//! Speakers on the network: finding UPnP/DLNA renderers, and playing to them.
//!
//! This is the third kind of "somewhere else the sound could come out", beside
//! Connect (another install of the app holding a seat) and the routes the phone
//! owns itself (AirPlay, Chromecast). What makes it different is that nobody
//! here is running our software: a UPnP MediaRenderer is a speaker, an AV
//! receiver or a TV that speaks a 2008 SOAP protocol and will fetch a URL if
//! you hand it one.
//!
//! **Why the hub and not the app.** Discovery is a UDP multicast to
//! 239.255.255.250, which only reaches speakers on the same network - so the
//! machine doing the looking has to be on that network. Doing it in the app
//! would work on a Mac and on Android and never on an iPhone, because Apple
//! puts multicast behind an entitlement you have to apply for. Doing it in the
//! hub costs the phone nothing: it asks a server it is already talking to, and
//! an iPhone reaches a kitchen speaker the same way a laptop does. The
//! trade-off is honest and worth saying out loud - a hub on a VPS sees no
//! speakers at all, because it is not on your wifi. `GET /api/speakers` on such
//! a hub correctly returns an empty list rather than an error, and the app can
//! fall back to whatever the device itself can see.
//!
//! **What the speaker actually plays.** Not our audio - a URL. The hub hands it
//! `http://<the hub's address on this LAN>:<port>/api/stream/<id>?t=<token>`
//! and the speaker fetches it directly, so the bytes go straight from the hub
//! to the speaker and never through the phone that pressed play. That address
//! must be the LAN one; `AFM_PUBLIC_URL` is frequently a name only the internet
//! can resolve, and handing a speaker a URL it cannot reach fails silently
//! several seconds later, which is the worst way for this to fail.

use crate::auth;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;

/// Multicast address and port every UPnP device listens on.
const SSDP_ADDR: &str = "239.255.255.250:1900";
/// How long to keep listening for answers. SSDP is fire-and-collect: devices
/// answer at a random delay up to the MX we ask for, precisely so a hundred of
/// them do not reply in the same millisecond. MX 2 and a 3 second window gives
/// the slow ones room without making the caller wait on a spinner.
const SEARCH_MX: u8 = 2;
const SEARCH_WINDOW: Duration = Duration::from_millis(3000);
/// How long a scan's results stand before the next request re-scans. Speakers
/// do not come and go by the second, and a rescan is three seconds of waiting.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// A renderer we have found and can talk to.
#[derive(Clone, Serialize)]
pub struct Renderer {
    /// The device's UDN (`uuid:...`), stable across reboots - our id for it.
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Absolute URL of the AVTransport control endpoint (play/pause/seek).
    #[serde(skip)]
    pub av_control: String,
    /// Absolute URL of the RenderingControl endpoint (volume). Not every
    /// renderer has one - a fixed-output streamer legitimately does not.
    #[serde(skip)]
    pub rc_control: Option<String>,
    /// True when the device also advertises RenderingControl, so the app knows
    /// whether to draw a volume slider it can actually move.
    pub volume: bool,
}

#[derive(Default)]
pub struct DlnaState {
    inner: tokio::sync::Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    found: HashMap<String, Renderer>,
    /// Speakers someone typed in rather than the search finding them. Kept
    /// apart so a re-scan that cannot see them does not delete them.
    manual: HashMap<String, Renderer>,
    scanned_at: Option<Instant>,
}

impl DlnaState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

// --- SSDP --------------------------------------------------------------------

/// Which of this machine's addresses a speaker would see us at.
///
/// Asked of the routing table rather than by listing interfaces: connecting a
/// UDP socket sends nothing, but it makes the kernel pick the interface it
/// would really use to reach that address, and `local_addr` then reports it.
/// That is the answer we want - the address on the network the speakers are on
/// - and it costs one syscall with no packets and no guessing about which of
/// `en0`, a VPN and a bridge is the real one.
async fn lan_address() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind(("0.0.0.0", 0)).await.ok()?;
    sock.connect(SSDP_ADDR).await.ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(v4),
        _ => None,
    }
}

/// Ask the network who can play music, and return every distinct LOCATION.
async fn search() -> Vec<String> {
    let Ok(sock) = UdpSocket::bind(("0.0.0.0", 0)).await else {
        return Vec::new();
    };
    let target: SocketAddr = match SSDP_ADDR.parse() {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };

    // Two searches, not one. `MediaRenderer` is the device type we want, but a
    // few streamers only answer `ssdp:all` or advertise the SERVICE without the
    // device - asking twice costs one datagram and finds those.
    for st in [
        "urn:schemas-upnp-org:device:MediaRenderer:1",
        "urn:schemas-upnp-org:service:AVTransport:1",
    ] {
        let msg = format!(
            "M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_ADDR}\r\nMAN: \"ssdp:discover\"\r\nMX: {SEARCH_MX}\r\nST: {st}\r\n\r\n"
        );
        let _ = sock.send_to(msg.as_bytes(), target).await;
    }

    let mut locations: Vec<String> = Vec::new();
    let deadline = Instant::now() + SEARCH_WINDOW;
    let mut buf = vec![0u8; 2048];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let Ok(Ok((n, _from))) = tokio::time::timeout(left, sock.recv_from(&mut buf)).await else {
            break;
        };
        let text = String::from_utf8_lossy(&buf[..n]);
        if let Some(loc) = header(&text, "LOCATION") {
            if !locations.iter().any(|l| l == &loc) {
                locations.push(loc);
            }
        }
    }
    locations
}

/// One header out of an SSDP response. Case-insensitive: the field names are
/// specified in capitals and sent in every casing there is.
fn header(response: &str, name: &str) -> Option<String> {
    let want = name.to_ascii_lowercase();
    response.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim().to_ascii_lowercase() == want).then(|| value.trim().to_string())
    })
}

// --- the device description --------------------------------------------------

/// The text of the first `<tag>` in some XML. UPnP descriptions are shallow,
/// machine-written and only ever read for a handful of leaves, so a scanner is
/// the right size of tool - and it keeps a whole XML crate out of a binary that
/// is cross-compiled for the server box.
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(unescape(xml[start..end].trim()))
}

/// The five entities XML guarantees. Speaker names really do contain `&`.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `http://10.0.0.7:8080/desc.xml` + `/ctrl/AVTransport` -> the absolute URL.
/// controlURL is allowed to be absolute, root-relative or relative, and
/// renderers use all three.
fn absolute(location: &str, control: &str) -> Option<String> {
    if control.starts_with("http://") || control.starts_with("https://") {
        return Some(control.to_string());
    }
    let scheme_end = location.find("://")? + 3;
    let host_end = location[scheme_end..]
        .find('/')
        .map(|i| scheme_end + i)
        .unwrap_or(location.len());
    let origin = &location[..host_end];
    if control.starts_with('/') {
        Some(format!("{origin}{control}"))
    } else {
        let dir = location[..location.rfind('/').unwrap_or(host_end)].to_string();
        Some(format!("{dir}/{control}"))
    }
}

/// The control URL of the service whose type contains `kind`.
fn service_control(xml: &str, kind: &str, location: &str) -> Option<String> {
    for block in xml.split("<service>").skip(1) {
        let block = block.split("</service>").next().unwrap_or(block);
        let ty = tag_text(block, "serviceType").unwrap_or_default();
        if ty.contains(kind) {
            let url = tag_text(block, "controlURL")?;
            return absolute(location, &url);
        }
    }
    None
}

/// Fetch and read one device description. Returns None for anything that is
/// not a renderer we can drive - a router advertising itself over SSDP is the
/// common case, and there is nothing wrong with it.
async fn describe(client: &reqwest::Client, location: &str) -> Option<Renderer> {
    let xml = client
        .get(location)
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let av_control = service_control(&xml, "AVTransport", location)?;
    let rc_control = service_control(&xml, "RenderingControl", location);
    let name = tag_text(&xml, "friendlyName").unwrap_or_else(|| "Speaker".into());
    // No UDN is legal-ish and useless to us: without a stable id the same
    // speaker would be a new device on every scan. The location is a decent
    // stand-in - it only changes when the device's address does.
    let id = tag_text(&xml, "UDN").unwrap_or_else(|| location.to_string());
    Some(Renderer {
        id,
        name,
        model: tag_text(&xml, "modelName"),
        av_control,
        volume: rc_control.is_some(),
        rc_control,
    })
}

// --- SOAP --------------------------------------------------------------------

/// One SOAP call. `service` is the short name (`AVTransport`), `action` the
/// verb, `args` the already-built inner XML.
async fn soap(
    client: &reqwest::Client,
    control: &str,
    service: &str,
    action: &str,
    args: &str,
) -> Option<String> {
    let urn = format!("urn:schemas-upnp-org:service:{service}:1");
    let body = format!(
        r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="{urn}"><InstanceID>0</InstanceID>{args}</u:{action}></s:Body></s:Envelope>"#
    );
    let res = client
        .post(control)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPACTION", format!("\"{urn}#{action}\""))
        .timeout(Duration::from_secs(6))
        .body(body)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.text().await.ok()
}

/// The scrap of DIDL-Lite that makes a speaker show a title instead of a URL.
/// Optional by the letter of the spec and load-bearing in practice: several
/// renderers refuse a SetAVTransportURI with empty metadata.
fn didl(title: &str, artist: &str, url: &str) -> String {
    let item = format!(
        r#"<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>{}</dc:title><upnp:artist>{}</upnp:artist><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:audio/mpeg:*">{}</res></item></DIDL-Lite>"#,
        escape(title),
        escape(artist),
        escape(url)
    );
    escape(&item)
}

/// `0:03:17` -> milliseconds. UPnP times are always this shape.
fn hms_to_ms(s: &str) -> Option<i64> {
    let mut parts = s.trim().split(':');
    let h: i64 = parts.next()?.trim().parse().ok()?;
    let m: i64 = parts.next()?.trim().parse().ok()?;
    // Seconds may carry a fraction, which we do not need but must not choke on.
    let sec_field = parts.next()?;
    let sec: f64 = sec_field.trim().parse().ok()?;
    Some(((h * 3600 + m * 60) as f64 + sec) as i64 * 1000)
}

/// Milliseconds -> `0:03:17`, the only format a renderer accepts for Seek.
fn ms_to_hms(ms: i64) -> String {
    let total = (ms.max(0) / 1000) as u64;
    format!("{}:{:02}:{:02}", total / 3600, (total / 60) % 60, total % 60)
}

// --- the cache ---------------------------------------------------------------

async fn renderers(state: &Arc<AppState>, force: bool) -> Vec<Renderer> {
    let mut cache = state.dlna.inner.lock().await;
    let fresh = cache
        .scanned_at
        .map(|at| at.elapsed() < CACHE_TTL)
        .unwrap_or(false);
    if fresh && !force && !cache.found.is_empty() {
        let mut list: Vec<Renderer> = cache.found.values().cloned().collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        return list;
    }

    let client = reqwest::Client::new();
    let mut found: HashMap<String, Renderer> = HashMap::new();
    for location in search().await {
        if let Some(r) = describe(&client, &location).await {
            found.insert(r.id.clone(), r);
        }
    }
    cache.found = found;
    // Hand-added speakers survive every scan, and lose to a device of the same
    // id that actually answered - that one's control URLs are certainly current.
    let manual = cache.manual.clone();
    for (id, r) in manual {
        cache.found.entry(id).or_insert(r);
    }
    cache.scanned_at = Some(Instant::now());
    let mut list: Vec<Renderer> = cache.found.values().cloned().collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

async fn one(state: &Arc<AppState>, id: &str) -> Option<Renderer> {
    if let Some(r) = state.dlna.inner.lock().await.found.get(id) {
        return Some(r.clone());
    }
    renderers(state, true).await.into_iter().find(|r| r.id == id)
}

// --- routes ------------------------------------------------------------------

/// `GET /api/speakers` - what this hub can see on its own network.
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    auth::require_caller(&state.db, &headers)?;
    let list = renderers(&state, false).await;
    // `reachable` says whether this hub is even in a position to see speakers,
    // so the app can tell "none on your network" from "this hub is in a data
    // centre" - two very different things to put in front of a person.
    Ok(Json(
        json!({ "speakers": list, "reachable": lan_address().await.is_some() }),
    ))
}

/// `POST /api/speakers/rescan` - look again now.
pub async fn rescan(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    auth::require_caller(&state.db, &headers)?;
    let list = renderers(&state, true).await;
    Ok(Json(json!({ "speakers": list })))
}

#[derive(Deserialize)]
pub struct AddBody {
    /// The device description URL, e.g. `http://10.0.0.7:49152/desc.xml`.
    pub location: String,
}

/// `POST /api/speakers/add` - name a speaker the search cannot find.
///
/// Discovery is a multicast, and multicast is the first thing a network eats:
/// a guest VLAN, an access point with IGMP snooping set wrong, a hub inside
/// Docker with a bridge network, a Mac that has not been granted local network
/// access. In every one of those the speaker is perfectly reachable over HTTP
/// and simply never answers the search. Rather than leave that person with an
/// empty list and no recourse, let them paste the address - the same
/// description URL discovery would have found - and keep it beside the ones
/// that answered.
pub async fn add(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AddBody>,
) -> Result<Json<Value>, StatusCode> {
    auth::require_caller(&state.db, &headers)?;
    if !body.location.starts_with("http://") && !body.location.starts_with("https://") {
        return Err(StatusCode::BAD_REQUEST);
    }
    let client = reqwest::Client::new();
    let Some(r) = describe(&client, &body.location).await else {
        // Reached and read, but it cannot play anything - or could not be read
        // at all. Either way it is not a speaker, and saying so beats adding a
        // row that will never work.
        return Err(StatusCode::BAD_REQUEST);
    };
    let mut cache = state.dlna.inner.lock().await;
    cache.found.insert(r.id.clone(), r.clone());
    // A hand-added speaker must not be swept away by the next search that does
    // not see it, so the scan stamp is left alone: `renderers` only replaces
    // the map when it actually re-scans, and a re-scan that finds nothing on a
    // network with no multicast would otherwise erase this.
    cache.manual.insert(r.id.clone(), r.clone());
    Ok(Json(json!({ "speaker": r })))
}

#[derive(Deserialize)]
pub struct PlayBody {
    #[serde(rename = "trackId")]
    pub track_id: i64,
}

/// `POST /api/speakers/{id}/play` - put a song on that speaker.
pub async fn play(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PlayBody>,
) -> Result<Json<Value>, StatusCode> {
    let caller = auth::require_caller(&state.db, &headers)?;
    let Some(r) = one(&state, &id).await else {
        return Err(StatusCode::NOT_FOUND);
    };
    let Some(track) = state.db.track(body.track_id) else {
        return Err(StatusCode::NOT_FOUND);
    };
    // The address the SPEAKER can reach, which is not the one the phone used to
    // get here. See the note at the top of the file.
    let Some(ip) = lan_address().await else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    // The speaker fetches the audio itself, so it needs a credential of its
    // own: the same short-lived stream token the app's own <audio> uses.
    let Some(account) = state.db.user_by_id(caller.id) else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let token = auth::mint_stream_token(&state.stream_secret, account.id, account.stream_epoch);
    let url = format!(
        "http://{ip}:{}/api/stream/{}?t={}",
        state.port, body.track_id, token
    );
    let meta = didl(&track.title, &track.artist, &url);
    let client = reqwest::Client::new();
    let set = soap(
        &client,
        &r.av_control,
        "AVTransport",
        "SetAVTransportURI",
        &format!("<CurrentURI>{}</CurrentURI><CurrentURIMetaData>{meta}</CurrentURIMetaData>", escape(&url)),
    )
    .await;
    if set.is_none() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let played = soap(
        &client,
        &r.av_control,
        "AVTransport",
        "Play",
        "<Speed>1</Speed>",
    )
    .await;
    if played.is_none() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    Ok(Json(json!({ "ok": true, "speaker": r.name, "url": url })))
}

#[derive(Deserialize)]
pub struct TransportBody {
    /// play | pause | stop
    pub action: String,
}

/// `POST /api/speakers/{id}/transport` - pause, resume or stop what is on it.
pub async fn transport(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<TransportBody>,
) -> Result<Json<Value>, StatusCode> {
    auth::require_caller(&state.db, &headers)?;
    let Some(r) = one(&state, &id).await else {
        return Err(StatusCode::NOT_FOUND);
    };
    let (action, args) = match body.action.as_str() {
        "play" => ("Play", "<Speed>1</Speed>"),
        "pause" => ("Pause", ""),
        "stop" => ("Stop", ""),
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    let client = reqwest::Client::new();
    match soap(&client, &r.av_control, "AVTransport", action, args).await {
        Some(_) => Ok(Json(json!({ "ok": true }))),
        None => Err(StatusCode::BAD_GATEWAY),
    }
}

#[derive(Deserialize)]
pub struct SeekBody {
    #[serde(rename = "positionMs")]
    pub position_ms: i64,
}

/// `POST /api/speakers/{id}/seek`
pub async fn seek(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<SeekBody>,
) -> Result<Json<Value>, StatusCode> {
    auth::require_caller(&state.db, &headers)?;
    let Some(r) = one(&state, &id).await else {
        return Err(StatusCode::NOT_FOUND);
    };
    let client = reqwest::Client::new();
    let args = format!(
        "<Unit>REL_TIME</Unit><Target>{}</Target>",
        ms_to_hms(body.position_ms)
    );
    match soap(&client, &r.av_control, "AVTransport", "Seek", &args).await {
        Some(_) => Ok(Json(json!({ "ok": true }))),
        None => Err(StatusCode::BAD_GATEWAY),
    }
}

#[derive(Deserialize)]
pub struct VolumeBody {
    /// 0.0 - 1.0, the same shape the player uses everywhere else.
    pub volume: f64,
}

/// `POST /api/speakers/{id}/volume`
pub async fn volume(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<VolumeBody>,
) -> Result<Json<Value>, StatusCode> {
    auth::require_caller(&state.db, &headers)?;
    let Some(r) = one(&state, &id).await else {
        return Err(StatusCode::NOT_FOUND);
    };
    let Some(rc) = r.rc_control.clone() else {
        return Err(StatusCode::NOT_IMPLEMENTED);
    };
    let level = (body.volume.clamp(0.0, 1.0) * 100.0).round() as i64;
    let args = format!("<Channel>Master</Channel><DesiredVolume>{level}</DesiredVolume>");
    let client = reqwest::Client::new();
    match soap(&client, &rc, "RenderingControl", "SetVolume", &args).await {
        Some(_) => Ok(Json(json!({ "ok": true }))),
        None => Err(StatusCode::BAD_GATEWAY),
    }
}

/// `GET /api/speakers/{id}/state` - what the speaker says it is doing.
pub async fn speaker_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    auth::require_caller(&state.db, &headers)?;
    let Some(r) = one(&state, &id).await else {
        return Err(StatusCode::NOT_FOUND);
    };
    let client = reqwest::Client::new();
    let info = soap(
        &client,
        &r.av_control,
        "AVTransport",
        "GetPositionInfo",
        "",
    )
    .await;
    let transport = soap(
        &client,
        &r.av_control,
        "AVTransport",
        "GetTransportInfo",
        "",
    )
    .await;
    let position_ms = info
        .as_deref()
        .and_then(|x| tag_text(x, "RelTime"))
        .and_then(|t| hms_to_ms(&t));
    let duration_ms = info
        .as_deref()
        .and_then(|x| tag_text(x, "TrackDuration"))
        .and_then(|t| hms_to_ms(&t));
    let status = transport
        .as_deref()
        .and_then(|x| tag_text(x, "CurrentTransportState"));
    Ok(Json(json!({
        "positionMs": position_ms,
        "durationMs": duration_ms,
        "playing": status.as_deref() == Some("PLAYING"),
        "state": status,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DESC: &str = r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<friendlyName>Kitchen &amp; Hall</friendlyName>
<modelName>WiiM Pro</modelName>
<UDN>uuid:1234-abcd</UDN>
<serviceList>
  <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/ctrl/rc</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>AVTransport/ctrl</controlURL></service>
</serviceList></device></root>"#;

    #[test]
    fn reads_a_device_description() {
        assert_eq!(tag_text(DESC, "friendlyName").unwrap(), "Kitchen & Hall");
        assert_eq!(tag_text(DESC, "UDN").unwrap(), "uuid:1234-abcd");
    }

    #[test]
    fn resolves_all_three_shapes_of_control_url() {
        let loc = "http://10.0.0.7:49152/desc.xml";
        // Root-relative.
        assert_eq!(
            service_control(DESC, "RenderingControl", loc).unwrap(),
            "http://10.0.0.7:49152/ctrl/rc"
        );
        // Relative to the description's own directory.
        assert_eq!(
            service_control(DESC, "AVTransport", loc).unwrap(),
            "http://10.0.0.7:49152/AVTransport/ctrl"
        );
        // Already absolute.
        assert_eq!(
            absolute(loc, "http://elsewhere/x").unwrap(),
            "http://elsewhere/x"
        );
    }

    #[test]
    fn a_device_that_cannot_play_is_not_a_speaker() {
        let router = "<root><device><friendlyName>Router</friendlyName></device></root>";
        assert!(service_control(router, "AVTransport", "http://x/y.xml").is_none());
    }

    #[test]
    fn upnp_times_round_trip() {
        assert_eq!(hms_to_ms("0:03:17").unwrap(), 197_000);
        assert_eq!(hms_to_ms("0:00:00.000").unwrap(), 0);
        assert_eq!(hms_to_ms("1:02:03").unwrap(), 3_723_000);
        assert_eq!(ms_to_hms(197_000), "0:03:17");
        assert_eq!(ms_to_hms(3_723_000), "1:02:03");
        // A renderer with nothing loaded answers NOT_IMPLEMENTED, not a time.
        assert!(hms_to_ms("NOT_IMPLEMENTED").is_none());
    }

    #[test]
    fn ssdp_headers_are_case_insensitive() {
        let res = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nlocation: http://10.0.0.7:49152/d.xml\r\n\r\n";
        assert_eq!(
            header(res, "LOCATION").unwrap(),
            "http://10.0.0.7:49152/d.xml"
        );
    }
}
