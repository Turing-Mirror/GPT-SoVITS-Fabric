//! 出诊断包之前，先把包里已经能看出来的问题说出来。
//!
//! 支援这半年收到的包里，相当一部分的结论用户自己就能得出：选错了模型、数据集
//! 一个音频都没读进去、上一次训练是被显存不足带走的、引擎其实是被系统杀掉的。
//! 这些都写在包里，只是没人替他读。
//!
//! 规则只陈述事实和数字，不下断言 —— 「音高 616/3884」是事实，「你的训练白跑
//! 了」不是。每条都带证据（哪个文件、哪一行），支援能顺着证据自己复核。

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Evidence {
    pub file: String,
    pub text: String,
}

impl Evidence {
    fn new(file: impl Into<String>, text: impl Into<String>) -> Self {
        Self { file: file.into(), text: text.into() }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Finding {
    pub code: &'static str,
    pub level: &'static str,
    pub title: String,
    pub evidence: Vec<Evidence>,
}

pub const ERROR: &str = "error";
pub const WARN: &str = "warn";
pub const INFO: &str = "info";

fn rank(level: &str) -> u8 {
    match level {
        ERROR => 0,
        WARN => 1,
        _ => 2,
    }
}

/// 跑一遍全部规则，严重的排前面。
pub fn run(root: &Path) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();

    out.extend(known_issue_hits(root));
    out.extend(train_experiments(root));
    out.extend(pretrained(root));
    out.extend(disk(root));

    out.sort_by_key(|f| rank(f.level));
    out
}

// ------------------------------------------------------------ 已知问题

/// 1.1 和 1.2 共用同一套判断：命中的已知问题也算一条结论，跟着诊断包一起走。
/// 支援打开 info.json 就能看到「这台机器命中了 realtek-asio-enum-crash」，
/// 不用再从显卡声卡列表里自己认。
fn known_issue_hits(root: &Path) -> Vec<Finding> {
    crate::known_issues::hits(root)
        .into_iter()
        .map(|h| Finding {
            code: "known_issue",
            level: match h.level.as_str() {
                "error" => ERROR,
                "info" => INFO,
                _ => WARN,
            },
            title: h.title,
            evidence: vec![Evidence::new("known_issues.json", h.id)],
        })
        .collect()
}

// ---------------------------------------------------------------- 训练产物

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageCounts {
    pub sliced: u64,
    pub cnhubert: u64,
    pub bert: u64,
}

/// 三个阶段的产物数目对不上，就说明上一次是中途停的。
///
/// 26.8.20 那位：切片 3884、音高 616、特征 0，而续跑的判据是「目录非空就算做
/// 完」，于是音高整步被跳过，filelist 取交集只剩 618 行 —— 用户以为在拿 3884
/// 条数据训练，实际只用了 16%，界面上一个字都没提。判据已经改了，但已经存在的
/// 半份产物还躺在盘上，出包的时候该说一声。目录名是 GSV 格式化阶段的落点，
/// 与 `train::write_outcome` 的计数同源。
pub fn stage_mismatch(c: StageCounts) -> bool {
    c.sliced > 0 && (c.cnhubert != c.sliced || c.bert != c.sliced)
}

/// train.log 的尾巴是不是显存不足。
///
/// 只看尾巴：上一轮的显存不足不能栽给这一轮。
pub fn train_log_oom(tail: &str) -> Option<String> {
    for line in tail.lines().rev() {
        if line.contains("OutOfMemoryError")
            || line.contains("CUDA out of memory")
            || line.contains("out of memory")
        {
            return Some(line.trim().chars().take(200).collect());
        }
    }
    None
}

fn train_experiments(root: &Path) -> Vec<Finding> {
    let mut out = Vec::new();
    let exp_root = crate::train::exp_root(root);
    let Ok(rd) = std::fs::read_dir(&exp_root) else {
        return out;
    };
    let mut dirs: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let exp = dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let counts = StageCounts {
            sliced: count_dir(&dir.join("sliced")),
            cnhubert: count_dir(&dir.join("4-cnhubert")),
            bert: count_dir(&dir.join("3-bert")),
        };
        if stage_mismatch(counts) {
            out.push(Finding {
                code: "train.stage_mismatch",
                level: WARN,
                title: crate::i18n::tn(
                    "s.chkStageMismatch",
                    &[
                        &exp,
                        &counts.sliced.to_string(),
                        &counts.cnhubert.to_string(),
                        &counts.bert.to_string(),
                    ],
                ),
                evidence: vec![Evidence::new(
                    format!("train/{exp}/"),
                    format!(
                        "sliced={} 4-cnhubert={} 3-bert={}",
                        counts.sliced, counts.cnhubert, counts.bert
                    ),
                )],
            });
        }
        let tail = crate::logging::tail_lines(&dir.join("train.log"), 80, 64 * 1024);
        if let Some(line) = train_log_oom(&tail) {
            out.push(Finding {
                code: "train.out_of_memory",
                level: ERROR,
                title: crate::i18n::te("s.chkOom", &exp),
                evidence: vec![Evidence::new(format!("train/{exp}/train.log"), line)],
            });
        }
    }
    out
}

fn count_dir(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| rd.flatten().filter(|e| e.path().is_file()).count() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- 底模

fn pretrained(root: &Path) -> Vec<Finding> {
    // 一个文件都还没落盘是「还没装引擎资源」，provision 闸那边的事；
    // 这条只管装了一半的残缺状态。
    if !root.join("GPT_SoVITS").exists() {
        return Vec::new();
    }
    let missing = crate::engine_assets::engine_core_missing(root);
    if missing.is_empty() {
        return Vec::new();
    }
    vec![Finding {
        code: "assets.pretrained_partial",
        level: INFO,
        title: crate::i18n::te("s.chkPretrainedPartial", &missing.join("、")),
        evidence: vec![Evidence::new("GPT_SoVITS/pretrained_models/", missing.join("、"))],
    }]
}

// ---------------------------------------------------------------- 磁盘

fn disk(root: &Path) -> Vec<Finding> {
    let Some(gb) = free_space_gb(root) else {
        return Vec::new();
    };
    if gb >= 10.0 {
        return Vec::new();
    }
    vec![Finding {
        code: "disk.low",
        level: WARN,
        title: crate::i18n::te("s.chkDiskLow", &format!("{gb:.1}")),
        evidence: vec![Evidence::new(root.to_string_lossy(), format!("{gb:.1} GB"))],
    }]
}

fn free_space_gb(root: &Path) -> Option<f64> {
    crate::paths::free_space_bytes(root).map(|b| b as f64 / 1024.0 / 1024.0 / 1024.0)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_counts_must_all_match_the_slices() {
        // 26.8.20 那位的真实数字。
        assert!(stage_mismatch(StageCounts { sliced: 3884, cnhubert: 616, bert: 0 }));
        assert!(stage_mismatch(StageCounts { sliced: 100, cnhubert: 100, bert: 99 }));
        assert!(!stage_mismatch(StageCounts { sliced: 100, cnhubert: 100, bert: 100 }));
        // 还没预处理过的实验不该报 —— 那不是「半份产物」，是「还没开始」。
        assert!(!stage_mismatch(StageCounts { sliced: 0, cnhubert: 0, bert: 0 }));
    }

    #[test]
    fn only_the_tail_of_train_log_decides_the_oom_verdict() {
        assert!(train_log_oom("Epoch 1\ntorch.cuda.OutOfMemoryError: CUDA out of memory\n").is_some());
        assert!(train_log_oom("Epoch 1\nEpoch 2\n").is_none());
        // 上一轮炸过、这一轮跑完了：调用方只喂尾巴，所以这里拿到的就是干净的尾巴。
        assert!(train_log_oom("====> Epoch: 500\n").is_none());
    }


    #[test]
    fn findings_are_sorted_with_the_worst_first() {
        let mut v = vec![
            Finding { code: "a", level: INFO, title: "i".into(), evidence: vec![] },
            Finding { code: "b", level: ERROR, title: "e".into(), evidence: vec![] },
            Finding { code: "c", level: WARN, title: "w".into(), evidence: vec![] },
        ];
        v.sort_by_key(|f| rank(f.level));
        assert_eq!(v.iter().map(|f| f.code).collect::<Vec<_>>(), ["b", "c", "a"]);
    }
}
