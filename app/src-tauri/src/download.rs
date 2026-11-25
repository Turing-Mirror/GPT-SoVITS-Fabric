//! Shared multi-connection downloader for Runtime / voice packs / gui updates.
//!
//! Core engine: **[ripget](https://github.com/sam0x17/ripget)** — open-source
//! multi-part HTTP range downloader (aria2c-style), with retries, idle reconnect,
//! and configurable parallelism. We only add product glue:
//! adaptive thread count, mirror URL fallback, sha256 verify, cancel,
//! reconnect on HTTP 500 (ripget treats it as fatal), and a blocking API
//! for Tauri commands.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ripget::{DownloadOptions, ProgressReporter};
use sha2::{Digest, Sha256};

/// UA 里的版本号跟包版本走。写死过的 1.3 在 1.5.4 上原样发了一年，服务端
/// 按版本统计的数据全是错的；env! 在编译期取 Cargo.toml 的值，零运行时开销。
const UA: &str = concat!(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) GPTSoVITSFabric/",
    env!("CARGO_PKG_VERSION")
);

/// 全下载共用的多线程 runtime。
///
/// 以前每个 `download_request` 都 build 一个再丢掉：音色广场连下几个包，
/// 就是几次「起线程池 → 用几秒 → 拆线程池」。并发下载共用一个池才是正
/// 常形态。约束不变：调用方仍然不许在 tokio 的异步上下文里进
/// `block_on`（那会 panic），这条限制对旧写法同样成立，没有变严。
fn shared_runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(8)
            .thread_name("gsv-dl")
            .enable_all()
            .build()
            .expect("download runtime")
    })
}
const MIN_MULTIPART_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB — same as launcher/online/multipart.py
const MAX_CONNECTIONS: usize = 32;
/// CNB Release CDN returns HTTP 500 under load. ripget treats 500 as fatal
/// (only 404/500 are non-retryable inside the crate), so a 6 GB Runtime
/// fetch used to die on the first blip. Wait ~3s and try again.
const RETRY_WAIT: Duration = Duration::from_secs(3);
const MAX_TRANSIENT_ATTEMPTS: u32 = 5;
/// ripget's `fetch_metadata` retries non-404/500 forever and the client has
/// no request timeout. A hanging mirror / CNB 502 then never returns, so the
/// store card stays at 0% and we never fail over to the next URL. Cap how
/// long we wait for the first real byte, then treat it as a transient error.
///
/// 40s 而不是 20s：拥塞线路上 TLS 握手加排队首字节超过 20 秒很常见
/// （diag 26.8.22/1 一晚上几十次恰好卡在 20s 整），每次掐断都把慢启动攒的
/// 窗口打回原点。超时后按清单顺序切换下一个源。
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(40);
const FIRST_BYTE_TIMEOUT_ERR: &str = "timed out waiting for first byte";
/// 续传流多久没有新字节算卡死。比 FIRST_BYTE_TIMEOUT 短：这时候连接已经建
/// 起来过了，再哑 15 秒就是真断了。
const RESUME_STALL: Duration = Duration::from_secs(15);

/// What is being downloaded — same pipeline for all product artifacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // VoicePack / GuiPatch used when store & update land
pub enum DownloadKind {
    Runtime,
    Dependency,
    VoicePack,
    GuiPatch,
    Generic,
}

impl DownloadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::VoicePack => "voice_pack",
            Self::GuiPatch => "gui_patch",
            Self::Dependency | Self::Generic => "file",
        }
    }
}

pub type ProgressFn = Arc<dyn Fn(u64, u64, &str) + Send + Sync>;

/// Progress phase token: `retry:N` (N = how many times we already failed).
pub fn retry_phase(attempt: u32) -> String {
    format!("retry:{attempt}")
}

/// Parse `retry:N`. Anything else is not a reconnect phase.
pub fn parse_retry_attempt(phase: &str) -> Option<u32> {
    phase.strip_prefix("retry:")?.parse().ok()
}

/// Percent for UI. Keep it a float so a 100 KB / 80 MB voice pack does not
/// sit on integer `0%` until a full percent has landed.
pub fn progress_percent(done: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (done as f64 / total as f64) * 100.0
    }
}

/// Network / origin blips we should reconnect on. Permanent catalog/auth/hash
/// errors must not spin.
pub fn is_transient_download_error(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    if e.contains("已取消") || e.contains("cancel") {
        return false;
    }
    if e.contains("status 404")
        || e.contains("status 403")
        || e.contains("status 401")
        || e.contains("status 410")
    {
        return false;
    }
    // Hash mismatch is the file we got, not the pipe. Next URL maybe; not a reconnect.
    if e.contains("sha256") {
        return false;
    }
    if e.contains("status 500")
        || e.contains("internal server error")
        || e.contains("status 502")
        || e.contains("status 503")
        || e.contains("status 504")
        || e.contains("status 429")
        || e.contains("bad gateway")
        || e.contains("service unavailable")
        || e.contains("gateway timeout")
        || e.contains("too many requests")
    {
        return true;
    }
    e.contains("timed out")
        || e.contains("timeout")
        || e.contains("connection")
        || e.contains("reset")
        || e.contains("broken pipe")
        || e.contains("unexpected end of stream")
        || e.contains("error sending request")
        || e.contains("dns")
        || e.contains("tls")
        || e.contains("handshake")
        || e.contains("unreachable")
        || e.contains("os error 10054")
        || e.contains("os error 10060")
        || e.contains("os error 10053")
        || e.contains("os error 10061")
        || e.contains("os error 11001")
        || (e.starts_with("ripget:") && !e.contains("status 40"))
}

fn wait_retry(cancel: &AtomicBool) -> Result<(), String> {
    let deadline = std::time::Instant::now() + RETRY_WAIT;
    while std::time::Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return Err(crate::i18n::t("s.a5ffdc95ee"));
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        std::thread::sleep(left.min(Duration::from_millis(200)));
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(crate::i18n::t("s.a5ffdc95ee"));
    }
    Ok(())
}


/// 联网请求失败时给用户看的话：原因，加上该怎么做。原始报错只写进日志，
/// 反馈时从日志里取，不在界面上铺一串地址。
pub(crate) fn plain_error(raw: &str) -> String {
    crate::logging::shell_log!("network request failed: {raw}");
    crate::diagnostics::failure(fabric_diagnostics::Feature::Download, raw, fabric_diagnostics::Context {
        operation: Some(fabric_diagnostics::Operation::Download), retry_safe: Some(false), ..Default::default()
    })
}

/// 报错的完整形状：一句人话 → 试过哪些源 → 能自己做点什么 → 技术细节。
///
/// 技术细节留在最后一行而不是删掉：用户来群里问的时候贴的就是这一整段，
/// 没有它我们只知道「下载失败」，一样查不出是哪一步。
fn download_error_text(raw: &str, attempts: u32, hosts: &[String]) -> String {
    let mut evidence = crate::diagnostics::evidence(fabric_diagnostics::Feature::Download, false);
    evidence.text = raw.into();
    evidence.context.operation = Some(fabric_diagnostics::Operation::Download);
    let mut diagnostic = crate::diagnostics::decode(raw).unwrap_or_else(|| crate::diagnostics::finish(&evidence));
    diagnostic.scope.attempt = Some(attempts);
    diagnostic.detail.text.push_str(&format!("\nattempts: {attempts}\nhosts: {}", hosts.join(", ")));
    crate::diagnostics::encode(&diagnostic)
}

fn suffixed(base: &Path, suffix: &str) -> PathBuf {
    let mut p = base.as_os_str().to_os_string();
    p.push(suffix);
    PathBuf::from(p)
}

/// 手上这半截还能不能接着下：返回它属于哪个源，None = 作废重来。
///
/// 判据只有标记文件，因为 `.part` 本身分不出「续传攒下的前缀」和「ripget 预
/// 分配出来的完整长度空壳」—— 后者的大小就是完整大小。
fn resumable_from(recorded: &str, urls: &[String], part_len: u64) -> Option<String> {
    let r = recorded.trim();
    if r.is_empty() || part_len == 0 || !urls.iter().any(|u| u == r) {
        return None;
    }
    Some(r.to_string())
}

/// Reduce concurrency after transient failures.
pub fn connections_for_attempt(base: usize, attempt: u32) -> usize {
    match attempt {
        0 | 1 => base,
        2 => (base / 4).max(4).min(base),
        _ => 1,
    }
}

/// Resume a verified prefix using HTTP Range; follow the server's redirects.
async fn resume_one_url(
    url: &str,
    part: &Path,
    kind: DownloadKind,
    size_hint: u64,
    cancel: Arc<AtomicBool>,
    progress: Option<ProgressFn>,
) -> Result<(), String> {
    use std::io::Write;

    let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(FIRST_BYTE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("client: {e}"))?;

    let mut req = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let resp = req.send().await.map_err(|e| format!("resume: {}", crate::diagnostics::error_chain(&e)))?;
    let (start, response_end, complete_size) = match resp.status() {
        reqwest::StatusCode::OK => (0, resp.content_length(), resp.content_length()),
        reqwest::StatusCode::PARTIAL_CONTENT => {
            let (end, size) = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| resume_range(value, have))
                .ok_or("resume: invalid Content-Range")?;
            (have, Some(end), Some(size))
        }
        status => return Err(format!("resume: status {}", status.as_u16())),
    };
    let total = complete_size.unwrap_or(size_hint).max(1);

    // Keep the existing bytes until a server that ignores Range actually
    // starts sending the replacement.
    let mut resp = resp;
    let first = resp
        .chunk()
        .await
        .map_err(|e| format!("resume: connection: {e}"))?;
    let Some(first) = first else {
        return Err("resume: unexpected end of stream".into());
    };
    if cancel.load(Ordering::SeqCst) {
        return Err(crate::i18n::t("s.a5ffdc95ee"));
    }
    let mut done = start + first.len() as u64;
    if response_end.is_some_and(|end| done > end) {
        return Err("resume: invalid response length".into());
    }
    let mut file = if start > 0 {
        std::fs::OpenOptions::new().append(true).open(part)
    } else {
        std::fs::File::create(part)
    }
    .map_err(|e| e.to_string())?;
    file.write_all(&first).map_err(|e| e.to_string())?;

    let mut last_emit = std::time::Instant::now();
    if let Some(ref cb) = progress {
        cb(done, total, kind.as_str());
    }
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(crate::i18n::t("s.a5ffdc95ee"));
        }
        let chunk = tokio::time::timeout(RESUME_STALL, resp.chunk())
            .await
            .map_err(|_| "resume: timed out waiting for data")?
            .map_err(|e| format!("resume: connection: {e}"))?;
        let Some(bytes) = chunk else { break };
        let next = done + bytes.len() as u64;
        if response_end.is_some_and(|end| next > end) {
            return Err("resume: invalid response length".into());
        }
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        done = next;
        if let Some(ref cb) = progress {
            if last_emit.elapsed() >= Duration::from_millis(150) {
                last_emit = std::time::Instant::now();
                cb(done, total.max(done), kind.as_str());
            }
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    if complete_size.is_some_and(|size| done != size) {
        return Err("resume: unexpected end of stream".into());
    }
    if let Some(ref cb) = progress {
        cb(done, total.max(done), kind.as_str());
    }
    Ok(())
}

fn resume_range(value: &str, offset: u64) -> Option<(u64, u64)> {
    let (range, size) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let end: u64 = end.parse().ok()?;
    let size = size.parse().ok()?;
    (start == offset && end >= start && end < size).then(|| (end + 1, size))
}

/// Adaptive connection count (mirrors `launcher/online/multipart.auto_connections`).
pub fn auto_connections(size: u64) -> usize {
    if size == 0 {
        return 1;
    }
    if size < MIN_MULTIPART_BYTES {
        return 1;
    }
    if size < 64 * 1024 * 1024 {
        return 8;
    }
    // Multi-GB Runtime: 16 connections; never exceed 32
    let preferred = if size >= 1024 * 1024 * 1024 { 16 } else { 12 };
    // Also keep ~1 MiB minimum per thread for very large sizes
    let by_mb = (size / (1024 * 1024)).clamp(1, MAX_CONNECTIONS as u64) as usize;
    preferred.min(by_mb).clamp(1, MAX_CONNECTIONS)
}

pub fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let exp = expected
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect::<String>()
        .to_ascii_lowercase();
    if exp.len() != 64 {
        return Err(crate::i18n::t("s.5ca337dd03").into());
    }
    let got = file_sha256(path)?;
    if got != exp {
        let mut e = crate::diagnostics::evidence(fabric_diagnostics::Feature::Download, false);
        e.source_code = Some("s.73a397a7fd".into());
        e.text = format!("sha256 mismatch: expected {exp}, got {got}");
        e.context.operation = Some(fabric_diagnostics::Operation::VerifyResource);
        e.context.target_disk_path = Some(path.to_string_lossy().into_owned());
        return Err(crate::diagnostics::encode(&crate::diagnostics::finish(&e)));
    }
    Ok(())
}

pub(crate) fn file_sha256(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| crate::i18n::te("s.21ce93c732", &(e)))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    use std::io::Read;
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn verify_download(path: &Path, sha256: &str, expected_size: u64) -> Result<(), String> {
    if expected_size > 0 {
        let size = path.metadata().map_err(|e| e.to_string())?.len();
        if size != expected_size {
            return Err(format!("download: size mismatch (expected {expected_size}, got {size})"));
        }
    }
    verify_sha256(path, sha256)
}

/// Options for a single product download (Runtime / voice / patch).
#[derive(Clone)]
pub struct DownloadRequest {
    pub urls: Vec<String>,
    /// 产品根。有它才能记「上次成功的源」和攒下载成败计数；给 None 就是
    /// 纯下载，不碰配置（安装器早期、单元测试）。
    pub root: Option<PathBuf>,
    pub dest: PathBuf,
    pub expected_sha256: String,
    /// Known size from catalog (feeds auto_connections when HEAD is slow).
    pub size_hint: u64,
    /// None = auto_connections(size)
    pub connections: Option<usize>,
    pub kind: DownloadKind,
}

/// Bridge product progress callbacks into ripget's ProgressReporter.
///
/// Emits are throttled (~150 ms) so the UI keeps up, but the first non-zero
/// byte and completion always fire immediately — otherwise multi-GB Runtime
/// downloads can show 0% for a long time even while the network is busy
/// (percent rounds down until done/total ≥ 0.5%).
struct ProgressBridge {
    cb: ProgressFn,
    total: AtomicU64,
    done: AtomicU64,
    threads: AtomicU64,
    kind: DownloadKind,
    cancel: Arc<AtomicBool>,
    /// size_hint from catalog when Content-Length is late / missing
    size_hint: u64,
    last_emit_ms: AtomicU64,
    started_ms: AtomicU64,
}

impl ProgressBridge {
    fn now_ms() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn effective_total(&self) -> u64 {
        self.total.load(Ordering::SeqCst).max(self.size_hint).max(1)
    }

    fn emit(&self, done: u64, phase: &str, force: bool) {
        let now = Self::now_ms();
        let last = self.last_emit_ms.load(Ordering::SeqCst);
        if !force && last != 0 && now.saturating_sub(last) < 150 {
            return;
        }
        self.last_emit_ms.store(now, Ordering::SeqCst);
        if self.started_ms.load(Ordering::SeqCst) == 0 {
            self.started_ms.store(now, Ordering::SeqCst);
        }
        let total = self.effective_total();
        (self.cb)(done, total, phase);
    }
}

impl ProgressReporter for ProgressBridge {
    fn init(&self, total: u64) {
        // Prefer the larger of HEAD length and catalog hint so the bar has a
        // real denominator from the first paint.
        let t = total.max(self.size_hint).max(1);
        self.total.store(t, Ordering::SeqCst);
        self.done.store(0, Ordering::SeqCst);
        let threads = self.threads.load(Ordering::SeqCst).max(1);
        self.emit(
            0,
            &crate::i18n::t2("s.364fa9e6bf", &self.kind.as_str(), &threads),
            true,
        );
    }

    fn set_threads(&self, threads: usize) {
        self.threads.store(threads as u64, Ordering::SeqCst);
    }

    fn add(&self, delta: u64) {
        if self.cancel.load(Ordering::SeqCst) {
            return;
        }
        let prev = self.done.fetch_add(delta, Ordering::SeqCst);
        let d = prev + delta;
        // First bytes always notify; then throttle.
        let force = prev == 0 || d >= self.effective_total();
        self.emit(d, "download", force);
    }
}

/// Blocking entry used by provision / future voice & update modules.
#[allow(dead_code)]
pub fn download_file(
    urls: &[String],
    dest: &Path,
    expected_sha256: &str,
    cancel: Arc<AtomicBool>,
    progress: Option<ProgressFn>,
) -> Result<(), String> {
    download_request(
        DownloadRequest {
            urls: urls.to_vec(),
            root: None,
            dest: dest.to_path_buf(),
            expected_sha256: expected_sha256.to_string(),
            size_hint: 0,
            connections: None,
            kind: DownloadKind::Generic,
        },
        cancel,
        progress,
    )
}

pub fn download_request(
    req: DownloadRequest,
    cancel: Arc<AtomicBool>,
    progress: Option<ProgressFn>,
) -> Result<(), String> {
    let destination = req.dest.to_string_lossy().into_owned();
    download_request_inner(req, cancel, progress).map_err(|error| {
        if error == crate::i18n::t("s.a5ffdc95ee") { return error; }
        crate::diagnostics::failure(fabric_diagnostics::Feature::Download, &error,
            fabric_diagnostics::Context { operation: Some(fabric_diagnostics::Operation::Download),
                target_disk_path: Some(destination), retry_safe: Some(false), ..Default::default() })
    })
}

fn download_request_inner(
    req: DownloadRequest,
    cancel: Arc<AtomicBool>,
    progress: Option<ProgressFn>,
) -> Result<(), String> {
    if req.urls.is_empty() {
        return Err(crate::i18n::t("s.d08e45e275").into());
    }
    let expected_size = req.size_hint;
    if let Some(parent) = req.dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Already complete + verified
    if req.dest.is_file() && !req.expected_sha256.is_empty() {
        if verify_download(&req.dest, &req.expected_sha256, expected_size).is_ok() {
            if let Some(ref cb) = progress {
                let len = req.dest.metadata().map(|m| m.len()).unwrap_or(0);
                cb(len, len, "download");
            }
            return Ok(());
        }
        let _ = std::fs::remove_file(&req.dest);
    }

    if cancel.load(Ordering::SeqCst) {
        return Err(crate::i18n::t("s.a5ffdc95ee").into());
    }

    // Setup packages preserve their bytes from the first connection.
    let threads = if matches!(req.kind, DownloadKind::Runtime | DownloadKind::Dependency) {
        1
    } else {
        req.connections
            .unwrap_or_else(|| auto_connections(req.size_hint))
            .clamp(1, MAX_CONNECTIONS)
    };

    // Download to .part then rename after verify
    let part_path = suffixed(&req.dest, ".part");
    // 「这个 .part 是从哪个源续下来的合法前缀」。
    //
    // 光看文件本身分不出来：ripget 会把目标**预分配**成完整长度再往各个
    // offset 写，一个半截的 .part 大小就是完整大小。只有续传那条路会写这个
    // 标记，所以它在 = 可以接着下，它不在 = 无条件重来。
    //
    // 顺带解决跨调用续传：用户取消一个 700MB 的包，回头再点，接着下。
    let tag_path = suffixed(&req.dest, ".part.src");
    let recorded = std::fs::read_to_string(&tag_path).unwrap_or_default();
    let part_len = part_path.metadata().map(|m| m.len()).unwrap_or(0);
    let mut resume_url = resumable_from(&recorded, &req.urls, part_len).unwrap_or_default();
    if resume_url.is_empty() {
        // 没标记、标记指向一个这次不用的源、或者半截是空的 —— 全部作废。
        let _ = std::fs::remove_file(&part_path);
        let _ = std::fs::remove_file(&tag_path);
    } else {
        crate::logging::shell_log!(format!(
            "download resume {} bytes from {resume_url}",
            part_len
        ));
    }

    let rt = shared_runtime();

    // Catalog mirrors are ordered; a faster fallback must not bypass the first URL.
    let urls = req.urls.clone();

    let mut last_err = String::new();
    let mut unavailable = Vec::new();
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let mut saw_transient = false;
        for url in &urls {
            if unavailable.contains(url) {
                continue;
            }
            if cancel.load(Ordering::SeqCst) {
                return Err(crate::i18n::t("s.a5ffdc95ee").into());
            }
            let use_resume = threads == 1 || attempt > 1 || !resume_url.is_empty();
            let conns = if use_resume {
                1
            } else {
                connections_for_attempt(threads, attempt)
            };
            crate::logging::shell_log!(format!(
                "download {} try {} (attempt {attempt}, conns {conns})",
                req.kind.as_str(),
                url
            ));
            // Verified mirrors can complete the same partial archive. Unverified
            // downloads must restart when the source changes.
            if !use_resume || (resume_url != *url && req.expected_sha256.is_empty()) {
                let _ = std::fs::remove_file(&part_path);
                let _ = std::fs::remove_file(&tag_path);
            }
            let offset = part_path.metadata().map(|m| m.len()).unwrap_or(0);
            if let Some(ref cb) = progress {
                cb(offset, req.size_hint.max(offset).max(1), "connecting:");
            }
            let outcome = if use_resume {
                resume_url = url.clone();
                std::fs::write(&tag_path, url).map_err(|e| e.to_string())?;
                let resume = || {
                    rt.block_on(async {
                        tokio::select! {
                            biased;
                            _ = wait_for_cancel(&cancel) => Err(crate::i18n::t("s.a5ffdc95ee")),
                            result = resume_one_url(
                                url,
                                &part_path,
                                req.kind,
                                req.size_hint,
                                cancel.clone(),
                                progress.clone(),
                            ) => result,
                        }
                    })
                };
                let first = resume();
                if offset > 0 && first.as_ref().is_err_and(|e| e == "resume: status 416") {
                    if !req.expected_sha256.is_empty()
                        && verify_download(&part_path, &req.expected_sha256, expected_size).is_ok()
                    {
                        Ok(())
                    } else {
                        std::fs::remove_file(&part_path).map_err(|e| e.to_string())?;
                        resume()
                    }
                } else {
                    first
                }
            } else {
                rt.block_on(download_one_url(
                    url,
                    &part_path,
                    conns,
                    req.kind,
                    req.size_hint,
                    cancel.clone(),
                    progress.clone(),
                ))
            };
            match outcome {
                Ok(()) => {
                    crate::logging::shell_log!(format!(
                        "download {} ok {}",
                        req.kind.as_str(),
                        url
                    ));
                    if let Some(ref root) = req.root {
                        crate::mirrors::note_success(root, url);
                        crate::telemetry::note_download(root, url, None);
                    }
                    if !req.expected_sha256.is_empty() {
                        if let Some(ref cb) = progress {
                            let len = part_path.metadata().map(|m| m.len()).unwrap_or(0);
                            cb(len, len.max(1), "verify");
                        }
                        if let Err(e) = verify_download(&part_path, &req.expected_sha256, expected_size) {
                            // 拿到的东西不对，续传更没意义 —— 整个丢掉换下一个源。
                            let _ = std::fs::remove_file(&part_path);
                            let _ = std::fs::remove_file(&tag_path);
                            resume_url.clear();
                            if let Some(ref root) = req.root {
                                crate::telemetry::note_download(root, url, Some(&e));
                            }
                            last_err = e;
                            continue;
                        }
                    }
                    if req.dest.is_file() {
                        let _ = std::fs::remove_file(&req.dest);
                    }
                    std::fs::rename(&part_path, &req.dest)
                        .map_err(|e| crate::i18n::te("s.fe9e98a65c", &(e)))?;
                    let _ = std::fs::remove_file(&tag_path);
                    if let Some(ref cb) = progress {
                        let len = req.dest.metadata().map(|m| m.len()).unwrap_or(0);
                        cb(len, len.max(1), "download");
                    }
                    return Ok(());
                }
                Err(e) => {
                    crate::logging::shell_log!(format!(
                        "download {} fail {}: {e}",
                        req.kind.as_str(),
                        url
                    ));
                    if e == crate::i18n::t("s.a5ffdc95ee")
                        || e.to_ascii_lowercase().contains("cancel")
                    {
                        // 取消：把半截留着，下次点安装能接着下。
                        return Err(e);
                    }
                    if let Some(ref root) = req.root {
                        crate::telemetry::note_download(root, url, Some(&e));
                    }
                    // 续传路径下失败**不删** `.part` —— 那正是它存在的意义。
                    // ripget 那条留下的是预分配的稀疏文件，必须删。
                    if !use_resume {
                        let _ = std::fs::remove_file(&part_path);
                        let _ = std::fs::remove_file(&tag_path);
                    }
                    let transient = is_transient_download_error(&e);
                    saw_transient |= transient;
                    if ["status 401", "status 403", "status 404", "status 410"]
                        .iter()
                        .any(|status| e.contains(status))
                    {
                        unavailable.push(url.clone());
                    }
                    last_err = e;
                }
            }
        }
        if last_err.is_empty() {
            break;
        }
        if !saw_transient || attempt >= MAX_TRANSIENT_ATTEMPTS {
            break;
        }
        crate::logging::shell_log!(format!(
            "download retry {attempt}/{MAX_TRANSIENT_ATTEMPTS} after: {last_err}"
        ));
        if let Some(ref cb) = progress {
            let have = if resume_url.is_empty() {
                0
            } else {
                part_path.metadata().map(|m| m.len()).unwrap_or(0)
            };
            cb(have, req.size_hint.max(have).max(1), &retry_phase(attempt));
        }
        wait_retry(&cancel)?;
    }
    if last_err.is_empty() {
        return Err(crate::i18n::t("s.e0dab22b1a"));
    }
    // 试过哪些站。用户手上只有一个「下载失败」的时候，最想知道的第一件事
    // 就是「它到底试没试过别的源」—— 不写出来，看起来就像我们只有一个源。
    let mut hosts: Vec<String> = Vec::new();
    for u in &urls {
        let h = crate::mirrors::host_of(u);
        if !h.is_empty() && !hosts.iter().any(|x| *x == h) {
            hosts.push(h);
        }
    }
    Err(download_error_text(&last_err, attempt, &hosts))
}

async fn download_one_url(
    url: &str,
    dest: &Path,
    threads: usize,
    kind: DownloadKind,
    size_hint: u64,
    cancel: Arc<AtomicBool>,
    progress: Option<ProgressFn>,
) -> Result<(), String> {
    let got_bytes = Arc::new(AtomicBool::new(false));
    // Always attach a reporter so first-byte timeout can see real traffic,
    // even when the caller did not pass a UI callback (index files, etc.).
    let track: ProgressFn = {
        let flag = got_bytes.clone();
        Arc::new(move |done, total, phase| {
            if done > 0 {
                flag.store(true, Ordering::SeqCst);
            }
            if let Some(ref cb) = progress {
                cb(done, total, phase);
            }
        })
    };
    let progress_handle: ripget::Progress = Arc::new(ProgressBridge {
        cb: track,
        total: AtomicU64::new(size_hint),
        done: AtomicU64::new(0),
        threads: AtomicU64::new(threads as u64),
        kind,
        cancel: cancel.clone(),
        size_hint,
        last_emit_ms: AtomicU64::new(0),
        started_ms: AtomicU64::new(0),
    });

    let options = DownloadOptions::new()
        .threads(threads)
        .user_agent(UA.to_string())
        .progress(progress_handle);

    // Cancel / first-byte timeout: poll and abort by dropping the future.
    let download = ripget::download_url_with_options(url, dest, options);
    tokio::pin!(download);

    let first_byte_wait = wait_first_byte_or_timeout(got_bytes, cancel.clone());
    tokio::pin!(first_byte_wait);

    tokio::select! {
        biased;
        _ = wait_for_cancel(&cancel) => {
            Err(crate::i18n::t("s.a5ffdc95ee").into())
        }
        timed_out = &mut first_byte_wait => {
            timed_out
        }
        res = &mut download => {
            res.map(|_| ()).map_err(|e| format!("ripget: {e}"))
        }
    }
}

async fn wait_for_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Completes only when the first byte never arrives in time. After bytes
/// start flowing this future parks so the download branch can finish.
async fn wait_first_byte_or_timeout(
    got_bytes: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + FIRST_BYTE_TIMEOUT;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(crate::i18n::t("s.a5ffdc95ee"));
        }
        if got_bytes.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(FIRST_BYTE_TIMEOUT_ERR.to_string());
        }
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        tokio::time::sleep(left.min(Duration::from_millis(200))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_follow_catalog_order_through_http_errors_hash_errors_and_redirects() {
        let empty = Duration::ZERO;
        let (base, server) = mirror_fixture(vec![
            ("/403", "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), empty),
            ("/404", "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), empty),
            ("/503", "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), empty),
            ("/bad-hash", "HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nwrong fabric".into(), empty),
            ("/bad-size", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nshort".into(), empty),
            ("/redirect", "HTTP/1.1 302 Found\r\nLocation: {cdn}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), empty),
            ("/cdn", "HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nhello fabric".into(), empty),
        ]);
        let req = mirror_request(&base, &["/403", "/404", "/503", "/bad-hash", "/bad-size", "/redirect", "/unused"], "mirror-order");
        let dest = req.dest.clone();
        let result = download_request(req, Arc::new(AtomicBool::new(false)), None);
        server.join().unwrap();
        result.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello fabric");
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }

    #[test]
    fn first_byte_timeout_tries_the_next_catalog_url() {
        let (base, server) = mirror_fixture(vec![
            ("/timeout", String::new(), FIRST_BYTE_TIMEOUT + Duration::from_millis(100)),
            ("/next", "HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nhello fabric".into(), Duration::ZERO),
        ]);
        let req = mirror_request(&base, &["/timeout", "/next"], "mirror-timeout");
        let dest = req.dest.clone();
        let result = download_request(req, Arc::new(AtomicBool::new(false)), None);
        server.join().unwrap();
        result.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello fabric");
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }

    #[test]
    fn resumed_fallback_does_not_override_catalog_priority() {
        let (base, server) = mirror_fixture(vec![
            ("/first", "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), Duration::ZERO),
            ("/resume", "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 5-11/12\r\nConnection: close\r\n\r\n fabric".into(), Duration::ZERO),
        ]);
        let req = mirror_request(&base, &["/first", "/resume"], "mirror-priority");
        let dest = req.dest.clone();
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(suffixed(&dest, ".part"), b"hello").unwrap();
        std::fs::write(suffixed(&dest, ".part.src"), &req.urls[1]).unwrap();
        let result = download_request(req, Arc::new(AtomicBool::new(false)), None);
        server.join().unwrap();
        result.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello fabric");
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }

    #[test]
    fn interrupted_stream_switches_mirror_and_keeps_verified_prefix() {
        let (base, server) = mirror_fixture(vec![
            ("/drop", "HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nhello".into(), Duration::ZERO),
            ("/next", "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 5-11/12\r\nConnection: close\r\n\r\n fabric".into(), Duration::ZERO),
        ]);
        let req = mirror_request(&base, &["/drop", "/next"], "mirror-partial");
        let dest = req.dest.clone();
        let result = download_request(req, Arc::new(AtomicBool::new(false)), None);
        server.join().unwrap();
        result.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello fabric");
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }

    #[test]
    fn catalog_size_is_checked_even_with_a_valid_checksum() {
        let path = crate::testutil::scratch("download-size");
        std::fs::write(&path, b"hello fabric").unwrap();
        let sha = format!("{:x}", Sha256::digest(b"hello fabric"));
        assert!(verify_download(&path, &sha, 13).unwrap_err().contains("size mismatch"));
        assert!(verify_download(&path, &sha, 12).is_ok());
        assert!(verify_download(&path, &"0".repeat(64), 12).is_err());
        std::fs::remove_file(path).unwrap();
    }


    #[test]
    fn setup_download_resumes_after_the_first_connection_drops() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::{Ipv4Addr, TcpListener};

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for (expected_range, response) in [
                (
                    None,
                    "HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nhello",
                ),
                (
                    Some("range: bytes=5-"),
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 5-11/12\r\nConnection: close\r\n\r\n fabric",
                ),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut reader = BufReader::new(&stream);
                let mut range = None;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    let line = line.trim().to_ascii_lowercase();
                    if line.starts_with("range:") {
                        range = Some(line);
                    }
                }
                assert_eq!(range.as_deref(), expected_range);
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let dir = crate::testutil::scratch("setup-download-resume");
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("runtime.tar");
        download_request(
            DownloadRequest {
                urls: vec![format!("http://{address}/runtime.tar")],
                root: None,
                dest: dest.clone(),
                expected_sha256: format!("{:x}", Sha256::digest(b"hello fabric")),
                size_hint: 12,
                connections: Some(16),
                kind: DownloadKind::Runtime,
            },
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello fabric");
        assert!(!suffixed(&dest, ".part.src").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resume_requires_the_requested_start_offset() {
        assert_eq!(resume_range("bytes 10-19/20", 10), Some((20, 20)));
        assert_eq!(resume_range("bytes 0-19/20", 10), None);
        assert_eq!(resume_range("bytes 10-20/20", 10), None);
    }

    #[test]
    fn connections_back_off_across_retries() {
        // 有些镜像不是挂了，是被 32 路并发打到限流。同并发重试五轮全是白费。
        assert_eq!(connections_for_attempt(32, 1), 32);
        assert_eq!(connections_for_attempt(32, 2), 8);
        assert_eq!(connections_for_attempt(32, 3), 1);
        assert_eq!(connections_for_attempt(32, 5), 1);
        // 本来就只有一条连接的小文件，不该被「退让」抬上去
        assert_eq!(connections_for_attempt(1, 2), 1);
        assert_eq!(connections_for_attempt(4, 2), 4);
    }

    #[test]
    fn a_stale_partial_is_only_kept_with_a_matching_tag() {
        // `.part` 单看是分不出「续传攒下的前缀」和「ripget 预分配的空壳」的，
        // 所以只认标记文件。
        let urls = vec![
            "https://a.cn/p.zip".to_string(),
            "https://b.cn/p.zip".to_string(),
        ];
        assert_eq!(
            resumable_from("https://a.cn/p.zip", &urls, 1024),
            Some("https://a.cn/p.zip".to_string())
        );
        // 标记指向这次不用的源：接在别人的字节后面，最后 sha256 才发现，白下一遍
        assert_eq!(resumable_from("https://c.cn/p.zip", &urls, 1024), None);
        // 没标记 = ripget 留下的空壳，或者根本没下过
        assert_eq!(resumable_from("", &urls, 1024), None);
        // 空文件没什么可续的，还多一个 Range 往返
        assert_eq!(resumable_from("https://a.cn/p.zip", &urls, 0), None);
    }

    #[test]
    fn part_and_tag_sit_next_to_the_destination() {
        let dest = std::path::Path::new("/tmp/x/pack.zip");
        assert_eq!(
            suffixed(dest, ".part").file_name().unwrap(),
            "pack.zip.part"
        );
        assert_eq!(
            suffixed(dest, ".part.src").file_name().unwrap(),
            "pack.zip.part.src"
        );
    }

    #[test]
    fn auto_connections_scales() {
        assert_eq!(auto_connections(1024), 1);
        assert_eq!(auto_connections(20 * 1024 * 1024), 8);
        assert!(auto_connections(2 * 1024 * 1024 * 1024) >= 12);
        assert!(auto_connections(8 * 1024 * 1024 * 1024) <= MAX_CONNECTIONS);
    }

    #[test]
    fn cnb_500_is_transient() {
        let e = "ripget: unexpected HTTP status 500 Internal Server Error for \
                 https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases/-/releases/download/\
                 GSV-runtime/runtime-nvidia-2026.07.21.tar";
        assert!(is_transient_download_error(e));
        assert!(is_transient_download_error(
            "ripget: unexpected HTTP status 502 Bad Gateway for https://cnb.cool/x"
        ));
        assert!(is_transient_download_error("error sending request for url"));
        assert!(is_transient_download_error("os error 10054"));
        assert!(is_transient_download_error(FIRST_BYTE_TIMEOUT_ERR));
    }

    #[test]
    fn progress_percent_keeps_fractions() {
        // 100 KiB of an 80 MiB pack used to cast to integer 0%.
        let p = progress_percent(100 * 1024, 80 * 1024 * 1024);
        assert!(p > 0.1 && p < 0.2, "{p}");
        assert_eq!(progress_percent(0, 1), 0.0);
        assert_eq!(progress_percent(50, 0), 0.0);
        assert!((progress_percent(1, 1) - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn permanent_errors_are_not_retried() {
        assert!(!is_transient_download_error(
            "ripget: unexpected HTTP status 404 Not Found for https://cnb.cool/x"
        ));
        assert!(!is_transient_download_error(
            "ripget: unexpected HTTP status 403 Forbidden for https://cnb.cool/x"
        ));
        assert!(!is_transient_download_error("已取消"));
        assert!(!is_transient_download_error("cancelled by user"));
        assert!(!is_transient_download_error(
            "sha256 mismatch: expected abc got def"
        ));
    }

    #[test]
    fn retry_phase_roundtrip() {
        assert_eq!(retry_phase(3), "retry:3");
        assert_eq!(parse_retry_attempt("retry:3"), Some(3));
        assert_eq!(parse_retry_attempt("retry"), None);
        assert_eq!(parse_retry_attempt("download"), None);
    }

    /// 下面这些是真实报错原文（日志里抄来的）。归类错一条，用户就会被指去
    /// 修一件跟他的问题无关的事 —— 磁盘满了却让他换代理，比不解释更糟。
    #[test]
    fn an_unclassified_error_keeps_its_original_text() {
        let text = download_error_text("tokio runtime: boom", 1, &[]);
        assert!(text.contains("tokio runtime: boom"));
    }

    /// 试过哪些源要写出来。只报一句「下载失败」的话，看起来就像我们压根
    /// 只有一个源、一次没成就放弃了。
    #[test]
    fn the_message_names_the_hosts_it_tried() {
        let hosts = vec!["cnb.cool".to_string(), "hf-mirror.com".to_string()];
        let text = download_error_text("os error 10060", 3, &hosts);
        assert!(text.contains("cnb.cool"));
        assert!(text.contains("hf-mirror.com"));
        // 技术细节留在末尾：用户反馈时贴的就是这一整段。
        assert!(text.contains("os error 10060"));
    }

    fn mirror_fixture(
        responses: Vec<(&'static str, String, Duration)>,
    ) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, BufReader, Write};
        use std::net::{Ipv4Addr, TcpListener};

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let base = format!("http://{address}");
        let thread = std::thread::spawn(move || {
            for (path, response, delay) in responses {
                let start = std::time::Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
                            && start.elapsed() < Duration::from_secs(5) => {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("missing request {path}: {error}"),
                    }
                };
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut reader = BufReader::new(&stream);
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert_eq!(first.split_whitespace().nth(1), Some(path));
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() { break; }
                    let lower = line.to_ascii_lowercase();
                    assert!(!["authorization:", "cookie:", "proxy-authorization:"]
                        .iter().any(|header| lower.starts_with(header)));
                }
                std::thread::sleep(delay);
                let response = response.replace("{cdn}", &format!("http://localhost:{}/cdn", address.port()));
                // A deliberately timed-out request may already have closed its socket.
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (base, thread)
    }

    fn mirror_request(base: &str, paths: &[&str], tag: &str) -> DownloadRequest {
        DownloadRequest {
            urls: paths.iter().map(|path| format!("{base}{path}")).collect(),
            root: None,
            dest: crate::testutil::scratch(tag).join("runtime.tar"),
            expected_sha256: format!("{:x}", Sha256::digest(b"hello fabric")),
            size_hint: 12,
            connections: Some(1),
            kind: DownloadKind::Runtime,
        }
    }

}
