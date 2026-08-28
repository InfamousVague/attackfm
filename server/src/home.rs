//! The home feed: what greets a listener, composed from their own history.
//!
//! Three kinds of shelf come out of `GET /api/home`, all as track ids the
//! client resolves against the library it already synced (no track payloads
//! ride this route):
//!
//! - the plain shelves - recently played, heavy rotation, recently added -
//!   straight SQL over the plays log;
//! - heuristic mixes, built here from the same log: always available, no
//!   model required;
//! - AI mixes, when the operator points `AFM_AI_URL` at any local
//!   OpenAI-compatible chat endpoint (Ollama, LM Studio, llama.cpp server).
//!   The model gets a compact taste summary and a candidate list and returns
//!   titled, blurbed track selections - constrained to the candidates it was
//!   shown, so it can name and shape a mix but never invent a track.
//!
//! AI mixes regenerate in the background on a long TTL; the feed never waits
//! on a model. No model, no key, no cloud: the endpoint is whatever the user
//! runs on their own hardware.

use crate::auth;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SHELF: i64 = 24;
const WINDOW_30D_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// How long AI mixes stay before a background regeneration - fresh enough to
/// follow the listener's week, stable enough that home does not reshuffle
/// every visit.
const AI_TTL: Duration = Duration::from_secs(24 * 60 * 60); // daily mixes: refresh once a day

type ApiError = (StatusCode, String);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// --- mix cache ---------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
pub struct Mix {
    pub id: String,
    pub title: String,
    pub blurb: String,
    #[serde(rename = "trackIds")]
    pub track_ids: Vec<i64>,
    /// "ai" | "heuristic" - the client may badge them differently.
    pub flavor: String,
}

struct CachedMixes {
    mixes: Vec<Mix>,
    built_at: std::time::Instant,
    refreshing: bool,
}

#[derive(Default)]
pub struct HomeState {
    per_user: tokio::sync::Mutex<HashMap<i64, CachedMixes>>,
}

impl HomeState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

fn ai_url() -> Option<String> {
    std::env::var("AFM_AI_URL").ok().filter(|s| !s.trim().is_empty())
}

fn ai_model() -> String {
    std::env::var("AFM_AI_MODEL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "llama3.2".to_string())
}

// --- plays -------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PlayBody {
    #[serde(rename = "trackId")]
    pub track_id: i64,
}

/// `POST /api/plays` - one qualifying play. The client decides what
/// qualifies (past thirty seconds or half the track); this just writes it.
pub async fn record_play(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PlayBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state
        .db
        .record_play(caller.id, body.track_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// `GET /api/artist-top?name=` - one artist's most-played songs, all-time:
/// `{ top: [{ id, plays }] }`, most-played first. Ids only, like the home
/// feed: the client resolves them against its synced library.
#[derive(Deserialize)]
pub struct ArtistTopQuery {
    pub name: String,
}

pub async fn artist_top(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ArtistTopQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let top: Vec<serde_json::Value> = state
        .db
        .top_plays_for_artist(caller.id, &query.name, 10)
        .into_iter()
        .map(|(id, plays)| json!({ "id": id, "plays": plays }))
        .collect();
    Ok(Json(json!({ "top": top })))
}

// --- the feed ----------------------------------------------------------------

/// `GET /api/home` - the shelves. Track ids only; the client resolves them
/// against its synced library and silently drops any it does not know yet.
pub async fn feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let user = caller.id;

    let recent = state.db.recent_plays(user, SHELF);
    let since = now_ms() - WINDOW_30D_MS;
    // The counts come back with the ids and used to be thrown away; the On
    // repeat page shows them instead of a row number, which is the one number
    // that page is actually about.
    let heavy_pairs = state.db.top_plays(user, since, SHELF);
    let heavy: Vec<i64> = heavy_pairs.iter().map(|(id, _)| *id).collect();
    let heavy_plays: Vec<serde_json::Value> = heavy_pairs
        .iter()
        .map(|(id, plays)| serde_json::json!({ "id": id, "plays": plays }))
        .collect();
    let fresh = state.db.recently_added(SHELF);
    // Jump back in: the albums behind recent plays, each a full ordered
    // track list the client plays as given (no client-side album matching,
    // so same-named albums never merge and discs stay in order).
    let jump_back_in = state.db.recent_album_track_lists(user, 12);
    // The names of the user's top artists this month; the client resolves a
    // cover from its own library and links each into that artist's page.
    let top_artists: Vec<String> =
        state.db.top_artists(user, since, 12).into_iter().map(|(name, _)| name).collect();

    let mixes = mixes_for(&state, user).await;

    Ok(Json(json!({
        "recent": recent,
        "heavy": heavy,
        "heavyPlays": heavy_plays,
        "fresh": fresh,
        "jumpBackIn": jump_back_in,
        "topArtists": top_artists,
        "mixes": mixes,
        // Whether a model is wired up, so the client can say which kind of
        // curation the listener is looking at.
        "ai": ai_url().is_some(),
    })))
}

/// The current mixes: cached AI ones while fresh, heuristics otherwise - and
/// a background regeneration kicked whenever the cache has gone stale. The
/// heuristic battery is only computed on the branches that actually return it,
/// so a warm AI cache does not pay for a fallback it never uses.
/// Build this listener's mixes NOW, ignoring the cache and its day-long clock.
///
/// `mixes_for` deliberately serves a cache and only rebuilds in the background
/// when it has gone stale, which is right for a page load and useless as an
/// action: pressing "make me a new mix" and being handed yesterday's is not an
/// answer. This awaits the build instead of spawning it, so the caller knows
/// when it is done and what it produced.
///
/// Returns how many mixes came out. Zero means the model declined or there was
/// not enough listening to work from - the caller says so rather than implying
/// something new is waiting.
pub async fn rebuild_mixes(state: &Arc<AppState>, user: i64) -> usize {
    let Some(url) = ai_url() else { return 0 };
    // Drop the entry outright rather than marking it stale: a rebuild that
    // fails should leave the next page load to try again, not serve an empty
    // list it thinks is fresh.
    state.home.per_user.lock().await.remove(&user);
    let built = ai_mixes(state, user, &url).await.unwrap_or_default();
    let n = built.len();
    if n > 0 {
        state.home.per_user.lock().await.insert(
            user,
            CachedMixes { mixes: built, built_at: std::time::Instant::now(), refreshing: false },
        );
    }
    n
}

async fn mixes_for(state: &Arc<AppState>, user: i64) -> Vec<Mix> {
    let Some(url) = ai_url() else { return heuristic_mixes(state, user) };

    let mut cache = state.home.per_user.lock().await;
    let entry = cache.get(&user);
    let fresh = entry.map(|e| e.built_at.elapsed() < AI_TTL && !e.mixes.is_empty()).unwrap_or(false);
    if fresh {
        return entry.map(|e| e.mixes.clone()).unwrap_or_default();
    }
    let already_refreshing = entry.map(|e| e.refreshing).unwrap_or(false);
    if !already_refreshing {
        cache
            .entry(user)
            .and_modify(|e| e.refreshing = true)
            .or_insert(CachedMixes { mixes: Vec::new(), built_at: std::time::Instant::now(), refreshing: true });
        let bg_state = Arc::clone(state);
        tokio::spawn(async move {
            let built = ai_mixes(&bg_state, user, &url).await;
            let mut cache = bg_state.home.per_user.lock().await;
            match built {
                Some(mixes) if !mixes.is_empty() => {
                    cache.insert(user, CachedMixes { mixes, built_at: std::time::Instant::now(), refreshing: false });
                }
                _ => {
                    // The model was unreachable or answered nonsense; drop the
                    // refreshing latch so a later visit tries again, and keep
                    // whatever the cache held.
                    if let Some(e) = cache.get_mut(&user) {
                        e.refreshing = false;
                    }
                }
            }
        });
    }
    // Whatever the cache still holds beats a blank; heuristics beat nothing.
    let held = cache.get(&user).map(|e| e.mixes.clone()).unwrap_or_default();
    drop(cache);
    if held.is_empty() { heuristic_mixes(state, user) } else { held }
}

// --- heuristic mixes ---------------------------------------------------------

/// Mixes with no model in the loop: real listening math, plainly named.
fn heuristic_mixes(state: &Arc<AppState>, user: i64) -> Vec<Mix> {
    let since = now_ms() - WINDOW_30D_MS;
    let mut out = Vec::new();

    // On repeat: the month's most-played, order shuffled by a stable rotation
    // (day number) so the shelf breathes without a rebuild every visit.
    let top = state.db.top_plays(user, since, 40);
    if top.len() >= 4 {
        let mut ids: Vec<i64> = top.iter().map(|(id, _)| *id).collect();
        let day = (now_ms() / 86_400_000) as usize;
        let len = ids.len().max(1);
        ids.rotate_left(day % len);
        out.push(Mix {
            id: "on-repeat".into(),
            title: "On repeat".into(),
            blurb: "What you keep coming back to this month.".into(),
            track_ids: ids.into_iter().take(SHELF as usize).collect(),
            flavor: "heuristic".into(),
        });
    }

    // Artist spotlight: the top artist's catalogue beyond what is already on
    // repeat - deep cuts included, album order. The runner-up seeds a
    // "Because you played" mix below, so the two never name the same artist.
    let artists = state.db.top_artists(user, since, 3);
    if let Some((artist, _)) = artists.first() {
        let ids = state.db.tracks_by_artist(artist, SHELF);
        if ids.len() >= 4 {
            out.push(Mix {
                id: "artist-spotlight".into(),
                title: format!("{artist} and you"),
                blurb: format!("A walk through {artist}, deep cuts included."),
                track_ids: ids,
                flavor: "heuristic".into(),
            });
        }
    }

    // Because you played: the runner-up artist, framed as a follow-on rather
    // than a spotlight - the shelf's small nod to what else you have been into.
    if let Some((artist, _)) = artists.get(1) {
        let ids = state.db.tracks_by_artist(artist, SHELF);
        if ids.len() >= 4 {
            out.push(Mix {
                id: "because-artist".into(),
                title: format!("Because you played {artist}"),
                blurb: format!("More {artist} to sink into."),
                track_ids: ids,
                flavor: "heuristic".into(),
            });
        }
    }

    // Genre blend: the month's most-played genre, newest first - a wider net
    // than any one artist.
    if let Some((genre, _)) = state.db.top_genres(user, since, 1).into_iter().next() {
        let ids = state.db.tracks_by_genre(&genre, SHELF);
        if ids.len() >= 4 {
            // Genre tags are often comma-joined; name the mix after the first.
            let name = genre.split(',').next().unwrap_or(&genre).trim().to_string();
            out.push(Mix {
                id: "genre-blend".into(),
                title: format!("{name} mix"),
                blurb: format!("Your {name}, all in one place."),
                track_ids: ids,
                flavor: "heuristic".into(),
            });
        }
    }

    // Fresh finds: what arrived that has never been played.
    let unplayed = state.db.unplayed(user, SHELF);
    if unplayed.len() >= 4 {
        out.push(Mix {
            id: "fresh-finds".into(),
            title: "Fresh finds".into(),
            blurb: "In your library, never yet played.".into(),
            track_ids: unplayed,
            flavor: "heuristic".into(),
        });
    }

    out
}

// --- AI mixes ----------------------------------------------------------------

/// Asks the local model for named, themed selections over a candidate list.
/// Every returned id is validated against the candidates: the model curates,
/// it never invents.
async fn ai_mixes(state: &Arc<AppState>, user: i64, url: &str) -> Option<Vec<Mix>> {
    let since = now_ms() - WINDOW_30D_MS;
    let top_artists = state.db.top_artists(user, since, 8);
    let recent = state.db.recent_plays(user, 30);
    if recent.is_empty() {
        // Nothing to reason from yet; the heuristics say so more honestly.
        return None;
    }

    // Candidates: heavy rotation + the top artists' catalogues + unplayed
    // discoveries, deduped, described compactly.
    let mut candidate_ids: Vec<i64> = Vec::new();
    candidate_ids.extend(state.db.top_plays(user, since, 60).into_iter().map(|(id, _)| id));
    for (artist, _) in &top_artists {
        candidate_ids.extend(state.db.tracks_by_artist(artist, 24));
    }
    candidate_ids.extend(state.db.unplayed(user, 60));
    candidate_ids.dedup();
    let mut seen = std::collections::HashSet::new();
    candidate_ids.retain(|id| seen.insert(*id));
    candidate_ids.truncate(240);

    let mut lines = Vec::new();
    for id in &candidate_ids {
        if let Some(t) = state.db.track(*id) {
            lines.push(format!("{}|{} — {}", t.id, t.artist, t.title));
        }
    }
    let recent_titles: Vec<String> = recent
        .iter()
        .take(15)
        .filter_map(|id| state.db.track(*id))
        .map(|t| format!("{} — {}", t.artist, t.title))
        .collect();
    let taste: Vec<String> = top_artists.iter().map(|(a, n)| format!("{a} ({n} plays)")).collect();

    let prompt = format!(
        "You curate playlists for one listener from THEIR OWN library.\n\
         Their most-played artists this month: {}.\n\
         Recently played: {}.\n\
         Candidate tracks, one per line as id|artist — title:\n{}\n\n\
         Build 6 DAILY MIXES from ONLY these candidate ids, the way a music app's Daily Mixes work: each mix is a COHERENT lane of this listener's OWN taste - a cluster of artists and a sound they actually play together (one lane per genre/scene/mood they keep returning to), NOT a grab-bag, and each lane clearly distinct from the others. Order each lane so it flows. Titles evocative but short (2-4 words); one-line blurbs naming the through-line, warm and plain, no exclamation marks.\n\
         Answer with STRICT JSON, nothing else: [{{\"title\":\"...\",\"blurb\":\"...\",\"ids\":[1,2,3]}}] with 10-20 ids each.",
        taste.join(", "),
        recent_titles.join("; "),
        lines.join("\n"),
    );

    let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).build().ok()?;
    let reply = client
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": ai_model(),
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.8,
        }))
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = reply.json().await.ok()?;
    let content = body.pointer("/choices/0/message/content")?.as_str()?;

    // Models decorate JSON with prose and fences; carve out the array. Ordered
    // and bounds-checked: a truncated reply can put the last ']' before the
    // first '[', and an unguarded slice would panic - which, inside the spawned
    // task, would leave the refreshing latch stuck and freeze regeneration.
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    if end <= start {
        return None;
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(content.get(start..=end)?).ok()?;

    let valid: std::collections::HashSet<i64> = candidate_ids.iter().copied().collect();
    let mut mixes = Vec::new();
    for (i, m) in parsed.into_iter().take(8).enumerate() {
        let title = m.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let blurb = m.get("blurb").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let mut seen_ids = std::collections::HashSet::new();
        let ids: Vec<i64> = m
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_i64())
                    // Valid AND not already in this mix: a model that repeats an
                    // id would otherwise give the client two rows keyed the same.
                    .filter(|id| valid.contains(id) && seen_ids.insert(*id))
                    .collect()
            })
            .unwrap_or_default();
        if title.is_empty() || ids.len() < 4 {
            continue;
        }
        mixes.push(Mix {
            id: format!("ai-{i}"),
            title,
            blurb,
            track_ids: ids,
            flavor: "ai".into(),
        });
    }
    (!mixes.is_empty()).then_some(mixes)
}
