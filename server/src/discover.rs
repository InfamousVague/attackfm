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
    #[serde(rename = "trackCount")]
    pub track_count: Option<u32>,
    /// The playlist's track titles, in order, as the public embed lists them -
    /// what the client's preview shows before the user commits to an import.
    pub tracks: Vec<String>,
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

/// Fetches every catalogue entry's metadata from its public embed. Entries
/// that do not resolve (a retired playlist, a hiccup) are simply left out.
async fn build_suggestions() -> Vec<Suggestion> {
    let mut out = Vec::new();
    for (id, section) in CATALOG {
        let url = format!("https://open.spotify.com/playlist/{id}");
        if let Some((title, cover, total, titles)) = fetch_embed_meta(&url, "playlist").await {
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
                track_count: total,
                tracks: titles,
            });
        }
    }
    out
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
