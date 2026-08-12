//! One-time device pairing.
//!
//! A device that is already signed in mints a short-lived code; a fresh device
//! turns that code into a full session of its own. It is how a phone links to
//! the server without anyone typing a password on the small keyboard: the
//! desktop shows a QR (and the same code in text), the phone scans or types it,
//! and the server hands back the token pair a normal sign-in would.
//!
//! The store is in memory on purpose. A pairing code is meant to live for the
//! couple of minutes it takes to walk a phone across a room; nothing here is
//! worth surviving a restart, and a dropped code just gets minted again.

use crate::{auth, AppState};
use axum::{extract::State, http::HeaderMap, http::StatusCode, Json};
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a code is good for. Long enough to carry a phone over and scan,
/// short enough that a code glimpsed over a shoulder is useless by the time it
/// is used. Overridable with `AFM_PAIR_TTL_SECS` for a demo/review box that
/// wants a code it can print and hand out; a code is still one-time, so a long
/// life only widens the window to the first claim, it never mints two sessions.
fn pair_ttl() -> Duration {
    let secs = std::env::var("AFM_PAIR_TTL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(180);
    Duration::from_secs(secs)
}

struct Pending {
    user_id: i64,
    expires: Instant,
}

/// The live codes, keyed by the (normalised) code string.
#[derive(Default)]
pub struct PairStore {
    inner: Mutex<HashMap<String, Pending>>,
}

impl PairStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Drop anything past its life. Called on every touch, so an idle store
    /// never accumulates - there is no separate sweeper task.
    fn sweep(map: &mut HashMap<String, Pending>) {
        let now = Instant::now();
        map.retain(|_, p| p.expires > now);
    }

    fn insert(&self, code: String, user_id: i64) {
        let mut map = self.inner.lock().unwrap();
        Self::sweep(&mut map);
        map.insert(
            code,
            Pending {
                user_id,
                expires: Instant::now() + pair_ttl(),
            },
        );
    }

    /// Consume a code. A claim is one-time: a valid code is removed as it is
    /// read, so the same code can never mint two sessions.
    fn take(&self, code: &str) -> Option<i64> {
        let mut map = self.inner.lock().unwrap();
        Self::sweep(&mut map);
        map.remove(code).map(|p| p.user_id)
    }
}

/// The code the human sees: uppercase, no ambiguous glyphs (no 0/O, 1/I), so
/// it reads cleanly aloud and types without a second guess. Six digits are easy
/// to dictate and still give a million possibilities inside a 3-minute life.
fn make_code() -> String {
    const ALPHABET: &[u8] = b"0123456789";
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// The one place the two strings that mean the same code are made to agree:
/// case-folded, and with the grouping dash/space a QR or a human might add
/// stripped back out.
fn normalise(code: &str) -> String {
    code.trim()
        .to_ascii_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// `POST /api/pair/start` - a signed-in device mints a code for a new one.
pub async fn start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let code = make_code();
    state.pairing.insert(code.clone(), caller.id);
    Ok(Json(json!({ "code": code, "expiresIn": pair_ttl().as_secs() })))
}

#[derive(Deserialize)]
pub struct ClaimBody {
    pub code: String,
}

/// A standing, reusable code for demo/review boxes.
///
/// Set `AFM_PAIR_STATIC_CODE` (the code) and `AFM_PAIR_STATIC_USER` (the account
/// it signs in as) and that code claims a session for that account every time,
/// never consumed - a QR an App Store reviewer (or the owner) can scan again and
/// again. Deliberately env-gated and never set on a real server: it is a
/// no-password backdoor into one named account, which only makes sense on an
/// isolated box whose whole purpose is to be signed into.
fn static_claim_user(state: &AppState, normalised_code: &str) -> Option<crate::db::User> {
    let code = std::env::var("AFM_PAIR_STATIC_CODE").ok()?;
    let want = normalise(&code);
    if want.is_empty() || want != normalised_code {
        return None;
    }
    let username = std::env::var("AFM_PAIR_STATIC_USER").ok()?;
    state.db.user_by_name(username.trim())
}

/// Mints the token pair a sign-in returns, for a resolved user.
fn issue_session(state: &AppState, user: &crate::db::User) -> Result<Json<Value>, (StatusCode, String)> {
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

/// `POST /api/pair/claim` - a new device turns a code into its own session,
/// identical to what a password sign-in would have handed back.
pub async fn claim(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ClaimBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let normalised_code = normalise(&body.code);

    // The reusable review code, if one is configured and matches: never
    // consumed, so it works any number of times.
    if let Some(user) = static_claim_user(&state, &normalised_code) {
        return issue_session(&state, &user);
    }

    let user_id = state.pairing.take(&normalised_code).ok_or((
        StatusCode::UNAUTHORIZED,
        "that code is wrong or has expired".to_string(),
    ))?;
    let user = state
        .db
        .user_by_id(user_id)
        .ok_or((StatusCode::UNAUTHORIZED, "account is gone".to_string()))?;

    issue_session(&state, &user)
}
