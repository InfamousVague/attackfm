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
    #[serde(default)]
    songs: i64,
    #[serde(default)]
    playlists: i64,
    #[serde(default)]
    artists: i64,
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
    state.db.set_stats(who.sub, body.songs, body.playlists, body.artists, now);
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
        .route("/health", get(health))
        .route("/v1/pubkey", get(pubkey))
        .route("/v1/prefs", get(prefs_get).put(prefs_put))
        .route("/v1/resume", get(resume_get).put(resume_put))
        .route("/v1/signup", post(signup))
        .route("/v1/login", post(login))
        .route("/v1/login/challenge", post(challenge))
        .route("/v1/login/device", post(login_device))
        .route("/v1/device", post(add_device))
        .route("/v1/refresh", post(refresh))
        .route("/v1/announce", post(announce))
        .route("/v1/friends", get(friends))
        .route("/v1/friends/requests", post(friend_request))
        .route("/v1/friends/requests/{id}/accept", post(accept_request))
        .route("/v1/friends/requests/{id}/decline", post(decline_request))
        .route("/v1/friends/{account_id}", axum::routing::delete(remove_friend))
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
