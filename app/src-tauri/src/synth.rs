//! 合成引擎托管：常驻 synth_worker.py 的 spawn、行协议、取消与事件转发。
//!
//! 与 sts.rs 的一次性进程不同，合成 worker 是**常驻**的：模型加载动辄十几秒，
//! 跨批复用显存里的权重是整个产品体验的根基（docs/DECISIONS.md D2）。所以这里
//! 管的是一个长命进程的生命周期：
//!
//!   * spawn：`Runtime\pythonw.exe tools\synth_worker.py --resident`，
//!     ready 行表示协议层就绪（GPT_SoVITS 是懒加载，缺源码不影响 ready）
//!   * 协议：stdin 写请求，stdout 逐行读回应；请求→回应严格串行，
//!     所以作业线程直接同步读，不需要额外的 reader 线程
//!   * 取消：CANCEL 标志 + stop 文件双通道。worker 在分片间隙查 stop 文件，
//!     长分片静默期里上游 `TTS.stop()` 负责打断；壳侧看门狗 2 秒后强杀兜底
//!   * 事件：synth-chunk / synth-done / synth-error 转发给前端；
//!     同一时刻只允许一个合成作业（BUSY 互斥），进程 pid 交给 ToolPidGuard

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::paths;

/// 常驻 worker 句柄。stdout 在 spawn 时被接管，之后所有读取都走它。
struct Resident {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

static RESIDENT: Mutex<Option<Resident>> = Mutex::new(None);
static BUSY: Mutex<bool> = Mutex::new(false);
static CANCEL: OnceLock<Arc<AtomicBool>> = OnceLock::new();
/// worker 最近一次 ready 时报的设备（"cuda:0" / "mps" / "cpu"）。
/// 「其他」页的计算后端行读这个 —— 合成没跑过就没有后端可言，空着。
static LAST_DEVICE: Mutex<String> = Mutex::new(String::new());

fn cancel_flag() -> Arc<AtomicBool> {
    CANCEL
        .get_or_init(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

fn script(root: &Path) -> PathBuf {
    root.join("tools").join("synth_worker.py")
}

/// 角色包根：`User_Data/characters/<id>/`（docs/DECISIONS.md D4）。
pub fn characters_dir(root: &Path) -> PathBuf {
    paths::user_data(root).join("characters")
}

/// 合成输出目录的配置键。启动时要按它续放行资产作用域，所以得是个常量 ——
/// 两处各写一遍字符串，改一处忘一处的后果是「重启之后播放失败」。
pub const OUT_DIR_KEY: &str = "synth_out_dir";

/// 合成输出默认目录。设置页可改（synth_out_dir），空值回这里。
pub fn out_dir(root: &Path) -> PathBuf {
    let custom = crate::config::read(root)
        .get(OUT_DIR_KEY)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if custom.is_empty() {
        paths::user_data(root).join("synth")
    } else {
        PathBuf::from(custom)
    }
}

fn stop_file(root: &Path) -> PathBuf {
    paths::update_cache(root).join("synth_stop")
}

/// 合成记录：与音频同名的 `.json`，存文本、角色、参数（含实际种子）。
/// 合成页右栏的历史与「重新使用这组参数」都读它。写失败不影响音频本身。
fn record_path(audio: &Path) -> PathBuf {
    audio.with_extension("json")
}

fn write_record(audio: &Path, rec: &Value) {
    if let Ok(s) = serde_json::to_string_pretty(rec) {
        let _ = std::fs::write(record_path(audio), s);
    }
}

fn read_record(audio: &Path) -> Value {
    std::fs::read_to_string(record_path(audio))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// 只认输出目录里的直接子文件：前端传来的路径不能借改名、删除碰到别处。
fn owned_output(root: &Path, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    let dir = out_dir(root);
    let ok = p.is_file()
        && p.parent()
            .and_then(|d| d.canonicalize().ok())
            .zip(dir.canonicalize().ok())
            .map(|(a, b)| a == b)
            .unwrap_or(false);
    if ok {
        Ok(p)
    } else {
        Err(crate::i18n::t("s.synthErrNotOutput"))
    }
}

/// 改名：音频与记录一起改，扩展名保持不变。
pub fn rename_output(root: &Path, path: &str, name: &str) -> Result<String, String> {
    let src = owned_output(root, path)?;
    let name = name.trim();
    let bad = name.is_empty()
        || name.len() > 120
        || name
            .chars()
            .any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control());
    if bad {
        return Err(crate::i18n::t("s.synthErrBadName"));
    }
    let ext = src.extension().and_then(|x| x.to_str()).unwrap_or("wav");
    let dst = src.with_file_name(format!("{name}.{ext}"));
    if dst == src {
        return Ok(dst.to_string_lossy().into_owned());
    }
    if dst.exists() {
        return Err(crate::i18n::t("s.synthErrNameTaken"));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    let rec = record_path(&src);
    if rec.is_file() {
        let _ = std::fs::rename(&rec, record_path(&dst));
    }
    Ok(dst.to_string_lossy().into_owned())
}

/// 删除：移入回收站，音频与记录一起。
pub fn delete_output(root: &Path, path: &str) -> Result<(), String> {
    let src = owned_output(root, path)?;
    let rec = record_path(&src);
    trash::delete(&src).map_err(|e| e.to_string())?;
    if rec.is_file() {
        let _ = trash::delete(&rec);
    }
    Ok(())
}

/// 最近的合成产物，按修改时间倒序。首页「最近合成」与合成页右栏用。
pub fn recent_outputs(root: &Path, limit: usize) -> Value {
    let dir = out_dir(root);
    let mut rows: Vec<(std::time::SystemTime, String, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let is_audio = p
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| matches!(x.to_ascii_lowercase().as_str(), "wav" | "flac" | "mp3" | "ogg"))
                .unwrap_or(false);
            if !p.is_file() || !is_audio {
                continue;
            }
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            rows.push((
                mtime,
                p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                p.to_string_lossy().into_owned(),
            ));
        }
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.truncate(limit);
    json!(rows
        .into_iter()
        .map(|(mtime, name, path)| {
            json!({
                "name": name,
                "record": read_record(Path::new(&path)),
                "path": path,
                "mtime": mtime
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            })
        })
        .collect::<Vec<_>>())
}

/// 「其他」页显示用的后端串（"cuda:0" / "mps" / "cpu"）。没跑过就是空。
pub fn last_device() -> String {
    LAST_DEVICE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// worker 还活着吗。try_wait 拿 Some(_) 就是退了 —— 崩过、被杀过都算。
fn worker_alive_mut(g: &mut Option<Resident>) -> bool {
    match g {
        Some(r) => matches!(r.child.try_wait(), Ok(None)),
        None => false,
    }
}

/// 起常驻 worker（已活着就是 no-op）。ready 行当场读掉 —— GPT_SoVITS 懒加载，
/// 这一行来得很快；它同时也是「python 能跑、脚本能跑」的第一次体检。
fn ensure_worker(root: &Path) -> Result<(), String> {
    let mut g = RESIDENT.lock().unwrap_or_else(|e| e.into_inner());
    if worker_alive_mut(&mut g) {
        return Ok(());
    }
    *g = None;

    let script = script(root);
    if !script.is_file() {
        return Err(crate::i18n::t("s.synthErrNoWorker"));
    }
    let py = paths::runtime_python(root).ok_or_else(|| crate::i18n::t("s.47e57cab60"))?;

    // stderr 落文件而不是 piped：上游 import 链爱往 stderr 写警告，
    // 管道满了子进程会卡死在 write 上。
    let errfile = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::logging::daily_path(root, crate::logging::CH_SYNTH))
        .ok();

    let mut cmd = Command::new(&py);
    cmd.arg(script.as_os_str())
        .arg("--resident")
        .current_dir(root)
        .envs(crate::worker::env_for_runtime(root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(match errfile {
            Some(f) => Stdio::from(f),
            None => Stdio::null(),
        });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| crate::i18n::te("s.4f592d4fc2", &e))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or_else(|| crate::i18n::t("s.68759edc4b"))?;
    let stdout = child.stdout.take().ok_or_else(|| crate::i18n::t("s.68759edc4b"))?;
    let _guard = crate::worker::ToolPidGuard::new(pid);

    let mut resident = Resident {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    };
    // ready 行：协议版本不对就当起不来。
    let line = read_line_with_deadline(&mut resident, Duration::from_secs(20))?;
    match parse_event(&line) {
        Some(v) if v.get("event").and_then(|x| x.as_str()) == Some("ready") => {}
        _ => {
            let _ = resident.child.kill();
            return Err(crate::i18n::t("s.synthErrProtocol"));
        }
    }
    *g = Some(resident);
    Ok(())
}

/// 带截止时间的读一行。超时多半是 import 链卡死，杀掉重来比挂死好。
fn read_line_with_deadline(r: &mut Resident, timeout: Duration) -> Result<String, String> {
    // 同步读没有超时，用看门狗线程兜底：到点、或用户取消，就杀进程让
    // read 拿到 EOF。看门狗按小步轮询 done 标志 —— 不能一觉睡满 timeout
    // 再 join，否则每一行都要等满整个超时窗口。
    let pid = r.child.id();
    let done = Arc::new(AtomicBool::new(false));
    let killer = {
        let done = done.clone();
        let flag = cancel_flag();
        std::thread::spawn(move || {
            let step = Duration::from_millis(50);
            let mut waited = Duration::ZERO;
            while waited < timeout {
                if done.load(Ordering::SeqCst) {
                    return;
                }
                if flag.load(Ordering::SeqCst) {
                    break; // 取消：立刻杀，不等超时
                }
                std::thread::sleep(step.min(timeout - waited));
                waited += step;
            }
            if !done.load(Ordering::SeqCst) {
                kill_pid(pid);
            }
        })
    };
    let mut line = String::new();
    let n = r
        .stdout
        .read_line(&mut line)
        .map_err(|e| e.to_string())
        .unwrap_or(0);
    done.store(true, Ordering::SeqCst);
    killer.join().ok();
    if n == 0 {
        return Err(crate::i18n::t("s.synthErrWorkerGone"));
    }
    Ok(line.trim_end().to_string())
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        unsafe {
            libc_kill(pid as i32, 9);
        }
    }
}

#[cfg(not(windows))]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

fn parse_event(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

fn send(g: &mut Resident, req: &Value) -> Result<(), String> {
    let mut line = req.to_string();
    line.push('\n');
    g.stdin
        .write_all(line.as_bytes())
        .map_err(|_| crate::i18n::t("s.synthErrWorkerGone"))?;
    g.stdin
        .flush()
        .map_err(|_| crate::i18n::t("s.synthErrWorkerGone"))
}

/// 杀掉常驻 worker（引擎强杀、设置变更时调用方决定要不要重建）。
pub fn shutdown() {
    let mut g = RESIDENT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut r) = g.take() {
        let _ = writeln!(r.stdin, r#"{{"cmd":"quit"}}"#);
        let _ = r.stdin.flush();
        std::thread::sleep(Duration::from_millis(300));
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
}

pub fn is_busy() -> bool {
    *BUSY.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn cancel() {
    cancel_flag().store(true, Ordering::SeqCst);
}

/// 本地角色包清单：扫 `User_Data/characters/*/config.json`。
///
/// 包格式见 docs/DECISIONS.md D4：config.json 声明 name/author/version/cover/
/// lists/params；models/ 放权重；dataset/*.list 是参考音频候选。.list 的解析
/// 直接复用 annot::load —— 那份实现带着绝对路径拼装与存在性检查，合成台的
/// 参考挑选器要的正是这两样。
pub fn list_characters(root: &Path) -> Value {
    let base = characters_dir(root);
    let mut roles: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&base) {
        for e in rd.flatten() {
            let dir = e.path();
            let cfg_path = dir.join("config.json");
            if !cfg_path.is_file() {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&cfg_path) else {
                continue;
            };
            let Ok(cfg) = serde_json::from_str::<Value>(&raw) else {
                // 坏包不拖垮整页：跳过并记一条，界面少一个角色好过整页报错。
                crate::logging::shell_log!(
                    "character pack skipped (bad config.json): {}",
                    dir.display()
                );
                continue;
            };
            let id = dir
                .file_name()
                .map(|x| x.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut lists: Vec<Value> = Vec::new();
            if let Some(arr) = cfg.get("lists").and_then(|v| v.as_array()) {
                for l in arr {
                    // `file` 相对包根（`dataset/xxx.list` —— 和 pack_role_pack.py
                    // 的 `f in rels` 校验、train_worker 写回的 `dataset/<exp>.list`
                    // 同一套约定）。它是包里带来的字符串：拦住 `..` / 绝对路径 /
                    // 盘符，不然一个坏包就能把任意文件读给标注解析器。
                    let file = l.get("file").and_then(|v| v.as_str()).unwrap_or("");
                    let rel = file.replace('\\', "/");
                    let ok = !rel.is_empty()
                        && !rel.starts_with('/')
                        && !rel.contains(':')
                        && rel
                            .split('/')
                            .all(|s| !s.is_empty() && s != "." && s != "..");
                    if !ok {
                        continue;
                    }
                    let path = dir.join(&rel);
                    let Ok(parsed) = crate::annot::load(&path.to_string_lossy()) else {
                        continue;
                    };
                    lists.push(json!({
                        "file": file,
                        "lang": l.get("lang").and_then(|v| v.as_str()).unwrap_or(""),
                        "note": l.get("note").and_then(|v| v.as_str()).unwrap_or(""),
                        "rows": parsed.get("rows").cloned().unwrap_or(json!([])),
                    }));
                }
            }
            roles.push(json!({
                "id": id,
                "name": cfg.get("name").and_then(|v| v.as_str()).unwrap_or(&id),
                "author": cfg.get("author").and_then(|v| v.as_str()).unwrap_or(""),
                "version": cfg.get("version").and_then(|v| v.as_str()).unwrap_or("v2ProPlus"),
                "cover": cfg.get("cover").and_then(|v| v.as_str()).unwrap_or(""),
                "cover_exists": dir.join(cfg.get("cover").and_then(|v| v.as_str()).unwrap_or("")).is_file(),
                "params": cfg.get("params").cloned().unwrap_or(json!({})),
                "lists": lists,
                "dir": dir.to_string_lossy(),
            }));
        }
    }
    roles.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    json!({ "roles": roles, "dir": base.to_string_lossy() })
}

/// 跑一个合成作业。阻塞到 done/error；进度经事件通道给前端。
///
/// 角色参数的合并（作者推荐值 vs 用户持久化值）在前端做完，这里拿到的就是
/// 最终值 —— 壳不做第二套判定，避免两边规则漂移。
#[allow(clippy::too_many_arguments)]
pub fn synthesize(
    app: &AppHandle,
    root: &Path,
    role_id: &str,
    role_dir: &Path,
    version: &str,
    text: &str,
    ref_wav: &str,
    ref_text: &str,
    ref_lang: &str,
    params: &Value,
    streaming: bool,
    opts: &Value,
) -> Result<Value, String> {
    {
        let mut g = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        if *g {
            return Err(crate::i18n::t("s.synthErrBusy"));
        }
        *g = true;
    }
    cancel_flag().store(false, Ordering::SeqCst);
    let out = synthesize_inner(
        app, root, role_id, role_dir, version, text, ref_wav, ref_text, ref_lang, params, streaming,
        opts,
    );
    *BUSY.lock().unwrap_or_else(|e| e.into_inner()) = false;
    let _ = std::fs::remove_file(stop_file(root));
    cancel_flag().store(false, Ordering::SeqCst);
    out
}

#[allow(clippy::too_many_arguments)]
fn synthesize_inner(
    app: &AppHandle,
    root: &Path,
    role_id: &str,
    role_dir: &Path,
    version: &str,
    text: &str,
    ref_wav: &str,
    ref_text: &str,
    ref_lang: &str,
    params: &Value,
    streaming: bool,
    opts: &Value,
) -> Result<Value, String> {
    if !paths::runtime_ready(root) {
        return Err(crate::i18n::t("s.synthErrNoRuntime"));
    }
    let sovits = role_dir.join("models").join("sovits.pth");
    let gpt = role_dir.join("models").join("gpt.ckpt");
    for p in [&sovits, &gpt] {
        if !p.is_file() {
            return Err(crate::i18n::te(
                "s.synthErrNoModel",
                &p.display().to_string(),
            ));
        }
    }
    // 带毫秒：批量合成一秒内可能出好几条。
    let job = format!("synth_{}", chrono::Local::now().format("%Y%m%d_%H%M%S_%3f"));
    let stop = stop_file(root);
    let _ = std::fs::remove_file(&stop);

    ensure_worker(root)?;

    let mut g = RESIDENT.lock().unwrap_or_else(|e| e.into_inner());
    let Some(resident) = g.as_mut() else {
        return Err(crate::i18n::t("s.synthErrWorkerGone"));
    };

    // 1) load：切到目标角色。同角色秒回（cached）。
    send(
        resident,
        &json!({
            "cmd": "load",
            "role_id": role_id,
            "sovits": sovits.to_string_lossy(),
            "gpt": gpt.to_string_lossy(),
            "version": version,
            // 两个都得是**目录**：worker 那边最终走的是
            // `HubertModel.from_pretrained()` / `AutoTokenizer.from_pretrained()`，
            // 指到 pretrained_model2.pth 这种具体权重文件上会当场报错。
            "cnhubert": "GPT_SoVITS/pretrained_models/chinese-hubert-base",
            "bert": "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
            // 主显卡（-1 = 自动）。不传的话 worker 只能自己猜第 0 张，
            // 而上游 TTS_Config 的默认值是 CPU —— 装了 N 卡运行时也白装。
            "main_gpu": crate::config::read(root)
                .get("main_gpu")
                .and_then(|v| v.as_i64())
                .unwrap_or(-1),
            "stop_file": stop.to_string_lossy(),
        }),
    )?;
    loop {
        if cancel_flag().load(Ordering::SeqCst) {
            let _ = std::fs::write(&stop, b"stop");
        }
        let line = read_line_with_deadline(resident, Duration::from_secs(180))
            .map_err(|_| crate::i18n::t("s.synthErrLoadTimeout"))?;
        let Some(v) = parse_event(&line) else { continue };
        match v.get("event").and_then(|x| x.as_str()).unwrap_or("") {
            "ready" => {
                if let Some(d) = v.get("device").and_then(|x| x.as_str()) {
                    *LAST_DEVICE.lock().unwrap_or_else(|e| e.into_inner()) = d.to_string();
                }
                break;
            }
            "error" => {
                // worker 报文带 message_code（msg.synth.* 语言包）+ detail
                // （异常原文）；翻译不到时 t_worker_msg 回退 message。
                let msg = crate::i18n::t_worker_msg(&v);
                let detail = v.get("detail").and_then(|x| x.as_str()).unwrap_or("");
                let msg = if detail.is_empty() {
                    msg
                } else {
                    format!("{msg}（{detail}）")
                };
                return Err(crate::i18n::te("s.synthErrLoadFailed", &msg));
            }
            _ => {}
        }
    }

    // 2) synth：分片经事件转发，done/error 收尾。
    let format = opts.get("format").and_then(|x| x.as_str()).unwrap_or("wav");
    let out_path = out_dir(root).join(format!("{job}.{format}"));
    send(
        resident,
        &json!({
            "cmd": "synth",
            "job": job,
            "text": text,
            "ref_wav": ref_wav,
            "ref_text": ref_text,
            "ref_lang": ref_lang,
            "params": params,
            "streaming": streaming,
            "aux_refs": opts.get("aux_refs").cloned().unwrap_or(json!([])),
            "format": format,
            "out_dir": out_dir(root).to_string_lossy(),
            "stop_file": stop.to_string_lossy(),
        }),
    )?;
    loop {
        let cancelled = cancel_flag().load(Ordering::SeqCst);
        if cancelled {
            let _ = std::fs::write(&stop, b"stop");
        }
        // 取消后只给 worker 2 秒体面收场（写完 wav 头）；到点 read 的看门狗
        // 会杀掉进程，EOF 让循环立刻醒，用户不用等长分片磨完。
        let deadline = if cancelled {
            Duration::from_secs(2)
        } else {
            Duration::from_secs(300)
        };
        let line = match read_line_with_deadline(resident, deadline) {
            Ok(l) => l,
            Err(_) => {
                // worker 没了（看门狗杀的或崩溃）：按取消/失败收场，别把互斥卡死。
                *g = None;
                if cancelled {
                    return Ok(json!({"ok": true, "cancelled": true, "job": job}));
                }
                return Err(crate::i18n::t("s.synthErrWorkerGone"));
            }
        };
        let Some(v) = parse_event(&line) else { continue };
        match v.get("event").and_then(|x| x.as_str()).unwrap_or("") {
            "chunk" => {
                let _ = app.emit("synth-chunk", v);
            }
            "done" => {
                let _ = app.emit("synth-done", &v);
                let out = v
                    .get("out")
                    .and_then(|x| x.as_str())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| out_path.clone());
                write_record(
                    &out,
                    &json!({
                        "text": text,
                        "role_id": role_id,
                        "role_name": opts.get("role_name").cloned().unwrap_or(json!(role_id)),
                        "ref_wav": ref_wav,
                        "params": params,
                        "audio_sec": v.get("audio_sec").cloned().unwrap_or(json!(0)),
                        "t_first_ms": v.get("t_first_ms").cloned().unwrap_or(json!(0)),
                        "t_total_ms": v.get("t_total_ms").cloned().unwrap_or(json!(0)),
                    }),
                );
                return Ok(json!({
                    "ok": true,
                    "job": job,
                    "out": v.get("out").cloned().unwrap_or(json!(out_path.to_string_lossy())),
                    "t_first_ms": v.get("t_first_ms").cloned().unwrap_or(json!(0)),
                    "t_total_ms": v.get("t_total_ms").cloned().unwrap_or(json!(0)),
                }));
            }
            "error" => {
                let code = v.get("code").and_then(|x| x.as_str()).unwrap_or("");
                if code == "cancelled" || cancelled {
                    let _ = app.emit("synth-error", json!({"job": job, "code": "cancelled"}));
                    return Ok(json!({"ok": true, "cancelled": true, "job": job}));
                }
                let msg = crate::i18n::t_worker_msg(&v);
                let detail = v.get("detail").and_then(|x| x.as_str()).unwrap_or("");
                let msg = if detail.is_empty() {
                    msg
                } else {
                    format!("{msg}（{detail}）")
                };
                let _ = app.emit("synth-error", json!({"job": job, "code": code, "message": msg}));
                return Err(msg);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 角色扫描遇到坏包要跳过而不是整页报错 —— 用户手改 config.json 写坏一个
    /// 字段是常事，其余角色必须照常列出。
    #[test]
    fn a_broken_character_pack_is_skipped_not_fatal() {
        let root = crate::testutil::scratch("gsvf-synth-scan");
        let _ = std::fs::remove_dir_all(&root);
        let base = characters_dir(&root);
        std::fs::create_dir_all(base.join("good")).unwrap();
        std::fs::write(
            base.join("good").join("config.json"),
            r#"{"name":"好角色","author":"a","version":"v2ProPlus","lists":[]}"#,
        )
        .unwrap();
        std::fs::create_dir_all(base.join("bad")).unwrap();
        std::fs::write(base.join("bad").join("config.json"), "{broken").unwrap();

        let v = list_characters(&root);
        let roles = v["roles"].as_array().unwrap();
        assert_eq!(roles.len(), 1);
        assert_eq!(roles[0]["name"], "好角色");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// worker 报的 `synth.*` 码，语言包里必须真的有 —— 和 sep/train 同一条
    /// 契约：对不上不会报错，只会在界面上冒出 worker 自带的兜底原文。
    #[test]
    fn every_synth_code_the_worker_emits_exists_in_the_language_pack() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("engine-payload/tools/synth_worker.py"),
        )
        .expect("synth_worker.py");

        let mut codes: Vec<String> = Vec::new();
        for (i, _) in src.match_indices("code=\"") {
            let rest = &src[i + "code=\"".len()..];
            if let Some(end) = rest.find('"') {
                codes.push(rest[..end].to_string());
            }
        }
        codes.sort();
        codes.dedup();
        assert!(
            codes.len() >= 6,
            "认出来的码太少，扫描方式可能没跟上 worker 写法：{codes:?}"
        );

        let _g = crate::i18n::testing::pin("zh-CN");
        for c in &codes {
            let key = format!("msg.synth.{c}");
            assert_ne!(crate::i18n::t(&key), key, "语言包里没有 {key}");
        }
    }

    /// 输出目录：设置页留空回默认，写了就用用户的。
    #[test]
    fn out_dir_prefers_the_configured_one() {
        let root = crate::testutil::scratch("gsvf-synth-outdir");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(paths::user_data(&root)).unwrap();
        assert_eq!(out_dir(&root), paths::user_data(&root).join("synth"));
        crate::config::update(
            &root,
            serde_json::from_str::<serde_json::Map<String, Value>>(
                r#"{"synth_out_dir":"D:/Audio/Out"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(out_dir(&root), PathBuf::from("D:/Audio/Out"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
