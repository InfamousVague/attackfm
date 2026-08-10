//! The Spotify account link, per user, on the hub.
//!
//! Ported from the desktop app's local OAuth flow when the import engine moved
//! server-side: the account that feeds playlist imports now lives where the
//! downloads run, so every device sees one connection, one library listing,
//! and one sync bookkeeping - and the desktop app carries no Spotify machinery
//! at all.
//!
//! The flow, reshaped for a server:
//!
//! 1. `POST /api/spotify/connect { clientId }` - mints a PKCE verifier and a
//!    state, parks them against the calling user, and returns the authorize
//!    URL. The client opens it in the system browser.
//! 2. Spotify redirects the browser to `GET /api/spotify/callback` HERE (the
//!    public URL must be the app's redirect URI in Spotify's dashboard). The
//!    state finds the parked login; the code+verifier trade for tokens; the
//!    tokens persist per user; the browser gets a "return to AttackFM" page.
//! 3. The client polls `GET /api/spotify/status` until it reads connected.
//!
//! Requires `AFM_PUBLIC_URL` (e.g. https://matt.attack.fm) so the redirect URI
//! can be built; without it, connect explains rather than guessing.

use crate::auth;
use crate::db;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::Digest;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const SCOPES: &str = "user-library-read playlist-read-private playlist-read-collaborative";
/// How long a parked login waits for the browser before it is swept.
const PENDING_TTL_SECS: i64 = 300;

/// A login that has left for the browser and not yet come back.
pub struct PendingLogin {
    user_id: i64,
    client_id: String,
    verifier: String,
    started: i64,
}

/// The module's shared state: parked logins by state token.
#[derive(Default)]
pub struct SpotifyLogins {
    pending: tokio::sync::Mutex<HashMap<String, PendingLogin>>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn http_client() -> Result<reqwest::Client, (StatusCode, String)> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
}

async fn exchange_token(
    http: &reqwest::Client,
    params: &[(&str, &str)],
) -> Result<TokenResponse, String> {
    let response = http
        .post("https://accounts.spotify.com/api/token")
        .form(params)
        .send()
        .await
        .map_err(|e| format!("Spotify token request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("Spotify refused the token request ({status})"));
    }
    response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("Spotify token response unreadable: {e}"))
}

/// A live access token for the user, refreshed (and re-persisted - Spotify
/// rotates refresh tokens) when the cached one has under a minute left.
pub async fn access_token(
    state: &AppState,
    user_id: i64,
    force_refresh: bool,
) -> Result<String, String> {
    let account = state
        .db
        .spotify_account(user_id)
        .ok_or("Not connected to Spotify.")?;
    if account.refresh_token.is_empty() {
        return Err("Not connected to Spotify.".into());
    }

    if !force_refresh {
        if let Some(token) = &account.access_token {
            if account.expires_at > now_secs() + 60 {
                return Ok(token.clone());
            }
        }
    }

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let refreshed = exchange_token(
        &http,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &account.refresh_token),
            ("client_id", &account.client_id),
        ],
    )
    .await?;

    let rotated = refreshed.refresh_token.as_deref().unwrap_or(&account.refresh_token);
    state
        .db
        .spotify_update_tokens(
            user_id,
            rotated,
            &refreshed.access_token,
            now_secs() + refreshed.expires_in as i64,
        )
        .map_err(|e| format!("could not persist the refreshed login: {e}"))?;
    Ok(refreshed.access_token)
}

/// GET one Web API page as JSON. A 401 re-auths once; a 429 sleeps out
/// Retry-After (capped) and tries again, twice - a big library pages enough
/// to meet one.
pub async fn api_get(
    state: &AppState,
    user_id: i64,
    http: &reqwest::Client,
    url: &str,
) -> Result<serde_json::Value, String> {
    let mut token = access_token(state, user_id, false).await?;
    let mut reauthed = false;
    let mut retries = 0u8;
    loop {
        let response = http
            .get(url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("Spotify request failed: {e}"))?;

        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED && !reauthed {
            reauthed = true;
            token = access_token(state, user_id, true).await?;
            continue;
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS && retries < 2 {
            retries += 1;
            let wait = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(2)
                .min(30);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }
        if !status.is_success() {
            // Spotify says WHY in the body, and it is usually the whole answer
            // ("Insufficient client scope", "the user may not be registered").
            // Throwing it away left a bare status code that could mean four
            // different things, so it is carried through to the listener.
            let body = response.text().await.unwrap_or_default();
            let reason = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| body.chars().take(200).collect());
            if status == reqwest::StatusCode::FORBIDDEN {
                return Err(format!(
                    "Spotify refused this request (403). {reason} \
                     Usually the Spotify app has no Web API access, or - while it is in \
                     Development Mode - the account you logged in with is not listed under \
                     its User Management."
                ));
            }
            return Err(format!("Spotify API error ({status}). {reason}"));
        }
        return response
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Spotify response unreadable: {e}"));
    }
}

// --- track enumeration -----------------------------------------------------
//
// The authenticated read the import path never had. The public-page scrape it
// uses instead can only see public playlists and only recovers titles, which
// is why private and collaborative playlists were refused outright even though
// the scopes to read them have been granted all along. Everything below asks
// the Web API as the user, so a private playlist is an ordinary read - and it
// comes back with ids, ISRCs and durations, which is what makes matching a
// track to the library something better than a string compare.

/// Only the fields the mirror stores. Spotify's default track object is huge
/// and every playlist pages; the projection is roughly a 90% payload cut,
/// which is the difference between staying inside the rate limit and meeting
/// a 429 on every large account.
const TRACK_FIELDS: &str = "next,items(added_at,is_local,track(id,name,duration_ms,is_local,\
linked_from(id),external_ids(isrc),artists(name),album(name,artists(name))))";

/// Read one track object into a mirror row. `position`/`occurrence` are the
/// caller's business - it is walking the pages and knows the order.
fn item_from_track(track: &serde_json::Value, added_at: i64, position: i64) -> db::MirrorItem {
    let str_at = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str()).unwrap_or_default().to_string()
    };
    // A relinked track reports the id for THIS market while `linked_from`
    // carries the one the playlist was built with. Preferring linked_from
    // keeps the uid stable when the same account is read from another country.
    let uid = track
        .get("linked_from")
        .and_then(|l| l.get("id"))
        .and_then(|v| v.as_str())
        .or_else(|| track.get("id").and_then(|v| v.as_str()))
        .unwrap_or_default()
        .to_string();
    let is_local = track.get("is_local").and_then(|v| v.as_bool()).unwrap_or(false);
    let album = track.get("album");
    db::MirrorItem {
        // A local file the user added to a Spotify playlist has no id and can
        // never be fetched; it is mirrored so the position count stays honest
        // and immediately parked as unavailable.
        track_uid: if uid.is_empty() || is_local {
            format!("local:{position}")
        } else {
            uid
        },
        occurrence: 0,
        position,
        isrc: track
            .get("external_ids")
            .and_then(|e| e.get("isrc"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_uppercase(),
        title: str_at(track.get("name")),
        artist: str_at(
            track
                .get("artists")
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())
                .and_then(|a| a.get("name")),
        ),
        album: str_at(album.and_then(|a| a.get("name"))),
        album_artist: str_at(
            album
                .and_then(|a| a.get("artists"))
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())
                .and_then(|a| a.get("name")),
        ),
        duration_ms: track.get("duration_ms").and_then(|v| v.as_i64()),
        added_at,
        track_id: None,
        match_method: String::new(),
        state: if is_local { "unavailable".into() } else { "pending".into() },
        attempts: 0,
        next_try_at: 0,
        job_id: String::new(),
        note: String::new(),
    }
}

fn added_at_ms(item: &serde_json::Value) -> i64 {
    item.get("added_at")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono_ish(s))
        .unwrap_or(0)
}

/// Spotify stamps `added_at` as RFC3339 UTC ("2024-03-01T12:00:00Z"). The
/// server carries no date crate, and the value is only ever used for ordering
/// and display, so it is parsed by hand rather than pulling one in.
fn chrono_ish(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // Days since the epoch by the civil-from-days algorithm, so no leap-year
    // table is needed.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + h * 3_600 + mi * 60 + sec) * 1000)
}

/// Number repeated tracks so the same song twice in one playlist stays two
/// distinct mirror rows. The mirror is keyed by (uid, occurrence) precisely so
/// this case does not collapse.
fn number_occurrences(items: &mut [db::MirrorItem]) {
    let mut seen: HashMap<String, i64> = HashMap::new();
    for item in items.iter_mut() {
        let n = seen.entry(item.track_uid.clone()).or_insert(0);
        item.occurrence = *n;
        *n += 1;
    }
}

/// Every track in a collection, in upstream order, fully paged.
pub async fn fetch_items(
    state: &AppState,
    user_id: i64,
    http: &reqwest::Client,
    kind: &str,
    spotify_id: &str,
) -> Result<Vec<db::MirrorItem>, String> {
    let mut items = Vec::new();
    let mut position = 0i64;

    let mut url = match kind {
        "playlist" => format!(
            "https://api.spotify.com/v1/playlists/{spotify_id}/tracks?limit=100&additional_types=track&fields={}",
            urlencode(TRACK_FIELDS)
        ),
        "liked" => "https://api.spotify.com/v1/me/tracks?limit=50".to_string(),
        "album" => format!("https://api.spotify.com/v1/albums/{spotify_id}/tracks?limit=50"),
        other => return Err(format!("cannot enumerate a {other}")),
    };

    loop {
        let page = api_get(state, user_id, http, &url).await?;
        let empty = Vec::new();
        let rows = page.get("items").and_then(|v| v.as_array()).unwrap_or(&empty);
        for row in rows {
            // Playlist and saved-track pages wrap the track; an album's track
            // list is the track objects themselves.
            let (track, added) = match kind {
                "album" => (row, 0),
                _ => match row.get("track") {
                    Some(t) if !t.is_null() => (t, added_at_ms(row)),
                    // A removed or unavailable entry still holds its slot
                    // upstream, so it holds one here too.
                    _ => {
                        let mut ghost = db::MirrorItem {
                            state: "unavailable".into(),
                            note: "Spotify no longer carries this track".into(),
                            ..item_from_track(&serde_json::Value::Null, 0, position)
                        };
                        ghost.track_uid = format!("local:{position}");
                        items.push(ghost);
                        position += 1;
                        continue;
                    }
                },
            };
            items.push(item_from_track(track, added, position));
            position += 1;
        }
        match page.get("next").and_then(|v| v.as_str()) {
            Some(next) if !next.is_empty() => url = next.to_string(),
            _ => break,
        }
    }

    // An album's track list is "simplified" and carries no ISRC, so the one
    // identity worth having is missing exactly where a whole record is being
    // matched. Hydrating costs one request per 50 tracks.
    if kind == "album" {
        hydrate_isrcs(state, user_id, http, &mut items).await?;
        for item in items.iter_mut() {
            if item.album.is_empty() {
                item.album = String::new();
            }
        }
    }

    number_occurrences(&mut items);
    Ok(items)
}

/// Fill in ISRCs (and album names) for rows that came from a simplified list.
async fn hydrate_isrcs(
    state: &AppState,
    user_id: i64,
    http: &reqwest::Client,
    items: &mut [db::MirrorItem],
) -> Result<(), String> {
    let ids: Vec<String> = items
        .iter()
        .filter(|i| !i.track_uid.starts_with("local:"))
        .map(|i| i.track_uid.clone())
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let mut found: HashMap<String, (String, String, String)> = HashMap::new();
    for chunk in ids.chunks(50) {
        let url = format!("https://api.spotify.com/v1/tracks?ids={}", chunk.join(","));
        let page = api_get(state, user_id, http, &url).await?;
        let empty = Vec::new();
        for track in page.get("tracks").and_then(|v| v.as_array()).unwrap_or(&empty) {
            let Some(id) = track.get("id").and_then(|v| v.as_str()) else { continue };
            let album = track.get("album");
            found.insert(
                id.to_string(),
                (
                    track
                        .get("external_ids")
                        .and_then(|e| e.get("isrc"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_uppercase(),
                    album
                        .and_then(|a| a.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    album
                        .and_then(|a| a.get("artists"))
                        .and_then(|a| a.as_array())
                        .and_then(|a| a.first())
                        .and_then(|a| a.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                ),
            );
        }
    }
    for item in items.iter_mut() {
        if let Some((isrc, album, album_artist)) = found.get(&item.track_uid) {
            if item.isrc.is_empty() {
                item.isrc = isrc.clone();
            }
            if item.album.is_empty() {
                item.album = album.clone();
            }
            if item.album_artist.is_empty() {
                item.album_artist = album_artist.clone();
            }
        }
    }
    Ok(())
}

/// The cheap "has it moved?" read - one request, no paging. Watching two
/// hundred playlists costs two hundred tiny calls a cycle rather than
/// thousands of pages, and a full enumeration only follows a snapshot that
/// actually changed.
pub async fn head_snapshot(
    state: &AppState,
    user_id: i64,
    http: &reqwest::Client,
    kind: &str,
    spotify_id: &str,
) -> Result<String, String> {
    match kind {
        "playlist" => {
            let url = format!(
                "https://api.spotify.com/v1/playlists/{spotify_id}?fields=snapshot_id,name,owner(id,display_name)"
            );
            let value = api_get(state, user_id, http, &url).await?;
            // Spotify stopped letting third-party apps read its OWN editorial
            // and algorithmic playlists - Discover Weekly, Release Radar, Daily
            // Mix, the "Today's Top Hits" sort - which come back 403 however
            // valid the token is. They arrive in /v1/me/playlists like any
            // other, so the only honest thing is to name the reason rather than
            // let a bare 403 read as a broken login.
            if value
                .get("owner")
                .and_then(|o| o.get("id"))
                .and_then(|v| v.as_str())
                .is_some_and(is_spotify_owned)
            {
                return Err(SPOTIFY_OWNED_NOTE.to_string());
            }
            Ok(value
                .get("snapshot_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string())
        }
        // Saved tracks have no snapshot id, so one is synthesized from the
        // total and the newest addition: either a save or an unsave moves it.
        "liked" => {
            let value = api_get(
                state,
                user_id,
                http,
                "https://api.spotify.com/v1/me/tracks?limit=1",
            )
            .await?;
            let total = value.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
            let newest = value
                .get("items")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .map(added_at_ms)
                .unwrap_or(0);
            Ok(format!("{total}:{newest}"))
        }
        // An album's contents never change, so its id IS its snapshot.
        "album" => Ok(spotify_id.to_string()),
        other => Err(format!("cannot poll a {other}")),
    }
}

fn redirect_uri(state: &AppState) -> Result<String, (StatusCode, String)> {
    let base = state.public_url.trim_end_matches('/');
    if base.is_empty() {
        return Err((
            StatusCode::PRECONDITION_FAILED,
            "The server does not know its public address. Set AFM_PUBLIC_URL (e.g. https://matt.attack.fm) in the service unit and restart.".into(),
        ));
    }
    Ok(format!("{base}/api/spotify/callback"))
}

// --- endpoints -------------------------------------------------------------

/// `GET /api/spotify/status`
pub async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let account = state.db.spotify_account(caller.id);
    let redirect = redirect_uri(&state).map(|u| json!(u)).unwrap_or(json!(null));
    let stored = account.as_ref().map(|a| a.client_id.clone()).filter(|c| !c.is_empty());
    let server_default = {
        let d = state.spotify_client_id.trim();
        (!d.is_empty()).then(|| d.to_string())
    };
    Ok(Json(json!({
        "connected": account.as_ref().map(|a| !a.refresh_token.is_empty()).unwrap_or(false),
        "displayName": account.as_ref().and_then(|a| a.display_name.clone()),
        // What a Connect right now would actually use, so the client can offer
        // a bare button instead of an empty field it has to explain.
        "clientId": stored.clone().or_else(|| server_default.clone()),
        // True when the hub supplied it, so the UI can say where it came from
        // rather than looking like it remembered something the user never typed.
        "clientIdFromServer": stored.is_none() && server_default.is_some(),
        "redirectUri": redirect,
    })))
}

#[derive(Deserialize)]
pub struct ConnectBody {
    /// Optional. Left out, the caller's stored id is reused, and failing that
    /// the server's own - so a hub whose owner configured one needs no typing.
    #[serde(rename = "clientId", default)]
    pub client_id: String,
}

/// Which Spotify app to log in against, best first: what the caller just
/// typed, then what they used last time, then the server's default.
///
/// A Client ID is not a secret - PKCE puts it in the authorize URL in plain
/// sight, which is exactly why there is no client secret to protect - so
/// keeping one in the service unit costs nothing and turns connecting into a
/// single button for everyone on the hub.
fn resolve_client_id(state: &AppState, user_id: i64, typed: &str) -> Option<String> {
    let typed = typed.trim();
    if !typed.is_empty() {
        return Some(typed.to_string());
    }
    let stored = state
        .db
        .spotify_account(user_id)
        .map(|a| a.client_id)
        .filter(|c| !c.is_empty());
    stored.or_else(|| {
        let default = state.spotify_client_id.trim();
        (!default.is_empty()).then(|| default.to_string())
    })
}

/// `POST /api/spotify/connect` - parks a login and returns the authorize URL.
pub async fn connect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ConnectBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let client_id = resolve_client_id(&state, caller.id, &body.client_id).ok_or((
        StatusCode::BAD_REQUEST,
        "This server has no Spotify Client ID. Enter one, or set AFM_SPOTIFY_CLIENT_ID in the service unit.".to_string(),
    ))?;
    let redirect = redirect_uri(&state)?;

    let mut verifier_bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let verifier = b64url(&verifier_bytes);
    let challenge = b64url(&sha2::Sha256::digest(verifier.as_bytes()));
    let mut state_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut state_bytes);
    let login_state = b64url(&state_bytes);

    let authorize_url = format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&state={}&code_challenge_method=S256&code_challenge={}",
        urlencode(&client_id),
        urlencode(SCOPES),
        urlencode(&redirect),
        urlencode(&login_state),
        urlencode(&challenge),
    );

    let mut pending = state.spotify.pending.lock().await;
    // Sweep anything the browser never brought back.
    let now = now_secs();
    pending.retain(|_, p| now - p.started < PENDING_TTL_SECS);
    pending.insert(
        login_state,
        PendingLogin { user_id: caller.id, client_id, verifier, started: now },
    );

    Ok(Json(json!({ "authorizeUrl": authorize_url })))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// `GET /api/spotify/callback` - where Spotify sends the browser back.
///
/// Unauthenticated by nature (it is the user's BROWSER arriving, not the
/// app), so the parked state token is the whole identity: no state match, no
/// login. The page it serves is terminal either way - the app learns the
/// outcome by polling status.
pub async fn callback(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CallbackQuery>,
) -> impl IntoResponse {
    fn page(title: &str, detail: &str) -> Html<String> {
        Html(format!(
            concat!(
                "<!doctype html><meta charset=\"utf-8\"><title>AttackFM</title>",
                "<body style=\"font-family:system-ui;background:#0f0f10;color:#eee;",
                "display:grid;place-items:center;height:100vh;margin:0\">",
                "<div style=\"text-align:center\"><h2>{}</h2><p>{}</p></div>",
            ),
            title, detail
        ))
    }

    let Some(login_state) = query.state else {
        return page("That link is stale", "Start the Spotify connection again from AttackFM.");
    };
    let parked = state.spotify.pending.lock().await.remove(&login_state);
    let Some(parked) = parked else {
        return page("That link is stale", "Start the Spotify connection again from AttackFM.");
    };

    if query.error.is_some() {
        return page("Spotify login was declined", "You can close this tab and return to AttackFM.");
    }
    let Some(code) = query.code else {
        return page("Spotify sent no code back", "Try connecting again from AttackFM.");
    };
    let Ok(redirect) = redirect_uri(&state) else {
        return page("Server misconfigured", "AFM_PUBLIC_URL is not set.");
    };

    let Ok(http) = reqwest::Client::builder().timeout(Duration::from_secs(30)).build() else {
        return page("Something went wrong", "Try connecting again from AttackFM.");
    };
    let tokens = match exchange_token(
        &http,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("client_id", &parked.client_id),
            ("code_verifier", &parked.verifier),
        ],
    )
    .await
    {
        Ok(t) => t,
        Err(_) => {
            return page("Spotify declined the login", "Try connecting again from AttackFM.")
        }
    };
    let Some(refresh_token) = tokens.refresh_token else {
        return page("Spotify sent no refresh token", "Check the Spotify app's settings and try again.");
    };

    // The display name is a nicety - a profile fetch that fails must not fail
    // the login it decorates.
    let display_name = async {
        let profile = http
            .get("https://api.spotify.com/v1/me")
            .bearer_auth(&tokens.access_token)
            .send()
            .await
            .ok()?
            .json::<serde_json::Value>()
            .await
            .ok()?;
        profile.get("display_name").and_then(|v| v.as_str()).map(|s| s.to_string())
    }
    .await;

    if state
        .db
        .spotify_save_account(
            parked.user_id,
            &parked.client_id,
            &refresh_token,
            &tokens.access_token,
            now_secs() + tokens.expires_in as i64,
            display_name.as_deref(),
        )
        .is_err()
    {
        return page("Could not save the login", "Try connecting again from AttackFM.");
    }

    page("Connected", "You can close this tab and return to AttackFM.")
}

/// `POST /api/spotify/disconnect` - forgets the tokens, keeps the sync
/// bookkeeping and the client id, so a reconnect picks up where it left off.
pub async fn disconnect(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .spotify_clear_tokens(caller.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// What a listener is told about a playlist Spotify will not hand over.
pub const SPOTIFY_OWNED_NOTE: &str =
    "Spotify does not let other apps read its own playlists (Discover Weekly, Release Radar, \
     Daily Mix, and its editorial lists), so this one cannot be mirrored. Your own playlists, \
     and playlists made by other people, work normally.";

/// Whether a playlist belongs to Spotify itself rather than to a person.
///
/// Owner id is the reliable signal; the `37i9dQZF1D` id prefix every editorial
/// playlist carries is kept as a fallback for the listing path, which does not
/// always have the owner to hand.
pub fn is_spotify_owned(owner_id: &str) -> bool {
    owner_id.eq_ignore_ascii_case("spotify")
}

/// Spotify orders `images` largest first; the second-smallest is the ~300px
/// variant - crisp on a retina row without paying for the 640px original.
fn thumb(value: &serde_json::Value) -> Option<String> {
    let images = value.get("images").and_then(|v| v.as_array())?;
    let pick = if images.len() >= 2 { images.get(images.len() - 2) } else { images.last() };
    pick.and_then(|img| img.get("url")).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// `GET /api/spotify/library` - saved albums and playlists, fully paged, each
/// stamped with its sync state against the per-user bookkeeping.
pub async fn library(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let http = http_client()?;
    let synced = state.db.spotify_synced(caller.id);
    // What the mirror knows, so each row can report real progress rather than
    // the old client-asserted "synced" flag. Falls back to spotify_synced
    // below, so nothing already marked on a live box regresses to "new".
    let mirrors: std::collections::HashMap<String, crate::db::MirrorHead> = state
        .db
        .spotify_mirrors(caller.id)
        .into_iter()
        .map(|m| (m.key.clone(), m))
        .collect();

    let mut albums = Vec::new();
    let mut url = "https://api.spotify.com/v1/me/albums?limit=50".to_string();
    loop {
        let page = api_get(&state, caller.id, &http, &url)
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
        for item in page.get("items").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
            let Some(album) = item.get("album") else { continue };
            let id = album.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if id.is_empty() {
                continue;
            }
            albums.push(json!({
                "id": id,
                "synced": synced.contains_key(&format!("album:{id}")),
                "name": album.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled"),
                "artist": album.get("artists").and_then(|v| v.as_array()).and_then(|a| a.first())
                    .and_then(|a| a.get("name")).and_then(|v| v.as_str()).unwrap_or("Unknown artist"),
                "url": format!("https://open.spotify.com/album/{id}"),
                "tracks": album.get("total_tracks").and_then(|v| v.as_u64()).unwrap_or(0),
                "image": thumb(album),
            }));
        }
        match page.get("next").and_then(|v| v.as_str()) {
            Some(next) => url = next.to_string(),
            None => break,
        }
    }

    let mut playlists = Vec::new();
    let mut url = "https://api.spotify.com/v1/me/playlists?limit=50".to_string();
    loop {
        let page = api_get(&state, caller.id, &http, &url)
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
        for item in page.get("items").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if id.is_empty() {
                continue;
            }
            let snapshot_id = item.get("snapshot_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let key = format!("playlist:{id}");
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled");
            let owner_id = item
                .get("owner")
                .and_then(|o| o.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let owner = item
                .get("owner")
                .and_then(|o| o.get("display_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // Marked here so the row can say so up front, rather than letting
            // someone switch it on and collect a 403 a minute later.
            let spotify_owned = is_spotify_owned(owner_id);
            let image = thumb(item);
            // Remember what we just saw, so a watch toggle needs no second
            // round trip to learn the playlist's name or where it stands.
            let _ = state.db.spotify_mirror_seed(
                caller.id,
                &key,
                "playlist",
                &id,
                name,
                owner,
                image.as_deref().unwrap_or(""),
                &snapshot_id,
            );
            let mirror = mirrors.get(&key);
            let sync_state = match mirror {
                Some(m) if m.total > 0 => m.state.clone(),
                // No mirror yet: fall back to the pre-upgrade bookkeeping so a
                // box that already marked things synced keeps saying so.
                _ => match synced.get(&key) {
                    None => "new".to_string(),
                    Some(seen) if *seen == snapshot_id => "synced".to_string(),
                    Some(_) => "changed".to_string(),
                },
            };
            playlists.push(json!({
                "id": id,
                "state": sync_state,
                "name": name,
                "owner": owner,
                "url": format!("https://open.spotify.com/playlist/{id}"),
                "tracks": item.get("tracks").and_then(|t| t.get("total")).and_then(|v| v.as_u64()).unwrap_or(0),
                "image": image,
                // Informational only now. The authenticated read below does
                // not care whether a playlist is public, which is the whole
                // point of the mirror.
                "public": item.get("public").and_then(|v| v.as_bool()).unwrap_or(false),
                "snapshotId": snapshot_id,
                // Spotify's own lists cannot be read by third-party apps at
                // all; the row disables itself and explains rather than
                // offering a switch that can only fail.
                "spotifyOwned": spotify_owned,
                "unsupportedReason": if spotify_owned { json!(SPOTIFY_OWNED_NOTE) } else { json!(null) },
                "watch": mirror.map(|m| m.watch).unwrap_or(false),
                "playlistId": mirror.and_then(|m| m.playlist_id),
                "resolved": mirror.map(|m| m.resolved).unwrap_or(0),
                "queued": mirror.map(|m| m.queued).unwrap_or(0),
                "missing": mirror.map(|m| m.missing).unwrap_or(0),
            }));
        }
        match page.get("next").and_then(|v| v.as_str()) {
            Some(next) => url = next.to_string(),
            None => break,
        }
    }

    Ok(Json(json!({ "albums": albums, "playlists": playlists })))
}

#[derive(Deserialize)]
pub struct SyncedBody {
    pub items: Vec<SyncedItem>,
}

#[derive(Deserialize)]
pub struct SyncedItem {
    pub key: String,
    #[serde(default)]
    pub snapshot: String,
}

// --- the mirror's endpoints ------------------------------------------------

#[derive(Deserialize)]
pub struct WatchBody {
    pub items: Vec<WatchItem>,
}

#[derive(Deserialize)]
pub struct WatchItem {
    pub key: String,
    #[serde(default = "yes")]
    pub watch: bool,
}

fn yes() -> bool {
    true
}

/// `POST /api/spotify/watch` - start (or stop) keeping a collection in step.
/// This is the whole subscription: everything after it is the server's job.
pub async fn watch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WatchBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mut watched = 0;
    for item in &body.items {
        crate::spotify_sync::watch(&state, caller.id, &item.key, item.watch)
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
        // Carry over what the listing already knows, so the row reads with a
        // real name before its first enumeration finishes.
        if item.watch {
            watched += 1;
        }
    }
    Ok(Json(json!({ "ok": true, "watching": watched })))
}

#[derive(Deserialize)]
pub struct SyncBody {
    #[serde(default)]
    pub keys: Vec<String>,
    /// Re-enumerate even when the snapshot has not moved - the "something is
    /// wrong, rebuild it" button.
    #[serde(default)]
    pub full: bool,
}

/// `POST /api/spotify/sync` - run a pass now rather than at the next tick.
/// Returns immediately; progress is read from `GET /api/spotify/sync`.
pub async fn sync_now(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SyncBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let keys: Vec<String> = if body.keys.is_empty() {
        state
            .db
            .spotify_mirrors(caller.id)
            .into_iter()
            .filter(|m| m.watch)
            .map(|m| m.key)
            .collect()
    } else {
        body.keys.clone()
    };
    // Off the request thread: a full enumeration is many round trips and the
    // caller only needs to know it started.
    let bg = Arc::clone(&state);
    let full = body.full;
    let started = keys.len();
    tokio::spawn(async move {
        for key in keys {
            crate::spotify_sync::sync_one(&bg, caller.id, &key, full).await;
        }
    });
    Ok(Json(json!({ "ok": true, "started": started })))
}

fn mirror_json(m: &crate::db::MirrorHead) -> serde_json::Value {
    json!({
        "key": m.key,
        "kind": m.kind,
        "name": m.name,
        "owner": m.owner,
        "image": if m.image.is_empty() { serde_json::Value::Null } else { json!(m.image) },
        "playlistId": m.playlist_id,
        "watch": m.watch,
        "state": m.state,
        "error": m.error,
        "total": m.total,
        "resolved": m.resolved,
        "queued": m.queued,
        "missing": m.missing,
        "ambiguous": m.ambiguous,
        "changed": !m.head_snapshot.is_empty() && m.head_snapshot != m.snapshot,
        "checkedAt": m.checked_at,
        "syncedAt": m.synced_at,
    })
}

/// `GET /api/spotify/sync` - what every mirror is doing. Every number is read
/// from the database rather than from memory, so it survives a restart and
/// reads the same on every device.
pub async fn sync_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let mirrors = state.db.spotify_mirrors(caller.id);
    let mut totals = (0i64, 0i64, 0i64, 0i64, 0i64, 0i64);
    for m in mirrors.iter().filter(|m| m.watch) {
        totals.0 += 1;
        totals.1 += m.total;
        totals.2 += m.resolved;
        totals.3 += m.queued;
        totals.4 += m.missing;
        totals.5 += m.ambiguous;
    }
    let busy = mirrors
        .iter()
        .any(|m| matches!(m.state.as_str(), "enumerating" | "resolving" | "downloading"));
    Ok(Json(json!({
        "phase": if busy { "working" } else { "idle" },
        "totals": {
            "watched": totals.0,
            "tracks": totals.1,
            "resolved": totals.2,
            "queued": totals.3,
            "missing": totals.4,
            "ambiguous": totals.5,
        },
        "items": mirrors.iter().map(mirror_json).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct ItemsQuery {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// `GET /api/spotify/mirror/{key}/items` - the entry list, in upstream order.
/// What makes a partial sync inspectable rather than just a number.
pub async fn mirror_items(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(key): axum::extract::Path<String>,
    Query(q): Query<ItemsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let head = state
        .db
        .spotify_mirror(caller.id, &key)
        .ok_or((StatusCode::NOT_FOUND, "not mirrored".to_string()))?;
    let limit = q.limit.unwrap_or(500).min(2000);
    let items: Vec<serde_json::Value> = state
        .db
        .spotify_items(caller.id, &key)
        .into_iter()
        .filter(|i| q.state.is_empty() || i.state == q.state)
        .take(limit)
        .map(|i| {
            json!({
                "uid": i.track_uid,
                "occurrence": i.occurrence,
                "position": i.position,
                "title": i.title,
                "artist": i.artist,
                "album": i.album,
                "durationMs": i.duration_ms,
                "state": i.state,
                "trackId": i.track_id,
                "method": i.match_method,
                "note": i.note,
                "attempts": i.attempts,
            })
        })
        .collect();
    Ok(Json(json!({ "mirror": mirror_json(&head), "items": items })))
}

/// `POST /api/spotify/mirror/{key}/retry` - clear the backoff on everything
/// this mirror gave up on and try again.
pub async fn mirror_retry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(key): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .spotify_items_retry(caller.id, &key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let bg = Arc::clone(&state);
    let bg_key = key.clone();
    tokio::spawn(async move {
        crate::spotify_sync::sync_one(&bg, caller.id, &bg_key, false).await;
    });
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/spotify/mirror/{key}/forget` - stop mirroring and drop the
/// bookkeeping. The local playlist and every downloaded file stay.
pub async fn mirror_forget(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(key): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .spotify_mirror_forget(caller.id, &key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/spotify/synced` - records finished downloads so the next
/// library read reports them synced.
pub async fn mark_synced(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SyncedBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    for item in body.items {
        state
            .db
            .spotify_mark_synced(caller.id, &item.key, &item.snapshot)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(Json(json!({ "ok": true })))
}
