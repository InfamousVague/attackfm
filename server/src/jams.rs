//! Jams: friends listening to the same song at the same time.
//!
//! A jam is one host and the friends who joined them. The host's player is the
//! clock: it posts where it is every few seconds, and every member reads that
//! and follows. Nothing here drives audio - members' own players do that from
//! what they read, exactly the way a Connect remote extrapolates a position
//! between updates.
//!
//! Deliberately NOT built into connect.rs. That hub is one-user-many-devices
//! and carries live playback for the whole app; a jam is many-users-one-room.
//! Keeping them apart means a bug in here cannot take somebody's music down
//! with it.
//!
//! Held in memory only. A jam is a moment, not a record - if the server
//! restarts, the music was already interrupted.
//!
//! What the room knows about its people: everyone's `seen_at`, refreshed by
//! their polls, so a member who closed the app drops off the list instead of
//! being counted forever; and the host's beat, which is the room's pulse. A
//! host who goes quiet, or leaves, hands the room to whoever has been in it
//! longest - the music was playing for them too, and a room that vanished
//! mid-song the moment the host's phone locked was the loudest complaint.
use crate::auth;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use rand::Rng;
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A host whose beat has not arrived in this long is not hosting any more -
/// the app is closed, backgrounded past the throttle, or off the network. The
/// room passes to the next member rather than freezing on them.
const HOST_QUIET_MS: i64 = 30_000;
/// A member whose poll has not arrived in this long has left without saying
/// so. Followers poll every few seconds; hidden ones keep polling slower.
const MEMBER_QUIET_MS: i64 = 60_000;
/// A room nobody has touched in this long is over.
const ROOM_STALE_MS: i64 = 90_000;
/// How many pending additions a room holds before it stops taking more.
const ADDITIONS_CAP: usize = 50;
/// How many recent events a room remembers for latecomers to read.
const EVENTS_KEPT: usize = 12;
/// Another of the host's devices may take the clock only after this device
/// has been silent this long; before that a paused second phone would clobber
/// the room with its own idle state.
const CLOCK_HANDOVER_MS: i64 = 10_000;

#[derive(Clone)]
pub struct Member {
    pub id: i64,
    pub name: String,
    pub joined_at: i64,
    pub seen_at: i64,
}

#[derive(Clone)]
pub struct Event {
    pub at: i64,
    /// "joined" | "left" | "host" (the room changed hands to `who`).
    pub kind: &'static str,
    pub who: String,
}

/// One friend asking another to listen along. `from` is doing the asking; `to`
/// is the one already playing, who will HOST the room when they accept - their
/// player is the music, so the invite goes to the source, not the other way.
/// Held only until accepted, declined, or it goes stale.
#[derive(Clone)]
pub struct Invite {
    pub from_id: i64,
    pub from_name: String,
    pub to_id: i64,
    pub at: i64,
}

/// A listen-along ask is a live nudge, not a standing request: if it is not
/// answered while the asker is still there wanting it, it has expired.
const INVITE_TTL_MS: i64 = 120_000;

#[derive(Clone)]
pub struct Jam {
    pub id: String,
    pub host_id: i64,
    pub host_name: String,
    /// Everyone listening, host included, in the order they arrived.
    pub members: Vec<Member>,
    pub track_id: Option<i64>,
    /// What is on, by name, so a member without the song still knows what
    /// the room is hearing - ids mean something on one box only.
    pub track_title: String,
    pub track_artist: String,
    pub position_ms: i64,
    pub playing: bool,
    /// What the host is playing through, so a member can show what is next.
    pub queue: Vec<i64>,
    /// Tracks members have asked to add, waiting for the host to take them into
    /// its own queue. Kept apart from `queue` so the host's next state post -
    /// which overwrites `queue` wholesale - cannot clobber a pending request;
    /// the host drains this on its beat. One-way (member -> host) by design.
    pub additions: Vec<i64>,
    /// Who asked for each track, by track id, for as long as the jam lives.
    pub added_by: HashMap<i64, String>,
    /// When position_ms was true. Members extrapolate forward from here.
    pub updated_at: i64,
    /// Which of the host's devices is the clock, and when it last beat.
    pub clock_device: String,
    pub clock_at: i64,
    pub events: VecDeque<Event>,
    pub created_at: i64,
}

impl Jam {
    fn member(&self, id: i64) -> Option<&Member> {
        self.members.iter().find(|m| m.id == id)
    }

    fn has(&self, id: i64) -> bool {
        self.member(id).is_some()
    }

    fn note(&mut self, kind: &'static str, who: &str) {
        self.events.push_back(Event { at: now_ms(), kind, who: who.to_string() });
        while self.events.len() > EVENTS_KEPT {
            self.events.pop_front();
        }
    }

    /// The room after `id` walks out: hands off if they were the host, and
    /// says whether anybody is left.
    fn remove(&mut self, id: i64) -> bool {
        let Some(pos) = self.members.iter().position(|m| m.id == id) else {
            return !self.members.is_empty();
        };
        let gone = self.members.remove(pos);
        self.note("left", &gone.name);
        if self.host_id == id {
            self.hand_off();
        }
        !self.members.is_empty()
    }

    /// The longest-standing member takes the clock. Their app sees itself as
    /// host on its next poll and starts beating from where its own deck is -
    /// which is where the room was, since it was following.
    fn hand_off(&mut self) {
        if let Some(next) = self.members.iter().min_by_key(|m| m.joined_at).cloned() {
            self.host_id = next.id;
            self.host_name = next.name.clone();
            self.clock_device = String::new();
            self.clock_at = 0;
            self.updated_at = now_ms();
            self.note("host", &next.name);
        }
    }

    /// The wire shape. `positionMs` is carried forward to NOW for a playing
    /// jam (capped: a beat that stopped is not a song that kept going), so a
    /// member that just joined lands in the right place. `now` is the hub's
    /// clock, for the reader to measure its own skew against.
    fn to_json(&self) -> serde_json::Value {
        let now = now_ms();
        let drift = if self.playing { (now - self.updated_at).clamp(0, HOST_QUIET_MS) } else { 0 };
        json!({
            "id": self.id,
            "hostId": self.host_id,
            "hostName": self.host_name,
            "members": self.members.iter().map(|m| m.name.clone()).collect::<Vec<_>>(),
            "people": self.members.iter().map(|m| json!({
                "id": m.id, "name": m.name, "joinedAt": m.joined_at, "seenAt": m.seen_at,
                "host": m.id == self.host_id,
            })).collect::<Vec<_>>(),
            "memberCount": self.members.len(),
            "trackId": self.track_id,
            "trackTitle": self.track_title,
            "trackArtist": self.track_artist,
            "positionMs": self.position_ms + drift,
            "playing": self.playing,
            "queue": self.queue,
            "addedBy": self.added_by,
            "updatedAt": self.updated_at,
            "hostQuiet": now - self.updated_at > HOST_QUIET_MS,
            "events": self.events.iter().map(|e| json!({ "at": e.at, "kind": e.kind, "who": e.who })).collect::<Vec<_>>(),
            "createdAt": self.created_at,
            "now": now,
        })
    }
}

#[derive(Default)]
pub struct JamState {
    jams: Mutex<HashMap<String, Jam>>,
    /// Listen-along asks waiting to be answered, newest kept. Separate from the
    /// rooms because an invite exists BEFORE any room does.
    invites: Mutex<Vec<Invite>>,
}

impl JamState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The rooms, whatever a previous holder did: a panic elsewhere must not
    /// poison every jam for the life of the process.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Jam>> {
        self.jams.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Housekeeping before every read and write: members who stopped
    /// polling leave, a quiet host hands off, and empty or abandoned rooms
    /// close. A dead jam is never offered to anybody.
    fn sweep(&self, jams: &mut HashMap<String, Jam>) {
        let now = now_ms();
        for jam in jams.values_mut() {
            let quiet: Vec<i64> = jam
                .members
                .iter()
                .filter(|m| now - m.seen_at > MEMBER_QUIET_MS)
                .map(|m| m.id)
                .collect();
            for id in quiet {
                jam.remove(id);
            }
            if !jam.members.is_empty() && jam.has(jam.host_id) && now - jam.updated_at > HOST_QUIET_MS {
                // The host is still polling but not beating: their player
                // stopped reporting (the app in the background past its
                // throttle). Somebody else takes the clock.
                if jam.members.len() > 1 {
                    let old = jam.host_id;
                    let others: Vec<&Member> = jam.members.iter().filter(|m| m.id != old).collect();
                    if let Some(next) = others.iter().min_by_key(|m| m.joined_at).cloned().cloned() {
                        jam.host_id = next.id;
                        jam.host_name = next.name.clone();
                        jam.clock_device = String::new();
                        jam.clock_at = 0;
                        jam.updated_at = now;
                        jam.note("host", &next.name);
                    }
                }
            }
        }
        jams.retain(|_, jam| {
            !jam.members.is_empty() && jam.has(jam.host_id) && now - jam.updated_at.max(jam.created_at) < ROOM_STALE_MS
                || (!jam.members.is_empty() && jam.members.iter().any(|m| now - m.seen_at < MEMBER_QUIET_MS))
        });
    }

    fn invites_lock(&self) -> MutexGuard<'_, Vec<Invite>> {
        self.invites.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Take `id` out of every room but `keep`, handing off where they hosted.
    fn withdraw(&self, jams: &mut HashMap<String, Jam>, id: i64, keep: Option<&str>) {
        for jam in jams.values_mut() {
            if keep.is_some_and(|k| k == jam.id) {
                continue;
            }
            if jam.has(id) {
                jam.remove(id);
            }
        }
        jams.retain(|_, j| !j.members.is_empty());
    }
}

/// A short, sayable id from an unambiguous alphabet - a jam gets shared out
/// loud. Random, and never one already live: the id is also the invitation,
/// so it must be neither guessable nor a door into somebody else's room.
fn jam_id(taken: &HashMap<String, Jam>) -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    loop {
        let id: String = (0..6).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect();
        if !taken.contains_key(&id) {
            return id;
        }
    }
}

/// `POST /api/jams` - start one, hosted by the caller. Starting again while
/// already hosting returns the jam you already have rather than a second one;
/// starting while following another room leaves that room first.
pub async fn create(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mut jams = state.jams.lock();
    state.jams.sweep(&mut jams);
    if let Some(existing) = jams.values().find(|j| j.host_id == caller.id) {
        return Ok(Json(existing.to_json()));
    }
    state.jams.withdraw(&mut jams, caller.id, None);
    let now = now_ms();
    let mut jam = Jam {
        id: jam_id(&jams),
        host_id: caller.id,
        host_name: caller.username.clone(),
        members: vec![Member { id: caller.id, name: caller.username.clone(), joined_at: now, seen_at: now }],
        track_id: None,
        track_title: String::new(),
        track_artist: String::new(),
        position_ms: 0,
        playing: false,
        queue: Vec::new(),
        additions: Vec::new(),
        added_by: HashMap::new(),
        updated_at: now,
        clock_device: String::new(),
        clock_at: 0,
        events: VecDeque::new(),
        created_at: now,
    };
    jam.note("joined", &caller.username);
    let out = jam.to_json();
    jams.insert(jam.id.clone(), jam);
    Ok(Json(out))
}

/// `GET /api/jams` - the jam you are in, and every jam your FRIENDS are
/// hosting. Only friends': a jam is not a public room, and the friend list is
/// the whole guest list. Reading is also the member's heartbeat.
pub async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let friend_ids: Vec<i64> = state.db.friends_of(caller.id).into_iter().map(|(id, _)| id).collect();
    let mut jams = state.jams.lock();
    let now = now_ms();
    for jam in jams.values_mut() {
        if let Some(m) = jam.members.iter_mut().find(|m| m.id == caller.id) {
            m.seen_at = now;
        }
    }
    state.jams.sweep(&mut jams);
    let mine = jams.values().find(|j| j.has(caller.id)).map(|j| j.to_json());
    let friends: Vec<_> = jams
        .values()
        .filter(|j| friend_ids.contains(&j.host_id) && !j.has(caller.id))
        .map(|j| j.to_json())
        .collect();
    // Listen-along asks addressed to this caller, freshest kept. Reading the
    // feed is where a friend discovers someone wants to hear along with them.
    let invites: Vec<_> = {
        let mut inv = state.jams.invites_lock();
        inv.retain(|i| now - i.at < INVITE_TTL_MS);
        inv.iter()
            .filter(|i| i.to_id == caller.id)
            .map(|i| json!({ "from": i.from_name, "at": i.at }))
            .collect()
    };
    Ok(Json(json!({ "current": mine, "friends": friends, "invites": invites })))
}

/// Resolve a name the client sent - a registry handle or a hub username - to a
/// (hub id, username), but ONLY when they are the caller's friend on THIS hub.
/// A listen-along is between friends who share a server, and nothing wider: the
/// same-server gate the whole feature is asked to honour lives here.
fn resolve_friend(state: &AppState, caller_id: i64, name: &str) -> Option<(i64, String)> {
    let want = name.trim();
    if want.is_empty() {
        return None;
    }
    let uid = state
        .db
        .user_by_name_ci(want)
        .map(|u| u.id)
        .or_else(|| state.db.member_by_handle(want).map(|(id, _, _, _)| id))?;
    state.db.friends_of(caller_id).into_iter().find(|(id, _)| *id == uid)
}

#[derive(Deserialize)]
pub struct InviteBody {
    pub to: String,
}

/// `POST /api/jams/invite {to}` - ask a friend who is playing to let you listen
/// along. Records the ask; their client sees it on its next feed read and can
/// accept (which starts the room) or let it go.
pub async fn invite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<InviteBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some((to_id, _)) = resolve_friend(&state, caller.id, &body.to) else {
        return Err((StatusCode::FORBIDDEN, "that friend is not on this server".into()));
    };
    if to_id == caller.id {
        return Err((StatusCode::BAD_REQUEST, "you cannot listen along with yourself".into()));
    }
    let now = now_ms();
    let mut inv = state.jams.invites_lock();
    inv.retain(|i| now - i.at < INVITE_TTL_MS && !(i.from_id == caller.id && i.to_id == to_id));
    inv.push(Invite { from_id: caller.id, from_name: caller.username.clone(), to_id, at: now });
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct FromBody {
    pub from: String,
}

/// `POST /api/jams/invite/accept {from}` - the friend who was asked says yes.
/// They HOST the room (their player is the music); the asker is dropped in so
/// they follow the moment they poll. Accepting into a room you already host
/// just adds them to it.
pub async fn accept_invite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FromBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some((from_id, from_name)) = resolve_friend(&state, caller.id, &body.from) else {
        return Err((StatusCode::NOT_FOUND, "no such invite".into()));
    };
    let now = now_ms();
    {
        let mut inv = state.jams.invites_lock();
        let before = inv.len();
        inv.retain(|i| !(i.from_id == from_id && i.to_id == caller.id) && now - i.at < INVITE_TTL_MS);
        if inv.len() == before {
            return Err((StatusCode::NOT_FOUND, "that invite is gone".into()));
        }
    }
    let mut jams = state.jams.lock();
    state.jams.sweep(&mut jams);
    if let Some(jam) = jams.values_mut().find(|j| j.host_id == caller.id) {
        if !jam.has(from_id) {
            jam.members.push(Member { id: from_id, name: from_name.clone(), joined_at: now, seen_at: now });
            jam.note("joined", &from_name);
        }
        return Ok(Json(jam.to_json()));
    }
    // Neither of us stays in another room: the asker leaves whatever they were
    // following, and a second host device of the acceptor's is stood down.
    state.jams.withdraw(&mut jams, caller.id, None);
    state.jams.withdraw(&mut jams, from_id, None);
    let mut jam = Jam {
        id: jam_id(&jams),
        host_id: caller.id,
        host_name: caller.username.clone(),
        members: vec![
            Member { id: caller.id, name: caller.username.clone(), joined_at: now, seen_at: now },
            Member { id: from_id, name: from_name.clone(), joined_at: now, seen_at: now },
        ],
        track_id: None,
        track_title: String::new(),
        track_artist: String::new(),
        position_ms: 0,
        playing: false,
        queue: Vec::new(),
        additions: Vec::new(),
        added_by: HashMap::new(),
        updated_at: now,
        clock_device: String::new(),
        clock_at: 0,
        events: VecDeque::new(),
        created_at: now,
    };
    jam.note("joined", &caller.username);
    jam.note("joined", &from_name);
    let out = jam.to_json();
    jams.insert(jam.id.clone(), jam);
    Ok(Json(out))
}

/// `POST /api/jams/invite/decline {from}` - the ask is let go. Quiet: the asker
/// simply never sees a room appear.
pub async fn decline_invite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FromBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if let Some((from_id, _)) = resolve_friend(&state, caller.id, &body.from) {
        let mut inv = state.jams.invites_lock();
        inv.retain(|i| !(i.from_id == from_id && i.to_id == caller.id));
    }
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/jams/{id}/join` - listen along.
///
/// The id IS the invitation. It is six random characters from an unambiguous
/// alphabet, it exists only in memory while the jam is live, and it is
/// learnable in exactly three ways: the host reads it out, the host shares a
/// link, or it appears in a friend's feed (`list`, which shows only friends'
/// jams). So holding one is the permission - which is what makes a jam work
/// in a car, where the people beside you may not be in your friends list.
pub async fn join(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let id = id.trim().to_lowercase();
    let mut jams = state.jams.lock();
    state.jams.sweep(&mut jams);
    // Existence FIRST, so a dead id cannot evict you from the room you are in.
    if !jams.contains_key(&id) {
        return Err((StatusCode::NOT_FOUND, "that jam has ended".into()));
    }
    // One jam at a time: joining leaves whatever you were in - handing that
    // room to its next member if you were hosting it.
    state.jams.withdraw(&mut jams, caller.id, Some(&id));
    let Some(jam) = jams.get_mut(&id) else {
        return Err((StatusCode::NOT_FOUND, "that jam has ended".into()));
    };
    let now = now_ms();
    if let Some(m) = jam.members.iter_mut().find(|m| m.id == caller.id) {
        m.seen_at = now;
    } else {
        jam.members.push(Member { id: caller.id, name: caller.username.clone(), joined_at: now, seen_at: now });
        jam.note("joined", &caller.username);
    }
    Ok(Json(jam.to_json()))
}

/// `POST /api/jams/{id}/leave` - step out. The host leaving hands the room to
/// whoever has been in it longest; the last person out closes it.
pub async fn leave(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let id = id.trim().to_lowercase();
    let mut jams = state.jams.lock();
    if let Some(jam) = jams.get_mut(&id) {
        if !jam.remove(caller.id) {
            jams.remove(&id);
        }
    }
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/jams/{id}/end` - the host closes the room for everyone. Leaving
/// hands the room on; this is the other thing a host might mean.
pub async fn end(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let id = id.trim().to_lowercase();
    let mut jams = state.jams.lock();
    let Some(jam) = jams.get(&id) else {
        return Ok(Json(json!({ "ok": true })));
    };
    if jam.host_id != caller.id {
        return Err((StatusCode::FORBIDDEN, "only the host can end the jam".into()));
    }
    jams.remove(&id);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct HostState {
    #[serde(rename = "trackId")]
    pub track_id: Option<i64>,
    #[serde(default, rename = "trackTitle")]
    pub track_title: String,
    #[serde(default, rename = "trackArtist")]
    pub track_artist: String,
    #[serde(rename = "positionMs")]
    pub position_ms: i64,
    pub playing: bool,
    #[serde(default)]
    pub queue: Option<Vec<i64>>,
    /// Which of the host's devices this is, so a second, idle device cannot
    /// clobber the clock the playing one keeps.
    #[serde(default, rename = "deviceId")]
    pub device_id: String,
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
    let id = id.trim().to_lowercase();
    let mut jams = state.jams.lock();
    let Some(jam) = jams.get_mut(&id) else {
        return Err((StatusCode::NOT_FOUND, "that jam has ended".into()));
    };
    if jam.host_id != caller.id {
        return Err((StatusCode::FORBIDDEN, "only the host sets the pace".into()));
    }
    let now = now_ms();
    if let Some(m) = jam.members.iter_mut().find(|m| m.id == caller.id) {
        m.seen_at = now;
    }
    // The clock belongs to the host's device that is PLAYING. Another of
    // their devices - a laptop left open, paused - may take it over only
    // once this one has been quiet a while, or if it is the one now playing
    // while the clock device reports nothing of the sort.
    let other_device = !jam.clock_device.is_empty() && jam.clock_device != body.device_id;
    if other_device && now - jam.clock_at < CLOCK_HANDOVER_MS && !(body.playing && !jam.playing) {
        return Ok(Json(json!({ "ok": true, "additions": [], "clock": false })));
    }
    jam.clock_device = body.device_id;
    jam.clock_at = now;
    jam.track_id = body.track_id;
    jam.track_title = body.track_title.chars().take(200).collect();
    jam.track_artist = body.track_artist.chars().take(200).collect();
    jam.position_ms = body.position_ms.max(0);
    jam.playing = body.playing;
    if let Some(queue) = body.queue {
        jam.queue = queue;
    }
    jam.updated_at = now;
    // Hand the host anything the room has asked to add since its last beat, and
    // clear it: the host folds these into its real queue, which comes back to
    // everyone on the next post.
    let additions = std::mem::take(&mut jam.additions);
    Ok(Json(json!({ "ok": true, "additions": additions, "clock": true })))
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
    let id = id.trim().to_lowercase();
    let mut jams = state.jams.lock();
    state.jams.sweep(&mut jams);
    let Some(jam) = jams.get_mut(&id) else {
        return Err((StatusCode::NOT_FOUND, "that jam has ended".into()));
    };
    let Some(name) = jam.member(caller.id).map(|m| m.name.clone()) else {
        return Err((StatusCode::FORBIDDEN, "join the jam to add to it".into()));
    };
    if !jam.queue.contains(&body.track_id) && !jam.additions.contains(&body.track_id) {
        if jam.additions.len() >= ADDITIONS_CAP {
            return Err((StatusCode::TOO_MANY_REQUESTS, "the jam's queue is full for now".into()));
        }
        jam.additions.push(body.track_id);
    }
    // Whoever asked owns the credit, even if the host already had it queued:
    // the room should read "Kayla wanted this" either way.
    jam.added_by.insert(body.track_id, name);
    Ok(Json(json!({ "ok": true })))
}
