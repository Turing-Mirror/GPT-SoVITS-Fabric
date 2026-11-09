//! GPT-SoVITS 底模（engine-core）供给。
//!
//! GPT-SoVITS 推理必装底模，缺一 worker 都起不来：
//!
//! * **cnhubert**（chinese-hubert-base）— SSL 音频特征底模；
//! * **roberta**（chinese-roberta-wwm-ext-large）— BERT 文本特征底模
//!   （同时是 g2pw 分词器的 model_source）；
//! * **GPT 底模 s1v3** — v3/v4/v2Pro/v2ProPlus 共用；
//! * **SoVITS 底模组** — 默认版本 v2ProPlus 的 s2Gv/s2Dv；
//! * **sv**（ERes2NetV2 说话人验证）— `sv.py` 的硬编码路径，Pro 模型
//!   `init_vits_weights` → `init_sv_model` 必走，缺了 load 直接崩；
//! * **G2PWModel** — 中文多音字模型，`text/chinese2.py` 在模块级建
//!   `G2PWPinyin(model_dir="GPT_SoVITS/text/G2PWModel")`，缺了它会去
//!   modelscope 静默拉一百多 MB，第一次中文合成看起来像卡死。
//!
//! 落点是**上游自己的布局**：`<安装根>/GPT_SoVITS/pretrained_models/` 与
//! `<安装根>/GPT_SoVITS/text/G2PWModel/`。上游源码里所有写死的路径
//! （sv.py、init_vocoder 的 vocoder、v3-LoRA 的 s2Gv3.pth、TTS_Config 的
//! 默认值、fast_langdetect 的 cache_dir）全都按 `<cwd>/GPT_SoVITS/...`
//! 解析，worker 的 cwd 就是安装根 —— 把底模放进 vendored 树里它们才看得见。
//! 顶层再放一份 `pretrained_models/` 只会变成上游永远读不到的孤儿。
//!
//! 清单路径与命名沿用发布仓 `catalog/sources.json` 的 `engine_core` 段；制品挂
//! `GSV-engine-core` Release 标签（发布仓 README 的标签约定）。sha256 见
//! `BASE_MODEL_PACKS`，由 `scripts/build_engine_core.py` 打包时算出。

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::{download, extract, paths};

pub(crate) const CNB_REPO: &str = "https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases";

/// 底模组制品的 Release 标签。
///
/// 必须和 `scripts/build_catalog.py` 的 `TAG_CORE` 一致 —— 在线清单里的
/// URL 由那边生成，这里是清单拉不到时的内置兜底。两边写不同的标签，
/// 兜底那条路就是一串 404，而且只有在 CNB 不通的时候才暴露出来。
///
/// 原来是 `base-models`（早期草案的标签名），而清单侧已经统一成
/// `GSV-` 前缀的五条。
const BASE_MODELS_TAG: &str = "GSV-engine-core";

/// GSV 必装底模包清单：(Release 附件名 / 缓存名, sha256)。
///
/// 对应 hubert+roberta / gpt-s1v3 / v2proplus(+sv) / g2pw / 语种识别五组，
/// 由 `scripts/build_engine_core.py` 按 `engine_core_files` 的清单打出。每个 zip 的
/// 内部路径都从 `GPT_SoVITS/` 底下算起（`pretrained_models/...`、
/// `text/G2PWModel/...`），统一解到 `<安装根>/GPT_SoVITS/`。sha256 取自
/// 打包脚本写出的 `manifest.json`；重打任何一个包都要同步改这里，否则
/// 用户那边下完校验不过，会反复重下。
const BASE_MODEL_PACKS: &[(&str, &str)] = &[
    (
        "base-hubert-bert.zip",
        "6b68a21a344931460fc12288382eecfe751f67ddfb97eecf440ce6625eee63c5",
    ),
    (
        "base-gpt-s1v3.zip",
        "a0bdc3d323b3cdcd0b728f32c46c8d017c1f01b71d36c3357c0f6cfa15329ea8",
    ),
    (
        "base-v2proplus.zip",
        "4b1a31ec85c75333a3e5c0dc5f66885cd599b867c7b5feb8a470648540065e68",
    ),
    (
        "base-g2pw.zip",
        "c74963eba422412f0e86c3623d7ef24251579fcef236f971f68c5c34516fade5",
    ),
    (
        "base-langdetect.zip",
        "a0fe2fbfb0decf18bd03b599e6ed3fb59060a2eca9fe2225d482cf768f164543",
    ),
];

/// 同一时刻只允许一个引擎资源包在下载。
///
/// 触发入口有好几个：首跑补全、工具窗、更多页。以前每个入口各起一条下载线程，
/// 全往同一个 `.part` 里写：一个在续传追加，另一个把文件预分配成完整长度盖上
/// 去，最后整包作废从零再来 —— 用户看到的就是「下完一遍又重新下一遍」。
/// 串行化之后后来的等先来的做完，轮到它时一看就绪了，直接返回。
static PACK_LOCK: Mutex<()> = Mutex::new(());

fn pack_lock() -> std::sync::MutexGuard<'static, ()> {
    PACK_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 内置清单里登记的包大小（字节）。拿不到就 0 —— 下载器按无提示处理，
/// 行为和从前一样。
///
/// 这个数喂给 `auto_connections` 和进度条分母：恒传 0 的话大包只开一条连接
/// 慢慢爬，慢网络下雪上加霜。
fn catalog_size_for(root: &Path, cache_name: &str) -> u64 {
    let data: Value = std::fs::read_to_string(root.join("configs").join("online_catalog.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    for section in ["engine_core", "extras"] {
        let Some(v) = data.get(section) else { continue };
        // 段本身就是条目（engine_core 在清单里是单对象）。
        if v.get("name").and_then(|x| x.as_str()) == Some(cache_name) {
            return v.get("size_bytes").and_then(|x| x.as_u64()).unwrap_or(0);
        }
        // 或者是「名字 → 条目」的映射（extras 预留这种形状）。
        if let Value::Object(m) = v {
            for e in m.values() {
                if e.get("name").and_then(|x| x.as_str()) == Some(cache_name) {
                    return e.get("size_bytes").and_then(|x| x.as_u64()).unwrap_or(0);
                }
            }
        }
    }
    0
}

// ---------------------------------------------------------------------------
// engine-core（GSV 底模）
// ---------------------------------------------------------------------------

/// 快速就绪检查的最小合理体积；下载完整性由包的 SHA-256 校验负责。
/// 已核验发布权重：cnhubert ~189MB、roberta ~651MB、s1v3 ~155MB、
/// v2ProPlus G ~200MB / D ~126MB、sv ~108MB、g2pw onnx ~635MB。
const MIN_HUBERT_BYTES: u64 = 100_000_000;
const MIN_BERT_BYTES: u64 = 500_000_000;
const MIN_S1V3_BYTES: u64 = 100_000_000;
const MIN_S2G_BYTES: u64 = 200_000_000;
const MIN_S2D_BYTES: u64 = 100_000_000;
const MIN_SV_BYTES: u64 = 10_000_000;
const MIN_G2PW_BYTES: u64 = 10_000_000;
/// fast_langdetect 的 lid.176.bin 约 126MB。
const MIN_LANGDETECT_BYTES: u64 = 100_000_000;
/// config.json / tokenizer.json 这类随行文件的下限。它们只有几 KB，
/// 但少一个 `from_pretrained` 就起不来，所以必须一并把关；给个很小的
/// 非零下限，只为挡住 0 字节的半截下载。
const MIN_SIDECAR_BYTES: u64 = 64;

/// 底模统一解到这里：`<安装根>/GPT_SoVITS/`。包里的相对路径
/// （`pretrained_models/...`、`text/G2PWModel/...`）落进去之后正好是上游
/// 源码按 cwd 拼出来的位置 —— sv.py、init_vocoder、TTS_Config 默认值、
/// fast_langdetect 的 cache_dir 全都指这儿，没有第二条约定要维护。
fn engine_core_dest(root: &Path) -> PathBuf {
    root.join("GPT_SoVITS")
}

/// (相对安装根的路径, 最小合法体积) — a truncated download must not
/// count as ready, which is why sizes are checked and not just existence.
///
/// 安装路径即上游源码期望的布局：`GPT_SoVITS/pretrained_models/` 下的
/// chinese-hubert-base/、chinese-roberta-wwm-ext-large/、s1v3.ckpt、
/// v2Pro/s2{G,D}v2ProPlus.pth（上游把两个 Pro 底模都放在 v2Pro/ 目录里，
/// 见 `TTS_Config.default_configs`）、sv/pretrained_eres2netv2w24s4ep4.ckpt
/// （`sv.py` 写死的相对路径，Pro 推理必加载），以及
/// `GPT_SoVITS/text/G2PWModel/`（`text/chinese2.py` 写死的 model_dir）。
/// worker 侧还会显式传绝对路径覆盖，但两边必须对齐同一套约定。
///
/// 前两项是 HuggingFace 模型**目录**，底下走 `from_pretrained()`：光有权重
/// 文件是起不来的，config.json 少一个就 `OSError`。所以这里按上游
/// `lj1995/GPT-SoVITS` 实际发布的文件逐个点名。
///
/// 这里原先点的是 `chinese-hubert-base/pretrained_model2.pth` —— 上游那个
/// 目录里**根本没有这个文件**（实际是 config.json / preprocessor_config.json
/// / pytorch_model.bin 三件）。也就是说底模就算下载得完完整整，
/// `engine_core_ready()` 也永远返回 false，合成台的前置闸永远打不开。
fn engine_core_files() -> Vec<(&'static str, u64)> {
    vec![
        (
            "GPT_SoVITS/pretrained_models/chinese-hubert-base/pytorch_model.bin",
            MIN_HUBERT_BYTES,
        ),
        (
            "GPT_SoVITS/pretrained_models/chinese-hubert-base/config.json",
            MIN_SIDECAR_BYTES,
        ),
        (
            "GPT_SoVITS/pretrained_models/chinese-hubert-base/preprocessor_config.json",
            MIN_SIDECAR_BYTES,
        ),
        (
            "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/pytorch_model.bin",
            MIN_BERT_BYTES,
        ),
        (
            "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/config.json",
            MIN_SIDECAR_BYTES,
        ),
        (
            "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/tokenizer.json",
            MIN_SIDECAR_BYTES,
        ),
        ("GPT_SoVITS/pretrained_models/s1v3.ckpt", MIN_S1V3_BYTES),
        (
            "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth",
            MIN_S2G_BYTES,
        ),
        (
            "GPT_SoVITS/pretrained_models/v2Pro/s2Dv2ProPlus.pth",
            MIN_S2D_BYTES,
        ),
        (
            "GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt",
            MIN_SV_BYTES,
        ),
        // 合成按「自动」认语种（synth_worker 的 text_lang=auto），走的是
        // fast_langdetect；上游 langsegmenter.py 把它的 cache_dir 指到这里，
        // 文件不在就当场去 Facebook 的 CDN 下 126MB。
        (
            "GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin",
            MIN_LANGDETECT_BYTES,
        ),
        ("GPT_SoVITS/text/G2PWModel/config.py", MIN_SIDECAR_BYTES),
        // G2PWPinyin 构造时无条件读这两份字表（onnx_api.py:113-114），
        // 缺了 g2pw 静默失效或当场崩 —— 不能只看 onnx 在不在。
        ("GPT_SoVITS/text/G2PWModel/POLYPHONIC_CHARS.txt", MIN_SIDECAR_BYTES),
        (
            "GPT_SoVITS/text/G2PWModel/MONOPHONIC_CHARS.txt",
            MIN_SIDECAR_BYTES,
        ),
    ]
}

/// onnx 权重两种命名上游都认（`_find_first_existing_file` 先试 g2pW.onnx
/// 再试 g2pw.onnx），检查也照此办。
fn g2pw_onnx_missing(root: &Path) -> bool {
    let dir = root.join("GPT_SoVITS/text/G2PWModel");
    !["g2pW.onnx", "g2pw.onnx"].iter().any(|n| {
        std::fs::metadata(dir.join(n))
            .map(|m| m.len() >= MIN_G2PW_BYTES)
            .unwrap_or(false)
    })
}

pub fn engine_core_missing(root: &Path) -> Vec<String> {
    let mut missing: Vec<String> = engine_core_files()
        .into_iter()
        .filter(|(rel, min)| {
            let p = root.join(rel);
            match std::fs::metadata(&p) {
                Ok(m) => !m.is_file() || m.len() < *min,
                Err(_) => true,
            }
        })
        .map(|(rel, _)| rel.to_string())
        .collect();
    if g2pw_onnx_missing(root) {
        missing.push("GPT_SoVITS/text/G2PWModel/g2pW.onnx".to_string());
    }
    missing
}

pub fn engine_core_ready(root: &Path) -> bool {
    engine_core_missing(root).is_empty()
}

// ---------------------------------------------------------------------------
// Shared download + extract
// ---------------------------------------------------------------------------

/// 按 Release 标签直连的下载地址。
///
/// 底模组制品只挂 Release 附件（发布仓规则：禁用 Git LFS），所以底模不走
/// 按 sha 寻址那条路，只按标签直连。基址列表从清单来（`mirrors::lfs_bases`），
/// 官方仓库永远排第一，要加备份源改一行 JSON 就行，不用发新版本。
pub fn release_urls(root: &Path, tag: &str, file: &str) -> Vec<String> {
    crate::mirrors::lfs_bases(root)
        .into_iter()
        .map(|base| format!("{base}/-/releases/download/{tag}/{file}"))
        .collect()
}

/// CNB LFS 的按 sha 寻址地址。只对当年还在用 git-lfs 时留下的老制品有效，
/// 现在只有 VC++ 运行库还在用这条路兜底。
fn lfs_urls(root: &Path, sha: &str) -> Vec<String> {
    crate::mirrors::lfs_bases(root)
        .into_iter()
        .map(|base| format!("{base}/-/lfs/{sha}"))
        .collect()
}

/// 同 `fetch_pack`，但在按 sha 寻址之后再挂几条备用地址。
pub fn fetch_pack_with_fallback(
    cache_name: &str,
    sha: &str,
    extra: Vec<String>,
    dest_root: &Path,
    root: &Path,
    cancel: Arc<AtomicBool>,
    progress: Option<download::ProgressFn>,
) -> Result<(), String> {
    let cache = paths::update_cache(root);
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let archive = cache.join(cache_name);
    let cached_ok = archive.is_file() && download::verify_sha256(&archive, sha).is_ok();
    if !cached_ok {
        let mut urls = lfs_urls(root, sha);
        urls.extend(extra);
        download::download_request(
            download::DownloadRequest {
                urls,
                root: Some(root.to_path_buf()),
                dest: archive.clone(),
                expected_sha256: sha.to_string(),
                size_hint: catalog_size_for(root, cache_name),
                connections: None,
                kind: download::DownloadKind::Dependency,
            },
            cancel,
            progress,
        )
        .map_err(|e| crate::i18n::te("s.04c4e3b2b3", &(e)))?;
    }
    extract::extract_zip(&archive, dest_root).map_err(|e| crate::i18n::te("s.0707e8af4e", &(e)))?;
    let _ = std::fs::remove_file(&archive);
    Ok(())
}

/// 下载并解开一个底模包到安装根。
///
/// 只走按标签直连的地址（底模组制品不进 LFS 命名空间）。sha 为空串期间
/// 无法校验缓存也无法校验成品 —— 缓存复用直接放弃（每次重下），完整性
/// 校验交给下载器对空 sha 的现状行为（跳过）；回填之后两条都自动生效。
fn fetch_base_pack(
    file: &str,
    sha: &str,
    dest_root: &Path,
    root: &Path,
    cancel: Arc<AtomicBool>,
    progress: Option<download::ProgressFn>,
) -> Result<(), String> {
    let cache = paths::update_cache(root);
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let archive = cache.join(file);

    let cached_ok =
        !sha.is_empty() && archive.is_file() && download::verify_sha256(&archive, sha).is_ok();
    if !cached_ok {
        // Passing progress through is what keeps the first-run gate honest:
        // without it the bar sits still while the NIC is busy for minutes.
        download::download_request(
            download::DownloadRequest {
                urls: release_urls(root, BASE_MODELS_TAG, file),
                root: Some(root.to_path_buf()),
                dest: archive.clone(),
                expected_sha256: sha.to_string(),
                size_hint: catalog_size_for(root, file),
                connections: None,
                kind: download::DownloadKind::Dependency,
            },
            cancel,
            progress,
        )
        .map_err(|e| crate::i18n::te("s.04c4e3b2b3", &(e)))?;
    }

    extract::extract_zip(&archive, dest_root).map_err(|e| crate::i18n::te("s.0707e8af4e", &(e)))?;
    let _ = std::fs::remove_file(&archive);
    Ok(())
}

/// Hoist `<dir>/<name>/*` up into `<dir>` when the zip carried a single
/// top-level folder of that name.
///
/// 打包侧稍不留神就会带出一层顶层目录；没有这个抬升，pretrained_models 会
/// 垫深一层，就绪检查永远找不到文件，用户只会看到无限重下。
fn hoist_nested(dir: &Path, name: &str) {
    let nested = dir.join(name);
    if !nested.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&nested) else {
        return;
    };
    for e in entries.filter_map(|e| e.ok()) {
        let from = e.path();
        let to = dir.join(e.file_name());
        if to.exists() {
            let _ = if to.is_dir() {
                std::fs::remove_dir_all(&to)
            } else {
                std::fs::remove_file(&to)
            };
        }
        let _ = std::fs::rename(&from, &to);
    }
    let _ = std::fs::remove_dir(&nested);
}

/// Download + extract every required base-model pack under `GPT_SoVITS/`.
///
/// `progress` mirrors the shared downloader's (done, total, phase) so the
/// caller can forward it to the UI. Before it existed, the first-run gate
/// showed a frozen bar during this step — hundreds of MB of base models with
/// no event at all, which reads exactly like a hang.
pub fn ensure_engine_core(
    root: &Path,
    cancel: Arc<AtomicBool>,
    progress: Option<download::ProgressFn>,
) -> Result<(), String> {
    // 先拿锁再看就绪：并发触发的第二个调用等第一个下完，回头一看文件都在
    // 了，直接返回 —— 而不是再起一条下载线程去打同一个 .part。
    let _flight = pack_lock();
    if engine_core_ready(root) {
        return Ok(());
    }
    let dest = engine_core_dest(root);
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for &(file, sha) in BASE_MODEL_PACKS {
        fetch_base_pack(file, sha, &dest, root, cancel.clone(), progress.clone())?;
    }
    if !engine_core_ready(root) {
        // Same guard: a single top-level folder in the zip would put
        // pretrained_models/ one level too deep.
        for &(file, _) in BASE_MODEL_PACKS {
            hoist_nested(&dest, file.trim_end_matches(".zip"));
        }
    }
    let missing = engine_core_missing(root);
    if missing.is_empty() {
        Ok(())
    } else {
        Err(crate::i18n::te("s.f36aff2870", &(missing.join("、"))))
    }
}

/// Status for the first-run gate and the Help page.
pub fn assets_status(root: &Path) -> Value {
    let missing = engine_core_missing(root);
    json!({
        "engine_core_ready": missing.is_empty(),
        "engine_core_missing": missing,
        "engine_core_packs": BASE_MODEL_PACKS.iter().map(|(name, _)| json!({
            "name": name,
            "size_bytes": catalog_size_for(root, name),
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的完整长度假 sha（lfs 寻址形态只看字符串本身）。
    const TEST_SHA: &str = "ecb3231c7d26ad553e902ac24d40daf3d3fbe5786a7d8e78af8038fc389cab47";

    #[test]
    fn catalog_size_feeds_the_base_pack_download() {
        // 大包以前 size_hint 恒为 0，auto_connections 只给一条连接慢慢爬，
        // 进度条连分母都没有。大小得从内置清单里查出来。
        let root = crate::testutil::scratch("catalog-size");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("configs")).unwrap();
        std::fs::write(
            root.join("configs").join("online_catalog.json"),
            r#"{"engine_core":{"name":"base-v2proplus.zip","size_bytes":209715200}}"#,
        )
        .unwrap();
        assert_eq!(catalog_size_for(&root, "base-v2proplus.zip"), 209_715_200);
        assert_eq!(catalog_size_for(&root, "not-in-catalog.zip"), 0);
        let status = assets_status(&root);
        let packs = status["engine_core_packs"].as_array().unwrap();
        assert_eq!(packs.len(), BASE_MODEL_PACKS.len());
        assert_eq!(packs.iter().find(|p| p["name"] == "base-v2proplus.zip").unwrap()["size_bytes"], 209_715_200);
        assert_eq!(status["engine_core_ready"], false);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn base_pack_urls_are_tag_addressed_under_base_models() {
        // 底模组制品只挂 Release 附件（发布仓禁止 LFS），必须按标签直连。
        let root = crate::testutil::scratch("base-url");
        let _ = std::fs::remove_dir_all(&root);
        for (file, _) in BASE_MODEL_PACKS {
            let u = release_urls(&root, BASE_MODELS_TAG, file);
            assert_eq!(u.len(), 1, "{file}: no catalog means official repo only");
            assert!(u[0].starts_with(CNB_REPO), "{file}: {u:?}");
            assert!(
                u[0].ends_with(&format!("/-/releases/download/{BASE_MODELS_TAG}/{file}")),
                "{file}: {}",
                u[0]
            );
        }
    }

    #[test]
    fn base_pack_sha_is_empty_or_a_full_digest() {
        // M0 待回填：现在必须是空串（不伪造校验值）；回填后必须是完整摘要。
        for (name, sha) in BASE_MODEL_PACKS {
            let ok = sha.is_empty()
                || (sha.len() == 64 && sha.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(ok, "{name}: sha256 must be empty or a full digest, got {sha:?}");
        }
    }

    /// Rust 的内置兜底标签必须和 `build_catalog.py` 生成清单时用的一致。
    ///
    /// 两边写不同的标签，兜底那条路就是一串 404 —— 而且只有在 CNB 拉不到
    /// 清单的时候才暴露出来，也就是用户最需要兜底的那一刻。
    #[test]
    fn the_release_tags_match_the_catalog_builder() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/build_catalog.py"),
        )
        .expect("scripts/build_catalog.py 必须在");
        for (rs, py) in [
            (BASE_MODELS_TAG, "TAG_CORE"),
            (crate::catalog::DEFAULT_RELEASE_TAG, "TAG_RUNTIME"),
        ] {
            let line = src
                .lines()
                .find(|l| l.starts_with(py))
                .unwrap_or_else(|| panic!("build_catalog.py 里没有 {py}"));
            let want = line.split('"').nth(1).unwrap_or("");
            assert_eq!(rs, want, "{py} 两边对不上");
        }
    }

    #[test]
    fn missing_when_root_is_empty() {
        let tmp = crate::testutil::scratch("engine-core-test");
        let _ = std::fs::create_dir_all(&tmp);
        // +1：g2pw 的 onnx 走二选一探测，不在 engine_core_files 清单里。
        assert_eq!(
            engine_core_missing(&tmp).len(),
            engine_core_files().len() + 1
        );
        assert!(!engine_core_ready(&tmp));
    }

    #[test]
    fn published_gpt_and_sovits_sizes_are_recognized() {
        let root = crate::testutil::scratch("published-core-sizes");
        // Uncompressed lengths in the SHA-256 verified GSV-engine-core packages.
        let published = [
            ("GPT_SoVITS/pretrained_models/s1v3.ckpt", 155_284_856),
            ("GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth", 200_125_741),
            ("GPT_SoVITS/pretrained_models/v2Pro/s2Dv2ProPlus.pth", 126_432_639),
        ];
        for (rel, size) in published {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::File::create(path).unwrap().set_len(size).unwrap();
        }
        let missing = engine_core_missing(&root);
        for (rel, _) in published {
            assert!(!missing.iter().any(|item| item == rel), "complete model rejected: {rel}");
            std::fs::File::create(root.join(rel)).unwrap().set_len(1024).unwrap();
            assert!(engine_core_missing(&root).iter().any(|item| item == rel), "truncated model accepted: {rel}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn truncated_first_base_model_does_not_count_as_ready() {
        let tmp = crate::testutil::scratch("engine-core-trunc");
        let f = tmp.join("GPT_SoVITS/pretrained_models/chinese-hubert-base");
        let _ = std::fs::create_dir_all(&f);
        let _ = std::fs::write(f.join("pytorch_model.bin"), b"too small");
        assert!(engine_core_missing(&tmp)
            .iter()
            .any(|m| m.contains("chinese-hubert-base/pytorch_model.bin")));
    }

    #[test]
    fn hoists_a_single_nested_folder() {
        // 底模包若带单层顶层目录（如 base-hubert-bert/），解出来的
        // pretrained_models 会垫深一层，就绪检查永远找不到文件。
        let base = engine_core_dest(&crate::testutil::scratch("hoist-test"));
        let _ = std::fs::remove_dir_all(&base);
        let nested = base.join("base-hubert-bert");
        std::fs::create_dir_all(nested.join("pretrained_models/chinese-hubert-base")).unwrap();
        std::fs::write(
            nested.join("pretrained_models/chinese-hubert-base/pytorch_model.bin"),
            b"x".repeat(1_000),
        )
        .unwrap();

        assert!(
            !base.join("pretrained_models").exists(),
            "before hoist: one level too deep"
        );
        hoist_nested(&base, "base-hubert-bert");
        assert!(
            base.join("pretrained_models/chinese-hubert-base/pytorch_model.bin")
                .is_file(),
            "after hoist: file at the expected install path"
        );
        assert!(!nested.exists(), "nested dir removed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 就绪清单里的每一条都必须落在上游源码自己拼得出来的位置：
    /// `GPT_SoVITS/pretrained_models/` 或 `GPT_SoVITS/text/`。钉住这条约定 ——
    /// 哪天有人把 dest 挪回安装根顶层，sv.py 和 vocoder 的硬编码路径就全断了。
    #[test]
    fn core_files_live_inside_the_vendored_tree() {
        for (rel, _) in engine_core_files() {
            assert!(
                rel.starts_with("GPT_SoVITS/"),
                "{rel} 必须落在 GPT_SoVITS/ 下，上游按 <cwd>/GPT_SoVITS/... 解析"
            );
        }
    }

    #[test]
    fn lfs_url_is_sha_addressed() {
        let root = crate::testutil::scratch("lfs-url");
        let _ = std::fs::remove_dir_all(&root);
        let u = lfs_urls(&root, TEST_SHA);
        // 没有清单时就只有官方仓库那一条
        assert_eq!(u.len(), 1);
        assert!(u[0].starts_with(CNB_REPO));
        assert!(u[0].ends_with(TEST_SHA));
        assert!(u[0].contains("/-/lfs/"));
    }

    #[test]
    fn a_release_tag_url_is_built_for_every_mirror() {
        // 备用源必须跟着镜像一起铺开，只有官方仓一条的话 CNB 一挂就全断。
        let root = crate::testutil::scratch("rel-url");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("configs")).unwrap();
        std::fs::write(
            root.join("configs").join("online_catalog.json"),
            r#"{"download_mirrors":{"lfs":["https://backup.example.cn/Turing-Mirror/Rel"]}}"#,
        )
        .unwrap();
        let u = release_urls(&root, "vcredist", "vcredist-x64.zip");
        assert_eq!(u.len(), 2, "{u:?}");
        assert!(u[0].starts_with(CNB_REPO), "官方仓库必须还是第一个");
        assert!(u[0].ends_with("/-/releases/download/vcredist/vcredist-x64.zip"), "{}", u[0]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lfs_urls_pick_up_catalog_mirrors() {
        // 引擎资源是首次运行的必经之路，只有一个源的话 CNB 一挂谁都装不上。
        let root = crate::testutil::scratch("lfs-mirror");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("configs")).unwrap();
        std::fs::write(
            root.join("configs").join("online_catalog.json"),
            r#"{"download_mirrors":{"lfs":["https://backup.example.cn/Turing-Mirror/Rel"]}}"#,
        )
        .unwrap();
        let u = lfs_urls(&root, TEST_SHA);
        assert_eq!(u.len(), 2, "{u:?}");
        assert!(u[0].starts_with(CNB_REPO), "官方仓库必须还是第一个");
        assert!(u[1].starts_with("https://backup.example.cn/"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
