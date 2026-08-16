//! External evidence and validation for the background song enricher.
//!
//! Internet data is evidence, never a substitute for listening.  This module
//! deliberately talks to structured catalogues rather than feeding arbitrary
//! search-result prose to the model.  Failed or ambiguous matches simply add
//! no evidence.

use crate::db::CurationTrack;
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

const MUSICBRAINZ: &str = "https://musicbrainz.org/ws/2/recording";
const LISTENBRAINZ: &str = "https://api.listenbrainz.org/1";
const USER_AGENT: &str = "AttackFM/0.3 (https://attack.fm)";

#[derive(Default, Clone, Serialize)]
pub struct ExternalKnowledge {
    pub musicbrainz_id: String,
    pub artist_mbid: String,
    pub tags: Vec<String>,
    pub similar_recording_mbids: Vec<String>,
    pub listen_count: i64,
    pub listener_count: i64,
    pub sources: Vec<String>,
    pub confidence: f32,
}

pub const PROFILE_SCHEMA_VERSION: i64 = 3;
pub const FAST_PROMPT_VERSION: &str = "fast-semantic-v7";
pub const REFINEMENT_PROMPT_VERSION: &str = "evidence-audit-v7";
pub const CONTROLLED_GENRES: &[&str] = &[
    "ambient",
    "blues",
    "classical",
    "country",
    "dance",
    "disco",
    "electronic",
    "electronic-dance-music",
    "folk",
    "funk",
    "hip-hop",
    "house",
    "indie",
    "jazz",
    "metal",
    "pop",
    "punk",
    "reggae",
    "rnb",
    "rock",
    "soul",
    "techno",
    "trance",
    "world",
];
pub const CONTROLLED_MOODS: &[&str] = &[
    "aggressive",
    "calm",
    "dark",
    "dreamy",
    "energetic",
    "euphoric",
    "hopeful",
    "intimate",
    "melancholic",
    "mysterious",
    "playful",
    "rebellious",
    "reflective",
    "romantic",
    "somber",
    "tense",
    "uplifting",
];
pub const CONTROLLED_VIBES: &[&str] = &[
    "atmospheric",
    "cinematic",
    "dancefloor",
    "festival",
    "late-night",
    "lo-fi",
    "party",
    "raw",
    "retro",
    "sparse",
    "warm",
];
pub const CONTROLLED_TRAITS: &[&str] = &[
    "acoustic",
    "aggressive",
    "bass-heavy",
    "beat-driven",
    "dense",
    "guitar-driven",
    "high-intensity",
    "low-intensity",
    "melodic",
    "percussive",
    "rhythm-forward",
    "sparse",
    "syncopated",
    "synth-driven",
    "vocal-forward",
];

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct CategoryConfidence {
    #[serde(default)]
    pub genres: f32,
    #[serde(default)]
    pub moods: f32,
    #[serde(default)]
    pub vibes: f32,
    #[serde(default)]
    pub musical_traits: f32,
    #[serde(default)]
    pub lyrical_themes: f32,
    #[serde(default)]
    pub specific_tags: f32,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct SemanticProfile {
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub moods: Vec<String>,
    #[serde(default)]
    pub vibes: Vec<String>,
    #[serde(default)]
    pub musical_traits: Vec<String>,
    #[serde(default)]
    pub lyrical_themes: Vec<String>,
    #[serde(default)]
    pub specific_tags: Vec<String>,
    #[serde(default)]
    pub scenes: Vec<String>,
    #[serde(default)]
    pub movements: Vec<String>,
    #[serde(default)]
    pub eras: Vec<String>,
    #[serde(default)]
    pub influences: Vec<String>,
    #[serde(default)]
    pub cultural_context: Vec<String>,
    #[serde(default)]
    pub production_descriptors: Vec<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub confidence: CategoryConfidence,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct SemanticFields {
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub moods: Vec<String>,
    #[serde(default)]
    pub vibes: Vec<String>,
    #[serde(default)]
    pub musical_traits: Vec<String>,
    #[serde(default)]
    pub lyrical_themes: Vec<String>,
    #[serde(default)]
    pub specific_tags: Vec<String>,
    #[serde(default)]
    pub scenes: Vec<String>,
    #[serde(default)]
    pub movements: Vec<String>,
    #[serde(default)]
    pub eras: Vec<String>,
    #[serde(default)]
    pub influences: Vec<String>,
    #[serde(default)]
    pub cultural_context: Vec<String>,
    #[serde(default)]
    pub production_descriptors: Vec<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct RefinementPatch {
    #[serde(default)]
    pub add: SemanticFields,
    #[serde(default)]
    pub remove: SemanticFields,
    #[serde(default)]
    pub replace: SemanticFields,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub confidence: CategoryConfidence,
    #[serde(default)]
    pub reasoning_summary: String,
}

fn slug(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

pub fn normalize_specific_tag(value: &str) -> String {
    slug(value)
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct SpecificTagDecision {
    pub input_tag: String,
    /// `reuse`, `keep-new`, or `reject`.
    pub action: String,
    #[serde(default)]
    pub canonical_tag: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct SpecificTagDecisionBatch {
    #[serde(default)]
    pub decisions: Vec<SpecificTagDecision>,
}

fn controlled(value: &str, family: &str) -> Option<String> {
    let raw = slug(value);
    let alias = match (family, raw.as_str()) {
        ("genre", "hip-hop") | ("genre", "rap-hip-hop") | ("genre", "rap-music") => "hip-hop",
        ("genre", "r-b") | ("genre", "rhythm-and-blues") => "rnb",
        ("genre", "edm") => "electronic-dance-music",
        ("mood", "high-energy") | ("mood", "excited") | ("mood", "exhilarating") => "energetic",
        ("mood", "melancholy") => "melancholic",
        ("mood", "sad") | ("mood", "sadness") => "somber",
        ("mood", "anxious") | ("mood", "uneasy") => "tense",
        ("mood", "defiant") => "rebellious",
        ("vibe", "nocturnal") => "late-night",
        ("vibe", "club") | ("vibe", "club-ready") => "dancefloor",
        ("vibe", "cinematic-soundscape") => "cinematic",
        ("trait", "rhythm-forward")
        | ("trait", "rhythmic")
        | ("trait", "driving-rhythm")
        | ("trait", "complex-rhythms") => "rhythm-forward",
        ("trait", "synthesizer-driven") | ("trait", "synthesizer-heavy") => "synth-driven",
        ("trait", "high-energy") => "high-intensity",
        ("trait", "low-energy") => "low-intensity",
        ("trait", "distorted-guitars") | ("trait", "guitar-heavy") => "guitar-driven",
        ("trait", "vocal-driven") => "vocal-forward",
        _ => raw.as_str(),
    };
    let vocabulary = match family {
        "genre" => CONTROLLED_GENRES,
        "mood" => CONTROLLED_MOODS,
        "vibe" => CONTROLLED_VIBES,
        "trait" => CONTROLLED_TRAITS,
        _ => return None,
    };
    vocabulary.contains(&alias).then(|| alias.to_string())
}

/// Convert a recognized specific genre into one or more broad controlled
/// parents. The original specific term is still retained in `specific_tags`.
/// This deliberately models families, not individual artists or recordings.
fn genre_parents(value: &str) -> &'static [&'static str] {
    match slug(value).as_str() {
        "alternative-rnb" | "contemporary-rnb" => &["rnb"],
        "art-pop" | "electropop" | "hyperpop" | "power-pop" | "synthpop" => &["pop"],
        "country-rap" | "country-trap" => &["country", "hip-hop"],
        "dance-punk" | "disco-punk" => &["punk", "dance"],
        "darkwave" | "indietronica" | "synthwave" | "witch-house" => &["electronic"],
        "digital-hardcore" => &["electronic", "punk"],
        "drum-and-bass" | "electro" | "experimental-electronic" | "glitch" => &["electronic"],
        "electro-house" | "french-house" | "future-house" => &["house", "electronic"],
        "electroclash" => &["electronic", "punk"],
        "experimental-hip-hop"
        | "glitch-hop"
        | "industrial-hip-hop"
        | "noise-rap"
        | "southern-hip-hop"
        | "trap" => &["hip-hop"],
        "experimental-rock" | "indie-rock" | "math-rock" | "noise-rock" | "post-rock"
        | "progressive-rock" => &["rock"],
        "folk-punk" => &["folk", "punk"],
        "funk-rock" => &["funk", "rock"],
        "industrial-rock" => &["rock", "electronic"],
        "jazz-fusion" | "nu-jazz" => &["jazz"],
        "neo-psychedelia" | "psychedelic-rock" => &["rock"],
        "nu-disco" => &["disco", "dance"],
        "nu-metal" | "rap-metal" => &["metal", "rock"],
        "plunderphonics" | "sampledelia" => &["electronic"],
        "post-punk" | "post-punk-revival" | "riot-grrrl" => &["punk", "rock"],
        _ => &[],
    }
}

fn normalize_controlled_with_overflow(
    values: Vec<String>,
    max: usize,
    family: &str,
) -> (Vec<String>, Vec<String>) {
    let cleaned = clean_terms(values, max * 2);
    let mut controlled_seen = HashSet::new();
    let mut overflow_seen = HashSet::new();
    let mut accepted = Vec::new();
    let mut overflow = Vec::new();
    for raw in cleaned {
        if let Some(value) = controlled(&raw, family) {
            if controlled_seen.insert(value.clone()) && accepted.len() < max {
                accepted.push(value);
            }
            continue;
        }
        let specific = slug(&raw);
        let measurement_artifact = specific.contains("dynamic-range")
            || specific.contains("rhythmic-activity")
            || specific.starts_with("bpm-")
            || specific.starts_with("brightness-")
            || specific.starts_with("loudness-");
        if specific.is_empty() || measurement_artifact {
            continue;
        }
        if family == "genre" {
            for parent in genre_parents(&specific) {
                let parent = (*parent).to_string();
                if controlled_seen.insert(parent.clone()) && accepted.len() < max {
                    accepted.push(parent);
                }
            }
        }
        if overflow_seen.insert(specific.clone()) {
            overflow.push(specific);
        }
    }
    (accepted, overflow)
}

fn normalize_list(
    values: Vec<String>,
    max: usize,
    family: Option<&str>,
    strict: bool,
) -> Vec<String> {
    let cleaned = clean_terms(values, max * 2);
    let mut seen = HashSet::new();
    cleaned
        .into_iter()
        .filter_map(|v| {
            let value = family
                .and_then(|f| controlled(&v, f))
                .or_else(|| (!strict).then(|| slug(&v)))?;
            (!value.is_empty() && seen.insert(value.clone())).then_some(value)
        })
        .take(max)
        .collect()
}

impl CategoryConfidence {
    fn normalize(&mut self) {
        for value in [
            &mut self.genres,
            &mut self.moods,
            &mut self.vibes,
            &mut self.musical_traits,
            &mut self.lyrical_themes,
            &mut self.specific_tags,
        ] {
            *value = value.clamp(0.0, 1.0);
        }
    }
}

impl SemanticProfile {
    pub fn normalize(mut self, lyrics_available: bool) -> Self {
        let (genres, genre_specifics) = normalize_controlled_with_overflow(self.genres, 5, "genre");
        let (moods, _mood_specifics) = normalize_controlled_with_overflow(self.moods, 6, "mood");
        let (vibes, _vibe_specifics) = normalize_controlled_with_overflow(self.vibes, 6, "vibe");
        let (musical_traits, _trait_specifics) =
            normalize_controlled_with_overflow(self.musical_traits, 8, "trait");
        self.genres = genres;
        self.moods = moods;
        self.vibes = vibes;
        self.musical_traits = musical_traits;
        self.lyrical_themes = if lyrics_available {
            normalize_list(self.lyrical_themes, 6, None, false)
        } else {
            Vec::new()
        };
        // A narrow genre that does not fit the broad discovery vocabulary is
        // useful specificity.  An unknown mood/vibe/trait is not: overflowing
        // those fields made `confident`, `hopeless`, and `fast-tempo` look like
        // learned genres in the v4 evaluation.
        self.specific_tags.extend(genre_specifics);
        self.specific_tags = normalize_list(self.specific_tags, 16, None, false);
        self.scenes = normalize_list(self.scenes, 8, None, false);
        self.movements = normalize_list(self.movements, 8, None, false);
        self.eras = normalize_list(self.eras, 6, None, false);
        self.influences = normalize_list(self.influences, 8, None, false);
        self.cultural_context = normalize_list(self.cultural_context, 8, None, false);
        self.production_descriptors = normalize_list(self.production_descriptors, 8, None, false);
        self.summary = self.summary.trim().chars().take(420).collect();
        self.confidence.normalize();
        self
    }

    pub fn confidence_average(&self) -> f32 {
        let c = &self.confidence;
        (c.genres + c.moods + c.vibes + c.musical_traits + c.lyrical_themes + c.specific_tags) / 6.0
    }

    pub fn confidence_average_for(&self, lyrics_available: bool) -> f32 {
        let c = &self.confidence;
        let mut values = vec![
            c.genres,
            c.moods,
            c.vibes,
            c.musical_traits,
            c.specific_tags,
        ];
        if lyrics_available {
            values.push(c.lyrical_themes);
        }
        values.iter().sum::<f32>() / values.len() as f32
    }

    /// Model confidence is advisory at most. Stored confidence is derived from
    /// evidence availability and whether the normalized profile satisfies the
    /// server's semantic invariants.
    pub fn set_deterministic_confidence(
        &mut self,
        lyrics_available: bool,
        community_tags_available: bool,
        repaired: bool,
    ) -> f32 {
        let mut base = 0.62_f32;
        if community_tags_available {
            base += 0.10;
        }
        if lyrics_available {
            base += 0.06;
        }
        if !self.production_descriptors.is_empty() {
            base += 0.05;
        }
        if !self.specific_tags.is_empty() {
            base += 0.05;
        }
        if repaired {
            base -= 0.08;
        }
        base = base.clamp(0.0, 0.88);
        self.confidence = CategoryConfidence {
            genres: base,
            moods: base,
            vibes: base,
            musical_traits: base,
            lyrical_themes: if lyrics_available && !self.lyrical_themes.is_empty() {
                base
            } else {
                0.0
            },
            specific_tags: if self.specific_tags.is_empty() {
                (base - 0.10).max(0.0)
            } else {
                base
            },
        };
        self.confidence_average_for(lyrics_available)
    }

    /// Confidence for a profile that survived the deep review pass.  A field
    /// left unchanged by an explicitly skeptical reviewer has stronger support
    /// than one the reviewer had to rewrite.  Scores remain category-level for
    /// schema-v3 compatibility, but no longer collapse to one blanket value.
    pub fn set_reviewed_confidence(
        &mut self,
        fast: &SemanticProfile,
        lyrics_available: bool,
        community_tags_available: bool,
    ) -> f32 {
        let evidence_base = 0.57_f32 + if community_tags_available { 0.09 } else { 0.0 };
        let score = |unchanged: bool, populated: bool| {
            if !populated {
                0.0
            } else {
                (evidence_base + if unchanged { 0.13 } else { 0.04 }).clamp(0.0, 0.86)
            }
        };
        self.confidence = CategoryConfidence {
            genres: score(self.genres == fast.genres, !self.genres.is_empty()),
            moods: score(self.moods == fast.moods, !self.moods.is_empty()),
            vibes: score(self.vibes == fast.vibes, !self.vibes.is_empty()),
            musical_traits: score(
                self.musical_traits == fast.musical_traits,
                !self.musical_traits.is_empty(),
            ),
            lyrical_themes: if lyrics_available {
                score(
                    self.lyrical_themes == fast.lyrical_themes,
                    !self.lyrical_themes.is_empty(),
                )
            } else {
                0.0
            },
            specific_tags: score(
                self.specific_tags == fast.specific_tags,
                !self.specific_tags.is_empty(),
            ),
        };
        self.confidence_average_for(lyrics_available)
    }
}

/// Return actionable errors for one bounded repair pass. This deliberately
/// validates the normalized representation: useful niche terms have already
/// been preserved in `specific_tags` and mapped to broad parents where known.
pub fn semantic_validation_errors(
    profile: &SemanticProfile,
    lyrics_available: bool,
) -> Vec<String> {
    let mut errors = Vec::new();
    if profile.summary.len() < 24 {
        errors.push("summary must describe the recording in at least 24 characters".into());
    }
    if profile.genres.is_empty() {
        errors.push("genres needs at least one broad genre supported by the recording".into());
    }
    if profile.moods.is_empty() {
        errors.push("moods needs at least one musical mood".into());
    }
    if profile.musical_traits.is_empty() {
        errors.push("musical_traits needs at least one audible musical trait".into());
    }
    if !lyrics_available && !profile.lyrical_themes.is_empty() {
        errors.push("lyrical_themes must be empty because no lyrics were supplied".into());
    }
    if lyrics_available
        && profile
            .specific_tags
            .iter()
            .any(|tag| tag == "instrumental" || tag == "instrumental-hip-hop")
    {
        errors.push("instrumental conflicts with the supplied vocal/lyric evidence".into());
    }
    errors
}

fn patch_list(current: &mut Vec<String>, add: &[String], remove: &[String], replace: &[String]) {
    if !replace.is_empty() {
        *current = replace.to_vec();
    }
    let removed: HashSet<&str> = remove.iter().map(String::as_str).collect();
    current.retain(|v| !removed.contains(v.as_str()));
    for value in add {
        if !current.contains(value) {
            current.push(value.clone());
        }
    }
}

fn normalize_fields(mut f: SemanticFields, lyrics: bool) -> SemanticFields {
    let (genres, genre_specifics) = normalize_controlled_with_overflow(f.genres, 5, "genre");
    let (moods, _mood_specifics) = normalize_controlled_with_overflow(f.moods, 6, "mood");
    let (vibes, _vibe_specifics) = normalize_controlled_with_overflow(f.vibes, 6, "vibe");
    let (musical_traits, _trait_specifics) =
        normalize_controlled_with_overflow(f.musical_traits, 8, "trait");
    f.genres = genres;
    f.moods = moods;
    f.vibes = vibes;
    f.musical_traits = musical_traits;
    f.lyrical_themes = if lyrics {
        normalize_list(f.lyrical_themes, 6, None, false)
    } else {
        Vec::new()
    };
    f.specific_tags.extend(genre_specifics);
    f.specific_tags = normalize_list(f.specific_tags, 16, None, false);
    f.scenes = normalize_list(f.scenes, 8, None, false);
    f.movements = normalize_list(f.movements, 8, None, false);
    f.eras = normalize_list(f.eras, 6, None, false);
    f.influences = normalize_list(f.influences, 8, None, false);
    f.cultural_context = normalize_list(f.cultural_context, 8, None, false);
    f.production_descriptors = normalize_list(f.production_descriptors, 8, None, false);
    f
}

pub fn apply_patch(
    fast: &SemanticProfile,
    patch: &RefinementPatch,
    lyrics_available: bool,
) -> SemanticProfile {
    let mut out = fast.clone();
    let add = normalize_fields(patch.add.clone(), lyrics_available);
    let remove = normalize_fields(patch.remove.clone(), lyrics_available);
    let replace = normalize_fields(patch.replace.clone(), lyrics_available);
    macro_rules! field {
        ($name:ident) => {
            patch_list(&mut out.$name, &add.$name, &remove.$name, &replace.$name)
        };
    }
    field!(genres);
    field!(moods);
    field!(vibes);
    field!(musical_traits);
    field!(lyrical_themes);
    field!(specific_tags);
    field!(scenes);
    field!(movements);
    field!(eras);
    field!(influences);
    field!(cultural_context);
    field!(production_descriptors);
    if let Some(summary) = &patch.summary {
        if !summary.trim().is_empty() {
            out.summary = summary.clone();
        }
    }
    out.confidence = patch.confidence.clone();
    out.normalize(lyrics_available)
}

pub fn provenance(
    fast: &SemanticProfile,
    canonical: &SemanticProfile,
    patch: Option<&RefinementPatch>,
) -> Value {
    json!({"fast": fast, "refinementPatch": patch, "canonical": canonical})
}

/// Admin-only comparison view: measured facts, both model layers, canonical,
/// and version provenance for one recording.
pub async fn debug_profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, (StatusCode, String)> {
    crate::auth::require_admin(&state.db, &headers)
        .map_err(|s| (s, "admin access required".into()))?;
    state
        .db
        .profile_debug(id)
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "track not found".into()))
}

#[derive(Deserialize)]
struct MbSearch {
    #[serde(default)]
    recordings: Vec<MbRecording>,
}

#[derive(Deserialize)]
struct MbRecording {
    id: String,
    title: String,
    #[serde(default, rename = "artist-credit")]
    artist_credit: Vec<MbArtistCredit>,
    #[serde(default)]
    tags: Vec<MbTag>,
    #[serde(default)]
    genres: Vec<MbTag>,
}

#[derive(Deserialize)]
struct MbArtistCredit {
    #[serde(default)]
    name: String,
    #[serde(default)]
    artist: Option<MbArtist>,
}

#[derive(Deserialize)]
struct MbArtist {
    #[serde(default)]
    id: String,
}

#[derive(Deserialize)]
struct MbTag {
    name: String,
    #[serde(default)]
    count: i64,
}

fn folded(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn exactish(a: &str, b: &str) -> bool {
    let a = folded(a);
    let b = folded(b);
    !a.is_empty() && (a == b || (a.len() >= 8 && (a.contains(&b) || b.contains(&a))))
}

/// Find a high-confidence recording match. MusicBrainz asks clients to stay at
/// one request per second; the curator calls this serially and sleeps between
/// tracks, while this request has its own conservative timeout.
pub async fn musicbrainz(track: &CurationTrack) -> ExternalKnowledge {
    let query = format!(
        "recording:\"{}\" AND artist:\"{}\"",
        track.title.replace('"', ""),
        track.artist.replace('"', "")
    );
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent(USER_AGENT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return ExternalKnowledge::default(),
    };
    let response = match client
        .get(MUSICBRAINZ)
        .query(&[("fmt", "json"), ("limit", "5"), ("query", query.as_str())])
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => return ExternalKnowledge::default(),
    };
    let body = match response.json::<MbSearch>().await {
        Ok(body) => body,
        Err(_) => return ExternalKnowledge::default(),
    };
    let Some(mut recording) = body.recordings.into_iter().find(|candidate| {
        exactish(&candidate.title, &track.title)
            && candidate
                .artist_credit
                .iter()
                .any(|artist| exactish(&artist.name, &track.artist))
    }) else {
        return ExternalKnowledge::default();
    };

    // Search identifies the recording but normally omits folksonomy tags. The
    // detail endpoint supplies them. Keep the courtesy gap beside the request
    // so this module always respects MusicBrainz's shared one-call-per-second
    // service, regardless of how quickly its caller is looping.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let detail_url = format!("{MUSICBRAINZ}/{}", recording.id);
    if let Ok(response) = client
        .get(detail_url)
        .query(&[("fmt", "json"), ("inc", "tags+genres")])
        .send()
        .await
    {
        if response.status().is_success() {
            if let Ok(detail) = response.json::<MbRecording>().await {
                recording.tags = detail.tags;
                recording.genres = detail.genres;
            }
        }
    }

    let mut tags: Vec<MbTag> = recording.tags.into_iter().chain(recording.genres).collect();
    tags.sort_by(|a, b| b.count.cmp(&a.count));
    let mut seen = HashSet::new();
    let tags = tags
        .into_iter()
        .map(|tag| tag.name.trim().to_string())
        .filter(|tag| tag.len() >= 2 && seen.insert(tag.to_lowercase()))
        .take(12)
        .collect();
    ExternalKnowledge {
        musicbrainz_id: recording.id,
        artist_mbid: recording
            .artist_credit
            .iter()
            .find(|artist| exactish(&artist.name, &track.artist))
            .and_then(|credit| credit.artist.as_ref())
            .map(|artist| artist.id.clone())
            .unwrap_or_default(),
        tags,
        similar_recording_mbids: Vec::new(),
        listen_count: 0,
        listener_count: 0,
        sources: vec!["musicbrainz".into()],
        confidence: 0.9,
    }
}

/// Enrich an already identity-checked MusicBrainz recording with ListenBrainz
/// community evidence. These endpoints are public and keyless. A response is
/// accepted only when it is keyed by the exact MBID and its returned names
/// still agree with the local recording; a catalogue mismatch contributes
/// nothing. Similar recordings are collaborative evidence, not sonic facts.
pub async fn listenbrainz(track: &CurationTrack, knowledge: &mut ExternalKnowledge) {
    if knowledge.musicbrainz_id.is_empty() {
        return;
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent(USER_AGENT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let metadata_url = format!("{LISTENBRAINZ}/metadata/recording/");
    let metadata = client
        .get(metadata_url)
        .query(&[
            ("recording_mbids", knowledge.musicbrainz_id.as_str()),
            ("inc", "artist tag release"),
        ])
        .send()
        .await
        .ok()
        .filter(|response| response.status().is_success())
        .and_then(|response| response.error_for_status().ok());
    let Some(metadata) = metadata else { return };
    let Ok(body) = metadata.json::<serde_json::Value>().await else {
        return;
    };
    let Some(entry) = body.get(&knowledge.musicbrainz_id) else {
        return;
    };
    let returned_title = entry
        .pointer("/recording/name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let returned_artist = entry
        .pointer("/artist/name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !exactish(returned_title, &track.title) || !exactish(returned_artist, &track.artist) {
        return;
    }

    let mut candidates: Vec<(i64, String)> = Vec::new();
    for family in ["recording", "release_group", "artist"] {
        if let Some(tags) = entry
            .pointer(&format!("/tag/{family}"))
            .and_then(|v| v.as_array())
        {
            for tag in tags {
                if let Some(name) = tag.get("tag").and_then(|v| v.as_str()) {
                    candidates.push((
                        tag.get("count").and_then(|v| v.as_i64()).unwrap_or(0),
                        name.into(),
                    ));
                }
            }
        }
    }
    if let Some(relations) = entry.pointer("/recording/rels").and_then(|v| v.as_array()) {
        for relation in relations {
            if let Some(instrument) = relation.get("instrument").and_then(|v| v.as_str()) {
                candidates.push((20, instrument.into()));
            }
            if let Some(kind) = relation.get("type").and_then(|v| v.as_str()) {
                if kind == "vocal" {
                    candidates.push((20, "vocals".into()));
                }
            }
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let mut seen: HashSet<String> = knowledge
        .tags
        .iter()
        .map(|tag| tag.to_lowercase())
        .collect();
    knowledge.tags.extend(
        candidates
            .into_iter()
            .map(|(_, tag)| tag.trim().to_string())
            .filter(|tag| tag.len() >= 2 && seen.insert(tag.to_lowercase()))
            .take(16),
    );
    knowledge.sources.push("listenbrainz_metadata".into());

    if let Ok(response) = client
        .post(format!("{LISTENBRAINZ}/popularity/recording"))
        .json(&serde_json::json!({"recording_mbids": [knowledge.musicbrainz_id]}))
        .send()
        .await
    {
        if let Ok(rows) = response.json::<serde_json::Value>().await {
            if let Some(row) = rows.as_array().and_then(|rows| rows.first()).filter(|row| {
                row.get("recording_mbid").and_then(|v| v.as_str())
                    == Some(&knowledge.musicbrainz_id)
            }) {
                knowledge.listen_count = row
                    .get("total_listen_count")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                knowledge.listener_count = row
                    .get("total_user_count")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                knowledge.sources.push("listenbrainz_popularity".into());
            }
        }
    }
    if !knowledge.artist_mbid.is_empty() {
        if let Ok(response) = client
            .get(format!(
                "{LISTENBRAINZ}/lb-radio/artist/{}",
                knowledge.artist_mbid
            ))
            .query(&[
                ("mode", "easy"),
                ("max_similar_artists", "8"),
                ("max_recordings_per_artist", "5"),
                ("pop_begin", "10"),
                ("pop_end", "100"),
            ])
            .send()
            .await
        {
            if let Ok(groups) = response.json::<serde_json::Value>().await {
                let mut related: Vec<(i64, String)> = groups
                    .as_object()
                    .into_iter()
                    .flat_map(|map| map.values())
                    .filter_map(|value| value.as_array())
                    .flatten()
                    .filter_map(|row| {
                        Some((
                            row.get("total_listen_count")?.as_i64().unwrap_or(0),
                            row.get("recording_mbid")?.as_str()?.to_string(),
                        ))
                    })
                    .collect();
                related.sort_by(|a, b| b.0.cmp(&a.0));
                knowledge.similar_recording_mbids = related
                    .into_iter()
                    .map(|(_, id)| id)
                    .filter(|id| id != &knowledge.musicbrainz_id)
                    .take(40)
                    .collect();
                if !knowledge.similar_recording_mbids.is_empty() {
                    knowledge.sources.push("listenbrainz_radio".into());
                }
            }
        }
    }
}

pub fn clean_terms(values: Vec<String>, max: usize) -> Vec<String> {
    const PLACEHOLDERS: &[&str] = &[
        "groove",
        "instrumentation",
        "vocal delivery",
        "energy",
        "production texture",
        "audible vibe",
        "mood",
        "genre",
    ];
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|v| {
            v.trim()
                .trim_matches(|c: char| c == '.' || c == '-')
                .to_string()
        })
        .filter(|v| {
            let folded = v.to_lowercase();
            let measurement = [
                "bpm",
                "energy",
                "brightness",
                "loudness",
                "dynamic_range",
                "rhythmic_activity",
            ]
            .iter()
            .any(|name| {
                folded.starts_with(&format!("{name}=")) || folded.starts_with(&format!("{name}:"))
            });
            let numeric_only = folded
                .trim_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | '%' | '-' | '+'))
                .is_empty();
            v.len() >= 3
                && v.len() <= 48
                && !measurement
                && !numeric_only
                && !PLACEHOLDERS.contains(&folded.as_str())
                && seen.insert(folded)
        })
        .take(max)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_prompt_headings_and_duplicates() {
        let terms = clean_terms(
            vec![
                "Energy".into(),
                "dark".into(),
                " Dark ".into(),
                "bass-heavy".into(),
            ],
            8,
        );
        assert_eq!(terms, vec!["dark", "bass-heavy"]);
    }

    #[test]
    fn matching_ignores_punctuation_and_case() {
        assert!(exactish("Don't Fuk Me", "Dont Fuk Me"));
        assert!(!exactish("Moon Love", "Summertime Sadness"));
    }

    #[test]
    fn rejects_raw_measurements_as_descriptive_terms() {
        let terms = clean_terms(
            vec![
                "bpm=92.3".into(),
                "energy: 1.0".into(),
                "92%".into(),
                "syncopated guitar".into(),
            ],
            8,
        );
        assert_eq!(terms, vec!["syncopated guitar"]);
    }

    #[test]
    fn normalizes_taxonomy_confidence_and_absent_lyrics() {
        let profile = SemanticProfile {
            genres: vec!["Hip Hop".into(), "rap_music".into(), "made up genre".into()],
            moods: vec!["Melancholy".into(), "low_dynamic_range".into()],
            lyrical_themes: vec!["Heroism".into()],
            specific_tags: vec!["French house influenced".into()],
            confidence: CategoryConfidence {
                genres: 85.0,
                moods: -2.0,
                ..Default::default()
            },
            ..Default::default()
        }
        .normalize(false);
        assert_eq!(profile.genres, vec!["hip-hop"]);
        assert_eq!(profile.moods, vec!["melancholic"]);
        assert!(profile.lyrical_themes.is_empty());
        assert_eq!(
            profile.specific_tags,
            vec!["french-house-influenced", "made-up-genre"]
        );
        assert_eq!(profile.confidence.genres, 1.0);
        assert_eq!(profile.confidence.moods, 0.0);
    }

    #[test]
    fn deterministic_confidence_ignores_model_numbers() {
        let mut profile = SemanticProfile {
            genres: vec!["rock".into()],
            moods: vec!["tense".into()],
            musical_traits: vec!["guitar-driven".into()],
            specific_tags: vec!["noise-rock".into()],
            production_descriptors: vec!["distorted-guitars".into()],
            confidence: CategoryConfidence {
                genres: 99.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let score = profile.set_deterministic_confidence(false, true, false);
        assert!((score - 0.82).abs() < 0.001);
        assert!((profile.confidence.genres - 0.82).abs() < 0.001);
        assert_eq!(profile.confidence.lyrical_themes, 0.0);
    }

    #[test]
    fn validator_catches_missing_families_and_vocal_conflict() {
        let profile = SemanticProfile {
            summary: "A sufficiently long recording-level summary.".into(),
            specific_tags: vec!["instrumental-hip-hop".into()],
            ..Default::default()
        };
        let errors = semantic_validation_errors(&profile, true);
        assert!(errors.iter().any(|e| e.starts_with("genres")));
        assert!(errors.iter().any(|e| e.starts_with("moods")));
        assert!(errors.iter().any(|e| e.starts_with("musical_traits")));
        assert!(errors.iter().any(|e| e.starts_with("instrumental")));
    }

    #[test]
    fn preserves_specific_genres_and_derives_controlled_parents() {
        let profile = SemanticProfile {
            genres: vec![
                "Dance-punk".into(),
                "Electroclash".into(),
                "Plunderphonics".into(),
            ],
            moods: vec!["Defiant".into(), "Reflective".into()],
            musical_traits: vec!["Driving rhythm".into(), "Synthesizer-heavy".into()],
            ..Default::default()
        }
        .normalize(false);
        assert_eq!(profile.genres, vec!["punk", "dance", "electronic"]);
        assert_eq!(profile.moods, vec!["rebellious", "reflective"]);
        assert_eq!(
            profile.musical_traits,
            vec!["rhythm-forward", "synth-driven"]
        );
        assert!(profile.specific_tags.contains(&"dance-punk".into()));
        assert!(profile.specific_tags.contains(&"electroclash".into()));
        assert!(profile.specific_tags.contains(&"plunderphonics".into()));
    }

    #[test]
    fn absent_lyrics_confidence_does_not_penalize_profile() {
        let profile = SemanticProfile {
            confidence: CategoryConfidence {
                genres: 0.8,
                moods: 0.8,
                vibes: 0.8,
                musical_traits: 0.8,
                lyrical_themes: 0.0,
                specific_tags: 0.8,
            },
            ..Default::default()
        };
        assert!((profile.confidence_average_for(false) - 0.8).abs() < f32::EPSILON);
    }

    #[test]
    fn refinement_is_a_traceable_patch() {
        let fast = SemanticProfile {
            genres: vec!["rock".into()],
            moods: vec!["energetic".into()],
            summary: "fast".into(),
            ..Default::default()
        };
        let patch = RefinementPatch {
            add: SemanticFields {
                genres: vec!["punk".into()],
                specific_tags: vec!["riot grrrl".into()],
                ..Default::default()
            },
            remove: SemanticFields {
                moods: vec!["energetic".into()],
                ..Default::default()
            },
            summary: Some("refined".into()),
            ..Default::default()
        };
        let canonical = apply_patch(&fast, &patch, false);
        assert_eq!(canonical.genres, vec!["rock", "punk"]);
        assert!(canonical.moods.is_empty());
        assert_eq!(canonical.specific_tags, vec!["riot-grrrl"]);
        assert_eq!(canonical.summary, "refined");
    }
}
