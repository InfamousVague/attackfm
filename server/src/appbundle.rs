//! Publishing the app's frontend to its own devices.
//!
//! The counterpart to src-tauri/src/bundle.rs. A hub serves the web bundle it
//! wants its phones running; the phones fetch it and run it at their next
//! launch, which is how a TypeScript change reaches a device without an app
//! store or a sideloaded APK.
//!
//! What is served is whatever `redeploy` last placed in `<data>/appbundle/`,
//! and the manifest is generated FROM THOSE FILES rather than stored beside
//! them - a manifest that disagreed with the bytes on disk would fail the
//! device's checksum test and quarantine a perfectly good version.

use crate::{auth, AppState};
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;

type ApiError = (StatusCode, String);

fn dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("appbundle")
}

/// The version is the directory's own marker file, written by the publisher.
fn published_version(state: &AppState) -> Option<String> {
    std::fs::read_to_string(dir(state).join("VERSION"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `GET /api/app/bundle` - what this hub is publishing, or 404 when nothing is.
pub async fn manifest(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let base = dir(&state);
    let version = published_version(&state)
        .ok_or((StatusCode::NOT_FOUND, "this server publishes no bundle".into()))?;

    let mut files = Vec::new();
    let entries = std::fs::read_dir(&base)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if name == "VERSION" || name == "NATIVE" || name == "NOTES" {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let sum: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        files.push(json!({ "name": name, "sha256": sum, "bytes": bytes.len() }));
    }
    if files.is_empty() {
        return Err((StatusCode::NOT_FOUND, "the published bundle is empty".into()));
    }

    // The native generation the bundle was built against; devices older than
    // it refuse the download rather than run code their binary cannot serve.
    let native: u32 = std::fs::read_to_string(base.join("NATIVE"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(1);

    // What changed, if the publisher wrote any. Absent is fine: an update
    // with no story still installs, it just arrives quietly.
    let notes = std::fs::read_to_string(base.join("NOTES")).unwrap_or_default();

    Ok(Json(json!({
        "version": version,
        "native": native,
        "files": files,
        "notes": notes,
    })))
}

/// `GET /api/app/bundle/{name}` - one file from the published bundle.
///
/// Deliberately UNAUTHENTICATED, unlike everything around it. The download
/// runs in the NATIVE half of the updater (src-tauri/src/bundle.rs), a bare
/// reqwest that sets no headers - and for four releases its fetches met this
/// endpoint's old `require_caller` 401 and every update died silently, on
/// every device, with nothing logged anywhere. What is served is the app's
/// own frontend, the same bytes published on GitHub: there is nothing here
/// worth a token, and requiring one only re-breaks every phone whose
/// installed build predates the fix. The manifest above stays authed; the
/// name is traversal-guarded below.
pub async fn file(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> Result<Response, ApiError> {
    // The name indexes a flat directory and must not walk out of it.
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.len() > 128 {
        return Err((StatusCode::BAD_REQUEST, "not a bundle file".into()));
    }
    let path = dir(&state).join(&name);
    let bytes = std::fs::read(&path).map_err(|_| (StatusCode::NOT_FOUND, "no such file".into()))?;
    let mime = if name.ends_with(".js") {
        "text/javascript"
    } else if name.ends_with(".css") {
        "text/css"
    } else {
        "application/octet-stream"
    };
    Ok(([(header::CONTENT_TYPE, mime)], bytes).into_response())
}
