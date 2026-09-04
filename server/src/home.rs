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
    // A play is the listener meeting a song: it leaves their New Music now.
    // Behind the reply - two indexed reads and a compare, but the play POST
    // sits on the playback path and should answer at once.
    let st = state.clone();
    let user = caller.id;
    tokio::spawn(async move {
        crate::chartlists::refresh_new_music_for(&st, user);
    });
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
    let fresh = state.db.recently_added_for(user, SHELF);
    // Jump back in: the albums behind recent plays, each a full ordered
    // track list the client plays as given (no client-side album matching,
    // so same-named albums never merge and discs stay in order).
    let jump_back_in = state.db.recent_album_track_lists_for(user, 12);
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
        let ids = state.db.tracks_by_artist_for(user, artist, SHELF);
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
        let ids = state.db.tracks_by_artist_for(user, artist, SHELF);
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
        let ids = state.db.tracks_by_genre_for(user, &genre, SHELF);
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
//
// THE MATHS CLUSTERS, THE MODEL NAMES.
//
// The model used to be handed two hundred and forty lines and asked to find
// six coherent lanes in them - grouping, ordering and naming in one call, on
// a CPU model that had never heard of most of the artists. What came back was
// a grab-bag with confident titles: the grouping was the model's guess about
// music it could not hear, and the blurb's "through-line" was whatever it
// remembered about the two names it recognised. So the grouping now happens
// here, deterministically, in the space the recordings were MEASURED in
// (`audio_fingerprint`, the lyric or sonic embedding when a track has no
// fingerprint - the same choice the Daily Mixes make, mixes.rs); the model is
// shown one lane at a time and asked only what it is for: a name and a line,
// fenced to the artists and titles in front of it.

/// How many lanes the candidates are cut into, at most. Six is what the
/// shelf shows; fewer when the candidates cannot honestly fill them.
const LANES: usize = 6;
/// Fewest tracks a lane may ship with - under this it is a fragment.
const LANE_MIN: usize = 4;
/// Most tracks one lane shows the model - a name needs a sample, not a list.
const LANE_SHOWN: usize = 30;
/// At most this many of one artist's songs in the candidate list: the
/// "new" quota (`unplayed`) comes first and a favourite's back catalogue
/// must not crowd it out before the cap at 240.
const PER_ARTIST: i64 = 12;

/// The candidate list, in the order that reserves the "new" quota: what
/// arrived and was never played first, then the month's top artists capped
/// at twelve each, then heavy rotation - deduped, then cut at 240.
fn candidate_ids(state: &Arc<AppState>, user: i64, since: i64, top_artists: &[(String, i64)]) -> Vec<i64> {
    let mut ids: Vec<i64> = Vec::new();
    ids.extend(state.db.unplayed(user, 60));
    for (artist, _) in top_artists {
        ids.extend(state.db.tracks_by_artist_for(user, artist, PER_ARTIST));
    }
    ids.extend(state.db.top_plays(user, since, 60).into_iter().map(|(id, _)| id));
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(*id));
    ids.truncate(240);
    ids
}

/// When the maths has already built this listener's Daily Mixes
/// (`daily-*` in `curated`), those lanes ARE the prequalified pool: the
/// model may name and shape within them and nothing outside. Returns the
/// candidates unchanged when no daily lane exists yet.
pub(crate) fn within_daily_pool(candidates: Vec<i64>, curated: &[crate::db::CuratedList]) -> Vec<i64> {
    let pool: std::collections::HashSet<i64> = curated
        .iter()
        .filter(|l| l.slug.starts_with("daily-"))
        .flat_map(|l| l.track_ids.iter().copied())
        .collect();
    if pool.is_empty() {
        return candidates;
    }
    candidates.into_iter().filter(|id| pool.contains(id)).collect()
}

/// Cut the candidates into lanes by measured sound: k-means (mood.rs's
/// deterministic one) over each track's fingerprint - or its lyric/sonic
/// embedding when the body of candidates does not carry enough fingerprints
/// to cluster by ear. Tracks with no vector in the chosen space find no
/// lane. Lanes come back largest first, each in candidate order, fragments
/// under `LANE_MIN` dropped.
pub(crate) fn lanes_of(candidates: &[i64], by_id: &HashMap<i64, &crate::db::TrackFeatures>) -> Vec<Vec<i64>> {
    let feats: Vec<&crate::db::TrackFeatures> =
        candidates.iter().filter_map(|id| by_id.get(id).copied()).collect();
    let sound = crate::mood::by_sound(feats.iter().copied());
    // One space per run: the majority dimensionality among the vectors the
    // candidates can offer, so a fingerprint and a prose embedding are never
    // clustered together.
    let mut dims: HashMap<usize, usize> = HashMap::new();
    for f in &feats {
        if let Some((v, _)) = crate::mood::point_vec(f, sound) {
            *dims.entry(v.len()).or_insert(0) += 1;
        }
    }
    let Some((&want_dims, _)) = dims.iter().max_by_key(|(d, n)| (**n, **d)) else {
        return Vec::new();
    };
    let mut ids: Vec<i64> = Vec::new();
    let mut points: Vec<Vec<f32>> = Vec::new();
    for f in &feats {
        if let Some((v, _)) = crate::mood::point_vec(f, sound) {
            if v.len() == want_dims {
                let mut p = v.clone();
                let n = p.iter().map(|x| x * x).sum::<f32>().sqrt();
                if n > 1e-6 {
                    for x in p.iter_mut() {
                        *x /= n;
                    }
                }
                ids.push(f.track_id);
                points.push(p);
            }
        }
    }
    if ids.len() < LANE_MIN {
        return Vec::new();
    }
    let k = LANES.min(ids.len() / LANE_MIN).max(1);
    let weights = vec![1.0f32; points.len()];
    let (assign, _) = crate::mood::kmeans(&points, &weights, k);
    let mut lanes: Vec<Vec<i64>> = vec![Vec::new(); k];
    for (i, id) in ids.iter().enumerate() {
        lanes[assign[i]].push(*id);
    }
    lanes.retain(|l| l.len() >= LANE_MIN);
    lanes.sort_by(|a, b| b.len().cmp(&a.len()));
    lanes
}

/// The plain name a lane ships under when the model declines or misbehaves:
/// its two most-present artists. Never empty for a lane that met the floor.
fn plain_lane_title(lane: &[i64], by_id: &HashMap<i64, &crate::db::TrackFeatures>) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for id in lane {
        let Some(f) = by_id.get(id) else { continue };
        let name = f.artist.trim();
        if name.is_empty() {
            continue;
        }
        match counts.iter_mut().find(|(a, _)| a.eq_ignore_ascii_case(name)) {
            Some(e) => e.1 += 1,
            None => counts.push((name.to_string(), 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1));
    match counts.as_slice() {
        [] => "Daily mix".into(),
        [(a, _)] => format!("{a} and more"),
        [(a, _), (b, _), ..] => format!("{a}, {b} and more"),
    }
}

/// One lane's naming, as the model returned it, validated: the title and
/// blurb through the fence, and any `ids` it offered kept only where they
/// are the LANE's own - an id from another lane, or from nowhere, is
/// dropped. When it offers too few, the lane's own order stands. Returns
/// (title, blurb, ids).
pub(crate) fn validate_lane(
    m: &serde_json::Value,
    lane: &[i64],
    lane_text: &str,
    plain_title: &str,
) -> (String, String, Vec<i64>) {
    let title = m.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let blurb = m.get("blurb").and_then(|v| v.as_str()).unwrap_or("");
    let (title, blurb) = crate::ai::fence_naming(title, blurb, lane_text)
        .unwrap_or_else(|| (plain_title.to_string(), String::new()));
    let own: std::collections::HashSet<i64> = lane.iter().copied().collect();
    let mut seen = std::collections::HashSet::new();
    let offered: Vec<i64> = m
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_i64())
                .filter(|id| own.contains(id) && seen.insert(*id))
                .collect()
        })
        .unwrap_or_default();
    let ids = if offered.len() >= LANE_MIN { offered } else { lane.to_vec() };
    (title, blurb, ids)
}

/// The lanes, cut by the maths; the model asked only to name each one.
/// Every id a mix ships with is the lane's own: the model curates the
/// words, it never chooses a track.
async fn ai_mixes(state: &Arc<AppState>, user: i64, url: &str) -> Option<Vec<Mix>> {
    let since = now_ms() - WINDOW_30D_MS;
    let top_artists = state.db.top_artists(user, since, 8);
    let recent = state.db.recent_plays(user, 30);
    if recent.is_empty() {
        // Nothing to reason from yet; the heuristics say so more honestly.
        return None;
    }

    let candidates = candidate_ids(state, user, since, &top_artists);
    let candidates = within_daily_pool(candidates, &state.db.curated_for(user));
    let all = state.db.all_features();
    let by_id: HashMap<i64, &crate::db::TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    let lanes = lanes_of(&candidates, &by_id);
    if lanes.is_empty() {
        return None;
    }

    // Each lane as the model sees it: id|artist — title, a sample at most.
    let lane_texts: Vec<String> = lanes
        .iter()
        .map(|lane| {
            lane.iter()
                .take(LANE_SHOWN)
                .filter_map(|id| by_id.get(id))
                .map(|f| format!("{}|{} — {}", f.track_id, f.artist, f.title))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    let blocks: Vec<String> = lane_texts
        .iter()
        .enumerate()
        .map(|(i, text)| format!("LANE {}:\n{}", i + 1, text))
        .collect();
    let taste: Vec<String> = top_artists.iter().map(|(a, n)| format!("{a} ({n} plays)")).collect();

    let prompt = format!(
        "You NAME daily mixes for one listener, built from THEIR OWN library. The lanes below were grouped by measured sound; you do not regroup them.\n\
         Their most-played artists this month: {}.\n\
         The lanes, each as id|artist — title:\n\n{}\n\n\
         For EACH lane, in order, write a title (2-4 words, evocative but short) and a one-line blurb. Name the through-line using only the artists and titles listed in that lane; no years, genres, places or claims not in the list. Warm and plain, no exclamation marks.\n\
         You may also return the lane's own ids in the order they should play; never an id from another lane.\n\
         Answer with STRICT JSON, nothing else: [{{\"lane\":1,\"title\":\"...\",\"blurb\":\"...\",\"ids\":[...]}}] with one entry per lane.",
        taste.join(", "),
        blocks.join("\n\n"),
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

    // Each reply entry names the lane it is for (1-based), else the lanes
    // are taken in order. A lane the model skipped ships under its plain
    // name: the grouping is the maths', and the maths does not need a poet.
    let mut named: Vec<Option<serde_json::Value>> = vec![None; lanes.len()];
    for (i, m) in parsed.into_iter().enumerate() {
        let at = m
            .get("lane")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .filter(|n| (1..=lanes.len()).contains(n))
            .map(|n| n - 1)
            .unwrap_or(i);
        if at < lanes.len() && named[at].is_none() {
            named[at] = Some(m);
        }
    }
    let mut mixes = Vec::new();
    for (i, lane) in lanes.iter().enumerate() {
        let plain = plain_lane_title(lane, &by_id);
        let (title, blurb, ids) = match &named[i] {
            Some(m) => validate_lane(m, lane, &lane_texts[i], &plain),
            None => (plain, String::new(), lane.clone()),
        };
        mixes.push(Mix { id: format!("ai-{i}"), title, blurb, track_ids: ids, flavor: "ai".into() });
    }
    (!mixes.is_empty()).then_some(mixes)
}

#[cfg(test)]
mod lanes {
    //! The maths clusters, the model names - and the checks that keep the
    //! model to naming.

    use super::*;
    use crate::db::{CuratedList, TrackFeatures};

    fn song(id: i64, artist: &str, fp: [f32; 2]) -> TrackFeatures {
        TrackFeatures {
            track_id: id,
            kind: "music".into(),
            artist: artist.into(),
            title: format!("song {id}"),
            audio_fingerprint: Some(fp.to_vec()),
            ..Default::default()
        }
    }

    /// Two sounds, plainly apart, make two lanes - each in candidate order,
    /// the larger first; a track with no vector finds no lane.
    #[test]
    fn candidates_are_cut_by_measured_sound() {
        let mut all: Vec<TrackFeatures> = Vec::new();
        for i in 0..6 {
            all.push(song(i, "Quiet", [1.0, 0.05 * i as f32]));
        }
        for i in 10..14 {
            all.push(song(i, "Loud", [0.05 * (i - 10) as f32, 1.0]));
        }
        let mut silent = song(99, "Unmeasured", [0.0, 0.0]);
        silent.audio_fingerprint = None;
        all.push(silent);
        let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
        let candidates: Vec<i64> = all.iter().map(|f| f.track_id).collect();
        let lanes = lanes_of(&candidates, &by_id);
        assert_eq!(lanes.len(), 2, "{lanes:?}");
        assert_eq!(lanes[0], vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(lanes[1], vec![10, 11, 12, 13]);
        assert!(!lanes.iter().flatten().any(|id| *id == 99), "no vector, no lane");
    }

    /// The model's ids are kept only where they are the lane's own; an id
    /// from another lane - or from nowhere - is dropped, and too few keeps
    /// the lane's order. Title and blurb ride the fence.
    #[test]
    fn ids_outside_the_lane_are_rejected_and_the_caps_hold() {
        let lane = vec![1, 2, 3, 4, 5];
        let text = "1|A — s1\n2|A — s2\n3|B — s3\n4|B — s4\n5|C — s5";
        let m = json!({ "title": "Late Rooms", "blurb": "A and B, unhurried.", "ids": [5, 4, 9, 3, 2, 42, 1] });
        let (t, b, ids) = validate_lane(&m, &lane, text, "A, B and more");
        assert_eq!(t, "Late Rooms");
        assert_eq!(b, "A and B, unhurried.");
        assert_eq!(ids, vec![5, 4, 3, 2, 1], "9 and 42 are not this lane's");

        let m = json!({ "title": "Late Rooms", "blurb": "ok", "ids": [7, 8, 9, 1] });
        let (_, _, ids) = validate_lane(&m, &lane, text, "A, B and more");
        assert_eq!(ids, lane, "one own id is not an order; the lane's stands");

        let m = json!({ "title": "t".repeat(41), "blurb": "fine" });
        let (t, b, _) = validate_lane(&m, &lane, text, "A, B and more");
        assert_eq!((t.as_str(), b.as_str()), ("A, B and more", ""), "over the cap: the plain name");

        let m = json!({ "title": "Late Rooms", "blurb": "Their 1994 records." });
        let (_, b, _) = validate_lane(&m, &lane, text, "A, B and more");
        assert_eq!(b, "", "a year the lane never said is dropped");
        let m = json!({ "title": "Late Rooms", "blurb": "b".repeat(141) });
        let (_, b, _) = validate_lane(&m, &lane, text, "A, B and more");
        assert_eq!(b, "");
    }

    /// With the maths' Daily Mixes on file, the candidates are confined to
    /// them; with none, the list is untouched.
    #[test]
    fn candidates_stay_inside_the_daily_pool_when_one_exists() {
        let list = |slug: &str, ids: Vec<i64>| CuratedList {
            slug: slug.into(),
            name: String::new(),
            blurb: String::new(),
            track_ids: ids,
            built_at: 0,
        };
        let candidates = vec![1, 2, 3, 4, 5, 6];
        let none = vec![list("blend", vec![1, 2])];
        assert_eq!(within_daily_pool(candidates.clone(), &none), candidates, "no daily lane: untouched");
        let daily = vec![list("daily-1", vec![2, 3]), list("daily-2", vec![5]), list("blend", vec![1])];
        assert_eq!(within_daily_pool(candidates, &daily), vec![2, 3, 5]);
    }
}
