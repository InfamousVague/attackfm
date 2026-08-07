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

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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
