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
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

/// Serialises every read-modify-write of state.json.
///
/// There was nothing here, and three commands - `bundle_state`,
/// `bundle_begin_boot`, `bundle_boot_ok` - each read the whole file, changed
/// one field and wrote it back. Two of those overlapping loses whichever wrote
/// first, and the one that mattered was a settle being overwritten by a stale
/// read: the wager stayed standing, the next reader called it a failed boot,
/// and a perfectly good bundle was deleted. Five over-the-air versions were
/// spent trying to sequence around that from JavaScript, which cannot see the
/// interleaving, let alone control it.
///
/// A process-wide lock rather than a file lock: there is one process, and the
/// critical sections are three lines of synchronous IO. Nothing awaits while
/// holding it.
static STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn state_lock() -> &'static Mutex<()> {
    STATE_LOCK.get_or_init(|| Mutex::new(()))
}

/// What this binary's Tauri commands amount to. A published bundle names the
/// generation it was built against; anything higher than this cannot run here.
///
/// BUMP THIS whenever a command is added, removed or changes shape - it is the
/// one guard between an old APK and a bundle that expects a newer one.
/// What a PUBLISHED BUNDLE requires of the binary running it.
///
/// Not the same number as `NATIVE_GENERATION`, and conflating them is a way to
/// lock every device in the field out of every future update at once. That
/// constant says what this binary PROVIDES; this one says what the frontend
/// being shipped over the air actually NEEDS. A bundle stamped with a
/// generation higher than a device's binary is refused outright - which is
/// correct when the frontend genuinely calls a command that is not there, and
/// a catastrophe when it merely happens to have been built from the same
/// checkout as a native change it does not use.
///
/// Generation 2 added `bundle_claim_boot` and made `bundle_state` a pure read,
/// and the frontend takes advantage of both - but only when the boot loader
/// reports a generation-2 binary underneath (see `__afmNativeGeneration`), and
/// degrades to exactly its old behaviour otherwise. So it still requires 1.
///
/// BUMP THIS only when the shipped frontend cannot function on the older
/// binary at all, having first checked that it truly cannot rather than merely
/// prefers not to.
pub const BUNDLE_REQUIRES: u32 = 1;

pub const NATIVE_GENERATION: u32 = 2;
//                                    ^ 2: `bundle_state` no longer consumes the
// boot wager, and `bundle_claim_boot` was added to do that one job atomically.
// A bundle built against generation 2 may rely on both; generation 1 binaries
// still answer every older command exactly as before.

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
    // Downloaded frontends are re-fetchable by definition; they have no place
    // in somebody's iCloud backup. Cheap and idempotent, so it rides on the
    // create rather than needing a separate startup step.
    crate::nobackup::exclude(&base);
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

/// `bundle_state` - what is active, pending and refused. **A pure read.**
///
/// It used to be the place rule 3 was settled: a `pending` found here was
/// taken as a failed boot and quarantined on the spot. That made the most
/// innocuous-looking call in the API destructive, and every caller a hazard -
/// the settings pane asking what version is running, the update check asking
/// what is refused, `bundle_install` asking for its own return value - each
/// one able to delete the bundle it was asked from if it happened to land
/// while a wager was outstanding. It did, repeatedly, and it was not
/// diagnosable from the frontend.
///
/// The quarantine decision now belongs to `bundle_claim_boot` alone, which
/// makes it once per launch, atomically, at the only moment the answer is
/// knowable. This one just reports.
#[tauri::command]
pub async fn bundle_state(app: tauri::AppHandle) -> Result<BundleState, String> {
    let _guard = state_lock().lock();
    #[allow(unused_mut)]
    let mut stored = read_stored(&app);

    // A pinned diagnostic build must not be shadowed by an OTA bundle left by
    // an ordinary installation using the same app-data directory. Clearing
    // the pointers here makes the boot loader choose the embedded frontend on
    // this launch and every launch after it.
    #[cfg(feature = "pinned-build")]
    if stored.active.is_some() || stored.pending.is_some() {
        stored.active = None;
        stored.pending = None;
        write_stored(&app, &stored)?;
    }

    let pending = stored.pending.clone();
    let dir = stored
        .active
        .as_ref()
        .and_then(|v| root(&app).ok().map(|r| r.join(v)))
        // BOTH files, not just app.js. Checking only the script is how a bundle
        // whose stylesheet has gone still gets handed to the loader: the module
        // boots, the boot wager is won, and the <link> beside it quietly 404s -
        // leaving new JS painting itself with the embedded build's old CSS,
        // which is not "a version behind on looks" but two halves of different
        // versions. Everything added since that embedded build then renders as
        // naked HTML. Requiring the pair means a bundle missing either one
        // falls back whole, which is a state the app can actually be in.
        .filter(|p| p.join("app.js").exists() && p.join("app.css").exists())
        .map(|p| p.to_string_lossy().into_owned());

    // An active pointer whose files have gone (an OS reclaim, a wipe) reads as
    // the embedded bundle again - but that is REPORTED, not written. A pure
    // read stays pure; `bundle_claim_boot` tidies the pointer at the next boot.
    let active = if dir.is_some() { stored.active.clone() } else { None };

    Ok(BundleState {
        active,
        // Reported honestly now. It used to be hardcoded to None because this
        // function had just eaten it, which meant nothing could ever observe an
        // outstanding wager - including the code trying to work out why bundles
        // were disappearing.
        pending,
        quarantined: stored.quarantined,
        native_generation: NATIVE_GENERATION,
        dir,
    })
}

/// `bundle_claim_boot` - settle the last launch's wager and stake this one, in
/// a single step that nothing can interleave with.
///
/// THE ONE DESTRUCTIVE OPERATION IN THIS FILE, and the whole point of it being
/// one. Deciding "the previous boot failed" and "this boot is starting" are two
/// halves of the same thought, and they were two commands with a gap between
/// them that other callers kept falling into. Now the boot loader asks once,
/// gets back everything it needs to run something, and no other code path can
/// quarantine anything.
///
/// Order matters and is deliberate: judge the OLD wager first, then choose what
/// to run from what survives, then stake. A version quarantined here is
/// therefore never the version being staked.
#[tauri::command]
pub async fn bundle_claim_boot(app: tauri::AppHandle) -> Result<BundleState, String> {
    let _guard = state_lock().lock();
    let mut stored = read_stored(&app);
    let mut dirty = false;

    #[cfg(feature = "pinned-build")]
    if stored.active.is_some() || stored.pending.is_some() {
        stored.active = None;
        stored.pending = None;
        write_stored(&app, &stored)?;
        return Ok(BundleState {
            active: None,
            pending: None,
            quarantined: stored.quarantined,
            native_generation: NATIVE_GENERATION,
            dir: None,
        });
    }

    // 1. The previous launch. A wager still standing means whatever ran last
    //    never reported a mount, so refuse it for good and take the pointer
    //    off it. This is rule 3, and this is now the only place it happens.
    if let Some(failed) = stored.pending.take() {
        if !stored.quarantined.contains(&failed) {
            stored.quarantined.push(failed.clone());
        }
        if stored.active.as_deref() == Some(failed.as_str()) {
            stored.active = None;
        }
        let _ = std::fs::remove_dir_all(root(&app)?.join(&failed));
        dirty = true;
    }

    // 2. What is left to run, if anything. BOTH files, for the reason given on
    //    bundle_state's own resolution: a bundle missing either half is two
    //    halves of different versions, which is worse than being a version
    //    behind, so it falls back whole.
    let dir = stored
        .active
        .as_ref()
        .and_then(|v| root(&app).ok().map(|r| r.join(v)))
        .filter(|p| p.join("app.js").exists() && p.join("app.css").exists())
        .map(|p| p.to_string_lossy().into_owned());
    if dir.is_none() && stored.active.is_some() {
        // The files have gone - an OS reclaim, a wipe, or the quarantine above.
        stored.active = None;
        dirty = true;
    }

    // 3. Stake the new one, but only if there is actually something to run.
    //    Staking on the embedded bundle would be betting on a boot that has no
    //    directory to lose, and the next launch would quarantine a version
    //    number that never came from here.
    if let Some(active) = stored.active.clone() {
        stored.pending = Some(active);
        dirty = true;
    }

    if dirty {
        write_stored(&app, &stored)?;
    }

    Ok(BundleState {
        active: stored.active.clone(),
        pending: stored.pending.clone(),
        quarantined: stored.quarantined,
        native_generation: NATIVE_GENERATION,
        dir,
    })
}

/// `bundle_begin_boot` - stake the wager: this version is about to run.
#[tauri::command]
pub async fn bundle_begin_boot(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let version = safe_version(&version)?;
    let _guard = state_lock().lock();
    let mut stored = read_stored(&app);
    stored.pending = Some(version);
    write_stored(&app, &stored)
}

/// `bundle_boot_ok` - settle it: the frontend mounted.
#[tauri::command]
pub async fn bundle_boot_ok(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = state_lock().lock();
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
    #[cfg(feature = "pinned-build")]
    return Err("this build is pinned and does not accept frontend updates".into());

    #[cfg(not(feature = "pinned-build"))]
    {
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

        // Scoped, because `bundle_state` below takes the same lock and this
        // must not still be holding it. Nothing awaits inside.
        let previous = {
            let _guard = state_lock().lock();
            let mut stored = read_stored(&app);
            let previous = stored.active.clone();
            stored.active = Some(version.clone());
            write_stored(&app, &stored)?;
            previous
        };

        // One generation back is kept: it is what a rollback returns to without a
        // download. Anything older is just disk.
        if let Some(old) = previous.filter(|p| p != &version) {
            prune_except(&base, &[version.as_str(), old.as_str()]);
        } else {
            prune_except(&base, &[version.as_str()]);
        }

        // Safe to ask now, in a way it was not before: this reports, and no
        // longer decides. An install used to be able to quarantine the bundle
        // that asked for it, on its way to telling it the install worked.
        bundle_state(app).await
    }
}

/// `bundle_revert` - go back to the embedded bundle deliberately.
#[tauri::command]
pub async fn bundle_revert(app: tauri::AppHandle) -> Result<BundleState, String> {
    {
        let _guard = state_lock().lock();
        let mut stored = read_stored(&app);
        stored.active = None;
        // The wager goes with it. Reverting is a deliberate choice, not a boot
        // that failed, and leaving the bet standing would have the next launch
        // quarantine a version nobody rejected.
        stored.pending = None;
        write_stored(&app, &stored)?;
    }
    bundle_state(app).await
}

fn prune_except(base: &Path, keep: &[&str]) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !keep.contains(&name) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
