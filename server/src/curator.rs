//! The curator: a process that never stops listening to what you listen to.
//!
//! Two jobs, both running forever in the background from boot:
//!
//! 1. **Enrichment.** A library's tags say what a song IS but not what it is
//!    LIKE. So every track is slowly looked up and given two things it did not
//!    have: a tempo, read off the public catalogue, and a vector standing for
//!    what its words are about, computed by the local model from the lyrics
//!    already in the index. A few tracks per cycle, resumable, stamped so a
//!    restart picks up where it left off and a track is never asked about
//!    twice in a day.
//!
//! 2. **Curation.** Every listener with recent plays gets a handful of
//!    playlists rebuilt from their own history: what they have been playing
//!    decides a target tempo, a set of genres and a centre of lyrical
//!    gravity, and the whole library is scored against those three. The model
//!    names the results when one is configured; when none is, the same maths
//!    runs and the names are plain. The recommendations are the maths either
//!    way - the model is a writer here, not an oracle.
//!
//! Nothing here leaves the listener's own server. The catalogue lookup sends a
//! title and an artist to Deezer to ask a tempo; the words themselves only ever
//! go to the model the operator pointed at, which is theirs.

use crate::db::{CurationTrack, TrackFeatures};
use crate::AppState;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// How long a track's lookup stands before it is worth asking again. Tempo
/// does not change, but a track whose lyrics arrived later deserves a vector.
const FEATURE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// How soon to come back for a track that has lyrics but no vector yet. Short,
/// because that gap usually means the embedder was not running when the track
/// was first looked at - which is exactly the case when a model is switched on
/// for a library that has already been read once.
const VECTOR_RETRY_MS: i64 = 20 * 60 * 1000;
/// Tracks looked up per cycle. Small on purpose: this is a background errand
/// that must never be the reason a stream stutters.
const ENRICH_BATCH: i64 = 6;
/// Politeness gap between catalogue lookups.
const LOOKUP_GAP: Duration = Duration::from_millis(900);
/// Between cycles with work left to do.
const BUSY_SLEEP: Duration = Duration::from_secs(15);
/// Between cycles when the library is fully enriched.
const IDLE_SLEEP: Duration = Duration::from_secs(300);
/// How often one listener's playlists are rebuilt.
const CURATE_EVERY_MS: i64 = 30 * 60 * 1000;
/// The listening window that counts as "lately".
const WINDOW_30D_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Tracks per curated list.
const LIST_LEN: usize = 20;
/// At most this many by one artist in a list, so a favourite cannot fill it.
const PER_ARTIST_CAP: usize = 2;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ai_url() -> Option<String> {
    std::env::var("AFM_AI_URL").ok().filter(|s| !s.trim().is_empty())
}

/// The chat model, and whether there is one at all.
///
/// Deliberately not defaulted: writing the playlist names is the EXPENSIVE half
/// of this, and on a one-core box a chat model that was assumed rather than
/// configured means every curation cycle waits out a long timeout against a
/// model that was never pulled. Embeddings - the
/// half that actually drives the recommendations - run off their own switch
/// below, so a server can read lyrics without ever generating a word.
fn ai_chat_model() -> Option<String> {
    std::env::var("AFM_AI_MODEL").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The embedding model. Separate from the chat model because they are
/// different things: an embedder is small and fast and the chat model usually
/// cannot embed at all.
fn embed_model() -> String {
    std::env::var("AFM_AI_EMBED_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "nomic-embed-text".to_string())
}

fn client(secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(secs))
        .build()
        .unwrap_or_default()
}

/// Live state the endpoints read: what the loop is doing right now.
#[derive(Default)]
pub struct CuratorState {
    pub status: tokio::sync::Mutex<Status>,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// What the loop is up to: "enriching", "curating", "idle".
    pub phase: String,
    /// Epoch ms of the last completed curation pass.
    pub last_curated: i64,
    /// Whether an embedder is reachable - the half that reads lyrics.
    pub ai: bool,
    /// Whether a chat model is configured - the half that writes the names. Off
    /// by default, and not needed for the recommendations.
    pub chat: bool,
    /// Whether the embedder answered last time it was asked - the difference
    /// between "lyrics are being read" and "only tempo and genre are".
    pub embeddings: bool,
}

impl CuratorState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

// --- the loop ----------------------------------------------------------------

/// Starts the curator. Runs until the process ends.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        // A breath before the first cycle: the scanner is indexing at boot and
        // deserves the disk to itself.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let did_work = enrich_cycle(&state).await;
            curate_cycle(&state).await;
            // Then the world outside the library: harvest candidates, listen to
            // a couple, and keep the shelf honest about what is already owned.
            let discovered = discovery_cycle(&state).await;
            tokio::time::sleep(if did_work || discovered { BUSY_SLEEP } else { IDLE_SLEEP }).await;
        }
    });
}

/// One enrichment batch. Returns whether there was anything to do, which is
/// what decides how soon the loop comes back.
async fn enrich_cycle(state: &Arc<AppState>) -> bool {
    let stale_before = now_ms() - FEATURE_TTL_MS;
    let vector_before = now_ms() - VECTOR_RETRY_MS;
    // Only chase missing vectors when there is something that could produce
    // one; otherwise every lyric-bearing track would be revisited forever.
    let ids = state.db.tracks_needing_features(
        ENRICH_BATCH,
        stale_before,
        vector_before,
        ai_url().is_some(),
    );
    if ids.is_empty() {
        let mut s = state.curator.status.lock().await;
        s.phase = "idle".into();
        s.ai = ai_url().is_some();
        s.chat = ai_chat_model().is_some();
        return false;
    }
    {
        let mut s = state.curator.status.lock().await;
        s.phase = "enriching".into();
        s.ai = ai_url().is_some();
        s.chat = ai_chat_model().is_some();
    }

    let tracks = state.db.tracks_for_curation(&ids);
    for track in tracks {
        // The tempo is measured off the file on this box - see tempo.rs for
        // why the catalogues could not supply it. Skipped when it is already
        // known: on a lyrics backfill pass that would mean decoding a minute of
        // audio to learn nothing.
        let bpm = if track.has_bpm {
            None
        } else {
            match state.db.track_rel_path(track.id) {
                Some(rel) => crate::tempo::analyze(&state.music_root.join(rel)).await,
                None => None,
            }
        };
        let vec = if track.has_vec { None } else { embed_lyrics(&track).await };
        if vec.is_some() {
            let mut s = state.curator.status.lock().await;
            s.embeddings = true;
        }
        let _ = state.db.save_features(
            track.id,
            bpm,
            if bpm.is_some() { "local" } else { "" },
            vec.as_deref(),
        );
        tokio::time::sleep(LOOKUP_GAP).await;
    }
    true
}

/// What the words are about, as a vector, from the operator's own model. No
/// model, no lyrics, or an embedder that will not answer: no vector, and the
/// curator falls back on tempo and genre alone.
async fn embed_lyrics(track: &CurationTrack) -> Option<Vec<f32>> {
    let url = ai_url()?;
    let words = track.lyrics.trim();
    if words.len() < 40 {
        return None;
    }
    // Enough to characterise a song without paying for a whole repeated chorus.
    let input: String = words.chars().take(2000).collect();
    let reply: serde_json::Value = client(60)
        .post(format!("{}/v1/embeddings", url.trim_end_matches('/')))
        .json(&json!({ "model": embed_model(), "input": input }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let arr = reply.pointer("/data/0/embedding")?.as_array()?;
    let v: Vec<f32> = arr.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect();
    (v.len() >= 32).then_some(v)
}

// --- scoring -----------------------------------------------------------------

pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= 0.0 || nb <= 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// What a listener has been into lately, in the three terms the curator scores
/// against.
pub(crate) struct Taste {
    /// The centre of lyrical gravity: the mean of what they play.
    pub(crate) centroid: Option<Vec<f32>>,
    /// The tempo they gravitate to (median of what has one).
    pub(crate) tempo: Option<f64>,
    /// Genres by share of recent plays.
    pub(crate) genres: HashMap<String, f32>,
    /// Everything they have played lately - excluded from recommendations, so
    /// a "discover" list is not a mirror.
    pub(crate) heard: HashSet<i64>,
}

pub(crate) fn taste_from(plays: &[i64], feats: &HashMap<i64, &TrackFeatures>) -> Taste {
    let mut sum: Vec<f32> = Vec::new();
    let mut n = 0usize;
    let mut tempos: Vec<f64> = Vec::new();
    let mut genres: HashMap<String, f32> = HashMap::new();

    for id in plays {
        let Some(f) = feats.get(id) else { continue };
        if let Some(v) = &f.lyric_vec {
            if sum.is_empty() {
                sum = vec![0.0; v.len()];
            }
            if sum.len() == v.len() {
                for (s, x) in sum.iter_mut().zip(v) {
                    *s += *x;
                }
                n += 1;
            }
        }
        if let Some(b) = f.bpm {
            tempos.push(b);
        }
        if !f.genre.trim().is_empty() {
            *genres.entry(f.genre.to_lowercase()).or_insert(0.0) += 1.0;
        }
    }

    let centroid = (n > 0).then(|| sum.iter().map(|x| x / n as f32).collect::<Vec<f32>>());
    tempos.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let tempo = (!tempos.is_empty()).then(|| tempos[tempos.len() / 2]);
    let total: f32 = genres.values().sum();
    if total > 0.0 {
        for v in genres.values_mut() {
            *v /= total;
        }
    }

    Taste { centroid, tempo, genres, heard: plays.iter().copied().collect() }
}

/// How well one track answers a taste, in [0, 1]. Each term degrades to a
/// neutral 0.5 when the data behind it is missing, so a library with no
/// tempos still ranks sensibly on words and genre alone.
pub(crate) fn score(f: &TrackFeatures, taste: &Taste) -> f32 {
    let lyric = match (&taste.centroid, &f.lyric_vec) {
        (Some(c), Some(v)) => (cosine(c, v) + 1.0) / 2.0,
        _ => 0.5,
    };
    let tempo = match (taste.tempo, f.bpm) {
        // Twenty BPM out is a different feel; the falloff says so gently.
        (Some(t), Some(b)) => (-((t - b).abs() as f32) / 25.0).exp(),
        _ => 0.5,
    };
    let genre = if taste.genres.is_empty() {
        0.5
    } else {
        let g = f.genre.to_lowercase();
        // A share of 0.3 is a strong signal, so scale to reach 1 near there.
        taste.genres.get(&g).map(|s| (s * 3.0).min(1.0)).unwrap_or(0.15)
    };
    0.45 * lyric + 0.3 * tempo + 0.25 * genre
}

/// Picks the best `n`, never more than `PER_ARTIST_CAP` from one artist.
fn take_spread(mut ranked: Vec<(f32, &TrackFeatures)>, n: usize) -> Vec<i64> {
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for (_, f) in ranked {
        let key = f.artist.to_lowercase();
        let count = per_artist.entry(key).or_insert(0);
        if *count >= PER_ARTIST_CAP {
            continue;
        }
        *count += 1;
        out.push(f.track_id);
        if out.len() >= n {
            break;
        }
    }
    out
}


/// This listener's taste, built from their heavy rotation. None until they
/// have played enough for the question to have an answer.
pub(crate) fn taste_for(state: &Arc<AppState>, user: i64) -> Option<Taste> {
    let since = now_ms() - WINDOW_30D_MS;
    let top: Vec<i64> = state.db.top_plays(user, since, 60).into_iter().map(|(id, _)| id).collect();
    if top.len() < 4 {
        return None;
    }
    let all = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    Some(taste_from(&top, &by_id))
}

/// The same three-term scoring the library uses, for something that is not a
/// library row - a candidate from the catalogue, which has no track id and may
/// be missing any of the three. Each term falls back to a neutral 0.5, so a
/// candidate is never punished for what could not be measured.
pub(crate) fn score_parts(
    taste: &Taste,
    lyric_vec: Option<&[f32]>,
    bpm: Option<f64>,
    genre: Option<&str>,
) -> f32 {
    let lyric = match (&taste.centroid, lyric_vec) {
        (Some(c), Some(v)) => (cosine(c, v) + 1.0) / 2.0,
        _ => 0.5,
    };
    let tempo = match (taste.tempo, bpm) {
        (Some(t), Some(b)) => (-((t - b).abs() as f32) / 25.0).exp(),
        _ => 0.5,
    };
    let g = match (taste.genres.is_empty(), genre) {
        (false, Some(name)) => taste
            .genres
            .get(&name.to_lowercase())
            .map(|s| (s * 3.0).min(1.0))
            .unwrap_or(0.15),
        _ => 0.5,
    };
    0.45 * lyric + 0.3 * tempo + 0.25 * g
}

/// Embeds arbitrary text with the configured model - what discovery uses for
/// lyrics it fetched rather than lyrics the index already held.
pub(crate) async fn embed_text(words: &str) -> Option<Vec<f32>> {
    let url = ai_url()?;
    let trimmed = words.trim();
    if trimmed.len() < 40 {
        return None;
    }
    let input: String = trimmed.chars().take(2000).collect();
    let reply: serde_json::Value = client(60)
        .post(format!("{}/v1/embeddings", url.trim_end_matches('/')))
        .json(&json!({ "model": embed_model(), "input": input }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let arr = reply.pointer("/data/0/embedding")?.as_array()?;
    let v: Vec<f32> = arr.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect();
    (v.len() >= 32).then_some(v)
}

// --- curation ----------------------------------------------------------------

async fn curate_cycle(state: &Arc<AppState>) {
    let since = now_ms() - WINDOW_30D_MS;
    let listeners = state.db.listeners_since(since);
    if listeners.is_empty() {
        return;
    }
    {
        let last = state.curator.status.lock().await.last_curated;
        if now_ms() - last < CURATE_EVERY_MS {
            return;
        }
    }
    {
        let mut s = state.curator.status.lock().await;
        s.phase = "curating".into();
    }

    let all = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();

    for user in listeners {
        // Taste is read from heavy rotation rather than the raw log: playing
        // one song forty times should weigh more than forty different songs
        // heard once, and top_plays already counts that way.
        let top: Vec<i64> =
            state.db.top_plays(user, since, 60).into_iter().map(|(id, _)| id).collect();
        if top.len() < 4 {
            continue;
        }
        let taste = taste_from(&top, &by_id);

        // Everything they have NOT been playing lately, scored against them.
        let fresh: Vec<(f32, &TrackFeatures)> = all
            .iter()
            .filter(|f| !taste.heard.contains(&f.track_id))
            .map(|f| (score(f, &taste), f))
            .collect();
        if fresh.len() < 8 {
            continue;
        }

        // The blend: the best overall answer to this listener.
        let blend = take_spread(fresh.clone(), LIST_LEN);

        // The tempo lane: only what sits near their tempo, then ordered as a
        // ramp so the list flows instead of lurching.
        let mut lane: Vec<(f32, &TrackFeatures)> = fresh
            .iter()
            .filter(|(_, f)| match (taste.tempo, f.bpm) {
                (Some(t), Some(b)) => (t - b).abs() <= 12.0,
                _ => false,
            })
            .cloned()
            .collect();
        lane.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut lane_ids = take_spread(lane.clone(), LIST_LEN);
        lane_ids.sort_by(|a, b| {
            let x = by_id.get(a).and_then(|f| f.bpm).unwrap_or(0.0);
            let y = by_id.get(b).and_then(|f| f.bpm).unwrap_or(0.0);
            x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
        });

        // The lyrical echo: nearest to their centre of gravity in words alone.
        let echo: Vec<(f32, &TrackFeatures)> = match &taste.centroid {
            Some(c) => fresh
                .iter()
                .filter_map(|(_, f)| f.lyric_vec.as_ref().map(|v| (cosine(c, v), *f)))
                .collect(),
            None => Vec::new(),
        };
        let echo_ids = take_spread(echo, LIST_LEN);

        let tempo_label = taste.tempo.map(|t| t.round() as i64);
        let top_genre = taste
            .genres
            .iter()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(g, _)| g.clone());

        // Names: the model writes them when there is one, else they say
        // plainly what the maths did. Either way the ids are the maths'.
        let named = name_lists(state, &blend, &lane_ids, &echo_ids, tempo_label, &top_genre).await;

        if blend.len() >= 8 {
            let (n, b) = named.get(0).cloned().unwrap_or_else(|| {
                ("Made for you".into(), "Built from what you have been playing.".into())
            });
            let _ = state.db.put_curated(user, "blend", &n, &b, &blend);
        }
        if lane_ids.len() >= 8 {
            let (n, b) = named.get(1).cloned().unwrap_or_else(|| {
                (
                    "Your tempo".into(),
                    tempo_label
                        .map(|t| format!("Sitting around {t} BPM, where you live."))
                        .unwrap_or_else(|| "Tracks that move at your pace.".into()),
                )
            });
            let _ = state.db.put_curated(user, "tempo-lane", &n, &b, &lane_ids);
        }
        if echo_ids.len() >= 8 {
            let (n, b) = named.get(2).cloned().unwrap_or_else(|| {
                ("Same wavelength".into(), "Songs about what your songs are about.".into())
            });
            let _ = state.db.put_curated(user, "lyrical-echo", &n, &b, &echo_ids);
        }
    }

    let mut s = state.curator.status.lock().await;
    s.last_curated = now_ms();
    s.phase = "idle".into();
}

/// Asks the model for three (name, blurb) pairs. Returns empty on any doubt -
/// every caller has a plain fallback, and a wrong name is worse than a dull one.
async fn name_lists(
    state: &Arc<AppState>,
    blend: &[i64],
    lane: &[i64],
    echo: &[i64],
    tempo: Option<i64>,
    genre: &Option<String>,
) -> Vec<(String, String)> {
    let (Some(url), Some(model)) = (ai_url(), ai_chat_model()) else {
        // No chat model configured: the lists keep their plain names, which say
        // what the maths did and cost nothing.
        return Vec::new();
    };
    let describe = |ids: &[i64]| -> String {
        state
            .db
            .tracks_for_curation(&ids.iter().copied().take(6).collect::<Vec<_>>())
            .iter()
            .map(|t| format!("{} — {}", t.artist, t.title))
            .collect::<Vec<_>>()
            .join("; ")
    };
    let prompt = format!(
        "You name playlists for one listener's own music collection.\n\
         Their usual tempo: {}. Their main genre: {}.\n\
         Playlist A (an all-round mix): {}\n\
         Playlist B (tracks near their tempo): {}\n\
         Playlist C (lyrically similar to what they play): {}\n\n\
         Name each one. Titles 2-4 words, evocative but not silly. Blurbs one \
         short sentence, warm and plain, no exclamation marks.\n\
         Answer with STRICT JSON and nothing else: \
         [{{\"title\":\"...\",\"blurb\":\"...\"}}, ...] in the order A, B, C.",
        tempo.map(|t| format!("{t} BPM")).unwrap_or_else(|| "unknown".into()),
        genre.clone().unwrap_or_else(|| "mixed".into()),
        describe(blend),
        describe(lane),
        describe(echo),
    );

    let Ok(reply) = client(120)
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.7,
        }))
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = reply.json::<serde_json::Value>().await else { return Vec::new() };
    let Some(content) = body.pointer("/choices/0/message/content").and_then(|c| c.as_str()) else {
        return Vec::new();
    };
    // Models wrap JSON in prose and fences; carve the array out, bounds-checked
    // so a truncated reply cannot panic the loop that owns this task.
    let (Some(start), Some(end)) = (content.find('['), content.rfind(']')) else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let Some(slice) = content.get(start..=end) else { return Vec::new() };
    let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(slice) else {
        return Vec::new();
    };
    parsed
        .into_iter()
        .map(|v| {
            (
                v.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
                v.get("blurb").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
            )
        })
        .filter(|(t, _)| !t.is_empty())
        .collect()
}

/// One pass over the discovery pool for every recent listener.
async fn discovery_cycle(state: &Arc<AppState>) -> bool {
    let since = now_ms() - WINDOW_30D_MS;
    let mut worked = false;
    for user in state.db.listeners_since(since) {
        crate::discovery::harvest(state, user).await;
        crate::discovery::prune_owned(state, user);
        if crate::discovery::listen_cycle(state, user).await {
            worked = true;
        }
    }
    worked
}

// --- endpoints ---------------------------------------------------------------

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use crate::auth;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratedOut {
    pub slug: String,
    pub name: String,
    pub blurb: String,
    pub track_ids: Vec<i64>,
    pub built_at: i64,
}

/// `GET /api/curator` - this listener's curated lists, plus how far the
/// enrichment behind them has got. The client shows the lists; the progress is
/// what makes "the curator is still reading your library" honest rather than
/// mysterious.
pub async fn feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let lists: Vec<CuratedOut> = state
        .db
        .curated_for(caller.id)
        .into_iter()
        .map(|c| CuratedOut {
            slug: c.slug,
            name: c.name,
            blurb: c.blurb,
            track_ids: c.track_ids,
            built_at: c.built_at,
        })
        .collect();
    let (checked, with_bpm, with_vec, total) = state.db.feature_counts();
    let spread = state.db.tempo_spread();
    let status = state.curator.status.lock().await.clone();
    Ok(Json(json!({
        "lists": lists,
        "status": status,
        "progress": {
            "checked": checked,
            "withTempo": with_bpm,
            "withLyrics": with_vec,
            "total": total,
            "tempoMin": spread.map(|s| s.0),
            "tempoMedian": spread.map(|s| s.1),
            "tempoMax": spread.map(|s| s.2),
        },
    })))
}

// --- suggestions for one playlist --------------------------------------------

/// `GET /api/playlists/{id}/suggestions` - what else belongs on this list.
///
/// Scored against the PLAYLIST rather than the listener: a late-night playlist
/// should keep being a late-night playlist even if its owner spends the rest of
/// their week on something loud. So the taste profile here is built from the
/// list's own tracks - their words, their tempo, their genres - and the library
/// is ranked against that, minus what is already on it.
pub async fn playlist_suggestions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if state.db.playlist_owner(id) != Some(caller.id) {
        return Err((StatusCode::NOT_FOUND, "no such playlist".into()));
    }

    let members = state.db.playlist_track_ids(id);
    let all = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    let taste = taste_from(&members, &by_id);
    let on_list: HashSet<i64> = members.iter().copied().collect();

    // Two or three songs is not a character yet; below that the suggestions
    // would be noise wearing a confident label.
    let ids = if members.len() < 3 {
        Vec::new()
    } else {
        let ranked: Vec<(f32, &TrackFeatures)> = all
            .iter()
            .filter(|f| !on_list.contains(&f.track_id))
            .map(|f| (score(f, &taste), f))
            .collect();
        take_spread(ranked, 10)
    };

    Ok(Json(json!({
        "trackIds": ids,
        // The client only offers this where a model is reading lyrics - without
        // one the ranking is tempo and genre alone, which is a weaker promise
        // than "songs that belong here".
        "ai": ai_url().is_some(),
    })))
}
