//! Jams: friends listening to the same song at the same time. A person reads
//! this as a GROOVE - every string that reaches a screen says so. The code,
//! the routes, the storage keys and the invite kind keep their old name:
//! renaming those would churn every client for no one's benefit.
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

/// One friend asking another into a room, in one of two directions:
///
/// - `along`: "let me listen along with you". `to` is already playing, and
///   accepting makes THEM the host - their player is the music. This is the
///   ask that rides a friend's now-playing.
/// - `jam`: "come jam with me". `from` is the host (they have a room already),
///   and accepting drops `to` into it. This is the ask you send an online
///   friend to gather people.
///
/// Held only until accepted, declined, or it goes stale.
#[derive(Clone)]
pub struct Invite {
    pub from_id: i64,
    pub from_name: String,
    pub to_id: i64,
    /// "along" (accepter hosts) or "jam" (asker hosts, accepter joins).
    pub kind: String,
    pub at: i64,
}

/// A listen-along ask is a live nudge, not a standing request: if it is not
/// answered while the asker is still there wanting it, it has expired.
const INVITE_TTL_MS: i64 = 120_000;

/// One track a member asked the room to play, waiting for the host to fold
/// it into the real queue. Who asked and when ride along so everyone can see
/// "Kayla asked for this, just now" before the host's player has even heard.
#[derive(Clone, Debug, PartialEq)]
pub struct Addition {
    pub track_id: i64,
    pub by_id: i64,
    pub by: String,
    pub at: i64,
}

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
    /// the host drains this on its beat, or on its poll once the beat has gone
    /// quiet. One-way (member -> host) by design. Everyone in the room reads
    /// it as `pending`, so an ask shows up the moment it is made rather than
    /// after the host's next beat.
    pub additions: Vec<Addition>,
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

    /// `id` was just heard from. Every call a member makes is their heartbeat;
    /// the host's is also what `hostSeenAt` reads.
    fn touch(&mut self, id: i64, now: i64) {
        if let Some(m) = self.members.iter_mut().find(|m| m.id == id) {
            m.seen_at = now;
        }
    }

    /// When the host was last heard - a clock post or a poll, whichever came
    /// later. A client compares this against `now` to say "waiting for the
    /// host's player" instead of leaving a member staring at a pending song.
    fn host_seen_at(&self) -> i64 {
        self.member(self.host_id).map(|m| m.seen_at).unwrap_or(0)
    }

    /// The host's player has not posted its clock lately. Its poll takes the
    /// room's asks instead, so a paused or backgrounded player does not leave
    /// them waiting. While the clock IS beating, the beat takes them - a host
    /// on an older client reads `additions` only from its beat, and a poll that
    /// drained them first would lose every other ask.
    fn clock_quiet(&self, now: i64) -> bool {
        // Never beaten (a fresh room, or one just handed to a new host) is
        // quiet too: there is no beat coming to take them.
        self.clock_at == 0 || now - self.clock_at >= CLOCK_HANDOVER_MS
    }

    /// A member asks the room to play `track_id`. Deduped against what is
    /// already queued or pending so a double-tap does not stack the same song
    /// twice; the credit goes to whoever asked either way, so the room reads
    /// "Kayla wanted this" even when the host already had it lined up.
    fn ask(&mut self, who: &Member, track_id: i64, now: i64) -> Result<(), ApiError> {
        if !self.queue.contains(&track_id) && !self.additions.iter().any(|a| a.track_id == track_id) {
            if self.additions.len() >= ADDITIONS_CAP {
                return Err((StatusCode::TOO_MANY_REQUESTS, "the groove's queue is full for now".into()));
            }
            self.additions.push(Addition { track_id, by_id: who.id, by: who.name.clone(), at: now });
        }
        self.added_by.insert(track_id, who.name.clone());
        Ok(())
    }

    /// Take a pending ask back: the person who made it, or the host. Nothing
    /// to take back once the host has folded it in - that is the host's queue
    /// now, and the room follows the host.
    fn take_back(&mut self, caller_id: i64, track_id: i64) -> Result<(), ApiError> {
        let Some(pos) = self.additions.iter().position(|a| a.track_id == track_id) else {
            return Err((StatusCode::NOT_FOUND, "that song is not waiting".into()));
        };
        if self.additions[pos].by_id != caller_id && self.host_id != caller_id {
            return Err((StatusCode::FORBIDDEN, "only whoever asked for it, or the host, can take it back".into()));
        }
        self.additions.remove(pos);
        self.added_by.remove(&track_id);
        Ok(())
    }

    /// Hand the host everything the room has asked for and clear it: the host
    /// folds these into its real queue, which comes back to everyone on the
    /// next beat. Exactly once - the caller is expected to be the host's
    /// client, whichever of its reads got here first.
    fn drain(&mut self) -> Vec<i64> {
        std::mem::take(&mut self.additions).into_iter().map(|a| a.track_id).collect()
    }

    /// A member's poll. Their heartbeat, and - for a host whose clock has gone
    /// quiet - the room's asks, so a paused player still takes them.
    fn poll(&mut self, caller_id: i64, now: i64) -> Vec<i64> {
        self.touch(caller_id, now);
        if self.host_id == caller_id && self.clock_quiet(now) {
            self.drain()
        } else {
            Vec::new()
        }
    }

    /// The host's clock post, already checked to be the host's. Returns what
    /// the host's client reads back: whether this device kept the clock, and
    /// the asks it should fold in.
    fn beat(&mut self, body: HostState, now: i64) -> serde_json::Value {
        self.touch(self.host_id, now);
        // The clock belongs to the host's device that is PLAYING. Another of
        // their devices - a laptop left open, paused - may take it over only
        // once this one has been quiet a while, or if it is the one now playing
        // while the clock device reports nothing of the sort.
        let other_device = !self.clock_device.is_empty() && self.clock_device != body.device_id;
        if other_device && now - self.clock_at < CLOCK_HANDOVER_MS && !(body.playing && !self.playing) {
            return json!({ "ok": true, "additions": [], "clock": false });
        }
        self.clock_device = body.device_id;
        self.clock_at = now;
        self.track_id = body.track_id;
        self.track_title = body.track_title.chars().take(200).collect();
        self.track_artist = body.track_artist.chars().take(200).collect();
        self.position_ms = body.position_ms.max(0);
        self.playing = body.playing;
        if let Some(queue) = body.queue {
            self.queue = queue;
        }
        self.updated_at = now;
        json!({ "ok": true, "additions": self.drain(), "clock": true })
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
            // What members have asked for that the host has not folded in yet,
            // in the order asked. `queue` and `addedBy` stay exactly as they
            // were for older clients; this is the part they could not see.
            "pending": self.additions.iter().map(|a| json!({
                "trackId": a.track_id, "by": a.by, "at": a.at,
            })).collect::<Vec<_>>(),
            "hostSeenAt": self.host_seen_at(),
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
/// the whole guest list. Reading is also the member's heartbeat, and for a
/// host whose player has stopped beating it carries the room's pending asks
/// as `additions`, exactly as the clock post does - whichever of the host's
/// reads gets there first folds them, and nobody's song is lost to a paused
/// player.
pub async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let friend_ids: Vec<i64> = state.db.friends_of(caller.id).into_iter().map(|(id, _)| id).collect();
    let mut jams = state.jams.lock();
    let now = now_ms();
    for jam in jams.values_mut() {
        jam.touch(caller.id, now);
    }
    state.jams.sweep(&mut jams);
    // The host's poll takes the room's asks once its clock has gone quiet -
    // a paused player must not leave a friend's song waiting - and `current`
    // is read AFTER, so what the host folds in is no longer shown pending.
    let additions = jams.values_mut().find(|j| j.has(caller.id)).map(|j| j.poll(caller.id, now)).unwrap_or_default();
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
            .map(|i| json!({ "from": i.from_name, "kind": i.kind, "at": i.at }))
            .collect()
    };
    Ok(Json(json!({ "current": mine, "friends": friends, "invites": invites, "additions": additions })))
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
    /// "along" (default - accepter hosts) or "jam" (asker hosts). An older
    /// client sends none and means the listen-along it was built for.
    #[serde(default)]
    pub kind: Option<String>,
}

/// `POST /api/jams/invite {to, kind}` - ask a friend into a room. `along` (the
/// default) asks a friend who is playing to let you listen along and host it;
/// `jam` asks an online friend to come join the room YOU host. Records the ask;
/// their client sees it on its next feed read and can accept or let it go.
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
        return Err((StatusCode::BAD_REQUEST, "you cannot invite yourself".into()));
    }
    let kind = match body.kind.as_deref() {
        Some("jam") => "jam",
        _ => "along",
    };
    let now = now_ms();
    let mut inv = state.jams.invites_lock();
    inv.retain(|i| now - i.at < INVITE_TTL_MS && !(i.from_id == caller.id && i.to_id == to_id));
    inv.push(Invite {
        from_id: caller.id,
        from_name: caller.username.clone(),
        to_id,
        kind: kind.to_string(),
        at: now,
    });
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
    // Take the invite AND its direction: an old one is gone, and the direction
    // decides who ends up hosting.
    let kind = {
        let mut inv = state.jams.invites_lock();
        let pos = inv
            .iter()
            .position(|i| i.from_id == from_id && i.to_id == caller.id && now - i.at < INVITE_TTL_MS);
        let Some(pos) = pos else {
            return Err((StatusCode::NOT_FOUND, "that invite is gone".into()));
        };
        inv.remove(pos).kind
    };
    let mut jams = state.jams.lock();
    state.jams.sweep(&mut jams);

    // "jam": the ASKER hosts, and accepting drops the caller into their room.
    if kind == "jam" {
        let Some(jid) = jams.values().find(|j| j.host_id == from_id).map(|j| j.id.clone()) else {
            return Err((StatusCode::NOT_FOUND, "their groove has ended".into()));
        };
        state.jams.withdraw(&mut jams, caller.id, Some(&jid));
        let jam = jams.get_mut(&jid).expect("just found it");
        if !jam.has(caller.id) {
            jam.members.push(Member { id: caller.id, name: caller.username.clone(), joined_at: now, seen_at: now });
            jam.note("joined", &caller.username);
        }
        return Ok(Json(jam.to_json()));
    }

    // "along": the CALLER hosts (their player is the music), asker follows.
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
        return Err((StatusCode::NOT_FOUND, "that groove has ended".into()));
    }
    // One jam at a time: joining leaves whatever you were in - handing that
    // room to its next member if you were hosting it.
    state.jams.withdraw(&mut jams, caller.id, Some(&id));
    let Some(jam) = jams.get_mut(&id) else {
        return Err((StatusCode::NOT_FOUND, "that groove has ended".into()));
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
        return Err((StatusCode::FORBIDDEN, "only the host can end the groove".into()));
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
        return Err((StatusCode::NOT_FOUND, "that groove has ended".into()));
    };
    if jam.host_id != caller.id {
        return Err((StatusCode::FORBIDDEN, "only the host sets the pace".into()));
    }
    // The beat hands the host anything the room has asked to add since its
    // last one, and clears it: the host folds these into its real queue, which
    // comes back to everyone on the next post.
    Ok(Json(jam.beat(body, now_ms())))
}

#[derive(Deserialize)]
pub struct QueueAdd {
    #[serde(rename = "trackId")]
    pub track_id: i64,
}

/// `POST /api/jams/{id}/queue` - a member drops a track into the room's line.
/// Anyone in the jam may (that is the point); the host folds it in on its next
/// beat. Deduped against what is already queued or pending so a double-tap does
/// not stack the same song twice. Answers with the room, so the asker's screen
/// can show the song pending without waiting for its next poll.
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
        return Err((StatusCode::NOT_FOUND, "that groove has ended".into()));
    };
    let Some(who) = jam.member(caller.id).cloned() else {
        return Err((StatusCode::FORBIDDEN, "join the groove to add to it".into()));
    };
    let now = now_ms();
    jam.touch(caller.id, now);
    jam.ask(&who, body.track_id, now)?;
    let mut out = jam.to_json();
    out["ok"] = json!(true);
    Ok(Json(out))
}

/// `DELETE /api/jams/{id}/queue/{track_id}` - take a pending ask back. Only
/// the person who asked, or the host; 404 once it is no longer waiting (the
/// host folded it in, or it was never asked for). Answers with the room.
pub async fn withdraw_from_queue(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((id, track_id)): Path<(String, i64)>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let id = id.trim().to_lowercase();
    let mut jams = state.jams.lock();
    state.jams.sweep(&mut jams);
    let Some(jam) = jams.get_mut(&id) else {
        return Err((StatusCode::NOT_FOUND, "that groove has ended".into()));
    };
    if !jam.has(caller.id) {
        return Err((StatusCode::FORBIDDEN, "join the groove to change it".into()));
    }
    jam.touch(caller.id, now_ms());
    jam.take_back(caller.id, track_id)?;
    let mut out = jam.to_json();
    out["ok"] = json!(true);
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(id: i64, name: &str) -> Member {
        Member { id, name: name.into(), joined_at: 0, seen_at: 0 }
    }

    /// matt hosts; ana and kayla are in the room. Nobody has been heard from
    /// and the clock has never beaten, exactly as a room looks right after
    /// `create` in a test where no clock is running.
    fn room() -> Jam {
        Jam {
            id: "abc234".into(),
            host_id: 1,
            host_name: "matt".into(),
            members: vec![person(1, "matt"), person(2, "ana"), person(3, "kayla")],
            track_id: None,
            track_title: String::new(),
            track_artist: String::new(),
            position_ms: 0,
            playing: false,
            queue: vec![100],
            additions: Vec::new(),
            added_by: HashMap::new(),
            updated_at: 0,
            clock_device: String::new(),
            clock_at: 0,
            events: VecDeque::new(),
            created_at: 0,
        }
    }

    fn clock(playing: bool, queue: Option<Vec<i64>>) -> HostState {
        HostState {
            track_id: Some(100),
            track_title: "song".into(),
            track_artist: "band".into(),
            position_ms: 1_000,
            playing,
            queue,
            device_id: "phone".into(),
        }
    }

    #[test]
    fn pending_carries_who_and_when_in_order() {
        let mut jam = room();
        let ana = person(2, "ana");
        let kayla = person(3, "kayla");
        jam.ask(&ana, 200, 1_000).unwrap();
        jam.ask(&kayla, 300, 2_000).unwrap();
        // A double-tap does not stack the song twice, and the credit is
        // whoever asked - even for a song the host already had queued.
        jam.ask(&ana, 200, 3_000).unwrap();
        jam.ask(&kayla, 100, 4_000).unwrap();

        let j = jam.to_json();
        let pending = j["pending"].as_array().unwrap();
        assert_eq!(pending.len(), 2, "{pending:?}");
        assert_eq!(pending[0], json!({ "trackId": 200, "by": "ana", "at": 1_000 }));
        assert_eq!(pending[1], json!({ "trackId": 300, "by": "kayla", "at": 2_000 }));
        // The shape older clients read is untouched.
        assert_eq!(j["queue"], json!([100]));
        assert_eq!(j["addedBy"]["200"], json!("ana"));
        assert_eq!(j["addedBy"]["300"], json!("kayla"));
        assert_eq!(j["addedBy"]["100"], json!("kayla"));
    }

    #[test]
    fn host_seen_at_moves_on_the_hosts_beat_and_poll_only() {
        let mut jam = room();
        assert_eq!(jam.to_json()["hostSeenAt"], json!(0));
        jam.beat(clock(true, None), 1_000);
        assert_eq!(jam.to_json()["hostSeenAt"], json!(1_000));
        jam.poll(1, 5_000);
        assert_eq!(jam.to_json()["hostSeenAt"], json!(5_000));
        // A guest's poll is the guest's heartbeat, not the host's.
        jam.poll(2, 9_000);
        assert_eq!(jam.to_json()["hostSeenAt"], json!(5_000));
        assert_eq!(jam.member(2).unwrap().seen_at, 9_000);
    }

    #[test]
    fn a_guest_takes_back_their_own_ask_and_nobody_elses() {
        let mut jam = room();
        jam.ask(&person(2, "ana"), 200, 1_000).unwrap();
        jam.ask(&person(3, "kayla"), 300, 2_000).unwrap();

        // kayla cannot take back ana's.
        let err = jam.take_back(3, 200).unwrap_err();
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        assert_eq!(jam.additions.len(), 2);

        // ana takes back her own: gone from pending, and the credit with it.
        jam.take_back(2, 200).unwrap();
        assert_eq!(jam.additions.len(), 1);
        assert_eq!(jam.additions[0].track_id, 300);
        assert!(!jam.added_by.contains_key(&200));

        // Not pending any more: 404, whoever asks.
        assert_eq!(jam.take_back(2, 200).unwrap_err().0, StatusCode::NOT_FOUND);
        assert_eq!(jam.take_back(1, 999).unwrap_err().0, StatusCode::NOT_FOUND);
        // Already in the host's queue is not pending either.
        assert_eq!(jam.take_back(1, 100).unwrap_err().0, StatusCode::NOT_FOUND);

        // The host may take back anyone's.
        jam.take_back(1, 300).unwrap();
        assert!(jam.additions.is_empty());
        assert!(jam.to_json()["pending"].as_array().unwrap().is_empty());
    }

    #[test]
    fn the_hosts_poll_drains_the_asks_exactly_once() {
        let mut jam = room();
        jam.ask(&person(2, "ana"), 200, 1_000).unwrap();
        jam.ask(&person(3, "kayla"), 300, 2_000).unwrap();

        // A guest's poll hands nothing over: the asks are the host's to fold.
        assert!(jam.poll(2, 3_000).is_empty());
        assert_eq!(jam.additions.len(), 2);

        // The host's player has never beaten: its poll takes them, in order.
        assert_eq!(jam.poll(1, 4_000), vec![200, 300]);
        assert!(jam.to_json()["pending"].as_array().unwrap().is_empty());
        // Once only.
        assert!(jam.poll(1, 5_000).is_empty());
        // And a beat after a drained poll has nothing to hand over either.
        let out = jam.beat(clock(true, Some(vec![100, 200, 300])), 6_000);
        assert_eq!(out["additions"], json!([]));
        assert_eq!(out["clock"], json!(true));
        assert_eq!(jam.to_json()["queue"], json!([100, 200, 300]));
    }

    #[test]
    fn a_beating_clock_keeps_the_asks_for_its_own_beat() {
        // A host on an older client folds asks from its beat and nothing else;
        // while that beat is arriving, the poll must not steal them.
        let mut jam = room();
        jam.beat(clock(true, None), 10_000);
        jam.ask(&person(2, "ana"), 200, 11_000).unwrap();
        assert!(jam.poll(1, 12_000).is_empty());
        assert_eq!(jam.additions.len(), 1);
        let out = jam.beat(clock(true, None), 13_000);
        assert_eq!(out["additions"], json!([200]));
        assert!(jam.additions.is_empty());

        // The beat stops (paused, backgrounded): after the handover window the
        // poll takes over so the song is not left waiting.
        jam.ask(&person(2, "ana"), 400, 14_000).unwrap();
        assert!(jam.poll(1, 20_000).is_empty());
        assert_eq!(jam.poll(1, 13_000 + CLOCK_HANDOVER_MS), vec![400]);
    }

    #[test]
    fn a_full_room_says_so_in_the_grooves_words() {
        let mut jam = room();
        let ana = person(2, "ana");
        for t in 0..ADDITIONS_CAP as i64 {
            jam.ask(&ana, 1_000 + t, t).unwrap();
        }
        let err = jam.ask(&ana, 5_000, 99).unwrap_err();
        assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(err.1, "the groove's queue is full for now");
    }
}
