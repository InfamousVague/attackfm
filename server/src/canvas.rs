//! Spotify Canvas: the short looping clip some tracks carry on the now-playing
//! screen. Spotify only serves it to a logged-in session, so this is inert
//! until `AFM_SPOTIFY_SP_DC` (the owner's Spotify `sp_dc` session cookie) is
//! set - which is exactly why the App-Review box, with no cookie, never shows
//! a frame of it.
//!
//! The fetch itself is a small, dependency-free Python one-shot (stdlib only,
//! any `python3`): it re-extracts Spotify's rotating TOTP secret from the live
//! web bundle, mints a web-player token with the cookie, matches the playing
//! track to a Spotify track, and reads the Canvas URL from the GraphQL query
//! the web player uses. The cookie travels on stdin, never an argv, so it is
//! not visible in the process list. Results are cached per track (hits and
//! misses alike) so a replay costs nothing.

use crate::auth;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Per-track memory of what Spotify answered: `Some(url)` for a clip, `None`
/// for "asked, there is none". Cleared on restart; canvases barely change.
#[derive(Default)]
pub struct CanvasCache {
    inner: Mutex<HashMap<String, Option<String>>>,
}
impl CanvasCache {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn get(&self, key: &str) -> Option<Option<String>> {
        self.inner.lock().unwrap().get(key).cloned()
    }
    fn put(&self, key: String, url: Option<String>) {
        self.inner.lock().unwrap().insert(key, url);
    }
}

#[derive(Deserialize)]
pub struct CanvasQuery {
    pub title: String,
    pub artist: String,
    /// Which library track this is, so the clip can be stored beside it.
    /// Absent for a local-only file, which simply gets the un-cached path.
    #[serde(default, rename = "trackId")]
    pub track_id: Option<i64>,
}

/// `GET /api/canvas?title=&artist=` - the Canvas URL for the playing track, or
/// `{ "url": null }` when there is none (or the feature is not configured).
pub async fn canvas(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<CanvasQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let title = q.title.trim();
    let artist = q.artist.trim();

    // A clip already kept beside its song answers without Spotify at all: no
    // token, no search, no rate limit, and it keeps working when the cookie
    // eventually expires. This is the common path after the first play.
    if let Some(id) = q.track_id {
        if sidecar_for(&state, id).is_some_and(|p| p.exists()) {
            return Ok(Json(json!({ "url": media_path(id) })));
        }
    }

    let sp_dc = std::env::var("AFM_SPOTIFY_SP_DC").unwrap_or_default();
    if sp_dc.is_empty() || title.is_empty() {
        // No cookie, no Spotify - but no black wall either.
        return Ok(Json(json!({ "url": stock_canvas(q.track_id, title, artist) })));
    }

    // The in-memory map still absorbs repeat asks for tracks that have NO clip
    // (and for the brief window before a download lands), so a canvas-less
    // song is looked up once per boot rather than once per open.
    let key = format!("{}\u{0}{}", artist.to_lowercase(), title.to_lowercase());
    if let Some(hit) = state.canvas.get(&key) {
        return Ok(Json(json!({ "url": hit })));
    }

    let remote = fetch_canvas(&sp_dc, title, artist, &state).await;

    // A hit gets kept: fetched once, then owned. Failure to store is not
    // failure to play - the Spotify URL still works for this listen.
    if let (Some(url), Some(id)) = (remote.as_deref(), q.track_id) {
        if let Some(dest) = sidecar_for(&state, id) {
            if store_canvas(url, &dest).await {
                state.canvas.put(key, Some(media_path(id)));
                return Ok(Json(json!({ "url": media_path(id) })));
            }
        }
    }

    // Spotify answered "no such clip": the stock loop stands in, and the
    // cache keeps that answer so a canvas-less song costs one lookup per
    // boot exactly as before.
    let answer = remote.or_else(|| Some(stock_canvas(q.track_id, title, artist)));
    state.canvas.put(key, answer.clone());
    Ok(Json(json!({ "url": answer })))
}


/// The stock loop for a song no Canvas exists for: one of the shipped clips
/// under /api/assets/canvas, chosen by a stable hash so the same song wears
/// the same loop every open, on every device. This is what an unconfigured
/// server (no sp_dc - the App-Review box) shows instead of a black wall,
/// and what every canvas-less track shows instead of nothing.
fn stock_canvas(track_id: Option<i64>, title: &str, artist: &str) -> String {
    const STOCK: [&str; 5] = [
        "glass-heart",
        "infinite-crate",
        "metronome",
        "ring-tunnel",
        "turntable",
    ];
    let seed = match track_id {
        Some(id) => id.to_string(),
        None => format!("{}\u{{0}}{}", artist.to_lowercase(), title.to_lowercase()),
    };
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in seed.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("/api/assets/canvas/{}.mp4", STOCK[(h % STOCK.len() as u64) as usize])
}

/// Where a track's clip lives: beside the audio, same stem, `.canvas.mp4`.
///
/// Deliberately a sidecar rather than a separate cache directory - the clip
/// belongs to the song, so moving, backing up or re-pointing the library
/// carries it along, and a track deleted by hand takes its clip with it.
/// `mp4` is not in the scanner's AUDIO_EXTENSIONS, so the walk steps over it.
fn sidecar_for(state: &AppState, track_id: i64) -> Option<std::path::PathBuf> {
    let rel = state.db.track_rel_path(track_id)?;
    let audio = crate::stream::resolve_in_root(&state.music_root, &rel)?;
    Some(audio.with_extension("canvas.mp4"))
}

/// What the client is handed: a path on THIS server, not Spotify's CDN.
fn media_path(track_id: i64) -> String {
    format!("/api/canvas/media/{track_id}")
}

/// Download the clip next to its song. Written to a temporary name and then
/// renamed, so a half-finished file can never be served as a whole one.
async fn store_canvas(url: &str, dest: &std::path::Path) -> bool {
    const MAX_BYTES: u64 = 32 * 1024 * 1024;
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    else {
        return false;
    };
    let Ok(response) = client.get(url).send().await else { return false };
    if !response.status().is_success() {
        return false;
    }
    if response.content_length().is_some_and(|n| n > MAX_BYTES) {
        return false;
    }
    let Ok(bytes) = response.bytes().await else { return false };
    if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
        return false;
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = dest.with_extension("mp4.part");
    if std::fs::write(&tmp, &bytes).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    std::fs::rename(&tmp, dest).is_ok()
}

/// `GET /api/canvas/media/{id}` - the stored clip, served from this server.
///
/// Takes the stream token from the query as well as a bearer header: a
/// `<video src>` cannot carry an Authorization header, which is the same
/// reason the art endpoint accepts both.
pub async fn media(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i64>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    request: axum::extract::Request<axum::body::Body>,
) -> Result<axum::response::Response, StatusCode> {
    crate::stream::caller_from_either(&state, &headers, &params)?;
    let path = sidecar_for(&state, id).ok_or(StatusCode::NOT_FOUND)?;
    if !path.exists() {
        return Err(StatusCode::NOT_FOUND);
    }
    use axum::response::IntoResponse;
    use tower::ServiceExt;
    let mut response = tower_http::services::ServeFile::new_with_mime(
        &path,
        &"video/mp4".parse().unwrap_or(mime_guess::mime::APPLICATION_OCTET_STREAM),
    )
    .oneshot(request)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_response();
    // The clip for a given track never changes once stored.
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "private, max-age=31536000, immutable".parse().unwrap(),
    );
    Ok(response)
}

/// Runs the Python one-shot, feeding the request (cookie included) on stdin.
/// Any failure is a quiet `None` - a missing clip must never break playback.
async fn fetch_canvas(
    sp_dc: &str,
    title: &str,
    artist: &str,
    state: &AppState,
) -> Option<String> {
    // The client secret is optional and only ever used for the track search.
    // Without it the lookup falls back to the web-player token, which is what
    // shipped before - so an unconfigured server is no worse off.
    let client_secret = std::env::var("AFM_SPOTIFY_CLIENT_SECRET").unwrap_or_default();
    let req = json!({
        "sp_dc": sp_dc,
        "title": title,
        "artist": artist,
        "client_id": state.spotify_client_id,
        "client_secret": client_secret,
    })
    .to_string();
    let py = std::env::var("AFM_CANVAS_PYTHON").unwrap_or_else(|_| "python3".to_string());

    let mut child = tokio::process::Command::new(py)
        .arg("-c")
        .arg(CANVAS_PY)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    use tokio::io::AsyncWriteExt;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(req.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(12), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let parsed: Value = serde_json::from_slice(&out.stdout).ok()?;
    parsed
        .get("url")
        .and_then(|u| u.as_str())
        .filter(|u| u.starts_with("http"))
        .map(|u| u.to_string())
}

/// stdlib-only Python: extract secret -> mint logged-in token -> match track ->
/// read Canvas. Prints `{"url": ...}` and never raises.
const CANVAS_PY: &str = r#"
import sys, os, re, json, time, hmac, hashlib, struct, tempfile
import urllib.request, urllib.parse, urllib.error

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
CACHE = os.path.join(tempfile.gettempdir(), "afm_spotify_canvas.json")
CANVAS_HASH = "575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f"

def out(url):
    print(json.dumps({"url": url})); sys.exit(0)

def http(url, headers=None, data=None):
    r = urllib.request.Request(url, data=data, headers=headers or {"User-Agent": UA})
    return urllib.request.urlopen(r, timeout=12)

def load_cache():
    try:
        with open(CACHE) as f: return json.load(f)
    except Exception:
        return {}

def save_cache(c):
    try:
        with open(CACHE, "w") as f: json.dump(c, f)
    except Exception:
        pass

def js_unescape(s):
    o = []; i = 0
    m = {"\\": "\\", "'": "'", '"': '"', "/": "/", "n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f"}
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            if n in m: o.append(m[n]); i += 2; continue
            if n == "x": o.append(chr(int(s[i+2:i+4], 16))); i += 4; continue
            if n == "u": o.append(chr(int(s[i+2:i+6], 16))); i += 6; continue
            o.append(n); i += 2; continue
        o.append(c); i += 1
    return "".join(o)

def extract_secret():
    # Re-read Spotify's own secret so this survives their rotations.
    html = http("https://open.spotify.com/").read().decode("utf-8", "ignore")
    bundles = re.findall(r"https://[a-z0-9.\-]+/[^\"'\s>]*web-player[^\"'\s>]*\.js", html)
    for b in bundles:
        try:
            js = http(b).read().decode("utf-8", "ignore")
        except Exception:
            continue
        m = re.search(r"secret:(['\"])((?:\\.|(?!\1).)*)\1,version:(\d+)", js)
        if m:
            return js_unescape(m.group(2)), int(m.group(3))
    return None, None

def totp(secret, ts):
    key = "".join(str(ord(ch) ^ ((i % 33) + 9)) for i, ch in enumerate(secret)).encode()
    counter = int(ts // 30)
    h = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return "%06d" % ((struct.unpack(">I", h[o:o+4])[0] & 0x7FFFFFFF) % 1000000)

def get_token(sp_dc):
    cache = load_cache()
    now = time.time()
    if cache.get("token") and cache.get("token_exp", 0) > now + 60:
        return cache["token"]
    secret, ver = cache.get("secret"), cache.get("version")
    if not secret or cache.get("secret_exp", 0) < now:
        secret, ver = extract_secret()
        if not secret: return None
        cache.update(secret=secret, version=ver, secret_exp=now + 6 * 3600)
    try:
        server_ts = int(json.load(http("https://open.spotify.com/api/server-time"))["serverTime"])
    except Exception:
        server_ts = int(now)
    code = totp(secret, server_ts)
    url = ("https://open.spotify.com/api/token?reason=init&productType=web-player"
           "&totp=%s&totpServer=%s&totpVer=%d" % (code, code, ver))
    try:
        d = json.load(http(url, headers={"User-Agent": UA, "Cookie": "sp_dc=" + sp_dc}))
    except Exception:
        return None
    tok = d.get("accessToken")
    if not tok: return None
    cache.update(token=tok, token_exp=d.get("accessTokenExpirationTimestampMs", 0) / 1000.0 or now + 1800)
    save_cache(cache)
    return tok

def api_token(client_id, client_secret):
    # A plain client-credentials token, for the SEARCH only.
    #
    # The web-player token is minted for open.spotify.com's own pathfinder
    # calls and is refused (429, "API rate limit exceeded") on the public
    # /v1 endpoints - measured, not guessed: the same search with an ordinary
    # token answered instantly while the web token was throttled every time.
    # So the two jobs get the two different tokens they each want.
    if not client_id or not client_secret:
        return None
    cache = load_cache()
    now = time.time()
    if cache.get("api_token") and cache.get("api_token_exp", 0) > now + 60:
        return cache["api_token"]
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }).encode()
    try:
        d = json.load(http("https://accounts.spotify.com/api/token",
                           headers={"User-Agent": UA,
                                    "Content-Type": "application/x-www-form-urlencoded"},
                           data=body))
    except Exception:
        return None
    tok = d.get("access_token")
    if not tok:
        return None
    cache.update(api_token=tok, api_token_exp=now + (d.get("expires_in") or 3600) - 60)
    save_cache(cache)
    return tok

def find_track(tok, title, artist):
    q = urllib.parse.quote('track:"%s" artist:"%s"' % (title, artist))
    url = "https://api.spotify.com/v1/search?q=%s&type=track&limit=5" % q
    try:
        d = json.load(http(url, headers={"User-Agent": UA, "Authorization": "Bearer " + tok}))
    except Exception:
        return None
    items = (d.get("tracks") or {}).get("items") or []
    tl, al = title.lower(), artist.lower()
    for it in items:
        if it.get("name", "").lower() == tl and any(a.get("name", "").lower() == al for a in it.get("artists", [])):
            return it.get("id")
    return items[0].get("id") if items else None

def get_canvas(tok, track_id):
    v = urllib.parse.quote(json.dumps({"trackUri": "spotify:track:" + track_id}))
    ext = urllib.parse.quote(json.dumps({"persistedQuery": {"version": 1, "sha256Hash": CANVAS_HASH}}))
    url = "https://api-partner.spotify.com/pathfinder/v1/query?operationName=canvas&variables=%s&extensions=%s" % (v, ext)
    try:
        d = json.load(http(url, headers={"User-Agent": UA, "Authorization": "Bearer " + tok, "App-Platform": "WebPlayer", "Accept": "application/json"}))
    except Exception:
        return None
    can = ((d.get("data") or {}).get("trackUnion") or {}).get("canvas") or {}
    for k in ("url", "uri"):
        u = can.get(k)
        if isinstance(u, str) and u.startswith("http"):
            return u
    return None

def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
        sp_dc = req.get("sp_dc"); title = req.get("title"); artist = req.get("artist")
        if not sp_dc or not title: out(None)
        tok = get_token(sp_dc)
        if not tok: out(None)
        # Look the track up with an ordinary API token when one is configured,
        # falling back to the web token so a server without a client secret
        # behaves exactly as it did before.
        search_tok = api_token(req.get("client_id"), req.get("client_secret")) or tok
        tid = find_track(search_tok, title, artist)
        if not tid and search_tok is not tok:
            tid = find_track(tok, title, artist)
        if not tid: out(None)
        # The canvas query itself MUST use the web-player token; an ordinary
        # OAuth token is 403'd by pathfinder.
        out(get_canvas(tok, tid))
    except Exception:
        out(None)

main()
"#;
