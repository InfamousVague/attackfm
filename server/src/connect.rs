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
/// volume, queue+index for setQueue).
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Command {
    /// play | pause | toggle | next | prev | seek | volume | setQueue
    action: String,
    #[serde(rename = "positionMs", skip_serializing_if = "Option::is_none")]
    position_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    volume: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<i64>,
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

fn state_message(hub: &UserHub) -> String {
    json!({ "type": "state", "state": hub.session }).to_string()
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
    // the refreshed device list.
    let _ = tx.send(devices_message(hub));
    let _ = tx.send(state_message(hub));
    // The seat-holder returning from a blip collects what was aimed at it
    // while it was gone.
    if hub.session.active_device_id.as_deref() == Some(id.as_str()) {
        if let Some(cmd) = hub.pending.take() {
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
) {
    let mut users = state.connect.users.lock().await;
    let Some(hub) = users.get_mut(&user_id) else {
        return;
    };

    // A device reporting state claims active when the seat is empty (this is how
    // playback starts cold - press play, become active). If another device is
    // active, a non-active reporter is ignored: only the authority writes.
    match &hub.session.active_device_id {
        None => {
            hub.session.active_device_id = Some(device.to_string());
            hub.session.epoch += 1;
        }
        Some(active) if active == device => {}
        Some(_) => return,
    }

    let s = &mut hub.session;
    s.track_id = track_id;
    s.position_ms = position_ms.max(0);
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

    // Remotes get the new state; the active device already knows it. The device
    // list rides along only when the active seat just changed (epoch tells us).
    let state_msg = state_message(hub);
    let devices_msg = devices_message(hub);
    for (dev_id, conn) in hub.conns.iter() {
        if dev_id != device {
            let _ = conn.tx.send(state_msg.clone());
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
        // return rather than dropping it on the floor. Latest wins.
        None => hub.pending = Some(command),
    }
}

async fn on_transfer(state: &Arc<AppState>, user_id: i64, target: &str) {
    let mut users = state.connect.users.lock().await;
    let Some(hub) = users.get_mut(&user_id) else {
        return;
    };
    if !hub.conns.contains_key(target) {
        // Cannot hand playback to a device that is not connected.
        return;
    }
    let previous = hub.session.active_device_id.clone();
    if previous.as_deref() == Some(target) {
        return;
    }
    hub.session.active_device_id = Some(target.to_string());
    hub.session.epoch += 1;
    // Advance the stored position to now before freezing the timestamp. The
    // active device reports only on discontinuities (play/pause/seek/track), so
    // between them the true position is position_ms + the time elapsed since
    // updated_at. Without this the hand-off carries a stale position - often
    // still 0 from the track's start - and the new device restarts the song
    // instead of picking it up where it was.
    let now = now_ms();
    if hub.session.playing {
        hub.session.position_ms =
            (hub.session.position_ms + (now - hub.session.updated_at).max(0)).max(0);
    }
    hub.session.updated_at = now;

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
            hub.pending = None;
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
