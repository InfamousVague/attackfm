//! The picture a playlist wears, when somebody chooses one.
//!
//! Kept out of the database on purpose. The playlists endpoint returns every
//! list a user owns and the client refetches it on every heartbeat - so an
//! image in a row is an image on the wire, over and over, for a picture that
//! changes about once. The row holds a FILENAME; the bytes live on disk beside
//! the rest of the server's data and are fetched once and cached forever.
//!
//! Written to a temporary name and renamed into place, which is the same rule
//! canvas.rs follows and for the same reason: a half-written file must never be
//! servable. A rename within one directory is atomic on every filesystem this
//! runs on, so a reader sees either the old cover or the new one.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::json;

use crate::{auth, AppState};

/// Four megabytes. Generous for a square that is displayed at 300px and small
/// enough that a phone cannot fill the disk by holding the button down.
const MAX_BYTES: usize = 4 * 1024 * 1024;

fn covers_dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("playlist-covers")
}

/// The extension for what was actually sent, or None if it is not an image we
/// are willing to store.
///
/// Sniffed from the BYTES rather than trusted from Content-Type, because the
/// header is chosen by the caller and the magic number is chosen by whatever
/// wrote the file. Refusing anything unrecognised is what keeps this directory
/// from becoming a place to park arbitrary uploads.
fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("png");
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// Replace a playlist's cover with the uploaded image.
pub async fn upload(
    State(state): State<Arc<AppState>>,
    Path(playlist_id): Path<i64>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    // Ownership on every edit, never trusted from the list response - two
    // accounts on one server must not reach into each other's playlists.
    match state.db.playlist_owner(playlist_id) {
        Some(owner) if owner == caller.id => {}
        _ => return Err((StatusCode::NOT_FOUND, "no such playlist".to_string())),
    }
    if body.len() > MAX_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "that image is too big".into()));
    }
    let Some(ext) = image_kind(&body) else {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "covers must be a JPEG, PNG or WebP".to_string(),
        ));
    };

    let dir = covers_dir(&state);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    // The name carries the playlist and the format. A changed format leaves the
    // old file behind, which the cleanup below removes - otherwise switching a
    // PNG for a JPEG would leave the PNG serving forever under a stale row.
    let name = format!("{playlist_id}.{ext}");
    let tmp = dir.join(format!(".{playlist_id}.part"));
    if let Err(e) = std::fs::write(&tmp, &body) {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    if let Err(e) = std::fs::rename(&tmp, dir.join(&name)) {
        let _ = std::fs::remove_file(&tmp);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    for other in ["jpg", "png", "webp"] {
        if other != ext {
            let _ = std::fs::remove_file(dir.join(format!("{playlist_id}.{other}")));
        }
    }

    state
        .db
        .set_playlist_meta(playlist_id, None, None, Some(&name))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "cover": name })))
}

/// Drop a playlist's cover, falling the tile back to its song mosaic.
pub async fn remove(
    State(state): State<Arc<AppState>>,
    Path(playlist_id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    match state.db.playlist_owner(playlist_id) {
        Some(owner) if owner == caller.id => {}
        _ => return Err((StatusCode::NOT_FOUND, "no such playlist".to_string())),
    }
    if let Some(name) = state.db.playlist_cover(playlist_id) {
        let _ = std::fs::remove_file(covers_dir(&state).join(name));
    }
    state
        .db
        .set_playlist_meta(playlist_id, None, None, Some(""))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// Serve a cover.
///
/// Accepts the stream token as well as the bearer, through the same door art
/// and canvas use: an `<img src>` cannot carry an Authorization header, so a
/// cover that only accepted one would be unreachable from the markup that needs
/// it.
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(playlist_id): Path<i64>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    request: axum::extract::Request<axum::body::Body>,
) -> Result<axum::response::Response, StatusCode> {
    crate::stream::caller_from_either(&state, &headers, &params)?;
    let name = state
        .db
        .playlist_cover(playlist_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let path = covers_dir(&state).join(&name);
    if !path.exists() {
        return Err(StatusCode::NOT_FOUND);
    }
    use axum::response::IntoResponse;
    use tower::ServiceExt;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut response = tower_http::services::ServeFile::new_with_mime(&path, &mime)
        .oneshot(request)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_response();
    // A cover CAN change, unlike a canvas clip, so this is revalidated rather
    // than immutable - the filename stays the same when a JPEG replaces a
    // JPEG, and an immutable year would pin the old picture on every device
    // that had already seen it.
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "private, max-age=0, must-revalidate".parse().unwrap(),
    );
    Ok(response)
}
