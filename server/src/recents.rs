//! Search recents, synced: what this listener searched for and actually
//! opened, kept on the server so every device shows the same short memory.
//!
//! The rows are deliberately opaque to the server. A recent may point at
//! anything - a local track, an external album, an artist page - so kind+key
//! name it and title, subtitle, cover and url are enough to draw it. The
//! server only remembers, newest first, and forgets past forty; the client
//! decides what a tap on one means.

use crate::auth;
use crate::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

/// `GET /api/recents` - this listener's recents, newest first, capped at
/// twenty. The table keeps forty (see touch_recent), so the cap here is a
/// display decision rather than a storage one.
pub async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    Ok(Json(json!({ "recents": state.db.recents(caller.id, 20) })))
}

#[derive(Deserialize)]
pub struct AddBody {
    pub kind: String,
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub url: String,
}

/// `POST /api/recents` - record one opened result. Opening it again bumps it
/// to the top rather than filing a duplicate.
pub async fn add(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AddBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let kind = body.kind.trim();
    let key = body.key.trim();
    let title = body.title.trim();
    if kind.is_empty() || key.is_empty() || title.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "kind, key and title are required".into()));
    }
    state
        .db
        .touch_recent(caller.id, kind, key, title, &body.subtitle, &body.cover, &body.url)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RemoveBody {
    pub kind: String,
    pub key: String,
}

/// `POST /api/recents/remove` - forget one. Silent when it was already gone:
/// the end state is what was asked for either way.
pub async fn remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RemoveBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .remove_recent(caller.id, body.kind.trim(), body.key.trim())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/recents/clear` - forget everything.
pub async fn clear(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .clear_recents(caller.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}
