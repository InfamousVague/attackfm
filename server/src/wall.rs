//! The public wall: a random handful of this library's covers and Canvas
//! clips, for a page that has no sign-in - the invite link's landing on the
//! registry, which draws the server it is inviting to rather than a stock
//! wall. `/api/wall` hands out URLs this server signed for the day; the art
//! and clip routes serve only what carries such a signature, so nothing here
//! is an open door to the library - it is a glance, chosen by the server.
use crate::{auth, canvas, stream, AppState};
use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

const COVERS: i64 = 24;
const CANVASES: usize = 6;

/// `GET /api/wall` - covers and clips, fresh every ask.
pub async fn wall(State(state): State<Arc<AppState>>) -> Json<Value> {
    let covers: Vec<String> = state
        .db
        .random_art_ids(COVERS)
        .into_iter()
        .map(|id| {
            let sig = auth::public_sig(&state.stream_secret, &format!("art.{id}"));
            format!("/api/wall/art/{id}/{sig}")
        })
        .collect();
    let canvases: Vec<String> = canvas::sample_sidecars(&state, CANVASES)
        .into_iter()
        .map(|id| {
            let sig = auth::public_sig(&state.stream_secret, &format!("canvas.{id}"));
            format!("/api/wall/canvas/{id}/{sig}")
        })
        .collect();
    Json(json!({ "covers": covers, "canvases": canvases }))
}

/// `GET /api/wall/art/{id}/{sig}` - a cover the wall named. `?w=` variants as
/// the member route takes them.
pub async fn art(
    State(state): State<Arc<AppState>>,
    Path((id, sig)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    if !auth::public_sig_ok(&state.stream_secret, &format!("art.{id}"), &sig) {
        return Err(StatusCode::FORBIDDEN);
    }
    stream::serve_art(&state, &id, &params, &headers, request).await
}

/// `GET /api/wall/canvas/{id}/{sig}` - a clip the wall named.
pub async fn canvas_clip(
    State(state): State<Arc<AppState>>,
    Path((id, sig)): Path<(i64, String)>,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    if !auth::public_sig_ok(&state.stream_secret, &format!("canvas.{id}"), &sig) {
        return Err(StatusCode::FORBIDDEN);
    }
    canvas::serve_media(&state, id, request).await
}
