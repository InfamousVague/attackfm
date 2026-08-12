//! The endless station.
//!
//! A mix is a fixed list built once; a station never ends and answers to the
//! hand on the dial. Both read the same taste the curator already keeps -
//! lyric centroid, median tempo, genre shares (curator.rs) - so a station is
//! not a second opinion about this listener, it is the same opinion asked a
//! different way: "what next", forever, with three knobs.
//!
//!   energy    -1..1  calmer or harder than usual - moves the tempo and
//!                    loudness the scorer is aiming at, so it steers the FEEL
//!                    rather than filtering a genre out.
//!   familiar   0..1  0 is the deep end of your own shelves (things you own
//!                    and rarely play), 1 is the songs you wear out. The
//!                    middle is a normal radio hour.
//!   seed             one track to start from: its own lyric vector and tempo
//!                    are blended into the centre, so "radio from this song"
//!                    means what it says.
//!
//! Picks are weighted-random rather than the top N, and that is deliberate:
//! the top N of a fixed taste is the same list every time, which is how a
//! station stops feeling alive. Score decides the odds, chance decides the
//! order, and `exclude` carries what the client already has queued so the
//! next page never repeats the last one.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::curator::{score, taste_for, Taste};
use crate::{auth, AppState};

#[derive(Deserialize)]
pub struct RadioQuery {
    /// Start from this track: its feel joins the centre of the search.
    pub seed: Option<i64>,
    /// -1 calmer .. 1 harder.
    pub energy: Option<f32>,
    /// 0 deep cuts .. 1 favourites. Absent means an even hand.
    pub familiar: Option<f32>,
    /// How many to hand back. Kept small: a station is asked again.
    pub n: Option<usize>,
    /// Comma-separated ids the client already holds, so pages do not repeat.
    pub exclude: Option<String>,
    /// Blend: another account on this server whose taste joins the search, so
    /// a station can belong to two people in a house rather than one.
    pub with: Option<i64>,
}

/// How many of the best candidates go into the hat. Wide enough that the same
/// hour never plays twice, narrow enough that nothing embarrassing gets in.
const POOL: usize = 160;

/// Odds are the score raised to this: a firm preference for the better
/// candidates without ever making the best one a certainty.
const SHARPNESS: f32 = 3.0;

fn parse_ids(raw: &Option<String>) -> HashSet<i64> {
    raw.as_deref()
        .map(|s| s.split(',').filter_map(|p| p.trim().parse::<i64>().ok()).collect())
        .unwrap_or_default()
}

/// A blend's score: the WORSE of the two tastes, not the average.
///
/// An average lets one person's obsession carry a track neither would have
/// chosen together - it is how "our" playlists end up being one person's.
/// Taking the minimum means every song has to clear a bar with both, which is
/// what a room full of two people actually needs. A small bonus goes to what
/// they BOTH already play: the common ground is the point of a blend.
fn blended(mine: f32, theirs: f32, shared: bool) -> f32 {
    let base = mine.min(theirs);
    if shared {
        base * 1.25
    } else {
        base
    }
}

/// `GET /api/household` - the other accounts on this server.
///
/// Deliberately readable by any signed-in listener, where the user LIST is
/// admin-only: this hands back names and ids and nothing else, and a house
/// where nobody may know who else lives there cannot blend, hand a device
/// over, or say whose turn it is. Anyone holding a session on this server is
/// already inside the house.
pub async fn household(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let me = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?
        .id;
    let people: Vec<Value> = state
        .db
        .list_users()
        .into_iter()
        .map(|(id, username, _)| json!({ "id": id, "username": username, "me": id == me }))
        .collect();
    Ok(Json(json!({ "people": people })))
}

/// `GET /api/radio` - the next handful for an endless station.
pub async fn radio(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<RadioQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?
        .id;

    let want = q.n.unwrap_or(20).clamp(1, 60);
    let exclude = parse_ids(&q.exclude);
    let features = state.db.all_features();
    if features.is_empty() {
        return Ok(Json(json!({ "tracks": [] })));
    }

    // A listener with barely any history still gets a station; the neutral
    // taste scores everything alike and the weighting below turns it into an
    // honest shuffle rather than an error.
    let mut taste = taste_for(&state, user).unwrap_or(Taste {
        centroid: None,
        tempo: None,
        genres: HashMap::new(),
        heard: HashSet::new(),
    });

    // The seed lends its own feel to the centre. Blending rather than
    // replacing keeps a station from wandering off into whatever one odd song
    // resembles - it is "more like this, for someone like you".
    if let Some(seed_id) = q.seed {
        if let Some(f) = features.iter().find(|f| f.track_id == seed_id) {
            if let (Some(centre), Some(v)) = (taste.centroid.as_mut(), f.lyric_vec.as_ref()) {
                if centre.len() == v.len() {
                    for (c, s) in centre.iter_mut().zip(v.iter()) {
                        *c = 0.5 * *c + 0.5 * *s;
                    }
                }
            } else if taste.centroid.is_none() {
                taste.centroid = f.lyric_vec.clone();
            }
            if let Some(bpm) = f.bpm {
                taste.tempo = Some(match taste.tempo {
                    Some(t) => (t + bpm) / 2.0,
                    None => bpm,
                });
            }
        }
    }

    // Energy moves the target rather than filtering: a hard hour of a quiet
    // listener's library is still their library, just its livelier end.
    let energy = q.energy.unwrap_or(0.0).clamp(-1.0, 1.0);
    if energy != 0.0 {
        if let Some(t) = taste.tempo {
            taste.tempo = Some((t + f64::from(energy) * 28.0).clamp(50.0, 200.0));
        }
    }
    // The audio character the analyser measured, when it has: 0.5 is the
    // middle of the road, and the knob walks either side of it.
    let want_energy = (0.5 + f64::from(energy) * 0.35).clamp(0.05, 0.95);

    // The other half of a blend, when one is asked for: their taste, and what
    // they actually play, so "both of us" can mean something measurable.
    let guest = q.with.filter(|id| *id != user).and_then(|id| {
        taste_for(&state, id).map(|t| {
            let played: HashSet<i64> =
                state.db.top_plays(id, 0, 4000).into_iter().map(|(t, _)| t).collect();
            (t, played)
        })
    });

    // How often each track has been played lately, for the familiarity dial.
    let plays: HashMap<i64, i64> =
        state.db.top_plays(user, 0, 4000).into_iter().collect();
    let most = plays.values().copied().max().unwrap_or(0).max(1) as f32;
    let familiar = q.familiar.unwrap_or(0.5).clamp(0.0, 1.0);

    let mut scored: Vec<(i64, f32)> = features
        .iter()
        .filter(|f| !exclude.contains(&f.track_id) && Some(f.track_id) != q.seed)
        .map(|f| {
            let mut s = score(f, &taste);
            // A blend has to clear a bar with both listeners - see `blended`.
            if let Some((their_taste, their_plays)) = guest.as_ref() {
                let shared = plays.contains_key(&f.track_id) && their_plays.contains(&f.track_id);
                s = blended(s, score(f, their_taste), shared);
            }
            // Measured loudness/character, where the analyser has been.
            if let Some(e) = f.energy {
                let gap = (e - want_energy).abs() as f32;
                s *= 1.0 - 0.45 * gap.min(1.0);
            }
            // Familiarity: a known song's weight rises with the dial, a
            // stranger's falls, and the middle leaves both alone.
            let known = (*plays.get(&f.track_id).unwrap_or(&0) as f32 / most).min(1.0);
            let pull = (familiar - 0.5) * 2.0;
            s *= 1.0 + pull * (known - 0.35);
            (f.track_id, s.max(0.0001))
        })
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(POOL);

    // Draw without replacement, odds proportional to score^SHARPNESS.
    let mut rng = rand::thread_rng();
    let mut picks: Vec<i64> = Vec::with_capacity(want);
    let mut weights: Vec<f32> = scored.iter().map(|(_, s)| s.powf(SHARPNESS)).collect();
    for _ in 0..want.min(scored.len()) {
        let total: f32 = weights.iter().sum();
        if total <= 0.0 {
            break;
        }
        let mut hit = rng.gen_range(0.0..total);
        let mut chosen = 0usize;
        for (i, w) in weights.iter().enumerate() {
            hit -= w;
            if hit <= 0.0 {
                chosen = i;
                break;
            }
        }
        picks.push(scored[chosen].0);
        weights[chosen] = 0.0;
    }

    Ok(Json(json!({ "tracks": picks })))
}
