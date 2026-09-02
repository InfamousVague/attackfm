//! Accounts, session tokens, and the stream tokens that let a bare `<audio>`
//! element fetch bytes.
//!
//! Two credentials, deliberately not the same one:
//!
//! - the **session token** is the account. It rides an `Authorization: Bearer`
//!   header on API calls, is stored server-side, and can be revoked one device
//!   at a time.
//! - the **stream token** is a read-only, expiring capability for media bytes.
//!   It has to travel in the query string, because `<audio src>` and `<img
//!   src>` cannot carry headers - so it is built to be the thing you would
//!   rather have leak into an access log: it is an HMAC over the user id, their
//!   stream epoch, and an expiry, it grants nothing but reads, it dies on its
//!   own, and bumping the user's epoch kills every one they hold at once.

use crate::db::Db;
use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// How long a freshly minted stream token is good for. Long enough that a
/// listener never trips over it mid-album, short enough that a leaked URL in
/// somebody's proxy log stops working within the week.
pub const STREAM_TOKEN_TTL_SECS: i64 = 7 * 24 * 60 * 60;

const SECRET_KEY: &str = "stream_secret";

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The HMAC key behind every stream token, minted on first boot and kept in the
/// database. Rotating it (deleting the row) invalidates every outstanding
/// stream token on the next restart, which is the blunt version of the
/// per-user epoch.
pub fn stream_secret(db: &Db) -> Vec<u8> {
    if let Some(existing) = db.meta_get(SECRET_KEY) {
        if let Ok(bytes) = URL_SAFE_NO_PAD.decode(&existing) {
            if bytes.len() >= 32 {
                return bytes;
            }
        }
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    let _ = db.meta_set(SECRET_KEY, &encoded);
    bytes.to_vec()
}

fn sign(secret: &[u8], payload: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(payload.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// Mints `user.epoch.expiry.signature`.
pub fn mint_stream_token(secret: &[u8], user_id: i64, epoch: i64) -> String {
    let expiry = now_secs() + STREAM_TOKEN_TTL_SECS;
    let payload = format!("{user_id}.{epoch}.{expiry}");
    let signature = sign(secret, &payload);
    format!("{payload}.{signature}")
}

/// Checks a stream token and returns the user it belongs to.
///
/// The signature is checked before anything else is believed, the expiry is
/// checked against the clock, and the epoch is checked against the account -
/// so a token survives only while all three still agree.
pub fn verify_stream_token(db: &Db, secret: &[u8], token: &str) -> Option<i64> {
    let mut parts = token.rsplitn(2, '.');
    let signature = parts.next()?;
    let payload = parts.next()?;

    let expected = sign(secret, payload);
    // Constant-time: a byte-by-byte early return would leak the signature one
    // request at a time.
    if !constant_time_eq(signature.as_bytes(), expected.as_bytes()) {
        return None;
    }

    let mut fields = payload.split('.');
    let user_id: i64 = fields.next()?.parse().ok()?;
    let epoch: i64 = fields.next()?.parse().ok()?;
    let expiry: i64 = fields.next()?.parse().ok()?;
    if fields.next().is_some() {
        return None;
    }
    if now_secs() >= expiry {
        return None;
    }
    let user = db.user_by_id(user_id)?;
    if user.stream_epoch != epoch {
        return None;
    }
    Some(user_id)
}

/// A day-scoped signature for a URL the server hands out itself to a page
/// with no sign-in (the invite link's wall). Not a session: it says only
/// "this server chose to show this today". Verification accepts today's and
/// yesterday's, so a page loaded before midnight still draws after it.
pub fn public_sig(secret: &[u8], payload: &str) -> String {
    let day = now_secs() / 86_400;
    sign(secret, &format!("public.{payload}.{day}"))
}

pub fn public_sig_ok(secret: &[u8], payload: &str, sig: &str) -> bool {
    let day = now_secs() / 86_400;
    [day, day - 1].iter().any(|d| {
        let expected = sign(secret, &format!("public.{payload}.{d}"));
        constant_time_eq(expected.as_bytes(), sig.as_bytes())
    })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// --- validated-token cache --------------------------------------------------

/// How long a stream token's verification is trusted before the database is
/// asked again. The signature and expiry are checked on every request either
/// way (they cost nothing); what this window defers is the epoch re-read - so
/// it is exactly how long a revoked device can keep fetching media bytes.
const TOKEN_CACHE_TTL_MS: i64 = 60 * 1000;

/// A hard ceiling on cached tokens. A library page fires one media request per
/// cover but every device holds only a handful of distinct tokens, so this is
/// generous; blowing past it means something is minting garbage, and the sane
/// answer is to start over rather than grow.
const TOKEN_CACHE_MAX: usize = 4096;

/// Remembers recently verified stream tokens so a page of fifty covers does
/// not queue fifty epoch lookups behind the one global database Mutex - which
/// is shared with the scanner and the curator, and on a busy box is exactly
/// where art requests were stalling.
#[derive(Default)]
pub struct StreamTokenCache {
    /// token -> (user id, trust it until this many ms since the epoch).
    map: std::sync::Mutex<std::collections::HashMap<String, (i64, i64)>>,
}

impl StreamTokenCache {
    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn get(&self, token: &str) -> Option<i64> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.get(token)
            .filter(|(_, until)| Self::now_ms() < *until)
            .map(|(user_id, _)| *user_id)
    }

    fn put(&self, token: &str, user_id: i64) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= TOKEN_CACHE_MAX {
            map.clear();
        }
        map.insert(token.to_string(), (user_id, Self::now_ms() + TOKEN_CACHE_TTL_MS));
    }

    /// Forgets every cached token a user holds. Called on revoke, so the admin
    /// action takes effect now rather than when the TTL runs out.
    pub fn purge_user(&self, user_id: i64) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, (uid, _)| *uid != user_id);
    }
}

/// `verify_stream_token`, minus the per-request database hit.
///
/// The HMAC and the embedded expiry are still checked every single time - a
/// forged or lapsed token never reaches the cache lookup. Only the epoch
/// consultation (the revocation check, the one part that needs the database)
/// is reused for up to a minute.
pub fn verify_stream_token_cached(
    db: &Db,
    secret: &[u8],
    cache: &StreamTokenCache,
    token: &str,
) -> Option<i64> {
    // Signature and expiry first, unconditionally: a cache hit must never
    // outlive the token itself or bless bytes we did not sign.
    let mut parts = token.rsplitn(2, '.');
    let signature = parts.next()?;
    let payload = parts.next()?;
    if !constant_time_eq(signature.as_bytes(), sign(secret, payload).as_bytes()) {
        return None;
    }
    let expiry: i64 = payload.split('.').nth(2)?.parse().ok()?;
    if now_secs() >= expiry {
        return None;
    }

    if let Some(user_id) = cache.get(token) {
        return Some(user_id);
    }
    let user_id = verify_stream_token(db, secret, token)?;
    cache.put(token, user_id);
    Some(user_id)
}

// --- passwords ------------------------------------------------------------

pub fn hash_password(password: &str) -> Result<String, String> {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    use argon2::Argon2;
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    use argon2::Argon2;
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

// --- request extraction ---------------------------------------------------

/// The caller behind a request, resolved from the `Authorization` header.
#[derive(Clone)]
pub struct Caller {
    pub id: i64,
    /// Carried for the sake of anything that needs to name the caller in an
    /// error or a log line; the handlers themselves route on the id.
    #[allow(dead_code)]
    pub username: String,
    pub is_admin: bool,
}

/// Pulls the bearer token out of a request's headers.
pub fn bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let token = raw.strip_prefix("Bearer ").or_else(|| raw.strip_prefix("bearer "))?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// Resolves the caller, or the 401 that says why not.
pub fn require_caller(db: &Db, headers: &axum::http::HeaderMap) -> Result<Caller, StatusCode> {
    let token = bearer(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let user = db.user_for_token(&token).ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Caller {
        id: user.id,
        username: user.username,
        is_admin: user.is_admin,
    })
}

pub fn require_admin(db: &Db, headers: &axum::http::HeaderMap) -> Result<Caller, StatusCode> {
    let caller = require_caller(db, headers)?;
    if !caller.is_admin {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(caller)
}

/// What the app says it is, for the session it is asking for - a short label
/// ("android", "iPhone", "macOS") sent as `x-afm-device`. Empty when absent;
/// never trusted for anything but a name in a list.
pub fn device_label(headers: &axum::http::HeaderMap) -> String {
    headers
        .get("x-afm-device")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().chars().take(80).collect())
        .unwrap_or_default()
}
