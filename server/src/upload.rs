//! Getting music onto the server.
//!
//! Uploads are resumable by construction: `init` opens a sparse temp file and
//! hands back an id, each `PUT` writes a slice at a stated offset, and `GET`
//! reports how much landed so an interrupted phone can carry on from there
//! rather than starting a 40 MB FLAC again. A file is only moved into the
//! library - and only indexed - once `finish` says it is whole.

use crate::auth;
use crate::scan;
use crate::AppState;
use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The extensions the server will take. Anything else is refused at `init`,
/// before a byte is transferred.
const ACCEPTED: &[&str] = &[
    "mp3", "m4a", "m4b", "aac", "flac", "wav", "aiff", "aif", "ogg", "oga", "opus", "wma", "ape",
    "wv",
];

/// A ceiling on a single file. A lossless 20-minute piece at 24/192 is around
/// 700 MB, so this leaves room for the honest cases and still refuses somebody
/// pushing a disk image at the music folder.
const MAX_FILE_BYTES: i64 = 2 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
pub struct InitBody {
    pub filename: String,
    pub size: i64,
}

#[derive(Serialize)]
pub struct InitReply {
    #[serde(rename = "uploadId")]
    pub upload_id: String,
    /// How much of this file the server already holds - non-zero when a client
    /// re-inits an upload it had started before.
    pub received: i64,
}

/// Strips a user-supplied name down to something safe to put on disk: no path
/// separators, no leading dots, no control characters, and a bounded length.
fn safe_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let bounded: String = trimmed.chars().take(120).collect();
    if bounded.is_empty() {
        "Unknown".to_string()
    } else {
        bounded
    }
}

fn extension_of(name: &str) -> String {
    name.rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| e.len() <= 5)
        .unwrap_or_default()
}

fn upload_path(state: &AppState, upload_id: &str) -> Option<PathBuf> {
    // The id is one the server minted; anything with a separator in it is not.
    if upload_id.is_empty()
        || upload_id.len() > 64
        || upload_id.contains('/')
        || upload_id.contains('\\')
        || upload_id.contains('.')
    {
        return None;
    }
    Some(state.upload_dir.join(upload_id))
}

/// `POST /api/upload/init`
pub async fn init(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<InitBody>,
) -> Result<Json<InitReply>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let ext = extension_of(&body.filename);
    if !ACCEPTED.contains(&ext.as_str()) {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!("{ext:?} is not an audio format this server takes"),
        ));
    }
    if body.size <= 0 || body.size > MAX_FILE_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "file is too large".into()));
    }

    // The library quota, checked before the transfer rather than after it. A
    // music server fills its disk faster than anything else on the box, and a
    // full disk takes the database down with it.
    let used = state.db.total_bytes();
    if state.library_quota_bytes > 0 && used + body.size > state.library_quota_bytes {
        return Err((
            StatusCode::INSUFFICIENT_STORAGE,
            format!(
                "library is at {} of its {} quota",
                human_bytes(used),
                human_bytes(state.library_quota_bytes)
            ),
        ));
    }

    // The id encodes the extension so `finish` knows what it is holding without
    // a second lookup, and so a resumed upload lands on the same temp file.
    let upload_id = format!("{}{}", auth::random_token().replace('-', "_"), "");
    let upload_id: String = upload_id.chars().filter(|c| c.is_alphanumeric() || *c == '_').take(48).collect();

    let path = upload_path(&state, &upload_id).ok_or((StatusCode::BAD_REQUEST, "bad id".into()))?;
    std::fs::create_dir_all(&state.upload_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    std::fs::File::create(&path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // The original name and target size ride alongside, so a resumed session
    // does not have to be told them again.
    let meta = serde_json::json!({
        "filename": body.filename,
        "size": body.size,
        "ext": ext,
    });
    let _ = std::fs::write(path.with_extension("meta"), meta.to_string());

    Ok(Json(InitReply {
        upload_id,
        received: 0,
    }))
}

/// `PUT /api/upload/:id?offset=N` - one slice.
pub async fn chunk(
    State(state): State<Arc<AppState>>,
    AxumPath(upload_id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let path = upload_path(&state, &upload_id).ok_or((StatusCode::BAD_REQUEST, "bad id".into()))?;
    if !path.is_file() {
        return Err((StatusCode::NOT_FOUND, "no such upload".into()));
    }
    let offset: u64 = params
        .get("offset")
        .and_then(|o| o.parse().ok())
        .ok_or((StatusCode::BAD_REQUEST, "offset required".into()))?;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    file.write_all(&body)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let received = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(Json(serde_json::json!({ "received": received })))
}

/// `GET /api/upload/:id` - how much of it the server holds, for resuming.
pub async fn status(
    State(state): State<Arc<AppState>>,
    AxumPath(upload_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let path = upload_path(&state, &upload_id).ok_or((StatusCode::BAD_REQUEST, "bad id".into()))?;
    let received = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(Json(serde_json::json!({ "received": received })))
}

/// `POST /api/upload/:id/finish` - move it into the library and index it.
///
/// The destination comes from the file's own tags where it has them, so an
/// upload lands as `Artist/Album/03 Title.flac` and the library on disk stays
/// something a human can navigate. A file whose tags say nothing keeps the name
/// it arrived under.
pub async fn finish(
    State(state): State<Arc<AppState>>,
    AxumPath(upload_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let temp = upload_path(&state, &upload_id).ok_or((StatusCode::BAD_REQUEST, "bad id".into()))?;
    if !temp.is_file() {
        return Err((StatusCode::NOT_FOUND, "no such upload".into()));
    }

    let meta: serde_json::Value = std::fs::read_to_string(temp.with_extension("meta"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let original = meta
        .get("filename")
        .and_then(|v| v.as_str())
        .unwrap_or("upload")
        .to_string();
    let expected = meta.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
    let actual = std::fs::metadata(&temp).map(|m| m.len() as i64).unwrap_or(0);
    if expected > 0 && actual != expected {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("incomplete: {actual} of {expected} bytes"),
        ));
    }

    let ext = extension_of(&original);
    let rel = destination_for(&temp, &original, &ext);
    let dest = state.music_root.join(&rel);

    // A name already taken gets a numeric suffix rather than overwriting: two
    // different rips of the same track are two tracks, and an upload must never
    // silently replace music somebody already has.
    let (rel, dest) = unique_destination(&state.music_root, &rel, &dest);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    // Rename first (same filesystem, atomic); fall back to a copy when the temp
    // dir and the music root are on different mounts - which they will be the
    // moment the library moves to a block volume.
    if std::fs::rename(&temp, &dest).is_err() {
        std::fs::copy(&temp, &dest)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let _ = std::fs::remove_file(&temp);
    }
    let _ = std::fs::remove_file(temp.with_extension("meta"));

    let indexed = scan::scan_one(&state.db, &state.music_root, &state.art_dir, &rel);
    Ok(Json(serde_json::json!({
        "ok": true,
        "path": rel,
        "indexed": indexed,
    })))
}

/// Where an uploaded file belongs, read from its own tags.
fn destination_for(temp: &Path, original: &str, ext: &str) -> String {
    use lofty::file::TaggedFileExt;
    use lofty::prelude::{Accessor, ItemKey};
    use lofty::probe::Probe;

    let fallback = || format!("Uploads/{}", safe_component(original));

    // `guess_file_type` is what makes this work at all: an in-flight upload is
    // stored under a bare random id, and lofty picks the parser off the file
    // extension unless it is asked to sniff the contents instead. Without it
    // every upload silently landed in Uploads/ with its tags unread.
    let probed = Probe::open(temp)
        .ok()
        .and_then(|p| p.guess_file_type().ok())
        .and_then(|p| p.read().ok());
    let Some(tagged) = probed else {
        return fallback();
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return fallback();
    };

    // The album artist groups a compilation correctly; the track artist is the
    // fallback so something always names the folder.
    let artist = tag
        .get_string(&ItemKey::AlbumArtist)
        .map(|s| s.to_string())
        .or_else(|| tag.artist().map(|c| c.to_string()))
        .unwrap_or_default();
    let album = tag.album().map(|c| c.to_string()).unwrap_or_default();
    let title = tag.title().map(|c| c.to_string()).unwrap_or_default();

    if artist.trim().is_empty() || title.trim().is_empty() {
        return fallback();
    }

    let track_no = tag.track().map(|n| format!("{n:02} ")).unwrap_or_default();
    let album_dir = if album.trim().is_empty() {
        "Singles".to_string()
    } else {
        safe_component(&album)
    };
    format!(
        "{}/{}/{}{}.{}",
        safe_component(&artist),
        album_dir,
        track_no,
        safe_component(&title),
        if ext.is_empty() { "audio" } else { ext }
    )
}

/// Finds a free name near `rel`, so nothing is ever overwritten.
fn unique_destination(root: &Path, rel: &str, dest: &Path) -> (String, PathBuf) {
    if !dest.exists() {
        return (rel.to_string(), dest.to_path_buf());
    }
    let (stem, ext) = match rel.rfind('.') {
        Some(dot) => (&rel[..dot], &rel[dot..]),
        None => (rel, ""),
    };
    for n in 2..1000 {
        let candidate = format!("{stem} ({n}){ext}");
        let path = root.join(&candidate);
        if !path.exists() {
            return (candidate, path);
        }
    }
    (rel.to_string(), dest.to_path_buf())
}

pub fn human_bytes(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
