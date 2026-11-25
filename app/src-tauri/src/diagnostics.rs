//! Product boundary for the shared v1 diagnostic protocol. No classification rules live here.
use fabric_diagnostics::{diagnose, Context, Diagnostic, Evidence, Feature, Outcome};
use serde::Serialize;
use serde_json::{json, Value};
use std::{io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};

static NEXT: AtomicU64 = AtomicU64::new(1);

pub fn id() -> String {
    format!("{}-{}-{}", std::process::id(), chrono::Utc::now().timestamp_micros(), NEXT.fetch_add(1, Ordering::Relaxed))
}

/// The start offset is captured before the operation. Never read a historical tail.
pub struct LogSlice { path: PathBuf, start: u64 }
impl LogSlice {
    pub fn start(path: &Path) -> Self { Self { path: path.into(), start: crate::logging::file_len(path) } }
    pub fn append(&self, evidence: &mut Evidence) {
        let result = (|| -> std::io::Result<String> {
            let mut file = std::fs::File::open(&self.path)?;
            if file.metadata()?.len() < self.start { return Err(std::io::Error::other("current operation log was replaced")); }
            file.seek(SeekFrom::Start(self.start))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        })();
        match result {
            Ok(text) => { evidence.text.push('\n'); evidence.text.push_str(&text); }
            Err(error) => { evidence.truncated = true; evidence.text.push_str(&format!("\n[current operation log unavailable: {error}]")); }
        }
        evidence.log_ref = Some(format!("{}#offset={}", self.path.display(), self.start));
    }
}

pub fn evidence(feature: Feature, retry_safe: bool) -> Evidence {
    let mut e = Evidence::new(feature, id());
    e.context.outcome = Some(Outcome::Failed);
    e.context.retry_safe = Some(retry_safe);
    e
}

pub fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source { text.push_str(&format!("\ncaused by: {cause}")); source = cause.source(); }
    text
}

pub fn worker(e: &mut Evidence, value: &Value) {
    e.source_code = value["message_code"].as_str().or(value["code"].as_str()).map(str::to_owned);
    e.source_params = value["message_params"].as_object().cloned().unwrap_or_default();
    if let Some(stage) = value["stage"].as_str() { e.stage = Some(stage.into()); }
    for field in ["message", "detail", "exception", "traceback"] {
        if let Some(text) = value[field].as_str() { e.text.push_str(text); e.text.push('\n'); }
    }
    if let Some(code) = value["exit_code"].as_i64() { e.exit_code = Some(code as i32); }
    if let Some(code) = value["os_error"].as_i64() { e.os_error = Some(code as i32); }
    if let Some(batch) = value["batch"].as_u64() {
        if let Some(stage) = &e.stage { e.context.batch.get_or_insert_default().insert(stage.clone(), batch as u32); }
    }
    if let Some(backend) = value["backend"].as_str() {
        e.context.backend = serde_json::from_value(json!(backend)).ok();
    }
}

pub fn finish(e: &Evidence) -> Diagnostic {
    let mut d = diagnose(e);
    adopt_specific_cause(&mut d, e.source_code.as_deref(), &e.source_params);
    // Metadata is copied for support but never participates in signature matching.
    d.detail.text.push_str(&format!("\n\n[evidence]\n{}", serde_json::to_string_pretty(&json!({
        "error_id": e.error_id, "stage": e.stage, "job_id": e.job_id, "attempt": e.attempt,
        "source_code": e.source_code, "source_params": e.source_params, "context": e.context,
        "exit_code": e.exit_code, "os_error": e.os_error, "http_status": e.http_status,
        "log_ref": e.log_ref, "truncated": e.truncated,
    })).unwrap()));
    d
}

/// No rule recognised the failure, but the worker already said something specific
/// (for example "the microphone is in use"). Show that sentence as the cause instead
/// of "the cause could not be determined". Templates that only carry an exit code,
/// a raw error or a log path are not specific and stay out.
fn adopt_specific_cause(d: &mut Diagnostic, source_code: Option<&str>, params: &serde_json::Map<String, Value>) {
    if d.code != "diag.unknown" {
        return;
    }
    let Some(code) = source_code.map(str::trim).filter(|c| !c.is_empty()) else { return };
    let key = if code.starts_with("msg.") || code.starts_with("s.") { code.to_string() } else { format!("msg.{code}") };
    let template = crate::i18n::t(&key);
    if template == key || ["{error}", "{detail}", "{log}", "{code}"].iter().any(|m| template.contains(m)) {
        return;
    }
    d.cause = Some(fabric_diagnostics::Message { key, params: params.clone() });
}

/// Internal String-returning APIs keep their ABI; IPC unwraps this into an object.
pub fn encode(d: &Diagnostic) -> String { serde_json::to_string(d).expect("diagnostic serializes") }
pub fn summary(error: &str) -> String {
    decode(error).map(|d| crate::i18n::t(&d.title.key)).unwrap_or_else(|| error.into())
}
pub fn decode(text: &str) -> Option<Diagnostic> {
    serde_json::from_str::<Diagnostic>(text).ok().filter(|d| d.schema == 1)
}
pub fn from_error(feature: Feature, error: &str, retry_safe: bool) -> Diagnostic {
    decode(error).unwrap_or_else(|| { let mut e = evidence(feature, retry_safe); e.text = error.into(); finish(&e) })
}
pub fn failure(feature: Feature, error: &str, context: Context) -> String {
    if decode(error).is_some() { return error.into(); }
    let mut e = evidence(feature, context.retry_safe.unwrap_or(false));
    e.context = context;
    e.text = error.into();
    encode(&finish(&e))
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub message: String, pub diagnostic: Diagnostic,
    #[serde(flatten)] pub legacy: serde_json::Map<String, Value>,
}
// The local API's generated dispatcher uses Display for its legacy error ABI.
// Keep the full envelope so that the browser adapter can recover the same id.
impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", serde_json::to_string(self).map_err(|_| std::fmt::Error)?)
    }
}
impl CommandError {
    pub fn new(command: &str, error: String) -> Self {
        let cancelled = error == crate::i18n::t("s.annot.cancelled") || error == crate::i18n::t("s.a5ffdc95ee");
        let diagnostic = if cancelled {
            let mut e = evidence(feature_for(command), false);
            e.context.outcome = Some(Outcome::Cancelled);
            e.source_code = Some("cancelled".into());
            e.text = error;
            finish(&e)
        } else { from_error(feature_for(command), &error, command.starts_with("train_")) };
        let message = crate::i18n::t(&diagnostic.title.key);
        Self { message, diagnostic, legacy: Default::default() }
    }
    pub fn api(command: &str, error: trm_app_protocol::ApiError) -> Self {
        let value = serde_json::to_value(error).expect("API error serializes");
        let mut evidence = evidence(feature_for(command), false);
        evidence.source_code = value["code"].as_str().map(str::to_owned);
        evidence.text = value["message"].as_str().unwrap_or("").into();
        evidence.http_status = value["details"]["http_status"].as_u64().map(|s| s as u16);
        evidence.source_params = value["details"].as_object().cloned().unwrap_or_default();
        if matches!(evidence.source_code.as_deref(), Some("canceled" | "cancelled")) {
            evidence.context.outcome = Some(Outcome::Cancelled);
        }
        let diagnostic = finish(&evidence);
        let mut legacy = value.as_object().cloned().unwrap_or_default();
        legacy.remove("message");
        Self { message: crate::i18n::t(&diagnostic.title.key), diagnostic, legacy }
    }
}
pub fn feature_for(command: &str) -> Feature {
    // Commands whose name prefix does not match what the user is doing. Keep this
    // list the same as the frontend's invokeFor calls.
    match command {
        "train_cleanup_scan" | "train_cleanup_apply" | "synth_rename" | "synth_delete" | "synth_characters" => return Feature::Other,
        "assets_ensure_engine_core" | "assets_ensure_gsv_cpp" | "assets_cancel_gsv_cpp" => return Feature::Download,
        _ => {}
    }
    if command.starts_with("train_") { Feature::Training }
    else if command.starts_with("annot_") { Feature::Annotation }
    else if command.starts_with("synth_") { Feature::Synthesis }
    else if command.starts_with("separate_") { Feature::Separation }
    else if command.starts_with("update_") { Feature::Update }
    else if command.starts_with("provision_") || command.starts_with("assets_") || command.starts_with("vcredist_") { Feature::Provision }
    else if command.starts_with("extra_") || command.starts_with("extras_") { Feature::Download }
    else if command.starts_with("store_") || command.starts_with("community_") || command.starts_with("plaza_") { Feature::Store }
    else if command.starts_with("role_") || command.starts_with("character_") || command.starts_with("publication_") || command.starts_with("model_version") { Feature::ImportExport }
    else if command.starts_with("config_") || command.starts_with("autostart_") || command.starts_with("wallpaper_") { Feature::Settings }
    else if command.starts_with("engine_") || command.starts_with("legacy_") { Feature::EngineStart }
    else { Feature::Other }
}

/// The bundled legacy web UI uses this process boundary to reuse the same rules.
/// It runs before Tauri initialization, takes only evidence, and performs no actions.
pub fn run_stdin() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let mut evidence: Evidence = serde_json::from_str(&input)?;
    if evidence.error_id.is_empty() { evidence.error_id = id(); }
    println!("{}", encode(&finish(&evidence)));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejection_preserves_identity_and_unknown_training_scope() {
        let d = from_error(Feature::Training, "child exited with code 1", false);
        assert_eq!(d.code, "diag.unknown");
        assert_eq!(d.title.key, "diag.title.training");
        let rejection = CommandError::new("train_start", encode(&d));
        assert_eq!(rejection.diagnostic.error_id, d.error_id);
    }
    #[test]
    fn oom_uses_actual_worker_stage_and_batch_not_legacy_params() {
        for (stage, current, suggested) in [("sovits", 4, 2), ("gpt", 12, 6)] {
            let mut e = evidence(Feature::Training, true);
            e.job_id = Some("failed-job".into());
            worker(&mut e, &json!({"stage": stage, "batch": current, "backend": "cuda",
                "message_code": "train.oom", "message_params": {"batch": "999"},
                "detail": "torch.cuda.OutOfMemoryError: CUDA out of memory"}));
            let d = finish(&e);
            assert_eq!(d.code, "diag.oom_gpu");
            assert!(d.actions.iter().any(|a| matches!(a,
                fabric_diagnostics::Action::EditTrainingCopy { stage: s, current: c, suggested: n, .. }
                if s == stage && *c == current && *n == suggested)));
            assert!(d.steps.iter().any(|step| step.key == "diag.step.submitEdited"));
        }
    }
    #[test]
    fn specific_worker_sentence_becomes_the_cause_but_exit_codes_do_not() {
        let mut e = evidence(Feature::Training, true);
        worker(&mut e, &json!({"stage": "prepare", "message_code": "train.dup_name", "message_params": {"name": "a.wav"}}));
        assert_eq!(finish(&e).cause.unwrap().key, "msg.train.dup_name");
        let mut e = evidence(Feature::Training, true);
        worker(&mut e, &json!({"stage": "gpt", "message_code": "train.step_failed", "message_params": {"step": "s1_train", "code": "1"}}));
        assert!(finish(&e).cause.is_none());
    }
    #[test]
    fn log_slice_excludes_previous_failures() {
        let dir = crate::testutil::scratch("diag-slice");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log");
        std::fs::write(&path, "torch.cuda.OutOfMemoryError: CUDA out of memory\n").unwrap();
        let slice = LogSlice::start(&path);
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&path).unwrap(), "unknown failure").unwrap();
        let mut e = evidence(Feature::Training, false); slice.append(&mut e);
        assert_eq!(finish(&e).code, "diag.unknown");
    }
}
