//! 合成引擎托管：常驻 synth_worker.py 的 spawn、行协议、取消与事件转发。
//!
//! 与 sts.rs 的一次性进程不同，合成 worker 是**常驻**的：模型加载动辄十几秒，
//! 跨批复用显存里的权重是整个产品体验的根基（docs/DECISIONS.md D2）。所以这里
//! 管的是一个长命进程的生命周期：
//!
//!   * spawn：`Runtime\pythonw.exe tools\synth_worker.py --resident --lru 2`，
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

/// 合成输出默认目录。设置页可改（synth_out_dir），空值回这里。
pub fn out_dir(root: &Path) -> PathBuf {
    let custom = crate::config::read(root)
        .get("synth_out_dir")
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

/// worker 还活着吗。try_wait 拿 Some(_) 就是退了 —— 崩过、被杀过都算。
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
        .open(crate::logging::daily_path(root, crate::logging::CH_STS))
        .ok();

    let mut cmd = Command::new(&py);
    cmd.arg(script.as_os_str())
        .args(["--resident", "--lru", "2"])
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
    // 同步读没有超时，用看门狗线程兜底：到点杀进程，read 返回 EOF。
    // 正常路径看门狗什么都没做就退出了，开销可忽略。
    let pid = r.child.id();
    let killer = {
        let flag = cancel_flag();
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            if !flag.load(Ordering::SeqCst) {
                // 到点还没读完：不区分卡死与慢，直接杀。调用方会拿到 EOF 报错。
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
    killer.join().ok();
    if n == 0 {
        return Err(crate::i18n::t("s.synthErrWorkerGone"));
    }
    Ok(line.trim_end().to_string())
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
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
            let cfgPath = dir.join("config.json");
            if !cfgPath.is_file() {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&cfgPath) else {
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
                    let file = l.get("file").and_then(|v| v.as_str()).unwrap_or("");
                    let path = dir.join("dataset").join(file);
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
    let job = format!("synth_{}", chrono::Local::now().format("%Y%m%d_%H%M%S"));
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
            "cnhubert": "pretrained_models/chinese-hubert-base/pretrained_model2.pth",
            "bert": "pretrained_models/chinese-roberta-wwm-ext-large",
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
            "ready" => break,
            "error" => {
                let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
                return Err(crate::i18n::te("s.synthErrLoadFailed", &msg));
            }
            _ => {}
        }
    }

    // 2) synth：分片经事件转发，done/error 收尾。
    let out_path = out_dir(root).join(format!("{job}.wav"));
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
                let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
                if code == "cancelled" || cancelled {
                    let _ = app.emit("synth-error", json!({"job": job, "code": "cancelled"}));
                    return Ok(json!({"ok": true, "cancelled": true, "job": job}));
                }
                let _ = app.emit("synth-error", json!({"job": job, "code": code, "message": msg}));
                return Err(msg.to_string());
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
        let root = std::env::temp_dir().join("gsvf-synth-scan");
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

    /// 输出目录：设置页留空回默认，写了就用用户的。
    #[test]
    fn out_dir_prefers_the_configured_one() {
        let root = std::env::temp_dir().join("gsvf-synth-outdir");
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
