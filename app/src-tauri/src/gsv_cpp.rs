//! Assets for the optional Vulkan synthesis backend.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use crate::{catalog, download, engine_assets, extra_assets, extract, i18n, paths, synth};

const VERSION: &str = "0.1.3";
const GROUP: &str = "gsv-cpp";
const BASE_FILE: &str = "s2Gv5turbo.pth";
const BASE_BYTES: u64 = 766_406_144;
const ENGINE_FILES: &[&str] = &[
    "bin/gsv_server.exe",
    "bin/ggml.dll",
    "bin/ggml-base.dll",
    "bin/ggml-cpu.dll",
    "bin/ggml-vulkan.dll",
    "tools/text_sidecar.py",
    "tools/export_gguf/convert_ar.py",
    "tools/export_gguf/convert_cond.py",
    "tools/export_gguf/convert_dit.py",
    "tools/export_gguf/convert_refcode.py",
    "frontend/frontend.py",
    "deps/gguf/__init__.py",
    "deps/onnxruntime/__init__.py",
];
const SHARED_FILES: &[&str] = &[
    "bert-f16.gguf",
    "hubert-f16.gguf",
    "vocoder-f32.gguf",
    "resampy_kaiser_best.bin",
    "bert_tokenizer/vocab.txt",
    "bert_tokenizer/config.json",
];

static INSTALL: Mutex<()> = Mutex::new(());
static CANCEL: OnceLock<Arc<AtomicBool>> = OnceLock::new();

fn cancel_flag() -> Arc<AtomicBool> {
    CANCEL
        .get_or_init(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

pub(crate) fn cancel() {
    cancel_flag().store(true, Ordering::Release);
}

pub(crate) fn asset_root(root: &Path) -> PathBuf {
    root.join("GSV_CPP")
}

pub(crate) fn cache_root(root: &Path) -> PathBuf {
    paths::user_data(root).join("cache/gsv-cpp")
}

fn base_path(root: &Path) -> PathBuf {
    root.join("GPT_SoVITS/pretrained_models/gsv-v5-pretrained")
        .join(BASE_FILE)
}

fn base_ready(root: &Path) -> bool {
    fs::metadata(base_path(root)).is_ok_and(|m| m.is_file() && m.len() == BASE_BYTES)
}

fn missing_part(dir: &Path, part: &str) -> Vec<String> {
    let files = match part {
        "engine" => ENGINE_FILES,
        "shared" => SHARED_FILES,
        _ => unreachable!(),
    };
    let mut missing: Vec<String> = files
        .iter()
        .filter(|file| !fs::metadata(dir.join(file)).is_ok_and(|m| m.is_file() && m.len() > 0))
        .map(|file| format!("{part}/{file}"))
        .collect();
    if part == "engine"
        && !fs::read_to_string(dir.join("VERSION")).is_ok_and(|s| s.trim() == VERSION)
    {
        missing.push("engine/VERSION".into());
    }
    missing
}

fn missing(root: &Path) -> Vec<String> {
    if !cfg!(windows) {
        return vec!["platform".into()];
    }
    let assets = asset_root(root);
    let mut missing = missing_part(&assets.join("engine"), "engine");
    missing.extend(missing_part(&assets.join("shared"), "shared"));
    if !base_ready(root) {
        missing.push(BASE_FILE.into());
    }
    missing
}

fn local_catalog(root: &Path) -> Value {
    fs::read_to_string(root.join("configs/online_catalog.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn missing_bytes(root: &Path, data: &Value) -> u64 {
    let assets = asset_root(root);
    let packs = ["engine", "shared"]
        .into_iter()
        .filter(|part| !missing_part(&assets.join(part), part).is_empty())
        .filter_map(|part| data[GROUP][part]["size_bytes"].as_u64())
        .sum::<u64>();
    packs + if base_ready(root) { 0 } else { BASE_BYTES }
}

pub(crate) fn status(root: &Path) -> Value {
    let missing = missing(root);
    let size = if cfg!(windows) && !missing.is_empty() {
        missing_bytes(root, &local_catalog(root))
    } else {
        0
    };
    json!({
        "gsv_cpp_ready": missing.is_empty(),
        "gsv_cpp_missing": missing,
        "gsv_cpp_size_bytes": size,
    })
}

pub(crate) fn message(code: &str, fallback: &str) -> String {
    i18n::t_worker_msg(&json!({"message_code": format!("synth.{code}"), "message": fallback}))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn request_error(
    root: &Path,
    version: &str,
    text: &str,
    ref_text: &str,
    ref_lang: &str,
    params: &Value,
    streaming: bool,
    opts: &Value,
) -> Option<(&'static str, &'static str)> {
    let supported_lang = |lang: &str| {
        matches!(
            lang.to_ascii_lowercase().as_str(),
            "auto" | "zh" | "ja" | "all_zh" | "all_ja"
        )
    };
    if !cfg!(windows) {
        return Some(("vulkan_unavailable", "此设备无法使用 Vulkan 推理。"));
    }
    if version != "v5turbo"
        || streaming
        || opts["format"].as_str().unwrap_or("wav") != "wav"
        || opts["aux_refs"]
            .as_array()
            .is_some_and(|refs| !refs.is_empty())
        || params["super_sampling"].as_bool().unwrap_or(false)
        || params["batch_size"].as_u64().unwrap_or(1) != 1
        || !supported_lang(params["text_lang"].as_str().unwrap_or("auto"))
        || !supported_lang(ref_lang)
        || text.trim().is_empty()
        || text.len() > 4000
        || ref_text.trim().is_empty()
        || ref_text.len() > 4000
        || params["seed"]
            .as_i64()
            .is_some_and(|seed| !(-1..=i32::MAX as i64).contains(&seed))
    {
        return Some((
            "vulkan_unsupported",
            "Vulkan 需要 V5 Turbo 角色、单条参考音频和完整 WAV 输出。",
        ));
    }
    if !missing(root).is_empty() {
        return Some(("vulkan_resources_missing", "请先下载 Vulkan 推理资源。"));
    }
    None
}

struct Pack<'a> {
    name: &'a str,
    sha: &'a str,
    tag: &'a str,
    size: u64,
}

fn pack<'a>(data: &'a Value, part: &str) -> Option<Pack<'a>> {
    let blob = &data[GROUP][part];
    let name = blob["name"].as_str()?;
    let sha = blob["sha256"].as_str()?;
    let tag = blob["release_tag"].as_str()?;
    if !name.ends_with(".zip")
        || name.contains(['/', '\\', ':'])
        || sha.len() != 64
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
        || tag.is_empty()
        || tag.contains(['/', '\\', ':'])
    {
        return None;
    }
    Some(Pack {
        name,
        sha,
        tag,
        size: blob["size_bytes"].as_u64()?,
    })
}

fn progress_part(progress: &download::ProgressFn, done: u64, total: u64) -> download::ProgressFn {
    let progress = progress.clone();
    Arc::new(move |bytes, _, phase| progress((done + bytes).min(total), total, phase))
}

fn install_pack(
    root: &Path,
    part: &str,
    pack: &Pack<'_>,
    cancel: Arc<AtomicBool>,
    progress: download::ProgressFn,
) -> Result<(), String> {
    let cache = paths::update_cache(root);
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let archive = cache.join(pack.name);
    if download::verify_sha256(&archive, pack.sha).is_err() {
        download::download_request(
            download::DownloadRequest {
                urls: engine_assets::release_urls(root, pack.tag, pack.name),
                root: Some(root.to_path_buf()),
                dest: archive.clone(),
                expected_sha256: pack.sha.to_string(),
                size_hint: pack.size,
                connections: None,
                kind: download::DownloadKind::Dependency,
            },
            cancel.clone(),
            Some(progress),
        )?;
    }

    let assets = asset_root(root);
    fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let stamp = chrono::Utc::now().timestamp_micros();
    let stage = assets.join(format!(".{part}-staging-{stamp}"));
    let backup = assets.join(format!(".{part}-previous-{stamp}"));
    let destination = assets.join(part);
    let result = (|| {
        extract::extract_zip(&archive, &stage)?;
        if !missing_part(&stage, part).is_empty() {
            return Err(message(
                "vulkan_resources_missing",
                "Vulkan 推理资源不完整。",
            ));
        }
        if cancel.load(Ordering::Acquire) {
            return Ok(());
        }
        synth::while_idle(|| {
            synth::shutdown();
            let had_old = destination.exists();
            if had_old {
                fs::rename(&destination, &backup).map_err(|e| e.to_string())?;
            }
            if let Err(error) = fs::rename(&stage, &destination) {
                if had_old {
                    fs::rename(&backup, &destination).map_err(|restore| restore.to_string())?;
                }
                return Err(error.to_string());
            }
            let _ = fs::remove_dir_all(&backup);
            let _ = fs::remove_file(&archive);
            Ok(())
        })
    })();
    let _ = fs::remove_dir_all(&stage);
    result
}

fn install_base(
    root: &Path,
    data: &Value,
    cancel: Arc<AtomicBool>,
    progress: download::ProgressFn,
) -> Result<(), String> {
    let spec = extra_assets::parse_spec("gsv-v5", &data["extras"]["gsv-v5"])
        .ok_or_else(|| message("vulkan_resources_missing", "未找到 Vulkan 推理资源。"))?;
    let file = spec
        .files
        .into_iter()
        .find(|f| f.name == BASE_FILE && f.size_bytes == BASE_BYTES)
        .ok_or_else(|| message("vulkan_resources_missing", "未找到 V5 Turbo 底模。"))?;
    let destination = base_path(root);
    fs::create_dir_all(destination.parent().expect("base model parent"))
        .map_err(|e| e.to_string())?;
    let partial = destination.with_extension("pth.vulkan-part");
    download::download_request(
        download::DownloadRequest {
            urls: file.urls,
            root: Some(root.to_path_buf()),
            dest: partial.clone(),
            expected_sha256: file.sha256,
            size_hint: file.size_bytes,
            connections: None,
            kind: download::DownloadKind::Dependency,
        },
        cancel.clone(),
        Some(progress),
    )?;
    if !cancel.load(Ordering::Acquire) {
        synth::while_idle(|| {
            if !base_ready(root) {
                synth::shutdown();
                if destination.exists() {
                    fs::remove_file(&destination).map_err(|e| e.to_string())?;
                }
                fs::rename(&partial, &destination).map_err(|e| e.to_string())?;
            } else {
                let _ = fs::remove_file(&partial);
            }
            Ok(())
        })?;
    }
    Ok(())
}

pub(crate) fn ensure(root: &Path, progress: download::ProgressFn) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err(message(
            "vulkan_unavailable",
            "此设备无法使用 Vulkan 推理。",
        ));
    }
    let _lock = INSTALL.try_lock().map_err(|_| i18n::t("s.synthErrBusy"))?;
    let cancel = cancel_flag();
    cancel.store(false, Ordering::Release);
    if missing(root).is_empty() {
        return Ok(json!({"ok": true}));
    }

    let local = local_catalog(root);
    let data = catalog::fetch_remote_catalog_cached(12)
        .ok()
        .filter(|d| d[GROUP].is_object())
        .unwrap_or(local);
    let total = missing_bytes(root, &data).max(1);
    let result: Result<(), String> = (|| {
        let mut done = 0;
        for part in ["engine", "shared"] {
            if cancel.load(Ordering::Acquire) {
                return Ok(());
            }
            if missing_part(&asset_root(root).join(part), part).is_empty() {
                continue;
            }
            let pack = pack(&data, part)
                .ok_or_else(|| message("vulkan_resources_missing", "未找到 Vulkan 推理资源。"))?;
            install_pack(
                root,
                part,
                &pack,
                cancel.clone(),
                progress_part(&progress, done, total),
            )?;
            done += pack.size;
        }
        if !cancel.load(Ordering::Acquire) && !base_ready(root) {
            install_base(
                root,
                &data,
                cancel.clone(),
                progress_part(&progress, done, total),
            )?;
        }
        Ok(())
    })();
    if cancel.load(Ordering::Acquire) {
        return Ok(json!({"ok": false, "cancelled": true}));
    }
    result?;
    if !missing(root).is_empty() {
        return Err(message(
            "vulkan_resources_missing",
            "Vulkan 推理资源不完整。",
        ));
    }
    Ok(json!({"ok": true}))
}
