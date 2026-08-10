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
    json!({
        "id": f.id, "handle": f.handle, "serverUrl": f.server_url,
        "seenAt": f.seen_at, "songs": f.songs, "playlists": f.playlists, "artists": f.artists,
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
}

/// The alphabet invite codes are drawn from: uppercase letters and digits with
/// the look-alikes removed (no 0/O, 1/I/L, U), so a code reads cleanly aloud and
/// drops into the app's segmented code boxes without a "was that an O or a zero?"
const INVITE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

/// An 8-character invite code. ~39 bits of entropy over a single-use invite that
/// lives a week - ample against guessing, yet short enough to read over the
/// phone or type by hand into eight boxes.
fn invite_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..8)
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
    // A week to use it.
    let expires = now_secs() + 7 * 24 * 3600;
    state
        .db
        .create_invite(&code, body.server_url.trim(), body.server_name.trim(), who.sub, role, expires, now_secs())
        .map_err(db_err)?;
    Ok(Json(json!({ "code": code, "serverUrl": body.server_url.trim(), "expiresAt": expires })))
}

/// `GET /v1/invites/{code}` - preview an invite (what server, who from) before
/// deciding to redeem it. No auth: a link recipient may look before signing in.
async fn invite_preview(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(code): axum::extract::Path<String>,
) -> ApiResult {
    let inv = state.db.invite(&code).ok_or((StatusCode::NOT_FOUND, "That invite is not valid.".into()))?;
    let expired = inv.expires_at != 0 && now_secs() >= inv.expires_at;
    let from = state.db.account_by_id(inv.created_by).map(|a| a.handle).unwrap_or_default();
    Ok(Json(json!({
        "serverUrl": inv.server_url,
        "serverName": inv.server_name,
        "from": from,
        "spent": inv.redeemed_by.is_some(),
        "expired": expired,
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
    if inv.redeemed_by.is_some() {
        return invite_page(
            "Invite already used",
            "<h1>That invite has already been used</h1><p>Ask whoever sent it for another.</p>",
        );
    }
    if inv.expires_at != 0 && now_secs() >= inv.expires_at {
        return invite_page(
            "Invite expired",
            "<h1>That invite has expired</h1><p>Ask whoever sent it for another.</p>",
        );
    }
    let from = state.db.account_by_id(inv.created_by).map(|a| a.handle).unwrap_or_default();
    let who = if from.is_empty() {
        "Someone".to_string()
    } else {
        format!("<strong>{}</strong>", esc(&from))
    };
    invite_page(
        "You're invited",
        &format!(
            "<h1>Join {name}</h1>\
             <p>{who} invited you to their music library on AttackFM.</p>\
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
    if inv.redeemed_by.is_some() {
        return Err((StatusCode::GONE, "That invite has already been used.".into()));
    }
    if inv.expires_at != 0 && now_secs() >= inv.expires_at {
        return Err((StatusCode::GONE, "That invite has expired.".into()));
    }
    state.db.redeem_invite(&code, who.sub, &inv.server_url, &inv.role, now_secs());
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
        .map(|m| json!({ "serverUrl": m.server_url, "role": m.role, "state": m.state, "since": m.since }))
        .collect();
    Ok(Json(json!({ "memberships": list })))
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

#[tokio::main]
async fn main() {
    let bind = env_or("AFM_REGISTRY_BIND", "127.0.0.1");
    let port: u16 = env_or("AFM_REGISTRY_PORT", "8790").parse().unwrap_or(8790);
    let data = std::path::PathBuf::from(env_or("AFM_REGISTRY_DATA", "./registry.sqlite3"));

    let db = Arc::new(Db::open(&data).expect("open registry database"));
    let issuer = Arc::new(load_or_make_issuer(&db));

    let state = Arc::new(AppState { db, issuer, challenges: Mutex::new(HashMap::new()) });

    let cors = CorsLayer::new().allow_origin(Any).allow_methods([Method::GET, Method::POST]).allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/pubkey", get(pubkey))
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
        .route("/v1/memberships", get(memberships))
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
