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

// Must stay comfortably above the per-track timeout below: a track allowed
// 300s to arrive cannot be declared "stalled" at 180s, or the guard kills
// exactly the slow-but-working download the longer timeout was meant to allow.
const STALL_SECS: u64 = 420;
// Download lanes. Filing into the shared library is serialized separately by
// `state.filing`, so parallel DOWNLOADS never race on a destination - which is
// what frees these to run at all.
//
// Single songs run up to three at once, and a tapped "now playing" song can use
// all three; a BACKGROUND single (the collector, a sync) is held to two, so one
// slot always stands clear for a tap and a listen never queues behind a chore.
// Playlists/albums file many tracks each, so they run one at a time.
const SONG_SLOTS: usize = 3;
const BG_SONG_SLOTS: usize = 2;
const PLAYLIST_SLOTS: usize = 1;

/// A single track shares the song lanes; everything else (playlist, album,
/// artist, or an unrecognised link that might expand to many) runs on the one
/// playlist lane.
fn is_song_kind(kind: &str) -> bool {
    kind == "track"
}

pub(crate) const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "flac", "wav", "aiff", "aif", "ogg", "oga", "opus",
];

/// Provider priority handed to SpotiFLAC; overridable per deployment via
/// AFM_IMPORT_SERVICES. Deezer leads because it downloads real lossless with
/// no API key or self-hosted endpoint - Tidal and Qobuz need a configured
/// hifi-api / local API, and YouTube's public scraper backends come and go.
/// The rest trail as fallbacks for tracks Deezer does not carry.
pub(crate) fn services() -> Vec<String> {
    std::env::var("AFM_IMPORT_SERVICES")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "deezer tidal qobuz youtube".to_string())
        .split([' ', ','])
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect()
}

/// Metadata-enrichment providers handed to SpotiFLAC (`--enrich-providers`),
/// set via AFM_IMPORT_ENRICH. Unset keeps SpotiFLAC's own default; a value of
/// `none` (or `off`) disables enrichment entirely. This is separate from the
/// download `--service` list so a deployment can drop a provider that 429s a
/// datacentre IP (deezer) from enrichment without losing it as a download source
/// or having to touch the other list.
fn enrich_providers() -> Option<Vec<String>> {
    let raw = std::env::var("AFM_IMPORT_ENRICH").ok()?;
    let raw = raw.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(
        raw.split([' ', ','])
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .collect(),
    )
}

/// How long ONE track may take from a provider before SpotiFLAC gives up on
/// it. The old 120s was tuned for backends answering promptly; when a public
/// backend is throttling a datacentre address the transfer crawls rather than
/// refusing, and 120s cut off downloads that would have finished. Raised, and
/// made settable so the box can be tuned without a rebuild.
pub(crate) fn per_track_timeout() -> String {
    std::env::var("AFM_IMPORT_TIMEOUT")
        .ok()
        .filter(|s| s.trim().parse::<u32>().is_ok())
        .unwrap_or_else(|| "300".to_string())
}

pub(crate) fn quality() -> String {
    std::env::var("AFM_IMPORT_QUALITY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "LOSSLESS".to_string())
}

/// One song inside an import, as much as the source's embed page says about it
/// before a byte has been downloaded: title, artist, length. Enough for the
/// queue to read like a track list rather than a list of strings.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub duration_ms: Option<u64>,
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
    /// The same list as `tracks`, with what else the embed knew about each:
    /// artist and length. Parallel to `tracks` rather than replacing it, so a
    /// client built before this field keeps reading titles exactly as before -
    /// the wire shape only ever grows. Index i here is index i there.
    #[serde(default)]
    pub items: Vec<ImportItem>,
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
    /// Tracks this run found the library already had. Separate from
    /// `track_ids`, which stays aligned with `files`; an import of something
    /// wholly owned files nothing yet still resolves to real tracks here.
    #[serde(default)]
    pub owned_track_ids: Vec<i64>,
    /// Set when the sync engine raised this job, so its result can be routed
    /// back to the mirror entry that asked for it. Empty for a pasted link.
    #[serde(default)]
    pub origin: String,
    /// Who queued this. The download queue is shared - one box, one library -
    /// but a PLAYLIST import has to land on somebody's account, so the job
    /// carries the caller who raised it. Defaulted for jobs persisted before
    /// this field existed: they finish without making a playlist rather than
    /// making one for user 0.
    #[serde(default)]
    pub owner: i64,
    /// Who or what asked for this, in words the queue can wear: the
    /// username that pasted the link, "the collector · for &lt;name&gt;",
    /// "Spotify mirror · &lt;name&gt;". Display only - `origin` and `owner`
    /// stay the machine-readable truth. Empty on jobs persisted before the
    /// field existed; the client says nothing rather than guessing.
    #[serde(default)]
    pub via: String,
    /// Set when a listener TAPPED this single song to play it now: it opens Now
    /// Playing downloading and wants its file fast. Such a track jumps ahead of
    /// background singles for a download slot, and one song slot is always held
    /// clear for it, so a tap never waits behind the collector or a sync.
    #[serde(default)]
    pub now_playing: bool,
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
    /// The writable HOME the SpotiFLAC child runs under - reused by the search
    /// so its Spotify metadata client caches its session in the same place.
    pub fn sf_home(&self) -> &Path {
        &self.sf_home
    }

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


/// Translates a link SpotiFLAC will not take into one it will.
///
/// SpotiFLAC's primary input must be Spotify, Tidal, Apple Music, SoundCloud,
/// YouTube or Pandora - Deezer is only ever a DOWNLOAD provider, and handing it
/// a Deezer link fails outright with INVALID_URL. That matters because this
/// app's own catalogue surfaces are Deezer-shaped: Deezer is the one service
/// that answers artist, album and search queries without a key, so the artist
/// pages and the discovery shelf all produce Deezer links.
///
/// Odesli (song.link) maps any one platform's link onto every other's, keylessly,
/// which is exactly the translation needed. Spotify is preferred - it is
/// SpotiFLAC's native input - then Tidal, then the streaming sites. Apple is
/// deliberately NOT in the list: SpotiFLAC accepts the URL but its Apple
/// metadata provider dies on a redirect, so it would trade one failure for
/// another.
pub(crate) async fn spotiflac_input(url: &str) -> Result<String, String> {
    if !url.to_ascii_lowercase().contains("deezer.") {
        return Ok(url.to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let reply = client
        .get("https://api.song.link/v1-alpha.1/links")
        .query(&[("url", url)])
        .send()
        .await
        .map_err(|e| format!("Could not reach the link resolver: {e}"))?;
    if !reply.status().is_success() {
        return Err(format!(
            "The link resolver refused this Deezer link ({}). SpotiFLAC cannot take Deezer links directly.",
            reply.status()
        ));
    }
    let body: serde_json::Value =
        reply.json().await.map_err(|e| format!("Link resolver gave nonsense: {e}"))?;
    for platform in ["spotify", "tidal", "soundcloud", "youtube"] {
        if let Some(found) = body
            .pointer(&format!("/linksByPlatform/{platform}/url"))
            .and_then(|v| v.as_str())
        {
            return Ok(found.to_string());
        }
    }
    Err("No Spotify or Tidal release matches this Deezer link, so there is nothing SpotiFLAC can pull."
        .to_string())
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

/// Why this box will not download, in the words that fit the reason.
///
/// The two cases need different sentences and used to share one. A server that
/// was DECLARED a non-downloader answering "SpotiFLAC is not installed" sends
/// its owner off to install something that is already there, and says nothing
/// about the actual problem, which is that the import arrived at the wrong
/// box. The fix for that is a setting in the app, not a package on the server.
pub(crate) fn no_downloader_here() -> String {
    if imports_mode() == ImportsMode::CollectorOnly {
        return "This server only downloads for its own collector \
                (AFM_IMPORTS=collector). Pick the server that takes links, \
                under Settings, Downloads, \"Download on\"."
            .to_string();
    }
    if imports_disabled() {
        "This server is not the downloader (AFM_IMPORTS=off). Pick the server that is, \
         under Settings, Downloads, \"Download on\"."
            .to_string()
    } else {
        "SpotiFLAC is not installed on the server (pipx install SpotiFLAC on the box, \
         or set AFM_SPOTIFLAC)."
            .to_string()
    }
}

/// What this box will download, and for whom.
///
/// `AFM_IMPORTS` exists because ROLE and CAPABILITY are different questions,
/// and only the first one has a right answer. Where a hub and a home box both
/// happen to have SpotiFLAC installed, an import routed to the wrong one
/// SUCCEEDS: it downloads, files the song into that box's library, and reports
/// done. There is nothing on screen to notice, and the music is simply in the
/// wrong place - which is worse than an error, because an error gets fixed.
/// Declaring a box a non-downloader turns a silent misfile into an immediate
/// refusal that names itself.
///
/// WHERE EACH MODE IS ENFORCED, which is the part worth getting right:
///
/// `Off` is checked inside `find_spotiflac`, so the answer cannot differ
/// between the importer, the collector and the search results - they all
/// funnel through there, and `importable` in the collector status is derived
/// from it, so the app is told too without any extra plumbing.
///
/// `CollectorOnly` deliberately does NOT go there. It is checked at the
/// `enqueue` handler, the one door a pasted link comes through. Putting it in
/// `find_spotiflac` would take the downloader away from the collector as well,
/// which is the exact thing this mode exists to avoid.
#[derive(Debug, PartialEq, Clone, Copy)]
pub(crate) enum ImportsMode {
    /// Anyone may download here.
    On,
    /// The COLLECTOR may download here; a pasted link may not.
    ///
    /// The middle setting exists because "off" turned out to be two decisions
    /// wearing one word. Declaring the hub a non-downloader correctly sent
    /// pasted links to the box that fetches - and silently stopped the curator,
    /// which downloads through the same door, so Music Date stopped being
    /// refilled and nothing said why. They are separate errands: one is a
    /// person choosing where their music lands, the other is the server
    /// stocking its own shelves.
    CollectorOnly,
    /// Nothing downloads here.
    Off,
}

pub(crate) fn imports_mode() -> ImportsMode {
    match std::env::var("AFM_IMPORTS")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "off" | "0" | "false" | "no" => ImportsMode::Off,
        "collector" | "curator" => ImportsMode::CollectorOnly,
        _ => ImportsMode::On,
    }
}

fn imports_disabled() -> bool {
    imports_mode() == ImportsMode::Off
}

pub(crate) fn find_spotiflac() -> Option<PathBuf> {
    if imports_disabled() {
        return None;
    }
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

/// The embed page lists at most this many tracks in its `trackList`. At the cap
/// the length is a FLOOR, not the real total, so a bigger playlist must not
/// trust it - or its count reads "100" while 150 songs actually download.
const EMBED_TRACK_CAP: u32 = 100;

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

/// What the embed page says about a link, before anything is downloaded.
pub(crate) struct EmbedMeta {
    pub name: String,
    pub cover: Option<String>,
    /// Trusted only when the track list is short of the embed's cap.
    pub total: Option<u32>,
    /// Titles in order - the legacy shape `tracks` carries on the wire.
    pub titles: Vec<String>,
    /// The same songs with artist and length, aligned with `titles`.
    pub items: Vec<ImportItem>,
}

pub(crate) async fn fetch_embed_meta(link: &str, kind: &str) -> Option<EmbedMeta> {
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
    // Only trust the length as a total when the list is SHORT of the cap; at the
    // cap it is truncated, so report no total and let the download's own count
    // fill it in when the run ends.
    let total = track_list
        .map(|a| a.len() as u32)
        .filter(|n| *n > 0 && *n < EMBED_TRACK_CAP);
    // `subtitle` on an embed track is the artist line ("Tame Impala", or
    // "A, B" for features); `duration` is milliseconds. Both are optional per
    // item so a row missing one still lands with the others.
    let items: Vec<ImportItem> = track_list
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let title = t.get("title")?.as_str()?.to_string();
                    Some(ImportItem {
                        title,
                        artist: t
                            .get("subtitle")
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim().to_string())
                            .unwrap_or_default(),
                        duration_ms: t.get("duration").and_then(|v| v.as_u64()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let titles = items.iter().map(|i| i.title.clone()).collect();
    Some(EmbedMeta { name, cover, total, titles, items })
}

// --- The runner --------------------------------------------------------------

/// Which queued job to start next given the lanes' free capacity, or None if
/// nothing can run right now. A now-playing tap is picked first and may use
/// every song slot; a background single leaves the last one clear for a tap; a
/// playlist takes the one playlist slot. Oldest-first within each group (`jobs`
/// is insertion order). Returns (id, url, is_song).
fn pick_runnable(
    jobs: &[ImportJob],
    songs: usize,
    playlists: usize,
) -> Option<(String, String, bool)> {
    let hit = |j: &ImportJob| (j.id.clone(), j.url.clone(), is_song_kind(&j.kind));
    if songs < SONG_SLOTS {
        if let Some(j) = jobs
            .iter()
            .find(|j| j.state == "queued" && is_song_kind(&j.kind) && j.now_playing)
        {
            return Some(hit(j));
        }
    }
    if songs < BG_SONG_SLOTS {
        if let Some(j) = jobs
            .iter()
            .find(|j| j.state == "queued" && is_song_kind(&j.kind) && !j.now_playing)
        {
            return Some(hit(j));
        }
    }
    if playlists < PLAYLIST_SLOTS {
        if let Some(j) = jobs.iter().find(|j| j.state == "queued" && !is_song_kind(&j.kind)) {
            return Some(hit(j));
        }
    }
    None
}

/// The scheduler: fills two download lanes forever - up to SONG_SLOTS single
/// songs and PLAYLIST_SLOTS playlist at a time - starting every runnable job
/// each pass, then sleeping until a slot frees or a job arrives. Spawned once at
/// boot. Filing into the library stays serialized by state.filing, so the
/// parallel downloads never race on a destination.
pub fn spawn_scheduler(state: Arc<AppState>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    tokio::spawn(async move {
        let songs = Arc::new(AtomicUsize::new(0));
        let playlists = Arc::new(AtomicUsize::new(0));
        loop {
            let manager = Arc::clone(&state.imports);
            // Start every job the two lanes have room for this pass.
            loop {
                let s = songs.load(Ordering::Acquire);
                let p = playlists.load(Ordering::Acquire);
                let picked = {
                    let jobs = manager.jobs.lock().await;
                    pick_runnable(&jobs, s, p)
                };
                let Some((id, url, is_song)) = picked else { break };
                manager.update(&id, |j| j.state = "downloading".to_string()).await;
                manager.flush().await;
                let lane = if is_song { Arc::clone(&songs) } else { Arc::clone(&playlists) };
                lane.fetch_add(1, Ordering::AcqRel);

                let run_state = Arc::clone(&state);
                let slots = Arc::clone(&lane);
            tokio::spawn(async move {
                let manager = Arc::clone(&run_state.imports);
                // Frees the slot and re-pokes the scheduler no matter how this
                // task leaves - normal return OR a panic. Without it a single
                // panicked job would leak a permanent slot and, at
                // CONCURRENCY=1, wedge the whole queue.
                let _guard = SlotGuard { slots: Arc::clone(&slots), manager: Arc::clone(&manager) };
                let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
                manager.cancels.lock().await.insert(id.clone(), cancel_tx);
                // The activity feed's view of a download. `key` is the job id,
                // so the finish replaces the start rather than stacking beside
                // it, and a queue of ten reads as ten rows rather than twenty.
                let activity_key = format!("imports:{id}");
                run_state.db.record_activity(crate::db::NewActivity {
                    source: "imports",
                    kind: "download",
                    state: "started",
                    key: &activity_key,
                    title: "Download started",
                    body: &url,
                    track_id: None,
                    detail: None,
                });
                let result = run_job(&run_state, &id, &url, cancel_rx).await;
                manager.cancels.lock().await.remove(&id);
                match result {
                    Ok((count, files, track_ids, skipped, owned)) => {
                        run_state.db.record_activity(crate::db::NewActivity {
                            source: "imports",
                            kind: "download",
                            state: "done",
                            key: &activity_key,
                            title: "Download finished",
                            body: &match (count, skipped) {
                                (0, 0) => "Nothing landed".to_string(),
                                (n, 0) => format!("{n} added"),
                                (0, s) => format!("{s} already owned"),
                                (n, s) => format!("{n} added, {s} already owned"),
                            },
                            track_id: None,
                            detail: None,
                        });
                        manager
                            .update(&id, |j| {
                                j.completed = count.max(j.completed);
                                // The true total is at least what actually
                                // downloaded - correct a capped or absent estimate
                                // so a 150-song playlist never finishes at "100".
                                j.total = Some(j.total.map_or(j.completed, |t| t.max(j.completed)));
                                j.skipped = skipped;
                                j.state = "done".to_string();
                                j.error = None;
                                j.current_track = None;
                                j.current_index = None;
                                j.files = files;
                                j.track_ids = track_ids;
                                j.owned_track_ids = owned;
                            })
                            .await;
                    }
                    Err(err) => {
                        run_state.db.record_activity(crate::db::NewActivity {
                            source: "imports",
                            kind: "download",
                            state: "failed",
                            key: &activity_key,
                            title: "Download failed",
                            body: &err,
                            track_id: None,
                            detail: None,
                        });
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
                // Music landed: the one push a download queue owes its
                // owner. After the flush so the job reads as done to anyone
                // the tap wakes, and only for real arrivals - a job that
                // found every track already owned landed nothing.
                {
                    let job = {
                        let jobs = run_state.imports.jobs.lock().await;
                        jobs.iter().find(|j| j.id == id).cloned()
                    };
                    if let Some(j) = job {
                        if j.owner > 0 && j.state == "done" && !j.track_ids.is_empty() {
                            let n = j.track_ids.len();
                            let body = if n == 1 {
                                if j.title.is_empty() {
                                    "1 song is in your library.".to_string()
                                } else {
                                    format!("\u{201c}{}\u{201d} is in your library.", j.title)
                                }
                            } else {
                                format!("{n} songs are in your library.")
                            };
                            crate::push::notify(
                                &run_state,
                                j.owner,
                                crate::push::Kind::Drops,
                                "New music".into(),
                                body,
                            );
                        }
                    }
                }
                // A playlist link asked for a PLAYLIST, not a pile of songs.
                // Nothing here used to make one, so importing a Spotify list
                // filed forty tracks in the library and left the listener to
                // rebuild the list by hand - which is most of the reason to
                // import a list at all.
                file_into_playlist(&run_state, &id).await;
                // Hand the outcome back to the mirror that raised it, if any.
                // A no-op for an ordinary pasted link.
                crate::spotify_sync::on_job_finished(&run_state, &id).await;
                // The files also belong on the hub, if this box is a peer.
                // Rows and a poke only: this still holds the job's download
                // slot, and PLAYLIST_SLOTS is 1, so a megabyte-paced upload
                // here would wedge every playlist import queued behind it.
                crate::peersync::on_job_finished(&run_state, &id).await;
                // The slot is freed and the scheduler re-poked by _guard's Drop.
            });
            }
            // Every runnable job started; wait for a slot to free or a job to
            // arrive, then try to fill the lanes again.
            manager.notify.notified().await;
        }
    });
}

/// A finished playlist import becomes a playlist.
///
/// The queue's job is to get files onto the disk; nothing after it turned those
/// files back into the LIST they came from, so importing a Spotify playlist
/// filed the songs in the library and stopped there. This is the missing step.
///
/// Only for playlist links, and only for a job that knows who raised it - the
/// download queue is shared across a box, but a playlist belongs to an account.
///
/// The membership is `track_ids` (what this run filed) followed by
/// `owned_track_ids` (what it found you already had). Both matter: an import of
/// a list you half-own would otherwise produce a playlist with the other half
/// missing. The ORDER is the download's, not the source's - the queue never
/// learns the original running order, and a playlist in roughly the right shape
/// beats no playlist at all.
///
/// Re-importing the same link reuses the playlist it made rather than stacking
/// a second one beside it with the same name.
async fn file_into_playlist(state: &Arc<AppState>, job_id: &str) {
    let job = {
        let jobs = state.imports.jobs.lock().await;
        let Some(j) = jobs.iter().find(|j| j.id == job_id) else { return };
        j.clone()
    };
    if job.kind != "playlist" || job.owner <= 0 || job.state != "done" {
        return;
    }
    let mut ids: Vec<i64> = Vec::with_capacity(job.track_ids.len() + job.owned_track_ids.len());
    for id in job.track_ids.iter().chain(job.owned_track_ids.iter()) {
        if !ids.contains(id) {
            ids.push(*id);
        }
    }
    if ids.is_empty() {
        return;
    }
    let name = if job.title.trim().is_empty() { "Imported playlist" } else { job.title.trim() };
    // The same link imported twice should refill one list, not make two.
    let existing = state
        .db
        .playlists(job.owner)
        .into_iter()
        .find(|p| p.name == name)
        .map(|p| p.id);
    let playlist_id = match existing {
        Some(id) => id,
        None => match state.db.create_playlist(job.owner, name) {
            Ok(id) => id,
            Err(e) => {
                eprintln!("[imports] could not make a playlist for {name:?}: {e}");
                return;
            }
        },
    };
    if let Err(e) = state.db.set_playlist_tracks(playlist_id, &ids) {
        eprintln!("[imports] could not fill playlist {name:?}: {e}");
    }
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
) -> Result<(u32, Vec<String>, Vec<i64>, u32, Vec<i64>), String> {
    let manager = Arc::clone(&state.imports);
    let staging = manager.staging_root.join(id);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let program = find_spotiflac().ok_or_else(no_downloader_here)?;

    // A Deezer link becomes a Spotify or Tidal one here; anything else passes
    // through untouched.
    let input = spotiflac_input(url).await?;
    let mut args: Vec<String> = vec![input, staging.display().to_string()];
    args.push("--service".to_string());
    args.extend(services());
    // Enrichment providers, tunable via AFM_IMPORT_ENRICH (e.g. to drop deezer,
    // which 429s from a datacentre IP). Unset leaves SpotiFLAC's default.
    match enrich_providers() {
        Some(list)
            if list.len() == 1
                && matches!(list[0].to_ascii_lowercase().as_str(), "none" | "off" | "no") =>
        {
            args.push("--no-enrich".to_string());
        }
        Some(list) => {
            args.push("--enrich-providers".to_string());
            args.extend(list);
        }
        None => {}
    }
    args.push("--quality".to_string());
    args.push(quality());
    args.push("--use-album-track-numbers".to_string());
    args.push("--filename-format".to_string());
    args.push("{track}. {title}".to_string());
    args.push("--retries".to_string());
    args.push("2".to_string());
    args.push("--timeout".to_string());
    args.push(per_track_timeout());
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
        // A REAL stdin, even though nothing is ever written to it. Inheriting
        // ours is inheriting whatever the service manager left on fd 0, and a
        // hub started with that descriptor closed hands the child a closed one:
        // Python then dies in init_sys_streams with EBADF before it runs a
        // line, and the import fails with a stack trace that has no Python
        // frame in it. /dev/null is a descriptor; closed is not.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("SpotiFLAC would not start: {e}"))?;

    let stderr_tail = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    // Lines that say WHY, kept apart from the rolling tail. SpotiFLAC ends every
    // run with a box-drawn SESSION SUMMARY, so on an album the tail is all box by
    // the time the run ends and the per-track reasons have scrolled out of it.
    let stderr_diag = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    if let Some(err) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        let diag = Arc::clone(&stderr_diag);
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = strip_progress(&line);
                if line.is_empty() {
                    continue;
                }
                if is_diagnostic(&line) {
                    let mut diag = diag.lock().await;
                    diag.push(line.clone());
                    let excess = diag.len().saturating_sub(8);
                    if excess > 0 {
                        diag.drain(..excess);
                    }
                }
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
                            // Never let the running count outrun the estimate; a
                            // capped playlist carries no total and stays
                            // indeterminate until it lands.
                            if let Some(t) = j.total {
                                if count > t {
                                    j.total = Some(count);
                                }
                            }
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
    // Tracks the download produced that the library already had. Kept apart
    // from `track_ids`, which stays paired one-for-one with `rels`.
    let mut owned: Vec<i64> = Vec::new();
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
    // The same identities CARRYING their track ids. Recognising that a file is
    // already here has never been the hard part; saying WHICH track it is, is
    // what a caller re-importing something it mostly owns actually needs, and
    // dropping that on the floor is why such a run used to report nothing.
    let mut id_by_identity: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut id_by_track: std::collections::HashMap<String, Vec<(Option<i64>, i64)>> =
        std::collections::HashMap::new();
    for row in state.db.match_index() {
        let (title, artist, album_artist, album, dur) =
            (row.title, row.artist, row.album_artist, row.album, row.duration_ms);
        let k1 = identity_key(&title, &artist, &album);
        let k2 = identity_key(&title, &album_artist, &album);
        id_by_identity.entry(k1.clone()).or_insert(row.id);
        id_by_identity.entry(k2.clone()).or_insert(row.id);
        have.insert(k1);
        have.insert(k2);
        let tk = track_key(&title, &artist);
        have_tracks.entry(tk.clone()).or_default().push(dur);
        id_by_track.entry(tk).or_default().push((dur, row.id));
        if norm(&album_artist) != norm(&artist) {
            let tk2 = track_key(&title, &album_artist);
            have_tracks.entry(tk2.clone()).or_default().push(dur);
            id_by_track.entry(tk2).or_default().push((dur, row.id));
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
                // Report which track it already is. Without this an import of
                // something wholly owned returns no ids at all, and a caller
                // building a playlist from the result gets an empty list.
                if let Some(tid) = id_by_identity.get(&key).copied().or_else(|| {
                    id_by_track.get(&tkey).and_then(|rows| {
                        rows.iter()
                            .find(|(ours, _)| dur_close(std::slice::from_ref(ours), dur))
                            .map(|(_, id)| *id)
                    })
                }) {
                    owned.push(tid);
                }
                continue;
            }
            have.insert(key);
            have_tracks.entry(tkey).or_default().push(dur);
        }
        let original = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let ext = original.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let rel = upload::destination_for(&state.music_root, path, &original, &ext);
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
        return Ok((rels.len() as u32, rels, track_ids, skipped, owned));
    }
    // Everything that came down was already in the library: a real success -
    // the playlist added nothing new because you already own it all - not the
    // "downloaded nothing" failure below. It now says WHICH tracks those were,
    // so a mirror can finish resolving from a run that filed no new file.
    if skipped > 0 {
        return Ok((0, Vec::new(), Vec::new(), skipped, owned));
    }

    let reason = failure_reason(&*stderr_diag.lock().await, &*stderr_tail.lock().await);
    // Keep the reason on its own line: it is usually several provider errors, and
    // running it onto the end of a sentence is what made these unreadable.
    let detail = if reason.is_empty() {
        String::new()
    } else {
        format!("\n{reason}")
    };
    if last_progress.elapsed() >= Duration::from_secs(STALL_SECS) {
        return Err(format!(
            "Download stalled — no progress for {STALL_SECS}s. Retry to resume.{detail}"
        ));
    }
    match status {
        Ok(s) if s.success() => Err(format!(
            "SpotiFLAC finished but saved no playable files.{detail}"
        )),
        Ok(s) => Err(format!("SpotiFLAC failed (status {:?}).{detail}", s.code())),
        Err(e) => Err(format!("SpotiFLAC failed: {e}")),
    }
}

/// Strip tqdm's progress bar off a stderr line.
///
/// tqdm draws to stderr, so every message SpotiFLAC logs arrives with one or
/// more `Progress:  50%|xxxx| 1/2 [00:03<00:00, ?it/s]` bars glued to the front
/// of it. The bar's bracket never nests, so it always ends at the first `]`.
fn strip_progress(line: &str) -> String {
    let mut s = line.trim_start();
    while let Some(rest) = s.strip_prefix("Progress:") {
        match rest.find(']') {
            Some(i) => s = rest[i + 1..].trim_start(),
            // A bar still being drawn, with no message behind it yet.
            None => return String::new(),
        }
    }
    s.trim().to_string()
}

/// The box-drawn SESSION SUMMARY frame - decoration, never a reason.
fn is_box_art(line: &str) -> bool {
    line.starts_with('\u{2554}')
        || line.starts_with('\u{2560}')
        || line.starts_with('\u{255a}')
        || line.starts_with('\u{2551}')
}

/// A line that states why something failed, as opposed to progress or framing.
fn is_diagnostic(line: &str) -> bool {
    if is_box_art(line) {
        return false;
    }
    let lower = line.to_ascii_lowercase();
    line.starts_with('\u{2717}')
        || lower.contains("all providers failed")
        || lower.contains("has been retired")
        || lower.contains("v1_retired")
        || lower.contains("update spotiflac")
}

/// SpotiFLAC is a separate program on its own release cadence, and its download
/// backends are retired out from under whatever version a box happens to have.
/// When the failure carries that signal, say so in words an operator can act on
/// instead of leaving a wall of provider errors to be decoded.
fn out_of_date_hint(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    (lower.contains("has been retired") || lower.contains("v1_retired") || lower.contains("update spotiflac"))
        .then_some(
            "SpotiFLAC on this server is too old: the download API its version calls has been \
             retired, so every provider fails no matter the song. Update it on the box \
             (`pipx upgrade SpotiFLAC`) and retry.",
        )
}

/// What to show a listener when an import fails.
///
/// Prefers the lines that name a cause; falls back to the tail only when none
/// were seen. Taking the last N lines wholesale - what this used to do - showed
/// the SESSION SUMMARY box and dropped the reasons printed just above it.
fn failure_reason(diag: &[String], tail: &[String]) -> String {
    // Every retry reprints the same per-provider errors, and the summary line
    // already carries all of them. Lead with the summary and drop repeats, so a
    // wall of duplicates can never push the one useful line past the cap.
    let (mut summary, mut detail): (Vec<&str>, Vec<&str>) = (Vec::new(), Vec::new());
    for line in diag {
        let line = line.as_str();
        let lower = line.to_ascii_lowercase();
        let bucket = if lower.contains("all providers failed")
            || lower.contains("has been retired")
            || lower.contains("update spotiflac")
        {
            &mut summary
        } else {
            &mut detail
        };
        if !bucket.contains(&line) {
            bucket.push(line);
        }
    }
    // The summary spells out every provider's error, so the per-provider lines
    // below it are the same text twice. Keep them only when no summary printed.
    let mut picked: Vec<&str> = if summary.is_empty() { detail } else { summary };
    if picked.is_empty() {
        let usable: Vec<&str> = tail
            .iter()
            .map(String::as_str)
            .filter(|l| !l.is_empty() && !is_box_art(l))
            .collect();
        let start = usable.len().saturating_sub(6);
        picked = usable[start..].to_vec();
    }
    picked.truncate(6);
    let mut text = picked.join("\n");
    // Long enough for the per-provider summary, short enough to read on a phone.
    const CAP: usize = 600;
    if text.chars().count() > CAP {
        let cut = text
            .char_indices()
            .nth(CAP)
            .map(|(i, _)| i)
            .unwrap_or(text.len());
        text.truncate(cut);
        text.push_str("\u{2026}");
    }
    match out_of_date_hint(&text) {
        Some(hint) if text.is_empty() => hint.to_string(),
        Some(hint) => format!("{hint}\n\n{text}"),
        None => text,
    }
}

// --- API ---------------------------------------------------------------------

type ApiError = (StatusCode, String);

#[derive(Deserialize)]
pub struct EnqueueBody {
    pub url: String,
    /// A single song the listener tapped to PLAY now, not a background add - it
    /// jumps the song queue and keeps its reserved slot. camelCase on the wire.
    #[serde(default, rename = "nowPlaying")]
    pub now_playing: bool,
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

/// Raise a job from inside the server rather than from a request - what the
/// Spotify mirror uses to fetch one track it could not find locally.
///
/// Deliberately skips the embed-metadata fetch the HTTP path spawns: the
/// caller already knows the title and artist from the Web API, and a sync of
/// three hundred tracks should not also make three hundred scrape requests.
pub async fn enqueue_internal(
    state: &Arc<AppState>,
    url: &str,
    title: &str,
    subtitle: &str,
    origin: &str,
    owner_id: i64,
    via: &str,
) -> Result<String, String> {
    let used = state.db.total_bytes();
    if state.library_quota_bytes > 0 && used >= state.library_quota_bytes {
        return Err(format!(
            "library is at its quota ({})",
            upload::human_bytes(state.library_quota_bytes)
        ));
    }
    let kind = detect_kind(url);
    let job = ImportJob {
        id: random_id(),
        url: url.to_string(),
        kind: kind.to_string(),
        title: title.to_string(),
        service: "server".to_string(),
        quality: quality(),
        total: Some(1),
        completed: 0,
        skipped: 0,
        state: "queued".to_string(),
        error: None,
        created_at: now_unix(),
        artwork_url: None,
        subtitle: Some(subtitle.to_string()),
        current_track: None,
        tracks: Vec::new(),
        items: Vec::new(),
        current_index: None,
        output_dir: state.music_root.display().to_string(),
        files: Vec::new(),
        track_ids: Vec::new(),
        owned_track_ids: Vec::new(),
        origin: origin.to_string(),
        owner: owner_id,
        via: via.to_string(),
        // Server-raised (collector, sync): a background add, never a tap.
        now_playing: false,
    };
    let id = job.id.clone();
    state.imports.jobs.lock().await.push(job);
    state.imports.flush().await;
    state.imports.notify.notify_one();
    Ok(id)
}

/// `POST /api/imports` - enqueue a link. Returns the job as first created;
/// richer metadata (real title, artwork, track count) lands moments later via
/// a background embed fetch and shows up on the next list poll.
pub async fn enqueue(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<EnqueueBody>,
) -> Result<Json<ImportJob>, ApiError> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    // Refused HERE rather than by withholding the binary, which is the whole
    // point of the middle mode: `find_spotiflac` still answers, so the
    // collector keeps stocking the shelves and the search results keep marking
    // songs fetchable - only the pasted-link door is shut.
    if imports_mode() == ImportsMode::CollectorOnly {
        return Err((StatusCode::FORBIDDEN, no_downloader_here()));
    }
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
        items: Vec::new(),
        current_index: None,
        output_dir: state.music_root.display().to_string(),
        files: Vec::new(),
        track_ids: Vec::new(),
        owned_track_ids: Vec::new(),
        origin: String::new(),
        owner: caller.id,
        via: caller.username.clone(),
        // Only a tapped single song is now-playing; the client sets it, and
        // detect_kind must agree it is a track for the flag to matter.
        now_playing: body.now_playing && is_song_kind(kind),
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
        if let Some(meta) = fetch_embed_meta(&url, &meta_kind).await {
            meta_state
                .imports
                .update(&meta_id, |j| {
                    j.title = meta.name;
                    j.artwork_url = meta.cover;
                    if j.total.is_none() {
                        j.total = meta.total;
                    }
                    j.tracks = meta.titles;
                    j.items = meta.items;
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
    /*
     * The same door as `enqueue`, and it needs the same lock.
     *
     * A box only becomes a non-downloader after it has been one, so its old
     * cards are still sitting there - including the failure that literally
     * reads "Retry to resume." Refusing new links while a tap on that button
     * downloads the song here anyway is not a gate, it is a detour, and it
     * files the track into exactly the library the setting exists to protect.
     */
    if imports_mode() == ImportsMode::CollectorOnly {
        return Err((StatusCode::FORBIDDEN, no_downloader_here()));
    }
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

#[cfg(test)]
mod failure_text_tests {
    use super::*;

    /// Verbatim stderr from a real failed run (SpotiFLAC 1.1.2, 2026-08-18),
    /// including the tqdm bars glued to every line and the trailing box.
    const REAL_STDERR: &str = concat!(
        "Progress:   0%|          | 0/1 [00:42<?, ?it/s]   [WARNING] SpotiFLAC.providers.deezer: [deezer] HTTP 429 Rate Limit on https://api.zarz.moe/v1/dl/dzr. Retrying in 2.0s...\n",
        "Progress:   0%|          | 0/1 [00:49<?, ?it/s]     \u{2717}  deezer  \u{b7}  No file downloaded\n",
        "Progress:   0%|          | 0/1 [01:00<?, ?it/s]     \u{2717}  qobuz  \u{b7}  [qobuz] TRACK_NOT_FOUND: Track not found\n",
        "Progress:   0%|          | 0/1 [01:03<?, ?it/s]     \u{2717}  youtube  \u{b7}  All YouTube download sources failed (Direct, Cobalt, YT1D)\n",
        "Progress:   0%|          | 0/1 [01:03<?, ?it/s]     \u{2717}  Failed: Babydoll \u{2014} Dominic Fike: All providers failed after 3 attempt(s) \u{2014} deezer: No file downloaded; youtube: All YouTube download sources failed\n",
        "Progress: 100%|\u{2588}\u{2588}| 1/1 [01:03<00:00, 63.92s/it]   \u{2554}\u{2550}\u{2550}\u{2550}\u{2550}\u{2557}\n",
        "Progress: 100%|\u{2588}\u{2588}| 1/1 [01:03<00:00, 63.92s/it]   \u{2551}  SESSION SUMMARY   \u{2551}\n",
        "Progress: 100%|\u{2588}\u{2588}| 1/1 [01:03<00:00, 63.92s/it]   \u{2551}  Total Tracks  : 1 \u{2551}\n",
        "Progress: 100%|\u{2588}\u{2588}| 1/1 [01:03<00:00, 63.92s/it]   \u{2551}  Successful    : 0 \u{2551}\n",
        "Progress: 100%|\u{2588}\u{2588}| 1/1 [01:03<00:00, 63.92s/it]   \u{255a}\u{2550}\u{2550}\u{2550}\u{2550}\u{255d}\n",
    );

    /// Reproduces the reader loop so the test exercises the real split.
    fn split(raw: &str) -> (Vec<String>, Vec<String>) {
        let (mut diag, mut tail) = (Vec::new(), Vec::new());
        for line in raw.lines() {
            let line = strip_progress(line);
            if line.is_empty() {
                continue;
            }
            if is_diagnostic(&line) {
                diag.push(line.clone());
            }
            tail.push(line);
        }
        (diag, tail)
    }

    #[test]
    fn strips_every_tqdm_bar_including_repeats() {
        assert_eq!(
            strip_progress("Progress:  50%|xx| 1/2 [00:03<00:00, ?it/s]Progress: 100%|xx| 2/2 [00:04<00:00, ?it/s]  done"),
            "done"
        );
        // A bar with no message behind it yet carries no information.
        assert_eq!(strip_progress("Progress:  50%|xx| 1/2 [00:03<00:00, ?it/s]"), "");
        // A message with its own brackets survives intact.
        assert_eq!(
            strip_progress("Progress:   0%| | 0/1 [00:01<?, ?it/s]   [ERROR] [tidal] TRACK_NOT_FOUND"),
            "[ERROR] [tidal] TRACK_NOT_FOUND"
        );
    }

    #[test]
    fn keeps_the_reason_and_drops_the_box() {
        let (diag, tail) = split(REAL_STDERR);
        let out = failure_reason(&diag, &tail);
        // The one line that names every provider's failure.
        assert!(out.contains("All providers failed"), "missing summary: {out}");
        assert!(out.contains("youtube"), "missing per-provider detail: {out}");
        // The summary names every provider, so it must survive the length cap.
        assert!(
            out.lines().next().unwrap_or_default().contains("All providers failed"),
            "summary was not first: {out}"
        );
        // Retries reprint the same lines; a repeat must not eat a slot.
        assert_eq!(out.lines().count(), 1, "summary should stand alone: {out}");
        // ...and it must not be cut off, since it is the whole explanation.
        assert!(out.ends_with("All YouTube download sources failed"), "summary truncated: {out}");
        // The box art that used to be ALL the listener saw.
        assert!(!out.contains("SESSION SUMMARY"), "kept box art: {out}");
        assert!(!out.contains('\u{2551}'), "kept box border: {out}");
        assert!(!out.contains("Progress:"), "kept tqdm bar: {out}");
    }

    #[test]
    fn names_an_out_of_date_downloader() {
        let raw = "Progress:   0%| | 0/1 [00:01<?, ?it/s]   [deezer] The v1 download API has been retired. Please update SpotiFLAC to the latest version to continue.";
        let (diag, tail) = split(raw);
        let out = failure_reason(&diag, &tail);
        assert!(out.contains("too old"), "no operator hint: {out}");
        assert!(out.contains("pipx upgrade"), "no remedy: {out}");
    }

    #[test]
    fn falls_back_to_the_tail_when_nothing_matched() {
        let raw = "Progress:   0%| | 0/1 [00:01<?, ?it/s]   something unexpected happened";
        let (diag, tail) = split(raw);
        assert!(diag.is_empty());
        assert_eq!(failure_reason(&diag, &tail), "something unexpected happened");
    }

    /*
     * The switch is the whole point of the feature, and it is one `matches!`
     * away from silently doing nothing - a typo in the accepted spellings, or
     * a check placed after the AFM_SPOTIFLAC branch, and a box declared a
     * non-downloader keeps downloading. Env vars are process-global, so these
     * run in one test rather than several racing ones.
     */
    /*
     * ONE test for the whole switch, deliberately.
     *
     * Environment variables are process-global and cargo runs tests in
     * parallel, so three tests each setting AFM_IMPORTS raced and two of them
     * failed on whatever the third had just written. Splitting them read
     * better and did not work; this is the shape that can actually be trusted.
     *
     * AFM_SPOTIFLAC points at a file that certainly exists, so the only thing
     * that can make find_spotiflac answer None is the switch itself - which
     * also pins the gate as sitting AHEAD of that branch.
     */
    #[test]
    fn the_imports_switch() {
        std::env::set_var("AFM_SPOTIFLAC", "/bin/sh");

        // Unset, and anything unrecognised, means a normal downloader.
        for spelling in ["", "on", "1", "true", "yes"] {
            std::env::set_var("AFM_IMPORTS", spelling);
            assert_eq!(imports_mode(), ImportsMode::On, "{spelling:?}");
            assert!(find_spotiflac().is_some(), "{spelling:?}");
        }
        std::env::remove_var("AFM_IMPORTS");
        assert_eq!(imports_mode(), ImportsMode::On, "unset is on");
        assert_eq!(
            no_downloader_here(),
            "SpotiFLAC is not installed on the server (pipx install SpotiFLAC on the box, or set AFM_SPOTIFLAC).",
        );

        // Off stops everything, including the collector.
        for spelling in ["off", "OFF", "0", "false", "No", " off "] {
            std::env::set_var("AFM_IMPORTS", spelling);
            assert_eq!(imports_mode(), ImportsMode::Off, "{spelling:?}");
            assert!(find_spotiflac().is_none(), "{spelling:?} should stop downloading");
        }
        assert_eq!(
            no_downloader_here(),
            "This server is not the downloader (AFM_IMPORTS=off). Pick the server that is, under Settings, Downloads, \"Download on\".",
        );

        // Collector mode keeps the binary - the curator downloads through the
        // same door - and shuts only the pasted-link one.
        for spelling in ["collector", "Collector", "curator", " collector "] {
            std::env::set_var("AFM_IMPORTS", spelling);
            assert_eq!(imports_mode(), ImportsMode::CollectorOnly, "{spelling:?}");
            assert!(
                find_spotiflac().is_some(),
                "{spelling:?}: the collector still needs the downloader",
            );
        }
        assert_eq!(
            no_downloader_here(),
            "This server only downloads for its own collector (AFM_IMPORTS=collector). Pick the server that takes links, under Settings, Downloads, \"Download on\".",
        );

        std::env::remove_var("AFM_IMPORTS");
        std::env::remove_var("AFM_SPOTIFLAC");
    }
}
