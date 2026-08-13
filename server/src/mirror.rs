//! Cloning one library into another, server to server.
//!
//! The destination PULLS. That is the whole design, and it is what makes this
//! usable from a phone in another country: the source needs no new code, no new
//! port and no visit - it only has to be reachable, which any AttackFM server
//! already is over its own HTTPS. Everything new lives on the box being filled.
//!
//! It walks the source's own delta feed (`/api/library`), skips what it already
//! holds by the same title-and-artist identity the importer uses, and fetches
//! the rest through `/api/stream` - the original bytes, not a transcode. Files
//! land in the music root under artist/album, and the ordinary scanner indexes
//! them, so a mirrored track is indistinguishable from one that was always here.
//!
//! Resumable by construction: it re-derives what is missing every run, so an
//! interrupted mirror is finished by starting it again.

use crate::{auth, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How many tracks to ask the source for at a time.
const PAGE: usize = 500;
/// Index what has landed every so often, so the library fills visibly rather
/// than in one lump at the end of a long run.
const SCAN_EVERY: usize = 25;

#[derive(Default)]
pub struct MirrorState {
    pub running: AtomicBool,
    pub total: AtomicUsize,
    pub copied: AtomicUsize,
    pub skipped: AtomicUsize,
    pub failed: AtomicUsize,
    pub note: std::sync::Mutex<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBody {
    /// Origin of the library to copy FROM, e.g. https://headless-mac...ts.net
    pub source_url: String,
    /// A session token for the source, to read its library listing.
    pub token: String,
    /// The source's stream token, which is what `/api/stream` accepts in a
    /// query string - a header cannot ride an audio fetch.
    pub stream_token: String,
}

fn ext_for(codec: &str) -> &str {
    match codec.trim().to_ascii_lowercase().as_str() {
        "flac" => "flac",
        "alac" | "aac" | "m4a" | "mp4" => "m4a",
        "opus" => "opus",
        "ogg" | "vorbis" => "ogg",
        "wav" => "wav",
        "aiff" | "aif" => "aiff",
        _ => "mp3",
    }
}

/// Anything a filesystem would object to, folded to a space.
fn safe(part: &str) -> String {
    let cleaned: String = part
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() { "Unknown".to_string() } else { trimmed.chars().take(80).collect() }
}

/// `POST /api/mirror/start` - begin pulling another library into this one.
pub async fn start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<StartBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Filling a library is an owner's decision: it spends this box's disk and
    // puts another server's music under everyone's name on it.
    auth::require_admin(&state.db, &headers)
        .map_err(|s| (s, "only the owner can mirror a library".into()))?;
    let source = body.source_url.trim().trim_end_matches('/').to_string();
    if source.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "a source server is required".into()));
    }
    if state.mirror.running.swap(true, Ordering::AcqRel) {
        return Err((StatusCode::CONFLICT, "a mirror is already running".into()));
    }
    state.mirror.total.store(0, Ordering::Release);
    state.mirror.copied.store(0, Ordering::Release);
    state.mirror.skipped.store(0, Ordering::Release);
    state.mirror.failed.store(0, Ordering::Release);
    *state.mirror.note.lock().unwrap() = "reading the other library".to_string();

    let bg = Arc::clone(&state);
    tokio::spawn(async move {
        run(&bg, &source, &body.token, &body.stream_token).await;
        bg.mirror.running.store(false, Ordering::Release);
    });
    Ok(Json(json!({ "started": true })))
}

/// `GET /api/mirror/status` - how far along, for a screen that is watching.
pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let m = &state.mirror;
    Ok(Json(json!({
        "running": m.running.load(Ordering::Acquire),
        "total": m.total.load(Ordering::Acquire),
        "copied": m.copied.load(Ordering::Acquire),
        "skipped": m.skipped.load(Ordering::Acquire),
        "failed": m.failed.load(Ordering::Acquire),
        "note": m.note.lock().map(|n| n.clone()).unwrap_or_default(),
    })))
}

async fn run(state: &Arc<AppState>, source: &str, token: &str, stream_token: &str) {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("AttackFM/0.1 (library mirror)")
        .build()
        .unwrap_or_default();

    // What this library already holds, by the importer's own identity: title
    // and artist, folded. A mirror must never file a second copy of a song
    // this box already has under a slightly different tag.
    let held: std::collections::HashSet<String> = state
        .db
        .owned_names()
        .into_iter()
        .map(|(artist, title)| {
            format!("{}\u{1}{}", crate::discovery::fold(&artist), crate::discovery::fold(&title))
        })
        .collect();

    let mut since: i64 = 0;
    let mut wanted: Vec<serde_json::Value> = Vec::new();
    loop {
        let url = format!("{source}/api/library?since={since}");
        let Ok(reply) = http.get(&url).bearer_auth(token).send().await else {
            *state.mirror.note.lock().unwrap() = "could not reach that server".to_string();
            return;
        };
        if !reply.status().is_success() {
            *state.mirror.note.lock().unwrap() =
                format!("that server answered {}", reply.status().as_u16());
            return;
        }
        let Ok(page) = reply.json::<serde_json::Value>().await else { return };
        let tracks = page.get("tracks").and_then(|t| t.as_array()).cloned().unwrap_or_default();
        for t in &tracks {
            let artist = t.get("artist").and_then(|v| v.as_str()).unwrap_or("");
            let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let key = format!("{}\u{1}{}", crate::discovery::fold(artist), crate::discovery::fold(title));
            if held.contains(&key) {
                state.mirror.skipped.fetch_add(1, Ordering::AcqRel);
            } else {
                wanted.push(t.clone());
            }
        }
        since = page.get("rev").and_then(|r| r.as_i64()).unwrap_or(since);
        if !page.get("more").and_then(|m| m.as_bool()).unwrap_or(false) || tracks.len() < PAGE {
            break;
        }
    }

    state.mirror.total.store(wanted.len(), Ordering::Release);
    *state.mirror.note.lock().unwrap() = format!("{} to copy", wanted.len());

    for (i, t) in wanted.iter().enumerate() {
        if !state.mirror.running.load(Ordering::Acquire) {
            break;
        }
        // The quota is enforced by the upload and import paths, and this writes
        // files directly - so it has to check for itself or a large mirror
        // would be the one way to run a box out of disk. Checked per track
        // rather than once, because the whole point is that this runs for hours.
        if state.library_quota_bytes > 0 && state.db.total_bytes() >= state.library_quota_bytes {
            *state.mirror.note.lock().unwrap() =
                "stopped: this library is at its storage limit".to_string();
            break;
        }
        let id = t.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
        let artist = t.get("artist").and_then(|v| v.as_str()).unwrap_or("Unknown");
        let album = t.get("album").and_then(|v| v.as_str()).unwrap_or("Unknown");
        let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled");
        let codec = t.get("codec").and_then(|v| v.as_str()).unwrap_or("");
        let dir = state.music_root.join(safe(artist)).join(safe(album));
        if tokio::fs::create_dir_all(&dir).await.is_err() {
            state.mirror.failed.fetch_add(1, Ordering::AcqRel);
            continue;
        }
        let file = dir.join(format!("{}.{}", safe(title), ext_for(codec)));
        if tokio::fs::metadata(&file).await.is_ok() {
            state.mirror.skipped.fetch_add(1, Ordering::AcqRel);
            continue;
        }
        // The stream token rides the query, because an <audio> tag cannot send
        // a header and so this endpoint was built to take it there.
        let url = format!("{source}/api/stream/{id}?t={}", urlencoding_lite(stream_token));
        let ok = match http.get(&url).send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) if !b.is_empty() => tokio::fs::write(&file, &b).await.is_ok(),
                _ => false,
            },
            _ => false,
        };
        if ok {
            state.mirror.copied.fetch_add(1, Ordering::AcqRel);
        } else {
            state.mirror.failed.fetch_add(1, Ordering::AcqRel);
            let _ = tokio::fs::remove_file(&file).await;
        }
        *state.mirror.note.lock().unwrap() = format!("{} / {}", i + 1, wanted.len());
        // Index what has landed as it goes, so the library fills visibly.
        if (i + 1) % SCAN_EVERY == 0 {
            index_now(state);
        }
    }
    index_now(state);
    *state.mirror.note.lock().unwrap() = "done".to_string();
}

/// Hand what has landed to the ordinary scanner, which is what makes a
/// mirrored file indistinguishable from one that was always here.
fn index_now(state: &Arc<AppState>) {
    crate::scan::spawn_scan(
        state.db.clone(),
        state.music_root.clone(),
        state.art_dir.clone(),
        state.progress.clone(),
    );
}

/// Percent-encodes the few characters a token could carry that a query string
/// would misread. Small enough not to be worth a dependency.
fn urlencoding_lite(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}
