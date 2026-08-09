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

fn http_client() -> Result<reqwest::Client, (StatusCode, String)> {
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
async fn access_token(
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
async fn api_get(
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
            return Err(format!("Spotify API error ({status})"));
        }
        return response
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Spotify response unreadable: {e}"));
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
    Ok(Json(json!({
        "connected": account.as_ref().map(|a| !a.refresh_token.is_empty()).unwrap_or(false),
        "displayName": account.as_ref().and_then(|a| a.display_name.clone()),
        "clientId": account.as_ref().map(|a| a.client_id.clone()).filter(|c| !c.is_empty()),
        "redirectUri": redirect,
    })))
}

#[derive(Deserialize)]
pub struct ConnectBody {
    #[serde(rename = "clientId")]
    pub client_id: String,
}

/// `POST /api/spotify/connect` - parks a login and returns the authorize URL.
pub async fn connect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ConnectBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let client_id = body.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Enter your Spotify app's Client ID first.".into()));
    }
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
            let sync_state = match synced.get(&format!("playlist:{id}")) {
                None => "new",
                Some(seen) if *seen == snapshot_id => "synced",
                Some(_) => "changed",
            };
            playlists.push(json!({
                "id": id,
                "state": sync_state,
                "name": item.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled"),
                "owner": item.get("owner").and_then(|o| o.get("display_name")).and_then(|v| v.as_str()).unwrap_or(""),
                "url": format!("https://open.spotify.com/playlist/{id}"),
                "tracks": item.get("tracks").and_then(|t| t.get("total")).and_then(|v| v.as_u64()).unwrap_or(0),
                "image": thumb(item),
                // Spotify reports null for collaborative playlists; anything
                // short of an explicit true reads as private here.
                "public": item.get("public").and_then(|v| v.as_bool()).unwrap_or(false),
                "snapshotId": snapshot_id,
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
