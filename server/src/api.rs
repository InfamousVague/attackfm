//! The JSON surface: accounts, the library delta, favourites, playlists, and
//! resume positions.
//!
//! Everything here is small and cacheable. The bytes that matter - audio and
//! cover art - are `stream.rs`'s business and never travel through a JSON
//! response.

use crate::auth;
use crate::scan;
use crate::upload::human_bytes;
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

fn bad(status: StatusCode, message: &str) -> ApiError {
    (status, message.to_string())
}

// --- the handshake --------------------------------------------------------

/// `GET /api/server` - the only endpoint that answers without a token.
///
/// It is how a client decides what screen to show before it has credentials:
/// an empty server needs its first account made, a set-up one needs a sign-in,
/// and a server without ffmpeg should not be offering a quality slider.
pub async fn server_info(State(state): State<Arc<AppState>>) -> ApiResult {
    Ok(Json(json!({
        "name": state.server_name,
        "version": env!("CARGO_PKG_VERSION"),
        "api": 1,
        // No users yet: whoever registers first becomes the admin.
        "needsSetup": state.db.user_count() == 0,
        "transcode": state.ffmpeg,
        "tracks": state.db.track_count(),
        /*
         * Whether this box downloads, said WITHOUT a sign-in.
         *
         * The app has to pick which of several servers runs an import, and
         * until now the only way to learn that a box had a downloader was
         * `/api/curator/pulls`, which needs a caller. So the picker offered
         * every server it knew equally, the default fell to whichever one you
         * happened to be signed into, and an import sent to a box with no
         * downloader failed after the round trip instead of never being sent
         * there. This is already public information in every practical sense -
         * it is what the box does with a link, not who may ask it - and the
         * probe that keeps the server list fresh reads it for free.
         */
        // What a PASTED LINK can expect, which is what the app is choosing
        // between. A box in collector mode still downloads - for itself - but
        // it will refuse a link, so advertising true would send every import
        // to a door that is shut.
        "imports": crate::imports::imports_mode() == crate::imports::ImportsMode::On
            && crate::imports::find_spotiflac().is_some(),
    })))
}

#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

/// `POST /api/auth/register`
///
/// Open only until the first account exists; after that it is an admin's call
/// who else gets in. A personal music server that stayed open to registration
/// would be a public music server by the end of the week.
pub async fn register(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Credentials>,
) -> ApiResult {
    let first = state.db.user_count() == 0;
    if !first {
        auth::require_admin(&state.db, &headers)
            .map_err(|_| bad(StatusCode::FORBIDDEN, "only an admin can add accounts"))?;
    }

    let username = body.username.trim().to_string();
    if username.len() < 2 || username.len() > 40 {
        return Err(bad(StatusCode::BAD_REQUEST, "username must be 2-40 characters"));
    }
    if body.password.len() < 8 {
        return Err(bad(StatusCode::BAD_REQUEST, "password must be at least 8 characters"));
    }
    if state.db.user_by_name(&username).is_some() {
        return Err(bad(StatusCode::CONFLICT, "that name is taken"));
    }

    let hash = auth::hash_password(&body.password)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let id = state
        .db
        .create_user(&username, &hash, first)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(json!({ "id": id, "username": username, "isAdmin": first })))
}

/// `POST /api/auth/login` - a session token plus the stream token that lets a
/// media element fetch bytes.
pub async fn login(State(state): State<Arc<AppState>>, Json(body): Json<Credentials>) -> ApiResult {
    let user = state
        .db
        .user_by_name(body.username.trim())
        .filter(|u| auth::verify_password(&body.password, &u.pass_hash))
        // One message for both halves: saying which of the two was wrong tells
        // an attacker which usernames exist.
        .ok_or_else(|| bad(StatusCode::UNAUTHORIZED, "wrong name or password"))?;

    let token = auth::random_token();
    state
        .db
        .create_token(&token, user.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let stream_token = auth::mint_stream_token(&state.stream_secret, user.id, user.stream_epoch);

    Ok(Json(json!({
        "token": token,
        "streamToken": stream_token,
        "streamTokenExpires": auth::STREAM_TOKEN_TTL_SECS,
        "user": { "id": user.id, "username": user.username, "isAdmin": user.is_admin },
    })))
}

/// `POST /api/auth/logout` - drops this device's session only.
pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    if let Some(token) = auth::bearer(&headers) {
        let _ = state.db.delete_token(&token);
    }
    Ok(Json(json!({ "ok": true })))
}

/// `GET /api/me` - who is calling, and a freshly minted stream token.
///
/// The client calls this when a stream URL starts coming back 401, which is how
/// an expired stream token renews itself without a re-login.
pub async fn me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let user = state
        .db
        .user_by_id(caller.id)
        .ok_or_else(|| bad(StatusCode::UNAUTHORIZED, "account is gone"))?;
    let stream_token = auth::mint_stream_token(&state.stream_secret, user.id, user.stream_epoch);
    Ok(Json(json!({
        "id": user.id,
        "username": user.username,
        "isAdmin": user.is_admin,
        "streamToken": stream_token,
        "streamTokenExpires": auth::STREAM_TOKEN_TTL_SECS,
    })))
}

// --- the library ----------------------------------------------------------

/// `GET /api/library?since=&limit=` - everything that changed above `since`.
///
/// Delta sync rather than a full index: a phone that has been away for a day
/// downloads the four tracks that arrived, not the ten thousand it already
/// has. `rev` in the reply is what to pass as `since` next time, and `more`
/// says whether the page hit its limit and should be asked for again.
pub async fn library(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    // Bound, not discarded. The library a caller may see depends on who they
    // are: an unadopted collector audition belongs to exactly one listener.
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let since: i64 = params.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    let limit: i64 = params
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5000)
        .clamp(1, 20_000);

    let (tracks, removed, page_rev) = state.db.tracks_since(caller.id, since, limit);
    let more = (tracks.len() as i64 + removed.len() as i64) >= limit;

    Ok(Json(json!({
        // The whole-library revision, so a client that has drained every page
        // knows what it is caught up to.
        "rev": if more { page_rev } else { state.db.current_rev() },
        "more": more,
        "tracks": tracks,
        "removed": removed,
    })))
}

/// One side of the sync handshake: how a track is recognised across devices.
/// Normalised tags, because paths differ per machine and hashes differ per rip.
fn sync_key(title: &str, artist: &str, album: &str) -> String {
    let norm = |s: &str| s.trim().to_lowercase();
    format!("{}\u{1}{}\u{1}{}", norm(title), norm(artist), norm(album))
}

#[derive(serde::Deserialize)]
pub struct MissingQuery {
    pub tracks: Vec<MissingEntry>,
}

#[derive(serde::Deserialize)]
pub struct MissingEntry {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    /// Seconds, when the client knows it.
    #[serde(default)]
    pub duration: Option<f64>,
}

/// `POST /api/library/missing` - which of these tracks the server lacks.
///
/// The reply is indices into the request, so the client can upload exactly
/// what is absent and skip what is already here - the precheck that makes
/// folder sync idempotent instead of a duplicate factory (`finish` suffixes
/// name collisions rather than overwriting; see upload.rs).
///
/// A track counts as present when tags match (case-insensitive title, artist,
/// album) and any known durations agree within three seconds. The artist leg
/// matches either the track artist or the album artist, because compilations
/// disagree with themselves about which one names the song.
pub async fn library_missing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<MissingQuery>,
) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    use std::collections::HashMap as Map;
    let mut have: Map<String, Vec<Option<i64>>> = Map::new();
    // A third, artist-less leg (title + album only) absorbs the ways two tag
    // readers join a multi-artist credit differently ("A & B" vs "A; B" vs
    // "A feat. B") - within one ALBUM, an identical title with a duration
    // within tolerance is the same recording, whoever the credit names.
    let mut have_loose: Map<String, Vec<Option<i64>>> = Map::new();
    for (title, artist, album_artist, album, duration_ms) in state.db.sync_identities() {
        have.entry(sync_key(&title, &artist, &album))
            .or_default()
            .push(duration_ms);
        if album_artist.trim().to_lowercase() != artist.trim().to_lowercase() {
            have.entry(sync_key(&title, &album_artist, &album))
                .or_default()
                .push(duration_ms);
        }
        if !album.trim().is_empty() {
            have_loose
                .entry(sync_key(&title, "", &album))
                .or_default()
                .push(duration_ms);
        }
    }

    let duration_close = |ours: &[Option<i64>], theirs: Option<f64>| -> bool {
        let Some(theirs) = theirs else { return true };
        ours.iter().any(|ms| match ms {
            None => true,
            Some(ms) => ((*ms as f64) / 1000.0 - theirs).abs() <= 3.0,
        })
    };

    let missing: Vec<usize> = body
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            let exact = have
                .get(&sync_key(&t.title, &t.artist, &t.album))
                .is_some_and(|durs| duration_close(durs, t.duration));
            let loose = !t.album.trim().is_empty()
                && have_loose
                    .get(&sync_key(&t.title, "", &t.album))
                    .is_some_and(|durs| duration_close(durs, t.duration));
            !(exact || loose)
        })
        .map(|(i, _)| i)
        .collect();

    Ok(Json(json!({ "missing": missing })))
}

/// `GET /api/scan` - how the indexer is doing.
pub async fn scan_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let used = state.db.total_bytes();
    let mut status = state.progress.snapshot();
    if let Some(obj) = status.as_object_mut() {
        obj.insert("tracks".into(), json!(state.db.track_count()));
        obj.insert("bytes".into(), json!(used));
        obj.insert("bytesLabel".into(), json!(human_bytes(used)));
        obj.insert("quota".into(), json!(state.library_quota_bytes));
        obj.insert("rev".into(), json!(state.db.current_rev()));
    }
    Ok(Json(status))
}

/// `POST /api/scan` - re-walk the music root now.
pub async fn scan_now(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    scan::spawn_scan(
        state.db.clone(),
        state.music_root.clone(),
        state.art_dir.clone(),
        state.progress.clone(),
    );
    Ok(Json(json!({ "started": true })))
}

/// The volume the music lives on, asked of `df` - dependency-free, and the
/// server already shells out for heavier things (ffmpeg, the importer). POSIX
/// `-kP` output is two lines: a header, then
/// `filesystem 1024-blocks used available capacity mount`. Best-effort: a
/// container without `df` just reports no disk numbers rather than an error.
/*
 * How hard the box is working, for the Server pane.
 *
 * Deliberately the same shape as `disk_space` below: ask the operating system
 * the way a person at a terminal would, parse the answer, and treat "no answer"
 * as "nothing to show" rather than an error. No new dependency - a metrics
 * crate for three numbers would be a lot of supply chain for a readout.
 */

/// One, five and fifteen minute load averages.
///
/// `getloadavg` is POSIX and works the same on the Mac the home hub runs on and
/// the Linux box the registry runs on, which is the whole reason to use it
/// rather than read /proc: one implementation, no cfg, no second code path to
/// keep honest.
fn load_average() -> Option<[f64; 3]> {
    let mut out = [0f64; 3];
    // SAFETY: getloadavg writes at most `n` doubles into the pointer it is
    // given, and it is given exactly the length of the array it is writing to.
    let got = unsafe { libc::getloadavg(out.as_mut_ptr(), 3) };
    if got == 3 { Some(out) } else { None }
}

/// Total and available bytes of RAM, or None where we cannot tell.
///
/// AVAILABLE, not "free". Both systems keep memory busy on purpose - caches and
/// buffers that are handed back the moment anything wants them - so a "free"
/// figure on a healthy box reads alarmingly close to zero and means nothing.
/// Available is the number that answers "could this machine do more work".
#[cfg(target_os = "linux")]
fn memory() -> Option<(i64, i64)> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let field = |name: &str| -> Option<i64> {
        text.lines()
            .find(|l| l.starts_with(name))?
            .split_whitespace()
            .nth(1)?
            .parse::<i64>()
            .ok()
            .map(|kb| kb * 1024)
    };
    Some((field("MemTotal:")?, field("MemAvailable:")?))
}

#[cfg(target_os = "macos")]
fn memory() -> Option<(i64, i64)> {
    let total: i64 = String::from_utf8_lossy(
        &std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?
            .stdout,
    )
    .trim()
    .parse()
    .ok()?;

    let out = std::process::Command::new("vm_stat")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // The header names the page size: "Mach Virtual Memory Statistics:
    // (page size of 16384 bytes)". Read it rather than assuming 4096 - Apple
    // silicon uses 16k, and assuming would under-report by a factor of four.
    let page: i64 = text
        .lines()
        .next()
        .and_then(|l| l.split("page size of ").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(4096);
    let pages = |name: &str| -> i64 {
        text.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split(':').nth(1))
            .map(|v| v.trim().trim_end_matches('.'))
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
    };
    // Free plus the pages the system would reclaim without hesitating.
    let available = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative"))
        * page;
    Some((total, available))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn memory() -> Option<(i64, i64)> {
    None
}

fn disk_space(path: &std::path::Path) -> Option<(i64, i64)> {
    let out = std::process::Command::new("df")
        .arg("-kP")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1)?;
    let mut cols = line.split_whitespace();
    let total_kb: i64 = cols.nth(1)?.parse().ok()?;
    let _used = cols.next()?;
    let free_kb: i64 = cols.next()?.parse().ok()?;
    Some((total_kb * 1024, free_kb * 1024))
}

/// `GET /api/stats` - the numbers behind the settings dashboard, one call.
///
/// Everything a client would otherwise stitch together from three endpoints
/// (plus the two things it cannot derive at all: process uptime and the real
/// free space on the music volume). Any signed-in caller may read it - it is
/// the user's own server, and nothing here is a secret from a listener whose
/// uploads share the same disk.
pub async fn stats(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let used = state.db.total_bytes();
    let disk = disk_space(&state.music_root);
    let load = load_average();
    let mem = memory();
    // Cores, so a load figure means something: 4.0 is a busy laptop and an idle
    // sixteen-core box, and the pane divides by this to say which.
    let cpus = std::thread::available_parallelism().map(|n| n.get() as i64).unwrap_or(0);
    let (queued, downloading) = {
        let jobs = state.imports.jobs.lock().await;
        (
            jobs.iter().filter(|j| j.state == "queued").count(),
            jobs.iter().filter(|j| j.state == "downloading").count(),
        )
    };

    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "name": state.server_name,
        "uptimeSecs": state.started.elapsed().as_secs(),
        "tracks": state.db.track_count(),
        "users": state.db.user_count(),
        "bytesUsed": used,
        "bytesLabel": human_bytes(used),
        "quotaBytes": state.library_quota_bytes,
        "diskTotalBytes": disk.map(|(total, _)| total),
        "diskFreeBytes": disk.map(|(_, free)| free),
        // Nulls where the box will not say, so the pane can leave a row out
        // rather than draw a confident zero.
        "cpuCount": if cpus > 0 { json!(cpus) } else { json!(null) },
        "loadAvg1": load.map(|l| (l[0] * 100.0).round() / 100.0),
        "loadAvg5": load.map(|l| (l[1] * 100.0).round() / 100.0),
        "loadAvg15": load.map(|l| (l[2] * 100.0).round() / 100.0),
        "memTotalBytes": mem.map(|(total, _)| total),
        "memAvailableBytes": mem.map(|(_, avail)| avail),
        "transcode": state.ffmpeg,
        "importsQueued": queued,
        "importsActive": downloading,
    })))
}

// --- favourites -----------------------------------------------------------

/// `GET /api/tracks?ids=1,2,3` - the light metadata a REMOTE needs to draw a
/// track it will never stream: title, artist, art, length. For any thin client
/// whose whole library view is "resolve these two dozen ids", and for whom the
/// full /api/library payload is megabytes of lyrics it cannot use. (Built for
/// a Wear OS remote that was since retired in favour of the phone's own
/// MediaSession controls; the endpoint stays - it is published hub API and the
/// right door for the next remote.)
pub async fn tracks_meta(
    State(state): State<Arc<AppState>>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let _ = caller;
    let ids: Vec<i64> = q
        .get("ids")
        .map(|raw| raw.split(',').filter_map(|p| p.trim().parse().ok()).collect())
        .unwrap_or_default();
    // A remote asks for a queue's worth, not a library's. The cap is generous
    // for that and mean to a scraper.
    let ids: Vec<i64> = ids.into_iter().take(200).collect();
    let rows: Vec<serde_json::Value> = ids
        .iter()
        .filter_map(|id| state.db.track(*id))
        .map(|t| {
            json!({
                "id": t.id,
                "title": t.title,
                "artist": t.artist,
                "album": t.album,
                "durationMs": t.duration.map(|d| (d * 1000.0) as i64),
                "artId": t.art_id,
            })
        })
        .collect();
    Ok(Json(json!({ "tracks": rows })))
}

pub async fn favorites(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    Ok(Json(json!({ "tracks": state.db.favorites(caller.id) })))
}

#[derive(Deserialize)]
pub struct FavoriteBody {
    pub favorite: bool,
}

/// The one matching rule a pending like lives by: the folded identity, and
/// only rows the caller may actually hold - library, or their own audition.
fn liked_track_for(state: &Arc<AppState>, user: i64, k: &str) -> Option<i64> {
    // The exact credit wins; the lead credit is the fallback, because the
    // promise and the file disagree about featured artists more often than
    // they agree (see discovery::lead_key). Two passes rather than one so an
    // exact match is never beaten by a looser one on another row.
    let mut lead_hit = None;
    for (id, artist, title, audition_owner) in state.db.track_identities() {
        if audition_owner != 0 && audition_owner != user {
            continue;
        }
        if crate::discovery::key_of(&artist, &title) == k {
            return Some(id);
        }
        if lead_hit.is_none() && crate::discovery::lead_key(&artist, &title) == k {
            lead_hit = Some(id);
        }
    }
    lead_hit
}

#[derive(serde::Deserialize)]
pub struct PendingLikeBody {
    pub artist: String,
    pub title: String,
}

/// `POST /api/likes/pending` - a heart promised on Discover: favourite it now
/// if the song is already here, remember the promise otherwise. The
/// collector's sweep keeps it the moment a matching track lands.
pub async fn add_pending_like(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PendingLikeBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let artist = body.artist.trim();
    let title = body.title.trim();
    if artist.is_empty() || title.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name the song".into()));
    }
    let k = crate::discovery::key_of(artist, title);
    if let Some(id) = liked_track_for(&state, caller.id, &k) {
        state
            .db
            .set_favorite(caller.id, id, true)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        state.db.promote_curator_track(id);
        return Ok(Json(json!({ "landed": true, "trackId": id, "k": k })));
    }
    state
        .db
        .pending_like_put(caller.id, &k, title, artist)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "landed": false, "k": k })))
}

/// `GET /api/likes/pending` - the hearts still waiting on their downloads.
///
/// Each row now says whether a download is actually RUNNING for it. The shelf
/// on the Liked page used to caption every pending heart "still downloading",
/// which was a guess dressed as a fact: a failed or cleared job left the heart
/// standing for its whole thirty-day life over an empty queue. The claim is
/// checked against the live queue by the same folded identity the settle pass
/// matches with, so the client can say "downloading" only where it is true and
/// "will retry" where it is not.
pub async fn pending_likes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    // The folded identity of every job still moving. A job's title/subtitle
    // is what the importer was ASKED for, which is exactly what the pending
    // like recorded.
    let live: std::collections::HashSet<String> = {
        let jobs = state.imports.jobs.lock().await;
        jobs.iter()
            .filter(|j| j.state == "queued" || j.state == "downloading")
            .filter_map(|j| {
                j.subtitle
                    .as_deref()
                    .map(|artist| crate::discovery::key_of(artist, &j.title))
            })
            .collect()
    };
    let rows: Vec<serde_json::Value> = state
        .db
        .pending_likes_for(caller.id)
        .into_iter()
        .map(|(k, title, artist, created_at)| {
            json!({
                "k": k,
                "title": title,
                "artist": artist,
                "createdAt": created_at,
                "downloading": live.contains(&k),
            })
        })
        .collect();
    Ok(Json(json!({ "pending": rows })))
}

#[derive(serde::Deserialize)]
pub struct RemovePendingLikeBody {
    pub k: String,
}

/// `POST /api/likes/pending/remove` - the heart withdrawn before it landed.
pub async fn remove_pending_like(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RemovePendingLikeBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .pending_like_remove(caller.id, &body.k)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn set_favorite(
    State(state): State<Arc<AppState>>,
    Path(track_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<FavoriteBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .set_favorite(caller.id, track_id, body.favorite)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // Adoption: a heart on a collector download is deliberate approval - it
    // skips the audition entirely and joins the library at once.
    if body.favorite {
        state.db.promote_curator_track(track_id);
    }
    Ok(Json(json!({ "ok": true })))
}

// --- playlists ------------------------------------------------------------

pub async fn playlists(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let lists: Vec<_> = state
        .db
        .playlists(caller.id)
        .into_iter()
        .map(|p| {
            // Decoration rides the list response rather than a second endpoint:
            // the client already refetches this on every heartbeat, and a
            // description that arrived a request later would paint in after the
            // name it belongs under.
            // The songs filed into this list that the box does not own yet -
            // the "plan to acquire" members. They ride the same response as
            // the owned track ids so the client can draw the arriving ghosts
            // in order without a second request per list.
            let wants: Vec<_> = state
                .db
                .playlist_wants_for(p.id)
                .into_iter()
                .map(|(k, title, artist, url, created_at)| {
                    json!({ "k": k, "title": title, "artist": artist, "url": url, "createdAt": created_at })
                })
                .collect();
            json!({
                "id": p.id,
                "name": p.name,
                "updatedAt": p.updated_at,
                "tracks": p.tracks,
                "wants": wants,
                "description": p.description,
                "folder": p.folder,
                "cover": p.cover,
                "autoStem": p.auto_stem,
            })
        })
        .collect();
    Ok(Json(json!({ "playlists": lists })))
}

#[derive(Deserialize)]
pub struct PlaylistBody {
    pub name: Option<String>,
    pub tracks: Option<Vec<i64>>,
    /// Each optional so a caller sends only what it means to change. A body
    /// carrying every field would make two devices editing different things
    /// overwrite each other with whatever they last read.
    pub description: Option<String>,
    pub folder: Option<String>,
    pub cover: Option<String>,
    /// Separate this list's songs ahead of being asked.
    #[serde(rename = "autoStem")]
    pub auto_stem: Option<bool>,
}

pub async fn create_playlist(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PlaylistBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let name = body.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "a playlist needs a name"));
    }
    let id = state
        .db
        .create_playlist(caller.id, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(tracks) = body.tracks {
        let _ = state.db.set_playlist_tracks(id, &tracks);
    }
    Ok(Json(json!({ "id": id, "name": name })))
}

/// Refuses any playlist the caller does not own. Ownership is checked on every
/// edit rather than trusted from the list response - two accounts on one server
/// should not be able to reach into each other's playlists by guessing an id.
fn owned_playlist(state: &AppState, caller_id: i64, playlist_id: i64) -> Result<(), ApiError> {
    match state.db.playlist_owner(playlist_id) {
        Some(owner) if owner == caller_id => Ok(()),
        // Same answer either way, so a probe cannot enumerate what exists.
        _ => Err(bad(StatusCode::NOT_FOUND, "no such playlist")),
    }
}

pub async fn update_playlist(
    State(state): State<Arc<AppState>>,
    Path(playlist_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<PlaylistBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    owned_playlist(&state, caller.id, playlist_id)?;
    if let Some(name) = body.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        let _ = state.db.rename_playlist(playlist_id, name);
    }
    if let Some(tracks) = body.tracks {
        state
            .db
            .set_playlist_tracks(playlist_id, &tracks)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    // Trimmed, and empty is a real value here rather than "unchanged" - that is
    // what `None` means. Clearing a description has to be expressible.
    let description = body.description.as_deref().map(str::trim);
    let folder = body.folder.as_deref().map(str::trim);
    let cover = body.cover.as_deref().map(str::trim);
    if description.is_some() || folder.is_some() || cover.is_some() {
        state
            .db
            .set_playlist_meta(playlist_id, description, folder, cover)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    if let Some(on) = body.auto_stem {
        state
            .db
            .set_playlist_auto_stem(playlist_id, on)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_playlist(
    State(state): State<Arc<AppState>>,
    Path(playlist_id): Path<i64>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    owned_playlist(&state, caller.id, playlist_id)?;
    // The cover goes with it. The row is about to be deleted, so this is the
    // last moment anything knows the filename - after the DELETE the file is
    // unreferenced and nothing would ever look for it again.
    if let Some(name) = state.db.playlist_cover(playlist_id) {
        let _ = std::fs::remove_file(state.data_dir.join("playlist-covers").join(name));
    }
    let _ = state.db.delete_playlist(playlist_id);
    Ok(Json(json!({ "ok": true })))
}

// --- playlist wants (plan-to-acquire members) -----------------------------

#[derive(Deserialize)]
pub struct PlaylistWantBody {
    pub artist: String,
    pub title: String,
    /// The catalogue link, when the caller has one - handed straight to the
    /// importer if it is fetchable, so the download starts without a second
    /// name search. Optional: the sweep can always resolve by name.
    #[serde(default)]
    pub url: String,
}

/// `POST /api/playlists/:id/wants` - file a song this box does not own yet into
/// a playlist and start fetching it. If it turns out we already own it, it is
/// added to the list at once and no want is left behind. Otherwise the want is
/// recorded (the sweep retries it and files it on land) and the download is
/// kicked off now so it begins arriving immediately.
pub async fn add_playlist_want(
    State(state): State<Arc<AppState>>,
    Path(playlist_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<PlaylistWantBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    owned_playlist(&state, caller.id, playlist_id)?;
    let artist = body.artist.trim();
    let title = body.title.trim();
    if artist.is_empty() || title.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name the song".into()));
    }
    let k = crate::discovery::key_of(artist, title);
    let url = body.url.trim().to_string();
    state
        .db
        .playlist_want_put(caller.id, playlist_id, &k, title, artist, &url)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // Already here? File it now - no ghost, no download. settle_want_now writes
    // the track into the list and clears the want it just wrote.
    if crate::collector::settle_want_now(&state, caller.id, playlist_id, &k) {
        return Ok(Json(json!({ "landed": true, "k": k })));
    }
    // Start the fetch now rather than waiting out the sweep's grace period; the
    // sweep and the client reconcile file it into the list when it lands.
    let st = state.clone();
    let (t, a, u, user) = (title.to_string(), artist.to_string(), url, caller.id);
    tokio::spawn(async move {
        crate::collector::kick_want_download(&st, user, &t, &a, &u).await;
    });
    Ok(Json(json!({ "landed": false, "k": k })))
}

/// `POST /api/playlists/:id/wants/:k/settle` - the client noticed this want's
/// song is now in the library and asks the box to file it into the list at once
/// rather than wait for the next sweep.
pub async fn settle_playlist_want(
    State(state): State<Arc<AppState>>,
    Path((playlist_id, k)): Path<(i64, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    owned_playlist(&state, caller.id, playlist_id)?;
    let settled = crate::collector::settle_want_now(&state, caller.id, playlist_id, &k);
    Ok(Json(json!({ "settled": settled })))
}

/// `DELETE /api/playlists/:id/wants/:k` - the want withdrawn before it landed.
pub async fn remove_playlist_want(
    State(state): State<Arc<AppState>>,
    Path((playlist_id, k)): Path<(i64, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    owned_playlist(&state, caller.id, playlist_id)?;
    state
        .db
        .playlist_want_remove(playlist_id, &k)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

// --- resume positions -----------------------------------------------------

#[derive(Deserialize)]
pub struct PlayStateBody {
    #[serde(rename = "trackId")]
    pub track_id: i64,
    #[serde(rename = "positionMs")]
    pub position_ms: i64,
}

pub async fn set_play_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PlayStateBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .set_play_state(caller.id, body.track_id, body.position_ms.max(0))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn play_states(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    // `?kind=book` asks for audiobook bookmarks alone. Without it a reader with
    // several books on the go loses the mark for whichever they touched least
    // recently, because one capped, recency-ordered list served everything.
    let kind = q.get("kind").map(String::as_str).filter(|k| !k.is_empty());
    // A shelf wants every book's mark, not a recent hundred. Bounded all the
    // same - the cap is there to keep one request from reading a whole table.
    let limit = q
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(100)
        .clamp(1, 2_000);
    let states: Vec<_> = state
        .db
        .play_states(caller.id, limit, kind)
        .into_iter()
        .map(|(track_id, position_ms, updated)| {
            json!({ "trackId": track_id, "positionMs": position_ms, "updatedAt": updated })
        })
        .collect();
    Ok(Json(json!({ "states": states })))
}

// --- accounts (admin) -----------------------------------------------------

pub async fn list_users(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    let users: Vec<_> = state
        .db
        .list_users()
        .into_iter()
        .map(|(id, username, is_admin)| json!({ "id": id, "username": username, "isAdmin": is_admin }))
        .collect();
    Ok(Json(json!({ "users": users })))
}

pub async fn delete_user(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i64>,
    headers: HeaderMap,
) -> ApiResult {
    let caller = auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    if caller.id == user_id {
        return Err(bad(StatusCode::BAD_REQUEST, "an admin cannot delete themselves"));
    }
    state
        .db
        .delete_user(user_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // A deleted account's media tokens must die with it, not a minute later.
    state.stream_tokens.purge_user(user_id);
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/users/:id/revoke` - kills every stream token that account holds.
pub async fn revoke_streams(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i64>,
    headers: HeaderMap,
) -> ApiResult {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    // Both halves, or the revoke is theatre: the epoch bump invalidates
    // stream tokens already in the wild, and dropping the session tokens
    // stops the client from just minting fresh ones via /api/me.
    state
        .db
        .bump_stream_epoch(user_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state
        .db
        .delete_tokens_for_user(user_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // The verified-token cache would otherwise honour the old epoch for up to
    // its TTL - purge it so the revoke means now.
    state.stream_tokens.purge_user(user_id);
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod host_readings {
    //! The three numbers the Server pane shows about the box itself.
    //!
    //! Worth testing because they are the kind of thing that returns a
    //! confident, plausible, wrong number: a page size assumed at 4k instead of
    //! Apple's 16k under-reports memory by a factor of four, and nothing about
    //! the readout would look broken.

    #[test]
    fn the_box_reports_a_plausible_load() {
        let load = super::load_average().expect("POSIX getloadavg should answer");
        for v in load {
            assert!(v.is_finite(), "load must be a number, got {v}");
            assert!(v >= 0.0, "load cannot be negative, got {v}");
            // A machine running tests is busy, not on fire.
            assert!(v < 1024.0, "load is implausible: {v}");
        }
    }

    #[test]
    fn memory_is_read_at_the_right_scale() {
        let Some((total, available)) = super::memory() else {
            // An unsupported platform answers None, which the pane handles.
            return;
        };
        // The factor-of-four page-size bug lands here: a machine with 16GB
        // reporting 4GB would sail past a "greater than zero" check.
        assert!(total > 1 << 30, "total RAM under a gigabyte is not credible: {total}");
        assert!(total < 1 << 44, "total RAM over 16TB is not credible: {total}");
        assert!(available > 0, "no memory available at all is not credible");
        assert!(
            available <= total,
            "available ({available}) cannot exceed total ({total})",
        );
    }
}
