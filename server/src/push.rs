//! Push notifications, out to the phone.
//!
//! Four things are worth interrupting somebody for, and no more: a playlist
//! their curator just built, music that has landed in the library, a friend
//! asking, and - every few days, not every day - a note of what arrived. Each
//! is a `Kind` below, each can be switched off on its own, and anything not
//! on that list is not a notification.
//!
//! ## What it takes to actually send
//!
//! APNs, over HTTP/2, authenticated by a JWT this server signs with an
//! Apple-issued `.p8` key. Four settings, all from the environment:
//!
//! | Variable | What it is |
//! |---|---|
//! | `AFM_APNS_KEY_PATH` | The `.p8` file (Keys → new key with APNs enabled). |
//! | `AFM_APNS_KEY_ID` | That key's 10-character id. |
//! | `AFM_APNS_TEAM_ID` | The developer team id. |
//! | `AFM_APNS_TOPIC` | The app's bundle id. Defaults to the AttackFM one. |
//! | `AFM_APNS_ENV` | `sandbox` for development builds, else production. |
//!
//! **With none of that set, this module is inert**: every send is a no-op that
//! logs once. That is deliberate - the whole pipeline (registration, prefs,
//! triggers, the digest sweep) runs and is testable on a server that has no
//! Apple key, and starts delivering the moment one is dropped in. Nothing has
//! to be rewritten to switch it on.
//!
//! ## The token, and its lifetime
//!
//! The signing JWT is good for an hour and Apple rejects a server that mints a
//! fresh one per request, so it is cached and reused for 50 minutes. The DEVICE
//! token is a different thing entirely: opaque, rotating on the device's own
//! schedule, and only ever declared dead by APNs itself - a 410 retires it here
//! rather than any guess of ours.

use crate::AppState;
use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// What a notification can be about. The string form is what the preference
/// table and the client's settings both key on, so it is part of the contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The curator built a new playlist.
    Curated,
    /// Music landed in the library.
    Drops,
    /// Somebody asked to be friends.
    Friends,
    /// The every-few-days round-up.
    Digest,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Curated => "curated",
            Kind::Drops => "drops",
            Kind::Friends => "friends",
            Kind::Digest => "digest",
        }
    }
}

/// How long a signing token is reused before a fresh one is minted. Apple's
/// ceiling is an hour and its floor is twenty minutes (mint faster and it
/// starts refusing); fifty leaves room for a slow clock at both ends.
const TOKEN_REUSE_SECS: i64 = 50 * 60;

/// The least time between two digests to the same listener. "Every few days"
/// means what it says - a digest that arrives daily is a notification people
/// switch off, and then they have switched off the only one that summarises.
pub const DIGEST_GAP_MS: i64 = 3 * 24 * 60 * 60 * 1000;

pub struct Apns {
    key_pem: Vec<u8>,
    key_id: String,
    team_id: String,
    topic: String,
    host: &'static str,
    /// APNs speaks HTTP/2 only, so this client is built for it rather than
    /// borrowed from the call sites that do ordinary HTTP.
    client: reqwest::Client,
    /// The current signing token and when it was minted, epoch seconds.
    cached: std::sync::Mutex<Option<(String, i64)>>,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl Apns {
    /// Read the configuration, or None when this server has no Apple key -
    /// which is the ordinary state of a self-hosted box and not an error.
    pub fn from_env() -> Option<Self> {
        let path = env("AFM_APNS_KEY_PATH")?;
        let key_id = env("AFM_APNS_KEY_ID")?;
        let team_id = env("AFM_APNS_TEAM_ID")?;
        let key_pem = std::fs::read(&path)
            .map_err(|e| eprintln!("[push] cannot read {path}: {e}"))
            .ok()?;
        let sandbox = env("AFM_APNS_ENV").is_some_and(|v| v.eq_ignore_ascii_case("sandbox"));
        Some(Self {
            key_pem,
            key_id,
            team_id,
            topic: env("AFM_APNS_TOPIC").unwrap_or_else(|| "com.mattssoftware.attackfm".into()),
            // A development build's tokens are only known to the sandbox, and a
            // TestFlight or App Store build's only to production. Sending to the
            // wrong one is the classic "it works on my machine" of push.
            host: if sandbox {
                "https://api.sandbox.push.apple.com"
            } else {
                "https://api.push.apple.com"
            },
            client: reqwest::Client::builder()
                .http2_prior_knowledge()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| eprintln!("[push] cannot build APNs client: {e}"))
                .ok()?,
            cached: std::sync::Mutex::new(None),
        })
    }

    /// A signing token, minted if the cached one is old enough to be worth
    /// replacing. Errors are returned rather than cached, so a transient key
    /// problem does not pin a broken token for fifty minutes.
    fn token(&self) -> Result<String, String> {
        let now = now_secs();
        if let Ok(guard) = self.cached.lock() {
            if let Some((tok, minted)) = guard.as_ref() {
                if now - minted < TOKEN_REUSE_SECS {
                    return Ok(tok.clone());
                }
            }
        }
        let key = jsonwebtoken::EncodingKey::from_ec_pem(&self.key_pem)
            .map_err(|e| format!("bad APNs key: {e}"))?;
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
        header.kid = Some(self.key_id.clone());
        #[derive(Serialize)]
        struct Claims<'a> {
            iss: &'a str,
            iat: i64,
        }
        let tok = jsonwebtoken::encode(&header, &Claims { iss: &self.team_id, iat: now }, &key)
            .map_err(|e| format!("cannot sign APNs token: {e}"))?;
        if let Ok(mut guard) = self.cached.lock() {
            *guard = Some((tok.clone(), now));
        }
        Ok(tok)
    }

    /// Deliver one notification to one device. Returns Ok(false) when APNs says
    /// the token is dead, so the caller can retire it.
    async fn send(&self, device: &str, title: &str, body: &str, kind: Kind) -> Result<bool, String> {
        let jwt = self.token()?;
        let payload = serde_json::json!({
            "aps": { "alert": { "title": title, "body": body }, "sound": "default" },
            // The app reads this to decide where a tap should land.
            "kind": kind.as_str(),
        });
        let resp = self
            .client
            .post(format!("{}/3/device/{}", self.host, device))
            .header("authorization", format!("bearer {jwt}"))
            .header("apns-topic", &self.topic)
            .header("apns-push-type", "alert")
            // Notifications about the same kind supersede each other rather than
            // stacking: three "music landed" alerts in an hour is noise, and the
            // last one is the true one.
            .header("apns-collapse-id", kind.as_str())
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("APNs unreachable: {e}"))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(true);
        }
        // 410 Gone is APNs saying this token belongs to an app that is no
        // longer installed. It is the ONE authority on that, so it is the one
        // thing that deletes a row.
        if status.as_u16() == 410 {
            return Ok(false);
        }
        let detail = resp.text().await.unwrap_or_default();
        Err(format!("APNs {status}: {detail}"))
    }
}

/// Tell one listener something, on every device they have registered, if they
/// want this kind. Fire-and-forget by design: a notification that fails must
/// never fail the request that triggered it - nobody should lose a friend
/// request because Apple was slow.
pub fn notify(state: &Arc<AppState>, user_id: i64, kind: Kind, title: String, body: String) {
    if !state.db.push_wants(user_id, kind.as_str()) {
        return;
    }
    let tokens = state.db.push_tokens(user_id);
    if tokens.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        let Some(apns) = state.apns.as_ref() else {
            // Configured with no key: the pipeline still runs, so this is the
            // one line that says why nothing arrived.
            eprintln!(
                "[push] {} for user {user_id} not sent: no APNs key configured",
                kind.as_str()
            );
            return;
        };
        for device in tokens {
            match apns.send(&device, &title, &body, kind).await {
                Ok(true) => {}
                Ok(false) => state.db.retire_push_token(&device),
                Err(e) => eprintln!("[push] {}: {e}", kind.as_str()),
            }
        }
        state.db.mark_push_sent(user_id, kind.as_str());
    });
}

// ── The HTTP face ────────────────────────────────────────────────────────────
//
// Three small endpoints: a device saying "tell me things here", the reverse,
// and the per-kind preferences the settings pane shows. All per-account; the
// send side above never learns about HTTP.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth;

type ApiResult = Result<Json<Value>, (StatusCode, String)>;

fn caller(state: &Arc<AppState>, headers: &HeaderMap) -> Result<crate::auth::Caller, (StatusCode, String)> {
    auth::require_caller(&state.db, headers).map_err(|s| (s, "sign in first".into()))
}

#[derive(Deserialize)]
pub struct RegisterBody {
    pub token: String,
    #[serde(default)]
    pub platform: String,
    /// The device's own name ("Matt's iPhone"), for the devices pane.
    #[serde(default)]
    pub label: String,
}

/// `POST /api/push/register` - a device that wants to be told things.
pub async fn register(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RegisterBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let token = body.token.trim();
    if token.is_empty() || token.len() > 512 {
        return Err((StatusCode::BAD_REQUEST, "that is not a device token".into()));
    }
    let platform = if body.platform.trim().is_empty() { "ios" } else { body.platform.trim() };
    state.db.add_push_token(who.id, token, platform, body.label.trim());
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UnregisterBody {
    pub token: String,
}

/// `POST /api/push/unregister` - a sign-out, or notifications switched off on
/// that device.
pub async fn unregister(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<UnregisterBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    state.db.remove_push_token(who.id, body.token.trim());
    Ok(Json(json!({ "ok": true })))
}

/// `GET /api/push/prefs` - every kind with where this listener stands on it.
/// Unset means on (see push_wants), so the reply materialises the defaults the
/// settings pane needs rather than making the client know them.
pub async fn prefs(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let who = caller(&state, &headers)?;
    let set: std::collections::HashMap<String, bool> =
        state.db.push_prefs(who.id).into_iter().collect();
    let all = [Kind::Curated, Kind::Drops, Kind::Friends, Kind::Digest];
    let prefs: serde_json::Map<String, Value> = all
        .iter()
        .map(|k| (k.as_str().to_string(), Value::Bool(*set.get(k.as_str()).unwrap_or(&true))))
        .collect();
    Ok(Json(json!({ "prefs": prefs, "devices": state.db.push_tokens(who.id).len() })))
}

#[derive(Deserialize)]
pub struct PrefBody {
    pub kind: String,
    pub enabled: bool,
}

/// `POST /api/push/prefs` - one kind, switched.
pub async fn set_pref(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PrefBody>,
) -> ApiResult {
    let who = caller(&state, &headers)?;
    let known = [Kind::Curated, Kind::Drops, Kind::Friends, Kind::Digest]
        .iter()
        .any(|k| k.as_str() == body.kind);
    if !known {
        return Err((StatusCode::BAD_REQUEST, "no such notification kind".into()));
    }
    state.db.set_push_pref(who.id, &body.kind, body.enabled);
    Ok(Json(json!({ "ok": true })))
}

/// The every-few-days round-up, swept hourly: anyone with a device registered,
/// whose last digest is old enough, and for whom something actually arrived
/// since. `notify` re-checks the preference and stamps push_sent, so the sweep
/// itself stays a straight walk.
pub async fn digest_sweep(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        for user in state.db.push_audience() {
            let last = state.db.push_last_sent(user, Kind::Digest.as_str());
            let now = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if now - last < DIGEST_GAP_MS {
                continue;
            }
            // Counted from the gap's start, not from `last`: a first-ever
            // digest should speak for the last few days, not all of history.
            let since = last.max(now - DIGEST_GAP_MS);
            let landed = state.db.tracks_added_since(since);
            if landed <= 0 {
                continue;
            }
            let body = if landed == 1 {
                "1 song landed in the library while you were away.".to_string()
            } else {
                format!("{landed} songs landed in the library while you were away.")
            };
            notify(&state, user, Kind::Digest, "While you were away".into(), body);
        }
    }
}
