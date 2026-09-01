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

/// A browsable root the web layer handed over (Android: the AttackFM folder in
/// shared storage, where a file manager can walk). None means the app-private
/// default - the only possibility until the all-files grant exists, and the
/// permanent state everywhere but Android.
static ROOT_OVERRIDE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// `offline_set_root` - point the vault at a browsable folder.
///
/// Called by the web layer at boot once Android's all-files grant exists, with
/// the folder MainActivity's `vaultDir()` made. Anything already held in the
/// private vault MIGRATES immediately: copy-then-delete, because the private
/// and shared halves of Android storage are different filesystems and a rename
/// will not cross them. An OPTIONAL command by design - an older binary simply
/// refuses the invoke, the web layer shrugs, and the vault stays private - so
/// this does not bump NATIVE_GENERATION (the airplay commands set the rule).
#[tauri::command]
pub fn offline_set_root(app: tauri::AppHandle, root: String) -> Result<usize, String> {
    let new_root = PathBuf::from(&root);
    std::fs::create_dir_all(&new_root)
        .map_err(|e| format!("cannot create {}: {e}", new_root.display()))?;
    // Music indexers would list every cached song twice in the system's media
    // library; the vault is the app's cache, not a contribution to the phone's
    // gallery of ringtones.
    let _ = std::fs::write(new_root.join(".nomedia"), b"");

    let old = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("offline");
    let mut moved = 0usize;
    if old.is_dir() && old != new_root {
        if let Ok(entries) = std::fs::read_dir(&old) {
            for entry in entries.flatten() {
                let from = entry.path();
                if !from.is_file() {
                    continue;
                }
                let to = new_root.join(entry.file_name());
                if to.exists() {
                    let _ = std::fs::remove_file(&from);
                    continue;
                }
                if std::fs::copy(&from, &to).is_ok() {
                    let _ = std::fs::remove_file(&from);
                    moved += 1;
                } else {
                    // A copy that failed mid-file must not stand as a track:
                    // the reader treats presence as wholeness.
                    let _ = std::fs::remove_file(&to);
                }
            }
        }
    }
    *ROOT_OVERRIDE.lock().unwrap() = Some(new_root);
    Ok(moved)
}

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = ROOT_OVERRIDE.lock().unwrap().clone() {
        std::fs::create_dir_all(&root)
            .map_err(|e| format!("cannot create {}: {e}", root.display()))?;
        return Ok(root);
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("offline");
    std::fs::create_dir_all(&base).map_err(|e| format!("cannot create {}: {e}", base.display()))?;
    // The big one: this is allowed to reach fifteen gigabytes, every byte of it
    // re-downloadable from the hub. See nobackup.rs for why it is not simply
    // moved to Caches instead.
    crate::nobackup::exclude(&base);
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

    /*
     * The fragment carries the EXTENSION, so a half-finished download can only
     * ever be resumed into a file of the same quality.
     *
     * It used to be `<hex>.part` for every quality, which made an abandoned 128k
     * encode indistinguishable on disk from an abandoned lossless download. The
     * next attempt saw bytes already there and sent `Range: bytes=N-`; the
     * original-file endpoint honours that with a 206, so FLAC bytes were
     * appended onto an AAC head and renamed into place - a file that passes
     * every check this code can make and is garbage, preferred over the network
     * for good. `<hex>.<ext>.part` makes a mismatched fragment simply invisible
     * to the resume check, and preserves resume for a fragment that DOES match.
     *
     * `entry_of` is unaffected: it skips on `extension() == "part"`, which is
     * still true, and a hex stem still contains no dot of its own.
     */
    let part = base.join(format!("{}.{}.part", to_hex(&key), ext));
    // A client with a connect timeout, and a watchdog on every chunk. The old
    // body was reqwest::get + bytes() - no timeout anywhere, the whole file
    // buffered in memory - so one wedged connection hung its worker forever.
    //
    // And the download RESUMES. Playback survives the same flaky path because
    // Chromium re-requests from where a reset left it; the downloader
    // restarted whole files from zero, so a reset at 90% of a lossless file
    // cost everything it had. A surviving .part now picks up with a Range
    // header - the server is tower's ServeFile, which honours ranges - and
    // only a clean finish renames it into place.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client failed: {e}"))?;
    let already: u64 = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut request = client.get(&url);
    if already > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={already}-"));
    }
    let mut response = request.send().await.map_err(|e| format!("fetch failed: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // The file on the server is shorter than our fragment - it changed
        // out from under us (a refetch, a rescan). The fragment is garbage.
        let _ = std::fs::remove_file(&part);
        return Err("resume rejected; will start fresh next attempt".into());
    }
    if !status.is_success() {
        // A refusal writes no bytes this attempt; any older fragment is not
        // implicated, so it survives for a future attempt.
        return Err(format!("server answered {status}"));
    }
    // Asked for a range, given the whole file: the server ignored the header,
    // so the fragment must not be appended to.
    let resuming = already > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut file = if resuming {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|e| format!("write failed: {e}"))?
    } else {
        std::fs::File::create(&part).map_err(|e| format!("write failed: {e}"))?
    };
    let mut total: u64 = if resuming { already } else { 0 };
    loop {
        let next = tokio::time::timeout(std::time::Duration::from_secs(45), response.chunk()).await;
        let chunk = match next {
            // Mid-body deaths KEEP the fragment: what landed is real, and the
            // next attempt continues from its end instead of paying again.
            Err(_) => return Err("stalled: no data for 45 seconds".into()),
            Ok(Err(e)) => return Err(format!("read failed: {e}")),
            Ok(Ok(chunk)) => chunk,
        };
        match chunk {
            Some(bytes) => {
                use std::io::Write;
                if let Err(e) = file.write_all(&bytes) {
                    // A disk that will not take bytes will not take a resume
                    // either; drop the fragment.
                    let _ = std::fs::remove_file(&part);
                    return Err(format!("write failed: {e}"));
                }
                total += bytes.len() as u64;
            }
            None => break,
        }
    }
    drop(file);
    if total == 0 {
        let _ = std::fs::remove_file(&part);
        return Err("the server sent an empty file".into());
    }
    // Renamed only once whole, so an interrupted pin never looks finished.
    std::fs::rename(&part, &target).map_err(|e| format!("rename failed: {e}"))?;
    Ok(OfflineEntry { key, path: target.to_string_lossy().into_owned(), bytes: total })
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
        // `<hex>.<ext>` matches on the stem; `<hex>.<ext>.part` has the stem
        // `<hex>.<ext>`, so it needs the prefix arm. Without it this stops
        // deleting fragments entirely and the vault leaks `.part` files for
        // ever - which is why these two changes have to land together.
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem == want.as_str() || stem.starts_with(&format!("{want}.")) {
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

#[cfg(test)]
mod tests {
    /// The exact predicate `offline_unpin` uses, so the two cannot drift.
    fn matches(stem: &str, want: &str) -> bool {
        stem == want || stem.starts_with(&format!("{want}."))
    }

    #[test]
    fn unpin_takes_the_file_and_its_fragment_and_nothing_else() {
        let want = "61666d3a2f2f3432";
        let other = "61666d3a2f2f3939";

        // The held file, whatever quality it is stored at. `file_stem` of
        // `<hex>.flac` is `<hex>`, so these come through the equality arm.
        assert!(matches(want, want), "lossless file");

        // The fragment. `file_stem` of `<hex>.aac128.part` is `<hex>.aac128`,
        // which only the prefix arm can see - and if it cannot, the vault leaks
        // `.part` files for ever.
        assert!(matches(&format!("{want}.aac128"), want), "lossy fragment");
        assert!(matches(&format!("{want}.flac"), want), "lossless fragment");

        // Another song is never touched. A hex stem carries no dot of its own,
        // so no other key can start with `<want>.`.
        assert!(!matches(other, want), "a different song");
        assert!(!matches(&format!("{other}.aac128"), want), "another song's fragment");

        // A key that merely SHARES A PREFIX is not this key - the dot is what
        // makes the prefix arm safe rather than greedy.
        assert!(!matches(&format!("{want}ff"), want), "a longer key with this one as a prefix");
    }
}
