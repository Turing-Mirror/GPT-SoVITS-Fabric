//! 注册表里注册过的 ASIO 驱动名。
//!
//! 这个文件原来还有一半是 worker 异常退出码的台账 —— 判断进程是被系统终止的
//! 还是自己退的，好在界面上说清楚。那半边随实时 worker 一起没了：这个产品
//! 不起常驻音频进程，也就没有「刚刚那个 worker 是怎么没的」这个问题。
//!
//! 留下驱动名单是因为已知问题表按它筛条目（`affects.asio_driver`）。
//! 表现在是空的，规则还在。

/// 注册表里注册过的 ASIO 驱动名。只读，不需要管理员。
///
/// PortAudio 会把这里的每一项都 CoCreateInstance 起来问参数，所以引擎一崩在
/// 音频枚举上，嫌疑人就在这张表里。空表说明这台机器没装 ASIO，那就是别的
/// 原因，别顺口栽赃。
#[cfg(windows)]
pub fn asio_drivers() -> Vec<String> {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    let mut out: Vec<String> = Vec::new();
    unsafe {
        let mut key: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(r"SOFTWARE\ASIO").as_ptr(),
            0,
            KEY_READ,
            &mut key,
        ) != ERROR_SUCCESS
        {
            return out;
        }
        let mut i: u32 = 0;
        loop {
            let mut name = [0u16; 256];
            let mut len: u32 = name.len() as u32;
            if RegEnumKeyExW(
                key,
                i,
                name.as_mut_ptr(),
                &mut len,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) != ERROR_SUCCESS
            {
                break;
            }
            i += 1;
            let sub = OsString::from_wide(&name[..len as usize])
                .to_string_lossy()
                .trim()
                .to_string();
            // 支持渠道让用户改名停用过的会带这个后缀，别再算进嫌疑人里。
            if sub.is_empty() || sub.ends_with(".tm-disabled") {
                continue;
            }
            if !out.contains(&sub) {
                out.push(sub);
            }
        }
        RegCloseKey(key);
    }
    out
}

#[cfg(not(windows))]
pub fn asio_drivers() -> Vec<String> {
    Vec::new()
}
