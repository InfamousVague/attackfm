//! Offline: your own library, kept on the device.
//!
//! This is NOT the import engine, and the distinction matters enough to state
//! plainly: nothing here reaches a third party, searches a catalogue, or
//! acquires music. It copies files the signed-in server ALREADY serves to this
//! device - your own library, over your own session - so a phone keeps playing
//! on a plane, on bad signal, or on any evening the home hub is off. Every
//! music app has this; it is the thing a self-hosted one needs most, because
//! the hub is a box in a house rather than a datacentre.
//!
//! The disk IS the index. A pinned track is stored under the app's data
//! directory as `<hex of its library path>.<ext>`, so listing the folder
//! recovers exactly which tracks are held without a second ledger to fall out
//! of step with the files. A download lands on a `.part` and is renamed only
//! once complete, so an interrupted pin leaves nothing that looks finished.

use std::path::PathBuf;
use tauri::Manager;

#[derive(serde::Serialize, Clone)]
pub struct OfflineEntry {
    /// The track's stable library path - `afm://<id>` for a server track.
    pub key: String,
    /// Absolute path on this device, for `convertFileSrc`.
    pub path: String,
    pub bytes: u64,
}

fn to_hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<String> {
    if s.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let raw = s.as_bytes();
    for pair in raw.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    String::from_utf8(out).ok()
}

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("offline");
    std::fs::create_dir_all(&base).map_err(|e| format!("cannot create {}: {e}", base.display()))?;
    Ok(base)
}

fn entry_of(path: &std::path::Path) -> Option<OfflineEntry> {
    let stem = path.file_stem()?.to_str()?;
    // A half-finished download is not an entry; the extension keeps it out.
    if path.extension().and_then(|e| e.to_str()) == Some("part") {
        return None;
    }
    let key = from_hex(stem)?;
    let bytes = std::fs::metadata(path).ok()?.len();
    Some(OfflineEntry { key, path: path.to_string_lossy().into_owned(), bytes })
}

/// Everything held on this device, newest first is the caller's business.
#[tauri::command]
pub async fn offline_list(app: tauri::AppHandle) -> Result<Vec<OfflineEntry>, String> {
    let base = dir(&app)?;
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(&base) else {
        return Ok(out);
    };
    for item in read.flatten() {
        if let Some(entry) = entry_of(&item.path()) {
            out.push(entry);
        }
    }
    Ok(out)
}

/// Fetch one track and keep it. Idempotent: a track already held answers with
/// what is on disk rather than downloading it twice.
#[tauri::command]
pub async fn offline_pin(
    app: tauri::AppHandle,
    key: String,
    url: String,
    ext: String,
) -> Result<OfflineEntry, String> {
    let base = dir(&app)?;
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let ext = if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        "audio".to_string()
    } else {
        ext
    };
    let target = base.join(format!("{}.{}", to_hex(&key), ext));
    if let Ok(meta) = std::fs::metadata(&target) {
        if meta.len() > 0 {
            return Ok(OfflineEntry {
                key,
                path: target.to_string_lossy().into_owned(),
                bytes: meta.len(),
            });
        }
    }

    let part = target.with_extension("part");
    let response = reqwest::get(&url).await.map_err(|e| format!("fetch failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("server answered {}", response.status()));
    }
    let body = response.bytes().await.map_err(|e| format!("read failed: {e}"))?;
    if body.is_empty() {
        return Err("the server sent an empty file".into());
    }
    std::fs::write(&part, &body).map_err(|e| format!("write failed: {e}"))?;
    // Renamed only once whole, so an interrupted pin never looks finished.
    std::fs::rename(&part, &target).map_err(|e| format!("rename failed: {e}"))?;
    Ok(OfflineEntry { key, path: target.to_string_lossy().into_owned(), bytes: body.len() as u64 })
}

/// How much room the vault has to work with: free bytes on its volume, and
/// how much it is already using.
///
/// Anything that caches AHEAD of being asked - the Date warmer especially -
/// has to know this. Filling a phone with songs nobody requested is the
/// failure mode that makes people turn a feature off, so the rule is that
/// speculative caching gets the room that is genuinely spare and stops.
#[tauri::command]
pub async fn offline_space(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let base = dir(&app)?;
    let mut held: u64 = 0;
    if let Ok(read) = std::fs::read_dir(&base) {
        for entry in read.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    held += meta.len();
                }
            }
        }
    }
    Ok(serde_json::json!({
        "freeBytes": free_bytes(&base),
        "heldBytes": held,
    }))
}

/// Free bytes on the volume holding `path`, or None when it cannot be asked.
/// statvfs rather than a crate: this is the one number needed, and every
/// platform the app ships to is unix.
fn free_bytes(path: &std::path::Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: `c` is a valid NUL-terminated path and `stat` is written
        // only by statvfs, which is given a pointer to fully-owned storage.
        unsafe {
            let mut stat: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(c.as_ptr(), &mut stat) != 0 {
                return None;
            }
            // f_bavail, not f_bfree: blocks available to an unprivileged
            // process, which is the number that governs whether OUR write
            // succeeds.
            Some(stat.f_bavail as u64 * stat.f_frsize as u64)
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// Give one track's space back. Missing is success: the caller wanted it gone.
#[tauri::command]
pub async fn offline_unpin(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let base = dir(&app)?;
    let want = to_hex(&key);
    let Ok(read) = std::fs::read_dir(&base) else {
        return Ok(());
    };
    for item in read.flatten() {
        let path = item.path();
        if path.file_stem().and_then(|s| s.to_str()) == Some(want.as_str()) {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Everything, gone - the "free up space" button in Settings.
#[tauri::command]
pub async fn offline_clear(app: tauri::AppHandle) -> Result<(), String> {
    let base = dir(&app)?;
    if let Ok(read) = std::fs::read_dir(&base) {
        for item in read.flatten() {
            let _ = std::fs::remove_file(item.path());
        }
    }
    Ok(())
}
