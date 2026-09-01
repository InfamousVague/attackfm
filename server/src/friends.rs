//! Friends: who knows whom on this server, and the asks in flight between
//! them.
//!
//! The shape mirrors PrettyCardboard's: one endpoint answers "how do I stand
//! with everyone" (friends, asks aimed at me, asks I sent), and the rest are
//! the four verbs that move a pair between those states - request, accept,
//! decline, remove. A request is one row that exists until answered; a
//! friendship is one row, not two.
//!
//! Everything here is between accounts ON THIS SERVER. That is the whole of
//! what a self-hosted instance can settle by itself: it knows its own users
//! and nobody else's. Reaching a friend who runs their OWN AttackFM - and so
//! sharing libraries across two boxes - needs a directory both instances
//! trust to introduce them, which is a separate piece of work.

use crate::auth;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

/// `GET /api/friends` - everyone this account knows, plus both directions of
/// pending asks. One request answers the whole page.
pub async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let friends: Vec<_> = state
        .db
        .friends_of(caller.id)
        .into_iter()
        .map(|(id, username)| json!({ "userId": id, "username": username }))
        .collect();
    let incoming: Vec<_> = state
        .db
        .incoming_requests(caller.id)
        .into_iter()
        .map(|(id, uid, username)| json!({ "id": id, "userId": uid, "username": username }))
        .collect();
    let outgoing: Vec<_> = state
        .db
        .outgoing_requests(caller.id)
        .into_iter()
        .map(|(id, uid, username)| json!({ "id": id, "userId": uid, "username": username }))
        .collect();

    Ok(Json(json!({ "friends": friends, "incoming": incoming, "outgoing": outgoing })))
}

#[derive(Deserialize)]
pub struct RequestBody {
    /// Who to ask, by the name they signed up with.
    pub username: String,
}

/// `POST /api/friends/requests` - ask someone to be friends, by name.
///
/// An ask that crosses one already coming the other way is not a second ask:
/// it is an accept, and this settles it as one. Otherwise two people who
/// reach for each other at the same moment sit staring at requests neither
/// can complete.
pub async fn request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RequestBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let name = body.username.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "who do you want to add?".into()));
    }
    let Some((target_id, target_name)) = state.db.user_by_username(name) else {
        return Err((StatusCode::NOT_FOUND, format!("no account called {name} here")));
    };
    if target_id == caller.id {
        return Err((StatusCode::BAD_REQUEST, "you are already your own best friend".into()));
    }
    if state.db.are_friends(caller.id, target_id) {
        return Err((StatusCode::CONFLICT, format!("you and {target_name} are already friends")));
    }

    // They asked first: take it as the answer rather than filing a mirror.
    let crossed = state
        .db
        .incoming_requests(caller.id)
        .into_iter()
        .find(|(_, uid, _)| *uid == target_id);
    if let Some((request_id, _, _)) = crossed {
        state
            .db
            .add_friendship(caller.id, target_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let _ = state.db.delete_friend_request(request_id);
        return Ok(Json(json!({ "ok": true, "friends": true })));
    }

    state
        .db
        .add_friend_request(caller.id, target_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true, "friends": false })))
}

#[derive(serde::Deserialize)]
pub struct MirrorBody {
    /// Registry handles of the caller's friends, as the app read them off
    /// attack.fm.
    pub handles: Vec<String>,
}

/// `POST /api/friends/mirror` - the app hands over its REGISTRY friends, and
/// the hub keeps the ones who are members here.
///
/// Friends live on attack.fm; this table gates what is shared inside these
/// walls (playlist members, profiles) and nothing ever filled it - the Friends
/// tab is entirely the registry - so every friendship check here failed for
/// everyone. Rather than trust one client's word about who its friends are,
/// each handle becomes a friend REQUEST from the caller; when the other person's
/// app posts the caller back, the crossed requests settle into a friendship,
/// exactly as two people asking each other would. Symmetric, and no more
/// power than the existing request route.
pub async fn mirror(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<MirrorBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mut befriended = 0usize;
    let mut asked = 0usize;
    for handle in body.handles.iter().take(500) {
        let handle = handle.trim().trim_start_matches('@');
        if handle.is_empty() {
            continue;
        }
        let Some((target_id, _, _, _)) = state.db.member_by_handle(handle) else { continue };
        if target_id == caller.id || state.db.are_friends(caller.id, target_id) {
            continue;
        }
        let crossed = state
            .db
            .incoming_requests(caller.id)
            .into_iter()
            .find(|(_, uid, _)| *uid == target_id);
        if let Some((request_id, _, _)) = crossed {
            if state.db.add_friendship(caller.id, target_id).is_ok() {
                let _ = state.db.delete_friend_request(request_id);
                befriended += 1;
            }
            continue;
        }
        // add_friend_request answers the standing request's id when one
        // already exists, so repeated passes file nothing new.
        if state.db.add_friend_request(caller.id, target_id).is_ok() {
            asked += 1;
        }
    }
    Ok(Json(json!({ "ok": true, "befriended": befriended, "asked": asked })))
}

/// `POST /api/friends/requests/{id}/accept` - only the person asked may.
pub async fn accept(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some((from, to)) = state.db.friend_request(id) else {
        return Err((StatusCode::NOT_FOUND, "that request is gone".into()));
    };
    if to != caller.id {
        return Err((StatusCode::FORBIDDEN, "not your request to answer".into()));
    }
    state
        .db
        .add_friendship(from, to)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/friends/requests/{id}/decline` - the person asked turns it
/// down, or the sender withdraws their own. Either way the row goes.
pub async fn decline(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some((from, to)) = state.db.friend_request(id) else {
        return Err((StatusCode::NOT_FOUND, "that request is gone".into()));
    };
    if to != caller.id && from != caller.id {
        return Err((StatusCode::FORBIDDEN, "not your request to answer".into()));
    }
    state
        .db
        .delete_friend_request(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /api/friends/{user_id}` - unfriend. Silent when they were not a
/// friend: the end state is what was asked for either way.
pub async fn remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<i64>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .remove_friendship(caller.id, user_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}
