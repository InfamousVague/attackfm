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
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::{auth, AppState};

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
/// `<home>/.local/pipx/venvs/audible-cli/bin/python3`), mirroring
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
            let py = local.join("pipx/venvs/audible-cli/bin/python3");
            if py.exists() {
                return Some(py);
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
    login: tokio::sync::Mutex<Option<LoginSession>>,
}

impl AudibleState {
    pub fn new(data_dir: &Path) -> Self {
        let config_dir = std::env::var("AFM_AUDIBLE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("audible"));
        let home = data_dir.join("audible-home");
        AudibleState {
            config_dir,
            home,
            login: tokio::sync::Mutex::new(None),
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
