//! The endless station.
//!
//! A mix is a fixed list built once; a station never ends and answers to the
//! hand on the dial. Both read the same taste the rest of the house keeps -
//! `taste::UserTaste`, the listener's own verdict-weighted model - so a
//! station is not a second opinion about this listener, it is the same
//! opinion asked a different way: "what next", forever, with three knobs.
//!
//!   energy    -1..1  calmer or harder than usual - moves the tempo and
//!                    loudness the scorer is aiming at, so it steers the FEEL
//!                    rather than filtering a genre out.
//!   familiar   0..1  0 is the deep end of your own shelves (things you own
//!                    and rarely play), 1 is the songs you wear out. The
//!                    middle is a normal radio hour.
//!   seed             one track to start from: its own vectors and tempo are
//!                    blended into the centre, so "radio from this song"
//!                    means what it says.
//!
//! Picks are weighted-random rather than the top N, and that is deliberate:
//! the top N of a fixed taste is the same list every time, which is how a
//! station stops feeling alive. Score decides the odds, chance decides the
//! order, and `exclude` carries what the client already has queued so the
//! next page never repeats the last one.
//!
//! What the station now refuses, which it used to deal: another listener's
//! unadopted audition, an audiobook chapter, and anything this listener has
//! said no to (an instant skip, a dismissed card). And it now keeps a ledger
//! of its own - impressions in slot `radio` - so a page dealt yesterday sits
//! out today (`dealt_hold`, one day). The Thompson sampler that seats the DJ
//! set's exploration slots reads ONLY the `rank` and `explore` slots and is
//! deliberately not widened to this one: a radio page is not an offer the
//! listener was asked to judge.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::TrackFeatures;
use crate::dj::{dealable, dealt_hold, nudge_for_hour};
use crate::taste::{self, UserTaste};
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
    /// The listener's LOCAL hour, 0-23, for the light time-of-day tilt.
    /// Optional: an older client sends nothing and gets no tilt.
    pub hour: Option<u32>,
}

/// How many of the best candidates go into the hat. Wide enough that the same
/// hour never plays twice, narrow enough that nothing embarrassing gets in.
const POOL: usize = 160;

/// Odds are the score raised to this: a firm preference for the better
/// candidates without ever making the best one a certainty.
const SHARPNESS: f32 = 3.0;

/// How long a dealt song sits out of the station. A day: the client's own
/// `exclude` already covers one sitting, this covers tomorrow's.
const RADIO_DEALT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

fn parse_ids(raw: &Option<String>) -> HashSet<i64> {
    raw.as_deref()
        .map(|s| s.split(',').filter_map(|p| p.trim().parse::<i64>().ok()).collect())
        .unwrap_or_default()
}

/// Whether one track is in the hat for this listener at all: not already
/// queued, not the seed, dealable to THEM (their own auditions yes, another
/// listener's no, never a book), not dealt lately, and not something they
/// have said no to.
fn admits(
    f: &TrackFeatures,
    user: i64,
    seed: Option<i64>,
    exclude: &HashSet<i64>,
    held: &HashSet<i64>,
    rejected: &HashSet<i64>,
) -> bool {
    !exclude.contains(&f.track_id)
        && Some(f.track_id) != seed
        && dealable(f, user)
        && !held.contains(&f.track_id)
        && !rejected.contains(&f.track_id)
}

/// Half of one vector into another, in place, when the two are the same
/// shape. The seed lends its feel to the centre rather than replacing it.
fn blend_into(centre: &mut Option<Vec<f32>>, v: Option<&Vec<f32>>) {
    match (centre.as_mut(), v) {
        (Some(c), Some(v)) if c.len() == v.len() => {
            for (a, b) in c.iter_mut().zip(v.iter()) {
                *a = 0.5 * *a + 0.5 * *b;
            }
        }
        (None, Some(v)) => *centre = Some(v.clone()),
        _ => {}
    }
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

    // A listener with barely any history still gets a station; the cold
    // model scores everything alike and the weighting below turns it into an
    // honest shuffle rather than an error.
    let (mut taste, features) = match crate::curator::user_taste_for(&state, user) {
        Some(built) => built,
        None => (UserTaste::cold(user), state.db.all_features()),
    };
    if features.is_empty() {
        return Ok(Json(json!({ "tracks": [] })));
    }
    nudge_for_hour(&mut taste, q.hour);

    // The seed lends its own feel to the centre. Blending rather than
    // replacing keeps a station from wandering off into whatever one odd song
    // resembles - it is "more like this, for someone like you".
    if let Some(seed_id) = q.seed {
        if let Some(f) = features.iter().find(|f| f.track_id == seed_id) {
            blend_into(&mut taste.lyric, f.lyric_vec.as_ref());
            blend_into(&mut taste.sonic, f.sonic_vec.as_ref());
            if let Some(bpm) = f.bpm {
                taste.tempo = Some(match taste.tempo {
                    Some((mid, spread)) => ((mid + bpm) / 2.0, spread),
                    None => (bpm, 4.0),
                });
            }
        }
    }

    // Energy moves the target rather than filtering: a hard hour of a quiet
    // listener's library is still their library, just its livelier end.
    let energy = q.energy.unwrap_or(0.0).clamp(-1.0, 1.0);
    if energy != 0.0 {
        if let Some((mid, spread)) = taste.tempo {
            taste.tempo = Some(((mid + f64::from(energy) * 28.0).clamp(50.0, 200.0), spread));
        }
    }
    // The audio character the analyser measured, when it has: 0.5 is the
    // middle of the road, and the knob walks either side of it. The hour
    // leans on the same dial, lightly.
    let (hour_energy, _) = crate::dj::hour_nudge(q.hour);
    let want_energy = (0.5 + f64::from(energy) * 0.35 + hour_energy).clamp(0.05, 0.95);

    // The other half of a blend, when one is asked for: their taste, and what
    // they actually play, so "both of us" can mean something measurable.
    let guest = q.with.filter(|id| *id != user).and_then(|id| {
        crate::curator::user_taste_for(&state, id).map(|(t, _)| {
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

    // What sits out: yesterday's pages, and the listener's no.
    let pool_size = features.iter().filter(|f| dealable(f, user)).count();
    let held = dealt_hold(&state.db, user, RADIO_DEALT_WINDOW_MS, want, pool_size);
    let mut rejected: HashSet<i64> = taste.rejected.clone();
    rejected.extend(crate::discovery::rejected_track_ids(&state.db, user));

    let mut scored: Vec<(i64, f32)> = features
        .iter()
        .filter(|f| admits(f, user, q.seed, &exclude, &held, &rejected))
        .map(|f| {
            let mut s = taste::score(f, &taste);
            // A blend has to clear a bar with both listeners - see `blended`.
            if let Some((their_taste, their_plays)) = guest.as_ref() {
                let shared = plays.contains_key(&f.track_id) && their_plays.contains(&f.track_id);
                s = blended(s, taste::score(f, their_taste), shared);
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

    // The station's own ledger, in its own slot. The dealt hold reads every
    // slot; the exploration sampler reads only the DJ set's two.
    let offered: Vec<(i64, &str, i64)> =
        picks.iter().enumerate().map(|(i, id)| (*id, "radio", i as i64)).collect();
    state.db.record_dj_impressions(user, &offered);

    Ok(Json(json!({ "tracks": picks })))
}

#[cfg(test)]
mod guards {
    use super::*;

    fn feature(id: i64) -> TrackFeatures {
        TrackFeatures {
            kind: "music".into(),
            track_id: id,
            bpm: None,
            curator_user_id: None,
            added_at: 0,
            lyric_vec: None,
            genre: String::new(),
            ai_genres: Vec::new(),
            ai_specific_tags: Vec::new(),
            ai_sonic_traits: Vec::new(),
            artist: "someone".into(),
            energy: None,
            brightness: None,
            dynamic_range: None,
            rhythmic_activity: None,
            musicbrainz_id: String::new(),
            listenbrainz_similar: Vec::new(),
            sonic_vec: None,
            lyrical_vec: None,
            community_vec: None,
            audio_fingerprint: None,
            year: None,
            quarantined: false,
            ai_moods: Vec::new(),
        }
    }

    /// The three leaks the station used to have, and the one door it keeps.
    #[test]
    fn another_listeners_audition_a_book_and_a_no_are_not_dealt() {
        let me = 1;
        let none = HashSet::new();

        let plain = feature(10);
        assert!(admits(&plain, me, None, &none, &none, &none), "the library itself plays");

        let mut theirs = feature(11);
        theirs.quarantined = true;
        theirs.curator_user_id = Some(2);
        assert!(!admits(&theirs, me, None, &none, &none, &none), "somebody else's audition is theirs to judge");

        let mut mine = feature(12);
        mine.quarantined = true;
        mine.curator_user_id = Some(me);
        assert!(admits(&mine, me, None, &none, &none, &none), "my own audition is the door in");

        let mut chapter = feature(13);
        chapter.kind = "book".into();
        assert!(!admits(&chapter, me, None, &none, &none, &none), "an audiobook chapter is not a song");

        let refused: HashSet<i64> = [14].into_iter().collect();
        assert!(!admits(&feature(14), me, None, &none, &none, &refused), "a no is remembered");

        let dealt: HashSet<i64> = [15].into_iter().collect();
        assert!(!admits(&feature(15), me, None, &none, &dealt, &none), "yesterday's page sits out");

        assert!(!admits(&feature(16), me, Some(16), &none, &none, &none), "the seed is not its own answer");
    }
}
