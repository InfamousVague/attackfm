//! The Spotify account: login, library, and sync bookkeeping.
//!
//! The import pipeline (music.rs) already turns any album or playlist URL
//! into files in the library; this module is the missing account layer that
//! produces those URLs from the user's own Spotify. It owns:
//!
//! - **Login**: Authorization Code + PKCE, the public-client flow - no
//!   secret anywhere. The user supplies their own Client ID (a free app on
//!   developer.spotify.com); the browser does the consenting; a loopback
//!   listener on 127.0.0.1:8898 catches the redirect. The listener accepts
//!   in a loop and answers only the request carrying this login's state -
//!   stray hits (browser preconnects, favicon probes, anything local that
//!   pokes the port) get a 404 and cost nothing. Tokens never reach the
//!   webview; the refresh token lives in a 0600 file under the app data dir.
//! - **Library**: saved albums and playlists, paged fully off the Web API,
//!   with 401s re-authing once and 429s honouring Retry-After.
//! - **Sync bookkeeping**: which albums and playlist snapshots have been
//!   imported. The frontend enqueues through the existing pipeline and marks
//!   items here once their download actually finishes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The fixed loopback redirect. Spotify requires the exact URI to be
/// registered on the app, so it cannot float to a free port; the UI tells
/// the user to add this one.
const REDIRECT_URI: &str = "http://127.0.0.1:8898/callback";
const REDIRECT_PORT: u16 = 8898;

/// Everything the account layer needs to read the user's library.
const SCOPES: &str = "user-library-read playlist-read-private playlist-read-collaborative";

/// How long the browser roundtrip may take before connect gives up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);

/// How long one loopback connection may dawdle before it is dropped - an
/// idle socket must not pin the whole login window.
const REDIRECT_READ_TIMEOUT: Duration = Duration::from_secs(10);

// ============================================================================
// Stored state
// ============================================================================

#[derive(Serialize, Deserialize, Clone, Default)]
struct StoredAuth {
    client_id: String,
    refresh_token: String,
    #[serde(default)]
    access_token: Option<String>,
    /// Unix seconds the access token dies at.
    #[serde(default)]
    expires_at: u64,
    #[serde(default)]
    display_name: Option<String>,
    /// What has been imported: "album:{id}" -> "", and "playlist:{id}" ->
    /// the snapshot_id it was synced at.
    #[serde(default)]
    synced: HashMap<String, String>,
}

pub struct SpotifyAccount {
    store_path: PathBuf,
    auth: tokio::sync::Mutex<Option<StoredAuth>>,
    http: reqwest::Client,
    /// Held for the duration of a login roundtrip, so a second connect while
    /// one is pending fails with an honest message instead of a port error.
    connect_gate: tokio::sync::Mutex<()>,
}

impl SpotifyAccount {
    /// Persists the account atomically (temp file + rename) with owner-only
    /// permissions - the refresh token grants the library scopes for as long
    /// as the user doesn't revoke the app, so it is treated as a credential.
    fn save(&self, auth: &Option<StoredAuth>) -> Result<(), String> {
        let Some(auth) = auth else {
            let _ = std::fs::remove_file(&self.store_path);
            return Ok(());
        };
        let json = serde_json::to_string(auth)
            .map_err(|e| format!("Could not serialize the Spotify account: {e}"))?;

        let tmp = self.store_path.with_extension("tmp");
        {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            let mut file = options
                .open(&tmp)
                .map_err(|e| format!("Could not write the Spotify account store: {e}"))?;
            file.write_all(json.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|e| format!("Could not write the Spotify account store: {e}"))?;
        }
        std::fs::rename(&tmp, &self.store_path)
            .map_err(|e| format!("Could not write the Spotify account store: {e}"))?;
        // Files created 0644 by older builds get tightened on their next save.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &self.store_path,
                std::fs::Permissions::from_mode(0o600),
            );
        }
        Ok(())
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ============================================================================
// Wire types the frontend sees (camelCase)
// ============================================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStatus {
    pub connected: bool,
    pub display_name: Option<String>,
    pub client_id: Option<String>,
    pub redirect_uri: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyAlbum {
    pub id: String,
    pub name: String,
    pub artist: String,
    pub url: String,
    pub tracks: u32,
    pub image: Option<String>,
    pub synced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyPlaylist {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub url: String,
    pub tracks: u32,
    pub image: Option<String>,
    pub snapshot_id: String,
    /// Whether Spotify reports the playlist as public. The importer reads
    /// public pages, so a private playlist cannot be fetched - the UI says
    /// so instead of offering a sync that would fail.
    pub public: bool,
    /// "new" (never synced), "changed" (snapshot moved), or "synced".
    pub state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyLibrary {
    pub albums: Vec<SpotifyAlbum>,
    pub playlists: Vec<SpotifyPlaylist>,
}

#[derive(Deserialize)]
pub struct SyncedItem {
    pub key: String,
    #[serde(default)]
    pub snapshot: String,
}

// ============================================================================
// Token plumbing
// ============================================================================

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
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Spotify refused the token request ({status}): {body}"));
    }
    response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("Spotify token response unreadable: {e}"))
}

/// A live access token, refreshed through the stored refresh token when the
/// cached one has under a minute left. Spotify may rotate the refresh token
/// on use; the rotation is persisted before the token is handed back, and a
/// persistence failure is an error - losing a rotated refresh token would
/// brick the login at the next refresh.
async fn access_token(account: &SpotifyAccount, force_refresh: bool) -> Result<String, String> {
    let mut guard = account.auth.lock().await;
    let auth = guard.as_mut().ok_or("Not connected to Spotify.")?;

    if !force_refresh {
        if let Some(token) = &auth.access_token {
            if auth.expires_at > now_secs() + 60 {
                return Ok(token.clone());
            }
        }
    }

    let refreshed = exchange_token(
        &account.http,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &auth.refresh_token.clone()),
            ("client_id", &auth.client_id.clone()),
        ],
    )
    .await?;

    auth.access_token = Some(refreshed.access_token.clone());
    auth.expires_at = now_secs() + refreshed.expires_in;
    if let Some(rotated) = refreshed.refresh_token {
        auth.refresh_token = rotated;
    }
    account.save(&guard)?;
    Ok(refreshed.access_token)
}

/// GET one Web API page as JSON. A 401 re-auths once (the cached token may
/// have been revoked early); a 429 sleeps out Retry-After (capped) and tries
/// again, twice, before giving up - a big library pages enough to meet one.
async fn api_get(account: &SpotifyAccount, url: &str) -> Result<serde_json::Value, String> {
    let mut token = access_token(account, false).await?;
    let mut reauthed = false;
    let mut retries = 0u8;
    loop {
        let response = account
            .http
            .get(url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("Spotify request failed: {e}"))?;

        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED && !reauthed {
            reauthed = true;
            token = access_token(account, true).await?;
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
            return Err(format!("Spotify API error ({status}) at {url}"));
        }
        return response
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Spotify response unreadable: {e}"));
    }
}

// ============================================================================
// The loopback catch
// ============================================================================

/// Accepts until the request carrying this login's state arrives; everything
/// else - browser preconnects, favicon probes, anything local poking the
/// port - is answered 404 (or dropped) and costs nothing. Only the genuine
/// callback gets the "return to the app" page.
async fn catch_redirect(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Login listener failed: {e}"))?;

        // Read to the end of the request line (or 8KB, or 10s), tolerating a
        // fragmented first segment; an idle socket is dropped, not waited on.
        let mut buffer = Vec::with_capacity(2048);
        let request_line = {
            let read_all = async {
                let mut chunk = [0u8; 1024];
                loop {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                    if buffer.windows(2).any(|w| w == b"\r\n") || buffer.len() > 8192 {
                        break;
                    }
                }
            };
            let _ = tokio::time::timeout(REDIRECT_READ_TIMEOUT, read_all).await;
            String::from_utf8_lossy(&buffer)
                .lines()
                .next()
                .unwrap_or_default()
                .to_string()
        };

        // "GET /callback?code=...&state=... HTTP/1.1"
        let target = request_line.split_whitespace().nth(1).unwrap_or_default();
        let is_callback = request_line.starts_with("GET ") && target.starts_with("/callback");
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or_default();
        let state_matches =
            query_param(query, "state").as_deref() == Some(expected_state);

        if is_callback && state_matches {
            let page = concat!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nconnection: close\r\n\r\n",
                "<!doctype html><meta charset=\"utf-8\"><title>AttackFM</title>",
                "<body style=\"font-family:system-ui;background:#0f0f10;color:#eee;",
                "display:grid;place-items:center;height:100vh;margin:0\">",
                "<div style=\"text-align:center\"><h2>Connected</h2>",
                "<p>You can close this tab and return to AttackFM.</p></div>",
            );
            let _ = stream.write_all(page.as_bytes()).await;
            let _ = stream.shutdown().await;
            return Ok(query.to_string());
        }

        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n")
            .await;
        let _ = stream.shutdown().await;
    }
}

/// One value out of an application/x-www-form-urlencoded query string.
fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key != name {
            return None;
        }
        let decoded = value.replace('+', " ");
        // Percent-decoding, minimally: auth codes and states are URL-safe,
        // so only the escapes Spotify actually emits need handling.
        let mut out = String::with_capacity(decoded.len());
        let mut chars = decoded.chars();
        while let Some(c) = chars.next() {
            if c == '%' {
                let hex: String = chars.by_ref().take(2).collect();
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    out.push(byte as char);
                }
            } else {
                out.push(c);
            }
        }
        Some(out)
    })
}

// ============================================================================
// Commands
// ============================================================================

fn status_from(auth: &Option<StoredAuth>) -> SpotifyStatus {
    SpotifyStatus {
        connected: auth.as_ref().map(|a| !a.refresh_token.is_empty()).unwrap_or(false),
        display_name: auth.as_ref().and_then(|a| a.display_name.clone()),
        client_id: auth
            .as_ref()
            .map(|a| a.client_id.clone())
            .filter(|id| !id.is_empty()),
        redirect_uri: REDIRECT_URI.to_string(),
    }
}

#[tauri::command]
pub async fn spotify_status(
    account: tauri::State<'_, SpotifyAccount>,
) -> Result<SpotifyStatus, String> {
    Ok(status_from(&*account.auth.lock().await))
}

/// The whole login roundtrip: bind the loopback, open the browser, catch the
/// redirect, trade the code for tokens, learn the display name, persist.
/// Resolves when the user has finished (or after five minutes of nothing).
#[tauri::command]
pub async fn spotify_connect(
    app: AppHandle,
    account: tauri::State<'_, SpotifyAccount>,
    client_id: String,
) -> Result<SpotifyStatus, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("Enter your Spotify app's Client ID first.".into());
    }

    // One login at a time: a second attempt while the browser roundtrip is
    // pending gets told so, rather than a baffling port error.
    let Ok(_gate) = account.connect_gate.try_lock() else {
        return Err(
            "A Spotify login is already waiting on the browser - finish it there, or wait for it to time out."
                .into(),
        );
    };

    // Bound before the browser opens: a redirect with nobody listening is a
    // browser error page and a confused user.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .await
        .map_err(|_| {
            format!("Port {REDIRECT_PORT} is in use - close whatever holds it and try again.")
        })?;

    let mut verifier_bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let verifier = b64url(&verifier_bytes);
    let challenge = b64url(&sha2::Sha256::digest(verifier.as_bytes()));
    let mut state_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut state_bytes);
    let state = b64url(&state_bytes);

    let auth_url = format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&state={}&code_challenge_method=S256&code_challenge={}",
        urlencode(&client_id),
        urlencode(SCOPES),
        urlencode(REDIRECT_URI),
        urlencode(&state),
        urlencode(&challenge),
    );

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(auth_url, None::<&str>)
            .map_err(|e| format!("Could not open the browser: {e}"))?;
    }

    // Only a request carrying this login's state ever comes back from the
    // catch, so everything in the query is Spotify's answer to us.
    let query = tokio::time::timeout(CONNECT_TIMEOUT, catch_redirect(listener, &state))
        .await
        .map_err(|_| "Spotify login timed out - try connecting again.".to_string())??;

    if let Some(error) = query_param(&query, "error") {
        // Known codes get their own words; anything else is not reflected -
        // the value rode a local URL and is not ours to print.
        return Err(match error.as_str() {
            "access_denied" => "Spotify login was declined.".to_string(),
            _ => "Spotify declined the login.".to_string(),
        });
    }
    let code = query_param(&query, "code").ok_or("Spotify sent no code back.")?;

    let tokens = exchange_token(
        &account.http,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", &client_id),
            ("code_verifier", &verifier),
        ],
    )
    .await?;
    let refresh_token = tokens
        .refresh_token
        .ok_or("Spotify sent no refresh token; check the app's settings.")?;

    // The display name is a nicety - a profile fetch that fails must not
    // fail the login it decorates.
    let display_name = api_get_profile(&account, &tokens.access_token).await;

    let mut guard = account.auth.lock().await;
    let previous_synced = guard.take().map(|a| a.synced).unwrap_or_default();
    *guard = Some(StoredAuth {
        client_id,
        refresh_token,
        access_token: Some(tokens.access_token),
        expires_at: now_secs() + tokens.expires_in,
        display_name,
        synced: previous_synced,
    });
    account.save(&guard)?;
    Ok(status_from(&guard))
}

async fn api_get_profile(account: &SpotifyAccount, token: &str) -> Option<String> {
    let response = account
        .http
        .get("https://api.spotify.com/v1/me")
        .bearer_auth(token)
        .send()
        .await
        .ok()?;
    let profile = response.json::<serde_json::Value>().await.ok()?;
    profile
        .get("display_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Forgets the tokens but keeps the sync bookkeeping and the client id, so a
/// reconnect picks up where the account left off instead of re-listing the
/// whole library as new.
#[tauri::command]
pub async fn spotify_disconnect(account: tauri::State<'_, SpotifyAccount>) -> Result<(), String> {
    let mut guard = account.auth.lock().await;
    if let Some(auth) = guard.as_mut() {
        auth.refresh_token = String::new();
        auth.access_token = None;
        auth.expires_at = 0;
        auth.display_name = None;
    }
    account.save(&guard)
}

/// Spotify orders `images` largest first; the second-smallest is the ~300px
/// variant - crisp on a retina row without paying for the 640px original.
fn thumb(value: &serde_json::Value) -> Option<String> {
    let images = value.get("images").and_then(|v| v.as_array())?;
    let pick = if images.len() >= 2 { images.get(images.len() - 2) } else { images.last() };
    pick.and_then(|img| img.get("url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// The user's saved albums and playlists, fully paged, each stamped with its
/// sync state against the bookkeeping.
#[tauri::command]
pub async fn spotify_library(
    account: tauri::State<'_, SpotifyAccount>,
) -> Result<SpotifyLibrary, String> {
    let synced = account
        .auth
        .lock()
        .await
        .as_ref()
        .map(|a| a.synced.clone())
        .unwrap_or_default();

    let mut albums = Vec::new();
    let mut url = "https://api.spotify.com/v1/me/albums?limit=50".to_string();
    loop {
        let page = api_get(&account, &url).await?;
        for item in page.get("items").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
            let Some(album) = item.get("album") else { continue };
            let id = album.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if id.is_empty() {
                continue;
            }
            albums.push(SpotifyAlbum {
                synced: synced.contains_key(&format!("album:{id}")),
                name: album.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string(),
                artist: album
                    .get("artists")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|a| a.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown artist")
                    .to_string(),
                url: format!("https://open.spotify.com/album/{id}"),
                tracks: album.get("total_tracks").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                image: thumb(album),
                id,
            });
        }
        match page.get("next").and_then(|v| v.as_str()) {
            Some(next) => url = next.to_string(),
            None => break,
        }
    }

    let mut playlists = Vec::new();
    let mut url = "https://api.spotify.com/v1/me/playlists?limit=50".to_string();
    loop {
        let page = api_get(&account, &url).await?;
        for item in page.get("items").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if id.is_empty() {
                continue;
            }
            let snapshot_id = item
                .get("snapshot_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let state = match synced.get(&format!("playlist:{id}")) {
                None => "new",
                Some(seen) if *seen == snapshot_id => "synced",
                Some(_) => "changed",
            };
            playlists.push(SpotifyPlaylist {
                state: state.to_string(),
                name: item.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string(),
                owner: item
                    .get("owner")
                    .and_then(|o| o.get("display_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                url: format!("https://open.spotify.com/playlist/{id}"),
                tracks: item
                    .get("tracks")
                    .and_then(|t| t.get("total"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                image: thumb(item),
                // Spotify reports null for collaborative playlists; anything
                // short of an explicit true reads as private here.
                public: item.get("public").and_then(|v| v.as_bool()).unwrap_or(false),
                snapshot_id,
                id,
            });
        }
        match page.get("next").and_then(|v| v.as_str()) {
            Some(next) => url = next.to_string(),
            None => break,
        }
    }

    Ok(SpotifyLibrary { albums, playlists })
}

/// Records items whose downloads have finished, so the next library read
/// reports them synced. Albums carry an empty snapshot; playlists the
/// snapshot_id they were synced at.
#[tauri::command]
pub async fn spotify_mark_synced(
    account: tauri::State<'_, SpotifyAccount>,
    items: Vec<SyncedItem>,
) -> Result<(), String> {
    let mut guard = account.auth.lock().await;
    let auth = guard.as_mut().ok_or("Not connected to Spotify.")?;
    for item in items {
        auth.synced.insert(item.key, item.snapshot);
    }
    account.save(&guard)
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

// ============================================================================
// Setup
// ============================================================================

/// Load the persisted account (if any) and register the state. Call from the
/// Tauri `setup` hook, after music::init has ensured the data dir exists.
pub fn init(app: &AppHandle) {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let store_path = data_dir.join("spotify-account.json");

    // A store that reads but does not parse is set aside, not clobbered:
    // the bytes may be worth recovering, and the app still boots signed out.
    let auth = match std::fs::read_to_string(&store_path) {
        Ok(data) => match serde_json::from_str::<StoredAuth>(&data) {
            Ok(parsed) => Some(parsed),
            Err(err) => {
                eprintln!("spotify: account store unreadable ({err}); setting it aside");
                let _ = std::fs::rename(&store_path, store_path.with_extension("corrupt"));
                None
            }
        },
        Err(_) => None,
    };

    app.manage(SpotifyAccount {
        store_path,
        auth: tokio::sync::Mutex::new(auth),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new()),
        connect_gate: tokio::sync::Mutex::new(()),
    });
}
