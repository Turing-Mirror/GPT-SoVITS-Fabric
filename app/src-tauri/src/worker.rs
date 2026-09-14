//! Runtime 里那些 python 进程的收尾。
//!
//! 这个文件原来是实时变声 worker 的全部：起进程、认领 pid、按文件协议收发
//! 命令、软停再强杀、把 status.json 翻译给界面。那条链路是照搬 RVC 的，
//! 而它要跑的 `tools/realtime_worker.py` 从来没随附过 —— 「开启变声」那个
//! 按钮打头第一道脚本检查就必然失败。整条随界面上的按钮一起拆掉。
//!
//! 留下的是三样跟实时无关、别处还在用的东西：
//!
//! * [`env_for_runtime`] —— 起任何一个 Runtime python 都要这份干净环境；
//! * [`ToolPidGuard`] 与 [`kill_runtime_pythons`] —— 训练 / 分离 / 合成的
//!   进程要登记 pid，收孤儿时才绕得开正在跑的那个；
//! * [`append_log`] —— 写 worker 那条日志通道。

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use crate::paths;

pub(crate) fn append_log(root: &Path, line: &str) {
    crate::logging::append_daily(root, crate::logging::CH_WORKER, line);
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // Access denied also lands here. A process we cannot open is not
            // one we could have spawned, so treating it as gone is correct for
            // our purposes and never kills someone else's process.
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    pid != 0 && Path::new(&format!("/proc/{pid}")).exists()
}

/// Full image path for *pid*, or empty.
///
/// Was a `Get-CimInstance Win32_Process` call through PowerShell — a cold start
/// per lookup, and no return at all on a machine whose WMI repository is
/// damaged. `Command::output()` has no timeout, so that stalled the caller
/// indefinitely. The Win32 call cannot hang and spawns nothing.
#[cfg(windows)]
fn pid_image_path(pid: u32) -> String {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return String::new();
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return String::new();
        }
        // MAX_PATH is not enough: a long-path-enabled system can exceed it, and
        // the call fails rather than truncating.
        let mut buf = [0u16; 32768];
        let mut len: u32 = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return String::new();
        }
        OsString::from_wide(&buf[..len as usize])
            .to_string_lossy()
            .trim()
            .to_string()
    }
}

#[cfg(not(windows))]
fn pid_image_path(_pid: u32) -> String {
    String::new()
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(0x08000000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

/// Build env for Runtime python: strip host Python pollution (see win_util._env_for_runtime_python).
pub(crate) fn env_for_runtime(root: &Path) -> HashMap<String, String> {
    let drop_exact = [
        "_MEIPASS",
        "_PYI_APPLICATION_HOME_DIR",
        "_PYI_ARCHIVE_FILE",
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "PYTHONEXECUTABLE",
        "PYTHONUSERBASE",
        "VIRTUAL_ENV",
        "CONDA_PREFIX",
        "CONDA_DEFAULT_ENV",
        "CONDA_PYTHON_EXE",
        "TCL_LIBRARY",
        "TK_LIBRARY",
        "TIX_LIBRARY",
        "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
    ];
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.retain(|k, _| {
        let ku = k.to_ascii_uppercase();
        if drop_exact.iter().any(|d| ku == *d) {
            return false;
        }
        if ku.starts_with("PYTHON")
            || ku.starts_with("CONDA_")
            || ku.starts_with("VIRTUAL_ENV")
            || ku.starts_with("PIP_")
            || ku.starts_with("UV_")
            || ku.starts_with("POETRY_")
            || ku.starts_with("MAMBA_")
            || ku.starts_with("PYENV_")
        {
            return false;
        }
        true
    });

    let root_s = root.to_string_lossy().to_string();
    let rt = paths::runtime_dir(root);
    let rt_s = rt.to_string_lossy().to_string();

    let path_key = env
        .keys()
        .find(|k| k.eq_ignore_ascii_case("PATH"))
        .cloned()
        .unwrap_or_else(|| "PATH".into());
    let old_path = env.get(&path_key).cloned().unwrap_or_default();
    let mut parts: Vec<String> = vec![rt_s, root_s.clone()];
    for p in old_path.split(';') {
        if p.is_empty() {
            continue;
        }
        let pl = p.replace('/', "\\").to_ascii_lowercase();
        if pl.contains("_mei") || pl.contains("pyinstaller") {
            continue;
        }
        parts.push(p.to_string());
    }
    env.insert(path_key, parts.join(";"));
    env.insert("TM_VOICE_ROOT".into(), root_s);
    env.insert("TM_REALTIME_WORKER".into(), "1".into());
    env.insert("PYTHONUNBUFFERED".into(), "1".into());
    env.insert("PYTHONNOUSERSITE".into(), "1".into());
    // 管道里的 worker stdout 走 UTF-8，避免中文进度/报错 OSError 22。
    env.insert("PYTHONIOENCODING".into(), "utf-8".into());
    env.insert("PYTHONUTF8".into(), "1".into());
    env.insert("no_proxy".into(), "localhost,127.0.0.1,::1".into());
    env.insert("NO_PROXY".into(), "localhost,127.0.0.1,::1".into());
    // 这里以前铺了五个环境变量：weight_root / weight_uvr5_root / index_root /
    // outside_index_root / rmvpe_root。那是官方 RVC 从产品根 .env 读的一套，
    // **上游 GPT-SoVITS 一个都不读** —— 它的 SoVITS_weight_root 与
    // weight_uvr5_root 是模块级 Python 变量（config.py:44 / tools/uvr5/webui.py:21），
    // 不走环境；index_root / outside_index_root / rmvpe_root 是检索库和
    // rmvpe 音高模型的位置，这个产品两样都没有。
    //
    // 其中 index_root 还指着 `logs` —— 训练产物挪进 User_Data/train 之后，
    // 它连指向都错了。设一堆没人读的变量不只是没用：排障时看见
    // `index_root=logs` 会以为检索库该在那儿，白查一轮。
    // 与官方 WebUI 一致：把 TEMP/TMP/TMPDIR 指到安装目录下的 TEMP，
    // 中间文件统一落这里，启动/退出/任务结束时清理。
    let temp = paths::temp_dir(root);
    let _ = std::fs::create_dir_all(&temp);
    let temp_s = temp.to_string_lossy().to_string();
    env.insert("TEMP".into(), temp_s.clone());
    env.insert("TMP".into(), temp_s.clone());
    env.insert("TMPDIR".into(), temp_s);
    // TM_ACCEL / TM_ACCEL_RESOLVED / TM_USE_DML 也一并去掉：三个都是 RVC 的
    // A 卡 DirectML 路径用的，这个产品的 worker 一处都没读过（grep 为零），
    // 上游更没有 DirectML 分支。设备选择在 worker 内部按
    // `torch.cuda.is_available()` 决定，主显卡通过下面的 CUDA_VISIBLE_DEVICES
    // 生效 —— 那才是真正管用的那一条。
    apply_main_gpu(root, &mut env);
    env
}

/// 把「主显卡」选择变成 worker 进程的环境变量。
///
/// 引擎全线写死 `cuda:0`（configs/config.py 的 `Config.device`，还有 rtrvc /
/// rmvpe / train_worker 里的一堆 0）。双卡机器上这就是「谁排第一用谁」——
/// 一块 5060 一块 5090，很可能整场都在用 5060 算。
///
/// 不去改引擎那一堆 0，而是在这里遮住其他卡：`CUDA_VISIBLE_DEVICES=n` 之后，
/// torch 眼里就只剩一块卡，`cuda:0` 自然落到用户选的那块上。训练、分离走的是
/// 同一个 `env_for_runtime`，所以三边行为一致。
///
/// `CUDA_DEVICE_ORDER=PCI_BUS_ID` 是为了让序号稳定：CUDA 默认按
/// FASTEST_FIRST 排，换一次驱动、插一块新卡都可能让同一个序号指向另一块卡，
/// 那样用户选过的设置会莫名其妙失效。
///
/// 这套变量只有 CUDA 认；CPU 变体没有多卡可选的问题，界面上写清楚了。
fn apply_main_gpu(root: &Path, env: &mut HashMap<String, String>) {
    let cfg = crate::config::read(root);
    let idx = cfg.get("main_gpu").and_then(|v| v.as_i64()).unwrap_or(-1);
    if idx < 0 {
        // 「自动」。用户机器上本来就设了这个变量的话别动它 —— 那是他自己的
        // 环境，不是我们该覆盖的东西。
        return;
    }
    // 越界的序号比不设还糟：`CUDA_VISIBLE_DEVICES` 指向不存在的设备时，CUDA 报的
    // 是 0 个设备，`is_available()` 直接变 false，引擎会静默退到 CPU。
    // 用户看到的是「显存不足」，跟他动过的那个下拉框看不出任何关系。
    //
    // 这种脏序号是真会存在的：早先的列表来自注册表的显示适配器枚举，里面混着已
    // 禁用的卡和残留的驱动键，存下来的下标换到 CUDA 那边可能根本没有对应设备；
    // 用户换掉一块卡之后，旧配置里的下标同样会悬空。宁可当「自动」。
    let avail = crate::provision::list_nvidia_gpus().len() as i64;
    if avail == 0 || idx >= avail {
        crate::logging::shell_log!(
            "main_gpu={idx} 超出可用 N 卡数量（{avail}），按自动处理，不设 CUDA_VISIBLE_DEVICES"
        );
        return;
    }
    env.insert("CUDA_VISIBLE_DEVICES".into(), idx.to_string());
    env.insert("CUDA_DEVICE_ORDER".into(), "PCI_BUS_ID".into());
    crate::logging::shell_log!("main_gpu={idx} → CUDA_VISIBLE_DEVICES");
}

/// True when *img* sits under *dir* (Windows path, case-insensitive).
fn path_is_under(dir: &Path, img: &str) -> bool {
    let d = dir
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    let i = img.replace('/', "\\").to_ascii_lowercase();
    !d.is_empty() && (i == d || i.starts_with(&(d.clone() + "\\")))
}

/// (pid, parent_pid, image_path) for every live python.exe / pythonw.exe.
#[cfg(windows)]
fn iter_python_procs() -> Vec<(u32, u32, String)> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap.is_null() || snap == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut pe: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut out = Vec::new();
    unsafe {
        if Process32FirstW(snap, &mut pe) != 0 {
            loop {
                let end = pe
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(pe.szExeFile.len());
                let name = OsString::from_wide(&pe.szExeFile[..end])
                    .to_string_lossy()
                    .to_ascii_lowercase();
                if name == "python.exe" || name == "pythonw.exe" {
                    let pid = pe.th32ProcessID;
                    let parent = pe.th32ParentProcessID;
                    let img = pid_image_path(pid);
                    if !img.is_empty() {
                        out.push((pid, parent, img));
                    }
                }
                if Process32NextW(snap, &mut pe) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

#[cfg(not(windows))]
fn iter_python_procs() -> Vec<(u32, u32, String)> {
    Vec::new()
}

/// 壳自己拉起来的一次性任务（STS / 训练 / 分离 / TTS）。关变声时不能杀它们。
static TOOL_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// 记住一个工具子进程，函数返回时自动忘掉。
pub struct ToolPidGuard {
    pid: u32,
}

impl ToolPidGuard {
    pub fn new(pid: u32) -> Self {
        if pid != 0 {
            let mut g = TOOL_PIDS.lock().unwrap_or_else(|e| e.into_inner());
            if !g.contains(&pid) {
                g.push(pid);
            }
        }
        Self { pid }
    }
}

impl Drop for ToolPidGuard {
    fn drop(&mut self) {
        if self.pid == 0 {
            return;
        }
        let mut g = TOOL_PIDS.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|p| *p != self.pid);
    }
}

fn protected_tool_pids() -> Vec<u32> {
    TOOL_PIDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Kill Runtime python processes.
///
/// * `orphans_only` — leftovers after **强制结束** / 关应用. Parent-dead
///   **or** reparented onto this shell. 普通「停止变声」走软停，不调这里。
///   STS / train / separate / TTS pids the shell itself spawned are skipped.
/// * otherwise — every python whose image lives under Runtime. Used on
///   关闭应用 so nothing is left behind.
///
/// Returns how many were killed — 启动时的那次调用要拿它写日志。
pub fn kill_runtime_pythons(root: &Path, orphans_only: bool) -> usize {
    let rt = paths::runtime_dir(root);
    let shell = std::process::id();
    let tools = protected_tool_pids();
    let mut killed = 0usize;
    for (pid, parent, img) in iter_python_procs() {
        if !path_is_under(&rt, &img) {
            continue;
        }
        if orphans_only {
            if tools.contains(&pid) {
                continue;
            }
            // 父进程还活着，且不是本壳：别人的 python，别动。
            // 父进程已死，或已被 Windows 过继到本壳：worker 留下的 AudioIo。
            if pid_alive(parent) && parent != shell {
                continue;
            }
        }
        append_log(
            root,
            &format!(
                "kill_tree runtime python pid={pid} parent={parent} orphans_only={orphans_only}"
            ),
        );
        kill_tree(pid);
        killed += 1;
    }
    killed
}

/// 上一次是被强杀 / 崩掉的：训练、分离、STS、TTS 的 python 都是我们 spawn
/// 出来的独立进程，壳一死它们不死，还攥着显存继续跑。
///
/// 26.8.18 的用户就栽在这里：窗口黑了他去任务管理器结束进程，训练进程活
/// 得好好的继续跑了五分钟；重开之后界面显示「空闲」，他再点一次开始训练，
/// 两个进程抢同一张 8G 卡 —— 那时候才是真卡死。
///
/// `reap_orphan_workers` 只认实时 worker 的 pid 台账，工具进程不在里面，
/// 所以这里单独扫一遍。判据和 `orphans_only` 一致：父进程已死，或者已被
/// Windows 过继到本壳。别人那份还活着的 App 不受影响（它的 python 父进程
/// 活着且不是本壳）。
pub fn reap_orphan_tool_pythons(root: &Path) {
    let n = kill_runtime_pythons(root, true);
    if n > 0 {
        crate::logging::shell_log!("收掉 {n} 个上次留下的 Runtime python（训练/分离/合成的残留）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 系统上不会存在的 pid，`pid_alive` 必须判它死。
    const DEAD_PID: u32 = 4_000_000;

    #[test]
    fn pid_zero_is_never_alive() {
        assert!(!pid_alive(0));
        assert!(!pid_alive(DEAD_PID));
    }

    /// 只收 Runtime 目录底下的 python。判据写错的话，收孤儿会把用户自己装的
    /// python 一起杀了。
    #[test]
    fn path_is_under_matches_runtime_children_only() {
        let dir = Path::new("/opt/app/Runtime");
        assert!(path_is_under(dir, "/opt/app/Runtime/python.exe"));
        assert!(path_is_under(dir, "/opt/app/Runtime/Scripts/pythonw.exe"));
        assert!(!path_is_under(dir, "/opt/app/Runtime2/python.exe"));
        assert!(!path_is_under(dir, "/usr/bin/python3"));
        assert!(!path_is_under(dir, ""));
    }

    /// 工具进程（训练 / 分离 / 合成）自己登记 pid，收孤儿时必须绕开它们 ——
    /// 收错一个，正在跑的几小时训练当场没。
    #[test]
    fn tool_pid_guard_tracks_and_drops() {
        let before = protected_tool_pids().len();
        {
            let _g = ToolPidGuard::new(DEAD_PID);
            assert!(protected_tool_pids().contains(&DEAD_PID));
        }
        assert!(!protected_tool_pids().contains(&DEAD_PID));
        assert_eq!(protected_tool_pids().len(), before);
    }
}
