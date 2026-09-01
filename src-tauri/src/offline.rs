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
//! The disk is STILL the index, but the files wear their own names and sit on
//! shelves. A pinned track is stored as `Artist/Album/Title.<ext>` (artist
//! only when the track names no album) so a person browsing the AttackFM
//! folder in a file manager walks a record collection, not a flat wall - and
//! a hidden `.attackfm-index.json` at the root maps each relative path back
//! to its library key, because a readable name cannot encode one losslessly.
//! The
//! index is a convenience, not an authority: a file it has forgotten is simply
//! not held (the sweep re-fetches it), a file the person deleted by hand is
//! gone the way deleting is supposed to work, and files from the pre-readable
//! era - `<hex of key>.<ext>` - decode straight from their stem exactly as
//! before, so both generations list without a migration step. A download
//! lands on a `.part` and is renamed only once complete, so an interrupted
//! pin leaves nothing that looks finished.

use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::Manager;

/// The filename -> key map, hidden beside the music it describes.
const INDEX_FILE: &str = ".attackfm-index.json";

fn load_index(base: &std::path::Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(base.join(INDEX_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Written whole via a temp file so a death mid-write cannot leave half a
/// ledger; the fallback for a lost index is re-downloading, which is safe but
/// not free.
fn save_index(base: &std::path::Path, index: &BTreeMap<String, String>) {
    let Ok(body) = serde_json::to_string_pretty(index) else { return };
    let tmp = base.join(format!("{INDEX_FILE}.tmp"));
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, base.join(INDEX_FILE));
    }
}

/// A display name made safe for every filesystem the app ships to: the
/// characters FAT and its emulated Android cousins refuse become spaces,
/// runs of whitespace collapse, and the result is capped well under the
/// 255-byte filename limit (the extension still has to fit). None means the
/// name had nothing usable in it and the hex form should stand.
fn sanitize_stem(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    let mut s = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    while s.len() > 120 {
        s.pop();
    }
    let s = s.trim_end_matches(|c: char| c == '.' || c == ' ').to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Six hex characters that stay the same for a key forever - the suffix that
/// keeps two different songs called "Intro" from fighting over one filename.
fn short_tag(key: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:06x}", h & 0xff_ffff)
}

/// The shelf a track sits on: `Artist/Album/`, `Artist/` when it names no
/// album, or the vault root when it names no artist. Each segment is
/// sanitized on its own, so a slash inside a band name cannot invent a
/// deeper folder.
fn shelf_of(artist: Option<&str>, album: Option<&str>) -> String {
    let artist = artist.and_then(sanitize_stem);
    let album = album.and_then(sanitize_stem);
    match (artist, album) {
        (Some(ar), Some(al)) => format!("{ar}/{al}/"),
        (Some(ar), None) => format!("{ar}/"),
        (None, _) => String::new(),
    }
}

/// The relative path a (key, ext) pair stores under. When `respect_existing`
/// an existing mapping wins so resumes and re-pins stay stable; the organize
/// pass turns that off, because its whole point is computing where the file
/// SHOULD be. Otherwise the readable shelf and title, unless a DIFFERENT song
/// already answers to that exact path (case-insensitively - Android's shared
/// storage does not distinguish), in which case the key's tag breaks the tie.
#[allow(clippy::too_many_arguments)]
fn decide_relpath(
    index: &BTreeMap<String, String>,
    key: &str,
    ext: &str,
    artist: Option<&str>,
    album: Option<&str>,
    title: Option<&str>,
    name: Option<&str>,
    respect_existing: bool,
) -> String {
    let suffix = format!(".{ext}");
    if respect_existing {
        for (f, k) in index {
            if k == key && f.to_ascii_lowercase().ends_with(&suffix) {
                return f.clone();
            }
        }
    }
    let shelf = shelf_of(artist, album);
    // Inside an artist's folder the title alone is the name; with no shelf to
    // stand on, "Artist - Title" (the flat `name`) carries the context, and
    // with nothing readable at all the hex era's form still works.
    let stem = if shelf.is_empty() {
        name.or(title).and_then(sanitize_stem).unwrap_or_else(|| to_hex(key))
    } else {
        title.and_then(sanitize_stem).or_else(|| name.and_then(sanitize_stem)).unwrap_or_else(|| to_hex(key))
    };
    let plain = format!("{shelf}{stem}{suffix}");
    let taken = index.iter().any(|(f, k)| k != key && f.eq_ignore_ascii_case(&plain));
    if taken { format!("{shelf}{stem} ({}){suffix}", short_tag(key)) } else { plain }
}

/// Every file under the vault, as (relative path with `/` separators,
/// absolute path). Depth-capped so a runaway symlink cannot walk the phone,
/// and dot-entries are bookkeeping at every level.
fn walk(base: &std::path::Path) -> Vec<(String, PathBuf)> {
    fn rec(base: &std::path::Path, dir: &std::path::Path, depth: u8, out: &mut Vec<(String, PathBuf)>) {
        if depth > 3 {
            return;
        }
        let Ok(read) = std::fs::read_dir(dir) else { return };
        for item in read.flatten() {
            let path = item.path();
            let n = item.file_name().to_string_lossy().into_owned();
            if n.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                rec(base, &path, depth + 1, out);
            } else if path.is_file() {
                let rel = path
                    .strip_prefix(base)
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .unwrap_or(n);
                out.push((rel, path));
            }
        }
    }
    let mut out = Vec::new();
    rec(base, base, 0, &mut out);
    out
}

/// After deletes and moves: fold up the shelves nothing sits on any more, so
/// unpinning an album does not strand an empty folder in the file manager.
fn prune_empty_dirs(base: &std::path::Path) {
    fn rec(dir: &std::path::Path, is_root: bool) -> bool {
        let Ok(read) = std::fs::read_dir(dir) else { return false };
        let mut empty = true;
        for item in read.flatten() {
            let path = item.path();
            if path.is_dir() {
                if !rec(&path, false) {
                    empty = false;
                }
            } else {
                empty = false;
            }
        }
        if empty && !is_root {
            return std::fs::remove_dir(dir).is_ok();
        }
        empty && is_root
    }
    let _ = rec(base, true);
}

/// A finished, non-empty file already holding this (key, ext) - through the
/// index or as a legacy hex name at the root.
fn held_file(
    base: &std::path::Path,
    index: &BTreeMap<String, String>,
    key: &str,
    ext: &str,
) -> Option<OfflineEntry> {
    let suffix = format!(".{ext}");
    let mut candidates: Vec<String> = index
        .iter()
        .filter(|(f, k)| *k == key && f.to_ascii_lowercase().ends_with(&suffix))
        .map(|(f, _)| f.clone())
        .collect();
    candidates.push(format!("{}{suffix}", to_hex(key)));
    for f in candidates {
        let path = base.join(&f);
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() && meta.len() > 0 {
                return Some(OfflineEntry {
                    key: key.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    bytes: meta.len(),
                });
            }
        }
    }
    None
}

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
        // The two folders may each have a ledger; a blind copy would pick a
        // winner and orphan the loser's files under their readable names.
        // Union them - the destination's claims stand where they collide.
        let mut merged = load_index(&new_root);
        for (f, k) in load_index(&old) {
            merged.entry(f).or_insert(k);
        }
        save_index(&new_root, &merged);
        let _ = std::fs::remove_file(old.join(INDEX_FILE));
        for (rel, from) in walk(&old) {
            let to = new_root.join(&rel);
            if to.exists() {
                let _ = std::fs::remove_file(&from);
                continue;
            }
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
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
        prune_empty_dirs(&old);
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

fn entry_of(rel: &str, path: &std::path::Path, index: &BTreeMap<String, String>) -> Option<OfflineEntry> {
    // A half-finished download is not an entry; the extension keeps it out.
    if path.extension().and_then(|e| e.to_str()) == Some("part") {
        return None;
    }
    // Readable paths answer through the ledger; legacy hex names decode from
    // their own stem. A file that is neither - something a person dropped in
    // the folder themselves - is left alone, unlisted and unevictable.
    let stem = path.file_stem()?.to_str()?;
    let key = index.get(rel).cloned().or_else(|| from_hex(stem))?;
    let bytes = std::fs::metadata(path).ok()?.len();
    Some(OfflineEntry { key, path: path.to_string_lossy().into_owned(), bytes })
}

/// Everything held on this device, newest first is the caller's business.
#[tauri::command]
pub async fn offline_list(app: tauri::AppHandle) -> Result<Vec<OfflineEntry>, String> {
    let base = dir(&app)?;
    let index = load_index(&base);
    let mut out = Vec::new();
    for (rel, path) in walk(&base) {
        if let Some(entry) = entry_of(&rel, &path, &index) {
            out.push(entry);
        }
    }
    Ok(out)
}

/// Fetch one track and keep it. Idempotent: a track already held answers with
/// what is on disk rather than downloading it twice.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn offline_pin(
    app: tauri::AppHandle,
    key: String,
    url: String,
    ext: String,
    name: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    title: Option<String>,
) -> Result<OfflineEntry, String> {
    let base = dir(&app)?;
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let ext = if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        "audio".to_string()
    } else {
        ext
    };
    let mut index = load_index(&base);
    if let Some(entry) = held_file(&base, &index, &key, &ext) {
        return Ok(entry);
    }
    let filename = decide_relpath(
        &index,
        &key,
        &ext,
        artist.as_deref(),
        album.as_deref(),
        title.as_deref(),
        name.as_deref(),
        true,
    );
    let target = base.join(&filename);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    // The ledger learns the claim BEFORE the download, so an unpin can find
    // and delete the fragment of a pin that never finished. A claim whose
    // file never appears is inert: listing walks real files, not the ledger.
    if index.get(&filename).map(String::as_str) != Some(key.as_str()) {
        index.insert(filename.clone(), key.clone());
        save_index(&base, &index);
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
    let part = base.join(format!("{filename}.part"));
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
    // A fragment from the hex-named era can only rot now that downloads land
    // under readable names; the finished pin retires it.
    let legacy_part = base.join(format!("{}.{}.part", to_hex(&key), ext));
    if legacy_part != part {
        let _ = std::fs::remove_file(&legacy_part);
    }
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
    for (_, path) in walk(&base) {
        if let Ok(meta) = std::fs::metadata(&path) {
            held += meta.len();
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
    let mut index = load_index(&base);
    let claimed: Vec<String> =
        index.iter().filter(|(_, k)| **k == key).map(|(f, _)| f.clone()).collect();
    if !claimed.is_empty() {
        for f in &claimed {
            let _ = std::fs::remove_file(base.join(f));
            // The fragment of an unfinished pin sits at `<filename>.part`.
            let _ = std::fs::remove_file(base.join(format!("{f}.part")));
            index.remove(f);
        }
        save_index(&base, &index);
    }
    let want = to_hex(&key);
    for (_, path) in walk(&base) {
        // `<hex>.<ext>` matches on the stem; `<hex>.<ext>.part` has the stem
        // `<hex>.<ext>`, so it needs the prefix arm. Without it this stops
        // deleting fragments entirely and the vault leaks `.part` files for
        // ever - which is why these two changes have to land together.
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem == want.as_str() || stem.starts_with(&format!("{want}.")) {
            let _ = std::fs::remove_file(&path);
        }
    }
    prune_empty_dirs(&base);
    Ok(())
}

/// Everything, gone - the "free up space" button in Settings.
#[tauri::command]
pub async fn offline_clear(app: tauri::AppHandle) -> Result<(), String> {
    let base = dir(&app)?;
    for (_, path) in walk(&base) {
        let _ = std::fs::remove_file(&path);
    }
    // walk() never yields dot-entries, so .nomedia survives the purge on its
    // own - without it the first song cached into the emptied folder would
    // join the phone's music library. The ledger describes nothing now.
    let _ = std::fs::remove_file(base.join(INDEX_FILE));
    prune_empty_dirs(&base);
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct RebrandItem {
    pub key: String,
    /// The flat "Artist - Title" fallback, kept for root-level files.
    pub name: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub title: Option<String>,
}

/// Move held files to where the shelves say they belong - hex-era names,
/// flat readable names from the shelfless era, all of it - in one batch so a
/// vault of thousands costs one walk and one ledger write. The web layer
/// sends (key, names) pairs for files it can see are not shelved yet;
/// anything already in place no-ops here.
///
/// Optional the way `offline_set_root` is: an older binary refuses the
/// invoke (or, one generation back, renames flat), the files stay playable
/// either way, and no NATIVE_GENERATION bump is owed.
#[tauri::command]
pub async fn offline_rebrand(
    app: tauri::AppHandle,
    items: Vec<RebrandItem>,
) -> Result<Vec<OfflineEntry>, String> {
    let base = dir(&app)?;
    let mut index = load_index(&base);
    // One walk up front: relpath -> hex stem, for finding legacy files
    // without touching the disk once per item.
    let on_disk = walk(&base);
    let mut out = Vec::new();
    let mut dirty = false;
    for item in &items {
        let hex = to_hex(&item.key);
        // Every finished file this key holds, whatever its quality: ledger
        // claims plus on-disk legacy hex names.
        let mut current: Vec<String> =
            index.iter().filter(|(_, k)| **k == item.key).map(|(f, _)| f.clone()).collect();
        for (rel, path) in &on_disk {
            if path.extension().and_then(|e| e.to_str()) == Some("part") {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem == hex && !current.contains(rel) {
                current.push(rel.clone());
            }
        }
        for f in current {
            let ext = f.rsplit('.').next().unwrap_or("audio").to_string();
            let desired = decide_relpath(
                &index,
                &item.key,
                &ext,
                item.artist.as_deref(),
                item.album.as_deref(),
                item.title.as_deref(),
                Some(&item.name),
                false,
            );
            if f == desired {
                continue;
            }
            let from = base.join(&f);
            let to = base.join(&desired);
            if !from.is_file() || to.exists() {
                continue;
            }
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::rename(&from, &to).is_ok() {
                index.remove(&f);
                index.insert(desired, item.key.clone());
                dirty = true;
                if let Ok(meta) = std::fs::metadata(&to) {
                    out.push(OfflineEntry {
                        key: item.key.clone(),
                        path: to.to_string_lossy().into_owned(),
                        bytes: meta.len(),
                    });
                }
            }
        }
    }
    if dirty {
        save_index(&base, &index);
        prune_empty_dirs(&base);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_come_out_browsable() {
        assert_eq!(sanitize_stem("Daft Punk - One More Time"), Some("Daft Punk - One More Time".into()));
        // The filesystem's forbidden characters become spaces, then collapse.
        assert_eq!(sanitize_stem("AC/DC: Back?"), Some("AC DC Back".into()));
        // Nothing usable in the name means the hex form should stand instead.
        assert_eq!(sanitize_stem("///"), None);
        assert_eq!(sanitize_stem("  . "), None);
        // Long names stop under the filename limit, never mid-codepoint, and
        // never on a trailing dot Windows would strip.
        let long = sanitize_stem(&"ノ".repeat(200)).unwrap();
        assert!(long.len() <= 120 && long.chars().all(|c| c == 'ノ'));
    }

    fn rel(
        index: &BTreeMap<String, String>,
        key: &str,
        artist: Option<&str>,
        album: Option<&str>,
        title: Option<&str>,
        name: Option<&str>,
    ) -> String {
        decide_relpath(index, key, "flac", artist, album, title, name, true)
    }

    #[test]
    fn shelves_read_like_a_record_collection() {
        let mut index = BTreeMap::new();
        // The full shelf: artist folder, album folder, title-only filename.
        assert_eq!(
            rel(&index, "afm://1", Some("Joji"), Some("BALLADS 1"), Some("YEAH RIGHT"), Some("Joji - YEAH RIGHT")),
            "Joji/BALLADS 1/YEAH RIGHT.flac"
        );
        index.insert("Joji/BALLADS 1/YEAH RIGHT.flac".to_string(), "afm://1".to_string());
        // Same key again answers with its existing path, not a move.
        assert_eq!(
            rel(&index, "afm://1", Some("Joji"), Some("Ballads One"), Some("Yeah Right?"), None),
            "Joji/BALLADS 1/YEAH RIGHT.flac"
        );
        // No album: the song sits in the artist's folder directly.
        assert_eq!(
            rel(&index, "afm://2", Some("Joji"), None, Some("Glimpse"), None),
            "Joji/Glimpse.flac"
        );
        // No artist at all: the flat "Artist - Title" name carries the context
        // at the root, and slashes inside names cannot invent folders.
        assert_eq!(
            rel(&index, "afm://3", None, None, Some("Intro"), Some("AC/DC - Intro")),
            "AC DC - Intro.flac"
        );
        // A DIFFERENT song on the same shelf with the same title gets the tag -
        // case-insensitively, because Android's storage cannot tell them apart.
        let clash = rel(&index, "afm://4", Some("joji"), Some("ballads 1"), Some("yeah right"), None);
        assert_eq!(clash, format!("joji/ballads 1/yeah right ({}).flac", short_tag("afm://4")));
        // Nothing readable anywhere falls back to the hex era's form.
        assert_eq!(rel(&index, "afm://5", None, None, None, None), format!("{}.flac", to_hex("afm://5")));
        // The organize pass ignores the existing claim - that is how a flat
        // file learns where its shelf is.
        assert_eq!(
            decide_relpath(&index, "afm://1", "flac", Some("Joji"), Some("BALLADS 1"), Some("YEAH RIGHT"), None, false),
            "Joji/BALLADS 1/YEAH RIGHT.flac"
        );
    }

    #[test]
    fn listing_walks_shelves_and_both_generations() {
        let dir = std::env::temp_dir().join(format!("afm-vault-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Joji/BALLADS 1")).unwrap();
        std::fs::write(dir.join("Joji/BALLADS 1/YEAH RIGHT.flac"), b"x").unwrap();
        std::fs::write(dir.join(format!("{}.flac", to_hex("afm://old"))), b"x").unwrap();
        std::fs::write(dir.join("Joji/BALLADS 1/Glimpse.flac.part"), b"x").unwrap();
        std::fs::write(dir.join(INDEX_FILE), b"{}").unwrap();
        std::fs::write(dir.join(".nomedia"), b"").unwrap();
        std::fs::write(dir.join("somebody-elses.mp3"), b"x").unwrap();
        let mut index = BTreeMap::new();
        index.insert("Joji/BALLADS 1/YEAH RIGHT.flac".to_string(), "afm://42".to_string());
        let mut keys: Vec<String> = walk(&dir)
            .into_iter()
            .filter_map(|(rel, path)| entry_of(&rel, &path, &index))
            .map(|e| e.key)
            .collect();
        keys.sort();
        assert_eq!(keys, vec!["afm://42".to_string(), "afm://old".to_string()]);
        // Unpinning the album's last song folds the empty shelves away.
        std::fs::remove_file(dir.join("Joji/BALLADS 1/YEAH RIGHT.flac")).unwrap();
        std::fs::remove_file(dir.join("Joji/BALLADS 1/Glimpse.flac.part")).unwrap();
        prune_empty_dirs(&dir);
        assert!(!dir.join("Joji").exists(), "empty artist shelf should fold away");
        assert!(dir.join(".nomedia").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

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
