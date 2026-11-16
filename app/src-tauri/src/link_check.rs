//! 新手进度：三步各就各位了吗。
//!
//! 这个文件原来还有一半是「链路自检」——「为什么听不到」的逐项核对：虚拟
//! 声卡装没装、输出是不是接进了 CABLE、监听开没开。那是 RVC 实时变声的问题，
//! GPT-SoVITS 合成出来的是文件，没有这条链路，而它依赖的常驻 worker
//! （`tools/realtime_worker.py`）本来就没随附过。整段随实时链路一起拆掉。
//!
//! 剩下的是新手三步：运行时就绪、选过角色、成功合成过一次。前两步每次实时
//! 推导，第三步是**历史事件**，必须落配置才能跨重启存活（写入方见
//! App.tsx 的 onboard_convert）。
//!
//! 全部是读操作，毫秒级，不启动任何进程。

use std::path::Path;

use serde_json::{json, Value};

use crate::paths;

pub fn onboarding(root: &Path) -> Value {
    let cfg = crate::config::read(root);
    // 「有没有可用的角色」。以前问的是 RVC 音色库的 `selected_idx`，
    // 那套东西这个产品没有；判据换成合成台真正读的那个目录。
    let selected = crate::synth::has_characters(root);
    json!({
        "runtime": paths::runtime_ready(root),
        "voice": selected,
        "convert": cfg.get("onboard_convert").and_then(|v| v.as_bool()).unwrap_or(false),
        "dismissed": cfg.get("onboard_dismiss").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 进度条会照着这几个键渲染。少一个键，那一段就永远是灰的，
    /// 而且不会有任何报错 —— 所以形状要钉住。
    #[test]
    fn the_bar_always_gets_every_key_it_renders() {
        let dir = crate::testutil::scratch("ob");
        let _ = std::fs::create_dir_all(&dir);
        let v = onboarding(&dir);
        for k in ["runtime", "voice", "convert", "dismissed"] {
            assert!(v.get(k).is_some(), "缺 {k}");
            assert!(v[k].is_boolean(), "{k} 不是布尔");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
