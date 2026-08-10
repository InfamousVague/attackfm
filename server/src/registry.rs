//! The registry: identities that outlive any one server.
//!
//! Every other account in this codebase belongs to a box. A registry handle
//! belongs to a person: they claim it once, announce whichever server their
//! library currently answers on, and find each other by name from anywhere.
//! That is the whole reason it exists - two people who each self-host cannot
//! discover one another without somewhere neutral to look.
//!
//! It runs as a namespace on an ordinary AttackFM server (`/api/registry/*`)
//! rather than as its own binary, so it can be hosted today on the instance
//! that is already up. Nothing about it assumes it is running beside the
//! library it describes: the handle's `server_url` is announced, never
//! inferred, which is what lets the registry move to attack.fm later without
//! anything else changing.
//!
//! Auth here is its own bearer token, separate from the local session. A
//! request carrying a local login is NOT a registry caller and vice versa -
//! the two identities are deliberately not interchangeable.
//!
//! Sharing is stored per direction. Letting somebody into your library is not
//! the same as agreeing to be let into theirs, and a model that cannot say so
//! would quietly make every friendship mutual.

use crate::auth;
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

/// What one person can hand another. Anything outside this set is dropped on
/// the way in, so a client cannot invent a permission by sending a new word.
const GRANTS: [&str; 4] = ["catalog", "playlists", "liked", "stats"];

fn clean_grants(raw: &[String]) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for want in raw {
        let want = want.trim().to_ascii_lowercase();
        if let Some(g) = GRANTS.iter().find(|g| **g == want) {
            if !kept.contains(g) {
                kept.push(g);
            }
        }
    }
    kept.join(",")
}

fn bad(msg: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, msg.to_string())
}

/// The registry caller behind a request, or 401.
fn caller(state: &Arc<AppState>, headers: &HeaderMap) -> Result<(i64, String), ApiError> {
    let token = auth::bearer(headers)
        .ok_or((StatusCode::UNAUTHORIZED, "claim a handle first".to_string()))?;
    state
        .db
        .registry_account_for_token(&token)
        .ok_or((StatusCode::UNAUTHORIZED, "that registry session has expired".to_string()))
}

#[derive(Deserialize)]
pub struct ClaimBody {
    pub handle: String,
    pub password: String,
}

/// `POST /api/registry/claim` - take a handle, and get a session for it.
///
/// The rules are the local server's, on purpose: a handle is a name people
/// type at each other, so it may only hold what a person can reliably say and
/// spell, and the password floor matches the one the rest of the app already
/// enforces.
pub async fn claim(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ClaimBody>,
) -> ApiResult {
    let handle = body.handle.trim().to_string();
    if handle.len() < 3 || handle.len() > 24 {
        return Err(bad("a handle is 3 to 24 characters"));
    }
    if !handle.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err(bad("handles can hold letters, numbers, dot, dash and underscore"));
    }
    if body.password.len() < 8 {
        return Err(bad("password must be at least 8 characters"));
    }
    if state.db.registry_account_by_handle(&handle).is_some() {
        return Err((StatusCode::CONFLICT, format!("{handle} is taken")));
    }
    let hash = auth::hash_password(&body.password).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let id = state
        .db
        .registry_create(&handle, &hash)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let token = auth::random_token();
    state
        .db
        .registry_token_put(&token, id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "token": token, "handle": handle })))
}

/// `POST /api/registry/login` - sign back in to a handle already claimed.
pub async fn login(State(state): State<Arc<AppState>>, Json(body): Json<ClaimBody>) -> ApiResult {
    let handle = body.handle.trim();
    let Some((id, handle, hash)) = state.db.registry_account_auth(handle) else {
        return Err((StatusCode::UNAUTHORIZED, "wrong handle or password".into()));
    };
    if !auth::verify_password(&body.password, &hash) {
        return Err((StatusCode::UNAUTHORIZED, "wrong handle or password".into()));
    }
    let token = auth::random_token();
    state
        .db
        .registry_token_put(&token, id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "token": token, "handle": handle })))
}

/// `GET /api/registry/me` - who this token is, and what it has announced.
pub async fn me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let (id, handle) = caller(&state, &headers)?;
    let account = state.db.registry_account(id);
    Ok(Json(json!({
        "handle": handle,
        "serverUrl": account.map(|a| a.server_url).unwrap_or_default(),
        "stats": state.db.registry_stats(id),
    })))
}

#[derive(Deserialize)]
pub struct AnnounceBody {
    /// Where this person's library answers right now.
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(default)]
    pub songs: i64,
    #[serde(default)]
    pub playlists: i64,
    #[serde(default)]
    pub liked: i64,
    #[serde(default)]
    pub artists: i64,
    #[serde(default)]
    pub bytes: i64,
}

/// `POST /api/registry/announce` - "my library is here, and this is its size".
///
/// The client calls this as it starts. Two things come of it: friends learn
/// which address to reach, and the numbers on a friends list can be shown
/// without waking every friend's server to ask.
pub async fn announce(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AnnounceBody>,
) -> ApiResult {
    let (id, _) = caller(&state, &headers)?;
    let url = body.server_url.trim();
    if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(bad("a server address starts with http:// or https://"));
    }
    state
        .db
        .registry_announce(id, url, body.songs, body.playlists, body.liked, body.artists, body.bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

/// `GET /api/registry/search?q=` - find people by handle.
///
/// Prefix matching, not substring: a handle is something you are told, and
/// searching the middle of every name turns a directory into a way to browse
/// strangers.
pub async fn search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> ApiResult {
    let (me_id, _) = caller(&state, &headers)?;
    let q = query.q.trim();
    if q.len() < 2 {
        return Ok(Json(json!({ "results": [] })));
    }
    let friends: Vec<i64> = state.db.registry_friend_ids(me_id);
    let outgoing: Vec<i64> =
        state.db.registry_requests_out(me_id).into_iter().map(|(_, id, _)| id).collect();
    let results: Vec<_> = state
        .db
        .registry_search(q, 20)
        .into_iter()
        .filter(|(id, _, _)| *id != me_id)
        .map(|(id, handle, server_url)| {
            json!({
                "id": id,
                "handle": handle,
                "hasServer": !server_url.is_empty(),
                // So the row can say "Friends" or "Asked" instead of offering
                // an Add that would only bounce.
                "friend": friends.contains(&id),
                "asked": outgoing.contains(&id),
            })
        })
        .collect();
    Ok(Json(json!({ "results": results })))
}

/// `GET /api/registry/friends` - the whole page: friends with what they share
/// and how big their library is, plus both directions of pending asks.
pub async fn friends(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let (me_id, _) = caller(&state, &headers)?;

    let friends: Vec<_> = state
        .db
        .registry_friends(me_id)
        .into_iter()
        .map(|f| {
            // Only the numbers they actually share are reported. Stats is a
            // grant like any other, so a friend who has not given it does not
            // leak their library size through the friends list.
            let shares_stats = f.they_share.split(',').any(|g| g == "stats");
            json!({
                "id": f.id,
                "handle": f.handle,
                "serverUrl": f.server_url,
                "since": f.since,
                // What I have given them, and what they have given me.
                "iShare": f.i_share.split(',').filter(|s| !s.is_empty()).collect::<Vec<_>>(),
                "theyShare": f.they_share.split(',').filter(|s| !s.is_empty()).collect::<Vec<_>>(),
                "stats": if shares_stats { state.db.registry_stats(f.id) } else { serde_json::Value::Null },
            })
        })
        .collect();

    let incoming: Vec<_> = state
        .db
        .registry_requests_in(me_id)
        .into_iter()
        .map(|(id, uid, handle)| json!({ "id": id, "userId": uid, "handle": handle }))
        .collect();
    let outgoing: Vec<_> = state
        .db
        .registry_requests_out(me_id)
        .into_iter()
        .map(|(id, uid, handle)| json!({ "id": id, "userId": uid, "handle": handle }))
        .collect();

    Ok(Json(json!({ "friends": friends, "incoming": incoming, "outgoing": outgoing })))
}

#[derive(Deserialize)]
pub struct AskBody {
    pub handle: String,
}

/// `POST /api/registry/requests` - ask by handle. A crossing ask settles the
/// pair rather than filing a mirror of it, same as the local friends do.
pub async fn ask(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AskBody>,
) -> ApiResult {
    let (me_id, _) = caller(&state, &headers)?;
    let handle = body.handle.trim();
    let Some((them, their_handle, _)) = state.db.registry_account_auth(handle) else {
        return Err((StatusCode::NOT_FOUND, format!("no handle called {handle}")));
    };
    if them == me_id {
        return Err(bad("you are already your own best friend"));
    }
    if state.db.registry_are_friends(me_id, them) {
        return Err((StatusCode::CONFLICT, format!("you and {their_handle} are already friends")));
    }
    if let Some((rid, _, _)) =
        state.db.registry_requests_in(me_id).into_iter().find(|(_, id, _)| *id == them)
    {
        state
            .db
            .registry_befriend(me_id, them)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let _ = state.db.registry_request_delete(rid);
        return Ok(Json(json!({ "ok": true, "friends": true })));
    }
    state
        .db
        .registry_request_add(me_id, them)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true, "friends": false })))
}

pub async fn accept(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult {
    let (me_id, _) = caller(&state, &headers)?;
    let Some((from, to)) = state.db.registry_request(id) else {
        return Err((StatusCode::NOT_FOUND, "that request is gone".into()));
    };
    if to != me_id {
        return Err((StatusCode::FORBIDDEN, "not your request to answer".into()));
    }
    state
        .db
        .registry_befriend(from, to)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn decline(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult {
    let (me_id, _) = caller(&state, &headers)?;
    let Some((from, to)) = state.db.registry_request(id) else {
        return Err((StatusCode::NOT_FOUND, "that request is gone".into()));
    };
    if to != me_id && from != me_id {
        return Err((StatusCode::FORBIDDEN, "not your request to answer".into()));
    }
    state
        .db
        .registry_request_delete(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn unfriend(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult {
    let (me_id, _) = caller(&state, &headers)?;
    state
        .db
        .registry_unfriend(me_id, id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct SharesBody {
    /// The whole set this friend should have, not a delta - a client that
    /// sends nothing is revoking, which is exactly what an empty list means.
    pub shares: Vec<String>,
}

/// `POST /api/registry/friends/{id}/shares` - per-friend management: decide
/// what this one person gets. Writes only MY side of the pair; theirs is
/// theirs to set.
pub async fn set_shares(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<SharesBody>,
) -> ApiResult {
    let (me_id, _) = caller(&state, &headers)?;
    if !state.db.registry_are_friends(me_id, id) {
        return Err((StatusCode::FORBIDDEN, "you are not friends".into()));
    }
    let grants = clean_grants(&body.shares);
    state
        .db
        .registry_set_shares(me_id, id, &grants)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true, "shares": grants.split(',').filter(|s| !s.is_empty()).collect::<Vec<_>>() })))
}
