//! 角色包导入：`<id>_voice.zip` → `User_Data/characters/<id>/`。
//!
//! 包格式见 docs/DECISIONS.md D4：
//!
//! ```text
//! <id>_voice.zip
//! ├─ config.json     id/name/author/date/cover/version/lists/params
//! ├─ cover.jpg
//! ├─ models/{sovits.pth, gpt.ckpt}
//! └─ dataset/{<id>.list, audios/*.wav}
//! ```
//!
//! 合成台读的就是这个目录（`synth::list_characters`）。在这之前，角色包
//! 只能靠用户自己往 `User_Data/characters` 里拷文件夹 —— 「模型」页那个
//! 「导入角色包」按钮转 1.2 秒然后什么也不做。
//!
//! 三条纪律，都是把包当外来数据：
//!
//! * **路径**：zip 条目只接受相对路径的正常组件，绝对路径 / `..` / 盘符
//!   一律拒收（zip-slip）。落盘目录名另走一遍清洗，不用包里给的 id 原文。
//! * **体积**：单条目与整包都有上限。角色包里最大的是 sovits.pth 与音频，
//!   给得很宽，但不能没有 —— 没有上限等于把「解压后多大」交给做包的人定。
//! * **完整性**：`config.json` 与两份权重缺一不可，缺了就整包拒收。装进去
//!   一个跑不了的角色，比导入失败难查得多：用户要点到合成才会发现。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::paths;

/// 单个条目的解压上限。sovits.pth 大约 100 MB 量级，音频逐条也远小于此。
const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
/// 整包上限。带完整数据集的角色包上到 1–2 GB 是正常的。
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// zip 条目路径只收「正常组件」构成的相对路径。
fn check_entry_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("empty entry path".into());
    }
    if rel.contains(':') {
        return Err(format!("drive letter in zip entry: {rel}"));
    }
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(format!("absolute path in zip: {rel}"));
    }
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(format!("dotdot in zip entry: {rel}"));
        }
    }
    let p = Path::new(&normalized);
    if p.is_absolute() {
        return Err(format!("absolute path in zip: {rel}"));
    }
    Ok(())
}

/// 角色 id → 落盘目录名。任何路径语义都在清洗中消失。
pub fn safe_id(id: &str) -> String {
    let mut out = String::new();
    for c in id.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    let trimmed = if trimmed.is_empty() {
        "role".to_string()
    } else {
        trimmed
    };
    trimmed.chars().take(60).collect()
}

/// 单层包装目录：Windows 右键「压缩」出来的 zip 都带一层。
/// 所有条目共享同一个首段时把它剥掉。
fn content_root(names: &[String]) -> String {
    let mut root: Option<String> = None;
    for n in names {
        let Some((head, rest)) = n.split_once('/') else {
            return String::new(); // 有条目在根上，说明没有包装目录
        };
        if rest.is_empty() {
            continue;
        }
        match &root {
            None => root = Some(head.to_string()),
            Some(r) if r == head => {}
            Some(_) => return String::new(),
        }
    }
    root.unwrap_or_default()
}

struct Zip {
    files: BTreeMap<String, Vec<u8>>,
}

fn read_zip(path: &Path) -> Result<Zip, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        check_entry_path(&name)?;
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(format!("entry too large: {name}"));
        }
        // take 之后多出来的字节读不到，于是「读满了上限」就等价于
        // 「这个条目比它自报的还大」。
        let mut buf = Vec::new();
        entry
            .take(MAX_ENTRY_BYTES + 1)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        if buf.len() as u64 > MAX_ENTRY_BYTES {
            return Err(format!("entry too large: {name}"));
        }
        total += buf.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err("pack too large".into());
        }
        names.push(name.clone());
        files.insert(name, buf);
    }
    let root = content_root(&names);
    let files = files
        .into_iter()
        .map(|(k, v)| {
            if root.is_empty() {
                (k, v)
            } else {
                (k[root.len() + 1..].to_string(), v)
            }
        })
        .collect();
    Ok(Zip { files })
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// 解析并落盘。返回装好的角色摘要（id / name / dir）。
pub fn install_zip(root: &Path, zip_path: &Path) -> Result<Value, String> {
    install_zip_as(root, zip_path, None)
}

pub(crate) fn install_zip_as(root: &Path, zip_path: &Path, role_id: Option<&str>) -> Result<Value, String> {
    let z = read_zip(zip_path)?;

    let cfg_bytes = z
        .files
        .get("config.json")
        .ok_or_else(|| crate::i18n::t("s.roleErrNoConfig"))?;
    let mut cfg: Value =
        serde_json::from_slice(cfg_bytes).map_err(|e| crate::i18n::te("s.roleErrBadConfig", &e))?;

    let name = str_field(&cfg, "name");
    if name.trim().is_empty() {
        return Err(crate::i18n::t("s.roleErrNoName"));
    }

    // 两份权重缺一不可 —— 少了任何一份，这个角色在合成台点下去只会报错。
    for need in ["models/sovits.pth", "models/gpt.ckpt"] {
        if !z.files.contains_key(need) {
            return Err(crate::i18n::te("s.roleErrMissingWeight", &need));
        }
    }

    if cfg["lists"].is_null() {
        let found = bundled_references(&z.files);
        if !found.is_empty() {
            cfg["lists"] = json!(found);
        }
    }

    // id 优先用包里声明的，其次退到文件名。两条都过清洗。
    let declared = str_field(&cfg, "id");
    let fallback = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("role")
        .trim_end_matches("_voice")
        .to_string();
    let id = safe_id(role_id.unwrap_or_else(|| if declared.trim().is_empty() {
        &fallback
    } else {
        &declared
    }));

    let parent = paths::user_data(root).join("characters");
    let dest = parent.join(&id);
    let nonce = crate::role_assets::unique();
    let stage = paths::user_data(root).join(format!(".install-{nonce}"));
    let backup = paths::user_data(root).join(format!(".previous-{nonce}"));
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        for (rel, bytes) in &z.files {
            // 落盘前再查一遍：剥包装目录是字符串操作，别让它把校验绕过去。
            check_entry_path(rel)?;
            let out = stage.join(rel);
            // 最后一道：算出来的路径必须仍在角色目录里。
            if !out.starts_with(&stage) {
                return Err(format!("entry escapes the pack dir: {rel}"));
            }
            if rel == "config.json" {
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            std::fs::write(&out, bytes).map_err(|e| format!("{}: {e}", out.display()))?;
        }

        if crate::paths::runtime_python(root).is_some()
            && root.join("tools/weight_inspect.py").is_file()
        {
            let detected = crate::role_assets::inspect_replacement(
                root,
                "sovits",
                &stage.join("models/sovits.pth"),
                Some(&stage.join("models/gpt.ckpt")),
                None,
            )?;
            cfg["version"] = detected["version"].clone();
            cfg["weight_info"] = json!({"gpt": detected["gpt"], "sovits": detected["sovits"]});
            cfg["weight_validation"] = json!("verified");
        } else {
            cfg["weight_validation"] = json!("pending");
        }
        write_cfg(&stage, &cfg)?;
        static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _lock = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let replacing = dest.exists();
        if replacing {
            std::fs::rename(&dest, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(e) = std::fs::rename(&stage, &dest) {
            if replacing {
                std::fs::rename(&backup, &dest).map_err(|restore| format!("{e}; {restore}"))?;
            }
            return Err(e.to_string());
        }
        if replacing {
            let _ = std::fs::remove_dir_all(&backup);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    result?;

    let version = {
        let v = str_field(&cfg, "version");
        if v.is_empty() {
            "v2ProPlus".to_string()
        } else {
            v
        }
    };
    Ok(json!({
        "id": id,
        "name": name,
        "author": str_field(&cfg, "author"),
        "version": version,
        "dir": dest.to_string_lossy(),
    }))
}

/// 选包对话框。原生对话框要主线程，所以留在调用方那一侧。
pub fn pick_pack(win: Option<&tauri::WebviewWindow>) -> Vec<PathBuf> {
    crate::shell_extras::dialog_on(win)
        .add_filter(&crate::i18n::t("s.rolePackFilter"), &["zip"])
        .set_title(&crate::i18n::t("s.rolePackPickTitle"))
        .pick_files()
        .unwrap_or_default()
}

// --- 角色管理：改名、删除、导出、换封面 ------------------------------------

/// 封面接受的图片格式。
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];

/// 已装角色的目录。id 必须原样就是清洗过的目录名，不能借它指到别处。
pub(crate) fn role_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || safe_id(id) != id {
        return Err(crate::i18n::t("s.roleErrNotFound"));
    }
    let dir = paths::user_data(root).join("characters").join(id);
    if !dir.join("config.json").is_file() {
        return Err(crate::i18n::t("s.roleErrNotFound"));
    }
    Ok(dir)
}

pub(crate) fn read_cfg(dir: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(dir.join("config.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| crate::i18n::te("s.roleErrBadConfig", &e))
}

pub(crate) fn write_cfg(dir: &Path, cfg: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    crate::config::write_atomic(&dir.join("config.json"), &text).map_err(|e| e.to_string())
}

/// 改名称与作者。只动这两项，其余字段原样保留。
pub fn update_meta(root: &Path, id: &str, name: &str, author: &str) -> Result<Value, String> {
    let dir = role_dir(root, id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(crate::i18n::t("s.roleErrNoName"));
    }
    let mut cfg = read_cfg(&dir)?;
    let obj = cfg.as_object_mut().ok_or_else(|| crate::i18n::t("s.roleErrNoConfig"))?;
    obj.insert("name".into(), json!(name));
    obj.insert("author".into(), json!(author.trim()));
    write_cfg(&dir, &cfg)?;
    Ok(json!({ "id": id, "name": name, "author": author.trim() }))
}

/// 删除整个角色目录。
pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let dir = role_dir(root, id)?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))
}

/// Local image bytes are shared with wallpaper sampling so canvas stays same-origin.
pub fn cover_data_url(src: &str) -> Result<String, String> {
    crate::wallpaper::data_url(src).map_err(|_| crate::i18n::t("s.roleErrCoverType"))
}

const CUSTOM_COVER_PREFIX: &str = "cover-custom-";
const MAX_COVER_BYTES: usize = 16 * 1024 * 1024;

/// Preserve the package cover; edits are separate content-addressed files.
pub fn save_cover(root: &Path, id: &str, data_url: &str) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    let dir = role_dir(root, id)?;
    let invalid = || crate::i18n::t("s.roleErrCoverType");
    let (header, encoded) = data_url.split_once(',').ok_or_else(invalid)?;
    if !["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64", "data:image/bmp;base64"].contains(&header)
        || encoded.len() > MAX_COVER_BYTES.div_ceil(3) * 4 {
        return Err(invalid());
    }
    let bytes = crate::shell_extras::base64_decode(encoded).ok_or_else(invalid)?;
    let ext = match crate::wallpaper::sniff_mime(&bytes) {
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        Some("image/bmp") => "bmp",
        _ => return Err(invalid()),
    };
    if bytes.len() > MAX_COVER_BYTES { return Err(invalid()); }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let name = format!("{CUSTOM_COVER_PREFIX}{}.{ext}", &digest[..16]);
    let mut cfg = read_cfg(&dir)?;
    let previous = str_field(&cfg, "cover");
    let obj = cfg.as_object_mut().ok_or_else(|| crate::i18n::t("s.roleErrNoConfig"))?;
    if !obj.contains_key("original_cover") {
        obj.insert("original_cover".into(), json!(previous));
    }
    std::fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
    obj.insert("cover".into(), json!(name));
    write_cfg(&dir, &cfg)?;
    if previous != name && previous != str_field(&cfg, "original_cover") && previous.starts_with(CUSTOM_COVER_PREFIX) && check_entry_path(&previous).is_ok() {
        let _ = std::fs::remove_file(dir.join(previous));
    }
    Ok(json!({"id": id, "cover": name}))
}

pub fn reset_cover(root: &Path, id: &str) -> Result<Value, String> {
    let dir = role_dir(root, id)?;
    let mut cfg = read_cfg(&dir)?;
    let current = str_field(&cfg, "cover");
    let Some(original) = cfg.get("original_cover").and_then(Value::as_str).map(str::to_string) else {
        return Ok(json!({"id":id,"cover":current}));
    };
    let obj = cfg.as_object_mut().ok_or_else(|| crate::i18n::t("s.roleErrNoConfig"))?;
    obj.insert("cover".into(), json!(original));
    obj.remove("original_cover");
    write_cfg(&dir, &cfg)?;
    if current != original && current.starts_with(CUSTOM_COVER_PREFIX) && check_entry_path(&current).is_ok() {
        let _ = std::fs::remove_file(dir.join(current));
    }
    Ok(json!({"id":id,"cover":original}))
}

/// Compatibility entry point for callers that already have a local image path.
pub fn set_cover(root: &Path, id: &str, src: &Path) -> Result<Value, String> {
    let data = cover_data_url(&src.to_string_lossy())?;
    save_cover(root, id, &data)
}

fn portable_path(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    (!path.contains(':')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != ".."))
        .then_some(path)
}

fn is_annotation(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("list"))
}

fn bundled_references(files: &BTreeMap<String, Vec<u8>>) -> Vec<Value> {
    files
        .iter()
        .filter_map(|(path, bytes)| {
            if !path.starts_with("dataset/") || !is_annotation(path) {
                return None;
            }
            let path = portable_path(path)?;
            let (parent, _) = path.rsplit_once('/')?;
            let rows = crate::annot::parse_rows(std::str::from_utf8(bytes).ok()?);
            let complete = !rows.is_empty()
                && rows.iter().all(|row| {
                    row.is_complete()
                        && portable_path(&row.wav).is_some_and(|audio| {
                            files
                                .get(&format!("{parent}/{audio}"))
                                .is_some_and(|data| !data.is_empty())
                        })
                });
            complete.then(|| json!({ "file": path }))
        })
        .collect()
}

fn export_lists(dir: &Path, config: &Value) -> Vec<Value> {
    if let Some(lists) = config["lists"].as_array() {
        return lists.clone();
    }
    if !config["lists"].is_null() {
        return Vec::new();
    }
    // Older role directories may have their own .list but no saved association.
    let mut paths: Vec<_> = std::fs::read_dir(dir.join("dataset"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_annotation(name))
        .collect();
    paths.sort();
    paths.into_iter().map(|name| json!({ "file": format!("dataset/{name}") })).collect()
}

fn role_file(dir: &Path, path: &str) -> Option<PathBuf> {
    let source = dir.join(portable_path(path)?).canonicalize().ok()?;
    (source.starts_with(dir) && source.is_file()).then_some(source)
}

fn add_export_references(
    dir: &Path,
    lists: &mut [Value],
    files: &mut BTreeMap<String, PathBuf>,
) -> Result<BTreeMap<String, String>, String> {
    let invalid_list = || crate::i18n::t("s.roleErrListInvalid");
    let missing_audio = || crate::i18n::t("s.roleErrListAudio");
    let mut annotations = BTreeMap::new();
    let mut audio_entries = BTreeMap::<PathBuf, String>::new();
    for (index, list) in lists.iter_mut().enumerate() {
        let original = list["file"].as_str().filter(|path| is_annotation(path)).ok_or_else(invalid_list)?;
        let source = role_file(dir, original).ok_or_else(invalid_list)?;
        let rows = crate::annot::read_rows(&source)?;
        if rows.is_empty() || rows.iter().any(|row| !row.is_complete()) {
            return Err(invalid_list());
        }
        let mut body = String::new();
        for row in rows {
            let audio = Path::new(&row.abs).canonicalize().map_err(|_| missing_audio())?;
            let ext = audio.extension().and_then(|ext| ext.to_str())
                .map(str::to_ascii_lowercase)
                .filter(|ext| crate::train::DATASET_AUDIO_EXT.contains(&ext.as_str()))
                .ok_or_else(missing_audio)?;
            if !audio.starts_with(dir)
                || !std::fs::metadata(&audio).is_ok_and(|info| info.is_file() && info.len() > 0)
            {
                return Err(missing_audio());
            }
            let next = audio_entries.len() + 1;
            let relative = audio_entries.entry(audio.clone()).or_insert_with(|| {
                let relative = format!("audios/{next:05}.{ext}");
                files.insert(format!("dataset/{relative}"), audio);
                relative
            });
            body.push_str(&format!("{relative}|{}|{}|{}\n", row.speaker, row.lang, row.text));
        }
        let file = format!("dataset/references-{:02}.list", index + 1);
        annotations.insert(file.clone(), body);
        if list["note"].as_str().is_none_or(str::is_empty) {
            list["note"] = json!(Path::new(original).file_name().unwrap_or_default().to_string_lossy());
        }
        list["file"] = json!(file);
    }
    Ok(annotations)
}

/// Export a self-contained character with both weights and all linked references.
pub fn export_zip(root: &Path, id: &str, dest: &Path) -> Result<Value, String> {
    let dir = role_dir(root, id)?.canonicalize().map_err(|e| e.to_string())?;
    let mut config = read_cfg(&dir)?;
    if !config.is_object() {
        return Err(crate::i18n::t("s.roleErrNoConfig"));
    }
    let mut lists = export_lists(&dir, &config);
    if lists.is_empty() {
        return Err(crate::i18n::t("s.roleExportNeedsList"));
    }

    let mut files = BTreeMap::new();
    for name in ["models/sovits.pth", "models/gpt.ckpt"] {
        let file = role_file(&dir, name)
            .ok_or_else(|| crate::i18n::te("s.roleErrMissingWeight", &name))?;
        files.insert(name.to_string(), file);
    }
    for key in ["cover", "original_cover"] {
        if let Some(name) = config[key].as_str().and_then(portable_path) {
            if let Some(source) = role_file(&dir, &name) {
                files.insert(name, source);
            }
        }
    }
    let mut annotations = add_export_references(&dir, &mut lists, &mut files)?;
    config["lists"] = json!(lists);
    let config_text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    annotations.insert("config.json".into(), config_text);
    let mut total = 0_u64;
    for size in files
        .values()
        .map(|source| std::fs::metadata(source).map(|info| info.len()))
        .chain(annotations.values().map(|text| Ok(text.len() as u64)))
    {
        let size = size.map_err(|e| e.to_string())?;
        total = total.saturating_add(size);
        if size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES {
            return Err(crate::i18n::t("publication.packTooLarge"));
        }
    }

    let stage = dest.with_extension(format!("{}.tmp", crate::role_assets::unique()));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stage)
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        for (name, source) in &files {
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            let mut file = std::fs::File::open(source).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut zip).map_err(|e| e.to_string())?;
        }
        for (name, text) in &annotations {
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        drop(zip.finish().map_err(|e| e.to_string())?);
        std::fs::rename(&stage, dest).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&stage);
    }
    result?;
    Ok(json!({ "path": dest.to_string_lossy(), "files": files.len() + annotations.len() }))
}

/// Read metadata without extracting the archive or loading model weights.
pub(crate) fn pack_metadata(root: &Path, path: &Path) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    let mut indexed = BTreeMap::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        check_entry_path(&name)?;
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(format!("entry too large: {name}"));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            return Err("pack too large".into());
        }
        if indexed.insert(name.clone(), index).is_some() {
            return Err("Duplicate package path.".into());
        }
        names.push(name);
    }

    let prefix = content_root(&names);
    let path_index = |file: &str| {
        let key = if prefix.is_empty() { file.to_owned() } else { format!("{prefix}/{file}") };
        indexed.get(&key).copied()
    };
    let weights = ["models/sovits.pth", "models/gpt.ckpt"]
        .map(|name| path_index(name).map(|index| (name, index))
            .ok_or_else(|| crate::i18n::te("s.roleErrMissingWeight", &name)));
    let [sovits, gpt] = weights;
    let weights = [sovits?, gpt?];
    let index = path_index("config.json").ok_or_else(|| crate::i18n::t("s.roleErrNoConfig"))?;
    let mut bytes = Vec::new();
    zip.by_index(index)
        .map_err(|e| e.to_string())?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Package metadata is too large.".into());
    }
    let mut config: Value = serde_json::from_slice(&bytes).map_err(|e| crate::i18n::te("s.roleErrBadConfig", &e))?;
    if str_field(&config, "name").trim().is_empty() {
        return Err(crate::i18n::t("s.roleErrNoName"));
    }

    let declared = str_field(&config, "id");
    let fallback = path.file_stem().and_then(|name| name.to_str()).unwrap_or("").trim_end_matches("_voice");
    let id = safe_id(if declared.trim().is_empty() { fallback } else { &declared });
    if let Ok(dir) = role_dir(root, &id) {
        if let Ok(local) = read_cfg(&dir) {
            if weights.iter().all(|(name, index)| {
                let Ok(entry) = zip.by_index(*index) else { return false; };
                same_weight(entry, &dir.join(name))
            }) {
                for key in ["name", "author", "author_url", "description", "version", "series", "group", "club", "language", "lang", "license", "lists"] {
                    if config[key].is_null() || config[key].as_str().is_some_and(|value| value.trim().is_empty()) {
                        config[key] = local[key].clone();
                    }
                }
                if local["weight_validation"] == "verified" && local["version"].is_string() {
                    config["version"] = local["version"].clone();
                }
            }
        }
    }
    Ok(config)
}

fn same_weight(entry: zip::read::ZipFile<'_>, installed: &Path) -> bool {
    use sha2::{Digest, Sha256};
    let size = entry.size();
    if size == 0 || size > MAX_ENTRY_BYTES || !std::fs::metadata(installed).is_ok_and(|file| file.is_file() && file.len() == size) {
        return false;
    }
    let Ok(local_hash) = crate::download::file_sha256(installed) else { return false; };
    let mut hasher = Sha256::new();
    std::io::copy(&mut entry.take(size + 1), &mut hasher).is_ok_and(|bytes| bytes == size)
        && hex::encode(hasher.finalize()) == local_hash
}

/// 选封面图片。
pub fn pick_cover(win: Option<&tauri::WebviewWindow>) -> Option<PathBuf> {
    crate::shell_extras::dialog_on(win)
        .add_filter(&crate::i18n::t("s.roleCoverFilter"), COVER_EXTS)
        .set_title(&crate::i18n::t("s.roleCoverPickTitle"))
        .pick_file()
}

/// 选导出位置，默认文件名 `<id>_voice.zip`。
pub fn pick_export(win: Option<&tauri::WebviewWindow>, id: &str) -> Option<PathBuf> {
    crate::shell_extras::dialog_on(win)
        .add_filter(&crate::i18n::t("s.rolePackFilter"), &["zip"])
        .set_title(&crate::i18n::t("s.roleExportTitle"))
        .set_file_name(format!("{id}_voice.zip"))
        .save_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn opts() -> SimpleFileOptions {
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
    }

    /// 建一个最小可用的角色包。`prefix` 用来模拟 Windows 右键压缩多出来的那层。
    fn make_pack(path: &Path, prefix: &str, cfg: &str) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let p = |n: &str| format!("{prefix}{n}");
        w.start_file(p("config.json"), opts()).unwrap();
        w.write_all(cfg.as_bytes()).unwrap();
        w.start_file(p("models/sovits.pth"), opts()).unwrap();
        w.write_all(b"sovits").unwrap();
        w.start_file(p("models/gpt.ckpt"), opts()).unwrap();
        w.write_all(b"gpt").unwrap();
        w.start_file(p("dataset/role.list"), opts()).unwrap();
        w.write_all("audios/a.wav|角色|ZH|你好\n".as_bytes()).unwrap();
        w.start_file(p("dataset/audios/a.wav"), opts()).unwrap();
        w.write_all(b"reference audio").unwrap();
        w.finish().unwrap();
    }

    const CFG: &str = r#"{"id":"Yuzu","name":"柚子","author":"某人","version":"v2ProPlus"}"#;

    #[test]
    fn external_pack_fills_missing_local_details_only_when_both_weights_match() {
        let root = crate::testutil::scratch("external-publication-pack");
        std::fs::create_dir_all(&root).unwrap();
        let archive = root.join("local_voice.zip");
        make_pack(&archive, "wrapped/", r#"{"id":"local","name":"Package name","version":"v2"}"#);
        install_zip(&root, &archive).unwrap();

        let installed = role_dir(&root, "local").unwrap();
        let mut cfg = read_cfg(&installed).unwrap();
        cfg["author"] = json!("Local author");
        cfg["weight_validation"] = json!("verified");
        cfg["version"] = json!("v5turbo");
        write_cfg(&installed, &cfg).unwrap();

        let matching = pack_metadata(&root, &archive).unwrap();
        assert_eq!(matching["name"], "Package name");
        assert_eq!(matching["author"], "Local author");
        assert_eq!(matching["version"], "v5turbo");

        std::fs::write(installed.join("models/gpt.ckpt"), b"new").unwrap();
        let other = pack_metadata(&root, &archive).unwrap();
        assert!(other["author"].is_null());
        assert_eq!(other["version"], "v2");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_pack_lands_where_the_synth_page_looks_for_it() {
        let _g = crate::i18n::testing::pin("zh-CN");
        let root = crate::testutil::scratch("role-ok");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("Yuzu_voice.zip");
        make_pack(&zip, "", CFG);

        let v = install_zip(&root, &zip).unwrap();
        assert_eq!(v["id"], json!("yuzu"), "id 要过清洗");
        assert_eq!(v["name"], json!("柚子"));

        // 合成台扫的就是这个目录，落错地方等于没装。
        let dir = crate::synth::characters_dir(&root).join("yuzu");
        assert!(dir.join("config.json").is_file());
        assert!(dir.join("models/sovits.pth").is_file());
        assert!(dir.join("models/gpt.ckpt").is_file());
        assert!(dir.join("dataset/role.list").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Windows 右键「压缩」出来的 zip 多一层同名目录。剥不掉的话
    /// config.json 就在 `<name>/config.json`，整包会被当成缺配置拒收。
    #[test]
    fn a_single_wrapper_directory_is_stripped() {
        let _g = crate::i18n::testing::pin("zh-CN");
        let root = crate::testutil::scratch("role-wrap");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("Yuzu_voice.zip");
        make_pack(&zip, "Yuzu_voice/", CFG);

        let v = install_zip(&root, &zip).unwrap();
        let dir = PathBuf::from(v["dir"].as_str().unwrap());
        assert!(dir.join("config.json").is_file());
        assert!(dir.join("models/gpt.ckpt").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 缺权重的包不许进库。装进去一个跑不了的角色，用户要点到合成才会发现。
    #[test]
    fn a_pack_without_both_weights_is_refused() {
        let _g = crate::i18n::testing::pin("zh-CN");
        let root = crate::testutil::scratch("role-noweight");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("bad_voice.zip");
        {
            let f = std::fs::File::create(&zip).unwrap();
            let mut w = zip::ZipWriter::new(f);
            w.start_file("config.json", opts()).unwrap();
            w.write_all(CFG.as_bytes()).unwrap();
            w.start_file("models/sovits.pth", opts()).unwrap();
            w.write_all(b"only one").unwrap();
            w.finish().unwrap();
        }
        let err = install_zip(&root, &zip).unwrap_err();
        assert!(err.contains("gpt.ckpt"), "错误里要指名缺的是哪份：{err}");
        assert!(
            !crate::synth::characters_dir(&root).join("yuzu").exists(),
            "拒收的包不能留下半个目录"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_slip_is_rejected() {
        assert!(check_entry_path("models/gpt.ckpt").is_ok());
        assert!(check_entry_path("../evil.pth").is_err());
        assert!(check_entry_path("/abs.pth").is_err());
        assert!(check_entry_path(r"..\evil.pth").is_err());
        assert!(check_entry_path("C:/x.pth").is_err());
        assert!(check_entry_path("").is_err());
    }

    /// id 是包里给的，直接拿去拼路径就是任意写。清洗之后不许还剩路径语义。
    #[test]
    fn a_hostile_id_cannot_choose_where_the_pack_lands() {
        for hostile in ["../../evil", "C:\\Windows\\Temp", "..", "/", ""] {
            let s = safe_id(hostile);
            assert!(!s.contains('/') && !s.contains('\\') && !s.contains(':'), "{s}");
            assert!(s != ".." && !s.is_empty(), "{s}");
        }
    }

    /// 解压炸弹：几十 KB 的包解出几百 MB。
    #[test]
    fn a_zip_bomb_is_refused() {
        let root = crate::testutil::scratch("role-bomb");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("bomb.zip");
        {
            let f = std::fs::File::create(&zip).unwrap();
            let mut w = zip::ZipWriter::new(f);
            w.start_file("models/sovits.pth", opts()).unwrap();
            let chunk = vec![0u8; 1024 * 1024];
            for _ in 0..(MAX_ENTRY_BYTES / (1024 * 1024)) + 2 {
                w.write_all(&chunk).unwrap();
            }
            w.finish().unwrap();
        }
        let err = match read_zip(&zip) {
            Err(e) => e,
            Ok(_) => panic!("炸弹包应当被拒收"),
        };
        assert!(err.contains("too large"), "got {err}");
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn export_binds_all_reference_audio_and_preserves_the_original_role() {
        let root = crate::testutil::scratch("role-reference-export");
        std::fs::create_dir_all(&root).unwrap();
        let original = root.join("original.zip");
        make_pack(&original, "wrapped/", CFG);
        install_zip(&root, &original).unwrap();
        let dir = role_dir(&root, "yuzu").unwrap();
        let mut config = read_cfg(&dir).unwrap();
        assert_eq!(config["lists"][0]["file"], "dataset/role.list");

        let primary = dir.join("dataset/role.list");
        let shared_audio = dir.join("dataset/audios/a.wav");
        let linked = dir.join("dataset/second.list");
        let other_audio = dir.join("dataset/other/a.wav");
        std::fs::create_dir_all(other_audio.parent().unwrap()).unwrap();
        std::fs::write(&other_audio, b"another reference").unwrap();
        std::fs::write(dir.join("dataset/audios/unlinked.wav"), b"other recording").unwrap();
        let external_style = format!("\u{feff}{}|Yuzu|JA|one|two\r\n", shared_audio.display());
        std::fs::write(&primary, &external_style).unwrap();
        std::fs::write(&linked, "audios/a.wav|Yuzu|JA|same recording\nother/a.wav|Yuzu|EN|different recording\n").unwrap();
        config["lists"][0]["lang"] = json!("ja");
        config["lists"].as_array_mut().unwrap().push(json!({ "file": "dataset/second.list", "note": "More references" }));
        write_cfg(&dir, &config).unwrap();

        let output = root.join("exported.zip");
        export_zip(&root, "yuzu", &output).unwrap();
        assert_eq!(read_cfg(&dir).unwrap(), config);
        assert_eq!(std::fs::read_to_string(primary).unwrap(), external_style);
        let entries = read_zip(&output).unwrap().files;
        assert!(!entries.contains_key("dataset/audios/unlinked.wav"));
        assert_eq!(entries.keys().filter(|name| name.starts_with("dataset/audios/")).count(), 2);

        let restored = root.join("restored");
        install_zip(&restored, &output).unwrap();
        let roles = crate::synth::list_characters(&restored);
        let lists = roles["roles"][0]["lists"].as_array().unwrap();
        assert_eq!(lists.len(), 2);
        assert_eq!(lists[0]["lang"], "ja");
        assert_eq!(lists[1]["note"], "More references");
        assert_eq!(lists[0]["rows"][0]["text"], "one|two");
        assert_eq!(lists[0]["rows"][0]["wav"], lists[1]["rows"][0]["wav"]);
        for (row, expected) in [
            (&lists[0]["rows"][0], b"reference audio".as_slice()),
            (&lists[1]["rows"][1], b"another reference".as_slice()),
        ] {
            assert_eq!(row["exists"], true);
            assert!(!Path::new(row["wav"].as_str().unwrap()).is_absolute());
            assert_eq!(std::fs::read(row["abs"].as_str().unwrap()).unwrap(), expected);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_reference_does_not_overwrite_an_existing_export() {
        let root = crate::testutil::scratch("missing-export-reference");
        std::fs::create_dir_all(&root).unwrap();
        let original = root.join("original.zip");
        make_pack(&original, "", CFG);
        install_zip(&root, &original).unwrap();
        let output = root.join("exported.zip");
        std::fs::write(&output, b"previous export").unwrap();

        let dir = role_dir(&root, "yuzu").unwrap();
        std::fs::remove_file(dir.join("dataset/audios/a.wav")).unwrap();
        assert_eq!(export_zip(&root, "yuzu", &output).unwrap_err(), crate::i18n::t("s.roleErrListAudio"));
        assert_eq!(std::fs::read(&output).unwrap(), b"previous export");

        let mut config = read_cfg(&dir).unwrap();
        config["lists"] = json!([]);
        write_cfg(&dir, &config).unwrap();
        assert_eq!(export_zip(&root, "yuzu", &output).unwrap_err(), crate::i18n::t("s.roleExportNeedsList"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_role_can_be_renamed_exported_and_deleted() {
        let root = crate::testutil::scratch("roles-manage");
        std::fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("alice_voice.zip");
        make_pack(&zip_path, "", r#"{"id":"alice","name":"Alice"}"#);
        install_zip(&root, &zip_path).unwrap();

        update_meta(&root, "alice", "Alice B", "me").unwrap();
        let cfg = read_cfg(&role_dir(&root, "alice").unwrap()).unwrap();
        assert_eq!(cfg["name"], "Alice B");
        assert_eq!(cfg["author"], "me");

        let out = root.join("out.zip");
        export_zip(&root, "alice", &out).unwrap();
        std::fs::remove_dir_all(role_dir(&root, "alice").unwrap()).unwrap();
        let back = install_zip(&root, &out).unwrap();
        assert_eq!(back["name"], "Alice B");

        delete(&root, "alice").unwrap();
        assert!(role_dir(&root, "alice").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_id_cannot_point_outside_the_characters_dir() {
        let root = crate::testutil::scratch("roles-escape");
        for id in ["..", "../x", "a/b", "C:", ""] {
            assert!(role_dir(&root, id).is_err(), "{id}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn cover_edits_preserve_original_and_change_the_asset_url() {
        let root = crate::testutil::scratch("cover-reset");
        let dir = root.join("User_Data/characters/voice");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"name":"Voice","cover":"original.png"}"#).unwrap();
        std::fs::write(dir.join("original.png"), b"original").unwrap();
        let first = save_cover(&root, "voice", "data:image/png;base64,iVBORw0KGgoAAAAAAAAAAA==").unwrap();
        let second = save_cover(&root, "voice", "data:image/png;base64,iVBORw0KGgoBAAAAAAAAAA==").unwrap();
        assert_ne!(first["cover"], second["cover"]);
        assert!(!dir.join(first["cover"].as_str().unwrap()).exists());
        assert_eq!(read_cfg(&dir).unwrap()["original_cover"], "original.png");
        assert_eq!(reset_cover(&root,"voice").unwrap()["cover"], "original.png");
        assert_eq!(std::fs::read(dir.join("original.png")).unwrap(), b"original");
        assert!(!dir.join(second["cover"].as_str().unwrap()).exists());
        assert_eq!(reset_cover(&root,"voice").unwrap()["cover"], "original.png");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_cover_does_not_change_the_role() {
        let root = crate::testutil::scratch("cover-invalid");
        let dir = root.join("User_Data/characters/voice");
        std::fs::create_dir_all(&dir).unwrap();
        let config = r#"{"name":"Voice","cover":"original.png"}"#;
        std::fs::write(dir.join("config.json"), config).unwrap();
        assert!(save_cover(&root,"voice","data:image/png;base64,bm90IGFuIGltYWdl").is_err());
        assert_eq!(std::fs::read_to_string(dir.join("config.json")).unwrap(), config);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn imported_custom_named_default_cover_survives_edit_and_reset() {
        let root = crate::testutil::scratch("cover-custom-default");
        let dir = root.join("User_Data/characters/voice");
        std::fs::create_dir_all(&dir).unwrap();
        let original = "cover-custom-imported.jpg";
        std::fs::write(dir.join("config.json"), json!({"name":"Voice", "cover":original}).to_string()).unwrap();
        std::fs::write(dir.join(original), b"original").unwrap();
        let edited = save_cover(&root, "voice", "data:image/png;base64,iVBORw0KGgoAAAAAAAAAAA==").unwrap();
        assert_eq!(std::fs::read(dir.join(original)).unwrap(), b"original");
        assert_eq!(reset_cover(&root, "voice").unwrap()["cover"], original);
        assert!(dir.join(original).is_file());
        assert!(!dir.join(edited["cover"].as_str().unwrap()).exists());
        // A package may already store the default as both fields.
        std::fs::write(dir.join("config.json"), json!({"cover":original, "original_cover":original}).to_string()).unwrap();
        reset_cover(&root, "voice").unwrap();
        assert!(dir.join(original).is_file());
        let _ = std::fs::remove_dir_all(root);
    }

}
