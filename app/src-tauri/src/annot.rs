//! `.list` 标注文件的读、校、写。
//!
//! GPT-SoVITS 的一行标注长这样：
//!
//! ```text
//! audios/0001.wav|爱丽丝|JA|ブルーアーカイブ
//! ```
//!
//! 四段：音频路径、说话人、语种、文本。路径**相对 .list 所在目录**（角色包
//! 约定见 docs/DECISIONS.md 的 D4），所以这里所有的绝对路径都是当场拼出来
//! 给界面播放用的，不写回文件。
//!
//! 这个模块只做三件事，而且刻意都做成同步的纯函数：解析一行、给一行挑毛病、
//! 把一批行写回去。挑毛病的部分是这里唯一有判断的地方 —— 标注坏掉的方式就
//! 那么几种（文件不在、字段数不对、文本空、同一个音频出现两次、语种写错），
//! 每一种都直接对应用户接下来要做的一个动作，所以按种类分开报，而不是笼统
//! 地说一句「第 47 行有问题」。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use serde_json::{json, Value};

/// 上游认得的语种记号。大小写不敏感 —— 素材库里 `ZH` 和 `zh` 都见过。
///
/// 这份表是**提示**用的，不是闸门：写了表外的记号只会得到一条 warn，行照样
/// 存得下去。上游随时可能加新语种，而这个软件不该因为自己的表旧了就拒绝
/// 保存用户的标注。
const KNOWN_LANGS: &[&str] = &["zh", "ja", "en", "ko", "yue", "all_zh", "all_ja", "all_ko", "auto"];

/// 一行标注在界面里的样子。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row {
    /// 原始行号（1 起）。删行之后不重排 —— 用户报错时说的是「第几行」。
    pub line: usize,
    /// 写在文件里的那个相对路径，原样。
    pub wav: String,
    pub speaker: String,
    pub lang: String,
    pub text: String,
    /// 拼出来的绝对路径，给界面播放用。文件不在时也给，界面自己按 exists 判断。
    #[serde(default)]
    pub abs: String,
    #[serde(default)]
    pub exists: bool,
    /// 这一行的毛病，见 `issues_of`。空 = 干净。
    #[serde(default)]
    pub issues: Vec<String>,
}

/// 解析一行。返回 None = 空行或注释，调用方跳过。
///
/// 用 `splitn(4, '|')` 而不是 `split('|')`：文本里出现竖线不是没有过（日语的
/// 「｜」是全角，但转写时被人手打成半角的情况见过），前三段定死，剩下的全归
/// 文本。反过来写就会把人家的台词从中间劈开。
fn parse_line(line: &str) -> Option<Row> {
    let t = line.trim_end_matches(['\r', '\n']);
    if t.trim().is_empty() || t.trim_start().starts_with('#') {
        return None;
    }
    let mut it = t.splitn(4, '|');
    let wav = it.next().unwrap_or("").trim().to_string();
    let speaker = it.next().unwrap_or("").trim().to_string();
    let lang = it.next().unwrap_or("").trim().to_string();
    let text = it.next().unwrap_or("").trim().to_string();
    Some(Row {
        line: 0,
        wav,
        speaker,
        lang,
        text,
        abs: String::new(),
        exists: false,
        issues: Vec::new(),
    })
}

/// 一行的毛病清单。记号是给界面用的，文案在语言包里。
fn issues_of(r: &Row, dup: bool) -> Vec<String> {
    let mut out = Vec::new();
    if r.wav.is_empty() {
        out.push("no_wav".into());
    } else if !r.exists {
        out.push("missing".into());
    }
    if r.speaker.is_empty() {
        out.push("no_speaker".into());
    }
    if r.lang.is_empty() {
        out.push("no_lang".into());
    } else if !KNOWN_LANGS.contains(&r.lang.to_ascii_lowercase().as_str()) {
        out.push("odd_lang".into());
    }
    if r.text.is_empty() {
        out.push("no_text".into());
    }
    if dup {
        out.push("dup".into());
    }
    out
}

/// Windows 上大小写不敏感、分隔符两种都收，比路径要归一化一次。
fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_matches('/').to_ascii_lowercase()
}

/// 读一份 .list，连带把每一行体检一遍。
pub fn load(path: &str) -> Result<Value, String> {
    let p = Path::new(path);
    let raw = fs::read_to_string(p).map_err(|e| format!("{path}: {e}"))?;
    let base: PathBuf = p.parent().map(Path::to_path_buf).unwrap_or_default();

    let mut rows: Vec<Row> = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        if let Some(mut r) = parse_line(line) {
            r.line = i + 1;
            if !r.wav.is_empty() {
                let abs = base.join(r.wav.replace('\\', "/"));
                r.exists = abs.is_file();
                r.abs = abs.to_string_lossy().into_owned();
            }
            rows.push(r);
        }
    }

    // 同一个音频出现两次：训练时它会被喂两遍，合成台的参考列表里也会出现
    // 两条一模一样的候选。先数一遍再回填，单趟做不出来。
    let mut seen: HashMap<String, usize> = HashMap::new();
    for r in &rows {
        if !r.wav.is_empty() {
            *seen.entry(norm(&r.wav)).or_insert(0) += 1;
        }
    }
    for r in rows.iter_mut() {
        let dup = !r.wav.is_empty() && seen.get(&norm(&r.wav)).copied().unwrap_or(0) > 1;
        r.issues = issues_of(r, dup);
    }

    let bad = rows.iter().filter(|r| !r.issues.is_empty()).count();
    let missing = rows.iter().filter(|r| r.issues.iter().any(|i| i == "missing")).count();
    let speakers = {
        let mut v: Vec<String> = rows
            .iter()
            .map(|r| r.speaker.clone())
            .filter(|s| !s.is_empty())
            .collect();
        v.sort();
        v.dedup();
        v
    };

    Ok(json!({
        "path": path,
        "dir": base.to_string_lossy(),
        "rows": rows,
        "total": rows.len(),
        "bad": bad,
        "missing": missing,
        "speakers": speakers,
    }))
}

/// 把一批行写回去。
///
/// 先写同目录的临时文件再改名，中途断电不会留下半份标注 —— 标注是用户一句
/// 一句校出来的，是这个软件里最贵的东西，不能拿它冒险。第一次写之前留一份
/// `.list.bak`；只留第一次那份，之后不再覆盖，否则连着存三次就把原始那份
/// 冲没了，而用户想回的正是最开始那份。
pub fn save(path: &str, rows: &[Row]) -> Result<Value, String> {
    let p = Path::new(path);
    if !p.parent().map(Path::is_dir).unwrap_or(false) {
        return Err(crate::i18n::t("s.annot.errNoDir"));
    }
    let mut body = String::with_capacity(rows.len() * 64);
    for r in rows {
        // 字段里混进竖线就再也读不回来了。前三段是我们自己拼的，只可能是
        // 用户在界面里打进去的，就地换成全角 —— 直接拒绝保存等于让他在一个
        // 几千行的表里自己找是哪一格。
        let f = |s: &str| s.replace('|', "｜").replace(['\r', '\n'], " ");
        body.push_str(&f(&r.wav));
        body.push('|');
        body.push_str(&f(&r.speaker));
        body.push('|');
        body.push_str(&f(&r.lang));
        body.push('|');
        body.push_str(&f(&r.text));
        body.push('\n');
    }

    let bak = p.with_extension("list.bak");
    if p.is_file() && !bak.exists() {
        let _ = fs::copy(p, &bak);
    }
    let tmp = p.with_extension("list.tmp");
    fs::write(&tmp, body.as_bytes()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, p).map_err(|e| format!("{path}: {e}"))?;
    Ok(json!({ "path": path, "written": rows.len(), "backup": bak.is_file() }))
}

/// 选一份 .list。顺手把它所在的目录放进 asset 白名单 —— 界面要播那些音频。
pub fn pick(win: Option<&tauri::WebviewWindow>) -> Option<String> {
    let picked = crate::shell_extras::dialog_on(win)
        .set_title(&crate::i18n::t("s.annot.pickTitle"))
        .add_filter(&crate::i18n::t("s.annot.pickFilter"), &["list", "txt"])
        .pick_file()
        .map(|p| p.to_string_lossy().into_owned());
    if let (Some(win), Some(p)) = (win, picked.as_ref()) {
        if let Some(dir) = Path::new(p).parent() {
            crate::asset_scope::grant_dir(win.app_handle(), dir);
        }
    }
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipe_in_the_text_does_not_split_the_line() {
        let r = parse_line("audios/a.wav|爱丽丝|JA|前半|后半").unwrap();
        assert_eq!(r.wav, "audios/a.wav");
        assert_eq!(r.lang, "JA");
        assert_eq!(r.text, "前半|后半");
    }

    #[test]
    fn blank_and_comment_lines_are_not_rows() {
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
        assert!(parse_line("# 这是注释").is_none());
    }

    #[test]
    fn lang_case_does_not_matter_but_nonsense_is_flagged() {
        let mut r = parse_line("a.wav|s|zh|文本").unwrap();
        r.exists = true;
        assert!(issues_of(&r, false).is_empty());
        let mut r2 = parse_line("a.wav|s|ZH|文本").unwrap();
        r2.exists = true;
        assert!(issues_of(&r2, false).is_empty());
        let mut r3 = parse_line("a.wav|s|klingon|文本").unwrap();
        r3.exists = true;
        assert_eq!(issues_of(&r3, false), vec!["odd_lang".to_string()]);
    }

    #[test]
    fn duplicate_audio_paths_are_reported_on_both_rows() {
        let dir = std::env::temp_dir().join("annot_dup_test");
        let _ = fs::create_dir_all(dir.join("audios"));
        fs::write(dir.join("audios/a.wav"), b"x").unwrap();
        let list = dir.join("x.list");
        fs::write(&list, "audios/a.wav|s|zh|一\nAUDIOS\\A.WAV|s|zh|二\n").unwrap();
        let v = load(&list.to_string_lossy()).unwrap();
        let rows = v["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        for r in rows {
            let iss: Vec<String> = serde_json::from_value(r["issues"].clone()).unwrap();
            assert!(iss.contains(&"dup".to_string()), "{iss:?}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_keeps_the_first_original_as_a_backup() {
        let dir = std::env::temp_dir().join("annot_save_test");
        let _ = fs::create_dir_all(&dir);
        let list = dir.join("y.list");
        fs::write(&list, "a.wav|s|zh|原始\n").unwrap();
        let path = list.to_string_lossy().into_owned();

        let rows = vec![Row {
            line: 1,
            wav: "a.wav".into(),
            speaker: "s".into(),
            lang: "zh".into(),
            text: "第一次改".into(),
            abs: String::new(),
            exists: false,
            issues: vec![],
        }];
        save(&path, &rows).unwrap();
        let bak = list.with_extension("list.bak");
        assert_eq!(fs::read_to_string(&bak).unwrap(), "a.wav|s|zh|原始\n");

        let rows2 = vec![Row { text: "第二次改".into(), ..rows[0].clone() }];
        save(&path, &rows2).unwrap();
        // 备份还是最开始那份，没有被第二次保存冲掉。
        assert_eq!(fs::read_to_string(&bak).unwrap(), "a.wav|s|zh|原始\n");
        assert_eq!(fs::read_to_string(&list).unwrap(), "a.wav|s|zh|第二次改\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pipe_typed_into_a_field_becomes_full_width_instead_of_corrupting_the_file() {
        let dir = std::env::temp_dir().join("annot_pipe_test");
        let _ = fs::create_dir_all(&dir);
        let list = dir.join("z.list");
        let path = list.to_string_lossy().into_owned();
        let rows = vec![Row {
            line: 1,
            wav: "a.wav".into(),
            speaker: "a|b".into(),
            lang: "zh".into(),
            text: "文本".into(),
            abs: String::new(),
            exists: false,
            issues: vec![],
        }];
        save(&path, &rows).unwrap();
        let back = fs::read_to_string(&list).unwrap();
        assert_eq!(back, "a.wav|a｜b|zh|文本\n");
        // 读回来仍然是四段。
        let r = parse_line(back.trim()).unwrap();
        assert_eq!(r.text, "文本");
        let _ = fs::remove_dir_all(&dir);
    }
}
