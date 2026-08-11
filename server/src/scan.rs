//! The library scanner: walks the music root, reads each file's tags, and
//! writes the result into the index.
//!
//! It is deliberately incremental. A pass fingerprints every file by (mtime,
//! size) and skips the ones the index already agrees with, so re-scanning a
//! settled library is a directory walk and nothing more - which matters on a
//! one-core box where a full tag read of ten thousand files is minutes of CPU
//! that would otherwise be stolen from whoever is listening.

use crate::db::{Db, ScannedTrack};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;

/// The extensions the walk treats as music, matching the client's own list.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "m4b", "aac", "flac", "wav", "aiff", "aif", "ogg", "oga", "opus", "wma", "ape",
    "wv", "alac",
];

/// Where the duplicate resolver quarantines dropped files, inside the music
/// root. The walk must skip it, or everything "deleted" this way would be
/// re-imported on the next pass.
pub const TRASH_DIR: &str = ".attackfm-trash";

/// Where a scan has got to, for the status endpoint.
#[derive(Default)]
pub struct ScanProgress {
    pub running: AtomicBool,
    pub seen: AtomicI64,
    pub total: AtomicI64,
    pub added: AtomicI64,
    pub removed: AtomicI64,
    pub last_finished: AtomicI64,
}

impl ScanProgress {
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "running": self.running.load(Ordering::Relaxed),
            "seen": self.seen.load(Ordering::Relaxed),
            "total": self.total.load(Ordering::Relaxed),
            "added": self.added.load(Ordering::Relaxed),
            "removed": self.removed.load(Ordering::Relaxed),
            "lastFinished": self.last_finished.load(Ordering::Relaxed),
        })
    }
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Every audio file under `root`, as paths relative to it.
///
/// Symlinks are not followed: a music root is a place for music, and a link
/// pointing at `/` would otherwise walk the whole filesystem.
fn walk(root: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                // The quarantine holds files a person deliberately removed
                // from the library; walking it would resurrect them.
                if path.file_name().and_then(|n| n.to_str()) == Some(TRASH_DIR) {
                    continue;
                }
                stack.push(path);
            } else if meta.is_file() && is_audio(&path) {
                if let Ok(rel) = path.strip_prefix(root) {
                    if let Some(rel) = rel.to_str() {
                        out.push((path.clone(), rel.to_string()));
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
    out
}

/// Writes a cover to the art cache under its own content hash and returns that
/// hash. Two albums that ship the same JPEG land on one file.
fn store_art(art_dir: &Path, data: &[u8], mime: &str) -> Option<String> {
    let digest = Sha256::digest(data);
    let id = URL_SAFE_NO_PAD.encode(&digest[..16]);
    let ext = match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    let path = art_dir.join(format!("{id}.{ext}"));
    if !path.exists() {
        std::fs::create_dir_all(art_dir).ok()?;
        std::fs::write(&path, data).ok()?;
    }
    Some(id)
}

/// Finds a cached cover by its hash, whatever extension it landed under.
pub fn art_path(art_dir: &Path, id: &str) -> Option<PathBuf> {
    // The id is a base64url hash the server minted; anything carrying a path
    // separator or a dot did not come from us and is not looked up.
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains('.') {
        return None;
    }
    for ext in ["jpg", "png", "webp", "gif"] {
        let candidate = art_dir.join(format!("{id}.{ext}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Falls back to the file name (minus extension) when a file carries no title.
fn name_without_extension(rel_path: &str) -> String {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    match name.rfind('.') {
        Some(dot) => name[..dot].to_string(),
        None => name.to_string(),
    }
}

/// Reads one file into a scannable row. Returns None when the file cannot be
/// parsed at all - one unreadable file must never fail a pass.
fn read_track(path: &Path, rel_path: &str, art_dir: &Path) -> Option<ScannedTrack> {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::{Accessor, ItemKey};
    use lofty::probe::Probe;

    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let tagged = Probe::open(path).ok()?.read().ok()?;
    let properties = tagged.properties();
    let file_type = tagged.file_type();
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let text = |key: &ItemKey| -> String {
        tag.and_then(|t| t.get_string(key))
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };

    let title = tag
        .and_then(|t| t.title())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| name_without_extension(rel_path));
    let artist = tag
        .and_then(|t| t.artist())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Unknown artist".to_string());
    let album = tag
        .and_then(|t| t.album())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    // An album artist is what groups a compilation; falling back to the track
    // artist keeps every album grouped by something.
    let album_artist = {
        let tagged_value = text(&ItemKey::AlbumArtist);
        if tagged_value.is_empty() {
            artist.clone()
        } else {
            tagged_value
        }
    };

    // Cover art: the first picture the tag carries, cached by content hash.
    let art_id = tag
        .and_then(|t| t.pictures().first())
        .and_then(|pic| {
            let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
            store_art(art_dir, pic.data(), mime)
        });

    let lossless = matches!(
        file_type,
        lofty::file::FileType::Flac
            | lofty::file::FileType::Wav
            | lofty::file::FileType::Aiff
            | lofty::file::FileType::Ape
            | lofty::file::FileType::WavPack
    // ALAC and AAC share the MP4 container, and lofty's generic properties do
    // not name the codec. A reported bit depth is the tell: ALAC carries one,
    // AAC does not. An approximation, and flagged as such - it decides a badge,
    // never what gets served.
    ) || (matches!(file_type, lofty::file::FileType::Mp4) && properties.bit_depth().is_some());

    Some(ScannedTrack {
        rel_path: rel_path.to_string(),
        title,
        artist,
        album_artist,
        album,
        track_no: tag.and_then(|t| t.track()).map(|n| n as i64),
        disc_no: tag.and_then(|t| t.disk()).map(|n| n as i64),
        year: tag.and_then(|t| t.year()).map(|n| n as i64),
        genre: tag.and_then(|t| t.genre()).map(|s| s.trim().to_string()).unwrap_or_default(),
        lyrics: text(&ItemKey::Lyrics),
        duration_ms: Some(properties.duration().as_millis() as i64),
        codec: format!("{file_type:?}").to_lowercase(),
        lossless,
        sample_rate: properties.sample_rate().map(|n| n as i64),
        bit_depth: properties.bit_depth().map(|n| n as i64),
        channels: properties.channels().map(|n| n as i64),
        bitrate: properties.audio_bitrate().map(|n| n as i64),
        size_bytes: meta.len() as i64,
        mtime,
        art_id,
    })
}

/// Runs one pass over the music root.
///
/// Blocking work, so callers hand it to a blocking thread rather than running
/// it on the async runtime - a tag read is a synchronous file read and there is
/// only one core to steal.
pub fn run_scan(db: &Db, music_root: &Path, art_dir: &Path, progress: &ScanProgress) {
    if progress
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        // A pass is already under way; a second one would only fight it.
        return;
    }
    progress.seen.store(0, Ordering::Relaxed);
    progress.added.store(0, Ordering::Relaxed);
    progress.removed.store(0, Ordering::Relaxed);

    let files = walk(music_root);
    progress.total.store(files.len() as i64, Ordering::Relaxed);

    let known = db.scan_fingerprints();
    // Every pass that changes anything stamps its rows with one new revision,
    // so a client's delta is "everything above the number I last saw".
    let rev = db.current_rev() + 1;
    let mut present: HashSet<String> = HashSet::with_capacity(files.len());
    let mut added = 0i64;

    for (path, rel_path) in files {
        present.insert(rel_path.clone());
        progress.seen.fetch_add(1, Ordering::Relaxed);

        // Unchanged since the index last looked: nothing to re-read.
        if let Some((mtime, size)) = known.get(&rel_path) {
            let unchanged = std::fs::metadata(&path)
                .map(|m| {
                    let mt = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    mt == *mtime && m.len() as i64 == *size
                })
                .unwrap_or(false);
            if unchanged {
                continue;
            }
        }

        if let Some(track) = read_track(&path, &rel_path, art_dir) {
            if db.upsert_track(&track, rev).is_ok() {
                added += 1;
            }
        }
    }

    let removed = db.tombstone_missing(&present, rev);
    progress.added.store(added, Ordering::Relaxed);
    progress.removed.store(removed, Ordering::Relaxed);
    progress.last_finished.store(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        Ordering::Relaxed,
    );
    progress.running.store(false, Ordering::SeqCst);
}

/// Indexes a single file that has just been uploaded, without walking anything.
pub fn scan_one(db: &Db, music_root: &Path, art_dir: &Path, rel_path: &str) -> bool {
    let path = music_root.join(rel_path);
    let Some(track) = read_track(&path, rel_path, art_dir) else {
        return false;
    };
    let rev = db.current_rev() + 1;
    db.upsert_track(&track, rev).is_ok()
}

/// Kicks a scan off on a blocking thread and returns at once.
pub fn spawn_scan(
    db: Arc<Db>,
    music_root: PathBuf,
    art_dir: PathBuf,
    progress: Arc<ScanProgress>,
) {
    tokio::task::spawn_blocking(move || {
        run_scan(&db, &music_root, &art_dir, &progress);
    });
}
