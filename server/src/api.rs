//! The JSON surface: accounts, the library delta, favourites, playlists, and
//! resume positions.
//!
//! Everything here is small and cacheable. The bytes that matter - audio and
//! cover art - are `stream.rs`'s business and never travel through a JSON
//! response.

use crate::auth;
use crate::scan;
use crate::upload::human_bytes;
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

fn bad(status: StatusCode, message: &str) -> ApiError {
    (status, message.to_string())
}

// --- the handshake --------------------------------------------------------

/// `GET /api/server` - the only endpoint that answers without a token.
///
/// It is how a client decides what screen to show before it has credentials:
/// an empty server needs its first account made, a set-up one needs a sign-in,
/// and a server without ffmpeg should not be offering a quality slider.
pub async fn server_info(State(state): State<Arc<AppState>>) -> ApiResult {
    Ok(Json(json!({
        "name": state.server_name,
        "version": env!("CARGO_PKG_VERSION"),
        "api": 1,
        // No users yet: whoever registers first becomes the admin.
        "needsSetup": state.db.user_count() == 0,
        "transcode": state.ffmpeg,
        "tracks": state.db.track_count(),
    })))
}

#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

/// `POST /api/auth/register`
///
/// Open only until the first account exists; after that it is an admin's call
/// who else gets in. A personal music server that stayed open to registration
/// would be a public music server by the end of the week.
pub async fn register(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Credentials>,
) -> ApiResult {
    let first = state.db.user_count() == 0;
    if !first {
        auth::require_admin(&state.db, &headers)
            .map_err(|_| bad(StatusCode::FORBIDDEN, "only an admin can add accounts"))?;
    }

    let username = body.username.trim().to_string();
    if username.len() < 2 || username.len() > 40 {
        return Err(bad(StatusCode::BAD_REQUEST, "username must be 2-40 characters"));
    }
    if body.password.len() < 8 {
        return Err(bad(StatusCode::BAD_REQUEST, "password must be at least 8 characters"));
    }
    if state.db.user_by_name(&username).is_some() {
        return Err(bad(StatusCode::CONFLICT, "that name is taken"));
    }

    let hash = auth::hash_password(&body.password)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let id = state
        .db
        .create_user(&username, &hash, first)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(json!({ "id": id, "username": username, "isAdmin": first })))
}

/// `POST /api/auth/login` - a session token plus the stream token that lets a
/// media element fetch bytes.
pub async fn login(State(state): State<Arc<AppState>>, Json(body): Json<Credentials>) -> ApiResult {
    let user = state
        .db
        .user_by_name(body.username.trim())
        .filter(|u| auth::verify_password(&body.password, &u.pass_hash))
        // One message for both halves: saying which of the two was wrong tells
        // an attacker which usernames exist.
        .ok_or_else(|| bad(StatusCode::UNAUTHORIZED, "wrong name or password"))?;

    let token = auth::random_token();
    state
        .db
        .create_token(&token, user.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let stream_token = auth::mint_stream_token(&state.stream_secret, user.id, user.stream_epoch);

    Ok(Json(json!({
        "token": token,
        "streamToken": stream_token,
        "streamTokenExpires": auth::STREAM_TOKEN_TTL_SECS,
        "user": { "id": user.id, "username": user.username, "isAdmin": user.is_admin },
    })))
}

/// `POST /api/auth/logout` - drops this device's session only.
pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    if let Some(token) = auth::bearer(&headers) {
        let _ = state.db.delete_token(&token);
    }
    Ok(Json(json!({ "ok": true })))
}

/// `GET /api/me` - who is calling, and a freshly minted stream token.
///
/// The client calls this when a stream URL starts coming back 401, which is how
/// an expired stream token renews itself without a re-login.
pub async fn me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let user = state
        .db
        .user_by_id(caller.id)
        .ok_or_else(|| bad(StatusCode::UNAUTHORIZED, "account is gone"))?;
    let stream_token = auth::mint_stream_token(&state.stream_secret, user.id, user.stream_epoch);
    Ok(Json(json!({
        "id": user.id,
        "username": user.username,
        "isAdmin": user.is_admin,
        "streamToken": stream_token,
        "streamTokenExpires": auth::STREAM_TOKEN_TTL_SECS,
    })))
}

// --- the library ----------------------------------------------------------

/// `GET /api/library?since=&limit=` - everything that changed above `since`.
///
/// Delta sync rather than a full index: a phone that has been away for a day
/// downloads the four tracks that arrived, not the ten thousand it already
/// has. `rev` in the reply is what to pass as `since` next time, and `more`
/// says whether the page hit its limit and should be asked for again.
pub async fn library(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let since: i64 = params.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    let limit: i64 = params
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5000)
        .clamp(1, 20_000);

    let (tracks, removed, page_rev) = state.db.tracks_since(since, limit);
    let more = (tracks.len() as i64 + removed.len() as i64) >= limit;

    Ok(Json(json!({
        // The whole-library revision, so a client that has drained every page
        // knows what it is caught up to.
        "rev": if more { page_rev } else { state.db.current_rev() },
        "more": more,
        "tracks": tracks,
        "removed": removed,
    })))
}

/// One side of the sync handshake: how a track is recognised across devices.
/// Normalised tags, because paths differ per machine and hashes differ per rip.
fn sync_key(title: &str, artist: &str, album: &str) -> String {
    let norm = |s: &str| s.trim().to_lowercase();
    format!("{}\u{1}{}\u{1}{}", norm(title), norm(artist), norm(album))
}

#[derive(serde::Deserialize)]
pub struct MissingQuery {
    pub tracks: Vec<MissingEntry>,
}

#[derive(serde::Deserialize)]
pub struct MissingEntry {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    /// Seconds, when the client knows it.
    #[serde(default)]
    pub duration: Option<f64>,
}

/// `POST /api/library/missing` - which of these tracks the server lacks.
///
/// The reply is indices into the request, so the client can upload exactly
/// what is absent and skip what is already here - the precheck that makes
/// folder sync idempotent instead of a duplicate factory (`finish` suffixes
/// name collisions rather than overwriting; see upload.rs).
///
/// A track counts as present when tags match (case-insensitive title, artist,
/// album) and any known durations agree within three seconds. The artist leg
/// matches either the track artist or the album artist, because compilations
/// disagree with themselves about which one names the song.
pub async fn library_missing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<MissingQuery>,
) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    use std::collections::HashMap as Map;
    let mut have: Map<String, Vec<Option<i64>>> = Map::new();
    // A third, artist-less leg (title + album only) absorbs the ways two tag
    // readers join a multi-artist credit differently ("A & B" vs "A; B" vs
    // "A feat. B") - within one ALBUM, an identical title with a duration
    // within tolerance is the same recording, whoever the credit names.
    let mut have_loose: Map<String, Vec<Option<i64>>> = Map::new();
    for (title, artist, album_artist, album, duration_ms) in state.db.sync_identities() {
        have.entry(sync_key(&title, &artist, &album))
            .or_default()
            .push(duration_ms);
        if album_artist.trim().to_lowercase() != artist.trim().to_lowercase() {
            have.entry(sync_key(&title, &album_artist, &album))
                .or_default()
                .push(duration_ms);
        }
        if !album.trim().is_empty() {
            have_loose
                .entry(sync_key(&title, "", &album))
                .or_default()
                .push(duration_ms);
        }
    }

    let duration_close = |ours: &[Option<i64>], theirs: Option<f64>| -> bool {
        let Some(theirs) = theirs else { return true };
        ours.iter().any(|ms| match ms {
            None => true,
            Some(ms) => ((*ms as f64) / 1000.0 - theirs).abs() <= 3.0,
        })
    };

    let missing: Vec<usize> = body
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            let exact = have
                .get(&sync_key(&t.title, &t.artist, &t.album))
                .is_some_and(|durs| duration_close(durs, t.duration));
            let loose = !t.album.trim().is_empty()
                && have_loose
                    .get(&sync_key(&t.title, "", &t.album))
                    .is_some_and(|durs| duration_close(durs, t.duration));
            !(exact || loose)
        })
        .map(|(i, _)| i)
        .collect();

    Ok(Json(json!({ "missing": missing })))
}

/// `GET /api/scan` - how the indexer is doing.
pub async fn scan_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let used = state.db.total_bytes();
    let mut status = state.progress.snapshot();
    if let Some(obj) = status.as_object_mut() {
        obj.insert("tracks".into(), json!(state.db.track_count()));
        obj.insert("bytes".into(), json!(used));
        obj.insert("bytesLabel".into(), json!(human_bytes(used)));
        obj.insert("quota".into(), json!(state.library_quota_bytes));
        obj.insert("rev".into(), json!(state.db.current_rev()));
    }
    Ok(Json(status))
}

/// `POST /api/scan` - re-walk the music root now.
pub async fn scan_now(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    scan::spawn_scan(
        state.db.clone(),
        state.music_root.clone(),
        state.art_dir.clone(),
        state.progress.clone(),
    );
    Ok(Json(json!({ "started": true })))
}

/// The volume the music lives on, asked of `df` - dependency-free, and the
/// server already shells out for heavier things (ffmpeg, the importer). POSIX
/// `-kP` output is two lines: a header, then
/// `filesystem 1024-blocks used available capacity mount`. Best-effort: a
/// container without `df` just reports no disk numbers rather than an error.
fn disk_space(path: &std::path::Path) -> Option<(i64, i64)> {
    let out = std::process::Command::new("df")
        .arg("-kP")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1)?;
    let mut cols = line.split_whitespace();
    let total_kb: i64 = cols.nth(1)?.parse().ok()?;
    let _used = cols.next()?;
    let free_kb: i64 = cols.next()?.parse().ok()?;
    Some((total_kb * 1024, free_kb * 1024))
}

/// `GET /api/stats` - the numbers behind the settings dashboard, one call.
///
/// Everything a client would otherwise stitch together from three endpoints
/// (plus the two things it cannot derive at all: process uptime and the real
/// free space on the music volume). Any signed-in caller may read it - it is
/// the user's own server, and nothing here is a secret from a listener whose
/// uploads share the same disk.
pub async fn stats(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let used = state.db.total_bytes();
    let disk = disk_space(&state.music_root);
    let (queued, downloading) = {
        let jobs = state.imports.jobs.lock().await;
        (
            jobs.iter().filter(|j| j.state == "queued").count(),
            jobs.iter().filter(|j| j.state == "downloading").count(),
        )
    };

    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "name": state.server_name,
        "uptimeSecs": state.started.elapsed().as_secs(),
        "tracks": state.db.track_count(),
        "users": state.db.user_count(),
        "bytesUsed": used,
        "bytesLabel": human_bytes(used),
        "quotaBytes": state.library_quota_bytes,
        "diskTotalBytes": disk.map(|(total, _)| total),
        "diskFreeBytes": disk.map(|(_, free)| free),
        "transcode": state.ffmpeg,
        "importsQueued": queued,
        "importsActive": downloading,
    })))
}

// --- favourites -----------------------------------------------------------

pub async fn favorites(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    Ok(Json(json!({ "tracks": state.db.favorites(caller.id) })))
}

#[derive(Deserialize)]
pub struct FavoriteBody {
    pub favorite: bool,
}

pub async fn set_favorite(
    State(state): State<Arc<AppState>>,
    Path(track_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<FavoriteBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .set_favorite(caller.id, track_id, body.favorite)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // Adoption: a heart on a collector download is deliberate approval - it
    // skips the audition entirely and joins the library at once.
    if body.favorite {
        state.db.promote_curator_track(track_id);
    }
    Ok(Json(json!({ "ok": true })))
}

// --- playlists ------------------------------------------------------------

pub async fn playlists(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let lists: Vec<_> = state
        .db
        .playlists(caller.id)
        .into_iter()
        .map(|(id, name, updated, tracks)| {
            json!({ "id": id, "name": name, "updatedAt": updated, "tracks": tracks })
        })
        .collect();
    Ok(Json(json!({ "playlists": lists })))
}

#[derive(Deserialize)]
pub struct PlaylistBody {
    pub name: Option<String>,
    pub tracks: Option<Vec<i64>>,
}

pub async fn create_playlist(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PlaylistBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let name = body.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "a playlist needs a name"));
    }
    let id = state
        .db
        .create_playlist(caller.id, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(tracks) = body.tracks {
        let _ = state.db.set_playlist_tracks(id, &tracks);
    }
    Ok(Json(json!({ "id": id, "name": name })))
}

/// Refuses any playlist the caller does not own. Ownership is checked on every
/// edit rather than trusted from the list response - two accounts on one server
/// should not be able to reach into each other's playlists by guessing an id.
fn owned_playlist(state: &AppState, caller_id: i64, playlist_id: i64) -> Result<(), ApiError> {
    match state.db.playlist_owner(playlist_id) {
        Some(owner) if owner == caller_id => Ok(()),
        // Same answer either way, so a probe cannot enumerate what exists.
        _ => Err(bad(StatusCode::NOT_FOUND, "no such playlist")),
    }
}

pub async fn update_playlist(
    State(state): State<Arc<AppState>>,
    Path(playlist_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<PlaylistBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    owned_playlist(&state, caller.id, playlist_id)?;
    if let Some(name) = body.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        let _ = state.db.rename_playlist(playlist_id, name);
    }
    if let Some(tracks) = body.tracks {
        state
            .db
            .set_playlist_tracks(playlist_id, &tracks)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_playlist(
    State(state): State<Arc<AppState>>,
    Path(playlist_id): Path<i64>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    owned_playlist(&state, caller.id, playlist_id)?;
    let _ = state.db.delete_playlist(playlist_id);
    Ok(Json(json!({ "ok": true })))
}

// --- resume positions -----------------------------------------------------

#[derive(Deserialize)]
pub struct PlayStateBody {
    #[serde(rename = "trackId")]
    pub track_id: i64,
    #[serde(rename = "positionMs")]
    pub position_ms: i64,
}

pub async fn set_play_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PlayStateBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .set_play_state(caller.id, body.track_id, body.position_ms.max(0))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn play_states(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let states: Vec<_> = state
        .db
        .play_states(caller.id, 100)
        .into_iter()
        .map(|(track_id, position_ms, updated)| {
            json!({ "trackId": track_id, "positionMs": position_ms, "updatedAt": updated })
        })
        .collect();
    Ok(Json(json!({ "states": states })))
}

// --- accounts (admin) -----------------------------------------------------

pub async fn list_users(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    let users: Vec<_> = state
        .db
        .list_users()
        .into_iter()
        .map(|(id, username, is_admin)| json!({ "id": id, "username": username, "isAdmin": is_admin }))
        .collect();
    Ok(Json(json!({ "users": users })))
}

pub async fn delete_user(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i64>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    if caller.id == user_id {
        return Err(bad(StatusCode::BAD_REQUEST, "an admin cannot delete themselves"));
    }
    state
        .db
        .delete_user(user_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // A deleted account's media tokens must die with it, not a minute later.
    state.stream_tokens.purge_user(user_id);
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/users/:id/revoke` - kills every stream token that account holds.
pub async fn revoke_streams(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i64>,
    headers: HeaderMap,
) -> ApiResult {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    // Both halves, or the revoke is theatre: the epoch bump invalidates
    // stream tokens already in the wild, and dropping the session tokens
    // stops the client from just minting fresh ones via /api/me.
    state
        .db
        .bump_stream_epoch(user_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state
        .db
        .delete_tokens_for_user(user_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // The verified-token cache would otherwise honour the old epoch for up to
    // its TTL - purge it so the revoke means now.
    state.stream_tokens.purge_user(user_id);
    Ok(Json(json!({ "ok": true })))
}
