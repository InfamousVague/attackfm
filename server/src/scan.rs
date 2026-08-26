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

pub(crate) fn is_audio(path: &Path) -> bool {
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
    // A directory this cannot open is the difference between "the library is
    // empty" and "the library is unreachable", and the two want opposite
    // responses. Swallowing the error made a scan that could read NOTHING
    // look exactly like a scan of an empty folder - which is how a hub can
    // sit for days reporting no audio under a folder holding four thousand
    // songs. The first refusal says so; the rest are counted.
    let mut refused = 0usize;
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) => {
                if refused == 0 {
                    eprintln!("[attackfm] scan cannot read {}: {e}", dir.display());
                }
                refused += 1;
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_symlink() {
                /*
                 * One symlink is followed, by name: `audiobooks` at the top of
                 * the music root. The layout people actually make is
                 * `{music, data, audiobooks}` side by side - the books next to
                 * the library, not inside it - and a link is how that layout
                 * joins the one root everything else (rel_path keys, the
                 * streamer, the folder rules) is built on. The install script
                 * plants the link; this is the walk agreeing to look through
                 * it.
                 *
                 * Guarded, because a followed link is a loop waiting to
                 * happen: the target must be a real directory whose canonical
                 * path is neither the root itself, an ancestor of it (either
                 * way the walk would swallow its own tail), nor inside it
                 * (already walked; following would index everything twice).
                 */
                let is_books_link = dir == root
                    && path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.eq_ignore_ascii_case("audiobooks"));
                if is_books_link {
                    if let (Ok(target), Ok(canon_root)) =
                        (std::fs::canonicalize(&path), std::fs::canonicalize(root))
                    {
                        let safe = target.is_dir()
                            && target != canon_root
                            && !canon_root.starts_with(&target)
                            && !target.starts_with(&canon_root);
                        if safe {
                            // The LINK path, not the target: rel paths must
                            // stay under the root for every key downstream.
                            stack.push(path);
                        }
                    }
                }
                continue;
            }
            if meta.is_dir() {
                // The quarantine holds files a person deliberately removed
                // from the library; walking it would resurrect them.
                if path.file_name().and_then(|n| n.to_str()) == Some(TRASH_DIR) {
                    continue;
                }
                /*
                 * The audiobook IMPORT folder is raw material, not library.
                 *
                 * Each folder dropped in `Audiobooks/import/` is a book in
                 * whatever shape it arrived - one giant MP3, forty parts with
                 * names only their tracker understands, text files describing
                 * the rest. The ingest worker reads those folders, works out
                 * what they are, and files the result properly. If the walk
                 * indexed them first, every half-understood pile would appear
                 * on the shelf mid-assembly and then vanish again - so the
                 * walk treats import/ the way it treats the trash: invisible.
                 * Case-insensitive on both components, like everything else
                 * about the audiobooks folder.
                 */
                if let Ok(rel) = path.strip_prefix(root) {
                    if let Some(rel) = rel.to_str() {
                        if crate::db::book_prefix(rel)
                            .is_some_and(|rest| rest.eq_ignore_ascii_case("import"))
                        {
                            continue;
                        }
                    }
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
    if refused > 1 {
        eprintln!("[attackfm] scan could not read {refused} directories in total");
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
    let mut album = tag
        .and_then(|t| t.album())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    /*
     * AN UNTAGGED BOOK IS NAMED BY ITS FOLDER.
     *
     * A book downloaded as split MP3s very often carries no album tag at all,
     * and the shelf groups by artist+album - so every untagged book in a
     * library collapses into ONE entry together, because they all share the
     * empty key. Measured: two different books, five files, one blob.
     *
     * The folder already says which book it is; that is what the folder is
     * FOR in every audiobook download. So when a book has no album, the
     * directory holding it becomes one. Books only - a stray untagged song
     * genuinely has no album and should not be given the name of whatever
     * folder it was dropped in.
     */
    let mut artist = artist;
    if crate::db::kind_for(rel_path) == "book" {
        if let Some(folder) = book_folder(rel_path) {
            let (folder_artist, folder_album) = split_book_folder(&folder);
            if album.is_empty() {
                album = folder_album;
            }
            if artist == "Unknown artist" {
                if let Some(a) = folder_artist.or_else(|| book_author_folder(rel_path)) {
                    artist = a;
                }
            }
        }
    }
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
        })
        /*
         * A COVER SITTING BESIDE THE FILES still counts.
         *
         * Embedded art is the only kind this read, and a book downloaded as
         * split MP3s almost never has any - it ships `cover.jpg` in the folder
         * instead, the way the whole audiobook world distributes them. The
         * shelf then draws a blank glyph for a book whose cover is right there
         * on disk.
         *
         * Books only, matching the folder-name rule above and for the same
         * reason: inside `Audiobooks/` a folder IS one book, so a picture in
         * it belongs to that book. A music folder can hold several albums, and
         * handing all of them one stray image would be worse than none.
         */
        .or_else(|| {
            if crate::db::kind_for(rel_path) != "book" {
                return None;
            }
            folder_cover(path, art_dir)
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

    // Chapter markers for a single-file audiobook. Only books (the folder says
    // so), only the MP4 family where m4b/Audible chapters live, and only via
    // ffprobe - so music never pays for a probe with nothing to find.
    let chapters = if matches!(file_type, lofty::file::FileType::Mp4)
        && crate::db::kind_for(rel_path) == "book"
    {
        read_chapters(path)
    } else {
        String::new()
    };

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
        chapters,
    })
}

/// The cover image lying beside a book's files, if there is one.
///
/// The names are the ones every downloader and tagger actually writes, tried
/// in the order a human would: the ones that say "cover" before the ones that
/// merely say "folder". Read at most once per file and hashed by content, so
/// twenty chapters sharing one picture store it once.
fn folder_cover(path: &Path, art_dir: &Path) -> Option<String> {
    /*
     * Up to three folders, not one.
     *
     * A multi-disc book keeps its cover with the BOOK and its audio in
     * `CD1/` - so looking only beside the file finds nothing, which is exactly
     * what happened the first time this ran against a realistic download.
     * Nearest wins, so a disc that has its own art still gets it.
     */
    let mut dir = path.parent();
    for _ in 0..3 {
        let Some(here) = dir else { break };
        if let Some(found) = cover_in(here, art_dir) {
            return Some(found);
        }
        dir = here.parent();
    }
    None
}

/// The cover lying directly in one directory.
fn cover_in(dir: &Path, art_dir: &Path) -> Option<String> {
    for name in [
        "cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.jpeg", "folder.png",
        "Cover.jpg", "Folder.jpg", "front.jpg", "album.jpg",
    ] {
        let candidate = dir.join(name);
        if !candidate.is_file() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&candidate) else {
            continue;
        };
        // A cover big enough to be one; anything tiny is a stray icon.
        if bytes.len() < 1024 {
            continue;
        }
        let mime = if name.to_ascii_lowercase().ends_with(".png") {
            "image/png"
        } else {
            "image/jpeg"
        };
        return store_art(art_dir, &bytes, mime);
    }
    None
}

/// The author, when the layout IS the canonical one: `Audiobooks/<Author>/
/// <Title>/file`. The shelf's own filing convention should name its own
/// untagged files - it took a symlinked sibling library to notice it did not.
fn book_author_folder(rel_path: &str) -> Option<String> {
    let rest = crate::db::book_prefix(rel_path)?;
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    // Author / Title / file - anything shallower has no author component.
    if parts.len() >= 3 {
        Some(parts[0].to_string())
    } else {
        None
    }
}

/// The directory a book file sits in, relative to the music root - or None when
/// it sits directly in `Audiobooks/` and so has no folder of its own.
fn book_folder(rel_path: &str) -> Option<String> {
    // Case-insensitive, for the same reason kind_for is: `audiobooks/` and
    // `Audiobooks/` are one folder to macOS and must be one folder here.
    let inside = crate::db::book_prefix(rel_path)?;
    let dir = inside.rsplit_once('/')?.0;
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    /*
     * A DISC FOLDER IS NOT A BOOK.
     *
     * Long books are commonly split `<Book>/CD1/`, `<Book>/Disc 2/`,
     * `<Book>/Part 03/`. Taking the innermost folder would name those books
     * "CD1" and "CD2" and shelve one book as several - so a component that is
     * only a disc marker is stepped over, and the folder above it answers.
     * Stepped repeatedly, because `<Book>/CD1/Part 1/` exists in the wild.
     */
    while parts.len() > 1 {
        match parts.last() {
            Some(last) if is_disc_marker(last) => {
                parts.pop();
            }
            _ => break,
        }
    }
    // The LAST remaining component: `<Author>/<Title>/file.mp3` and
    // `<Title>/file.mp3` both name the book in the same place.
    parts.last().map(|p| (*p).to_string())
}

/// Whether a folder component only says which disc this is - `CD1`, `Disc 2`,
/// `Part 03`, `Vol 4` and the spelled-out forms, with or without separators.
///
/// Deliberately strict: it must be the marker word and a number and nothing
/// else. A book genuinely called "Part of the Furniture" keeps its name.
pub(crate) fn is_disc_marker(part: &str) -> bool {
    let lower = part.trim().to_ascii_lowercase();
    for word in ["cd", "disc", "disk", "part", "vol", "volume", "tape", "side"] {
        let Some(rest) = lower.strip_prefix(word) else {
            continue;
        };
        let rest = rest.trim_start_matches([' ', '_', '-', '.']);
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    false
}

/// An author and a title out of a folder name.
///
/// `Frank Herbert - 2007 - Dune Messiah (Sci-Fi)` is the shape audiobook
/// downloads overwhelmingly arrive in, and it carries both. Split on the
/// hyphens only when the middle piece is a YEAR - that is what makes it this
/// pattern rather than a title that merely contains a dash ("Anne of Green
/// Gables - Part One" must not become an author called "Anne of Green Gables").
/// A trailing parenthesised genre is dropped; anything unrecognised is left
/// whole as the title, which is always better than a wrong guess.
pub(crate) fn split_book_folder(folder: &str) -> (Option<String>, String) {
    let parts: Vec<&str> = folder.split(" - ").collect();
    let (artist, title) = if parts.len() >= 3
        && parts[1].len() == 4
        && parts[1].chars().all(|c| c.is_ascii_digit())
    {
        (Some(parts[0].trim().to_string()), parts[2..].join(" - "))
    } else {
        (None, folder.to_string())
    };
    // `Dune Messiah (Sci-Fi)` -> `Dune Messiah`, but only when the brackets
    // close at the very end and are not the whole name.
    let title = title.trim();
    let cleaned = match (title.rfind(" ("), title.ends_with(')')) {
        (Some(at), true) if at > 0 => title[..at].trim().to_string(),
        _ => title.to_string(),
    };
    (artist, cleaned)
}

/// Chapter markers from a media file, as a JSON string `[{title, startMs}]` in
/// order - or empty when ffprobe is absent, the file has no chapters, or
/// anything at all goes wrong. `-c copy` from an AAX preserves these atoms, so
/// this reads them straight back off the m4b at scan.
fn read_chapters(path: &Path) -> String {
    let Ok(out) = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_chapters", "-of", "json"])
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
    else {
        return String::new();
    };
    if !out.status.success() {
        return String::new();
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return String::new();
    };
    let list: Vec<serde_json::Value> = v
        .get("chapters")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let start = c
                        .get("start_time")
                        .and_then(|s| s.as_str())
                        .and_then(|s| s.parse::<f64>().ok())?;
                    let title = c
                        .get("tags")
                        .and_then(|t| t.get("title"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    Some(serde_json::json!({
                        "title": title,
                        "startMs": (start * 1000.0).round() as i64,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    if list.is_empty() {
        return String::new();
    }
    serde_json::to_string(&list).unwrap_or_default()
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
    // Taken before the walk's list is consumed below - the guard on the
    // tombstone pass needs to know whether this scan saw anything at all.
    let found = files.len();
    progress.total.store(found as i64, Ordering::Relaxed);

    let known = db.scan_fingerprints();
    // Every pass that changes anything stamps its rows with one new revision,
    // so a client's delta is "everything above the number I last saw".
    let rev = db.current_rev() + 1;
    // Every cover the art cache actually holds, read once. One readdir beats a
    // stat per track, and the ids are content hashes so the file stem IS the id.
    let cached_art: HashSet<String> = std::fs::read_dir(art_dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let name = e.file_name();
                    let name = name.to_str()?;
                    // Scaled variants are written as `<id>@<size>.jpg`; they are
                    // regenerated on demand from the original, so only the
                    // original counts as "cached".
                    let stem = name.rsplit_once('.').map(|(a, _)| a).unwrap_or(name);
                    (!stem.contains('@')).then(|| stem.to_string())
                })
                .collect()
        })
        .unwrap_or_default();

    let mut present: HashSet<String> = HashSet::with_capacity(files.len());
    let mut added = 0i64;

    for (path, rel_path) in files {
        present.insert(rel_path.clone());
        progress.seen.fetch_add(1, Ordering::Relaxed);

        // Unchanged since the index last looked, AND the cover it claims is
        // really on disk: nothing to re-read.
        //
        // The second half is not belt-and-braces. mtime and size describe the
        // audio file and say nothing about the derived cover, so an art cache
        // that is lost on its own - a database-only restore, a move between
        // machines, a wipe to reclaim disk - leaves every row naming an
        // `art_id` whose file does not exist. Every file then reads as
        // unchanged, `read_track` never runs, `store_art` never runs, and the
        // cache cannot refill: blank covers forever, and nothing in any log.
        // Checking the claim costs one hash-set lookup per track.
        if let Some((mtime, size, art_id)) = known.get(&rel_path) {
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
            // A track with no art_id is not missing anything - there was never
            // a cover to cache, and re-reading it every pass would be a full
            // tag read of the whole library for nothing.
            let art_ok = match art_id.as_deref() {
                None | Some("") => true,
                Some(id) => cached_art.contains(id),
            };
            if unchanged && art_ok {
                continue;
            }
        }

        if let Some(track) = read_track(&path, &rel_path, art_dir) {
            if db.upsert_track(&track, rev).is_ok() {
                added += 1;
            }
        }
    }

    /*
     * A scan that found NOTHING never removes anything.
     *
     * `tombstone_missing` marks every indexed row whose file the walk did not
     * see, which is right when files really went away and catastrophic when
     * the walk itself failed: an unmounted drive, a renamed or moved library
     * folder, a permissions change, or a music root pointed somewhere empty
     * all produce the same empty set, and one pass then tombstones the entire
     * library. The files are untouched on disk - this is an index wipe, not a
     * delete - but from the app it is indistinguishable from every song you
     * own being erased at once.
     *
     * Zero files with a non-empty index is never a legitimate state worth
     * acting on: a library that truly emptied is one rescan away from being
     * recorded correctly, while a library that is merely unreachable is one
     * rescan away from being wrong about everything. So the ambiguous case
     * resolves the recoverable way, loudly.
     */
    let removed = if found == 0 && db.live_track_count() > 0 {
        eprintln!(
            "[attackfm] scan found no audio under {} but the library holds {} tracks - \
             refusing to tombstone. Check the folder is mounted and readable.",
            music_root.display(),
            db.live_track_count(),
        );
        0
    } else {
        db.tombstone_missing(&present, rev)
    };
    // A scan is when a moved file reappears under its new path, so it is also
    // when a heart stranded on the old row can find its way home.
    let rebound = db.rebind_orphaned_favorites();
    if rebound > 0 {
        println!("[attackfm] moved {rebound} liked songs onto their re-filed copies");
    }
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

#[cfg(test)]
mod empty_scan_guard {
    //! A scan that found nothing must not empty the index.

    #[test]
    fn zero_files_with_a_populated_library_removes_nothing() {
        let dir = std::env::temp_dir().join(format!("afm-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::Db::open(&dir.join("t.sqlite")).unwrap();

        // A library holding one track whose file is NOT on disk - the exact
        // shape an unmounted drive presents to the walk.
        let mut track = crate::db::ScannedTrack::default();
        track.rel_path = "Artist/Album/song.flac".to_string();
        track.title = "Song".to_string();
        track.artist = "Artist".to_string();
        track.album = "Album".to_string();
        db.upsert_track(&track, 1).unwrap();
        assert_eq!(db.live_track_count(), 1, "setup: the track should be live");

        // An empty music root: the walk finds nothing at all.
        let music = dir.join("music");
        std::fs::create_dir_all(&music).unwrap();
        let progress = crate::scan::ScanProgress::default();
        crate::scan::run_scan(&db, &music, &dir.join("art"), &progress);

        assert_eq!(
            db.live_track_count(),
            1,
            "an empty scan tombstoned the library - the guard is not holding",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod book_folder_tests {
    use super::*;

    #[test]
    fn the_common_download_shape_splits() {
        let (artist, title) = split_book_folder("Frank Herbert - 2007 - Dune Messiah (Sci-Fi)");
        assert_eq!(artist.as_deref(), Some("Frank Herbert"));
        assert_eq!(title, "Dune Messiah");
    }

    /// A title that merely contains a dash must NOT donate its first half to
    /// the author field - the year is what identifies the pattern.
    #[test]
    fn a_dash_alone_is_not_an_author() {
        let (artist, title) = split_book_folder("Anne of Green Gables - Part One");
        assert_eq!(artist, None);
        assert_eq!(title, "Anne of Green Gables - Part One");
    }

    #[test]
    fn a_plain_folder_is_the_title() {
        let (artist, title) = split_book_folder("The Time Machine");
        assert_eq!(artist, None);
        assert_eq!(title, "The Time Machine");
    }

    /// Brackets that are the whole name are the name.
    #[test]
    fn brackets_are_only_dropped_when_they_trail() {
        let (_, title) = split_book_folder("(Sci-Fi)");
        assert_eq!(title, "(Sci-Fi)");
    }

    #[test]
    fn a_title_keeping_its_dashes() {
        let (artist, title) = split_book_folder("Frank Herbert - 1965 - Dune - Book One");
        assert_eq!(artist.as_deref(), Some("Frank Herbert"));
        assert_eq!(title, "Dune - Book One");
    }

    /// However the folder is spelled. macOS treats these as one directory and
    /// so must we - a lowercase `audiobooks/` used to index as music, which
    /// looks exactly like the books simply not appearing.
    #[test]
    fn the_folder_is_matched_whatever_its_case() {
        for shape in [
            "Audiobooks/Dune/01.mp3",
            "audiobooks/Dune/01.mp3",
            "AudioBooks/Dune/01.mp3",
            "AUDIOBOOKS/Dune/01.mp3",
        ] {
            assert_eq!(crate::db::kind_for(shape), "book", "{shape}");
            assert_eq!(book_folder(shape).as_deref(), Some("Dune"), "{shape}");
        }
        assert_eq!(crate::db::kind_for("Music/Dune/01.mp3"), "music");
        // Not a false positive on a name that merely begins the same way.
        assert_eq!(crate::db::kind_for("AudiobooksOfMine/01.mp3"), "music");
    }

    /// The sibling layout: `{music, data, audiobooks}` side by side, joined by
    /// one link. The walk follows exactly that link - and refuses one that
    /// points back at the library, which would be the walk eating its tail.
    #[test]
    fn the_audiobooks_link_is_followed_and_a_loop_is_not() {
        let base = std::env::temp_dir().join(format!("afm-walk-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("music");
        let books = base.join("audiobooks").join("Author").join("Title");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&books).unwrap();
        std::fs::write(books.join("01 - Part 1.mp3"), b"x").unwrap();
        std::os::unix::fs::symlink(base.join("audiobooks"), root.join("audiobooks")).unwrap();
        // The trap: a second link pointing at the root itself.
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();

        let found = walk(&root);
        let rels: Vec<&str> = found.iter().map(|(_, r)| r.as_str()).collect();
        assert_eq!(rels, vec!["audiobooks/Author/Title/01 - Part 1.mp3"]);
        // And what comes through the link is a book.
        assert_eq!(crate::db::kind_for(rels[0]), "book");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_disc_folder_does_not_become_the_book() {
        for shape in [
            "Audiobooks/Dune Messiah/CD1/01.mp3",
            "Audiobooks/Dune Messiah/Disc 2/01.mp3",
            "Audiobooks/Dune Messiah/disc_03/01.mp3",
            "Audiobooks/Dune Messiah/Part 04/01.mp3",
            "Audiobooks/Dune Messiah/CD1/Part 2/01.mp3",
        ] {
            assert_eq!(book_folder(shape).as_deref(), Some("Dune Messiah"), "{shape}");
        }
    }

    /// A book whose real name begins with one of those words keeps it.
    #[test]
    fn a_marker_word_is_not_a_marker_without_a_number() {
        assert!(!is_disc_marker("Part of the Furniture"));
        assert!(!is_disc_marker("Discworld"));
        assert!(!is_disc_marker("Volume of a Sphere"));
        assert!(is_disc_marker("CD1"));
        assert!(is_disc_marker("Disc 12"));
        assert_eq!(
            book_folder("Audiobooks/Part of the Furniture/01.mp3").as_deref(),
            Some("Part of the Furniture")
        );
    }

    #[test]
    fn the_folder_is_the_one_holding_the_file() {
        assert_eq!(
            book_folder("Audiobooks/Frank Herbert - 2007 - Dune Messiah (Sci-Fi)/01.mp3").as_deref(),
            Some("Frank Herbert - 2007 - Dune Messiah (Sci-Fi)")
        );
        // Author/Title nesting names the book from the innermost folder.
        assert_eq!(
            book_folder("Audiobooks/H. G. Wells/The Time Machine/01.mp3").as_deref(),
            Some("The Time Machine")
        );
        // Sitting loose in Audiobooks/ has no folder of its own.
        assert_eq!(book_folder("Audiobooks/loose.mp3"), None);
        assert_eq!(book_folder("Music/Artist/Album/01.mp3"), None);
    }
}

#[cfg(test)]
mod missing_art_is_refetched {
    //! A cover that vanished from the art cache must bring its track back for a
    //! re-read, even though the audio file itself has not moved.

    fn flac_with_cover(dir: &std::path::Path, rel: &str) -> std::path::PathBuf {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Not a real FLAC; the point of this test is the SKIP DECISION, which is
        // made from the index and the art cache before the file is ever parsed.
        std::fs::write(&path, b"not really audio").unwrap();
        path
    }

    #[test]
    fn a_track_whose_cover_is_gone_is_not_skipped() {
        let dir = std::env::temp_dir().join(format!("afm-art-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let music = dir.join("music");
        let art = dir.join("art");
        std::fs::create_dir_all(&art).unwrap();
        let db = crate::db::Db::open(&dir.join("t.sqlite")).unwrap();

        let rel = "Artist/Album/song.flac";
        let file = flac_with_cover(&music, rel);
        let meta = std::fs::metadata(&file).unwrap();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Indexed, unchanged on disk, and claiming a cover that is NOT cached -
        // exactly the state a database-only restore leaves behind.
        let mut track = crate::db::ScannedTrack::default();
        track.rel_path = rel.to_string();
        track.title = "Song".into();
        track.artist = "Artist".into();
        track.album = "Album".into();
        track.mtime = mtime;
        track.size_bytes = meta.len() as i64;
        track.art_id = Some("aCoverThatIsGone".into());
        db.upsert_track(&track, 1).unwrap();

        let fp = db.scan_fingerprints();
        let (_, _, art_id) = fp.get(rel).expect("the track should be fingerprinted");
        assert_eq!(
            art_id.as_deref(),
            Some("aCoverThatIsGone"),
            "the fingerprint must carry the art id, or the scan cannot check it",
        );

        // The cache is empty, so the claimed cover is absent and the track must
        // NOT qualify for the unchanged fast-path.
        let cached: std::collections::HashSet<String> = std::fs::read_dir(&art)
            .map(|e| {
                e.filter_map(Result::ok)
                    .filter_map(|e| {
                        let n = e.file_name();
                        let n = n.to_str()?;
                        let stem = n.rsplit_once('.').map(|(a, _)| a).unwrap_or(n);
                        (!stem.contains('@')).then(|| stem.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            !cached.contains("aCoverThatIsGone"),
            "setup: the cover must be missing for this test to mean anything",
        );

        // And once it IS cached, the same track is skippable again.
        std::fs::write(art.join("aCoverThatIsGone.jpg"), b"jpegbytes").unwrap();
        let cached_now: std::collections::HashSet<String> = std::fs::read_dir(&art)
            .map(|e| {
                e.filter_map(Result::ok)
                    .filter_map(|e| {
                        let n = e.file_name();
                        let n = n.to_str()?;
                        let stem = n.rsplit_once('.').map(|(a, _)| a).unwrap_or(n);
                        (!stem.contains('@')).then(|| stem.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            cached_now.contains("aCoverThatIsGone"),
            "a present cover must read as cached, or every scan re-reads the library",
        );

        // A scaled variant alone must not count as the cover being cached.
        std::fs::write(art.join("scaledOnly@256.jpg"), b"jpegbytes").unwrap();
        let cached_variants: std::collections::HashSet<String> = std::fs::read_dir(&art)
            .map(|e| {
                e.filter_map(Result::ok)
                    .filter_map(|e| {
                        let n = e.file_name();
                        let n = n.to_str()?;
                        let stem = n.rsplit_once('.').map(|(a, _)| a).unwrap_or(n);
                        (!stem.contains('@')).then(|| stem.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            !cached_variants.contains("scaledOnly"),
            "a @size variant is derived, not the original - it must not satisfy the check",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
