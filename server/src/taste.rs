//! What one listener actually likes, learned from what they actually did.
//!
//! WHY THIS MODULE EXISTS.
//!
//! The curator had a taste model already, and on paper it was per-user. In
//! practice it read the weakest signal in the database - `top_plays`, which is
//! a count of play STARTS, every one weighted 1.0. Starting a song says you
//! were curious. Finishing it says you were right. Skipping it eight seconds in
//! says the machine was wrong, and the old model could not represent that at
//! all: its floor was a positive 0.15, so a song you hated still pulled your
//! centroid toward itself, just more slowly than one you loved.
//!
//! Meanwhile `listen_events` had been recording completion, skips, the played
//! milliseconds, the track's real duration and the SURFACE the play came from,
//! for every listener, the whole time. `favorites` had the hearts. None of it
//! reached a recommendation.
//!
//! So this is not a new signal pipeline. It is the one that was already being
//! written, finally being read.
//!
//! THE COLD-START PROBLEM IS THE DESIGN CONSTRAINT.
//!
//! On the hub this was built against, one listener has 2138 listens and the
//! next has 45; six of ten have fewer than twelve. A model fitted per-user with
//! no regard for sample size gives one person something excellent and everyone
//! else noise wearing a personalised label - which is worse than the global
//! behaviour it replaced, because it is confidently wrong instead of blandly
//! wrong.
//!
//! Every per-user quantity here is therefore SHRUNK toward a library-wide
//! prior in proportion to how little evidence stands behind it (`shrink`). A
//! listener with no history gets the house model exactly. A listener with
//! thousands of verdicts gets almost purely their own. Nobody gets noise.

use std::collections::{HashMap, HashSet};

use crate::db::TrackFeatures;

/// Verdicts older than this stop counting. Long enough to survive a holiday,
/// short enough that last year's phase is not still picking tonight's music.
pub const WINDOW_DAYS: i64 = 180;

/// How long a verdict keeps half its weight. Taste moves over weeks.
const HALF_LIFE_DAYS: f32 = 21.0;

/// Evidence needed before a listener's own weights outrank the house prior.
/// At this many effective verdicts the split is even; see `shrink`.
const WEIGHT_CONFIDENCE: f32 = 120.0;

/// Evidence needed before a listener's tag affinities stand on their own.
/// Lower than the weights: a tag needs far less data to be believable than a
/// whole ranking function does.
const TAG_CONFIDENCE: f32 = 25.0;

/// A skip inside this many milliseconds is a rejection of the CHOICE, not of
/// the song - the listener did not hear enough to judge it, they heard enough
/// to know they did not want it now. Weighted hardest for that reason.
const INSTANT_SKIP_MS: i64 = 15_000;

/// The house ranking, and the value every per-user weight is pulled toward.
/// These are the old hardcoded curator weights (0.45 lyric / 0.30 tempo /
/// 0.25 genre) re-expressed over the wider set of terms now available, with
/// the new terms given deliberately modest starting room: the prior should be
/// close to known-acceptable behaviour, and let evidence earn the rest.
pub const PRIOR: Weights = Weights {
    lyric: 0.34,
    sonic: 0.14,
    tempo: 0.20,
    tags: 0.22,
    energy: 0.10,
};

/// How much each term of the score is worth to one listener.
///
/// These are not tuning knobs. They are fitted per-user against that person's
/// own outcomes (`fit_weights`) and then shrunk toward `PRIOR`, so the shape of
/// the ranking is itself a thing the model learns about you: somebody whose
/// completions track tempo and ignore lyrics ends up with a different function
/// to somebody who plays one genre at every speed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Weights {
    pub lyric: f32,
    pub sonic: f32,
    pub tempo: f32,
    pub tags: f32,
    pub energy: f32,
}

impl Weights {
    pub fn normalized(mut self) -> Self {
        let sum = self.lyric + self.sonic + self.tempo + self.tags + self.energy;
        if sum > 0.0 {
            self.lyric /= sum;
            self.sonic /= sum;
            self.tempo /= sum;
            self.tags /= sum;
            self.energy /= sum;
        } else {
            self = PRIOR;
        }
        self
    }

    /// Move `frac` of the way from the prior to these. `frac` is the shrinkage
    /// factor, so 0 is "no evidence, use the house model".
    pub fn blend_from_prior(self, frac: f32) -> Self {
        let f = frac.clamp(0.0, 1.0);
        let mix = |mine: f32, prior: f32| prior + (mine - prior) * f;
        Weights {
            lyric: mix(self.lyric, PRIOR.lyric),
            sonic: mix(self.sonic, PRIOR.sonic),
            tempo: mix(self.tempo, PRIOR.tempo),
            tags: mix(self.tags, PRIOR.tags),
            energy: mix(self.energy, PRIOR.energy),
        }
    }
}

/// One thing that happened to one track, as the model sees it.
///
/// This is deliberately a plain struct fed from a query rather than something
/// this module fetches itself: the same shape can be built from `listen_events`
/// for the real model and by hand in a test, and neither path can drift.
#[derive(Clone, Debug)]
pub struct Verdict {
    pub track_id: i64,
    /// When it happened, unix seconds.
    pub at: i64,
    /// Milliseconds actually listened.
    pub ms_listened: i64,
    /// The track's real length, when known. Absent for a stream whose
    /// duration never arrived.
    pub duration_ms: Option<i64>,
    pub completed: bool,
    pub skipped: bool,
    /// Which surface the play came from: 'search', 'discover', 'booth', ...
    pub context: String,
    /// Whether the listener has hearted this track.
    pub hearted: bool,
}

impl Verdict {
    /// How much of the track was heard, 0-1, using the REAL duration.
    ///
    /// The old rule was `completed = 1 OR ms_listened >= 30000` everywhere in
    /// the database layer, which is a bar and not a ratio: it scores thirty
    /// seconds of a ninety-second interlude the same as thirty seconds of an
    /// hour-long mix, and calls both of them the same kind of success.
    fn heard_fraction(&self) -> f32 {
        match self.duration_ms {
            Some(d) if d > 0 => (self.ms_listened as f32 / d as f32).clamp(0.0, 1.0),
            // No duration to divide by: fall back to the old bar, but as a
            // ratio against it rather than a cliff.
            _ => (self.ms_listened as f32 / 30_000.0).clamp(0.0, 1.0),
        }
    }

    /// What this verdict says, in [-1, 1]. Negative is evidence AGAINST.
    ///
    /// The sign is the point. The previous model's weakest value was a
    /// positive 0.15, so every skip still dragged the centroid toward the
    /// thing that was skipped - a listener who rejects a genre a hundred times
    /// was slowly taught to like it. Rejection has to be able to push away.
    pub fn sentiment(&self) -> f32 {
        let heard = self.heard_fraction();
        let base = if self.completed {
            1.0
        } else if self.skipped {
            // An instant skip is the strongest negative available; a skip near
            // the end is barely negative at all - they nearly stayed.
            if self.ms_listened <= INSTANT_SKIP_MS {
                -1.0
            } else {
                // -0.6 at a quarter through, easing to +0.1 by the very end.
                (0.1 - (1.0 - heard) * 0.9).clamp(-0.9, 0.1)
            }
        } else {
            // Neither flag: they left. How far they got is the whole story.
            heard * 1.4 - 0.4
        };
        let hearted = if self.hearted { 0.6 } else { 0.0 };
        (base + hearted).clamp(-1.0, 1.0)
    }

    /// How much this verdict counts, before recency.
    ///
    /// CONTEXT IS EVIDENCE ABOUT THE MACHINE, and this is the part the old
    /// model could not express because it never read the column.
    ///
    /// Finishing a song you searched for by name says almost nothing about
    /// whether a recommender would have found it - you already knew. Finishing
    /// a song the machine put in front of you unprompted is the strongest
    /// signal in the building, because the machine made a claim and was right.
    /// Weighting them equally throws away the difference between "I like this"
    /// and "you were right about this", and only the second one can teach a
    /// recommender anything.
    pub fn confidence(&self) -> f32 {
        match self.context.as_str() {
            // The machine chose. Its successes and failures both teach most.
            "discover" | "booth" | "home" | "date" => 1.4,
            // A shelf the machine built, but the listener picked a row.
            "playlist" | "library" | "songs" => 1.0,
            // The listener brought the intent with them.
            "artist" | "album" => 0.7,
            "search" => 0.4,
            // Books are a different product with a different completion curve.
            c if c.starts_with("books") => 0.0,
            _ => 0.9,
        }
    }

    /// Recency decay, 1.0 for today.
    fn recency(&self, now: i64) -> f32 {
        let days = ((now - self.at).max(0) as f32) / 86_400.0;
        0.5f32.powf(days / HALF_LIFE_DAYS)
    }

    /// The signed, decayed contribution this verdict makes.
    pub fn weight(&self, now: i64) -> f32 {
        self.sentiment() * self.confidence() * self.recency(now)
    }
}

/// How far to trust a per-user quantity given how much evidence it has.
///
/// `n / (n + k)`: nothing at zero, half at k, asymptotically all. This one
/// function is what keeps the whole design honest for the nine listeners who
/// have barely used the thing.
pub fn shrink(evidence: f32, k: f32) -> f32 {
    if evidence <= 0.0 {
        return 0.0;
    }
    evidence / (evidence + k)
}

/// One listener's model.
pub struct UserTaste {
    pub user_id: i64,
    /// Total absolute evidence behind this model - the sum of |weight|.
    pub evidence: f32,
    /// Centre of gravity in lyric space, from positively-weighted verdicts.
    pub lyric: Option<Vec<f32>>,
    /// The same for the semantic sonic vector, when enrichment has reached
    /// enough of what they play.
    pub sonic: Option<Vec<f32>>,
    /// Where they sit on tempo, and how wide that is. A listener who plays
    /// 80bpm and 160bpm has no meaningful median, and a point estimate would
    /// invent one; `spread` lets the score know not to be confident.
    pub tempo: Option<(f64, f64)>,
    /// Preferred energy, same shape.
    pub energy: Option<(f64, f64)>,
    /// Signed affinity per tag, already shrunk. Negative means avoid.
    pub tags: HashMap<String, f32>,
    /// This listener's own ranking weights, shrunk toward `PRIOR`.
    pub weights: Weights,
    /// Everything they have met, at any verdict. A discovery list must not
    /// offer back a song they already rejected.
    pub heard: HashSet<i64>,
    /// What they actively pushed away, for a harder exclusion than `heard`.
    pub rejected: HashSet<i64>,
}

impl UserTaste {
    /// The model for someone we know nothing about: the house prior, and no
    /// opinions. Every field degrades to neutral in `score`.
    pub fn cold(user_id: i64) -> Self {
        UserTaste {
            user_id,
            evidence: 0.0,
            lyric: None,
            sonic: None,
            tempo: None,
            energy: None,
            tags: HashMap::new(),
            weights: PRIOR,
            heard: HashSet::new(),
            rejected: HashSet::new(),
        }
    }

    /// The middle of their tempo band, for callers that want one number.
    pub fn tempo_center(&self) -> Option<f64> {
        self.tempo.map(|(m, _)| m)
    }

    /// The tags they actually like, strongest first, as (tag, strength) with
    /// strength in [0, 1]. Negative affinities are omitted: this answers "what
    /// should we build them a mix of", and a mix of something they reject is
    /// not a thing to build.
    pub fn favourite_tags(&self, n: usize) -> Vec<(String, f32)> {
        let mut v: Vec<(String, f32)> = self
            .tags
            .iter()
            .filter(|(_, a)| **a > 0.05)
            .map(|(t, a)| (t.clone(), *a))
            .collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.truncate(n);
        v
    }

    /// How much this listener should be pushed away from what they know.
    ///
    /// Adaptive and deliberately conservative early: a new listener is shown
    /// things close to the little we know works, and the net widens as the
    /// model earns the right to take risks. Returning a fraction rather than a
    /// bool lets each surface decide how much of it to apply - the DJ and the
    /// curated shelves are for listening and want a little, Date and Discover
    /// are for finding and want more.
    pub fn exploration(&self) -> f32 {
        // 0.12 with nothing known, rising toward 0.45 as evidence accumulates.
        0.12 + 0.33 * shrink(self.evidence, 400.0)
    }
}

/// Build a listener's model from their verdicts and the library's features.
///
/// `now` is passed in rather than read from the clock so the whole thing is
/// testable and so a batch build cannot drift mid-pass.
pub fn build(
    user_id: i64,
    verdicts: &[Verdict],
    feats: &HashMap<i64, &TrackFeatures>,
    now: i64,
) -> UserTaste {
    let mut taste = UserTaste::cold(user_id);
    if verdicts.is_empty() {
        return taste;
    }

    let mut lyric_sum: Vec<f32> = Vec::new();
    let mut lyric_w = 0.0f32;
    let mut sonic_sum: Vec<f32> = Vec::new();
    let mut sonic_w = 0.0f32;
    let mut tempos: Vec<(f64, f32)> = Vec::new();
    let mut energies: Vec<(f64, f32)> = Vec::new();
    let mut tag_score: HashMap<String, f32> = HashMap::new();
    let mut tag_seen: HashMap<String, f32> = HashMap::new();

    for v in verdicts {
        taste.heard.insert(v.track_id);
        let w = v.weight(now);
        if w < -0.05 {
            taste.rejected.insert(v.track_id);
        }
        if w == 0.0 {
            continue;
        }
        taste.evidence += w.abs();

        let Some(f) = feats.get(&v.track_id) else { continue };

        // Centroids take POSITIVE evidence only. A centroid is "the middle of
        // what you like"; subtracting disliked tracks from it does not move it
        // away from them, it moves it somewhere neither of you has been.
        // Rejection is expressed through tags and the `rejected` set instead.
        if w > 0.0 {
            if let Some(vec) = &f.lyric_vec {
                accumulate(&mut lyric_sum, &mut lyric_w, vec, w);
            }
            if let Some(vec) = &f.sonic_vec {
                accumulate(&mut sonic_sum, &mut sonic_w, vec, w);
            }
            if let Some(b) = f.bpm {
                tempos.push((b, w));
            }
            if let Some(e) = f.energy {
                energies.push((e, w));
            }
        }

        // Tags take BOTH signs: "never plays country" is as useful as "always
        // plays shoegaze", and it is the half the old exact-string genre
        // lookup could not represent at all.
        for tag in tags_of(f) {
            *tag_score.entry(tag.clone()).or_insert(0.0) += w;
            *tag_seen.entry(tag).or_insert(0.0) += w.abs();
        }
    }

    taste.lyric = (lyric_w > 0.0).then(|| lyric_sum.iter().map(|x| x / lyric_w).collect());
    taste.sonic = (sonic_w > 0.0).then(|| sonic_sum.iter().map(|x| x / sonic_w).collect());
    taste.tempo = spread_of(&mut tempos);
    taste.energy = spread_of(&mut energies);

    // Each tag's affinity is its mean sentiment, shrunk by how often it was
    // seen. One lucky completion of a polka track does not make you a polka
    // listener; twenty of them do.
    taste.tags = tag_score
        .into_iter()
        .filter_map(|(tag, total)| {
            let seen = tag_seen.get(&tag).copied().unwrap_or(0.0);
            if seen <= 0.0 {
                return None;
            }
            let mean = (total / seen).clamp(-1.0, 1.0);
            let affinity = mean * shrink(seen, TAG_CONFIDENCE);
            (affinity.abs() > 0.02).then_some((tag, affinity))
        })
        .collect();

    taste.weights = fit_weights(verdicts, feats, &taste, now);
    taste
}

fn accumulate(sum: &mut Vec<f32>, wsum: &mut f32, v: &[f32], w: f32) {
    if sum.is_empty() {
        *sum = vec![0.0; v.len()];
    }
    if sum.len() != v.len() {
        return;
    }
    for (s, x) in sum.iter_mut().zip(v) {
        *s += *x * w;
    }
    *wsum += w;
}

/// Weighted median and a robust spread, or None when there is nothing to say.
fn spread_of(vals: &mut Vec<(f64, f32)>) -> Option<(f64, f64)> {
    if vals.len() < 3 {
        return None;
    }
    vals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let total: f32 = vals.iter().map(|(_, w)| w).sum();
    if total <= 0.0 {
        return None;
    }
    let at = |q: f32| -> f64 {
        let target = total * q;
        let mut acc = 0.0f32;
        for (x, w) in vals.iter() {
            acc += w;
            if acc >= target {
                return *x;
            }
        }
        vals[vals.len() - 1].0
    };
    let med = at(0.5);
    // Half the interquartile range, floored so a listener who plays exactly
    // one tempo does not get an infinitely narrow, unsatisfiable target.
    let spread = ((at(0.75) - at(0.25)) / 2.0).max(4.0);
    Some((med, spread))
}

/// Every tag that describes a track, lowercased and split.
///
/// The old genre term looked up `f.genre.to_lowercase()` as ONE key, so a
/// track tagged "indie, rock" never matched a listener's taste for "rock" -
/// the string had to be identical end to end. Splitting is most of the fix;
/// the rest is that `ai_genres`, `ai_specific_tags` and `ai_sonic_traits` all
/// exist, are populated, and were never consulted by scoring.
pub fn tags_of(f: &TrackFeatures) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        let t = s.trim().to_lowercase();
        if !t.is_empty() && t.len() < 40 && !out.contains(&t) {
            out.push(t);
        }
    };
    for part in f.genre.split(|c| c == ',' || c == ';' || c == '/') {
        push(part);
    }
    for g in &f.ai_genres {
        push(g);
    }
    for t in &f.ai_specific_tags {
        push(t);
    }
    for t in &f.ai_sonic_traits {
        push(t);
    }
    out
}

/// The five term values a track scores on, for one listener, each in [0, 1]
/// and each degrading to a neutral 0.5 when its evidence is missing.
///
/// Split out from `score` so the fitter can ask "what did this term say?" for
/// a track whose outcome is already known, which is the whole basis of
/// learning the weights.
pub fn terms(f: &TrackFeatures, taste: &UserTaste) -> [f32; 5] {
    let lyric = match (&taste.lyric, &f.lyric_vec) {
        (Some(c), Some(v)) => (crate::curator::cosine(c, v) + 1.0) / 2.0,
        _ => 0.5,
    };
    let sonic = match (&taste.sonic, &f.sonic_vec) {
        (Some(c), Some(v)) => (crate::curator::cosine(c, v) + 1.0) / 2.0,
        _ => 0.5,
    };
    let tempo = match (taste.tempo, f.bpm) {
        (Some((med, spread)), Some(b)) => {
            (-(((med - b).abs() / spread.max(1.0)) as f32)).exp().clamp(0.0, 1.0)
        }
        _ => 0.5,
    };
    let energy = match (taste.energy, f.energy) {
        (Some((med, spread)), Some(e)) => {
            (-(((med - e).abs() / spread.max(0.05)) as f32)).exp().clamp(0.0, 1.0)
        }
        _ => 0.5,
    };
    let tags = if taste.tags.is_empty() {
        0.5
    } else {
        let ts = tags_of(f);
        if ts.is_empty() {
            0.5
        } else {
            // Mean affinity over the track's tags, mapped from [-1,1] to [0,1].
            let sum: f32 = ts.iter().filter_map(|t| taste.tags.get(t)).sum();
            let hits = ts.iter().filter(|t| taste.tags.contains_key(*t)).count();
            if hits == 0 {
                // Nothing known about this track's tags. Slightly below
                // neutral: unknown is not the same as agreeable.
                0.45
            } else {
                ((sum / hits as f32) + 1.0) / 2.0
            }
        }
    };
    [lyric, sonic, tempo, tags, energy]
}

/// How well a track answers a listener, in [0, 1].
pub fn score(f: &TrackFeatures, taste: &UserTaste) -> f32 {
    let t = terms(f, taste);
    let w = taste.weights;
    (t[0] * w.lyric + t[1] * w.sonic + t[2] * w.tempo + t[3] * w.tags + t[4] * w.energy)
        .clamp(0.0, 1.0)
}

/// Score something that is NOT in the library yet - a Deezer candidate for the
/// Date deck, which has a title, an artist and maybe a preview clip.
///
/// The library scorer cannot be reused because a candidate has no
/// `TrackFeatures` row: no measured energy, no sonic vector, no genre string.
/// What it does have is an embedding of its words, a tempo measured off the
/// preview, and the artist it was suggested FROM - and that seed artist is
/// usually one the listener owns, so their tags are a real signal about the
/// candidate rather than the flat 0.5 the old path substituted.
///
/// The terms it cannot answer stay neutral and their weight is redistributed
/// across the ones it can, so a candidate is never punished for the
/// server simply not knowing something about it.
pub fn score_candidate(
    taste: &UserTaste,
    lyric_vec: Option<&[f32]>,
    bpm: Option<f64>,
    seed_tags: &[String],
) -> f32 {
    let w = taste.weights;
    let mut total = 0.0f32;
    let mut used = 0.0f32;

    if let (Some(c), Some(v)) = (&taste.lyric, lyric_vec) {
        total += w.lyric * ((crate::curator::cosine(c, v) + 1.0) / 2.0);
        used += w.lyric;
    }
    if let (Some((med, spread)), Some(b)) = (taste.tempo, bpm) {
        let t = (-(((med - b).abs() / spread.max(1.0)) as f32)).exp().clamp(0.0, 1.0);
        total += w.tempo * t;
        used += w.tempo;
    }
    if !taste.tags.is_empty() && !seed_tags.is_empty() {
        let hits: Vec<f32> = seed_tags.iter().filter_map(|t| taste.tags.get(t).copied()).collect();
        if !hits.is_empty() {
            let mean = hits.iter().sum::<f32>() / hits.len() as f32;
            total += w.tags * ((mean + 1.0) / 2.0);
            used += w.tags;
        }
    }
    if used <= 0.0 {
        return 0.5;
    }
    (total / used).clamp(0.0, 1.0)
}

/// Every tag the library associates with one artist, for seeding a candidate.
pub fn artist_tags(feats: &HashMap<i64, &TrackFeatures>, artist: &str) -> Vec<String> {
    let want = artist.trim().to_lowercase();
    if want.is_empty() {
        return Vec::new();
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for f in feats.values() {
        if f.artist.trim().to_lowercase() != want {
            continue;
        }
        for t in tags_of(f) {
            *counts.entry(t).or_insert(0) += 1;
        }
    }
    let mut v: Vec<(String, usize)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    v.into_iter().take(8).map(|(t, _)| t).collect()
}

/// Learn which terms actually predict THIS listener's outcomes.
///
/// HOW, AND WHY NOT SOMETHING CLEVERER.
///
/// For each term, the fit asks one question: across this listener's history,
/// did a higher value of this term go with a better outcome? That is a
/// weighted correlation, and terms that correlate positively get more of the
/// weight. Negative or zero correlation earns nothing - it cannot go negative,
/// because a term that fails to predict should stop being consulted, not start
/// being inverted.
///
/// A regression would be the textbook answer and is the wrong tool here: with
/// forty verdicts and five collinear terms it would fit noise confidently, and
/// the failure would be invisible. A correlation per term is weaker, harder to
/// fool, and - crucially - each number remains explainable to a person looking
/// at why their mixes changed.
///
/// THE LEAKAGE TRAP, which is the part worth being careful about: the taste
/// being scored against was built FROM these same verdicts, so a track's own
/// contribution to the centroid makes it look more predictable than it is.
/// The fit therefore uses a temporal split - the model is rebuilt from the
/// older half of the history and evaluated only on the newer half, which is
/// also the question actually being asked (does this term predict what they
/// will do NEXT). Below `WEIGHT_CONFIDENCE` verdicts the split leaves too
/// little on either side to mean anything, and shrinkage collapses the result
/// back to the prior anyway.
fn fit_weights(
    verdicts: &[Verdict],
    feats: &HashMap<i64, &TrackFeatures>,
    _built: &UserTaste,
    now: i64,
) -> Weights {
    let mut scored: Vec<&Verdict> = verdicts
        .iter()
        .filter(|v| v.confidence() > 0.0 && feats.contains_key(&v.track_id))
        .collect();
    if scored.len() < 24 {
        return PRIOR;
    }
    scored.sort_by_key(|v| v.at);
    let cut = scored.len() / 2;
    let (older, newer) = scored.split_at(cut);

    // A model that has never seen the newer half.
    let past: Vec<Verdict> = older.iter().map(|v| (*v).clone()).collect();
    let mut history = UserTaste::cold(0);
    {
        // Build only the descriptive half - calling `build` here would recurse.
        let sub = build_descriptive(&past, feats, now);
        history.lyric = sub.lyric;
        history.sonic = sub.sonic;
        history.tempo = sub.tempo;
        history.energy = sub.energy;
        history.tags = sub.tags;
    }

    // Weighted correlation between each term and the outcome on the held-out half.
    let mut num = [0.0f32; 5];
    let mut term_mean = [0.0f32; 5];
    let mut out_mean = 0.0f32;
    let mut wsum = 0.0f32;
    let rows: Vec<([f32; 5], f32, f32)> = newer
        .iter()
        .filter_map(|v| {
            let f = feats.get(&v.track_id)?;
            let conf = v.confidence() * v.recency(now);
            (conf > 0.0).then(|| (terms(f, &history), v.sentiment(), conf))
        })
        .collect();
    if rows.len() < 10 {
        return PRIOR;
    }
    for (t, out, w) in &rows {
        wsum += w;
        out_mean += out * w;
        for i in 0..5 {
            term_mean[i] += t[i] * w;
        }
    }
    if wsum <= 0.0 {
        return PRIOR;
    }
    out_mean /= wsum;
    for m in term_mean.iter_mut() {
        *m /= wsum;
    }
    let mut var_t = [0.0f32; 5];
    let mut var_o = 0.0f32;
    for (t, out, w) in &rows {
        let dout = out - out_mean;
        var_o += w * dout * dout;
        for i in 0..5 {
            let dt = t[i] - term_mean[i];
            num[i] += w * dt * dout;
            var_t[i] += w * dt * dt;
        }
    }
    if var_o <= 0.0 {
        return PRIOR;
    }
    let mut fitted = [0.0f32; 5];
    for i in 0..5 {
        if var_t[i] > 0.0 {
            // Only positive predictive power earns weight.
            fitted[i] = (num[i] / (var_t[i] * var_o).sqrt()).max(0.0);
        }
    }
    if fitted.iter().sum::<f32>() <= 0.0 {
        return PRIOR;
    }
    let mine = Weights {
        lyric: fitted[0],
        sonic: fitted[1],
        tempo: fitted[2],
        tags: fitted[3],
        energy: fitted[4],
    }
    .normalized();

    let evidence: f32 = rows.iter().map(|(_, _, w)| *w).sum();
    mine.blend_from_prior(shrink(evidence, WEIGHT_CONFIDENCE)).normalized()
}

/// The descriptive half of `build` - centroids, bands and tags, no fitting.
/// Split out so `fit_weights` can rebuild a past-only model without recursing
/// into the fitter that called it.
fn build_descriptive(
    verdicts: &[Verdict],
    feats: &HashMap<i64, &TrackFeatures>,
    now: i64,
) -> UserTaste {
    let mut t = UserTaste::cold(0);
    let mut lyric_sum: Vec<f32> = Vec::new();
    let mut lyric_w = 0.0f32;
    let mut sonic_sum: Vec<f32> = Vec::new();
    let mut sonic_w = 0.0f32;
    let mut tempos: Vec<(f64, f32)> = Vec::new();
    let mut energies: Vec<(f64, f32)> = Vec::new();
    let mut tag_score: HashMap<String, f32> = HashMap::new();
    let mut tag_seen: HashMap<String, f32> = HashMap::new();

    for v in verdicts {
        let w = v.weight(now);
        if w == 0.0 {
            continue;
        }
        let Some(f) = feats.get(&v.track_id) else { continue };
        if w > 0.0 {
            if let Some(vec) = &f.lyric_vec {
                accumulate(&mut lyric_sum, &mut lyric_w, vec, w);
            }
            if let Some(vec) = &f.sonic_vec {
                accumulate(&mut sonic_sum, &mut sonic_w, vec, w);
            }
            if let Some(b) = f.bpm {
                tempos.push((b, w));
            }
            if let Some(e) = f.energy {
                energies.push((e, w));
            }
        }
        for tag in tags_of(f) {
            *tag_score.entry(tag.clone()).or_insert(0.0) += w;
            *tag_seen.entry(tag).or_insert(0.0) += w.abs();
        }
    }
    t.lyric = (lyric_w > 0.0).then(|| lyric_sum.iter().map(|x| x / lyric_w).collect());
    t.sonic = (sonic_w > 0.0).then(|| sonic_sum.iter().map(|x| x / sonic_w).collect());
    t.tempo = spread_of(&mut tempos);
    t.energy = spread_of(&mut energies);
    t.tags = tag_score
        .into_iter()
        .filter_map(|(tag, total)| {
            let seen = tag_seen.get(&tag).copied().unwrap_or(0.0);
            (seen > 0.0).then(|| {
                let mean = (total / seen).clamp(-1.0, 1.0);
                (tag, mean * shrink(seen, TAG_CONFIDENCE))
            })
        })
        .collect();
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feat(id: i64, bpm: f64, genre: &str, vec: Option<Vec<f32>>) -> TrackFeatures {
        TrackFeatures {
            track_id: id,
            bpm: Some(bpm),
            lyric_vec: vec,
            genre: genre.into(),
            ai_genres: Vec::new(),
            ai_specific_tags: Vec::new(),
            ai_sonic_traits: Vec::new(),
            artist: format!("artist{id}"),
            energy: Some(0.5),
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
        }
    }

    fn verdict(id: i64, at: i64, ctx: &str) -> Verdict {
        Verdict {
            track_id: id,
            at,
            ms_listened: 200_000,
            duration_ms: Some(200_000),
            completed: true,
            skipped: false,
            context: ctx.into(),
            hearted: false,
        }
    }

    // --- the sign, which the old model could not express --------------------

    #[test]
    fn a_rejection_is_negative_not_merely_small() {
        let mut v = verdict(1, 0, "discover");
        v.completed = false;
        v.skipped = true;
        v.ms_listened = 4_000;
        assert!(v.sentiment() < -0.5, "an instant skip must push AWAY: {}", v.sentiment());

        let done = verdict(1, 0, "discover");
        assert!(done.sentiment() > 0.9, "a completion is a yes: {}", done.sentiment());
    }

    #[test]
    fn a_late_skip_is_nearly_neutral() {
        let mut v = verdict(1, 0, "discover");
        v.completed = false;
        v.skipped = true;
        v.ms_listened = 190_000; // 95% of the way through
        let s = v.sentiment();
        assert!(s > -0.2 && s <= 0.1, "skipping at the end is not hatred: {s}");
    }

    #[test]
    fn a_heart_lifts_the_verdict() {
        let plain = verdict(1, 0, "playlist");
        let mut loved = plain.clone();
        loved.hearted = true;
        assert!(loved.sentiment() >= plain.sentiment());
    }

    // --- duration, the column that was written and never read ---------------

    #[test]
    fn completion_is_a_ratio_of_the_real_length_not_a_30s_bar() {
        // 30 seconds of a 3-minute song: a real taste of it.
        let mut short = verdict(1, 0, "songs");
        short.completed = false;
        short.skipped = false;
        short.ms_listened = 30_000;
        short.duration_ms = Some(180_000);

        // 30 seconds of a 60-minute mix: essentially nothing.
        let mut long = short.clone();
        long.duration_ms = Some(3_600_000);

        assert!(
            short.sentiment() > long.sentiment(),
            "the same 30s must mean less of a longer track: {} vs {}",
            short.sentiment(),
            long.sentiment()
        );
    }

    // --- context, the other column nobody read ------------------------------

    #[test]
    fn the_machines_own_picks_teach_more_than_a_search_does() {
        assert!(
            verdict(1, 0, "discover").confidence() > verdict(1, 0, "search").confidence(),
            "finishing what the machine offered is stronger evidence than finishing what you looked up"
        );
        assert_eq!(verdict(1, 0, "books:shelf").confidence(), 0.0, "books teach nothing about songs");
    }

    // --- shrinkage, the cold-start guarantee ---------------------------------

    #[test]
    fn a_listener_we_know_nothing_about_gets_the_house_model() {
        let feats = HashMap::new();
        let t = build(7, &[], &feats, 1_000_000);
        assert_eq!(t.weights, PRIOR);
        assert_eq!(t.evidence, 0.0);
        assert!(t.lyric.is_none() && t.tempo.is_none() && t.tags.is_empty());
    }

    #[test]
    fn too_little_history_cannot_move_the_weights() {
        let f = feat(1, 120.0, "rock", None);
        let mut feats = HashMap::new();
        feats.insert(1i64, &f);
        let vs: Vec<Verdict> = (0..10).map(|i| verdict(1, i * 1000, "discover")).collect();
        let t = build(7, &vs, &feats, 100_000);
        assert_eq!(t.weights, PRIOR, "ten verdicts must not fit a ranking function");
    }

    #[test]
    fn shrink_behaves() {
        assert_eq!(shrink(0.0, 10.0), 0.0);
        assert!((shrink(10.0, 10.0) - 0.5).abs() < 1e-6, "half weight at k");
        assert!(shrink(1000.0, 10.0) > 0.98);
    }

    // --- tags, where the exact-string match used to fail --------------------

    #[test]
    fn a_comma_joined_genre_is_split_into_real_tags() {
        let f = feat(1, 120.0, "Indie, Rock", None);
        let tags = tags_of(&f);
        assert!(tags.contains(&"indie".to_string()), "{tags:?}");
        assert!(tags.contains(&"rock".to_string()), "{tags:?}");
        assert!(!tags.contains(&"indie, rock".to_string()), "the whole string is not a tag");
    }

    #[test]
    fn a_tag_repeatedly_rejected_becomes_negative() {
        let f = feat(1, 120.0, "country", None);
        let mut feats = HashMap::new();
        feats.insert(1i64, &f);
        let vs: Vec<Verdict> = (0..40)
            .map(|i| {
                let mut v = verdict(1, i * 3600, "discover");
                v.completed = false;
                v.skipped = true;
                v.ms_listened = 3_000;
                v
            })
            .collect();
        let t = build(7, &vs, &feats, 40 * 3600);
        let country = t.tags.get("country").copied().unwrap_or(0.0);
        assert!(country < -0.2, "forty instant skips must read as dislike, got {country}");
    }

    // --- scoring degrades rather than lying ---------------------------------

    #[test]
    fn every_term_is_neutral_when_its_evidence_is_missing() {
        let f = feat(1, 120.0, "", None);
        let cold = UserTaste::cold(1);
        let t = terms(&f, &cold);
        for (i, v) in t.iter().enumerate() {
            assert!((*v - 0.5).abs() < 0.06, "term {i} should be ~neutral, got {v}");
        }
        let s = score(&f, &cold);
        assert!(s > 0.4 && s < 0.6, "a cold score is neutral, got {s}");
    }

    #[test]
    fn exploration_starts_cautious_and_opens_up() {
        let cold = UserTaste::cold(1);
        let mut warm = UserTaste::cold(1);
        warm.evidence = 2000.0;
        assert!(cold.exploration() < 0.2, "a new listener is shown safe things");
        assert!(warm.exploration() > cold.exploration(), "evidence buys risk");
        assert!(warm.exploration() < 0.5, "never a coin flip");
    }

    #[test]
    fn weights_always_sum_to_one() {
        let w = Weights { lyric: 3.0, sonic: 1.0, tempo: 2.0, tags: 2.0, energy: 2.0 }.normalized();
        let sum = w.lyric + w.sonic + w.tempo + w.tags + w.energy;
        assert!((sum - 1.0).abs() < 1e-5, "got {sum}");
        let zero = Weights { lyric: 0.0, sonic: 0.0, tempo: 0.0, tags: 0.0, energy: 0.0 }.normalized();
        assert_eq!(zero, PRIOR, "a degenerate fit falls back to the house model");
    }

    #[test]
    fn blending_from_the_prior_moves_the_right_distance() {
        let mine = Weights { lyric: 1.0, sonic: 0.0, tempo: 0.0, tags: 0.0, energy: 0.0 };
        assert_eq!(mine.blend_from_prior(0.0), PRIOR, "no evidence, no movement");
        let half = mine.blend_from_prior(0.5);
        assert!((half.lyric - (PRIOR.lyric + (1.0 - PRIOR.lyric) * 0.5)).abs() < 1e-6);
    }

    #[test]
    fn recency_halves_on_schedule() {
        let v = verdict(1, 0, "playlist");
        let now = (HALF_LIFE_DAYS as i64) * 86_400;
        let fresh = verdict(1, now, "playlist");
        let decayed = v.weight(now);
        let full = fresh.weight(now);
        assert!(
            (decayed / full - 0.5).abs() < 0.02,
            "one half-life should halve it: {decayed} vs {full}"
        );
    }
}

/// An offline check against a real database, run by hand:
///
///     AFM_EVAL_DB=/path/to/attackfm.db cargo test --release eval_against_real -- --ignored --nocapture
///
/// It answers the only question that matters about this rework: does the new
/// model rank what a listener will actually finish above what they will skip,
/// better than the model it replaces? It trains on the older half of each
/// listener's history and is scored on the newer half, which they have not
/// been shown.
#[cfg(test)]
mod eval {
    use super::*;
    use crate::db::Db;

    /// Area under the ROC curve: the probability that a randomly chosen
    /// liked track outranks a randomly chosen disliked one. 0.5 is a coin.
    fn auc(mut rows: Vec<(f32, bool)>) -> f32 {
        rows.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let pos = rows.iter().filter(|(_, y)| *y).count() as f32;
        let neg = rows.len() as f32 - pos;
        if pos == 0.0 || neg == 0.0 {
            return f32::NAN;
        }
        let mut rank_sum = 0.0f32;
        for (i, (_, y)) in rows.iter().enumerate() {
            if *y {
                rank_sum += (i + 1) as f32;
            }
        }
        (rank_sum - pos * (pos + 1.0) / 2.0) / (pos * neg)
    }

    #[test]
    #[ignore]
    fn eval_against_real() {
        let Ok(path) = std::env::var("AFM_EVAL_DB") else {
            eprintln!("set AFM_EVAL_DB");
            return;
        };
        let db = Db::open(std::path::Path::new(&path)).unwrap();
        let all = db.all_features();
        let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let users: Vec<(i64, String)> =
            db.list_users().into_iter().map(|(id, name, _)| (id, name)).collect();

        println!("\n{:<18} {:>7} {:>9} {:>9}  {}", "listener", "test n", "OLD auc", "NEW auc", "weights");
        println!("{}", "-".repeat(78));
        for (uid, name) in users {
            let mut vs = db.taste_verdicts(uid, 0, 20_000);
            if vs.len() < 40 {
                continue;
            }
            vs.sort_by_key(|v| v.at);
            let cut = vs.len() / 2;
            let (train, test) = vs.split_at(cut);

            let taste = build(uid, train, &by_id, now);

            // The model being replaced: an unweighted centroid over play
            // starts, scored with the fixed 0.45/0.30/0.25.
            let starts: Vec<(i64, f32)> = train.iter().map(|v| (v.track_id, 1.0)).collect();
            let old = crate::curator::taste_from_weighted(&starts, &by_id);

            let mut old_rows = Vec::new();
            let mut new_rows = Vec::new();
            for v in test {
                let Some(f) = by_id.get(&v.track_id) else { continue };
                let liked = v.sentiment() > 0.25;
                let disliked = v.sentiment() < -0.25;
                if !liked && !disliked {
                    continue; // ambiguous middle teaches nothing about ranking
                }
                old_rows.push((crate::curator::score(f, &old), liked));
                new_rows.push((score(f, &taste), liked));
            }
            if new_rows.len() < 20 {
                continue;
            }
            let w = taste.weights;
            println!(
                "{:<18} {:>7} {:>9.3} {:>9.3}  ly{:.2} so{:.2} te{:.2} ta{:.2} en{:.2}",
                name,
                new_rows.len(),
                auc(old_rows),
                auc(new_rows),
                w.lyric, w.sonic, w.tempo, w.tags, w.energy
            );
        }
        println!();
    }
}
