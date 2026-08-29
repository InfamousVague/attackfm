//! The DJ: a continuous, steerable set drawn from the listener's OWN library,
//! with a lightweight model writing the patter between runs of tracks - the
//! shape of a radio station, not a static playlist.
//!
//! Track SELECTION happens here in Rust, off the same taste/score the curator
//! uses, so the DJ agrees with the rest of the recommendations. The model only
//! writes WORDS, over a compact already-chosen list, which is why it can use a
//! smaller/faster model than the offline curator (`AFM_DJ_MODEL`) and still feel
//! live. A free-text `seed` steers the whole thing - "something mellow for a
//! rainy morning" - by standing in for the listener's centroid.

use crate::ai::AiClient;
use crate::auth;
use crate::curator::{cosine, score, taste_from};
use crate::db::TrackFeatures;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use rand::Rng;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

/// At most this many from one artist, so the DJ never gets stuck on a favourite.
const PER_ARTIST_CAP: usize = 2;
/// How many recent plays define "lately" and get held back from the set.
const RECENT_WINDOW: i64 = 80;

/// How long the patter model may hold the reply. Past this the set ships
/// with library lines; the voice never needed the model at all.
const PATTER_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

/// Runs cut by hand when the model is absent or over budget: the same shape
/// the patter aims for, minus the prose. Seats mirror the voice layer's own
/// choice (opener, turns, a closer once there is more than one run).
fn fallback_blocks(state: &Arc<AppState>, picks: &[i64]) -> Vec<Value> {
    let chunks: Vec<&[i64]> = picks.chunks(3).collect();
    let last = chunks.len().saturating_sub(1);
    chunks
        .iter()
        .enumerate()
        .map(|(i, chunk)| {
            let artist = state
                .db
                .titles_for(&[chunk[0]])
                .first()
                .map(|(artist, _)| artist.clone())
                .unwrap_or_default();
            let seat = if i == 0 {
                crate::voice::Seat::Opener
            } else if i == last && last > 0 {
                crate::voice::Seat::Closer
            } else {
                crate::voice::Seat::Turn
            };
            let line = crate::voice::line_for(seat, &artist);
            let say = if artist.trim().is_empty() {
                line
            } else {
                format!("{line} {artist}.")
            };
            json!({ "say": say, "trackIds": chunk })
        })
        .collect()
}

const TRAIT_CACHE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Trait extraction is optional polish around an already enriched track. Keep
/// its deadline comfortably below the Booth's 90-second request deadline so a
/// busy or looping local model can never turn "choose the sound" into a client
/// timeout; the canonical enrichment-backed fallback remains useful on its own.
const TRAIT_AI_DEADLINE: Duration = Duration::from_secs(45);
/// Per-generation movement for close matches. Four percentage points peak to
/// peak changes ordering inside a quality tier without letting a weak match
/// leapfrog a clearly better one.
const QUEUE_SCORE_JITTER: f32 = 0.02;

/// The station's blend, mirroring the trait queue's shape: semantic families
/// carry the set, personal signals season it. The two invariants the unit
/// test pins: each family group sums to 1, and the semantic share outweighs
/// the personal share - a station should sound like a TASTE, not a history.
const STATION_SEM_SONIC: f32 = 0.45;
const STATION_SEM_AUDIO: f32 = 0.20;
const STATION_SEM_LYRIC: f32 = 0.20;
const STATION_SEM_COMMUNITY: f32 = 0.15;
const STATION_W_SEM: f32 = 0.72;
const STATION_W_HISTORY: f32 = 0.14;
const STATION_W_LIKE: f32 = 0.09;
const STATION_W_COLLAB: f32 = 0.05;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DjTrait {
    pub id: String,
    pub label: String,
    pub category: String,
    pub description: String,
    pub weight: f32,
    pub confidence: f32,
    pub query: String,
    #[serde(default)]
    pub signals: TraitSignals,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraitSignals {
    pub energy: Option<f32>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
    pub year_min: Option<i64>,
    pub year_max: Option<i64>,
    #[serde(default)]
    pub genres: Vec<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraitAnalysis {
    summary: String,
    traits: Vec<DjTrait>,
}

#[derive(Clone)]
struct CachedAnalysis {
    at: i64,
    value: TraitAnalysis,
}

static TRAIT_CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, CachedAnalysis>>> = OnceLock::new();

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
    if dj_model().trim().is_empty() {
        return None;
    }
    Some(url)
}

/// The DJ's model. Separate from the offline curator's on purpose: the DJ answers
/// a listener who is waiting, so it wants a small fast model, while curation runs
/// in the background and can afford a big one.
fn dj_model() -> String {
    crate::ai::setting("djModel", "AFM_DJ_MODEL")
        // Then whatever model this box was actually set up with. home-install.sh
        // writes AFM_AI_MODEL and never AFM_DJ_MODEL, so a literal default asked
        // for a model nobody had pulled - and because the feed's `ai` flag is
        // just "a URL is set", that failure was indistinguishable from having no
        // AI at all. Empty is honest; a guess is not.
        .or_else(|| crate::ai::setting("chatModel", "AFM_AI_MODEL"))
        .unwrap_or_default()
}

fn embed_model() -> String {
    std::env::var("AFM_AI_EMBED_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "nomic-embed-text".to_string())
}

/// Embed a free-text vibe so the set can be steered toward it rather than only
/// mirroring what was played last.
async fn embed(text: &str) -> Option<Vec<f32>> {
    let url = ai_url()?;
    let reply: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .ok()?
        .post(format!("{}/v1/embeddings", url.trim_end_matches('/')))
        .json(&json!({ "model": embed_model(), "input": text }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let arr = reply.pointer("/data/0/embedding")?.as_array()?;
    let v: Vec<f32> = arr
        .iter()
        .filter_map(|x| x.as_f64())
        .map(|x| x as f32)
        .collect();
    (v.len() >= 32).then_some(v)
}

#[derive(serde::Deserialize)]
pub struct DjQuery {
    /// A free-text vibe to steer toward. Empty = mirror recent listening.
    #[serde(default)]
    pub seed: String,
    /// How many tracks to hand back (clamped to a sane range).
    #[serde(default)]
    pub count: Option<usize>,
}

/// `GET /api/dj?seed=&count=` - a continuous DJ set: runs of the listener's own
/// tracks with the DJ's spoken-style patter between them. The client plays each
/// block's tracks after showing its line, and calls again to keep the set going.
pub async fn station(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DjQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let want = q.count.unwrap_or(15).clamp(6, 30);
    let seed = q.seed.trim().to_string();

    /*
     * The banked sets first. Live building under a five-second patter budget
     * produced honest picks but no JUDGEMENT - the model never had time to
     * curate, and a taste-scored ranking with jitter reads as glorified
     * shuffle. So each known vibe keeps a set built OFFLINE, where the model
     * gets minutes: it chooses from a wider pool, sequences, and speaks.
     * Serving one consumes it and banks a replacement behind the reply. A
     * custom count opts out - that caller asked for something bespoke.
     */
    if q.count.is_none() {
        if let Some(body) = crate::vibes::take(&state, caller.id, &seed) {
            return Ok(Json(body));
        }
    }

    let reply = build_reply(&state, caller.id, &seed, want, false).await?;
    // A vibe served live means none was banked; bank the next one now.
    if crate::vibes::key_for_seed(&seed).is_some() {
        let st = state.clone();
        let user = caller.id;
        let seed = seed.clone();
        tokio::spawn(async move {
            crate::vibes::rebuild_for_seed(&st, user, &seed).await;
        });
    }
    Ok(Json(reply))
}

/// The whole set, built: picks scored against taste, runs cut, lines written,
/// voice promised. `curate` is the offline mode - twice the candidates, no
/// jitter, and the model unhurried and allowed to DROP what does not fit;
/// live keeps the tight budget and ships whatever is ready.
pub(crate) async fn build_reply(
    state: &Arc<AppState>,
    user: i64,
    seed: &str,
    want: usize,
    curate: bool,
) -> Result<Value, (StatusCode, String)> {
    let seed = seed.to_string();

    // Taste: the same profile the curator scores against, from recent plays.
    let feats = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = feats.iter().map(|f| (f.track_id, f)).collect();
    // Verdicts when the ledger has them, play starts when it does not.
    let weighted = state.db.weighted_recent_listens(user, RECENT_WINDOW);
    let taste = if weighted.len() >= 8 {
        crate::curator::taste_from_weighted(&weighted, &by_id)
    } else {
        let recent = state.db.recent_plays(user, RECENT_WINDOW);
        taste_from(&recent, &by_id)
    };

    // A seed steers the set. It used to stand in for the LYRIC centroid -
    // "something mellow" compared against what songs say rather than how they
    // sound. The sonic vectors live in the same text-embedding space as the
    // seed, so the seed now steers the sonic term, which is what a vibe is.
    let mut seed_vec: Option<Vec<f32>> = None;
    if !seed.is_empty() {
        seed_vec = embed(&seed).await;
    }

    // Score the whole library, hold back the very-recently-played so the DJ does
    // not replay the last hour, and cap per artist.
    let held: HashSet<i64> = taste.heard.clone();

    /*
     * The taste profile, in every vector the library actually has.
     *
     * The station used to rank on the thinnest signals in the module - lyric
     * embedding, median BPM, genre tag - while the sonic vectors, the 48-dim
     * audio fingerprint, the community vectors, the hearts and the
     * ListenBrainz edges sat computed and unread twenty lines from here, in
     * the trait queue's blend. This is that blend, aimed at a taste profile
     * instead of a trait sheet: weighted centroids of what the listener
     * verifiably kept listening to.
     */
    let listened: Vec<(i64, f32)> = if weighted.len() >= 8 {
        weighted.clone()
    } else {
        state.db.recent_plays(user, RECENT_WINDOW).into_iter().map(|id| (id, 1.0)).collect()
    };
    let listened_feats: Vec<&TrackFeatures> = listened
        .iter()
        .filter_map(|(id, _)| by_id.get(id).copied())
        .collect();
    let taste_sonic = average_vectors(listened_feats.iter().filter_map(|f| f.sonic_vec.as_deref()));
    let taste_community =
        average_vectors(listened_feats.iter().filter_map(|f| f.community_vec.as_deref()));
    let taste_audio =
        average_owned_vectors(listened_feats.iter().filter_map(|f| audio_vector(f)));
    let collaborative_edges: HashSet<&str> = listened_feats
        .iter()
        .flat_map(|f| f.listenbrainz_similar.iter().map(String::as_str))
        .collect();
    let liked: HashSet<i64> = state.db.favorites(user).into_iter().collect();
    let sonic_target: Option<&[f32]> = seed_vec.as_deref().or(taste_sonic.as_deref());

    let half = |c: f32| (c + 1.0) / 2.0;
    let mut ranked: Vec<(f32, i64)> = {
        let mut rng = rand::thread_rng();
        feats
            .iter()
            // `!quarantined` is the same clause the trait queue applies: an
            // audition under quarantine is a judgement not yet made, and the
            // DB's own invariant says it must never seed a mix.
            .filter(|f| !held.contains(&f.track_id) && !f.quarantined)
            .map(|f| {
                let sonic = match (sonic_target, &f.sonic_vec) {
                    (Some(q), Some(v)) => half(cosine(q, v)),
                    _ => 0.5,
                };
                let audio = match (&taste_audio, audio_vector(f)) {
                    (Some(q), Some(v)) => half(cosine(q, &v)),
                    _ => 0.5,
                };
                let lyric = match (&taste.centroid, &f.lyric_vec) {
                    (Some(q), Some(v)) => half(cosine(q, v)),
                    _ => 0.5,
                };
                let community = match (&taste_community, &f.community_vec) {
                    (Some(q), Some(v)) => half(cosine(q, v)),
                    _ => 0.5,
                };
                let sem = STATION_SEM_SONIC * sonic
                    + STATION_SEM_AUDIO * audio
                    + STATION_SEM_LYRIC * lyric
                    + STATION_SEM_COMMUNITY * community;
                // The old score lives on as the history term: tempo and genre
                // closeness against the same taste, so a library with no
                // vectors at all still ranks the way it always did.
                let history = score(f, &taste);
                let like = if liked.contains(&f.track_id) { 1.0 } else { 0.0 };
                let collab = if collaborative_edges.contains(f.musicbrainz_id.as_str()) {
                    1.0
                } else {
                    0.0
                };
                let relevance = STATION_W_SEM * sem
                    + STATION_W_HISTORY * history
                    + STATION_W_LIKE * like
                    + STATION_W_COLLAB * collab;
                // Curation wants the honest ranking; the live path keeps a
                // shake of jitter so back-to-back presses do not repeat.
                let jitter = if curate {
                    0.0
                } else {
                    rng.gen_range(-QUEUE_SCORE_JITTER..=QUEUE_SCORE_JITTER)
                };
                (relevance + jitter, f.track_id)
            })
            .collect()
    };
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let artist_of: HashMap<i64, String> = feats
        .iter()
        .map(|f| (f.track_id, f.artist.to_lowercase()))
        .collect();
    let mut picks: Vec<i64> = Vec::new();
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    for (_s, id) in ranked {
        let key = artist_of.get(&id).cloned().unwrap_or_default();
        let c = per_artist.entry(key).or_insert(0);
        if *c >= PER_ARTIST_CAP {
            continue;
        }
        *c += 1;
        picks.push(id);
        // Offline the model gets a wider pool and the right to drop; live
        // takes exactly what will play. Wider, not double: thirty dossiers
        // was a prompt the hub's CPU model could not finish even unhurried.
        if picks.len() >= if curate { want + 6 } else { want } {
            break;
        }
    }
    if picks.is_empty() {
        return Ok(json!({ "ai": false, "vibe": seed, "blocks": [] }));
    }

    /*
     * The exploration slots: two of the set are a considered gamble.
     *
     * A recommender with one listener collapses onto what it already plays -
     * nothing new is ever offered, so nothing new is ever adopted, so nothing
     * new is ever scored. These slots are the structural fix: a couple of
     * positions go to artists the listener has never met (quarantined
     * auditions included - this is the deliberate door into sets that
     * replaces the accident Phase 0 closed), chosen by Thompson sampling over
     * per-artist adoption. An artist whose offers keep getting finished or
     * hearted wins slots more often; one that keeps getting skipped fades
     * without ever being banned; one never offered at all carries the uniform
     * prior and its full share of hope.
     *
     * Artist-level arms, never track-level: at one household's data size,
     * track arms would never converge on anything.
     */
    let explore_n: usize = if want >= 12 { 2 } else { 1 };
    let explore_picks: Vec<i64> = {
        use rand_distr::Distribution;
        let played = state.db.played_artist_keys(user);
        let taken: HashSet<String> =
            picks.iter().filter_map(|id| artist_of.get(id).cloned()).collect();
        let stats: HashMap<String, (i64, i64)> = state
            .db
            .explore_artist_stats(user)
            .into_iter()
            .map(|(a, offers, adopted)| (a, (offers, adopted)))
            .collect();
        // Candidates: best track per unmet artist, judged by the same taste.
        let mut best: HashMap<String, (f32, i64)> = HashMap::new();
        for f in feats.iter() {
            let key = f.artist.to_lowercase();
            if key.is_empty() || played.contains(&key) || taken.contains(&key) {
                continue;
            }
            let sc = score(f, &taste);
            let e = best.entry(key).or_insert((sc, f.track_id));
            if sc > e.0 {
                *e = (sc, f.track_id);
            }
        }
        let mut rng = rand::thread_rng();
        let mut sampled: Vec<(f64, i64)> = best
            .into_iter()
            .map(|(key, (_sc, id))| {
                let (offers, adopted) = stats.get(&key).copied().unwrap_or((0, 0));
                let a = 1.0 + adopted as f64;
                let b = 1.0 + (offers - adopted).max(0) as f64;
                let p = rand_distr::Beta::new(a, b)
                    .map(|d| d.sample(&mut rng))
                    .unwrap_or(0.5);
                (p, id)
            })
            .collect();
        sampled.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(std::cmp::Ordering::Equal));
        sampled.into_iter().take(explore_n).map(|(_, id)| id).collect()
    };
    // Seated mid-set, not opening it: position 3 and position 10 - deep
    // enough that the set has established itself, early enough to be heard.
    let explore_set: HashSet<i64> = explore_picks.iter().copied().collect();
    for (n, id) in explore_picks.into_iter().enumerate() {
        let at = (3 + n * 7).min(picks.len());
        picks.insert(at, id);
    }
    picks.truncate(want);

    // The offer ledger: what this set put in front of the listener. Adoption
    // is judged against these rows, per impression, not per catalog.
    let offered: Vec<(i64, &str, i64)> = picks
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, if explore_set.contains(id) { "explore" } else { "rank" }, i as i64))
        .collect();
    state.db.record_dj_impressions(user, &offered);

    /*
     * The dossiers: what the patter is ALLOWED to say about each pick.
     *
     * For exactly the small artists the exploration slots promote, the
     * model's world knowledge is empty or fabricated - so every fact the
     * patter may use is computed here, deterministically, from things the
     * retrieval layer knows to be true. The model's job is to phrase them,
     * never to add to them: grounded dossiers are the difference between a
     * sommelier and a confident liar.
     */
    let hearted = state.db.hearted_artist_keys(user);
    let dossiers: HashMap<i64, String> = picks
        .iter()
        .map(|id| {
            let mut facts: Vec<String> = Vec::new();
            if explore_set.contains(id) {
                facts.push("their first time in one of these sets".into());
            }
            if let Some(a) = artist_of.get(id) {
                if hearted.contains(a) {
                    facts.push("an artist this listener has hearted before".into());
                }
            }
            if let Some(f) = by_id.get(id) {
                if !f.genre.trim().is_empty() {
                    facts.push(format!("filed under {}", f.genre.trim()));
                }
            }
            (*id, facts.join("; "))
        })
        .collect();

    // The model writes the patter over the already-chosen ids; a failure just
    // means a set with no words, never a set with no music.
    /*
     * The model writes better patter, but a DJ that answers in half a minute
     * is not a DJ - by request the whole reply lands in single-digit
     * seconds, so the model gets a five-second seat at the desk and the show
     * goes on without it. The fallback is not the old wordless single block:
     * the runs are cut by hand (three tracks, led by their artist) and each
     * say line is the voice's own library line plus the name - the toast
     * shows exactly the words the voice speaks.
     */
    let mut blocks = if curate {
        // Unhurried: the whole point of banking is that the model may think.
        patter(state, &picks, &seed, &dossiers, true)
            .await
            .unwrap_or_else(|| fallback_blocks(state, &picks[..picks.len().min(want)]))
    } else {
        match tokio::time::timeout(PATTER_BUDGET, patter(state, &picks, &seed, &dossiers, false))
            .await
        {
            Ok(Some(blocks)) => blocks,
            _ => fallback_blocks(state, &picks),
        }
    };

    /*
     * The voice, as beats: each block gets its seat's cached library line and
     * the lead artist's name-drop (voice.rs owns the economics - the display
     * patter above stays the model's, rich and per-set, while the SPOKEN
     * layer is built entirely from clips that cache forever). Best-effort
     * and strictly additive: a hub with no provider, or a mint that fails,
     * just leaves the beat silent and the toast carries the set as before.
     */
    if crate::voice::enabled() {
        let last = blocks.len().saturating_sub(1);
        let mut jobs: Vec<crate::voice::Beat> = Vec::new();
        for (i, block) in blocks.iter_mut().enumerate() {
            let lead = block
                .get("trackIds")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_i64());
            let Some(lead) = lead else { continue };
            let artist = state
                .db
                .titles_for(&[lead])
                .first()
                .map(|(artist, _)| artist.clone())
                .unwrap_or_default();
            let seat = if i == 0 {
                crate::voice::Seat::Opener
            } else if i == last && last > 0 {
                crate::voice::Seat::Closer
            } else {
                crate::voice::Seat::Turn
            };
            let beats = crate::voice::block_beats(seat, &artist);
            if !beats.is_empty() {
                block["voice"] = json!(beats.iter().map(|b| b.id.clone()).collect::<Vec<_>>());
                jobs.extend(beats);
            }
        }
        // The ids are promises; the speaking happens behind the reply. The
        // clip endpoint keeps the promise even if this task dies first.
        crate::voice::mint_behind(&state, jobs);
    }
    Ok(json!({ "ai": ai_url().is_some(), "vibe": seed, "blocks": blocks }))
}

/// Ask the DJ model to break the chosen set into a few runs and open each with a
/// short spoken line. Words only - every id is validated back against `picks`,
/// and any the model drops are appended so the set stays whole.
async fn patter(
    state: &Arc<AppState>,
    picks: &[i64],
    seed: &str,
    dossiers: &HashMap<i64, String>,
    curate: bool,
) -> Option<Vec<Value>> {
    let url = ai_url()?;
    let mut lines = Vec::new();
    for id in picks {
        if let Some(t) = state.db.track(*id) {
            let facts = dossiers.get(id).filter(|f| !f.is_empty());
            match facts {
                Some(f) => lines.push(format!("{}|{} — {}|{}", id, t.artist, t.title, f)),
                None => lines.push(format!("{}|{} — {}", id, t.artist, t.title)),
            }
        }
    }
    if lines.is_empty() {
        return None;
    }
    let vibe = if seed.is_empty() {
        "their recent listening".to_string()
    } else {
        format!("\"{seed}\"")
    };
    /*
     * Two jobs, one voice. Live, the model NARRATES a set already chosen -
     * cover everything, keep the order. Banked (curate), it gets the room to
     * be a DJ: twice the candidates, told to choose the ones that belong
     * together and sequence them - dropping the rest is the point, because
     * judgement is exactly what the listener said the live sets lacked.
     */
    let brief = if curate {
        "These are CANDIDATES, ranked by this listener's taste. CHOOSE about fifteen that belong together for this brief and SEQUENCE them into a set with a shape - an opener, a build, a close. DROP the rest; a smaller set that flows beats a complete one that does not. Split your chosen set into 3-5 consecutive runs."
    } else {
        "Split the set into 3-4 consecutive runs. Cover every track, in order, across the runs."
    };
    let prompt = format!(
        "You are a warm late-night radio DJ introducing a continuous set pulled from ONE listener's OWN library, steered toward {vibe}.\n\
         The songs, one per line as id|artist — title, some lines carrying known facts after a further |:\n{}\n\n\
         {brief} For each run write ONE short spoken DJ line to open it: first person, natural, 1-2 sentences, no exclamation marks, no emojis, name at most one artist.\n\
         When you say anything ABOUT a song or artist, use only that line's listed facts or its artist and title text. Lines without facts are introduced by name and feel alone. Never invent history, biography, genres or claims of any kind.\n\
         Answer with STRICT JSON and nothing else: [{{\"say\":\"...\",\"ids\":[1,2,3]}}] using ONLY the ids above.",
        lines.join("\n"),
    );

    // Live gets a minute; the bank gets whatever the operator granted the
    // model (the AI pane's own timeout) - benching it again with a hardcoded
    // sixty seconds was exactly how the first banked sets shipped library
    // lines instead of judgement.
    let patience = if curate {
        crate::ai::setting("timeoutSecs", "AFM_AI_TIMEOUT_SECS")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(300)
            .max(60)
    } else {
        60
    };
    let reply: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(patience))
        .build()
        .ok()?
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": dj_model(),
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.9,
            // The reply is a JSON skeleton, not prose - bounding it keeps a
            // CPU model from wandering past its own patience.
            "max_tokens": 700,
        }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let content = reply.pointer("/choices/0/message/content")?.as_str()?;
    // Carve the array out of any surrounding prose/fences; ordered and bounds
    // checked so a truncated reply can never panic the slice.
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    if end <= start {
        return None;
    }
    let parsed: Vec<Value> = serde_json::from_str(content.get(start..=end)?).ok()?;

    let valid: HashSet<i64> = picks.iter().copied().collect();
    let mut used: HashSet<i64> = HashSet::new();
    let mut blocks: Vec<Value> = Vec::new();
    for m in parsed {
        let say = m
            .get("say")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let ids: Vec<i64> = m
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_i64())
                    .filter(|id| valid.contains(id) && used.insert(*id))
                    .collect()
            })
            .unwrap_or_default();
        if say.is_empty() || ids.is_empty() {
            continue;
        }
        blocks.push(json!({ "say": say, "trackIds": ids }));
    }

    // Live, whatever the model left out still gets played - the selector
    // chose it and narration must not silently cut it. Banked, dropping IS
    // the curation, so leftovers stay on the shelf.
    let leftover: Vec<i64> = if curate {
        Vec::new()
    } else {
        picks.iter().copied().filter(|id| !used.contains(id)).collect()
    };
    if !leftover.is_empty() {
        match blocks
            .last_mut()
            .and_then(|b| b.get_mut("trackIds"))
            .and_then(|v| v.as_array_mut())
        {
            Some(arr) => arr.extend(leftover.into_iter().map(|id| json!(id))),
            None => blocks.push(json!({ "say": "", "trackIds": leftover })),
        }
    }

    (!blocks.is_empty()).then_some(blocks)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSeedBody {
    #[serde(default)]
    pub track_id: Option<i64>,
    #[serde(default)]
    pub track_ids: Vec<i64>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraitQueueBody {
    #[serde(default)]
    pub track_id: Option<i64>,
    #[serde(default)]
    pub track_ids: Vec<i64>,
    pub traits: Vec<DjTrait>,
    pub count: Option<usize>,
}

/// `POST /api/dj/analyze` - ask the configured local model what is musically
/// interesting about one owned song. The model returns concepts, never tracks.
pub async fn analyze_seed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AnalyzeSeedBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".into()))?
        .id;
    let mut seed_ids = body.track_ids;
    if let Some(id) = body.track_id {
        seed_ids.insert(0, id);
    }
    seed_ids.sort_unstable();
    seed_ids.dedup();
    seed_ids.truncate(100);
    if seed_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "choose at least one song".into()));
    }
    let tracks = state.db.tracks_for_curation(&seed_ids);
    if tracks.is_empty() {
        return Err((StatusCode::NOT_FOUND, "no such tracks".into()));
    }
    let source = match body.source.as_str() {
        "album" => "album",
        "playlist" => "playlist",
        _ => "song",
    };
    let is_collection = tracks.len() > 1 || source != "song";
    let dj_note = (!is_collection)
        .then(|| state.db.dj_note(user, tracks[0].id))
        .unwrap_or_default();
    let feature_by_id: HashMap<i64, TrackFeatures> = state
        .db
        .all_features()
        .into_iter()
        .map(|f| (f.track_id, f))
        .collect();
    let model = AiClient::configured()
        .map(|c| c.chat_model().to_string())
        .unwrap_or_default();
    let enrichment_key = tracks
        .iter()
        .map(|t| format!(
            "{}:{}:{}:{}:{}:{}:{}:{:.2}",
            t.ai_genres.join("|"),
            t.ai_specific_tags.join("|"),
            t.ai_sonic_traits.join("|"),
            t.ai_production_descriptors.join("|"),
            t.ai_moods.join("|"),
            t.ai_vibes.join("|"),
            t.ai_influences.join("|"),
            t.ai_confidence,
        ))
        .collect::<Vec<_>>()
        .join(";");
    let cache_key = format!(
        "{}:{:?}:{}:{}:{}",
        source, seed_ids, model, enrichment_key, dj_note
    );
    let cache = TRAIT_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().await.get(&cache_key).cloned() {
        if now_ms() - hit.at < TRAIT_CACHE_MS {
            return Ok(Json(json!({ "source": source, "trackIds": seed_ids,
                "summary": hit.value.summary, "traits": hit.value.traits, "cached": true,
                "ai": !model.is_empty(), "djNote": dj_note })));
        }
    }

    let (analysis, used_ai) = if let Some(client) = AiClient::configured() {
        let prompt = if is_collection {
            let catalogue = tracks
                .iter()
                .map(|track| {
                    let f = feature_by_id.get(&track.id);
                    format!(
                        "{} — {} | enriched genres: {} | specific styles/subgenres: {} | sonic traits: {} | production: {} | moods/vibes: {} / {} | influences: {} | year: {} | bpm: {} | energy: {}",
                        track.artist,
                        track.title,
                        track.ai_genres.join(", "),
                        track.ai_specific_tags.join(", "),
                        track.ai_sonic_traits.join(", "),
                        track.ai_production_descriptors.join(", "),
                        track.ai_moods.join(", "),
                        track.ai_vibes.join(", "),
                        track.ai_influences.join(", "),
                        track
                            .year
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                        f.and_then(|v| v.bpm)
                            .map(|v| format!("{v:.0}"))
                            .unwrap_or_else(|| "unknown".into()),
                        f.and_then(|v| v.energy)
                            .map(|v| format!("{v:.2}"))
                            .unwrap_or_else(|| "unknown".into())
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("Analyze the shared musical identity and useful sonic lanes inside this {} named '{}'. Offer exactly 4 selectable traits. At least 3 MUST describe audible qualities shared by several tracks: groove/rhythm, instrumentation, vocal delivery, production texture, energy, or specific style hybrids. Do not let the collection title, soundtrack/franchise placement, or one outlier define the answer. Queries must describe audible qualities, not proper nouns. The summary should explain the collection's musical center in under 60 words.\n\nTracks:\n{}", source, body.name, catalogue)
        } else {
            let track = &tracks[0];
            let feature = feature_by_id.get(&track.id);
            let lyrics: String = track.lyrics.chars().take(1800).collect();
            format!(
            "Analyze what is musically distinctive about this recording and what a listener may want more of. Offer exactly 4 distinct, selectable traits. At least 3 MUST describe the actual sound: groove/rhythm, instrumentation, vocal delivery, production texture, energy, or a specific hybrid of styles. Prefer supported enriched genres and specific styles/subgenres over broad file tags. Soundtrack, Films/Games, an album, or a franchise is context and MUST NOT be returned as a genre/style or retrieval query. The DJ note is high-value human direction but not verified fact. Keep labels and queries concise, sensory, and free of proper nouns. Do not name recommended songs.\n\nTitle: {}\nArtist: {}\nAlbum (context only): {}\nFile genre tag (possibly broad or wrong): {}\nEnriched broad genres: {}\nEnriched specific styles/subgenres: {}\nEnriched sonic traits: {}\nEnriched production/instrumentation: {}\nEnriched moods: {}\nEnriched vibes: {}\nEnriched influences: {}\nEnriched lyrical themes: {}\nEnrichment summary: {}\nEnrichment confidence: {:.2}\nDJ note: {}\nYear: {}\nBPM: {}\nMeasured energy (0-1): {}\nMeasured brightness (0-1): {}\nLyrics excerpt:\n{}",
            track.title, track.artist, track.album, track.genre,
            track.ai_genres.join(", "), track.ai_specific_tags.join(", "),
            track.ai_sonic_traits.join(", "), track.ai_production_descriptors.join(", "),
            track.ai_moods.join(", "), track.ai_vibes.join(", "), track.ai_influences.join(", "),
            track.ai_lyrical_themes.join(", "), track.ai_summary, track.ai_confidence, dj_note,
            track.year.map(|v| v.to_string()).unwrap_or_else(|| "unknown".into()),
            feature.as_ref().and_then(|f| f.bpm).map(|v| format!("{v:.0}")).unwrap_or_else(|| "unknown".into()),
            feature.as_ref().and_then(|f| f.energy).map(|v| format!("{v:.2}")).unwrap_or_else(|| "unknown".into()),
            feature.as_ref().and_then(|f| f.brightness).map(|v| format!("{v:.2}")).unwrap_or_else(|| "unknown".into()),
            lyrics
        )
        };
        let schema = trait_schema();
        match tokio::time::timeout(
            TRAIT_AI_DEADLINE,
            client.chat_json::<TraitAnalysis>(
                "You are AttackFM's local music curator. Return compact, evidence-aware structured traits for the listener's own library.",
                &prompt, "attackfm_trait_analysis", schema, true,
            ),
        ).await {
            Ok(Ok(value)) => (value, true),
            Ok(Err(error)) => {
                eprintln!("[attackfm] song trait AI failed; using enriched fallback: {error}");
                let track = &tracks[0];
                (heuristic_analysis(track, feature_by_id.get(&track.id)), false)
            }
            Err(_) => {
                eprintln!("[attackfm] song trait AI exceeded 45s; using enriched fallback");
                let track = &tracks[0];
                (heuristic_analysis(track, feature_by_id.get(&track.id)), false)
            }
        }
    } else {
        let track = &tracks[0];
        (
            heuristic_analysis(track, feature_by_id.get(&track.id)),
            false,
        )
    };
    let analysis = sanitize_analysis(analysis);
    if analysis.traits.is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "the DJ could not find useful traits for this song".into(),
        ));
    }
    cache.lock().await.insert(
        cache_key,
        CachedAnalysis {
            at: now_ms(),
            value: analysis.clone(),
        },
    );
    Ok(Json(json!({ "source": source, "trackIds": seed_ids,
        "summary": analysis.summary, "traits": analysis.traits, "cached": false,
        "ai": used_ai, "djNote": dj_note })))
}

/// `POST /api/dj/queue` - turn selected concepts into a semantic and
/// feature-aware target, then rank only real rows from this server's library.
pub async fn trait_queue(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<TraitQueueBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".into()))?
        .id;
    let song_seed = body.track_id;
    let mut seed_ids = body.track_ids;
    if let Some(id) = song_seed {
        seed_ids.insert(0, id);
    }
    seed_ids.sort_unstable();
    seed_ids.dedup();
    if seed_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "choose at least one song".into()));
    }
    let selected: Vec<DjTrait> = body
        .traits
        .into_iter()
        .take(12)
        .map(sanitize_trait)
        .filter(|t| !t.label.is_empty() && !t.query.is_empty())
        .collect();
    if selected.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "select at least one trait".into()));
    }
    let want = body.count.unwrap_or(24).clamp(6, 40);
    let features = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = features.iter().map(|f| (f.track_id, f)).collect();
    // A collection mix must retain the sound of the whole collection. Earlier
    // this endpoint used the seed ids only as an exclusion list, so after the
    // analysis step the queue had no direct knowledge of the album/playlist at
    // all. Average every available member embedding and measured feature into
    // a stable collection profile; an outlier can contribute, but cannot own it.
    let seed_features: Vec<&TrackFeatures> = seed_ids
        .iter()
        .filter_map(|id| by_id.get(id).copied())
        .collect();
    let collection_centroid =
        average_vectors(seed_features.iter().filter_map(|f| f.lyric_vec.as_deref()));
    let collection_sonic =
        average_vectors(seed_features.iter().filter_map(|f| f.sonic_vec.as_deref()));
    let collection_lyrical = average_vectors(
        seed_features
            .iter()
            .filter_map(|f| f.lyrical_vec.as_deref()),
    );
    let collection_community = average_vectors(
        seed_features
            .iter()
            .filter_map(|f| f.community_vec.as_deref()),
    );
    let collection_energy = average_values(seed_features.iter().filter_map(|f| f.energy));
    let collection_bpm = average_values(seed_features.iter().filter_map(|f| f.bpm));
    let collection_brightness = average_values(seed_features.iter().filter_map(|f| f.brightness));
    let collection_dynamic_range =
        average_values(seed_features.iter().filter_map(|f| f.dynamic_range));
    let collection_rhythmic_activity =
        average_values(seed_features.iter().filter_map(|f| f.rhythmic_activity));
    let collection_audio = average_owned_vectors(
        seed_features
            .iter()
            .filter_map(|feature| audio_vector(feature)),
    );
    let collaborative_candidates: HashSet<&str> = seed_features
        .iter()
        .flat_map(|feature| feature.listenbrainz_similar.iter().map(String::as_str))
        .collect();
    let recent = state.db.recent_plays(user, RECENT_WINDOW);
    let taste = taste_from(&recent, &by_id);
    let liked: HashSet<i64> = state.db.favorites(user).into_iter().collect();
    // The embedding is primarily a description of audible character. Context
    // can add colour, but letting a soundtrack/scene phrase occupy an equal
    // share made soundtrack cuts recommend other soundtrack cuts regardless
    // of how unlike one another they sounded.
    let target_text = selected
        .iter()
        .map(|t| {
            let importance = category_importance(&t.category);
            format!("audible trait (importance {importance:.1}): {}", t.query)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let semantic = match AiClient::configured() {
        Some(client) => client.embed(&target_text).await.ok(),
        None => None,
    };
    let held: HashSet<i64> = recent.into_iter().collect();
    let mut rng = rand::thread_rng();
    let mut ranked: Vec<(f32, &TrackFeatures, serde_json::Value)> = features
        .iter()
        .filter(|f| {
            !seed_ids.contains(&f.track_id) && !held.contains(&f.track_id) && !f.quarantined
        })
        .map(|f| {
            let trait_sem = match (&semantic, &f.lyric_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => 0.5,
            };
            let sonic_sem = match (&semantic, &f.sonic_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => trait_sem,
            };
            let lyrical_sem = match (&collection_lyrical, &f.lyrical_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => 0.5,
            };
            let community_sem = match (&collection_community, &f.community_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => 0.5,
            };
            let collection_sem = match (&collection_centroid, &f.lyric_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => 0.5,
            };
            let seed_sonic_sem = match (&collection_sonic, &f.sonic_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => collection_sem,
            };
            let measured = collection_feature_score(
                f,
                collection_energy,
                collection_bpm,
                collection_brightness,
                collection_dynamic_range,
                collection_rhythmic_activity,
            );
            let audio_embedding = match (&collection_audio, audio_vector(f)) {
                (Some(seed), Some(candidate)) => (cosine(seed, &candidate) + 1.0) / 2.0,
                _ => measured,
            };
            // Traits steer the direction the listener selected, while the
            // members themselves remain nearly half of the musical evidence.
            let sem = 0.45 * sonic_sem
                + 0.25 * seed_sonic_sem
                + 0.15 * audio_embedding
                + 0.08 * lyrical_sem
                + 0.07 * community_sem;
            let specialized = specialized_score(f, &selected);
            let history = score(f, &taste);
            // Likes are a gentle taste vote, not a shortcut to replaying the
            // favourites list. Eight percent is enough to break close sonic
            // matches while the selected sound still owns the ranking.
            let like = if liked.contains(&f.track_id) {
                1.0
            } else {
                0.0
            };
            let collaborative = if !f.musicbrainz_id.is_empty()
                && collaborative_candidates.contains(f.musicbrainz_id.as_str())
            {
                1.0
            } else {
                0.0
            };
            // ListenBrainz is a small positive-only corroborator. Its radio
            // graph reflects listening patterns, not proof that recordings
            // sound alike, so it cannot outweigh semantic or measured sound.
            let relevance = 0.44 * sem
                + 0.32 * specialized
                + 0.12 * history
                + 0.08 * like
                + 0.04 * collaborative;
            let jitter = rng.gen_range(-QUEUE_SCORE_JITTER..=QUEUE_SCORE_JITTER);
            let strongest = [
                ("sound", 0.45 * sonic_sem + 0.25 * seed_sonic_sem),
                ("audio", 0.15 * audio_embedding),
                ("lyrics", 0.08 * lyrical_sem),
                ("community", 0.07 * community_sem + 0.04 * collaborative),
                ("your listening", 0.12 * history + 0.08 * like),
            ]
            .into_iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap();
            let explanation = json!({
                "trackId": f.track_id,
                "reason": format!("Strongest match: {}", strongest.0),
                "scores": { "sonic": sonic_sem, "measuredAudio": audio_embedding,
                    "lyrical": lyrical_sem, "community": community_sem,
                    "history": history, "liked": like, "collaborative": collaborative }
            });
            ((relevance + jitter).clamp(0.0, 1.0), f, explanation)
        })
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut ids = song_seed.into_iter().collect::<Vec<_>>();
    let mut artists: HashMap<String, usize> = ids
        .iter()
        .filter_map(|id| {
            features
                .iter()
                .find(|f| f.track_id == *id)
                .map(|f| (f.artist.to_lowercase(), 1))
        })
        .collect();
    let mut explanations = Vec::new();
    for (_, f, explanation) in ranked {
        let count = artists.entry(f.artist.to_lowercase()).or_insert(0);
        if *count >= PER_ARTIST_CAP {
            continue;
        }
        *count += 1;
        ids.push(f.track_id);
        explanations.push(explanation);
        if ids.len() >= want {
            break;
        }
    }
    // Same offer ledger the station writes: adoption is judged per impression.
    let offered: Vec<(i64, &str, i64)> =
        ids.iter().enumerate().map(|(i, id)| (*id, "rank", i as i64)).collect();
    state.db.record_dj_impressions(user, &offered);
    Ok(Json(
        json!({ "trackIds": ids, "semantic": semantic.is_some(), "explanations": explanations,
        "intent": { "kind": "traits", "seedTrackIds": seed_ids,
            "traits": selected.iter().map(|t| &t.id).collect::<Vec<_>>() } }),
    ))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DjNoteBody {
    pub track_id: i64,
    #[serde(default)]
    pub note: String,
}

/// `POST /api/dj/note` - save human judgement independently of AI enrichment.
pub async fn set_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<DjNoteBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".into()))?
        .id;
    if state.db.tracks_for_curation(&[body.track_id]).is_empty() {
        return Err((StatusCode::NOT_FOUND, "no such track".into()));
    }
    state
        .db
        .set_dj_note(user, body.track_id, &body.note)
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not save DJ note".into(),
            )
        })?;
    Ok(Json(
        json!({ "ok": true, "note": state.db.dj_note(user, body.track_id) }),
    ))
}

fn average_values(values: impl Iterator<Item = f64>) -> Option<f64> {
    let values: Vec<f64> = values.collect();
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn average_vectors<'a>(vectors: impl Iterator<Item = &'a [f32]>) -> Option<Vec<f32>> {
    let vectors: Vec<&[f32]> = vectors.collect();
    let len = vectors.first()?.len();
    if len == 0 {
        return None;
    }
    let usable: Vec<&[f32]> = vectors.into_iter().filter(|v| v.len() == len).collect();
    if usable.is_empty() {
        return None;
    }
    let mut out = vec![0.0; len];
    for vector in &usable {
        for (sum, value) in out.iter_mut().zip(vector.iter()) {
            *sum += *value;
        }
    }
    for value in &mut out {
        *value /= usable.len() as f32;
    }
    Some(out)
}

fn average_owned_vectors(vectors: impl Iterator<Item = Vec<f32>>) -> Option<Vec<f32>> {
    let vectors: Vec<Vec<f32>> = vectors.collect();
    average_vectors(vectors.iter().map(Vec::as_slice))
}

/// Prefer the versioned 48-dimensional spectral/temporal fingerprint measured
/// directly from decoded audio. Older rows fall back to the five explainable
/// measurements while the background analyser backfills them.
fn audio_vector(feature: &TrackFeatures) -> Option<Vec<f32>> {
    if let Some(fingerprint) = feature
        .audio_fingerprint
        .as_ref()
        .filter(|vector| vector.len() == 48)
    {
        return Some(fingerprint.clone());
    }
    let parts = [
        feature.bpm.map(|v| (v / 240.0).clamp(0.0, 1.0)),
        feature.energy,
        feature.brightness,
        feature.dynamic_range,
        feature.rhythmic_activity,
    ];
    (parts.iter().filter(|value| value.is_some()).count() >= 3).then(|| {
        parts
            .into_iter()
            .map(|value| value.unwrap_or(0.5) as f32)
            .collect()
    })
}

fn collection_feature_score(
    feature: &TrackFeatures,
    energy: Option<f64>,
    bpm: Option<f64>,
    brightness: Option<f64>,
    dynamic_range: Option<f64>,
    rhythmic_activity: Option<f64>,
) -> f32 {
    let mut parts = Vec::new();
    if let (Some(target), Some(actual)) = (energy, feature.energy) {
        parts.push((1.0 - (target - actual).abs().min(1.0)) as f32);
    }
    if let (Some(target), Some(actual)) = (bpm, feature.bpm) {
        parts.push((-(target - actual).abs() / 30.0).exp() as f32);
    }
    if let (Some(target), Some(actual)) = (brightness, feature.brightness) {
        parts.push((1.0 - (target - actual).abs().min(1.0)) as f32);
    }
    if let (Some(target), Some(actual)) = (dynamic_range, feature.dynamic_range) {
        parts.push((1.0 - (target - actual).abs().min(1.0)) as f32);
    }
    if let (Some(target), Some(actual)) = (rhythmic_activity, feature.rhythmic_activity) {
        parts.push((1.0 - (target - actual).abs().min(1.0)) as f32);
    }
    if parts.is_empty() {
        0.5
    } else {
        parts.iter().sum::<f32>() / parts.len() as f32
    }
}

fn specialized_score(feature: &TrackFeatures, traits: &[DjTrait]) -> f32 {
    let mut total = 0.0f32;
    let mut weights = 0.0f32;
    for t in traits {
        let w = t.weight.clamp(0.1, 1.5)
            * t.confidence.clamp(0.25, 1.0)
            * category_importance(&t.category);
        let mut parts = Vec::new();
        if let (Some(target), Some(actual)) = (t.signals.energy, feature.energy) {
            parts.push(1.0 - (target - actual as f32).abs().min(1.0));
        }
        if let Some(bpm) = feature.bpm {
            if let (Some(lo), Some(hi)) = (t.signals.bpm_min, t.signals.bpm_max) {
                let gap = if bpm < lo {
                    lo - bpm
                } else if bpm > hi {
                    bpm - hi
                } else {
                    0.0
                };
                parts.push((-gap as f32 / 25.0).exp());
            }
        }
        if let Some(year) = feature.year {
            if let (Some(lo), Some(hi)) = (t.signals.year_min, t.signals.year_max) {
                let gap = if year < lo {
                    lo - year
                } else if year > hi {
                    year - hi
                } else {
                    0
                };
                parts.push((-gap as f32 / 8.0).exp());
            }
        }
        if !t.signals.genres.is_empty()
            && (!feature.ai_genres.is_empty()
                || !feature.ai_specific_tags.is_empty()
                || !feature.genre.trim().is_empty())
        {
            let candidate_genres = if feature.ai_genres.is_empty() && feature.ai_specific_tags.is_empty() {
                vec![feature.genre.to_lowercase()]
            } else {
                feature.ai_genres.iter().chain(&feature.ai_specific_tags)
                    .map(|g| g.to_lowercase()).collect()
            };
            parts.push(
                if t.signals.genres.iter().any(|g| {
                    let wanted = normalized_style(g);
                    candidate_genres.iter().any(|candidate| {
                        let candidate = normalized_style(candidate);
                        candidate.contains(&wanted) || wanted.contains(&candidate)
                    })
                }) {
                    1.0
                } else {
                    0.2
                },
            );
        }
        if !parts.is_empty() {
            total += w * parts.iter().sum::<f32>() / parts.len() as f32;
            weights += w;
        }
    }
    if weights > 0.0 {
        total / weights
    } else {
        0.5
    }
}

fn normalized_style(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn category_importance(category: &str) -> f32 {
    match category {
        "sonic" | "production" | "instrumentation" | "vocals" => 1.25,
        "energy" | "genre_style" | "mood" => 1.0,
        "lyrical_theme" => 0.75,
        // Cultural context is useful DJ knowledge, but a weak similarity
        // signal: a film/game/show is a container, not a sound.
        "scene_culture" | "era" => 0.45,
        _ => 0.75,
    }
}

fn sanitize_analysis(mut analysis: TraitAnalysis) -> TraitAnalysis {
    analysis.summary = analysis.summary.trim().chars().take(240).collect();
    analysis.traits = analysis
        .traits
        .into_iter()
        .take(12)
        .map(sanitize_trait)
        .filter(|t| !t.label.is_empty() && !t.query.is_empty())
        .collect();
    analysis
}

fn sanitize_trait(mut t: DjTrait) -> DjTrait {
    const CATEGORIES: &[&str] = &[
        "sonic",
        "energy",
        "genre_style",
        "vocals",
        "era",
        "mood",
        "production",
        "lyrical_theme",
        "instrumentation",
        "scene_culture",
    ];
    t.label = t.label.trim().chars().take(42).collect();
    t.description = t.description.trim().chars().take(160).collect();
    t.query = t.query.trim().chars().take(180).collect();
    t.category = t.category.trim().to_lowercase();
    if !CATEGORIES.contains(&t.category.as_str()) {
        t.category = "sonic".into();
    }
    t.weight = t.weight.clamp(0.1, 1.5);
    t.confidence = t.confidence.clamp(0.0, 1.0);
    if t.id.trim().is_empty() {
        t.id = t
            .label
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
    }
    t.signals.energy = t.signals.energy.map(|v| v.clamp(0.0, 1.0));
    t.signals.bpm_min = t.signals.bpm_min.map(|v| v.clamp(30.0, 300.0));
    t.signals.bpm_max = t.signals.bpm_max.map(|v| v.clamp(30.0, 300.0));
    t.signals.year_min = t.signals.year_min.map(|v| v.clamp(1900, 2200));
    t.signals.year_max = t.signals.year_max.map(|v| v.clamp(1900, 2200));
    t.signals.genres = t
        .signals
        .genres
        .into_iter()
        .take(5)
        .map(|g| g.trim().chars().take(48).collect())
        .filter(|g: &String| !g.is_empty())
        .collect();
    t
}

fn heuristic_analysis(
    track: &crate::db::CurationTrack,
    feature: Option<&TrackFeatures>,
) -> TraitAnalysis {
    let mut traits = Vec::new();
    let mut add =
        |label: &str, category: &str, description: String, query: String, signals: TraitSignals| {
            traits.push(DjTrait {
                id: label.to_lowercase().replace(' ', "-"),
                label: label.into(),
                category: category.into(),
                description,
                weight: 1.0,
                confidence: 0.7,
                query,
                signals,
            });
        };
    let preferred_genre = track
        .ai_specific_tags
        .iter()
        .chain(&track.ai_genres)
        .next()
        .map(String::as_str)
        .filter(|_| track.ai_confidence >= 0.45)
        .unwrap_or(track.genre.as_str());
    let broad_context = matches!(
        preferred_genre.trim().to_lowercase().as_str(),
        "soundtrack" | "films/games" | "film" | "game" | "video game music"
    );
    if !preferred_genre.trim().is_empty() && !broad_context {
        add(
            preferred_genre,
            "genre_style",
            "More from this musical lane.".into(),
            preferred_genre.to_string(),
            TraitSignals {
                genres: vec![preferred_genre.to_string()],
                ..Default::default()
            },
        );
    }
    // The local model is optional. When it is busy, expose useful choices
    // straight from the canonical enrichment instead of collapsing to broad
    // file tags and measured energy alone.
    if let Some(sonic) = track.ai_sonic_traits.first().filter(|v| !v.trim().is_empty()) {
        add(
            sonic,
            "sonic",
            "More with this enriched sonic character.".into(),
            sonic.to_string(),
            TraitSignals::default(),
        );
    }
    if let Some(production) = track
        .ai_production_descriptors
        .first()
        .filter(|v| !v.trim().is_empty())
    {
        add(
            production,
            "production",
            "More with this production or instrumentation character.".into(),
            production.to_string(),
            TraitSignals::default(),
        );
    }
    if let Some(mood) = track
        .ai_moods
        .iter()
        .chain(&track.ai_vibes)
        .next()
        .filter(|v| !v.trim().is_empty())
    {
        add(
            mood,
            "mood",
            "More with this enriched mood and vibe.".into(),
            mood.to_string(),
            TraitSignals::default(),
        );
    }
    if let Some(year) = track.year {
        let decade = year / 10 * 10;
        add(
            &format!("{decade}s"),
            "era",
            "More music from the same era.".into(),
            format!("music from the {decade}s"),
            TraitSignals {
                year_min: Some(decade),
                year_max: Some(decade + 9),
                ..Default::default()
            },
        );
    }
    if let Some(f) = feature {
        if let Some(e) = f.energy {
            let label = if e >= 0.62 {
                "High energy"
            } else if e <= 0.36 {
                "Low-key"
            } else {
                "Steady energy"
            };
            add(
                label,
                "energy",
                "Matched to the measured intensity of the recording.".into(),
                label.into(),
                TraitSignals {
                    energy: Some(e as f32),
                    bpm_min: f.bpm.map(|b| b - 15.0),
                    bpm_max: f.bpm.map(|b| b + 15.0),
                    ..Default::default()
                },
            );
        }
        if let Some(bright) = f.brightness {
            let label = if bright > 0.58 {
                "Bright sound"
            } else {
                "Dark-toned"
            };
            add(
                label,
                "sonic",
                "A similar overall tonal character.".into(),
                label.into(),
                TraitSignals::default(),
            );
        }
    }
    add(
        "Lyrical character",
        "lyrical_theme",
        "Follow the song's words and subject matter.".into(),
        format!(
            "songs lyrically and thematically like {} by {}",
            track.title, track.artist
        ),
        TraitSignals::default(),
    );
    TraitAnalysis {
        summary: format!("A few directions outward from {}.", track.title),
        traits,
    }
}

fn trait_schema() -> Value {
    json!({
      "type": "object", "additionalProperties": false,
      "required": ["summary", "traits"],
      "properties": {
        "summary": { "type": "string" },
        "traits": { "type": "array", "minItems": 4, "maxItems": 4, "items": {
          "type": "object", "additionalProperties": false,
          "required": ["id", "label", "category", "description", "weight", "confidence", "query", "signals"],
          "properties": {
            "id": { "type": "string" }, "label": { "type": "string" },
            "category": { "type": "string", "enum": ["sonic", "energy", "genre_style", "vocals", "era", "mood", "production", "lyrical_theme", "instrumentation", "scene_culture"] },
            "description": { "type": "string" }, "weight": { "type": "number" },
            "confidence": { "type": "number" }, "query": { "type": "string" },
            "signals": { "type": "object", "additionalProperties": false,
              "required": ["energy", "bpmMin", "bpmMax", "yearMin", "yearMax", "genres"],
              "properties": {
                "energy": { "type": ["number", "null"] }, "bpmMin": { "type": ["number", "null"] },
                "bpmMax": { "type": ["number", "null"] }, "yearMin": { "type": ["integer", "null"] },
                "yearMax": { "type": ["integer", "null"] },
                "genres": { "type": "array", "items": { "type": "string" }, "maxItems": 5 }
              }
            }
          }
        }}
      }
    })
}

#[cfg(test)]
mod ranking_tests {
    use super::*;

    fn feature(bpm: f64, energy: f64, brightness: f64, dynamic: f64, rhythm: f64) -> TrackFeatures {
        TrackFeatures {
            kind: "music".into(),
            track_id: 1,
            bpm: Some(bpm),
            curator_user_id: None,
            added_at: 0,
            lyric_vec: None,
            genre: "test".into(),
            ai_genres: Vec::new(),
            ai_specific_tags: Vec::new(),
            ai_sonic_traits: Vec::new(),
            artist: "test".into(),
            energy: Some(energy),
            brightness: Some(brightness),
            dynamic_range: Some(dynamic),
            rhythmic_activity: Some(rhythm),
            musicbrainz_id: String::new(),
            listenbrainz_similar: Vec::new(),
            sonic_vec: None,
            lyrical_vec: None,
            community_vec: None,
            audio_fingerprint: None,
            year: None,
            quarantined: false,
        }
    }

    #[test]
    fn local_audio_embedding_is_deterministic_and_bounded() {
        let vector = audio_vector(&feature(120.0, 0.8, 0.2, 0.6, 0.4)).unwrap();
        assert_eq!(vector, vec![0.5, 0.8, 0.2, 0.6, 0.4]);
        assert!(vector.iter().all(|value| (0.0..=1.0).contains(value)));
    }

    #[test]
    fn nearby_audio_ranks_above_an_opposite_profile() {
        let seed = audio_vector(&feature(120.0, 0.8, 0.2, 0.6, 0.4)).unwrap();
        let near = audio_vector(&feature(123.0, 0.78, 0.22, 0.58, 0.42)).unwrap();
        let far = audio_vector(&feature(55.0, 0.1, 0.95, 0.05, 0.95)).unwrap();
        assert!(cosine(&seed, &near) > cosine(&seed, &far));
    }

    #[test]
    fn taste_signals_cannot_outweigh_relevance() {
        let relevance_families = 0.44 + 0.32;
        let personal_tie_breakers = 0.12 + 0.08;
        let collaborative = 0.04;
        assert!(relevance_families > personal_tie_breakers + collaborative);
        assert!(
            (relevance_families + personal_tie_breakers + collaborative - 1.0_f32).abs() < 0.001
        );
    }

    #[test]
    fn specific_subgenres_drive_the_explicit_style_signal() {
        let mut candidate = feature(120.0, 0.6, 0.5, 0.5, 0.5);
        candidate.genre = "electronic".into();
        candidate.ai_genres = vec!["electronic".into()];
        candidate.ai_specific_tags = vec!["future-garage".into()];
        let direction = DjTrait {
            id: "future-garage".into(),
            label: "Future garage".into(),
            category: "genre_style".into(),
            description: String::new(),
            weight: 1.0,
            confidence: 1.0,
            query: "future garage".into(),
            signals: TraitSignals {
                genres: vec!["future garage".into()],
                ..Default::default()
            },
        };
        assert_eq!(specialized_score(&candidate, &[direction]), 1.0);
    }
}

#[cfg(test)]
mod station_weights {
    use super::*;

    #[test]
    fn the_budget_holds() {
        let sem = STATION_SEM_SONIC + STATION_SEM_AUDIO + STATION_SEM_LYRIC + STATION_SEM_COMMUNITY;
        assert!((sem - 1.0).abs() < 1e-6, "semantic family must sum to 1");
        let outer = STATION_W_SEM + STATION_W_HISTORY + STATION_W_LIKE + STATION_W_COLLAB;
        assert!((outer - 1.0).abs() < 1e-6, "outer blend must sum to 1");
        assert!(
            STATION_W_SEM > STATION_W_HISTORY + STATION_W_LIKE + STATION_W_COLLAB,
            "a station sounds like a taste, not a history",
        );
    }
}
