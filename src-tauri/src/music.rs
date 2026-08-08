//! Music import queue — ported from ghostwire.
//!
//! Spotify (and other music-service) links — playlists, albums, artists, single
//! tracks — are queued here and downloaded via the external `spotiflac` CLI by a
//! background worker. Jobs persist to `<app-data>/music-imports.json` so a large
//! import resumes after a restart (SpotiFLAC skips tracks already on disk). The
//! frontend surfaces the queue in the downloads popover.
//!
//! Downloads land in the app's music folder (passed per-job from the frontend),
//! so the library indexer picks them up on the next rescan.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncBufReadExt;

/// Queue snapshots are broadcast on this event; the frontend listens and renders.
const MUSIC_IMPORTS_EVENT: &str = "music-imports://state";
/// Raw SpotiFLAC stdout/stderr lines, for a live log if the UI wants one.
const SPOTIFLAC_OUTPUT_EVENT: &str = "spotiflac://output";
/// Kill + flag an import as stalled if no new track lands for this long.
const MUSIC_IMPORT_STALL_SECS: u64 = 180;
/// A lone downloaded track shorter than this is treated as a provider preview clip.
const PREVIEW_MAX_SECS: f64 = 35.0;
/// How many imports may download at once.
const MUSIC_IMPORT_CONCURRENCY: usize = 3;

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "flac", "wav", "aiff", "aif", "ogg", "oga", "opus", "wma",
];

/// Every audio provider the bundled SpotiFLAC build accepts for `--service`.
const SPOTIFLAC_SERVICES: &[&str] = &[
    "tidal", "qobuz", "deezer", "amazon", "joox", "netease", "migu", "kuwo", "soundcloud",
    "youtube", "apple", "pandora", "flacdownloader",
];

// ============================================================================
// SpotiFLAC CLI resolution + install
// ============================================================================

struct SpotiFlacCmd {
    program: PathBuf,
    fixed_args: Vec<String>,
}

fn find_bin(name: &str) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        let mut extra = vec![home.join(".local/bin")];
        if let Ok(lib_py) = std::fs::read_dir(home.join("Library/Python")) {
            for dir in lib_py.flatten() {
                let p = dir.path().join("bin");
                if p.is_dir() {
                    extra.push(p);
                }
            }
        }
        for dir in extra {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_spotiflac() -> Option<SpotiFlacCmd> {
    find_bin("spotiflac").map(|program| SpotiFlacCmd {
        program,
        fixed_args: Vec::new(),
    })
}

fn render_command(program: &Path, fixed_args: &[String], args: &[String]) -> String {
    let mut parts = vec![program.display().to_string()];
    parts.extend(fixed_args.iter().cloned());
    parts.extend(args.iter().cloned());
    parts
        .into_iter()
        .map(|part| {
            if part.chars().any(char::is_whitespace) {
                format!("\"{}\"", part.replace('"', "\\\""))
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn system_path_for_installs() -> std::ffi::OsString {
    let mut parts: Vec<PathBuf> = std::env::var_os("PATH")
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect();
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        parts.push(home.join(".local/bin"));
        parts.push(PathBuf::from("/opt/homebrew/bin"));
        parts.push(PathBuf::from("/usr/local/bin"));
        parts.push(PathBuf::from("/usr/bin"));
        if let Ok(lib_py) = std::fs::read_dir(home.join("Library/Python")) {
            for dir in lib_py.flatten() {
                let p = dir.path().join("bin");
                if p.is_dir() {
                    parts.push(p);
                }
            }
        }
    }
    let mut uniq: Vec<PathBuf> = Vec::new();
    for part in parts {
        if !uniq.iter().any(|p| p == &part) {
            uniq.push(part);
        }
    }
    std::env::join_paths(uniq).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn preferred_python_for_install() -> Option<PathBuf> {
    for candidate in [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/opt/homebrew/bin/python",
        "/usr/local/bin/python",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    find_bin("python3")
        .filter(|p| p != Path::new("/usr/bin/python3"))
        .or_else(|| find_bin("python").filter(|p| p != Path::new("/usr/bin/python")))
        .or_else(|| find_bin("python3"))
        .or_else(|| find_bin("python"))
}

fn install_attempts() -> Vec<(String, Vec<String>)> {
    let mut cmds = Vec::new();
    if let Some(pipx) = find_bin("pipx") {
        cmds.push((
            pipx.display().to_string(),
            vec!["install".to_string(), "--force".to_string(), "SpotiFLAC".to_string()],
        ));
    }
    if let Some(py) = preferred_python_for_install() {
        cmds.push((
            py.display().to_string(),
            vec![
                "-m".to_string(),
                "pip".to_string(),
                "install".to_string(),
                "--user".to_string(),
                "--upgrade".to_string(),
                "SpotiFLAC".to_string(),
            ],
        ));
    }
    cmds
}

async fn run_install_capture(
    program: String,
    args: Vec<String>,
    path: std::ffi::OsString,
    max_lines: usize,
) -> Result<(bool, String, String, String), String> {
    let rendered = render_command(Path::new(&program), &[], &args);
    let out = tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&program);
        command.env("PATH", &path);
        command.args(&args);
        command.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = tail_lines(&String::from_utf8_lossy(&out.stdout), max_lines);
    let stderr = tail_lines(&String::from_utf8_lossy(&out.stderr), max_lines);
    Ok((out.status.success(), rendered, stdout, stderr))
}

fn tail_lines(s: &str, max: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n").trim().to_string()
}

fn tail_vec_lines(lines: &[String], max: usize) -> String {
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n").trim().to_string()
}

// ============================================================================
// Serialized types shared with the frontend
// ============================================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MusicSpotiFlacStatus {
    available: bool,
    command: Option<String>,
    output_dir: String,
    hint: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MusicSpotiFlacInstallResult {
    command: String,
    resolved_command: Option<String>,
    stdout: String,
    stderr: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MusicSpotiFlacOutput {
    stream: String,
    line: String,
    completed_files: Option<usize>,
}

/// Resolved SpotiFLAC download settings. Sensible credential-free defaults.
struct SpotiflacConfig {
    services: Vec<String>,
    quality: String,
    retries: u32,
    timeout: Option<u32>,
    lyrics: bool,
    enrich: bool,
    tidal_api: Option<String>,
    qobuz_api: Option<String>,
}

impl Default for SpotiflacConfig {
    fn default() -> Self {
        SpotiflacConfig {
            services: normalize_services(""),
            quality: "LOSSLESS".to_string(),
            retries: 2,
            timeout: Some(120),
            lyrics: true,
            enrich: true,
            tidal_api: None,
            qobuz_api: None,
        }
    }
}

/// User-facing download settings, persisted and edited from the Settings modal.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MusicSettings {
    /// LOSSLESS | HI_RES_LOSSLESS | HIGH | LOW.
    quality: String,
    /// Provider priority, space/comma separated (e.g. "tidal qobuz youtube").
    services: String,
    retries: u32,
    /// Per-track cap in seconds; 0 means no limit.
    timeout: u32,
    lyrics: bool,
    enrich: bool,
}

impl Default for MusicSettings {
    fn default() -> Self {
        MusicSettings {
            quality: "LOSSLESS".to_string(),
            services: "tidal qobuz youtube".to_string(),
            retries: 2,
            timeout: 120,
            lyrics: true,
            enrich: true,
        }
    }
}

fn config_from_settings(s: &MusicSettings) -> SpotiflacConfig {
    SpotiflacConfig {
        services: normalize_services(&s.services),
        quality: if s.quality.trim().is_empty() {
            "LOSSLESS".to_string()
        } else {
            s.quality.trim().to_string()
        },
        retries: s.retries.min(10),
        timeout: (s.timeout > 0).then_some(s.timeout),
        lyrics: s.lyrics,
        enrich: s.enrich,
        tidal_api: None,
        qobuz_api: None,
    }
}

/// Parse a space/comma separated priority list into a validated, de-duped provider
/// list. Falls back to a robust lossless-first chain when empty/unrecognised.
fn normalize_services(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tok in raw.split(|c: char| c.is_whitespace() || c == ',') {
        let t = tok.trim().to_ascii_lowercase();
        if !t.is_empty() && SPOTIFLAC_SERVICES.contains(&t.as_str()) && !out.contains(&t) {
            out.push(t);
        }
    }
    if out.is_empty() {
        // Deezer is deliberately excluded: without an account it serves 30s previews.
        out = ["tidal", "qobuz", "youtube"].iter().map(|s| s.to_string()).collect();
    }
    out
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MusicImportJob {
    id: String,
    url: String,
    /// playlist | album | artist | track | link
    kind: String,
    title: String,
    service: String,
    quality: String,
    total: Option<u32>,
    completed: u32,
    /// queued | downloading | done | error
    state: String,
    error: Option<String>,
    created_at: i64,
    #[serde(default)]
    artwork_url: Option<String>,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    current_track: Option<String>,
    /// Track titles for an album/playlist, in order — the per-song sub-list.
    #[serde(default)]
    tracks: Vec<String>,
    /// 0-based index of the track currently downloading, if any.
    #[serde(default)]
    current_index: Option<u32>,
    /// Where this job's files are written (the app's music folder at enqueue time).
    #[serde(default)]
    output_dir: String,
    /// Every file this job downloaded - absolute paths, in filename order.
    /// This is what lets a server-connected client upload exactly what an
    /// import produced instead of guessing from the folder. Empty on jobs
    /// from before the field existed, which the uploader reads as "nothing
    /// to send" rather than "send the whole folder".
    #[serde(default)]
    files: Vec<String>,
}

// ============================================================================
// Import manager
// ============================================================================

pub struct MusicImportManager {
    jobs: tokio::sync::Mutex<Vec<MusicImportJob>>,
    notify: tokio::sync::Notify,
    persist_path: PathBuf,
    app: AppHandle,
    fallback_dir: PathBuf,
    claimed: tokio::sync::Mutex<HashSet<String>>,
    flush: tokio::sync::Notify,
    cancels: tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// Download settings, read fresh per job so edits apply to the queue too.
    settings: tokio::sync::Mutex<MusicSettings>,
    settings_path: PathBuf,
    /// When set, the worker stops pulling new jobs (in-flight ones finish).
    paused: AtomicBool,
}

impl MusicImportManager {
    async fn snapshot(&self) -> Vec<MusicImportJob> {
        self.jobs.lock().await.clone()
    }

    async fn flush_now(&self) {
        let jobs = self.jobs.lock().await.clone();
        let _ = self.app.emit(MUSIC_IMPORTS_EVENT, &jobs);
        let path = self.persist_path.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(json) = serde_json::to_string(&jobs) {
                let _ = std::fs::write(&path, json);
            }
        })
        .await;
    }

    fn request_flush(&self) {
        self.flush.notify_one();
    }
}

async fn music_import_flusher(manager: Arc<MusicImportManager>) {
    loop {
        manager.flush.notified().await;
        tokio::time::sleep(Duration::from_millis(350)).await;
        manager.flush_now().await;
    }
}

fn load_music_import_jobs(path: &Path) -> Vec<MusicImportJob> {
    let Ok(data) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut jobs: Vec<MusicImportJob> = serde_json::from_str(&data).unwrap_or_default();
    for job in jobs.iter_mut() {
        if job.state == "downloading" {
            job.state = "queued".to_string();
            job.error = None;
            job.current_track = None;
        }
    }
    // Collapse duplicate links, keeping the most-complete state per URL.
    let rank = |state: &str| -> u8 {
        match state {
            "done" => 3,
            "queued" | "downloading" => 2,
            "error" => 1,
            _ => 0,
        }
    };
    let mut order: Vec<String> = Vec::new();
    let mut by_url: HashMap<String, MusicImportJob> = HashMap::new();
    let mut passthrough: Vec<MusicImportJob> = Vec::new();
    for job in jobs {
        if job.url.is_empty() {
            passthrough.push(job);
            continue;
        }
        match by_url.get(&job.url) {
            Some(prev) if rank(&prev.state) >= rank(&job.state) => {}
            Some(_) => {
                by_url.insert(job.url.clone(), job);
            }
            None => {
                order.push(job.url.clone());
                by_url.insert(job.url.clone(), job);
            }
        }
    }
    let mut deduped: Vec<MusicImportJob> =
        order.into_iter().filter_map(|u| by_url.remove(&u)).collect();
    deduped.extend(passthrough);
    deduped
}

fn music_import_random_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}{n:x}")
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn detect_music_import_kind(url: &str) -> &'static str {
    let u = url.to_ascii_lowercase();
    if u.contains("/playlist/") || u.contains("spotify:playlist:") {
        "playlist"
    } else if u.contains("/album/") || u.contains("spotify:album:") {
        "album"
    } else if u.contains("/artist/") || u.contains("spotify:artist:") {
        "artist"
    } else if u.contains("/track/") || u.contains("spotify:track:") {
        "track"
    } else {
        "link"
    }
}

fn default_music_import_title(kind: &str) -> String {
    match kind {
        "playlist" => "Spotify playlist",
        "album" => "Spotify album",
        "artist" => "Spotify artist",
        "track" => "Spotify track",
        _ => "Music import",
    }
    .to_string()
}

fn music_import_kind_label(kind: &str) -> String {
    match kind {
        "playlist" => "Spotify playlist",
        "album" => "Spotify album",
        "artist" => "Spotify artist",
        "track" => "Spotify track",
        _ => "Music link",
    }
    .to_string()
}

// ============================================================================
// Output-folder scanning + per-job file claiming
// ============================================================================

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn current_music_file_set(root: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    fn walk(dir: &Path, out: &mut HashSet<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("._") || name == ".DS_Store" {
                continue;
            }
            if path.is_dir() {
                walk(&path, out);
            } else if is_audio(&path) {
                out.insert(path.to_string_lossy().to_string());
            }
        }
    }
    walk(root, &mut out);
    out
}

async fn claim_new_music_files(
    manager: &MusicImportManager,
    root: &Path,
    baseline: &HashSet<String>,
    my_files: &Arc<tokio::sync::Mutex<HashSet<String>>>,
) -> (u32, Option<String>) {
    {
        let current = current_music_file_set(root);
        let mut mine = my_files.lock().await;
        let mut claimed = manager.claimed.lock().await;
        for path in current {
            if baseline.contains(&path) || mine.contains(&path) || claimed.contains(&path) {
                continue;
            }
            claimed.insert(path.clone());
            mine.insert(path);
        }
    }
    let mine = my_files.lock().await;
    let mut newest: Option<(SystemTime, String)> = None;
    for path in mine.iter() {
        if let Ok(modified) = std::fs::metadata(path).and_then(|m| m.modified()) {
            if newest.as_ref().map_or(true, |(t, _)| modified > *t) {
                newest = Some((modified, path.clone()));
            }
        }
    }
    (mine.len() as u32, newest.map(|(_, p)| p))
}

// ============================================================================
// Preview metadata (title / cover / total) via the public Spotify embed
// ============================================================================

const SPOTIFY_EMBED_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

fn parse_spotify_id(input: &str, kind: &str) -> Option<String> {
    let s = input.trim();
    let uri_prefix = format!("spotify:{kind}:");
    if let Some(rest) = s.strip_prefix(&uri_prefix) {
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        return (!id.is_empty()).then_some(id);
    }
    let path_marker = format!("/{kind}/");
    if let Some(idx) = s.find(&path_marker) {
        let rest = &s[idx + path_marker.len()..];
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        return (!id.is_empty()).then_some(id);
    }
    None
}

fn find_key<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(found) = m.get(key) {
                return Some(found);
            }
            m.values().find_map(|vv| find_key(vv, key))
        }
        serde_json::Value::Array(a) => a.iter().find_map(|vv| find_key(vv, key)),
        _ => None,
    }
}

/// Best-effort cover art + display name + track count for a public Spotify link,
/// scraped from the embed page (no auth). Returns (name, cover_url, track_count).
async fn fetch_embed_meta(
    link: &str,
    kind: &str,
) -> Result<(String, Option<String>, Option<u32>, Vec<String>), String> {
    let id = parse_spotify_id(link, kind).ok_or_else(|| "Unrecognized Spotify link.".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    let html = client
        .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
        .header("User-Agent", SPOTIFY_EMBED_UA)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let marker = html
        .find("__NEXT_DATA__")
        .ok_or_else(|| "Couldn't read Spotify embed metadata.".to_string())?;
    let json_start = html[marker..]
        .find('>')
        .map(|i| marker + i + 1)
        .ok_or("Couldn't parse the Spotify embed.")?;
    let json_end = html[json_start..]
        .find("</script>")
        .map(|i| json_start + i)
        .ok_or("Couldn't parse the Spotify embed.")?;
    let data: serde_json::Value = serde_json::from_str(html[json_start..json_end].trim())
        .map_err(|e| format!("Couldn't parse the Spotify embed: {e}"))?;

    let name = find_key(&data, "name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Spotify import".to_string());
    // The embed used to carry `coverArt.sources`; it now hangs the artwork off
    // `visualIdentity.image`, an array of sized variants. Prefer the largest,
    // falling back to the old shape for any link that still serves it.
    let cover = find_key(&data, "coverArt")
        .and_then(|c| c.pointer("/sources/0/url"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            find_key(&data, "visualIdentity")
                .and_then(|vi| vi.get("image"))
                .and_then(|img| img.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .filter_map(|it| {
                            let url = it.get("url")?.as_str()?;
                            let width = it.get("maxWidth").and_then(|v| v.as_u64()).unwrap_or(0);
                            Some((width, url.to_string()))
                        })
                        .max_by_key(|(width, _)| *width)
                        .map(|(_, url)| url)
                })
        });
    let track_list = find_key(&data, "trackList").and_then(|v| v.as_array());
    let total = track_list.map(|a| a.len() as u32).filter(|n| *n > 0);
    let titles = track_list
        .map(|a| {
            a.iter()
                .filter_map(|it| it.get("title").and_then(|t| t.as_str()).map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok((name, cover, total, titles))
}

async fn music_import_preview(
    url: &str,
    kind: &str,
) -> (String, Option<u32>, Option<String>, Vec<String>) {
    let mut title = default_music_import_title(kind);
    let mut total = None;
    let mut artwork = None;
    let mut titles = Vec::new();
    if matches!(kind, "playlist" | "album" | "artist" | "track") {
        if let Ok((name, cover, embed_total, embed_titles)) = fetch_embed_meta(url, kind).await {
            if !name.trim().is_empty() {
                title = name;
            }
            total = embed_total;
            artwork = cover;
            titles = embed_titles;
        }
    }
    (title, total, artwork, titles)
}

// ============================================================================
// SpotiFLAC output parsing
// ============================================================================

/// Parse a SpotiFLAC per-track header into `(position, total, "<title> — <artists>")`.
fn parse_spotiflac_track_header(line: &str) -> Option<(u32, u32, String)> {
    let rest = line.strip_prefix("Track [")?;
    let (frac, tail) = rest.split_once(']')?;
    let (pos_s, total_s) = frac.split_once('/')?;
    let position: u32 = pos_s.trim().parse().ok()?;
    let total: u32 = total_s.trim().parse().ok()?;
    let mut label = tail.trim().to_string();
    if label.ends_with(')') {
        if let Some(idx) = label.rfind(" (") {
            label.truncate(idx);
        }
    }
    let label = label.trim().to_string();
    if label.is_empty() {
        return None;
    }
    Some((position, total, label))
}

async fn drain_import_lines<R>(reader: R, lines: Arc<tokio::sync::Mutex<Vec<String>>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut reader = tokio::io::BufReader::new(reader).lines();
    while let Ok(Some(chunk)) = reader.next_line().await {
        // SpotiFLAC's tqdm bar overwrites with carriage returns, so one newline
        // can carry several `\r`-separated updates; split them out.
        for seg in chunk.split('\r') {
            let line = seg.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let mut out = lines.lock().await;
            out.push(line);
            if out.len() > 240 {
                let drop_n = out.len() - 240;
                out.drain(0..drop_n);
            }
        }
    }
}

async fn drain_import_progress<R>(
    reader: R,
    lines: Arc<tokio::sync::Mutex<Vec<String>>>,
    manager: Arc<MusicImportManager>,
    job_id: String,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut reader = tokio::io::BufReader::new(reader).lines();
    while let Ok(Some(chunk)) = reader.next_line().await {
        // Split the `\r`-glued tqdm updates so the `Track [n/total]` header the
        // progress bar overwrites is seen on its own.
        for seg in chunk.split('\r') {
            let line = seg.trim().to_string();
            if line.is_empty() {
                continue;
            }
            if let Some((position, total, label)) = parse_spotiflac_track_header(&line) {
                let mut changed = false;
                {
                    let mut jobs = manager.jobs.lock().await;
                    if let Some(job) = jobs.iter_mut().find(|j| j.id == job_id) {
                        if job.current_track.as_deref() != Some(label.as_str()) {
                            job.current_track = Some(label.clone());
                            changed = true;
                        }
                        if total > 0 && job.total != Some(total) {
                            job.total = Some(total);
                            changed = true;
                        }
                        let lead = position.saturating_sub(1);
                        if lead > job.completed {
                            job.completed = lead;
                            changed = true;
                        }
                        // Grow the per-song list to the real total, then fill this
                        // row's real title from the header (only over a placeholder,
                        // so embed-provided titles are kept).
                        while (job.tracks.len() as u32) < total {
                            let n = job.tracks.len() + 1;
                            job.tracks.push(format!("Track {n}"));
                            changed = true;
                        }
                        let idx = lead as usize;
                        if let Some(slot) = job.tracks.get_mut(idx) {
                            if *slot == format!("Track {}", idx + 1) {
                                *slot = label.clone();
                                changed = true;
                            }
                        }
                        if job.current_index != Some(lead) {
                            job.current_index = Some(lead);
                            changed = true;
                        }
                    }
                }
                if changed {
                    manager.request_flush();
                }
            }
            let mut out = lines.lock().await;
            out.push(line);
            if out.len() > 240 {
                let drop_n = out.len() - 240;
                out.drain(0..drop_n);
            }
        }
    }
}

/// Probe a media file's duration in seconds via ffprobe if it is on PATH.
async fn probe_duration_secs(path: &Path) -> Option<f64> {
    let ffprobe = find_bin("ffprobe")?;
    let out = tokio::process::Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|d| *d > 0.0)
}

// ============================================================================
// The per-job runner
// ============================================================================

/// Run SpotiFLAC for one queued import, updating `job.completed` as files land.
async fn run_music_import_job(
    manager: &Arc<MusicImportManager>,
    id: &str,
    url: &str,
    output_dir: PathBuf,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(u32, Vec<String>), String> {
    let app = manager.app.clone();
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let baseline_files = current_music_file_set(&output_dir);

    let cmd = resolve_spotiflac().ok_or_else(|| {
        "SpotiFLAC CLI not found. Install it first (pipx install SpotiFLAC), then relaunch AttackFM.".to_string()
    })?;
    let cfg = {
        let s = manager.settings.lock().await;
        config_from_settings(&s)
    };

    let mut args = vec![url.to_string(), output_dir.display().to_string()];
    args.push("--service".to_string());
    for svc in &cfg.services {
        args.push(svc.clone());
    }
    args.push("--quality".to_string());
    args.push(cfg.quality.clone());
    args.push("--use-artist-subfolders".to_string());
    args.push("--use-album-subfolders".to_string());
    args.push("--use-album-track-numbers".to_string());
    args.push("--first-artist-only".to_string());
    args.push("--filename-format".to_string());
    args.push("{track}. {title}".to_string());
    if cfg.retries > 0 {
        args.push("--retries".to_string());
        args.push(cfg.retries.to_string());
    }
    if let Some(secs) = cfg.timeout {
        args.push("--timeout".to_string());
        args.push(secs.to_string());
    }
    if !cfg.lyrics {
        args.push("--no-lyrics".to_string());
    }
    if !cfg.enrich {
        args.push("--no-enrich".to_string());
    }
    args.push("--verbose".to_string());
    if let Some(api) = &cfg.tidal_api {
        args.push("--tidal-api".to_string());
        args.push(api.clone());
    }
    if let Some(api) = &cfg.qobuz_api {
        args.push("--qobuz-local-api".to_string());
        args.push(api.clone());
    }
    let program = cmd.program.clone();
    let fixed_args = cmd.fixed_args.clone();

    let _ = app.emit(
        SPOTIFLAC_OUTPUT_EVENT,
        MusicSpotiFlacOutput {
            stream: "meta".to_string(),
            line: format!("Running: {}", render_command(&program, &fixed_args, &args)),
            completed_files: None,
        },
    );

    let my_files: Arc<tokio::sync::Mutex<HashSet<String>>> =
        Arc::new(tokio::sync::Mutex::new(HashSet::new()));
    let (kill_tx, mut kill_rx) = tokio::sync::oneshot::channel::<()>();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();

    let progress_manager = Arc::clone(manager);
    let progress_id = id.to_string();
    let progress_dir = output_dir.clone();
    let progress_baseline = baseline_files.clone();
    let progress_files = Arc::clone(&my_files);
    let progress_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(800));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last = u32::MAX;
        let mut last_progress = std::time::Instant::now();
        let mut kill_tx = Some(kill_tx);
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = interval.tick() => {
                    let (count, _track) = claim_new_music_files(
                        &progress_manager,
                        &progress_dir,
                        &progress_baseline,
                        &progress_files,
                    )
                    .await;
                    if count != last {
                        last_progress = std::time::Instant::now();
                        last = count;
                        {
                            let mut jobs = progress_manager.jobs.lock().await;
                            if let Some(job) = jobs.iter_mut().find(|j| j.id == progress_id) {
                                if count > job.completed {
                                    job.completed = count;
                                }
                            }
                        }
                        progress_manager.request_flush();
                    }
                    if last_progress.elapsed() >= Duration::from_secs(MUSIC_IMPORT_STALL_SECS) {
                        if let Some(tx) = kill_tx.take() {
                            let _ = tx.send(());
                        }
                    }
                }
            }
        }
    });

    let mut command = tokio::process::Command::new(&program);
    command.args(&fixed_args);
    command.args(&args);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            let _ = stop_tx.send(());
            let _ = progress_task.await;
            return Err(err.to_string());
        }
    };

    let stdout_lines = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let stderr_lines = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let stdout_task = child.stdout.take().map(|stdout| {
        let lines = stdout_lines.clone();
        tokio::spawn(async move { drain_import_lines(stdout, lines).await })
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        let lines = stderr_lines.clone();
        let progress_manager = Arc::clone(manager);
        let progress_id = id.to_string();
        tokio::spawn(async move {
            drain_import_progress(stderr, lines, progress_manager, progress_id).await
        })
    });

    {
        let mut jobs = manager.jobs.lock().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
            if job.current_track.is_none() {
                job.current_track = Some("Preparing download…".to_string());
            }
        }
    }
    manager.request_flush();

    let mut stalled = false;
    let mut cancelled = false;
    let wait = tokio::select! {
        s = child.wait() => Some(s),
        _ = &mut kill_rx => None,
        _ = &mut cancel_rx => { cancelled = true; None },
    };
    let status = match wait {
        Some(s) => s,
        None => {
            if !cancelled {
                stalled = true;
            }
            let _ = child.start_kill();
            child.wait().await
        }
    };
    if let Some(mut task) = stdout_task {
        if tokio::time::timeout(Duration::from_secs(3), &mut task).await.is_err() {
            task.abort();
        }
    }
    if let Some(mut task) = stderr_task {
        if tokio::time::timeout(Duration::from_secs(3), &mut task).await.is_err() {
            task.abort();
        }
    }
    let _ = stop_tx.send(());
    let _ = progress_task.await;

    let completed = claim_new_music_files(manager, &output_dir, &baseline_files, &my_files)
        .await
        .0;
    {
        let mine = my_files.lock().await;
        let mut claimed = manager.claimed.lock().await;
        for path in mine.iter() {
            claimed.remove(path);
        }
    }
    if cancelled {
        return Err("Canceled.".to_string());
    }
    let global_new = current_music_file_set(&output_dir)
        .into_iter()
        .filter(|p| !baseline_files.contains(p))
        .count() as u32;

    let stdout = {
        let lines = stdout_lines.lock().await;
        tail_vec_lines(&lines, 120)
    };
    let stderr = {
        let lines = stderr_lines.lock().await;
        tail_vec_lines(&lines, 120)
    };
    let build_detail = |fallback: &str| -> String {
        if !stderr.is_empty() {
            stderr.clone()
        } else if !stdout.is_empty() {
            stdout.clone()
        } else {
            fallback.to_string()
        }
    };

    // Preview guard: a lone ~30s result is a provider preview, not the song.
    if completed == 1 {
        let lone = { my_files.lock().await.iter().next().cloned() };
        if let Some(path) = lone {
            if let Some(dur) = probe_duration_secs(Path::new(&path)).await {
                if dur < PREVIEW_MAX_SECS {
                    let _ = std::fs::remove_file(&path);
                    {
                        let mut c = manager.claimed.lock().await;
                        c.remove(&path);
                    }
                    return Err(format!(
                        "Got a {dur:.0}s preview, not the full track. Retry to fetch it from another source."
                    ));
                }
            }
        }
    }

    if completed > 0 {
        // The files this run claimed, in filename order - the track-number
        // prefixes SpotiFLAC writes make that the album's own order.
        let mut files: Vec<String> = { my_files.lock().await.iter().cloned().collect() };
        files.sort();
        return Ok((completed, files));
    }
    if stalled {
        let detail = build_detail("No tracks were saved before the import stalled.");
        return Err(format!(
            "Download stalled — no progress for {MUSIC_IMPORT_STALL_SECS}s. Retry to resume. {detail}"
        ));
    }
    let status = status.map_err(|e| e.to_string())?;
    if !status.success() {
        let detail = build_detail(&format!("SpotiFLAC exited with status {:?}.", status.code()));
        return Err(format!("SpotiFLAC failed. {detail}"));
    }
    if global_new == 0 {
        let detail =
            build_detail("SpotiFLAC exited successfully, but no new music files were written.");
        return Err(format!("SpotiFLAC finished but saved no new files. {detail}"));
    }
    Ok((0, Vec::new()))
}

// ============================================================================
// Background scheduler
// ============================================================================

async fn music_import_worker(manager: Arc<MusicImportManager>) {
    let in_flight = Arc::new(AtomicUsize::new(0));
    loop {
        // Honour a paused queue: hold here until resumed (or something nudges us).
        if manager.paused.load(Ordering::Acquire) {
            manager.notify.notified().await;
            continue;
        }
        let limit = MUSIC_IMPORT_CONCURRENCY;
        let next = if in_flight.load(Ordering::Acquire) < limit {
            let mut jobs = manager.jobs.lock().await;
            match jobs.iter_mut().find(|j| j.state == "queued") {
                Some(job) => {
                    job.state = "downloading".to_string();
                    job.error = None;
                    job.current_track = None;
                    let dir = if job.output_dir.is_empty() {
                        manager.fallback_dir.display().to_string()
                    } else {
                        job.output_dir.clone()
                    };
                    Some((job.id.clone(), job.url.clone(), dir))
                }
                None => None,
            }
        } else {
            None
        };
        let Some((id, url, dir)) = next else {
            manager.notify.notified().await;
            continue;
        };
        manager.request_flush();

        in_flight.fetch_add(1, Ordering::AcqRel);
        let mgr = Arc::clone(&manager);
        let slots = Arc::clone(&in_flight);
        tokio::spawn(async move {
            let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
            mgr.cancels.lock().await.insert(id.clone(), cancel_tx);
            let result =
                run_music_import_job(&mgr, &id, &url, PathBuf::from(dir), cancel_rx).await;
            mgr.cancels.lock().await.remove(&id);
            {
                let mut jobs = mgr.jobs.lock().await;
                if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
                    match &result {
                        Ok((count, files)) => {
                            job.completed = (*count).max(job.completed);
                            if job.total.is_none() {
                                job.total = Some(job.completed);
                            }
                            job.state = "done".to_string();
                            job.error = None;
                            job.current_track = None;
                            job.current_index = None;
                            job.files = files.clone();
                        }
                        Err(err) => {
                            job.state = "error".to_string();
                            job.error = Some(err.clone());
                            job.current_track = None;
                            job.current_index = None;
                        }
                    }
                }
            }
            mgr.request_flush();
            slots.fetch_sub(1, Ordering::AcqRel);
            mgr.notify.notify_one();
        });
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command]
pub async fn music_import_enqueue(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    url: String,
    output_dir: Option<String>,
) -> Result<MusicImportJob, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Paste a music link first.".to_string());
    }
    {
        let jobs = manager.jobs.lock().await;
        if let Some(existing) = jobs
            .iter()
            .find(|j| j.url == url && (j.state == "queued" || j.state == "downloading"))
        {
            return Ok(existing.clone());
        }
    }
    let kind = detect_music_import_kind(&url);
    let (title, total, artwork_url, track_titles) = music_import_preview(&url, kind).await;
    let dir = output_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| manager.fallback_dir.display().to_string());
    let job = MusicImportJob {
        id: format!("import-{}", music_import_random_id()),
        url,
        kind: kind.to_string(),
        title,
        service: "youtube".to_string(),
        quality: "LOSSLESS".to_string(),
        total,
        completed: 0,
        state: "queued".to_string(),
        error: None,
        created_at: now_unix_secs(),
        artwork_url,
        subtitle: Some(music_import_kind_label(kind)),
        current_track: None,
        tracks: track_titles,
        current_index: None,
        output_dir: dir,
        files: Vec::new(),
    };
    {
        let mut jobs = manager.jobs.lock().await;
        jobs.push(job.clone());
    }
    manager.request_flush();
    manager.notify.notify_one();
    Ok(job)
}

#[tauri::command]
pub async fn music_imports_list(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
) -> Result<Vec<MusicImportJob>, String> {
    Ok(manager.snapshot().await)
}

#[tauri::command]
pub async fn music_import_remove(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    id: String,
) -> Result<(), String> {
    {
        let mut jobs = manager.jobs.lock().await;
        jobs.retain(|j| j.id != id || j.state == "downloading");
    }
    manager.request_flush();
    Ok(())
}

#[tauri::command]
pub async fn music_import_cancel(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    id: String,
) -> Result<(), String> {
    if let Some(tx) = manager.cancels.lock().await.remove(&id) {
        let _ = tx.send(());
    }
    {
        let mut jobs = manager.jobs.lock().await;
        jobs.retain(|j| j.id != id);
    }
    manager.request_flush();
    manager.notify.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn music_imports_clear(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    states: Vec<String>,
) -> Result<(), String> {
    {
        let mut jobs = manager.jobs.lock().await;
        jobs.retain(|j| j.state == "downloading" || !states.iter().any(|s| s == &j.state));
    }
    manager.request_flush();
    Ok(())
}

#[tauri::command]
pub async fn music_import_retry(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    id: String,
) -> Result<(), String> {
    {
        let mut jobs = manager.jobs.lock().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
            job.state = "queued".to_string();
            job.error = None;
        }
    }
    manager.request_flush();
    manager.notify.notify_one();
    Ok(())
}

#[tauri::command]
pub fn music_spotiflac_status(output_dir: Option<String>) -> MusicSpotiFlacStatus {
    let output_dir = output_dir.unwrap_or_default();
    match resolve_spotiflac() {
        Some(cmd) => MusicSpotiFlacStatus {
            available: true,
            command: Some(cmd.program.display().to_string()),
            output_dir,
            hint: None,
        },
        None => MusicSpotiFlacStatus {
            available: false,
            command: None,
            output_dir,
            hint: Some(
                "Install SpotiFLAC so AttackFM can launch `spotiflac` (for example: `pipx install SpotiFLAC`)."
                    .to_string(),
            ),
        },
    }
}

#[tauri::command]
pub async fn music_spotiflac_install() -> Result<MusicSpotiFlacInstallResult, String> {
    if let Some(cmd) = resolve_spotiflac() {
        return Ok(MusicSpotiFlacInstallResult {
            command: cmd.program.display().to_string(),
            resolved_command: Some(cmd.program.display().to_string()),
            stdout: "SpotiFLAC is already installed.".to_string(),
            stderr: String::new(),
        });
    }
    let path = system_path_for_installs();
    let mut failures = Vec::new();
    if find_bin("pipx").is_none() {
        if let Some(brew) = find_bin("brew") {
            let (ok, rendered, stdout, stderr) = run_install_capture(
                brew.display().to_string(),
                vec!["install".to_string(), "pipx".to_string()],
                path.clone(),
                40,
            )
            .await?;
            if !ok {
                let detail = if !stderr.is_empty() { stderr } else { stdout };
                failures.push(format!("{rendered}: {detail}"));
            }
        }
    }
    let attempts = install_attempts();
    if attempts.is_empty() {
        return Err("Couldn't find `pipx` or `python3`, so AttackFM can't install SpotiFLAC automatically.".to_string());
    }
    for (program, args) in attempts {
        let (ok, rendered, stdout, stderr) =
            run_install_capture(program, args, path.clone(), 40).await?;
        if ok {
            let resolved = resolve_spotiflac().map(|cmd| cmd.program.display().to_string());
            return Ok(MusicSpotiFlacInstallResult {
                command: rendered,
                resolved_command: resolved,
                stdout,
                stderr,
            });
        }
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        failures.push(format!("{rendered}: {detail}"));
    }
    Err(format!("SpotiFLAC install failed. {}", failures.join(" | ")))
}

#[tauri::command]
pub async fn music_import_get_settings(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
) -> Result<MusicSettings, String> {
    Ok(manager.settings.lock().await.clone())
}

#[tauri::command]
pub async fn music_import_set_settings(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    settings: MusicSettings,
) -> Result<(), String> {
    {
        let mut s = manager.settings.lock().await;
        *s = settings.clone();
    }
    let path = manager.settings_path.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(json) = serde_json::to_string(&settings) {
            let _ = std::fs::write(&path, json);
        }
    })
    .await;
    Ok(())
}

#[tauri::command]
pub fn music_import_set_paused(manager: tauri::State<'_, Arc<MusicImportManager>>, paused: bool) {
    manager.paused.store(paused, Ordering::Release);
    if !paused {
        manager.notify.notify_one();
    }
}

#[tauri::command]
pub fn music_import_paused(manager: tauri::State<'_, Arc<MusicImportManager>>) -> bool {
    manager.paused.load(Ordering::Acquire)
}

/// Look up a high-resolution album cover via the free iTunes Search API (no key,
/// server-side so there's no CORS). Embedded tags often carry only a tiny cover
/// that blurs when shown large; this returns a crisp 600px source, or null.
#[tauri::command]
pub async fn music_album_art(artist: String, album: String) -> Option<String> {
    let term = format!("{} {}", artist.trim(), album.trim());
    if term.trim().is_empty() {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let body = client
        .get("https://itunes.apple.com/search")
        .query(&[
            ("media", "music"),
            ("entity", "album"),
            ("limit", "1"),
            ("term", term.as_str()),
        ])
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let data: serde_json::Value = serde_json::from_str(&body).ok()?;
    let art = data.pointer("/results/0/artworkUrl100").and_then(|v| v.as_str())?;
    // The API returns a 100px thumb; bump the size token for a crisp cover.
    Some(art.replace("100x100bb", "600x600bb"))
}

// ============================================================================
// Setup
// ============================================================================

/// Build the import manager, load the persisted queue, register it as state, and
/// spawn the background flusher + worker. Call from the Tauri `setup` hook.
pub fn init(app: &AppHandle) {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&data_dir);
    let persist_path = data_dir.join("music-imports.json");

    // Downloads default here when a job carries no folder of its own.
    let fallback_dir = app
        .path()
        .audio_dir()
        .map(|p| p.join("AttackFM"))
        .unwrap_or_else(|_| data_dir.join("AttackFM"));

    let jobs = load_music_import_jobs(&persist_path);
    let has_queued = jobs.iter().any(|j| j.state == "queued");

    let settings_path = data_dir.join("music-settings.json");
    let settings = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|d| serde_json::from_str::<MusicSettings>(&d).ok())
        .unwrap_or_default();

    let manager = Arc::new(MusicImportManager {
        jobs: tokio::sync::Mutex::new(jobs),
        notify: tokio::sync::Notify::new(),
        persist_path,
        app: app.clone(),
        fallback_dir,
        claimed: tokio::sync::Mutex::new(HashSet::new()),
        flush: tokio::sync::Notify::new(),
        cancels: tokio::sync::Mutex::new(HashMap::new()),
        settings: tokio::sync::Mutex::new(settings),
        settings_path,
        paused: AtomicBool::new(false),
    });

    app.manage(Arc::clone(&manager));

    tauri::async_runtime::spawn(music_import_flusher(Arc::clone(&manager)));
    tauri::async_runtime::spawn(music_import_worker(Arc::clone(&manager)));
    if has_queued {
        manager.notify.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::parse_spotiflac_track_header;

    #[test]
    fn parses_track_header() {
        assert_eq!(
            parse_spotiflac_track_header(
                "Track [3/12] Bohemian Rhapsody — Queen (A Night at the Opera)"
            ),
            Some((3, 12, "Bohemian Rhapsody — Queen".to_string()))
        );
    }

    #[test]
    fn ignores_noise() {
        assert!(parse_spotiflac_track_header("DEBUG:httpcore: connect").is_none());
    }
}
