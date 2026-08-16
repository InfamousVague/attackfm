//! Push notifications, out to the phone.
//!
//! Only a few things are worth interrupting somebody for: a playlist their
//! curator just built, music that has landed in the library, auditions waiting
//! to be met, a friend asking, and - on a clock rather than an event - a note
//! of what arrived and a recap of the week. Each is a `Kind` below, each can
//! be switched off on its own, and anything not on that list is not a
//! notification.
//!
//! The event-driven kinds are raised where the event happens (`imports.rs`,
//! `discovery.rs`); the rest are swept hourly by `sweeps` at the foot of this
//! file, each holding its own distance from the last one it sent.
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
    /// Auditions the collector fetched are waiting to be met in Date mode.
    Dates,
    /// The week just gone, in hours and a name.
    Recap,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Curated => "curated",
            Kind::Drops => "drops",
            Kind::Friends => "friends",
            Kind::Digest => "digest",
            Kind::Dates => "dates",
            Kind::Recap => "recap",
        }
    }
}

/// Every kind there is. The prefs endpoints both walk this, so a `Kind` added
/// above is switchable the moment it is listed here and nowhere else.
pub const ALL_KINDS: [Kind; 6] =
    [Kind::Curated, Kind::Drops, Kind::Friends, Kind::Digest, Kind::Dates, Kind::Recap];

/// How long a signing token is reused before a fresh one is minted. Apple's
/// ceiling is an hour and its floor is twenty minutes (mint faster and it
/// starts refusing); fifty leaves room for a slow clock at both ends.
const TOKEN_REUSE_SECS: i64 = 50 * 60;

/// The least time between two digests to the same listener. "Every few days"
/// means what it says - a digest that arrives daily is a notification people
/// switch off, and then they have switched off the only one that summarises.
pub const DIGEST_GAP_MS: i64 = 3 * 24 * 60 * 60 * 1000;

/// The least time between two "waiting to be met" nudges. Once a day at most:
/// the pile is not urgent, and a queue that pesters is a queue people stop
/// opening.
pub const DATES_GAP_MS: i64 = 24 * 60 * 60 * 1000;

/// How many auditions must be waiting before it is worth saying anything. One
/// song is not an occasion, and the collector trickles.
pub const DATES_FLOOR: i64 = 5;

/// A recap is weekly or it is not a recap.
pub const RECAP_GAP_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Below this the week had no shape worth reporting. A recap that says "you
/// played 2 songs" is a reminder that you did not listen, which nobody asked
/// for.
pub const RECAP_FLOOR: i64 = 10;

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
    let prefs: serde_json::Map<String, Value> = ALL_KINDS
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
    let known = ALL_KINDS.iter().any(|k| k.as_str() == body.kind);
    if !known {
        return Err((StatusCode::BAD_REQUEST, "no such notification kind".into()));
    }
    state.db.set_push_pref(who.id, &body.kind, body.enabled);
    Ok(Json(json!({ "ok": true })))
}

/// How long, said the way a person would. Minutes under an hour, hours and
/// minutes above it - never "0h 47m", and never seconds.
fn spell_duration(ms: i64) -> String {
    let mins = ms / 60_000;
    if mins < 60 {
        return format!("{} min", mins.max(1));
    }
    let (h, m) = (mins / 60, mins % 60);
    if m == 0 {
        format!("{h} {}", if h == 1 { "hour" } else { "hours" })
    } else {
        format!("{h}h {m}m")
    }
}

/// Whether one artist's share of a batch is worth putting a name to.
///
/// Two rules at once, and both are needed. It must be more than a single song,
/// or "12 songs landed, 1 of them X" names the least interesting fact
/// available; and it must be at least half the batch, or the name describes a
/// minority and quietly misleads. Half exactly counts - a name that covers
/// half the arrivals is the truest single thing that can be said about them.
fn dominates(n: i64, total: i64) -> bool {
    n >= 2 && n * 2 >= total
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Everything that arrives on a clock rather than on an event, swept hourly
/// over anyone with a device registered.
///
/// Three kinds share the walk, and each one owns its own gap: the round-up of
/// what landed, the nudge that auditions are waiting, and the week's recap.
/// `notify` re-checks the listener's preference and stamps the send, so a kind
/// switched off costs nothing here and a kind that fired keeps its distance
/// without this loop tracking anything itself.
///
/// Nothing is sent for an empty window. A notification whose body is "nothing
/// happened" is the fastest way to teach somebody to swipe the next one away.
pub async fn sweeps(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let now = now_ms();
        for user in state.db.push_audience() {
            digest_for(&state, user, now);
            dates_for(&state, user, now);
            recap_for(&state, user, now);
        }
    }
}

/// What landed while they were away, and who most of it was by.
fn digest_for(state: &Arc<AppState>, user: i64, now: i64) {
    let last = state.db.push_last_sent(user, Kind::Digest.as_str());
    if now - last < DIGEST_GAP_MS {
        return;
    }
    // Counted from the gap's start, not from `last`: a first-ever digest
    // should speak for the last few days, not all of history.
    let since = last.max(now - DIGEST_GAP_MS);
    let landed = state.db.tracks_added_since(since);
    if landed <= 0 {
        return;
    }
    let mut body = if landed == 1 {
        "1 song landed in the library while you were away.".to_string()
    } else {
        format!("{landed} songs landed in the library while you were away.")
    };
    // The name only earns its place when it accounts for a real share of the
    // batch - otherwise "12 songs landed, 1 of them X" says less than nothing.
    if let Some((artist, n)) = state.db.top_artist_added_since(since) {
        if dominates(n, landed) {
            body.push_str(&format!(" Mostly {artist}."));
        }
    }
    notify(state, user, Kind::Digest, "While you were away".into(), body);
}

/// The collector's pile, which otherwise sits unmet: Date mode is a page you
/// have to think to open, and nobody thinks to open it for music they do not
/// know is there.
fn dates_for(state: &Arc<AppState>, user: i64, now: i64) {
    if now - state.db.push_last_sent(user, Kind::Dates.as_str()) < DATES_GAP_MS {
        return;
    }
    let waiting = state.db.auditions_waiting(user);
    if waiting < DATES_FLOOR {
        return;
    }
    notify(
        state,
        user,
        Kind::Dates,
        "Waiting to meet you".into(),
        format!("{waiting} songs your curator found are waiting for a date."),
    );
}

/// The week just gone. Plays, time, and the one name that ran through it.
fn recap_for(state: &Arc<AppState>, user: i64, now: i64) {
    if now - state.db.push_last_sent(user, Kind::Recap.as_str()) < RECAP_GAP_MS {
        return;
    }
    let since = now - RECAP_GAP_MS;
    let (plays, ms) = state.db.listening_since(user, since);
    if plays < RECAP_FLOOR {
        return;
    }
    let mut body = format!("{plays} songs, {}.", spell_duration(ms));
    if let Some((artist, n)) = state.db.top_artists(user, since, 1).into_iter().next() {
        // Same rule as the digest: a name is worth printing when the week
        // actually belonged to it.
        if n >= 2 {
            body.push_str(&format!(" Most of it {artist}."));
        }
    }
    notify(state, user, Kind::Recap, "Your week in music".into(), body);
}

#[cfg(test)]
mod push_tests {
    use super::{dominates, spell_duration};

    /// The shapes a listener actually sees. The one that matters is the hour
    /// boundary: an unguarded h/m split prints "0h 47m" under an hour and
    /// "1h 0m" on it, and both read as a bug in the app rather than a number.
    #[test]
    fn durations_read_like_a_person_wrote_them() {
        assert_eq!(spell_duration(0), "1 min", "a rounded-down zero still happened");
        assert_eq!(spell_duration(47 * 60_000), "47 min");
        assert_eq!(spell_duration(59 * 60_000), "59 min");
        assert_eq!(spell_duration(60 * 60_000), "1 hour");
        assert_eq!(spell_duration(61 * 60_000), "1h 1m");
        assert_eq!(spell_duration(120 * 60_000), "2 hours");
        assert_eq!(spell_duration(195 * 60_000), "3h 15m");
    }

    /// A name is printed when it says something true about the batch.
    #[test]
    fn only_a_real_share_earns_a_name() {
        assert!(!dominates(1, 1), "one song is not a pattern");
        assert!(!dominates(1, 12), "the loneliest possible majority claim");
        assert!(!dominates(5, 12), "under half says less than the count alone");
        assert!(dominates(6, 12), "exactly half is the truest single thing");
        assert!(dominates(12, 12), "all of it");
        assert!(dominates(2, 3));
    }
}
