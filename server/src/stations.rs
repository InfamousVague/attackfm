//! Stations the DJ suggests: places to tune to, rather than lists to play.
//!
//! The home feed already builds MIXES - a fixed two dozen tracks, chosen once,
//! that play out and end. A station is the other thing: it never ends. The
//! DJ set at `/api/dj` already takes a free-text vibe and keeps going forever,
//! steered by it, but nothing ever suggested a vibe - so a listener had to
//! arrive knowing what to type, which is the same problem as a search box with
//! no shelves under it.
//!
//! So this hands back a handful of named stations, each really a SEED for that
//! endless set: a name, a line saying what it is, and the phrase the DJ steers
//! by. Tuning to one is `/api/dj?seed=<seed>` and nothing more.
//!
//! Two sources, in the same arrangement home.rs uses for mixes and for the
//! same reason:
//!
//!   heuristic  built from the play log alone - a listener's own eras, genres
//!              and heavy artists. Always available, no model required, and
//!              honest about being obvious.
//!   AI         when a model is wired up, it names and shapes stations from a
//!              taste summary. It writes the WORDS and the vibe phrase; it
//!              never picks tracks, because the DJ picks those and a model
//!              inventing a track is the failure mode worth designing out.
//!
//! The model is never waited on. A request gets whatever is cached, and a
//! stale cache regenerates behind it.

use crate::auth;
use crate::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// How long a set of stations stands before it is rebuilt behind the next
/// request. Longer than the daily mixes: a station is a place you go back to,
/// and one that is renamed every morning is not a place.
const TTL: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// The window the taste summary is drawn from.
const WINDOW_30D_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// How many to offer. Enough to feel like a dial, few enough to read.
const WANT: usize = 6;

#[derive(Clone, serde::Serialize)]
pub struct Station {
    pub id: String,
    pub name: String,
    pub blurb: String,
    /// What the DJ steers by - handed straight back as `/api/dj?seed=`.
    pub seed: String,
    /// "ai" | "heuristic", so the client can say where it came from.
    pub flavor: String,
}

struct Cached {
    stations: Vec<Station>,
    built_at: std::time::Instant,
    refreshing: bool,
}

#[derive(Default)]
pub struct StationState {
    per_user: tokio::sync::Mutex<HashMap<i64, Cached>>,
}

impl StationState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

fn ai_url() -> Option<String> {
    std::env::var("AFM_AI_URL").ok().filter(|s| !s.trim().is_empty())
}

fn ai_model() -> String {
    std::env::var("AFM_DJ_MODEL")
        .ok()
        .or_else(|| std::env::var("AFM_AI_MODEL").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "llama3.2".to_string())
}

/// `GET /api/dj/stations` - what the DJ suggests you tune to.
pub async fn stations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let user = caller.id;

    let (ready, needs_refresh) = {
        let mut cache = state.stations.per_user.lock().await;
        match cache.get_mut(&user) {
            Some(entry) => {
                let stale = entry.built_at.elapsed() > TTL;
                let start = stale && !entry.refreshing;
                if start {
                    entry.refreshing = true;
                }
                (entry.stations.clone(), start)
            }
            None => {
                // Nothing yet: seed the cache with the heuristics so the first
                // visit is answered immediately, and let the model improve on
                // them in the background.
                let built = heuristic_stations(&state, user);
                cache.insert(
                    user,
                    Cached {
                        stations: built.clone(),
                        built_at: std::time::Instant::now(),
                        refreshing: true,
                    },
                );
                (built, true)
            }
        }
    };

    if needs_refresh {
        if let Some(url) = ai_url() {
            let state2 = Arc::clone(&state);
            tokio::spawn(async move {
                let fresh = ai_stations(&state2, user, &url).await;
                let mut cache = state2.stations.per_user.lock().await;
                if let Some(entry) = cache.get_mut(&user) {
                    if let Some(list) = fresh {
                        if !list.is_empty() {
                            entry.stations = list;
                        }
                    }
                    entry.built_at = std::time::Instant::now();
                    entry.refreshing = false;
                }
            });
        } else {
            let mut cache = state.stations.per_user.lock().await;
            if let Some(entry) = cache.get_mut(&user) {
                entry.refreshing = false;
                entry.built_at = std::time::Instant::now();
            }
        }
    }

    Ok(Json(json!({ "stations": ready })))
}

/// Stations anybody's play log can answer for, with no model at all.
///
/// Deliberately plain. These are the obvious cuts through a listener's own
/// history - their decade, their genre, their heaviest artist, the songs they
/// have never played - and being obvious is the point: they are always right,
/// always available, and a model that fails leaves the listener with these
/// rather than an empty shelf.
fn heuristic_stations(state: &Arc<AppState>, user: i64) -> Vec<Station> {
    let since = now_ms() - WINDOW_30D_MS;
    let mut out: Vec<Station> = Vec::new();

    let top_artists = state.db.top_artists(user, since, 6);
    if let Some((artist, _)) = top_artists.first() {
        out.push(Station {
            id: "heavy-artist".into(),
            name: format!("{artist} and the road out"),
            blurb: format!("Starts where {artist} lives and keeps walking."),
            seed: format!("{artist} and artists who sound like them"),
            flavor: "heuristic".into(),
        });
    }
    if let Some((artist, _)) = top_artists.get(2) {
        out.push(Station {
            id: "second-lane".into(),
            name: format!("The {artist} side"),
            blurb: "Your other lane, given its own hour.".into(),
            seed: format!("in the style of {artist}"),
            flavor: "heuristic".into(),
        });
    }

    for (genre, _) in state.db.top_genres(user, since, 2) {
        if genre.trim().is_empty() {
            continue;
        }
        out.push(Station {
            id: format!("genre-{}", genre.to_lowercase().replace(' ', "-")),
            name: format!("Deep {genre}"),
            blurb: format!("{genre}, past the songs you already know."),
            seed: format!("{genre}, deeper cuts"),
            flavor: "heuristic".into(),
        });
    }

    out.push(Station {
        id: "late".into(),
        name: "After midnight".into(),
        blurb: "Slower, darker, and in no hurry.".into(),
        seed: "late night, slow, atmospheric, quiet".into(),
        flavor: "heuristic".into(),
    });
    out.push(Station {
        id: "unplayed".into(),
        name: "Never played".into(),
        blurb: "Records you own and have never once put on.".into(),
        seed: "songs I have never played".into(),
        flavor: "heuristic".into(),
    });

    out.truncate(WANT);
    out
}

/// Stations a model names from the listener's taste.
///
/// It writes words and a vibe phrase - never a track list. The DJ chooses the
/// music from the library it can see, so the worst a bad reply can do here is
/// name a station badly.
async fn ai_stations(state: &Arc<AppState>, user: i64, url: &str) -> Option<Vec<Station>> {
    let since = now_ms() - WINDOW_30D_MS;
    let top_artists = state.db.top_artists(user, since, 10);
    if top_artists.is_empty() {
        return None;
    }
    let genres = state.db.top_genres(user, since, 6);
    let recent: Vec<String> = state
        .db
        .recent_plays(user, 20)
        .into_iter()
        .filter_map(|id| state.db.track(id))
        .map(|t| format!("{} — {}", t.artist, t.title))
        .collect();

    let prompt = format!(
        "You are a radio DJ who knows one listener's collection well.\n\
         Their most-played artists this month: {}.\n\
         Genres they live in: {}.\n\
         Recently played: {}.\n\n\
         Suggest {WANT} RADIO STATIONS for them. A station is not a playlist: it never ends, so \
         describe a LANE the music can keep walking down, not a fixed set. Make them genuinely \
         different from each other - one built on an artist they love, one on a mood or a time of \
         day, one that pushes into what they nearly listen to but have not yet. Names short and \
         evocative (2-4 words), the kind a station would have. Blurbs one plain warm line, no \
         exclamation marks. Also give each a 'seed': a short phrase describing the SOUND to steer \
         by, as you would describe it to another DJ - instruments, texture, energy, era - not a \
         list of artist names.\n\
         Answer with STRICT JSON, nothing else: \
         [{{\"name\":\"...\",\"blurb\":\"...\",\"seed\":\"...\"}}]",
        top_artists
            .iter()
            .map(|(a, n)| format!("{a} ({n} plays)"))
            .collect::<Vec<_>>()
            .join(", "),
        genres
            .iter()
            .map(|(g, _)| g.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        recent.join("; "),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .ok()?;
    let reply = client
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": ai_model(),
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.9,
        }))
        .send()
        .await
        .ok()?;
    let body: Value = reply.json().await.ok()?;
    let content = body.pointer("/choices/0/message/content")?.as_str()?;

    // Models decorate JSON with prose and fences; carve the array out, bounds
    // checked - a truncated reply can put the last ']' before the first '[',
    // and an unguarded slice would panic inside this spawned task and leave
    // the refreshing latch stuck forever.
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    if end <= start {
        return None;
    }
    let parsed: Vec<Value> = serde_json::from_str(content.get(start..=end)?).ok()?;

    let mut out = Vec::new();
    for (i, s) in parsed.into_iter().take(WANT).enumerate() {
        let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let blurb = s.get("blurb").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let seed = s.get("seed").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        // A station with no name or nothing to steer by is not a station.
        if name.is_empty() || seed.is_empty() {
            continue;
        }
        out.push(Station {
            id: format!("ai-{i}"),
            name: name.chars().take(48).collect(),
            blurb: blurb.chars().take(120).collect(),
            seed: seed.chars().take(160).collect(),
            flavor: "ai".into(),
        });
    }
    (!out.is_empty()).then_some(out)
}
