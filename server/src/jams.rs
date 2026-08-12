//! Jams: friends listening to the same song at the same time.
//!
//! A jam is one host and the friends who joined them. The host's player is the
//! clock: it posts where it is every few seconds, and every member reads that
//! and follows. Nothing here drives audio - members' own players do that from
//! what they read, exactly the way a Connect remote extrapolates a position
//! between updates.
//!
//! Deliberately NOT built into connect.rs. That hub is one-user-many-devices
//! and carries live playback for the whole app; a jam is many-users-one-room
//! and is new. Keeping them apart means a bug in here cannot take somebody's
//! music down with it, and the two can be merged later once this has earned
//! its keep.
//!
//! Held in memory only. A jam is a moment, not a record - if the server
//! restarts, the music was already interrupted.

use crate::auth;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A jam that has heard nothing from its host in this long is over: the host
/// closed the app, lost signal, or stopped. Members stop following rather
/// than sit forever on a song that has not moved.
const STALE_MS: i64 = 90_000;

#[derive(Clone)]
pub struct Jam {
    pub id: String,
    pub host_id: i64,
    pub host_name: String,
    /// Everyone listening, host included: user id -> their name.
    pub members: HashMap<i64, String>,
    pub track_id: Option<i64>,
    pub position_ms: i64,
    pub playing: bool,
    /// What the host is playing through, so a member can show what is next.
    pub queue: Vec<i64>,
    /// Tracks members have asked to add, waiting for the host to take them into
    /// its own queue. Kept apart from `queue` so the host's next state post -
    /// which overwrites `queue` wholesale - cannot clobber a pending request;
    /// the host drains this on its beat and folds them into its real queue,
    /// which then flows back out to the room. One-way (member -> host) by
    /// design, so there is never a merge to reconcile.
    pub additions: Vec<i64>,
    /// Who asked for each track, by track id, for as long as the jam lives.
    /// A jam is other people's taste arriving in your queue - saying whose is
    /// most of the point, and the host's own state posts carry only ids, so
    /// the attribution has to live here rather than ride the queue.
    pub added_by: HashMap<i64, String>,
    /// When position_ms was true. Members extrapolate forward from here.
    pub updated_at: i64,
    pub created_at: i64,
}

impl Jam {
    fn stale(&self) -> bool {
        now_ms() - self.updated_at > STALE_MS
    }

    /// The wire shape. `positionMs` is carried forward to NOW for a playing
    /// jam, so a member that just joined lands in the right place instead of
    /// wherever the host last happened to report.
    fn to_json(&self) -> serde_json::Value {
        let drift = if self.playing { (now_ms() - self.updated_at).max(0) } else { 0 };
        json!({
            "id": self.id,
            "hostId": self.host_id,
            "hostName": self.host_name,
            "members": self.members.values().cloned().collect::<Vec<_>>(),
            "memberCount": self.members.len(),
            "trackId": self.track_id,
            "positionMs": self.position_ms + drift,
            "playing": self.playing,
            "queue": self.queue,
            "addedBy": self.added_by,
            "updatedAt": self.updated_at,
        })
    }
}

#[derive(Default)]
pub struct JamState {
    jams: Mutex<HashMap<String, Jam>>,
}

impl JamState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Drops jams whose host has gone quiet. Called before every read, so a
    /// dead jam is never offered to anybody.
    fn sweep(&self, jams: &mut HashMap<String, Jam>) {
        jams.retain(|_, jam| !jam.stale());
    }
}

/// A short, sayable id - a jam gets shared out loud.
fn jam_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let seed = now_ms() as u64;
    let mut n = seed ^ (seed >> 17) ^ 0x9E3779B97F4A7C15;
    let mut out = String::new();
    for _ in 0..6 {
        n = n.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push(ALPHABET[(n >> 33) as usize % ALPHABET.len()] as char);
    }
    out
}

/// `POST /api/jams` - start one, hosted by the caller. Starting again while
/// already hosting returns the jam you already have rather than a second one.
pub async fn create(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mut jams = state.jams.jams.lock().unwrap();
    state.jams.sweep(&mut jams);

    if let Some(existing) = jams.values().find(|j| j.host_id == caller.id) {
        return Ok(Json(existing.to_json()));
    }

    let mut members = HashMap::new();
    members.insert(caller.id, caller.username.clone());
    let jam = Jam {
        id: jam_id(),
        host_id: caller.id,
        host_name: caller.username,
        members,
        track_id: None,
        position_ms: 0,
        playing: false,
        queue: Vec::new(),
        additions: Vec::new(),
        added_by: HashMap::new(),
        updated_at: now_ms(),
        created_at: now_ms(),
    };
    let out = jam.to_json();
    jams.insert(jam.id.clone(), jam);
    Ok(Json(out))
}

/// `GET /api/jams` - the jam you are in, and every jam your FRIENDS are
/// hosting. Only friends': a jam is not a public room, and the friend list is
/// the whole guest list.
pub async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let friend_ids: Vec<i64> = state.db.friends_of(caller.id).into_iter().map(|(id, _)| id).collect();

    let mut jams = state.jams.jams.lock().unwrap();
    state.jams.sweep(&mut jams);

    let mine = jams.values().find(|j| j.members.contains_key(&caller.id)).map(|j| j.to_json());
    let friends: Vec<_> = jams
        .values()
        .filter(|j| friend_ids.contains(&j.host_id) && !j.members.contains_key(&caller.id))
        .map(|j| j.to_json())
        .collect();

    Ok(Json(json!({ "current": mine, "friends": friends })))
}

/// `POST /api/jams/{id}/join` - listen along. Open to the host's friends
/// only, checked here rather than trusted from the client.
pub async fn join(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mut jams = state.jams.jams.lock().unwrap();
    state.jams.sweep(&mut jams);

    let Some(jam) = jams.get(&id) else {
        return Err((StatusCode::NOT_FOUND, "that jam has ended".into()));
    };
    let host_id = jam.host_id;
    if host_id != caller.id && !state.db.are_friends(caller.id, host_id) {
        return Err((StatusCode::FORBIDDEN, "only the host's friends can join".into()));
    }

    // One jam at a time: joining leaves whatever you were in.
    for other in jams.values_mut() {
        if other.id != id {
            other.members.remove(&caller.id);
        }
    }
    jams.retain(|_, j| !j.members.is_empty());

    let Some(jam) = jams.get_mut(&id) else {
        return Err((StatusCode::NOT_FOUND, "that jam has ended".into()));
    };
    jam.members.insert(caller.id, caller.username);
    Ok(Json(jam.to_json()))
}

/// `POST /api/jams/{id}/leave` - step out. The host leaving ends it for
/// everyone: without the clock there is nothing left to follow.
pub async fn leave(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mut jams = state.jams.jams.lock().unwrap();

    if let Some(jam) = jams.get_mut(&id) {
        if jam.host_id == caller.id {
            jams.remove(&id);
        } else {
            jam.members.remove(&caller.id);
        }
    }
    jams.retain(|_, j| !j.members.is_empty());
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct HostState {
    #[serde(rename = "trackId")]
    pub track_id: Option<i64>,
    #[serde(rename = "positionMs")]
    pub position_ms: i64,
    pub playing: bool,
    #[serde(default)]
    pub queue: Option<Vec<i64>>,
}

/// `POST /api/jams/{id}/state` - the host's clock, posted as it plays. Only
/// the host may: everyone else in the room is following, and a member that
/// could write would drag the room to wherever their own player drifted.
pub async fn set_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<HostState>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mut jams = state.jams.jams.lock().unwrap();
    let Some(jam) = jams.get_mut(&id) else {
        return Err((StatusCode::NOT_FOUND, "that jam has ended".into()));
    };
    if jam.host_id != caller.id {
        return Err((StatusCode::FORBIDDEN, "only the host sets the pace".into()));
    }
    jam.track_id = body.track_id;
    jam.position_ms = body.position_ms;
    jam.playing = body.playing;
    if let Some(queue) = body.queue {
        jam.queue = queue;
    }
    jam.updated_at = now_ms();
    // Hand the host anything the room has asked to add since its last beat, and
    // clear it: the host folds these into its real queue, which comes back to
    // everyone on the next post. Draining here (the host's own write) means no
    // extra round trip and no chance a member's request is served twice.
    let additions = std::mem::take(&mut jam.additions);
    Ok(Json(json!({ "ok": true, "additions": additions })))
}

#[derive(Deserialize)]
pub struct QueueAdd {
    #[serde(rename = "trackId")]
    pub track_id: i64,
}

/// `POST /api/jams/{id}/queue` - a member drops a track into the room's line.
/// Anyone in the jam may (that is the point); the host folds it in on its next
/// beat. Deduped against what is already queued or pending so a double-tap does
/// not stack the same song twice.
pub async fn add_to_queue(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<QueueAdd>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mut jams = state.jams.jams.lock().unwrap();
    state.jams.sweep(&mut jams);
    let Some(jam) = jams.get_mut(&id) else {
        return Err((StatusCode::NOT_FOUND, "that jam has ended".into()));
    };
    if !jam.members.contains_key(&caller.id) {
        return Err((StatusCode::FORBIDDEN, "join the jam to add to it".into()));
    }
    if !jam.queue.contains(&body.track_id) && !jam.additions.contains(&body.track_id) {
        jam.additions.push(body.track_id);
    }
    // Whoever asked owns the credit, even if the host already had it queued:
    // the room should read "Kayla wanted this" either way.
    let name = jam.members.get(&caller.id).cloned().unwrap_or_default();
    if !name.is_empty() {
        jam.added_by.insert(body.track_id, name);
    }
    Ok(Json(json!({ "ok": true })))
}
