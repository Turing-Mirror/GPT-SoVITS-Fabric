//! Inference snapshots belonging to an installed character's exact experiment.
use crate::characters::{read_cfg, role_dir};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

#[derive(Debug, Serialize)]
pub struct ModelVersions {
    experiment: Option<String>,
    weights_dir: Option<PathBuf>,
    weights: Vec<WeightVersions>,
}
#[derive(Debug, Serialize)]
struct WeightVersions {
    kind: String,
    current: Current,
    versions: Vec<Version>,
}
#[derive(Debug, Serialize)]
struct Current {
    state: &'static str,
    file: Option<String>,
    epoch: Option<u64>,
    step: Option<u64>,
}
#[derive(Debug, Serialize)]
struct Version {
    file: String,
    epoch: Option<u64>,
    step: Option<u64>,
    is_final: bool,
    current: bool,
}

struct FileHash {
    size: u64,
    modified: SystemTime,
    sha256: String,
}
static HASHES: OnceLock<Mutex<HashMap<PathBuf, FileHash>>> = OnceLock::new();

/// Retain only the latest (path, size, modification time) entry for each file.
pub(crate) fn sha256(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta.modified().map_err(|e| e.to_string())?;
    let cache = HASHES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(path) {
        if hit.size == meta.len() && hit.modified == modified {
            return Ok(hit.sha256.clone());
        }
    }
    let mut file = std::io::BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
    let mut digest = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    let hash = hex::encode(digest.finalize());
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(
        path.into(),
        FileHash {
            size: meta.len(),
            modified,
            sha256: hash.clone(),
        },
    );
    Ok(hash)
}

fn pattern(exp: &str, kind: &str) -> Result<Regex, String> {
    let exp = regex::escape(exp);
    let source = match kind {
        "sovits" => format!(r"\A{exp}_e([0-9]+)_s([0-9]+)(?:_l[0-9]+)?\.pth\z"),
        "gpt" => format!(r"\A{exp}-e([0-9]+)\.ckpt\z"),
        _ => return Err(crate::i18n::t("s.roleErrWeightType")),
    };
    Regex::new(&source).map_err(|e| e.to_string())
}

pub(crate) fn parse_filename(exp: &str, kind: &str, file: &str) -> Option<(u64, Option<u64>)> {
    parse_with(&pattern(exp, kind).ok()?, file)
}

fn parse_with(pattern: &Regex, file: &str) -> Option<(u64, Option<u64>)> {
    let parts = pattern.captures(file)?;
    Some((
        parts[1].parse().ok()?,
        parts.get(2).map(|v| v.as_str().parse()).transpose().ok()?,
    ))
}

/// Old collect() stored the original experiment in `name` with source=trained.
fn experiment(cfg: &Value, fallback: &str) -> String {
    [
        cfg["training"]["experiment"].as_str(),
        cfg["experiment"].as_str(),
        cfg["exp_name"].as_str(),
        cfg["exp"].as_str(),
        cfg["training_experiment"].as_str(),
        (cfg["source"] == "trained")
            .then(|| cfg["name"].as_str())
            .flatten(),
    ]
    .into_iter()
    .flatten()
    .find(|s| !s.is_empty())
    .unwrap_or(fallback)
    .to_owned()
}

fn source_dir(root: &Path, cfg: &Value, exp: &str) -> PathBuf {
    cfg["training"]["weights_dir"]
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| crate::train::weights_dir(root, exp))
}

fn installed(root: &Path, target: &str) -> Result<(PathBuf, Value, String, PathBuf), String> {
    let dir = role_dir(root, target)?;
    // A character ID cannot resolve through a directory link outside the library.
    let base = crate::synth::characters_dir(root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    if dir.parent() != Some(base.as_path()) {
        return Err(crate::i18n::t("s.roleErrNotFound"));
    }
    let cfg = read_cfg(&dir)?;
    if !cfg.is_object() {
        return Err(crate::i18n::t("s.roleErrNoConfig"));
    }
    let exp = experiment(&cfg, target);
    crate::train::validate_name(&exp)?;
    let weights = source_dir(root, &cfg, &exp);
    Ok((dir, cfg, exp, weights))
}

fn candidates(dir: &Path, exp: &str, kind: &str, cfg: &Value) -> Result<Vec<Version>, String> {
    let pattern = pattern(exp, kind)?;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let Some(file) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if let Some((epoch, step)) = parse_with(&pattern, &file) {
            out.push(Version {
                is_final: cfg["training"]["final"][kind]["file"].as_str() == Some(file.as_str()),
                file,
                epoch: Some(epoch),
                step,
                current: false,
            });
        }
    }
    out.sort_by(|a, b| (a.epoch, a.step, &a.file).cmp(&(b.epoch, b.step, &b.file)));
    Ok(out)
}

fn current(
    installed: &Path,
    dir: &Path,
    versions: &mut [Version],
    selected: &Value,
) -> Result<Current, String> {
    let state = |state| Current {
        state,
        file: None,
        epoch: None,
        step: None,
    };
    if !installed.is_file() {
        return Ok(state("missing"));
    }
    let size = std::fs::metadata(installed)
        .map_err(|e| e.to_string())?
        .len();
    let mut hash = None;
    // Prefer the recorded selection when more than one epoch has identical bytes.
    let mut order: Vec<_> = (0..versions.len()).collect();
    order.sort_by_key(|&i| selected["file"].as_str() != Some(versions[i].file.as_str()));
    for i in order {
        let candidate = dir.join(&versions[i].file);
        if std::fs::metadata(&candidate)
            .map_err(|e| e.to_string())?
            .len()
            != size
        {
            continue;
        }
        if hash.is_none() {
            hash = Some(sha256(installed)?);
        }
        if hash.as_deref() == Some(sha256(&candidate)?.as_str()) {
            versions[i].current = true;
            return Ok(Current {
                state: "matched",
                file: Some(versions[i].file.clone()),
                epoch: versions[i].epoch,
                step: versions[i].step,
            });
        }
    }
    if let Some(file) = selected["file"].as_str() {
        if !dir.join(file).is_file() {
            return Ok(Current {
                state: "source_removed",
                file: Some(file.into()),
                epoch: selected["epoch"].as_u64(),
                step: selected["step"].as_u64(),
            });
        }
    }
    Ok(state("external"))
}

pub fn list(root: &Path, target: &str) -> Result<ModelVersions, String> {
    let (dir, cfg, exp, weights_dir) = installed(root, target)?;
    let mut weights = Vec::new();
    // Both worker stages explicitly set save_weight_dir/half_weights_save_dir to
    // the same request output_dir (or experiment/weights).
    for (kind, file) in [("sovits", "sovits.pth"), ("gpt", "gpt.ckpt")] {
        let mut versions = candidates(&weights_dir, &exp, kind, &cfg)?;
        let current = current(
            &dir.join("models").join(file),
            &weights_dir,
            &mut versions,
            &cfg["training"]["selected"][kind],
        )?;
        weights.push(WeightVersions {
            kind: kind.into(),
            current,
            versions,
        });
    }
    Ok(ModelVersions {
        experiment: Some(exp),
        weights_dir: Some(weights_dir),
        weights,
    })
}

pub fn apply(root: &Path, target: &str, kind: &str, file: &str) -> Result<ModelVersions, String> {
    apply_with(
        root,
        target,
        kind,
        file,
        crate::role_assets::inspect_replacement,
    )
}

fn apply_with(
    root: &Path,
    target: &str,
    kind: &str,
    file: &str,
    inspect: impl FnOnce(&Path, &str, &Path, Option<&Path>, Option<&str>) -> Result<Value, String>,
) -> Result<ModelVersions, String> {
    let (_, cfg, exp, weights) = installed(root, target)?;
    let version = candidates(&weights, &exp, kind, &cfg)?
        .into_iter()
        .find(|v| v.file == file)
        .ok_or_else(|| crate::i18n::t("s.roleErrWeightInvalid"))?;
    let record = json!({"file": version.file, "epoch": version.epoch, "step": version.step});
    crate::role_assets::replace_weight_and_record_with(
        root,
        target,
        kind,
        &weights.join(file),
        None,
        Some(&record),
        inspect,
    )?;
    list(root, target)
}

/// Cleanup shares exactly the same parser and includes remembered custom folders.
pub(crate) fn snapshot_files(root: &Path, exp: &str) -> Vec<PathBuf> {
    let mut dirs = HashSet::from([
        crate::train::weights_dir(root, exp),
        crate::train::exp_root(root).join(exp).join("weights"),
    ]);
    if let Ok(entries) = std::fs::read_dir(crate::synth::characters_dir(root)) {
        for entry in entries.flatten() {
            let Ok(cfg) = read_cfg(&entry.path()) else {
                continue;
            };
            if experiment(&cfg, &entry.file_name().to_string_lossy()) == exp {
                dirs.insert(source_dir(root, &cfg, exp));
            }
        }
    }
    let mut files = Vec::new();
    for dir in dirs {
        for kind in ["sovits", "gpt"] {
            if let Ok(versions) = candidates(&dir, exp, kind, &Value::Null) {
                files.extend(versions.into_iter().map(|v| dir.join(v.file)));
            }
        }
    }
    files.sort();
    files.dedup();
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::characters::write_cfg;

    fn fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = crate::testutil::scratch(label);
        let dir = root.join("User_Data/characters/voice");
        let weights = crate::train::weights_dir(&root, "Voice.[a]+(1)");
        std::fs::create_dir_all(dir.join("models")).unwrap();
        std::fs::create_dir_all(&weights).unwrap();
        std::fs::write(dir.join("models/sovits.pth"), b"final sovits").unwrap();
        std::fs::write(dir.join("models/gpt.ckpt"), b"final gpt").unwrap();
        for (name, bytes) in [
            ("Voice.[a]+(1)_e2_s20.pth", b"early sovits".as_slice()),
            ("Voice.[a]+(1)_e5_s50_l32.pth", b"final sovits"),
            ("Voice.[a]+(1)-e2.ckpt", b"early gpt"),
            ("Voice.[a]+(1)-e5.ckpt", b"final gpt"),
            ("Voice.[a]+(1)other_e2_s20.pth", b"wrong experiment"),
            ("G_100.pth", b"training checkpoint"),
            ("epoch=5.ckpt", b"lightning checkpoint"),
        ] {
            std::fs::write(weights.join(name), bytes).unwrap();
        }
        write_cfg(
            &dir,
            &json!({"name":"Display name", "author":"Author", "custom":42,
            "version":"v2", "training":{"experiment":"Voice.[a]+(1)", "weights_dir":weights,
                "final":{"sovits":{"file":"Voice.[a]+(1)_e5_s50_l32.pth", "epoch":5, "step":50},
                    "gpt":{"file":"Voice.[a]+(1)-e5.ckpt", "epoch":5, "step":null}}}}),
        )
        .unwrap();
        (root, dir, weights)
    }

    fn inspect_ok(
        _: &Path,
        _: &str,
        stage: &Path,
        other: Option<&Path>,
        _: Option<&str>,
    ) -> Result<Value, String> {
        assert!(stage.is_file());
        assert!(other.unwrap().is_file());
        Ok(json!({"version":"v2", "gpt":{"symbol_version":"v2"}, "sovits":{"version":"v2"}}))
    }

    #[test]
    fn filenames_are_anchored_to_the_escaped_experiment() {
        let exp = "Voice.[a]+(1)";
        assert_eq!(
            parse_filename(exp, "sovits", &format!("{exp}_e12_s345.pth")),
            Some((12, Some(345)))
        );
        assert_eq!(
            parse_filename(exp, "sovits", &format!("{exp}_e12_s345_l64.pth")),
            Some((12, Some(345)))
        );
        assert_eq!(
            parse_filename(exp, "gpt", &format!("{exp}-e12.ckpt")),
            Some((12, None))
        );
        for file in [
            format!("{exp}other_e12_s345.pth"),
            format!("other{exp}_e12_s345.pth"),
            format!("{exp}_e12_s345.pth.bak"),
            format!("{exp}_e12_s345.pth\n"),
            "VoiceXa1_e12_s345.pth".into(),
            "G_100.pth".into(),
            "D_100.pth".into(),
        ] {
            assert_eq!(parse_filename(exp, "sovits", &file), None, "{file}");
        }
        assert_eq!(
            parse_filename(exp, "gpt", &format!("{exp}other-e12.ckpt")),
            None
        );
    }

    #[test]
    fn list_hashes_the_installed_files_and_reports_all_four_states() {
        let (root, dir, weights) = fixture("versions-states");
        let matched = list(&root, "voice").unwrap();
        assert_eq!(matched.weights[0].current.state, "matched");
        assert_eq!(matched.weights[0].current.epoch, Some(5));
        assert_eq!(matched.weights[0].versions.len(), 2);
        assert_eq!(matched.weights[0].versions[0].epoch, Some(2));
        assert!(matched.weights[0].versions[1].is_final);
        assert!(matched.weights[0].versions[1].current);
        assert_eq!(matched.weights[1].current.state, "matched");

        let mut cfg = read_cfg(&dir).unwrap();
        cfg["training"]["selected"] =
            json!({"sovits":{"file":"Voice.[a]+(1)_e5_s50_l32.pth","epoch":5,"step":50}});
        write_cfg(&dir, &cfg).unwrap();
        std::fs::remove_file(weights.join("Voice.[a]+(1)_e5_s50_l32.pth")).unwrap();
        let removed = list(&root, "voice").unwrap();
        assert_eq!(removed.weights[0].current.state, "source_removed");
        assert_eq!(removed.weights[0].current.epoch, Some(5));

        cfg["training"].as_object_mut().unwrap().remove("selected");
        write_cfg(&dir, &cfg).unwrap();
        // Same length as the original final file: size alone must not match it.
        std::fs::write(dir.join("models/sovits.pth"), b"other sovits").unwrap();
        assert_eq!(
            list(&root, "voice").unwrap().weights[0].current.state,
            "external"
        );
        std::fs::remove_file(dir.join("models/sovits.pth")).unwrap();
        assert_eq!(
            list(&root, "voice").unwrap().weights[0].current.state,
            "missing"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_reenumerates_and_rejects_paths_and_non_candidates() {
        let (root, dir, weights) = fixture("versions-reject");
        let before = std::fs::read(dir.join("models/gpt.ckpt")).unwrap();
        for target in ["../voice", "", "voice/models", "C:\\outside", "unknown"] {
            assert!(list(&root, target).is_err());
            assert!(apply_with(&root, target, "gpt", "Voice.[a]+(1)-e2.ckpt", inspect_ok).is_err());
        }
        for file in [
            "../Voice.[a]+(1)-e2.ckpt",
            "epoch=5.ckpt",
            "G_100.pth",
            "Voice.[a]+(1)other-e2.ckpt",
        ] {
            assert!(apply_with(&root, "voice", "gpt", file, inspect_ok).is_err());
        }
        std::fs::remove_file(weights.join("Voice.[a]+(1)-e2.ckpt")).unwrap();
        assert!(apply_with(&root, "voice", "gpt", "Voice.[a]+(1)-e2.ckpt", inspect_ok).is_err());
        assert!(apply_with(&root, "voice", "rvc", "anything.pth", inspect_ok).is_err());
        assert_eq!(std::fs::read(dir.join("models/gpt.ckpt")).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_records_the_validated_bytes_and_external_replacement_clears_only_its_kind() {
        let (root, dir, weights) = fixture("versions-apply");
        println!(
            "MODEL_VERSIONS_LIST_JSON={}",
            serde_json::to_string(&list(&root, "voice").unwrap()).unwrap()
        );
        let result =
            apply_with(&root, "voice", "gpt", "Voice.[a]+(1)-e2.ckpt", inspect_ok).unwrap();
        println!(
            "MODEL_VERSIONS_APPLY_JSON={}",
            serde_json::to_string(&result).unwrap()
        );
        assert_eq!(result.weights[1].current.epoch, Some(2));
        let mut cfg = read_cfg(&dir).unwrap();
        let selected = &cfg["training"]["selected"]["gpt"];
        assert_eq!(selected["file"], "Voice.[a]+(1)-e2.ckpt");
        assert_eq!(selected["epoch"], 2);
        assert!(selected["step"].is_null());
        assert_eq!(
            selected["sha256"],
            sha256(&dir.join("models/gpt.ckpt")).unwrap()
        );
        assert_eq!(cfg["author"], "Author");
        assert_eq!(cfg["custom"], 42);
        assert!(weights.join("Voice.[a]+(1)-e2.ckpt").is_file());
        cfg["training"]["selected"]["sovits"] = json!({"file":"other.pth","epoch":9});
        write_cfg(&dir, &cfg).unwrap();
        crate::role_assets::replace_weight_and_record_with(
            &root,
            "voice",
            "gpt",
            &weights.join("Voice.[a]+(1)-e5.ckpt"),
            None,
            None,
            inspect_ok,
        )
        .unwrap();
        let cfg = read_cfg(&dir).unwrap();
        assert!(cfg["training"]["selected"]["gpt"].is_null());
        assert_eq!(cfg["training"]["selected"]["sovits"]["epoch"], 9);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_validation_preserves_the_selection_and_installed_bytes() {
        let (root, dir, _) = fixture("versions-invalid");
        let before = std::fs::read(dir.join("config.json")).unwrap();
        assert!(apply_with(
            &root,
            "voice",
            "gpt",
            "Voice.[a]+(1)-e2.ckpt",
            |_, _, _, _, _| Err("pair mismatch".into())
        )
        .is_err());
        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), before);
        assert_eq!(
            std::fs::read(dir.join("models/gpt.ckpt")).unwrap(),
            b"final gpt"
        );
        assert_eq!(std::fs::read_dir(dir.join("models")).unwrap().count(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_source_and_configured_output_use_exact_experiment_names() {
        let (root, dir, _) = fixture("versions-legacy");
        write_cfg(&dir, &json!({"name":"Voice.[a]+(1)","source":"trained"})).unwrap();
        assert_eq!(
            list(&root, "voice").unwrap().experiment.as_deref(),
            Some("Voice.[a]+(1)")
        );
        let custom = root.join("custom weights");
        std::fs::create_dir_all(&custom).unwrap();
        crate::config::set_train_output_dir(&root, custom.to_str().unwrap()).unwrap();
        std::fs::write(custom.join("Voice.[a]+(1)-e7.ckpt"), b"seven").unwrap();
        assert_eq!(
            list(&root, "voice").unwrap().weights[1].versions[0].epoch,
            Some(7)
        );
        write_cfg(&dir, &json!({"name":"Display name"})).unwrap();
        assert_eq!(
            list(&root, "voice").unwrap().experiment.as_deref(),
            Some("voice")
        );
        assert!(list(&root, "voice").unwrap().weights[1].versions.is_empty());
        write_cfg(&dir, &json!({"exp_name":"Voice.[a]+(1)"})).unwrap();
        assert_eq!(list(&root, "voice").unwrap().weights[1].versions.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshots_cleanup_uses_exact_names_and_keeps_installed_copies() {
        let (root, dir, weights) = fixture("versions-cleanup");
        let custom = root.join("previous output");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join("Voice.[a]+(1)-e1.ckpt"), b"custom gpt").unwrap();
        let mut cfg = read_cfg(&dir).unwrap();
        cfg["training"]["weights_dir"] = json!(custom);
        write_cfg(&dir, &cfg).unwrap();
        let scan = crate::train::cleanup_scan(&root);
        assert_eq!(scan[0]["kinds"]["snapshots"]["files"], 5);
        let expected: u64 = snapshot_files(&root, "Voice.[a]+(1)")
            .iter()
            .map(|p| std::fs::metadata(p).unwrap().len())
            .sum();
        let freed =
            crate::train::cleanup_apply(&root, "Voice.[a]+(1)", &["snapshots".into()]).unwrap();
        assert_eq!(freed, expected);
        assert!(dir.join("models/sovits.pth").is_file());
        assert!(dir.join("models/gpt.ckpt").is_file());
        assert!(weights.join("Voice.[a]+(1)other_e2_s20.pth").is_file());
        assert!(weights.join("G_100.pth").is_file());
        assert!(weights.join("epoch=5.ckpt").is_file());
        assert!(snapshot_files(&root, "Voice.[a]+(1)").is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hash_cache_refreshes_for_changed_size_or_modification_time() {
        let root = crate::testutil::scratch("versions-hash");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("weight");
        std::fs::write(&path, b"first").unwrap();
        let initial = sha256(&path).unwrap();
        std::fs::write(&path, b"other").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        assert_ne!(sha256(&path).unwrap(), initial);
        std::fs::write(&path, b"different size").unwrap();
        assert_ne!(sha256(&path).unwrap(), initial);
        std::fs::remove_dir_all(root).unwrap();
    }
}
