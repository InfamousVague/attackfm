//! Library housekeeping: tag editing, cover-art replacement, duplicate
//! detection and resolution, storage accounting, and playlist import/export.
//!
//! The write endpoints (tags, art, duplicate resolve) are admin-only: they
//! rewrite the files themselves, not just rows, and every client sees the
//! result through the same delta sync a scan would produce - each edit
//! re-reads the touched file through scan.rs's own row builder, so the index
//! never holds a value a rescan would disagree with.
//!
//! Discipline inherited from the rest of the server: the database Mutex is
//! held for single statements only, never across file or network IO, and all
//! blocking work (lofty writes, directory walks, file moves) runs on the
//! blocking pool.

use crate::auth;
use crate::scan;
use crate::stream::resolve_in_root;
use crate::AppState;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

fn bad(status: StatusCode, message: &str) -> ApiError {
    (status, message.to_string())
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// One shared HTTP client for the art fetches: 15s ceiling, a real UA (the
/// MusicBrainz API refuses anonymous clients outright).
fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent(concat!(
                "AttackFM/",
                env!("CARGO_PKG_VERSION"),
                " (https://attack.fm)"
            ))
            .build()
            .expect("reqwest client")
    })
}

// --- 1. tag writing --------------------------------------------------------

/// What one field edit means: absent = leave alone, Some(None) = clear,
/// Some(Some(v)) = set. Parsed by hand from the JSON body because serde's
/// Option cannot tell null from missing, and here the difference is the API.
#[derive(Default)]
struct TagEdits {
    title: Option<Option<String>>,
    artist: Option<Option<String>>,
    album_artist: Option<Option<String>>,
    album: Option<Option<String>>,
    genre: Option<Option<String>>,
    year: Option<Option<i64>>,
    track_no: Option<Option<i64>>,
    disc_no: Option<Option<i64>>,
}

impl TagEdits {
    fn from_json(body: &serde_json::Value) -> Result<Self, ApiError> {
        let obj = body
            .as_object()
            .ok_or_else(|| bad(StatusCode::BAD_REQUEST, "expected a JSON object"))?;
        let text = |key: &str| -> Result<Option<Option<String>>, ApiError> {
            match obj.get(key) {
                None => Ok(None),
                Some(serde_json::Value::Null) => Ok(Some(None)),
                Some(serde_json::Value::String(s)) => {
                    let s = s.trim().to_string();
                    Ok(Some(if s.is_empty() { None } else { Some(s) }))
                }
                Some(_) => Err(bad(StatusCode::BAD_REQUEST, "tag fields must be strings")),
            }
        };
        let number = |key: &str| -> Result<Option<Option<i64>>, ApiError> {
            match obj.get(key) {
                None => Ok(None),
                Some(serde_json::Value::Null) => Ok(Some(None)),
                Some(v) => v
                    .as_i64()
                    .filter(|n| *n >= 0)
                    .map(|n| Some(Some(n)))
                    .ok_or_else(|| bad(StatusCode::BAD_REQUEST, "numeric fields must be non-negative numbers or null")),
            }
        };
        Ok(TagEdits {
            title: text("title")?,
            artist: text("artist")?,
            album_artist: text("albumArtist")?,
            album: text("album")?,
            genre: text("genre")?,
            year: number("year")?,
            track_no: number("trackNo")?,
            disc_no: number("discNo")?,
        })
    }

    fn is_noop(&self) -> bool {
        self.title.is_none()
            && self.artist.is_none()
            && self.album_artist.is_none()
            && self.album.is_none()
            && self.genre.is_none()
            && self.year.is_none()
            && self.track_no.is_none()
            && self.disc_no.is_none()
    }
}

/// Opens the file, applies the provided fields to its primary tag, saves.
/// Blocking - callers run it on the blocking pool.
fn write_file_tags(path: &Path, edits: &TagEdits) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::{Accessor, ItemKey};
    use lofty::probe::Probe;
    use lofty::tag::Tag;

    let mut tagged = Probe::open(path)
        .map_err(|e| format!("cannot open file: {e}"))?
        .read()
        .map_err(|e| format!("cannot parse file: {e}"))?;

    // The same tag scan.rs reads from, so the write lands where the rescan
    // will look. A file with no tag at all gets its format's primary type.
    if tagged.primary_tag().is_none() && tagged.first_tag().is_none() {
        let tag_type = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }
    let has_primary = tagged.primary_tag().is_some();
    let tag = if has_primary {
        tagged.primary_tag_mut()
    } else {
        tagged.first_tag_mut()
    }
    .ok_or_else(|| "file carries no writable tag".to_string())?;

    if let Some(v) = &edits.title {
        match v {
            Some(s) => tag.set_title(s.clone()),
            None => tag.remove_title(),
        }
    }
    if let Some(v) = &edits.artist {
        match v {
            Some(s) => tag.set_artist(s.clone()),
            None => tag.remove_artist(),
        }
    }
    if let Some(v) = &edits.album_artist {
        match v {
            Some(s) => {
                tag.insert_text(ItemKey::AlbumArtist, s.clone());
            }
            None => tag.remove_key(&ItemKey::AlbumArtist),
        }
    }
    if let Some(v) = &edits.album {
        match v {
            Some(s) => tag.set_album(s.clone()),
            None => tag.remove_album(),
        }
    }
    if let Some(v) = &edits.genre {
        match v {
            Some(s) => tag.set_genre(s.clone()),
            None => tag.remove_genre(),
        }
    }
    if let Some(v) = &edits.year {
        match v {
            Some(n) => tag.set_year(*n as u32),
            None => tag.remove_year(),
        }
    }
    if let Some(v) = &edits.track_no {
        match v {
            Some(n) => tag.set_track(*n as u32),
            None => tag.remove_track(),
        }
    }
    if let Some(v) = &edits.disc_no {
        match v {
            Some(n) => tag.set_disk(*n as u32),
            None => tag.remove_disk(),
        }
    }

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("cannot save tags: {e}"))
}

/// `POST /api/tracks/:id/tags` (admin) - writes the provided fields into the
/// file's own tags, then re-reads that file into its row the way a scan
/// would, bumping the library rev so every client's delta picks it up.
pub async fn write_tags(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> ApiResult {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    let edits = TagEdits::from_json(&body)?;
    if edits.is_noop() {
        // Nothing to write; hand back the row as it stands.
        let track = state.db.track(id).ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such track"))?;
        return Ok(Json(json!({ "track": track })));
    }

    let rel = state
        .db
        .track_rel_path(id)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such track"))?;
    let path = resolve_in_root(&state.music_root, &rel)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "file is gone"))?;

    let db = state.db.clone();
    let music_root = state.music_root.clone();
    let art_dir = state.art_dir.clone();
    let track = tokio::task::spawn_blocking(move || -> Result<crate::db::Track, String> {
        write_file_tags(&path, &edits)?;
        // Re-read through the scanner's own row builder: same values a scan
        // would produce, same rev discipline (current + 1).
        if !scan::scan_one(&db, &music_root, &art_dir, &rel) {
            return Err("tags saved, but the file no longer parses".into());
        }
        db.track(id).ok_or_else(|| "track vanished during rescan".into())
    })
    .await
    .map_err(internal)?
    .map_err(|e| bad(StatusCode::UNPROCESSABLE_ENTITY, &e))?;

    Ok(Json(json!({ "track": track })))
}

// --- 2. art candidates -----------------------------------------------------

/// `GET /api/art/candidates?artist=&album=` - cover options from iTunes,
/// Deezer and the Cover Art Archive. Best-effort per source: one erroring
/// contributes nothing and fails nobody.
pub async fn art_candidates(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let artist = params.get("artist").map(|s| s.trim()).unwrap_or("");
    let album = params.get("album").map(|s| s.trim()).unwrap_or("");
    if artist.is_empty() && album.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "artist or album required"));
    }

    let (itunes, deezer, caa) = futures_util::join!(
        itunes_candidates(artist, album),
        deezer_candidates(artist, album),
        caa_candidates(artist, album),
    );

    let mut seen = std::collections::HashSet::new();
    let mut candidates = Vec::new();
    for c in itunes.into_iter().chain(deezer).chain(caa) {
        if seen.insert(c["url"].as_str().unwrap_or("").to_string()) {
            candidates.push(c);
        }
    }
    Ok(Json(json!({ "candidates": candidates })))
}

async fn itunes_candidates(artist: &str, album: &str) -> Vec<serde_json::Value> {
    let term = format!("{artist} {album}");
    let url = format!(
        "https://itunes.apple.com/search?media=music&entity=album&limit=6&term={}",
        urlencode(term.trim())
    );
    let Ok(resp) = http().get(&url).send().await else { return Vec::new() };
    let Ok(body) = resp.json::<serde_json::Value>().await else { return Vec::new() };
    body["results"]
        .as_array()
        .map(|results| {
            results
                .iter()
                .filter_map(|r| r["artworkUrl100"].as_str())
                // The CDN serves any size you name; 100x100 is just the
                // size the search API happens to mention.
                .map(|art| art.replace("100x100bb", "1200x1200bb"))
                .map(|url| json!({ "url": url, "source": "itunes", "width": 1200, "height": 1200 }))
                .collect()
        })
        .unwrap_or_default()
}

async fn deezer_candidates(artist: &str, album: &str) -> Vec<serde_json::Value> {
    let q = format!("{artist} {album}");
    let url = format!("https://api.deezer.com/search/album?limit=6&q={}", urlencode(q.trim()));
    let Ok(resp) = http().get(&url).send().await else { return Vec::new() };
    let Ok(body) = resp.json::<serde_json::Value>().await else { return Vec::new() };
    body["data"]
        .as_array()
        .map(|hits| {
            hits.iter()
                .filter_map(|hit| hit["cover_xl"].as_str())
                .filter(|u| !u.is_empty())
                // cover_xl is Deezer's 1000px rendition.
                .map(|url| json!({ "url": url, "source": "deezer", "width": 1000, "height": 1000 }))
                .collect()
        })
        .unwrap_or_default()
}

async fn caa_candidates(artist: &str, album: &str) -> Vec<serde_json::Value> {
    // MusicBrainz release search first, then the Cover Art Archive's
    // deterministic per-release URL. HEAD each candidate: most releases have
    // no art, and a dead thumbnail is worse than none.
    let mut query = String::new();
    if !album.is_empty() {
        query.push_str(&format!("release:\"{}\"", album.replace('"', "")));
    }
    if !artist.is_empty() {
        if !query.is_empty() {
            query.push_str(" AND ");
        }
        query.push_str(&format!("artist:\"{}\"", artist.replace('"', "")));
    }
    let url = format!(
        "https://musicbrainz.org/ws/2/release/?fmt=json&limit=4&query={}",
        urlencode(&query)
    );
    let Ok(resp) = http().get(&url).send().await else { return Vec::new() };
    let Ok(body) = resp.json::<serde_json::Value>().await else { return Vec::new() };
    let ids: Vec<String> = body["releases"]
        .as_array()
        .map(|rs| {
            rs.iter()
                .filter_map(|r| r["id"].as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let mut out = Vec::new();
    for mbid in ids {
        let front = format!("https://coverartarchive.org/release/{mbid}/front-500");
        // The archive answers HEAD with a redirect to the image when it has
        // one and 404 when it does not.
        match http().head(&front).send().await {
            Ok(resp) if resp.status().is_success() => {
                out.push(json!({ "url": front, "source": "caa", "width": 500, "height": 500 }));
            }
            _ => {}
        }
    }
    out
}

/// Percent-encodes a query value. Byte-wise, which is exactly what URLs want.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// --- 3. album art embedding ------------------------------------------------

#[derive(Deserialize)]
pub struct AlbumArtBody {
    pub album: String,
    #[serde(rename = "albumArtist")]
    pub album_artist: String,
    pub url: String,
}

/// The download ceiling: covers are megabytes at most, and this endpoint
/// fetches an arbitrary URL an admin pasted.
const ART_DOWNLOAD_CAP: usize = 10 * 1024 * 1024;

/// Fetches the image, capped and validated (it must decode).
/// Returns the raw bytes plus the lofty mime for embedding.
async fn download_art(url: &str) -> Result<(Vec<u8>, lofty::picture::MimeType), String> {
    use futures_util::StreamExt;
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("url must be http(s)".into());
    }
    let resp = http()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    if resp.content_length().is_some_and(|len| len as usize > ART_DOWNLOAD_CAP) {
        return Err("image is larger than 10MB".into());
    }
    let mut data = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download failed: {e}"))?;
        if data.len() + chunk.len() > ART_DOWNLOAD_CAP {
            return Err("image is larger than 10MB".into());
        }
        data.extend_from_slice(&chunk);
    }

    // Must decode: an admin pasting a URL should find out now that it is an
    // HTML error page, not after it has been embedded into forty files.
    let format = image::guess_format(&data).map_err(|_| "not a recognisable image".to_string())?;
    image::load_from_memory_with_format(&data, format)
        .map_err(|e| format!("image does not decode: {e}"))?;
    let mime = match format {
        image::ImageFormat::Png => lofty::picture::MimeType::Png,
        image::ImageFormat::Gif => lofty::picture::MimeType::Gif,
        image::ImageFormat::Jpeg => lofty::picture::MimeType::Jpeg,
        other => lofty::picture::MimeType::Unknown(format!("image/{}", other.extensions_str().first().unwrap_or(&"bin"))),
    };
    Ok((data, mime))
}

/// Replaces the front cover of one file. Blocking.
fn embed_front_cover(
    path: &Path,
    data: &[u8],
    mime: &lofty::picture::MimeType,
) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::picture::{Picture, PictureType};
    use lofty::probe::Probe;
    use lofty::tag::Tag;

    let mut tagged = Probe::open(path)
        .map_err(|e| format!("cannot open file: {e}"))?
        .read()
        .map_err(|e| format!("cannot parse file: {e}"))?;
    if tagged.primary_tag().is_none() && tagged.first_tag().is_none() {
        let tag_type = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }
    let has_primary = tagged.primary_tag().is_some();
    let tag = if has_primary {
        tagged.primary_tag_mut()
    } else {
        tagged.first_tag_mut()
    }
    .ok_or_else(|| "file carries no writable tag".to_string())?;

    tag.remove_picture_type(PictureType::CoverFront);
    // Index 0: scan.rs reads pictures().first(), so the new front cover must
    // be what a rescan sees first.
    let picture = Picture::new_unchecked(
        PictureType::CoverFront,
        Some(mime.clone()),
        None,
        data.to_vec(),
    );
    // set_picture(0) replaces whatever picture a rescan would read first, and
    // appends when the tag holds none.
    tag.set_picture(0, picture);
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("cannot save cover: {e}"))
}

/// `POST /api/album-art` (admin) - embeds the image at `url` as the front
/// cover of every file in the album, re-reading each into the index so the
/// new content-addressed art id propagates by delta sync.
pub async fn set_album_art(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AlbumArtBody>,
) -> ApiResult {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    let album = body.album.trim().to_string();
    let album_artist = body.album_artist.trim().to_string();
    if album.is_empty() || album_artist.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "album and albumArtist required"));
    }

    let files = state.db.album_files(&album, &album_artist);
    if files.is_empty() {
        return Err(bad(StatusCode::NOT_FOUND, "no tracks match that album"));
    }

    let (data, mime) = download_art(body.url.trim())
        .await
        .map_err(|e| bad(StatusCode::UNPROCESSABLE_ENTITY, &e))?;

    let db = state.db.clone();
    let music_root = state.music_root.clone();
    let art_dir = state.art_dir.clone();
    let (updated, art_id) = tokio::task::spawn_blocking(move || {
        let mut updated = 0usize;
        let mut art_id: Option<String> = None;
        for (id, rel) in &files {
            let Some(path) = resolve_in_root(&music_root, rel) else { continue };
            if let Err(e) = embed_front_cover(&path, &data, &mime) {
                eprintln!("[tools] cover write failed for {rel}: {e}");
                continue;
            }
            // Same store_art path the scanner uses: the rescan reads the
            // picture back out of the file and content-addresses it.
            if scan::scan_one(&db, &music_root, &art_dir, rel) {
                updated += 1;
                if art_id.is_none() {
                    art_id = db.track(*id).and_then(|t| t.art_id);
                }
            }
        }
        (updated, art_id)
    })
    .await
    .map_err(internal)?;

    Ok(Json(json!({ "updated": updated, "artId": art_id })))
}

// --- 4. duplicates ---------------------------------------------------------

/// The normalisation both title and artist go through before comparison:
/// lowercase, bracketed segments dropped, punctuation flattened, whitespace
/// collapsed. "Song (Remastered 2011)" and "song" cluster; the duration
/// tolerance keeps genuinely different recordings apart.
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for ch in s.chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            _ => {
                if ch.is_alphanumeric() {
                    out.extend(ch.to_lowercase());
                } else {
                    // Every punctuation mark and space becomes one space,
                    // collapsed below.
                    out.push(' ');
                }
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How far apart two durations may sit and still count as one recording.
const DUP_DURATION_TOLERANCE_S: f64 = 2.0;

/// `GET /api/library/duplicates` - clusters of probable same-recordings.
pub async fn duplicates(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let tracks = state.db.all_live_tracks();
    let mut groups: HashMap<(String, String), Vec<crate::db::Track>> = HashMap::new();
    for t in tracks {
        let key = (normalize(&t.title), normalize(&t.artist));
        if key.0.is_empty() {
            continue;
        }
        groups.entry(key).or_default().push(t);
    }

    let mut clusters: Vec<Vec<crate::db::Track>> = Vec::new();
    for (_, mut group) in groups {
        if group.len() < 2 {
            continue;
        }
        // Chain-cluster by duration: sorted, a track joins the open cluster
        // while it sits within tolerance of the cluster's first member.
        // Unknown durations sort first and match anything.
        group.sort_by(|a, b| {
            a.duration
                .unwrap_or(-1.0)
                .partial_cmp(&b.duration.unwrap_or(-1.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut open: Vec<crate::db::Track> = Vec::new();
        let mut anchor: Option<f64> = None;
        for t in group {
            let close = match (anchor, t.duration) {
                (None, _) | (_, None) => true,
                (Some(a), Some(d)) => (d - a).abs() <= DUP_DURATION_TOLERANCE_S,
            };
            if open.is_empty() || close {
                if anchor.is_none() {
                    anchor = t.duration;
                }
                open.push(t);
            } else {
                if open.len() >= 2 {
                    clusters.push(std::mem::take(&mut open));
                } else {
                    open.clear();
                }
                anchor = t.duration;
                open.push(t);
            }
        }
        if open.len() >= 2 {
            clusters.push(open);
        }
    }

    // Stable order for the UI: biggest clusters first, then alphabetical.
    clusters.sort_by(|a, b| {
        b.len()
            .cmp(&a.len())
            .then_with(|| a[0].title.to_lowercase().cmp(&b[0].title.to_lowercase()))
    });

    let clusters: Vec<_> = clusters
        .into_iter()
        .map(|tracks| json!({ "tracks": tracks }))
        .collect();
    Ok(Json(json!({ "clusters": clusters })))
}

// --- 5. duplicate resolution -----------------------------------------------

#[derive(Deserialize)]
pub struct ResolveBody {
    pub keep: i64,
    pub drop: Vec<i64>,
}

/// Moves one library file into the trash, preserving its filename and
/// suffixing -2, -3... on collisions. Never unlinks. Blocking.
fn quarantine_file(music_root: &Path, rel: &str) -> Result<(), String> {
    let src = resolve_in_root(music_root, rel).ok_or_else(|| format!("{rel}: not in library"))?;
    let trash = music_root.join(scan::TRASH_DIR);
    std::fs::create_dir_all(&trash).map_err(|e| format!("cannot create trash dir: {e}"))?;

    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{rel}: unnameable file"))?;
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    let mut dest = trash.join(name);
    let mut n = 2;
    while dest.exists() {
        dest = trash.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    std::fs::rename(&src, &dest).map_err(|e| format!("{rel}: move failed: {e}"))
}

/// `POST /api/library/duplicates/resolve` (admin) - re-points every reference
/// from the dropped tracks to the kept one, quarantines the dropped files
/// under <libraryRoot>/.attackfm-trash/, and tombstones the rows so the delta
/// sync's removed[] carries them.
pub async fn resolve_duplicates(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ResolveBody>,
) -> ApiResult {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;

    if body.drop.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "nothing to drop"));
    }
    if body.drop.contains(&body.keep) {
        return Err(bad(StatusCode::BAD_REQUEST, "keep cannot also be dropped"));
    }
    state
        .db
        .track(body.keep)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "kept track does not exist"))?;

    // Only drops that are live rows with known paths take part.
    let mut drops: Vec<(i64, String)> = Vec::new();
    for &id in &body.drop {
        if let Some(rel) = state.db.track_rel_path(id) {
            drops.push((id, rel));
        }
    }
    if drops.is_empty() {
        return Err(bad(StatusCode::NOT_FOUND, "none of the dropped tracks exist"));
    }

    // 1. Re-point references while every row still exists (brief lock).
    let ids: Vec<i64> = drops.iter().map(|(id, _)| *id).collect();
    state
        .db
        .repoint_track_refs(body.keep, &ids)
        .map_err(internal)?;

    // 2. Move the files - no lock held, and never a deletion.
    let music_root = state.music_root.clone();
    let moved: Vec<i64> = tokio::task::spawn_blocking(move || {
        let mut moved = Vec::new();
        for (id, rel) in drops {
            match quarantine_file(&music_root, &rel) {
                Ok(()) => moved.push(id),
                // A file already missing on disk is as dropped as it gets:
                // tombstone it too rather than leaving a phantom row.
                Err(e) => {
                    if music_root.join(&rel).exists() {
                        eprintln!("[tools] quarantine failed: {e}");
                    } else {
                        moved.push(id);
                    }
                }
            }
        }
        moved
    })
    .await
    .map_err(internal)?;

    if moved.is_empty() {
        return Err(bad(
            StatusCode::INTERNAL_SERVER_ERROR,
            "no files could be moved to the trash",
        ));
    }

    // 3. Tombstone under one fresh rev, the scanner's own discipline.
    let rev = state.db.current_rev() + 1;
    state.db.tombstone_tracks(&moved, rev).map_err(internal)?;

    Ok(Json(json!({ "ok": true, "dropped": moved.len() })))
}

// --- 6. storage ------------------------------------------------------------

/// Recursive byte count of a directory. Blocking; symlinks not followed.
fn dir_bytes(root: &Path) -> i64 {
    let mut total = 0i64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len() as i64;
            }
        }
    }
    total
}

/// `GET /api/storage` - where the disk went.
pub async fn storage(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let library_bytes = state.db.total_bytes();
    let track_count = state.db.track_count();
    let by_artist: Vec<_> = state
        .db
        .storage_by_artist(100)
        .into_iter()
        .map(|(artist, bytes, tracks)| json!({ "artist": artist, "bytes": bytes, "tracks": tracks }))
        .collect();
    let by_album: Vec<_> = state
        .db
        .storage_by_album(100)
        .into_iter()
        .map(|(album, album_artist, bytes, tracks)| {
            json!({ "album": album, "albumArtist": album_artist, "bytes": bytes, "tracks": tracks })
        })
        .collect();
    let by_codec: Vec<_> = state
        .db
        .storage_by_codec()
        .into_iter()
        .map(|(codec, bytes, tracks)| json!({ "codec": codec, "bytes": bytes, "tracks": tracks }))
        .collect();
    let rarely: Vec<_> = state
        .db
        .rarely_played_albums(2, 25)
        .into_iter()
        .map(|(album, album_artist, bytes, plays)| {
            json!({ "album": album, "albumArtist": album_artist, "bytes": bytes, "plays": plays })
        })
        .collect();

    let collector = json!({
        "ledgerBytes": state.db.collector_ledger_bytes(),
        "capBytes": crate::collector::cap_bytes(&state),
    });

    // The directory walks are real IO - off the async runtime, no DB lock.
    let art_dir = state.art_dir.clone();
    let trash_dir = state.music_root.join(scan::TRASH_DIR);
    let (art_bytes, trash_bytes) =
        tokio::task::spawn_blocking(move || (dir_bytes(&art_dir), dir_bytes(&trash_dir)))
            .await
            .map_err(internal)?;

    Ok(Json(json!({
        "libraryBytes": library_bytes,
        "trackCount": track_count,
        "byArtist": by_artist,
        "byAlbum": by_album,
        "byCodec": by_codec,
        "artBytes": art_bytes,
        // This server transcodes live through a pipe and caches nothing, so
        // there is no transcode directory to measure.
        "transcodeBytes": 0,
        "trashBytes": trash_bytes,
        "collector": collector,
        "rarelyPlayed": rarely,
    })))
}

// --- 7. backup export ------------------------------------------------------

/// Civil date from a unix timestamp (days-based algorithm, no chrono).
fn ymd(unix_secs: i64) -> (i64, u32, u32) {
    let days = unix_secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `GET /api/export/backup` - the caller's playlists and favourites as one
/// portable JSON file, identified by tags and relative paths rather than ids
/// so it survives being restored onto a different server.
pub async fn export_backup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let playlists: Vec<_> = state
        .db
        .export_playlists(caller.id)
        .into_iter()
        .map(|(name, tracks)| {
            let tracks: Vec<_> = tracks
                .into_iter()
                .map(|(path, title, artist, album)| {
                    json!({ "path": path, "title": title, "artist": artist, "album": album })
                })
                .collect();
            json!({ "name": name, "tracks": tracks })
        })
        .collect();
    let favorites = state.db.favorite_paths(caller.id);

    let exported_at = now_ms();
    let (y, m, d) = ymd(exported_at / 1000);
    let filename = format!("attackfm-backup-{y:04}-{m:02}-{d:02}.json");
    let body = serde_json::to_string_pretty(&json!({
        "exportedAt": exported_at,
        "playlists": playlists,
        "favorites": favorites,
    }))
    .map_err(internal)?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        body,
    )
        .into_response())
}

// --- 8. m3u export ---------------------------------------------------------

/// Strips a playlist name down to something a filename header can carry.
fn safe_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '"' | ':' | '*' | '?' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        "playlist".to_string()
    } else {
        cleaned
    }
}

/// `GET /api/playlists/:id/export.m3u` - the playlist as an extended M3U of
/// library-relative paths.
pub async fn export_m3u(
    State(state): State<Arc<AppState>>,
    AxumPath(playlist_id): AxumPath<i64>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    // The same ownership rule every playlist edit enforces, same shape of
    // refusal - a probe cannot tell "not yours" from "not there".
    match state.db.playlist_owner(playlist_id) {
        Some(owner) if owner == caller.id => {}
        _ => return Err(bad(StatusCode::NOT_FOUND, "no such playlist")),
    }
    let name = state
        .db
        .playlist_name(playlist_id)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such playlist"))?;

    let mut m3u = String::from("#EXTM3U\n");
    for (title, artist, duration_ms, rel_path) in state.db.playlist_export_rows(playlist_id) {
        let secs = duration_ms.map(|ms| (ms as f64 / 1000.0).round() as i64).unwrap_or(-1);
        m3u.push_str(&format!("#EXTINF:{secs},{artist} - {title}\n{rel_path}\n"));
    }

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "audio/x-mpegurl".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}.m3u\"", safe_filename(&name)),
            ),
        ],
        m3u,
    )
        .into_response())
}

// --- 9. playlist import ----------------------------------------------------

#[derive(Deserialize, Clone)]
pub struct ImportEntry {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
}

#[derive(Deserialize)]
pub struct ImportBody {
    pub name: String,
    pub entries: Vec<ImportEntry>,
}

/// `POST /api/playlists/import` - resolves each entry against the library
/// (exact rel path first, then case-insensitive title+artist) and creates the
/// playlist from the matches, in entry order.
pub async fn import_playlist(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ImportBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "a playlist needs a name"));
    }

    // The identity index once, not one query per entry.
    let mut by_tags: HashMap<(String, String), i64> = HashMap::new();
    for row in state.db.match_index() {
        by_tags
            .entry((row.title.trim().to_lowercase(), row.artist.trim().to_lowercase()))
            .or_insert(row.id);
    }

    let mut matched: Vec<i64> = Vec::new();
    let mut missed: Vec<serde_json::Value> = Vec::new();
    for entry in &body.entries {
        let by_path = entry
            .path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .and_then(|p| state.db.track_id_by_path(p));
        let id = by_path.or_else(|| {
            let title = entry.title.as_deref().unwrap_or("").trim().to_lowercase();
            let artist = entry.artist.as_deref().unwrap_or("").trim().to_lowercase();
            if title.is_empty() {
                return None;
            }
            by_tags.get(&(title, artist)).copied()
        });
        match id {
            Some(id) => matched.push(id),
            None => missed.push(json!({
                "title": entry.title,
                "artist": entry.artist,
                "path": entry.path,
            })),
        }
    }

    let id = state.db.create_playlist(caller.id, &name).map_err(internal)?;
    state.db.set_playlist_tracks(id, &matched).map_err(internal)?;

    Ok(Json(json!({ "id": id, "matched": matched.len(), "missed": missed })))
}
