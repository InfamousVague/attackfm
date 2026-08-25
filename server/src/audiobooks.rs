//! Audiobooks: search the public-domain catalogue, pull a book into the
//! library, and let every device read it back.
//!
//! The catalogue is LibriVox - keyless, public-domain, and honest about what
//! it has - whose books live as per-section MP3s on archive.org. A book here
//! is an ALBUM whose tracks are its sections: the importer files them under
//! `Audiobooks/<Author>/<Title>/`, tags each section with the book as its
//! album and "Audiobook" as its genre, embeds the archive's cover, and lets
//! the scanner index them like any other files. The folder is the contract:
//! `db::kind_for` marks everything inside it `kind = 'book'`, which is what
//! keeps sections out of every music surface (mixes, shuffle, search, the
//! curator's taste) and on the audiobooks shelf instead.
//!
//! The queue is deliberately small and in-memory, like pairing codes: a book
//! download is a human-paced errand, jobs are gone on restart, and the files
//! that already landed simply ARE the library afterwards - nothing to resume.
//!
//! | Route | What it answers |
//! |---|---|
//! | GET  /api/audiobooks/search?q= | LibriVox search, trimmed to what cards need |
//! | POST /api/audiobooks/import    | `{id}` - queue that book |
//! | GET  /api/audiobooks/jobs      | the queue, newest first |

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::{auth, scan, upload, AppState};

const LIBRIVOX: &str = "https://librivox.org/api/feed/audiobooks/";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(20))
        .user_agent("AttackFM/1.0 (audiobook importer)")
        .build()
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- The queue ---------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BookJob {
    pub id: String,
    /// LibriVox book id, so a client can tell "this book is already queued".
    pub book_id: u64,
    pub title: String,
    pub author: String,
    /// The archive.org thumbnail, for the job card.
    pub cover: String,
    /// queued | downloading | done | error
    pub state: String,
    pub total: u32,
    pub completed: u32,
    pub current_section: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    /// Database ids of the indexed sections, in reading order - what a client
    /// resolves against its synced library to start the book the moment it
    /// lands.
    pub track_ids: Vec<i64>,
}

/// The in-memory book queue. `worker` serialises the downloads the same way
/// imports' filing lock does: one book at a time, whoever asks next waits.
#[derive(Default)]
pub struct BookQueue {
    jobs: tokio::sync::Mutex<Vec<BookJob>>,
    worker: tokio::sync::Mutex<()>,
}

async fn update_job(state: &Arc<AppState>, id: &str, f: impl FnOnce(&mut BookJob)) {
    let mut jobs = state.audiobooks.jobs.lock().await;
    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
        f(job);
    }
}

// --- LibriVox ----------------------------------------------------------------

/// One section as LibriVox lists it; `listen_url` is an archive.org file.
struct Section {
    number: u32,
    title: String,
    url: String,
}

struct Book {
    id: u64,
    title: String,
    author: String,
    year: Option<i64>,
    /// The archive.org item identifier, derived from where the sections live.
    identifier: String,
    sections: Vec<Section>,
}

fn author_of(book: &Value) -> String {
    let authors = book.get("authors").and_then(|a| a.as_array());
    let first = authors.and_then(|a| a.first());
    let name = first
        .map(|a| {
            let f = a.get("first_name").and_then(|x| x.as_str()).unwrap_or("").trim();
            let l = a.get("last_name").and_then(|x| x.as_str()).unwrap_or("").trim();
            format!("{f} {l}").trim().to_string()
        })
        .unwrap_or_default();
    if name.is_empty() { "Unknown author".into() } else { name }
}

/// `https://www.archive.org/download/<identifier>/<file>` -> identifier.
fn identifier_from(url: &str) -> Option<String> {
    let after = url.split("/download/").nth(1)?;
    Some(after.split('/').next()?.to_string())
}

fn parse_book(v: &Value) -> Option<Book> {
    let sections: Vec<Section> = v
        .get("sections")
        .and_then(|s| s.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|s| {
                    let url = s.get("listen_url").and_then(|x| x.as_str())?.to_string();
                    if url.is_empty() {
                        return None;
                    }
                    Some(Section {
                        number: s
                            .get("section_number")
                            .and_then(|x| x.as_str())
                            .and_then(|x| x.parse().ok())
                            .unwrap_or(0),
                        title: s
                            .get("title")
                            .and_then(|x| x.as_str())
                            .unwrap_or("Section")
                            .to_string(),
                        url,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if sections.is_empty() {
        return None;
    }
    let identifier = v
        .get("url_iarchive")
        .and_then(|x| x.as_str())
        .and_then(|u| u.rsplit('/').next())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| identifier_from(&sections[0].url))?;
    Some(Book {
        id: v.get("id").and_then(|x| x.as_str()).and_then(|x| x.parse().ok())?,
        title: v.get("title").and_then(|x| x.as_str())?.to_string(),
        author: author_of(v),
        year: v
            .get("copyright_year")
            .and_then(|x| x.as_str())
            .and_then(|x| x.parse().ok()),
        identifier,
        sections,
    })
}

async fn librivox(params: &str) -> Result<Vec<Value>, String> {
    let url = format!("{LIBRIVOX}?{params}&format=json&extended=1");
    let v: Value = client()
        .get(&url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("LibriVox did not answer: {e}"))?
        .json()
        .await
        .map_err(|_| "LibriVox answered strangely".to_string())?;
    Ok(v.get("books").and_then(|b| b.as_array()).cloned().unwrap_or_default())
}

// --- Routes ------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    pub q: String,
}

/// `GET /api/audiobooks/search?q=` - the catalogue, trimmed to what the cards
/// need. Title first; when the title finds nothing the same words are tried as
/// an author, so "jane austen" answers with her shelf rather than nothing.
pub async fn search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let q = params.q.trim();
    if q.is_empty() {
        return Ok(Json(json!({ "results": [] })));
    }
    // LibriVox's title match is a rigid substring: "the gift of the magi"
    // misses a book filed as "Gift of the Magi". Try the query as typed, then
    // shorn of its leading article, then as an author - the same words, asked
    // three ways, and the first shelf with anything on it answers.
    let mut books = Vec::new();
    let stripped = q
        .to_lowercase()
        .strip_prefix("the ")
        .map(|_| &q[4..])
        .unwrap_or(q)
        .trim()
        .to_string();
    let mut asks: Vec<String> = vec![format!("title={}", url_encode(q))];
    if stripped.to_lowercase() != q.to_lowercase() {
        asks.push(format!("title={}", url_encode(&stripped)));
    }
    asks.push(format!("author={}", url_encode(q)));
    for ask in asks {
        books = librivox(&format!("{ask}&limit=20")).await.unwrap_or_default();
        if !books.is_empty() {
            break;
        }
    }
    let results: Vec<Value> = books
        .iter()
        .filter_map(parse_book)
        .map(|b| {
            json!({
                "id": b.id,
                "title": b.title,
                "author": b.author,
                "cover": format!("https://archive.org/services/img/{}", b.identifier),
                "sections": b.sections.len(),
                "totaltime": books
                    .iter()
                    .find(|v| v.get("id").and_then(|x| x.as_str()).and_then(|x| x.parse::<u64>().ok()) == Some(b.id))
                    .and_then(|v| v.get("totaltime"))
                    .and_then(|x| x.as_str())
                    .unwrap_or(""),
            })
        })
        .collect();
    Ok(Json(json!({ "results": results })))
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            b' ' => "%20".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Deserialize)]
pub struct ImportBody {
    pub id: u64,
}

/// `POST /api/audiobooks/import {id}` - queue one book. The server re-fetches
/// the book itself rather than trusting a client's URL list: the client only
/// ever names what it saw in our own search.
pub async fn import(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ImportBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    {
        let jobs = state.audiobooks.jobs.lock().await;
        if let Some(j) = jobs.iter().find(|j| j.book_id == body.id && j.state != "error") {
            return Ok(Json(json!({ "job": j })));
        }
    }

    let books = librivox(&format!("id={}", body.id))
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let book = books
        .first()
        .and_then(parse_book)
        .ok_or((StatusCode::NOT_FOUND, "LibriVox does not know that book".into()))?;

    let job = BookJob {
        id: format!("book-{}-{}", book.id, now_ms()),
        book_id: book.id,
        title: book.title.clone(),
        author: book.author.clone(),
        cover: format!("https://archive.org/services/img/{}", book.identifier),
        state: "queued".into(),
        total: book.sections.len() as u32,
        completed: 0,
        current_section: None,
        error: None,
        created_at: now_ms(),
        track_ids: Vec::new(),
    };
    let reply = job.clone();
    {
        let mut jobs = state.audiobooks.jobs.lock().await;
        jobs.push(job.clone());
        // The queue remembers enough to be a history, not a log.
        let len = jobs.len();
        if len > 20 {
            jobs.drain(0..len - 20);
        }
    }

    let state2 = state.clone();
    let job_id = job.id.clone();
    tokio::spawn(async move {
        run_job(state2, job_id, book).await;
    });

    Ok(Json(json!({ "job": reply })))
}

pub async fn jobs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let jobs = state.audiobooks.jobs.lock().await;
    let mut list: Vec<&BookJob> = jobs.iter().collect();
    list.reverse();
    Ok(Json(json!({ "jobs": list })))
}

// --- The worker --------------------------------------------------------------

/// A path segment that cannot escape or upset the filesystem.
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

/// The 64kb listen file's VBR sibling: LibriVox links the 64kbps copy, but the
/// archive item almost always carries the original VBR encode under the same
/// name without the suffix. Worth one extra request per section.
fn vbr_candidate(url: &str) -> Option<String> {
    url.strip_suffix("_64kb.mp3").map(|base| format!("{base}.mp3"))
}

async fn fetch_to(client: &reqwest::Client, url: &str, dest: &PathBuf) -> Result<i64, String> {
    use tokio::io::AsyncWriteExt;
    let resp = client.get(url).send().await.map_err(|e| format!("{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("answered {}", resp.status()));
    }
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| format!("{e}"))?;
    let mut resp = resp;
    let mut written: i64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{e}"))? {
        file.write_all(&chunk).await.map_err(|e| format!("{e}"))?;
        written += chunk.len() as i64;
    }
    file.flush().await.map_err(|e| format!("{e}"))?;
    drop(file);
    tokio::fs::rename(&tmp, dest).await.map_err(|e| format!("{e}"))?;
    Ok(written)
}

async fn run_job(state: Arc<AppState>, job_id: String, book: Book) {
    // One book at a time; a second import waits its turn here.
    let _worker = state.audiobooks.worker.lock().await;
    update_job(&state, &job_id, |j| j.state = "downloading".into()).await;

    let http = client();
    let dir = state
        .music_root
        .join("Audiobooks")
        .join(safe_segment(&book.author))
        .join(safe_segment(&book.title));
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        update_job(&state, &job_id, |j| {
            j.state = "error".into();
            j.error = Some(format!("cannot create the book's folder: {e}"));
        })
        .await;
        return;
    }

    // The cover, fetched once and embedded into every section: the shelf shows
    // the book's face, and the files stay self-describing if they ever travel.
    let cover: Option<Vec<u8>> = match http
        .get(format!("https://archive.org/services/img/{}", book.identifier))
        .timeout(Duration::from_secs(30))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.bytes().await.ok().map(|b| b.to_vec()),
        _ => None,
    };

    let width = if book.sections.len() >= 100 { 3 } else { 2 };
    let mut indexed: Vec<i64> = Vec::new();
    let mut failed: Option<String> = None;

    for (i, section) in book.sections.iter().enumerate() {
        let n = if section.number > 0 { section.number } else { (i as u32) + 1 };
        update_job(&state, &job_id, |j| {
            j.current_section = Some(section.title.clone());
        })
        .await;

        // Quota first: a book is big, and the ceiling holds here exactly as it
        // does for uploads and music imports.
        if state.library_quota_bytes > 0 && state.db.total_bytes() >= state.library_quota_bytes {
            failed = Some(format!(
                "library is at its quota ({})",
                upload::human_bytes(state.library_quota_bytes)
            ));
            break;
        }

        let file_name = format!("{n:0width$} - {}.mp3", safe_segment(&section.title));
        let dest = dir.join(&file_name);
        let rel = format!(
            "{}/{}/{}/{}",
            crate::ingest::audiobooks_component(&state.music_root),
            safe_segment(&book.author),
            safe_segment(&book.title),
            file_name
        );

        if !dest.exists() {
            // The VBR original first, the 64kbps listen copy as the fallback.
            let mut got = Err("no source".to_string());
            if let Some(vbr) = vbr_candidate(&section.url) {
                got = fetch_to(&http, &vbr, &dest).await;
            }
            if got.is_err() {
                got = fetch_to(&http, &section.url, &dest).await;
            }
            if let Err(e) = got {
                failed = Some(format!("{}: {e}", section.title));
                break;
            }

            // Tag it as the book's Nth track, wearing the archive's cover, so
            // the scanner reads back exactly the album this folder claims.
            let tag_path = dest.clone();
            let title = section.title.clone();
            let author = book.author.clone();
            let album = book.title.clone();
            let year = book.year;
            let cover_bytes = cover.clone();
            let tagged = tokio::task::spawn_blocking(move || {
                tag_section(&tag_path, &title, &author, &album, year, n, cover_bytes.as_deref())
            })
            .await
            .unwrap_or_else(|e| Err(format!("tagging thread died: {e}")));
            if let Err(e) = tagged {
                // A tag that would not write is not worth losing the audio
                // over; the scanner falls back to the filename.
                eprintln!("[audiobooks] tag write failed for {rel}: {e}");
            }
        }

        // Index it under the filing lock like every other arrival, so uploads,
        // music imports and books never race the scanner.
        let _filing = state.filing.lock().await;
        if scan::scan_one(&state.db, &state.music_root, &state.art_dir, &rel) {
            if let Some(id) = state.db.track_id_by_path(&rel) {
                indexed.push(id);
            }
        }
        drop(_filing);

        update_job(&state, &job_id, |j| {
            j.completed = (i as u32) + 1;
            j.track_ids = indexed.clone();
        })
        .await;
    }

    update_job(&state, &job_id, |j| {
        j.current_section = None;
        match &failed {
            Some(e) => {
                j.state = "error".into();
                j.error = Some(e.clone());
            }
            None => j.state = "done".into(),
        }
    })
    .await;
}

/// Blocking lofty write: the section's identity plus the book's cover.
/// Write a lyrics body into a file's own tag, leaving everything else alone.
///
/// The same lofty door `tag_section` uses, narrowed to one field: this is
/// called on music the listener already owns and tagged, so touching a single
/// key is the whole contract.
pub(crate) fn write_lyrics_tag(path: &std::path::Path, lyrics: &str) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::ItemKey;
    use lofty::probe::Probe;
    use lofty::tag::{Tag, TagExt};

    let mut tagged = Probe::open(path)
        .map_err(|e| format!("cannot open: {e}"))?
        .read()
        .map_err(|e| format!("cannot parse: {e}"))?;
    let kind = tagged.primary_tag_type();
    if tagged.primary_tag_mut().is_none() {
        tagged.insert_tag(Tag::new(kind));
    }
    let tag = tagged.primary_tag_mut().ok_or_else(|| "no tag to write".to_string())?;
    tag.insert_text(ItemKey::Lyrics, lyrics.to_string());
    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("cannot write: {e}"))
}

pub(crate) fn tag_section(
    path: &std::path::Path,
    title: &str,
    author: &str,
    album: &str,
    year: Option<i64>,
    track_no: u32,
    cover: Option<&[u8]>,
) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::{Accessor, ItemKey};
    use lofty::probe::Probe;
    use lofty::tag::Tag;

    let mut tagged = Probe::open(path)
        .map_err(|e| format!("cannot open: {e}"))?
        .read()
        .map_err(|e| format!("cannot parse: {e}"))?;
    if tagged.primary_tag().is_none() && tagged.first_tag().is_none() {
        let tag_type = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }
    let has_primary = tagged.primary_tag().is_some();
    let tag = if has_primary { tagged.primary_tag_mut() } else { tagged.first_tag_mut() }
        .ok_or_else(|| "no writable tag".to_string())?;

    tag.set_title(title.to_string());
    tag.set_artist(author.to_string());
    tag.insert_text(ItemKey::AlbumArtist, author.to_string());
    tag.set_album(album.to_string());
    tag.set_genre("Audiobook".to_string());
    tag.set_track(track_no);
    if let Some(y) = year {
        tag.set_year(y as u32);
    }
    if let Some(data) = cover {
        use lofty::picture::{MimeType, Picture, PictureType};
        tag.remove_picture_type(PictureType::CoverFront);
        let picture = Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            None,
            data.to_vec(),
        );
        tag.set_picture(0, picture);
    }

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("cannot save: {e}"))
}
