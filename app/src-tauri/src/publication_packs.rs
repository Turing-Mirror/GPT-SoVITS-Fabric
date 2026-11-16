use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

use crate::{characters, download, root_clone, shell_extras, AppState};

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pack {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<PackDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackDetails {
    sha256: String,
    size_bytes: u64,
    metadata: Value,
}

fn details(root: &Path, path: &Path, exported: Option<&str>) -> Result<PackDetails, String> {
    let config = match exported {
        Some(id) => characters::role_dir(root, id).and_then(|dir| characters::read_cfg(&dir))?,
        None => characters::pack_metadata(root, path)?,
    };
    let size_bytes = fs::metadata(path).map_err(|e| e.to_string())?.len();
    let sha256 = download::file_sha256(path)?;
    let mut metadata = serde_json::Map::new();
    for key in ["name", "author", "author_url", "description", "version", "series", "group", "club", "language", "lang", "license"] {
        if let Some(text) = config[key].as_str().filter(|text| text.len() <= 20_000) {
            metadata.insert(key.into(), Value::String(text.into()));
        }
    }
    if !metadata.contains_key("language") && !metadata.contains_key("lang") {
        if let Some(lists) = config["lists"].as_array() {
            let common = lists.first().and_then(|list| list["lang"].as_str()).map(str::trim).filter(|lang| !lang.is_empty());
            if let Some(lang) = common.filter(|lang| lists.iter().all(|list| {
                list["lang"].as_str().is_some_and(|value| value.trim().eq_ignore_ascii_case(lang))
            })) {
                metadata.insert("language".into(), Value::String(lang.to_lowercase()));
            }
        }
    }
    Ok(PackDetails { sha256, size_bytes, metadata: Value::Object(metadata) })
}

fn record(name: String, result: Result<PackDetails, String>) -> Pack {
    match result {
        Ok(result) => Pack { name, result: Some(result), error: None },
        Err(error) => Pack { name, result: None, error: Some(error) },
    }
}

#[tauri::command]
pub(crate) fn publication_pick_cover_path(window: tauri::WebviewWindow) -> Option<String> {
    characters::pick_cover(Some(&window)).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn publication_read_packs(
    window: tauri::WebviewWindow, state: State<'_, Mutex<AppState>>,
) -> Result<Value, String> {
    let root = root_clone(&state)?;
    let files = characters::pick_pack(Some(&window));
    tauri::async_runtime::spawn_blocking(move || {
        let records: Vec<_> = files.iter().map(|file| {
            let name = file.file_name().unwrap_or_default().to_string_lossy().into_owned();
            record(name, details(&root, file, None))
        }).collect();
        serde_json::to_value(records).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn publication_read_manifest(window: tauri::WebviewWindow) -> Result<Value, String> {
    let Some(path) = shell_extras::dialog_on(Some(&window)).add_filter("JSON", &["json"]).pick_file() else {
        return Ok(Value::Null);
    };
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(path).map_err(|e| e.to_string())?.take(2_000_001).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > 2_000_000 { return Err("Export list is too large.".into()); }
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let records = if let Some(entries) = value.as_object() {
            entries.iter().filter_map(|(name, entry)| {
                let sha256 = entry["sha256"].as_str()?.to_string();
                let size_bytes = entry["size"].as_u64().or_else(|| entry["sizeBytes"].as_u64()).or_else(|| entry["size_bytes"].as_u64()).unwrap_or(0);
                Some(record(name.clone(), Ok(PackDetails { sha256, size_bytes, metadata: entry.clone() })))
            }).collect()
        } else {
            serde_json::from_value::<Vec<Pack>>(value).map_err(|e| e.to_string())?
        };
        serde_json::to_value(records).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn publication_export_packs(
    window: tauri::WebviewWindow, state: State<'_, Mutex<AppState>>, ids: Vec<String>,
) -> Result<Value, String> {
    let root = root_clone(&state)?;
    if ids.is_empty() {
        return Ok(Value::Null);
    }
    let Some(dest) = shell_extras::dialog_on(Some(&window)).pick_folder() else {
        return Ok(Value::Null);
    };
    tauri::async_runtime::spawn_blocking(move || export(&root, &dest, ids))
        .await.map_err(|e| e.to_string())?
}

fn export(root: &Path, dest: &Path, ids: Vec<String>) -> Result<Value, String> {
    let output = dest.join(format!("character-packs-{}", crate::role_assets::unique()));
    fs::create_dir(&output).map_err(|e| e.to_string())?;
    let mut records = Vec::new();
    for id in ids {
        let name = format!("{id}_voice.zip");
        let result = (|| {
            characters::role_dir(root, &id)?;
            let file = output.join(&name);
            let result = characters::export_zip(root, &id, &file).and_then(|_| details(root, &file, Some(&id)));
            if result.is_err() {
                let _ = fs::remove_file(&file);
            }
            result
        })();
        records.push(record(name, result));
    }
    let manifest = write_manifest(output.join("pack-checksums.json"), &records)?;
    Ok(serde_json::json!({ "folder": output, "manifest": manifest, "packs": records }))
}

fn write_manifest(path: PathBuf, packs: &[Pack]) -> Result<PathBuf, String> {
    let rows: Vec<_> = packs.iter().filter(|pack| pack.result.is_some()).collect();
    let data = serde_json::to_vec_pretty(&rows).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path)
}
