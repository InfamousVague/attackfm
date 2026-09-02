//! attackfm-registry — the central identity directory.
//!
//! Accounts, the devices that speak for them, friendships, invites, and the
//! signed tokens every music server trusts. Configured by environment, like the
//! music server: one binary, one SQLite file.
//!
//! | Variable | Default | What it is |
//! |---|---|---|
//! | `AFM_REGISTRY_BIND` | `127.0.0.1` | Interface to bind. Loopback so Caddy fronts it. |
//! | `AFM_REGISTRY_PORT` | `8790` | Port. |
//! | `AFM_REGISTRY_DATA` | `./registry.sqlite3` | The database. |
//!
//! The signing secret is not configuration: it is generated on first boot and
//! kept in the database, so the key and the accounts it vouches for share one
//! file and one backup.

mod db;

use afm_identity::{Claims, Issuer};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::routing::{get, post};
use axum::response::Html;
use axum::{Json, Router};
use axum::response::IntoResponse;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use db::Db;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower_http::cors::{Any, CorsLayer};

/// The secret is stored under this key in the meta table.
const ISSUER_SECRET_KEY: &str = "issuer_secret_b64";
/// A token lives a week; the app refreshes against the registry well before.
const TOKEN_TTL_SECS: i64 = 7 * 24 * 3600;
/// A device-login challenge is good for two minutes.
const CHALLENGE_TTL_SECS: i64 = 120;

struct AppState {
    db: Arc<Db>,
    issuer: Arc<Issuer>,
    /// Outstanding device-login challenges: nonce -> (account_id, issued_at).
    /// In memory: a challenge that outlives a restart is no loss, the device
    /// just asks for another.
    challenges: Mutex<HashMap<String, (i64, i64)>>,
    /// Where the published app frontend lives (beside the database). The
    /// registry is the one service every device talks to regardless of which
    /// music server it listens from - which makes it the natural place updates
    /// come from, the same way sign-in does.
    bundle_dir: std::path::PathBuf,
}

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<Value>, ApiError>;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

// --- passwords --------------------------------------------------------------

fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not hash password".into()))
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

// --- handle rules -----------------------------------------------------------

/// A handle is a person's public name and their login, so it is kept plain:
/// letters, digits, and a few separators, a sane length. Case is preserved for
/// display but compared case-insensitively (the UNIQUE index is NOCASE).
fn valid_handle(handle: &str) -> bool {
    let n = handle.chars().count();
    (3..=24).contains(&n)
        && handle
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && handle.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
}

// --- token ------------------------------------------------------------------

fn issue_token(state: &AppState, account_id: i64, handle: &str) -> String {
    let now = now_secs();
    state.issuer.issue(&Claims {
        sub: account_id,
        handle: handle.to_string(),
        iat: now,
        exp: now + TOKEN_TTL_SECS,
    })
}

/// The bearer of a valid token, or a 401. The registry verifies its own tokens
/// with its own public key, the same offline check a music server does.
fn caller(state: &AppState, headers: &HeaderMap) -> Result<Claims, ApiError> {
    let raw = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or((StatusCode::UNAUTHORIZED, "sign in first".into()))?;
    state
        .issuer
        .verifier()
        .verify(raw.trim(), now_secs())
        .map_err(|_| (StatusCode::UNAUTHORIZED, "session expired - sign in again".into()))
}

fn account_json(a: &db::Account) -> Value {
    json!({ "id": a.id, "handle": a.handle })
}

// --- endpoints --------------------------------------------------------------

async fn health() -> Json<Value> {
    Json(json!({ "service": "attackfm-registry", "ok": true }))
}

/// `GET /v1/pubkey` - the key every music server fetches once to verify tokens
/// offline. Public by nature.
async fn pubkey(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({ "alg": "ed25519", "publicKey": state.issuer.public_b64() }))
}

#[derive(Deserialize)]
struct SignupBody {
    handle: String,
    /// Either a password, a device key, or both. At least one is required.
    #[serde(default)]
    password: String,
    #[serde(default, rename = "devicePublicKey")]
    device_public_key: String,
    #[serde(default, rename = "deviceLabel")]
    device_label: String,
}

/// `POST /v1/signup` - make an account. Open registration: anyone may create a
/// central identity. What that identity can REACH (a server) is gated
/// separately by invites - an account with no membership is a name and a friends
/// list, nothing a server has to honour.
async fn signup(State(state): State<Arc<AppState>>, Json(body): Json<SignupBody>) -> ApiResult {
    let handle = body.handle.trim().to_string();
    if !valid_handle(&handle) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Handle must be 3-24 letters, digits, . _ or -, starting with a letter or digit.".into(),
        ));
    }
    let has_password = !body.password.is_empty();
    let has_device = !body.device_public_key.trim().is_empty();
    if !has_password && !has_device {
        return Err((StatusCode::BAD_REQUEST, "Set a password or pair a device.".into()));
    }
    if has_password && body.password.chars().count() < 8 {
        return Err((StatusCode::BAD_REQUEST, "Password must be at least 8 characters.".into()));
    }
    if state.db.account_by_handle(&handle).is_some() {
        return Err((StatusCode::CONFLICT, "That handle is taken.".into()));
    }

    let hash = if has_password { hash_password(&body.password)? } else { String::new() };
    let now = now_secs();
    let account = state
        .db
        .create_account(&handle, &hash, now)
        // The UNIQUE index is the real gate: a racing signup that slipped past
        // the check above lands here as a constraint error.
        .map_err(|_| (StatusCode::CONFLICT, "That handle is taken.".into()))?;

    if has_device {
        let label = if body.device_label.trim().is_empty() { "device" } else { body.device_label.trim() };
        state
            .db
            .add_device_key(account.id, body.device_public_key.trim(), label, now)
            .map_err(|_| (StatusCode::BAD_REQUEST, "That device key could not be stored.".into()))?;
    }

    Ok(Json(json!({
        "token": issue_token(&state, account.id, &account.handle),
        "account": account_json(&account),
    })))
}

#[derive(Deserialize)]
struct LoginBody {
    handle: String,
    password: String,
}

/// `POST /v1/login` - password sign-in. The generic "wrong handle or password"
/// is deliberate: it does not reveal whether a handle exists.
async fn login(State(state): State<Arc<AppState>>, Json(body): Json<LoginBody>) -> ApiResult {
    let account = state
        .db
        .account_by_handle(body.handle.trim())
        .filter(|a| !a.pass_hash.is_empty() && verify_password(&body.password, &a.pass_hash))
        .ok_or((StatusCode::UNAUTHORIZED, "Wrong handle or password.".into()))?;
    state.db.touch_seen(account.id, now_secs());
    Ok(Json(json!({
        "token": issue_token(&state, account.id, &account.handle),
        "account": account_json(&account),
    })))
}

#[derive(Deserialize)]
struct ChallengeBody {
    handle: String,
}

/// `POST /v1/login/challenge` - step one of a passwordless login. The registry
/// hands out a one-time nonce for the device to sign. Returns a nonce even when
/// the handle is unknown or has no device keys, so this cannot be used to probe
/// which handles exist; the signature check at step two is the real gate.
async fn challenge(State(state): State<Arc<AppState>>, Json(body): Json<ChallengeBody>) -> ApiResult {
    let account_id = state.db.account_by_handle(body.handle.trim()).map(|a| a.id).unwrap_or(-1);
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let nonce = URL_SAFE_NO_PAD.encode(bytes);
    let now = now_secs();
    let mut ch = state.challenges.lock().unwrap();
    ch.retain(|_, (_, issued)| now - *issued < CHALLENGE_TTL_SECS);
    ch.insert(nonce.clone(), (account_id, now));
    Ok(Json(json!({ "nonce": nonce })))
}

#[derive(Deserialize)]
struct DeviceLoginBody {
    handle: String,
    nonce: String,
    signature: String,
}

/// `POST /v1/login/device` - step two. The device signed the nonce; the registry
/// checks that signature against every device key on the account, and issues a
/// token if any accepts.
async fn login_device(State(state): State<Arc<AppState>>, Json(body): Json<DeviceLoginBody>) -> ApiResult {
    let now = now_secs();
    let claimed = {
        let mut ch = state.challenges.lock().unwrap();
        // One shot: a nonce is consumed whether or not it verifies.
        ch.remove(&body.nonce)
    };
    let (account_id, issued) = claimed.ok_or((StatusCode::UNAUTHORIZED, "Challenge expired.".into()))?;
    if now - issued >= CHALLENGE_TTL_SECS {
        return Err((StatusCode::UNAUTHORIZED, "Challenge expired.".into()));
    }
    let account = state
        .db
        .account_by_handle(body.handle.trim())
        .filter(|a| a.id == account_id)
        .ok_or((StatusCode::UNAUTHORIZED, "Could not verify this device.".into()))?;
    let ok = state
        .db
        .device_keys(account.id)
        .iter()
        .any(|pk| afm_identity::verify_detached(pk, body.nonce.as_bytes(), &body.signature));
    if !ok {
        return Err((StatusCode::UNAUTHORIZED, "Could not verify this device.".into()));
    }
    state.db.touch_seen(account.id, now);
    Ok(Json(json!({
        "token": issue_token(&state, account.id, &account.handle),
        "account": account_json(&account),
    })))
}

#[derive(Deserialize)]
struct AddDeviceBody {
    #[serde(rename = "devicePublicKey")]
    device_public_key: String,
    #[serde(default)]
    label: String,
}

/// `POST /v1/device` - register another device's key on the signed-in account,
/// so a second phone or a desktop can log in passwordlessly too.
async fn add_device(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AddDeviceBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let key = body.device_public_key.trim();
    if key.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "No device key.".into()));
    }
    let label = if body.label.trim().is_empty() { "device" } else { body.label.trim() };
    state
        .db
        .add_device_key(who.sub, key, label, now_secs())
        .map_err(|_| (StatusCode::BAD_REQUEST, "That device key could not be stored.".into()))?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /v1/refresh` - a fresh token for a still-valid one, so a long-running
/// app renews without a re-login.
/// `GET /v1/resume` - where this account was last listening.
///
/// Separate from prefs because it answers a different kind of question. Settings
/// are merged when two devices disagree; a listening position is not - the most
/// recent one is simply the truth, and there is no sense in which two devices
/// both hold the real answer. It also changes far more often, and putting it in
/// the settings blob would bump that revision constantly and turn every genuine
/// settings edit into a conflict.
async fn resume_get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    match state.db.resume(who.sub) {
        None => Ok(Json(json!({ "at": 0, "body": Value::Null }))),
        Some((body, at)) => {
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            Ok(Json(json!({ "at": at, "body": parsed })))
        }
    }
}

#[derive(Deserialize)]
struct ResumeBody {
    body: Value,
}

/// `PUT /v1/resume` - record where you are.
async fn resume_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ResumeBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let text = serde_json::to_string(&body.body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "could not be stored".to_string()))?;
    // Small by construction - one track and a position. A cap anyway, because
    // this is a free-form blob on a shared service.
    if text.len() > 8 * 1024 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "too large".into()));
    }
    // The server's clock decides recency, not the device's. A phone with a
    // wrong clock would otherwise be able to pin itself permanently as "most
    // recent" and never be overwritten.
    state.db.set_resume(who.sub, &text, now_secs());
    Ok(Json(json!({ "ok": true })))
}

/// `GET /v1/prefs` - this account's synced settings.
///
/// Settings that belong to a PERSON rather than to a device or a library: what
/// the app looks like, which plugins they run, which servers they are on. They
/// lived in localStorage, which meant a new phone, or the player at
/// attack.fm/listen, started blank every time - and a person with three devices
/// had three different-looking apps.
///
/// The body is opaque here on purpose. The registry stores and returns it and
/// never reads inside, so adding a synced setting stays a client change instead
/// of a schema migration on a service other people's servers depend on.
async fn prefs_get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    match state.db.prefs(who.sub) {
        // rev 0 and a null body says "nothing has ever been stored", which the
        // client must tell apart from stored-and-empty: the first means keep
        // what this device has and push it, the second means someone cleared it.
        None => Ok(Json(json!({ "rev": 0, "body": Value::Null }))),
        Some((body, rev)) => {
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            Ok(Json(json!({ "rev": rev, "body": parsed })))
        }
    }
}

#[derive(Deserialize)]
struct PrefsBody {
    /// The revision this write is based on; 0 for "I have never seen one".
    rev: i64,
    body: Value,
}

/// `PUT /v1/prefs` - store settings, if nobody moved them first.
///
/// A stale revision is refused rather than merged here, because the registry
/// cannot merge what it will not read. The client gets 409 and the current
/// state, and it CAN merge - it knows which keys it changed.
async fn prefs_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PrefsBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let text = serde_json::to_string(&body.body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "settings could not be stored".to_string()))?;
    // A cap, because this is a free-form blob on a shared service and nothing
    // else stops one account filling the disk. Generous next to what settings
    // weigh; refuse rather than truncate, since half a settings object is worse
    // than none.
    const MAX: usize = 256 * 1024;
    if text.len() > MAX {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "those settings are too large to sync".into()));
    }
    match state.db.set_prefs(who.sub, &text, body.rev, now_secs()) {
        Some(rev) => Ok(Json(json!({ "rev": rev }))),
        None => {
            let (current, rev) = state
                .db
                .prefs(who.sub)
                .map(|(b, r)| (serde_json::from_str::<Value>(&b).unwrap_or(Value::Null), r))
                .unwrap_or((Value::Null, 0));
            // 409 with the winning state, so the client can merge and retry
            // instead of guessing what it collided with.
            Err((
                StatusCode::CONFLICT,
                json!({ "rev": rev, "body": current }).to_string(),
            ))
        }
    }
}

async fn refresh(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    let account = state
        .db
        .account_by_id(who.sub)
        .ok_or((StatusCode::UNAUTHORIZED, "Account is gone.".into()))?;
    Ok(Json(json!({
        "token": issue_token(&state, account.id, &account.handle),
        "account": account_json(&account),
    })))
}

// --- friends ----------------------------------------------------------------

fn friend_json(f: &db::Friend) -> Value {
    // The listening glance shows only while it is FRESH - eight days covers a
    // weekly announcer with slack. Someone who stops sharing simply stops
    // announcing, and this is where their numbers quietly disappear.
    let fresh = f.listened_at > 0 && now_secs() - f.listened_at < 8 * 24 * 60 * 60;
    json!({
        "id": f.id, "handle": f.handle, "serverUrl": f.server_url,
        "seenAt": f.seen_at, "songs": f.songs, "playlists": f.playlists, "artists": f.artists,
        "weekMinutes": if fresh { Value::from(f.week_minutes) } else { Value::Null },
        "weekTopArtist": if fresh && !f.week_top_artist.is_empty() { Value::from(f.week_top_artist.clone()) } else { Value::Null },
        "streakDays": if fresh { Value::from(f.streak_days) } else { Value::Null },
    })
}

/// `GET /v1/friends` - the whole standing: friends, requests aimed at me, and
/// requests I have out. One call so the page renders in a single round trip.
async fn friends(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    let friends: Vec<Value> = state.db.friends_of(who.sub).iter().map(friend_json).collect();
    let incoming: Vec<Value> = state
        .db
        .requests_for(who.sub, true)
        .iter()
        .map(|r| json!({ "id": r.id, "accountId": r.account_id, "handle": r.handle }))
        .collect();
    let outgoing: Vec<Value> = state
        .db
        .requests_for(who.sub, false)
        .iter()
        .map(|r| json!({ "id": r.id, "accountId": r.account_id, "handle": r.handle }))
        .collect();
    Ok(Json(json!({ "friends": friends, "incoming": incoming, "outgoing": outgoing })))
}

#[derive(Deserialize)]
struct FriendRequestBody {
    handle: String,
}

/// `POST /v1/friends/requests` - ask someone by handle. If they had already
/// asked you, the two requests settle into a friendship on the spot.
async fn friend_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FriendRequestBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let target = state
        .db
        .account_by_handle(body.handle.trim())
        .ok_or((StatusCode::NOT_FOUND, "No one here goes by that handle.".into()))?;
    if target.id == who.sub {
        return Err((StatusCode::BAD_REQUEST, "You cannot friend yourself.".into()));
    }
    if state.db.are_friends(who.sub, target.id) {
        return Ok(Json(json!({ "friends": true, "message": "Already friends." })));
    }
    let now = now_secs();
    // Their ask crossing yours IS the answer.
    if let Some(rid) = state.db.reverse_request(who.sub, target.id) {
        state.db.add_friendship(who.sub, target.id, now).map_err(db_err)?;
        state.db.delete_friend_request(rid);
        return Ok(Json(json!({ "friends": true, "message": format!("You and {} are now friends.", target.handle) })));
    }
    state.db.add_friend_request(who.sub, target.id, now).map_err(db_err)?;
    Ok(Json(json!({ "friends": false, "message": format!("Asked {}.", target.handle) })))
}

/// `POST /v1/friends/requests/{id}/accept` - only the person it was aimed at
/// may accept, and doing so both makes the friendship and clears the request.
async fn accept_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let (from, to) = state.db.friend_request(id).ok_or((StatusCode::NOT_FOUND, "No such request.".into()))?;
    if to != who.sub {
        return Err((StatusCode::FORBIDDEN, "That request is not yours to answer.".into()));
    }
    state.db.add_friendship(from, to, now_secs()).map_err(db_err)?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /v1/friends/requests/{id}/decline` - the aimed-at person turns it down.
async fn decline_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let (_, to) = state.db.friend_request(id).ok_or((StatusCode::NOT_FOUND, "No such request.".into()))?;
    if to != who.sub {
        return Err((StatusCode::FORBIDDEN, "That request is not yours to answer.".into()));
    }
    state.db.delete_friend_request(id);
    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /v1/friends/{accountId}` - unfriend, either direction.
async fn remove_friend(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(other): axum::extract::Path<i64>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    state.db.remove_friendship(who.sub, other);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct AnnounceBody {
    #[serde(default, rename = "serverUrl")]
    server_url: String,
    /// The library's size. Optional, and ABSENT MEANS UNCHANGED: these used
    /// to default to zero, so the glance push (which sends only listening)
    /// and the Friends page (which sends only the address) each wiped every
    /// friend's counts to "no library yet" a few times a day.
    #[serde(default)]
    songs: Option<i64>,
    #[serde(default)]
    playlists: Option<i64>,
    #[serde(default)]
    artists: Option<i64>,
    /// The listening glance - present only while the sender's owner has
    /// sharing ON. Absent keeps whatever was last shared (which then goes
    /// stale on its own; the friends view stops showing week-old numbers).
    #[serde(default, rename = "weekMinutes")]
    week_minutes: Option<i64>,
    #[serde(default, rename = "weekTopArtist")]
    week_top_artist: Option<String>,
    #[serde(default, rename = "streakDays")]
    streak_days: Option<i64>,
}

/// `POST /v1/announce` - the app tells the registry where its library answers
/// and how big it is, so friends can see numbers and reach it without waking it.
async fn announce(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AnnounceBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let now = now_secs();
    if !body.server_url.trim().is_empty() {
        state.db.set_server_url(who.sub, body.server_url.trim());
    }
    if let Some(songs) = body.songs {
        state.db.set_stats(
            who.sub,
            songs.max(0),
            body.playlists.unwrap_or(0).max(0),
            body.artists.unwrap_or(0).max(0),
            now,
        );
    }
    if let Some(minutes) = body.week_minutes {
        state.db.set_listening(
            who.sub,
            minutes.max(0),
            body.week_top_artist.as_deref().unwrap_or("").trim(),
            body.streak_days.unwrap_or(0).max(0),
            now,
        );
    }
    state.db.touch_seen(who.sub, now);
    Ok(Json(json!({ "ok": true })))
}

// --- invites & memberships --------------------------------------------------

#[derive(Deserialize)]
struct CreateInviteBody {
    #[serde(rename = "serverUrl")]
    server_url: String,
    #[serde(default, rename = "serverName")]
    server_name: String,
    #[serde(default)]
    role: String,
    /// Mint a code that never expires and is never used up - for a review
    /// note, or anywhere a link has to keep working for whoever arrives.
    #[serde(default)]
    standing: bool,
    /// How long a single-use code lives, in seconds. Absent means the week it
    /// always was; the app offers a day, a week, a month. Clamped to an hour
    /// and ninety days so a typo cannot mint a code that is dead on arrival or
    /// good until the heat death. Ignored when `standing`.
    #[serde(default, rename = "ttlSecs")]
    ttl_secs: Option<i64>,
    /// How many DISTINCT people may join with this code. Absent (or 1) is the
    /// classic one-time invite; a higher number lets a handful in off one code.
    /// Clamped to a ceiling so a typo cannot mint an effectively-open code -
    /// the truly-unlimited option is `standing`, not a giant number here.
    /// Ignored when `standing`.
    #[serde(default, rename = "maxUses")]
    max_uses: Option<i64>,
}

const INVITE_TTL_MIN_SECS: i64 = 3600;
const INVITE_TTL_DEFAULT_SECS: i64 = 7 * 24 * 3600;
const INVITE_TTL_MAX_SECS: i64 = 90 * 24 * 3600;
/// The most redemptions a finite code may carry. Past this the right tool is a
/// `standing` code, not a bigger number - a cap keeps a fat-fingered "1000"
/// from being a de-facto open door with none of standing's deliberateness.
const INVITE_MAX_USES_CEIL: i64 = 100;

/// The alphabet invite codes are drawn from: uppercase letters and digits with
/// the look-alikes removed (no 0/O, 1/I/L, U), so a code reads cleanly aloud and
/// drops into the app's segmented code boxes without a "was that an O or a zero?"
/// An invite with no expiry is a STANDING invite: it never lapses AND it is
/// not consumed by being redeemed, so one code can admit a queue of people
/// rather than the first of them. That is what an App Store review note needs -
/// a reviewer may come to it days later, and more than one may come.
///
/// The sentinel is `expires_at == 0` rather than a new column, because this
/// database is created by one `execute_batch(SCHEMA)` and nothing else: a new
/// TABLE would land on the deployed file and a new COLUMN silently would not.
/// The redemption check already read 0 as "never expires"; this only widens it
/// to mean "and never spent" too.
pub fn is_standing(expires_at: i64) -> bool {
    expires_at == 0
}

/// Six characters, from a 30-letter unambiguous alphabet: 729 million codes,
/// which is plenty for a server a handful of people are ever invited to, and
/// short enough to read down a phone line. Single-use and expiring in a week,
/// so the shorter code is not the thing standing between a stranger and the
/// library - see the invite-ownership note in the registry's docs.
const INVITE_CODE_LEN: usize = 6;

const INVITE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

/// An 8-character invite code. ~39 bits of entropy over a single-use invite that
/// lives a week - ample against guessing, yet short enough to read over the
/// phone or type by hand into eight boxes.
fn invite_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..INVITE_CODE_LEN)
        .map(|_| INVITE_ALPHABET[rng.gen_range(0..INVITE_ALPHABET.len())] as char)
        .collect()
}

/// `POST /v1/invites` - a server owner mints an invite to their server. The code
/// is what an invite link carries; redeeming it joins the bearer to the server.
async fn create_invite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateInviteBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    if body.server_url.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Which server is this an invite to?".into()));
    }
    let role = if body.role.trim().is_empty() { "member" } else { body.role.trim() };
    let code = invite_code();
    // The asked-for life, clamped - a week by default - or no expiry at all,
    // which is also what marks it as standing (see is_standing).
    let ttl = body
        .ttl_secs
        .unwrap_or(INVITE_TTL_DEFAULT_SECS)
        .clamp(INVITE_TTL_MIN_SECS, INVITE_TTL_MAX_SECS);
    let expires = if body.standing { 0 } else { now_secs() + ttl };
    // Distinct redemptions allowed. Standing codes are unlimited by their own
    // rule, so max_uses is moot there; a finite code clamps to [1, ceiling].
    let max_uses = body.max_uses.unwrap_or(1).clamp(1, INVITE_MAX_USES_CEIL);
    state
        .db
        .create_invite(&code, body.server_url.trim(), body.server_name.trim(), who.sub, role, expires, max_uses, now_secs())
        .map_err(db_err)?;
    Ok(Json(json!({
        "code": code,
        "serverUrl": body.server_url.trim(),
        "expiresAt": expires,
        "maxUses": if body.standing { serde_json::Value::Null } else { serde_json::json!(max_uses) },
    })))
}

/// `GET /v1/invites/{code}` - preview an invite (what server, who from) before
/// deciding to redeem it. No auth: a link recipient may look before signing in.
async fn invite_preview(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(code): axum::extract::Path<String>,
) -> ApiResult {
    let inv = state.db.invite(&code).ok_or((StatusCode::NOT_FOUND, "That invite is not valid.".into()))?;
    let standing = is_standing(inv.expires_at);
    let expired = !standing && now_secs() >= inv.expires_at;
    let from = state.db.account_by_id(inv.created_by).map(|a| a.handle).unwrap_or_default();
    Ok(Json(json!({
        "serverUrl": inv.server_url,
        "serverName": inv.server_name,
        "from": from,
        "spent": !standing && inv.uses_count >= inv.max_uses,
        "expired": expired,
        "standing": standing,
        // How many the code carries and how many are left, so a card can read
        // "3 of 5 used". Null for a standing code, which is unlimited.
        "maxUses": if standing { serde_json::Value::Null } else { serde_json::json!(inv.max_uses) },
        "remaining": if standing {
            serde_json::Value::Null
        } else {
            serde_json::json!((inv.max_uses - inv.uses_count).max(0))
        },
    })))
}

/// Text made safe to drop into HTML. Everything this page shows comes from
/// somebody's keyboard - a server's name, a handle, the code out of the URL -
/// and this page is served from the registry's own origin, so an unescaped
/// name would be script running with the registry's cookies behind it.
fn esc(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// The landing page's shell: the same frame whatever the invite turned out to
/// be, so a dead code and a live one are the same page with different words.
fn invite_page(title: &str, body: &str) -> Html<String> {
    Html(format!(
        r#"<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title} · AttackFM</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 0; min-height: 100dvh; display: grid; place-items: center;
    padding: 1.5rem; background: #0b0b0d; color: #f2f2f4;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }}
  main {{ width: 100%; max-width: 26rem; text-align: center; }}
  h1 {{ font-size: 1.5rem; margin: 0 0 0.25rem; }}
  p {{ color: #a8a8b3; margin: 0.25rem 0 0; }}
  .open {{ display: block; margin: 1.75rem 0 0; padding: 0.9rem 1.25rem;
    border-radius: 999px; background: #f0356d; color: #fff; font-weight: 600;
    text-decoration: none; }}
  .code {{ margin-top: 1.5rem; font: 600 1.05rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.04em; background: #17171b; border: 1px solid #26262d;
    border-radius: 0.75rem; padding: 0.75rem; word-break: break-all; }}
  .hint {{ font-size: 0.85rem; }}
</style>
</head><body><main>{body}</main></body></html>"#
    ))
}

/// `GET /i/{code}` - what an invite LINK opens.
///
/// The link is the shareable face of an invite; `/v1/invites/{code}` is the
/// same thing for the app to read. Until the app carries an associated-domains
/// entitlement, iOS hands a tapped https link to the browser and there is
/// nothing the app can do about it - so this page is what the browser lands on,
/// and it offers the app the one way a page can: a custom scheme the app
/// registers. The code is printed too, because a scheme link is a dead end on a
/// device with no app installed and pasting always works.
///
/// A bad, spent or expired code still renders a page rather than a bare 404: a
/// shared link that answers "this invite has already been used" is doing its
/// job; one that answers with the server's error page is not.
async fn invite_landing(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(code): axum::extract::Path<String>,
) -> Html<String> {
    let safe = esc(&code);
    let Some(inv) = state.db.invite(&code) else {
        return invite_page(
            "Invite not found",
            "<h1>That invite is not valid</h1><p>The link may have been mistyped, or the invite \
             withdrawn.</p>",
        );
    };
    // A standing invite is never used up and never lapses, so neither of the
    // two dead-ends below applies to it. Without this the SECOND person to
    // follow a review link would be told the code had been used - by the first.
    let standing = is_standing(inv.expires_at);
    if !standing && inv.redeemed_by.is_some() {
        return invite_page(
            "Invite already used",
            "<h1>That invite has already been used</h1><p>Ask whoever sent it for another.</p>",
        );
    }
    if !standing && now_secs() >= inv.expires_at {
        return invite_page(
            "Invite expired",
            "<h1>That invite has expired</h1><p>Ask whoever sent it for another.</p>",
        );
    }
    let from = state.db.account_by_id(inv.created_by).map(|a| a.handle).unwrap_or_default();
    // An invite nobody signed is not from a person - it is the door to a
    // server. A standing one with no author is exactly that (a review note,
    // say), so it says so rather than claiming "Someone" invited you.
    let who = if from.is_empty() {
        "You have been invited to a music library on AttackFM.".to_string()
    } else {
        format!("<strong>{}</strong> invited you to their music library on AttackFM.", esc(&from))
    };
    invite_page(
        "You're invited",
        &format!(
            "<h1>Join {name}</h1>\
             <p>{who}</p>\
             <a class=\"open\" href=\"attackfm://i/{safe}\">Open in AttackFM</a>\
             <p class=\"hint\" style=\"margin-top:1.5rem\">No app yet, or the button did nothing? \
             Enter this code in AttackFM under Join a server:</p>\
             <div class=\"code\">{safe}</div>",
            name = esc(&inv.server_name),
        ),
    )
}

/// `POST /v1/invites/{code}/redeem` - the signed-in account spends the invite and
/// becomes a member of the server it names.
async fn redeem_invite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(code): axum::extract::Path<String>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let inv = state.db.invite(&code).ok_or((StatusCode::NOT_FOUND, "That invite is not valid.".into()))?;
    let standing = is_standing(inv.expires_at);
    // Full is now "as many distinct people as it was minted for", not "used
    // once". Someone who already redeemed it is let through again (idempotent -
    // re-entering after a local delete must not be told the code is used up),
    // so only a NEW account past the cap is refused.
    if !standing && inv.uses_count >= inv.max_uses && !state.db.has_redeemed(&code, who.sub) {
        return Err((StatusCode::GONE, "That invite has been fully used.".into()));
    }
    if !standing && now_secs() >= inv.expires_at {
        return Err((StatusCode::GONE, "That invite has expired.".into()));
    }
    state.db.redeem_invite(&code, who.sub, &inv.server_url, &inv.role, now_secs(), standing);
    Ok(Json(json!({
        "serverUrl": inv.server_url,
        "serverName": inv.server_name,
        "role": inv.role,
    })))
}

/// `GET /v1/memberships` - the servers this account can reach.
async fn memberships(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    let list: Vec<Value> = state
        .db
        .memberships_of(who.sub)
        .iter()
        .map(|m| {
            json!({
                "serverUrl": m.server_url,
                "serverName": m.name,
                "role": m.role,
                "state": m.state,
                "since": m.since,
            })
        })
        .collect();
    Ok(Json(json!({ "memberships": list })))
}

#[derive(Deserialize)]
struct MembershipBody {
    #[serde(rename = "serverUrl")]
    server_url: String,
    #[serde(default, rename = "serverName")]
    server_name: String,
    #[serde(default)]
    role: String,
    /// Set to stop syncing this server rather than to record it.
    #[serde(default)]
    forget: bool,
}

/// `POST /v1/memberships` - a device reporting where it got in.
///
/// The list this builds is deliberately ADDRESSES, not credentials. A device
/// that signs into a server keeps its own tokens; what travels to the account
/// is only "this account can reach that box", which is enough for the next
/// device to re-prove membership through `/api/registry/enter` and mint tokens
/// of its own. Storing the tokens instead would make this one row a master key
/// to every music server the account touches, and a registry breach would hand
/// over all of them at once.
///
/// Self-asserted, and that is the honest reading of it: anyone can claim to
/// reach any address. It costs nothing, because the claim buys no access - the
/// server itself still decides whether this identity may enter.
async fn set_membership(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<MembershipBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let url = body.server_url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "a server address is required".into()));
    }
    if body.forget {
        state.db.forget_membership(who.sub, url);
        return Ok(Json(json!({ "ok": true, "forgotten": true })));
    }
    let role = if body.role.trim().is_empty() { "member" } else { body.role.trim() };
    state
        .db
        .record_membership(who.sub, url, body.server_name.trim(), role, now_secs());
    Ok(Json(json!({ "ok": true })))
}

// --- playlist links ------------------------------------------------------------------

/// Songs on a shared playlist, by name. Five hundred is a long playlist;
/// past that it is a library, and a link is not the way to move one.
const SHARE_MAX_TRACKS: usize = 500;
/// Up to four small cover thumbnails ride along for the landing page's
/// mosaic and the link preview. Each is a data URL; a phone-made 160px JPEG
/// is ~8 KB, so this cap is generous without being a photo host.
const SHARE_MAX_COVER_BYTES: usize = 48 * 1024;
const SHARE_CODE_LEN: usize = 10;

#[derive(Deserialize)]
struct SharedTrack {
    artist: String,
    title: String,
    #[serde(default)]
    album: String,
    #[serde(default, rename = "durationMs")]
    duration_ms: Option<i64>,
}

#[derive(Deserialize)]
struct SharePlaylistBody {
    name: String,
    #[serde(default)]
    description: String,
    tracks: Vec<SharedTrack>,
    #[serde(default)]
    covers: Vec<String>,
}

fn share_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..SHARE_CODE_LEN)
        .map(|_| INVITE_ALPHABET[rng.gen_range(0..INVITE_ALPHABET.len())] as char)
        .collect()
}

/// `POST /v1/playlists/share` - publish a playlist as a link. What is kept is
/// the NAMES of its songs and a few small covers; whoever opens the link
/// re-files it on their own hub, which fetches what it does not own.
async fn share_playlist(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SharePlaylistBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let name: String = body.name.trim().chars().take(120).collect();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "A playlist needs a name.".into()));
    }
    if body.tracks.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "An empty playlist is not worth a link.".into()));
    }
    if body.tracks.len() > SHARE_MAX_TRACKS {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "That playlist is too long to share as a link.".into()));
    }
    let tracks: Vec<Value> = body
        .tracks
        .iter()
        .filter(|t| !t.artist.trim().is_empty() && !t.title.trim().is_empty())
        .map(|t| {
            json!({
                "artist": t.artist.trim().chars().take(200).collect::<String>(),
                "title": t.title.trim().chars().take(200).collect::<String>(),
                "album": t.album.trim().chars().take(200).collect::<String>(),
                "durationMs": t.duration_ms,
            })
        })
        .collect();
    if tracks.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Every song needs an artist and a title.".into()));
    }
    let covers: Vec<&String> = body
        .covers
        .iter()
        .filter(|c| c.starts_with("data:image/") && c.len() <= SHARE_MAX_COVER_BYTES)
        .take(4)
        .collect();
    let description: String = body.description.trim().chars().take(400).collect();
    let code = share_code();
    state
        .db
        .create_playlist_share(
            &code,
            who.sub,
            &name,
            &description,
            &Value::Array(tracks).to_string(),
            &serde_json::to_string(&covers).unwrap_or_else(|_| "[]".into()),
            now_secs(),
        )
        .map_err(db_err)?;
    Ok(Json(json!({ "code": code, "url": format!("{}/p/{}", public_base(), code) })))
}

/// Where links point. The registry lives behind one hostname; a deploy that
/// changes it sets `AFM_REGISTRY_PUBLIC`.
fn public_base() -> String {
    std::env::var("AFM_REGISTRY_PUBLIC")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://registry.attack.fm".into())
        .trim_end_matches('/')
        .to_string()
}

fn share_json(s: &db::PlaylistShare, with_covers: bool) -> Value {
    let tracks: Value = serde_json::from_str(&s.tracks_json).unwrap_or(Value::Array(vec![]));
    let covers: Value = if with_covers {
        serde_json::from_str(&s.covers_json).unwrap_or(Value::Array(vec![]))
    } else {
        Value::Array(vec![])
    };
    json!({
        "code": s.code, "name": s.name, "description": s.description, "by": s.owner_handle,
        "tracks": tracks, "covers": covers, "createdAt": s.created_at, "opens": s.opens,
        "url": format!("{}/p/{}", public_base(), s.code),
    })
}

/// `GET /v1/playlists/share/{code}` - the playlist, for the app. Public: the
/// link IS the permission, the way a Spotify link is.
async fn playlist_share_json(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(code): axum::extract::Path<String>,
) -> ApiResult {
    let s = state
        .db
        .playlist_share(code.trim())
        .ok_or((StatusCode::NOT_FOUND, "No playlist at that link.".into()))?;
    state.db.bump_share_opens(&s.code);
    Ok(Json(share_json(&s, true)))
}

/// `GET /p/{code}/cover.jpg` - the first cover, for link previews: a messenger
/// unfurling the page fetches og:image, and it has to be a plain picture URL.
async fn playlist_share_cover(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(code): axum::extract::Path<String>,
) -> axum::response::Response {
    let Some(s) = state.db.playlist_share(code.trim()) else {
        return (StatusCode::NOT_FOUND, "no such playlist").into_response();
    };
    let covers: Vec<String> = serde_json::from_str(&s.covers_json).unwrap_or_default();
    let Some(first) = covers.first() else {
        return (StatusCode::NOT_FOUND, "no cover").into_response();
    };
    // data:image/jpeg;base64,....
    let Some((head, b64)) = first.split_once(',') else {
        return (StatusCode::NOT_FOUND, "no cover").into_response();
    };
    let mime = head
        .trim_start_matches("data:")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .to_string();
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) else {
        return (StatusCode::NOT_FOUND, "no cover").into_response();
    };
    (
        [(axum::http::header::CONTENT_TYPE, mime), (axum::http::header::CACHE_CONTROL, "public, max-age=86400".into())],
        bytes,
    )
        .into_response()
}

/// Thirty-second previews for the landing page, from the catalogue the app's
/// own discovery already draws on (Deezer's public search - no key, no
/// account). The registry holds no audio: a preview is a redirect to the
/// catalogue's clip, looked up by artist and title once per song and kept
/// in memory. None means "asked, nothing there" - not asked again until a
/// restart, which is the right price for a song the catalogue lacks.
type PreviewHit = Option<(String, String)>;
static PREVIEWS: std::sync::OnceLock<Mutex<HashMap<String, PreviewHit>>> = std::sync::OnceLock::new();

async fn deezer_preview(artist: &str, title: &str) -> PreviewHit {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("AttackFM registry (playlist link previews)")
        .build()
        .ok()?;
    let q = format!("artist:\"{}\" track:\"{}\"", artist.replace('"', ""), title.replace('"', ""));
    let body = client
        .get("https://api.deezer.com/search")
        .query(&[("q", q.as_str()), ("limit", "1")])
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Value>()
        .await
        .ok()?;
    let hit = body.get("data")?.as_array()?.first()?;
    let preview = hit.get("preview")?.as_str()?.trim().to_string();
    if preview.is_empty() {
        return None;
    }
    let cover = hit
        .pointer("/album/cover_medium")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some((preview, cover))
}

/// The (preview, cover) for song `i` of a shared playlist, cached.
async fn preview_for(state: &AppState, code: &str, i: usize) -> Option<PreviewHit> {
    let s = state.db.playlist_share(code)?;
    let tracks: Vec<Value> = serde_json::from_str(&s.tracks_json).unwrap_or_default();
    let t = tracks.get(i)?;
    let artist = t.get("artist").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if artist.is_empty() || title.is_empty() {
        return Some(None);
    }
    let key = format!("{code}:{i}");
    let cache = PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return Some(hit.clone());
    }
    let hit = deezer_preview(&artist, &title).await;
    cache.lock().unwrap().insert(key, hit.clone());
    Some(hit)
}

/// `GET /p/{code}/preview/{i}` - redirects to a thirty-second clip of song i,
/// or 404 when the catalogue has none. The page plays it in place.
async fn playlist_preview(
    State(state): State<Arc<AppState>>,
    axum::extract::Path((code, i)): axum::extract::Path<(String, usize)>,
) -> axum::response::Response {
    match preview_for(&state, code.trim(), i).await {
        Some(Some((preview, _))) => axum::response::Redirect::temporary(&preview).into_response(),
        Some(None) => (StatusCode::NOT_FOUND, "no preview for that song").into_response(),
        None => (StatusCode::NOT_FOUND, "no such song").into_response(),
    }
}

/// `GET /p/{code}/art/{i}` - the catalogue's cover for song i, for the row.
async fn playlist_row_art(
    State(state): State<Arc<AppState>>,
    axum::extract::Path((code, i)): axum::extract::Path<(String, usize)>,
) -> axum::response::Response {
    match preview_for(&state, code.trim(), i).await {
        Some(Some((_, cover))) if !cover.is_empty() => axum::response::Redirect::temporary(&cover).into_response(),
        _ => (StatusCode::NOT_FOUND, "no art").into_response(),
    }
}

/// `GET /p/{code}` - what a playlist LINK opens: a page that unfurls in a
/// messenger like a Spotify embed (title, cover, "N songs · shared by"),
/// lists the songs, and hands the app the link by its own scheme.
async fn playlist_landing(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(code): axum::extract::Path<String>,
) -> Html<String> {
    let safe = esc(code.trim());
    let Some(s) = state.db.playlist_share(code.trim()) else {
        return invite_page(
            "Playlist not found",
            "<h1>No playlist at that link</h1><p>It may have been mistyped, or taken down.</p>",
        );
    };
    let tracks: Vec<Value> = serde_json::from_str(&s.tracks_json).unwrap_or_default();
    let covers: Vec<String> = serde_json::from_str(&s.covers_json).unwrap_or_default();
    let base = public_base();
    let count = tracks.len();
    let summary = format!(
        "{count} {} · shared by @{} on AttackFM",
        if count == 1 { "song" } else { "songs" },
        esc(&s.owner_handle)
    );
    let image = if covers.is_empty() {
        String::new()
    } else {
        format!(
            "<meta property=\"og:image\" content=\"{base}/p/{safe}/cover.jpg\">\
             <meta name=\"twitter:card\" content=\"summary_large_image\">\
             <meta name=\"twitter:image\" content=\"{base}/p/{safe}/cover.jpg\">"
        )
    };
    let mosaic: String = covers
        .iter()
        .take(4)
        .map(|c| format!("<img src=\"{}\" alt=\"\">", esc(c)))
        .collect();
    let rows: String = tracks
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let artist = t.get("artist").and_then(|v| v.as_str()).unwrap_or("");
            format!(
                "<li class=\"row\" data-i=\"{i}\"><button type=\"button\" class=\"play\" aria-label=\"Preview {t}\">\
                 <span class=\"n\">{n}</span>\
                 <svg class=\"ic-play\" aria-hidden=\"true\"><use href=\"#i-play\"/></svg>\
                 <svg class=\"ic-pause\" aria-hidden=\"true\"><use href=\"#i-pause\"/></svg></button>\
                 <span class=\"t\">{t}</span><span class=\"a\">{a}</span></li>",
                n = i + 1,
                t = esc(title),
                a = esc(artist)
            )
        })
        .collect();
    let description = if s.description.is_empty() { String::new() } else { format!("<p class=\"desc\">{}</p>", esc(&s.description)) };
    let backdrop = covers
        .first()
        .map(|c| format!("<div class=\"backdrop\" style=\"background-image:url('{}')\"></div>", esc(c)))
        .unwrap_or_default();
    Html(format!(
        r##"<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{name} · AttackFM</title>
<meta property="og:type" content="music.playlist">
<meta property="og:site_name" content="AttackFM">
<meta property="og:title" content="{name}">
<meta property="og:description" content="{summary}">
<meta property="og:url" content="{base}/p/{safe}">
{image}
<meta name="description" content="{summary}">
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; }}
  body {{ margin: 0; background: #0b0b0d; color: #f2f2f4; overflow: hidden;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }}
  .backdrop {{ position: fixed; inset: -10%; background-size: cover; background-position: center;
    filter: blur(60px) saturate(1.3) brightness(0.45); transform: scale(1.1); }}
  .stage {{ position: fixed; inset: 0; display: grid; place-items: center;
    padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom)); }}
  .card {{ position: relative; width: min(100%, 30rem); max-height: min(88dvh, 52rem);
    display: flex; flex-direction: column; border-radius: 1.5rem; overflow: hidden;
    background: rgba(20, 20, 24, 0.86); backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4); border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 30px 80px rgba(0,0,0,0.6); }}
  .head {{ flex: none; padding: 1.5rem 1.5rem 1rem; text-align: center; }}
  .mosaic {{ display: grid; grid-template-columns: 1fr 1fr; gap: 2px; width: 9.5rem; aspect-ratio: 1;
    border-radius: 1rem; overflow: hidden; background: #17171b; margin: 0 auto 1rem;
    box-shadow: 0 12px 30px rgba(0,0,0,0.5); }}
  .mosaic img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
  .mosaic img:only-child {{ grid-column: 1 / -1; grid-row: 1 / -1; }}
  h1 {{ font-size: 1.35rem; margin: 0; line-height: 1.25; overflow-wrap: anywhere; }}
  .head p {{ color: #a8a8b3; margin: 0.25rem 0 0; font-size: 0.9rem; }}
  .desc {{ margin-top: 0.5rem !important; }}
  .actions {{ display: flex; gap: 0.5rem; margin-top: 1rem; }}
  .open {{ flex: 1; padding: 0.75rem 1rem; text-align: center; border-radius: 999px;
    background: #f0356d; color: #fff; font-weight: 600; text-decoration: none; font-size: 0.95rem; }}
  .get {{ flex: 1; padding: 0.75rem 1rem; text-align: center; border-radius: 999px; color: #f2f2f4;
    background: rgba(255,255,255,0.08); text-decoration: none; font-size: 0.95rem; }}
  .list {{ flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    border-top: 1px solid rgba(255,255,255,0.08); padding: 0.25rem 0.75rem 1rem; }}
  ol {{ list-style: none; margin: 0; padding: 0; }}
  .row {{ position: relative; display: grid; grid-template-columns: 2.5rem 1fr; column-gap: 0.6rem;
    align-items: center; padding: 0.5rem 0.25rem; border-radius: 0.75rem; cursor: pointer; }}
  .row[data-on] {{ background: rgba(240,53,109,0.14); }}
  /* The row's button is the app's own play button: a solid accent circle
     with a filled glyph, 2.5rem, the number resting on it until it is asked. */
  .play {{ grid-row: 1 / 3; width: 2.5rem; height: 2.5rem; border: none; border-radius: 999px;
    background: rgba(255,255,255,0.06); color: #f2f2f4; display: grid; place-items: center;
    cursor: pointer; padding: 0; }}
  .play .n {{ color: #8e8e99; font-variant-numeric: tabular-nums; font-size: 0.85rem; }}
  .play svg {{ display: none; width: 18px; height: 18px; }}
  .row:hover .play .n, .row[data-on] .play .n, .row[data-busy] .play .n {{ display: none; }}
  .row:hover .play .ic-play, .row[data-busy] .play .ic-play {{ display: block; }}
  .row[data-on] .play {{ background: #f0356d; color: #0b0b0d; }}
  .row[data-on] .play .ic-pause {{ display: block; }}
  .row[data-on] .play .ic-play {{ display: none; }}
  .row[data-busy] .play {{ color: rgba(255,255,255,0.5); }}
  .row[data-none] {{ opacity: 0.55; cursor: default; }}
  .t {{ font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .a {{ color: #a8a8b3; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .foot {{ color: #6b6b75; font-size: 0.75rem; text-align: center; padding: 0.75rem 0 0; }}

  /* The bottom of the card: the app's compact player. Seek line (the swell),
     elapsed and remaining, then previous · play · next in the app's shapes. */
  .now {{ flex: none; padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom));
    border-top: 1px solid rgba(255,255,255,0.08); background: rgba(12,12,15,0.7);
    display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; column-gap: 0.75rem; align-items: center; }}
  .nowMeta {{ grid-column: 1 / -1; display: flex; align-items: center; gap: 0.6rem; min-width: 0; margin-bottom: 0.4rem; }}
  .nowArt {{ width: 2.5rem; height: 2.5rem; border-radius: 0.5rem; background: #24242b; object-fit: cover; flex: none; }}
  .nowArt[hidden] {{ display: none; }}
  .nowWho {{ min-width: 0; display: flex; flex-direction: column; }}
  .nowTitle {{ font-weight: 600; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .nowArtist {{ color: #a8a8b3; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .seekWrap {{ min-width: 0; }}
  .seek {{ position: relative; height: 2.25rem; cursor: pointer; touch-action: none; }}
  .seek svg {{ position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }}
  .seek .ahead {{ fill: none; stroke: rgba(255,255,255,0.22); stroke-width: 3; stroke-linecap: round; }}
  .seek .played {{ fill: none; stroke: #f0356d; stroke-width: 3; stroke-linecap: round; }}
  .seek .playhead {{ position: absolute; top: 0; bottom: 0; width: 2px; background: #f0356d; border-radius: 999px;
    transform: translateX(-50%); left: 0; }}
  .seek[data-scrubbing] .playhead {{ box-shadow: 0 0 0 3px rgba(240,53,109,0.35); }}
  .times {{ display: flex; justify-content: space-between; font-size: 0.8rem; color: #a8a8b3;
    font-variant-numeric: tabular-nums; margin-top: 0.15rem; }}
  .transport {{ display: flex; align-items: center; gap: 0.25rem; }}
  .transport button {{ border: none; background: transparent; color: #f2f2f4; width: 2.25rem; height: 2.25rem;
    border-radius: 999px; display: grid; place-items: center; cursor: pointer; padding: 0; }}
  .transport button svg {{ width: 20px; height: 20px; }}
  .transport .big {{ width: 2.5rem; height: 2.5rem; background: #f0356d; color: #0b0b0d; }}
  .transport .big svg {{ width: 22px; height: 22px; }}
  .transport .big .ic-pause {{ display: none; }}
  .now[data-playing] .transport .big .ic-pause {{ display: block; }}
  .now[data-playing] .transport .big .ic-play {{ display: none; }}
  .now[data-idle] .transport button, .now[data-idle] .seek {{ opacity: 0.45; pointer-events: none; }}
  .now[data-idle] .transport .big {{ opacity: 1; pointer-events: auto; }}
  @media (prefers-reduced-motion: reduce) {{ .backdrop {{ transform: none; }} }}
</style>
</head><body>
{backdrop}
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-play" viewBox="0 0 24 24"><path d="M6 4.5v15a1 1 0 0 0 1.52.86l12.3-7.5a1 1 0 0 0 0-1.72L7.52 3.64A1 1 0 0 0 6 4.5z"/></symbol>
  <symbol id="i-pause" viewBox="0 0 24 24"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></symbol>
  <symbol id="i-back" viewBox="0 0 24 24"><path d="M19 5.5v13a1 1 0 0 1-1.57.82L8 13.2V18a1 1 0 0 1-2 0V6a1 1 0 0 1 2 0v4.8l9.43-6.12A1 1 0 0 1 19 5.5z"/></symbol>
  <symbol id="i-fwd" viewBox="0 0 24 24"><path d="M5 5.5v13a1 1 0 0 0 1.57.82L16 13.2V18a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v4.8L6.57 4.68A1 1 0 0 0 5 5.5z"/></symbol>
</svg>
<div class="stage"><main class="card">
  <div class="head">
    {mosaic_block}
    <h1>{name}</h1>
    <p>{summary}</p>
    {description}
    <div class="actions">
      <a class="open" href="attackfm://p/{safe}">Open in AttackFM</a>
      <a class="get" href="https://attack.fm">Get the app</a>
    </div>
  </div>
  <div class="list">
    <ol id="rows">{rows}</ol>
    <p class="foot">Thirty-second previews · full songs play in AttackFM</p>
  </div>
  <div class="now" id="now" data-idle>
    <div class="nowMeta">
      <img class="nowArt" id="nowArt" alt="" hidden>
      <div class="nowWho"><span class="nowTitle" id="nowTitle">Tap a song to preview</span><span class="nowArtist" id="nowArtist">Thirty seconds of each</span></div>
    </div>
    <div class="seekWrap">
      <div class="seek" id="seek" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none">
          <defs><clipPath id="playedClip"><rect id="playedRect" x="0" y="-20" width="0" height="80"/></clipPath></defs>
          <path class="ahead" id="swell"/>
          <path class="played" id="swellPlayed" clip-path="url(#playedClip)"/>
        </svg>
        <div class="playhead" id="head"></div>
      </div>
      <div class="times"><span id="tElapsed">0:00</span><span id="tRemain">-0:00</span></div>
    </div>
    <div class="transport" role="group" aria-label="Playback controls">
      <button type="button" id="btnPrev" aria-label="Previous"><svg><use href="#i-back"/></svg></button>
      <button type="button" id="btnPlay" class="big" aria-label="Play"><svg class="ic-play"><use href="#i-play"/></svg><svg class="ic-pause"><use href="#i-pause"/></svg></button>
      <button type="button" id="btnNext" aria-label="Next"><svg><use href="#i-fwd"/></svg></button>
    </div>
  </div>
</main></div>
<audio id="player" preload="none"></audio>
<script>
(function () {{
  var code = {code_json};
  var audio = document.getElementById('player');
  var rows = document.getElementById('rows');
  var now = document.getElementById('now');
  var nowArt = document.getElementById('nowArt'), nowTitle = document.getElementById('nowTitle'), nowArtist = document.getElementById('nowArtist');
  var seek = document.getElementById('seek'), playedRect = document.getElementById('playedRect'), head = document.getElementById('head');
  var tElapsed = document.getElementById('tElapsed'), tRemain = document.getElementById('tRemain');
  var total = rows.children.length;
  var current = null;

  // The swell: the app's seek line - a gentle wave that grows toward the
  // end, drawn once; the played part is the same path clipped to progress.
  (function drawSwell() {{
    var d = '', n = 200;
    for (var k = 0; k <= n; k++) {{
      var x = 1000 * k / n, t = k / n;
      var amp = 2 + 14 * t * t;
      var y = 20 + Math.sin(t * Math.PI * 14) * amp;
      d += (k ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(2);
    }}
    document.getElementById('swell').setAttribute('d', d);
    document.getElementById('swellPlayed').setAttribute('d', d);
  }})();

  function row(i) {{ return rows.querySelector('[data-i="' + i + '"]'); }}
  function fmt(s) {{ s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }}
  function progress(p) {{
    playedRect.setAttribute('width', String(1000 * p));
    head.style.left = (100 * p) + '%';
    seek.setAttribute('aria-valuenow', String(Math.round(100 * p)));
  }}
  function times() {{
    var d = audio.duration || 0, c = audio.currentTime || 0;
    tElapsed.textContent = fmt(c); tRemain.textContent = '-' + fmt(Math.max(0, d - c));
    progress(d ? c / d : 0);
  }}
  function setPlaying(on) {{ if (on) now.setAttribute('data-playing', ''); else now.removeAttribute('data-playing'); document.getElementById('btnPlay').setAttribute('aria-label', on ? 'Pause' : 'Play'); }}
  function clearRow() {{
    if (current !== null) {{ var r = row(current); if (r) {{ r.removeAttribute('data-on'); r.removeAttribute('data-busy'); }} }}
  }}
  function stop() {{ audio.pause(); audio.removeAttribute('src'); audio.load(); clearRow(); current = null; setPlaying(false); progress(0); tElapsed.textContent = '0:00'; tRemain.textContent = '-0:00'; }}
  function show(i) {{
    var r = row(i);
    nowTitle.textContent = r.querySelector('.t').textContent;
    nowArtist.textContent = r.querySelector('.a').textContent;
    nowArt.hidden = true; nowArt.removeAttribute('src');
    var art = new Image();
    art.onload = function () {{ if (current === i) {{ nowArt.src = art.src; nowArt.hidden = false; }} }};
    art.src = '/p/' + code + '/art/' + i;
    now.removeAttribute('data-idle');
  }}
  function play(i) {{
    var r = row(i); if (!r || r.hasAttribute('data-none')) return;
    if (current === i) {{ if (audio.paused) audio.play(); else audio.pause(); return; }}
    stop(); current = i; r.setAttribute('data-busy', ''); show(i);
    // The registry answers with a redirect to the catalogue's clip, or 404.
    fetch('/p/' + code + '/preview/' + i, {{ method: 'HEAD' }}).then(function (res) {{
      if (current !== i) return;
      if (!res.ok) {{ r.removeAttribute('data-busy'); r.setAttribute('data-none', ''); current = null; nowArtist.textContent = 'No preview for this one'; return; }}
      audio.src = res.url; audio.play().then(function () {{
        r.removeAttribute('data-busy'); r.setAttribute('data-on', '');
      }}).catch(function () {{ r.removeAttribute('data-busy'); current = null; }});
    }}).catch(function () {{ r.removeAttribute('data-busy'); current = null; }});
  }}
  function step(dir) {{
    if (current === null) {{ if (total) play(0); return; }}
    if (dir < 0 && audio.currentTime > 3) {{ audio.currentTime = 0; return; }}
    var k = current + dir;
    while (k >= 0 && k < total && row(k).hasAttribute('data-none')) k += dir;
    if (k >= 0 && k < total) play(k);
  }}

  rows.addEventListener('click', function (e) {{
    var li = e.target.closest('.row'); if (!li) return;
    play(parseInt(li.getAttribute('data-i'), 10));
  }});
  document.getElementById('btnPlay').addEventListener('click', function () {{
    if (current === null) {{ if (total) play(0); return; }}
    if (audio.paused) audio.play(); else audio.pause();
  }});
  document.getElementById('btnPrev').addEventListener('click', function () {{ step(-1); }});
  document.getElementById('btnNext').addEventListener('click', function () {{ step(1); }});

  // Seeking: tap or drag along the swell.
  var scrubbing = false;
  function seekTo(e) {{
    var b = seek.getBoundingClientRect();
    var p = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
    if (audio.duration) audio.currentTime = p * audio.duration;
    progress(p);
  }}
  seek.addEventListener('pointerdown', function (e) {{ if (current === null) return; scrubbing = true; seek.setAttribute('data-scrubbing', ''); try {{ seek.setPointerCapture(e.pointerId); }} catch (_) {{}} seekTo(e); }});
  seek.addEventListener('pointermove', function (e) {{ if (scrubbing) seekTo(e); }});
  function endScrub(e) {{ if (!scrubbing) return; scrubbing = false; seek.removeAttribute('data-scrubbing'); seekTo(e); }}
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);
  seek.addEventListener('keydown', function (e) {{
    if (!audio.duration) return;
    if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  }});

  audio.addEventListener('play', function () {{ setPlaying(true); }});
  audio.addEventListener('pause', function () {{ setPlaying(false); }});
  audio.addEventListener('timeupdate', function () {{ if (!scrubbing) times(); }});
  audio.addEventListener('durationchange', times);
  audio.addEventListener('ended', function () {{
    var next = current === null ? null : current + 1;
    if (next !== null && next < total) play(next); else stop();
  }});
}})();
</script>
</body></html>"##,
        name = esc(&s.name),
        code_json = serde_json::to_string(&s.code).unwrap_or_else(|_| "\"\"".into()),
        mosaic_block = if mosaic.is_empty() { String::new() } else { format!("<div class=\"mosaic\">{mosaic}</div>") },
    ))
}

// --- profiles ------------------------------------------------------------------------

/// A profile is a few hundred songs' worth of names and numbers; anything
/// past this is not a profile.
const PROFILE_MAX_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
struct ProfileBody {
    #[serde(default = "yes")]
    sharing: bool,
    /// The document, or absent to only move the switch.
    #[serde(default)]
    profile: Option<Value>,
}

fn yes() -> bool {
    true
}

/// `PUT /v1/profile` - the app publishes the account's listening profile,
/// built from whichever hub it listens on. Global, so a friend on any other
/// hub reads the same page.
async fn profile_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ProfileBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let doc = match body.profile {
        Some(v) if v.is_object() => {
            let s = v.to_string();
            if s.len() > PROFILE_MAX_BYTES {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "That profile is too big to keep.".into()));
            }
            Some(s)
        }
        Some(_) => return Err((StatusCode::BAD_REQUEST, "A profile is an object.".into())),
        None => None,
    };
    state
        .db
        .set_profile(who.sub, body.sharing, doc.as_deref(), now_secs())
        .map_err(db_err)?;
    Ok(Json(json!({ "ok": true })))
}

/// `GET /v1/profile/{handle}` - a friend's profile (or your own). Friends
/// only, and only while they share: the same closed door the hubs show.
async fn profile_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(handle): axum::extract::Path<String>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let account = state
        .db
        .account_by_handle(handle.trim())
        .ok_or((StatusCode::NOT_FOUND, "No one here goes by that handle.".into()))?;
    let its_me = account.id == who.sub;
    if !its_me && !state.db.are_friends(who.sub, account.id) {
        return Err((StatusCode::FORBIDDEN, "Profiles are for friends.".into()));
    }
    let (sharing, body, updated_at) = state
        .db
        .profile(account.id)
        .ok_or((StatusCode::NOT_FOUND, "No profile published yet.".into()))?;
    if !its_me && !sharing {
        return Err((StatusCode::FORBIDDEN, "they keep their listening to themselves".into()));
    }
    if body.is_empty() {
        return Err((StatusCode::NOT_FOUND, "No profile published yet.".into()));
    }
    let profile: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    Ok(Json(json!({ "handle": account.handle, "updatedAt": updated_at, "sharing": sharing, "profile": profile })))
}

// --- recovery codes --------------------------------------------------------------

/// Eight codes of twelve characters from an alphabet with no 0/O or 1/I, shown
/// as XXXX-XXXX-XXXX. Sixty bits each; the sheet is the thing to guard, not
/// the alphabet.
const RECOVERY_CODES: usize = 8;
const RECOVERY_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

fn make_recovery_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let raw: String = (0..12)
        .map(|_| RECOVERY_ALPHABET[rng.gen_range(0..RECOVERY_ALPHABET.len())] as char)
        .collect();
    format!("{}-{}-{}", &raw[0..4], &raw[4..8], &raw[8..12])
}

/// The stored form: uppercase, letters and digits only (so a code typed with
/// or without its dashes, or in lowercase, is the same code), then SHA-256.
fn recovery_hash(code: &str) -> String {
    use sha2::Digest;
    let norm: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let digest = sha2::Sha256::digest(norm.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// `POST /v1/recovery` - a fresh sheet of one-time codes for the signed-in
/// account, replacing any earlier sheet. Returned exactly once.
async fn mint_recovery(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    let codes: Vec<String> = (0..RECOVERY_CODES).map(|_| make_recovery_code()).collect();
    let hashes: Vec<String> = codes.iter().map(|c| recovery_hash(c)).collect();
    state
        .db
        .replace_recovery_codes(who.sub, &hashes, now_secs())
        .map_err(db_err)?;
    Ok(Json(json!({ "codes": codes })))
}

/// `GET /v1/recovery` - how many codes are left unspent, for the settings row.
async fn recovery_left(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    Ok(Json(json!({ "left": state.db.recovery_codes_left(who.sub) })))
}

#[derive(Deserialize)]
struct RecoveryLoginBody {
    handle: String,
    code: String,
}

/// `POST /v1/login/recovery` - in with a code, which is spent by the attempt.
/// The generic error is deliberate, as with passwords.
async fn login_recovery(State(state): State<Arc<AppState>>, Json(body): Json<RecoveryLoginBody>) -> ApiResult {
    let now = now_secs();
    let account = state
        .db
        .account_by_handle(body.handle.trim())
        .filter(|a| state.db.consume_recovery_code(a.id, &recovery_hash(&body.code), now))
        .ok_or((StatusCode::UNAUTHORIZED, "Wrong handle or code, or a code already used.".into()))?;
    state.db.touch_seen(account.id, now);
    Ok(Json(json!({
        "token": issue_token(&state, account.id, &account.handle),
        "account": account_json(&account),
    })))
}

// --- songs sent between friends ------------------------------------------------

#[derive(Deserialize)]
struct ShareBody {
    handle: String,
    artist: String,
    title: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    note: String,
}

/// A sender may send this many songs a day, to everyone put together. Enough
/// for a whole evening of "you have to hear this"; not enough to be a feed.
const SHARES_PER_DAY: i64 = 40;

/// `POST /v1/shares` - send a friend a song by NAME. Their own hub fetches it;
/// the registry carries only the title. The first song from anyone waits until
/// the recipient says they will take songs from that person at all.
async fn send_share(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ShareBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let target = state
        .db
        .account_by_handle(body.handle.trim())
        .ok_or((StatusCode::NOT_FOUND, "No one here goes by that handle.".into()))?;
    if target.id == who.sub {
        return Err((StatusCode::BAD_REQUEST, "You already have it.".into()));
    }
    if !state.db.are_friends(who.sub, target.id) {
        return Err((StatusCode::FORBIDDEN, "You can only send songs to friends.".into()));
    }
    let artist = body.artist.trim();
    let title = body.title.trim();
    if artist.is_empty() || title.is_empty() || artist.len() > 200 || title.len() > 200 {
        return Err((StatusCode::BAD_REQUEST, "A song needs an artist and a title.".into()));
    }
    let grant = state.db.share_grant(target.id, who.sub);
    if grant == Some(false) {
        return Err((StatusCode::FORBIDDEN, format!("{} is not taking songs from you.", target.handle)));
    }
    let now = now_secs();
    if state.db.shares_sent_since(who.sub, now - 86_400) >= SHARES_PER_DAY {
        return Err((StatusCode::TOO_MANY_REQUESTS, "That is enough songs for one day.".into()));
    }
    let album: String = body.album.trim().chars().take(200).collect();
    let note: String = body.note.trim().chars().take(280).collect();
    let id = state
        .db
        .add_share(who.sub, target.id, artist, title, &album, &note, now)
        .map_err(db_err)?;
    Ok(Json(json!({ "id": id, "pending": grant.is_none() })))
}

/// `GET /v1/shares` - the songs waiting for you.
async fn shares(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    let inbox: Vec<Value> = state
        .db
        .shares_for(who.sub)
        .iter()
        .map(|s| {
            json!({
                "id": s.id, "fromId": s.from_id, "from": s.from_handle,
                "artist": s.artist, "title": s.title, "album": s.album, "note": s.note,
                "createdAt": s.created_at, "allowed": s.allowed,
            })
        })
        .collect();
    Ok(Json(json!({ "inbox": inbox })))
}

fn settle_share(state: &AppState, headers: &HeaderMap, id: i64, taken: bool) -> ApiResult {
    let who = caller(state, headers)?;
    let (_, to) = state
        .db
        .share_parties(id)
        .ok_or((StatusCode::NOT_FOUND, "No such song.".into()))?;
    if to != who.sub {
        return Err((StatusCode::FORBIDDEN, "That was not sent to you.".into()));
    }
    state.db.settle_share(id, taken, now_secs());
    Ok(Json(json!({ "ok": true })))
}

/// `POST /v1/shares/{id}/taken` - your hub has it, or is fetching it.
async fn share_taken(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> ApiResult {
    settle_share(&state, &headers, id, true)
}

/// `POST /v1/shares/{id}/dismiss` - not this one, thanks.
async fn share_dismiss(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> ApiResult {
    settle_share(&state, &headers, id, false)
}

#[derive(Deserialize)]
struct GrantBody {
    handle: String,
    allow: bool,
}

/// `PUT /v1/shares/grants` - whether you take songs from this friend at all.
/// Asked once, the first time they send one; refusing also puts away whatever
/// they have already sent.
async fn share_grant(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<GrantBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let from = state
        .db
        .account_by_handle(body.handle.trim())
        .ok_or((StatusCode::NOT_FOUND, "No one here goes by that handle.".into()))?;
    state
        .db
        .set_share_grant(who.sub, from.id, body.allow, now_secs())
        .map_err(db_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn db_err(_: rusqlite::Error) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, "the registry could not save that".into())
}

// --- boot -------------------------------------------------------------------

/// Load the signing secret from the database, or mint one on first boot and
/// persist it. The registry's identity IS this key.
fn load_or_make_issuer(db: &Db) -> Issuer {
    if let Some(secret) = db.meta_get(ISSUER_SECRET_KEY) {
        if let Some(issuer) = Issuer::from_secret_b64(&secret) {
            return issuer;
        }
        eprintln!("[registry] stored issuer secret would not parse; minting a new one");
    }
    let issuer = Issuer::generate();
    db.meta_set(ISSUER_SECRET_KEY, &issuer.secret_b64());
    println!("[registry] minted a new signing key");
    issuer
}

// --- app updates ------------------------------------------------------------
//
// The registry publishes the app's frontend to every device, the counterpart
// to src-tauri/src/bundle.rs. It lives HERE - not on any music server -
// because this is the one address every install already talks to for
// identity, so updates reach a device whichever server it listens from, and
// even a device signed into nothing at all.
//
// Both routes are deliberately public. What is served is the app's own code,
// the same bytes as the public repo; and the native downloader is a bare
// reqwest that sets no headers - an auth requirement here is how four
// releases once shipped to nobody, silently. The manifest is generated from
// the bytes on disk per request, so it can never disagree with what a device
// then downloads and checksums.

/// `GET /v1/app/bundle` - what the registry is publishing, or 404 when nothing.
async fn app_bundle_manifest(State(state): State<Arc<AppState>>) -> ApiResult {
    let base = &state.bundle_dir;
    let version = std::fs::read_to_string(base.join("VERSION"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or((StatusCode::NOT_FOUND, "no app bundle is published".into()))?;

    let mut files = Vec::new();
    let entries = std::fs::read_dir(base)
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
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(&bytes);
        let sum: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        files.push(json!({ "name": name, "sha256": sum, "bytes": bytes.len() }));
    }
    if files.is_empty() {
        return Err((StatusCode::NOT_FOUND, "the published bundle is empty".into()));
    }

    let native: u32 = std::fs::read_to_string(base.join("NATIVE"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(1);
    let notes = std::fs::read_to_string(base.join("NOTES")).unwrap_or_default();

    Ok(Json(json!({
        "version": version,
        "native": native,
        "files": files,
        "notes": notes,
    })))
}

/// `GET /v1/app/bundle/{name}` - one file from the published bundle.
async fn app_bundle_file(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    // The name indexes a flat directory and must not walk out of it.
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.len() > 128 {
        return Err((StatusCode::BAD_REQUEST, "not a bundle file".into()));
    }
    let path = state.bundle_dir.join(&name);
    let bytes = std::fs::read(&path).map_err(|_| (StatusCode::NOT_FOUND, "no such file".into()))?;
    let mime = if name.ends_with(".js") {
        "text/javascript"
    } else if name.ends_with(".css") {
        "text/css"
    } else {
        "application/octet-stream"
    };
    Ok(([(axum::http::header::CONTENT_TYPE, mime)], bytes).into_response())
}

/// The Android app's package and the SHA-256 of the certificate its releases
/// are signed with. `AFM_ANDROID_CERT_SHA256` overrides (comma-separated for
/// several - an upload cert and a Play app-signing cert, say); the baked-in
/// value is the GitHub-release keystore. A wrong fingerprint breaks nothing
/// visibly: Android silently treats the link as unverified and opens the
/// browser - the exact behaviour these routes exist to end - so check
/// `adb shell pm get-app-links com.mattssoftware.attackfm` after a build.
const ANDROID_PACKAGE: &str = "com.mattssoftware.attackfm";
const ANDROID_CERT_SHA256: &str = "56:BF:1A:B7:F9:E0:78:A4:E5:DB:24:6B:2B:3C:10:24:E1:0B:23:C7:A9:90:AE:E5:6E:DB:D9:D8:A2:B0:C7:4B";
/// Apple team + bundle id, for Universal Links onto `/i/*`.
const APPLE_APP_ID: &str = "F6ZAL7ANAD.com.mattssoftware.attackfm";

async fn assetlinks() -> impl IntoResponse {
    let certs: Vec<String> = std::env::var("AFM_ANDROID_CERT_SHA256")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect())
        .unwrap_or_else(|| vec![ANDROID_CERT_SHA256.to_string()]);
    let body = json!([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {
            "namespace": "android_app",
            "package_name": ANDROID_PACKAGE,
            "sha256_cert_fingerprints": certs,
        }
    }]);
    ([(axum::http::header::CONTENT_TYPE, "application/json")], body.to_string())
}

async fn apple_site_association() -> impl IntoResponse {
    let body = json!({
        "applinks": {
            "details": [{
                "appIDs": [APPLE_APP_ID],
                "components": [
                    { "/": "/i/*", "comment": "invite links open the app's Join screen" },
                    { "/": "/p/*", "comment": "playlist links open in the app" }
                ]
            }]
        }
    });
    // Apple insists on application/json and no redirect; the file has no
    // extension on purpose.
    ([(axum::http::header::CONTENT_TYPE, "application/json")], body.to_string())
}

#[tokio::main]
async fn main() {
    let bind = env_or("AFM_REGISTRY_BIND", "127.0.0.1");
    let port: u16 = env_or("AFM_REGISTRY_PORT", "8790").parse().unwrap_or(8790);
    let data = std::path::PathBuf::from(env_or("AFM_REGISTRY_DATA", "./registry.sqlite3"));

    let db = Arc::new(Db::open(&data).expect("open registry database"));
    let issuer = Arc::new(load_or_make_issuer(&db));
    // The published frontend lives beside the database: <data dir>/appbundle.
    let bundle_dir = data
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("appbundle");

    let state = Arc::new(AppState {
        db,
        issuer,
        challenges: Mutex::new(HashMap::new()),
        bundle_dir,
    });

    // DELETE belongs here as much as GET does: `/v1/friends/{id}` is the only
    // route on this service that is neither GET nor POST, and leaving it off
    // this list did not make it unreachable in an obvious way - it made the
    // browser refuse it at the preflight, so unfriending failed silently in the
    // app while curl against the same endpoint worked perfectly. OPTIONS is
    // named for the preflight itself.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any);

    let app = Router::new()
        // The two files that let an https link open the app instead of a
        // browser: Android's Digital Asset Links and Apple's site association.
        // Served from memory, no auth, no redirect - both platforms fetch them
        // blind and give up on anything but a plain 200 with JSON.
        .route("/.well-known/assetlinks.json", get(assetlinks))
        .route("/.well-known/apple-app-site-association", get(apple_site_association))
        .route("/health", get(health))
        .route("/v1/pubkey", get(pubkey))
        .route("/v1/prefs", get(prefs_get).put(prefs_put))
        .route("/v1/resume", get(resume_get).put(resume_put))
        .route("/v1/signup", post(signup))
        .route("/v1/login", post(login))
        .route("/v1/login/challenge", post(challenge))
        .route("/v1/login/device", post(login_device))
        .route("/v1/login/recovery", post(login_recovery))
        .route("/v1/recovery", get(recovery_left).post(mint_recovery))
        .route("/v1/device", post(add_device))
        .route("/v1/refresh", post(refresh))
        .route("/v1/announce", post(announce))
        .route("/v1/friends", get(friends))
        .route("/v1/friends/requests", post(friend_request))
        .route("/v1/friends/requests/{id}/accept", post(accept_request))
        .route("/v1/friends/requests/{id}/decline", post(decline_request))
        .route("/v1/friends/{account_id}", axum::routing::delete(remove_friend))
        .route("/v1/playlists/share", post(share_playlist))
        .route("/v1/playlists/share/{code}", get(playlist_share_json))
        .route("/p/{code}", get(playlist_landing))
        .route("/p/{code}/cover.jpg", get(playlist_share_cover))
        .route("/p/{code}/preview/{i}", get(playlist_preview))
        .route("/p/{code}/art/{i}", get(playlist_row_art))
        .route("/v1/profile", axum::routing::put(profile_put))
        .route("/v1/profile/{handle}", get(profile_get))
        .route("/v1/shares", get(shares).post(send_share))
        .route("/v1/shares/grants", axum::routing::put(share_grant))
        .route("/v1/shares/{id}/taken", post(share_taken))
        .route("/v1/shares/{id}/dismiss", post(share_dismiss))
        .route("/v1/invites", post(create_invite))
        .route("/v1/invites/{code}", get(invite_preview))
        .route("/v1/invites/{code}/redeem", post(redeem_invite))
        // The shareable face of an invite: what a tapped link lands on.
        .route("/i/{code}", get(invite_landing))
        .route("/v1/memberships", get(memberships).post(set_membership))
        // The app's own updates, from the same central place sign-in comes
        // from - every device checks here, whatever music server it uses.
        .route("/v1/app/bundle", get(app_bundle_manifest))
        .route("/v1/app/bundle/{name}", get(app_bundle_file))
        .layer(cors)
        .with_state(state);

    let addr = format!("{bind}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind registry port");
    println!("[registry] listening on {addr}");
    println!("[registry] data    {}", data.display());

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}
