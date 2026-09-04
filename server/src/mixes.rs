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
//!
//! WHAT "TOO RANDOM" MEANT, and what each rule below answers.
//!
//! The listener's own complaint about these cards was that they were random.
//! They were not - there is no RNG in this file - but four things made them
//! read that way. Membership was "nearest centroid" while the ORDER was the
//! global taste score, so every lane opened on the same flavour of best-fit
//! song and the lane's own character was buried mid-list. The lanes shipped
//! in score order, thirty tracks from fifteen artists with no flow between
//! them. Nothing they had pushed away was kept out. And the clustering ran on
//! prose embeddings of genre words, where songs that are DESCRIBED alike sit
//! together whether or not they sound alike.
//!
//! So: a lane's key is half closeness-to-the-lane and half taste, tilted to
//! the lane's own era; the lane opens on the tracks that defined it and then
//! climbs by tempo; the cluster and the bucketing both live in the measured
//! audio space when the profile has it; and a song or artist they dismissed
//! is out of every card. Each list is a maths-built lane whose top is
//! characteristic of the lane. Nothing here asks a model for an id.
//!
//! The builders are split into a pure PLAN (what to write, what to delete)
//! and a thin APPLY, so the arithmetic can be tested without a running hub.
use crate::curator::{cosine, ramp, take_spread, title_case, Rejections, LIST_LEN};
use crate::db::TrackFeatures;
use crate::enrichment::CONTROLLED_MOODS;
use crate::mood::{MoodCluster, MoodProfile};
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
/// At most this many by one artist in a daylist or mood mix - the curator's
/// own cap, so a favourite cannot fill a card.
const ARTIST_CAP: usize = 2;
/// A Daily Mix lets one artist in three times. A lane is a mood, and a mood
/// often has a face: the person whose records defined it should be allowed
/// to appear more than twice in thirty.
const DAILY_ARTIST_CAP: usize = 3;
/// How many of a cluster's exemplars open its lane.
const LEAD_EXEMPLARS: usize = 3;
/// How many of the listener's own unheard auditions close a lane.
const TAIL_PULLS: usize = 4;
/// The era tilt's scale, in years: a track this far from the lane's median
/// year keeps 1/e of its key. Eight years is a scene's lifetime, roughly.
const ERA_YEARS: f64 = 8.0;

/// One card the plan wants on the shelf.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Card {
    pub slug: String,
    pub name: String,
    pub blurb: String,
    pub ids: Vec<i64>,
}

/// What a builder decided: cards to upsert, slugs to sweep.
#[derive(Debug, Default)]
pub(crate) struct Plan {
    pub write: Vec<Card>,
    pub delete: Vec<String>,
}

/// A track this listener may be dealt: in the library (not someone else's
/// unadopted audition), a song and never a book chapter, and nothing they
/// pushed away - not a song they bailed on (`taste.rejected`), not a song or
/// an artist they dismissed from the shelf by name (`Rejections`).
#[inline]
pub(crate) fn eligible(f: &TrackFeatures, user: i64, taste: &UserTaste, rej: &Rejections) -> bool {
    f.kind != "book"
        && (!f.quarantined || f.curator_user_id == Some(user))
        && !taste.rejected.contains(&f.track_id)
        && !rej.blocks(f)
}

/// The centroid a lane is bucketed against: the measured-audio one when the
/// profile was drawn by ear, else the prose one it was drawn by.
#[inline]
fn lane_centroid(c: &MoodCluster) -> &[f32] {
    c.sound_centroid.as_deref().unwrap_or(&c.centroid)
}

/// The vector a track is placed by, in the SAME space as the centroid it is
/// measured against: the fingerprint first, then lyric, then sonic - the
/// first whose dimensions match. A track that cannot answer in the lane's
/// space finds no home there rather than being scored against the wrong
/// kind of vector.
#[inline]
fn embed(f: &TrackFeatures, dims: usize) -> Option<&Vec<f32>> {
    [f.audio_fingerprint.as_ref(), f.lyric_vec.as_ref(), f.sonic_vec.as_ref()]
        .into_iter()
        .flatten()
        .find(|v| v.len() == dims)
}

/// The lane a track belongs to and how close it sits, or None when it has no
/// vector in any lane's space or lies at or beyond a right angle from all of
/// them (cosine <= 0: no home).
fn nearest(f: &TrackFeatures, clusters: &[MoodCluster]) -> Option<(usize, f32)> {
    let mut best = (0usize, f32::MIN);
    for (i, c) in clusters.iter().enumerate() {
        let cen = lane_centroid(c);
        let Some(v) = embed(f, cen.len()) else { continue };
        let sim = cosine(cen, v);
        if sim > best.1 {
            best = (i, sim);
        }
    }
    (best.1 > 0.0).then_some(best)
}

/// How far a track's year sits from a lane's, as a multiplier in (0, 1]:
/// 1 when either is unknown, and never a hard cut - a 1994 song in a 2019
/// lane is not excluded, only asked to earn its seat harder.
fn era_tilt(f: &TrackFeatures, c: &MoodCluster) -> f32 {
    match (f.year.filter(|y| *y > 1900), c.year) {
        (Some(y), Some(cy)) => (-((y - cy).abs() as f64 / ERA_YEARS)).exp() as f32,
        _ => 1.0,
    }
}

/// The Daily Mix key: half how characteristic of the lane, half how much
/// this listener likes it, tilted toward the lane's era. The global taste
/// score used to be the whole key, so every lane opened on the same handful
/// of best-fit songs and the lane's own thread was never what you heard first.
pub(crate) fn lane_key(f: &TrackFeatures, cos: f32, c: &MoodCluster, taste: &UserTaste) -> f32 {
    (0.5 * ((cos + 1.0) / 2.0) + 0.5 * score(f, taste)) * era_tilt(f, c)
}

/// The daylist key: closeness TIMES taste, so a song they dislike cannot
/// win a daypart on proximity alone - closeness used to be the whole story.
pub(crate) fn daylist_key(f: &TrackFeatures, cos: f32, taste: &UserTaste) -> f32 {
    cos * score(f, taste)
}

/// Which lane is written as `daily-1`: the one whose listening peaks in the
/// current UTC quarter-day, when there is one, else the biggest. A gentle
/// time-of-day tilt using data the profile already carries; the lanes
/// themselves do not change, only which one leads the shelf.
pub(crate) fn lane_order(clusters: &[MoodCluster], hour_bucket: usize) -> Vec<usize> {
    let bucket = hour_bucket.min(3);
    let tilted = clusters
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            let h = c.hours[bucket];
            h > 0.0 && c.hours.iter().all(|x| *x <= h)
        })
        .max_by(|(ia, a), (ib, b)| {
            a.hours[bucket]
                .partial_cmp(&b.hours[bucket])
                .unwrap_or(std::cmp::Ordering::Equal)
                // Equal peaks: the earlier (bigger-share) lane leads.
                .then_with(|| ib.cmp(ia))
        })
        .map(|(i, _)| i);
    let mut order: Vec<usize> = Vec::with_capacity(clusters.len());
    if let Some(t) = tilted {
        order.push(t);
    }
    order.extend((0..clusters.len()).filter(|i| Some(*i) != tilted));
    order
}

/// Numbered Daily Mixes: the owned library partitioned by nearest mood
/// centroid, each lane keyed half by closeness and half by taste, opened by
/// the cluster's own exemplars, ramped by tempo, and closed by up to four of
/// the listener's own unheard auditions that belong to that mood. `daily-1..N`,
/// N the profile's cluster count; `daily-1` is the lane for this time of day
/// when one stands out, else the biggest.
pub(crate) fn plan_daily(
    user: i64,
    all: &[TrackFeatures],
    by_id: &HashMap<i64, &TrackFeatures>,
    profile: &MoodProfile,
    taste: &UserTaste,
    rej: &Rejections,
    hour_bucket: usize,
) -> Plan {
    let k = profile.clusters.len().min(MAX_DAILY);
    let clusters = &profile.clusters[..k];
    let mut buckets: Vec<Vec<(f32, &TrackFeatures)>> = vec![Vec::new(); k];
    let mut pulls: Vec<Vec<(f32, &TrackFeatures)>> = vec![Vec::new(); k];
    for f in all.iter().filter(|f| eligible(f, user, taste, rej)) {
        let Some((i, cos)) = nearest(f, clusters) else { continue };
        let key = lane_key(f, cos, &clusters[i], taste);
        buckets[i].push((key, f));
        if f.quarantined && f.curator_user_id == Some(user) {
            pulls[i].push((key, f));
        }
    }

    let mut plan = Plan::default();
    for (pos, &ci) in lane_order(clusters, hour_bucket).iter().enumerate() {
        let slug = format!("daily-{}", pos + 1);
        let c = &clusters[ci];
        let bucket = std::mem::take(&mut buckets[ci]);

        // The lane opens on the tracks that DEFINED it - the heaviest plays
        // in the cluster - so what you hear first is the mood itself.
        let mut per_artist: HashMap<String, usize> = HashMap::new();
        let mut lead: Vec<i64> = Vec::new();
        for id in c.exemplar_ids.iter().take(LEAD_EXEMPLARS) {
            let Some(f) = by_id.get(id) else { continue };
            if lead.contains(id) || !eligible(f, user, taste, rej) {
                continue;
            }
            let n = per_artist.entry(f.artist.to_lowercase()).or_insert(0);
            if *n >= DAILY_ARTIST_CAP {
                continue;
            }
            *n += 1;
            lead.push(*id);
        }
        let seated: HashSet<i64> = lead.iter().copied().collect();

        // The body, by lane key with the artist cap - counted ACROSS the
        // exemplars too, so the lane's face does not get three more seats
        // on top of the three it opened with.
        let rest: Vec<(f32, &TrackFeatures)> =
            bucket.into_iter().filter(|(_, f)| !seated.contains(&f.track_id)).collect();
        let want = LIST_LEN.saturating_sub(lead.len());
        let mut body: Vec<i64> = Vec::with_capacity(want);
        for id in take_spread(rest, LIST_LEN, DAILY_ARTIST_CAP) {
            if body.len() >= want {
                break;
            }
            let Some(f) = by_id.get(&id) else { continue };
            let n = per_artist.entry(f.artist.to_lowercase()).or_insert(0);
            if *n >= DAILY_ARTIST_CAP {
                continue;
            }
            *n += 1;
            body.push(id);
        }
        // Then it climbs: tempo ascending through the body.
        let mut ids = lead;
        ids.extend(ramp(body, by_id));

        // And closes on what the collector fetched for THIS listener that
        // belongs to this mood and did not win a seat on merit - pool music
        // reaching the shelf, per person, past the ramp so the lane's flow
        // is not broken by songs they have never heard.
        let on_list: HashSet<i64> = ids.iter().copied().collect();
        let mut tail = std::mem::take(&mut pulls[ci]);
        tail.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.1.added_at.cmp(&a.1.added_at))
                .then_with(|| b.1.track_id.cmp(&a.1.track_id))
        });
        ids.extend(
            tail.into_iter()
                .map(|(_, f)| f.track_id)
                .filter(|id| !on_list.contains(id))
                .take(TAIL_PULLS),
        );

        if ids.len() >= MIN_LIST {
            let blurb = if c.blurb.is_empty() {
                if c.tags.is_empty() {
                    "Songs you keep coming back to.".to_string()
                } else {
                    format!("{} — songs you keep coming back to.", c.tags.join(", "))
                }
            } else {
                c.blurb.clone()
            };
            plan.write.push(Card { slug, name: format!("Daily Mix {}", pos + 1), blurb, ids });
        } else {
            plan.delete.push(slug);
        }
    }
    // Strand no stale card when the profile shrinks: delete only the slugs for
    // clusters that no longer exist (indices at/after `k`). Thin buckets WITHIN
    // 0..k were already deleted in the loop above by their own else-branch -
    // sweeping from the success COUNT would wrongly wipe a later mix that was
    // written when an earlier bucket came up thin.
    for i in k..MAX_DAILY {
        plan.delete.push(format!("daily-{}", i + 1));
    }
    for n in 1..=3 {
        plan.delete.push(format!("mix-{n}"));
    }
    plan
}

/// Daylist: one card per UTC quarter-day, drawn from the cluster this listener
/// most lives in during that window. `hours[]` is UTC (the server has no
/// timezone); the client picks the bucket for its own local time and retitles
/// the one it shows by daypart ("Tuesday morning").
pub(crate) fn plan_daylist(
    user: i64,
    all: &[TrackFeatures],
    by_id: &HashMap<i64, &TrackFeatures>,
    profile: &MoodProfile,
    taste: &UserTaste,
    rej: &Rejections,
) -> Plan {
    let mut plan = Plan::default();
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
            plan.delete.push(slug);
            continue;
        };
        let cen = lane_centroid(c);
        let ranked: Vec<(f32, &TrackFeatures)> = all
            .iter()
            .filter(|f| eligible(f, user, taste, rej))
            .filter_map(|f| embed(f, cen.len()).map(|v| (daylist_key(f, cosine(cen, v), taste), f)))
            .collect();
        let ids = ramp(take_spread(ranked, LIST_LEN, ARTIST_CAP), by_id);
        if ids.len() >= MIN_LIST {
            let blurb = if c.blurb.is_empty() {
                c.tags.join(", ")
            } else {
                c.blurb.clone()
            };
            // Name it by the MOOD; the client overrides the heading with the
            // live daypart and keeps this as the card's label.
            plan.write.push(Card { slug, name: c.name.clone(), blurb, ids });
        } else {
            plan.delete.push(slug);
        }
    }
    plan
}

/// The listener's moods, heaviest first, by what the LEDGER says they played:
/// each track's summed positive verdict weight, spread over the controlled
/// mood words it carries. Ties break on the word, so a HashMap's order never
/// decides which mood gets a card.
pub(crate) fn ranked_moods<'a>(
    by_id: &'a HashMap<i64, &TrackFeatures>,
    taste: &UserTaste,
    ledger: &HashMap<i64, f32>,
) -> Vec<(&'a str, f64)> {
    let mut tally: HashMap<&str, f64> = HashMap::new();
    for (id, w) in ledger {
        if *w <= 0.0 || taste.rejected.contains(id) {
            continue;
        }
        let Some(f) = by_id.get(id) else { continue };
        if f.kind == "book" {
            continue;
        }
        for m in &f.ai_moods {
            *tally.entry(m.as_str()).or_default() += f64::from(*w);
        }
    }
    let mut ranked: Vec<(&str, f64)> = tally.into_iter().collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(b.0))
    });
    ranked
}

/// Mood/vibe mixes from the controlled ai-vibe vocabulary: the handful of moods
/// this listener plays most, each drawn from across the whole owned library.
/// `mood-<word>`. Data-driven - no hardcoded song lists, no model call.
pub(crate) fn plan_moods(
    user: i64,
    all: &[TrackFeatures],
    by_id: &HashMap<i64, &TrackFeatures>,
    taste: &UserTaste,
    rej: &Rejections,
    ledger: &HashMap<i64, f32>,
) -> Plan {
    let pool: Vec<&TrackFeatures> = all.iter().filter(|f| eligible(f, user, taste, rej)).collect();
    let mut plan = Plan::default();
    let mut written: HashSet<String> = HashSet::new();
    for (word, _) in ranked_moods(by_id, taste, ledger).into_iter().take(TOP_MOODS) {
        let carriers: Vec<(f32, &TrackFeatures)> = pool
            .iter()
            .filter(|f| f.ai_moods.iter().any(|m| m == word))
            .map(|f| (score(f, taste), *f))
            .collect();
        if carriers.len() < MOOD_CARRIER_FLOOR {
            continue;
        }
        let ids = ramp(take_spread(carriers, LIST_LEN, ARTIST_CAP), by_id);
        if ids.len() >= MIN_LIST {
            let slug = format!("mood-{word}");
            let name = title_case(word);
            written.insert(slug.clone());
            plan.write.push(Card {
                slug,
                blurb: format!("{name} tracks from your library."),
                name,
                ids,
            });
        }
    }
    // Sweep vibe words that fell out of the top set. Only the controlled vibe
    // vocabulary is swept - it never contains the audio-character activity
    // slugs (chill/workout/late-night/focus), so those are left alone.
    for w in CONTROLLED_MOODS {
        let slug = format!("mood-{w}");
        if !written.contains(&slug) {
            plan.delete.push(slug);
        }
    }
    plan
}

/// Writes a plan to the curated table. Returns how many cards were written.
fn apply(state: &Arc<AppState>, user: i64, plan: Plan) -> usize {
    let n = plan.write.len();
    for card in plan.write {
        let _ = state.db.put_curated(user, &card.slug, &card.name, &card.blurb, &card.ids);
    }
    for slug in plan.delete {
        let _ = state.db.delete_curated(user, &slug);
    }
    n
}

pub fn build_daily(
    state: &Arc<AppState>,
    user: i64,
    all: &[TrackFeatures],
    by_id: &HashMap<i64, &TrackFeatures>,
    profile: &MoodProfile,
    taste: &UserTaste,
    rej: &Rejections,
    hour_bucket: usize,
) -> usize {
    apply(state, user, plan_daily(user, all, by_id, profile, taste, rej, hour_bucket))
}

pub fn build_daylist(
    state: &Arc<AppState>,
    user: i64,
    all: &[TrackFeatures],
    by_id: &HashMap<i64, &TrackFeatures>,
    profile: &MoodProfile,
    taste: &UserTaste,
    rej: &Rejections,
) -> usize {
    apply(state, user, plan_daylist(user, all, by_id, profile, taste, rej))
}

pub fn build_moods(
    state: &Arc<AppState>,
    user: i64,
    all: &[TrackFeatures],
    by_id: &HashMap<i64, &TrackFeatures>,
    taste: &UserTaste,
    rej: &Rejections,
    ledger: &HashMap<i64, f32>,
) -> usize {
    apply(state, user, plan_moods(user, all, by_id, taste, rej, ledger))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: i64 = 7;

    /// A song in the sound space: a 2-d fingerprint, its own artist, a tempo
    /// that rises with its id so a ramp is checkable, and a mood word.
    fn song(id: i64, fp: [f32; 2]) -> TrackFeatures {
        TrackFeatures {
            track_id: id,
            kind: "music".into(),
            artist: format!("Artist {id}"),
            title: format!("Title {id}"),
            audio_fingerprint: Some(fp.to_vec()),
            bpm: Some(80.0 + id as f64),
            energy: Some(0.5),
            added_at: id,
            ai_moods: vec!["dreamy".into()],
            ..Default::default()
        }
    }

    fn cluster(centroid: [f32; 2], hours: [f64; 4]) -> MoodCluster {
        MoodCluster {
            name: "Mood".into(),
            blurb: String::new(),
            share: 1.0,
            bpm: None,
            energy: None,
            tags: vec![],
            exemplar_ids: vec![],
            hours,
            centroid: vec![0.0; 3], // a prose centroid the tracks cannot answer
            sound_centroid: Some(centroid.to_vec()),
            year: None,
        }
    }

    fn profile(clusters: Vec<MoodCluster>) -> MoodProfile {
        MoodProfile { built_at: 0, evidence: 10, clusters }
    }

    fn index(all: &[TrackFeatures]) -> HashMap<i64, &TrackFeatures> {
        all.iter().map(|f| (f.track_id, f)).collect()
    }

    fn card<'a>(plan: &'a Plan, slug: &str) -> &'a Card {
        plan.write.iter().find(|c| c.slug == slug).unwrap_or_else(|| panic!("no {slug} in {plan:?}"))
    }

    /// Twelve songs that all sound like the one lane.
    fn one_lane() -> Vec<TrackFeatures> {
        (1..=12).map(|i| song(i, [1.0, 0.05 * i as f32])).collect()
    }

    /// A song they bailed on, a song they dismissed by name and an artist
    /// they dismissed by name: out of every card, all three builders.
    #[test]
    fn rejected_tracks_and_artists_are_excluded_from_all_three_builders() {
        let all = one_lane();
        let by_id = index(&all);
        let mut taste = UserTaste::cold(ME);
        taste.rejected.insert(3);
        let mut rej = Rejections::default();
        rej.tracks.insert(crate::discovery::key_of("Artist 4", "Title 4"));
        rej.artists.insert(crate::discovery::artist_key_public("Artist 5"));
        let prof = profile(vec![cluster([1.0, 0.0], [1.0, 0.0, 0.0, 0.0])]);
        let ledger: HashMap<i64, f32> = (1..=12).map(|i| (i, 1.0)).collect();

        let daily = plan_daily(ME, &all, &by_id, &prof, &taste, &rej, 0);
        let daylist = plan_daylist(ME, &all, &by_id, &prof, &taste, &rej);
        let moods = plan_moods(ME, &all, &by_id, &taste, &rej, &ledger);
        for (plan, slug) in [(&daily, "daily-1"), (&daylist, "daylist-0"), (&moods, "mood-dreamy")] {
            let ids = &card(plan, slug).ids;
            assert!(ids.len() >= MIN_LIST, "{slug} still ships: {ids:?}");
            for bad in [3, 4, 5] {
                assert!(!ids.contains(&bad), "{slug} dealt rejected track {bad}: {ids:?}");
            }
        }
        // And a book, or somebody else's audition, never was eligible.
        let mut book = song(99, [1.0, 0.0]);
        book.kind = "book".into();
        let mut theirs = song(98, [1.0, 0.0]);
        theirs.quarantined = true;
        theirs.curator_user_id = Some(ME + 1);
        assert!(!eligible(&book, ME, &taste, &rej));
        assert!(!eligible(&theirs, ME, &taste, &rej));
    }

    /// The lane opens on its exemplars - in the profile's order - and then
    /// climbs by tempo through the rest.
    #[test]
    fn exemplars_lead_a_daily_lane_and_the_body_ramps() {
        let all = one_lane();
        let by_id = index(&all);
        let taste = UserTaste::cold(ME);
        let rej = Rejections::default();
        let mut c = cluster([1.0, 0.0], [0.25; 4]);
        c.exemplar_ids = vec![9, 4];
        let prof = profile(vec![c]);

        let plan = plan_daily(ME, &all, &by_id, &prof, &taste, &rej, 0);
        let ids = &card(&plan, "daily-1").ids;
        assert_eq!(&ids[..2], &[9, 4], "the exemplars open the lane: {ids:?}");
        assert_eq!(ids.len(), 12, "and nobody is dealt twice: {ids:?}");
        let body = &ids[2..];
        for w in body.windows(2) {
            assert!(by_id[&w[0]].bpm <= by_id[&w[1]].bpm, "the body climbs: {body:?}");
        }
    }

    /// Three builders, one cycle: the client matches shelves by slug prefix,
    /// so the set of prefixes emitted must not change under it.
    #[test]
    fn slugs_are_unchanged() {
        let all = one_lane();
        let by_id = index(&all);
        let taste = UserTaste::cold(ME);
        let rej = Rejections::default();
        let prof = profile(vec![cluster([1.0, 0.0], [1.0, 0.0, 0.0, 0.0])]);
        let ledger: HashMap<i64, f32> = (1..=12).map(|i| (i, 1.0)).collect();

        let plans = [
            plan_daily(ME, &all, &by_id, &prof, &taste, &rej, 0),
            plan_daylist(ME, &all, &by_id, &prof, &taste, &rej),
            plan_moods(ME, &all, &by_id, &taste, &rej, &ledger),
        ];
        let prefix = |s: &str| s.split('-').next().unwrap().to_string();
        let written: std::collections::BTreeSet<String> =
            plans.iter().flat_map(|p| p.write.iter().map(|c| prefix(&c.slug))).collect();
        let swept: std::collections::BTreeSet<String> =
            plans.iter().flat_map(|p| p.delete.iter().map(|s| prefix(s))).collect();
        assert_eq!(written, ["daily", "daylist", "mood"].map(String::from).into_iter().collect());
        assert_eq!(swept, ["daily", "daylist", "mix", "mood"].map(String::from).into_iter().collect());
        // The names the client keys its dedupe on, verbatim.
        assert_eq!(card(&plans[0], "daily-1").name, "Daily Mix 1");
        assert_eq!(card(&plans[1], "daylist-0").name, "Mood");
        assert_eq!(card(&plans[2], "mood-dreamy").name, "Dreamy");
        assert!(plans[0].delete.iter().any(|s| s == "daily-2") && plans[0].delete.iter().any(|s| s == "mix-1"));
    }

    /// The daylist ranks by closeness TIMES taste: at equal closeness the
    /// song they dislike loses its seat, where closeness alone would have
    /// dealt it.
    #[test]
    fn daylist_ranks_by_closeness_times_taste() {
        // Thirty-one songs, all equally close; one is polka to a listener
        // who has said what they think of polka. Thirty seats.
        let mut all: Vec<TrackFeatures> = (1..=31).map(|i| song(i, [1.0, 0.0])).collect();
        all[30].genre = "polka".into();
        all[0].genre = "rock".into();
        let by_id = index(&all);
        let mut taste = UserTaste::cold(ME);
        taste.tags.insert("polka".into(), -0.9);
        taste.tags.insert("rock".into(), 0.9);
        let rej = Rejections::default();
        let prof = profile(vec![cluster([1.0, 0.0], [1.0, 0.0, 0.0, 0.0])]);

        let polka = &all[30];
        let rock = &all[0];
        assert!(daylist_key(rock, 1.0, &taste) > daylist_key(polka, 1.0, &taste));
        assert!(daylist_key(rock, 0.2, &taste) < daylist_key(rock, 0.9, &taste), "and closeness still counts");

        let plan = plan_daylist(ME, &all, &by_id, &prof, &taste, &rej);
        let ids = &card(&plan, "daylist-0").ids;
        assert_eq!(ids.len(), LIST_LEN);
        assert!(!ids.contains(&31), "the polka song lost its seat: {ids:?}");
        assert!(ids.contains(&1));
    }

    /// The moods are tallied by what the ledger says they played - the
    /// summed positive weight - not by what the model predicts they would
    /// like; ties break on the word so a HashMap's order never decides.
    #[test]
    fn moods_tally_by_the_ledger_not_the_model() {
        let mut a = song(1, [1.0, 0.0]);
        a.ai_moods = vec!["dreamy".into()];
        let mut b = song(2, [1.0, 0.0]);
        b.ai_moods = vec!["bright".into(), "angry".into()];
        let mut bailed = song(3, [1.0, 0.0]);
        bailed.ai_moods = vec!["bleak".into()];
        let all = vec![a, b, bailed];
        let by_id = index(&all);
        let mut taste = UserTaste::cold(ME);
        taste.rejected.insert(3);
        let ledger: HashMap<i64, f32> = [(1, 5.0), (2, 0.1), (3, 40.0)].into_iter().collect();

        let ranked = ranked_moods(&by_id, &taste, &ledger);
        assert_eq!(ranked, vec![("dreamy", 5.0), ("angry", 0.1f32 as f64), ("bright", 0.1f32 as f64)]);
    }

    /// The listener's own unheard auditions that belong to a mood close its
    /// lane, past the ramp, when they did not win a seat on merit - and
    /// never someone else's.
    #[test]
    fn own_pulls_close_a_daily_lane() {
        let mut all: Vec<TrackFeatures> = (1..=32).map(|i| song(i, [1.0, 0.0])).collect();
        // Mine: same mood, but a touch further out, so it ranks last of 32.
        all[31].quarantined = true;
        all[31].curator_user_id = Some(ME);
        all[31].audio_fingerprint = Some(vec![1.0, 0.5]);
        // Theirs: never.
        let mut theirs = song(50, [1.0, 0.0]);
        theirs.quarantined = true;
        theirs.curator_user_id = Some(ME + 1);
        all.push(theirs);
        let by_id = index(&all);
        let taste = UserTaste::cold(ME);
        let rej = Rejections::default();
        let prof = profile(vec![cluster([1.0, 0.0], [0.25; 4])]);

        let plan = plan_daily(ME, &all, &by_id, &prof, &taste, &rej, 0);
        let ids = &card(&plan, "daily-1").ids;
        assert_eq!(ids.len(), LIST_LEN + 1, "thirty on merit, then my one audition: {ids:?}");
        assert_eq!(ids.last(), Some(&32));
        assert!(!ids.contains(&50));
    }

    /// The lane whose listening peaks in the current quarter-day leads the
    /// shelf as `daily-1`; at another hour the biggest lane does.
    #[test]
    fn the_daypart_lane_is_written_first() {
        let mut all: Vec<TrackFeatures> = (1..=10).map(|i| song(i, [1.0, 0.0])).collect();
        all.extend((11..=20).map(|i| song(i, [0.0, 1.0])));
        let by_id = index(&all);
        let taste = UserTaste::cold(ME);
        let rej = Rejections::default();
        let mut big = cluster([1.0, 0.0], [0.7, 0.1, 0.1, 0.1]);
        big.share = 0.6;
        big.exemplar_ids = vec![1];
        let mut small = cluster([0.0, 1.0], [0.1, 0.1, 0.7, 0.1]);
        small.share = 0.4;
        small.exemplar_ids = vec![11];
        let prof = profile(vec![big, small]);

        assert_eq!(lane_order(&prof.clusters, 2), vec![1, 0]);
        assert_eq!(lane_order(&prof.clusters, 0), vec![0, 1]);
        assert_eq!(lane_order(&prof.clusters, 1), vec![0, 1], "no peak here: share order");

        let afternoon = plan_daily(ME, &all, &by_id, &prof, &taste, &rej, 2);
        assert_eq!(card(&afternoon, "daily-1").ids[0], 11, "the afternoon mood leads in the afternoon");
        assert_eq!(card(&afternoon, "daily-2").ids[0], 1);
        let night = plan_daily(ME, &all, &by_id, &prof, &taste, &rej, 0);
        assert_eq!(card(&night, "daily-1").ids[0], 1);
        assert_eq!(card(&night, "daily-2").ids[0], 11);
    }

    /// A track is bucketed in the space the profile was drawn in: the sound
    /// centroid when there is one, and a song that only carries prose finds
    /// no home in a lane drawn by ear rather than a wrong-space score.
    #[test]
    fn buckets_in_the_profiles_space_and_leans_to_its_era() {
        let mut c = cluster([1.0, 0.0], [0.25; 4]);
        c.year = Some(2019);
        let near = song(1, [1.0, 0.0]);
        let mut wordy = song(3, [1.0, 0.0]);
        wordy.audio_fingerprint = None;
        wordy.lyric_vec = Some(vec![0.0; 3]); // prose dims only - the profile's `centroid`, not its lane
        assert_eq!(nearest(&near, std::slice::from_ref(&c)).map(|(i, _)| i), Some(0));
        assert!(nearest(&wordy, std::slice::from_ref(&c)).is_none(), "no vector in the lane's space, no home");
        // A profile drawn in prose (no sound centroid) is answered by prose.
        let mut prose = cluster([9.0, 9.0], [0.25; 4]);
        prose.sound_centroid = None;
        prose.centroid = vec![0.0, 0.0, 1.0];
        let mut wordy_near = song(4, [1.0, 0.0]);
        wordy_near.audio_fingerprint = None;
        wordy_near.lyric_vec = Some(vec![0.0, 0.0, 1.0]);
        assert_eq!(nearest(&wordy_near, std::slice::from_ref(&prose)).map(|(i, s)| (i, s > 0.99)), Some((0, true)));
        assert!(nearest(&near, std::slice::from_ref(&prose)).is_none(), "a fingerprint cannot answer a prose lane");

        let taste = UserTaste::cold(ME);
        let mut same_era = song(4, [1.0, 0.0]);
        same_era.year = Some(2020);
        let mut far_era = song(5, [1.0, 0.0]);
        far_era.year = Some(1996);
        let mut no_year = song(6, [1.0, 0.0]);
        no_year.year = None;
        let k = |f: &TrackFeatures| lane_key(f, 1.0, &c, &taste);
        assert!(k(&same_era) > k(&far_era), "the lane leans to its own era");
        assert!((k(&no_year) - 0.5 * 1.0 - 0.5 * score(&no_year, &taste)).abs() < 1e-6, "unknown year: no tilt");
        assert!((k(&far_era) / k(&no_year) - (-(23.0f64 / ERA_YEARS)).exp() as f32).abs() < 1e-4);
    }
}
