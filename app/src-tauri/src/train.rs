//! 训练角色（GPT-SoVITS 的两段微调）。
//!
//! # 流水线
//!
//! 训练台四个阶段，与 `TrainPage` 上那四个勾一一对应：
//!
//! 1. **数据集工具链** —— UVR5 人声分离 → 切片 → ASR 打标 → 人工校对，
//!    产出 `<数据集>/<名字>.list`（`音频路径|说话人|语种|文本`）。校对在
//!    「标注」工具窗里做，不在这条链上。
//! 2. **训练集格式化** —— 上游 `prepare_datasets`：BERT 文本特征、cnhubert
//!    SSL 特征 + 32k 重采样、语义 token；v2Pro / v2ProPlus 还要多一步说话人
//!    验证嵌入（`2-get-sv.py` → `7-sv_cn`）。产物见 `STAGE_ARTIFACTS`。
//! 3. **SoVITS 微调**（s2）—— 产出 `logs_s2_<版本>/` 下的检查点。
//! 4. **GPT 微调**（s1）—— 产出 `logs_s1_<版本>/` 下的检查点。
//!
//! 阶段 2 之前的东西可以重来（删了再跑一遍就有），阶段 3、4 的检查点不能 ——
//! `CLEANUP_KINDS` 那张表按这条线划的。
//!
//! # 与 worker 的约定
//!
//! `tools/train_worker.py` 由这里 spawn，参数走一个 JSON 文件（数据集路径里
//! 有中文和空格是常态），stdout 一行一条 JSON：
//!
//! ```text
//! {"phase":"start"}
//! {"phase":"env",   "device":"cuda", "version":"v2ProPlus", ...}
//! {"phase":"stage", "stage":"prepare|format|sovits|gpt", "done":n, "total":n,
//!                   "message_code":"train.xxx", "message_params":{…},
//!                   "message":"（兜底原文）"}
//! {"phase":"checkpoint", "stage":"sovits|gpt", "path":"…", "bytes":n}
//! {"phase":"done",  "weights":{"sovits":"…","gpt":"…"}}
//! {"phase":"error", "message_code":"train.xxx", "message_params":{…}}
//! ```
//!
//! 文案一律走 `message_code`（对应语言包 `msg.train.*`），由 `t_worker_msg`
//! 按用户当前语言取词；worker 自带的 `message` 只是兜底 —— 新加的 code 还没
//! 进语言包时界面至少有句话，而不是一片空白。
//!
//! # 验到哪一步了
//!
//! 脚本写完了，协议两头对过了：worker 的五条失败路径都实跑过（空数据集、
//! 有现成标注、坏版本、请求文件缺失、没参数），输出的行原样抄进了
//! `the_lines_the_worker_actually_prints_come_out_as_sentences`；轮数解析和
//! OOM 判定拿一个假 trainer 跑过。`msg.train.*` 与 worker 发的 code 双向钉死
//! （多一条少一条都红）。
//!
//! **没跑过的是真正干活的那三段**：它调用的 `GPT_SoVITS` 源码树跟着 engine-core
//! 走，不在这个仓里，本机也没有 N 卡和 Runtime。所以脚本里凡是依赖上游布局的
//! 地方（三个 prepare_datasets 脚本、s2_train / s1_train、两份 config 模板、
//! 底模路径）都写成「不在就明确报缺哪个文件」，而不是猜一个默认值继续 ——
//! 第一次在真机上跑时，错的地方会自己报出名字，而不是在某个 epoch 中间炸。
//! config 也是读上游模板再改我们关心的那几个键，不写死一整份。
//!
//! 和 `separate.rs` 同一个形状（一次性子进程 + JSON 行进度），但多两件事：
//!
//! * **它会跑几个小时。** 所以进度必须是「第几步 / 第几轮」而不是一个转圈，
//!   用户要能判断还剩多久，也要能关掉软件明天接着跑。
//! * **它必须能续跑。** 训练中途断电、蓝屏、手滑关窗都太常见了，重头再来
//!   意味着白烧几个小时的电。续跑判据放在 Python 那侧（看产物目录），这里
//!   只负责把 `resume` 传下去。
//!
//! 不复用 `worker.rs`：那套 pid 文件 + status.json 是给常驻变声进程设计的，
//! 训练是一次性任务，套进去只会多出一堆要清理的残留。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::paths;

/// 一次只训一个：训练会吃满显存，两个一起跑必爆。
static BUSY: Mutex<bool> = Mutex::new(false);
static CANCEL: OnceLock<Arc<AtomicBool>> = OnceLock::new();
/// 训练子进程本身会再 fork 出 worker 进程，光靠 cancel 标志杀不干净，得留句柄。
static CHILD: Mutex<Option<u32>> = Mutex::new(None);

/// 上游版本表：`configs/upstream_versions.json`，打包时由
/// `scripts/prepare_engine_payload.py` 从随包上游源码生成。可训练哪些版本、
/// 哪些走 LoRA、底模在哪，全以它为准，这里不另写一份清单。
fn version_table(root: &Path) -> Value {
    read_json(&root.join("configs").join("upstream_versions.json"))
}

/// 训练台的默认值（`configs/train_defaults.json`）。只是起点，用户可改。
fn train_defaults(root: &Path) -> Value {
    read_json(&root.join("configs").join("train_defaults.json"))
}

fn read_json(p: &Path) -> Value {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

/// 可训练的版本，按上游训练页的顺序。
pub fn train_versions(root: &Path) -> Vec<String> {
    let table = version_table(root);
    table["train_order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .filter(|v| table["versions"][*v]["trainable"].as_bool() == Some(true))
        .map(str::to_string)
        .collect()
}

/// 这个版本训练要用到、但盘上没有的底模（相对安装根）。
fn base_missing(root: &Path, info: &Value) -> Vec<String> {
    ["s2G", "s2D", "s1"]
        .iter()
        .filter_map(|k| info[*k].as_str())
        .filter(|rel| !root.join(rel).is_file())
        .map(str::to_string)
        .collect()
}

/// 某个版本的默认参数。批大小按显存算，规则与上游 webui 的 `set_default` 相同：
/// 显存 GB 除以每批所需 GB，LoRA 版本占得多。
fn version_defaults(root: &Path, lora: bool) -> Value {
    let d = train_defaults(root);
    let s = &d["sovits"][if lora { "lora" } else { "full" }];
    let g = &d["gpt"];
    let u = |v: &Value, fb: u64| v.as_u64().unwrap_or(fb) as u32;
    let vram = vram_gb().unwrap_or(u(&d["fallback_vram_gb"], 8));
    let per = |v: &Value| (vram / u(v, 2).max(1)).clamp(BATCH_RANGE.0, BATCH_RANGE.1);
    let s_batch = per(&s["vram_gb_per_batch"]);
    let g_max = u(&g["max_batch"], 40).min(BATCH_RANGE.1);
    json!({
        "lora": lora,
        "sovits": {
            "epochs": u(&s["epochs"], 8),
            "max_epochs": u(&s["max_epochs"], 25).min(EPOCH_RANGE.1),
            "save_every": u(&s["save_every"], 4),
            "batch": s_batch,
            "max_batch": (s_batch * u(&d["sovits"]["max_batch_factor"], 3)).min(BATCH_RANGE.1),
            "learning_rate": s["learning_rate"].as_f64().unwrap_or(1e-4),
            "lora_rank": u(&s["lora_rank"], 32),
            "lora_ranks": s["lora_ranks"].clone(),
        },
        "gpt": {
            "epochs": u(&g["epochs"], 15),
            "min_epochs": u(&g["min_epochs"], 1),
            "max_epochs": u(&g["max_epochs"], 50).min(EPOCH_RANGE.1),
            "save_every": u(&g["save_every"], 5),
            "batch": per(&g["vram_gb_per_batch"]).min(g_max),
            "max_batch": g_max,
        },
    })
}

/// 每个可训练版本：是否 LoRA、缺哪些底模、默认参数。界面直接用。
fn versions_status(root: &Path) -> Vec<Value> {
    let table = version_table(root);
    train_versions(root)
        .into_iter()
        .map(|v| {
            let info = &table["versions"][&v];
            let lora = info["lora"].as_bool().unwrap_or(false);
            json!({
                "id": v,
                "lora": lora,
                "base_missing": base_missing(root, info),
                "defaults": version_defaults(root, lora),
            })
        })
        .collect()
}

/// 默认版本：`train_defaults.json` 指定的；不可训练时退到上游顺序的第一个。
fn default_version(root: &Path) -> String {
    let list = train_versions(root);
    train_defaults(root)["default_version"]
        .as_str()
        .filter(|v| list.iter().any(|x| x == v))
        .map(str::to_string)
        .or_else(|| list.first().cloned())
        .unwrap_or_default()
}

/// 轮数 / 批大小 / 学习率的可接受范围。
///
/// 卡在这里而不是只靠界面的滑杆：命令是能直接 invoke 的，而一个 0 的批大小
/// 或者 1e9 的学习率不会报错，只会安静地训出一个废模型 —— 几个小时之后才知道。
pub const EPOCH_RANGE: (u32, u32) = (1, 200);
pub const BATCH_RANGE: (u32, u32) = (1, 64);
pub const LR_RANGE: (f64, f64) = (1e-6, 1e-2);

fn cancel_flag() -> Arc<AtomicBool> {
    CANCEL
        .get_or_init(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

fn worker_script(root: &Path) -> PathBuf {
    root.join("tools").join("train_worker.py")
}

/// 训练实验的落点：`User_Data/train/<实验名>/`。
///
/// **原来在安装目录根下的 `logs/`。** 那是 RVC 沿用上游的位置，代价有两个：
/// 一个实验的中间产物和检查点动辄几个 GB，却和随包发的文件混在同一层；
/// 卸载时更麻烦 —— 用户「保留我的数据」指的显然包括他训了一整晚的模型，
/// 而那份东西压根不在 `User_Data` 里。挪进来之后，「保留用户数据」这一个
/// 开关就真的覆盖了用户的全部产出，安装目录也回到「只有随包文件」。
///
/// 名字用 `train` 不用 `logs`：那底下是数据集特征与检查点，不是日志；
/// 真正的日志在 `User_Data/logs/`（`paths::logs_dir`），两个 `logs` 并存
/// 只会让人删错。
pub fn exp_root(root: &Path) -> PathBuf {
    crate::paths::user_data(root).join("train")
}

/// 已有的实验（`User_Data/train/<名字>`）。`mute` 是随包发的静音样本，不是用户的实验。
fn experiments(root: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(exp_root(root)) else {
        return out;
    };
    let mut items: Vec<(String, Value)> = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name == "mute" || name.starts_with('.') {
            continue;
        }
        // GSV 的格式化产物：切片 → cnhubert 特征 → wav32k →（Pro）sv →
        // name2semantic。两个数目对不上就说明上一次是中途停的。
        let slices = count_dir(&p.join("sliced"));
        let hubert = count_dir(&p.join("4-cnhubert"));
        let wav32k = count_dir(&p.join("5-wav32k"));
        let sv = count_dir(&p.join("7-sv_cn"));
        let text_done = p.join("2-name2text.txt").is_file();
        let semantic_done = p.join("6-name2semantic.tsv").is_file();
        // 训完的成品是角色包（`User_Data/characters/<safe_id>/models/`），
        // 不是散落的权重文件 —— collect() 的落点与这里必须是同一套约定。
        let trained = crate::synth::characters_dir(root)
            .join(crate::characters::safe_id(name))
            .join("models")
            .join("sovits.pth")
            .is_file();
        items.push((
            name.to_string(),
            json!({
                "name": name,
                "slices": slices,
                "hubert": hubert,
                "wav32k": wav32k,
                "sv": sv,
                // 格式化五步齐活才算能直接进微调；缺一说明上次断在中途。
                "complete": slices > 0 && hubert > 0 && wav32k > 0 && text_done && semantic_done,
                // 有切片就能续跑：切片+ASR 是最慢的一步，能跳过就省下几十分钟。
                "resumable": slices > 0,
                "trained": trained,
            }),
        ));
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    out.extend(items.into_iter().map(|(_, v)| v));
    out
}

/// preprocess.log 里成功了几个、失败了几个。
///
/// 26.8.20 那位的一个实验 2038 个文件只切出 3 条，训练照跑，500 epoch 之后才
/// 发现音色不像。后端已经会报这件事了，但报完就被下一阶段的进度盖掉；界面上
/// 得能随时翻出来。
///
/// 一个实验的「中间产物」——可以删、删了只是要重跑预处理的东西。
///
/// 这张表是唯一的判据：扫多少和删多少必须来自同一处，两边各写一份迟早会分叉，
/// 而分叉的后果是删掉了不该删的。
///
/// 明确不在表里：`*.pth`（训练存档和权重）、`*.index`（检索索引）、
/// `*.log`（日志）、`config.json`。前两样删了不可再生。
pub const STAGE_ARTIFACTS: [&str; 6] = [
    "2-name2text.txt",
    "3-bert",
    "4-cnhubert",
    "5-wav32k",
    // v2Pro / v2ProPlus 专有：说话人验证嵌入，由 `2-get-sv.py` 产出。
    // 非 Pro 版本不会有这个目录，`dir_or_file_bytes` 见不到就算 0。
    "7-sv_cn",
    "6-name2semantic.tsv",
];

/// 两段微调的检查点目录**前缀**。**不在 `STAGE_ARTIFACTS` 里** —— 那张表是
/// 「删了能再生成」的中间产物，这两个删了就是几个小时白烧。清理那边按
/// `checkpoints` 单独一类处理，用户得自己勾。
///
/// 是前缀不是全名：上游按版本分目录（`logs_s2_v2ProPlus`、`logs_s1_v2Pro`
/// ……，见 `s2_train.py:522` 与 webui 的 `open1Bb`），同一个实验换版本重训
/// 会并排留下好几个。写死 `logs_s2` / `logs_s1` 的话一个都匹配不上，清理页
/// 会显示 0 字节，用户以为没东西可删。
pub const CHECKPOINT_DIR_PREFIXES: [&str; 2] = ["logs_s2", "logs_s1"];

/// 实验目录下所有匹配上述前缀的检查点目录。
fn checkpoint_dirs(exp_dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(exp_dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            CHECKPOINT_DIR_PREFIXES.iter().any(|p| name.starts_with(p))
        })
        .map(|e| e.path())
        .collect()
}

/// 中间产物一共占多少字节。
pub fn stage_artifact_bytes(exp_dir: &Path) -> u64 {
    STAGE_ARTIFACTS
        .iter()
        .map(|name| dir_or_file_bytes(&exp_dir.join(name)))
        .sum()
}

fn dir_or_file_bytes(p: &Path) -> u64 {
    let Ok(meta) = std::fs::metadata(p) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    let Ok(rd) = std::fs::read_dir(p) else {
        return 0;
    };
    rd.flatten()
        .map(|e| dir_or_file_bytes(&e.path()))
        .sum()
}

/// 数据集抽样体检。
///
/// 26.8.20 那位跑了 500 epoch 才发现音色不像，原因是 2038 个文件只切出 3 条。
/// 那件事已经在预处理阶段拦住了，但还有一类拦不住：素材本身就不合适 —— 整首歌
/// （带伴奏）、大段静音、采样率五花八门。这些跑完才发现同样是几十分钟白费。
///
/// 用产品自带的 ffprobe 读元数据，不解码 —— 三十个文件几秒钟就回来了。响度和
/// 静音占比要解码，所以只在更小的子集上做。
///
/// 全程可跳过：拿不到 ffprobe（比如开发机上）就返回 available=false，界面不显示
/// 这一块，而不是报错。
pub fn inspect_dataset(root: &Path, dir: &Path) -> Value {
    let Some(probe) = paths::audio_tool(root, "ffprobe") else {
        return json!({ "available": false });
    };
    let mut files = Vec::new();
    collect_audio(dir, &mut files, 0);
    if files.is_empty() {
        return json!({ "available": true, "sampled": 0, "files": 0 });
    }
    files.sort();
    let total = files.len();
    // 均匀抽样，不是取前 N 个 —— 用户常按歌手/来源分文件夹，取前 N 个只会看到
    // 第一个文件夹。
    const SAMPLE: usize = 30;
    let step = (total as f64 / SAMPLE as f64).max(1.0);
    let picked: Vec<&PathBuf> = (0..SAMPLE.min(total))
        .map(|i| &files[((i as f64) * step) as usize % total])
        .collect();

    let mut durations: Vec<f64> = Vec::new();
    let mut rates: std::collections::BTreeMap<u32, u64> = Default::default();
    let mut channels: std::collections::BTreeMap<u32, u64> = Default::default();
    // 响度/静音要解码，只在这几个（前 5 个抽中的）上做。
    let mut loud_files: Vec<(PathBuf, f64)> = Vec::new();
    for p in &picked {
        let Some((dur, sr, ch)) = probe_one(&probe, p) else {
            continue;
        };
        if dur > 0.0 {
            durations.push(dur);
            loud_files.push(((*p).clone(), dur));
        }
        if sr > 0 {
            *rates.entry(sr).or_insert(0) += 1;
        }
        if ch > 0 {
            *channels.entry(ch).or_insert(0) += 1;
        }
    }
    if durations.is_empty() {
        return json!({ "available": true, "sampled": 0, "files": total });
    }
    durations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = durations[durations.len() / 2];
    let mean: f64 = durations.iter().sum::<f64>() / durations.len() as f64;
    let mut out = json!({
        "available": true,
        "files": total,
        "sampled": durations.len(),
        "median_seconds": median,
        // 总时长是估的：抽样均值 × 文件数。界面上必须写成「约」。
        "estimated_total_seconds": mean * total as f64,
        "sample_rates": rates.iter().map(|(k, v)| json!({"rate": k, "files": v})).collect::<Vec<_>>(),
        "channels": channels.iter().map(|(k, v)| json!({"channels": k, "files": v})).collect::<Vec<_>>(),
    });
    // 响度和静音占比量不出来（没有 ffmpeg / 文件都读不出）就不给字段，
    // 界面把缺省当成「没这项检查」，不当成 0。
    if let Some((mean_db, silence_ratio)) = probe_loudness(root, &loud_files) {
        out["mean_volume_db"] = json!((mean_db * 10.0).round() / 10.0);
        out["silence_ratio"] = json!((silence_ratio * 100.0).round() / 100.0);
    }
    out
}

fn collect_audio(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 6 || out.len() > 20_000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_audio(&p, out, depth + 1);
            continue;
        }
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if DATASET_AUDIO_EXT.contains(&ext.as_str()) {
            out.push(p);
        }
    }
}

/// 一个文件的 (时长秒, 采样率, 声道数)。取不到就是 None。
fn probe_one(probe: &Path, file: &Path) -> Option<(f64, u32, u32)> {
    let mut cmd = std::process::Command::new(probe);
    cmd.args([
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels:format=duration",
        "-of", "default=noprint_wrappers=1:nokey=0",
    ])
    .arg(file)
    .stdin(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    // `output()` 没有超时。坏文件能让 ffprobe 卡住，而这里要连着跑三十次。
    let out = run_with_timeout(cmd, std::time::Duration::from_secs(5))?;
    let text = String::from_utf8_lossy(&out);
    let mut dur = 0.0;
    let mut sr = 0u32;
    let mut ch = 0u32;
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k.trim() {
            "duration" => dur = v.trim().parse().unwrap_or(0.0),
            "sample_rate" => sr = v.trim().parse().unwrap_or(0),
            "channels" => ch = v.trim().parse().unwrap_or(0),
            _ => {}
        }
    }
    Some((dur, sr, ch))
}

fn run_with_timeout(mut cmd: std::process::Command, wait: std::time::Duration) -> Option<Vec<u8>> {
    cmd.stdout(std::process::Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(wait) {
        Ok(buf) => {
            let _ = child.wait();
            Some(buf)
        }
        Err(_) => {
            let _ = child.kill();
            None
        }
    }
}

/// `run_with_timeout` 的 stderr 版：ffmpeg 的 volumedetect / silencedetect
/// 报告写在 stderr，stdout 是空的无所谓。
fn run_with_timeout_stderr(
    mut cmd: std::process::Command,
    wait: std::time::Duration,
) -> Option<String> {
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let mut stderr = child.stderr.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(wait) {
        Ok(buf) => {
            let _ = child.wait();
            Some(String::from_utf8_lossy(&buf).into_owned())
        }
        Err(_) => {
            let _ = child.kill();
            None
        }
    }
}

/// ffmpeg 报告里解析 (平均响度 dB, 累计静音秒)。行样例：
/// `[Parsed_volumedetect_1 @ …] mean_volume: -23.6 dB`
/// `silence_duration: 4.51`
fn parse_volume_report(text: &str) -> (Option<f64>, f64) {
    let mut mean = None;
    let mut silence = 0.0;
    for line in text.lines() {
        if let Some(v) = line.split("mean_volume:").nth(1) {
            if let Ok(n) = v.trim().trim_end_matches("dB").trim().parse::<f64>() {
                mean = Some(n);
            }
        } else if let Some(v) = line.split("silence_duration:").nth(1) {
            if let Ok(n) = v.trim().parse::<f64>() {
                silence += n;
            }
        }
    }
    (mean, silence)
}

/// 解码抽中的前几个文件，量平均响度和静音占比。
///
/// ffprobe 只读元数据，量不出这两样 —— 而「录得太轻」「整轨大段静音」恰恰是
/// 跑完几百轮才暴露的素材问题。解码贵，所以只抽前 5 个、每个最多听前 120 秒。
/// 返回 (平均响度 dB, 静音占比 0..1)；ffmpeg 不在或全军覆没就 None，界面
/// 不显示这一块。
fn probe_loudness(root: &Path, files: &[(PathBuf, f64)]) -> Option<(f64, f64)> {
    let ffmpeg = paths::audio_tool(root, "ffmpeg")?;
    const CAP: f64 = 120.0;
    let mut vols: Vec<f64> = Vec::new();
    let mut silence_sum = 0.0;
    let mut analyzed = 0.0;
    for (p, dur) in files.iter().take(5) {
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.args(["-hide_banner", "-nostats", "-v", "info", "-i"])
            .arg(p)
            .args([
                "-t",
                "120",
                "-map",
                "a:0",
                "-af",
                "silencedetect=noise=-35dB:d=1,volumedetect",
                "-f",
                "null",
                "-",
            ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        // 坏文件能让 ffmpeg 卡住；这里要连着跑五次，超时必须比 probe_one 紧。
        let Some(text) = run_with_timeout_stderr(cmd, std::time::Duration::from_secs(20))
        else {
            continue;
        };
        let (mean, silence) = parse_volume_report(&text);
        if let Some(m) = mean {
            vols.push(m);
            silence_sum += silence;
            analyzed += dur.min(CAP).max(0.0);
        }
    }
    if vols.is_empty() || analyzed <= 0.0 {
        return None;
    }
    let mean = vols.iter().sum::<f64>() / vols.len() as f64;
    let ratio = (silence_sum / analyzed).clamp(0.0, 1.0);
    Some((mean, ratio))
}

/// 可清理的两类。分开列、分开勾 —— 后果完全不同，混成一个「一键清理」
/// 就等于让用户在不知道后果的情况下按下去。
///
/// | 类别 | 匹配 | 删掉之后 |
/// |---|---|---|
/// | checkpoints | `logs/<exp>/{logs_s1,logs_s2}/**` | 不能续训，两段微调都要重来 |
/// | dataset     | `STAGE_ARTIFACTS`                 | 要从格式化那一步重跑 |
///
/// 永不触碰：训练输出目录下已经成形的角色（`User_Data/characters/**`）、各类 `.log`。
///
/// RVC 那版还有第三类 `snapshots`（`assets/weights/<exp>_eN_sM.pth`，训练途中
/// 另存的小模型）。GPT-SoVITS 没有这个东西：中途的检查点就在 `logs_s?/` 里，
/// 最终权重直接落到输出目录，两者已经分别对应上面两类了。
pub const CLEANUP_KINDS: [&str; 2] = ["checkpoints", "dataset"];

/// 某一类在盘上的文件清单。扫描和删除都调它 —— 只有一处判据。
fn cleanup_targets(root: &Path, exp: &str, kind: &str) -> Vec<PathBuf> {
    let exp_dir = exp_root(root).join(exp);
    match kind {
        // 两段微调的检查点整目录算一类。不按文件名认（`G_*.pth` / `epoch=*.ckpt`
        // 两套命名，还会随上游版本变），按目录认 —— 目录是我们和 worker 之间
        // 约定死的，文件名不是。
        "checkpoints" => checkpoint_dirs(&exp_dir)
            .iter()
            .flat_map(|d| list_files(d))
            .collect(),
        "dataset" => STAGE_ARTIFACTS
            .iter()
            .map(|n| exp_dir.join(n))
            .filter(|p| p.exists())
            .collect(),
        _ => Vec::new(),
    }
}

/// 目录下的文件（递归）。检查点目录里上游会再分子目录，只扫一层会漏。
fn list_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(list_files(&p));
        } else if p.is_file() {
            out.push(p);
        }
    }
    out
}

/// 每个实验、每一类各占多少、各有几个文件。
pub fn cleanup_scan(root: &Path) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let Ok(rd) = std::fs::read_dir(exp_root(root)) else {
        return json!([]);
    };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .filter(|n| n != "mute" && !n.starts_with('.'))
        .collect();
    names.sort();
    for exp in names {
        let mut kinds = serde_json::Map::new();
        let mut total = 0u64;
        for kind in CLEANUP_KINDS {
            let files = cleanup_targets(root, &exp, kind);
            let bytes: u64 = files.iter().map(|p| dir_or_file_bytes(p)).sum();
            total += bytes;
            kinds.insert(kind.into(), json!({ "files": files.len(), "bytes": bytes }));
        }
        out.push(json!({ "exp": exp, "total_bytes": total, "kinds": Value::Object(kinds) }));
    }
    json!(out)
}

/// 删掉指定实验的指定几类，返回释放的字节数。
///
/// 闸：训练中拒绝、实验名不许逃逸、删前重扫、写日志。
pub fn cleanup_apply(root: &Path, exp: &str, kinds: &[String]) -> Result<u64, String> {
    let exp_dir = guard_exp_dir(root, exp)?;
    let _ = &exp_dir;
    let mut freed = 0u64;
    for kind in kinds {
        if !CLEANUP_KINDS.contains(&kind.as_str()) {
            continue;
        }
        // 删之前重新扫一次，不复用界面上那份可能已经过时的清单。
        for p in cleanup_targets(root, exp.trim(), kind) {
            let bytes = dir_or_file_bytes(&p);
            let r = if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
            match r {
                Ok(()) => freed += bytes,
                Err(e) => {
                    crate::logging::shell_log!("清理：{} 删除失败 {}", p.display(), e)
                }
            }
        }
    }
    crate::logging::shell_log!(
        "清理：实验 {} 类别 {:?} 释放约 {:.1} MB",
        exp.trim(),
        kinds,
        freed as f64 / (1024.0 * 1024.0)
    );
    Ok(freed)
}

/// 删除类操作共用的那几道闸。
fn guard_exp_dir(root: &Path, exp: &str) -> Result<PathBuf, String> {
    let exp = exp.trim();
    if exp.is_empty() || exp.contains(['/', '\\', ':']) || exp == "." || exp == ".." {
        return Err(crate::i18n::te("s.trainNameInvalid", &exp));
    }
    if *BUSY.lock().unwrap_or_else(|e| e.into_inner()) {
        return Err(crate::i18n::t("s.trainBusyNoReset"));
    }
    let exp_dir = exp_root(root).join(exp);
    let (Ok(canon), Ok(canon_root)) = (exp_dir.canonicalize(), root.canonicalize()) else {
        return Err(crate::i18n::te("s.trainExpMissing", &exp));
    };
    if !canon.starts_with(&canon_root) {
        return Err(crate::i18n::te("s.trainExpMissing", &exp));
    }
    Ok(exp_dir)
}


/// 数据集里算数的音频后缀。
///
/// 必须和 `tools/train_worker.py` 的 `AUDIO_EXT` 完全一致 —— 界面上报「找到 120 个音频」而预处理只认出 80 个，比不报
/// 还糟：用户会拿这个数字去判断自己的数据集够不够，而它是假的。有一条测试直接
/// 读 train_worker.py 的那一行来比对，改一边忘了另一边就红。
pub const DATASET_AUDIO_EXT: [&str; 8] =
    ["wav", "mp3", "flac", "ogg", "m4a", "aac", "wma", "opus"];

/// 选完数据集立刻数一遍。
///
/// 26.8.20 那位的另一个实验：2038 个文件只切出 3 条，训练照跑，500 epoch 跑完
/// 才发现音色不像。那是预处理阶段的事，但更早一步就能拦 —— 选目录的当下就该
/// 知道这里到底有几个音频。
///
/// 递归扫子目录，跟 preprocess.py 的 os.walk 一致：用户按歌手分文件夹是常态。
pub fn scan_dataset(dir: &Path) -> Value {
    let mut files: u64 = 0;
    let mut other: u64 = 0;
    let mut bytes: u64 = 0;
    let mut by_ext: std::collections::BTreeMap<String, u64> = Default::default();
    let mut stack = vec![dir.to_path_buf()];
    // 扫到这么多就停：真有人把整块盘选进来，界面不该卡在那儿数。
    const MAX_ENTRIES: u64 = 200_000;
    let mut seen: u64 = 0;
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                stack.clear();
                break;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let ext = p
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if DATASET_AUDIO_EXT.contains(&ext.as_str()) {
                files += 1;
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                *by_ext.entry(ext).or_insert(0) += 1;
            } else {
                other += 1;
            }
        }
    }
    json!({
        "files": files,
        "other_files": other,
        "total_bytes": bytes,
        "by_ext": by_ext,
        "truncated": seen > MAX_ENTRIES,
        "supported": DATASET_AUDIO_EXT,
    })
}

fn count_dir(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| rd.flatten().filter(|e| e.path().is_file()).count() as u64)
        .unwrap_or(0)
}

/// N 卡才谈得上训练。CPU 变体跑 `train.py` 不是「慢一点」，是几百小时。
/// 必须在界面上拦住，而不是让用户跑一晚上才发现。
fn is_nvidia(root: &Path) -> bool {
    match crate::provision::read_package_meta_variant(root).as_deref() {
        // nvidia* 一并盖住旧的 50 系专用 meta：那也是 CUDA 包，变体收敛后不再单列。
        Some(v) if v.starts_with("nvidia") => true,
        Some(_) => false,
        // 没写过 package_meta 就现场看显卡名。
        None => {
            let gpus = crate::provision::list_gpus();
            crate::provision::recommend_variant(&gpus).0.starts_with("nvidia")
        }
    }
}

/// 训练是否在跑。卸载底模前要问一句 —— 训练正读着底模，删掉只会让它在
/// 某个 epoch 中间炸掉。
pub fn busy() -> bool {
    *BUSY.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn status(root: &Path) -> Value {
    let nvidia = is_nvidia(root);
    let busy = *BUSY.lock().unwrap_or_else(|e| e.into_inner());
    json!({
        "runtime_ready": paths::runtime_ready(root),
        "worker_present": worker_script(root).is_file(),
        // 底模就绪与否交给 engine_assets 判 —— 缺哪几组它自己报得出来，
        // 界面不必再拼一遍「hubert 在不在、mute 在不在」这种 RVC 的清单。
        "engine_core_ready": crate::engine_assets::engine_core_ready(root),
        "engine_core_missing": crate::engine_assets::engine_core_missing(root),
        "nvidia": nvidia,
        "versions": versions_status(root),
        "default_version": default_version(root),
        "experiments": experiments(root),
        // 产品所在盘还剩多少。训练要在 logs/<实验>/ 下写切片、音高、特征，
        // 写到一半盘满了是「跑了四十分钟然后失败」，值得在开始之前就拦。
        "disk_free_bytes": paths::free_space_bytes(root).map(Value::from).unwrap_or(Value::Null),
        "busy": busy,
        // 正在跑的时候不提「上次断了」—— 那说的就是这一次。
        "interrupted": if busy { Value::Null } else { last_interrupted(root).unwrap_or(Value::Null) },
    })
}

/// 上一次训练是不是没跑完就断了，断在第几轮。
///
/// 训练进度以前只活在内存（`BUSY` 那个 bool）和界面组件的 state 里，程序
/// 一死就全没了。26.8.18 的用户被强杀之后重开，界面显示「空闲」，他完全
/// 不知道刚才那一次跑到了第 99 轮、切片和特征都还在盘上 —— 只能从头再来。
///
/// 判据是日志尾巴：`finish_run` 不管成败都会写一行 `=== done (…) ===`，
/// 没有这行就是壳没活到写它的那一刻。
fn last_interrupted(root: &Path) -> Option<Value> {
    let dir = crate::logging::channel_dir(root, crate::logging::CH_TRAIN);
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for e in std::fs::read_dir(&dir).ok()?.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let Ok(m) = e.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if newest.as_ref().map_or(true, |(t, _)| m > *t) {
            newest = Some((m, p));
        }
    }
    let (_, path) = newest?;
    let text = std::fs::read_to_string(&path).ok()?;
    if text.contains("=== done (") {
        return None;
    }
    parse_interrupted(&text).map(|(exp, done, total)| {
        json!({ "exp": exp, "epoch": done, "total": total })
    })
}

/// 从一份没写完的训练日志里挖出实验名和最后一轮。日志格式见 `begin_run`
/// （头部是请求 JSON）和 `note_progress`（`progress stage stage=sovits 99/200 …`）。
fn parse_interrupted(text: &str) -> Option<(String, u32, u32)> {
    let exp = text
        .lines()
        .find_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix("\"exp\":")?;
            let v = rest.trim().trim_end_matches(',').trim();
            let v = v.strip_prefix('"')?.strip_suffix('"')?;
            (!v.is_empty()).then(|| v.to_string())
        })?;
    let mut last = None;
    for line in text.lines() {
        // 只有两段微调值得提示续跑：格式化那一步重跑一遍就有，而微调是几个
        // 小时。`stage=` 后面跟的是 worker 报的阶段名。
        let Some(at) = ["stage=sovits ", "stage=gpt "]
            .iter()
            .find_map(|k| line.find(k).map(|i| i + k.len()))
        else {
            continue;
        };
        let tail = line[at..].split_whitespace().next()?;
        let (a, b) = tail.split_once('/')?;
        if let (Ok(a), Ok(b)) = (a.parse::<u32>(), b.parse::<u32>()) {
            last = Some((a, b));
        }
    }
    let (done, total) = last?;
    // 0/200 是「准备训练」那一下，还没真开始，不值得提示用户续跑。
    (done > 0).then_some((exp, done, total))
}


pub fn cancel() {
    cancel_flag().store(true, Ordering::SeqCst);
    // 光设标志不够：训练子进程自己还会 fork 出 DDP worker，父进程不死它们
    // 就一直占着显存。这里直接按 pid 杀。
    let pid = *CHILD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(pid) = pid {
        kill_tree(pid);
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .status();
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

/// 把 worker 的一行原样转给界面，外加一个已经翻好的 `text`。
///
/// worker 只发 `message_code` + `message_params`（它不知道用户选了哪种语言），
/// 翻译在这一侧。不在这里翻的话，界面要么显示 `train.sovits_started` 这种
/// 裸 key，要么就得把八份文案再拼一遍 —— 而语言包的四道校验只认这边的引用。
fn emit(app: &AppHandle, mut payload: Value) {
    let text = crate::i18n::t_worker_msg(&payload);
    if let Some(obj) = payload.as_object_mut() {
        if !text.is_empty() {
            obj.insert("text".into(), Value::String(text));
        }
    }
    let _ = app.emit("train-progress", payload);
}

/// 训练请求。字段和 `tools/train_worker.py` 的 `normalize()` 一一对应，
/// 也和 `TrainPage` 上的那几个控件一一对应。
///
/// 这里原来是 RVC 的一套：`sample_rate`（32k/40k/48k）、`f0_method`
/// （rmvpe/harvest/pm/dio）、以及训完之后建检索索引。GPT-SoVITS 一个都没有 ——
/// 它的输入固定 32k、不提 f0、也没有索引这回事。照抄过来的结果是界面上摆着
/// 一排这个产品根本不存在的旋钮。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TrainReq {
    pub exp: String,
    pub dataset: String,
    /// 见 `train_versions`。决定用哪一组底模、走哪条微调路径。
    pub version: String,
    /// SoVITS 与 GPT 两段微调各自的轮数、批大小、保存间隔。
    pub sovits_epoch: u32,
    pub sovits_batch: u32,
    pub sovits_save_every: u32,
    pub gpt_epoch: u32,
    pub gpt_batch: u32,
    pub gpt_save_every: u32,
    /// SoVITS 学习率。上游 s2 配置的默认值是 1e-4。
    pub learning_rate: f64,
    /// LoRA 版本的秩，全参版本忽略。
    #[serde(default = "default_lora_rank")]
    pub lora_rank: u32,
    pub resume: bool,
    /// 训好的音色放哪。空 = `User_Data/models`（老行为）。
    ///
    /// 一个音色连模型带索引三四百 MB，训十个就是几个 G。允许挪到别的盘，
    /// 但必须是绝对路径且建得出来 —— 相对路径会跟着 cwd 跑，训了几小时
    /// 最后落在谁也找不到的地方。
    #[serde(default)]
    pub output_dir: String,
}

fn default_lora_rank() -> u32 {
    32
}

pub const LORA_RANK_RANGE: (u32, u32) = (1, 256);

/// 显存最小那块卡的 GB 数（整数，向下取整）。查不到就是 None。
fn vram_gb() -> Option<u32> {
    static CACHED: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| {
        let mut cmd = Command::new("nvidia-smi");
        cmd.args([
            "--query-gpu=memory.total",
            "--format=csv,noheader,nounits",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let out = cmd.output().ok().filter(|o| o.status.success())?;
        let mut min_mb = u32::MAX;
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Ok(n) = line.trim().parse::<u32>() {
                min_mb = min_mb.min(n);
            }
        }
        if min_mb == u32::MAX {
            return None;
        }
        // 与上游 config.py 的取整一致：GB 数加 0.4 再截断（6 GB 卡报 5.99 也算 6）。
        Some(((min_mb as f64 / 1024.0 + 0.4) as u32).max(1))
    })
}

/// 名字要当目录名和 .pth 文件名用，非法字符会在训练跑了半小时之后才炸。
pub fn validate_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(crate::i18n::t("s.0dabaf60ef").into());
    }
    if n.len() > 60 {
        return Err(crate::i18n::t("s.950d0895e7").into());
    }
    if n.chars().any(|c| "\\/:*?\"<>|".contains(c)) {
        return Err(crate::i18n::t("s.2633fe7d2f").into());
    }
    if n == "mute" {
        return Err(crate::i18n::t("s.2a330f81d4").into());
    }
    if n.starts_with('.') {
        return Err(crate::i18n::t("s.09d3c05d6b").into());
    }
    Ok(())
}

fn preflight(root: &Path, req: &TrainReq) -> Result<(), String> {
    validate_name(&req.exp)?;
    if !paths::runtime_ready(root) {
        return Err(crate::i18n::t("s.dc92f52f68").into());
    }
    if !worker_script(root).is_file() {
        return Err(crate::i18n::t("s.5164f3e0db").into());
    }
    if !train_versions(root).contains(&req.version) {
        return Err(crate::i18n::te("s.trainVersionUnsupported", &(req.version)));
    }
    // 范围校验放在预检里，不只放在界面的滑杆上：命令是能直接 invoke 的，而一个
    // 0 的批大小或者 1e9 的学习率不会报错，只会安静地训出一个废模型 ——
    // 几个小时之后才知道。
    for epoch in [req.sovits_epoch, req.gpt_epoch, req.sovits_save_every, req.gpt_save_every] {
        if epoch < EPOCH_RANGE.0 || epoch > EPOCH_RANGE.1 {
            return Err(crate::i18n::te("s.trainEpochRange", &epoch.to_string()));
        }
    }
    for batch in [req.sovits_batch, req.gpt_batch] {
        if batch < BATCH_RANGE.0 || batch > BATCH_RANGE.1 {
            return Err(crate::i18n::te("s.trainBatchRange", &batch.to_string()));
        }
    }
    if req.lora_rank < LORA_RANK_RANGE.0 || req.lora_rank > LORA_RANK_RANGE.1 {
        return Err(crate::i18n::te("s.trainLoraRange", &req.lora_rank.to_string()));
    }
    if !(req.learning_rate.is_finite()
        && req.learning_rate >= LR_RANGE.0
        && req.learning_rate <= LR_RANGE.1)
    {
        return Err(crate::i18n::te(
            "s.trainLrRange",
            &format!("{}", req.learning_rate),
        ));
    }
    // 底模不再是 RVC 那套按采样率分的 pretrained_v2 + hubert_base.pt + 静音样本，
    // 而是 engine-core 里的 s1v3 / hubert+bert / v2ProPlus 三组 —— 判据统一
    // 交给 engine_assets，缺哪一组它自己报得出来。
    if !crate::engine_assets::engine_core_ready(root) {
        return Err(crate::i18n::t("s.trainEngineCoreMissing").into());
    }
    // 这个版本自己的底模（V5、v4 等不在 engine-core 里，是可选下载）。
    if !base_missing(root, &version_table(root)["versions"][&req.version]).is_empty() {
        return Err(crate::i18n::te("s.trainBaseMissing", &(req.version)));
    }
    // resume 的时候数据集可以不在了 —— 切片/格式化产物已经在实验目录里，
    // 原始素材删掉也无妨。切片目录非空就算有产物（`sliced` 是 prepare 的
    // 第一个落点，比 STAGE_ARTIFACTS[0] 更早出现）。
    let exp_dir = exp_root(root).join(&req.exp);
    let have_slices = count_dir(&exp_dir.join("sliced")) > 0
        || STAGE_ARTIFACTS.iter().any(|a| exp_dir.join(a).exists());
    if !(req.resume && have_slices) && !Path::new(&req.dataset).is_dir() {
        return Err(crate::i18n::t("s.6c4b38602a").into());
    }
    Ok(())
}

/// 这一趟训练目前走到哪。取消或崩的时候，光看「已取消」不够。
#[derive(Default, Clone)]
struct Progress {
    stage: String,
    done: u64,
    total: u64,
    message: String,
}

/// 训练结束不管成败，都把盘上的产物和阶段日志尾巴写进 run log。
///
/// 26.8.16 两份用户日志只有请求 JSON + 一句 ERROR：一份是预处理
/// `_stop` 崩了，另一份是「已取消」。切片切完没有、权重写没写、训到第
/// 几轮，全看不出来。stdout 进度以前只进界面，不进日志。
fn write_outcome(root: &Path, exp: &str, log: &Path, progress: &Progress, outcome: &str) {
    let exp_dir = exp_root(root).join(exp);
    // GSV 格式化阶段产物名 —— 与 STAGE_ARTIFACTS / train_worker 的落点同源。
    let counts = [
        ("sliced", count_dir(&exp_dir.join("sliced"))),
        ("cnhubert", count_dir(&exp_dir.join("4-cnhubert"))),
        ("wav32k", count_dir(&exp_dir.join("5-wav32k"))),
        ("sv", count_dir(&exp_dir.join("7-sv_cn"))),
        ("bert", count_dir(&exp_dir.join("3-bert"))),
    ];
    let list_lines = count_text_lines(&exp_dir.join(format!("{exp}.list")));
    let epoch = latest_epoch(&exp_dir.join("train.log"));
    // 训完的成品是角色包，不是散权重 —— 与 collect() / experiments() 的
    // 「trained」判据同一处落点。
    let role_dir = crate::synth::characters_dir(root).join(crate::characters::safe_id(exp));
    let sovits_w = role_dir.join("models").join("sovits.pth");
    let gpt_w = role_dir.join("models").join("gpt.ckpt");
    // 中途产物 = 两段微调落在 logs_s{1,2}_<版本>/ 里的检查点。
    let mut ckpts: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&exp_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_ckpt_dir = e.path().is_dir()
                && CHECKPOINT_DIR_PREFIXES
                    .iter()
                    .any(|pre| name.starts_with(pre));
            if is_ckpt_dir {
                ckpts.extend(list_pth_names(&e.path()));
            }
        }
    }
    let usable = if crate::logging::file_len(&sovits_w) > 0 && crate::logging::file_len(&gpt_w) > 0
    {
        "final"
    } else if !ckpts.is_empty() {
        "intermediate"
    } else if counts[0].1 > 0 {
        "slices_only"
    } else {
        "none"
    };
    let last = if progress.stage.is_empty() {
        "-".into()
    } else {
        format!(
            "{} {}/{} {}",
            progress.stage, progress.done, progress.total, progress.message
        )
    };
    crate::logging::note_run(
        log,
        &format!(
            "=== outcome ({outcome}) ===\n\
             last: {last}\n\
             usable: {usable}\n\
             latest_epoch: {}\n\
             counts: {}\n\
             list_lines: {list_lines}\n\
             role_sovits: {} ({} bytes)\n\
             role_gpt: {} ({} bytes)\n\
             ckpts: {}",
            epoch.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
            counts
                .iter()
                .map(|(k, n)| format!("{k}={n}"))
                .collect::<Vec<_>>()
                .join(" "),
            sovits_w.display(),
            crate::logging::file_len(&sovits_w),
            gpt_w.display(),
            crate::logging::file_len(&gpt_w),
            if ckpts.is_empty() {
                "-".into()
            } else {
                ckpts.join(",")
            },
        ),
    );
    for name in ["train.log"] {
        crate::logging::append_file(
            log,
            &crate::logging::tail_lines(&exp_dir.join(name), 50, 64 * 1024),
        );
    }
}

fn count_text_lines(p: &Path) -> u64 {
    std::fs::read_to_string(p)
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u64)
        .unwrap_or(0)
}

fn list_pth_names(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("pth") {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect();
    names.sort();
    names
}

fn latest_epoch(train_log: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(train_log).ok()?;
    let marker = "====> Epoch: ";
    let mut last = None;
    for line in text.lines() {
        let Some(at) = line.find(marker) else {
            continue;
        };
        let tail = line[at + marker.len()..].split_whitespace().next()?;
        if let Ok(n) = tail.parse::<u32>() {
            last = Some(n);
        }
    }
    last
}

fn note_progress(log: &Path, v: &Value, progress: &mut Progress) {
    let phase = v.get("phase").and_then(|x| x.as_str()).unwrap_or("");
    let stage = v.get("stage").and_then(|x| x.as_str()).unwrap_or("");
    let message_owned = crate::i18n::t_worker_msg(v);
    let message = message_owned.as_str();
    let done = v
        .get("done")
        .and_then(|x| x.as_u64().or_else(|| x.as_i64().map(|n| n as u64)));
    let total = v
        .get("total")
        .and_then(|x| x.as_u64().or_else(|| x.as_i64().map(|n| n as u64)));
    if !stage.is_empty() {
        progress.stage = stage.to_string();
    } else if matches!(phase, "start" | "done" | "error" | "env") {
        progress.stage = phase.to_string();
    }
    if let Some(n) = done {
        progress.done = n;
    }
    if let Some(n) = total {
        progress.total = n;
    }
    if !message.is_empty() {
        progress.message = message.to_string();
    }
    // checkpoint 行已经是一份完整快照，原样落下；普通进度压成一行。
    if phase == "checkpoint" || phase == "env" {
        crate::logging::note_run(
            log,
            &format!(
                "{phase} {}",
                serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
            ),
        );
        return;
    }
    crate::logging::note_run(
        log,
        &format!(
            "progress {phase} stage={} {}/{} {}",
            if stage.is_empty() { "-" } else { stage },
            done.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
            total.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
            message,
        ),
    );
}


/// 校验用户选的音色存放目录，返回归一化后的路径（空 = 用默认的 `User_Data/models`）。
///
/// 必须是绝对路径：相对路径会跟着进程的 cwd 走，训了几小时最后落在谁也找不到
/// 的地方。也必须现在就建得出来 —— 拔掉的移动硬盘、写保护的目录，等训完再发现
/// 就是几小时白烧。
pub fn normalize_output_dir(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(String::new());
    }
    let p = Path::new(t);
    if !p.is_absolute() {
        return Err(crate::i18n::te("s.trainOutRelative", &t));
    }
    std::fs::create_dir_all(p).map_err(|e| crate::i18n::t2("s.trainOutUnwritable", &t, &e))?;
    Ok(p.to_string_lossy().into_owned())
}

/// 阻塞跑一次训练，调用方负责挪到后台线程。
pub fn run(app: &AppHandle, root: &Path, mut req: TrainReq) -> Result<Value, String> {
    {
        let mut g = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        if *g {
            return Err(crate::i18n::t("s.fce4b463c1").into());
        }
        *g = true;
    }
    cancel_flag().store(false, Ordering::SeqCst);
    // 训练是这里最吃显存的一件事。合成留下的常驻 worker 还攥着 GPT + SoVITS
    // 两份权重，先放掉再开，别让训练从第一步就 OOM。
    crate::synth::shutdown();
    // 先把输出目录判掉：训了几小时最后落不下去，那几小时就白烧了。
    let out_dir = match normalize_output_dir(&req.output_dir) {
        Ok(d) => d,
        Err(e) => {
            *BUSY.lock().unwrap_or_else(|err| err.into_inner()) = false;
            return Err(e);
        }
    };
    // 记住选择：音色库要一直扫这个目录，不然重启之后训好的音色就「消失」了。
    let _ = crate::config::set_train_output_dir(root, &out_dir);
    req.output_dir = out_dir;
    let device = if is_nvidia(root) { "cuda" } else { "cpu" };
    let log = crate::logging::begin_run(
        root,
        crate::logging::CH_TRAIN,
        &json!({
            "exp": req.exp,
            "dataset": req.dataset,
            "version": req.version,
            "sovits_epoch": req.sovits_epoch,
            "sovits_batch": req.sovits_batch,
            "sovits_save_every": req.sovits_save_every,
            "gpt_epoch": req.gpt_epoch,
            "gpt_batch": req.gpt_batch,
            "gpt_save_every": req.gpt_save_every,
            "learning_rate": req.learning_rate,
            "lora_rank": req.lora_rank,
            "resume": req.resume,
            "output_dir": req.output_dir,
            "device": device,
        }),
    );
    crate::logging::shell_log!(
        "train run log {}",
        log.file_name().and_then(|s| s.to_str()).unwrap_or("train")
    );
    let mut progress = Progress::default();
    let result = run_inner(app, root, &req, &log, &mut progress);
    let outcome = match &result {
        Ok(_) => "ok",
        Err(e) if e == &crate::i18n::t("s.a5ffdc95ee") => "cancelled",
        Err(_) => "error",
    };
    write_outcome(root, req.exp.trim(), &log, &progress, outcome);
    match &result {
        Ok(_) => crate::logging::finish_run(&log, true, "ok"),
        Err(e) => {
            crate::logging::note_run(&log, &format!("ERROR {e}"));
            crate::logging::finish_run(&log, true, outcome);
        }
    }
    *BUSY.lock().unwrap_or_else(|e| e.into_inner()) = false;
    *CHILD.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Err(ref e) = result {
        emit(app, json!({ "phase": "error", "message": e }));
    }
    result
}

fn run_inner(
    app: &AppHandle,
    root: &Path,
    req: &TrainReq,
    log: &Path,
    progress: &mut Progress,
) -> Result<Value, String> {
    preflight(root, req)?;

    // 参数走临时文件不走命令行：数据集路径里有中文和空格是常态。
    let reqfile = paths::update_cache(root).join("train_request.json");
    if let Some(p) = reqfile.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let device = if is_nvidia(root) { "cuda" } else { "cpu" };
    let payload = json!({
        "exp": req.exp.trim(),
        "dataset": req.dataset,
        "version": req.version,
        "sovits_epoch": req.sovits_epoch,
        "sovits_batch": req.sovits_batch,
        "sovits_save_every": req.sovits_save_every,
        "gpt_epoch": req.gpt_epoch,
        "gpt_batch": req.gpt_batch,
        "gpt_save_every": req.gpt_save_every,
        "learning_rate": req.learning_rate,
        "lora_rank": req.lora_rank,
        "device": device,
        "is_half": device == "cuda",
        "resume": req.resume,
        "output_dir": req.output_dir,
        // 落点由壳算好交过去，不让 worker 自己拼 —— 两边各拼一遍就会出现
        // 「壳去 A 找产物、worker 写在 B」这种查半天的错。
        "exp_dir": exp_root(root).join(req.exp.trim()).to_string_lossy(),
        // 训完的角色直接装进合成台扫的那个目录。
        "role_dir": crate::synth::characters_dir(root)
            .join(crate::characters::safe_id(req.exp.trim()))
            .to_string_lossy(),
    });
    std::fs::write(
        &reqfile,
        serde_json::to_string_pretty(&payload).unwrap_or_default(),
    )
    .map_err(|e| crate::i18n::te("s.5ee0565f28", &(e)))?;

    let py = paths::runtime_python(root).ok_or(crate::i18n::t("s.47e57cab60"))?;
    let errfile = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .ok();

    let mut cmd = Command::new(&py);
    cmd.arg(worker_script(root).as_os_str())
        .arg(reqfile.as_os_str())
        .current_dir(root)
        .envs(crate::worker::env_for_runtime(root))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(match errfile {
            Some(f) => Stdio::from(f),
            None => Stdio::null(),
        });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child: Child = cmd.spawn().map_err(|e| crate::i18n::te("s.217047672d", &(e)))?;
    *CHILD.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
    let _keep = crate::worker::ToolPidGuard::new(child.id());
    let stdout = child.stdout.take().ok_or(crate::i18n::t("s.c73d43b29b"))?;

    let mut done: Option<Value> = None;
    let mut fail: Option<String> = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if cancel_flag().load(Ordering::SeqCst) {
            kill_tree(child.id());
            let _ = child.wait();
            return Err(crate::i18n::t("s.a5ffdc95ee").into());
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue; // 不是协议行（tqdm 之类），忽略
        };
        note_progress(log, &v, progress);
        match v.get("phase").and_then(|x| x.as_str()).unwrap_or("") {
            "error" => {
                fail = Some({
                    let m = crate::i18n::t_worker_msg(&v);
                    if m.is_empty() {
                        crate::i18n::t("s.60a21a8105")
                    } else {
                        m
                    }
                })
            }
            "done" => done = Some(v.clone()),
            _ => {}
        }
        emit(app, v);
    }

    let st = child.wait().map_err(|e| crate::i18n::te("s.d21a4981b7", &(e)))?;
    if cancel_flag().load(Ordering::SeqCst) {
        return Err(crate::i18n::t("s.a5ffdc95ee").into());
    }
    if let Some(e) = fail {
        return Err(e);
    }
    if !st.success() {
        return Err(crate::i18n::t2("s.7803aff201", &st.code().unwrap_or(-1), &req.exp.trim()));
    }
    let d = done.ok_or(crate::i18n::t("s.7dc4ea39fd"))?;
    // 预处理/特征提取可能在 TEMP 落中间文件。
    let stats = crate::paths::clean_temps(root);
    crate::paths::log_clean_stats(&crate::i18n::t("s.4546433411"), root, &stats);
    Ok(json!({
        "ok": true,
        "weights": d.get("weights").cloned().unwrap_or(Value::Null),
        "index": d.get("index").cloned().unwrap_or(Value::Null),
        // 一次训练留下的切片 / 音高 / 特征动辄几个 GB，而用户完全看不见。
        // 训练刚跑完是唯一一个他会读这句话的时刻。只报数，不自动删。
        "leftover_bytes": stage_artifact_bytes(&exp_root(root).join(req.exp.trim())),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ffmpeg 的报告解析：mean_volume 取到，静音时长累加，解析不出就 None/0。
    #[test]
    fn volume_report_parsing_takes_mean_and_sums_silence() {
        let text = "[Parsed_silencedetect_0 @ 0x1] silence_start: 1.0\n\
                    [Parsed_silencedetect_0 @ 0x1] silence_end: 3.5 | silence_duration: 2.5\n\
                    [Parsed_silencedetect_0 @ 0x1] silence_start: 10.0\n\
                    [Parsed_silencedetect_0 @ 0x1] silence_end: 11.0 | silence_duration: 1.0\n\
                    [Parsed_volumedetect_1 @ 0x2] mean_volume: -23.6 dB\n\
                    [Parsed_volumedetect_1 @ 0x2] max_volume: -3.1 dB\n";
        let (mean, silence) = parse_volume_report(text);
        assert_eq!(mean, Some(-23.6));
        assert!((silence - 3.5).abs() < 1e-9);
        let (mean, silence) = parse_volume_report("no report at all");
        assert_eq!(mean, None);
        assert_eq!(silence, 0.0);
    }

    /// 扫描给出的数字必须就是删除会释放的数字，而且不该删的不能出现在清单里。
    #[test]
    fn the_cleanup_scan_and_apply_agree_and_spare_everything_irreplaceable() {
        let root = crate::testutil::scratch("cleanup");
        let _ = std::fs::remove_dir_all(&root);
        let exp = crate::train::exp_root(&root).join("miku");
        let models = root.join("User_Data").join("models");
        std::fs::create_dir_all(exp.join("5-wav32k")).unwrap();
        // 上游在检查点目录下还会再分子目录，list_files 要递归才扫得到。
        std::fs::create_dir_all(exp.join("logs_s2").join("eval")).unwrap();
        std::fs::create_dir_all(exp.join("logs_s1")).unwrap();
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(exp.join("5-wav32k").join("a.wav"), vec![0u8; 300]).unwrap();
        std::fs::write(exp.join("2-name2text.txt"), vec![0u8; 20]).unwrap();
        std::fs::write(exp.join("logs_s2").join("G_100.pth"), vec![0u8; 200]).unwrap();
        std::fs::write(exp.join("logs_s2").join("eval").join("D_100.pth"), vec![0u8; 100]).unwrap();
        std::fs::write(exp.join("logs_s1").join("epoch=8.ckpt"), vec![0u8; 100]).unwrap();
        std::fs::write(exp.join("train.log"), vec![0u8; 5]).unwrap();
        std::fs::write(models.join("miku.pth"), vec![0u8; 999]).unwrap();

        let scan = cleanup_scan(&root);
        let row = &scan.as_array().unwrap()[0];
        assert_eq!(row["exp"], "miku");
        assert_eq!(row["kinds"]["checkpoints"]["bytes"].as_u64(), Some(400));
        assert_eq!(row["kinds"]["dataset"]["bytes"].as_u64(), Some(320));
        assert_eq!(row["total_bytes"].as_u64(), Some(720));

        // 只勾一类，另一类必须原样留着。
        let freed = cleanup_apply(&root, "miku", &["checkpoints".to_string()]).unwrap();
        assert_eq!(freed, 400);
        assert!(!exp.join("logs_s2").join("G_100.pth").exists());
        assert!(!exp.join("logs_s1").join("epoch=8.ckpt").exists());
        assert!(exp.join("5-wav32k").join("a.wav").is_file(), "没勾的类别不能动");
        assert!(models.join("miku.pth").is_file(), "训好的角色永远不动");
        assert!(exp.join("train.log").is_file(), "日志永远不动");

        // 认不出来的类别名直接忽略，不做任何事。
        assert_eq!(cleanup_apply(&root, "miku", &["everything".to_string()]).unwrap(), 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 删中间产物这件事，删错一次就是用户几十分钟白跑。所以钉死两件：
    /// 该删的一个不剩，不该删的一个不碰。
    #[test]
    fn resetting_stages_removes_only_the_regenerable_artifacts() {
        let root = crate::testutil::scratch("reset-stages");
        let _ = std::fs::remove_dir_all(&root);
        let exp = crate::train::exp_root(&root).join("miku");
        std::fs::create_dir_all(exp.join("5-wav32k")).unwrap();
        std::fs::create_dir_all(exp.join("3-bert")).unwrap();
        std::fs::create_dir_all(exp.join("4-cnhubert")).unwrap();
        std::fs::create_dir_all(exp.join("logs_s2_v2ProPlus")).unwrap();
        std::fs::write(exp.join("5-wav32k").join("a.wav"), vec![0u8; 100]).unwrap();
        std::fs::write(exp.join("3-bert").join("a.pt"), vec![0u8; 50]).unwrap();
        std::fs::write(exp.join("2-name2text.txt"), b"x").unwrap();
        // 这两样不可再生，绝不能碰。
        std::fs::write(exp.join("logs_s2_v2ProPlus").join("G_2333.pth"), b"checkpoint").unwrap();
        std::fs::write(exp.join("train.log"), b"log").unwrap();

        assert_eq!(stage_artifact_bytes(&exp), 151);
        let freed = cleanup_apply(&root, "miku", &["dataset".into()]).unwrap();
        assert_eq!(freed, 151);
        assert!(!exp.join("5-wav32k").exists());
        assert!(!exp.join("3-bert").exists());
        assert!(!exp.join("2-name2text.txt").exists());
        assert!(
            exp.join("logs_s2_v2ProPlus").join("G_2333.pth").is_file(),
            "微调检查点不能删"
        );
        assert!(exp.join("train.log").is_file(), "日志不能删");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 实验名里带路径分隔符时必须拒绝 —— 这是删除操作，`../..` 不能有第二种解读。
    #[test]
    fn resetting_refuses_anything_that_could_escape_the_experiment_folder() {
        let root = crate::testutil::scratch("reset-escape");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(crate::train::exp_root(&root)).unwrap();
        for bad in ["", "   ", "..", ".", "../mute", "a/b", "a\\b", "C:x"] {
            assert!(
                cleanup_apply(&root, bad, &["dataset".into()]).is_err(),
                "{bad:?} 应该被拒绝"
            );
        }
        // 不存在的实验也拒绝，而不是「删了 0 字节」假装成功。
        assert!(cleanup_apply(&root, "nope", &["dataset".into()]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 两边认的音频后缀必须是同一套。
    ///
    /// 界面上报「找到 120 个音频」而 worker 只认出 80 个，比不报还糟：用户
    /// 会拿这个数字判断自己的数据集够不够，而它是假的。这条测试直接去读
    /// `train_worker.py` 里的那一行，改一边忘了另一边就红。
    ///
    /// 这个测试曾经以一段注释的形式「暂时缺席」—— 理由是 GSV 的 worker
    /// 还没写。worker 早写完了，注释留着就成了一条不会响的闸。
    #[test]
    fn the_audio_extensions_match_the_python_side() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("engine-payload/tools/train_worker.py"),
        )
        .expect("train_worker.py 必须随 payload 发出去");

        let line = src
            .lines()
            .find(|l| l.trim_start().starts_with("AUDIO_EXT"))
            .expect("train_worker.py 里没有 AUDIO_EXT");
        let mut py: Vec<String> = line
            .split('"')
            .skip(1)
            .step_by(2)
            .map(|s| s.trim_start_matches('.').to_ascii_lowercase())
            .collect();
        assert!(py.len() > 3, "只解析出 {} 个后缀，正则多半失效了", py.len());

        let mut rs: Vec<String> = DATASET_AUDIO_EXT.iter().map(|s| s.to_string()).collect();
        py.sort();
        rs.sort();
        assert_eq!(
            rs, py,
            "Rust 的 DATASET_AUDIO_EXT 和 train_worker.py 的 AUDIO_EXT 对不上"
        );
    }

    #[test]
    fn a_dataset_scan_counts_audio_recursively_and_ignores_the_rest() {
        let base = crate::testutil::scratch("scan-dataset");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("歌手A")).unwrap();
        std::fs::write(base.join("a.wav"), b"1234").unwrap();
        std::fs::write(base.join("歌手A").join("b.MP3"), b"12").unwrap();
        std::fs::write(base.join("cover.jpg"), b"x").unwrap();
        std::fs::write(base.join("readme.txt"), b"x").unwrap();

        let v = scan_dataset(&base);
        // 子目录里的也算 —— 用户按歌手分文件夹是常态，preprocess 也是 os.walk。
        assert_eq!(v["files"].as_u64(), Some(2));
        // 大小写不敏感：.MP3 也是音频。
        assert_eq!(v["by_ext"]["mp3"].as_u64(), Some(1));
        assert_eq!(v["by_ext"]["wav"].as_u64(), Some(1));
        assert_eq!(v["other_files"].as_u64(), Some(2));
        assert_eq!(v["total_bytes"].as_u64(), Some(6));

        // 空目录报 0，不是报错 —— 界面靠这个 0 把提示标红。
        let empty = base.join("空的");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(scan_dataset(&empty)["files"].as_u64(), Some(0));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_output_dir_means_the_default_library() {
        assert_eq!(normalize_output_dir("").unwrap(), "");
        assert_eq!(normalize_output_dir("   ").unwrap(), "");
    }

    #[test]
    fn a_relative_output_dir_is_rejected() {
        // 相对路径跟着进程的 cwd 走。训了几小时，音色落在谁也找不到的地方，
        // 而用户看到的只是「训练完成」。
        let _g = crate::i18n::testing::pin("zh-CN");
        for bad in ["models", "./out", "..\\elsewhere"] {
            assert!(normalize_output_dir(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn an_absolute_output_dir_is_created_up_front() {
        // 建不出来就得当场报错 —— 拔掉的移动硬盘、写保护的目录，等训完再
        // 发现就是几小时白烧。
        let _g = crate::i18n::testing::pin("zh-CN");
        let root = crate::testutil::scratch("train-out");
        let base = root.join("nested");
        let got = normalize_output_dir(&base.to_string_lossy()).expect("should accept");
        assert!(Path::new(&got).is_dir(), "目录应当已经建好：{got}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_names_that_would_break_a_path() {
        // 语言是进程级全局状态，cargo 默认多线程跑测试。不钉住的话，
        // 断言里两次取文案可能落在不同语言上（实测到过法语 vs 韩语）。
        let _g = crate::i18n::testing::pin("zh-CN");
        // 这些字符不拦，用户会在训练跑了半小时之后收到一个建目录失败。
        for bad in ["", "  ", "a/b", "a\\b", "c:d", "x?y", "*", ".hidden", "mute"] {
            assert!(validate_name(bad).is_err(), "should reject {bad:?}");
        }
        for ok in [&crate::i18n::t("s.6ca6738e54"), "my voice", "voice-2026_v2"] {
            assert!(validate_name(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn mute_is_not_listed_as_a_user_experiment() {
        // 语言是进程级全局状态，别的测试改了会让这里的 t() 前后取到两种语言。
        let _g = crate::i18n::testing::pin("zh-CN");
        // logs/mute 是随包发的静音样本。列出来用户会以为那是自己的音色。
        let base = crate::testutil::scratch("train-exps");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(crate::train::exp_root(&base).join("mute")).unwrap();
        std::fs::create_dir_all(crate::train::exp_root(&base).join(&crate::i18n::t("s.6ca6738e54")).join("sliced")).unwrap();
        std::fs::write(
            crate::train::exp_root(&base).join(&crate::i18n::t("s.6ca6738e54")).join("sliced").join("a.wav"),
            b"x",
        )
        .unwrap();

        let exps = experiments(&base);
        assert_eq!(exps.len(), 1);
        assert_eq!(exps[0]["name"], json!(crate::i18n::t("s.6ca6738e54")));
        assert_eq!(exps[0]["slices"], json!(1));
        assert_eq!(exps[0]["resumable"], json!(true));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unfinished_train_log_reports_where_it_stopped() {
        // 壳被强杀 → 日志里没有 `=== done (…) ===`，界面据此告诉用户
        // 「上次断在第几轮、切片还在、可以续跑」。
        // 格式化阶段的行不算数：那一步重跑一遍就有，值得提示的是微调。
        let text = "=== train run 2026-08-18 11:42:56 ===\n                    {\n  \"exp\": \"tomori\",\n  \"total_epoch\": 200\n}\n                    2026-08-18 11:43:22 progress stage stage=format 3/3 训练集就绪\n                    2026-08-18 11:43:30 progress stage stage=sovits 0/200 微调 SoVITS…\n                    2026-08-18 11:58:45 progress stage stage=sovits 99/200 第 99 / 200 轮\n";
        assert_eq!(parse_interrupted(text), Some(("tomori".into(), 99, 200)));
    }

    #[test]
    fn a_run_that_never_reached_epoch_one_is_not_worth_a_prompt() {
        // 只跑到「准备训练」就断了，没有中间产物可续，提示反而添乱。
        let text = "{\n  \"exp\": \"tomori\"\n}\n                    progress stage stage=sovits 0/200 微调 SoVITS…\n";
        assert_eq!(parse_interrupted(text), None);
    }

    #[test]
    fn a_log_without_an_exp_name_is_ignored() {
        let text = "progress stage stage=gpt 9/200 第 9 / 200 轮\n";
        assert_eq!(parse_interrupted(text), None);
    }

    #[test]
    fn latest_epoch_reads_the_last_marker() {
        let td = crate::testutil::scratch("train-epoch");
        let _ = std::fs::remove_dir_all(&td);
        std::fs::create_dir_all(&td).unwrap();
        let p = td.join("train.log");
        std::fs::write(
            &p,
            "noise\n====> Epoch: 1 [t]\n====> Epoch: 2 [t]\n====> Epoch: 2 [t]\n",
        )
        .unwrap();
        assert_eq!(latest_epoch(&p), Some(2));
        assert_eq!(latest_epoch(&td.join("missing.log")), None);
        let _ = std::fs::remove_dir_all(&td);
    }

    #[test]
    fn outcome_report_can_tell_slices_from_a_finished_model() {
        let td = crate::testutil::scratch("train-outcome");
        let _ = std::fs::remove_dir_all(&td);
        let exp = crate::train::exp_root(&td).join("voice");
        std::fs::create_dir_all(exp.join("sliced")).unwrap();
        std::fs::write(exp.join("sliced").join("a.wav"), b"x").unwrap();
        std::fs::write(exp.join("train.log"), "sliced 1 file\n").unwrap();
        let log = td.join("run.log");
        std::fs::write(&log, b"").unwrap();
        let progress = Progress {
            stage: "prepare".into(),
            done: 1,
            total: 1,
            message: "切片与重采样…".into(),
        };
        write_outcome(&td, "voice", &log, &progress, "cancelled");
        let body = std::fs::read_to_string(&log).unwrap();
        assert!(body.contains("usable: slices_only"), "{body}");
        assert!(body.contains("sliced=1"), "{body}");
        assert!(body.contains("last: prepare 1/1"), "{body}");
        assert!(body.contains("train.log"), "{body}");
        assert!(body.contains("sliced 1 file"), "{body}");

        // 成品 = 角色包的两份权重，与 collect() 的落点一致。
        let role = crate::synth::characters_dir(&td)
            .join("voice")
            .join("models");
        std::fs::create_dir_all(&role).unwrap();
        std::fs::write(role.join("sovits.pth"), b"pth").unwrap();
        std::fs::write(role.join("gpt.ckpt"), b"ckpt").unwrap();
        write_outcome(&td, "voice", &log, &progress, "ok");
        let body = std::fs::read_to_string(&log).unwrap();
        assert!(body.contains("usable: final"), "{body}");
        let _ = std::fs::remove_dir_all(&td);
    }

    #[test]
    fn preflight_refuses_before_it_can_waste_hours() {
        let base = crate::testutil::scratch("train-preflight");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let ok = || TrainReq {
            exp: "x".into(),
            dataset: base.to_string_lossy().into(),
            version: "v2ProPlus".into(),
            sovits_epoch: 8,
            sovits_batch: 4,
            sovits_save_every: 4,
            gpt_epoch: 15,
            gpt_batch: 4,
            gpt_save_every: 5,
            learning_rate: 1e-4,
            lora_rank: 32,
            resume: false,
            output_dir: String::new(),
        };
        // 没 Runtime 就该在这里停，而不是起个进程再失败。
        assert!(preflight(&base, &ok()).is_err());

        // 参数范围也在预检里判 —— 命令是能直接 invoke 的，界面的滑杆拦不住
        // 一个 0 的批大小或者 1e9 的学习率，而那两样不会报错，只会安静地
        // 训出一个废模型。
        for bad in [
            TrainReq { version: "v3".into(), ..ok() },
            TrainReq { sovits_epoch: 0, ..ok() },
            TrainReq { gpt_epoch: EPOCH_RANGE.1 + 1, ..ok() },
            TrainReq { sovits_batch: 0, ..ok() },
            TrainReq { gpt_batch: BATCH_RANGE.1 + 1, ..ok() },
            TrainReq { lora_rank: 0, ..ok() },
            TrainReq { learning_rate: 0.0, ..ok() },
            TrainReq { learning_rate: 1.0, ..ok() },
            TrainReq { learning_rate: f64::NAN, ..ok() },
        ] {
            assert!(preflight(&base, &bad).is_err(), "{bad:?} 应当被拒");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 训练产物与角色落点：壳算的和 worker 兜底算的必须是同一个目录。
    ///
    /// worker 现在从请求里拿 `exp_dir` / `role_dir`，但它自己也留了一份兜底
    /// （手工调起来排障时用）。两边算不出同一个目录名，就会出现「训完了，
    /// 合成台看不见」—— 而那正是这次要修的毛病，不该由同一份代码再制造一遍。
    #[test]
    fn the_shell_and_the_worker_agree_on_where_things_land() {
        let root = crate::testutil::scratch("train-dirs");
        // 实验目录必须在 User_Data 底下，不能再落回安装根的 logs/。
        let exp = exp_root(&root);
        assert!(
            exp.starts_with(crate::paths::user_data(&root)),
            "训练产物必须在 User_Data 内，卸载时的「保留用户数据」才盖得住：{}",
            exp.display()
        );
        assert!(exp.ends_with("train"), "{}", exp.display());

        // 角色落点用的清洗要和 characters::safe_id 一致。
        for name in ["Tomori", "高松灯", "a b/c", "  --  "] {
            let id = crate::characters::safe_id(name);
            let dir = crate::synth::characters_dir(&root).join(&id);
            assert!(
                dir.starts_with(crate::synth::characters_dir(&root)),
                "{name:?} 清洗后逃出了角色目录：{}",
                dir.display()
            );
            assert!(!id.is_empty(), "{name:?} 清洗成了空串");
        }
        // worker 侧那份兜底是照着这两条写的，改了这里要同步改
        // train_worker.py 的 `safe_id` 与 `normalize`。
        assert_eq!(crate::characters::safe_id("高松灯"), "role");
        assert_eq!(crate::characters::safe_id("Tomori"), "tomori");
    }

    /// worker 报的每一个 `message_code`，语言包里必须真的有。
    ///
    /// 这一条钉的是壳与 worker 之间唯一一条**跨语言**的契约。对不上不会报错：
    /// `t_worker_msg` 查不到 key 就回落到 worker 自带的那句英文兜底 —— 于是
    /// 中文界面上冒出一句英文，而且只在那个分支真的走到时才看得见（缺底模、
    /// OOM、转写失败，全是不常走的路）。RVC 那边有一条等价的契约测试，
    /// GSV 一直缺，因为 worker 一直不存在。
    #[test]
    fn every_message_code_the_worker_emits_exists_in_the_language_pack() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("engine-payload/tools/train_worker.py"),
        )
        .expect("train_worker.py 必须随 payload 发出去");

        // 四种发 code 的写法。**按调用形状取，不是把所有小写字面量都当 code**
        // —— 那样会把 say() 的阶段名、dict 的键名、文档里的例子一起收进来，
        // 测试就从「钉住契约」变成「钉住我的正则」。
        //
        //   say(<stage>, "<code>", …)    第二个字符串参数
        //   Fail("<code>", …)            第一个
        //   need(<path>, "<code>", …)    第二个
        //   message_code="train.<code>"  字面量
        fn is_code(s: &str) -> bool {
            !s.is_empty() && s.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_')
        }

        fn args(src: &str, pat: &str) -> Vec<Vec<String>> {
            let mut out = Vec::new();
            let mut at = 0;
            while let Some(i) = src[at..].find(pat) {
                let head = at + i + pat.len();
                at = head;
                let Some(close) = src[head..].find(')') else { break };
                out.push(
                    src[head..head + close]
                        .split('"')
                        .skip(1)
                        .step_by(2)
                        .map(str::to_string)
                        .collect(),
                );
            }
            out
        }

        let mut codes: Vec<String> = Vec::new();
        for a in args(&src, "say(") {
            if let Some(c) = a.get(1) {
                codes.push(c.clone());
            }
        }
        for a in args(&src, "Fail(") {
            if let Some(c) = a.first() {
                codes.push(c.clone());
            }
        }
        // need() 的第一个参数是路径，code 紧随其后 —— 但路径**可能是常量**
        // （`need(BERT_DIR, "bert_missing", …)`），那时候 code 就落到第 0 位。
        // 按下标取会整类漏掉：`retain` 那道形状过滤把误取到的整句英文剔掉，
        // 于是测试照样绿，而真正的 code 一次都没被检查过。改成「第一个长得像
        // code 的参数」—— 路径字面量带大写、`/` 和 `.`，不会被误认。
        for a in args(&src, "need(") {
            if let Some(c) = a.iter().find(|x| is_code(x)) {
                codes.push(c.clone());
            }
        }
        let lit = "message_code=\"train.";
        for (i, _) in src.match_indices(lit) {
            let rest = &src[i + lit.len()..];
            if let Some(end) = rest.find('"') {
                codes.push(rest[..end].to_string());
            }
        }
        codes.retain(|c| is_code(c));
        codes.sort();
        codes.dedup();
        assert!(codes.len() > 20, "只认出 {} 个 code，正则多半失效了", codes.len());

        let _g = crate::i18n::testing::pin("zh-CN");
        let mut missing: Vec<String> = Vec::new();
        for c in &codes {
            let key = format!("msg.train.{c}");
            if crate::i18n::t(&key) == key {
                missing.push(key);
            }
        }
        assert!(missing.is_empty(), "语言包里没有这些 code：{missing:?}");
    }

    /// worker 真实输出的那几行，喂进壳的解析器，看取出来的是不是人话。
    ///
    /// 这几行是把 `train_worker.py` 拿五种输入实跑之后原样抄下来的（空数据集、
    /// 有现成标注、坏版本、请求文件缺失、没参数），不是照着协议手写的 ——
    /// 手写的话，写错的地方两边会一起错。
    #[test]
    fn the_lines_the_worker_actually_prints_come_out_as_sentences() {
        let _g = crate::i18n::testing::pin("zh-CN");
        let log = crate::testutil::scratch("worker-lines");
        let _ = std::fs::remove_dir_all(&log);
        std::fs::create_dir_all(&log).unwrap();
        let log = log.join("train.log");
        let mut progress = Progress::default();

        let lines = [
            r#"{"phase":"start"}"#,
            r#"{"phase":"env","device":"cpu","version":"v2ProPlus","is_half":false}"#,
            r#"{"phase":"stage","stage":"prepare","message_code":"train.skip_prepare","message":"using the existing annotation file","message_params":{"name":"tomori.list","count":"1"},"done":1,"total":1}"#,
            r#"{"phase":"stage","stage":"sovits","message_code":"train.sovits_started","message":"fine-tuning SoVITS","done":0,"total":24}"#,
            r#"{"phase":"checkpoint","stage":"sovits","path":"logs/tomori/logs_s2/G_100.pth","bytes":123}"#,
            r#"{"phase":"error","message_code":"train.bert_missing","message":"the BERT base model is missing","message_params":{}}"#,
        ];
        for l in lines {
            let v: Value = serde_json::from_str(l).expect(l);
            note_progress(&log, &v, &mut progress);
        }

        // 最后一条是错误，取出来必须是中文那句，不是 worker 自带的英文兜底，
        // 更不是 key 本身。
        let last: Value = serde_json::from_str(lines[5]).unwrap();
        let msg = crate::i18n::t_worker_msg(&last);
        assert!(msg.contains("cnhubert") || msg.contains("BERT"), "{msg}");
        assert!(!msg.starts_with("msg."), "取到的是 key 不是文案：{msg}");
        assert_ne!(msg, "the BERT base model is missing", "回落到英文兜底了");

        // 带参数的那条要把参数填进去。
        let skip: Value = serde_json::from_str(lines[2]).unwrap();
        let msg = crate::i18n::t_worker_msg(&skip);
        assert!(msg.contains("tomori.list"), "{msg}");

        // 进度状态跟着最后一条 stage 走 —— 断点续跑读的就是它。
        assert_eq!(progress.stage, "error");
        let body = std::fs::read_to_string(&log).unwrap();
        assert!(body.contains("stage=sovits 0/24"), "{body}");
        assert!(body.contains("checkpoint"), "checkpoint 行要原样落盘：{body}");

        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    /// worker 必须真的在 payload 里。少了它，预检会报「安装不完整」，
    /// 而这件事在打包之后才发现就太晚了。
    #[test]
    fn the_worker_script_ships_with_the_payload() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("engine-payload/tools/train_worker.py");
        assert!(p.is_file(), "{} 不在", p.display());
    }

    /// 反过来也要管：语言包里挂着 worker 根本不发的 code，就是下一批死文案。
    #[test]
    fn the_language_pack_has_no_message_code_the_worker_never_emits() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("engine-payload/tools/train_worker.py"),
        )
        .expect("train_worker.py");
        let pack = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../i18n/locales/zh-CN.json"),
        )
        .expect("zh-CN.json");
        let v: Value = serde_json::from_str(&pack).expect("zh-CN.json 不是合法 JSON");
        let train = v
            .get("msg")
            .and_then(|m| m.get("train"))
            .and_then(|t| t.as_object())
            .expect("msg.train");

        // 两种形式都算数：`say(…, "oom", …)` 和 `message_code="train.usage"`。
        let mut stale: Vec<&String> = train
            .keys()
            .filter(|k| {
                !src.contains(&format!("\"{k}\"")) && !src.contains(&format!("\"train.{k}\""))
            })
            .collect();
        stale.sort();
        assert!(stale.is_empty(), "worker 不发这些，删掉：{stale:?}");
    }

    /// 随包的版本表与默认值：默认版本可训练，每个版本的默认参数都落在
    /// 预检认的范围里 —— 否则用户什么都不改、直接开始就会被预检拦下。
    #[test]
    fn the_bundled_defaults_pass_preflight_ranges() {
        let payload = Path::new(env!("CARGO_MANIFEST_DIR")).join("engine-payload");
        let list = train_versions(&payload);
        assert!(!list.is_empty(), "版本表为空：先跑 prepare_engine_payload.py --versions");
        assert!(list.contains(&default_version(&payload)));
        for v in versions_status(&payload) {
            let d = &v["defaults"];
            for (part, keys) in [("sovits", ["epochs", "save_every"]), ("gpt", ["epochs", "save_every"])] {
                for k in keys {
                    let n = d[part][k].as_u64().unwrap() as u32;
                    assert!((EPOCH_RANGE.0..=EPOCH_RANGE.1).contains(&n), "{v} {part}.{k}");
                }
                let b = d[part]["batch"].as_u64().unwrap() as u32;
                assert!((BATCH_RANGE.0..=BATCH_RANGE.1).contains(&b), "{v} {part}.batch");
            }
            let lr = d["sovits"]["learning_rate"].as_f64().unwrap();
            assert!(LR_RANGE.0 <= lr && lr <= LR_RANGE.1);
        }
    }

    #[test]
    fn stage_artifacts_and_checkpoints_never_overlap() {
        // 两张表混了就是灾难：清理「中间产物」时把微调检查点一起删掉，
        // 那是几个小时白烧，而且不可再生。
        for a in STAGE_ARTIFACTS {
            assert!(
                !CHECKPOINT_DIR_PREFIXES.iter().any(|p| a.starts_with(p)),
                "{a} 同时在两张表里"
            );
        }
    }
}
