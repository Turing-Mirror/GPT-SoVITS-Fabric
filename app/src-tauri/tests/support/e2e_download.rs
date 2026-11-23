//! Opt-in live acceptance. Uses the production catalog/parser/downloader.
//! cargo test --locked --lib e2e_download::live_download_chain -- --ignored --nocapture
use crate::{catalog, download, logging};
use download::{DownloadKind, DownloadRequest, ProgressFn};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn request(blob: &Value, folder: &Path, kind: DownloadKind) -> DownloadRequest {
    DownloadRequest {
        urls: blob["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect(),
        root: None, // No telemetry, saved mirror preference, or user configuration.
        dest: folder.join(blob["name"].as_str().unwrap()),
        expected_sha256: blob["sha256"].as_str().unwrap().to_owned(),
        size_hint: blob["size_bytes"].as_u64().unwrap(),
        connections: None,
        kind,
    }
}

fn progress(name: String, cancel_at: Option<u64>, cancel: Arc<AtomicBool>) -> ProgressFn {
    let state = Mutex::new((Instant::now(), String::new()));
    Arc::new(move |done, total, phase| {
        if cancel_at.is_some_and(|limit| done >= limit) {
            cancel.store(true, Ordering::SeqCst);
        }
        let mut state = state.lock().unwrap();
        if state.0.elapsed().as_secs() >= 10 || state.1 != phase || done == total {
            println!("PROGRESS {name} {done}/{total} {phase}");
            *state = (Instant::now(), phase.to_owned());
        }
    })
}

fn shell_log() -> String {
    logging::path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

fn run_download(label: &str, req: DownloadRequest) -> Value {
    let started = Instant::now();
    println!("START {label} size={} urls={:?}", req.size_hint, req.urls);
    let cancel = Arc::new(AtomicBool::new(false));
    let result = download::download_request(
        req.clone(),
        cancel.clone(),
        Some(progress(label.to_owned(), None, cancel)),
    );
    let check = result.and_then(|()| {
        let size = std::fs::metadata(&req.dest)
            .map_err(|e| e.to_string())?
            .len();
        if size != req.size_hint {
            return Err(format!("size mismatch {size} != {}", req.size_hint));
        }
        download::verify_sha256(&req.dest, &req.expected_sha256)?;
        // The client writes this only after the real HTTP download returns.
        let needle = format!("download {} ok ", req.kind.as_str());
        let log = shell_log();
        let used = req
            .urls
            .iter()
            .find(|url| log.contains(&format!("{needle}{url}")))
            .ok_or("No successful client URL in log")?;
        if !used.starts_with("https://modelscope.cn/") {
            return Err(format!("Expected ModelScope, actually used {used}"));
        }
        Ok(used.clone())
    });
    let row = match check {
        Ok(url) => json!({"item":label,"pass":true,"url":url,"sha256":req.expected_sha256,
                         "size":req.size_hint,"seconds":started.elapsed().as_secs_f64()}),
        Err(error) => json!({"item":label,"pass":false,"error":error,
                            "seconds":started.elapsed().as_secs_f64()}),
    };
    println!("RESULT {row}");
    row
}

fn prefix_hash(path: &Path, size: u64) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(size)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 != size {
        return Err("Missing bytes for fallback prefix comparison".into());
    }
    Ok(hex::encode(Sha256::digest(&bytes)))
}

fn fallback(cpu: &DownloadRequest, folder: &Path) -> Value {
    let check = || -> Result<Value, String> {
        let mirror = cpu
            .urls
            .iter()
            .find(|url| url.starts_with("https://modelscope.cn/"))
            .ok_or("No ModelScope URL")?
            .clone();
        let blocked = "https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases/-/releases/download/GSV-runtime/runtime-cpu-2026.10.31.tar.gz";
        let req = DownloadRequest {
            urls: vec![blocked.to_owned(), mirror.clone()],
            dest: folder.join("fallback.tar.gz"),
            ..cpu.clone()
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let before = shell_log().len();
        let outcome = download::download_request(
            req.clone(),
            cancel.clone(),
            Some(progress(
                "fallback".into(),
                Some(4 * 1024 * 1024),
                cancel.clone(),
            )),
        );
        println!("FALLBACK outcome={outcome:?}");
        let log = shell_log();
        let log = &log[before..];
        println!("FALLBACK CLIENT LOG\n{log}");
        if !log.contains(&format!("fail {blocked}: resume: status 403"))
            || !log.contains(&format!("try {mirror}"))
        {
            return Err("Client log does not show CNB 403 followed by ModelScope".into());
        }
        let part = PathBuf::from(format!("{}.part", req.dest.display()));
        let marker = PathBuf::from(format!("{}.part.src", req.dest.display()));
        let size = std::fs::metadata(&part).map_err(|e| e.to_string())?.len();
        if size < 4 * 1024 * 1024 || !cancel.load(Ordering::SeqCst) || outcome.is_ok() {
            return Err(format!(
                "Expected cancellation after 4 MiB, got {size} bytes"
            ));
        }
        if std::fs::read_to_string(marker).map_err(|e| e.to_string())? != mirror {
            return Err("Partial download source is not ModelScope".into());
        }
        let digest = prefix_hash(&part, size)?;
        if digest != prefix_hash(&cpu.dest, size)? {
            return Err("Fallback bytes differ from the verified CPU archive prefix".into());
        }
        Ok(
            json!({"item":"fallback","pass":true,"url":mirror,"bytes":size,
                  "prefix_sha256":digest,"complete_archive_verified":false}),
        )
    };
    let row = check().unwrap_or_else(|error| json!({"item":"fallback","pass":false,"error":error}));
    println!("RESULT {row}");
    row
}

#[test]
#[ignore = "Live network and approximately 800 MB of downloads; explicit acceptance only"]
fn live_download_chain() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../data/e2e")
        .join(format!("gsv-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    logging::init(&root);
    println!("E2E_DIRECTORY {}", root.display());
    let doc = catalog::fetch_remote_catalog(30).expect("Live catalog fetch failed");
    std::fs::write(
        root.join("catalog.json"),
        serde_json::to_vec_pretty(&doc).unwrap(),
    )
    .unwrap();
    let source = "https://www.turingmirror.com/releases/gpt-sovits-fabric/index.json";
    assert!(
        shell_log().contains(&format!("catalog source {source}")),
        "Actual source was not the website"
    );
    println!(
        "RESULT {}",
        json!({"item":"catalog","pass":true,"source":source,"version":doc["app"]["version"]})
    );
    let spec = catalog::parse_spec("cpu", &doc);
    assert_eq!(spec.part.name, "runtime-cpu-2026.10.31.tar.gz");
    let cpu = DownloadRequest {
        urls: spec.part.urls,
        root: None,
        dest: root.join(&spec.part.name),
        expected_sha256: spec.part.sha256,
        size_hint: spec.part.size_bytes,
        connections: None,
        kind: DownloadKind::Runtime,
    };
    let core = doc["engine_core"]
        .as_object()
        .unwrap()
        .values()
        .min_by_key(|blob| blob["size_bytes"].as_u64().unwrap())
        .unwrap();
    let extra = doc["extras"]["gsv-v5"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|blob| blob["name"] == "vocoder.pth")
        .unwrap();
    let requests = vec![
        ("cpu", cpu.clone()),
        ("smallest_core", request(core, &root, DownloadKind::Generic)),
        ("vocoder", request(extra, &root, DownloadKind::Generic)),
    ];
    let mut results = std::thread::scope(|scope| {
        let handles: Vec<_> = requests
            .iter()
            .map(|(label, req)| scope.spawn(move || run_download(label, req.clone())))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    results.push(fallback(&cpu, &root));
    std::fs::write(
        root.join("results.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
    // Only files created by this test; preserve the JSON and original client logs.
    for path in requests
        .iter()
        .map(|(_, req)| req.dest.clone())
        .chain([root.join("fallback.tar.gz")])
    {
        for suffix in ["", ".part", ".part.src"] {
            let file = PathBuf::from(format!("{}{suffix}", path.display()));
            if file.is_file() {
                std::fs::remove_file(file).unwrap();
            }
        }
    }
    println!(
        "CLEANUP removed test download files; evidence retained at {}",
        root.display()
    );
    assert!(
        results.iter().all(|row| row["pass"] == true),
        "Some live downloads failed: {results:?}"
    );
}
