//! App settings — `User_Data/app_config.json`, mirrored into
//! `configs/inuse/config.json` for the worker.
//!
//! Ports `launcher/config_store.py` + `launcher/inuse_config.py`. Two rules from
//! the Python shell carry over and must not be dropped:
//!
//! * **`configs/inuse/config.json` must never contain dev-machine absolute
//!   paths.** Shipped builds once leaked `L:\…` and the worker died on user
//!   machines. Anything that looks like an absolute path on another drive is
//!   stripped on write.
//! * **HOT vs COLD.** Hot keys apply to a running stream; cold keys need a
//!   stop + start. The UI has to say which it is instead of silently doing
//!   nothing.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::paths;

/// app_config 读改写必须排队。两路 setHot（比如选音色和开启变声）同时
/// 读改写会互相覆盖，后写的把先写的键盖回旧值，启动就报「请选择pth文件」。
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn lock_files() -> std::sync::MutexGuard<'static, ()> {
    FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Product defaults. Values match the Python shell so a user switching over
/// does not silently get different audio.
pub fn defaults() -> Map<String, Value> {
    let mut m = Map::new();
    // voice params (hot)
    m.insert("pitch".into(), json!(0));
    m.insert("formant".into(), json!(0.0));
    m.insert("index_rate".into(), json!(0.75));
    m.insert("rms_mix_rate".into(), json!(0.25));
    m.insert("threhold".into(), json!(-60));
    m.insert("in_gain_db".into(), json!(0.0));
    m.insert("out_gain_db".into(), json!(0.0));
    m.insert("f0method".into(), json!("rmvpe"));
    m.insert("I_noise_reduce".into(), json!(true));
    m.insert("O_noise_reduce".into(), json!(false));
    m.insert("use_pv".into(), json!(false));
    m.insert("function".into(), json!("vc"));
    // 音效链（热）。默认整条关掉 —— 开着就改变了所有人听到的声音，
    // 那不该是升级一次软件就默默发生的事。数值与引擎侧默认值对齐。
    m.insert("fx_enabled".into(), json!(false));
    m.insert("fx_gate_enabled".into(), json!(true));
    m.insert("fx_gate_threshold_db".into(), json!(-50.0));
    m.insert("fx_gate_release_ms".into(), json!(50.0));
    m.insert("fx_gate_hold_ms".into(), json!(20.0));
    m.insert("fx_gate_range_db".into(), json!(20.0));
    m.insert("fx_comp_enabled".into(), json!(true));
    m.insert("fx_comp_threshold_db".into(), json!(-20.0));
    m.insert("fx_comp_ratio".into(), json!(4.0));
    m.insert("fx_comp_attack_ms".into(), json!(5.0));
    m.insert("fx_comp_release_ms".into(), json!(100.0));
    m.insert("fx_comp_makeup_db".into(), json!(0.0));
    m.insert("fx_eq_enabled".into(), json!(true));
    m.insert("fx_eq_gains".into(), json!([0.0, 0.0, 0.0, 0.0, 0.0]));
    m.insert("fx_eq_preset".into(), json!("flat"));
    m.insert("fx_out_gain_db".into(), json!(0.0));
    // 合成台（GPT-SoVITS 自己的键）。参数在角色推荐值与用户手调值之间
    // 由前端合并，这里存的是用户最后用过的那份。
    m.insert("synth_role".into(), json!(""));
    m.insert("synth_out_dir".into(), json!(""));
    m.insert("synth_streaming".into(), json!(true));
    m.insert("synth_speed".into(), json!(1.0));
    m.insert("synth_top_k".into(), json!(15));
    m.insert("synth_top_p".into(), json!(1.0));
    m.insert("synth_temperature".into(), json!(1.0));
    m.insert("synth_rep_penalty".into(), json!(1.35));
    // model binding (cold) — written by voice selection, not by the settings
    // page, but the worker expects the keys to exist.
    // devices / performance (cold)
    m.insert("sg_hostapi".into(), json!(""));
    m.insert("sg_wasapi_exclusive".into(), json!(false));
    m.insert("sg_input_device".into(), json!(""));
    m.insert("sg_output_device".into(), json!(""));
    m.insert("sr_type".into(), json!("sr_device"));
    m.insert("block_time".into(), json!(0.25));
    m.insert("crossfade_length".into(), json!(0.08));
    m.insert("extra_time".into(), json!(2.5));
    m.insert("n_cpu".into(), json!(4));
    // 默认关。这东西改的是推理核心，先让人自己开、量过再谈默认值。
    m.insert("cuda_graph".into(), json!(false));
    // shell-only
    m.insert("monitor_self".into(), json!(false));
    m.insert("monitor_device".into(), json!(""));
    // 主显卡序号。-1 = 自动（交给 torch 自己挑）。
    //
    // 不进 COLD_KEYS：worker 不读这个键，它是通过进程环境变量
    // CUDA_VISIBLE_DEVICES 生效的（见 worker::env_for_runtime）。写进 inuse
    // 只会多一个没人看的键。needs_restart 在 update() 里单独补。
    m.insert("main_gpu".into(), json!(-1));
    m.insert("close_action".into(), json!("ask"));
    // 界面兼容渲染。默认关。开了就在下次启动时给 WebView2 加
    // --disable-gpu-compositing —— 画面交回 CPU 合成，动效会掉一点，
    // 但显卡驱动一抽风整窗变黑/花屏的机器能救回来。见 lib.rs::run。
    m.insert("ui_compat_render".into(), json!(false));
    m.insert("theme_mode".into(), json!("system"));
    // UI language (React + Rust tray/errors). Engine logs may stay Chinese.
    // ui_locale_picked 不进 defaults：老配置缺该键时不能被默认 false 盖成「未选过」，
    // 否则老用户升级后会再弹一次语言引导。新装在 read() 里文件不存在时再写 false。
    m.insert("ui_locale".into(), json!("zh-CN"));
    m.insert("wallpaper_path".into(), json!(""));
    m.insert("wallpaper_blur".into(), json!(40));
    m.insert("wallpaper_opacity".into(), json!(70));
    // 首页横幅自定义：文案留空 = 默认标题；不透明度最低由前端滑杆限在 20。
    m.insert("home_banner_text".into(), json!(""));
    m.insert("home_banner_opacity".into(), json!(100));
    // 新手进度的两个历史事件（首次成功变声 / 开启过监听）与永久关闭标记。
    // 前三步（运行时/音色/声卡）每次实时推导，不需要存。不进任何设置分组：
    // 这不是用户该在设置页里看到的东西。
    m.insert("onboard_convert".into(), json!(false));
    m.insert("onboard_monitor".into(), json!(false));
    m.insert("onboard_dismiss".into(), json!(false));
    m.insert("hotkeys_enabled".into(), json!(false));
    // 快捷键组合。键名要和 `shell_extras::HOTKEYS` 对上。
    //
    // 这里原来还有八个：开关变声、切换直通、上一个/下一个音色、升降调、
    // 开关监听、开关音效 —— 全是 RVC 实时变声的动作，这个产品一个都没有。
    // `HOTKEYS` 早就只剩 toggle_window 一条，这八个键就成了写进配置文件、
    // 谁也不读的死值：默认值表把它们写进磁盘，设置页把它们当成用户设过的
    // 东西读回来，而按下去什么都不会发生。
    m.insert("hotkey_toggle_window".into(), json!("CmdOrCtrl+F11"));
    // 每个快捷键单独决定要不要抢成全局。默认全开 —— 以前九个一律全局，
    // 改默认值等于悄悄拿走用户已经在用的功能。
    //
    // 关掉的那些只在软件是当前窗口时有效。意义在于全局快捷键是**独占**的：
    // 被我们抢走的组合，用户在别的软件里就再也按不出原本的功能了。
    for (key, _, _) in crate::shell_extras::HOTKEYS {
        m.insert(format!("{key}_global"), json!(true));
    }
    m.insert("telemetry_opt_in".into(), json!(Value::Null));
    // 完成过多少次变声（开启→停止算一次）。攒够十次问一句要不要关注我们。
    // 问过之后 follow_prompt_done 置 true，这辈子不再问第二次。
    m.insert("vc_run_count".into(), json!(0));
    m.insert("follow_prompt_done".into(), json!(false));
    // 第一次点「开启变声」时问一句要不要先看说明页。点「转到说明页」或
    // 「不了」都置 true，只出这一次 —— 已经上手的人再被拦一道就是骚扰。
    m.insert("guide_prompt_done".into(), json!(false));
    // 第三方 Hugging Face 下载镜像根。空 = 走 `mirrors::hf_endpoints` 解出来
    // 的顺序（清单下发 → 编译进来的兜底 → 规范域）。不进 worker / inuse。
    m.insert("hf_endpoint".into(), json!(""));
    // 上一次真的下成功的那个源。用户没指定时排第一 —— 某些网络就是过不去
    // 默认那个源，不记住的话他每次、每个文件都要先白等一遍首字节超时。
    m.insert("hf_endpoint_last_good".into(), json!(""));
    // 各下载源的成败计数，随日活 ping 一起报（同样是 opt-in）。
    // 只有主机名和错误类型，没有文件名。见 `telemetry::download_summary`。
    m.insert("download_stats".into(), json!({}));
    m
}

fn read_json(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Full effective config: defaults overlaid with what the user has saved.
pub fn read(root: &Path) -> Map<String, Value> {
    let mut cfg = defaults();
    let path = paths::app_config_path(root);
    if path.is_file() {
        for (k, v) in read_json(&path) {
            cfg.insert(k, v);
        }
    } else {
        // 全新安装：尚无 app_config，标记语言未确认，前端弹首次语言引导。
        cfg.insert("ui_locale_picked".into(), json!(false));
    }
    let _ = apply_device_alias(&mut cfg);
    cfg
}

/// Old shells wrote `input_device`; the engine only reads `sg_input_device`.
/// Fill the empty side. Never overwrite a non-empty sg_ value — Broadcast
/// may be an intentional choice.
fn apply_device_alias(cfg: &mut Map<String, Value>) -> Vec<String> {
    let mut notes = Vec::new();
    let sg = cfg
        .get("sg_input_device")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let legacy = cfg
        .get("input_device")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if sg.is_empty() && !legacy.is_empty() {
        cfg.insert("sg_input_device".into(), json!(legacy.clone()));
        notes.push(format!("sg_input_device ← input_device ({legacy})"));
    } else if !sg.is_empty() && !legacy.is_empty() && sg != legacy {
        notes.push(format!(
            "input_device={legacy}  sg_input_device={sg} (engine uses sg_)"
        ));
    }
    let sg_out = cfg
        .get("sg_output_device")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let legacy_out = cfg
        .get("output_device")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if sg_out.is_empty() && !legacy_out.is_empty() {
        cfg.insert("sg_output_device".into(), json!(legacy_out.clone()));
        notes.push(format!("sg_output_device ← output_device ({legacy_out})"));
    }
    notes
}

/// Persist leftover device aliases. Does not rewrite block_time / extra_time.
pub fn persist_perf_caps(root: &Path) {
    let path = paths::app_config_path(root);
    if !path.is_file() {
        return;
    }
    let mut raw = read_json(&path);
    let notes = apply_device_alias(&mut raw);
    let changed = notes.iter().any(|n| n.contains('←'));
    if changed {
        if let Ok(text) = serde_json::to_string_pretty(&Value::Object(raw)) {
            let _ = write_atomic(&path, &text);
        }
    }
    for n in notes {
        crate::logging::shell_log!("config: {n}");
    }
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    // Unique temp name: the shell and the worker can both be writing under
    // User_Data, and a fixed `.tmp` was a real source of WinError 5.
    let tmp = path.with_extension(format!(
        "tmp{}",
        std::process::id() as u64
            ^ std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0)
    ));
    std::fs::write(&tmp, text)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Windows can hold the target open; fall back to a direct write
            // rather than losing the user's setting.
            let _ = std::fs::remove_file(&tmp);
            std::fs::write(path, text).map_err(|_| e)
        }
    }
}


/// 合并 patch 并落盘，回新的完整配置，外加「哪些键要等下一次任务才生效」。
///
/// 以前这里还分 HOT / COLD 两类键，往 `configs/inuse/config.json` 镜像一份，
/// 再把 HOT 的那批热推给常驻 worker。那整套是 RVC 实时变声的机制 ——
/// 边说话边改音高不能重开音频流，所以要分冷热。这个产品的合成是一次一个
/// 进程、参数随请求一起发过去，没有「正在跑的流」可热更新，也就没有冷热之分。
pub fn update(root: &Path, patch: Map<String, Value>) -> Result<Value, String> {
    let _g = lock_files();
    let mut saved = read_json(&paths::app_config_path(root));
    let mut needs_restart: Vec<String> = Vec::new();

    for (k, v) in patch {
        // 主显卡改的是 python 进程的环境变量（CUDA_VISIBLE_DEVICES），
        // 已经在跑的那个进程改不了 —— 得等下一次任务才换得过去，说清楚。
        if k == "main_gpu" {
            needs_restart.push(k.clone());
        }
        if k == "ui_locale" {
            if let Some(code) = v.as_str() {
                crate::i18n::set_locale(code);
            }
        }
        saved.insert(k, v);
    }

    let text = serde_json::to_string_pretty(&Value::Object(saved)).map_err(|e| e.to_string())?;
    write_atomic(&paths::app_config_path(root), &text)
        .map_err(|e| crate::i18n::te("s.47a27ebb17", &(e)))?;

    let cfg = read(root);
    Ok(json!({
        "config": Value::Object(cfg),
        "needs_restart": needs_restart,
    }))
}

/// Newest plaza date (`YYMMDD`) the user has actually looked at. Drives the
/// dot on the 广场 tab, which was previously hardcoded on and therefore never
/// meant anything.
const PLAZA_SEEN: &str = "plaza_seen";

pub fn plaza_seen(root: &Path) -> String {
    read_json(&paths::app_config_path(root))
        .get(PLAZA_SEEN)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub fn set_plaza_seen(root: &Path, newest: &str) -> Result<(), String> {
    // Only ever move forward: an older feed (a cached response, a rollback)
    // must not resurrect the dot for content already read.
    if newest.is_empty() || newest <= plaza_seen(root).as_str() {
        return Ok(());
    }
    let mut saved = read_json(&paths::app_config_path(root));
    saved.insert(PLAZA_SEEN.into(), json!(newest));
    let text = serde_json::to_string_pretty(&Value::Object(saved)).map_err(|e| e.to_string())?;
    write_atomic(&paths::app_config_path(root), &text).map_err(|e| crate::i18n::te("s.1455f353e7", &(e)))
}

/// Key holding the folder trained voices are written to. Not a settings key:
/// it never reaches the engine config — it only widens the voice library scan.
const TRAIN_OUT_DIR: &str = "train_output_dir";

/// 用户给训练音色选的存放目录。空 = 默认的 `User_Data/models`。
pub fn train_output_dir(root: &Path) -> String {
    read_json(&paths::app_config_path(root))
        .get(TRAIN_OUT_DIR)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 记住这个选择。音色库要一直扫这个目录，否则重启之后训好的音色就「消失」了。
///
/// 空字符串是有意义的输入，不是「没传」：用户从自定义改回默认时必须把旧的那条
/// 清掉，不然音色库会一直扫一个他已经不用的地方。
pub fn set_train_output_dir(root: &Path, dir: &str) -> Result<(), String> {
    let dir = dir.trim();
    let mut saved = read_json(&paths::app_config_path(root));
    let cur = saved.get(TRAIN_OUT_DIR).and_then(|v| v.as_str()).unwrap_or("");
    if cur == dir {
        return Ok(());
    }
    if dir.is_empty() {
        saved.remove(TRAIN_OUT_DIR);
    } else {
        saved.insert(TRAIN_OUT_DIR.into(), json!(dir));
    }
    let text = serde_json::to_string_pretty(&Value::Object(saved)).map_err(|e| e.to_string())?;
    write_atomic(&paths::app_config_path(root), &text)
        .map_err(|e| crate::i18n::te("s.1455f353e7", &(e)))
}

/// Key holding dismissed models-page banner ids. Not a settings key: it never
/// appears in the settings UI and must not reach the engine's config.
const DISMISSED_ADS: &str = "dismissed_ads";
/// Cap so a long-lived install cannot grow this list without bound.
const DISMISSED_MAX: usize = 200;

pub fn dismissed_ads(root: &Path) -> Vec<String> {
    read_json(&paths::app_config_path(root))
        .get(DISMISSED_ADS)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn dismiss_ad(root: &Path, id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Ok(());
    }
    let mut saved = read_json(&paths::app_config_path(root));
    let mut list = dismissed_ads(root);
    if list.iter().any(|x| x == id) {
        return Ok(());
    }
    list.push(id.to_string());
    // Oldest out first: a banner from two years ago will not come back.
    if list.len() > DISMISSED_MAX {
        let drop = list.len() - DISMISSED_MAX;
        list.drain(..drop);
    }
    saved.insert(DISMISSED_ADS.into(), json!(list));
    let text = serde_json::to_string_pretty(&Value::Object(saved)).map_err(|e| e.to_string())?;
    // Deliberately no sync_inuse: this is not an engine key.
    write_atomic(&paths::app_config_path(root), &text)
        .map_err(|e| crate::i18n::te("s.1455f353e7", &(e)))
}

/// Grouped view used by the settings page, so the UI does not hard-code which
/// keys belong to which tab.
pub fn describe() -> Value {
    let mut groups: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    groups.insert(
        "devices",
        vec![
            "sg_hostapi",
            "sg_input_device",
            "in_gain_db",
            "threhold",
            "sg_output_device",
            "out_gain_db",
            "monitor_self",
            "monitor_device",
            "sg_wasapi_exclusive",
            "sr_type",
        ],
    );
    groups.insert(
        "voice",
        vec![
            "pitch",
            "formant",
            "index_rate",
            "rms_mix_rate",
            "f0method",
        ],
    );
    groups.insert(
        "perf",
        vec!["block_time", "crossfade_length", "extra_time", "n_cpu"],
    );
    groups.insert("fx", vec!["I_noise_reduce", "O_noise_reduce", "use_pv"]);
    groups.insert(
        "appearance",
        vec![
            "theme_mode",
            "wallpaper_path",
            "wallpaper_blur",
            "wallpaper_opacity",
            "home_banner_text",
            "home_banner_opacity",
        ],
    );
    groups.insert(
        "general",
        vec!["close_action", "ui_locale", "telemetry_opt_in", "ui_compat_render"],
    );
    json!({ "groups": groups })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_locale_is_written_through() {
        let root = crate::testutil::scratch("cfg-locale");
        std::fs::create_dir_all(crate::paths::user_data(&root)).unwrap();
        let mut p = Map::new();
        p.insert("ui_locale".into(), json!("ja-JP"));
        let out = update(&root, p).unwrap();
        assert_eq!(out["config"]["ui_locale"], json!("ja-JP"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 主显卡改的是进程环境变量，跑着的那个进程改不了。改完必须告诉用户
    /// 「下次任务才生效」—— 不提示的话用户改完毫无反应，只会以为功能坏了。
    #[test]
    fn main_gpu_asks_to_wait_for_the_next_run() {
        let root = crate::testutil::scratch("cfg-gpu");
        std::fs::create_dir_all(crate::paths::user_data(&root)).unwrap();
        let mut p = Map::new();
        p.insert("main_gpu".into(), json!(1));
        let out = update(&root, p).unwrap();
        let nr = out["needs_restart"].as_array().unwrap();
        assert!(nr.iter().any(|v| v == "main_gpu"), "{nr:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 外观、语言这些跟引擎无关的键不该带出「要重来一次」的提示。
    #[test]
    fn a_cosmetic_key_never_asks_to_wait() {
        let root = crate::testutil::scratch("cfg-theme");
        std::fs::create_dir_all(crate::paths::user_data(&root)).unwrap();
        let mut p = Map::new();
        p.insert("theme_mode".into(), json!("dark"));
        let out = update(&root, p).unwrap();
        assert!(out["needs_restart"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 用户点「取消当前角色」之后，配置里不能再留着上一个模型的任何路径 ——
    /// 留一条，下一次合成就会悄悄用回那个角色。
    /// 设置页照着 describe() 的分组渲染。分组里出现一个 defaults() 没有的键，
    /// 那一格就是空的 —— 所以两边必须对得上。
    #[test]
    fn every_described_key_has_a_default() {
        let d = defaults();
        let desc = describe();
        for (group, keys) in desc["groups"].as_object().unwrap() {
            for k in keys.as_array().unwrap() {
                let k = k.as_str().unwrap();
                assert!(d.contains_key(k), "{group} 里的 {k} 没有默认值");
            }
        }
    }
}
