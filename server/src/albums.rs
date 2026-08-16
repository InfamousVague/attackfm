//! Album filler: the songs missing from records you already own most of.
//!
//! A library assembled a track at a time is full of nearly-complete albums -
//! eleven of twelve, the one single everybody ripped and nothing around it.
//! Nothing in the app could see those holes, because every other surface here
//! asks "what should I get NEXT", and this asks the opposite question: what is
//! already half here.
//!
//! Deliberately scoped to one artist per request. Checking a whole library
//! means a catalogue lookup per album - hundreds of calls, minutes of waiting,
//! and a rate limit at the end of it - so the listener picks who to check and
//! the work stays small enough to answer inside one request.
//!
//! The catalogue is Deezer's public API, keyless, the same one the discovery
//! harvest already walks. Matching is by folded title (see discovery::fold),
//! because a tag and a catalogue almost never agree character for character.

use crate::{auth, AppState};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// Albums checked per request. A prolific artist can have eighty entries once
/// singles and compilations are counted; the cap keeps one ask to a few seconds.
const MAX_ALBUMS: usize = 12;
/// Politeness between catalogue calls, matching the harvest's own pace.
const GAP: Duration = Duration::from_millis(250);

#[derive(Serialize)]
pub struct MissingTrack {
    /// Where it sits on the record, when the catalogue says.
    pub position: Option<u32>,
    pub title: String,
    /// The link an import takes. Empty when the catalogue gave none.
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumGap {
    pub album: String,
    pub artist: String,
    pub cover: Option<String>,
    /// How many of this album's tracks are already here.
    pub owned: usize,
    /// How many the catalogue says there are.
    pub total: usize,
    pub missing: Vec<MissingTrack>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("AttackFM/0.1 (personal music server)")
        .build()
        .unwrap_or_default()
}

/// The artist's albums as the catalogue lists them: id, title, cover.
async fn deezer_albums(c: &reqwest::Client, artist_id: u64) -> Vec<(u64, String, Option<String>)> {
    let Ok(reply) = c
        .get(format!("https://api.deezer.com/artist/{artist_id}/albums"))
        .query(&[("limit", "60")])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(v) = reply.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|a| {
                    Some((
                        a.get("id")?.as_u64()?,
                        a.get("title")?.as_str()?.to_string(),
                        a.get("cover_medium").and_then(|c| c.as_str()).map(String::from),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One album's tracklist: position, title, link.
///
/// Through the DEDICATED tracks endpoint rather than the album object's
/// embedded copy. The two differ in a way that matters: only the dedicated one
/// carries `track_position` (verified against the live API), so the embedded
/// copy left this counting the array and calling the index a position - fine
/// until a record is listed with a gap or out of order. It also takes a limit,
/// where the embedded list is one page and a box set is longer than that.
async fn deezer_tracklist(c: &reqwest::Client, album_id: u64) -> Vec<(Option<u32>, String, String)> {
    deezer_album_tracks(c, album_id)
        .await
        .into_iter()
        .map(|(position, title, url)| (Some(position), title, url))
        .collect()
}

#[derive(serde::Deserialize)]
pub struct GapQuery {
    pub artist: String,
}

/// `GET /api/albums/gaps?artist=` - which of this artist's records you own
/// part of, and what is missing from each.
pub async fn gaps(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<GapQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let artist = q.artist.trim().to_string();
    if artist.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "an artist to check is required".into()));
    }

    let mine = state.db.albums_by_artist(&artist);
    if mine.is_empty() {
        return Ok(Json(json!({ "artist": artist, "albums": [] })));
    }

    let c = client();
    let Some(artist_id) = crate::discovery::deezer_artist_id_public(&c, &artist).await else {
        return Ok(Json(json!({ "artist": artist, "albums": [] })));
    };
    tokio::time::sleep(GAP).await;
    let catalogue = deezer_albums(&c, artist_id).await;

    let mut out: Vec<AlbumGap> = Vec::new();
    for (album, tracks) in mine.into_iter().take(MAX_ALBUMS) {
        // The catalogue's entry for this record. Folded, because "Album
        // (Deluxe Edition)" and "Album" are the same record to a listener.
        let want = crate::discovery::fold(&album);
        let Some((id, cat_title, cover)) = catalogue
            .iter()
            .find(|(_, t, _)| crate::discovery::fold(t) == want)
            .or_else(|| {
                catalogue
                    .iter()
                    .find(|(_, t, _)| {
                        let f = crate::discovery::fold(t);
                        !f.is_empty() && (f.starts_with(&want) || want.starts_with(&f))
                    })
            })
            .cloned()
        else {
            continue;
        };
        tokio::time::sleep(GAP).await;
        let list = deezer_tracklist(&c, id).await;
        if list.is_empty() {
            continue;
        }
        let held: HashSet<String> =
            tracks.iter().map(|(t, _)| crate::discovery::title_key_public(t)).collect();
        let missing: Vec<MissingTrack> = list
            .iter()
            .filter(|(_, title, _)| !held.contains(&crate::discovery::title_key_public(title)))
            .map(|(position, title, url)| MissingTrack {
                position: *position,
                title: title.clone(),
                url: url.clone(),
            })
            .collect();
        if missing.is_empty() {
            continue;
        }
        out.push(AlbumGap {
            album: cat_title,
            artist: artist.clone(),
            cover,
            owned: tracks.len(),
            total: list.len(),
            missing,
        });
    }
    // The nearly-complete first: one song from finished is the most satisfying
    // thing this page can offer, and the emptiest record is the least.
    out.sort_by_key(|a| a.missing.len());
    Ok(Json(json!({ "artist": artist, "albums": out })))
}


// ── One record's songs ───────────────────────────────────────────────────────
//
// An album object from the catalogue carries no tracklist, only a URL to one
// (checked against the live API: the artist/albums reply has `tracklist` as a
// link and no track data at all). So the songs on a record are always a second
// call, per record - which is why this is its own endpoint rather than
// something the artist reply could have included.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTrack {
    pub position: u32,
    pub title: String,
    /// The link an import takes. Empty when the catalogue gave none.
    pub url: String,
    /// Whether this library already holds it.
    pub owned: bool,
}

#[derive(serde::Deserialize)]
pub struct TracksQuery {
    pub artist: String,
    pub album: String,
}

/// The full tracklist for one album, paged out of the catalogue's dedicated
/// endpoint. `limit=300` because the album object's own embedded list stops at
/// the first page, and a box set is longer than that.
async fn deezer_album_tracks(c: &reqwest::Client, album_id: u64) -> Vec<(u32, String, String)> {
    let Ok(reply) = c
        .get(format!("https://api.deezer.com/album/{album_id}/tracks"))
        .query(&[("limit", "300")])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(v) = reply.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(i, t)| {
                    // track_position when the catalogue carries it, else the
                    // order it came in - this endpoint DOES carry the field,
                    // unlike the one embedded in an album object.
                    let position = t
                        .get("track_position")
                        .and_then(|p| p.as_u64())
                        .map(|p| p as u32)
                        .unwrap_or((i + 1) as u32);
                    Some((
                        position,
                        t.get("title")?.as_str()?.to_string(),
                        t.get("link").and_then(|l| l.as_str()).unwrap_or("").to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `GET /api/album/tracks?artist=&album=` - the whole record as the catalogue
/// lists it, each song marked with whether this library holds it.
///
/// The album page shows what you own; this is what turns that into what the
/// record IS, with the holes visible. Empty `tracks` is a valid answer and
/// means the catalogue could not be reached or does not list this album - the
/// page falls back to showing only what it has, rather than claiming a record
/// is complete because nobody said otherwise.
pub async fn tracks(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TracksQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let artist = q.artist.trim().to_string();
    let album = q.album.trim().to_string();
    if artist.is_empty() || album.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "an artist and an album are required".into()));
    }

    let c = client();
    let Some(artist_id) = crate::discovery::deezer_artist_id_public(&c, &artist).await else {
        return Ok(Json(json!({ "album": album, "artist": artist, "tracks": [] })));
    };
    tokio::time::sleep(GAP).await;
    let catalogue = deezer_albums(&c, artist_id).await;

    // Same folded match the gap check uses, exact first then either-prefix, so
    // "Album (Deluxe Edition)" finds "Album" and the reverse.
    let want = crate::discovery::fold(&album);
    let Some((id, cat_title, cover)) = catalogue
        .iter()
        .find(|(_, t, _)| crate::discovery::fold(t) == want)
        .or_else(|| {
            catalogue.iter().find(|(_, t, _)| {
                let f = crate::discovery::fold(t);
                !f.is_empty() && (f.starts_with(&want) || want.starts_with(&f))
            })
        })
        .cloned()
    else {
        return Ok(Json(json!({ "album": album, "artist": artist, "tracks": [] })));
    };

    tokio::time::sleep(GAP).await;
    let list = deezer_album_tracks(&c, id).await;
    let held: HashSet<String> = state
        .db
        .album_track_titles(&artist, &album)
        .iter()
        .map(|t| crate::discovery::title_key_public(t))
        .collect();

    let out: Vec<CatalogTrack> = list
        .into_iter()
        .map(|(position, title, url)| CatalogTrack {
            owned: held.contains(&crate::discovery::title_key_public(&title)),
            position,
            title,
            url,
        })
        .collect();

    Ok(Json(json!({
        "album": cat_title,
        "artist": artist,
        "cover": cover,
        "tracks": out,
    })))
}
