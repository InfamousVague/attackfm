//! Over-the-air frontend updates: the web bundle, fetched from your own hub.
//!
//! Nearly everything that changes in this app is TypeScript and CSS. Shipping
//! those through an app store - or, on Android, through a sideloaded APK and a
//! system install prompt - is a slow, manual round trip for a change that the
//! WebView could simply be handed. So the server can publish a newer bundle,
//! the device downloads it, and the next launch runs it. Native code still
//! needs a real build; see `native_generation`.
//!
//! THE EMBEDDED BUNDLE IS THE FLOOR, NEVER THE FALLBACK OF LAST RESORT.
//!
//! That distinction is the whole design. This app is built to keep playing
//! with the hub switched off, so an update mechanism that can leave it unable
//! to boot when the server is unreachable would cost more than it saves. Three
//! rules follow, and every one of them is enforced here rather than trusted to
//! the caller:
//!
//!  1. A downloaded bundle is verified by SHA-256 per file before it is ever
//!     eligible to run, and lands in a version directory that is only pointed
//!     at once every file has arrived. A half-downloaded update is invisible.
//!
//!  2. A bundle declares the native generation it needs. A JS bundle calling a
//!     Tauri command this binary does not have would fail in ways no fallback
//!     could catch, so anything newer than this build is refused outright.
//!
//!  3. Booting a downloaded bundle is a WAGER that is settled every launch: the
//!     version is written to `pending` before it runs, and the frontend clears
//!     it once it has actually mounted. Finding `pending` still set at startup
//!     means that bundle failed to come up, so it is quarantined and the
//!     embedded one takes over. A bad deploy costs one launch, not the app.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// What this binary's Tauri commands amount to. A published bundle names the
/// generation it was built against; anything higher than this cannot run here.
///
/// BUMP THIS whenever a command is added, removed or changes shape - it is the
/// one guard between an old APK and a bundle that expects a newer one.
pub const NATIVE_GENERATION: u32 = 1;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BundleState {
    /// The version currently pointed at, or None while running embedded.
    pub active: Option<String>,
    /// Set while a boot is unproven - see rule 3.
    pub pending: Option<String>,
    /// Versions that failed to boot and will not be tried again.
    pub quarantined: Vec<String>,
    /// What this binary can run.
    pub native_generation: u32,
    /// Absolute directory of the active bundle, for the loader to build URLs.
    pub dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    pub name: String,
    pub url: String,
    /// Lowercase hex SHA-256. A file that does not match is not written.
    pub sha256: String,
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("bundles");
    std::fs::create_dir_all(&base).map_err(|e| format!("cannot create {}: {e}", base.display()))?;
    Ok(base)
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join("state.json"))
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    active: Option<String>,
    pending: Option<String>,
    #[serde(default)]
    quarantined: Vec<String>,
}

fn read_stored(app: &tauri::AppHandle) -> Stored {
    state_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_stored(app: &tauri::AppHandle, stored: &Stored) -> Result<(), String> {
    let path = state_path(app)?;
    let raw = serde_json::to_string(stored).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("cannot write state: {e}"))
}

/// A version string is used as a directory name, so it may not wander out of
/// the bundle root. Anything but the plainest characters is refused.
fn safe_version(version: &str) -> Result<String, String> {
    let ok = !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if ok {
        Ok(version.to_string())
    } else {
        Err("that version name is not usable as a directory".into())
    }
}

/// Same, for the file names inside a bundle: no separators, no traversal.
fn safe_name(name: &str) -> Result<String, String> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if ok {
        Ok(name.to_string())
    } else {
        Err(format!("{name}: not a usable file name"))
    }
}

/// `bundle_state` - what is active, pending and refused.
///
/// Called once at boot BEFORE anything is injected, and it is where rule 3 is
/// settled: a `pending` found here means the last launch never reported a
/// successful mount, so that version is quarantined on the spot.
#[tauri::command]
pub async fn bundle_state(app: tauri::AppHandle) -> Result<BundleState, String> {
    let mut stored = read_stored(&app);

    if let Some(failed) = stored.pending.take() {
        // It was written before the boot and never cleared: the bundle did not
        // come up. Refuse it for good and fall back.
        if !stored.quarantined.contains(&failed) {
            stored.quarantined.push(failed.clone());
        }
        if stored.active.as_deref() == Some(failed.as_str()) {
            stored.active = None;
        }
        let _ = std::fs::remove_dir_all(root(&app)?.join(&failed));
        write_stored(&app, &stored)?;
    }

    let dir = stored
        .active
        .as_ref()
        .and_then(|v| root(&app).ok().map(|r| r.join(v)))
        .filter(|p| p.join("app.js").exists())
        .map(|p| p.to_string_lossy().into_owned());

    // An active pointer whose files have gone (an OS reclaim, a wipe) is not an
    // error - it is simply the embedded bundle again.
    if dir.is_none() && stored.active.is_some() {
        stored.active = None;
        write_stored(&app, &stored)?;
    }

    Ok(BundleState {
        active: stored.active.clone(),
        pending: None,
        quarantined: stored.quarantined,
        native_generation: NATIVE_GENERATION,
        dir,
    })
}

/// `bundle_begin_boot` - stake the wager: this version is about to run.
#[tauri::command]
pub async fn bundle_begin_boot(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let version = safe_version(&version)?;
    let mut stored = read_stored(&app);
    stored.pending = Some(version);
    write_stored(&app, &stored)
}

/// `bundle_boot_ok` - settle it: the frontend mounted.
#[tauri::command]
pub async fn bundle_boot_ok(app: tauri::AppHandle) -> Result<(), String> {
    let mut stored = read_stored(&app);
    stored.pending = None;
    write_stored(&app, &stored)
}

/// `bundle_install` - fetch a published bundle and make it the active one.
///
/// Downloads every file into a temporary directory, checks each against the
/// SHA-256 the manifest promised, and only then renames it into place and
/// moves the pointer. A failure at any point leaves the previous state exactly
/// as it was.
#[tauri::command]
pub async fn bundle_install(
    app: tauri::AppHandle,
    version: String,
    native: u32,
    files: Vec<BundleFile>,
) -> Result<BundleState, String> {
    let version = safe_version(&version)?;
    if native > NATIVE_GENERATION {
        return Err(format!(
            "that bundle needs native generation {native}; this build is {NATIVE_GENERATION}"
        ));
    }
    let stored = read_stored(&app);
    if stored.quarantined.contains(&version) {
        return Err("that version already failed to boot here".into());
    }
    if files.is_empty() {
        return Err("a bundle with no files is not a bundle".into());
    }
    // The loader looks for exactly these two entries. Both are required, and
    // the stylesheet is not the lenient half: a bundle that arrives with only
    // app.js installs cleanly, boots, and reports its wager as won - while the
    // loader quietly falls back to the stylesheet baked into the native app.
    // The result is this build's markup drawn against a much older build's CSS,
    // which reads as the newest parts of the app losing their styling
    // altogether. Refusing the download is how that becomes a failed update
    // anybody can see rather than a silent half-update nobody can explain.
    for required in ["app.js", "app.css"] {
        if !files.iter().any(|f| f.name == required) {
            return Err(format!("a bundle must contain {required}"));
        }
    }

    let base = root(&app)?;
    let staging = base.join(format!(".staging-{version}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("cannot stage: {e}"))?;

    for file in &files {
        let name = safe_name(&file.name)?;
        let response = reqwest::get(&file.url)
            .await
            .map_err(|e| format!("{name}: fetch failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("{name}: server answered {}", response.status()));
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| format!("{name}: read failed: {e}"))?;

        let mut hasher = Sha256::new();
        hasher.update(&body);
        let got = hex(&hasher.finalize());
        if !got.eq_ignore_ascii_case(file.sha256.trim()) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("{name}: checksum did not match"));
        }
        std::fs::write(staging.join(&name), &body)
            .map_err(|e| format!("{name}: write failed: {e}"))?;
    }

    // Swap in whole. Until this rename, nothing points at the new files.
    let target = base.join(&version);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|e| format!("could not place bundle: {e}"))?;

    let mut stored = read_stored(&app);
    let previous = stored.active.clone();
    stored.active = Some(version.clone());
    write_stored(&app, &stored)?;

    // One generation back is kept: it is what a rollback returns to without a
    // download. Anything older is just disk.
    if let Some(old) = previous.filter(|p| p != &version) {
        prune_except(&base, &[version.as_str(), old.as_str()]);
    } else {
        prune_except(&base, &[version.as_str()]);
    }

    bundle_state(app).await
}

/// `bundle_revert` - go back to the embedded bundle deliberately.
#[tauri::command]
pub async fn bundle_revert(app: tauri::AppHandle) -> Result<BundleState, String> {
    let mut stored = read_stored(&app);
    stored.active = None;
    stored.pending = None;
    write_stored(&app, &stored)?;
    bundle_state(app).await
}

fn prune_except(base: &Path, keep: &[&str]) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !keep.contains(&name) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
