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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// How long a "this song has no Canvas" answer stands before it is worth
/// asking again. An artist who puts a Canvas on a back-catalogue track should
/// be found eventually; asking every boot is what this replaced.
pub const MISS_RETRY_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Per-track memory of what Spotify answered: `Some(url)` for a clip, `None`
/// for "asked, there is none". Cleared on restart - the durable half is the
/// sidecar for a hit and `canvas_misses` for a no.
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
        /*
         * A known miss, remembered across restarts. Answered without touching
         * Spotify at all - which is the whole point of writing them down - and
         * re-asked only once the sweep's retry window has passed.
         */
        if state
            .db
            .canvas_miss_age(id, crate::db::now_ms())
            .is_some_and(|age| age < MISS_RETRY_MS)
        {
            return Ok(Json(json!({ "url": stock_or_nothing(Some(id), title, artist) })));
        }
    }

    /*
     * THROUGH THE SETTINGS OVERLAY, not straight off the environment.
     *
     * This read `std::env::var` directly, which is the one shape that cannot
     * survive the box being rebuilt: the cookie lives in whatever launched the
     * process, so a re-install, a move to another machine, or an install script
     * that never asked for it leaves the server permanently cookie-less - and
     * silently, because a missing cookie is indistinguishable from a song with
     * no Canvas. Every card in the library quietly fell back to a stand-in.
     *
     * `ai::setting` resolves the owner's saved value first and the environment
     * second, which is the same door every other operator knob already uses, so
     * the cookie can be set from the app and is carried by the database rather
     * than by a shell.
     */
    let sp_dc = crate::ai::setting("spotifyCookie", "AFM_SPOTIFY_SP_DC").unwrap_or_default();
    if sp_dc.is_empty() || title.is_empty() {
        return Ok(Json(json!({ "url": stock_or_nothing(q.track_id, title, artist) })));
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
    if let (Answer::Found(url), Some(id)) = (&remote, q.track_id) {
        if let Some(dest) = sidecar_for(&state, id) {
            if store_canvas(url, &dest).await {
                let _ = state.db.clear_canvas_miss(id);
                state.canvas.put(key, Some(media_path(id)));
                return Ok(Json(json!({ "url": media_path(id) })));
            }
        }
    }

    // Spotify answered "no such clip". Written DOWN, not just held in memory: a
    // miss that only lived until the next restart meant the whole canvas-less
    // half of a library was looked up again on every boot.
    //
    // ONLY on Absent. An Unknown - a rate limit, a dead cookie, a timeout - is
    // not a fact about this track, and recording it as one hid the clip for
    // thirty days over a bad minute.
    let unknown = matches!(remote, Answer::Unknown);
    if matches!(remote, Answer::Absent) {
        if let Some(id) = q.track_id {
            let _ = state.db.mark_canvas_miss(id);
        }
    }
    let found = match remote {
        Answer::Found(url) => Some(url),
        _ => None,
    };
    let answer = found.or_else(|| stock_or_nothing(q.track_id, title, artist));
    // An Unknown is not held in memory either. The map is there to stop a
    // canvas-less song being looked up on every open; caching a shrug instead
    // means one failed minute silently lasts until the next restart.
    if !unknown {
        state.canvas.put(key, answer.clone());
    }
    Ok(Json(json!({ "url": answer })))
}


/*
 * THE STAND-IN IS OFF UNLESS ASKED FOR.
 *
 * A song with no Canvas used to get one of five shipped loops - a turntable, a
 * metronome - chosen by hash. The intent was that an unconfigured server show
 * something rather than a black wall, and on a screen that is only ever a
 * Canvas that is right. On the Date deck it is not: the card's face is the
 * COVER, and a generic clip fading in over it a second later replaces the one
 * thing on the card that is actually about this record with a video that is
 * about nothing. Matt, on seeing it: "I don't want that."
 *
 * So the fallback became a choice, and the default is the cover. A server that
 * wants the loops - the App-Review box, which has no cookie and would otherwise
 * show covers alone - turns `canvasStock` on, or sets AFM_CANVAS_STOCK=1.
 */
fn stock_or_nothing(track_id: Option<i64>, title: &str, artist: &str) -> Option<String> {
    if !crate::ai::setting("canvasStock", "AFM_CANVAS_STOCK")
        .is_some_and(|v| v != "false" && v != "0")
    {
        return None;
    }
    Some(stock_canvas(track_id, title, artist))
}

/*
 * THE RE-CACHE SWEEP.
 *
 * Canvases used to arrive only when a card asked for one, which meant the first
 * sight of every song was a cover with a clip landing on top of it a second
 * later - and after a restart, or a move to another box, every song was a first
 * sight again. This walks the library in the background and fetches them ahead
 * of being asked, so the deck finds the clip already beside the song.
 *
 * SLOWLY, and most-recently-played first. Spotify is being asked one search per
 * track by a cookie belonging to a real account; a library of six thousand
 * songs swept as fast as the network allows is how that cookie stops working.
 * The pace below is a few hundred an hour, which clears a big library in a day
 * of uptime and is indistinguishable from somebody using the web player.
 */
static SWEEPING: AtomicBool = AtomicBool::new(false);

/// Between two Spotify lookups. Deliberately unhurried - see above.
const SWEEP_GAP: std::time::Duration = std::time::Duration::from_secs(9);

/// How many to take in one pass before going back to sleep, so a sweep started
/// at boot cannot run forever holding the flag.
const SWEEP_BATCH: i64 = 400;

pub async fn sweep(state: Arc<AppState>) {
    if SWEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    sweep_inner(&state).await;
    SWEEPING.store(false, Ordering::SeqCst);
}

async fn sweep_inner(state: &Arc<AppState>) {
    let sp_dc = crate::ai::setting("spotifyCookie", "AFM_SPOTIFY_SP_DC").unwrap_or_default();
    if sp_dc.is_empty() {
        // Nothing to do, and nothing to complain about: a server with no cookie
        // is a server whose owner has not linked Spotify.
        return;
    }
    /*
     * ONE-TIME AMNESTY.
     *
     * Every miss on disk before this build was recorded by logic that could not
     * tell "Spotify says this track has no Canvas" from "we never got to ask" -
     * a 429, a dead cookie, a twelve-second timeout over a cold secret fetch.
     * They are not data about the library, they are a log of bad minutes, and
     * each one stands for thirty days.
     *
     * So they are forgotten once, and the sweep re-asks with a pipeline that
     * now knows the difference. Genuine noes cost one lookup each to relearn
     * and are then written down properly; the false ones - however many there
     * were - come back as clips. Marked in `meta` so it happens on this upgrade
     * and never again.
     */
    if state.db.meta_get("canvas.miss_amnesty").is_none() {
        let forgotten = state.db.forget_canvas_misses().unwrap_or(0);
        let _ = state.db.meta_set("canvas.miss_amnesty", "1");
        if forgotten > 0 {
            println!("[canvas] forgot {forgotten} recorded misses so they can be re-asked");
        }
    }

    let wanted = state.db.tracks_wanting_canvas(SWEEP_BATCH, MISS_RETRY_MS);
    if wanted.is_empty() {
        return;
    }
    let mut got = 0usize;
    let mut asked = 0usize;
    for (id, title, artist) in wanted {
        // The file is the truth: a clip already beside the song needs nothing,
        // and this is also how a sweep resumed after a restart skips its own
        // earlier work without keeping a cursor.
        if sidecar_for(state, id).is_some_and(|p| p.exists()) {
            continue;
        }
        if title.trim().is_empty() || artist.trim().is_empty() {
            continue;
        }
        asked += 1;
        match fetch_canvas(&sp_dc, &title, &artist, state).await {
            Answer::Found(url) => {
                if let Some(dest) = sidecar_for(state, id) {
                    if store_canvas(&url, &dest).await {
                        let _ = state.db.clear_canvas_miss(id);
                        got += 1;
                    }
                }
            }
            Answer::Absent => {
                let _ = state.db.mark_canvas_miss(id);
            }
            /*
             * Learned nothing, so record nothing and try this one again later.
             *
             * This is the case that mattered most here. The sweep asks Spotify
             * a few hundred times an hour on one cookie, which is exactly the
             * traffic that earns a 429 - and every 429 used to be filed as
             * "this song has no Canvas" for thirty days. A rate limit could
             * therefore erase a month of clips across whatever the sweep
             * happened to be walking at the time, and the faster it swept the
             * more it erased.
             */
            Answer::Unknown => {}
        }
        tokio::time::sleep(SWEEP_GAP).await;
    }
    if asked > 0 {
        println!("[canvas] swept {asked} tracks, kept {got} clips");
    }
}

/// `POST /api/canvas/resweep` - forget every recorded miss and go again.
///
/// The one button for "these stopped working": a cookie that had expired, a
/// library that moved, or simply a suspicion that more of them exist now. It
/// does NOT delete the clips already kept - those are the good outcome - only
/// the noes, which are the answers worth re-asking.
pub async fn resweep(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_admin(&state.db, &headers)
        .map_err(|s| (s, "only an admin can do that".into()))?;
    let forgotten = state.db.forget_canvas_misses().unwrap_or(0);
    let st = state.clone();
    tokio::spawn(async move { sweep(st).await });
    Ok(Json(json!({ "started": true, "forgotten": forgotten })))
}

/// The stock loop for a song no Canvas exists for: one of the shipped clips
/// under /api/assets/canvas, chosen by a stable hash so the same song wears
/// the same loop every open, on every device.
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
        None => format!("{}\u{0}{}", artist.to_lowercase(), title.to_lowercase()),
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

/// Up to `n` tracks with a clip stored beside them, drawn at random. There is
/// no record of which tracks HAVE a clip - the sidecar is the record - so a
/// random handful of the library is asked; a library with clips on a tenth
/// of its songs answers from a few hundred stats, which is nothing.
pub fn sample_sidecars(state: &AppState, n: usize) -> Vec<i64> {
    state
        .db
        .random_track_ids(600)
        .into_iter()
        .filter(|id| sidecar_for(state, *id).is_some_and(|p| p.is_file()))
        .take(n)
        .collect()
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
    serve_media(&state, id, request).await
}

/// The clip response itself, for a caller already admitted - `media` above
/// for a member, `wall::canvas_clip` for a public URL this server signed.
pub async fn serve_media(
    state: &AppState,
    id: i64,
    request: axum::extract::Request<axum::body::Body>,
) -> Result<axum::response::Response, StatusCode> {
    let path = sidecar_for(state, id).ok_or(StatusCode::NOT_FOUND)?;
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
/// What Spotify actually said, which is not the same question as "did we get a
/// URL".
///
/// Everything used to collapse into `None`: a track with no clip, a 429 from a
/// search endpoint the sweep asks a few hundred times an hour, an expired
/// cookie, a twelve-second timeout over a cold secret extraction, a missing
/// python3. The caller then wrote every one of them down as `canvas_miss`,
/// which suppresses that track for THIRTY DAYS - so one bad minute cost a month
/// of clips, and the library quietly ratcheted towards having none.
#[derive(Debug)]
pub enum Answer {
    Found(String),
    /// Spotify answered, and this recording has no Canvas. Worth remembering.
    Absent,
    /// We never got an answer. Nothing was learned, so nothing is recorded.
    Unknown,
}

async fn fetch_canvas(sp_dc: &str, title: &str, artist: &str, state: &AppState) -> Answer {
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

    let Ok(mut child) = tokio::process::Command::new(py)
        .arg("-c")
        .arg(CANVAS_PY)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        // No python3 on this box: every track would otherwise be recorded as
        // having no Canvas, one per play, for a month each.
        return Answer::Unknown;
    };

    use tokio::io::AsyncWriteExt;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(req.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    /*
     * Twenty seconds, up from twelve.
     *
     * The pipeline inside is four sequential Spotify round trips, and the first
     * one after the six-hour secret cache expires downloads a whole web-player
     * bundle to re-read the TOTP secret. Twelve seconds did not reliably cover
     * that, so the first ask after every expiry tended to time out - and a
     * timeout was written down as "this song has no Canvas" for a month. The
     * clip is not urgent (the cover is already on screen and the sweep fetches
     * ahead of the ask), so waiting is far cheaper than mislearning.
     */
    let Ok(Ok(out)) = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        child.wait_with_output(),
    )
    .await
    else {
        return Answer::Unknown;
    };
    if !out.status.success() {
        return Answer::Unknown;
    }
    read_answer(&out.stdout)
}

/// The one decision this whole change turns on, kept separate so it can be
/// tested without a Spotify account: which of the three answers a line of the
/// script's output actually is.
fn read_answer(stdout: &[u8]) -> Answer {
    let Ok(parsed) = serde_json::from_slice::<Value>(stdout) else {
        return Answer::Unknown;
    };
    // Said plainly by the script: a reason means it never got to ask. Note that
    // a JSON null is NOT a reason - `as_str` declines it - which is what keeps
    // a genuine "no clip for this track" recordable.
    if parsed.get("error").and_then(|e| e.as_str()).is_some() {
        return Answer::Unknown;
    }
    match parsed
        .get("url")
        .and_then(|u| u.as_str())
        .filter(|u| u.starts_with("http"))
    {
        Some(u) => Answer::Found(u.to_string()),
        None => Answer::Absent,
    }
}

/// stdlib-only Python: extract secret -> mint logged-in token -> match track ->
/// read Canvas. Prints `{"url": ...}` and never raises.
const CANVAS_PY: &str = r#"
import sys, os, re, json, time, hmac, hashlib, struct, tempfile
import urllib.request, urllib.parse, urllib.error

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
CACHE = os.path.join(tempfile.gettempdir(), "afm_spotify_canvas.json")
CANVAS_HASH = "575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f"
# The web /v1/search API rate-limits this box's IP to a wall of 429s, so the
# track lookup rides the SAME pathfinder endpoint the canvas query does - not
# throttled, because it is the web player's own door. searchSuggestions lives
# in the stable main bundle (unlike searchDesktop, which stopped being served
# from the CDN); its hash is re-read from the bundle when Spotify rotates it.
SEARCH_HASH = "23f33ca50a0f4153dafc5cd1b4d1370db01b72130c2994bd0ffd07d5a7fee8f0"

def out(url, error=None):
    # `error` is the difference between "Spotify says this track has no Canvas"
    # and "we never got to ask". The caller writes the first one down for a
    # month; the second must not be recorded at all.
    print(json.dumps({"url": url, "error": error})); sys.exit(0)

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

def fold(x):
    return "".join(ch.lower() for ch in x if ch.isalnum())

def search_hash():
    # The searchSuggestions persisted-query hash, re-read from the web player's
    # main bundle so a Spotify rotation self-heals like the TOTP secret does.
    cache = load_cache()
    now = time.time()
    if cache.get("search_hash") and cache.get("search_hash_exp", 0) > now:
        return cache["search_hash"]
    h = SEARCH_HASH
    try:
        html = http("https://open.spotify.com/").read().decode("utf-8", "ignore")
        for b in set(re.findall(r"https://[a-z0-9.\-]+/[^\"'\s>]*web-player\.[^\"'\s>]*\.js", html)):
            js = http(b).read().decode("utf-8", "ignore")
            m = re.search(r"searchSuggestions[\s\S]{0,80}?([0-9a-f]{64})", js) or \
                re.search(r"([0-9a-f]{64})[\s\S]{0,80}?searchSuggestions", js)
            if m:
                h = m.group(1)
                break
    except Exception:
        pass
    cache.update(search_hash=h, search_hash_exp=now + 6 * 3600)
    save_cache(cache)
    return h

def collect_tracks(node, out):
    # Walk the searchSuggestions tree collecting (uri, name, [artist names])
    # for every track object, wherever Spotify has moved it to this week.
    if isinstance(node, dict):
        uri = node.get("uri")
        if isinstance(uri, str) and uri.startswith("spotify:track:"):
            name = node.get("name") or ""
            artists = []
            a = node.get("artists")
            if isinstance(a, dict):
                for it in a.get("items", []) or []:
                    pr = (it or {}).get("profile") or {}
                    if pr.get("name"):
                        artists.append(pr["name"])
            out.append((uri.split(":")[-1], name, artists))
        for v in node.values():
            collect_tracks(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_tracks(v, out)

def find_track(tok, title, artist):
    # Returns (track_id, error). Rides pathfinder, not the throttled /v1 API.
    q = "%s %s" % (title, artist)
    variables = urllib.parse.quote(json.dumps({"query": q, "limit": 15}))
    ext = urllib.parse.quote(json.dumps({"persistedQuery": {"version": 1, "sha256Hash": search_hash()}}))
    url = ("https://api-partner.spotify.com/pathfinder/v1/query"
           "?operationName=searchSuggestions&variables=%s&extensions=%s" % (variables, ext))
    try:
        d = json.load(http(url, headers={"User-Agent": UA, "Authorization": "Bearer " + tok,
                                          "App-Platform": "WebPlayer", "Accept": "application/json"}))
    except urllib.error.HTTPError as e:
        return None, "search http %d" % e.code
    except Exception as e:
        return None, "search %s" % type(e).__name__
    if isinstance(d, dict) and d.get("errors"):
        return None, "search query rejected"
    tracks = []
    collect_tracks(d.get("data") or {}, tracks)
    if not tracks:
        # Spotify answered and offered no track - a real "no such recording".
        return None, None
    tl, al = fold(title), fold(artist)
    for tid, name, artists in tracks:
        if fold(name) == tl and any(fold(a) == al for a in artists):
            return tid, None
    # Looser: the title matches and some artist token overlaps.
    for tid, name, artists in tracks:
        if fold(name) == tl:
            return tid, None
    # Fall back to the top track - search relevance usually has it first.
    return tracks[0][0], None

def get_canvas(tok, track_id):
    v = urllib.parse.quote(json.dumps({"trackUri": "spotify:track:" + track_id}))
    ext = urllib.parse.quote(json.dumps({"persistedQuery": {"version": 1, "sha256Hash": CANVAS_HASH}}))
    url = "https://api-partner.spotify.com/pathfinder/v1/query?operationName=canvas&variables=%s&extensions=%s" % (v, ext)
    try:
        d = json.load(http(url, headers={"User-Agent": UA, "Authorization": "Bearer " + tok, "App-Platform": "WebPlayer", "Accept": "application/json"}))
    except urllib.error.HTTPError as e:
        return None, "canvas http %d" % e.code
    except Exception as e:
        return None, "canvas %s" % type(e).__name__
    # A rejected persisted query answers 200 with an errors array, so it would
    # otherwise read as "this track has no clip" for every track at once.
    if isinstance(d, dict) and d.get("errors"):
        return None, "canvas query rejected"
    can = ((d.get("data") or {}).get("trackUnion") or {}).get("canvas") or {}
    for k in ("url", "uri"):
        u = can.get(k)
        if isinstance(u, str) and u.startswith("http"):
            return u, None
    # Spotify answered, and this track simply has no Canvas. The one answer
    # actually worth remembering.
    return None, None

def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
        sp_dc = req.get("sp_dc"); title = req.get("title"); artist = req.get("artist")
        if not sp_dc or not title: out(None, "not configured")
        tok = get_token(sp_dc)
        # No token means the cookie has expired or Spotify changed the mint.
        # Nothing was learned about this track, so nothing may be written down.
        if not tok: out(None, "no web token")
        # One token does both jobs now: search and canvas both ride the web
        # player's pathfinder, which does not rate-limit this box the way the
        # public /v1 API does.
        tid, err = find_track(tok, title, artist)
        if err: out(None, err)
        # Searched successfully and the catalogue has nothing: a real answer.
        if not tid: out(None)
        # The canvas query itself MUST use the web-player token; an ordinary
        # OAuth token is 403'd by pathfinder.
        url, err = get_canvas(tok, tid)
        out(url, err)
    except Exception as e:
        # An unexpected crash teaches nothing about the track either.
        out(None, "crashed: %s" % type(e).__name__)

main()
"#;

#[cfg(test)]
mod answers {
    use super::*;

    /// The distinction the thirty-day miss depends on. Before this, all four of
    /// these read as "this song has no Canvas".
    #[test]
    fn only_a_real_no_is_recorded_as_one() {
        assert!(matches!(
            read_answer(br#"{"url": "https://canvaz.scdn.co/x.mp4", "error": null}"#),
            Answer::Found(_)
        ));
        // Spotify answered, and there is no clip: worth writing down.
        assert!(matches!(
            read_answer(br#"{"url": null, "error": null}"#),
            Answer::Absent
        ));
        // The pipeline never got an answer. Nothing to write down.
        for excuse in [
            &br#"{"url": null, "error": "search http 429"}"#[..],
            &br#"{"url": null, "error": "no web token"}"#[..],
            &br#"{"url": null, "error": "canvas query rejected"}"#[..],
            &br#"{"url": null, "error": "crashed: URLError"}"#[..],
        ] {
            assert!(
                matches!(read_answer(excuse), Answer::Unknown),
                "a failure must never be filed as a fact: {}",
                String::from_utf8_lossy(excuse)
            );
        }
        // Garbage on stdout teaches nothing either.
        assert!(matches!(read_answer(b"not json"), Answer::Unknown));
    }

    /// A miss stands for a month, so the old shape hid a clip for thirty days
    /// every time Spotify was merely busy.
    #[test]
    fn a_miss_is_a_month() {
        assert_eq!(MISS_RETRY_MS, 30 * 24 * 60 * 60 * 1000);
    }
}
