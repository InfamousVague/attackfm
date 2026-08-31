//! Behavior-driven playlist intents (checklist Stage 6).
//!
//! Fixed recipes are useful fallbacks, but the curator should notice what a
//! listener has actually been into lately. An intent is a small, deterministic,
//! EVIDENCE-BOUND playlist concept: it exists only because long-term affinities
//! or a recent-interest delta support it, and it cites that evidence. The LLM
//! may name and explain an intent; it cannot create one. Intent identity is
//! persisted (curator_intents) so a supported concept keeps its name between
//! rebuilds instead of shapeshifting every day.

use crate::db::TrackFeatures;
use crate::recommendation::TasteContext;
use std::collections::HashSet;

/// A genre needs at least this share of weighted long-term listening to stand
/// as an identity intent.
const LONG_TERM_MIN_SHARE: f32 = 0.12;
/// A genre needs at least this share of the 30-day window, AND a clear rise
/// over its long-term share, to stand as a current-interest intent.
const RECENT_MIN_SHARE: f32 = 0.15;
const RECENT_MIN_DELTA: f32 = 0.08;
/// Two intents whose selected candidate sets overlap this much are the same
/// musical lane wearing two names; the later one is dropped.
const DEDUP_JACCARD: f32 = 0.6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IntentKind {
    /// Who the listener is, over all history.
    LongTerm,
    /// Where the listener is drifting, over the last 30 days.
    RecentShift,
}

impl IntentKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            IntentKind::LongTerm => "long-term",
            IntentKind::RecentShift => "recent-shift",
        }
    }
}

/// One supported playlist concept. `genres` are normalized terms matched
/// against enriched genres first and the raw file tag as a fallback.
#[derive(Clone, Debug)]
pub(crate) struct PlaylistIntent {
    /// Stable identity: the same evidence produces the same key on every
    /// rebuild, which is what lets a playlist keep its name.
    pub key: String,
    pub kind: IntentKind,
    /// The plain name used until a model (or a previous rebuild) supplies one.
    pub fallback_title: String,
    /// Why this intent exists at all. Never empty: an intent without evidence
    /// is a hallucination with a track list.
    pub evidence: Vec<String>,
    pub genres: Vec<String>,
}

/// Generates the small set of intents this listener's behavior supports.
///
/// Deterministic: the same two taste windows always produce the same intents
/// in the same order, so a listener with no recent shift gets stable concepts.
pub(crate) fn generate(
    recent: Option<&TasteContext>,
    long_term: &TasteContext,
) -> Vec<PlaylistIntent> {
    let mut intents: Vec<PlaylistIntent> = Vec::new();

    let mut ranked: Vec<(&String, &f32)> = long_term.genres.iter().collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(b.0))
    });
    for (genre, share) in ranked.into_iter().filter(|(_, s)| **s >= LONG_TERM_MIN_SHARE).take(3) {
        intents.push(PlaylistIntent {
            key: format!("long-term:{genre}"),
            kind: IntentKind::LongTerm,
            fallback_title: format!("{} and you", title_case(genre)),
            evidence: vec![format!(
                "long-term identity: {genre} carries {:.0}% of weighted listening",
                share * 100.0
            )],
            genres: vec![genre.clone()],
        });
    }

    if let Some(recent) = recent {
        let mut shifts: Vec<(String, f32, f32)> = recent
            .genres
            .iter()
            .filter(|(_, recent_share)| **recent_share >= RECENT_MIN_SHARE)
            .map(|(genre, recent_share)| {
                let long_share = long_term.genres.get(genre).copied().unwrap_or(0.0);
                (genre.clone(), *recent_share, long_share)
            })
            .filter(|(genre, recent_share, long_share)| {
                *recent_share > *long_share + RECENT_MIN_DELTA
                    && !intents.iter().any(|i| i.genres.contains(genre))
            })
            .collect();
        shifts.sort_by(|a, b| {
            (b.1 - b.2)
                .partial_cmp(&(a.1 - a.2))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        for (genre, recent_share, long_share) in shifts.into_iter().take(2) {
            intents.push(PlaylistIntent {
                key: format!("recent-shift:{genre}"),
                kind: IntentKind::RecentShift,
                fallback_title: format!("Lately: {}", title_case(&genre)),
                evidence: vec![format!(
                    "recent interest: {genre} rose to {:.0}% of the last 30 days, up from {:.0}% long-term",
                    recent_share * 100.0,
                    long_share * 100.0
                )],
                genres: vec![genre],
            });
        }
    }
    intents
}

/// Whether a library track belongs to an intent's lane. Enriched genres lead;
/// the raw file tag is the fallback for tracks the enrichment pass has not
/// reached yet.
pub(crate) fn matches(intent: &PlaylistIntent, feature: &TrackFeatures) -> bool {
    let terms: Vec<String> = if feature.ai_genres.is_empty() {
        vec![normalize(&feature.genre)]
    } else {
        feature.ai_genres.iter().map(|g| normalize(g)).collect()
    };
    intent.genres.iter().any(|g| terms.iter().any(|t| t == g))
}

/// Jaccard overlap of two candidate sets - the dedup ruler.
pub(crate) fn overlap(a: &[i64], b: &[i64]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let sa: HashSet<i64> = a.iter().copied().collect();
    let sb: HashSet<i64> = b.iter().copied().collect();
    let both = sa.intersection(&sb).count() as f32;
    both / sa.union(&sb).count() as f32
}

/// Whether `candidate_ids` is essentially the same lane as any already-kept
/// intent's selection.
pub(crate) fn is_duplicate_lane(kept: &[Vec<i64>], candidate_ids: &[i64]) -> bool {
    kept.iter().any(|prev| overlap(prev, candidate_ids) >= DEDUP_JACCARD)
}

/// Applies model-written names to supported intents, by position.
///
/// The model is shown the intents and asked for one (title, blurb) each, in
/// order. Anything beyond that - an extra concept, a renamed lane it invented,
/// a valid-JSON daydream - is discarded here: naming is granted per supported
/// intent and there is no path by which an unsupported concept gets a list.
pub(crate) fn apply_names(
    intents: &[PlaylistIntent],
    parsed: Vec<serde_json::Value>,
) -> Vec<Option<(String, String)>> {
    let mut out: Vec<Option<(String, String)>> = vec![None; intents.len()];
    for (i, value) in parsed.into_iter().enumerate() {
        let Some(slot) = out.get_mut(i) else {
            // Valid JSON, unsupported concept: rejected.
            continue;
        };
        let title = value
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let blurb = value
            .get("blurb")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !title.is_empty() && title.len() <= 60 && blurb.len() <= 240 {
            *slot = Some((title, blurb));
        }
    }
    out
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase().replace('_', "-")
}

fn title_case(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recommendation;
    use std::collections::HashMap;

    fn context(genres: &[(&str, f32)]) -> TasteContext {
        let mut ctx = TasteContext::default();
        ctx.genres = genres
            .iter()
            .map(|(g, s)| (g.to_string(), *s))
            .collect::<HashMap<_, _>>();
        ctx
    }

    #[test]
    fn recent_industrial_spike_creates_a_shift_intent_without_erasing_identity() {
        let long_term = context(&[("industrial-metal", 0.4), ("hardcore", 0.3), ("metal", 0.2)]);
        let recent = context(&[("ebm", 0.4), ("industrial-metal", 0.3), ("hardcore", 0.3)]);
        let intents = generate(Some(&recent), &long_term);
        let keys: Vec<&str> = intents.iter().map(|i| i.key.as_str()).collect();
        assert!(keys.contains(&"recent-shift:ebm"), "the spike must surface: {keys:?}");
        assert!(keys.contains(&"long-term:industrial-metal"));
        assert!(keys.contains(&"long-term:hardcore"));
        let shift = intents.iter().find(|i| i.key == "recent-shift:ebm").unwrap();
        assert_eq!(shift.kind, IntentKind::RecentShift);
        assert!(!shift.evidence.is_empty());
    }

    #[test]
    fn no_recent_shift_means_stable_long_term_concepts() {
        let long_term = context(&[("bebop", 0.4), ("modal-jazz", 0.3), ("fusion", 0.2)]);
        let recent = context(&[("bebop", 0.4), ("modal-jazz", 0.3), ("fusion", 0.2)]);
        let first = generate(Some(&recent), &long_term);
        let second = generate(Some(&recent), &long_term);
        let a: Vec<&str> = first.iter().map(|i| i.key.as_str()).collect();
        let b: Vec<&str> = second.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(a, b);
        assert!(a.iter().all(|k| k.starts_with("long-term:")), "no shift invented: {a:?}");
    }

    #[test]
    fn unsupported_model_concepts_are_rejected_even_with_valid_json() {
        let intents = vec![
            PlaylistIntent {
                key: "long-term:industrial-metal".into(),
                kind: IntentKind::LongTerm,
                fallback_title: "Industrial Metal and you".into(),
                evidence: vec!["evidence".into()],
                genres: vec!["industrial-metal".into()],
            },
            PlaylistIntent {
                key: "recent-shift:ebm".into(),
                kind: IntentKind::RecentShift,
                fallback_title: "Lately: Ebm".into(),
                evidence: vec!["evidence".into()],
                genres: vec!["ebm".into()],
            },
        ];
        let parsed = serde_json::from_str::<Vec<serde_json::Value>>(
            r#"[
                {"title":"Mechanical Aggression","blurb":"Heavy machines, heavier hearts."},
                {"title":"Body Voltage","blurb":"The current running through your month."},
                {"title":"K-pop Dreams","blurb":"An unsupported concept with valid JSON."}
            ]"#,
        )
        .unwrap();
        let named = apply_names(&intents, parsed);
        assert_eq!(named.len(), 2);
        assert_eq!(named[0].as_ref().unwrap().0, "Mechanical Aggression");
        assert_eq!(named[1].as_ref().unwrap().0, "Body Voltage");
        assert!(
            !named.iter().flatten().any(|(t, _)| t.contains("K-pop")),
            "an unsupported concept must never receive a playlist"
        );
    }

    #[test]
    fn differently_named_near_identical_lanes_are_deduplicated() {
        let a: Vec<i64> = (1..=20).collect();
        let mut b: Vec<i64> = (1..=18).collect();
        b.extend([21, 22]);
        assert!(is_duplicate_lane(&[a.clone()], &b));
        let c: Vec<i64> = (30..=50).collect();
        assert!(!is_duplicate_lane(&[a], &c));
    }

    #[test]
    fn lane_membership_prefers_enriched_genres_with_raw_tag_fallback() {
        let intent = PlaylistIntent {
            key: "long-term:industrial".into(),
            kind: IntentKind::LongTerm,
            fallback_title: "Industrial and you".into(),
            evidence: vec!["evidence".into()],
            genres: vec!["industrial".into()],
        };
        let enriched = TrackFeatures {
            genre: "post-punk".into(),
            ai_genres: vec!["Industrial".into()],
            ..Default::default()
        };
        let raw_only = TrackFeatures {
            genre: "industrial".into(),
            ..Default::default()
        };
        let other = TrackFeatures {
            genre: "k-pop".into(),
            ai_genres: vec!["K-pop".into()],
            ..Default::default()
        };
        assert!(matches(&intent, &enriched));
        assert!(matches(&intent, &raw_only));
        assert!(!matches(&intent, &other));
        // The shared context builder stays the source of the genre shares.
        let _ = recommendation::from_tracks(&[], &HashMap::new());
    }
}
