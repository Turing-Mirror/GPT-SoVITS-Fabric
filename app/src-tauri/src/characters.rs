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
}
