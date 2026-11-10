//! Adapter from the published model catalog to the existing store cards and installer.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::{blocking::Client, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PRODUCT_ID: &str = "com.turingmirror.gpt-sovits-fabric";
const FAMILY: &str = "gpt-sovits";

fn setting(root: &Path, env: &str, key: &str) -> String {
    std::env::var(env)
        .ok()
        .or_else(|| {
            crate::config::read(root)
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn public_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|e| e.to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid Community URL".into());
    }
    Ok(url)
}

fn api_setting(root: &Path) -> String {
    setting(root, "TRM_COMMUNITY_API_URL", "community_api_url")
}

fn endpoint(api: &Url, segments: &[&str]) -> Url {
    let mut url = api.clone();
    url.set_query(None);
    url.set_fragment(None);
    let mut path = url.path_segments_mut().expect("HTTP URL");
    path.pop_if_empty();
    for part in segments {
        path.push(part);
    }
    drop(path);
    url
}

pub fn links(root: &Path) -> Value {
    let web = public_url(&setting(root, "TRM_COMMUNITY_WEB_URL", "community_web_url")).ok();
    let mut publish = web.clone();
    if let Some(url) = &mut publish {
        url.query_pairs_mut()
            .append_pair("community", "publish")
            .append_pair("kind", "model")
            .append_pair("family", FAMILY);
    }
    let submissions = web.map(|mut url| {
        url.query_pairs_mut().append_pair("community", "mine");
        url
    });
    let account = std::env::var("TRM_ACCOUNT_URL")
        .unwrap_or_else(|_| "https://account.turingmirror.com".into());
    json!({
        "enabled": !api_setting(root).is_empty(),
        "publishUrl": publish.as_ref().map(Url::as_str),
        "submissionsUrl": submissions.as_ref().map(Url::as_str),
        "accountUrl": public_url(&account).ok().as_ref().map(Url::as_str),
    })
}

fn request(client: &Client, url: Url) -> Result<Value, String> {
    let body = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn good_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

fn entry(asset: &Value, api: &Url) -> Option<Value> {
    let id = field(asset, "id");
    let version = &asset["compatibleVersion"];
    let version_id = field(version, "id");
    let package = &version["package"];
    let file_id = field(package, "id");
    let sha = field(package, "sha256");
    let size = package["sizeBytes"].as_u64()?;
    if id.is_empty() || version_id.is_empty() || file_id.is_empty() || !good_hash(sha) || size == 0
    {
        return None;
    }
    let meta = &asset["metadata"];
    let family_version = version["metadata"]["familyVersion"]
        .as_str()
        .or_else(|| meta["familyVersion"].as_str())
        .unwrap_or_default();
    let cover = if let Some(upload) = asset["coverUploadId"].as_str() {
        let mut url = endpoint(api, &["assets", id, "cover"]);
        url.query_pairs_mut().append_pair("v", upload);
        url.to_string()
    } else if field(asset, "previewMimeType").starts_with("image/") {
        asset["previewFileId"]
            .as_str()
            .map(|file| endpoint(api, &["files", file, "content"]).to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let mut entry = json!({
        "id": id,
        "name": field(asset, "title"),
        "tag": family_version,
        "version": family_version,
        "community_release": field(version, "label"),
        "community_version_id": version_id,
        "community_file_id": file_id,
        "legacy_catalog_id": field(meta, "fabricModelId"),
        "size_bytes": size,
        "size_label": crate::store::format_size(size),
        "sha256": sha,
        "cover_url": cover,
        "description": field(asset, "description"),
        "author": field(asset, "originalAuthor"),
        "series": field(meta, "series"),
        "group": field(meta, "group"),
        "date": field(asset, "createdAt"),
        "source_url": field(asset, "upstreamUrl"),
        "license": asset["license"],
        "official": false,
    });
    entry["community_staging_id"] = json!(version_role_id(&entry));
    Some(entry)
}

fn load_entries(api: &Url) -> Result<Vec<Value>, String> {
    let client = client()?;
    let mut entries = Vec::new();
    let mut cursor = String::new();
    loop {
        let mut url = endpoint(api, &["assets"]);
        url.query_pairs_mut()
            .append_pair("productId", PRODUCT_ID)
            .append_pair("limit", "100");
        if !cursor.is_empty() {
            url.query_pairs_mut().append_pair("cursor", &cursor);
        }
        let page = request(&client, url)?;
        let items = page["items"]
            .as_array()
            .ok_or("Invalid Community catalog")?;
        entries.extend(items.iter().filter_map(|asset| entry(asset, api)));
        let next = field(&page, "nextCursor");
        if next.is_empty() {
            return Ok(entries);
        }
        if next == cursor {
            return Err("Invalid Community catalog cursor".into());
        }
        cursor = next.to_owned();
    }
}

fn annotate_installed(root: &Path, entries: &mut [Value]) {
    let base = crate::paths::user_data(root).join("characters");
    let installed: Vec<(String, Value)> = fs::read_dir(base)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|dir| {
            let path = dir.path();
            if !path.join("models/gpt.ckpt").is_file() || !path.join("models/sovits.pth").is_file()
            {
                return None;
            }
            let cfg = fs::read_to_string(path.join("config.json")).ok()?;
            Some((
                dir.file_name().to_string_lossy().into_owned(),
                serde_json::from_str(&cfg).ok()?,
            ))
        })
        .collect();
    for entry in entries {
        let asset = field(entry, "id");
        let legacy = field(entry, "legacy_catalog_id");
        let version = field(entry, "community_version_id");
        let is_same_asset = |id: &str, cfg: &Value| {
            field(cfg, "catalog_id") == asset
                || !legacy.is_empty() && (id == legacy || field(cfg, "catalog_id") == legacy)
        };
        let exact = installed.iter().find(|(id, cfg)| {
            is_same_asset(id, cfg) && field(cfg, "community_version_id") == version
        });
        let any = exact.or_else(|| installed.iter().find(|(id, cfg)| is_same_asset(id, cfg)));
        if let Some((id, _)) = any {
            entry["installed"] = json!(true);
            entry["installed_role_id"] = json!(id);
            entry["update_available"] = json!(exact.is_none());
        }
    }
}

fn cache_path(root: &Path) -> PathBuf {
    crate::paths::user_data(root).join("community_catalog_cache.json")
}

pub fn catalog(root: &Path, prefer_remote: bool) -> Option<Value> {
    let configured = api_setting(root);
    if configured.is_empty() {
        return None;
    }
    let cache = cache_path(root);
    let cached = fs::read_to_string(&cache)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(|data| field(data, "url") == configured)
        .and_then(|data| data["entries"].as_array().cloned());
    let (mut entries, source, error) = if !prefer_remote && cached.is_some() {
        (cached.unwrap_or_default(), "cache", String::new())
    } else {
        match public_url(&configured).and_then(|url| load_entries(&url)) {
            Ok(entries) => {
                let _ = trm_app_protocol::discovery::write_json(
                    &cache,
                    &json!({ "url": configured, "entries": entries }),
                );
                (entries, "remote", String::new())
            }
            Err(error) => {
                crate::logging::shell_log!(format!("community catalog: {error}"));
                let source = if cached.is_some() { "cache" } else { "error" };
                (
                    cached.unwrap_or_default(),
                    source,
                    crate::i18n::t("community.catalogUnavailable"),
                )
            }
        }
    };
    annotate_installed(root, &mut entries);
    for entry in &mut entries {
        entry["origin_label"] = json!(crate::i18n::t("nav.plaza"));
    }
    Some(
        json!({"source": source, "voices": [], "thirdparty_voices": entries, "fetch_error": error}),
    )
}

pub fn download_url(root: &Path, entry: &Value) -> Result<String, String> {
    let api = public_url(&api_setting(root))?;
    let response = request(
        &client()?,
        endpoint(
            &api,
            &["files", field(entry, "community_file_id"), "download"],
        ),
    )?;
    if response["origin"]["assetId"] != entry["id"]
        || response["origin"]["versionId"] != entry["community_version_id"]
        || response["sha256"] != entry["sha256"]
        || response["sizeBytes"] != entry["size_bytes"]
    {
        return Err(crate::i18n::t("community.refreshBeforeDownload"));
    }
    Ok(public_url(field(&response, "url"))?.to_string())
}

pub fn version_role_id(entry: &Value) -> Option<String> {
    let asset = field(entry, "id");
    let version = field(entry, "community_version_id");
    if asset.is_empty() || version.is_empty() {
        return None;
    }
    let digest = format!("{:x}", Sha256::digest(format!("{asset}/{version}")));
    Some(format!("community-{}", &digest[..24]))
}
