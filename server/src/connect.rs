//! AttackFM Connect: one account, many devices, one thing playing.
//!
//! This is the Spotify-Connect shape. Every signed-in client opens a WebSocket
//! here and registers as a DEVICE. The account has at most one ACTIVE device -
//! the one actually decoding audio - and every other device is a remote: it
//! shows what is playing and can drive it. The server owns two facts and only
//! those: which devices exist, and the one authoritative playback session
//! (what's playing, where, on whom). It never touches audio.
//!
//! Authority is deliberately singular. The ACTIVE device owns the clock and is
//! the only writer of playback state; it reports on discontinuities (play,
//! pause, track, seek) and the position between them is extrapolated from
//! (positionMs, playing, updatedAt), so a steady stream of position frames is
//! never needed. A remote never writes state - it sends a COMMAND, the server
//! routes it to the active device, the active device executes and reports fresh
//! state. One writer, no conflicts.
//!
//! Transfer is how playback moves: any device asks to make some device active;
//! the server bumps an epoch (so a late frame from the deposed device is
//! ignored), tells the new device to `becomeActive` from the current state, and
//! tells the old one to `release`. The device you press "play here" on picks up
//! exactly where the other left off.
//!
//! Auth rides the stream token in the query string, because a browser cannot
//! set headers on a WebSocket - the same read-only, expiring capability the
//! `/api/stream` URLs already carry (see auth.rs).

use crate::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Per-connection ids are how the hub tells two tabs of the same device apart,
// and how a stale connection's teardown avoids clobbering a fresh one that
// reused the same device id (a reconnect).
static CONN_SEQ: AtomicU64 = AtomicU64::new(1);

// --- wire types --------------------------------------------------------------

#[derive(Clone, Serialize)]
struct Device {
    id: String,
    name: String,
    /// "desktop" | "phone" | "web" | "carplay"
    kind: String,
    online: bool,
    #[serde(rename = "lastSeen")]
    last_seen: i64,
}

/// The one authoritative now-playing. Sent to remotes to render; sent to a
/// newly-active device to resume from.
#[derive(Clone, Serialize, Default)]
struct Session {
    #[serde(rename = "activeDeviceId")]
    active_device_id: Option<String>,
    #[serde(rename = "trackId")]
    track_id: Option<i64>,
    #[serde(rename = "positionMs")]
    position_ms: i64,
    playing: bool,
    shuffle: bool,
    repeat: String,
    volume: f64,
    /// The active device's queue as track ids, so a remote can show what's next
    /// and a transfer target can rebuild it.
    queue: Vec<i64>,
    #[serde(rename = "queueIndex")]
    queue_index: i64,
    /// When positionMs was true, in epoch ms - remotes extrapolate from here.
    #[serde(rename = "updatedAt")]
    updated_at: i64,
    /// How long the playing song is, as the active device's own deck measures
    /// it. Zero means unknown (an older client that does not report it), which
    /// turns the clamp below off rather than guessing. See `clamp_to_track`.
    #[serde(rename = "durationMs")]
    duration_ms: i64,
    /// Bumped on every transfer. A state frame carrying an older epoch than the
    /// session is from a device that has since been deposed, and is dropped.
    epoch: i64,
}

struct Conn {
    conn_id: u64,
    tx: mpsc::UnboundedSender<String>,
}

#[derive(Default)]
struct UserHub {
    devices: HashMap<String, Device>,
    /// device id -> its live outbound connection. Absent means offline.
    conns: HashMap<String, Conn>,
    session: Session,
    /// The last command aimed at the active device while its socket was in a
    /// grace-period blip - delivered the moment it re-hellos. One, not a
    /// queue: transport commands supersede each other, and replaying a burst
    /// of stale ones at a device that just woke up is how playback teleports.
    pending: Option<Command>,
    /// The same holding pen for the commands that shape the SOUND, keyed by
    /// action so each store keeps its own latest.
    ///
    /// These do not supersede each other or the transport: the mix, the rack
    /// and the chain are three separate stores on the device, so a filter
    /// tapped during a blip used to be thrown away by the pause that followed
    /// it - and the listener's only evidence was a sound that did not change.
    /// A BTreeMap rather than a HashMap so the order they are handed back in
    /// is the same every time, which is one less thing for a test (or a
    /// bug report) to be at the mercy of.
    pending_sound: std::collections::BTreeMap<String, Command>,
}

impl UserHub {
    /// Hold a command for a seat-holder that is mid-blip.
    fn hold(&mut self, command: Command) {
        if shapes_sound(&command.action) {
            self.pending_sound.insert(command.action.clone(), command);
        } else {
            self.pending = Some(command);
        }
    }

    /// Everything held, taken, in the order it should be delivered.
    ///
    /// The sound goes FIRST: what the stream is coloured with is settled
    /// before a transport command asks it to play, so the device re-opens its
    /// connection once rather than twice.
    fn take_held(&mut self) -> Vec<Command> {
        let mut out: Vec<Command> = std::mem::take(&mut self.pending_sound)
            .into_values()
            .collect();
        out.extend(self.pending.take());
        out
    }

    /// Nothing held is worth keeping once the seat is not the same seat.
    ///
    /// Every held command was aimed at ONE device, at a moment when that
    /// device was the one making the sound. Handing them to whoever holds the
    /// seat next is handing them to somebody who never asked: a pause meant
    /// for the phone stops the desk, and a chain held for it re-colours a
    /// stream it was never about - and neither arrives when it was sent but
    /// the next time that device's own socket blips, which can be an hour
    /// later. Emptied when the seat empties (the grace lapse below) and
    /// emptied when it changes hands, which are the same fact.
    fn empty_the_pen(&mut self) {
        self.pending = None;
        self.pending_sound.clear();
    }

    /// Move the seat to `target`, answering with whoever held it before.
    ///
    /// The whole of what a transfer does to the hub's own state, so that the
    /// rules of one live in one place a test can drive: the epoch bump that
    /// makes a deposed device's late frame ignorable, the position advanced to
    /// NOW before the timestamp is refrozen (without it the hand-off carries a
    /// stale position, often still 0 from the track's start, and the new
    /// device restarts the song), and the holding pen emptied.
    fn hand_seat_to(&mut self, target: &str) -> Option<String> {
        let previous = self.session.active_device_id.clone();
        self.session.active_device_id = Some(target.to_string());
        self.session.epoch += 1;
        let now = now_ms();
        if self.session.playing {
            let advanced = (self.session.position_ms + (now - self.session.updated_at).max(0)).max(0);
            self.session.position_ms = clamp_to_track(advanced, self.session.duration_ms);
        }
        self.session.updated_at = now;
        self.empty_the_pen();
        previous
    }
}

#[derive(Default)]
pub struct ConnectState {
    users: tokio::sync::Mutex<HashMap<i64, UserHub>>,
}

impl ConnectState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// True while any listener has an active playing session. Background AI
    /// and file analysis use this to give playback the whole box.
    pub async fn any_playing(&self) -> bool {
        self.users
            .lock()
            .await
            .values()
            .any(|hub| hub.session.playing)
    }
}

/// What a client sends up.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMsg {
    /// Register (or re-register) this device.
    Hello {
        id: String,
        name: String,
        #[serde(default)]
        kind: Option<String>,
    },
    /// The active device reporting its authoritative playback state.
    State {
        #[serde(rename = "trackId")]
        track_id: Option<i64>,
        #[serde(rename = "positionMs")]
        position_ms: i64,
        playing: bool,
        #[serde(default)]
        shuffle: bool,
        #[serde(default)]
        repeat: Option<String>,
        #[serde(default)]
        volume: Option<f64>,
        #[serde(default)]
        queue: Option<Vec<i64>>,
        #[serde(rename = "queueIndex", default)]
        queue_index: Option<i64>,
        #[serde(rename = "durationMs", default)]
        duration_ms: Option<i64>,
    },
    /// A transport command, routed to whoever is active.
    Command { command: Command },
    /// Make `target` the active device, moving playback to it.
    Transfer { target: String },
    /// Keep-alive; the server answers with a pong frame anyway.
    Ping,
}

/// Transport a remote asks the active device to perform. Fields beyond `action`
/// are optional and interpreted per action (positionMs for seek, volume for
/// volume, queue+index for setQueue, gains for stems, effects/chain for the
/// two halves of the effects console).
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Command {
    /// play | pause | toggle | next | prev | seek | volume | setQueue | stems
    /// | effects | chain
    action: String,
    #[serde(rename = "positionMs", skip_serializing_if = "Option::is_none")]
    position_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    volume: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<i64>,
    /// For `stems`: the mix, as part name to gain (0 out, 1 full). The whole
    /// map travels rather than the one fader that moved, so a dropped frame
    /// cannot leave the remote and the playing device holding different mixes.
    /// Named here because this struct is a fixed shape - serde drops fields it
    /// was not told about, and without this the mix arrived empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    gains: Option<std::collections::HashMap<String, f64>>,
    /// For `effects`: the whole rack, as stream.rs's effect ids. Named here
    /// for the same reason `gains` is - this struct is a fixed shape, and
    /// serde drops what it was not told about.
    #[serde(skip_serializing_if = "Option::is_none")]
    effects: Option<Vec<String>>,
    /// For `chain`: the whole hi-fi chain, in order.
    ///
    /// Opaque JSON on purpose. A node is `{t, on, params}` today, and naming
    /// those three fields here would put a second copy of the client's schema
    /// in the hub - where the NEXT field a node grows would be dropped in
    /// transit, silently, exactly the way `gains` was before it was named.
    /// The hub is a pipe between two of one person's own devices; the
    /// receiving client sanitises what arrives through the same door its
    /// localStorage goes through (fxChain.ts's `sane`), which is where a
    /// validator belongs and where there is one already.
    #[serde(skip_serializing_if = "Option::is_none")]
    chain: Option<Vec<serde_json::Value>>,
}

/// The commands that SHAPE THE SOUND rather than drive the transport, and the
/// list this hub tells every device it carries WHOLE.
///
/// The same three words are in `shared/sound-commands.json`, which the client
/// builds its frames from and which the test at the bottom of this file checks
/// this array against - because two hand-written copies of a word cannot fail
/// together, and that is exactly how `gains` came to be dropped in transit
/// with both suites green.
///
/// Announced at hello because a hub that does NOT know one of these is worse
/// than useless for it: `Command` is a fixed shape, so serde drops the payload
/// of a field it was not told about, and the playing device gets a bare action
/// it can only ignore. During a seat holder's socket blip that bare frame also
/// takes the one transport slot below, so a filter tapped then loses a pause
/// that was waiting for delivery. A remote that hears nothing here keeps its
/// console at home instead.
const SOUND_ACTIONS: [&str; 3] = ["stems", "effects", "chain"];

/// Whether an action shapes the sound.
///
/// The difference matters in exactly two places - the hello above and the
/// grace-blip holding pen below - and in the pen it is the difference between
/// "supersedes" and "does not". A pause supersedes a play. A chain does not
/// supersede a mix, and neither supersedes a pause: each is the whole of a
/// different store on the device, and holding all three in one slot means
/// whichever arrived last is the only one that survives the blip.
fn shapes_sound(action: &str) -> bool {
    SOUND_ACTIONS.contains(&action)
}

/// The hub's own introduction, answering every hello. See `SOUND_ACTIONS`.
fn hello_message() -> String {
    json!({ "type": "hello", "carries": SOUND_ACTIONS }).to_string()
}

// --- the endpoint ------------------------------------------------------------

#[derive(Deserialize)]
pub struct ConnectQuery {
    /// The stream token (browsers cannot header-auth a WebSocket).
    t: String,
}

/// `GET /api/connect?t=<streamToken>` - upgrades to the Connect WebSocket.
pub async fn connect(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<ConnectQuery>,
) -> Response {
    let user_id = crate::auth::verify_stream_token(&state.db, &state.stream_secret, &q.t);
    ws.on_upgrade(move |socket| async move {
        match user_id {
            Some(uid) => handle_socket(socket, state, uid).await,
            None => {
                // Politely close an unauthenticated upgrade rather than hanging.
                let mut socket = socket;
                let _ = socket.send(Message::Close(None)).await;
            }
        }
    })
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, user_id: i64) {
    let (mut sink, mut stream) = {
        use futures_util::StreamExt;
        socket.split()
    };
    let conn_id = CONN_SEQ.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Pump outbound messages to the socket on their own task.
    let writer = tokio::spawn(async move {
        use futures_util::SinkExt;
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // The device id this connection registered, learned from its Hello. Held so
    // the disconnect path can mark exactly this device offline.
    let mut my_device: Option<String> = None;

    use futures_util::StreamExt;
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => continue,
        };
        let Ok(parsed) = serde_json::from_str::<ClientMsg>(&text) else {
            continue;
        };
        match parsed {
            ClientMsg::Hello { id, name, kind } => {
                my_device = Some(id.clone());
                on_hello(
                    &state,
                    user_id,
                    conn_id,
                    &tx,
                    id,
                    name,
                    kind.unwrap_or_else(|| "web".into()),
                )
                .await;
            }
            ClientMsg::State {
                track_id,
                position_ms,
                playing,
                shuffle,
                repeat,
                volume,
                queue,
                queue_index,
                duration_ms,
            } => {
                if let Some(dev) = &my_device {
                    on_state(
                        &state,
                        user_id,
                        dev,
                        track_id,
                        position_ms,
                        playing,
                        shuffle,
                        repeat,
                        volume,
                        queue,
                        queue_index,
                        duration_ms,
                    )
                    .await;
                }
            }
            ClientMsg::Command { command } => {
                on_command(&state, user_id, command).await;
            }
            ClientMsg::Transfer { target } => {
                on_transfer(&state, user_id, &target).await;
            }
            ClientMsg::Ping => {
                let _ = tx.send(json!({ "type": "pong" }).to_string());
            }
        }
    }

    // Disconnect: mark this device offline, but only if THIS connection is still
    // the registered one (a reconnect may have replaced it already).
    if let Some(dev) = my_device {
        on_disconnect(&state, user_id, &dev, conn_id).await;
    }
    writer.abort();
}

/// How long a vanished active device keeps its seat. A phone that blipped -
/// backgrounded WebView, a doorway, a proxy idling the socket - reconnects
/// well inside this; a device that is really gone loses the seat when it
/// lapses. Before this grace existed the seat opened the instant a socket
/// dropped, and a remote clicking during the blip would play locally and
/// STEAL the seat - then the phone came back, took it back, and paused the
/// remote: both devices lost.
const SEAT_GRACE_MS: u64 = 30_000;

// --- handlers ----------------------------------------------------------------

fn broadcast(hub: &UserHub, message: &str) {
    for conn in hub.conns.values() {
        let _ = conn.tx.send(message.to_string());
    }
}

fn devices_message(hub: &UserHub) -> String {
    let mut list: Vec<Device> = hub.devices.values().cloned().collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    json!({
        "type": "devices",
        "devices": list,
        "activeDeviceId": hub.session.active_device_id,
    })
    .to_string()
}

/// Keep an extrapolated position inside the song.
///
/// The active device reports only on discontinuities, so between them the hub
/// counts the seconds itself. That arithmetic assumes someone is still playing.
/// When the seat holder goes quiet instead - a remote that is loading, one that
/// was backgrounded, a speaker that never reports at all - the count keeps
/// running and the stored position walks off the end of the track. Handing THAT
/// number to the next device is what broke passing playback back: it seeked
/// past the last frame, so the deck parked on the end, paused, and the music
/// did not come back. Clamping costs a hand-off at most the tail of one song;
/// not clamping costs the song.
fn clamp_to_track(position_ms: i64, duration_ms: i64) -> i64 {
    if duration_ms > 0 {
        position_ms.min(duration_ms)
    } else {
        position_ms
    }
}

fn state_message(hub: &UserHub) -> String {
    // `now` is the hub's clock at send time. Remotes extrapolate the position
    // as base + (now - updatedAt), and both of those stamps must come from
    // the SAME clock: a phone whose clock ran behind the server's computed a
    // negative elapsed, clamped it to zero, and showed a position frozen at
    // the last report. With the server's now on the wire, the client measures
    // its own skew and the phone's clock stops being part of the answer.
    json!({ "type": "state", "state": hub.session, "now": now_ms() }).to_string()
}

async fn on_hello(
    state: &Arc<AppState>,
    user_id: i64,
    conn_id: u64,
    tx: &mpsc::UnboundedSender<String>,
    id: String,
    name: String,
    kind: String,
) {
    let mut users = state.connect.users.lock().await;
    let hub = users.entry(user_id).or_default();
    hub.devices.insert(
        id.clone(),
        Device {
            id: id.clone(),
            name,
            kind,
            online: true,
            last_seen: now_ms(),
        },
    );
    hub.conns.insert(
        id.clone(),
        Conn {
            conn_id,
            tx: tx.clone(),
        },
    );
    // This connection gets the full current picture; everyone else just needs
    // the refreshed device list. What this hub CARRIES goes first: it decides
    // what the device may put on the wire, and a device that acted on the rest
    // of the picture before hearing it would be guessing.
    let _ = tx.send(hello_message());
    let _ = tx.send(devices_message(hub));
    let _ = tx.send(state_message(hub));
    // The seat-holder returning from a blip collects what was aimed at it
    // while it was gone.
    if hub.session.active_device_id.as_deref() == Some(id.as_str()) {
        for cmd in hub.take_held() {
            let _ = tx.send(json!({ "type": "command", "command": cmd }).to_string());
        }
    }
    let devices = devices_message(hub);
    for (dev_id, conn) in hub.conns.iter() {
        if conn.conn_id != conn_id {
            let _ = conn.tx.send(devices.clone());
        }
        let _ = dev_id;
    }
}

// One `state` frame off the wire, spread flat: the socket hands these over
// one field at a time and a parameter struct here would be the same fields
// with a second name to keep in step with the message the client sends.
#[allow(clippy::too_many_arguments)]
async fn on_state(
    state: &Arc<AppState>,
    user_id: i64,
    device: &str,
    track_id: Option<i64>,
    position_ms: i64,
    playing: bool,
    shuffle: bool,
    repeat: Option<String>,
    volume: Option<f64>,
    queue: Option<Vec<i64>>,
    queue_index: Option<i64>,
    duration_ms: Option<i64>,
) {
    let mut users = state.connect.users.lock().await;
    let Some(hub) = users.get_mut(&user_id) else {
        return;
    };

    // A device reporting state claims active when the seat is empty (this is how
    // playback starts cold - press play, become active). If another device is
    // active, a non-active reporter is ignored: only the authority writes.
    let claimed = match &hub.session.active_device_id {
        None => {
            hub.session.active_device_id = Some(device.to_string());
            hub.session.epoch += 1;
            true
        }
        Some(active) if active == device => false,
        Some(_) => return,
    };

    let s = &mut hub.session;
    s.track_id = track_id;
    s.position_ms = position_ms.max(0);
    // Taken from this report or not at all: an old client sends none, and a
    // duration left over from the PREVIOUS song would clamp the new one to the
    // wrong length - worse than not clamping.
    s.duration_ms = duration_ms.unwrap_or(0).max(0);
    s.playing = playing;
    s.shuffle = shuffle;
    if let Some(r) = repeat {
        s.repeat = r;
    }
    if let Some(v) = volume {
        s.volume = v;
    }
    if let Some(q) = queue {
        s.queue = q;
    }
    if let Some(i) = queue_index {
        s.queue_index = i;
    }
    s.updated_at = now_ms();
    if let Some(dev) = hub.devices.get_mut(device) {
        dev.last_seen = s.updated_at;
    }

    // Remotes get the new state; the active device already knows what it just
    // told us. The device list rides along only when the seat actually moved -
    // it was going out with EVERY report, which is a second frame per report
    // for a list that had not changed, and on the client each one is a fresh
    // `devices` array that re-makes the whole Connect context object.
    //
    // The one exception is the device that just CLAIMED the seat, and it
    // matters more than it looks. A cold start is "press play, report, become
    // active" - and excluding the reporter meant the claimer was never sent a
    // frame naming it active. Its own `activeDeviceId` stayed at whatever it
    // last heard, so `ownsPlayback` was false on the very device that owned
    // playback. The report gate is `playing || ownsPlayback`, which then
    // collapses to `playing` - and the moment that device paused, the gate
    // went false and THE PAUSE WAS NEVER SENT. Every other device sat there
    // showing a song still running. So the claimer is told, once, here.
    let state_msg = state_message(hub);
    let devices_msg = devices_message(hub);
    for (dev_id, conn) in hub.conns.iter() {
        let mine = dev_id == device;
        if !mine || claimed {
            let _ = conn.tx.send(state_msg.clone());
        }
        if claimed {
            let _ = conn.tx.send(devices_msg.clone());
        }
    }
}

async fn on_command(state: &Arc<AppState>, user_id: i64, command: Command) {
    let mut users = state.connect.users.lock().await;
    let Some(hub) = users.get_mut(&user_id) else {
        return;
    };
    let Some(active) = hub.session.active_device_id.clone() else {
        return;
    };
    match hub.conns.get(&active) {
        Some(conn) => {
            let _ = conn
                .tx
                .send(json!({ "type": "command", "command": command }).to_string());
        }
        // The seat-holder is in its grace blip: hold the command for its
        // return rather than dropping it on the floor. Latest wins - per
        // store for the sound, and once for everything else.
        None => hub.hold(command),
    }
}

async fn on_transfer(state: &Arc<AppState>, user_id: i64, target: &str) {
    let mut users = state.connect.users.lock().await;
    let Some(hub) = users.get_mut(&user_id) else {
        return;
    };
    if !hub.conns.contains_key(target) {
        // Cannot hand playback to a device that is not connected. Say so in the
        // device list rather than dropping the tap on the floor: whoever tapped
        // is looking at a row that still says "tap to play here", and without
        // this correction the only feedback is nothing happening, forever.
        if let Some(dev) = hub.devices.get_mut(target) {
            dev.online = false;
        }
        let devices = devices_message(hub);
        broadcast(hub, &devices);
        return;
    }
    if hub.session.active_device_id.as_deref() == Some(target) {
        return;
    }
    let previous = hub.hand_seat_to(target);

    // The old active device stops; the new one resumes from the session.
    if let Some(prev) = previous {
        if let Some(conn) = hub.conns.get(&prev) {
            let _ = conn.tx.send(json!({ "type": "release" }).to_string());
        }
    }
    if let Some(conn) = hub.conns.get(target) {
        let _ = conn
            .tx
            .send(json!({ "type": "becomeActive", "state": hub.session }).to_string());
    }
    let devices = devices_message(hub);
    let state_msg = state_message(hub);
    broadcast(hub, &devices);
    broadcast(hub, &state_msg);
}

async fn on_disconnect(state: &Arc<AppState>, user_id: i64, device: &str, conn_id: u64) {
    let mut users = state.connect.users.lock().await;
    let Some(hub) = users.get_mut(&user_id) else {
        return;
    };

    // Only tear down if this exact connection is the current one. A reconnect
    // that already replaced it must not be undone by the old socket's teardown.
    match hub.conns.get(device) {
        Some(conn) if conn.conn_id == conn_id => {
            hub.conns.remove(device);
        }
        _ => return,
    }
    if let Some(dev) = hub.devices.get_mut(device) {
        dev.online = false;
        dev.last_seen = now_ms();
    }
    // The device that just left was the one playing. Its audio is very likely
    // still sounding - a dropped WebSocket says nothing about a media
    // pipeline - so the seat is NOT vacated here. It holds through a grace
    // window, long enough for a backgrounded WebView or an idled proxy to
    // reconnect; only if the device is still gone when the window lapses does
    // the session go paused and seatless. Unseating instantly was the seat-
    // stealing bug: a remote clicking during a two-second blip played locally,
    // took the seat, and got paused right back when the phone returned.
    if hub.session.active_device_id.as_deref() == Some(device) {
        let epoch_at_drop = hub.session.epoch;
        let state = Arc::clone(state);
        let device = device.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(SEAT_GRACE_MS)).await;
            let mut users = state.connect.users.lock().await;
            let Some(hub) = users.get_mut(&user_id) else {
                return;
            };
            // Still gone, still the holder, and nothing (a transfer, its own
            // return) has moved the session on: now the seat opens.
            let lapsed = !hub.conns.contains_key(&device)
                && hub.session.active_device_id.as_deref() == Some(device.as_str())
                && hub.session.epoch == epoch_at_drop;
            if !lapsed {
                return;
            }
            hub.session.active_device_id = None;
            hub.session.playing = false;
            hub.session.epoch += 1;
            hub.session.updated_at = now_ms();
            // The seat is empty: there is nobody left for a held command to be
            // delivered to, and keeping one would aim it at whatever device
            // takes the seat next.
            hub.empty_the_pen();
            hub.devices
                .retain(|id, d| d.online || Some(id) == hub.session.active_device_id.as_ref());
            let devices = devices_message(hub);
            let state_msg = state_message(hub);
            broadcast(hub, &devices);
            broadcast(hub, &state_msg);
        });
    }
    // Forget devices that are offline and not the active one, so the picker does
    // not accrete dead tabs forever. A device the session still references is
    // kept so its name survives a brief reconnect.
    hub.devices
        .retain(|id, d| d.online || Some(id) == hub.session.active_device_id.as_ref());

    let devices = devices_message(hub);
    let state_msg = state_message(hub);
    broadcast(hub, &devices);
    broadcast(hub, &state_msg);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The hand-back bug in one assertion: a seat holder that goes quiet lets
    /// the hub's between-reports clock run past the end of the song, and the
    /// next device seeked there parks on the last frame, paused. See
    /// `clamp_to_track`.
    #[test]
    fn extrapolated_position_stops_at_the_end_of_the_song() {
        assert_eq!(clamp_to_track(79_996, 30_000), 30_000);
        // Inside the song, untouched.
        assert_eq!(clamp_to_track(12_500, 30_000), 12_500);
        // Exactly the end is still the end.
        assert_eq!(clamp_to_track(30_000, 30_000), 30_000);
        // An older client reports no duration: no ceiling to apply, and
        // guessing one would be worse than the old behaviour.
        assert_eq!(clamp_to_track(79_996, 0), 79_996);
    }

    /// What the hub makes of one frame from a remote. Compared as JSON rather
    /// than as text: a `Value`'s object keys come back out sorted, which is a
    /// difference in spelling and not in meaning - and the client rebuilds
    /// every node through its own sanitiser before comparing anything.
    fn round_trip(sent: &str) -> serde_json::Value {
        let parsed: Command = serde_json::from_str(sent).expect("a frame the client can send");
        serde_json::from_str(&serde_json::to_string(&parsed).expect("and send on")).unwrap()
    }

    /// The client's own spelling of these commands, read rather than retyped.
    ///
    /// See `shared/sound-commands.json`: it is the ONE place the two languages
    /// agree on these words. Everything below reads it, so renaming a field on
    /// either side, or adding a fourth sound store to one of them, cannot leave
    /// both suites green - which is precisely what happened when the mix's
    /// `gains` was named in TypeScript and nowhere else.
    const FIXTURE: &str = include_str!("../../shared/sound-commands.json");

    /// Every JSON number as an f64, so `0` and `0.0` compare equal.
    ///
    /// A gain of zero - which is what karaoke sends, and so what the fixture
    /// samples - is written `0` by a browser and comes back out of the hub's
    /// `f64` map as `0.0`. That is one number in two spellings, and the thing
    /// under test here is whether the FIELD survived.
    fn as_floats(value: &Value) -> Value {
        match value {
            Value::Number(n) => serde_json::Number::from_f64(n.as_f64().unwrap_or(0.0))
                .map(Value::Number)
                .unwrap_or(Value::Null),
            Value::Array(items) => Value::Array(items.iter().map(as_floats).collect()),
            Value::Object(fields) => Value::Object(
                fields.iter().map(|(k, v)| (k.clone(), as_floats(v))).collect(),
            ),
            other => other.clone(),
        }
    }

    fn fixture_commands() -> serde_json::Map<String, Value> {
        let parsed: Value = serde_json::from_str(FIXTURE).expect("the shared fixture is JSON");
        parsed
            .get("commands")
            .and_then(|c| c.as_object())
            .cloned()
            .expect("the shared fixture has a `commands` object")
    }

    /// THE TRAP THE MIX FELL INTO FIRST, checked against what the client sends
    /// rather than against a copy of it.
    ///
    /// `Command` is a fixed shape and serde drops what it was not told about,
    /// so a field the struct does not name arrives at the playing device
    /// absent - with no error at either end and nothing in any log. The
    /// listener's whole evidence is a filter that does nothing. Every command
    /// in the fixture is sent through the hub here with a payload real enough
    /// to be nested, and has to come out the other side unchanged.
    #[test]
    fn every_sound_command_the_client_sends_survives_the_hub() {
        let commands = fixture_commands();

        // The two vocabularies are the same vocabulary. A rename on either
        // side, or a store added to one of them, lands here first.
        let mut named: Vec<&str> = commands.keys().map(|k| k.as_str()).collect();
        named.sort_unstable();
        let mut ours: Vec<&str> = SOUND_ACTIONS.to_vec();
        ours.sort_unstable();
        assert_eq!(
            named, ours,
            "shared/sound-commands.json and SOUND_ACTIONS disagree about what shapes the sound",
        );

        for (action, spec) in &commands {
            let field = spec["field"].as_str().expect("every command names its payload field");
            let frame = json!({ "action": action, field: spec["sample"] });
            assert_eq!(
                as_floats(&round_trip(&frame.to_string())),
                as_floats(&frame),
                "the hub dropped `{field}` from a `{action}` frame",
            );
            // And it is classified as sound, which is what keeps it out of the
            // single transport slot the holding pen has.
            assert!(shapes_sound(action), "the hub does not treat `{action}` as sound");
        }
    }

    /// What the hub tells a device it can send, and why a device asks.
    ///
    /// An older hub answers a hello with nothing of the sort, and a client
    /// reads that silence as "this hub will strip what you send" - which is
    /// true, and is the difference between a filter that does nothing and a
    /// filter that eats the pause somebody left waiting for a seat holder
    /// mid-blip.
    #[test]
    fn the_hub_says_what_it_carries() {
        let said: Value = serde_json::from_str(&hello_message()).unwrap();
        assert_eq!(said["type"], "hello");
        let carries: Vec<&str> = said["carries"]
            .as_array()
            .expect("a hello names what it carries")
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let mut said_sorted = carries.clone();
        said_sorted.sort_unstable();
        let commands = fixture_commands();
        let mut named: Vec<&str> = commands.keys().map(|k| k.as_str()).collect();
        named.sort_unstable();
        assert_eq!(said_sorted, named);
    }

    #[test]
    fn the_console_survives_the_hub() {
        let sent = r#"{"action":"chain","chain":[{"t":"tape","on":true,"params":{"wow":0.4}}]}"#;
        assert_eq!(round_trip(sent), serde_json::from_str::<Value>(sent).unwrap());

        let rack = r#"{"action":"effects","effects":["lofi","hall"]}"#;
        assert_eq!(round_trip(rack), serde_json::from_str::<Value>(rack).unwrap());

        // The empty cases, which are what "clear" and the console's all-off
        // send: present and empty, never absent. A `chain` command with the
        // field missing is not "take everything off", it is a command the
        // client is right to ignore - so the two must stay distinguishable
        // right through the hub.
        let cleared = r#"{"action":"chain","chain":[]}"#;
        assert_eq!(round_trip(cleared), serde_json::from_str::<Value>(cleared).unwrap());
        assert_eq!(
            round_trip(r#"{"action":"chain"}"#),
            serde_json::json!({ "action": "chain" }),
        );
    }

    fn command(action: &str) -> Command {
        serde_json::from_str(&format!(r#"{{"action":"{action}"}}"#)).unwrap()
    }

    /// The holding pen a seat-holder collects on its way back from a socket
    /// blip. One slot for transport, one per sound store - because a pause is
    /// an instruction that replaces the last one and a filter is not.
    #[test]
    fn a_blip_does_not_eat_the_sound_that_arrived_during_it() {
        let mut hub = UserHub::default();
        hub.hold(command("chain"));
        hub.hold(command("stems"));
        hub.hold(command("pause"));
        let held: Vec<String> = hub.take_held().into_iter().map(|c| c.action).collect();
        // All three, and the sound before the transport.
        assert_eq!(held, vec!["chain", "stems", "pause"]);
        // Taken means taken: a second hello must not replay them.
        assert!(hub.take_held().is_empty());
    }

    #[test]
    fn the_latest_word_from_each_store_is_the_one_held() {
        let mut hub = UserHub::default();
        hub.hold(command("play"));
        hub.hold(command("pause"));
        hub.hold(command("chain"));
        let mut chain_again = command("chain");
        chain_again.chain = Some(vec![]);
        hub.hold(chain_again);
        let held = hub.take_held();
        assert_eq!(
            held.iter().map(|c| c.action.as_str()).collect::<Vec<_>>(),
            vec!["chain", "pause"],
        );
        // The second chain, not the first: a store's latest state is its whole
        // state, so an older one is genuinely superseded.
        assert_eq!(held[0].chain, Some(vec![]));
    }

    /// THE PEN DOES NOT FOLLOW THE SEAT.
    ///
    /// Held commands were emptied when the seat EMPTIED and nowhere else, so a
    /// transfer - which is the other way a seat stops being that device's -
    /// left them in the pen. They were then handed to the device that took the
    /// seat, the next time its own socket blipped and it re-helloed: a pause
    /// aimed at the phone half an hour ago stopping the desk, and a chain held
    /// for the phone overwriting whatever the console holds by then.
    ///
    /// Driven through `hand_seat_to`, which is the whole of what a transfer
    /// does to the hub's own state - the two tests above drive the pen
    /// directly and would both stay green with this bug in place.
    #[test]
    fn the_holding_pen_does_not_follow_the_seat() {
        let mut hub = UserHub::default();
        hub.session.active_device_id = Some("desk".into());
        hub.hold(command("pause"));
        hub.hold(command("chain"));
        hub.hold(command("stems"));

        let previous = hub.hand_seat_to("phone");

        assert_eq!(previous.as_deref(), Some("desk"));
        assert_eq!(hub.session.active_device_id.as_deref(), Some("phone"));
        // The epoch moved, so a late frame from the deposed device is ignorable.
        assert_eq!(hub.session.epoch, 1);
        let held: Vec<String> = hub.take_held().into_iter().map(|c| c.action).collect();
        assert!(
            held.is_empty(),
            "the new seat holder was handed {held:?}, aimed at the device before it",
        );
    }
}
