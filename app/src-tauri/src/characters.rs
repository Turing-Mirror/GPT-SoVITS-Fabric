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
use std::io::Read;
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
    let z = read_zip(zip_path)?;

    let cfg_bytes = z
        .files
        .get("config.json")
        .ok_or_else(|| crate::i18n::t("s.roleErrNoConfig"))?;
    let cfg: Value = serde_json::from_slice(cfg_bytes)
        .map_err(|e| crate::i18n::te("s.roleErrBadConfig", &e))?;

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

    // id 优先用包里声明的，其次退到文件名。两条都过清洗。
    let declared = str_field(&cfg, "id");
    let fallback = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("role")
        .trim_end_matches("_voice")
        .to_string();
    let id = safe_id(if declared.trim().is_empty() {
        &fallback
    } else {
        &declared
    });

    let dest = paths::user_data(root).join("characters").join(&id);
    // 覆盖安装：先清空，避免上一版留下的多余权重被当成这一版的。
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;

    for (rel, bytes) in &z.files {
        // 落盘前再查一遍：剥包装目录是字符串操作，别让它把校验绕过去。
        check_entry_path(rel)?;
        let out = dest.join(rel);
        // 最后一道：算出来的路径必须仍在角色目录里。
        if !out.starts_with(&dest) {
            return Err(format!("entry escapes the pack dir: {rel}"));
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&out, bytes).map_err(|e| format!("{}: {e}", out.display()))?;
    }

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

/// 把角色目录打成角色包，格式与导入时一致（无包装目录）。
pub fn export_zip(root: &Path, id: &str, dest: &Path) -> Result<Value, String> {
    use std::io::Write;
    let dir = role_dir(root, id)?;
    let file = std::fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    let mut stack = vec![dir.clone()];
    let mut count = 0usize;
    while let Some(d) = stack.pop() {
        let rd = std::fs::read_dir(&d).map_err(|e| e.to_string())?;
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let rel = p
                .strip_prefix(&dir)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            zw.start_file(rel, opts).map_err(|e| e.to_string())?;
            let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
            zw.write_all(&bytes).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    zw.finish().map_err(|e| e.to_string())?;
    Ok(json!({ "path": dest.to_string_lossy(), "files": count }))
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
        w.finish().unwrap();
    }

    const CFG: &str = r#"{"id":"Yuzu","name":"柚子","author":"某人","version":"v2ProPlus"}"#;

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
