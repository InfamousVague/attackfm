//! Sorting the audiobooks people actually have into the shape the shelf wants.
//!
//! A bought or archived audiobook rarely arrives as `Author/Title/`. It arrives
//! as whatever its distributor left behind: one enormous MP3, or forty parts
//! named `mistborn1_017.mp3`, a folder per disc, an `info.txt` explaining the
//! parts, a series folder holding three books at once. The library's rules
//! (the folder is the book; tags order the chapters) are right for a SHELF and
//! useless for that pile - so this module is the doorway between the two.
//!
//! The contract: drop each mess, one folder per errand, into
//! `Audiobooks/import/`. The worker reads a folder's evidence - its name, its
//! file tree, its text files, whatever tags the audio carries - asks the
//! server's own model what the pile IS, and then does the assembly itself:
//! files renamed into read order, tags written so every player agrees, the
//! cover carried across, everything indexed. The scan walk never sees import/
//! (scan.rs skips it), so nothing half-sorted ever reaches the shelf.
//!
//! THE MODEL INTERPRETS; THE CODE ASSEMBLES. The AI is asked one small
//! question - author, title, and which subfolder belongs to which book, at
//! most a few hundred tokens of answer - never for a file-by-file listing,
//! which would blow the response cap on any real book and invite hallucinated
//! paths. File order is deterministic (disc-aware natural sort), which is what
//! it should be: the model is good at reading `info.txt`, and hopeless at
//! being trusted with `mistborn1_017.mp3` -> `mistborn1_018.mp3`.
//!
//! No AI on the box is not an error. The heuristics that already name a book
//! from its folder handle the common shapes alone; the model's job is the
//! genuinely ambiguous pile. Every AI failure - unreachable, malformed,
//! inconsistent with the actual files - falls back to the heuristic rather
//! than failing the errand, because a book filed under a folder-name guess is
//! recoverable and a book stuck in import/ forever is not.
//!
//! Nothing is deleted. A consumed folder - text files, artwork and all - is
//! moved into the scan's own trash (`.attackfm-trash`), where a mistake can be
//! retrieved by hand.
//!
//! | Route | What it does |
//! |---|---|
//! | GET  /api/audiobooks/ingest | the import folder, what waits in it, the jobs |
//! | POST /api/audiobooks/ingest | queue every waiting folder |

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::{auth, scan, upload, AppState};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- Where the import folder is ----------------------------------------------

/// The real audiobooks directory under the music root, whatever its casing.
///
/// `kind_for` matches the PATH case-insensitively, but to create files we need
/// the directory as it actually exists on disk - inventing `Audiobooks/` next
/// to an existing `audiobooks/` would work on macOS (one folder) and split the
/// library in two on Linux.
fn audiobooks_dir(music_root: &Path) -> PathBuf {
    if let Ok(entries) = std::fs::read_dir(music_root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if let Some(s) = name.to_str() {
                if s.eq_ignore_ascii_case("audiobooks") && entry.path().is_dir() {
                    return entry.path();
                }
            }
        }
    }
    music_root.join("Audiobooks")
}

/// The audiobooks folder's NAME as it exists under this root - "audiobooks"
/// on the hub whose folder is a lowercase symlink, "Audiobooks" where nothing
/// exists yet. Every writer that files a book builds its rel_path from this,
/// because a literal "Audiobooks/" works on a case-insensitive disk by
/// accident and splits the shelf in two on any other.
pub(crate) fn audiobooks_component(music_root: &Path) -> String {
    audiobooks_dir(music_root)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Audiobooks")
        .to_string()
}

/// The import folder inside it, again as it actually exists.
fn import_dir(music_root: &Path) -> Option<PathBuf> {
    let books = audiobooks_dir(music_root);
    let entries = std::fs::read_dir(&books).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if let Some(s) = name.to_str() {
            // Both spellings, because both get typed: "make an import folder"
            // and "the imports folder" were the same sentence.
            if (s.eq_ignore_ascii_case("import") || s.eq_ignore_ascii_case("imports"))
                && entry.path().is_dir()
            {
                return Some(entry.path());
            }
        }
    }
    None
}

/// The folders waiting to be understood, by name.
fn pending_folders(music_root: &Path) -> Vec<String> {
    let Some(dir) = import_dir(music_root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            // The entry's OWN type, never followed: a symlink dropped in
            // import/ would otherwise be treated as a pile, and consuming a
            // pile MOVES its files - through a link, that guts whatever the
            // link points at, up to and including the library itself.
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() && !ft.is_symlink() {
                if let Some(name) = entry.file_name().to_str() {
                    // Somebody's hidden folder is not an errand.
                    if !name.starts_with('.') {
                        out.push(name.to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out
}

// --- The queue ----------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IngestJob {
    pub id: String,
    /// The import folder's own name - what the person dropped in.
    pub folder: String,
    /// queued | reading | thinking | filing | done | error
    pub state: String,
    /// How the pile was understood: "ai" or "heuristic". Shown, because a
    /// wrong guess is easier to forgive when it says who guessed.
    pub via: String,
    /// The books it became: "Author — Title (n files)" lines.
    pub books: Vec<String>,
    pub error: String,
    pub queued_at: i64,
}

#[derive(Default)]
pub struct IngestState {
    pub jobs: tokio::sync::Mutex<Vec<IngestJob>>,
    /// One folder at a time: each may cost a model call and a pile of file
    /// moves, and two workers filing into the same author folder would race
    /// the very collision rules that keep names unique.
    pub worker: tokio::sync::Mutex<()>,
}

impl IngestState {
    pub fn new() -> Self {
        Self::default()
    }
}

async fn set_job(state: &Arc<AppState>, id: &str, f: impl FnOnce(&mut IngestJob)) {
    let mut jobs = state.ingest.jobs.lock().await;
    if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
        f(j);
    }
}

// --- Routes -------------------------------------------------------------------

/// `GET /api/audiobooks/ingest` - what waits, and what happened.
/// `POST /api/audiobooks/ingest/clear-errors` - drop every errored job from
/// the list. The pile itself stays in `import/`, so a cleared failure is
/// also an invitation: the sweep no longer remembers it failed and will
/// offer it again - which is the point, since the usual reason to clear is
/// having just fixed the folder.
pub async fn clear_errors(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((StatusCode::FORBIDDEN, "only an admin can tidy the imports".into()));
    }
    let mut jobs = state.ingest.jobs.lock().await;
    let before = jobs.len();
    jobs.retain(|j| j.state != "error");
    let cleared = before - jobs.len();
    Ok(Json(json!({ "cleared": cleared })))
}

pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((StatusCode::FORBIDDEN, "the import folder is the operator's".into()));
    }
    let music_root = state.music_root.clone();
    let (pending, dir) = tokio::task::spawn_blocking(move || {
        (
            pending_folders(&music_root),
            import_dir(&music_root).map(|p| p.to_string_lossy().to_string()),
        )
    })
    .await
    .unwrap_or((Vec::new(), None));
    let jobs = state.ingest.jobs.lock().await.clone();
    Ok(Json(json!({
        // Where to put things, told rather than guessed: the path only the
        // server knows, same policy as the whisper model folder.
        "importDir": dir.unwrap_or_else(|| {
            audiobooks_dir(&state.music_root).join("import").to_string_lossy().to_string()
        }),
        "pending": pending,
        "jobs": jobs.into_iter().rev().collect::<Vec<_>>(),
        // Whether the model will take part, so the button can say which kind
        // of sorting is on offer without a surprise afterwards.
        "ai": crate::ai::AiClient::configured().is_some(),
    })))
}

/// `POST /api/audiobooks/ingest` - queue every folder currently waiting.
pub async fn run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((StatusCode::FORBIDDEN, "the import folder is the operator's".into()));
    }
    let music_root = state.music_root.clone();
    let pending = tokio::task::spawn_blocking(move || pending_folders(&music_root))
        .await
        .unwrap_or_default();
    if pending.is_empty() {
        return Ok(Json(json!({ "queued": 0 })));
    }

    let mut queued = 0usize;
    {
        let mut jobs = state.ingest.jobs.lock().await;
        for folder in &pending {
            if enqueue_locked(&state, &mut jobs, folder) {
                queued += 1;
            }
        }
        // A history, not a log - and only the SETTLED rows are history. A
        // blind front-drain here once evicted jobs that were still queued,
        // which orphaned their workers: the job finished into a row that no
        // longer existed and the panel showed a folder vanishing mid-sort.
        let len = jobs.len();
        if len > 30 {
            let mut excess = len - 30;
            jobs.retain(|j| {
                if excess > 0 && (j.state == "done" || j.state == "error") {
                    excess -= 1;
                    false
                } else {
                    true
                }
            });
        }
    }
    Ok(Json(json!({ "queued": queued })))
}

/// Push one folder's job and spawn its worker - shared by the button and the
/// sweep, so the two can never drift on what "queued" means. The caller holds
/// the jobs lock; a folder already in flight is one errand, not two.
fn enqueue_locked(state: &Arc<AppState>, jobs: &mut Vec<IngestJob>, folder: &str) -> bool {
    if jobs
        .iter()
        .any(|j| j.folder == folder && j.state != "done" && j.state != "error")
    {
        return false;
    }
    let id = format!("ingest-{}-{}", jobs.len(), now_ms());
    jobs.push(IngestJob {
        id: id.clone(),
        folder: folder.to_string(),
        state: "queued".into(),
        via: String::new(),
        books: Vec::new(),
        error: String::new(),
        queued_at: now_ms(),
    });
    let worker_state = state.clone();
    let worker_folder = folder.to_string();
    tokio::spawn(async move { ingest_one(worker_state, id, worker_folder).await });
    true
}

/// The sweep: dropping a folder into import/ is enough, with nobody pressing
/// anything - which is what the doorway was asked to be in the first place.
///
/// Two manners the button does not need. It only queues QUIET piles (newest
/// file untouched for a minute), so a copy still landing waits silently
/// instead of erroring every pass. And it never touches a folder the job
/// history already knows: a pile that keeps failing must not burn a model
/// call every five minutes forever - the button is the retry, on purpose.
pub fn spawn_sweep(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Soon after boot - a restart should pick up whatever waited - and
        // every five minutes after.
        tokio::time::sleep(std::time::Duration::from_secs(45)).await;
        loop {
            sweep_once(&state).await;
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        }
    });
}

async fn sweep_once(state: &Arc<AppState>) {
    let music_root = state.music_root.clone();
    let pending = tokio::task::spawn_blocking(move || pending_folders(&music_root))
        .await
        .unwrap_or_default();
    for folder in pending {
        {
            let jobs = state.ingest.jobs.lock().await;
            if jobs.iter().any(|j| j.folder == folder) {
                continue;
            }
        }
        let music_root = state.music_root.clone();
        let probe = folder.clone();
        let age = tokio::task::spawn_blocking(move || {
            import_dir(&music_root).and_then(|d| newest_mtime(&d.join(&probe)))
        })
        .await
        .unwrap_or(None);
        if matches!(age, Some(a) if a >= std::time::Duration::from_secs(60)) {
            let mut jobs = state.ingest.jobs.lock().await;
            enqueue_locked(state, &mut jobs, &folder);
        }
    }
}

// --- Understanding a folder ---------------------------------------------------

/// Everything worth knowing about a pile before deciding what it is.
struct Inventory {
    /// Audio files, paths relative to the pile's root, natural-sorted.
    audio: Vec<String>,
    /// Image files, relative, largest first.
    images: Vec<(String, u64)>,
    /// Text files: (relative path, contents truncated to fit a prompt).
    texts: Vec<(String, String)>,
    /// Tags read off the first few audio files: (artist, album, title).
    tags: Vec<(String, String, String)>,
}

fn take_inventory(root: &Path) -> Inventory {
    let mut audio = Vec::new();
    let mut images: Vec<(String, u64)> = Vec::new();
    let mut texts = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let Some(rel) = rel.to_str().map(|s| s.to_string()) else { continue };
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if scan::is_audio(&path) {
                audio.push(rel);
            } else if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
                images.push((rel, meta.len()));
            } else if matches!(ext.as_str(), "txt" | "nfo" | "md" | "info") && meta.len() < 64_000 {
                // Remember them all cheaply; which ones are WORTH reading is
                // decided after the walk. A real pile carries eight two-line
                // "Downloaded From <tracker>" files beside the one real info
                // sheet, and taking the first three met means the walk order
                // decides whether the model ever sees the sheet.
                texts.push((rel, meta.len().to_string()));
            }
        }
    }
    audio.sort_by(|a, b| natural_cmp(a, b));
    images.sort_by(|a, b| b.1.cmp(&a.1));

    // The three biggest text files get read: an info sheet dwarfs a tracker
    // stub, and a prompt is not a place for a novel either way.
    texts.sort_by(|a, b| {
        let sa: u64 = a.1.parse().unwrap_or(0);
        let sb: u64 = b.1.parse().unwrap_or(0);
        sb.cmp(&sa)
    });
    texts.truncate(3);
    let root_owned = root.to_path_buf();
    let texts: Vec<(String, String)> = texts
        .into_iter()
        .map(|(rel, _)| {
            let body = std::fs::read_to_string(root_owned.join(&rel)).unwrap_or_default();
            let mut trimmed: String = body.chars().take(1_500).collect();
            if trimmed.len() < body.len() {
                trimmed.push_str("\n[…]");
            }
            (rel, trimmed)
        })
        .collect();

    // What the files say about themselves. Three is enough to see whether the
    // tags agree; forty would just be the same answer forty times.
    let mut tags = Vec::new();
    for rel in audio.iter().take(3) {
        use lofty::file::TaggedFileExt;
        use lofty::prelude::Accessor;
        let Ok(probed) = lofty::probe::Probe::open(root.join(rel)) else { continue };
        // Two error types, two steps: guessing is io, reading is lofty.
        let Ok(probed) = probed.guess_file_type() else { continue };
        let Ok(tagged) = probed.read() else { continue };
        let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else { continue };
        tags.push((
            tag.artist().map(|c| c.to_string()).unwrap_or_default(),
            tag.album().map(|c| c.to_string()).unwrap_or_default(),
            tag.title().map(|c| c.to_string()).unwrap_or_default(),
        ));
    }
    Inventory { audio, images, texts, tags }
}

/// One book the pile turned out to contain.
#[derive(Deserialize, Clone, Debug)]
struct BookPlan {
    author: String,
    title: String,
    /// The subfolder (relative to the pile) holding this book's audio, or ""
    /// when the whole pile is one book.
    #[serde(default)]
    folder: String,
    #[serde(default)]
    year: Option<i64>,
}

#[derive(Deserialize)]
struct PlanReply {
    books: Vec<BookPlan>,
}

/// Ask the model what the pile is. Interpretation only - never file listings.
async fn interpret_with_ai(folder_name: &str, inv: &Inventory) -> Option<Vec<BookPlan>> {
    let client = crate::ai::AiClient::configured()?;

    let mut evidence = format!("Folder name: {folder_name:?}\n\nAudio files ({}):\n", inv.audio.len());
    // Enough tree to show the shape; a 300-part book does not need every part
    // shown to be understood as one book.
    for rel in inv.audio.iter().take(80) {
        evidence.push_str("  ");
        evidence.push_str(rel);
        evidence.push('\n');
    }
    if inv.audio.len() > 80 {
        evidence.push_str(&format!("  … and {} more\n", inv.audio.len() - 80));
    }
    if !inv.tags.is_empty() {
        evidence.push_str("\nTags found on the first files (artist | album | title):\n");
        for (artist, album, title) in &inv.tags {
            evidence.push_str(&format!("  {artist:?} | {album:?} | {title:?}\n"));
        }
    }
    for (rel, body) in &inv.texts {
        evidence.push_str(&format!("\n--- {rel} ---\n{body}\n"));
    }

    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["books"],
        "properties": {
            "books": {
                "type": "array",
                "minItems": 1,
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["author", "title", "folder"],
                    "properties": {
                        "author": { "type": "string" },
                        "title": { "type": "string" },
                        "folder": { "type": "string" },
                        "year": { "type": ["integer", "null"] }
                    }
                }
            }
        }
    });

    let system = "You identify audiobooks from a downloaded folder's evidence. \
        Decide the author and the book title (clean human forms, no release-group \
        tags, no {MP3}, no bitrates). If the folder holds SEVERAL books (a series \
        pack), return one entry per book with `folder` naming the subfolder that \
        holds that book's audio, exactly as it appears in the file paths. If the \
        whole folder is one book, return one entry with folder set to \"\". \
        Never invent subfolders that are not in the evidence.";

    let reply: PlanReply = client
        .chat_json(system, &evidence, "audiobook_ingest", schema, false)
        .await
        .ok()?;
    Some(reply.books)
}

/// Whether the model's answer actually fits the files on disk. A plan that
/// does not is discarded whole - a half-right split would strand audio.
fn plan_is_sound(plans: &[BookPlan], inv: &Inventory) -> bool {
    if plans.is_empty() || plans.len() > 8 {
        return false;
    }
    for p in plans {
        if p.author.trim().is_empty() || p.title.trim().is_empty() {
            return false;
        }
    }
    if plans.len() == 1 {
        // One book claims the whole pile, whatever `folder` says.
        return true;
    }
    // Several books: every folder named, none nested in another, and every
    // audio file must belong to exactly one of them.
    let mut folders: Vec<String> = Vec::new();
    for p in plans {
        let f = p.folder.trim_matches('/').to_string();
        if f.is_empty() {
            return false;
        }
        folders.push(f);
    }
    for (i, a) in folders.iter().enumerate() {
        for (j, b) in folders.iter().enumerate() {
            if i != j && (a == b || a.starts_with(&format!("{b}/"))) {
                return false;
            }
        }
    }
    inv.audio.iter().all(|rel| {
        folders
            .iter()
            .filter(|f| rel.starts_with(&format!("{f}/")))
            .count()
            == 1
    })
}

/// What the code can work out alone, for when there is no model or the model
/// let us down. Covers the common shapes: one folder = one book, and the
/// series pack whose subfolders each hold audio.
fn interpret_heuristically(folder_name: &str, inv: &Inventory) -> Vec<BookPlan> {
    // The pile's top-level subfolders that hold audio, and whether any audio
    // sits loose beside them.
    let mut top: Vec<String> = Vec::new();
    let mut loose = false;
    for rel in &inv.audio {
        match rel.split_once('/') {
            Some((first, _)) => {
                if !top.contains(&first.to_string()) {
                    top.push(first.to_string());
                }
            }
            None => loose = true,
        }
    }

    /*
     * Subfolders that are VOLUMES are one book wearing three sleeves.
     *
     * GraphicAudio ships "The Final Empire" as `... (1 of 3)`, `(2 of 3)`,
     * `(3 of 3)` - three subfolders whose names are identical once the volume
     * marker comes off. The series split would shelve that as three books,
     * which is exactly wrong; collapsing to one book keeps the parts in
     * order, because the volume folders natural-sort ahead of their files.
     */
    let volume_set = !loose && top.len() >= 2 && {
        let mut stripped: Vec<String> =
            top.iter().map(|t| strip_volume_marker(t).to_ascii_lowercase()).collect();
        stripped.sort();
        stripped.dedup();
        stripped.len() == 1
    };

    // What the pack folder itself says: the year shape first, the
    // Author - Series - Title shape second.
    let (pack_author, pack_title) = {
        let (a, t) = scan::split_book_folder(folder_name);
        if a.is_some() {
            (a, t)
        } else if let Some((a, t)) = author_from_dashes(folder_name) {
            (Some(a), t)
        } else {
            (None, t)
        }
    };

    // A genuine series pack: several subfolders that are NOT volumes of one
    // thing, each becoming its own book.
    if !loose && top.len() >= 2 && !volume_set && !top.iter().any(|t| scan::is_disc_marker(t)) {
        return top
            .into_iter()
            .map(|sub| {
                let sub_stripped = strip_volume_marker(&sub);
                let (author, title) = {
                    let (a, t) = scan::split_book_folder(&sub_stripped);
                    if a.is_some() {
                        (a, t)
                    } else if let Some((a, t)) = author_from_dashes(&sub_stripped) {
                        (Some(a), t)
                    } else {
                        (None, t)
                    }
                };
                BookPlan {
                    author: author
                        .or_else(|| pack_author.clone())
                        .or_else(|| first_nonempty_artist(inv))
                        .unwrap_or_else(|| "Unknown Author".into()),
                    title: strip_ordinal(&clean_title(&title)),
                    folder: sub,
                    year: None,
                }
            })
            .collect();
    }

    /*
     * One book. Who wrote it and what it is called come from different
     * places, on the evidence of real piles rather than symmetry:
     *
     * AUTHOR: the folder first, the tags second. The artist tag on these
     * files names the STUDIO ("GraphicAudio") or worse ("Mistborn") more
     * often than the author; the folder was named by a person filing a book.
     *
     * TITLE: the tags first, the folder second. Album tags carried clean
     * titles ("Mistborn 5: Shadows of Self") on pile after pile whose folder
     * names carried tracker noise - the exact opposite reliability.
     */
    let tag_album = majority(inv.tags.iter().map(|(_, album, _)| album.trim()));
    let tag_artist = majority(inv.tags.iter().map(|(artist, _, _)| artist.trim()));
    let stem_split = if inv.audio.len() == 1 {
        let stem = Path::new(inv.audio[0].as_str())
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        match stem.split_once(" - ") {
            Some((left, right))
                if !left.trim().is_empty()
                    && !right.trim().is_empty()
                    && left.trim().chars().any(|c| c.is_ascii_alphabetic()) =>
            {
                Some((left.trim().to_string(), strip_trailing_parens(right)))
            }
            _ => None,
        }
    } else {
        None
    };
    vec![BookPlan {
        author: pack_author
            .clone()
            .or(tag_artist)
            .or_else(|| stem_split.as_ref().map(|(a, _)| a.clone()))
            .or_else(|| first_nonempty_artist(inv))
            .unwrap_or_else(|| "Unknown Author".into()),
        title: tag_album
            .map(|t| strip_volume_marker(&t))
            .or_else(|| {
                if pack_author.is_none() && scan::split_book_folder(folder_name).0.is_none() {
                    stem_split.as_ref().map(|(_, t)| t.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| strip_volume_marker(&clean_title(&pack_title))),
        folder: String::new(),
        year: None,
    }]
}

/// A series subfolder's ordinal, removed from its title: `1. Dune` and
/// `02 - Dune Messiah` are shelf positions, not names.
fn strip_ordinal(title: &str) -> String {
    let trimmed = title.trim();
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return trimmed.to_string();
    }
    // Spaces interleave with the separators (`02 - Title`), so the set
    // strips both in one pass.
    let rest = trimmed[digits..].trim_start_matches([' ', '.', ')', '-', '_']);
    if rest.is_empty() { trimmed.to_string() } else { rest.to_string() }
}

/// The trailing parenthesised aside - `(Unabridged Audiobook)`, `(Sci-Fi)` -
/// dropped exactly the way the folder-name reader drops it: only when the
/// brackets close at the very end and are not the whole name.
fn strip_trailing_parens(title: &str) -> String {
    let t = title.trim();
    match (t.rfind(" ("), t.ends_with(')')) {
        (Some(at), true) if at > 0 => t[..at].trim().to_string(),
        _ => t.to_string(),
    }
}

fn first_nonempty_artist(inv: &Inventory) -> Option<String> {
    inv.tags
        .iter()
        .map(|(artist, _, _)| artist.trim())
        .find(|a| !a.is_empty())
        .map(|a| a.to_string())
}

/// The value most of the entries agree on, if a non-empty one exists.
fn majority<'a>(values: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut total = 0usize;
    for v in values {
        total += 1;
        if v.is_empty() {
            continue;
        }
        match counts.iter_mut().find(|(k, _)| k == v) {
            Some((_, n)) => *n += 1,
            None => counts.push((v.to_string(), 1)),
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .filter(|(_, n)| total > 0 && *n * 2 > total)
        .map(|(k, _)| k)
}

/// A trailing `(N of M)` - GraphicAudio's way of shipping one book as three
/// volumes - removed from wherever it appears: subfolder names, album tags.
fn strip_volume_marker(s: &str) -> String {
    let t = s.trim();
    if let (Some(open), true) = (t.rfind('('), t.ends_with(')')) {
        let inner = &t[open + 1..t.len() - 1];
        let mut halves = inner.splitn(2, " of ");
        let (a, b) = (halves.next().unwrap_or(""), halves.next().unwrap_or(""));
        if !a.is_empty()
            && !b.is_empty()
            && a.trim().chars().all(|c| c.is_ascii_digit())
            && b.trim().chars().all(|c| c.is_ascii_digit())
        {
            return t[..open].trim().to_string();
        }
    }
    t.to_string()
}

/// Whether a cleaned stem still says anything - three letters in a row is the
/// difference between "The Vin" and the "1P01" left over from a part code.
fn has_a_word(s: &str) -> bool {
    let mut run = 0;
    for c in s.chars() {
        if c.is_ascii_alphabetic() {
            run += 1;
            if run >= 3 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// `Author - Whatever - Title` without a year: the first segment is an author
/// when it reads like a name - two to four alphabetic words - and there are at
/// least three segments, so "Anne of Green Gables - Part One" (two segments)
/// never donates its heroine to the author field. The evidence for the rule is
/// the shelf itself: `Brandon Sanderson - Mistborn 02 - The Well of Ascension`
/// is how these folders actually arrive, while their artist TAGS say
/// "GraphicAudio" or worse - the publisher, not the author. The folder
/// outranks the tag for authors because the folder was named by a person
/// filing a book and the tag by a ripper crediting a studio.
fn author_from_dashes(folder: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = folder.split(" - ").collect();
    if parts.len() < 3 {
        return None;
    }
    let first = parts[0].trim();
    let words: Vec<&str> = first.split_whitespace().collect();
    let namey = (2..=4).contains(&words.len())
        && words
            .iter()
            .all(|w| w.chars().all(|c| c.is_ascii_alphabetic() || c == '.' || c == '\''));
    if namey {
        Some((first.to_string(), parts[1..].join(" - ")))
    } else {
        None
    }
}

/// A folder name's worth of release-group noise, removed: `{MP3}`, `[64k]`,
/// `(Unabridged)` survive split_book_folder because they trail nothing.
fn clean_title(raw: &str) -> String {
    let mut out = String::new();
    let mut depth_curly = 0i32;
    let mut depth_square = 0i32;
    for c in raw.chars() {
        match c {
            '{' => depth_curly += 1,
            '}' => depth_curly = (depth_curly - 1).max(0),
            '[' => depth_square += 1,
            ']' => depth_square = (depth_square - 1).max(0),
            _ if depth_curly == 0 && depth_square == 0 => out.push(c),
            _ => {}
        }
    }
    let mut cleaned = out.trim().trim_end_matches(['-', '_', '.']).trim().to_string();
    // The studio's name trailing the title - " - Graphic Audio", "- GraphicAudio"
    // - is packaging, not name. Present on four of the seven real piles this
    // was tested against.
    let lower = cleaned.to_ascii_lowercase();
    for suffix in [" - graphic audio", " - graphicaudio", "- graphic audio", "- graphicaudio"] {
        if lower.ends_with(suffix) {
            cleaned = cleaned[..cleaned.len() - suffix.len()].trim().to_string();
            break;
        }
    }
    if cleaned.is_empty() { raw.trim().to_string() } else { cleaned }
}

// --- Ordering the parts -------------------------------------------------------

/// Natural comparison: "part 2" before "part 10", which is the entire reason
/// scene numbering works at all.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut ca, mut cb) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ca.peek().copied(), cb.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    let mut na = 0u64;
                    while let Some(d) = ca.peek().and_then(|c| c.to_digit(10)) {
                        na = na.saturating_mul(10).saturating_add(d as u64);
                        ca.next();
                    }
                    let mut nb = 0u64;
                    while let Some(d) = cb.peek().and_then(|c| c.to_digit(10)) {
                        nb = nb.saturating_mul(10).saturating_add(d as u64);
                        cb.next();
                    }
                    if na != nb {
                        return na.cmp(&nb);
                    }
                } else {
                    let (la, lb) = (x.to_ascii_lowercase(), y.to_ascii_lowercase());
                    if la != lb {
                        return la.cmp(&lb);
                    }
                    ca.next();
                    cb.next();
                }
            }
        }
    }
}

/// A chapter's name out of its filename, with the pile's shared noise removed.
///
/// `mistborn1_017` tells a listener nothing once the shared `mistborn1_` is
/// stripped and `017` is all that remains - so a stem that strips down to
/// digits (or to nothing) becomes "Part N" instead. `Chapter 04 - The Vin`
/// keeps its words.
fn chapter_title(stem: &str, common_prefix: &str, n: usize) -> String {
    // The prefix was MATCHED case-insensitively, so it must be stripped the
    // same way - `Mistborn1_002` and `MISTBORN1_002` share a prefix that a
    // byte-exact strip only removes from one of them, and the mixed-case
    // pile came out half "Part N" and half tracker noise.
    let plen = common_prefix.chars().count();
    let head: String = stem.chars().take(plen).collect();
    let stripped: String = if plen > 0 && head.eq_ignore_ascii_case(common_prefix) {
        stem.chars().skip(plen).collect()
    } else {
        stem.to_string()
    };
    let stripped = stripped.as_str();
    let cleaned = stripped
        .trim_matches(|c: char| c == '-' || c == '_' || c == '.' || c.is_whitespace())
        .to_string();
    // "1P01" survives a digits-only test on a technicality and tells a
    // listener nothing; a name earns its keep by containing an actual word.
    if !has_a_word(&cleaned) {
        format!("Part {n}")
    } else {
        cleaned
    }
}

/// The longest prefix every stem shares, so `mistborn1_001..058` sheds the
/// `mistborn1_0` and per-file words survive. Only meaningful across 2+ files.
fn common_stem_prefix(stems: &[String]) -> String {
    if stems.len() < 2 {
        return String::new();
    }
    let first = &stems[0];
    let mut len = first.len();
    for s in &stems[1..] {
        let matched = first
            .chars()
            .zip(s.chars())
            .take_while(|(a, b)| a.eq_ignore_ascii_case(b))
            .count();
        len = len.min(matched);
    }
    first.chars().take(len).collect()
}

/// How long ago the newest thing in a tree changed, or None when unreadable.
fn newest_mtime(root: &Path) -> Option<std::time::Duration> {
    let mut newest: Option<std::time::SystemTime> = None;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if let Ok(m) = meta.modified() {
                newest = Some(match newest {
                    Some(n) if n > m => n,
                    _ => m,
                });
            }
        }
    }
    newest.and_then(|n| n.elapsed().ok())
}

// --- The errand ---------------------------------------------------------------

async fn ingest_one(state: Arc<AppState>, job_id: String, folder: String) {
    let _one_at_a_time = state.ingest.worker.lock().await;

    let fail = |msg: String| {
        let state = state.clone();
        let job_id = job_id.clone();
        async move {
            set_job(&state, &job_id, |j| {
                j.state = "error".into();
                j.error = msg;
            })
            .await;
        }
    };

    let Some(import_root) = import_dir(&state.music_root) else {
        fail("the import folder disappeared".into()).await;
        return;
    };
    let pile = import_root.join(&folder);
    // The pile's own metadata, never followed: consuming a pile MOVES files,
    // and through a symlink that would gut whatever the link points at.
    let real_dir = std::fs::symlink_metadata(&pile)
        .map(|m| m.is_dir() && !m.is_symlink())
        .unwrap_or(false);
    if !real_dir {
        fail("that folder is no longer there".into()).await;
        return;
    }

    // A folder can be LISTED the moment its first byte lands, and a Finder or
    // SFTP copy takes minutes - so a pile whose newest file changed in the
    // last minute is still arriving, and sorting it now would file a third of
    // a book and sweep the rest into the trash as it landed. Waiting is the
    // whole fix.
    {
        let quiet_pile = pile.clone();
        let newest = tokio::task::spawn_blocking(move || newest_mtime(&quiet_pile))
            .await
            .unwrap_or(None);
        if let Some(age) = newest {
            if age < std::time::Duration::from_secs(60) {
                fail("still arriving — files changed under it in the last minute; try again shortly".into())
                    .await;
                return;
            }
        }
    }

    // 1. Read everything the pile has to say.
    set_job(&state, &job_id, |j| j.state = "reading".into()).await;
    let inv_pile = pile.clone();
    let Ok(inv) = tokio::task::spawn_blocking(move || take_inventory(&inv_pile)).await else {
        fail("could not read that folder".into()).await;
        return;
    };
    if inv.audio.is_empty() {
        fail("no audio in that folder".into()).await;
        return;
    }

    // 2. Decide what it is - the model first, the heuristic always ready.
    set_job(&state, &job_id, |j| j.state = "thinking".into()).await;
    let (plans, via) = match interpret_with_ai(&folder, &inv).await {
        Some(plans) if plan_is_sound(&plans, &inv) => (plans, "ai"),
        _ => (interpret_heuristically(&folder, &inv), "heuristic"),
    };
    set_job(&state, &job_id, |j| j.via = via.into()).await;

    // 3. Assemble each book: rename into order, tag, file, index.
    set_job(&state, &job_id, |j| j.state = "filing".into()).await;
    let books_dir = audiobooks_dir(&state.music_root);
    let mut made: Vec<String> = Vec::new();

    for plan in &plans {
        let prefix = {
            let f = plan.folder.trim_matches('/');
            if f.is_empty() { String::new() } else { format!("{f}/") }
        };
        let claimed: Vec<&String> = if plans.len() == 1 {
            inv.audio.iter().collect()
        } else {
            inv.audio.iter().filter(|rel| rel.starts_with(&prefix)).collect()
        };
        if claimed.is_empty() {
            continue;
        }

        let author = upload::safe_component(plan.author.trim());
        let title = upload::safe_component(&clean_title(plan.title.trim()));

        let stems: Vec<String> = claimed
            .iter()
            .map(|rel| {
                Path::new(rel.as_str())
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("part")
                    .to_string()
            })
            .collect();
        let shared = common_stem_prefix(&stems);
        let width = claimed.len().to_string().len().max(2);

        /*
         * PHASE ONE: place every file, or place none of them.
         *
         * The naive loop moved-and-indexed one chapter at a time, and a
         * failure at chapter 12 of 20 left the book split across two worlds:
         * eleven chapters shelved and indexed, nine still in the pile, and a
         * retry - finding the book's folder now occupied - filed the
         * survivors as "Title (2)". One transient disk-full became a book
         * permanently in two halves. So the moves come first, remembered as
         * they happen, and any failure puts every placed file straight back
         * and removes the folder: the pile is whole again and the retry
         * starts from nothing.
         *
         * Held under the FILING lock, probe included: upload.rs states the
         * invariant - the free-name check and the move must be serialised
         * against every other filer, or two can pick the same free name and
         * one silently replaces the other's file.
         */
        let mut placed: Vec<(PathBuf, PathBuf, bool)> = Vec::new(); // (src, dest, was_copied)
        let mut chapters: Vec<(PathBuf, String, usize)> = Vec::new(); // (dest, chapter, n)
        let placement = {
            let _filing = state.filing.lock().await;

            // A fresh shelf slot, never an overwrite or a silent merge.
            let mut dest_dir = books_dir.join(&author).join(&title);
            let mut suffix = 2;
            while dest_dir.exists() {
                dest_dir = books_dir.join(&author).join(format!("{title} ({suffix})"));
                suffix += 1;
            }
            if std::fs::create_dir_all(&dest_dir).is_err() {
                None
            } else {
                // The cover goes in FIRST, deliberately: the scanner reads a
                // folder cover at INDEX time and never re-reads an unchanged
                // file, so a cover that arrives after the chapters are
                // indexed is a cover no one ever sees. It was last, and every
                // ingested book wore the blank glyph forever.
                let cover = inv
                    .images
                    .iter()
                    .find(|(rel, _)| plans.len() == 1 || rel.starts_with(&prefix));
                if let Some((rel, _)) = cover {
                    let ext = Path::new(rel.as_str())
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_ascii_lowercase())
                        .unwrap_or_else(|| "jpg".into());
                    let name = if ext == "png" { "cover.png" } else { "cover.jpg" };
                    let _ = std::fs::copy(pile.join(rel.as_str()), dest_dir.join(name));
                }

                let mut ok = true;
                for (i, rel) in claimed.iter().enumerate() {
                    let n = i + 1;
                    let src = pile.join(rel.as_str());
                    let ext = src
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_ascii_lowercase())
                        .unwrap_or_else(|| "mp3".into());
                    let chapter = chapter_title(&stems[i], &shared, n);
                    let file_name = format!(
                        "{n:0width$} - {}.{ext}",
                        upload::safe_component(&chapter),
                        n = n,
                        width = width
                    );
                    let dest = dest_dir.join(&file_name);
                    if dest.exists() {
                        // Inside a directory we just created this cannot
                        // happen without another filer racing us; refusing
                        // beats replacing whatever they put there.
                        ok = false;
                        break;
                    }
                    if std::fs::rename(&src, &dest).is_ok() {
                        placed.push((src, dest.clone(), false));
                    } else if std::fs::copy(&src, &dest).is_ok() {
                        // The source survives until the whole book stands.
                        placed.push((src, dest.clone(), true));
                    } else {
                        let _ = std::fs::remove_file(&dest);
                        ok = false;
                        break;
                    }
                    chapters.push((dest, chapter, n));
                }

                if ok {
                    Some(dest_dir)
                } else {
                    // Put it all back: renames reversed, copies deleted, the
                    // folder removed. The pile is exactly what it was.
                    for (src, dest, was_copied) in placed.drain(..) {
                        if was_copied {
                            let _ = std::fs::remove_file(&dest);
                        } else {
                            let _ = std::fs::rename(&dest, &src);
                        }
                    }
                    let _ = std::fs::remove_dir_all(&dest_dir);
                    None
                }
            }
        };
        let Some(_dest_dir) = placement else {
            fail(format!("could not move {} into the library — nothing was changed", plan.title.trim())).await;
            return;
        };

        // PHASE TWO: the book stands; now spend the copies' sources, write
        // the identity into each file, and index it. Failures here keep the
        // audio - a tag that would not write is logged, not fatal.
        for (src, _dest, was_copied) in &placed {
            if *was_copied {
                let _ = std::fs::remove_file(src);
            }
        }
        for (dest, chapter, n) in &chapters {
            let tag_path = dest.clone();
            let (t_title, t_author, t_album, t_year) = (
                chapter.clone(),
                plan.author.trim().to_string(),
                clean_title(plan.title.trim()),
                plan.year,
            );
            let n = *n;
            let tagged = tokio::task::spawn_blocking(move || {
                crate::audiobooks::tag_section(
                    &tag_path,
                    &t_title,
                    &t_author,
                    &t_album,
                    t_year,
                    n as u32,
                    None,
                )
            })
            .await;
            if let Ok(Err(e)) = tagged {
                eprintln!("[ingest] tagging {} failed: {e}", dest.display());
            }
            let rel_lib = dest
                .strip_prefix(&state.music_root)
                .ok()
                .and_then(|p| p.to_str())
                .map(|s| s.to_string());
            if let Some(rel_lib) = rel_lib {
                let _filing = state.filing.lock().await;
                scan::scan_one(&state.db, &state.music_root, &state.art_dir, &rel_lib);
            }
        }

        made.push(format!(
            "{} — {} ({} files)",
            plan.author.trim(),
            clean_title(plan.title.trim()),
            claimed.len()
        ));
        set_job(&state, &job_id, |j| j.books = made.clone()).await;
    }

    if made.is_empty() {
        fail("nothing in that folder could be claimed as a book".into()).await;
        return;
    }

    // 4. Before retiring the pile, look again: a file that arrived AFTER the
    //    inventory was taken was never part of this errand, and sweeping it to
    //    the trash with the leftovers would disappear audio nobody has sorted.
    //    Leave the pile standing instead - it shows up as pending again, and
    //    the next pass sorts what is now there.
    {
        let check_pile = pile.clone();
        let known: std::collections::HashSet<String> = inv.audio.iter().cloned().collect();
        let newcomers = tokio::task::spawn_blocking(move || {
            let now = take_inventory(&check_pile);
            now.audio.into_iter().filter(|rel| !known.contains(rel)).count()
        })
        .await
        .unwrap_or(0);
        if newcomers > 0 {
            set_job(&state, &job_id, |j| {
                j.books.push(format!(
                    "{newcomers} more file{} arrived mid-sort — left in import for the next pass",
                    if newcomers == 1 { "" } else { "s" }
                ));
                j.state = "done".into();
            })
            .await;
            return;
        }
    }

    // The consumed pile goes to the trash, not to /dev/null: the text
    // files, the leftovers, the evidence - all retrievable by hand.
    let trash = state.music_root.join(scan::TRASH_DIR);
    let _ = std::fs::create_dir_all(&trash);
    let resting = trash.join(format!("import-{}-{}", upload::safe_component(&folder), now_ms()));
    if std::fs::rename(&pile, &resting).is_err() {
        // A pile that cannot be moved stays put; import/ is invisible to the
        // scan either way, so it clutters nothing but the pending list.
        eprintln!("[ingest] could not retire {}", pile.display());
    }

    set_job(&state, &job_id, |j| j.state = "done".into()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inv(audio: &[&str], tags: &[(&str, &str, &str)]) -> Inventory {
        let mut audio: Vec<String> = audio.iter().map(|s| s.to_string()).collect();
        audio.sort_by(|a, b| natural_cmp(a, b));
        Inventory {
            audio,
            images: Vec::new(),
            texts: Vec::new(),
            tags: tags.iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string())).collect(),
        }
    }

    #[test]
    fn parts_order_like_a_person_reads_numbers() {
        let mut v = vec!["part 10.mp3", "part 2.mp3", "part 1.mp3"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["part 1.mp3", "part 2.mp3", "part 10.mp3"]);
    }

    /// The scene pile: numbered stems shed their shared noise and become
    /// honest part names; a stem with words keeps them.
    #[test]
    fn chapter_names_come_out_readable() {
        let stems: Vec<String> =
            ["mistborn1_001", "mistborn1_002", "mistborn1_003"].iter().map(|s| s.to_string()).collect();
        let shared = common_stem_prefix(&stems);
        assert_eq!(chapter_title(&stems[0], &shared, 1), "Part 1");
        let named: Vec<String> =
            ["04 - The Vin", "05 - Kelsier"].iter().map(|s| s.to_string()).collect();
        let shared = common_stem_prefix(&named);
        assert_eq!(chapter_title(&named[0], &shared, 4), "4 - The Vin");
    }

    /// A multi-source pile mixes casings; the shared prefix must come off
    /// every spelling of itself, not only the first file's.
    #[test]
    fn the_shared_prefix_strips_whatever_its_case() {
        let stems: Vec<String> =
            ["Mistborn1_001", "MISTBORN1_002", "mistborn1_003"].iter().map(|s| s.to_string()).collect();
        let shared = common_stem_prefix(&stems);
        assert_eq!(chapter_title(&stems[0], &shared, 1), "Part 1");
        assert_eq!(chapter_title(&stems[1], &shared, 2), "Part 2");
        assert_eq!(chapter_title(&stems[2], &shared, 3), "Part 3");
    }

    #[test]
    fn release_noise_comes_off_a_title() {
        assert_eq!(clean_title("Mistborn Book 1 - The Final Empire {MP3}"), "Mistborn Book 1 - The Final Empire");
        assert_eq!(clean_title("Dune [64kbps]"), "Dune");
        // A title that is nothing but brackets keeps itself.
        assert_eq!(clean_title("{MP3}"), "{MP3}");
    }

    /// A folder of untagged parts is ONE book named by its folder.
    #[test]
    fn a_pile_is_one_book() {
        let inv = inv(&["mistborn1_001.mp3", "mistborn1_002.mp3"], &[]);
        let plans = interpret_heuristically("Mistborn Book 1 - The Final Empire {MP3}", &inv);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].title, "Mistborn Book 1 - The Final Empire");
        assert_eq!(plans[0].author, "Unknown Author");
    }

    /// Tags outvote the folder when they agree with themselves.
    #[test]
    fn tags_name_the_book_when_they_agree() {
        let inv = inv(
            &["a.mp3", "b.mp3"],
            &[
                ("Brandon Sanderson", "The Final Empire", "x"),
                ("Brandon Sanderson", "The Final Empire", "y"),
            ],
        );
        let plans = interpret_heuristically("random-rip-folder", &inv);
        assert_eq!(plans[0].author, "Brandon Sanderson");
        assert_eq!(plans[0].title, "The Final Empire");
    }

    /// A series pack splits into one book per subfolder - and a disc layout
    /// must NOT, because CD1/CD2 are one book in two halves.
    #[test]
    fn a_series_splits_and_discs_do_not() {
        let series = inv(&["1. Dune/a.mp3", "2. Dune Messiah/b.mp3"], &[]);
        let plans = interpret_heuristically("Dune Series", &series);
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].title, "Dune");

        let discs = inv(&["CD1/a.mp3", "CD2/b.mp3"], &[]);
        let plans = interpret_heuristically("Frank Herbert - 1965 - Dune", &discs);
        assert_eq!(plans.len(), 1, "discs are halves, not books");
        assert_eq!(plans[0].title, "Dune");
        assert_eq!(plans[0].author.as_str(), "Frank Herbert");
    }

    /// The model's answer is discarded whole when it does not fit the files:
    /// a split that strands audio, nests folders, or names a folder that is
    /// not there.
    #[test]
    fn an_unsound_plan_is_refused() {
        let inv = inv(&["1. Dune/a.mp3", "2. Dune Messiah/b.mp3", "loose.mp3"], &[]);
        let strands = vec![
            BookPlan { author: "F".into(), title: "Dune".into(), folder: "1. Dune".into(), year: None },
            BookPlan { author: "F".into(), title: "Messiah".into(), folder: "2. Dune Messiah".into(), year: None },
        ];
        assert!(!plan_is_sound(&strands, &inv), "loose.mp3 belongs to nobody");

        let covered = inv2(&["1. Dune/a.mp3", "2. Dune Messiah/b.mp3"]);
        assert!(plan_is_sound(&strands, &covered));

        let nested = vec![
            BookPlan { author: "F".into(), title: "A".into(), folder: "1. Dune".into(), year: None },
            BookPlan { author: "F".into(), title: "B".into(), folder: "1. Dune/inner".into(), year: None },
        ];
        assert!(!plan_is_sound(&nested, &covered));

        let empty_author = vec![BookPlan { author: " ".into(), title: "Dune".into(), folder: String::new(), year: None }];
        assert!(!plan_is_sound(&empty_author, &covered));
    }

    fn inv2(audio: &[&str]) -> Inventory {
        inv(audio, &[])
    }

    /// The seven real piles from the reference set, exactly as they arrived.
    #[test]
    fn the_reference_shelf_comes_out_right() {
        // GraphicAudio volumes: one book in three sleeves, never a series.
        let volumes = inv(
            &[
                "Mistborn 1 - The Final Empire (1 of 3)/MISTBORN0101P01.mp3",
                "Mistborn 1 - The Final Empire (2 of 3)/MISTBORN0102P01.mp3",
                "Mistborn 1 - The Final Empire (3 of 3)/MISTBORN0103P01.mp3",
            ],
            &[],
        );
        let plans = interpret_heuristically("Mistborn - The Final Empire - Graphic Audio", &volumes);
        assert_eq!(plans.len(), 1, "(N of M) folders are volumes, not books");
        assert_eq!(plans[0].title, "Mistborn - The Final Empire");

        // The artist tag says the STUDIO; the folder says the author.
        let studio_tagged = inv(
            &["MISTBORN04P01.mp3", "MISTBORN04P02.mp3"],
            &[
                ("GraphicAudio", "Mistborn 4: The Alloy of Law", "MISTBORN04P01"),
                ("GraphicAudio", "Mistborn 4: The Alloy of Law", "MISTBORN04P02"),
            ],
        );
        let plans = interpret_heuristically("Mistborn 4 - The Alloy of Law", &studio_tagged);
        assert_eq!(plans[0].title, "Mistborn 4: The Alloy of Law", "the album tag names the title");

        // Author - Series NN - Title, no year: the first segment is the author.
        let dash = inv(&["pt 1.mp3", "pt 2.mp3"], &[("Mistborn", "", "")]);
        let plans = interpret_heuristically(
            "Brandon Sanderson - Mistborn 02 - The Well of Ascension [Graphic Audio]",
            &dash,
        );
        assert_eq!(plans[0].author, "Brandon Sanderson", "the folder outranks a garbage artist tag");
        assert_eq!(plans[0].title, "Mistborn 02 - The Well of Ascension");

        // An album tag carrying a volume marker sheds it.
        let vol_tag = inv(
            &["a.mp3", "b.mp3"],
            &[
                ("Brandon Sanderson", "Mistborn 6: The Bands of Mourning (1 of 2)", "x"),
                ("Brandon Sanderson", "Mistborn 6: The Bands of Mourning (1 of 2)", "y"),
            ],
        );
        let plans = interpret_heuristically("Mistborn 6 - The Bands of Mourning (GraphicAudio)", &vol_tag);
        assert_eq!(plans[0].title, "Mistborn 6: The Bands of Mourning");
        assert_eq!(plans[0].author, "Brandon Sanderson");

        // The Goodreads shape: the trailing parenthetical is series info.
        let flat = inv(&["MISTBORN05P01.mp3"], &[("GraphicAudio", "", "")]);
        let plans = interpret_heuristically("Shadows of Self (Mistborn, #5)", &flat);
        assert_eq!(plans[0].title, "Shadows of Self");
    }

    /// Part codes are not chapter names: "1P01" says nothing once the shared
    /// prefix is gone, and becomes "Part N"; words survive.
    #[test]
    fn part_codes_become_part_numbers() {
        let stems: Vec<String> =
            ["MISTBORN0101P01", "MISTBORN0102P01", "MISTBORN0103P01"].iter().map(|s| s.to_string()).collect();
        let shared = common_stem_prefix(&stems);
        assert_eq!(chapter_title(&stems[0], &shared, 1), "Part 1");
        assert!(has_a_word("The Vin"));
        assert!(!has_a_word("1P01"));
    }

    #[test]
    fn volume_markers_come_off() {
        assert_eq!(strip_volume_marker("The Final Empire (1 of 3)"), "The Final Empire");
        assert_eq!(strip_volume_marker("Title (not a volume)"), "Title (not a volume)");
        assert_eq!(strip_volume_marker("(2 of 3)"), "");
    }

    /// A single file named `Author - Title (aside)` donates both halves;
    /// a part named `01 - Chapter One` donates neither.
    #[test]
    fn a_single_file_names_its_own_book() {
        let one = inv(&["Frank Herbert - Dune (Unabridged Audiobook).mp3"], &[]);
        let plans = interpret_heuristically("dune1965", &one);
        assert_eq!(plans[0].author, "Frank Herbert");
        assert_eq!(plans[0].title, "Dune");

        let ordinal = inv(&["01 - Chapter One.mp3"], &[]);
        let plans = interpret_heuristically("Some Book", &ordinal);
        assert_eq!(plans[0].author, "Unknown Author", "an ordinal is not an author");
        assert_eq!(plans[0].title, "Some Book");
    }

    #[test]
    fn series_titles_shed_their_shelf_position() {
        assert_eq!(strip_ordinal("1. Dune"), "Dune");
        assert_eq!(strip_ordinal("02 - Dune Messiah"), "Dune Messiah");
        assert_eq!(strip_ordinal("1984"), "1984", "a title that IS a number keeps it");
        let series = inv(&["1. Dune/a.mp3", "2. Dune Messiah/b.mp3"], &[]);
        let plans = interpret_heuristically("Dune Series", &series);
        assert_eq!(plans[0].title, "Dune");
        assert_eq!(plans[1].title, "Dune Messiah");
    }
}
