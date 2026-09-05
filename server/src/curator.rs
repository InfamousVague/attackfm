//! The curator: a process that never stops listening to what you listen to.
//!
//! Two jobs, both running forever in the background from boot:
//!
//! 1. **Enrichment.** A library's tags say what a song IS but not what it is
//!    LIKE. So every track is slowly looked up and given two things it did not
//!    have: a tempo, read off the public catalogue, and a vector standing for
//!    what its words are about, computed by the local model from the lyrics
//!    already in the index. A few tracks per cycle, resumable, stamped so a
//!    restart picks up where it left off and a track is never asked about
//!    twice in a day.
//!
//! 2. **Curation.** Every listener with recent plays gets a handful of
//!    playlists rebuilt from their own history: what they have been playing
//!    decides a target tempo, a set of genres and a centre of lyrical
//!    gravity, and the whole library is scored against those three. The model
//!    names the results when one is configured; when none is, the same maths
//!    runs and the names are plain. The recommendations are the maths either
//!    way - the model is a writer here, not an oracle.
//!
//! Nothing here leaves the listener's own server. The catalogue lookup sends a
//! title and an artist to Deezer to ask a tempo; the words themselves only ever
//! go to the model the operator pointed at, which is theirs.

use crate::db::{CurationTrack, TrackFeatures};
use crate::enrichment::{
    apply_patch, listenbrainz, musicbrainz, normalize_specific_tag, semantic_validation_errors,
    RefinementPatch, SemanticProfile, SpecificTagDecisionBatch, CONTROLLED_GENRES,
    CONTROLLED_MOODS, CONTROLLED_TRAITS, CONTROLLED_VIBES, FAST_PROMPT_VERSION,
    REFINEMENT_PROMPT_VERSION,
};
use crate::AppState;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// How long a track's lookup stands before it is worth asking again. Tempo
/// does not change, but a track whose lyrics arrived later deserves a vector.
const FEATURE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// How soon to come back for a track with no vector yet. Short, because that gap
/// usually means the embedder was not running when the track was first looked at
/// - exactly the case when a model is switched on for a library already read once.
const VECTOR_RETRY_MS: i64 = 3 * 60 * 1000;
/// Tracks looked up per cycle. A background errand that must never be the reason
/// a stream stutters - but embeddings are cheap and the tempo is measured only
/// once, so a fresh library backfills its vectors in minutes, not an hour.
const ENRICH_BATCH: i64 = 24;
const AI_ENRICH_BATCH: i64 = 2;
const AI_ENRICH_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// Politeness gap between catalogue lookups.
const LOOKUP_GAP: Duration = Duration::from_millis(900);

/// Keep the learned vocabulary about reusable sounds and styles. Identity
/// facts, broad parents, lyrical phrases, and production traits belong in
/// their own fields rather than becoming permanent `specific_tags`.
fn enforce_specific_tag_boundaries(profile: &mut SemanticProfile) {
    let mut kept = Vec::new();
    let mut production = Vec::new();
    for raw in std::mem::take(&mut profile.specific_tags) {
        let tag = normalize_specific_tag(&raw);
        if tag.is_empty()
            || CONTROLLED_GENRES.contains(&tag.as_str())
            || CONTROLLED_MOODS.contains(&tag.as_str())
            || CONTROLLED_VIBES.contains(&tag.as_str())
            || CONTROLLED_TRAITS.contains(&tag.as_str())
            || tag.contains("area-code")
            || tag.contains("lifestyle-reference")
            || tag.contains("luxury-lifestyle")
            || tag.ends_with("-persona")
            || tag.split('-').count() > 6
        {
            continue;
        }
        if tag.ends_with("-textures")
            || tag.ends_with("-vocals")
            || tag.ends_with("-percussion")
            || tag.ends_with("-production")
        {
            production.push(tag);
        } else if !kept.contains(&tag) {
            kept.push(tag);
        }
    }
    for tag in production {
        if !profile.production_descriptors.contains(&tag) {
            profile.production_descriptors.push(tag);
        }
    }
    profile.production_descriptors.truncate(8);
    profile.specific_tags = kept;
}

/// The reviewer may delete or reorganize Qwen's tags, but one community lookup
/// is not enough authority to invent new canonical vocabulary. New descriptors
/// must originate in the independent fast pass; later versions can admit a new
/// term when two truly independent evidence sources are represented explicitly.
fn prevent_reviewer_tag_expansion(fast: &SemanticProfile, patch: &mut RefinementPatch) {
    let allowed = fast
        .specific_tags
        .iter()
        .map(|tag| normalize_specific_tag(tag))
        .collect::<HashSet<_>>();
    for tags in [
        &mut patch.add.specific_tags,
        &mut patch.replace.specific_tags,
    ] {
        tags.retain(|tag| allowed.contains(&normalize_specific_tag(tag)));
    }
}

async fn reconcile_specific_tags(
    state: &Arc<AppState>,
    client: &crate::ai::AiClient,
    track_id: i64,
    profile: &mut SemanticProfile,
) {
    let mut canonical = Vec::new();
    let mut undecided = Vec::new();
    for raw in profile.specific_tags.clone() {
        let normalized = normalize_specific_tag(&raw);
        if normalized.is_empty() {
            continue;
        }
        if let Some(existing) = state.db.specific_tag_exact(&normalized) {
            let _ = state.db.record_specific_tag_decision(
                track_id,
                &raw,
                &normalized,
                Some(&existing),
                "reuse",
                &json!([]),
                "exact-or-alias",
                "",
                None,
            );
            if !canonical.contains(&existing) {
                canonical.push(existing);
            }
            continue;
        }
        let embedding = client
            .embed(&format!("Music descriptor meaning and usage: {normalized}"))
            .await
            .ok();
        // Embeddings retrieve possibilities; they do not establish synonymy.
        // Only a very close, already-established descriptor may be reused by
        // the model.  Everything else remains a distinct provisional term.
        let candidates = embedding
            .as_deref()
            .map(|v| state.db.specific_tag_candidates(v, 8))
            .unwrap_or_default()
            .into_iter()
            .filter(|candidate| candidate.status == "established" && candidate.similarity >= 0.93)
            .take(4)
            .collect::<Vec<_>>();
        undecided.push((raw, normalized, embedding, candidates));
    }
    if !undecided.is_empty() {
        let comparison = undecided
            .iter()
            .map(|(_, tag, _, candidates)| {
                json!({
                    "input_tag": tag,
                    "closest_existing": candidates,
                })
            })
            .collect::<Vec<_>>();
        let prompt = format!("Resolve open-ended music descriptors against a learned vocabulary. Similarity only retrieves candidates; it does not prove equivalence. Preserve meaningful distinctions (for example dream-pop is not automatically shoegaze). For each input choose exactly one action: reuse an existing canonical tag only when meaning is equivalent in music-discovery use; keep-new when it is useful and distinct; reject when it is vague, malformed, redundant, or not a music descriptor. canonical_tag must be one supplied existing tag for reuse, the input_tag for keep-new, and empty for reject. Give a short reusable description for keep-new. Return one decision per input.\nRecording profile context: {}\nComparisons: {}",
            serde_json::to_string(profile).unwrap_or_default(), serde_json::to_string(&comparison).unwrap_or_default());
        let schema = json!({"type":"object","additionalProperties":false,"required":["decisions"],"properties":{"decisions":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["input_tag","action","canonical_tag","description","reason"],"properties":{"input_tag":{"type":"string"},"action":{"type":"string","enum":["reuse","keep-new","reject"]},"canonical_tag":{"type":"string"},"description":{"type":"string","maxLength":180},"reason":{"type":"string","maxLength":140}}}}}});
        let decisions = client.chat_json::<SpecificTagDecisionBatch>(
            "You maintain a precise, evolving vocabulary of music descriptors. Merge synonyms, not merely related concepts.",
            &prompt, "attackfm_specific_tag_registry_v1", schema, false).await.ok();
        for (raw, normalized, embedding, candidates) in undecided {
            let decision = decisions.as_ref().and_then(|batch| {
                batch
                    .decisions
                    .iter()
                    .find(|d| normalize_specific_tag(&d.input_tag) == normalized)
            });
            let candidate_json = serde_json::to_value(&candidates).unwrap_or_else(|_| json!([]));
            let (action, chosen, description, decided_by) = match decision {
                Some(d)
                    if d.action == "reuse"
                        && candidates
                            .iter()
                            .any(|c| c.canonical_tag == d.canonical_tag) =>
                {
                    (
                        "reuse",
                        Some(d.canonical_tag.clone()),
                        d.description.as_str(),
                        "model-equivalence",
                    )
                }
                Some(d) if d.action == "reject" => {
                    ("reject", None, d.description.as_str(), "model-equivalence")
                }
                Some(d) => (
                    "keep-new",
                    Some(normalized.clone()),
                    d.description.as_str(),
                    "model-equivalence",
                ),
                None => (
                    "keep-new",
                    Some(normalized.clone()),
                    "Provisional music descriptor awaiting repeated evidence.",
                    "safe-fallback",
                ),
            };
            let _ = state.db.record_specific_tag_decision(
                track_id,
                &raw,
                &normalized,
                chosen.as_deref(),
                action,
                &candidate_json,
                decided_by,
                description,
                embedding.as_deref(),
            );
            if let Some(tag) = chosen {
                if !canonical.contains(&tag) {
                    canonical.push(tag);
                }
            }
        }
    }
    canonical.truncate(16);
    profile.specific_tags = canonical;
}
/// Between cycles with work left to do.
const BUSY_SLEEP: Duration = Duration::from_secs(15);
/// Between cycles when the library is fully enriched.
const IDLE_SLEEP: Duration = Duration::from_secs(300);
/// How often one listener's playlists are rebuilt.
const CURATE_EVERY_MS: i64 = 30 * 60 * 1000;
/// The listening window that counts as "lately".
const WINDOW_30D_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Tracks per curated list.
pub(crate) const LIST_LEN: usize = 30;
/// At most this many by one artist in a list, so a favourite cannot fill it.
const PER_ARTIST_CAP: usize = 2;

/// "shoegaze" -> "Shoegaze", for list names built from folded tags.
pub(crate) fn title_case(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn ai_url() -> Option<String> {
    crate::ai::setting("url", "AFM_AI_URL")
}

/// The chat model, and whether there is one at all.
///
/// Deliberately not defaulted: writing the playlist names is the EXPENSIVE half
/// of this, and on a one-core box a chat model that was assumed rather than
/// configured means every curation cycle waits out a long timeout against a
/// model that was never pulled. Embeddings - the
/// half that actually drives the recommendations - run off their own switch
/// below, so a server can read lyrics without ever generating a word.
pub(crate) fn ai_chat_model() -> Option<String> {
    crate::ai::setting("chatModel", "AFM_AI_MODEL")
}

/// The embedding model. Separate from the chat model because they are
/// different things: an embedder is small and fast and the chat model usually
/// cannot embed at all.
fn embed_model() -> String {
    crate::ai::setting("embedModel", "AFM_AI_EMBED_MODEL")
        .unwrap_or_else(|| "nomic-embed-text".to_string())
}

fn client(secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(secs))
        .build()
        .unwrap_or_default()
}

/// Live state the endpoints read: what the loop is doing right now.
#[derive(Default)]
pub struct CuratorState {
    pub status: tokio::sync::Mutex<Status>,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// What the loop is up to: "enriching", "curating", "idle".
    pub phase: String,
    /// Epoch ms of the last completed curation pass.
    pub last_curated: i64,
    /// Whether an embedder is reachable - the half that reads lyrics.
    pub ai: bool,
    /// Whether a chat model is configured - the half that writes the names. Off
    /// by default, and not needed for the recommendations.
    pub chat: bool,
    /// Whether the embedder answered last time it was asked - the difference
    /// between "lyrics are being read" and "only tempo and genre are".
    pub embeddings: bool,
}

impl CuratorState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

// --- the loop ----------------------------------------------------------------

/// Starts the curator. Runs until the process ends.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        // A breath before the first cycle: the scanner is indexing at boot and
        // deserves the disk to itself.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let did_work = enrich_cycle(&state).await;
            let ai_work = fast_enrich_cycle(&state).await;
            // Keep the two semantic passes genuinely staged across the whole
            // library. Qwen first builds and normalizes every eligible fast
            // profile; only once that durable queue is empty may Gemma begin
            // applying and normalizing refinement patches.
            let refined = if fast_profiles_pending(&state) {
                false
            } else {
                refinement_cycle(&state).await
            };
            if refined {
                note_cycle(&state, "refinement", "Went back over a profile", &crate::ai::refinement_model());
            }
            curate_cycle(&state).await;
            // Then the world outside the library: harvest candidates, listen to
            // a couple, and keep the shelf honest about what is already owned.
            let discovered = discovery_cycle(&state).await;
            if discovered {
                note_cycle(&state, "discovery", "Looked for new music", "Outside the library");
            }
            tokio::time::sleep(if did_work || ai_work || refined || discovered {
                BUSY_SLEEP
            } else {
                IDLE_SLEEP
            })
            .await;
        }
    });
}

/// One pass of everything the loop does, on demand.
///
/// The same four cycles in the same order as the loop body, because staging is
/// the whole point of that order - the fast pass has to have drained before the
/// auditor may start, or the auditor spends its time on profiles that are about
/// to be rewritten. Exists so the owner can press a button instead of waiting
/// out an idle sleep, and returns whether anything actually needed doing.
/// One activity line for a pass that did something. Silent when it did not:
/// the loop wakes constantly and finds nothing to do, and a row for each of
/// those would bury the ones that matter.
fn note_cycle(state: &Arc<AppState>, kind: &str, title: &str, body: &str) {
    state.db.record_activity(crate::db::NewActivity {
        source: "ai",
        kind,
        state: "info",
        // Time-keyed, because these are single moments rather than a start and
        // a finish - there is nothing for a later row to replace.
        key: &format!("ai:{kind}:{}", now_ms()),
        title,
        body,
        track_id: None,
        detail: None,
    });
}

pub async fn run_once(state: Arc<AppState>) -> bool {
    let enriched = enrich_cycle(&state).await;
    let fast = fast_enrich_cycle(&state).await;
    let refined = if fast_profiles_pending(&state) {
        false
    } else {
        refinement_cycle(&state).await
    };
    curate_cycle(&state).await;
    let discovered = discovery_cycle(&state).await;
    enriched || fast || refined || discovered
}

fn enrichment_allowlist() -> Option<HashSet<i64>> {
    std::env::var("AFM_ENRICH_TRACK_IDS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .filter_map(|id| id.trim().parse::<i64>().ok())
                .collect::<HashSet<_>>()
        })
        .filter(|ids| !ids.is_empty())
}

fn fast_profiles_pending(state: &AppState) -> bool {
    let allowlist = enrichment_allowlist();
    let query_limit = if allowlist.is_some() { i64::MAX } else { 1 };
    let ids = state
        .db
        .tracks_needing_fast_profile(query_limit, now_ms() - AI_ENRICH_TTL_MS);
    match allowlist {
        Some(allowed) => ids.into_iter().any(|id| allowed.contains(&id)),
        None => !ids.is_empty(),
    }
}

/// Slowly gives every song a richer musical description. The database query is
/// the durable queue: unfinished tracks remain at the front across restarts.
/// Chat work only starts when neither playback nor importing needs the box.
async fn fast_enrich_cycle(state: &Arc<AppState>) -> bool {
    if ai_chat_model().is_none() || ai_url().is_none() || state.connect.any_playing().await {
        return false;
    }
    if state
        .imports
        .jobs
        .lock()
        .await
        .iter()
        .any(|j| crate::imports::local(j) && (j.state == "queued" || j.state == "downloading"))
    {
        return false;
    }
    let allowlist = enrichment_allowlist();
    let query_limit = if allowlist.is_some() {
        i64::MAX
    } else {
        AI_ENRICH_BATCH
    };
    let mut ids = state
        .db
        .tracks_needing_fast_profile(query_limit, now_ms() - AI_ENRICH_TTL_MS);
    if let Some(allowlist) = &allowlist {
        ids.retain(|id| allowlist.contains(id));
        ids.truncate(AI_ENRICH_BATCH as usize);
    }
    if ids.is_empty() {
        return false;
    }
    let Some(client) = crate::ai::AiClient::configured() else {
        return false;
    };
    // Qwen is the fast usability layer. Operators can override the exact tag.
    let client = client.with_chat_model(crate::ai::fast_model());
    // A BATCH-level pair, not one per song. A fresh library has thousands of
    // tracks needing a first profile, and a notice each would be a pager rather
    // than a notification - the useful unit is "the AI started a pass over N
    // songs" and "it finished". The key is the batch, so the two collapse into
    // one row that changes state.
    let batch_key = format!("ai:fast:{}", now_ms());
    state.db.record_activity(crate::db::NewActivity {
        source: "ai",
        kind: "fast-profile",
        state: "started",
        key: &batch_key,
        title: "Listening to new songs",
        body: &format!("{} to profile · {}", ids.len(), crate::ai::fast_model()),
        track_id: None,
        detail: None,
    });
    let mut profiled = 0usize;
    for track in state.db.tracks_for_curation(&ids) {
        // Re-check between songs so a newly started stream/download preempts
        // the next job rather than waiting for the whole batch.
        if state.connect.any_playing().await
            || state
                .imports
                .jobs
                .lock()
                .await
                .iter()
                .any(|j| crate::imports::local(j) && (j.state == "queued" || j.state == "downloading"))
        {
            break;
        }
        let mut external = musicbrainz(&track).await;
        listenbrainz(&track, &mut external).await;
        let lyrics: String = track.lyrics.chars().take(1200).collect();
        let prompt = format!("Analyze this specific recording for music discovery. First reason from rhythm, instrumentation/production, vocals, structure, mood, and energy. Track-level audible evidence dominates. Artist, album, soundtrack placement, franchise, popularity, and the artist's usual style are identity context only and must not determine classification. Do not repeat numeric audio facts. Use 1-3 broad parents in genres and place subgenres or partial influences in specific_tags/influences; preserve sharp genre contrasts. Every label must be supported by supplied evidence. Do not promote a brief influence to a primary genre. Do not call a vocal recording instrumental. Do not invent regional scenes, eras, lyrical claims, or community provenance. Musical mood is not a literal reading of lyrics. Express uncertainty by omitting weak claims. Recommendations will use concrete musical properties, so production_descriptors should capture useful instrumentation, vocal, structural, and sound-design detail. Preferred broad vocabulary (the server also normalizes useful variants):\ngenres: {}\nmoods: {}\nvibes: {}\nmusical_traits: {}\nNever claim lyrical themes unless the lyrics excerpt is non-empty. Summary under 55 words.\nTitle: {}\nArtist: {}\nAlbum (identity only): {}\nSource genre (untrusted hint): {}\nYear: {}\nAuthoritative measured facts (read-only): bpm={:?}, energy={:?}, brightness={:?}, loudness={:?}, dynamic_range={:?}, rhythmic_activity={:?}, duration_seconds={:?}\nTrusted recording-level community tags: {}\nLyrics available: {}\nLyrics excerpt: {}",
            CONTROLLED_GENRES.join(", "), CONTROLLED_MOODS.join(", "), CONTROLLED_VIBES.join(", "),
            CONTROLLED_TRAITS.join(", "), track.title, track.artist, track.album, track.genre,
            track.year.map(|y| y.to_string()).unwrap_or_default(), track.bpm, track.energy,
            track.brightness, track.loudness, track.dynamic_range, track.rhythmic_activity,
            track.duration_ms.map(|v| v as f64 / 1000.0), external.tags.join(", "),
            !lyrics.trim().is_empty(), lyrics);
        let schema = semantic_schema(false);
        if let Ok(raw) = client.chat_json::<SemanticProfile>("You catalogue one specific recording from supplied evidence. Audible properties outrank identity context. Return semantic interpretation only; never output numeric measurements or unsupported claims.", &prompt, "attackfm_fast_profile_v4", schema.clone(), false).await {
            let lyrics_available = !track.lyrics.trim().is_empty();
            let mut info = raw.clone().normalize(lyrics_available);
            let mut errors = semantic_validation_errors(&info, lyrics_available);
            let mut repaired = false;
            if !errors.is_empty() {
                let repair_prompt = format!("Repair the candidate profile using the exact validator errors below. You are an editor, not a fresh classifier. Preserve every specific evidence-supported term and genre contrast. Do not add claims that are absent from the recording evidence. Broad fields should use the preferred vocabulary; useful subgenres belong in specific_tags. Return the complete corrected profile.\nValidator errors:\n- {}\nOriginal recording evidence:\n{}\nRejected candidate JSON:\n{}",
                    errors.join("\n- "), prompt, serde_json::to_string(&raw).unwrap_or_default());
                if let Ok(candidate) = client.chat_json::<SemanticProfile>("Repair only the supplied music profile. Preserve supported specificity, remove unsupported claims, and satisfy the schema.", &repair_prompt, "attackfm_fast_profile_repair_v1", schema, false).await {
                    let normalized = candidate.normalize(lyrics_available);
                    let candidate_errors = semantic_validation_errors(&normalized, lyrics_available);
                    if candidate_errors.len() < errors.len() {
                        info = normalized;
                        repaired = true;
                    }
                }
            }
            enforce_specific_tag_boundaries(&mut info);
            reconcile_specific_tags(state, &client, track.id, &mut info).await;
            errors = semantic_validation_errors(&info, lyrics_available);
            if !errors.is_empty() || info.summary.eq_ignore_ascii_case(&track.title) {
                state.db.mark_ai_enrichment_rejected(track.id);
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let confidence = info.set_deterministic_confidence(
                lyrics_available,
                !external.tags.is_empty(),
                repaired,
            );
            let knowledge = format!("{}\nGenres and styles: {}\nMusical traits: {}\nMoods: {}\nLyrical themes: {}", info.summary, info.genres.join(", "), info.musical_traits.join(", "), info.moods.join(", "), info.lyrical_themes.join(", "));
            let vector = embed_text(&knowledge).await;
            let sonic_vector = embed_text(&format!(
                "Genres: {}\nMeasured and supported sonic traits: {}\nMoods: {}",
                info.genres.join(", "), info.musical_traits.join(", "), info.moods.join(", ")
            )).await;
            let lyrical_vector = if info.lyrical_themes.is_empty() { None } else {
                embed_text(&format!("Lyrical themes: {}", info.lyrical_themes.join(", "))).await
            };
            let community_vector = if external.tags.is_empty() { None } else {
                embed_text(&format!("Community catalogue tags: {}", external.tags.join(", "))).await
            };
            let mut sources = vec!["measured_audio".to_string()];
            if !track.lyrics.trim().is_empty() { sources.push("lyrics".into()); }
            sources.extend(external.sources.clone());
            let _ = state.db.save_ai_enrichment(track.id, &info.summary, &info.genres, &info.moods,
                &info.musical_traits, &info.lyrical_themes, confidence, &sources,
                &external.tags, &external.musicbrainz_id,
                &external.similar_recording_mbids, external.listen_count,
                external.listener_count, sonic_vector.as_deref(),
                lyrical_vector.as_deref(), community_vector.as_deref(),
                vector.as_deref());
            let _ = state.db.save_layered_profile(track.id, &info, None, &info,
                client.chat_model(), FAST_PROMPT_VERSION, false);
            profiled += 1;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    // Closes the pair opened above, whether the batch ran to the end or broke
    // early because somebody pressed play - which is a perfectly good outcome
    // and should read as one, not as a failure.
    state.db.record_activity(crate::db::NewActivity {
        source: "ai",
        kind: "fast-profile",
        state: "done",
        key: &batch_key,
        title: "Finished listening",
        body: &format!("{profiled} of {} songs profiled", ids.len()),
        track_id: None,
        detail: None,
    });
    true
}

fn semantic_schema(patch: bool) -> serde_json::Value {
    let terms = || json!({"type":"array","maxItems":12,"items":{"type":"string"}});
    // Keep JSON structure strict but normalize semantic vocabulary server-side.
    // Requiring enum membership here prevents useful subgenres and aliases from
    // ever reaching the overflow/parent mapper.
    let controlled_terms = |_values: &[&str], max: usize, require_value: bool| json!({"type":"array","minItems":if require_value { 1 } else { 0 },"maxItems":max,"items":{"type":"string"}});
    let confidence = json!({"type":"object","additionalProperties":false,
        "required":["genres","moods","vibes","musical_traits","lyrical_themes","specific_tags"],
        "properties":{"genres":{"type":"number","minimum":0,"maximum":1},"moods":{"type":"number","minimum":0,"maximum":1},
        "vibes":{"type":"number","minimum":0,"maximum":1},"musical_traits":{"type":"number","minimum":0,"maximum":1},
        "lyrical_themes":{"type":"number","minimum":0,"maximum":1},"specific_tags":{"type":"number","minimum":0,"maximum":1}}});
    let fields = |require_controlled_values: bool| {
        let required = if require_controlled_values {
            json!([
                "genres",
                "moods",
                "vibes",
                "musical_traits",
                "lyrical_themes",
                "specific_tags",
                "scenes",
                "movements",
                "eras",
                "influences",
                "cultural_context",
                "production_descriptors"
            ])
        } else {
            json!([])
        };
        json!({"type":"object","additionalProperties":false,
        "required":required,
        "properties":{"genres":controlled_terms(CONTROLLED_GENRES,5,require_controlled_values),"moods":controlled_terms(CONTROLLED_MOODS,6,require_controlled_values),
        "vibes":controlled_terms(CONTROLLED_VIBES,6,require_controlled_values),"musical_traits":controlled_terms(CONTROLLED_TRAITS,8,require_controlled_values),
        "lyrical_themes":terms(),"specific_tags":terms(),
        "scenes":terms(),"movements":terms(),"eras":terms(),"influences":terms(),"cultural_context":terms(),"production_descriptors":terms()}})
    };
    if patch {
        json!({"type":"object","additionalProperties":false,"required":["add","remove","replace","summary","confidence","reasoning_summary"],
            "properties":{"add":fields(false),"remove":fields(false),"replace":fields(false),"summary":{"type":["string","null"]},"confidence":confidence,"reasoning_summary":{"type":"string","maxLength":300}}})
    } else {
        let mut properties = fields(true)["properties"].clone();
        properties["summary"] = json!({"type":"string","maxLength":420});
        properties["confidence"] = confidence;
        json!({"type":"object","additionalProperties":false,
            "required":["genres","moods","vibes","musical_traits","lyrical_themes","specific_tags","scenes","movements","eras","influences","cultural_context","production_descriptors","summary","confidence"],
            "properties":properties})
    }
}

/// Gemma reviews the usable fast profile later and returns an explicit patch.
/// It never holds up import, scan, playback, search, or the first DJ match.
async fn refinement_cycle(state: &Arc<AppState>) -> bool {
    if ai_url().is_none() || state.connect.any_playing().await {
        return false;
    }
    let Some(base) = crate::ai::AiClient::configured() else {
        return false;
    };
    let model = crate::ai::refinement_model();
    let client = base.with_chat_model(model);
    let allowed = enrichment_allowlist();
    let limit = if allowed.is_some() { i64::MAX } else { 1 };
    let mut ids = state
        .db
        .tracks_needing_refinement(limit, now_ms() - AI_ENRICH_TTL_MS);
    if let Some(allowed) = allowed {
        ids.retain(|id| allowed.contains(id));
        ids.truncate(1);
    }
    let Some(track) = state.db.tracks_for_curation(&ids).into_iter().next() else {
        return false;
    };
    let Some(fast) = state.db.fast_profile(track.id) else {
        return false;
    };
    let lyrics: String = track.lyrics.chars().take(2400).collect();
    let mut external = musicbrainz(&track).await;
    listenbrainz(&track, &mut external).await;
    let prompt = format!("Audit the supplied profile claim by claim for accuracy. You are a skeptical reviewer, not a creative classifier. Remove claims that cannot be grounded in the evidence below. Identity metadata (artist, title, album, release year) identifies the recording but is NOT evidence for genre, era, scene, franchise aesthetics, instrumentation, or cultural context. Numeric measurements support only tempo/energy/brightness/dynamics/rhythmic claims; they cannot identify instruments. Lyrics support lyrical themes only, never instrumentation or musical mood. Community tags are noisy supporting hints, not truth: use them to corroborate an existing claim, never copy their list into the profile and never add a new specific_tag from them. A production or instrumentation claim with no supporting evidence must be removed or rewritten as a cautious measurable trait. Preserve sharp, supported genre contrasts and narrow tags. Prefer omission over plausible invention. Do not add era, scene, movement, influence, or cultural-context claims. Do not replace a narrow accurate term with a generic parent. Do not place broad genres, identity facts, lyrical phrases, personas, or production traits in specific_tags. The summary must obey the same evidence rules as structured fields and must not print raw numeric measurements. OMIT unchanged fields and empty arrays inside add/remove/replace. For any one field, use only one operation; replace only when the entire category is wrong. Keep reasoning_summary under 40 words and name the evidence used for every change.\nSource identity only: title={}, artist={}, album={}, source_genre={}, year={:?}\nAuthoritative measured facts (read-only): bpm={:?}, energy={:?}, brightness={:?}, loudness={:?}, dynamic_range={:?}, rhythmic_activity={:?}\nNoisy recording-level community hints (corroboration only): {}\nExisting Qwen fast profile: {}\nLyrics available: {}\nLyrics excerpt: {}",
        track.title, track.artist, track.album, track.genre, track.year, track.bpm, track.energy, track.brightness,
        track.loudness, track.dynamic_range, track.rhythmic_activity, external.tags.join(", "), serde_json::to_string(&fast).unwrap_or_default(),
        !lyrics.trim().is_empty(), lyrics);
    match client.chat_json::<RefinementPatch>("You are AttackFM's evidence auditor. Return only a conservative corrective patch. Delete unsupported claims; never fill gaps with world knowledge. Deterministic audio facts are immutable.",
        &prompt, "attackfm_refinement_patch_v3", semantic_schema(true), false).await {
        Ok(mut patch) => {
            // Normalize every patch side through the same validator by applying
            // it and storing both raw change intent and validated canonical.
            patch.reasoning_summary = patch.reasoning_summary.trim().chars().take(300).collect();
            prevent_reviewer_tag_expansion(&fast, &mut patch);
            let lyrics_available = !track.lyrics.trim().is_empty();
            let mut canonical = apply_patch(&fast, &patch, lyrics_available);
            enforce_specific_tag_boundaries(&mut canonical);
            reconcile_specific_tags(state, &client, track.id, &mut canonical).await;
            let errors = semantic_validation_errors(&canonical, lyrics_available);
            if errors.is_empty() {
                canonical.set_reviewed_confidence(
                    &fast,
                    lyrics_available,
                    !external.tags.is_empty(),
                );
                let _ = state.db.save_layered_profile(track.id, &fast, Some(&patch), &canonical,
                    client.chat_model(), REFINEMENT_PROMPT_VERSION, true);
            } else {
                eprintln!("[enrichment] refinement rejected for {}: {}", track.id, errors.join("; "));
            }
        }
        Err(error) => eprintln!("[enrichment] refinement failed for {}: {}", track.id, error),
    }
    true
}

/// One enrichment batch. Returns whether there was anything to do, which is
/// what decides how soon the loop comes back.
async fn enrich_cycle(state: &Arc<AppState>) -> bool {
    let stale_before = now_ms() - FEATURE_TTL_MS;
    let vector_before = now_ms() - VECTOR_RETRY_MS;
    // Only chase missing vectors when there is something that could produce
    // one; otherwise every lyric-bearing track would be revisited forever.
    let ids = state.db.tracks_needing_features(
        ENRICH_BATCH,
        stale_before,
        vector_before,
        ai_url().is_some(),
    );
    if ids.is_empty() {
        let mut s = state.curator.status.lock().await;
        s.phase = "idle".into();
        s.ai = ai_url().is_some();
        s.chat = ai_chat_model().is_some();
        return false;
    }
    {
        let mut s = state.curator.status.lock().await;
        s.phase = "enriching".into();
        s.ai = ai_url().is_some();
        s.chat = ai_chat_model().is_some();
    }

    let tracks = state.db.tracks_for_curation(&ids);
    for track in tracks {
        // The tempo is measured off the file on this box - see tempo.rs for
        // why the catalogues could not supply it. Skipped when it is already
        // known: on a lyrics backfill pass that would mean decoding a minute of
        // audio to learn nothing.
        let bpm = if track.has_bpm {
            None
        } else {
            match state.db.track_rel_path(track.id) {
                Some(rel) => crate::tempo::analyze(&state.music_root.join(rel)).await,
                None => None,
            }
        };
        let vec = if track.has_vec {
            None
        } else {
            embed_track(&track).await
        };
        if vec.is_some() {
            let mut s = state.curator.status.lock().await;
            s.embeddings = true;
        }
        let _ = state.db.save_features(
            track.id,
            bpm,
            if bpm.is_some() { "local" } else { "" },
            vec.as_deref(),
        );
        tokio::time::sleep(LOOKUP_GAP).await;
    }
    true
}

/// A vector for a track's overall character, from the operator's own embedder.
///
/// The metadata every track carries - artist, title, album, genre - leads, and
/// the lyrics follow when there are any. That is deliberate: embedding lyrics
/// alone left every instrumental, every mis-tagged rip and every track a lyrics
/// provider did not cover with no vector at all, which is most of a fresh
/// library. Folding the metadata in means EVERY track gets a usable vector, and
/// the lyrics sharpen the ones that have them rather than being the whole signal.
///
/// No model or an embedder that will not answer: no vector, and the curator
/// falls back on tempo and genre alone.
async fn embed_track(track: &CurationTrack) -> Option<Vec<f32>> {
    let url = ai_url()?;
    let mut parts: Vec<String> = Vec::new();
    if !track.artist.trim().is_empty() {
        parts.push(format!("Artist: {}", track.artist.trim()));
    }
    if !track.title.trim().is_empty() {
        parts.push(format!("Title: {}", track.title.trim()));
    }
    if !track.album.trim().is_empty() {
        parts.push(format!("Album: {}", track.album.trim()));
    }
    if !track.genre.trim().is_empty() {
        parts.push(format!("Genre: {}", track.genre.trim()));
    }
    // Enough lyrics to characterise a song without paying for a whole repeated
    // chorus, and leaving room for the metadata above under the input cap.
    let words = track.lyrics.trim();
    if !words.is_empty() {
        let excerpt: String = words.chars().take(1500).collect();
        parts.push(format!("Lyrics: {excerpt}"));
    }
    let input: String = parts.join("\n").chars().take(2000).collect();
    if input.trim().is_empty() {
        return None;
    }
    let reply: serde_json::Value = client(60)
        .post(format!("{}/v1/embeddings", url.trim_end_matches('/')))
        .json(&json!({ "model": embed_model(), "input": input }))
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

// --- scoring -----------------------------------------------------------------

pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= 0.0 || nb <= 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// What a listener has been into lately, in the three terms the curator scores
/// against.
pub(crate) struct Taste {
    /// The centre of lyrical gravity: the mean of what they play.
    pub(crate) centroid: Option<Vec<f32>>,
    /// The tempo they gravitate to (median of what has one).
    pub(crate) tempo: Option<f64>,
    /// Genres by share of recent plays.
    pub(crate) genres: HashMap<String, f32>,
    /// Everything they have played lately - excluded from recommendations, so
    /// a "discover" list is not a mirror. No live surface reads it any more:
    /// the DJ and the radio hold `UserTaste::heard` and `rejected` instead.
    /// Kept because `taste_from_weighted` is the old-model baseline the
    /// offline evaluator (taste.rs `mod eval`) scores the new model against.
    #[allow(dead_code)]
    pub(crate) heard: HashSet<i64>,
}

pub(crate) fn taste_from(plays: &[i64], feats: &HashMap<i64, &TrackFeatures>) -> Taste {
    let weighted: Vec<(i64, f32)> = plays.iter().map(|id| (*id, 1.0)).collect();
    taste_from_weighted(&weighted, feats)
}

/// Taste built from VERDICTS: every contribution scaled by what actually
/// happened to the track. Weight 1.0 is the old behaviour (a play is a play);
/// a skip's 0.15 means ten abandonments finally stop outvoting one completion.
/// `heard` keeps every id regardless of weight - a skipped song is still a
/// song the listener met, and a discover list must not offer it straight back.
pub(crate) fn taste_from_weighted(
    plays: &[(i64, f32)],
    feats: &HashMap<i64, &TrackFeatures>,
) -> Taste {
    let mut sum: Vec<f32> = Vec::new();
    let mut wsum = 0.0f32;
    let mut tempos: Vec<(f64, f32)> = Vec::new();
    let mut genres: HashMap<String, f32> = HashMap::new();

    for (id, w) in plays {
        let w = w.max(0.0);
        if w <= 0.0 {
            continue;
        }
        let Some(f) = feats.get(id) else { continue };
        if let Some(v) = &f.lyric_vec {
            if sum.is_empty() {
                sum = vec![0.0; v.len()];
            }
            if sum.len() == v.len() {
                for (s, x) in sum.iter_mut().zip(v) {
                    *s += *x * w;
                }
                wsum += w;
            }
        }
        if let Some(b) = f.bpm {
            tempos.push((b, w));
        }
        if !f.genre.trim().is_empty() {
            *genres.entry(f.genre.to_lowercase()).or_insert(0.0) += w;
        }
    }

    let centroid = (wsum > 0.0).then(|| sum.iter().map(|x| x / wsum).collect::<Vec<f32>>());
    // Weighted median: the bpm where half the listened WEIGHT sits below.
    tempos.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let half: f32 = tempos.iter().map(|(_, w)| w).sum::<f32>() / 2.0;
    let tempo = (!tempos.is_empty()).then(|| {
        let mut acc = 0.0f32;
        for (b, w) in &tempos {
            acc += w;
            if acc >= half {
                return *b;
            }
        }
        tempos[tempos.len() - 1].0
    });
    let total: f32 = genres.values().sum();
    if total > 0.0 {
        for v in genres.values_mut() {
            *v /= total;
        }
    }

    Taste {
        centroid,
        tempo,
        genres,
        heard: plays.iter().map(|(id, _)| *id).collect(),
    }
}

/// How well one track answers a taste, in [0, 1]. Each term degrades to a
/// neutral 0.5 when the data behind it is missing, so a library with no
/// tempos still ranks sensibly on words and genre alone.
pub(crate) fn score(f: &TrackFeatures, taste: &Taste) -> f32 {
    let lyric = match (&taste.centroid, &f.lyric_vec) {
        (Some(c), Some(v)) => (cosine(c, v) + 1.0) / 2.0,
        _ => 0.5,
    };
    let tempo = match (taste.tempo, f.bpm) {
        // Twenty BPM out is a different feel; the falloff says so gently.
        (Some(t), Some(b)) => (-((t - b).abs() as f32) / 25.0).exp(),
        _ => 0.5,
    };
    let genre = if taste.genres.is_empty() {
        0.5
    } else {
        let g = f.genre.to_lowercase();
        // A share of 0.3 is a strong signal, so scale to reach 1 near there.
        taste
            .genres
            .get(&g)
            .map(|s| (s * 3.0).min(1.0))
            .unwrap_or(0.15)
    };
    0.45 * lyric + 0.3 * tempo + 0.25 * genre
}

/// Picks the best `n`, never more than `cap` from one artist.
///
/// Ties go to the NEWER arrival, then the higher id. The sort used to be
/// stable on score alone, which meant equal scores kept `all_features`' scan
/// order - rowid ascending - and because every term a track cannot answer
/// scores the same neutral value, an un-enriched library ties in blocks and
/// the tail of every list was "the oldest rows", which reads as random.
pub(crate) fn take_spread(mut ranked: Vec<(f32, &TrackFeatures)>, n: usize, cap: usize) -> Vec<i64> {
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    spread_pick(&mut ranked, n, cap, &mut per_artist)
        .into_iter()
        .map(|(_, f)| f.track_id)
        .collect()
}

/// The walk under `take_spread`, with the artist counter handed IN so several
/// lanes of one reply can share it: smart shuffle fills three lists that are
/// dealt as one, and a cap kept per lane would let one artist take two of
/// each. Picks are DRAINED out of `ranked`, so what is left can be offered a
/// second time when another lane comes up short.
fn spread_pick<'a>(
    ranked: &mut Vec<(f32, &'a TrackFeatures)>,
    n: usize,
    cap: usize,
    per_artist: &mut HashMap<String, usize>,
) -> Vec<(f32, &'a TrackFeatures)> {
    ranked.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.1.added_at.cmp(&a.1.added_at))
            .then_with(|| b.1.track_id.cmp(&a.1.track_id))
    });
    let mut out = Vec::new();
    let mut i = 0;
    while i < ranked.len() && out.len() < n {
        let key = ranked[i].1.artist.to_lowercase();
        let count = per_artist.entry(key).or_insert(0);
        if *count >= cap {
            i += 1;
            continue;
        }
        *count += 1;
        out.push(ranked.remove(i));
    }
    out
}

/// Orders a picked list for FLOW: tempo ascending, energy as the secondary,
/// so a mix climbs instead of lurching. Score decided who is in; this
/// decides the order they play in. A track with no measured tempo sorts
/// first (as 0), which is where the tempo lane always put it.
pub(crate) fn ramp(mut ids: Vec<i64>, by_id: &HashMap<i64, &TrackFeatures>) -> Vec<i64> {
    let key = |id: &i64| -> (f64, f64, i64) {
        let f = by_id.get(id);
        (
            f.and_then(|f| f.bpm).unwrap_or(0.0),
            f.and_then(|f| f.energy).unwrap_or(0.0),
            *id,
        )
    };
    ids.sort_by(|a, b| {
        let (xa, ya, ia) = key(a);
        let (xb, yb, ib) = key(b);
        xa.partial_cmp(&xb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| ya.partial_cmp(&yb).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| ia.cmp(&ib))
    });
    ids
}

/// What one listener has said "not this" to lately, folded the way the
/// discovery pool folds it, so a built list cannot hand back a song or an
/// artist they dismissed from the shelf last week.
///
/// The taste model's `rejected` set covers songs they bailed on; this covers
/// the OTHER refusal - the explicit dismiss, recorded by `artist|title` key
/// and by artist, which is keyed on names because it was made about a
/// catalogue candidate that may since have landed in the library under a
/// track id the refusal never knew.
#[derive(Default)]
pub(crate) struct Rejections {
    /// `discovery::key_of(artist, title)` keys refused in the last 90 days.
    pub(crate) tracks: HashSet<String>,
    /// `discovery::artist_key` keys refused in the last 30 days.
    pub(crate) artists: HashSet<String>,
}

/// A track-level dismiss holds this long; an artist-level one, shorter -
/// the same windows the discovery pool honours (`discovery::is_rejected`).
const TRACK_REJECT_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const ARTIST_REJECT_MS: i64 = 30 * 24 * 60 * 60 * 1000;

impl Rejections {
    pub(crate) fn load(db: &crate::db::Db, user: i64, now: i64) -> Self {
        Rejections {
            tracks: db.rejected_keys_since(user, "track", now - TRACK_REJECT_MS),
            artists: db.rejected_keys_since(user, "artist", now - ARTIST_REJECT_MS),
        }
    }

    /// Whether this track, or whoever made it, was dismissed recently.
    pub(crate) fn blocks(&self, f: &TrackFeatures) -> bool {
        if self.tracks.is_empty() && self.artists.is_empty() {
            return false;
        }
        (!self.artists.is_empty() && self.artists.contains(&crate::discovery::artist_key_public(&f.artist)))
            || (!self.tracks.is_empty()
                && self.tracks.contains(&crate::discovery::key_of(&f.artist, &f.title)))
    }
}

/// How many distinct tracks a listener must have played inside the window
/// before their taste has an answer. Named because the CLIENT shows it: the
/// Discover page counts up to this ("2 of 4 songs") rather than inventing a
/// threshold of its own, so the ask can never drift from the gate.
pub const TASTE_MIN_TRACKS: usize = 4;

/// How many distinct tracks this listener has played inside the window - the
/// numerator of that ask, and the thing user_taste_for gates on.
pub(crate) fn taste_heard(state: &Arc<AppState>, user: i64) -> usize {
    let since = now_ms() - WINDOW_30D_MS;
    state.db.top_plays(user, since, 60).len()
}

/// Everything one listener has ever said about a song, as verdicts - the ONE
/// place that builds them, so every surface hears the same evidence.
///
/// Three sources, in order of how loudly the listener spoke:
///
/// 1. The listen ledger (`listen_events`), joined to hearts and playlists.
///    Each sitting is a verdict already: how far, whether they bailed, what
///    their hands did.
/// 2. Hearts with no sitting behind them. A heart from a shelf, a browse, a
///    friend's profile - the listener said yes without pressing play, and
///    until now that yes was INVISIBLE to the model, which only ever read
///    `favorites` as a flag on a listen that may never have happened. A
///    synthetic completed verdict, context "heart", dated when it was starred.
/// 3. Music Date decisions. A keep is a yes on a stranger (context "date"); a
///    pass is a no (context "date-pass"), the lightest no we record because it
///    was thirty seconds of something they never chose.
///
/// `top_plays` survives only as the fallback for a listener with none of the
/// above - a hub that predates the ledger, or an account whose client never
/// reported. Those stand-ins are stamped NOW rather than at the window's edge:
/// they represent recent listening, and dating them 180 days back would decay
/// them to nothing the moment recency actually works.
pub(crate) fn verdicts_for(state: &Arc<AppState>, user: i64, now: i64) -> Vec<crate::taste::Verdict> {
    use crate::taste::Verdict;
    let since_ms = now - crate::taste::WINDOW_DAYS * 86_400_000;
    let mut verdicts = state.db.taste_verdicts(user, since_ms, 4000);

    let mut seen: HashSet<i64> = verdicts.iter().map(|v| v.track_id).collect();
    for (track_id, added_at) in state.db.favorites_with_time(user) {
        if added_at < since_ms || seen.contains(&track_id) {
            continue;
        }
        seen.insert(track_id);
        verdicts.push(Verdict {
            track_id,
            at: added_at / 1000,
            ms_listened: 30_000,
            completed: true,
            hearted: true,
            context: "heart".into(),
            ..Default::default()
        });
    }
    for (track_id, verdict, at) in state.db.date_verdict_rows(user, since_ms) {
        // The deck's own words - collector.rs writes "kept" and "passed".
        // Anything that is not a keep is a pass: the deck has never had a
        // third answer, and an unknown spelling reading as a no is the safer
        // mistake.
        let kept = matches!(verdict.as_str(), "kept" | "keep");
        verdicts.push(Verdict {
            track_id,
            at: at / 1000,
            ms_listened: if kept { 30_000 } else { 12_000 },
            duration_ms: Some(30_000),
            completed: kept,
            skipped: !kept,
            context: if kept { "date".into() } else { "date-pass".into() },
            ..Default::default()
        });
    }

    if verdicts.len() < 8 {
        let top = state.db.top_plays(user, now - WINDOW_30D_MS, 60);
        verdicts.extend(top.into_iter().map(|(id, _)| Verdict {
            track_id: id,
            at: now / 1000,
            ms_listened: 30_000,
            completed: true,
            ..Default::default()
        }));
    }
    verdicts
}

/// The new per-user model for one listener, or None when they have not given
/// the machine anything to go on yet.
///
/// The verdict ledger first, play starts only as the fallback for an account
/// whose client never reported listens. This is the one taste the DJ, the
/// radio and discovery all read; the three-term `Taste` above survives only
/// for the playlist and queue suggesters, which score against a LIST rather
/// than a listener.
pub(crate) fn user_taste_for(
    state: &Arc<AppState>,
    user: i64,
) -> Option<(crate::taste::UserTaste, Vec<TrackFeatures>)> {
    let verdicts = verdicts_for(state, user, now_ms());
    if verdicts.len() < TASTE_MIN_TRACKS {
        return None;
    }
    let all = state.db.all_features();
    let taste = {
        let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
        crate::taste::build(user, &verdicts, &by_id, now_ms() / 1000)
    };
    Some((taste, all))
}

/// The same three-term scoring the library uses, for something that is not a
/// library row - a candidate from the catalogue, which has no track id and may
/// be missing any of the three. Each term falls back to a neutral 0.5, so a
/// candidate is never punished for what could not be measured.
pub(crate) fn score_parts(
    taste: &Taste,
    lyric_vec: Option<&[f32]>,
    bpm: Option<f64>,
    genre: Option<&str>,
) -> f32 {
    let lyric = match (&taste.centroid, lyric_vec) {
        (Some(c), Some(v)) => (cosine(c, v) + 1.0) / 2.0,
        _ => 0.5,
    };
    let tempo = match (taste.tempo, bpm) {
        (Some(t), Some(b)) => (-((t - b).abs() as f32) / 25.0).exp(),
        _ => 0.5,
    };
    let g = match (taste.genres.is_empty(), genre) {
        (false, Some(name)) => taste
            .genres
            .get(&name.to_lowercase())
            .map(|s| (s * 3.0).min(1.0))
            .unwrap_or(0.15),
        _ => 0.5,
    };
    0.45 * lyric + 0.3 * tempo + 0.25 * g
}

/// Embeds arbitrary text with the configured model - what discovery uses for
/// lyrics it fetched rather than lyrics the index already held.
pub(crate) async fn embed_text(words: &str) -> Option<Vec<f32>> {
    let url = ai_url()?;
    let trimmed = words.trim();
    if trimmed.len() < 40 {
        return None;
    }
    let input: String = trimmed.chars().take(2000).collect();
    let reply: serde_json::Value = client(60)
        .post(format!("{}/v1/embeddings", url.trim_end_matches('/')))
        .json(&json!({ "model": embed_model(), "input": input }))
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

// --- curation ----------------------------------------------------------------

async fn curate_cycle(state: &Arc<AppState>) {
    let since = now_ms() - WINDOW_30D_MS;
    let listeners = state.db.listeners_since(since);
    if listeners.is_empty() {
        return;
    }
    {
        let last = state.curator.status.lock().await.last_curated;
        if now_ms() - last < CURATE_EVERY_MS {
            return;
        }
    }
    {
        let mut s = state.curator.status.lock().await;
        s.phase = "curating".into();
    }

    let all = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();

    for user in listeners {
        /*
         * Taste comes from VERDICTS now, not from play starts.
         *
         * The old line here was `top_plays(user, since, 60)` - the sixty tracks
         * this listener started most often, every one weighted 1.0. It could
         * not tell a song played forty times and finished from one played
         * forty times and skipped at eight seconds, and it never once consulted
         * `favorites`. Both facts were in the database the whole time; see
         * taste.rs for what reading them actually buys.
         *
         * `top_plays` survives only as the fallback for a listener whose
         * `listen_events` are thin - a hub that predates the ledger, or an
         * account that has only ever used a client that does not report. Those
         * synthetic verdicts are marked completed with an empty context, which
         * is exactly the old behaviour: a play is a play.
         */
        let verdicts = verdicts_for(state, user, now_ms());
        if verdicts.len() < 4 {
            continue;
        }
        let taste = crate::taste::build(user, &verdicts, &by_id, now_ms() / 1000);
        if taste.heard.len() < 4 {
            continue;
        }
        /*
         * The two things the mixes must never deal back, read once here:
         * what they dismissed from the shelf by name (`Rejections`), and how
         * much each song actually earned in the ledger - the summed positive
         * weight of its verdicts, which is what "you keep coming back to"
         * means in numbers. The mood mixes tally by this rather than by the
         * model's PREDICTED fit, so a hearted forty-play song outweighs a
         * once-played one the model happens to like.
         */
        let rejections = Rejections::load(&state.db, user, now_ms());
        let ledger: HashMap<i64, f32> = {
            let now_s = now_ms() / 1000;
            let mut m: HashMap<i64, f32> = HashMap::new();
            for v in &verdicts {
                let w = v.weight(now_s);
                if w > 0.0 {
                    *m.entry(v.track_id).or_default() += w;
                }
            }
            m
        };

        /*
         * WHOSE music this listener's lists may draw on.
         *
         * `quarantined` is a global fact - "nobody has adopted this yet" - and
         * every list here used it alone, so the collector could spend a week
         * fetching music chosen for this exact person and not one track of it
         * could appear in anything it built for them. The pulls sat in the For
         * you shelf and nowhere else, which made the curator look like it only
         * ever reshuffled the library you already had.
         *
         * An audition belonging to THIS listener is theirs to be offered; one
         * fetched for somebody else still is not, because a pull is chosen
         * against its owner's taste and adopting it is their gesture to make.
         */
        let available = |f: &TrackFeatures| !f.quarantined || f.curator_user_id == Some(user);

        // Everything they have NOT been playing lately, scored against them.
        let fresh: Vec<(f32, &TrackFeatures)> = all
            .iter()
            // Not what they have been playing, and nothing that belongs to
            // another listener's unfinished audition - see `available`.
            .filter(|f| !taste.heard.contains(&f.track_id) && available(f))
            .map(|f| (crate::taste::score(f, &taste), f))
            .collect();
        if fresh.len() < 8 {
            continue;
        }

        // The blend: the best overall answer to this listener.
        let blend = take_spread(fresh.clone(), LIST_LEN, PER_ARTIST_CAP);

        // The tempo lane: only what sits near their tempo, then ordered as a
        // ramp so the list flows instead of lurching.
        let mut lane: Vec<(f32, &TrackFeatures)> = fresh
            .iter()
            .filter(|(_, f)| match (taste.tempo_center(), f.bpm) {
                (Some(t), Some(b)) => (t - b).abs() <= 12.0,
                _ => false,
            })
            .cloned()
            .collect();
        lane.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let lane_ids = ramp(take_spread(lane.clone(), LIST_LEN, PER_ARTIST_CAP), &by_id);

        // The lyrical echo: nearest to their centre of gravity in words alone.
        let echo: Vec<(f32, &TrackFeatures)> = match &taste.lyric {
            Some(c) => fresh
                .iter()
                .filter_map(|(_, f)| f.lyric_vec.as_ref().map(|v| (cosine(c, v), *f)))
                .collect(),
            None => Vec::new(),
        };
        let echo_ids = take_spread(echo, LIST_LEN, PER_ARTIST_CAP);

        let tempo_label = taste.tempo_center().map(|t| t.round() as i64);
        let top_genre = taste.favourite_tags(1).first().map(|(g, _)| g.clone());

        // Names: the model writes them when there is one, else they say
        // plainly what the maths did. Either way the ids are the maths'.
        let named = name_lists(state, &blend, &lane_ids, &echo_ids, tempo_label, &top_genre).await;

        if blend.len() >= 8 {
            let (n, b) = named.get(0).cloned().unwrap_or_else(|| {
                (
                    "Made for you".into(),
                    "Built from what you have been playing.".into(),
                )
            });
            let _ = state.db.put_curated(user, "blend", &n, &b, &blend);
        }
        if lane_ids.len() >= 8 {
            let (n, b) = named.get(1).cloned().unwrap_or_else(|| {
                (
                    "Your tempo".into(),
                    tempo_label
                        .map(|t| format!("Sitting around {t} BPM, where you live."))
                        .unwrap_or_else(|| "Tracks that move at your pace.".into()),
                )
            });
            let _ = state.db.put_curated(user, "tempo-lane", &n, &b, &lane_ids);
        }
        if echo_ids.len() >= 8 {
            let (n, b) = named.get(2).cloned().unwrap_or_else(|| {
                (
                    "Same wavelength".into(),
                    "Songs about what your songs are about.".into(),
                )
            });
            let _ = state
                .db
                .put_curated(user, "lyrical-echo", &n, &b, &echo_ids);
        }

        // --- the families beyond the core three -----------------------------
        //
        // The rest of the standing shelf. Plain names on purpose: each list
        // says exactly what its maths did, and the model's naming budget stays
        // spent on the three above.

        // Fresh finds: what arrived this week, in arrival order - chronology
        // IS the ranking for a list whose point is newness. Adopted collector
        // pulls land here beside anyone's imports.
        //
        // ORDERED BY ARRIVAL, but CHOSEN for this listener. Taking the newest
        // N globally and writing them into every shelf made one list and gave
        // everybody a copy of it - the only row in a per-user table that was
        // byte-identical across all four listeners, which is how it was found.
        //
        // A wider window scored to taste and then re-sorted by arrival keeps
        // what the list is for (what turned up lately) while making it answer
        // to who is reading it. Ties on score go to the newer track because
        // the last sort is by arrival, not by rank.
        let recent = state
            .db
            .recent_track_ids(now_ms() - 21 * 24 * 60 * 60 * 1000, (LIST_LEN * 6) as i64, user);
        let mut arrivals: Vec<(usize, f32, i64)> = recent
            .iter()
            .enumerate()
            .filter_map(|(pos, id)| {
                let f = by_id.get(id)?;
                available(f).then(|| (pos, crate::taste::score(f, &taste), *id))
            })
            .collect();
        // Best for them first, then keep only as many as the list holds...
        arrivals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        arrivals.truncate(LIST_LEN);
        // ...and show them newest first, which is what "fresh" means.
        arrivals.sort_by_key(|(pos, _, _)| *pos);
        let arrivals: Vec<i64> = arrivals.into_iter().map(|(_, _, id)| id).collect();
        if arrivals.len() >= 8 {
            let _ = state.db.put_curated(
                user,
                "fresh-finds",
                "Fresh finds",
                "New in the library lately, the ones most likely to be yours.",
                &arrivals,
            );
        }

        /*
         * JUST DOWNLOADED - what the collector actually went and got.
         *
         * The families above all answer "out of the music that is here, what
         * suits you". None of them can answer "what did you buy me this week",
         * because an unadopted pull is spread thin across a whole library's
         * worth of candidates and rarely wins a seat on merit alone. So the one
         * thing the collector does that is visibly ITS work had no list of its
         * own, and the shelf looked like a library reshuffler.
         *
         * Arrival order, newest first: for a list whose entire point is that
         * these are new, when they landed IS the ranking. No taste scoring
         * either - these were already chosen for this listener when the
         * collector decided to spend the disk on them, and scoring them a
         * second time here would just bury the newest arrivals under whatever
         * happened to match last month's listening.
         *
         * Four is enough to draw it. The bar elsewhere is eight because those
         * lists pick from the whole library and a short one means the maths
         * found nothing; here a short list means the collector has fetched four
         * things, which is worth showing rather than hiding until it has eight.
         */
        let mut pulls: Vec<&TrackFeatures> = all
            .iter()
            .filter(|f| f.quarantined && f.curator_user_id == Some(user))
            .collect();
        pulls.sort_by_key(|f| std::cmp::Reverse(f.added_at));
        let pull_ids: Vec<i64> = pulls.iter().take(LIST_LEN).map(|f| f.track_id).collect();
        if pull_ids.len() >= 4 {
            let _ = state.db.put_curated(
                user,
                "collector-pulls",
                "Just downloaded",
                "Fetched for you and not heard yet. Play it through to keep it.",
                &pull_ids,
            );
        }

        // The mood lists, from the analyser's audio character (features.rs).
        // Whole library including what you play on repeat - a mood list is
        // something to put ON, not a discovery engine - ranked to taste so
        // the top of each list is still yours. Not what they pushed away,
        // though: a song they bailed on or dismissed by name is not a mood.
        let pool: Vec<&TrackFeatures> = all.iter().filter(|f| available(f)).collect();
        let mood_pool: Vec<&TrackFeatures> = pool
            .iter()
            .copied()
            .filter(|f| !taste.rejected.contains(&f.track_id) && !rejections.blocks(f))
            .collect();
        let moods: [(&str, &str, &str, fn(&TrackFeatures) -> bool); 4] = [
            ("mood-chill", "Chill", "Low energy, easy pace.", |f| {
                f.energy.is_some_and(|e| e <= 0.4) && f.bpm.is_none_or(|b| b < 105.0)
            }),
            ("mood-workout", "Workout", "Fast and loud.", |f| {
                f.energy.is_some_and(|e| e >= 0.6) && f.bpm.is_some_and(|b| b >= 115.0)
            }),
            ("mood-late-night", "Late night", "Dim, slow, close.", |f| {
                f.brightness.is_some_and(|b| b <= 0.35) && f.energy.is_none_or(|e| e <= 0.5)
            }),
            ("mood-focus", "Focus", "Steady and unobtrusive.", |f| {
                f.energy.is_some_and(|e| (0.2..=0.55).contains(&e))
                    && f.brightness.is_none_or(|b| b <= 0.55)
            }),
        ];
        for (slug, name, blurb, fits) in moods {
            let ranked: Vec<(f32, &TrackFeatures)> = mood_pool
                .iter()
                .filter(|f| fits(f))
                .map(|f| (crate::taste::score(f, &taste), *f))
                .collect();
            let ids = take_spread(ranked, LIST_LEN, PER_ARTIST_CAP);
            if ids.len() >= 8 {
                let _ = state.db.put_curated(user, slug, name, blurb, &ids);
            }
        }

        // Numbered Daily Mixes + a time-of-day Daylist, plus mood mixes from
        // the ai-vibe vocabulary - the "Made for you" shelf. Organised from the
        // mood profile the discovery cycle already persisted (no re-cluster),
        // reusing this loop's `all`/`by_id`/`taste` so no extra scan is taken.
        // These replace the old genre-camp `mix-1..3` lists, which were a
        // whole-string genre `contains` over the fresh pool; build_daily sweeps
        // the stale `mix-*` slugs. See mixes.rs.
        let hour_bucket = (((now_ms() / 1000 / 3600) % 24) / 6).clamp(0, 3) as usize;
        if let Some(mp) = crate::mood::load(state, user) {
            crate::mixes::build_daily(state, user, &all, &by_id, &mp, &taste, &rejections, hour_bucket);
            crate::mixes::build_daylist(state, user, &all, &by_id, &mp, &taste, &rejections);
        }
        crate::mixes::build_moods(state, user, &all, &by_id, &taste, &rejections, &ledger);

        // The decade station: where your rotation lives in time, heard tracks
        // welcome - a station is a place, not a surprise.
        // `heard` minus `rejected`: where their rotation lives in time should
        // not be decided by the songs they skipped out of.
        let mut years: Vec<i64> = taste
            .heard
            .iter()
            .filter(|id| !taste.rejected.contains(id))
            .filter_map(|id| by_id.get(id))
            .filter_map(|f| f.year)
            .collect();
        years.sort_unstable();
        if let Some(&mid) = years.get(years.len() / 2) {
            let d0 = (mid / 10) * 10;
            let ranked: Vec<(f32, &TrackFeatures)> = pool
                .iter()
                .filter(|f| f.year.is_some_and(|y| (d0..d0 + 10).contains(&y)))
                .map(|f| (crate::taste::score(f, &taste), *f))
                .collect();
            let ids = take_spread(ranked, LIST_LEN, PER_ARTIST_CAP);
            if ids.len() >= 8 {
                let _ = state.db.put_curated(
                    user,
                    "station-decade",
                    &format!("{d0}s station"),
                    &format!("The {d0}s, as your library holds them."),
                    &ids,
                );
            }
        }
    }

    let mut s = state.curator.status.lock().await;
    s.last_curated = now_ms();
    s.phase = "idle".into();
}

/// Asks the model for three (name, blurb) pairs. Returns empty on any doubt -
/// every caller has a plain fallback, and a wrong name is worse than a dull one.
async fn name_lists(
    state: &Arc<AppState>,
    blend: &[i64],
    lane: &[i64],
    echo: &[i64],
    tempo: Option<i64>,
    genre: &Option<String>,
) -> Vec<(String, String)> {
    let (Some(url), Some(model)) = (ai_url(), ai_chat_model()) else {
        // No chat model configured: the lists keep their plain names, which say
        // what the maths did and cost nothing.
        return Vec::new();
    };
    let describe = |ids: &[i64]| -> String {
        state
            .db
            .tracks_for_curation(&ids.iter().copied().take(6).collect::<Vec<_>>())
            .iter()
            .map(|t| format!("{} — {}", t.artist, t.title))
            .collect::<Vec<_>>()
            .join("; ")
    };
    let prompt = format!(
        "You name playlists for one listener's own music collection.\n\
         Their usual tempo: {}. Their main genre: {}.\n\
         Playlist A (an all-round mix): {}\n\
         Playlist B (tracks near their tempo): {}\n\
         Playlist C (lyrically similar to what they play): {}\n\n\
         Name each one. Titles 2-4 words, evocative but not silly. Blurbs one \
         short sentence, warm and plain, no exclamation marks.\n\
         Answer with STRICT JSON and nothing else: \
         [{{\"title\":\"...\",\"blurb\":\"...\"}}, ...] in the order A, B, C.",
        tempo
            .map(|t| format!("{t} BPM"))
            .unwrap_or_else(|| "unknown".into()),
        genre.clone().unwrap_or_else(|| "mixed".into()),
        describe(blend),
        describe(lane),
        describe(echo),
    );

    let Ok(reply) = client(120)
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.7,
        }))
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = reply.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    let Some(content) = body
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
    else {
        return Vec::new();
    };
    // Models wrap JSON in prose and fences; carve the array out, bounds-checked
    // so a truncated reply cannot panic the loop that owns this task.
    let (Some(start), Some(end)) = (content.find('['), content.rfind(']')) else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let Some(slice) = content.get(start..=end) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(slice) else {
        return Vec::new();
    };
    parsed
        .into_iter()
        .map(|v| {
            (
                v.get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                v.get("blurb")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
            )
        })
        .filter(|(t, _)| !t.is_empty())
        .collect()
}

/// One pass over the discovery pool for every recent listener.
async fn discovery_cycle(state: &Arc<AppState>) -> bool {
    let since = now_ms() - WINDOW_30D_MS;
    // Prune EVERY pool before the trending sweep, not per-user further down.
    // The sweep fans against each pool's headroom, and it learned this the
    // hard way: run first, it found the primary listener's pool at 635 rows,
    // fanned them nothing, and then watched the pruner make room it would not
    // use for another twelve hours.
    for user in state.db.listeners_since(since) {
        crate::discovery::prune_pool(state, user);
    }
    // The charts: one server-wide fetch on its own twice-a-day clock, fanned
    // to every listener's pool, so the taste walk below never runs on a pool
    // the trending lane has not had its chance to feed.
    crate::trending::cycle(state).await;
    let mut worked = false;
    for user in state.db.listeners_since(since) {
        crate::discovery::harvest(state, user).await;
        crate::discovery::prune_owned(state, user);
        if crate::discovery::listen_cycle(state, user).await {
            worked = true;
        }
        // The listener's own layer over all of it: the mood profile daily,
        // and the blended stations the moment a fresh profile exists.
        if crate::mood::cycle(state, user).await {
            note_cycle(state, "mood", "Read the mood of the last three weeks", "From your own listening");
            worked = true;
        }
        if crate::programmer::cycle(state, user).await {
            note_cycle(state, "stations", "Rebuilt your stations", "One per mood, new music tucked in");
            // The DJ shelf derives from the same profile; dropping its cache
            // here is what keeps one mood from wearing two names for days.
            crate::stations::invalidate(state, user).await;
            worked = true;
        }
        // The banked DJ sets are RETIRED from serving (2026-08-31, by
        // explicit request - cached sets dealt the same songs every press),
        // so nothing banks them any more either. vibes::cycle survives in
        // its module, parked, should judgement-over-freshness ever win back.
    }
    // The new-music shelf, kept warm: at most one grouping rebuild per pass.
    crate::discovery::new_music_warm_one(state).await;
    /*
     * The cold shelves: accounts with no recent listening whose date decks
     * sit under the floor. They get the DISCOVERY half only - dedupe and
     * measurement, so their chart candidates become offerable - and none of
     * the taste layer (mood, stations, vibe banks), which has nothing to
     * read and would just occupy the model for an empty room.
     */
    let heard: std::collections::HashSet<i64> =
        state.db.listeners_since(since).into_iter().collect();
    for user in crate::collector::daters(state) {
        if heard.contains(&user) {
            continue;
        }
        crate::discovery::prune_owned(state, user);
        if crate::discovery::listen_cycle(state, user).await {
            worked = true;
        }
    }
    worked
}

// --- endpoints ---------------------------------------------------------------

use crate::auth;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratedOut {
    pub slug: String,
    pub name: String,
    pub blurb: String,
    pub track_ids: Vec<i64>,
    pub built_at: i64,
}

/// `GET /api/curator` - this listener's curated lists, plus how far the
/// enrichment behind them has got. The client shows the lists; the progress is
/// what makes "the curator is still reading your library" honest rather than
/// mysterious.
pub async fn feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let lists: Vec<CuratedOut> = state
        .db
        .curated_for(caller.id)
        .into_iter()
        .map(|c| CuratedOut {
            slug: c.slug,
            name: c.name,
            blurb: c.blurb,
            track_ids: c.track_ids,
            built_at: c.built_at,
        })
        .collect();
    let (checked, with_bpm, with_vec, total) = state.db.feature_counts();
    let stale_before = now_ms() - AI_ENRICH_TTL_MS;
    let (first_done, second_done, second_total, enrichment_total) =
        state.db.layered_enrichment_counts(stale_before);
    let enrichment_stage = if fast_profiles_pending(&state) {
        "first"
    } else if !state
        .db
        .tracks_needing_refinement(1, stale_before)
        .is_empty()
    {
        "second"
    } else {
        "complete"
    };
    let spread = state.db.tempo_spread();
    let status = state.curator.status.lock().await.clone();
    Ok(Json(json!({
        "lists": lists,
        "status": status,
        "progress": {
            "checked": checked,
            "withTempo": with_bpm,
            "withLyrics": with_vec,
            "total": total,
            "tempoMin": spread.map(|s| s.0),
            "tempoMedian": spread.map(|s| s.1),
            "tempoMax": spread.map(|s| s.2),
        },
        "enrichment": {
            "stage": enrichment_stage,
            "firstLayer": { "complete": first_done, "total": enrichment_total },
            "secondLayer": { "complete": second_done, "total": second_total },
        },
    })))
}

// --- suggestions for one playlist --------------------------------------------

/// `GET /api/playlists/{id}/suggestions` - what else belongs on this list.
///
/// Scored against the PLAYLIST rather than the listener: a late-night playlist
/// should keep being a late-night playlist even if its owner spends the rest of
/// their week on something loud. So the taste profile here is built from the
/// list's own tracks - their words, their tempo, their genres - and the library
/// is ranked against that, minus what is already on it.
pub async fn playlist_suggestions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    // Owner, editor or viewer: a shared list's suggestions are for whoever is
    // filling it. Not a member at all reads as not there, like everywhere else.
    if state.db.playlist_role(id, caller.id).is_none() {
        return Err((StatusCode::NOT_FOUND, "no such playlist".into()));
    }

    let members = state.db.playlist_track_ids(id);
    let all = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    let taste = taste_from(&members, &by_id);
    let on_list: HashSet<i64> = members.iter().copied().collect();

    // Two or three songs is not a character yet; below that the suggestions
    // would be noise wearing a confident label.
    let ids = if members.len() < 3 {
        Vec::new()
    } else {
        let ranked: Vec<(f32, &TrackFeatures)> = all
            .iter()
            .filter(|f| !on_list.contains(&f.track_id))
            .map(|f| (score(f, &taste), f))
            .collect();
        take_spread(ranked, 10, PER_ARTIST_CAP)
    };

    Ok(Json(json!({
        "trackIds": ids,
        // The client only offers this where a model is reading lyrics - without
        // one the ranking is tempo and genre alone, which is a weaker promise
        // than "songs that belong here".
        "ai": ai_url().is_some(),
    })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceBody {
    /// The queue as it stands - whatever is playing, saved list or not.
    pub track_ids: Vec<i64>,
    /// How many to hand back. Clamped; a handful is the point.
    #[serde(default)]
    pub count: Option<usize>,
}

// --- smart shuffle: what the DJ mixes into THIS queue ------------------------

/// Which door a smart-shuffle pick came in through. The listener asked for a
/// DJ that "mixes on new music and top repeated songs and fills what we're
/// listening to with similar music" - three reasons to reach for a song that
/// is not on the queue, and the client shows which one applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lane {
    /// Sounds like what is playing.
    Similar,
    /// New to this listener: just landed, never met, or their own audition.
    New,
    /// On repeat: came back to it this fortnight, or heavy rotation this month.
    Repeat,
}

impl Lane {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Lane::Similar => "similar",
            Lane::New => "new",
            Lane::Repeat => "repeat",
        }
    }
}

/// The two pools that name a lane, gathered from the ledger for one
/// listener. Everything else a candidate can be is "similar".
#[derive(Default)]
pub(crate) struct LanePools {
    pub(crate) new: HashSet<i64>,
    pub(crate) repeat: HashSet<i64>,
}

/// A song they came back to inside this window is "on repeat".
const REPEAT_WINDOW_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// An arrival inside this window is "new" - a bound the newest-N query does
/// not carry on its own. Without it every song in a library under `NEW_POOL`
/// rows is "new", the repeat and similar lanes never see a candidate, and a
/// small hub's smart shuffle is the recently-added shelf wearing a DJ's hat.
const NEW_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// How far down the recently-added and never-played shelves to read.
const NEW_POOL: i64 = 200;
/// How many of the month's most-played count as heavy rotation.
const REPEAT_TOP: i64 = 60;

/// What is new and what is on repeat for one listener, from the ledger.
///
/// New: the library's recent arrivals this listener may hear (their own
/// pending auditions included, another member's not - `recently_added_for`
/// already draws that line), what they have never played, and their own
/// unadopted auditions outright - the collector fetched those FOR them, and
/// there is no newer music in the building. Repeat: songs they returned to
/// this fortnight, and the month's heavy rotation.
pub(crate) fn lane_pools(
    db: &crate::db::Db,
    caller: i64,
    all: &[TrackFeatures],
    now: i64,
) -> LanePools {
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    let arrived_lately = |id: &i64| by_id.get(id).map_or(false, |f| f.added_at >= now - NEW_WINDOW_MS);
    let mut new: HashSet<i64> =
        db.recently_added_for(caller, NEW_POOL).into_iter().filter(arrived_lately).collect();
    new.extend(db.unplayed(caller, NEW_POOL));
    new.extend(
        all.iter()
            .filter(|f| f.quarantined && f.curator_user_id == Some(caller))
            .map(|f| f.track_id),
    );
    let mut repeat: HashSet<i64> = db.recent_repeats(caller, now - REPEAT_WINDOW_MS).into_keys().collect();
    repeat.extend(db.top_plays(caller, now - WINDOW_30D_MS, REPEAT_TOP).into_iter().map(|(id, _)| id));
    LanePools { new, repeat }
}

/// How `n` picks split across the lanes: (similar, new, repeat). Half of the
/// deal sounds like the queue, a quarter is new, and the rest is on repeat -
/// six picks are three, one and two.
pub(crate) fn lane_quotas(n: usize) -> (usize, usize, usize) {
    let similar = n.div_ceil(2);
    let new = n / 4;
    (similar, new, n - similar - new)
}

/// The picks for one queue, each with the lane it came through, best fit
/// first.
///
/// Fit is two questions blended: does it sound like what is PLAYING (the
/// queue's own centroid, the term the old enhancer was built on), and does
/// this LISTENER like it (their verdict-trained model, when they have given
/// it enough to go on). 0.6 to the queue, because the request was "fill what
/// we're listening to", and 0.4 to the person, so two members playing the
/// same album are not dealt the same six songs.
///
/// A candidate is any live track not on the queue, never a book, not
/// something this listener dismissed lately, and not another member's
/// unadopted audition - the caller's OWN auditions are allowed, and are the
/// newest music they have. Each lane takes its quota by fit; a song that is
/// both new and on repeat is new; a lane that comes up short hands the
/// shortfall to similar, and only when similar cannot fill either do the
/// other two overflow, so a tiny library still gets a full deal. One shared
/// artist counter runs across all three lanes: no artist twice in a lane,
/// and none more than twice in the reply.
pub(crate) fn smart_lanes(
    queue: &[i64],
    all: &[TrackFeatures],
    user_taste: Option<&crate::taste::UserTaste>,
    rejections: &Rejections,
    caller: i64,
    pools: &LanePools,
    want: usize,
) -> Vec<(i64, Lane)> {
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    let queue_taste = taste_from(queue, &by_id);
    let on_queue: HashSet<i64> = queue.iter().copied().collect();

    let mut similar: Vec<(f32, &TrackFeatures)> = Vec::new();
    let mut new: Vec<(f32, &TrackFeatures)> = Vec::new();
    let mut repeat: Vec<(f32, &TrackFeatures)> = Vec::new();
    for f in all {
        if on_queue.contains(&f.track_id)
            || f.kind == "book"
            || rejections.blocks(f)
            || (f.quarantined && f.curator_user_id != Some(caller))
        {
            continue;
        }
        let queue_fit = score(f, &queue_taste);
        let fit = match user_taste {
            Some(t) => 0.6 * queue_fit + 0.4 * crate::taste::score(f, t),
            None => queue_fit,
        };
        if pools.new.contains(&f.track_id) {
            new.push((fit, f));
        } else if pools.repeat.contains(&f.track_id) {
            repeat.push((fit, f));
        } else {
            similar.push((fit, f));
        }
    }

    /// One lane's turn: up to `n` of its best, under the shared artist cap.
    fn deal(
        lane: &mut Vec<(f32, &TrackFeatures)>,
        n: usize,
        tag: Lane,
        per_artist: &mut HashMap<String, usize>,
        picks: &mut Vec<(f32, i64, Lane)>,
    ) {
        for (fit, f) in spread_pick(lane, n, PER_ARTIST_CAP, per_artist) {
            picks.push((fit, f.track_id, tag));
        }
    }

    let (_, q_new, q_repeat) = lane_quotas(want);
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    let mut picks: Vec<(f32, i64, Lane)> = Vec::new();
    // The two named lanes first, so similar's share is whatever they left -
    // its own quota plus their shortfall.
    deal(&mut new, q_new, Lane::New, &mut per_artist, &mut picks);
    deal(&mut repeat, q_repeat, Lane::Repeat, &mut per_artist, &mut picks);
    let short = want.saturating_sub(picks.len());
    deal(&mut similar, short, Lane::Similar, &mut per_artist, &mut picks);
    // Similar could not fill either: the named lanes may overflow.
    let short = want.saturating_sub(picks.len());
    deal(&mut new, short, Lane::New, &mut per_artist, &mut picks);
    let short = want.saturating_sub(picks.len());
    deal(&mut repeat, short, Lane::Repeat, &mut per_artist, &mut picks);

    picks.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.1.cmp(&a.1))
    });
    picks.into_iter().map(|(_, id, lane)| (id, lane)).collect()
}

/// The wire shape: `trackIds` as it always was, so a client that predates
/// the lanes still reads a flat list, and `lanes` beside it keyed by id.
pub(crate) fn enhance_reply(picks: &[(i64, Lane)], ai: bool) -> serde_json::Value {
    let ids: Vec<i64> = picks.iter().map(|(id, _)| *id).collect();
    let lanes: serde_json::Map<String, serde_json::Value> =
        picks.iter().map(|(id, lane)| (id.to_string(), json!(lane.as_str()))).collect();
    json!({ "trackIds": ids, "lanes": lanes, "ai": ai })
}

/// `POST /api/queue/enhance` - smart shuffle: songs that belong in THIS queue
/// but are not in it yet, each tagged with why.
///
/// The playlist suggester above answers "what else belongs here" for a saved
/// playlist, by its id. Smart shuffle asks it of whatever happens to be
/// playing - an album, a Liked list, a DJ set, a hand-built queue that was
/// never saved - so this takes the ids directly. The answer is three lanes
/// (`smart_lanes`): what sounds like the queue, what is new to the listener,
/// and what they have on repeat, scored against the queue AND the listener's
/// own model rather than the queue alone.
///
/// Body `{trackIds, count?}` -> `{trackIds, lanes: {id: "similar"|"new"|
/// "repeat"}, ai}`. Every returned track is logged as a DJ impression under
/// its own slot, so a mixed-in song that gets finished or hearted teaches the
/// same ledger the exploration slots read.
pub async fn enhance_queue(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<EnhanceBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let ai = ai_url().is_some();

    // Under three songs a queue has no character to match, and suggestions
    // would be noise wearing a confident label - the same floor the playlist
    // suggester uses.
    if body.track_ids.len() < 3 {
        return Ok(Json(enhance_reply(&[], ai)));
    }
    let want = body.count.unwrap_or(6).clamp(1, 12);
    let now = now_ms();
    // The listener's model when they have one; the library either way.
    let (user_taste, all) = match user_taste_for(&state, caller.id) {
        Some((taste, all)) => (Some(taste), all),
        None => (None, state.db.all_features()),
    };
    let rejections = Rejections::load(&state.db, caller.id, now);
    let pools = lane_pools(&state.db, caller.id, &all, now);
    let picks = smart_lanes(
        &body.track_ids,
        &all,
        user_taste.as_ref(),
        &rejections,
        caller.id,
        &pools,
        want,
    );

    let offered: Vec<(i64, &str, i64)> =
        picks.iter().enumerate().map(|(i, (id, _))| (*id, "enhance", i as i64)).collect();
    state.db.record_dj_impressions(caller.id, &offered);

    Ok(Json(enhance_reply(&picks, ai)))
}

#[cfg(test)]
mod smart_shuffle {
    //! The three lanes, and the doors a candidate must pass through.

    use super::*;

    fn feat(id: i64, artist: &str, bpm: f64) -> TrackFeatures {
        TrackFeatures {
            track_id: id,
            artist: artist.into(),
            title: format!("song{id}"),
            bpm: Some(bpm),
            genre: "rock".into(),
            ..Default::default()
        }
    }

    /// A queue of three 120bpm rock songs by three artists, ids 1-3.
    fn queue_feats() -> Vec<TrackFeatures> {
        vec![feat(1, "Q1", 120.0), feat(2, "Q2", 120.0), feat(3, "Q3", 120.0)]
    }

    fn deal(all: &[TrackFeatures], pools: &LanePools, want: usize) -> Vec<(i64, Lane)> {
        smart_lanes(&[1, 2, 3], all, None, &Rejections::default(), 7, pools, want)
    }

    fn lane_of(picks: &[(i64, Lane)], id: i64) -> Option<Lane> {
        picks.iter().find(|(i, _)| *i == id).map(|(_, l)| *l)
    }

    fn count(picks: &[(i64, Lane)], lane: Lane) -> usize {
        picks.iter().filter(|(_, l)| *l == lane).count()
    }

    #[test]
    fn quotas_are_half_a_quarter_and_the_rest() {
        assert_eq!(lane_quotas(6), (3, 1, 2));
        assert_eq!(lane_quotas(1), (1, 0, 0));
        assert_eq!(lane_quotas(4), (2, 1, 1));
        assert_eq!(lane_quotas(12), (6, 3, 3));
        for n in 1..=12 {
            let (s, nw, r) = lane_quotas(n);
            assert_eq!(s + nw + r, n);
        }
    }

    /// Six picks with plenty in every lane: three similar, one new, two on
    /// repeat - and every id is in exactly one lane.
    #[test]
    fn six_picks_deal_three_one_and_two() {
        let mut all = queue_feats();
        for id in 10..30 {
            all.push(feat(id, &format!("S{id}"), 120.0));
        }
        let pools = LanePools {
            new: (10..15).collect(),
            repeat: (15..20).collect(),
        };
        let picks = deal(&all, &pools, 6);
        assert_eq!(picks.len(), 6, "{picks:?}");
        assert_eq!(count(&picks, Lane::Similar), 3, "{picks:?}");
        assert_eq!(count(&picks, Lane::New), 1, "{picks:?}");
        assert_eq!(count(&picks, Lane::Repeat), 2, "{picks:?}");
        let ids: HashSet<i64> = picks.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids.len(), 6, "no id twice: {picks:?}");
        for (id, lane) in &picks {
            let expect = if pools.new.contains(id) {
                Lane::New
            } else if pools.repeat.contains(id) {
                Lane::Repeat
            } else {
                Lane::Similar
            };
            assert_eq!(*lane, expect, "{id} is in the lane its pool names");
        }
    }

    /// Nothing new in the building: similar takes the new lane's seat, so the
    /// deal is still six.
    #[test]
    fn similar_absorbs_a_short_lane() {
        let mut all = queue_feats();
        for id in 10..30 {
            all.push(feat(id, &format!("S{id}"), 120.0));
        }
        let pools = LanePools { new: HashSet::new(), repeat: (15..20).collect() };
        let picks = deal(&all, &pools, 6);
        assert_eq!(picks.len(), 6);
        assert_eq!(count(&picks, Lane::Similar), 4, "{picks:?}");
        assert_eq!(count(&picks, Lane::New), 0);
        assert_eq!(count(&picks, Lane::Repeat), 2);

        // And when similar has nothing either, the named lanes overflow
        // rather than the deal coming up short.
        let pools = LanePools { new: (10..30).collect(), repeat: HashSet::new() };
        let picks = deal(&all, &pools, 6);
        assert_eq!(picks.len(), 6, "{picks:?}");
        assert_eq!(count(&picks, Lane::New), 6);
    }

    /// A song that is both new and on repeat is new.
    #[test]
    fn new_outranks_repeat_when_a_song_is_both() {
        let mut all = queue_feats();
        for id in 10..20 {
            all.push(feat(id, &format!("S{id}"), 120.0));
        }
        let pools = LanePools { new: [10].into(), repeat: [10, 11].into() };
        let picks = deal(&all, &pools, 6);
        assert_eq!(lane_of(&picks, 10), Some(Lane::New), "{picks:?}");
        assert_eq!(lane_of(&picks, 11), Some(Lane::Repeat), "{picks:?}");
    }

    /// The doors: a book never, a dismissed artist never, another member's
    /// audition never - and the caller's own audition can, as new.
    #[test]
    fn books_rejections_and_strangers_auditions_are_never_dealt() {
        let mut all = queue_feats();
        let mut book = feat(10, "Narrator", 120.0);
        book.kind = "book".into();
        all.push(book);
        all.push(feat(11, "Bad Band", 120.0));
        let mut theirs = feat(12, "Theirs", 120.0);
        theirs.quarantined = true;
        theirs.curator_user_id = Some(99);
        all.push(theirs);
        let mut mine = feat(13, "Mine", 120.0);
        mine.quarantined = true;
        mine.curator_user_id = Some(7);
        all.push(mine);
        all.push(feat(14, "Plain", 120.0));

        let rejections = Rejections {
            artists: [crate::discovery::artist_key_public("Bad Band")].into(),
            tracks: HashSet::new(),
        };
        let pools = LanePools { new: [10, 11, 12, 13].into(), repeat: HashSet::new() };
        let picks = smart_lanes(&[1, 2, 3], &all, None, &rejections, 7, &pools, 6);
        let ids: Vec<i64> = picks.iter().map(|(id, _)| *id).collect();
        assert!(!ids.contains(&10), "a book is never dealt: {picks:?}");
        assert!(!ids.contains(&11), "a dismissed artist is never dealt: {picks:?}");
        assert!(!ids.contains(&12), "another member's audition is never dealt: {picks:?}");
        assert_eq!(lane_of(&picks, 13), Some(Lane::New), "my own audition is new music: {picks:?}");
        assert!(ids.contains(&14));
        assert!(!ids.iter().any(|id| [1, 2, 3].contains(id)), "never the queue itself");
    }

    /// One artist counter for the whole deal: a favourite with a song in
    /// every lane still gets at most two of the six.
    #[test]
    fn no_artist_more_than_twice_across_the_reply() {
        let mut all = queue_feats();
        // "Fav" sits in every lane with the best possible fit (the queue's
        // own tempo); the rest are off-tempo filler.
        for id in 10..16 {
            all.push(feat(id, "Fav", 120.0));
        }
        for id in 20..40 {
            all.push(feat(id, &format!("F{id}"), 60.0));
        }
        let pools = LanePools {
            new: [10, 11, 20, 21, 22].into(),
            repeat: [12, 13, 23, 24, 25].into(),
        };
        let picks = deal(&all, &pools, 6);
        assert_eq!(picks.len(), 6, "{picks:?}");
        let favs = picks.iter().filter(|(id, _)| (10..16).contains(id)).count();
        assert_eq!(favs, 2, "at most two by one artist in the reply: {picks:?}");
    }

    /// Best fit first, whatever the lane - a client that only reads
    /// `trackIds` gets the closest match at the top, as before.
    #[test]
    fn the_reply_is_ordered_by_fit() {
        let mut all = queue_feats();
        all.push(feat(10, "Near", 120.0));
        all.push(feat(11, "Far", 60.0));
        all.push(feat(12, "Mid", 100.0));
        let picks = deal(&all, &LanePools::default(), 3);
        let ids: Vec<i64> = picks.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, vec![10, 12, 11]);
    }

    /// The listener's own model moves the fit when they have one.
    #[test]
    fn the_listeners_model_is_blended_in() {
        let mut all = queue_feats();
        all.push(feat(10, "Loved", 100.0));
        all.push(feat(11, "Unknown", 110.0));
        // Tempo alone: 11 is nearer the queue's 120, and leads.
        let plain = deal(&all, &LanePools::default(), 2);
        assert_eq!(plain[0].0, 11);
        // A listener whose model is all scene, and who returns to "Loved":
        // their 0.4 outweighs the queue's 0.6 on a ten-bpm difference.
        let mut taste = crate::taste::UserTaste::cold(7);
        taste.weights = crate::taste::Weights::from_array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        taste.artists.insert(crate::taste::artist_key("Loved"), 1.0);
        taste.artists.insert(crate::taste::artist_key("Unknown"), -1.0);
        let with = smart_lanes(&[1, 2, 3], &all, Some(&taste), &Rejections::default(), 7, &LanePools::default(), 2);
        assert_eq!(with[0].0, 10, "{with:?}");
    }

    /// Old clients still read `trackIds`; new ones read `lanes` beside it.
    #[test]
    fn the_wire_shape_keeps_track_ids_and_adds_lanes() {
        let reply = enhance_reply(&[(10, Lane::Similar), (11, Lane::New), (12, Lane::Repeat)], false);
        assert_eq!(reply["trackIds"], json!([10, 11, 12]));
        assert_eq!(reply["lanes"]["10"], "similar");
        assert_eq!(reply["lanes"]["11"], "new");
        assert_eq!(reply["lanes"]["12"], "repeat");
        assert_eq!(reply["ai"], false);
        let empty = enhance_reply(&[], true);
        assert_eq!(empty["trackIds"], json!([]));
        assert_eq!(empty["lanes"], json!({}));
    }

    // --- the pools, read off a real ledger ----------------------------------

    fn temp_db(name: &str) -> crate::db::Db {
        let dir = std::env::temp_dir().join(format!("afm-smart-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::Db::open(&dir.join("t.sqlite")).unwrap()
    }

    fn track(db: &crate::db::Db, rel: &str, artist: &str) -> i64 {
        let t = crate::db::ScannedTrack {
            rel_path: rel.into(),
            title: rel.into(),
            artist: artist.into(),
            album_artist: artist.into(),
            album: "Al".into(),
            track_no: None,
            disc_no: None,
            year: None,
            genre: "rock".into(),
            lyrics: String::new(),
            duration_ms: Some(200_000),
            codec: "flac".into(),
            lossless: true,
            sample_rate: None,
            bit_depth: None,
            channels: None,
            bitrate: None,
            size_bytes: 1,
            mtime: 1,
            art_id: None,
            chapters: String::new(),
        };
        db.upsert_track(&t, 1).unwrap();
        db.track_id_by_path(rel).unwrap()
    }

    /// Ages a track, and any plays of it, so it is neither a recent arrival
    /// nor this month's heavy rotation.
    fn age(db: &crate::db::Db, id: i64, days: i64) {
        let at = now_ms() - days * 86_400_000;
        let conn = db.lock_for_test();
        conn.execute("UPDATE tracks SET added_at = ?2 WHERE id = ?1", rusqlite::params![id, at])
            .unwrap();
        conn.execute("UPDATE plays SET played_at = ?2 WHERE track_id = ?1", rusqlite::params![id, at])
            .unwrap();
    }

    fn listen(db: &crate::db::Db, user: i64, id: i64, ago_ms: i64) {
        let tags = (format!("t{id}"), "A".to_string(), "Al".to_string(), String::new());
        db.insert_listen(
            user,
            id,
            &tags,
            now_ms() - ago_ms,
            200_000,
            Some(200_000),
            true,
            false,
            "album",
            &crate::db::ListenShape::default(),
        )
        .unwrap();
    }

    /// A track that landed this week is new; one that landed last year and
    /// has been played is not.
    #[test]
    fn a_new_arrival_lands_in_lane_new() {
        let db = temp_db("arrival");
        let me = db.create_user("me", "x", true).unwrap();
        let mut ids = Vec::new();
        for i in 0..8 {
            ids.push(track(&db, &format!("q{i}.flac"), &format!("A{i}")));
        }
        let fresh = track(&db, "fresh.flac", "Fresh");
        // Everything but the fresh one is old and already met, long ago.
        for id in &ids {
            db.record_play(me, *id).unwrap();
            age(&db, *id, 400);
        }
        let all = db.all_features();
        let pools = lane_pools(&db, me, &all, now_ms());
        assert!(pools.new.contains(&fresh), "this week's arrival is new");
        assert!(!pools.new.contains(&ids[3]), "an old, played song is not");

        let picks = smart_lanes(&ids[..3], &all, None, &Rejections::default(), me, &pools, 6);
        assert_eq!(lane_of(&picks, fresh), Some(Lane::New), "{picks:?}");
        assert_eq!(lane_of(&picks, ids[4]), Some(Lane::Similar), "{picks:?}");
    }

    /// A song they came back to twice this fortnight is on repeat.
    #[test]
    fn a_repeat_lands_in_lane_repeat() {
        let db = temp_db("repeat");
        let me = db.create_user("me", "x", true).unwrap();
        let mut ids = Vec::new();
        for i in 0..8 {
            let id = track(&db, &format!("q{i}.flac"), &format!("A{i}"));
            db.record_play(me, id).unwrap();
            age(&db, id, 400);
            ids.push(id);
        }
        let loved = ids[5];
        listen(&db, me, loved, 2 * 86_400_000);
        listen(&db, me, loved, 5 * 86_400_000);
        let all = db.all_features();
        let pools = lane_pools(&db, me, &all, now_ms());
        assert!(pools.repeat.contains(&loved), "two sittings this fortnight is a repeat");
        assert!(!pools.new.contains(&loved));

        let picks = smart_lanes(&ids[..3], &all, None, &Rejections::default(), me, &pools, 6);
        assert_eq!(lane_of(&picks, loved), Some(Lane::Repeat), "{picks:?}");
        assert_eq!(count(&picks, Lane::Repeat), 1);
        // Eight songs, three on the queue, one on repeat: the four left are
        // similar, and the deal is five - the library ran out, not the lanes.
        assert_eq!(count(&picks, Lane::Similar), 4, "similar took the rest: {picks:?}");
        assert_eq!(picks.len(), 5);
    }

    /// A never-played song is new to this listener, and a dismissed artist
    /// stays out even when it is - the ledger's rejection, not a hand-built
    /// one.
    #[test]
    fn unplayed_is_new_and_a_ledger_rejection_holds() {
        let db = temp_db("unplayed");
        let me = db.create_user("me", "x", true).unwrap();
        let mut ids = Vec::new();
        for i in 0..5 {
            let id = track(&db, &format!("q{i}.flac"), &format!("A{i}"));
            db.record_play(me, id).unwrap();
            age(&db, id, 400);
            ids.push(id);
        }
        let never = track(&db, "never.flac", "Never Met");
        age(&db, never, 400);
        let dismissed = track(&db, "no.flac", "Bad Band");
        age(&db, dismissed, 400);
        db.reject_discovery(me, "artist", &crate::discovery::artist_key_public("Bad Band"));

        let all = db.all_features();
        let now = now_ms();
        let pools = lane_pools(&db, me, &all, now);
        assert!(pools.new.contains(&never), "never played is new");
        let rejections = Rejections::load(&db, me, now);
        let picks = smart_lanes(&ids[..3], &all, None, &rejections, me, &pools, 6);
        assert_eq!(lane_of(&picks, never), Some(Lane::New), "{picks:?}");
        assert!(lane_of(&picks, dismissed).is_none(), "a dismissed artist is never dealt: {picks:?}");
    }
}

#[cfg(test)]
mod verdict_taste {
    use super::*;

    fn feat(id: i64, bpm: f64) -> TrackFeatures {
        TrackFeatures { track_id: id, bpm: Some(bpm), ..Default::default() }
    }

    #[test]
    fn skips_stop_outvoting_completions() {
        // One loved slow song (weight 1.0) against one abandoned fast song
        // played "more" (weight 0.15): the weighted tempo median must sit on
        // the loved one, where the unweighted median of starts sat on neither.
        let a = feat(1, 80.0);
        let b = feat(2, 170.0);
        let feats: std::collections::HashMap<i64, &TrackFeatures> =
            [(1, &a), (2, &b)].into_iter().collect();
        let taste = taste_from_weighted(&[(1, 1.0), (2, 0.15)], &feats);
        assert_eq!(taste.tempo, Some(80.0), "weight decides the median, not row count");
        // Both ids stay heard - a skipped song is still one the listener met.
        assert!(taste.heard.contains(&1) && taste.heard.contains(&2));
    }

    fn by(id: i64, artist: &str, added_at: i64) -> TrackFeatures {
        TrackFeatures { track_id: id, artist: artist.into(), added_at, ..Default::default() }
    }

    /// The cap is the caller's, and equal scores go to the newer arrival and
    /// then the higher id - never to rowid order, which read as "the oldest
    /// un-enriched rows" at the tail of every list.
    #[test]
    fn take_spread_respects_the_cap_and_breaks_ties_toward_the_new() {
        let a1 = by(1, "A", 10);
        let a2 = by(2, "A", 20);
        let a3 = by(3, "A", 30);
        let b1 = by(4, "B", 5);
        let b2 = by(5, "B", 5);
        let ranked = vec![(0.9, &a1), (0.9, &a2), (0.9, &a3), (0.9, &b1), (0.9, &b2)];

        let two = take_spread(ranked.clone(), 10, 2);
        assert_eq!(two, vec![3, 2, 5, 4], "newest first within a tie, at most two of A");
        let three = take_spread(ranked.clone(), 10, 3);
        assert_eq!(three, vec![3, 2, 1, 5, 4], "a cap of three lets the third A in");
        assert_eq!(take_spread(ranked, 2, 3), vec![3, 2], "n still bounds the list");

        // Score outranks arrival: an older track with a better score leads.
        let old_good = by(6, "C", 1);
        let new_meh = by(7, "D", 99);
        assert_eq!(take_spread(vec![(0.5, &new_meh), (0.8, &old_good)], 5, 2), vec![6, 7]);
    }

    /// A ramp climbs: tempo never falls from one track to the next, and at
    /// equal tempo energy does not either.
    #[test]
    fn ramp_is_monotone_in_bpm_then_energy() {
        let mut fast = feat(1, 150.0);
        fast.energy = Some(0.9);
        let mut slow = feat(2, 80.0);
        slow.energy = Some(0.2);
        let mut mid_hot = feat(3, 110.0);
        mid_hot.energy = Some(0.8);
        let mut mid_cool = feat(4, 110.0);
        mid_cool.energy = Some(0.3);
        let unmeasured = TrackFeatures { track_id: 5, ..Default::default() };
        let by_id: HashMap<i64, &TrackFeatures> =
            [(1, &fast), (2, &slow), (3, &mid_hot), (4, &mid_cool), (5, &unmeasured)].into_iter().collect();

        let out = ramp(vec![1, 3, 5, 2, 4], &by_id);
        assert_eq!(out, vec![5, 2, 4, 3, 1]);
        let bpm = |id: &i64| by_id[id].bpm.unwrap_or(0.0);
        for w in out.windows(2) {
            assert!(bpm(&w[0]) <= bpm(&w[1]), "tempo must not fall: {out:?}");
        }
    }
}
