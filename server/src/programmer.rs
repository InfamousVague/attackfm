//! The programmer: blended radio stations, one per mood, the way a good
//! streaming service builds artist radio - except every ingredient is honest.
//!
//! A station is a real, playable track list written into the `curated` table,
//! so it surfaces beside the daily mixes on Home and Library with no new
//! client contract, plays instantly, and rebuilds in place. Each one blends
//! three pools around one mood cluster:
//!
//!   ANCHORS - the listener's heavy rotation that lives in this mood. The
//!   frequent plays the whole station is recognisably THEIRS by.
//!
//!   DEPTH   - the rest of the library that matches the mood but has not been
//!   worn out: less-played, forgotten, never-tried. The part that makes a
//!   station bigger than a top-tracks list.
//!
//!   FRESH   - the new music. The listener's own auditions (what the collector
//!   fetched and is waiting on a listen to justify) plus recent arrivals,
//!   mood-matched. This is the only place unadopted auditions enter a built
//!   list, on purpose: a station is explicitly a place for hearing new things,
//!   and playing one through IS the adoption rule working as designed.
//!
//! What a station wants but does not have - the trending and pool candidates
//! that match its mood - it does not fetch itself. The mood term in discovery
//! scoring raises exactly those candidates, the collector buys on that score,
//! the home server fetches, and the landed files enter the FRESH pool on the
//! next rebuild. One buying door, the loop closed through it.

use crate::db::TrackFeatures;
use crate::mood::{self, MoodProfile};
use crate::AppState;
use std::collections::HashMap;
use std::sync::Arc;

/// Stations rebuild with the mood profile - daily, effectively.
const FRESH_MS: i64 = 20 * 60 * 60 * 1000;
const LIST_LEN: usize = 30;
const PER_ARTIST_CAP: usize = 2;
/// The blend, in thirtieths.
const ANCHOR_SHARE: usize = 16;
const DEPTH_SHARE: usize = 8;
const FRESH_SHARE: usize = 6;
/// How far back "heavy rotation" and "recent arrival" look.
const PLAYS_WINDOW_MS: i64 = 30 * 86_400_000;

/// How far along the road from "typical library track" to "as close as the
/// artist's own records" a stranger must travel to join their station.
///
/// The first floor here was a share of the artist's own cohesion in absolute
/// cosine - and it excluded NOBODY, because text-embedding spaces are
/// anisotropic: everything lives in a narrow cone, the whole library sits at
/// 0.7+ to any centre, and 75% of 0.85 is a bar the furthest stranger clears
/// lying down (Katy Perry stayed on Wet Leg Radio to prove it, alongside an
/// audiobook chapter). What separates neighbours from strangers is not the
/// cosine's absolute size but where it falls between the POPULATION mean and
/// the artist's own mean - so that is the scale the floor lives on now.
const NEIGHBOUR_FLOOR_SHARE: f32 = 0.6;
/// The starvation fallback relaxes to here on the same scale - still closer
/// to the artist than the library's average, never just "least far".
const NEIGHBOUR_RELAX_SHARE: f32 = 0.3;
/// Below this gap between the artist's own cohesion and the population mean
/// the centre separates nothing, and picking "nearest" would be picking
/// noise - the station stays spine-only instead.
const SEPARATION_MIN: f32 = 0.02;

/// The bar a would-be neighbour must clear: `share` of the way from the
/// population's mean closeness to the artist's own.
fn similarity_floor(pop_mean: f32, own_sim: f32, share: f32) -> f32 {
    pop_mean + (own_sim - pop_mean) * share
}
const ARRIVAL_WINDOW_MS: i64 = 21 * 86_400_000;

fn built_key(user: i64) -> String {
    format!("programmer.built.{user}")
}

/// Rebuild one listener's stations if due. Returns whether work was done.
pub async fn cycle(state: &Arc<AppState>, user: i64) -> bool {
    let last = state
        .db
        .meta_get(&built_key(user))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if crate::db::now_ms() - last < FRESH_MS {
        return false;
    }
    let Some(profile) = mood::load(state.as_ref(), user) else { return false };
    build_stations(state, user, &profile);
    let _ = state.db.meta_set(&built_key(user), &crate::db::now_ms().to_string());
    true
}

/// The on-demand door, for the settings actions: rebuild now, clock be damned.
pub fn rebuild_now(state: &Arc<AppState>, user: i64, profile: &MoodProfile) -> usize {
    let n = build_stations(state, user, profile);
    let _ = state.db.meta_set(&built_key(user), &crate::db::now_ms().to_string());
    n
}

fn build_stations(state: &Arc<AppState>, user: i64, profile: &MoodProfile) -> usize {
    // Books are tracks too, but never radio: an audiobook chapter that
    // embeds "near" a band is an artifact of the text space, and one turned
    // up inside an artist station to prove it. Out before anything ranks.
    let all: Vec<crate::db::TrackFeatures> = state
        .db
        .all_features()
        .into_iter()
        .filter(|f| f.kind != "book")
        .collect();
    let plays: HashMap<i64, i64> = state
        .db
        .top_plays(user, crate::db::now_ms() - PLAYS_WINDOW_MS, 500)
        .into_iter()
        .collect();
    let auditions: std::collections::HashSet<i64> =
        state.db.audition_ids(user).into_iter().collect();
    let arrivals: std::collections::HashSet<i64> = state
        .db
        // The peer session widened this to scope auditions per caller - passing
        // the user keeps another listener's unadopted fetches out of "recent".
        .recent_track_ids(crate::db::now_ms() - ARRIVAL_WINDOW_MS, 400, user)
        .into_iter()
        .collect();

    let mut built = 0usize;
    for (i, cluster) in profile.clusters.iter().take(3).enumerate() {
        let slug = format!("station-mood-{}", i + 1);

        // Every library track's closeness to this one cluster.
        let scored: Vec<(f32, &TrackFeatures)> = all
            .iter()
            .filter_map(|f| {
                let v = f.lyric_vec.as_deref().or(f.sonic_vec.as_deref())?;
                if v.len() != cluster.centroid.len() {
                    return None;
                }
                let sim = (cos(&cluster.centroid, v) + 1.0) / 2.0;
                let tempo = match (cluster.bpm, f.bpm) {
                    (Some(a), Some(b)) => (-((a - b).abs() / 30.0)).exp() as f32,
                    _ => 0.5,
                };
                Some((sim * 0.8 + tempo.clamp(0.0, 1.0) * 0.2, f))
            })
            .collect();

        /*
         * Three pools from one scoring, split by what the track IS to this
         * listener rather than re-scored three ways. Auditions are the
         * listener's own only - `quarantined` is true for every unadopted
         * audition on the box, and another person's fetches must not leak
         * into this one's station.
         */
        let anchors: Vec<(f32, &TrackFeatures)> = scored
            .iter()
            .filter(|(_, f)| !f.quarantined && plays.get(&f.track_id).copied().unwrap_or(0) >= 2)
            .map(|(s, f)| (s * (1.0 + plays[&f.track_id] as f32 / 20.0), *f))
            .collect();
        let depth: Vec<(f32, &TrackFeatures)> = scored
            .iter()
            .filter(|(_, f)| !f.quarantined && plays.get(&f.track_id).copied().unwrap_or(0) < 2)
            .map(|(s, f)| (*s, *f))
            .collect();
        let fresh: Vec<(f32, &TrackFeatures)> = scored
            .iter()
            .filter(|(_, f)| {
                auditions.contains(&f.track_id)
                    || (!f.quarantined && arrivals.contains(&f.track_id))
            })
            .map(|(s, f)| (*s, *f))
            .collect();

        /*
         * Base shares first, THEN see what fresh really has left. A recent
         * arrival with two plays sits in both the anchors pool and the fresh
         * pool; counting it toward fresh before the anchors took it left the
         * fresh budget spent on tracks fresh could no longer contribute, and
         * the station shipped short. The unused fresh budget goes to depth,
         * which always has more.
         */
        let mut ids = take_spread(anchors, ANCHOR_SHARE);
        let picked: std::collections::HashSet<i64> = ids.iter().copied().collect();
        let depth: Vec<(f32, &TrackFeatures)> =
            depth.into_iter().filter(|(_, f)| !picked.contains(&f.track_id)).collect();
        ids.extend(take_spread(depth.clone(), DEPTH_SHARE));
        let picked: std::collections::HashSet<i64> = ids.iter().copied().collect();
        let fresh: Vec<(f32, &TrackFeatures)> =
            fresh.into_iter().filter(|(_, f)| !picked.contains(&f.track_id)).collect();
        let fresh_ids = take_spread(fresh, FRESH_SHARE);
        let fresh_count = fresh_ids.len();
        if fresh_count < FRESH_SHARE {
            let more: Vec<(f32, &TrackFeatures)> = depth
                .into_iter()
                .filter(|(_, f)| !picked.contains(&f.track_id))
                .collect();
            ids.extend(take_spread(more, FRESH_SHARE - fresh_count));
        }

        // The new music is threaded through, not stacked at the end: every
        // fourth-ish slot from the third onward, the way a station actually
        // slips an unfamiliar song between two it knows you like.
        let mut list = Vec::with_capacity(ids.len() + fresh_ids.len());
        let mut fi = fresh_ids.into_iter();
        for (n, id) in ids.into_iter().enumerate() {
            list.push(id);
            if n >= 2 && (n - 2) % 4 == 0 {
                if let Some(f) = fi.next() {
                    list.push(f);
                }
            }
        }
        list.extend(fi);
        list.truncate(LIST_LEN);

        if list.len() < 8 {
            let _ = state.db.delete_curated(user, &slug);
            continue;
        }

        let name = format!("{} Radio", cluster.name);
        let blurb = if fresh_count > 0 {
            format!(
                "{} And {fresh_count} you have never heard, tucked in between.",
                station_blurb(cluster),
            )
        } else {
            station_blurb(cluster)
        };
        let _ = state.db.put_curated(user, &slug, &name, &blurb, &list);
        built += 1;
    }

    // Tidy the slots a shrunken profile no longer fills.
    for i in profile.clusters.len().min(3)..3 {
        let _ = state.db.delete_curated(user, &format!("station-mood-{}", i + 1));
    }

    /*
     * And two stations built around the ARTISTS this listener actually plays -
     * the other thing "radio" means. A mood station answers "more of how I
     * feel"; an artist station answers "more like them": a spine of the
     * artist's own records, the library around them by embedding similarity,
     * and the fresh pool where it leans their way. The seed artist is exempt
     * from the per-artist cap inside their own station, obviously - the cap
     * exists to stop one artist swallowing a MIX.
     */
    let top = state.db.top_artists(user, crate::db::now_ms() - PLAYS_WINDOW_MS, 4);
    let mut artist_built = 0usize;
    for (name, _) in top.iter() {
        if artist_built >= 2 {
            break;
        }
        let slug = format!("station-artist-{}", artist_built + 1);
        let theirs: Vec<&TrackFeatures> = all
            .iter()
            .filter(|f| !f.quarantined && f.artist.eq_ignore_ascii_case(name))
            .collect();
        if theirs.len() < 4 {
            continue;
        }
        // The artist's own centre: the mean of their tracks' vectors.
        let dims = theirs
            .iter()
            .filter_map(|f| f.lyric_vec.as_ref().or(f.sonic_vec.as_ref()).map(|v| v.len()))
            .next()
            .unwrap_or(0);
        if dims == 0 {
            continue;
        }
        let mut centre = vec![0f32; dims];
        let mut n = 0usize;
        for f in &theirs {
            if let Some(v) = f.lyric_vec.as_deref().or(f.sonic_vec.as_deref()) {
                if v.len() == dims {
                    for (c, x) in centre.iter_mut().zip(v) {
                        *c += x;
                    }
                    n += 1;
                }
            }
        }
        if n == 0 {
            continue;
        }
        for c in centre.iter_mut() {
            *c /= n as f32;
        }


        // The spine: their records, most-played first, up to a dozen.
        let mut spine: Vec<(i64, i64)> = theirs
            .iter()
            .map(|f| (plays.get(&f.track_id).copied().unwrap_or(0), f.track_id))
            .map(|(p, id)| (id, p))
            .collect();
        spine.sort_by(|a, b| b.1.cmp(&a.1));
        let mut ids: Vec<i64> = spine.into_iter().take(12).map(|(id, _)| id).collect();

        // The neighbourhood: everyone else, by closeness to the centre.
        let picked: std::collections::HashSet<i64> = ids.iter().copied().collect();
        let near: Vec<(f32, &TrackFeatures)> = all
            .iter()
            .filter(|f| {
                !f.quarantined
                    && !picked.contains(&f.track_id)
                    && !f.artist.eq_ignore_ascii_case(name)
            })
            .filter_map(|f| {
                let v = f.lyric_vec.as_deref().or(f.sonic_vec.as_deref())?;
                if v.len() != dims {
                    return None;
                }
                Some((cos(&centre, v), f))
            })
            .collect();
        // The two means the floor lives between: how close the artist's own
        // records sit to their centre, and how close EVERYTHING ELSE does.
        // The gap between them is the only real signal in an anisotropic
        // space - absolute cosines here are all large and all meaningless.
        let own_sim = {
            let mut sum = 0f32;
            let mut cnt = 0usize;
            for f in &theirs {
                if let Some(v) = f.lyric_vec.as_deref().or(f.sonic_vec.as_deref()) {
                    if v.len() == dims {
                        sum += cos(&centre, v);
                        cnt += 1;
                    }
                }
            }
            if cnt == 0 {
                continue;
            }
            sum / cnt as f32
        };
        let pop_mean = if near.is_empty() {
            own_sim
        } else {
            near.iter().map(|(c, _)| *c).sum::<f32>() / near.len() as f32
        };

        /*
         * Floored, then relaxed only against starvation. When the artist's
         * own cohesion does not separate from the population at all, the
         * centre knows nothing and the station stays spine-only rather than
         * dressing noise as a neighbourhood.
         */
        let separated = own_sim - pop_mean >= SEPARATION_MIN;
        let floor = similarity_floor(pop_mean, own_sim, NEIGHBOUR_FLOOR_SHARE);
        let (mut close, far): (Vec<_>, Vec<_>) = if separated {
            near.into_iter().partition(|(c, _)| *c >= floor)
        } else {
            (Vec::new(), Vec::new())
        };
        if separated && ids.len() + close.len() < 8 {
            let relax = similarity_floor(pop_mean, own_sim, NEIGHBOUR_RELAX_SHARE);
            let mut fallback: Vec<_> = far.into_iter().filter(|(c, _)| *c >= relax).collect();
            fallback.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let need = (8 - ids.len()).saturating_sub(close.len());
            close.extend(fallback.into_iter().take(need));
        }
        ids.extend(take_spread(close, 12));

        // The fresh slice, where it leans this artist's way.
        let picked: std::collections::HashSet<i64> = ids.iter().copied().collect();
        let fresh: Vec<(f32, &TrackFeatures)> = all
            .iter()
            .filter(|f| {
                !picked.contains(&f.track_id)
                    && (auditions.contains(&f.track_id)
                        || (!f.quarantined && arrivals.contains(&f.track_id)))
            })
            .filter_map(|f| {
                let v = f.lyric_vec.as_deref().or(f.sonic_vec.as_deref())?;
                if v.len() != dims {
                    return None;
                }
                Some((cos(&centre, v), f))
            })
            // The same floor, and NO starvation relaxation: fresh slots are a
            // bonus, not structure, and this is exactly where a chart
            // audition would otherwise slide into a station it does not
            // belong to. Nothing close enough means fewer fresh slots.
            .filter(|(c, _)| separated && *c >= floor)
            .collect();
        let fresh_ids = take_spread(fresh, 6);
        let fresh_count = fresh_ids.len();

        let mut list = Vec::with_capacity(LIST_LEN);
        let mut fi = fresh_ids.into_iter();
        for (i, id) in ids.into_iter().enumerate() {
            list.push(id);
            if i >= 2 && (i - 2) % 4 == 0 {
                if let Some(f) = fi.next() {
                    list.push(f);
                }
            }
        }
        list.extend(fi);
        list.truncate(LIST_LEN);
        if list.len() < 8 {
            continue;
        }

        let blurb = if fresh_count > 0 {
            format!(
                "Their records, the library around them, and {fresh_count} you have never heard."
            )
        } else {
            "Their records, and the library that lives near them.".to_string()
        };
        let _ = state.db.put_curated(user, &slug, &format!("{name} Radio"), &blurb, &list);
        artist_built += 1;
        built += 1;
    }
    for i in artist_built..2 {
        let _ = state.db.delete_curated(user, &format!("station-artist-{}", i + 1));
    }
    built
}

fn station_blurb(cluster: &crate::mood::MoodCluster) -> String {
    if !cluster.blurb.is_empty() {
        return cluster.blurb.clone();
    }
    format!("Where your listening has been living: {}.", cluster.tags.join(", "))
}

fn cos(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na < 1e-6 || nb < 1e-6 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// Best-first with an artist cap - the curator's own idiom, reproduced here
/// because its copy is private and borrows differently.
fn take_spread(mut ranked: Vec<(f32, &TrackFeatures)>, n: usize) -> Vec<i64> {
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for (_, f) in ranked {
        let count = per_artist.entry(f.artist.to_lowercase()).or_default();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn feat(id: i64, artist: &str, vec: Vec<f32>, quarantined: bool) -> TrackFeatures {
        TrackFeatures {
            track_id: id,
            artist: artist.into(),
            lyric_vec: Some(vec),
            quarantined,
            ..Default::default()
        }
    }

    /// The artist cap holds however good one artist's scores are.
    #[test]
    fn the_floor_lives_between_the_population_and_the_artist() {
        // Anisotropic reality: population at 0.75, the artist's own records
        // at 0.87. The bar lands 60% of the way up the gap - 0.822 - which
        // a typical library track (0.75-0.78) cannot clear.
        assert!((similarity_floor(0.75, 0.87, NEIGHBOUR_FLOOR_SHARE) - 0.822).abs() < 1e-4);
        // The starvation relax stays closer to the artist than the average
        // library track - never just "least far".
        let relax = similarity_floor(0.75, 0.87, NEIGHBOUR_RELAX_SHARE);
        assert!(relax > 0.75 && relax < 0.822);
    }

    #[test]
    fn take_spread_caps_an_artist() {
        let a = feat(1, "A", vec![1.0], false);
        let b = feat(2, "A", vec![1.0], false);
        let c = feat(3, "A", vec![1.0], false);
        let d = feat(4, "B", vec![1.0], false);
        let ranked = vec![(0.9, &a), (0.8, &b), (0.7, &c), (0.6, &d)];
        let ids = take_spread(ranked, 4);
        assert_eq!(ids, vec![1, 2, 4], "the third A is skipped for the first B");
    }
}
