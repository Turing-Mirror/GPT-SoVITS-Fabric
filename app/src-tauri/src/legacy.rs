//! 「其他」页里那两个高级入口 —— 直接开上游自己的 Gradio 界面。
//!
//! * **原版推理界面** — `GPT_SoVITS/inference_webui.py`，上游的合成界面，
//!   端口 9872。壳里的合成台覆盖不到的旋钮（采样步数、超采样、分桶推理
//!   那些）都在那边。
//! * **原版 WebUI** — `webui.py`，上游的训练/工具全家桶，端口 9874。
//!
//! **这两条以前指的是 RVC 的脚本**（`gui_v1.py` 的 FreeSimpleGUI 实时窗口、
//! `infer-web.py` 的 7897 端口 Gradio），而这个产品从来没随包发过那两个
//! 文件 —— 「其他」页上两个按钮点下去，恒定报「脚本不存在」。RVC 那两个
//! 参数（`--pycmd` / `--port` / `--noautoopen` / A 卡的 `--dml`）上游一个
//! 都不认，也一并去掉：上游的端口写在 `config.py` 里，不走命令行。
//!
//! 冷启动 20–40 秒（torch/CUDA），所以进程一拉起来就返回，界面照实说
//! 「正在启动」，不假装是瞬间的。

use std::path::Path;
use std::process::{Command, Stdio};

use crate::{config, logging, paths, worker};

/// 上游 `config.py` 里的 `webui_port_main`。改这里没用，要跟着上游走。
pub const WEBUI_PORT: u16 = 9874;
/// 上游 `config.py` 里的 `webui_port_infer_tts`。
pub const INFER_WEBUI_PORT: u16 = 9872;

/// URL 由端口算出来，不写第二遍 —— 两处各写一遍就会出现「进程听 A、
/// 浏览器开 B」这种查半天的错。
fn local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn runtime_python(root: &Path, windowed: bool) -> Result<std::path::PathBuf, String> {
    let p = if windowed {
        paths::runtime_pythonw(root).or_else(|| paths::runtime_python(root))
    } else {
        paths::runtime_python(root).or_else(|| paths::runtime_pythonw(root))
    };
    p.ok_or_else(|| crate::i18n::t("s.4f09ae24cf"))
}

/// Spawn a Runtime-python process detached, with the shell's own Python-related
/// environment stripped (see `worker::env_for_runtime`).
fn spawn_detached(
    root: &Path,
    exe: &Path,
    args: &[String],
    log_name: &str,
    show_window: bool,
) -> Result<u32, String> {
    let env = worker::env_for_runtime(root);
    let log_path = paths::logs_dir(root).join(log_name);
    let _ = std::fs::create_dir_all(paths::logs_dir(root));
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(root)
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(match log_file {
            Some(f) => Stdio::from(f),
            None => Stdio::null(),
        });

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP so closing our window never takes it down.
        // CREATE_NO_WINDOW only when the child has no UI of its own — applying
        // it to the panel would hide the window the user just asked for.
        let mut flags = 0x0000_0200u32;
        if !show_window {
            flags |= 0x0800_0000;
        }
        cmd.creation_flags(flags);
    }
    #[cfg(not(windows))]
    let _ = show_window;

    let child = cmd.spawn().map_err(|e| crate::i18n::te("s.f1f3d2302b", &(e)))?;
    let pid = child.id();
    logging::shell_log!("启动 {}（pid {pid}），日志 {}", exe.display(), log_path.display());
    // Detached on purpose: it outlives us, and we never wait on it.
    std::mem::forget(child);
    Ok(pid)
}

/// 打开上游的原版推理界面（`GPT_SoVITS/inference_webui.py`，端口 9872）。
///
/// 和 WebUI 一样是 Gradio，所以同样把 URL 交回给调用方去开。
pub fn open_realtime_panel(root: &Path) -> Result<serde_json::Value, String> {
    let script = root
        .join("GPT_SoVITS")
        .join("inference_webui.py");
    if !script.is_file() {
        return Err(crate::i18n::te("s.0c5475c6d8", &(script.display())));
    }
    let pyw = runtime_python(root, true)?;
    let pid = spawn_detached(
        root,
        &pyw,
        &[script.to_string_lossy().into_owned()],
        "infer_webui.log",
        false,
    )?;
    Ok(serde_json::json!({
        "ok": true,
        "pid": pid,
        "url": local_url(INFER_WEBUI_PORT),
        "message": &crate::i18n::t("s.2bd41b71bb"),
    }))
}

/// 打开上游的原版 WebUI（`webui.py`，端口 9874）。URL 交回给调用方去开。
pub fn open_webui(root: &Path) -> Result<serde_json::Value, String> {
    let script = root.join("webui.py");
    if !script.is_file() {
        return Err(crate::i18n::te("s.fb5c249625", &(script.display())));
    }
    let pyw = runtime_python(root, true)?;
    // 上游不认命令行参数：端口在 config.py 里，加速方式看环境变量。
    // RVC 那三个（--pycmd / --port / --noautoopen）传过去只会让它报未知参数。
    let pid = spawn_detached(
        root,
        &pyw,
        &[script.to_string_lossy().into_owned()],
        "webui.log",
        false,
    )?;
    Ok(serde_json::json!({
        "ok": true,
        "pid": pid,
        "url": local_url(WEBUI_PORT),
        "message": &crate::i18n::t("s.c75f611a0a"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_scripts_report_the_path() {
        let empty = crate::testutil::scratch("legacy-empty");
        let _ = std::fs::create_dir_all(&empty);
        let e = open_realtime_panel(&empty).unwrap_err();
        assert!(e.contains("inference_webui.py"), "got {e}");
        let e = open_webui(&empty).unwrap_err();
        assert!(e.contains("webui.py"), "got {e}");
    }

    /// 端口必须是上游 `config.py` 里的那两个 —— 写错的话按钮拉起来的进程
    /// 在监听 A，浏览器去开 B，用户看到「连接被拒绝」，而进程其实好好地跑着。
    #[test]
    fn the_ports_match_upstream_config() {
        assert_eq!(WEBUI_PORT, 9874, "上游 config.py 的 webui_port_main");
        assert_eq!(INFER_WEBUI_PORT, 9872, "上游 config.py 的 webui_port_infer_tts");
        assert_eq!(local_url(WEBUI_PORT), "http://127.0.0.1:9874");
    }
}
