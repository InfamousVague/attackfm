//! Ephemeral personalized shelf cards: numbered Daily Mixes, a time-of-day
//! Daylist, and mood/vibe mixes.
//!
//! Every mix here is a pure function of the latest curate pass - it is written
//! with `put_curated`'s upsert (rebuild-in-place) and, when it no longer earns
//! its keep, removed with `delete_curated`. There is no tombstone and no
//! seeded ledger: unlike the New Music Mix playlist, these are not things a
//! listener curates, they are a reading of what they have been playing, redrawn
//! each cycle. That is the whole point of routing them through the curated
//! table rather than minting real playlists.
//!
//! All three build from the loop in `curator::curate_cycle`, which already
//! holds `all` (every track's features), `by_id`, and `taste` in scope - so
//! this adds no extra `all_features()` scan. The clustering is NOT redone here:
//! we read the mood profile the discovery cycle already persisted (`mood::load`)
//! and organise the OWNED library against its centroids.
use crate::curator::{cosine, take_spread, title_case, LIST_LEN};
use crate::db::TrackFeatures;
use crate::enrichment::CONTROLLED_MOODS;
use crate::mood::MoodProfile;
use crate::taste::{score, UserTaste};
use crate::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Fewest tracks a mix may ship with - below this it is a fragment, not a mix,
/// and it is deleted rather than shown thin. Matches the curator's house floor.
const MIN_LIST: usize = 8;
/// Numbered daily mixes cap at the mood profile's own cluster ceiling
/// (`mood::k_for` tops out at 4); we never invent more lanes than it found.
const MAX_DAILY: usize = 4;
/// A vibe word must sit on at least this many owned tracks before it earns a
/// mood mix - one or two carriers is a coincidence, not a mood.
const MOOD_CARRIER_FLOOR: usize = 8;
/// How many of the listener's most-played moods become mixes.
const TOP_MOODS: usize = 3;

/// A track this listener may be dealt: in the library (not someone else's
/// unadopted audition) and a song, never a book chapter.
#[inline]
fn eligible(f: &TrackFeatures, user: i64) -> bool {
    f.kind != "book" && (!f.quarantined || f.curator_user_id == Some(user))
}

/// The embedding a track is placed by - the SAME choice `mood.rs` builds its
/// centroids from (lyric first, sonic as fallback), so a nearest-centroid
/// assignment here lands a track in the cluster it actually shaped.
#[inline]
fn embed(f: &TrackFeatures) -> Option<&Vec<f32>> {
    f.lyric_vec.as_ref().or(f.sonic_vec.as_ref())
}

/// Numbered Daily Mixes: the owned library partitioned by nearest mood
/// centroid, each lane ranked by taste and artist-capped. `daily-1..N`, N the
/// profile's cluster count (share-ordered, so Daily Mix 1 is the biggest lane).
pub fn build_daily(
    state: &Arc<AppState>,
    user: i64,
    all: &[TrackFeatures],
    profile: &MoodProfile,
    taste: &UserTaste,
) -> usize {
    let k = profile.clusters.len().min(MAX_DAILY);
    let mut buckets: Vec<Vec<(f32, &TrackFeatures)>> = vec![Vec::new(); k];
    if k > 0 {
        for f in all.iter().filter(|f| eligible(f, user)) {
            let Some(v) = embed(f) else { continue };
            // Nearest centroid. cosine returns 0.0 on a dim mismatch, so a
            // track whose embedding does not match any centroid's dimensions
            // simply finds no home (best stays <= 0) and is left out.
            let mut best = (0usize, f32::MIN);
            for (i, c) in profile.clusters.iter().take(k).enumerate() {
                let sim = cosine(&c.centroid, v);
                if sim > best.1 {
                    best = (i, sim);
                }
            }
            if best.1 <= 0.0 {
                continue;
            }
            buckets[best.0].push((score(f, taste), f));
        }
    }

    let mut built = 0usize;
    for (i, bucket) in buckets.into_iter().enumerate() {
        let slug = format!("daily-{}", i + 1);
        let ids = take_spread(bucket, LIST_LEN);
        if ids.len() >= MIN_LIST {
            let c = &profile.clusters[i];
            let blurb = if c.blurb.is_empty() {
                if c.tags.is_empty() {
                    "Songs you keep coming back to.".to_string()
                } else {
                    format!("{} — songs you keep coming back to.", c.tags.join(", "))
                }
            } else {
                c.blurb.clone()
            };
            let _ = state
                .db
                .put_curated(user, &slug, &format!("Daily Mix {}", i + 1), &blurb, &ids);
            built += 1;
        } else {
            let _ = state.db.delete_curated(user, &slug);
        }
    }
    // Strand no stale card when the profile shrinks: delete only the slugs for
    // clusters that no longer exist (indices at/after `k`). Thin buckets WITHIN
    // 0..k were already deleted in the loop above by their own else-branch -
    // sweeping from `built` (a success COUNT, not an index) would wrongly wipe
    // a later mix that was written when an earlier bucket came up thin.
    for i in k..MAX_DAILY {
        let _ = state.db.delete_curated(user, &format!("daily-{}", i + 1));
    }
    for n in 1..=3 {
        let _ = state.db.delete_curated(user, &format!("mix-{n}"));
    }
    built
}

/// Daylist: one card per UTC quarter-day, drawn from the cluster this listener
/// most lives in during that window. `hours[]` is UTC (the server has no
/// timezone); the client picks the bucket for its own local time and retitles
/// the one it shows by daypart ("Tuesday morning").
pub fn build_daylist(
    state: &Arc<AppState>,
    user: i64,
    all: &[TrackFeatures],
    profile: &MoodProfile,
) -> usize {
    let mut built = 0usize;
    for bucket in 0..4usize {
        let slug = format!("daylist-{bucket}");
        let winner = profile
            .clusters
            .iter()
            .filter(|c| c.hours[bucket] > 0.0)
            .max_by(|a, b| {
                a.hours[bucket]
                    .partial_cmp(&b.hours[bucket])
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        let Some(c) = winner else {
            // A window this listener never plays in gets no card.
            let _ = state.db.delete_curated(user, &slug);
            continue;
        };
        let ranked: Vec<(f32, &TrackFeatures)> = all
            .iter()
            .filter(|f| eligible(f, user))
            .filter_map(|f| embed(f).map(|v| (cosine(&c.centroid, v), f)))
            .collect();
        let ids = take_spread(ranked, LIST_LEN);
        if ids.len() >= MIN_LIST {
            let blurb = if c.blurb.is_empty() {
                c.tags.join(", ")
            } else {
                c.blurb.clone()
            };
            // Name it by the MOOD; the client overrides the heading with the
            // live daypart and keeps this as the card's label.
            let _ = state.db.put_curated(user, &slug, &c.name, &blurb, &ids);
            built += 1;
        } else {
            let _ = state.db.delete_curated(user, &slug);
        }
    }
    built
}

/// Mood/vibe mixes from the controlled ai-vibe vocabulary: the handful of moods
/// this listener plays most, each drawn from across the whole owned library.
/// `mood-<word>`. Data-driven - no hardcoded song lists, no model call.
pub fn build_moods(
    state: &Arc<AppState>,
    user: i64,
    all: &[TrackFeatures],
    by_id: &HashMap<i64, &TrackFeatures>,
    taste: &UserTaste,
) -> usize {
    // Weight each mood by how much the listener actually plays the tracks that
    // carry it (skip the ones they have rejected).
    let mut tally: HashMap<&str, f64> = HashMap::new();
    for id in taste.heard.iter().filter(|id| !taste.rejected.contains(id)) {
        let Some(f) = by_id.get(id) else { continue };
        if f.kind == "book" {
            continue;
        }
        let w = f64::from(score(f, taste).max(0.0));
        for m in &f.ai_moods {
            *tally.entry(m.as_str()).or_default() += w;
        }
    }
    let pool: Vec<&TrackFeatures> = all.iter().filter(|f| eligible(f, user)).collect();

    let mut ranked_moods: Vec<(&str, f64)> = tally.into_iter().collect();
    ranked_moods.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut written: HashSet<String> = HashSet::new();
    for (word, _) in ranked_moods.into_iter().take(TOP_MOODS) {
        let carriers: Vec<(f32, &TrackFeatures)> = pool
            .iter()
            .filter(|f| f.ai_moods.iter().any(|m| m == word))
            .map(|f| (score(f, taste), *f))
            .collect();
        if carriers.len() < MOOD_CARRIER_FLOOR {
            continue;
        }
        let ids = take_spread(carriers, LIST_LEN);
        if ids.len() >= MIN_LIST {
            let slug = format!("mood-{word}");
            let name = title_case(word);
            let _ = state.db.put_curated(
                user,
                &slug,
                &name,
                &format!("{name} tracks from your library."),
                &ids,
            );
            written.insert(slug);
        }
    }
    // Sweep vibe words that fell out of the top set. Only the controlled vibe
    // vocabulary is swept - it never contains the audio-character activity
    // slugs (chill/workout/late-night/focus), so those are left alone.
    for w in CONTROLLED_MOODS {
        let slug = format!("mood-{w}");
        if !written.contains(&slug) {
            let _ = state.db.delete_curated(user, &slug);
        }
    }
    written.len()
}
