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
use crate::db::{Db, TrackFeatures};
use crate::recommendation;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SHELF: i64 = 24;
const WINDOW_30D_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// How long AI mixes stay before a background regeneration - fresh enough to
/// follow the listener's week, stable enough that home does not reshuffle
/// every visit.
const AI_TTL: Duration = Duration::from_secs(24 * 60 * 60); // daily mixes: refresh once a day
const HOME_RELEVANCE_FLOOR: f32 = 0.52;
const HOME_EXPLORATION_FLOOR: f32 = 0.40;
const HOME_EXPLORATION_CANDIDATES: usize = 10;
const HOME_EXPLORATION_PER_MIX: usize = 2;
const HOME_ARTIST_CAP: usize = 3;
const HOME_MIX_MIN: usize = 4;
const HOME_MIX_MAX: usize = 20;

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

/*
 * Through `ai::setting`, NOT a raw env read.
 *
 * `setting` resolves the owner's choice in Settings first and the environment
 * only after. Reading the variable directly means this feature silently ignores
 * the pane that exists to configure it: the model row is changed, the pickers
 * confirm it, and this one carries on asking for whatever the unit file said -
 * with no error anywhere, because a model name is only ever wrong later.
 */

/// Both halves, or nothing.
///
/// A model name is only ever wrong LATER - the request goes out, the endpoint
/// refuses a model it does not have, and the feature reports as an AI that is
/// not working. So "can this run" means a URL AND a model, the same rule
/// `AiClient::new` applies, and the caller falls back to its heuristic exactly
/// as it does when nothing is configured at all.
fn ai_url() -> Option<String> {
    let url = crate::ai::setting("url", "AFM_AI_URL")?;
    if ai_model().trim().is_empty() {
        return None;
    }
    Some(url)
}

fn ai_model() -> String {
    // No literal fallback: a name nobody pulled is a timeout every cycle, and
    // "llama3.2" was a guess about a box this code has never seen.
    crate::ai::setting("chatModel", "AFM_AI_MODEL").unwrap_or_default()
}

#[derive(Clone, Debug)]
pub(crate) struct HomeCandidate {
    pub(crate) id: i64,
    pub(crate) artist: String,
    pub(crate) title: String,
    pub(crate) lane: &'static str,
    pub(crate) class: recommendation::FamiliarityClass,
    pub(crate) relevance: f32,
    pub(crate) reason: String,
    pub(crate) evidence: String,
}

fn add_candidate(
    out: &mut Vec<HomeCandidate>,
    seen: &mut HashSet<i64>,
    db: &Db,
    features: &HashMap<i64, &TrackFeatures>,
    id: i64,
    lane: &'static str,
    class: recommendation::FamiliarityClass,
    relevance: f32,
    reason: String,
) {
    if !seen.insert(id) {
        return;
    }
    let Some(track) = db.track(id) else { return };
    let Some(feature) = features.get(&id) else { return };
    if feature.quarantined {
        return;
    }
    let evidence = feature
        .ai_specific_tags
        .iter()
        .chain(&feature.ai_genres)
        .chain(&feature.ai_sonic_traits)
        .take(6)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    out.push(HomeCandidate {
        id,
        artist: track.artist,
        title: track.title,
        lane,
        class,
        relevance,
        reason,
        evidence,
    });
}

/// Prequalify Home candidates before an LLM sees them. Inventory chronology is
/// deliberately absent: every row needs personal evidence or a bounded,
/// labeled exploration reason.
pub(crate) fn home_candidates(db: &Db, user: i64, now: i64) -> Vec<HomeCandidate> {
    let Some(taste) = recommendation::for_db(db, user, now) else { return Vec::new() };
    let all = db.all_features();
    let features: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    let recent_taste = (!taste.recent_weights.is_empty())
        .then(|| recommendation::from_weighted(&taste.recent_weights, &features));
    let learned_adjustment = |class: recommendation::FamiliarityClass| {
        let (adopted, exposed) = db.recommendation_class_stats(
            user,
            class.as_str(),
            now - 24 * 60 * 60 * 1000,
        );
        recommendation::exploration_adjustment(adopted, exposed)
    };
    let classify = |feature: &TrackFeatures, context: &recommendation::TasteContext| {
        let base = recommendation::classify(feature, context, 0.0)?;
        recommendation::classify(feature, context, learned_adjustment(base))
    };
    let recently_explored = [
        recommendation::FamiliarityClass::Exploratory,
        recommendation::FamiliarityClass::Wildcard,
    ]
    .into_iter()
    .flat_map(|class| {
        db.recently_exposed_artists(user, class.as_str(), now - 7 * 24 * 60 * 60 * 1000)
    })
    .collect::<HashSet<_>>();
    let mut ranked: Vec<(f32, i64)> = all
        .iter()
        .filter(|f| !f.quarantined)
        .map(|f| (recommendation::score(f, &taste), f.track_id))
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.cmp(&b.1)));

    let since = now - WINDOW_30D_MS;
    let familiar = db.top_plays(user, since, 60);
    let familiar_ids: HashSet<i64> = familiar.iter().map(|(id, _)| *id).collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (id, plays) in familiar.into_iter().take(48) {
        let relevance = features.get(&id).map(|f| recommendation::score(f, &taste)).unwrap_or(0.5);
        add_candidate(&mut out, &mut seen, db, &features, id, "familiar", recommendation::FamiliarityClass::Familiar, relevance, format!("familiar: {plays} plays this month"));
    }

    for (artist, _) in db.top_artists(user, since, 8) {
        for id in db.tracks_by_artist(&artist, 24) {
            if familiar_ids.contains(&id) {
                continue;
            }
            let relevance = features.get(&id).map(|f| recommendation::score(f, &taste)).unwrap_or(0.0);
            if relevance >= HOME_RELEVANCE_FLOOR {
                add_candidate(&mut out, &mut seen, db, &features, id, "deep-cut", recommendation::FamiliarityClass::Familiar, relevance, format!("deep cut from a top artist: {artist}"));
            }
        }
    }

    if let Some(recent) = &recent_taste {
        let mut current: Vec<(f32, i64)> = all
            .iter()
            .filter(|f| !f.quarantined && !familiar_ids.contains(&f.track_id))
            .map(|f| (recommendation::score(f, recent), f.track_id))
            .filter(|(score, _)| *score >= HOME_RELEVANCE_FLOOR)
            .collect();
        current.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.cmp(&b.1)));
        for (relevance, id) in current.into_iter().take(36) {
            let Some(class) = features.get(&id).and_then(|feature| classify(feature, recent)) else { continue };
            add_candidate(&mut out, &mut seen, db, &features, id, "recent-interest", class, relevance, "matches your current listening".into());
        }
    }

    for (relevance, id) in ranked.iter().copied().filter(|(score, _)| *score >= HOME_RELEVANCE_FLOOR).take(48) {
        let Some(class) = features.get(&id).and_then(|feature| classify(feature, &taste)) else { continue };
        add_candidate(&mut out, &mut seen, db, &features, id, "adjacent", class, relevance, "adjacent to your established taste".into());
    }
    let exploration: Vec<(f32, i64)> = ranked
        .into_iter()
        .filter(|(score, id)| *score >= HOME_EXPLORATION_FLOOR && !seen.contains(id))
        .take(HOME_EXPLORATION_CANDIDATES)
        .collect();
    for (relevance, id) in exploration {
        let Some(feature) = features.get(&id) else { continue };
        let Some(class) = classify(feature, &taste) else { continue };
        if matches!(class, recommendation::FamiliarityClass::Exploratory | recommendation::FamiliarityClass::Wildcard)
            && recently_explored.contains(&feature.artist.trim().to_lowercase())
        {
            continue;
        }
        add_candidate(&mut out, &mut seen, db, &features, id, "exploratory", class, relevance, "bounded exploration above the relevance floor".into());
    }
    out.truncate(180);
    out
}

fn candidate_is_qualified(candidate: &HomeCandidate) -> bool {
    match candidate.class {
        recommendation::FamiliarityClass::Familiar => true,
        recommendation::FamiliarityClass::Wildcard => {
            candidate.relevance >= recommendation::WILDCARD_RELEVANCE_FLOOR
        }
        recommendation::FamiliarityClass::Exploratory => {
            candidate.relevance >= HOME_EXPLORATION_FLOOR
        }
        recommendation::FamiliarityClass::Adjacent => {
            candidate.relevance >= HOME_RELEVANCE_FLOOR
        }
    }
}

fn validated_ai_mixes(parsed: Vec<serde_json::Value>, candidates: &[HomeCandidate]) -> Vec<Mix> {
    let valid: HashMap<i64, &HomeCandidate> = candidates
        .iter()
        .filter(|candidate| candidate_is_qualified(candidate))
        .map(|candidate| (candidate.id, candidate))
        .collect();
    let mut mixes = Vec::new();
    for (i, value) in parsed.into_iter().take(8).enumerate() {
        let title = value.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let blurb = value.get("blurb").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let mut seen = HashSet::new();
        let mut artists: HashMap<String, usize> = HashMap::new();
        let mut exploration = 0usize;
        let mut ids = Vec::new();
        for id in value.get("ids").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_i64()) {
            let Some(candidate) = valid.get(&id) else { continue };
            if !seen.insert(id) || ids.len() >= HOME_MIX_MAX {
                continue;
            }
            let artist = candidate.artist.to_lowercase();
            if artists.get(&artist).copied().unwrap_or(0) >= HOME_ARTIST_CAP {
                continue;
            }
            if matches!(candidate.class, recommendation::FamiliarityClass::Exploratory | recommendation::FamiliarityClass::Wildcard) {
                if exploration >= HOME_EXPLORATION_PER_MIX {
                    continue;
                }
                exploration += 1;
            }
            *artists.entry(artist).or_default() += 1;
            ids.push(id);
        }
        let allocated = recommendation::rerank_allocated(
            ids.iter()
                .enumerate()
                .filter_map(|(position, id)| {
                    let candidate = valid.get(id)?;
                    Some(recommendation::AllocationCandidate {
                        id: *id,
                        artist: candidate.artist.clone(),
                        // Preserve the model's flow inside each deterministic
                        // class while allocation/diversity remain code-owned.
                        score: 1.0 - position as f32 / 1_000.0,
                        class: candidate.class,
                    })
                })
                .collect(),
            ids.len(),
            recommendation::GENERAL_ALLOCATION,
        );
        ids = allocated.into_iter().map(|candidate| candidate.id).collect();
        if title.is_empty() || ids.len() < HOME_MIX_MIN {
            continue;
        }
        mixes.push(Mix { id: format!("ai-{i}"), title, blurb, track_ids: ids, flavor: "ai".into() });
    }
    mixes
}

fn deterministic_candidate_mixes(candidates: &[HomeCandidate]) -> Vec<Mix> {
    let make = |id: &str, title: &str, blurb: &str, lanes: &[&str]| {
        let requested = json!([{
            "title": title,
            "blurb": blurb,
            "ids": candidates.iter().filter(|c| lanes.contains(&c.lane)).map(|c| c.id).collect::<Vec<_>>()
        }]);
        validated_ai_mixes(requested.as_array().cloned().unwrap_or_default(), candidates)
            .into_iter()
            .next()
            .map(|mut mix| { mix.id = id.into(); mix.flavor = "heuristic".into(); mix })
    };
    [
        make("qualified-familiar", "Your rotation", "Familiar favorites and deeper cuts with a personal reason.", &["familiar", "deep-cut", "recent-interest"]),
        make("qualified-adjacent", "Along the edges", "Close musical neighbors with a little bounded exploration.", &["adjacent", "exploratory"]),
    ]
    .into_iter()
    .flatten()
    .collect()
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
    let by_id: HashMap<i64, HomeCandidate> = home_candidates(&state.db, user, now_ms())
        .into_iter()
        .map(|candidate| (candidate.id, candidate))
        .collect();
    for mix in &mixes {
        for id in &mix.track_ids {
            if let Some(candidate) = by_id.get(id) {
                state.db.record_recommendation_exposure(
                    user,
                    "home",
                    &id.to_string(),
                    Some(*id),
                    &candidate.artist,
                    candidate.class.as_str(),
                );
            }
        }
    }

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

    let candidates = home_candidates(&state.db, user, now_ms());
    if candidates.len() < HOME_MIX_MIN {
        return None;
    }
    let lines: Vec<String> = candidates
        .iter()
        .map(|candidate| format!(
            "{}|{} — {}|lane={}|class={}|score={:.3}|reason={}|evidence={}",
            candidate.id,
            candidate.artist,
            candidate.title,
            candidate.lane,
            candidate.class.as_str(),
            candidate.relevance,
            candidate.reason,
            if candidate.evidence.is_empty() { "measured/local history" } else { &candidate.evidence },
        ))
        .collect();
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
         Every candidate below was prequalified. Its lane, relevance score, reason, and enriched evidence are authoritative.\n\
         Familiar and deep-cut lanes are known territory; recent-interest follows the listener's current direction; adjacent has a strong musical bridge; exploratory is intentionally unfamiliar and tightly limited.\n\
         Candidate tracks, one per line as id|artist — title|lane|score|reason|evidence:\n{}\n\n\
         Build 6 DAILY MIXES from ONLY these candidate ids, the way a music app's Daily Mixes work: each mix is a COHERENT lane of this listener's OWN taste - a cluster of artists and a sound they actually play together (one lane per genre/scene/mood they keep returning to), NOT a grab-bag, and each lane clearly distinct from the others. Order each lane so it flows. Titles evocative but short (2-4 words); one-line blurbs naming the through-line, warm and plain, no exclamation marks.\n\
         Answer with STRICT JSON, nothing else: [{{\"title\":\"...\",\"blurb\":\"...\",\"ids\":[1,2,3]}}] with 10-20 ids each.",
        taste.join(", "),
        recent_titles.join("; "),
        lines.join("\n"),
    );

    let model_content = async {
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
        body.pointer("/choices/0/message/content")?.as_str().map(str::to_owned)
    }
    .await;
    let fallback = || {
        let mixes = deterministic_candidate_mixes(&candidates);
        (!mixes.is_empty()).then_some(mixes)
    };
    let Some(content) = model_content else { return fallback() };

    // Models decorate JSON with prose and fences; carve out the array. Ordered
    // and bounds-checked: a truncated reply can put the last ']' before the
    // first '[', and an unguarded slice would panic - which, inside the spawned
    // task, would leave the refreshing latch stuck and freeze regeneration.
    let Some(start) = content.find('[') else { return fallback() };
    let Some(end) = content.rfind(']') else { return fallback() };
    if end <= start {
        return fallback();
    }
    let Some(slice) = content.get(start..=end) else { return fallback() };
    let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(slice) else { return fallback() };

    let mixes = validated_ai_mixes(parsed, &candidates);
    if mixes.is_empty() {
        fallback()
    } else {
        Some(mixes)
    }
}

#[cfg(test)]
mod stage5_tests {
    use super::*;

    fn candidate(id: i64, artist: &str, lane: &'static str, relevance: f32) -> HomeCandidate {
        HomeCandidate {
            id,
            artist: artist.into(),
            title: format!("Track {id}"),
            lane,
            class: match lane {
                "familiar" | "deep-cut" => recommendation::FamiliarityClass::Familiar,
                "exploratory" => recommendation::FamiliarityClass::Exploratory,
                _ => recommendation::FamiliarityClass::Adjacent,
            },
            relevance,
            reason: format!("{lane} fixture"),
            evidence: "fixture".into(),
        }
    }

    #[test]
    fn post_model_gate_removes_invalid_duplicates_artist_overflow_and_wildcard_floods() {
        let candidates = vec![
            candidate(1, "A", "familiar", 0.9),
            candidate(2, "A", "deep-cut", 0.8),
            candidate(3, "A", "adjacent", 0.7),
            candidate(4, "A", "adjacent", 0.7),
            candidate(5, "B", "exploratory", 0.5),
            candidate(6, "C", "exploratory", 0.5),
            candidate(7, "D", "exploratory", 0.5),
            candidate(8, "E", "adjacent", 0.45), // below the normal floor
            candidate(9, "F", "adjacent", 0.8),
        ];
        let parsed = json!([{
            "title":"Tempting title",
            "blurb":"The title cannot rescue invalid choices.",
            "ids":[999,1,1,2,3,4,5,6,7,8,9]
        }]);
        let mixes = validated_ai_mixes(parsed.as_array().cloned().unwrap(), &candidates);
        assert_eq!(mixes.len(), 1);
        assert_eq!(mixes[0].track_ids, vec![1, 2, 9, 5, 6]);
        assert!(!mixes[0].track_ids.contains(&8));
    }

    #[test]
    fn weak_model_output_falls_back_to_prequalified_deterministic_mixes() {
        let candidates = vec![
            candidate(1, "A", "familiar", 0.9),
            candidate(2, "B", "deep-cut", 0.8),
            candidate(3, "C", "recent-interest", 0.8),
            candidate(4, "D", "familiar", 0.7),
            candidate(5, "E", "adjacent", 0.7),
            candidate(6, "F", "adjacent", 0.65),
            candidate(7, "G", "exploratory", 0.45),
            candidate(8, "H", "adjacent", 0.6),
        ];
        let weak = json!([{"title":"Pretty but empty","ids":[999,999]}]);
        assert!(validated_ai_mixes(weak.as_array().cloned().unwrap(), &candidates).is_empty());
        let fallback = deterministic_candidate_mixes(&candidates);
        assert!(!fallback.is_empty());
        assert!(fallback.iter().all(|mix| mix.flavor == "heuristic" && mix.track_ids.len() >= HOME_MIX_MIN));
    }
}
