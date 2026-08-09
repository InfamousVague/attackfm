//! Music imports, run where the music lives.
//!
//! The desktop app's importer drives SpotiFLAC as a local subprocess - a thing
//! a phone can never do (iOS forbids spawned executables). Here the same
//! engine runs on the server instead: any signed-in device enqueues a link,
//! this module downloads it into a per-job staging directory, and finished
//! files flow through the SAME tag-routing and indexing pipeline uploads use
//! (upload::destination_for / unique_destination / scan::scan_one). The
//! catalog rev bumps as each track lands, so every device - the one that
//! asked and all the others - sees the album arrive through its ordinary
//! delta sync. Files are born on the hub; nothing needs uploading afterward.
//!
//! Per-job staging (data/imports/<id>/) is what keeps this simple: everything
//! in the directory belongs to the job, so there is no cross-job file
//! claiming, and a partial download never touches the music root.

use crate::auth;
use crate::scan;
use crate::upload;
use crate::AppState;
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STALL_SECS: u64 = 180;
// One at a time. Imports are a rare, human-paced action, and serial filing
// means two jobs can never race on the same tag-derived destination in the
// shared music library - the concurrency was never worth that risk.
const CONCURRENCY: usize = 1;

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "flac", "wav", "aiff", "aif", "ogg", "oga", "opus",
];

/// Provider priority handed to SpotiFLAC; overridable per deployment via
/// AFM_IMPORT_SERVICES. Deezer leads because it downloads real lossless with
/// no API key or self-hosted endpoint - Tidal and Qobuz need a configured
/// hifi-api / local API, and YouTube's public scraper backends come and go.
/// The rest trail as fallbacks for tracks Deezer does not carry.
fn services() -> Vec<String> {
    std::env::var("AFM_IMPORT_SERVICES")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "deezer tidal qobuz youtube".to_string())
        .split([' ', ','])
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect()
}

fn quality() -> String {
    std::env::var("AFM_IMPORT_QUALITY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "LOSSLESS".to_string())
}

/// Mirrors the desktop `MusicImportJob` wire shape exactly, so the frontend
/// type covers both transports without a translation layer.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: String,
    pub url: String,
    pub kind: String,
    pub title: String,
    pub service: String,
    pub quality: String,
    pub total: Option<u32>,
    pub completed: u32,
    /// How many finished tracks were dropped as already in the library, so a
    /// done job can say "already yours" rather than looking like it lost songs.
    #[serde(default)]
    pub skipped: u32,
    /// queued | downloading | done | error
    pub state: String,
    pub error: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub artwork_url: Option<String>,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub current_track: Option<String>,
    #[serde(default)]
    pub tracks: Vec<String>,
    #[serde(default)]
    pub current_index: Option<u32>,
    #[serde(default)]
    pub output_dir: String,
    /// Library-relative paths of the indexed results, in filename order.
    #[serde(default)]
    pub files: Vec<String>,
    /// Database ids of the indexed results, matching `files` - what a client
    /// resolves against its synced library to play an import the moment it
    /// lands, no path or title matching required.
    #[serde(default)]
    pub track_ids: Vec<i64>,
}

pub struct ImportManager {
    pub jobs: tokio::sync::Mutex<Vec<ImportJob>>,
    cancels: tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    notify: tokio::sync::Notify,
    staging_root: PathBuf,
    store: PathBuf,
    /// A writable HOME for the SpotiFLAC child. The service's real home is
    /// read-only under systemd hardening, and SpotiFLAC caches provider
    /// sessions under $HOME/.spotiflac - so it gets a home inside the data
    /// dir, which is writable and persists so those sessions survive restarts.
    sf_home: PathBuf,
}

impl ImportManager {
    /// Loads persisted jobs; anything mid-flight when the process died goes
    /// back to queued - its staging directory is wiped at start, so a rerun
    /// is clean rather than double-counted.
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let store = data_dir.join("imports.json");
        let staging_root = data_dir.join("imports");
        let sf_home = data_dir.join("spotiflac-home");
        let _ = std::fs::create_dir_all(&sf_home);
        let mut jobs: Vec<ImportJob> = std::fs::read_to_string(&store)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        for job in jobs.iter_mut() {
            if job.state == "downloading" {
                // Interrupted mid-run by a restart. NOT auto-requeued: a crash
                // after some files were already filed into the library would,
                // on a blind rerun, download and file them a second time as
                // suffixed duplicates. The user retries deliberately instead
                // (and a retry is idempotent - see the tag precheck in
                // run_job's filing loop).
                job.state = "error".to_string();
                job.error = Some("Interrupted by a server restart. Retry to resume.".to_string());
            }
        }
        let manager = Arc::new(ImportManager {
            jobs: tokio::sync::Mutex::new(jobs),
            cancels: tokio::sync::Mutex::new(HashMap::new()),
            notify: tokio::sync::Notify::new(),
            staging_root,
            store,
            sf_home,
        });
        manager.notify.notify_one();
        manager
    }

    async fn flush(&self) {
        let jobs = self.jobs.lock().await;
        if let Ok(json) = serde_json::to_string(&*jobs) {
            let _ = std::fs::write(&self.store, json);
        }
    }

    async fn update<F: FnOnce(&mut ImportJob)>(&self, id: &str, apply: F) {
        let mut jobs = self.jobs.lock().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
            apply(job);
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn random_id() -> String {
    format!("srv-{}", auth::random_token().replace(['-', '_'], "").chars().take(16).collect::<String>())
}

fn detect_kind(url: &str) -> &'static str {
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

fn kind_label(kind: &str) -> String {
    match kind {
        "playlist" => "Spotify playlist",
        "album" => "Spotify album",
        "artist" => "Spotify artist",
        "track" => "Spotify track",
        _ => "Music link",
    }
    .to_string()
}

fn default_title(kind: &str) -> String {
    match kind {
        "playlist" => "Spotify playlist",
        "album" => "Spotify album",
        "artist" => "Spotify artist",
        "track" => "Spotify track",
        _ => "Music import",
    }
    .to_string()
}

/// The same normalised tag identity the sync precheck uses (api.rs sync_key),
/// so a track imported here reads as "already present" against one uploaded or
/// synced from anywhere else.
fn identity_key(title: &str, artist: &str, album: &str) -> String {
    let norm = |s: &str| s.trim().to_lowercase();
    format!("{}\u{1}{}\u{1}{}", norm(title), norm(artist), norm(album))
}

/// Title / artist / album and duration (ms) read from a staged file's own tags,
/// for the filing precheck. None when the file has no readable primary tag. The
/// duration lets the precheck tell two same-named songs apart by length before
/// it calls one a duplicate of the other.
fn read_identity(path: &Path) -> Option<(String, String, String, Option<i64>)> {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::Accessor;
    use lofty::probe::Probe;
    let tagged = Probe::open(path).ok()?.guess_file_type().ok()?.read().ok()?;
    let duration_ms = {
        let ms = tagged.properties().duration().as_millis();
        if ms == 0 { None } else { Some(ms as i64) }
    };
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    Some((
        tag.title().map(|c| c.to_string()).unwrap_or_default(),
        tag.artist().map(|c| c.to_string()).unwrap_or_default(),
        tag.album().map(|c| c.to_string()).unwrap_or_default(),
        duration_ms,
    ))
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Total bytes under a staging dir - EVERY file, partial downloads included -
/// so the stall watchdog can tell "actively transferring" from "hung".
fn staging_bytes(dir: &Path) -> u64 {
    fn walk(dir: &Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
        let mut total = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                total += walk(&path);
            } else if let Ok(m) = entry.metadata() {
                total += m.len();
            }
        }
        total
    }
    walk(dir)
}

fn staged_audio_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                walk(&path, out);
            } else if is_audio(&path) {
                out.push(path);
            }
        }
    }
    walk(dir, &mut out);
    out.sort();
    out
}

fn find_spotiflac() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("AFM_SPOTIFLAC") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("spotiflac");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join(".local/bin/spotiflac");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// --- Spotify embed metadata (ported from the desktop importer) --------------

const EMBED_UA: &str =
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

pub(crate) async fn fetch_embed_meta(
    link: &str,
    kind: &str,
) -> Option<(String, Option<String>, Option<u32>, Vec<String>)> {
    let id = parse_spotify_id(link, kind)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(25)).build().ok()?;
    let html = client
        .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
        .header("User-Agent", EMBED_UA)
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let marker = html.find("__NEXT_DATA__")?;
    let json_start = html[marker..].find('>').map(|i| marker + i + 1)?;
    let json_end = html[json_start..].find("</script>").map(|i| json_start + i)?;
    let data: serde_json::Value = serde_json::from_str(html[json_start..json_end].trim()).ok()?;

    let name = find_key(&data, "name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
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
                .filter_map(|t| t.get("title").and_then(|v| v.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Some((name, cover, total, titles))
}

// --- The runner --------------------------------------------------------------

/// The scheduler: takes queued jobs oldest-first, at most CONCURRENCY at a
/// time, forever. Spawned once at boot.
pub fn spawn_scheduler(state: Arc<AppState>) {
    tokio::spawn(async move {
        let in_flight = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        loop {
            let manager = Arc::clone(&state.imports);
            let next = {
                let jobs = manager.jobs.lock().await;
                if in_flight.load(std::sync::atomic::Ordering::Acquire) >= CONCURRENCY {
                    None
                } else {
                    jobs.iter().find(|j| j.state == "queued").map(|j| (j.id.clone(), j.url.clone()))
                }
            };
            let Some((id, url)) = next else {
                manager.notify.notified().await;
                continue;
            };
            manager.update(&id, |j| j.state = "downloading".to_string()).await;
            manager.flush().await;
            in_flight.fetch_add(1, std::sync::atomic::Ordering::AcqRel);

            let run_state = Arc::clone(&state);
            let slots = Arc::clone(&in_flight);
            tokio::spawn(async move {
                let manager = Arc::clone(&run_state.imports);
                // Frees the slot and re-pokes the scheduler no matter how this
                // task leaves - normal return OR a panic. Without it a single
                // panicked job would leak a permanent slot and, at
                // CONCURRENCY=1, wedge the whole queue.
                let _guard = SlotGuard { slots: Arc::clone(&slots), manager: Arc::clone(&manager) };
                let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
                manager.cancels.lock().await.insert(id.clone(), cancel_tx);
                let result = run_job(&run_state, &id, &url, cancel_rx).await;
                manager.cancels.lock().await.remove(&id);
                match result {
                    Ok((count, files, track_ids, skipped)) => {
                        manager
                            .update(&id, |j| {
                                j.completed = count.max(j.completed);
                                if j.total.is_none() {
                                    j.total = Some(j.completed);
                                }
                                j.skipped = skipped;
                                j.state = "done".to_string();
                                j.error = None;
                                j.current_track = None;
                                j.current_index = None;
                                j.files = files;
                                j.track_ids = track_ids;
                            })
                            .await;
                    }
                    Err(err) => {
                        manager
                            .update(&id, |j| {
                                j.state = "error".to_string();
                                j.error = Some(err);
                                j.current_track = None;
                                j.current_index = None;
                            })
                            .await;
                    }
                }
                manager.flush().await;
                // The slot is freed and the scheduler re-poked by _guard's Drop.
            });
        }
    });
}

/// Frees an in-flight slot and wakes the scheduler when a job task ends -
/// whether it returned or panicked. See its construction in spawn_scheduler.
struct SlotGuard {
    slots: Arc<std::sync::atomic::AtomicUsize>,
    manager: Arc<ImportManager>,
}
impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.slots.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        self.manager.notify.notify_one();
    }
}

/// Runs one import in its own staging directory, then files the results into
/// the library through the upload pipeline's own routing and indexing.
async fn run_job(
    state: &Arc<AppState>,
    id: &str,
    url: &str,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(u32, Vec<String>, Vec<i64>, u32), String> {
    let manager = Arc::clone(&state.imports);
    let staging = manager.staging_root.join(id);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let program = find_spotiflac().ok_or_else(|| {
        "SpotiFLAC is not installed on the server (pipx install SpotiFLAC on the box, or set AFM_SPOTIFLAC).".to_string()
    })?;

    let mut args: Vec<String> = vec![url.to_string(), staging.display().to_string()];
    args.push("--service".to_string());
    args.extend(services());
    args.push("--quality".to_string());
    args.push(quality());
    args.push("--use-album-track-numbers".to_string());
    args.push("--filename-format".to_string());
    args.push("{track}. {title}".to_string());
    args.push("--retries".to_string());
    args.push("2".to_string());
    args.push("--timeout".to_string());
    args.push("120".to_string());
    // Reliable lossless comes from a configured provider, not the flaky public
    // backends: a self-hosted hifi-api for Tidal, a local API for Qobuz. Both
    // are optional and passed straight through when the operator sets them.
    if let Ok(api) = std::env::var("AFM_TIDAL_API") {
        if !api.trim().is_empty() {
            args.push("--tidal-api".to_string());
            args.push(api);
        }
    }
    if let Ok(api) = std::env::var("AFM_QOBUZ_API") {
        if !api.trim().is_empty() {
            args.push("--qobuz-local-api".to_string());
            args.push(api);
        }
    }

    let mut child = tokio::process::Command::new(&program)
        .args(&args)
        // A writable HOME: the service's own is read-only under hardening, and
        // SpotiFLAC writes a session cache to $HOME/.spotiflac.
        .env("HOME", &manager.sf_home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("SpotiFLAC would not start: {e}"))?;

    let stderr_tail = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    if let Some(err) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut tail = tail.lock().await;
                tail.push(line);
                let excess = tail.len().saturating_sub(40);
                if excess > 0 {
                    tail.drain(..excess);
                }
            }
        });
    }
    if let Some(out) = child.stdout.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(out).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
    }

    // Progress: the staging directory is the truth. Poll it, and kill the run
    // only when it goes truly quiet - measured by BYTES on disk, not finished
    // files. A single large FLAC (or a slow provider negotiation) can take
    // minutes before its first file completes; watching the growing partial's
    // size keeps that from reading as a stall.
    let mut interval = tokio::time::interval(Duration::from_millis(1000));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_count = 0u32;
    let mut last_bytes = 0u64;
    let mut last_progress = std::time::Instant::now();
    let mut cancelled = false;
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            _ = &mut cancel_rx => {
                cancelled = true;
                let _ = child.kill().await;
                break child.wait().await;
            }
            _ = interval.tick() => {
                let bytes = staging_bytes(&staging);
                if bytes != last_bytes {
                    // Any byte movement, partial files included, is progress.
                    last_bytes = bytes;
                    last_progress = std::time::Instant::now();
                }
                let files = staged_audio_files(&staging);
                let count = files.len() as u32;
                if count != last_count {
                    last_count = count;
                    last_progress = std::time::Instant::now();
                    let newest = files
                        .iter()
                        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
                        .last();
                    manager
                        .update(id, |j| {
                            j.completed = count;
                            j.current_track = newest.clone();
                            j.current_index = count.checked_sub(1);
                        })
                        .await;
                    manager.flush().await;
                }
                if last_progress.elapsed() >= Duration::from_secs(STALL_SECS) {
                    let _ = child.kill().await;
                    break child.wait().await;
                }
            }
        }
    };

    if cancelled {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("Canceled.".to_string());
    }

    // File everything that landed into the library, tags deciding placement,
    // exactly as an upload would land. Serialized against every other filer
    // (concurrent uploads, the next import) so no two ever resolve to the same
    // destination between the free-name check and the rename.
    let staged = staged_audio_files(&staging);
    let mut rels = Vec::new();
    let mut track_ids = Vec::new();
    let mut skipped = 0u32;
    let _filing = state.filing.lock().await;
    // The library's current identities, for a tag precheck that makes filing
    // idempotent: a track already present (this album re-imported, or the same
    // song from another source) is dropped rather than filed as a suffixed
    // duplicate. Built once under the lock, so it already reflects everything
    // an earlier filer just added.
    let mut have: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Album-agnostic identity, keyed on title + artist alone: the same song
    // owned on its album is caught when a playlist lists it as a single or on a
    // compilation (a different album tag), which the album-scoped set above
    // misses. Each key holds the lengths of the songs behind it, so two truly
    // different tracks that share a title and artist are told apart by duration
    // rather than one silently swallowing the other.
    let norm = |s: &str| s.trim().to_lowercase();
    let track_key = |title: &str, artist: &str| format!("{}\u{1}{}", norm(title), norm(artist));
    let mut have_tracks: std::collections::HashMap<String, Vec<Option<i64>>> =
        std::collections::HashMap::new();
    for (title, artist, album_artist, album, dur) in state.db.sync_identities() {
        have.insert(identity_key(&title, &artist, &album));
        have.insert(identity_key(&title, &album_artist, &album));
        have_tracks.entry(track_key(&title, &artist)).or_default().push(dur);
        if norm(&album_artist) != norm(&artist) {
            have_tracks.entry(track_key(&title, &album_artist)).or_default().push(dur);
        }
    }
    // Same 3s tolerance the up-sync precheck (api.rs) allows for tag/encode
    // drift between two rips of one song. An unknown length on either side does
    // not block the match - name alone then decides, as it did before.
    let dur_close = |ours: &[Option<i64>], theirs: Option<i64>| -> bool {
        let Some(theirs) = theirs else { return true };
        ours.iter().any(|ms| match ms {
            None => true,
            Some(ms) => (ms - theirs).abs() <= 3000,
        })
    };
    // The running quota headroom, decremented as files land so a big album
    // cannot push the library past its ceiling one track at a time.
    let mut used = state.db.total_bytes();
    for path in &staged {
        let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
        if state.library_quota_bytes > 0 && used + size > state.library_quota_bytes {
            // Out of room. Stop filing; what landed already stays, and the
            // job reports the shortfall below.
            break;
        }
        if let Some((title, artist, album, dur)) = read_identity(path) {
            let key = identity_key(&title, &artist, &album);
            let tkey = track_key(&title, &artist);
            // Already present if this exact album copy is filed, OR the same
            // song (title + artist, matching length) is filed under any album.
            let already =
                have.contains(&key) || have_tracks.get(&tkey).is_some_and(|d| dur_close(d, dur));
            if already {
                skipped += 1;
                continue;
            }
            have.insert(key);
            have_tracks.entry(tkey).or_default().push(dur);
        }
        let original = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let ext = original.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let rel = upload::destination_for(path, &original, &ext);
        let dest = state.music_root.join(&rel);
        let (rel, dest) = upload::unique_destination(&state.music_root, &rel, &dest);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(path, &dest).is_err() {
            if std::fs::copy(path, &dest).is_err() {
                continue;
            }
            let _ = std::fs::remove_file(path);
        }
        if scan::scan_one(&state.db, &state.music_root, &state.art_dir, &rel) {
            used += size;
            if let Some(tid) = state.db.track_id_by_path(&rel) {
                track_ids.push(tid);
            }
            rels.push(rel);
        } else {
            // Unindexable never stays - same rule as uploads.
            let _ = std::fs::remove_file(&dest);
        }
    }
    drop(_filing);
    let _ = std::fs::remove_dir_all(&staging);

    if !rels.is_empty() {
        return Ok((rels.len() as u32, rels, track_ids, skipped));
    }
    // Everything that came down was already in the library: a real success -
    // the playlist added nothing new because you already own it all - not the
    // "downloaded nothing" failure below.
    if skipped > 0 {
        return Ok((0, Vec::new(), Vec::new(), skipped));
    }

    let stderr = tail_join(&*stderr_tail.lock().await);
    if last_progress.elapsed() >= Duration::from_secs(STALL_SECS) {
        return Err(format!(
            "Download stalled — no progress for {STALL_SECS}s. Retry to resume. {stderr}"
        ));
    }
    match status {
        Ok(s) if s.success() => Err(format!("SpotiFLAC finished but saved no playable files. {stderr}")),
        Ok(s) => Err(format!("SpotiFLAC failed (status {:?}). {stderr}", s.code())),
        Err(e) => Err(format!("SpotiFLAC failed: {e}")),
    }
}

fn tail_join(lines: &[String]) -> String {
    let start = lines.len().saturating_sub(12);
    lines[start..].join("\n").trim().to_string()
}

// --- API ---------------------------------------------------------------------

type ApiError = (StatusCode, String);

#[derive(Deserialize)]
pub struct EnqueueBody {
    pub url: String,
}

/// `GET /api/imports` - the queue, newest first.
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let jobs = state.imports.jobs.lock().await.clone();
    Ok(Json(serde_json::json!({ "jobs": jobs })))
}

/// `POST /api/imports` - enqueue a link. Returns the job as first created;
/// richer metadata (real title, artwork, track count) lands moments later via
/// a background embed fetch and shows up on the next list poll.
pub async fn enqueue(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<EnqueueBody>,
) -> Result<Json<ImportJob>, ApiError> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let url = body.url.trim().to_string();
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "a link to import is required".into()));
    }
    // The disk the library shares with everything else on the box; imports
    // respect the same ceiling uploads do.
    let used = state.db.total_bytes();
    if state.library_quota_bytes > 0 && used >= state.library_quota_bytes {
        return Err((
            StatusCode::INSUFFICIENT_STORAGE,
            format!("library is at its quota ({})", upload::human_bytes(state.library_quota_bytes)),
        ));
    }

    let kind = detect_kind(&url);
    let job = ImportJob {
        id: random_id(),
        url: url.clone(),
        kind: kind.to_string(),
        title: default_title(kind),
        service: "server".to_string(),
        quality: quality(),
        total: None,
        completed: 0,
        skipped: 0,
        state: "queued".to_string(),
        error: None,
        created_at: now_unix(),
        artwork_url: None,
        subtitle: Some(kind_label(kind)),
        current_track: None,
        tracks: Vec::new(),
        current_index: None,
        output_dir: state.music_root.display().to_string(),
        files: Vec::new(),
        track_ids: Vec::new(),
    };
    {
        let mut jobs = state.imports.jobs.lock().await;
        jobs.push(job.clone());
    }
    state.imports.flush().await;
    state.imports.notify.notify_one();

    // Best-effort pretty metadata; the queue never waits on Spotify.
    let meta_state = Arc::clone(&state);
    let meta_id = job.id.clone();
    let meta_kind = kind.to_string();
    tokio::spawn(async move {
        if let Some((name, cover, total, titles)) = fetch_embed_meta(&url, &meta_kind).await {
            meta_state
                .imports
                .update(&meta_id, |j| {
                    j.title = name;
                    j.artwork_url = cover;
                    if j.total.is_none() {
                        j.total = total;
                    }
                    j.tracks = titles;
                })
                .await;
            meta_state.imports.flush().await;
        }
    });

    Ok(Json(job))
}

/// `POST /api/imports/{id}/cancel`
pub async fn cancel(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if let Some(tx) = state.imports.cancels.lock().await.remove(&id) {
        let _ = tx.send(());
    } else {
        state
            .imports
            .update(&id, |j| {
                if j.state == "queued" {
                    j.state = "error".to_string();
                    j.error = Some("Canceled.".to_string());
                }
            })
            .await;
        state.imports.flush().await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `POST /api/imports/{id}/retry`
pub async fn retry(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .imports
        .update(&id, |j| {
            if j.state == "error" {
                j.state = "queued".to_string();
                j.error = None;
                j.completed = 0;
                j.current_track = None;
                j.current_index = None;
                j.files = Vec::new();
                j.track_ids = Vec::new();
            }
        })
        .await;
    state.imports.flush().await;
    state.imports.notify.notify_one();
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `DELETE /api/imports/{id}` - drop a finished or failed card.
pub async fn remove(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    {
        let mut jobs = state.imports.jobs.lock().await;
        jobs.retain(|j| j.id != id || j.state == "downloading");
    }
    state.imports.flush().await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ClearBody {
    pub states: Vec<String>,
}

/// `POST /api/imports/clear` - drop every card in the named states.
pub async fn clear(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ClearBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    {
        let mut jobs = state.imports.jobs.lock().await;
        jobs.retain(|j| j.state == "downloading" || !body.states.contains(&j.state));
    }
    state.imports.flush().await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
