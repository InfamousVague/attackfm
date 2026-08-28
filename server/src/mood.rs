//! The mood engine: what one listener has ACTUALLY been playing lately,
//! clustered into moods the rest of the machine can steer by.
//!
//! Everything here is derived from evidence that already exists - the verdict
//! stream (listen_events through taste::Verdict, sentiment x confidence x
//! recency), the lyric/sonic embeddings the enricher computed, the analyser's
//! energy, the profiles' controlled mood vocabulary - aggregated per listener
//! for the first time. The curator's old "mood" lists were static energy bands
//! over the whole library; these are clusters of the last three weeks of
//! listening, weighted by how each play actually went.
//!
//! The model's only job is NAMING. The clusters, their shares, their tempo and
//! energy and tags are all arithmetic; one short chat call turns "melancholic /
//! indie rock / 96bpm / late at night" into words a person would use, and a
//! box with no chat model gets honest plain names instead.
//!
//! Consumers: discovery scoring (a candidate near a current mood outranks one
//! near nothing), the station builder (one station per mood), the new-music
//! grouping, and the settings pane's Taste page.

use crate::db::TrackFeatures;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Mood looks at the last three weeks. Deliberately much shorter than taste's
/// 180-day window: taste is who you are, mood is where you have been living.
const WINDOW_DAYS: i64 = 21;
/// Rebuilt when older than this - daily, in practice, with slack so the cycle
/// that runs every few minutes does not thrash it.
const FRESH_MS: i64 = 20 * 60 * 60 * 1000;
/// K-means housekeeping.
const KMEANS_ROUNDS: usize = 12;
/// A cluster below this share of the listening is noise, not a mood.
const MIN_SHARE: f64 = 0.12;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoodCluster {
    /// The model's name for it, or the plain fallback ("Melancholic indie").
    pub name: String,
    /// One line, possibly empty.
    pub blurb: String,
    /// Share of recent listening weight, 0-1 across clusters.
    pub share: f64,
    /// Median tempo of the member tracks that have one.
    pub bpm: Option<f64>,
    /// Mean analyser energy of members that have one, 0-1.
    pub energy: Option<f64>,
    /// The top mood/genre words, weighted, most telling first.
    pub tags: Vec<String>,
    /// A few member tracks, heaviest first - the honest "this mood is these".
    pub exemplar_ids: Vec<i64>,
    /// Listening weight by UTC quarter-day [0-6, 6-12, 12-18, 18-24). The
    /// client shifts by its own timezone; the server does not know one.
    pub hours: [f64; 4],
    /// The embedding centroid, L2-normalised. Not serialized small - a few KB
    /// per cluster - but read whole by one scorer, like the vectors it is
    /// made of.
    pub centroid: Vec<f32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoodProfile {
    pub built_at: i64,
    /// How many verdicts fed this - the pane says "from N listens".
    pub evidence: usize,
    pub clusters: Vec<MoodCluster>,
}

// --- the pure half -----------------------------------------------------------

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn norm(v: &mut [f32]) {
    let n = dot(v, v).sqrt();
    if n > 1e-6 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

/// Weighted k-means over unit vectors, DETERMINISTIC.
///
/// No RNG: the first centre is the weighted mean of everything, and each
/// further centre is the point farthest (least similar) from every centre so
/// far - farthest-point init. Same input, same clusters, always; the tests
/// depend on it and so does a settings page that should not reshuffle a
/// person's moods on every rebuild when nothing changed.
///
/// Returns (assignment per point, centroids). k is clamped to the number of
/// points.
pub fn kmeans(points: &[Vec<f32>], weights: &[f32], k: usize) -> (Vec<usize>, Vec<Vec<f32>>) {
    let n = points.len();
    if n == 0 {
        return (Vec::new(), Vec::new());
    }
    let dims = points[0].len();
    let k = k.clamp(1, n);

    // Weighted mean as the first centre.
    let mut centres: Vec<Vec<f32>> = Vec::with_capacity(k);
    let mut mean = vec![0f32; dims];
    for (p, w) in points.iter().zip(weights) {
        for (m, x) in mean.iter_mut().zip(p) {
            *m += x * w.max(0.0);
        }
    }
    norm(&mut mean);
    centres.push(mean);

    // Farthest-point for the rest: the point least similar to its nearest
    // existing centre. Ties break on index, which is what makes this stable.
    while centres.len() < k {
        let mut far_i = 0usize;
        let mut far_sim = f32::MAX;
        for (i, p) in points.iter().enumerate() {
            let best = centres.iter().map(|c| dot(p, c)).fold(f32::MIN, f32::max);
            if best < far_sim {
                far_sim = best;
                far_i = i;
            }
        }
        centres.push(points[far_i].clone());
    }

    let mut assign = vec![0usize; n];
    for _ in 0..KMEANS_ROUNDS {
        // Assign to the most similar centre.
        let mut moved = false;
        for (i, p) in points.iter().enumerate() {
            let mut best = 0usize;
            let mut best_sim = f32::MIN;
            for (ci, c) in centres.iter().enumerate() {
                let s = dot(p, c);
                if s > best_sim {
                    best_sim = s;
                    best = ci;
                }
            }
            if assign[i] != best {
                assign[i] = best;
                moved = true;
            }
        }
        // Weighted centroid update.
        let mut sums = vec![vec![0f32; dims]; centres.len()];
        let mut mass = vec![0f32; centres.len()];
        for (i, p) in points.iter().enumerate() {
            let w = weights[i].max(0.0);
            mass[assign[i]] += w;
            for (m, x) in sums[assign[i]].iter_mut().zip(p) {
                *m += x * w;
            }
        }
        for (ci, sum) in sums.into_iter().enumerate() {
            if mass[ci] > 0.0 {
                centres[ci] = sum;
                norm(&mut centres[ci]);
            }
        }
        if !moved {
            break;
        }
    }
    (assign, centres)
}

/// How many moods a body of listening can honestly support.
pub fn k_for(distinct_tracks: usize) -> usize {
    match distinct_tracks {
        0..=5 => 1,
        6..=13 => 2,
        14..=29 => 3,
        _ => 4,
    }
}

/// A candidate's closeness to the profile, 0-1, 0.5 when unanswerable.
///
/// Max over clusters rather than an average: playing a lot of two different
/// moods should not make everything score as the smear between them. Each
/// cluster's vote is damped by the square root of its share, so a dominant
/// mood counts more without a minor one counting for nothing.
pub fn affinity(profile: &MoodProfile, vec: Option<&[f32]>, bpm: Option<f64>) -> f64 {
    let Some(v) = vec else { return 0.5 };
    let mut best = f64::MIN;
    for c in &profile.clusters {
        if c.centroid.len() != v.len() {
            continue;
        }
        let sim = f64::from((dot(&c.centroid, v) + 1.0) / 2.0);
        let tempo = match (c.bpm, bpm) {
            (Some(a), Some(b)) => (-((a - b).abs() / 30.0)).exp().clamp(0.0, 1.0),
            _ => 0.5,
        };
        let vote = (sim * 0.8 + tempo * 0.2) * c.share.sqrt().clamp(0.3, 1.0);
        if vote > best {
            best = vote;
        }
    }
    if best == f64::MIN {
        0.5
    } else {
        best.clamp(0.0, 1.0)
    }
}

// --- building ---------------------------------------------------------------

/// The stored profile, if fresh enough to use.
pub fn load(state: &AppState, user: i64) -> Option<MoodProfile> {
    let (_, json) = state.db.mood_profile(user)?;
    serde_json::from_str(&json).ok()
}

pub fn is_stale(state: &AppState, user: i64) -> bool {
    match state.db.mood_profile(user) {
        Some((built_at, _)) => crate::db::now_ms() - built_at > FRESH_MS,
        None => true,
    }
}

/// Build and store one listener's profile. Returns it, or None when there is
/// not enough recent listening to say anything - which is an answer the pane
/// shows, not an error.
pub async fn rebuild(state: &Arc<AppState>, user: i64) -> Option<MoodProfile> {
    let now_s = crate::db::now_ms() / 1000;
    let since_ms = crate::db::now_ms() - WINDOW_DAYS * 86_400_000;
    let verdicts = state.db.taste_verdicts(user, since_ms, 2000);

    // Positive listening only: mood is what you chose to live in. Skips teach
    // taste; they do not name a mood.
    let mut weight_by_track: HashMap<i64, f32> = HashMap::new();
    let mut hours_by_track: HashMap<i64, [f64; 4]> = HashMap::new();
    for v in &verdicts {
        let w = v.weight(now_s);
        if w <= 0.0 {
            continue;
        }
        *weight_by_track.entry(v.track_id).or_default() += w;
        let bucket = (((v.at / 3600) % 24) / 6).clamp(0, 3) as usize;
        hours_by_track.entry(v.track_id).or_default()[bucket] += f64::from(w);
    }
    if weight_by_track.len() < 4 {
        return None;
    }

    let all = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();

    // One point per distinct track: its embedding, at its accumulated weight.
    // The lyric vector first - it is the one the enricher always makes - and
    // the sonic one where a track has no words.
    let mut ids = Vec::new();
    let mut points = Vec::new();
    let mut weights = Vec::new();
    for (&id, &w) in &weight_by_track {
        let Some(f) = by_id.get(&id) else { continue };
        let v = f.lyric_vec.as_ref().or(f.sonic_vec.as_ref());
        let Some(v) = v else { continue };
        let mut v = v.clone();
        norm(&mut v);
        ids.push(id);
        points.push(v);
        weights.push(w);
    }
    if ids.len() < 4 {
        return None;
    }
    // Vectors must agree on dimensions to cluster; keep the majority size.
    let dims = {
        let mut counts: HashMap<usize, usize> = HashMap::new();
        for p in &points {
            *counts.entry(p.len()).or_default() += 1;
        }
        counts.into_iter().max_by_key(|(_, n)| *n).map(|(d, _)| d).unwrap_or(0)
    };
    let keep: Vec<usize> = (0..points.len()).filter(|&i| points[i].len() == dims).collect();
    let ids: Vec<i64> = keep.iter().map(|&i| ids[i]).collect();
    let points: Vec<Vec<f32>> = keep.iter().map(|&i| points[i].clone()).collect();
    let weights: Vec<f32> = keep.iter().map(|&i| weights[i]).collect();
    if ids.len() < 4 {
        return None;
    }

    let (assign, centres) = kmeans(&points, &weights, k_for(ids.len()));

    // Aggregate each cluster.
    let total: f64 = weights.iter().map(|w| f64::from(*w)).sum();
    let mut clusters = Vec::new();
    for (ci, centroid) in centres.iter().enumerate() {
        let members: Vec<usize> = (0..ids.len()).filter(|&i| assign[i] == ci).collect();
        if members.is_empty() {
            continue;
        }
        let mass: f64 = members.iter().map(|&i| f64::from(weights[i])).sum();
        let share = mass / total.max(1e-9);
        if share < MIN_SHARE && clusters.len() >= 1 {
            continue;
        }

        let mut bpms: Vec<f64> = members
            .iter()
            .filter_map(|&i| by_id.get(&ids[i]).and_then(|f| f.bpm))
            .collect();
        bpms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let bpm = (!bpms.is_empty()).then(|| bpms[bpms.len() / 2]);

        let energies: Vec<f64> = members
            .iter()
            .filter_map(|&i| by_id.get(&ids[i]).and_then(|f| f.energy))
            .collect();
        let energy =
            (!energies.is_empty()).then(|| energies.iter().sum::<f64>() / energies.len() as f64);

        // Weighted tag tally: the controlled moods (they live in ai_vibes -
        // the projection writes canonical.moods there) plus genres.
        let mood_words = state.db.mood_words_for(&members.iter().map(|&i| ids[i]).collect::<Vec<_>>());
        let mut tally: HashMap<String, f64> = HashMap::new();
        for &i in &members {
            let w = f64::from(weights[i]);
            if let Some(f) = by_id.get(&ids[i]) {
                for t in crate::taste::tags_of(f).into_iter().take(4) {
                    *tally.entry(t).or_default() += w * 0.5;
                }
            }
            if let Some(words) = mood_words.get(&ids[i]) {
                for t in words {
                    *tally.entry(t.clone()).or_default() += w;
                }
            }
        }
        let mut tags: Vec<(String, f64)> = tally.into_iter().collect();
        tags.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let tags: Vec<String> = tags.into_iter().take(5).map(|(t, _)| t).collect();

        let mut heavy: Vec<usize> = members.clone();
        heavy.sort_by(|&a, &b| {
            weights[b].partial_cmp(&weights[a]).unwrap_or(std::cmp::Ordering::Equal)
        });
        let exemplar_ids: Vec<i64> = heavy.iter().take(3).map(|&i| ids[i]).collect();

        let mut hours = [0f64; 4];
        for &i in &members {
            if let Some(h) = hours_by_track.get(&ids[i]) {
                for (a, b) in hours.iter_mut().zip(h) {
                    *a += b;
                }
            }
        }
        let hsum: f64 = hours.iter().sum();
        if hsum > 0.0 {
            for h in hours.iter_mut() {
                *h /= hsum;
            }
        }

        clusters.push(MoodCluster {
            name: plain_name(&tags),
            blurb: String::new(),
            share,
            bpm,
            energy,
            tags,
            exemplar_ids,
            hours,
            centroid: centroid.clone(),
        });
    }
    clusters.sort_by(|a, b| b.share.partial_cmp(&a.share).unwrap_or(std::cmp::Ordering::Equal));

    // The one model call: names. Failure keeps the plain names - a profile
    // with dull words beats no profile.
    name_clusters(state, &mut clusters).await;

    let profile = MoodProfile {
        built_at: crate::db::now_ms(),
        evidence: verdicts.len(),
        clusters,
    };
    if let Ok(json) = serde_json::to_string(&profile) {
        let _ = state.db.save_mood_profile(user, &json);
    }
    Some(profile)
}

/// "Melancholic indie", from the top tags. The honest fallback, and the seed
/// the model is asked to improve on.
fn plain_name(tags: &[String]) -> String {
    let mut it = tags.iter().take(2).map(|t| t.as_str());
    match (it.next(), it.next()) {
        (Some(a), Some(b)) => {
            let mut s = format!("{a} {b}");
            if let Some(c) = s.get_mut(0..1) {
                c.make_ascii_uppercase();
            }
            s
        }
        (Some(a), None) => {
            let mut s = a.to_string();
            if let Some(c) = s.get_mut(0..1) {
                c.make_ascii_uppercase();
            }
            s
        }
        _ => "Recently".to_string(),
    }
}

#[derive(Deserialize)]
struct NamedMood {
    name: String,
    #[serde(default)]
    blurb: String,
}

async fn name_clusters(state: &Arc<AppState>, clusters: &mut [MoodCluster]) {
    if clusters.is_empty() {
        return;
    }
    let Some(client) = crate::ai::AiClient::configured() else { return };
    let mut lines = Vec::new();
    for (i, c) in clusters.iter().enumerate() {
        let ex: Vec<String> = state
            .db
            .titles_for(&c.exemplar_ids)
            .into_iter()
            .map(|(a, t)| format!("{a} — {t}"))
            .collect();
        lines.push(format!(
            "{}|tags: {} | bpm {} | energy {} | e.g. {}",
            i + 1,
            c.tags.join(", "),
            c.bpm.map(|b| format!("{b:.0}")).unwrap_or_else(|| "?".into()),
            c.energy.map(|e| format!("{e:.2}")).unwrap_or_else(|| "?".into()),
            ex.join("; "),
        ));
    }
    let schema = serde_json::json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "name": { "type": "string", "maxLength": 40 },
                "blurb": { "type": "string", "maxLength": 100 }
            },
            "required": ["name", "blurb"],
            "additionalProperties": false
        },
        "minItems": clusters.len(),
        "maxItems": clusters.len()
    });
    let prompt = format!(
        "One listener's recent listening fell into {} mood clusters:\n{}\n\n\
         Name each one the way a person would name their own mood - two to four \
         plain words, no exclamation marks, no genre-soup. One warm line each. \
         Answer as a JSON array in the same order.",
        clusters.len(),
        lines.join("\n"),
    );
    if let Ok(named) = client
        .chat_json::<Vec<NamedMood>>(
            "You name moods for one listener's own recent music. Plain, warm, specific.",
            &prompt,
            "attackfm_mood_names_v1",
            schema,
            false,
        )
        .await
    {
        for (c, n) in clusters.iter_mut().zip(named) {
            if !n.name.trim().is_empty() {
                c.name = n.name.trim().to_string();
            }
            c.blurb = n.blurb.trim().to_string();
        }
    }
}

/// The daily upkeep, called from the curator's loop for each active listener.
pub async fn cycle(state: &Arc<AppState>, user: i64) -> bool {
    if !is_stale(state, user) {
        return false;
    }
    rebuild(state, user).await.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32) -> Vec<f32> {
        let mut p = vec![x, y];
        norm(&mut p);
        p
    }

    /// Two plainly different groups must come out as two clusters, and the
    /// same input must produce the same answer every time - the pane should
    /// not reshuffle a person's moods when nothing about them changed.
    #[test]
    fn kmeans_separates_and_is_deterministic() {
        let points = vec![v(1.0, 0.05), v(1.0, -0.05), v(0.9, 0.1), v(0.05, 1.0), v(-0.05, 1.0)];
        let weights = vec![1.0, 1.0, 1.0, 1.0, 1.0];
        let (a1, c1) = kmeans(&points, &weights, 2);
        let (a2, c2) = kmeans(&points, &weights, 2);
        assert_eq!(a1, a2, "same input, same clusters");
        assert_eq!(c1.len(), 2);
        assert_eq!(c2.len(), 2);
        assert_eq!(a1[0], a1[1], "the x-ish points sit together");
        assert_eq!(a1[0], a1[2]);
        assert_eq!(a1[3], a1[4], "the y-ish points sit together");
        assert_ne!(a1[0], a1[3], "and apart from the x-ish ones");
    }

    /// Weight moves the centroid: the heavy point owns the middle.
    #[test]
    fn weight_pulls_the_centroid() {
        let points = vec![v(1.0, 0.0), v(0.0, 1.0)];
        let (_, c) = kmeans(&points, &[10.0, 0.1], 1);
        assert!(c[0][0] > c[0][1], "the centroid leans to the heavy point");
    }

    /// Affinity prefers the near cluster and shrugs at nothing.
    #[test]
    fn affinity_answers_and_declines_honestly() {
        let profile = MoodProfile {
            built_at: 0,
            evidence: 10,
            clusters: vec![MoodCluster {
                name: "Test".into(),
                blurb: String::new(),
                share: 1.0,
                bpm: Some(100.0),
                energy: Some(0.5),
                tags: vec![],
                exemplar_ids: vec![],
                hours: [0.25; 4],
                centroid: v(1.0, 0.0),
            }],
        };
        let near = affinity(&profile, Some(&v(0.95, 0.05)), Some(102.0));
        let far = affinity(&profile, Some(&v(-1.0, 0.0)), Some(180.0));
        assert!(near > 0.75, "a matching candidate scores high, got {near}");
        assert!(far < 0.3, "an opposite one scores low, got {far}");
        assert_eq!(affinity(&profile, None, None), 0.5, "no vector, no opinion");
    }

    #[test]
    fn k_grows_with_evidence() {
        assert_eq!(k_for(4), 1);
        assert_eq!(k_for(10), 2);
        assert_eq!(k_for(20), 3);
        assert_eq!(k_for(300), 4);
    }
}
