//! Audible: connect the owner's Audible account to the hub, so the server can
//! download the books they own and file them into the shared library.
//!
//! The login is Amazon's, not ours. We never see a password: the browser does
//! the whole sign-in on Amazon's own page (CAPTCHA, 2FA and all), lands on a
//! page that does not resolve, and the user pastes that final URL back. Behind
//! that paste is Audible's "external login" — the same flow audible-cli and
//! Audiobookshelf use — which turns the URL's one-time authorization code into
//! device tokens. Those tokens (not the password) live in the config dir, the
//! way a Spotify refresh token lives in `spotify_accounts`.
//!
//! Because the sign-in is a two-step conversation (hand out a URL, then take
//! the pasted response), the Python that drives it is a SINGLE long-lived
//! child held between the two requests: it prints the login URL and blocks on
//! stdin for the response URL, exactly as `Authenticator.from_login_external`
//! wants its `login_url_callback` to behave.
//!
//! | Route | What it does |
//! |---|---|
//! | GET  /api/audible/status         | tools present? account connected? as whom? |
//! | POST /api/audible/login/start    | begin a login, hand back `{loginUrl, token}` |
//! | POST /api/audible/login/complete | `{token, responseUrl}` — finish, store tokens |
//! | POST /api/audible/logout         | forget the stored account |

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::{auth, scan, AppState};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- Locating the tools ------------------------------------------------------

/// The `audible` (audible-cli) shim: an override, then PATH, then the pipx
/// default — the same ladder the SpotiFLAC importer climbs for its own binary.
pub fn find_audible() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AFM_AUDIBLE") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("audible");
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let cand = PathBuf::from(home).join(".local/bin/audible");
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

/// The Python inside audible-cli's pipx venv — the one that can `import audible`.
/// Derived from the shim (`<home>/.local/bin/audible` ->
/// `<home>/.local/pipx/venvs/audible-cli/bin/python3` on Linux or
/// `<home>/Library/Application Support/pipx/venvs/audible-cli/bin/python3` on macOS,
/// mirroring
/// `search::spotiflac_python`.
pub fn audible_python() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AFM_AUDIBLE_PYTHON") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Some(bin) = find_audible() {
        if let Some(local) = bin.parent().and_then(|p| p.parent()) {
            let candidates = [
                local.join("pipx/venvs/audible-cli/bin/python3"),
                local.join("Library/Application Support/pipx/venvs/audible-cli/bin/python3"),
            ];
            for py in candidates {
                if py.exists() {
                    return Some(py);
                }
            }
        }
    }
    let fallback = PathBuf::from("/opt/attackfm/.local/pipx/venvs/audible-cli/bin/python3");
    fallback.exists().then_some(fallback)
}

// --- State -------------------------------------------------------------------

/// A login in flight: the child that holds Amazon's conversation open, waiting
/// for the pasted response URL on its stdin.
struct LoginSession {
    token: String,
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    started_at: i64,
}

/// The owner's Audible connection. One account for the whole hub (owner-level,
/// like the Spotify Canvas cookie), so this is a config dir plus whatever login
/// is mid-conversation — no per-user rows.
pub struct AudibleState {
    /// `AUDIBLE_CONFIG_DIR`: holds `audible.json` (the device tokens) and the
    /// `config.toml` that later lets audible-cli find them.
    pub config_dir: PathBuf,
    /// A writable HOME for the child, since the real one may be read-only.
    home: PathBuf,
    /// Where a download is assembled before it is filed into the library.
    stage: PathBuf,
    login: tokio::sync::Mutex<Option<LoginSession>>,
    /// The download queue, serialised by `worker` one book at a time - a book
    /// is a big, human-paced errand, exactly like the LibriVox queue.
    jobs: tokio::sync::Mutex<Vec<AudibleJob>>,
    worker: tokio::sync::Mutex<()>,
    /// The account's AAX activation bytes, fetched once and kept: they are a
    /// per-account constant, the key every AAX book is unlocked with.
    activation: tokio::sync::Mutex<Option<String>>,
}

impl AudibleState {
    pub fn new(data_dir: &Path) -> Self {
        let config_dir = std::env::var("AFM_AUDIBLE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("audible"));
        let home = data_dir.join("audible-home");
        let stage = data_dir.join("audible-stage");
        AudibleState {
            config_dir,
            home,
            stage,
            login: tokio::sync::Mutex::new(None),
            jobs: tokio::sync::Mutex::new(Vec::new()),
            worker: tokio::sync::Mutex::new(()),
            activation: tokio::sync::Mutex::new(None),
        }
    }

    /// The device-token file. Its presence is the whole definition of
    /// "connected" — no tokens, no account.
    fn auth_file(&self) -> PathBuf {
        self.config_dir.join("audible.json")
    }

    fn name_file(&self) -> PathBuf {
        self.config_dir.join("display_name.txt")
    }

    pub fn connected(&self) -> bool {
        self.auth_file().exists()
    }
}

/// The Python that runs the whole external login. It prints the login URL (so
/// the server can hand it to the browser), blocks on stdin for the response URL
/// the user pastes back, then registers and writes the device tokens. Every
/// line it prints is one JSON object, so the Rust side reads line by line.
const LOGIN_PY: &str = r#"
import sys, os, json, audible

locale = sys.argv[1]
config_file = sys.argv[2]

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def login_url_callback(login_url):
    # Hand the URL out, then wait for the pasted response URL on stdin.
    emit({"loginUrl": login_url})
    line = sys.stdin.readline()
    if not line:
        raise SystemExit("no response url")
    return line.strip()

try:
    auth = audible.Authenticator.from_login_external(
        locale=locale, login_url_callback=login_url_callback
    )
except SystemExit:
    raise
except Exception as e:
    emit({"ok": False, "error": str(e)})
    raise SystemExit(1)

try:
    os.makedirs(os.path.dirname(config_file), exist_ok=True)
    auth.to_file(config_file, encryption=False)
except Exception as e:
    emit({"ok": False, "error": "could not save tokens: %s" % e})
    raise SystemExit(1)

name = None
try:
    ci = auth.customer_info
    if isinstance(ci, dict):
        name = ci.get("name") or ci.get("given_name")
except Exception:
    name = None

emit({"ok": True, "name": name})
"#;

/// The config.toml audible-cli reads to find the tokens later — written once the
/// login lands, pointing at the auth file we just saved.
fn write_config_toml(config_dir: &Path, locale: &str) -> std::io::Result<()> {
    let toml = format!(
        "title = \"Audible Config File\"\n\n[APP]\nprimary_profile = \"attackfm\"\n\n[profile.attackfm]\nauth_file = \"audible.json\"\ncountry_code = \"{locale}\"\n"
    );
    std::fs::write(config_dir.join("config.toml"), toml)
}

// --- Handlers ----------------------------------------------------------------

/// `GET /api/audible/status` — whether the server can do this at all (tools
/// installed) and whether an account is connected. Any signed-in caller may
/// ask; the download UI reads it to know what to show.
pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let tools = audible_python().is_some();
    let connected = state.audible.connected();
    let name = std::fs::read_to_string(state.audible.name_file())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(Json(json!({
        "toolsInstalled": tools,
        "connected": connected,
        "name": name,
    })))
}

#[derive(Deserialize)]
pub struct StartBody {
    /// Audible marketplace: us, uk, de, fr, ca, au, in, it, es, jp, br. The
    /// account is tied to one; default the common case.
    #[serde(default = "default_locale")]
    pub locale: String,
}

fn default_locale() -> String {
    "us".into()
}

/// `POST /api/audible/login/start` — begin a login. Owner-only: this binds the
/// server to a personal Amazon account. Spawns the login child, reads the URL
/// it emits, and parks the child (still holding Amazon's page open) keyed by a
/// token the caller returns to us when they paste the response URL back.
pub async fn login_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<StartBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;

    let Some(py) = audible_python() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Audible tools aren't installed on the server. Run `pipx install audible-cli` on the hub.".into(),
        ));
    };

    let locale = sanitize_locale(&body.locale);
    if let Err(e) = std::fs::create_dir_all(&state.audible.home) {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("cannot prepare a workspace: {e}")));
    }
    let _ = std::fs::create_dir_all(&state.audible.config_dir);

    let auth_file = state.audible.auth_file();
    let mut cmd = tokio::process::Command::new(&py);
    cmd.arg("-c")
        .arg(LOGIN_PY)
        .arg(&locale)
        .arg(&auth_file)
        .env("HOME", &state.audible.home)
        .env("AUDIBLE_CONFIG_DIR", &state.audible.config_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("could not start the login: {e}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "no stdin".into()))?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "no stdout".into()))?,
    );

    // The first line the child prints is the login URL (or an error object).
    let mut line = String::new();
    let read = tokio::time::timeout(Duration::from_secs(30), stdout.read_line(&mut line)).await;
    let login_url = match read {
        Ok(Ok(n)) if n > 0 => {
            let v: Value = serde_json::from_str(line.trim()).unwrap_or_else(|_| json!({}));
            if let Some(url) = v.get("loginUrl").and_then(|x| x.as_str()) {
                url.to_string()
            } else {
                let _ = child.kill().await;
                let msg = v
                    .get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("Audible refused to start a login")
                    .to_string();
                return Err((StatusCode::BAD_GATEWAY, msg));
            }
        }
        _ => {
            let _ = child.kill().await;
            return Err((
                StatusCode::BAD_GATEWAY,
                "the Audible login tool did not answer — is `audible` installed in its venv?".into(),
            ));
        }
    };

    let token = format!("al-{}-{}", now_ms(), std::process::id());
    // Replace (and drop → kill) any earlier half-finished login.
    {
        let mut guard = state.audible.login.lock().await;
        *guard = Some(LoginSession {
            token: token.clone(),
            child,
            stdin,
            stdout,
            started_at: now_ms(),
        });
    }

    Ok(Json(json!({
        "loginUrl": login_url,
        "token": token,
        "locale": locale,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteBody {
    pub token: String,
    /// The whole URL of the page the browser landed on after signing in — the
    /// one that would not load. It carries the one-time authorization code.
    pub response_url: String,
    #[serde(default = "default_locale")]
    pub locale: String,
}

/// `POST /api/audible/login/complete` — finish the parked login. Feeds the
/// pasted response URL to the waiting child, which registers with Amazon and
/// writes the device tokens; on success we drop the config.toml beside them so
/// audible-cli can use them later.
pub async fn login_complete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CompleteBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;

    let response_url = body.response_url.trim().to_string();
    if response_url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "paste the URL you landed on after signing in".into()));
    }

    // Take the parked session only if the token matches; otherwise leave it be.
    let mut session = {
        let mut guard = state.audible.login.lock().await;
        match guard.as_ref() {
            Some(s) if s.token == body.token => guard.take().unwrap(),
            _ => {
                return Err((
                    StatusCode::GONE,
                    "that login has expired — start connecting again".into(),
                ))
            }
        }
    };

    // Amazon's authorization code is short-lived; a login left parked too long
    // will only fail at register, so turn it away here with a clearer word.
    if now_ms() - session.started_at > 10 * 60 * 1000 {
        let _ = session.child.kill().await;
        return Err((StatusCode::GONE, "that login took too long — start connecting again".into()));
    }

    // Hand the child the response URL and wait for its verdict. Registration is
    // a round-trip to Amazon, so give it room.
    if let Err(e) = session.stdin.write_all(format!("{response_url}\n").as_bytes()).await {
        let _ = session.child.kill().await;
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("could not talk to the login: {e}")));
    }
    let _ = session.stdin.flush().await;

    let mut line = String::new();
    let read = tokio::time::timeout(Duration::from_secs(120), session.stdout.read_line(&mut line)).await;
    let _ = session.child.wait().await;

    let v: Value = match read {
        Ok(Ok(n)) if n > 0 => serde_json::from_str(line.trim()).unwrap_or_else(|_| json!({})),
        _ => {
            return Err((
                StatusCode::BAD_GATEWAY,
                "the Audible login did not finish — the pasted URL may be wrong or expired".into(),
            ))
        }
    };

    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        let msg = v
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("Audible would not accept that sign-in")
            .to_string();
        return Err((StatusCode::BAD_GATEWAY, msg));
    }

    let locale = sanitize_locale(&body.locale);
    let _ = write_config_toml(&state.audible.config_dir, &locale);
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let _ = std::fs::write(state.audible.name_file(), &name);

    Ok(Json(json!({
        "connected": true,
        "name": if name.is_empty() { Value::Null } else { json!(name) },
    })))
}

/// `POST /api/audible/logout` — forget the account. Owner-only. Removes the
/// tokens; the books already downloaded stay in the library, they just stop
/// being refreshable from Audible.
pub async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    let _ = std::fs::remove_file(state.audible.auth_file());
    let _ = std::fs::remove_file(state.audible.name_file());
    let _ = std::fs::remove_file(state.audible.config_dir.join("config.toml"));
    // Drop any login mid-conversation too.
    *state.audible.login.lock().await = None;
    Ok(Json(json!({ "connected": false })))
}

/// A marketplace code, reduced to letters and lowercased — never trusted into a
/// command line or a path without this.
fn sanitize_locale(s: &str) -> String {
    let cleaned: String = s.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    if cleaned.is_empty() { "us".into() } else { cleaned.to_lowercase() }
}

/// A path segment that cannot escape or upset the filesystem — same rules the
/// LibriVox filer uses, so the two shelves sit side by side under Audiobooks.
fn safe_segment(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = trimmed.trim_matches('.').trim().to_string();
    if trimmed.is_empty() { "Untitled".into() } else { trimmed }
}

// --- The library and the download queue --------------------------------------

/// One owned book, trimmed to what a browse card needs. `ownedLocally` is true
/// once the book is already filed in the library, so the card shows "In library"
/// instead of an Add button.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudibleBook {
    pub asin: String,
    pub title: String,
    pub author: String,
    pub cover: Option<String>,
    pub runtime_min: Option<i64>,
    pub percent_complete: Option<f64>,
    pub owned_locally: bool,
    /// When it was bought, as Audible reports it. Carried so the newest thing
    /// you own can lead the list - which is what somebody opening this is
    /// almost always looking for, and what a library sorted by whatever order
    /// the export happened to emit never gives them.
    pub purchase_date: Option<String>,
}

/// One download, in flight or finished. camelCase for the client.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudibleJob {
    pub id: String,
    pub asin: String,
    pub title: String,
    pub author: String,
    pub cover: Option<String>,
    /// queued | downloading | decrypting | filing | done | error
    pub state: String,
    pub error: Option<String>,
    pub created_at: i64,
    /// The indexed track once it lands, so a client can jump straight to it.
    pub track_id: Option<i64>,
}

async fn set_job(state: &Arc<AppState>, id: &str, f: impl FnOnce(&mut AudibleJob)) {
    let mut jobs = state.audible.jobs.lock().await;
    if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
        f(j);
    }
}

/// The rel_path a given book files to — the one place the naming lives, so the
/// worker, the "already have it" check, and any future re-download all agree.
fn book_rel_path(music_root: &std::path::Path, author: &str, title: &str) -> String {
    let a = safe_segment(author);
    let t = safe_segment(title);
    // The folder as it exists - see ingest::audiobooks_component.
    let books = crate::ingest::audiobooks_component(music_root);
    format!("{books}/{a}/{t}/{t}.m4b")
}

/// A ready-to-run audible-cli command, pointed at the owner's config with a
/// writable HOME. `None` when the tool is not installed.
fn audible_command(state: &Arc<AppState>) -> Option<tokio::process::Command> {
    let bin = find_audible()?;
    let mut cmd = tokio::process::Command::new(bin);
    cmd.env("HOME", &state.audible.home)
        .env("AUDIBLE_CONFIG_DIR", &state.audible.config_dir);
    Some(cmd)
}

/// `GET /api/audible/library` — the books you own, so the downloader can list
/// them. Any signed-in caller may read it; downloading is a separate step.
pub async fn library(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if !state.audible.connected() {
        return Ok(Json(json!({ "connected": false, "books": [] })));
    }
    let Some(mut cmd) = audible_command(&state) else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "Audible tools aren't installed on the server.".into()));
    };

    let _ = tokio::fs::create_dir_all(&state.audible.stage).await;
    let out_path = state.audible.stage.join(format!("library-{}.json", now_ms()));
    cmd.arg("library")
        .arg("export")
        .arg("--format")
        .arg("json")
        .arg("-o")
        .arg(&out_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let ran = tokio::time::timeout(Duration::from_secs(90), cmd.status()).await;
    let ok = matches!(ran, Ok(Ok(s)) if s.success());
    if !ok {
        let _ = tokio::fs::remove_file(&out_path).await;
        return Err((StatusCode::BAD_GATEWAY, "Could not read your Audible library — try reconnecting.".into()));
    }
    let data = tokio::fs::read(&out_path).await.unwrap_or_default();
    let _ = tokio::fs::remove_file(&out_path).await;
    let parsed: Value = serde_json::from_slice(&data).unwrap_or_else(|_| json!([]));
    let items = parsed.as_array().cloned().unwrap_or_default();

    let mut books: Vec<AudibleBook> = Vec::new();
    for it in &items {
        let Some(asin) = it.get("asin").and_then(|x| x.as_str()) else { continue };
        let title = it.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if title.is_empty() {
            continue;
        }
        let author = it
            .get("authors")
            .and_then(|x| x.as_str())
            .map(clean_author)
            .unwrap_or_default();
        let cover = it.get("cover_url").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from);
        let runtime_min = it.get("runtime_length_min").and_then(|x| x.as_i64());
        let percent_complete = it.get("percent_complete").and_then(|x| x.as_f64());
        // audible-cli writes an ISO-ish stamp ("2024-03-11 09:22:14"), which
        // sorts correctly as text - no parsing, and nothing to get wrong about
        // time zones for a field only ever used to order a list.
        let purchase_date = it
            .get("purchase_date")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let owned_locally = state.db.track_id_by_path(&book_rel_path(&state.music_root, &author, &title)).is_some();
        books.push(AudibleBook {
            asin: asin.to_string(),
            title,
            author,
            cover,
            runtime_min,
            percent_complete,
            owned_locally,
            purchase_date,
        });
    }
    /*
     * Newest first.
     *
     * Sorted HERE rather than in the plugin because the order is a property of
     * the library, not of one surface that happens to draw it - and because a
     * client that sorts has to be given the date to sort by, which is the same
     * work plus a chance for two surfaces to disagree.
     *
     * A book with no date sorts last rather than first: an absent stamp means
     * "we do not know", and letting unknowns lead the list would put the oldest
     * imports where the newest purchases belong.
     */
    books.sort_by(|a, b| match (&a.purchase_date, &b.purchase_date) {
        (Some(x), Some(y)) => y.cmp(x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.title.cmp(&b.title),
    });
    Ok(Json(json!({ "connected": true, "books": books })))
}

/// Audible lists authors as a comma-joined string that folds in roles -
/// "Marcus Aurelius, Martin Hammond - translator". Keep the real authors (the
/// ones with no "- role" suffix); fall back to the whole string if that empties
/// it. Cosmetic - the file's own tags still drive the library metadata.
fn clean_author(raw: &str) -> String {
    let names: Vec<&str> = raw
        .split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty() && !p.contains(" - "))
        .collect();
    if names.is_empty() {
        raw.trim().to_string()
    } else {
        names.join(", ")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAudibleBody {
    pub asin: String,
    pub title: String,
    pub author: String,
    #[serde(default)]
    pub cover: Option<String>,
}

/// `POST /api/audible/import {asin,title,author}` — queue a download of a book
/// you own. Signed-in callers may pull into the shared library; the title and
/// author only name a folder (the file's own tags drive everything the app
/// shows), so there is nothing here a client could forge into harm.
pub async fn import(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ImportAudibleBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if !state.audible.connected() {
        return Err((StatusCode::BAD_REQUEST, "Connect your Audible account in Settings first.".into()));
    }
    if find_audible().is_none() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "Audible tools aren't installed on the server.".into()));
    }
    let asin = body.asin.trim().to_string();
    if asin.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "which book?".into()));
    }

    {
        let jobs = state.audible.jobs.lock().await;
        if let Some(j) = jobs.iter().find(|j| j.asin == asin && j.state != "error") {
            return Ok(Json(json!({ "job": j })));
        }
    }

    let job = AudibleJob {
        id: format!("aud-{}-{}", asin, now_ms()),
        asin: asin.clone(),
        title: body.title.trim().to_string(),
        author: clean_author(body.author.trim()),
        cover: body.cover.clone().filter(|s| !s.is_empty()),
        state: "queued".into(),
        error: None,
        created_at: now_ms(),
        track_id: None,
    };
    let reply = job.clone();
    {
        let mut jobs = state.audible.jobs.lock().await;
        jobs.push(job.clone());
        let len = jobs.len();
        if len > 20 {
            jobs.drain(0..len - 20);
        }
    }

    let state2 = state.clone();
    let id = job.id.clone();
    tokio::spawn(async move {
        run_audible_job(state2, id, job.asin, job.title, job.author).await;
    });

    Ok(Json(json!({ "job": reply })))
}

/// `GET /api/audible/jobs` — the download queue, newest first.
pub async fn audible_jobs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let jobs = state.audible.jobs.lock().await;
    let mut list: Vec<&AudibleJob> = jobs.iter().collect();
    list.reverse();
    Ok(Json(json!({ "jobs": list })))
}

/// The account's AAX activation bytes, fetched once and remembered. They are a
/// per-account constant, so one call serves every AAX book the hub ever pulls.
async fn activation_bytes(state: &Arc<AppState>) -> Option<String> {
    if let Some(a) = state.audible.activation.lock().await.clone() {
        return Some(a);
    }
    let mut cmd = audible_command(state)?;
    cmd.current_dir(&state.audible.stage)
        .arg("activation-bytes")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let _ = tokio::fs::create_dir_all(&state.audible.stage).await;
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // The bytes are an 8-hex-digit token in the output ("Save ... to file\n<hex>").
    let bytes = text
        .split_whitespace()
        .rev()
        .find(|t| t.len() == 8 && t.chars().all(|c| c.is_ascii_hexdigit()))?
        .to_string();
    *state.audible.activation.lock().await = Some(bytes.clone());
    Some(bytes)
}

/// The AES-128 key and IV a `.voucher` carries for an AAXC book. Best-effort:
/// the voucher is JSON and its shape has drifted between audible-cli versions,
/// so this hunts the tree for the first pair of hex strings named key/iv rather
/// than pinning one path. AAX (the common case here) never needs it.
fn voucher_key_iv(voucher: &Value) -> Option<(String, String)> {
    fn find<'a>(v: &'a Value, name: &str) -> Option<&'a str> {
        match v {
            Value::Object(map) => {
                for (k, val) in map {
                    if k.eq_ignore_ascii_case(name) {
                        if let Some(s) = val.as_str() {
                            if s.chars().all(|c| c.is_ascii_hexdigit()) && s.len() >= 16 {
                                return Some(s);
                            }
                        }
                    }
                    if let Some(found) = find(val, name) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(arr) => arr.iter().find_map(|x| find(x, name)),
            _ => None,
        }
    }
    Some((find(voucher, "key")?.to_string(), find(voucher, "iv")?.to_string()))
}

/// The download → decrypt → file → index pipeline for one book. Serial (one book
/// at a time) like the LibriVox queue, and each phase names itself on the job so
/// a watching card can say where it is.
async fn run_audible_job(
    state: Arc<AppState>,
    job_id: String,
    asin: String,
    title: String,
    author: String,
) {
    let _worker = state.audible.worker.lock().await;
    let fail = |msg: String| async { set_job(&state, &job_id, |j| { j.state = "error".into(); j.error = Some(msg); }).await; };

    // Quota holds here exactly as it does for uploads and music imports.
    if state.library_quota_bytes > 0 && state.db.total_bytes() >= state.library_quota_bytes {
        fail("The library is at its storage quota.".into()).await;
        return;
    }

    set_job(&state, &job_id, |j| j.state = "downloading".into()).await;

    let job_stage = state.audible.stage.join(safe_segment(&asin));
    let _ = tokio::fs::remove_dir_all(&job_stage).await;
    if let Err(e) = tokio::fs::create_dir_all(&job_stage).await {
        fail(format!("Could not prepare a workspace: {e}")).await;
        return;
    }

    // 1. Download the DRM'd book (AAX, or AAXC + voucher as a fallback).
    let Some(mut cmd) = audible_command(&state) else {
        fail("Audible tools aren't installed on the server.".into()).await;
        return;
    };
    cmd.arg("download")
        .arg("-a")
        .arg(&asin)
        .arg("--aax-fallback")
        .arg("-q")
        .arg("best")
        .arg("-o")
        .arg(&job_stage)
        .arg("-f")
        .arg("asin_ascii")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // A long book over a slow line: give it room, but not forever.
    let ran = tokio::time::timeout(Duration::from_secs(3600), cmd.status()).await;
    if !matches!(ran, Ok(Ok(s)) if s.success()) {
        let _ = tokio::fs::remove_dir_all(&job_stage).await;
        fail("The download from Audible failed.".into()).await;
        return;
    }

    // Find what landed: the encrypted audio, and whether it needs a voucher.
    let mut audio: Option<PathBuf> = None;
    let mut is_aaxc = false;
    if let Ok(mut rd) = tokio::fs::read_dir(&job_stage).await {
        while let Ok(Some(ent)) = rd.next_entry().await {
            let p = ent.path();
            match p.extension().and_then(|e| e.to_str()) {
                Some("aaxc") => {
                    audio = Some(p);
                    is_aaxc = true;
                    break;
                }
                Some("aax") if audio.is_none() => audio = Some(p),
                _ => {}
            }
        }
    }
    let Some(audio) = audio else {
        let _ = tokio::fs::remove_dir_all(&job_stage).await;
        fail("Audible returned no audio for that book.".into()).await;
        return;
    };

    // 2. Decrypt to a plain, chaptered m4b - a copy, no re-encode, so the
    //    embedded chapters and cover come through untouched.
    set_job(&state, &job_id, |j| j.state = "decrypting".into()).await;
    let out_m4b = job_stage.join("book.m4b");
    let mut ff = tokio::process::Command::new("ffmpeg");
    ff.arg("-y").arg("-loglevel").arg("error");
    if is_aaxc {
        let voucher_path = audio.with_extension("voucher");
        let voucher: Value = tokio::fs::read(&voucher_path)
            .await
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        match voucher_key_iv(&voucher) {
            Some((key, iv)) => {
                ff.arg("-audible_key").arg(key).arg("-audible_iv").arg(iv);
            }
            None => {
                let _ = tokio::fs::remove_dir_all(&job_stage).await;
                fail("This book uses Audible's newer AAXC format, which this server can't unlock yet.".into()).await;
                return;
            }
        }
    } else {
        let Some(ab) = activation_bytes(&state).await else {
            let _ = tokio::fs::remove_dir_all(&job_stage).await;
            fail("Could not fetch your account's activation bytes.".into()).await;
            return;
        };
        ff.arg("-activation_bytes").arg(ab);
    }
    ff.arg("-i")
        .arg(&audio)
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg(&out_m4b)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let ffran = tokio::time::timeout(Duration::from_secs(900), ff.status()).await;
    if !matches!(ffran, Ok(Ok(s)) if s.success()) || !out_m4b.exists() {
        let _ = tokio::fs::remove_dir_all(&job_stage).await;
        fail("Decrypting the book failed.".into()).await;
        return;
    }

    // 3. File it into the library under Audiobooks/<Author>/<Title>/, so the
    //    folder contract marks it kind = 'book'. Copy, not rename: the staging
    //    dir and the music root may be different mounts.
    set_job(&state, &job_id, |j| j.state = "filing".into()).await;
    let rel = book_rel_path(&state.music_root, &author, &title);
    let dest = state.music_root.join(&rel);
    if let Some(parent) = dest.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Err(e) = tokio::fs::copy(&out_m4b, &dest).await {
        let _ = tokio::fs::remove_dir_all(&job_stage).await;
        fail(format!("Could not file the book into the library: {e}")).await;
        return;
    }
    let _ = tokio::fs::remove_dir_all(&job_stage).await;

    // 4. Index it under the filing lock, like every other arrival.
    let mut track_id = None;
    {
        let _filing = state.filing.lock().await;
        if scan::scan_one(&state.db, &state.music_root, &state.art_dir, &rel) {
            track_id = state.db.track_id_by_path(&rel);
        }
    }

    set_job(&state, &job_id, |j| {
        j.state = "done".into();
        j.track_id = track_id;
    })
    .await;
}
