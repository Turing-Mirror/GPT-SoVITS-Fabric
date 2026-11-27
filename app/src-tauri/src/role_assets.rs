//! Model weights and portable annotation associations for installed roles.
use crate::characters::{read_cfg, role_dir, write_cfg};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

fn relative_file(file: &str) -> bool {
    !file.is_empty()
        && !file.starts_with('/')
        && !file.contains(':')
        && file
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

fn versions(root: &Path, cfg: &Value) -> Vec<String> {
    let table: Value = std::fs::read(root.join("configs/upstream_versions.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let mut out: Vec<String> = table["versions"]
        .as_object()
        .map(|v| v.keys().cloned().collect())
        .unwrap_or_default();
    if let Some(v) = cfg["version"].as_str().filter(|s| !s.is_empty()) {
        if !out.iter().any(|s| s == v) {
            out.push(v.to_owned());
        }
    }
    out
}

pub fn details(root: &Path, id: &str) -> Result<Value, String> {
    let dir = role_dir(root, id)?;
    let cfg = read_cfg(&dir)?;
    let weights: Vec<Value> = [("gpt", "gpt.ckpt"), ("sovits", "sovits.pth")].iter().map(|(kind, name)| {
        let path = dir.join("models").join(name);
        json!({"kind":kind,"path":path,"exists":path.is_file(),"size":std::fs::metadata(&path).map(|m|m.len()).unwrap_or(0)})
    }).collect();
    let lists: Vec<Value> = cfg["lists"].as_array().into_iter().flatten().enumerate().map(|(index, l)| {
        let file = l["file"].as_str().unwrap_or("");
        let normalized = file.replace('\\', "/");
        let safe = relative_file(&normalized);
        let path = dir.join(&normalized);
        let parsed = if safe { crate::annot::load(&path.to_string_lossy()).ok() } else { None };
        json!({"index":index,"file":file,"lang":l["lang"].as_str().unwrap_or(""),"note":l["note"].as_str().unwrap_or(""),
            "path":if safe {path.to_string_lossy().into_owned()} else {String::new()},
            "exists":safe && path.is_file(),"valid":parsed.is_some(),"rows":parsed.as_ref().and_then(|p|p["total"].as_u64()).unwrap_or(0)})
    }).collect();
    Ok(
        json!({"id":id,"version":cfg["version"].as_str().unwrap_or("v2ProPlus"),"versions":versions(root,&cfg),"weights":weights,"weight_info":cfg["weight_info"],"lists":lists}),
    )
}

pub fn weight_extension(kind: &str) -> Result<&'static str, String> {
    match kind {
        "gpt" => Ok("ckpt"),
        "sovits" => Ok("pth"),
        _ => Err(crate::i18n::t("s.roleErrWeightType")),
    }
}
fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case(ext))
        .unwrap_or(false)
}
pub(crate) fn unique() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub(crate) fn inspect_replacement(
    root: &Path,
    kind: &str,
    source: &Path,
    counterpart: Option<&Path>,
    version: Option<&str>,
) -> Result<Value, String> {
    let python = crate::paths::runtime_python(root)
        .ok_or_else(|| crate::i18n::t("s.roleErrWeightRuntime"))?;
    let script = root.join("tools/weight_inspect.py");
    if !script.is_file() {
        return Err(crate::i18n::t("s.roleErrWeightRuntime"));
    }
    let mut command = std::process::Command::new(python);
    command
        .arg(script)
        .arg("--source")
        .arg(source)
        .arg("--kind")
        .arg(kind)
        .current_dir(root)
        .env("PYTHONIOENCODING", "utf-8");
    if let Some(path) = counterpart {
        command.arg("--counterpart").arg(path);
    }
    if let Some(selected) = version.filter(|_| kind == "sovits") {
        command.arg("--version").arg(selected);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|error| crate::diagnostics::failure(fabric_diagnostics::Feature::ImportExport,
            &error.to_string(), fabric_diagnostics::Context { operation: Some(fabric_diagnostics::Operation::ModelLoad), ..Default::default() }))?;
    let fail = |code: &str, raw: &str| {
        let mut e = crate::diagnostics::evidence(fabric_diagnostics::Feature::ImportExport, false);
        e.context.operation = Some(fabric_diagnostics::Operation::ModelLoad);
        e.context.target_disk_path = Some(source.to_string_lossy().into_owned());
        e.exit_code = output.status.code();
        e.source_code = Some(code.into());
        e.text = format!("{raw}\n{}", String::from_utf8_lossy(&output.stderr));
        let mut d = crate::diagnostics::finish(&e);
        d.detail.text.push_str(&format!("\n[worker response]\n{}", String::from_utf8_lossy(&output.stdout)));
        crate::diagnostics::encode(&d)
    };
    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| fail("s.roleErrWeightInvalid", &error.to_string()))?;
    if !output.status.success() || result["ok"] != true {
        let key = match result["error"].as_str() {
            Some("pair") => "s.roleErrWeightPair",
            Some("version_mismatch") => "s.roleErrWeightVersionMismatch",
            Some("runtime") => "s.roleErrWeightRuntime",
            _ => "s.roleErrWeightInvalid",
        };
        return Err(fail(key, result["detail"].as_str().unwrap_or_default()));
    }
    Ok(result)
}

pub fn replace_weight(
    root: &Path,
    id: &str,
    kind: &str,
    src: &Path,
    version: Option<&str>,
) -> Result<Value, String> {
    replace_weight_with(root, id, kind, src, version, inspect_replacement)
}

fn replace_weight_with(
    root: &Path,
    id: &str,
    kind: &str,
    src: &Path,
    version: Option<&str>,
    inspect: impl FnOnce(&Path, &str, &Path, Option<&Path>, Option<&str>) -> Result<Value, String>,
) -> Result<Value, String> {
    replace_weight_and_record_with(root, id, kind, src, version, None, inspect)
}

pub(crate) fn replace_weight_and_record_with(
    root: &Path,
    id: &str,
    kind: &str,
    src: &Path,
    version: Option<&str>,
    selection: Option<&Value>,
    inspect: impl FnOnce(&Path, &str, &Path, Option<&Path>, Option<&str>) -> Result<Value, String>,
) -> Result<Value, String> {
    crate::synth::while_idle(|| {
        let ext = weight_extension(kind)?;
        if !has_extension(src, ext)
            || !src.is_file()
            || std::fs::metadata(src).map_err(|e| e.to_string())?.len() == 0
        {
            return Err(crate::i18n::t("s.roleErrWeightType"));
        }
        let dir = role_dir(root, id)?;
        let mut cfg = read_cfg(&dir)?;
        if !cfg.is_object() {
            return Err(crate::i18n::t("s.roleErrNoConfig"));
        }
        if kind == "sovits" {
            if let Some(selected) = version {
                if !versions(root, &cfg).iter().any(|known| known == selected) {
                    return Err(crate::i18n::t("s.roleErrVersion"));
                }
            }
        }
        let models = dir.join("models");
        std::fs::create_dir_all(&models).map_err(|e| e.to_string())?;
        let dest = models.join(format!("{kind}.{ext}"));
        let tmp = models.join(format!(".weight-{}", unique()));
        let result = (|| {
            std::fs::copy(src, &tmp).map_err(|e| e.to_string())?;
            let other = models.join(if kind == "gpt" {
                "sovits.pth"
            } else {
                "gpt.ckpt"
            });
            // Validate the exact staged bytes before touching either installed file.
            let validation = inspect(
                root,
                kind,
                &tmp,
                other.is_file().then_some(other.as_path()),
                version,
            )?;
            if let Some(detected) = validation["version"].as_str() {
                cfg["version"] = json!(detected);
            }
            cfg["weight_info"] = json!({"gpt":validation["gpt"], "sovits":validation["sovits"]});
            if let Some(selection) = selection {
                let mut selection = selection.clone();
                // Record the staged bytes that were actually validated and installed.
                selection["sha256"] = json!(crate::model_versions::sha256(&tmp)?);
                if !cfg["training"].is_object() { cfg["training"] = json!({}); }
                if !cfg["training"]["selected"].is_object() {
                    cfg["training"]["selected"] = json!({});
                }
                cfg["training"]["selected"][kind] = selection;
            } else if let Some(selected) = cfg["training"]["selected"].as_object_mut() {
                selected.remove(kind);
            }
            // The worker caches by role ID, including when filenames remain unchanged.
            crate::synth::shutdown();
            let backup = models.join(format!(".weight-previous-{}", unique()));
            let had_previous = dest.exists();
            if had_previous {
                std::fs::rename(&dest, &backup).map_err(|e| e.to_string())?;
            }
            let install = (|| {
                std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
                write_cfg(&dir, &cfg)?;
                Ok::<(), String>(())
            })();
            if let Err(err) = install {
                if dest.exists() {
                    let _ = std::fs::remove_file(&dest);
                }
                if had_previous {
                    std::fs::rename(&backup, &dest)
                        .map_err(|restore| format!("{err}; {}: {restore}", backup.display()))?;
                }
                return Err(err);
            }
            if had_previous {
                let _ = std::fs::remove_file(backup);
            }
            details(root, id)
        })();
        let _ = std::fs::remove_file(tmp);
        result
    })
}

pub fn associate(root: &Path, id: &str, src: &Path) -> Result<Value, String> {
    crate::synth::while_idle(|| {
        if !has_extension(src, "list") {
            return Err(crate::i18n::t("s.roleErrListInvalid"));
        }
        let dir = role_dir(root, id)?;
        let mut cfg = read_cfg(&dir)?;
        if !cfg.is_object() {
            return Err(crate::i18n::t("s.roleErrNoConfig"));
        }
        let parsed = crate::annot::load(&src.to_string_lossy())?;
        let rows: Vec<crate::annot::Row> =
            serde_json::from_value(parsed["rows"].clone()).map_err(|e| e.to_string())?;
        if rows.is_empty() || rows.iter().any(|row| !row.is_complete()) {
            return Err(crate::i18n::t("s.roleErrListInvalid"));
        }
        if rows.iter().any(|r| !r.exists) {
            return Err(crate::i18n::t("s.roleErrListAudio"));
        }
        let name = format!("linked-{}", unique());
        let dataset = dir.join("dataset");
        std::fs::create_dir_all(&dataset).map_err(|e| e.to_string())?;
        let stage = dataset.join(format!(".{name}"));
        let dest = dataset.join(&name);
        let result = (|| {
            std::fs::create_dir_all(stage.join("audios")).map_err(|e| e.to_string())?;
            let mut copied: HashMap<PathBuf, String> = HashMap::new();
            let mut body = String::new();
            for row in rows {
                let source = std::fs::canonicalize(&row.abs).map_err(|e| e.to_string())?;
                let rel = if let Some(rel) = copied.get(&source) {
                    rel.clone()
                } else {
                    let filename = source.file_name().unwrap().to_string_lossy();
                    let rel = format!("audios/{}-{filename}", copied.len());
                    std::fs::copy(&source, stage.join(&rel)).map_err(|e| e.to_string())?;
                    copied.insert(source, rel.clone());
                    rel
                };
                body.push_str(&format!(
                    "{}|{}|{}|{}\n",
                    rel, row.speaker, row.lang, row.text
                ));
            }
            std::fs::write(stage.join("annotations.list"), body).map_err(|e| e.to_string())?;
            std::fs::rename(&stage, &dest).map_err(|e| e.to_string())?;
            if !cfg["lists"].is_array() {
                cfg["lists"] = json!([]);
            }
            cfg["lists"].as_array_mut().unwrap().push(json!({"file":format!("dataset/{name}/annotations.list"),"lang":"","note":src.file_name().unwrap_or_default().to_string_lossy()}));
            write_cfg(&dir, &cfg)?;
            details(root, id)
        })();
        let _ = std::fs::remove_dir_all(&stage);
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&dest);
        }
        result
    })
}

/// 参考音频接受的格式。原版 GPT-SoVITS 的参考音频多是 wav，其余格式合成时同样能读。
pub const REFERENCE_AUDIO: &[&str] = &["wav", "mp3", "flac", "ogg", "m4a"];

/// 「模型」页 → 导入模型：用一份 GPT 权重、一份 SoVITS 权重和一条参考建成新角色。
///
/// 面向直接用原版 GPT-SoVITS 训练的用户：他们手里是 `GPT_weights/*.ckpt`、
/// `SoVITS_weights/*.pth` 和一段参考音频，而不是角色包。参考可以是一段音频
/// （同时给出它说的内容和语种），也可以是现成的 .list 标注。
pub fn import_weights(
    root: &Path,
    name: &str,
    gpt: &Path,
    sovits: &Path,
    reference: &Path,
    text: &str,
    lang: &str,
) -> Result<Value, String> {
    import_weights_with(root, name, gpt, sovits, reference, text, lang, inspect_replacement)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn import_weights_with(
    root: &Path,
    name: &str,
    gpt: &Path,
    sovits: &Path,
    reference: &Path,
    text: &str,
    lang: &str,
    inspect: impl FnOnce(&Path, &str, &Path, Option<&Path>, Option<&str>) -> Result<Value, String>,
) -> Result<Value, String> {
    for (kind, path) in [("gpt", gpt), ("sovits", sovits)] {
        let ext = weight_extension(kind)?;
        if !has_extension(path, ext)
            || !path.is_file()
            || std::fs::metadata(path).map_err(|e| e.to_string())?.len() == 0
        {
            return Err(crate::i18n::t("s.roleErrWeightType"));
        }
    }
    let is_list = has_extension(reference, "list");
    let is_audio = REFERENCE_AUDIO.iter().any(|ext| has_extension(reference, ext));
    if !reference.is_file() || !(is_list || is_audio) {
        return Err(crate::i18n::t("s.roleImportErrReference"));
    }
    // .list 一行用 | 分隔，换行分行：参考文本里的这两种字符换成空格。
    let text = text.replace(['|', '\r', '\n'], " ");
    let text = text.trim();
    if is_audio && (text.is_empty() || lang.trim().is_empty()) {
        return Err(crate::i18n::t("s.roleImportErrReferenceText"));
    }
    let stem = |p: &Path| p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let name = match name.trim() {
        "" => stem(gpt),
        given => given.to_owned(),
    };
    // 两份权重必须是同一套：校验和版本识别都在装进去之前做完。
    let detected = inspect(root, "sovits", sovits, Some(gpt), None)?;

    let base = crate::paths::user_data(root).join("characters");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let safe = crate::characters::safe_id(&name);
    let id = (1..)
        .map(|n| if n == 1 { safe.clone() } else { format!("{safe}-{n}") })
        .find(|id| !base.join(id).exists())
        .unwrap_or_default();
    let stage = base.join(format!(".import-{}", unique()));
    let dest = base.join(&id);
    let built = (|| {
        let models = stage.join("models");
        std::fs::create_dir_all(&models).map_err(|e| e.to_string())?;
        std::fs::copy(gpt, models.join("gpt.ckpt")).map_err(|e| e.to_string())?;
        std::fs::copy(sovits, models.join("sovits.pth")).map_err(|e| e.to_string())?;
        let cfg = json!({
            "id": id,
            "name": name,
            "author": "",
            "source": "imported",
            "version": detected["version"],
            "weight_info": {"gpt": detected["gpt"], "sovits": detected["sovits"]},
            "weight_validation": "verified",
            "lists": [],
        });
        write_cfg(&stage, &cfg)?;
        std::fs::rename(&stage, &dest).map_err(|e| e.to_string())
    })();
    if let Err(e) = built {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(e);
    }

    // 一段音频先写成一行 .list，再走与「关联 .list」相同的复制和校验。
    let scratch = base.join(format!(".reference-{}", unique()));
    let list = if is_audio {
        let file = scratch.join(format!("{}.list", stem(reference)));
        let line = format!("{}|{}|{}|{}\n", reference.to_string_lossy(), name, lang.trim(), text);
        std::fs::create_dir_all(&scratch)
            .and_then(|_| std::fs::write(&file, line))
            .map_err(|e| e.to_string())
            .map(|_| file)
    } else {
        Ok(reference.to_path_buf())
    };
    let linked = list.and_then(|list| associate(root, &id, &list));
    let _ = std::fs::remove_dir_all(&scratch);
    if let Err(e) = linked {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(e);
    }
    Ok(json!({"id": id, "name": name, "version": detected["version"]}))
}

pub fn unlink(
    root: &Path,
    id: &str,
    index: usize,
    expected_file: Option<&str>,
) -> Result<Value, String> {
    crate::synth::while_idle(|| {
        let dir = role_dir(root, id)?;
        let mut cfg = read_cfg(&dir)?;
        let lists = cfg["lists"]
            .as_array_mut()
            .ok_or_else(|| crate::i18n::t("s.roleErrListInvalid"))?;
        if index >= lists.len() {
            return Err(crate::i18n::t("s.roleErrListInvalid"));
        }
        if let Some(expected) = expected_file {
            if lists[index]["file"].as_str().unwrap_or("") != expected {
                return Err(crate::i18n::t("s.roleErrListInvalid"));
            }
        }
        lists.remove(index);
        write_cfg(&dir, &cfg)?;
        details(root, id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn detected(_: &Path, _: &str, _: &Path, _: Option<&Path>, _: Option<&str>) -> Result<Value, String> {
        Ok(json!({"version":"v2ProPlus","gpt":{"kind":"gpt"},"sovits":{"kind":"sovits"}}))
    }
    #[test]
    fn original_gui_weights_and_one_reference_clip_become_a_role() {
        let root = crate::testutil::scratch("role-import-weights");
        let src = root.join("from-gui");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("alice-e15.ckpt"), b"gpt").unwrap();
        std::fs::write(src.join("alice_e8_s200.pth"), b"sovits").unwrap();
        std::fs::write(src.join("ref.wav"), b"audio").unwrap();
        let made = import_weights_with(&root, "", &src.join("alice-e15.ckpt"), &src.join("alice_e8_s200.pth"),
            &src.join("ref.wav"), "Hello|there
", " en ", detected).unwrap();
        assert_eq!(made["id"], "alice-e15");
        assert_eq!(made["name"], "alice-e15");
        let dir = root.join("User_Data/characters/alice-e15");
        assert_eq!(std::fs::read(dir.join("models/gpt.ckpt")).unwrap(), b"gpt");
        assert_eq!(std::fs::read(dir.join("models/sovits.pth")).unwrap(), b"sovits");
        let cfg = read_cfg(&dir).unwrap();
        assert_eq!(cfg["version"], "v2ProPlus");
        assert_eq!(cfg["source"], "imported");
        let detail = details(&root, "alice-e15").unwrap();
        let list = crate::annot::load(detail["lists"][0]["path"].as_str().unwrap()).unwrap();
        assert_eq!(list["rows"][0]["text"], "Hello there");
        assert_eq!(list["rows"][0]["lang"], "en");
        assert_eq!(list["rows"][0]["exists"], true);
        // The same name again gets its own folder instead of replacing the first role.
        let again = import_weights_with(&root, "alice-e15", &src.join("alice-e15.ckpt"), &src.join("alice_e8_s200.pth"),
            &src.join("ref.wav"), "Hi", "en", detected).unwrap();
        assert_eq!(again["id"], "alice-e15-2");
        // No leftovers from staging.
        let names: Vec<String> = std::fs::read_dir(root.join("User_Data/characters")).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.starts_with('.')), "{names:?}");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn import_rejects_missing_reference_text_and_leaves_nothing_behind() {
        let root = crate::testutil::scratch("role-import-reject");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.ckpt"), b"gpt").unwrap();
        std::fs::write(root.join("a.pth"), b"sovits").unwrap();
        std::fs::write(root.join("ref.wav"), b"audio").unwrap();
        std::fs::write(root.join("broken.list"), "absent.wav|s|en|hi
").unwrap();
        assert!(import_weights_with(&root, "a", &root.join("a.ckpt"), &root.join("a.pth"), &root.join("ref.wav"), " ", "en", detected).is_err());
        assert!(import_weights_with(&root, "a", &root.join("a.pth"), &root.join("a.ckpt"), &root.join("ref.wav"), "hi", "en", detected).is_err());
        // A .list whose audio is missing fails after the role folder was built; it must be removed again.
        assert!(import_weights_with(&root, "a", &root.join("a.ckpt"), &root.join("a.pth"), &root.join("broken.list"), "", "", detected).is_err());
        let left = std::fs::read_dir(root.join("User_Data/characters")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(left, 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    fn fixture(label: &str) -> (PathBuf, PathBuf) {
        let root = crate::testutil::scratch(label);
        let dir = root.join("User_Data/characters/voice");
        std::fs::create_dir_all(dir.join("models")).unwrap();
        std::fs::write(dir.join("models/gpt.ckpt"), b"old gpt").unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"name":"Voice","version":"v2","custom":42,"lists":[]}"#,
        )
        .unwrap();
        (root, dir)
    }
    #[test]
    fn association_is_portable_and_unlink_keeps_audio() {
        let (root, dir) = fixture("role-link");
        let source = root.join("source");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested/a.wav"), b"audio").unwrap();
        let original = "nested/a.wav|speaker|ZH|first|second\n";
        std::fs::write(source.join("sample.list"), original).unwrap();
        let detail = associate(&root, "voice", &source.join("sample.list")).unwrap();
        let list = PathBuf::from(detail["lists"][0]["path"].as_str().unwrap());
        assert!(list.starts_with(&dir));
        let loaded = crate::annot::load(&list.to_string_lossy()).unwrap();
        assert_eq!(loaded["rows"][0]["exists"], true);
        assert_eq!(loaded["rows"][0]["text"], "first|second");
        assert!(!Path::new(loaded["rows"][0]["wav"].as_str().unwrap()).is_absolute());
        assert_eq!(
            std::fs::read_to_string(source.join("sample.list")).unwrap(),
            original
        );
        let audio = PathBuf::from(loaded["rows"][0]["abs"].as_str().unwrap());
        std::fs::remove_dir_all(source).unwrap();
        assert_eq!(
            crate::annot::load(&list.to_string_lossy()).unwrap()["missing"],
            0
        );
        std::fs::write(dir.join("models/sovits.pth"), b"sovits").unwrap();
        let zip = root.join("voice_voice.zip");
        crate::characters::export_zip(&root, "voice", &zip).unwrap();
        let restored = root.join("restored");
        crate::characters::install_zip(&restored, &zip).unwrap();
        let exported = details(&restored, "voice").unwrap();
        let exported_list = exported["lists"][0]["path"].as_str().unwrap();
        assert_eq!(crate::annot::load(exported_list).unwrap()["missing"], 0);
        unlink(&root, "voice", 0, None).unwrap();
        assert!(list.is_file() && audio.is_file());
        assert_eq!(read_cfg(&dir).unwrap()["custom"], 42);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_audio_does_not_change_associations() {
        let (root, dir) = fixture("role-missing");
        let src = root.join("broken.list");
        std::fs::write(&src, "absent.wav|speaker|en|hello\n").unwrap();
        assert!(associate(&root, "voice", &src).is_err());
        assert_eq!(read_cfg(&dir).unwrap()["lists"], json!([]));
        assert!(!dir.join("dataset").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_and_invalid_lists_remain_unlinkable() {
        let (root, dir) = fixture("role-invalid");
        let mut cfg = read_cfg(&dir).unwrap();
        cfg["lists"] = json!([{"file":"dataset/missing.list"},{"file":"../outside.list"},{}]);
        write_cfg(&dir, &cfg).unwrap();
        let detail = details(&root, "voice").unwrap();
        assert_eq!(detail["lists"].as_array().unwrap().len(), 3);
        assert_eq!(detail["lists"][1]["path"], "");
        assert_eq!(detail["weights"][0]["exists"], true);
        assert_eq!(detail["weights"][1]["exists"], false);
        unlink(&root, "voice", 1, None).unwrap();
        assert_eq!(
            read_cfg(&dir).unwrap()["lists"].as_array().unwrap().len(),
            2
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn duplicate_audio_is_copied_once_and_stale_unlink_is_rejected() {
        let (root, dir) = fixture("role-duplicates");
        std::fs::write(root.join("a.wav"), b"audio").unwrap();
        let src = root.join("voice.list");
        std::fs::write(&src, "a.wav|speaker|en|one\na.wav|speaker|en|two\n").unwrap();
        let detail = associate(&root, "voice", &src).unwrap();
        let list = PathBuf::from(detail["lists"][0]["path"].as_str().unwrap());
        assert_eq!(
            std::fs::read_dir(list.parent().unwrap().join("audios"))
                .unwrap()
                .count(),
            1
        );
        assert_eq!(detail["lists"][0]["rows"], 2);
        assert!(unlink(&root, "voice", 0, Some("old.list")).is_err());
        assert_eq!(
            read_cfg(&dir).unwrap()["lists"].as_array().unwrap().len(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn weight_replacement_preserves_source_and_rejects_wrong_type() {
        let (root, dir) = fixture("role-weight");
        let src = root.join("replacement.ckpt");
        std::fs::write(&src, b"new gpt").unwrap();
        replace_weight_with(
            &root,
            "voice",
            "gpt",
            &src,
            None,
            |_, kind, staged, other, _| {
                assert_eq!(kind, "gpt");
                assert!(other.is_none());
                assert_eq!(std::fs::read(staged).unwrap(), b"new gpt");
                Ok(json!({"gpt":{"symbol_version":"v2"}}))
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read(dir.join("models/gpt.ckpt")).unwrap(),
            b"new gpt"
        );
        assert_eq!(std::fs::read(&src).unwrap(), b"new gpt");
        assert!(replace_weight(&root, "voice", "sovits", &src, None).is_err());
        assert_eq!(read_cfg(&dir).unwrap()["version"], "v2");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_checkpoint_preserves_weights_and_config() {
        let (root, dir) = fixture("role-invalid-weight");
        let src = root.join("replacement.ckpt");
        std::fs::write(&src, b"not a checkpoint").unwrap();
        let config = std::fs::read(dir.join("config.json")).unwrap();
        let result = replace_weight_with(&root, "voice", "gpt", &src, None, |_, _, _, _, _| {
            Err("invalid checkpoint".into())
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(dir.join("models/gpt.ckpt")).unwrap(),
            b"old gpt"
        );
        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), config);
        assert_eq!(std::fs::read_dir(dir.join("models")).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_runtime_leaves_existing_weights_untouched() {
        let (root, dir) = fixture("role-weight-no-runtime");
        let src = root.join("replacement.ckpt");
        std::fs::write(&src, b"new gpt").unwrap();
        assert!(replace_weight(&root, "voice", "gpt", &src, None).is_err());
        assert_eq!(
            std::fs::read(dir.join("models/gpt.ckpt")).unwrap(),
            b"old gpt"
        );
        assert_eq!(std::fs::read_dir(dir.join("models")).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detected_version_is_saved_and_returned() {
        let (root, dir) = fixture("role-detected-weight");
        let src = root.join("replacement.pth");
        std::fs::write(&src, b"new sovits").unwrap();
        let detail = replace_weight_with(&root, "voice", "sovits", &src, None, |_, _, _, other, _| {
            assert_eq!(other.unwrap().file_name().unwrap(), "gpt.ckpt");
            Ok(json!({"version":"v5dev", "sovits":{"version":"v5dev"}, "gpt":{"symbol_version":"v2"}}))
        }).unwrap();
        assert_eq!(detail["version"], "v5dev");
        assert_eq!(read_cfg(&dir).unwrap()["version"], "v5dev");
        assert_eq!(read_cfg(&dir).unwrap()["custom"], 42);
        assert_eq!(detail["weight_info"]["sovits"]["version"], "v5dev");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_write_failure_restores_previous_weight() {
        let (root, dir) = fixture("role-weight-rollback");
        let src = root.join("replacement.ckpt");
        std::fs::write(&src, b"new gpt").unwrap();
        let result = replace_weight_with(&root, "voice", "gpt", &src, None, |_, _, _, _, _| {
            std::fs::remove_file(dir.join("config.json")).unwrap();
            std::fs::create_dir(dir.join("config.json")).unwrap();
            Ok(json!({"gpt":{"symbol_version":"v2"}}))
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(dir.join("models/gpt.ckpt")).unwrap(),
            b"old gpt"
        );
        assert_eq!(std::fs::read_dir(dir.join("models")).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
