//! Suggested playlists to add: browse a chart, tap once, and the whole thing
//! flows through the import pipeline.
//!
//! The catalogue is a curated set of Spotify's own editorial playlist ids -
//! the charts and genre/decade staples whose ids are stable. Their titles,
//! covers, and track counts come from the public embed page (the same free,
//! auth-less source SpotiFLAC scrapes; see imports::fetch_embed_meta), so
//! nothing here needs a Spotify key. Each card carries the playlist's own
//! open.spotify.com URL - exactly what `POST /api/imports` already knows how
//! to download - so "Add" is just an enqueue.
//!
//! The metadata is fetched once and cached for a day (charts refresh their
//! CONTENTS often but their identity rarely), refreshed in the background so
//! the endpoint never waits on a dozen embed round-trips.
//!
//! Spotify is not the only voice here. Deezer's public API answers charts and
//! per-genre top albums with NO key and rich metadata inline (cover, title,
//! artist in one response, no per-item scrape), so the bulk of the page - top
//! albums across two dozen genres - comes from there. A Deezer link is not one
//! SpotiFLAC takes directly, but the import pipeline already resolves it
//! through song.link (see imports::spotiflac_input), so "Add" works the same.
//! The result is an order of magnitude more to browse, and a second curator's
//! taste beside Spotify's.

use crate::auth;
use crate::imports::fetch_embed_meta;
use crate::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Deezer genre ids, stable enough to hardcode (the same ids `/editorial`
/// returns). Each becomes a section of top albums. "All" is left out - the
/// cross-genre charts already cover it - and the long tail of regional genres
/// is kept because a discovery page should reach past the anglophone charts.
const DEEZER_GENRES: &[(u32, &str)] = &[
    (132, "Pop"),
    (116, "Hip-Hop"),
    (152, "Rock"),
    (113, "Dance"),
    (165, "R&B"),
    (85, "Alternative"),
    (106, "Electronic"),
    (466, "Folk"),
    (144, "Reggae"),
    (129, "Jazz"),
    (84, "Country"),
    (98, "Classical"),
    (464, "Metal"),
    (169, "Soul & Funk"),
    (173, "Soundtracks"),
    (186, "Christian"),
    (122, "Reggaeton"),
    (2, "African"),
    (16, "Asian"),
    (153, "Blues"),
    (75, "Brazilian"),
    (67, "Latin"),
];

/// How many top albums to pull per Deezer genre. Twenty-two genres at fifteen
/// each, plus a trending-tracks row and the Spotify playlists - comfortably an
/// order of magnitude past the two dozen this page used to show.
const DEEZER_PER_GENRE: u32 = 15;

/// How many trending single tracks to lead with - a different shape from the
/// album grids, and a way in for someone after one song rather than a record.
const DEEZER_TRENDING: u32 = 30;

/// (playlist id, section) - the section groups them on the client.
/// Spotify editorial ids, stable enough to hardcode; any that stops resolving
/// simply drops out of the response rather than erroring.
const CATALOG: &[(&str, &str)] = &[
    // Charts
    ("37i9dQZEVXbLRQDuF5jeBp", "Charts"), // Top 50 - USA
    ("37i9dQZEVXbMDoHDwVN2tF", "Charts"), // Top 50 - Global
    ("37i9dQZF1DXcBWIGoYBM5M", "Charts"), // Today's Top Hits
    ("37i9dQZEVXbKuaTI1Z1Afx", "Charts"), // Viral 50 - USA
    ("37i9dQZEVXbLiRSasKsNU9", "Charts"), // Viral 50 - Global
    // By genre
    ("37i9dQZF1DX0XUsuxWHRQd", "By genre"), // RapCaviar
    ("37i9dQZF1DWXRqgorJj26U", "By genre"), // Rock Classics
    ("37i9dQZF1DX1lVhptIYRda", "By genre"), // Hot Country
    ("37i9dQZF1DX4SBhb3fqCJd", "By genre"), // Are & Be (R&B)
    ("37i9dQZF1DX4dyzvuaRJ0n", "By genre"), // mint (dance/electronic)
    ("37i9dQZF1DWWQRwui0ExPn", "By genre"), // Lorem (indie)
    // New & rising - what just dropped, and who is on the way up.
    ("37i9dQZF1DX4JAvHpjipBk", "New releases"), // New Music Friday
    ("37i9dQZF1DWUa8ZRTfalHk", "New releases"), // Pop Rising
    ("37i9dQZF1DWWjGdmeTyeJ6", "New releases"), // Fresh Finds
    // Moods - a run to put on for a whole afternoon.
    ("37i9dQZF1DX4WYpdgoIcn6", "Moods"), // Chill Hits
    ("37i9dQZF1DX4sWSpwq3LiO", "Moods"), // Peaceful Piano
    ("37i9dQZF1DX76Wlfdnj7AP", "Moods"), // Beast Mode
    ("37i9dQZF1DWTwnEm1IYyoj", "Moods"), // Soft Pop Hits
    // By decade
    ("37i9dQZF1DX4UtSsGT1Sbe", "By decade"), // All Out 80s
    ("37i9dQZF1DXbTxeAdrVG2l", "By decade"), // All Out 90s
    ("37i9dQZF1DX4o1oenSJRJd", "By decade"), // All Out 2000s
    ("37i9dQZF1DX5Ejj0EkURtP", "By decade"), // All Out 2010s
];

/// The refresh interval for the cached catalogue metadata.
const TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Serialize)]
pub struct Suggestion {
    pub id: String,
    pub title: String,
    pub blurb: String,
    pub cover: Option<String>,
    pub url: String,
    pub section: String,
    /// Which service this came from ("spotify" | "deezer"), so the client can
    /// say where a suggestion is from rather than implying it is all one place.
    pub source: String,
    /// "playlist" | "album" - the shape of the thing, so the card and the
    /// preview know whether to promise a whole list or one record.
    pub kind: String,
    #[serde(rename = "trackCount")]
    pub track_count: Option<u32>,
    /// The playlist's track titles, in order, as the public embed lists them -
    /// what the client's preview shows before the user commits. Empty for an
    /// album (its card carries cover, title and artist already).
    pub tracks: Vec<String>,
    /// The same songs with their artist and length. The embed already reads
    /// all three (imports::fetch_embed_meta builds these for the queue), and
    /// only the titles used to travel - which was enough for a one-line
    /// preview and not enough to draw the list as a page. Kept BESIDE
    /// `tracks` rather than replacing it so a client built before this one
    /// reads its titles exactly as it always did.
    pub items: Vec<crate::imports::ImportItem>,
}

#[derive(Default)]
pub struct DiscoverState {
    cache: tokio::sync::Mutex<Option<(Vec<Suggestion>, Instant)>>,
    refreshing: std::sync::atomic::AtomicBool,
}

impl DiscoverState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

/// The Spotify editorial playlists, each resolved from its public embed. Entries
/// that do not resolve (a retired playlist, a hiccup) are simply left out.
async fn build_spotify() -> Vec<Suggestion> {
    let mut out = Vec::new();
    for (id, section) in CATALOG {
        let url = format!("https://open.spotify.com/playlist/{id}");
        if let Some(meta) = fetch_embed_meta(&url, "playlist").await {
            let (title, cover, total, titles) = (meta.name, meta.cover, meta.total, meta.titles);
            let blurb = match total {
                Some(n) => format!("{n} songs · add the whole list"),
                None => "Add the whole list".to_string(),
            };
            out.push(Suggestion {
                id: (*id).to_string(),
                title,
                blurb,
                cover,
                url,
                section: (*section).to_string(),
                source: "spotify".to_string(),
                kind: "playlist".to_string(),
                track_count: total,
                tracks: titles,
                items: meta.items,
            });
        }
    }
    out
}

/// One Deezer genre's top albums, straight from the chart endpoint. The album
/// object carries cover, title and artist inline, so a whole genre is one HTTP
/// call rather than a dozen scrapes. A Deezer link imports fine (song.link
/// resolves it in the pipeline).
async fn build_deezer_genre(client: &reqwest::Client, genre_id: u32, section: &str) -> Vec<Suggestion> {
    let url = format!("https://api.deezer.com/chart/{genre_id}/albums?limit={DEEZER_PER_GENRE}");
    let value: serde_json::Value = match client.get(&url).send().await {
        Ok(resp) => match resp.json().await {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    let Some(items) = value.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for a in items {
        let (Some(id), Some(title), Some(link)) = (
            a.get("id").and_then(|v| v.as_u64()),
            a.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()),
            a.get("link").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let artist = a
            .get("artist")
            .and_then(|x| x.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let cover = a
            .get("cover_medium")
            .or_else(|| a.get("cover_big"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let nb = a.get("nb_tracks").and_then(|v| v.as_u64()).map(|n| n as u32);
        out.push(Suggestion {
            id: format!("dz-album-{id}"),
            title: title.to_string(),
            blurb: if artist.is_empty() { "Album".to_string() } else { format!("{artist} · album") },
            cover,
            url: link.to_string(),
            section: section.to_string(),
            source: "deezer".to_string(),
            kind: "album".to_string(),
            track_count: nb,
            tracks: Vec::new(),
            items: Vec::new(),
        });
    }
    out
}

/// A global run of trending single tracks, the row that leads the page. Same
/// resolver path as albums (a Deezer track link imports fine), a different
/// shape to browse.
async fn build_deezer_trending(client: &reqwest::Client) -> Vec<Suggestion> {
    let url = format!("https://api.deezer.com/chart/0/tracks?limit={DEEZER_TRENDING}");
    let value: serde_json::Value = match client.get(&url).send().await {
        Ok(resp) => match resp.json().await {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    let Some(items) = value.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for t in items {
        let (Some(id), Some(title), Some(link)) = (
            t.get("id").and_then(|v| v.as_u64()),
            t.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()),
            t.get("link").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let artist = t.get("artist").and_then(|x| x.get("name")).and_then(|v| v.as_str()).unwrap_or("");
        let cover = t
            .get("album")
            .and_then(|al| al.get("cover_medium").or_else(|| al.get("cover_big")))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        out.push(Suggestion {
            id: format!("dz-track-{id}"),
            title: title.to_string(),
            blurb: if artist.is_empty() { "Song".to_string() } else { format!("{artist} · song") },
            cover,
            url: link.to_string(),
            section: "Trending now".to_string(),
            source: "deezer".to_string(),
            kind: "track".to_string(),
            track_count: Some(1),
            tracks: Vec::new(),
            items: Vec::new(),
        });
    }
    out
}

/// Everything the page shows: a trending-tracks row, Spotify's editorial
/// playlists, then top albums across every Deezer genre. The Deezer calls run
/// concurrently (one each, all keyless), so the whole build is a couple of
/// seconds of network rather than a serial crawl.
async fn build_suggestions() -> Vec<Suggestion> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("AttackFM/1.0")
        .build()
        .unwrap_or_default();

    let spotify = build_spotify();
    let trending = build_deezer_trending(&client);
    let genres = async {
        let calls = DEEZER_GENRES
            .iter()
            .map(|(id, name)| build_deezer_genre(&client, *id, name));
        let per_genre = futures_util::future::join_all(calls).await;
        per_genre.into_iter().flatten().collect::<Vec<_>>()
    };

    let (trending, spotify, genres) = futures_util::future::join3(trending, spotify, genres).await;
    // Trending leads, then the editorial playlists, then the genre album grids.
    let mut out = trending;
    out.extend(spotify);
    out.extend(genres);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hits the live Deezer API - run explicitly with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn deezer_genre_returns_importable_albums() {
        let client = reqwest::Client::new();
        let albums = build_deezer_genre(&client, 132, "Pop").await;
        assert!(albums.len() >= 5, "expected several albums, got {}", albums.len());
        for a in &albums {
            assert_eq!(a.source, "deezer");
            assert_eq!(a.kind, "album");
            assert!(a.url.contains("deezer.com/album/"), "bad url: {}", a.url);
            assert!(!a.title.is_empty());
        }
        eprintln!("Pop: {} albums, e.g. {} — {}", albums.len(), albums[0].title, albums[0].blurb);
    }

    #[tokio::test]
    #[ignore]
    async fn full_build_is_ten_x() {
        let all = build_suggestions().await;
        let deezer = all.iter().filter(|s| s.source == "deezer").count();
        let spotify = all.iter().filter(|s| s.source == "spotify").count();
        eprintln!("total {}: spotify {}, deezer {}", all.len(), spotify, deezer);
        assert!(all.len() >= 200, "expected 10x content, got {}", all.len());
    }
}

/// `GET /api/discover` - the suggested playlists, cached a day and refreshed
/// in the background so a caller never waits on the embed round-trips.
pub async fn feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let disco = &state.discover;
    let (cached, fresh) = {
        let cache = disco.cache.lock().await;
        match &*cache {
            Some((items, at)) => (items.clone(), at.elapsed() < TTL),
            None => (Vec::new(), false),
        }
    };

    if fresh {
        return Ok(Json(json!({ "suggestions": cached })));
    }

    // Stale or empty: kick a single background refresh, and serve whatever the
    // cache still holds. The very first call (empty cache) builds inline so the
    // client gets something on the first paint.
    use std::sync::atomic::Ordering;
    if cached.is_empty() {
        let built = build_suggestions().await;
        *disco.cache.lock().await = Some((built.clone(), Instant::now()));
        return Ok(Json(json!({ "suggestions": built })));
    }
    if !disco.refreshing.swap(true, Ordering::AcqRel) {
        let bg = Arc::clone(&state);
        tokio::spawn(async move {
            let built = build_suggestions().await;
            if !built.is_empty() {
                *bg.discover.cache.lock().await = Some((built, Instant::now()));
            }
            bg.discover.refreshing.store(false, Ordering::Release);
        });
    }
    Ok(Json(json!({ "suggestions": cached })))
}
