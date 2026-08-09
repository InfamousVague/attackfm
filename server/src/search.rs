//! External catalogue search for Discover: find new artists and songs across
//! public music sources and hand back links the import pipeline can download.
//!
//! Spotify leads - searched through the same auth-less access token the web
//! player mints, so no API key is needed - because its links flow straight
//! through the proven `POST /api/imports` path. Deezer, already the importer's
//! lead download service, fills the list out and stands in whole when Spotify's
//! anonymous token is unavailable (they tighten it from time to time). Results
//! are deduped by kind+title+artist and capped, so the client gets one clean,
//! importable list with tracks ahead of artists.

use crate::auth;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

/// One external result: a track to import, or an artist to search deeper.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Stable id for React keys: the source and its native id.
    pub id: String,
    /// "track" or "artist".
    pub kind: String,
    /// Track title, or the artist's name.
    pub title: String,
    /// The artist under a track; "Artist" under an artist row.
    pub subtitle: String,
    pub cover: Option<String>,
    /// The link handed to `POST /api/imports`. Present for tracks; artist rows
    /// carry their name to search again rather than a thing to download.
    pub url: String,
    /// "spotify" or "deezer".
    pub source: String,
}

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent(UA)
        .build()
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// --- Spotify anonymous token -------------------------------------------------

/// (token, expiry_ms). The web player's token is short-lived; cached until just
/// before it lapses so a burst of keystrokes shares one fetch.
fn token_cache() -> &'static Mutex<Option<(String, u64)>> {
    static CACHE: OnceLock<Mutex<Option<(String, u64)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

async fn spotify_token() -> Option<String> {
    {
        let guard = token_cache().lock().await;
        if let Some((tok, exp)) = &*guard {
            if now_ms() + 30_000 < *exp {
                return Some(tok.clone());
            }
        }
    }
    let v: Value = client()
        .get("https://open.spotify.com/get_access_token?reason=transport&productType=web_player")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let tok = v.get("accessToken").and_then(|x| x.as_str())?.to_string();
    if tok.is_empty() {
        return None;
    }
    let exp = v
        .get("accessTokenExpirationTimestampMs")
        .and_then(|x| x.as_u64())
        .unwrap_or_else(|| now_ms() + 3_000_000);
    *token_cache().lock().await = Some((tok.clone(), exp));
    Some(tok)
}

// --- Sources -----------------------------------------------------------------

async fn spotify_search(q: &str) -> Vec<SearchResult> {
    let Some(token) = spotify_token().await else {
        return Vec::new();
    };
    let resp = client()
        .get("https://api.spotify.com/v1/search")
        .bearer_auth(&token)
        .query(&[("type", "track,artist"), ("limit", "8"), ("q", q)])
        .send()
        .await;
    let Ok(resp) = resp else { return Vec::new() };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(v) = resp.json::<Value>().await else {
        return Vec::new();
    };

    let mut out = Vec::new();
    if let Some(items) = v.pointer("/tracks/items").and_then(|x| x.as_array()) {
        for it in items {
            let title = it.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_string();
            let artist =
                it.pointer("/artists/0/name").and_then(|x| x.as_str()).unwrap_or_default().to_string();
            let url = it
                .pointer("/external_urls/spotify")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string();
            let id = it.get("id").and_then(|x| x.as_str()).unwrap_or_default();
            if title.is_empty() || url.is_empty() {
                continue;
            }
            out.push(SearchResult {
                id: format!("spotify:track:{id}"),
                kind: "track".into(),
                title,
                subtitle: artist,
                cover: it.pointer("/album/images/0/url").and_then(|x| x.as_str()).map(String::from),
                url,
                source: "spotify".into(),
            });
        }
    }
    if let Some(items) = v.pointer("/artists/items").and_then(|x| x.as_array()) {
        for it in items {
            let name = it.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_string();
            if name.is_empty() {
                continue;
            }
            let id = it.get("id").and_then(|x| x.as_str()).unwrap_or_default();
            out.push(SearchResult {
                id: format!("spotify:artist:{id}"),
                kind: "artist".into(),
                title: name,
                subtitle: "Artist".into(),
                cover: it.pointer("/images/0/url").and_then(|x| x.as_str()).map(String::from),
                url: it
                    .pointer("/external_urls/spotify")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                source: "spotify".into(),
            });
        }
    }
    out
}

async fn deezer_search(q: &str) -> Vec<SearchResult> {
    let mut out = Vec::new();

    if let Ok(resp) = client()
        .get("https://api.deezer.com/search")
        .query(&[("q", q), ("limit", "10")])
        .send()
        .await
    {
        if let Ok(v) = resp.json::<Value>().await {
            if let Some(items) = v.get("data").and_then(|x| x.as_array()) {
                for it in items {
                    let title = it.get("title").and_then(|x| x.as_str()).unwrap_or_default().to_string();
                    let url = it.get("link").and_then(|x| x.as_str()).unwrap_or_default().to_string();
                    let id = it.get("id").and_then(|x| x.as_u64()).unwrap_or_default();
                    if title.is_empty() || url.is_empty() {
                        continue;
                    }
                    out.push(SearchResult {
                        id: format!("deezer:track:{id}"),
                        kind: "track".into(),
                        title,
                        subtitle: it
                            .pointer("/artist/name")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        cover: it
                            .pointer("/album/cover_medium")
                            .and_then(|x| x.as_str())
                            .map(String::from)
                            .or_else(|| {
                                it.pointer("/artist/picture_medium")
                                    .and_then(|x| x.as_str())
                                    .map(String::from)
                            }),
                        url,
                        source: "deezer".into(),
                    });
                }
            }
        }
    }

    if let Ok(resp) = client()
        .get("https://api.deezer.com/search/artist")
        .query(&[("q", q), ("limit", "6")])
        .send()
        .await
    {
        if let Ok(v) = resp.json::<Value>().await {
            if let Some(items) = v.get("data").and_then(|x| x.as_array()) {
                for it in items {
                    let name = it.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let id = it.get("id").and_then(|x| x.as_u64()).unwrap_or_default();
                    out.push(SearchResult {
                        id: format!("deezer:artist:{id}"),
                        kind: "artist".into(),
                        title: name,
                        subtitle: "Artist".into(),
                        cover: it.get("picture_medium").and_then(|x| x.as_str()).map(String::from),
                        url: it.get("link").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                        source: "deezer".into(),
                    });
                }
            }
        }
    }
    out
}

// --- Handler -----------------------------------------------------------------

/// `GET /api/search?q=` - external catalogue search across Spotify and Deezer.
pub async fn search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let q = params.q.trim().to_string();
    if q.is_empty() {
        return Ok(Json(json!({ "results": [] })));
    }

    // Both sources at once; Spotify leads the merged order.
    let (spotify, deezer) = tokio::join!(spotify_search(&q), deezer_search(&q));

    let mut results: Vec<SearchResult> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for r in spotify.into_iter().chain(deezer.into_iter()) {
        let key = format!("{}|{}|{}", r.kind, r.title.to_lowercase(), r.subtitle.to_lowercase());
        if seen.insert(key) {
            results.push(r);
        }
    }
    // Tracks (importable in a tap) ahead of artists; the sort is stable, so the
    // Spotify-then-Deezer order within each kind is kept.
    results.sort_by_key(|r| u8::from(r.kind != "track"));
    results.truncate(30);

    Ok(Json(json!({ "results": results })))
}

// --- Artist detail -----------------------------------------------------------
//
// One artist, opened from a search row: who they are, how big they are, and
// everything they have put out, split into albums and singles.
//
// Deezer answers all of it without a key - profile, fan count, the full
// discography with a record_type on each release, the top tracks and the
// related artists - so it is the source here even when the row that was tapped
// came from Spotify. A Spotify row carries no Deezer id, so it is resolved by
// name first; an artist Deezer does not know simply comes back empty rather
// than half-built from two catalogues that disagree.

#[derive(Deserialize)]
pub struct ArtistQuery {
    /// `deezer:artist:27` or `spotify:artist:xyz`, as the search rows carry.
    pub id: String,
    /// The name to resolve by when the id is not Deezer's.
    #[serde(default)]
    pub name: String,
}

/// One release: an album, an EP, a single or a compilation.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRelease {
    pub id: String,
    pub title: String,
    pub cover: Option<String>,
    /// Release year as four digits, when the source states one.
    pub year: Option<String>,
    pub track_count: Option<u64>,
    /// "album", "single", "ep" or "compilation", straight from the source.
    pub kind: String,
    /// The link `POST /api/imports` takes - the importer reads `/album/` and
    /// pulls the whole record.
    pub url: String,
}

/// One of the artist's best-known tracks, importable on its own.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTrack {
    pub id: String,
    pub title: String,
    pub cover: Option<String>,
    pub url: String,
    /// Seconds.
    pub duration: Option<u64>,
}

/// A neighbour on the same shelf, for reading onward.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelatedArtist {
    pub id: String,
    pub name: String,
    pub picture: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistDetail {
    pub id: String,
    pub name: String,
    pub picture: Option<String>,
    pub url: String,
    pub source: String,
    /// Deezer's follower count - the one honest "how big are they" number that
    /// comes free with the profile.
    pub fans: Option<u64>,
    pub album_count: Option<u64>,
    pub albums: Vec<CatalogRelease>,
    pub singles: Vec<CatalogRelease>,
    pub top: Vec<CatalogTrack>,
    pub related: Vec<RelatedArtist>,
}

/// The Deezer artist id behind a search row: taken straight from a Deezer id,
/// or looked up by name for anything else.
async fn resolve_deezer_artist(id: &str, name: &str) -> Option<u64> {
    if let Some(rest) = id.strip_prefix("deezer:artist:") {
        if let Ok(n) = rest.parse::<u64>() {
            return Some(n);
        }
    }
    let q = name.trim();
    if q.is_empty() {
        return None;
    }
    let resp = client()
        .get("https://api.deezer.com/search/artist")
        .query(&[("q", q), ("limit", "5")])
        .send()
        .await
        .ok()?;
    let v = resp.json::<Value>().await.ok()?;
    let items = v.get("data")?.as_array()?;
    // An exact name match beats the top hit: searching "Muse" should not land
    // on a tribute band that happens to rank higher.
    let lower = q.to_lowercase();
    items
        .iter()
        .find(|it| {
            it.get("name")
                .and_then(|x| x.as_str())
                .map(|n| n.to_lowercase() == lower)
                .unwrap_or(false)
        })
        .or_else(|| items.first())
        .and_then(|it| it.get("id").and_then(|x| x.as_u64()))
}

fn release_from(it: &Value) -> Option<CatalogRelease> {
    let title = it.get("title").and_then(|x| x.as_str())?.to_string();
    let url = it.get("link").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    if title.is_empty() || url.is_empty() {
        return None;
    }
    let id = it.get("id").and_then(|x| x.as_u64()).unwrap_or_default();
    Some(CatalogRelease {
        id: format!("deezer:album:{id}"),
        title,
        cover: it
            .get("cover_medium")
            .and_then(|x| x.as_str())
            .or_else(|| it.get("cover").and_then(|x| x.as_str()))
            .map(String::from),
        year: it
            .get("release_date")
            .and_then(|x| x.as_str())
            .filter(|d| d.len() >= 4)
            .map(|d| d[..4].to_string()),
        track_count: it.get("nb_tracks").and_then(|x| x.as_u64()),
        kind: it
            .get("record_type")
            .and_then(|x| x.as_str())
            .unwrap_or("album")
            .to_string(),
        url,
    })
}

/// `GET /api/artist?id=&name=` - one artist's profile and discography.
pub async fn artist(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<ArtistQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let Some(dz) = resolve_deezer_artist(&params.id, &params.name).await else {
        return Err((StatusCode::NOT_FOUND, "artist not found".into()));
    };

    let c = client();
    let (profile, albums, top, related) = tokio::join!(
        c.get(format!("https://api.deezer.com/artist/{dz}")).send(),
        c.get(format!("https://api.deezer.com/artist/{dz}/albums"))
            .query(&[("limit", "100")])
            .send(),
        c.get(format!("https://api.deezer.com/artist/{dz}/top"))
            .query(&[("limit", "8")])
            .send(),
        c.get(format!("https://api.deezer.com/artist/{dz}/related"))
            .query(&[("limit", "8")])
            .send(),
    );

    let profile: Value = match profile {
        Ok(r) => r.json().await.unwrap_or_else(|_| json!({})),
        Err(_) => return Err((StatusCode::BAD_GATEWAY, "catalogue unreachable".into())),
    };
    let name = profile
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or(params.name.as_str())
        .to_string();

    // Releases, newest first, one entry per title: a discography listing the
    // same record three times over (remaster, deluxe, territory reissue) reads
    // as noise rather than a body of work.
    let mut all: Vec<CatalogRelease> = Vec::new();
    if let Ok(r) = albums {
        if let Ok(v) = r.json::<Value>().await {
            if let Some(items) = v.get("data").and_then(|x| x.as_array()) {
                let mut seen: HashSet<String> = HashSet::new();
                for it in items {
                    if let Some(rel) = release_from(it) {
                        if seen.insert(rel.title.to_lowercase()) {
                            all.push(rel);
                        }
                    }
                }
            }
        }
    }
    all.sort_by(|a, b| b.year.cmp(&a.year));
    let (singles, albums): (Vec<_>, Vec<_>) = all
        .into_iter()
        .partition(|r| r.kind == "single" || r.kind == "ep");

    let mut top_tracks: Vec<CatalogTrack> = Vec::new();
    if let Ok(r) = top {
        if let Ok(v) = r.json::<Value>().await {
            if let Some(items) = v.get("data").and_then(|x| x.as_array()) {
                for it in items {
                    let title = it.get("title").and_then(|x| x.as_str()).unwrap_or_default();
                    let url = it.get("link").and_then(|x| x.as_str()).unwrap_or_default();
                    if title.is_empty() || url.is_empty() {
                        continue;
                    }
                    let id = it.get("id").and_then(|x| x.as_u64()).unwrap_or_default();
                    top_tracks.push(CatalogTrack {
                        id: format!("deezer:track:{id}"),
                        title: title.to_string(),
                        cover: it.pointer("/album/cover_medium").and_then(|x| x.as_str()).map(String::from),
                        url: url.to_string(),
                        duration: it.get("duration").and_then(|x| x.as_u64()),
                    });
                }
            }
        }
    }

    let mut neighbours: Vec<RelatedArtist> = Vec::new();
    if let Ok(r) = related {
        if let Ok(v) = r.json::<Value>().await {
            if let Some(items) = v.get("data").and_then(|x| x.as_array()) {
                for it in items {
                    let n = it.get("name").and_then(|x| x.as_str()).unwrap_or_default();
                    if n.is_empty() {
                        continue;
                    }
                    let id = it.get("id").and_then(|x| x.as_u64()).unwrap_or_default();
                    neighbours.push(RelatedArtist {
                        id: format!("deezer:artist:{id}"),
                        name: n.to_string(),
                        picture: it.get("picture_medium").and_then(|x| x.as_str()).map(String::from),
                    });
                }
            }
        }
    }

    let detail = ArtistDetail {
        id: format!("deezer:artist:{dz}"),
        name,
        picture: profile
            .get("picture_big")
            .and_then(|x| x.as_str())
            .or_else(|| profile.get("picture_medium").and_then(|x| x.as_str()))
            .map(String::from),
        url: profile.get("link").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        source: "deezer".into(),
        fans: profile.get("nb_fan").and_then(|x| x.as_u64()),
        album_count: profile.get("nb_album").and_then(|x| x.as_u64()),
        albums,
        singles,
        top: top_tracks,
        related: neighbours,
    };

    Ok(Json(json!({ "artist": detail })))
}
