//! Shared, inspectable listener context used by recommendation surfaces.
//!
//! Stage 2 intentionally centralizes the legacy three-signal profile without changing its
//! ranking. Specialized DJ/theme scoring remains in its owning module.

use crate::{
    auth,
    curator::cosine,
    db::{Db, TrackFeatures},
    AppState,
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

const WINDOW_30D_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const PROFILE_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
pub(crate) const PROFILE_VERSION: i64 = 1;
pub const TASTE_MIN_TRACKS: usize = 4;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TasteCoverage {
    pub requested_tracks: usize,
    pub matched_tracks: usize,
    pub lyric_tracks: usize,
    pub tempo_tracks: usize,
    pub genre_tracks: usize,
}

/// The common base context. `heard` is eligibility state, deliberately separate from affinity.
#[derive(Clone, Debug, Default)]
pub(crate) struct TasteContext {
    pub centroid: Option<Vec<f32>>,
    pub tempo: Option<f64>,
    pub genres: HashMap<String, f32>,
    pub specific_tags: HashMap<String, f32>,
    pub sonic_centroid: Option<Vec<f32>>,
    pub audio_centroid: Option<Vec<f32>>,
    pub community_centroid: Option<Vec<f32>>,
    pub listenbrainz_edges: HashSet<String>,
    pub familiar_artists: HashSet<String>,
    pub semantic_confidence: f32,
    pub heard: HashSet<i64>,
    pub coverage: TasteCoverage,
    pub confidence: f32,
    /// The independently inspectable 30-day profile inputs.
    pub recent_weights: Vec<(i64, f32)>,
    /// The independently inspectable all-time profile inputs.
    pub long_term_weights: Vec<(i64, f32)>,
}

pub(crate) fn from_tracks(ids: &[i64], feats: &HashMap<i64, &TrackFeatures>) -> TasteContext {
    let weighted: Vec<(i64, f32)> = ids.iter().map(|id| (*id, 1.0)).collect();
    from_weighted(&weighted, feats)
}

pub(crate) fn from_weighted(
    tracks: &[(i64, f32)],
    feats: &HashMap<i64, &TrackFeatures>,
) -> TasteContext {
    let mut sum: Vec<f32> = Vec::new();
    let mut wsum = 0.0f32;
    let mut tempos: Vec<(f64, f32)> = Vec::new();
    let mut genres: HashMap<String, f32> = HashMap::new();
    let mut specific_tags: HashMap<String, f32> = HashMap::new();
    let mut sonic_vectors = Vec::new();
    let mut audio_vectors = Vec::new();
    let mut community_vectors = Vec::new();
    let mut listenbrainz_edges = HashSet::new();
    let mut familiar_artists = HashSet::new();
    let mut semantic_confidence_sum = 0.0;
    let mut semantic_weight_sum = 0.0;
    let mut coverage = TasteCoverage {
        requested_tracks: tracks.len(),
        ..Default::default()
    };

    for (id, weight) in tracks {
        let weight = weight.max(0.0);
        if weight <= 0.0 {
            continue;
        }
        let Some(feature) = feats.get(id) else {
            continue;
        };
        coverage.matched_tracks += 1;
        if !feature.artist.trim().is_empty() {
            familiar_artists.insert(feature.artist.trim().to_lowercase());
        }
        if let Some(vector) = feature
            .lyric_vec
            .as_ref()
            .filter(|vector| !vector.is_empty())
        {
            coverage.lyric_tracks += 1;
            if sum.is_empty() {
                sum = vec![0.0; vector.len()];
            }
            if sum.len() == vector.len() {
                for (total, value) in sum.iter_mut().zip(vector) {
                    *total += *value * weight;
                }
                wsum += weight;
            }
        }
        if let Some(bpm) = feature.bpm {
            coverage.tempo_tracks += 1;
            tempos.push((bpm, weight));
        }
        let enrichment_confidence = usable_enrichment_confidence(feature);
        semantic_confidence_sum += enrichment_confidence * weight;
        semantic_weight_sum += weight;
        if enrichment_confidence > 0.0 && !feature.ai_genres.is_empty() {
            coverage.genre_tracks += 1;
            for genre in &feature.ai_genres {
                *genres.entry(normalize_term(genre)).or_insert(0.0) +=
                    weight * enrichment_confidence;
            }
        } else if !feature.genre.trim().is_empty() {
            coverage.genre_tracks += 1;
            *genres.entry(normalize_term(&feature.genre)).or_insert(0.0) += weight * 0.7;
        }
        if enrichment_confidence > 0.0 {
            for tag in &feature.ai_specific_tags {
                *specific_tags.entry(normalize_term(tag)).or_insert(0.0) +=
                    weight * enrichment_confidence;
            }
            if let Some(vector) = feature.sonic_vec.as_ref().filter(|v| !v.is_empty()) {
                sonic_vectors.push((vector.as_slice(), weight * enrichment_confidence));
            }
        }
        if let Some(vector) = audio_vector(feature) {
            audio_vectors.push((vector, weight));
        }
        if let Some(vector) = feature.community_vec.as_ref().filter(|v| !v.is_empty()) {
            community_vectors.push((vector.as_slice(), weight));
        }
        for edge in &feature.listenbrainz_similar {
            listenbrainz_edges.insert(edge.clone());
        }
    }

    let centroid = (wsum > 0.0).then(|| sum.iter().map(|x| x / wsum).collect());
    tempos.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let half = tempos.iter().map(|(_, w)| w).sum::<f32>() / 2.0;
    let tempo = (!tempos.is_empty()).then(|| {
        let mut accumulated = 0.0;
        for (bpm, weight) in &tempos {
            accumulated += weight;
            if accumulated >= half {
                return *bpm;
            }
        }
        tempos[tempos.len() - 1].0
    });
    let total = genres.values().sum::<f32>();
    if total > 0.0 {
        for value in genres.values_mut() {
            *value /= total;
        }
    }
    normalize_shares(&mut specific_tags);
    let confidence = if coverage.requested_tracks == 0 {
        0.0
    } else {
        coverage.matched_tracks as f32 / coverage.requested_tracks as f32
    };
    TasteContext {
        centroid,
        tempo,
        genres,
        specific_tags,
        sonic_centroid: weighted_vector_mean(sonic_vectors),
        audio_centroid: weighted_owned_vector_mean(audio_vectors),
        community_centroid: weighted_vector_mean(community_vectors),
        listenbrainz_edges,
        familiar_artists,
        semantic_confidence: if semantic_weight_sum > 0.0 {
            semantic_confidence_sum / semantic_weight_sum
        } else {
            0.0
        },
        heard: tracks.iter().map(|(id, _)| *id).collect(),
        coverage,
        confidence,
        recent_weights: Vec::new(),
        long_term_weights: Vec::new(),
    }
}

pub(crate) fn heard_count(state: &Arc<AppState>, user: i64) -> usize {
    state.db.top_plays(user, now_ms() - WINDOW_30D_MS, 60).len()
}

/// Base context for callers that want verdict-aware data when available, preserving the
/// existing play-history fallback and minimum-data gate.
pub(crate) fn for_user(state: &Arc<AppState>, user: i64) -> Option<TasteContext> {
    for_db(&state.db, user, now_ms())
}

pub(crate) fn for_db(db: &Db, user: i64, now: i64) -> Option<TasteContext> {
    if let Some((version, generated_at, dirty, confidence, recent_json, long_json, _)) =
        db.taste_profile_row(user)
    {
        if version == PROFILE_VERSION
            && !dirty
            && now.saturating_sub(generated_at) <= PROFILE_MAX_AGE_MS
        {
            let recent = serde_json::from_str::<Vec<(i64, f32)>>(&recent_json).ok();
            let long_term = serde_json::from_str::<Vec<(i64, f32)>>(&long_json).ok();
            if let (Some(recent), Some(long_term)) = (recent, long_term) {
                if let Some(mut context) = context_from_windows(db, recent, long_term) {
                    context.confidence = confidence as f32;
                    return Some(context);
                }
            }
        }
    }
    rebuild_profile(db, user, now)
}

/// Full deterministic rebuild from raw events. This is also the per-user
/// incremental refresh path: meaningful events mark only that listener dirty,
/// and the next recommendation/profile read rebuilds only their snapshot.
pub(crate) fn rebuild_profile(db: &Db, user: i64, now: i64) -> Option<TasteContext> {
    let context = compute_raw(db, user, now)?;
    let summary = profile_summary(db, &context);
    let recent = serde_json::to_string(&context.recent_weights).ok()?;
    let long_term = serde_json::to_string(&context.long_term_weights).ok()?;
    let _ = db.store_taste_profile(
        user,
        PROFILE_VERSION,
        now,
        context.confidence as f64,
        &recent,
        &long_term,
        &summary.to_string(),
    );
    Some(context)
}

fn compute_raw(db: &Db, user: i64, now: i64) -> Option<TasteContext> {
    let all = db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    let recent: Vec<(i64, f32)> = db
        .weighted_listens_since(user, now - WINDOW_30D_MS, 60)
        .into_iter()
        .filter(|(id, _)| by_id.get(id).is_some_and(|feature| !feature.quarantined))
        .collect();
    let mut long_term: Vec<(i64, f32)> = db
        .weighted_long_term_listens(user, 60)
        .into_iter()
        .filter(|(id, _)| by_id.get(id).is_some_and(|feature| !feature.quarantined))
        .collect();
    // A track deliberately kept in one of this listener's playlists is mild
    // long-term evidence even when its play ledger is sparse. It cannot own a
    // profile: +0.25 once per distinct track, still capped at 3.0.
    let mut long_map: HashMap<i64, f32> = long_term.drain(..).collect();
    for track_id in db
        .playlists(user)
        .into_iter()
        .flat_map(|playlist| playlist.tracks)
        .collect::<HashSet<_>>()
    {
        if by_id
            .get(&track_id)
            .is_some_and(|feature| !feature.quarantined)
        {
            let weight = long_map.entry(track_id).or_default();
            *weight = (*weight + 0.25).min(3.0);
        }
    }
    let mut long_term: Vec<(i64, f32)> = long_map.into_iter().collect();
    long_term.sort_by_key(|(id, _)| *id);
    if long_term.len() >= TASTE_MIN_TRACKS {
        return context_from_feature_map(recent, long_term, &by_id);
    }
    let ids: Vec<i64> = db
        .top_plays(user, now - WINDOW_30D_MS, 60)
        .into_iter()
        .map(|(id, _)| id)
        .filter(|id| by_id.get(id).is_some_and(|feature| !feature.quarantined))
        .collect();
    (ids.len() >= TASTE_MIN_TRACKS).then(|| {
        let mut context = from_tracks(&ids, &by_id);
        context.recent_weights = ids.iter().map(|id| (*id, 1.0)).collect();
        context.long_term_weights = ids.iter().map(|id| (*id, 1.0)).collect();
        context
    })
}

fn context_from_windows(
    db: &Db,
    recent: Vec<(i64, f32)>,
    long_term: Vec<(i64, f32)>,
) -> Option<TasteContext> {
    let all = db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
    context_from_feature_map(recent, long_term, &by_id)
}

fn context_from_feature_map(
    recent: Vec<(i64, f32)>,
    long_term: Vec<(i64, f32)>,
    by_id: &HashMap<i64, &TrackFeatures>,
) -> Option<TasteContext> {
    if long_term.len() < TASTE_MIN_TRACKS {
        return None;
    }
    let mut combined: HashMap<i64, f32> = HashMap::new();
    for (id, weight) in &long_term {
        *combined.entry(*id).or_default() += 0.65 * weight;
    }
    for (id, weight) in &recent {
        *combined.entry(*id).or_default() += 0.35 * weight;
    }
    let mut combined: Vec<(i64, f32)> = combined.into_iter().collect();
    combined.sort_by_key(|(id, _)| *id);
    let mut context = from_weighted(&combined, by_id);
    context.heard = recent.iter().map(|(id, _)| *id).collect();
    context.recent_weights = recent;
    context.long_term_weights = long_term;
    Some(context)
}

fn weighted_names(db: &Db, weights: &[(i64, f32)], field: &str) -> Vec<serde_json::Value> {
    let mut totals: HashMap<String, f32> = HashMap::new();
    for (id, weight) in weights {
        let Some(track) = db.track(*id) else { continue };
        let value = if field == "album" { track.album } else { track.artist };
        if !value.trim().is_empty() {
            *totals.entry(value).or_default() += *weight;
        }
    }
    let mut ranked: Vec<(String, f32)> = totals.into_iter().collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    ranked
        .into_iter()
        .take(12)
        .map(|(name, weight)| json!({"name": name, "weight": weight}))
        .collect()
}

fn ranked_shares(values: &HashMap<String, f32>) -> Vec<serde_json::Value> {
    let mut ranked: Vec<(&String, &f32)> = values.iter().collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(b.0))
    });
    ranked
        .into_iter()
        .take(16)
        .map(|(name, share)| json!({"name": name, "share": share}))
        .collect()
}

fn profile_summary(db: &Db, context: &TasteContext) -> serde_json::Value {
    json!({
        "algorithmVersion": PROFILE_VERSION,
        "blend": {"longTerm": 0.65, "recent": 0.35},
        "tempo": context.tempo,
        "genres": ranked_shares(&context.genres),
        "specificTags": ranked_shares(&context.specific_tags),
        "recentArtists": weighted_names(db, &context.recent_weights, "artist"),
        "longTermArtists": weighted_names(db, &context.long_term_weights, "artist"),
        "longTermAlbums": weighted_names(db, &context.long_term_weights, "album"),
        "coverage": {
            "requestedTracks": context.coverage.requested_tracks,
            "matchedTracks": context.coverage.matched_tracks,
            "lyricTracks": context.coverage.lyric_tracks,
            "tempoTracks": context.coverage.tempo_tracks,
            "genreTracks": context.coverage.genre_tracks,
        },
        "confidence": context.confidence,
    })
}

/// Background backfill for existing listeners. It is deliberately detached
/// from startup latency and reads only the application's configured database.
pub(crate) fn spawn_profile_backfill(state: Arc<AppState>) {
    tokio::task::spawn_blocking(move || {
        let now = now_ms();
        for (user, _, _) in state.db.list_users() {
            let _ = rebuild_profile(&state.db, user, now);
        }
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileQuery {
    user_id: Option<i64>,
    #[serde(default)]
    rebuild: bool,
}

fn can_inspect_profile(caller_id: i64, is_admin: bool, target_id: i64) -> bool {
    caller_id == target_id || is_admin
}

/// Private profile inspection. A listener may inspect only themselves; an
/// administrator may name another user. No credentials, paths, or tokens are
/// serialized.
pub(crate) async fn profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ProfileQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|status| (status, "sign in first".into()))?;
    let user = query.user_id.unwrap_or(caller.id);
    if !can_inspect_profile(caller.id, caller.is_admin, user) {
        return Err((StatusCode::FORBIDDEN, "profile belongs to another listener".into()));
    }
    let context = if query.rebuild {
        rebuild_profile(&state.db, user, now_ms())
    } else {
        for_db(&state.db, user, now_ms())
    };
    let Some((version, generated_at, dirty, confidence, recent, long_term, summary)) =
        state.db.taste_profile_row(user)
    else {
        return Ok(Json(json!({"userId": user, "ready": false})));
    };
    Ok(Json(json!({
        "userId": user,
        "ready": context.is_some(),
        "version": version,
        "generatedAt": generated_at,
        "dirty": dirty,
        "confidence": confidence,
        "recentWeights": serde_json::from_str::<serde_json::Value>(&recent).unwrap_or(json!([])),
        "longTermWeights": serde_json::from_str::<serde_json::Value>(&long_term).unwrap_or(json!([])),
        "summary": serde_json::from_str::<serde_json::Value>(&summary).unwrap_or(json!({})),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsQuery {
    user_id: Option<i64>,
}

fn diagnostics_allowed(caller_id: i64, is_admin: bool, target_id: i64) -> bool {
    caller_id == target_id || is_admin
}

fn component_diagnostics(feature: &TrackFeatures, taste: &TasteContext) -> serde_json::Value {
    let values = score_components(feature, taste);
    let confidence = usable_enrichment_confidence(feature).min(taste.semantic_confidence);
    let lyric_present = taste.centroid.as_ref().is_some_and(|left| {
        feature
            .lyric_vec
            .as_ref()
            .is_some_and(|right| !left.is_empty() && left.len() == right.len())
    });
    let sonic_present = confidence > 0.0
        && taste.sonic_centroid.as_ref().is_some_and(|left| {
            feature
                .sonic_vec
                .as_ref()
                .is_some_and(|right| !left.is_empty() && left.len() == right.len())
        });
    let audio_present = taste.audio_centroid.as_ref().is_some_and(|left| {
        audio_vector(feature).is_some_and(|right| left.len() == right.len())
    });
    let genre_present = !taste.genres.is_empty()
        && (!feature.ai_genres.is_empty() || !feature.genre.trim().is_empty());
    let tag_present = confidence > 0.0
        && !taste.specific_tags.is_empty()
        && !feature.ai_specific_tags.is_empty();
    let community_present = taste.community_centroid.as_ref().is_some_and(|left| {
        feature
            .community_vec
            .as_ref()
            .is_some_and(|right| !left.is_empty() && left.len() == right.len())
    }) || (!feature.musicbrainz_id.is_empty()
        && taste.listenbrainz_edges.contains(&feature.musicbrainz_id));
    json!({
        "lyric": {"present": lyric_present, "score": values.lyric},
        "sonic": {"present": sonic_present, "score": values.sonic},
        "measuredAudio": {"present": audio_present, "score": values.measured_audio},
        "genre": {"present": genre_present, "score": values.genre},
        "specificTag": {"present": tag_present, "score": values.specific_tag},
        "community": {"present": community_present, "score": values.community},
        "evidenceCoverage": values.evidence_coverage,
        "total": values.total,
    })
}

fn library_lane(feature: &TrackFeatures, taste: &TasteContext, class: FamiliarityClass) -> &'static str {
    if taste.heard.contains(&feature.track_id) {
        "recently-heard"
    } else {
        match class {
            FamiliarityClass::Familiar => "familiar-artist-or-track",
            FamiliarityClass::Adjacent => "enriched-or-sonic-neighbor",
            FamiliarityClass::Exploratory => "bounded-exploration",
            FamiliarityClass::Wildcard => "relevance-floor-wildcard",
        }
    }
}

pub(crate) fn playlist_diagnostics(
    db: &Db,
    taste: &TasteContext,
    ids: &[i64],
) -> Vec<serde_json::Value> {
    let all = db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|feature| (feature.track_id, feature)).collect();
    ids.iter()
        .enumerate()
        .filter_map(|(position, id)| {
            let feature = by_id.get(id)?;
            let class = classify(feature, taste, 0.0)?;
            Some(json!({
                "trackId": id,
                "position": position,
                "artist": feature.artist,
                "retrievalLane": library_lane(feature, taste, class),
                "familiarityClass": class,
                "components": component_diagnostics(feature, taste),
                "filters": {
                    "quarantined": feature.quarantined,
                    "recentlyHeard": taste.heard.contains(id),
                    "rejected": false,
                },
                "llm": {"selected": false, "reordered": false},
            }))
        })
        .collect()
}

/// Developer-only recommendation trace. Disabled unless
/// AFM_RECOMMENDATION_DIAGNOSTICS=1 and still requires normal authentication.
/// The response is assembled from fixed application fields, never environment
/// values, paths, model URLs, tokens, or credentials.
pub(crate) async fn diagnostics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DiagnosticsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if std::env::var("AFM_RECOMMENDATION_DIAGNOSTICS").ok().as_deref() != Some("1") {
        return Err((StatusCode::NOT_FOUND, "diagnostics disabled".into()));
    }
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|status| (status, "sign in first".into()))?;
    let user = query.user_id.unwrap_or(caller.id);
    if !diagnostics_allowed(caller.id, caller.is_admin, user) {
        return Err((StatusCode::FORBIDDEN, "diagnostics belong to another listener".into()));
    }
    let Some(taste) = for_db(&state.db, user, now_ms()) else {
        return Ok(Json(json!({"userId": user, "ready": false})));
    };
    let profile = state.db.taste_profile_row(user);
    let intents: Vec<serde_json::Value> = state
        .db
        .curated_intents(user)
        .into_iter()
        .map(|(key, name, blurb, evidence)| {
            json!({
                "key": key,
                "name": name,
                "blurb": blurb,
                "evidence": serde_json::from_str::<serde_json::Value>(&evidence).unwrap_or(json!([])),
            })
        })
        .collect();
    let playlists: Vec<serde_json::Value> = state
        .db
        .curated_for(user)
        .into_iter()
        .map(|list| {
            json!({
                "slug": list.slug,
                "name": list.name,
                "builtAt": list.built_at,
                "finalOrder": playlist_diagnostics(&state.db, &taste, &list.track_ids),
            })
        })
        .collect();

    let all = state.db.all_features();
    let mut before: Vec<(f32, &TrackFeatures, FamiliarityClass)> = all
        .iter()
        .filter_map(|feature| {
            classify(feature, &taste, 0.0)
                .map(|class| (score(feature, &taste), feature, class))
        })
        .collect();
    before.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.track_id.cmp(&b.1.track_id))
    });
    let before_rank: HashMap<i64, usize> = before
        .iter()
        .enumerate()
        .map(|(rank, (_, feature, _))| (feature.track_id, rank))
        .collect();
    let reranked = rerank_allocated(
        before
            .iter()
            .map(|(candidate_score, feature, class)| AllocationCandidate {
                id: feature.track_id,
                artist: feature.artist.clone(),
                score: *candidate_score,
                class: *class,
            })
            .collect(),
        60,
        GENERAL_ALLOCATION,
    );
    let after_rank: HashMap<i64, usize> = reranked
        .iter()
        .enumerate()
        .map(|(rank, candidate)| (candidate.id, rank))
        .collect();
    let candidates: Vec<serde_json::Value> = before
        .iter()
        .take(120)
        .map(|(_, feature, class)| {
            json!({
                "trackId": feature.track_id,
                "artist": feature.artist,
                "retrievalLane": library_lane(feature, &taste, *class),
                "familiarityClass": class,
                "beforeDiversity": {
                    "rank": before_rank.get(&feature.track_id),
                    "components": component_diagnostics(feature, &taste),
                },
                "afterDiversity": {
                    "rank": after_rank.get(&feature.track_id),
                    "selected": after_rank.contains_key(&feature.track_id),
                    "scoreChanged": false,
                },
                "filters": {
                    "quarantined": feature.quarantined,
                    "recentlyHeard": taste.heard.contains(&feature.track_id),
                    "rejected": false,
                },
            })
        })
        .collect();
    let discoveries: Vec<serde_json::Value> = state
        .db
        .all_discoveries(user)
        .into_iter()
        .map(|row| {
            json!({
                "id": row.ext_id,
                "artist": row.artist,
                "title": row.title,
                "retrievalLane": row.lane,
                "familiarityClass": crate::discovery::discovery_class(row.score, &row.seed, &row.lane),
                "score": row.score,
                "bridge": row.seed,
                "filters": {
                    "owned": false,
                    "rejected": crate::discovery::is_rejected(&state.db, user, &row.artist, &row.title),
                    "quarantined": false,
                    "recentlyHeard": false,
                },
            })
        })
        .collect();
    let (version, generated_at, dirty, confidence) = profile
        .map(|row| (row.0, row.1, row.2, row.3))
        .unwrap_or((0, 0, true, 0.0));
    Ok(Json(json!({
        "userId": user,
        "ready": true,
        "profile": {
            "version": version,
            "generatedAt": generated_at,
            "ageMs": now_ms().saturating_sub(generated_at),
            "dirty": dirty,
            "confidence": confidence,
        },
        "intents": intents,
        "playlists": playlists,
        "candidates": candidates,
        "discoveries": discoveries,
        "llmRoles": {
            "home": "names, selects, and reorders only prequalified candidates; deterministic validation is final",
            "backgroundCurator": "names and explains supported intents; deterministic retrieval and ranking choose tracks",
            "newMusic": "groups and names already-scored discovery rows",
            "collector": "writes a reason only; threshold, confidence, pacing, and ownership are deterministic",
        },
    })))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn normalize_term(value: &str) -> String {
    value.trim().to_lowercase().replace('_', "-")
}

fn normalize_shares(values: &mut HashMap<String, f32>) {
    let total: f32 = values.values().sum();
    if total > 0.0 {
        for value in values.values_mut() {
            *value /= total;
        }
    }
}

fn usable_enrichment_confidence(feature: &TrackFeatures) -> f32 {
    let has_provenance = feature.enrichment_sources.iter().any(|source| {
        let source = source.to_lowercase();
        !source.starts_with("rejected") && !source.trim().is_empty()
    });
    if has_provenance {
        feature.enrichment_confidence.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn weighted_vector_mean(vectors: Vec<(&[f32], f32)>) -> Option<Vec<f32>> {
    let dims = vectors.first()?.0.len();
    if dims == 0 {
        return None;
    }
    let mut sum = vec![0.0; dims];
    let mut total = 0.0;
    for (vector, weight) in vectors {
        if vector.len() != dims || weight <= 0.0 {
            continue;
        }
        for (slot, value) in sum.iter_mut().zip(vector) {
            *slot += value * weight;
        }
        total += weight;
    }
    (total > 0.0).then(|| sum.into_iter().map(|value| value / total).collect())
}

fn weighted_owned_vector_mean(vectors: Vec<(Vec<f32>, f32)>) -> Option<Vec<f32>> {
    weighted_vector_mean(vectors.iter().map(|(v, w)| (v.as_slice(), *w)).collect())
}

fn similarity(a: Option<&[f32]>, b: Option<&[f32]>) -> Option<f32> {
    match (a, b) {
        (Some(a), Some(b)) if !a.is_empty() && a.len() == b.len() => Some(cosine(a, b)),
        _ => None,
    }
}

/// Prefer the local 48-part fingerprint. Older rows use the five measured,
/// explainable values when at least three exist.
pub(crate) fn audio_vector(feature: &TrackFeatures) -> Option<Vec<f32>> {
    if let Some(fingerprint) = feature.audio_fingerprint.as_ref().filter(|v| v.len() == 48) {
        return Some(fingerprint.clone());
    }
    let parts = [
        feature.bpm.map(|v| (v / 240.0).clamp(0.0, 1.0)),
        feature.energy,
        feature.brightness,
        feature.dynamic_range,
        feature.rhythmic_activity,
    ];
    (parts.iter().filter(|value| value.is_some()).count() >= 3).then(|| {
        parts
            .into_iter()
            .map(|value| value.unwrap_or(0.5) as f32)
            .collect()
    })
}

fn term_score(
    taste: &HashMap<String, f32>,
    candidate: &[String],
    miss: f32,
    confidence: f32,
) -> f32 {
    let matched = candidate
        .iter()
        .filter_map(|term| taste.get(term))
        .copied()
        .fold(0.0f32, f32::max);
    let base = if matched > 0.0 {
        (matched * 3.0).min(1.0)
    } else {
        miss
    };
    0.5 + (base - 0.5) * confidence.clamp(0.0, 1.0)
}

fn measured_audio_similarity(target: &[f32], candidate: &[f32]) -> Option<f32> {
    if target.is_empty() || target.len() != candidate.len() {
        return None;
    }
    if target.len() == 48 {
        return Some(((cosine(target, candidate) + 1.0) / 2.0).clamp(0.0, 1.0));
    }
    let distance = target
        .iter()
        .zip(candidate)
        .map(|(a, b)| (a - b).abs().min(1.0))
        .sum::<f32>()
        / target.len() as f32;
    Some((1.0 - distance).clamp(0.0, 1.0))
}

pub(crate) fn score(feature: &TrackFeatures, taste: &TasteContext) -> f32 {
    score_components(feature, taste).total
}

pub(crate) const WILDCARD_RELEVANCE_FLOOR: f32 = 0.40;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FamiliarityClass {
    Familiar,
    Adjacent,
    Exploratory,
    Wildcard,
}

impl FamiliarityClass {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Familiar => "familiar",
            Self::Adjacent => "adjacent",
            Self::Exploratory => "exploratory",
            Self::Wildcard => "wildcard",
        }
    }
}

/// A bounded learning nudge from settled exposure outcomes. Ten perfect or
/// failed samples move a relevance boundary by at most three hundredths;
/// sparse outcomes move it less and can never turn incompatibility into fit.
pub(crate) fn exploration_adjustment(adopted: i64, exposed: i64) -> f32 {
    if exposed <= 0 {
        return 0.0;
    }
    let confidence = (exposed as f32 / 10.0).clamp(0.0, 1.0);
    let rate = adopted as f32 / exposed as f32;
    ((rate - 0.25) * 0.04 * confidence).clamp(-0.03, 0.03)
}

pub(crate) fn classify(
    feature: &TrackFeatures,
    taste: &TasteContext,
    learning_adjustment: f32,
) -> Option<FamiliarityClass> {
    let components = score_components(feature, taste);
    let adjusted = (components.total + learning_adjustment).clamp(0.0, 1.0);
    if taste
        .long_term_weights
        .iter()
        .any(|(id, _)| *id == feature.track_id)
        || taste
            .familiar_artists
            .contains(&feature.artist.trim().to_lowercase())
    {
        return Some(FamiliarityClass::Familiar);
    }
    if adjusted >= 0.60 && components.evidence_coverage >= 0.25 {
        Some(FamiliarityClass::Adjacent)
    } else if adjusted >= 0.48 && components.evidence_coverage >= 0.20 {
        Some(FamiliarityClass::Exploratory)
    } else if adjusted >= WILDCARD_RELEVANCE_FLOOR && components.evidence_coverage >= 0.15 {
        Some(FamiliarityClass::Wildcard)
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct AllocationTargets {
    pub familiar: f32,
    pub adjacent: f32,
    pub exploratory: f32,
    pub wildcard: f32,
}

pub(crate) const GENERAL_ALLOCATION: AllocationTargets = AllocationTargets {
    familiar: 0.65,
    adjacent: 0.25,
    exploratory: 0.08,
    wildcard: 0.02,
};

pub(crate) const DISCOVERY_ALLOCATION: AllocationTargets = AllocationTargets {
    familiar: 0.10,
    adjacent: 0.45,
    exploratory: 0.35,
    wildcard: 0.10,
};

#[derive(Clone, Debug)]
pub(crate) struct AllocationCandidate {
    pub id: i64,
    pub artist: String,
    pub score: f32,
    pub class: FamiliarityClass,
}

fn target_counts(n: usize, targets: AllocationTargets) -> HashMap<FamiliarityClass, usize> {
    let values = [
        (FamiliarityClass::Familiar, targets.familiar),
        (FamiliarityClass::Adjacent, targets.adjacent),
        (FamiliarityClass::Exploratory, targets.exploratory),
        (FamiliarityClass::Wildcard, targets.wildcard),
    ];
    let mut counts: HashMap<FamiliarityClass, usize> = values
        .iter()
        .map(|(class, ratio)| (*class, (*ratio * n as f32).floor() as usize))
        .collect();
    let mut remainder = n.saturating_sub(counts.values().sum());
    let mut fractions: Vec<(FamiliarityClass, f32)> = values
        .iter()
        .map(|(class, ratio)| (*class, *ratio * n as f32 - (*ratio * n as f32).floor()))
        .collect();
    fractions.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.as_str().cmp(b.0.as_str()))
    });
    for (class, _) in fractions.into_iter().cycle().take(remainder) {
        *counts.entry(class).or_default() += 1;
        remainder = remainder.saturating_sub(1);
    }
    counts
}

/// Relevance first inside each class, then target allocation and a two-track
/// artist cap. Missing classes yield a shorter playlist only when every safe
/// alternative is exhausted; a wildcard never enters without classification,
/// which already enforces the compatibility floor.
pub(crate) fn rerank_allocated(
    mut candidates: Vec<AllocationCandidate>,
    n: usize,
    targets: AllocationTargets,
) -> Vec<AllocationCandidate> {
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    let limits = target_counts(n, targets);
    let mut out = Vec::new();
    let mut used = HashSet::new();
    let mut artists: HashMap<String, usize> = HashMap::new();
    for class in [
        FamiliarityClass::Familiar,
        FamiliarityClass::Adjacent,
        FamiliarityClass::Exploratory,
        FamiliarityClass::Wildcard,
    ] {
        let limit = limits.get(&class).copied().unwrap_or(0);
        for candidate in candidates.iter().filter(|candidate| candidate.class == class) {
            if out.iter().filter(|picked: &&AllocationCandidate| picked.class == class).count()
                >= limit
            {
                break;
            }
            let artist = candidate.artist.trim().to_lowercase();
            if artists.get(&artist).copied().unwrap_or(0) >= 2 {
                continue;
            }
            used.insert(candidate.id);
            *artists.entry(artist).or_default() += 1;
            out.push(candidate.clone());
        }
    }
    for candidate in candidates {
        if out.len() >= n || used.contains(&candidate.id) {
            continue;
        }
        let artist = candidate.artist.trim().to_lowercase();
        if artists.get(&artist).copied().unwrap_or(0) >= 2 {
            continue;
        }
        used.insert(candidate.id);
        *artists.entry(artist).or_default() += 1;
        out.push(candidate);
    }
    out.truncate(n);
    out
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct ScoreComponents {
    pub lyric: f32,
    pub sonic: f32,
    pub measured_audio: f32,
    pub genre: f32,
    pub specific_tag: f32,
    pub community: f32,
    pub evidence_coverage: f32,
    pub total: f32,
}

/// Inspectable deterministic score. Missing evidence is neutral and also
/// reduces how far the total may move away from neutral, so sparse candidates
/// do not receive a hidden advantage over well-measured tracks.
pub(crate) fn score_components(feature: &TrackFeatures, taste: &TasteContext) -> ScoreComponents {
    let half = |value: f32| ((value + 1.0) / 2.0).clamp(0.0, 1.0);
    let lyric = similarity(taste.centroid.as_deref(), feature.lyric_vec.as_deref()).map(half);
    let confidence = usable_enrichment_confidence(feature);
    let semantic_confidence = confidence.min(taste.semantic_confidence);
    let sonic = (semantic_confidence > 0.0)
        .then(|| similarity(taste.sonic_centroid.as_deref(), feature.sonic_vec.as_deref()))
        .flatten()
        .map(|value| 0.5 + (half(value) - 0.5) * semantic_confidence);
    let measured_audio = audio_vector(feature).and_then(|candidate| {
        taste
            .audio_centroid
            .as_deref()
            .and_then(|target| measured_audio_similarity(target, &candidate))
    });
    let enriched_terms: Vec<String> = if confidence > 0.0 {
        feature.ai_genres.iter().map(|v| normalize_term(v)).collect()
    } else {
        Vec::new()
    };
    let genre = if !enriched_terms.is_empty() && !taste.genres.is_empty() {
        Some(term_score(&taste.genres, &enriched_terms, 0.15, semantic_confidence))
    } else if !feature.genre.trim().is_empty() && !taste.genres.is_empty() {
        Some(term_score(&taste.genres, &[normalize_term(&feature.genre)], 0.15, 0.7))
    } else {
        None
    };
    let tags: Vec<String> = feature.ai_specific_tags.iter().map(|v| normalize_term(v)).collect();
    let specific_tag = (!tags.is_empty() && semantic_confidence > 0.0 && !taste.specific_tags.is_empty())
        .then(|| term_score(&taste.specific_tags, &tags, 0.1, semantic_confidence));
    let community_vector = similarity(
        taste.community_centroid.as_deref(),
        feature.community_vec.as_deref(),
    )
    .map(half);
    let community_edge = (!feature.musicbrainz_id.is_empty()
        && taste.listenbrainz_edges.contains(&feature.musicbrainz_id))
        .then_some(1.0);
    let community = community_edge.or(community_vector);

    let weighted = [
        (lyric, 0.12),
        (sonic, 0.18),
        (measured_audio, 0.30),
        (genre, 0.15),
        (specific_tag, 0.20),
        (community, 0.05),
    ];
    let available: f32 = weighted.iter().filter_map(|(v, w)| v.map(|_| *w)).sum();
    let raw = weighted.iter().map(|(v, w)| v.unwrap_or(0.5) * w).sum::<f32>();
    let total = 0.5 + (raw - 0.5) * (0.6 + 0.4 * available);
    ScoreComponents {
        lyric: lyric.unwrap_or(0.5),
        sonic: sonic.unwrap_or(0.5),
        measured_audio: measured_audio.unwrap_or(0.5),
        genre: genre.unwrap_or(0.5),
        specific_tag: specific_tag.unwrap_or(0.5),
        community: community.unwrap_or(0.5),
        evidence_coverage: available,
        total: total.clamp(0.0, 1.0),
    }
}

pub(crate) fn score_parts(
    taste: &TasteContext,
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
    let genre = match (taste.genres.is_empty(), genre) {
        (false, Some(name)) => taste
            .genres
            .get(&name.to_lowercase())
            .map(|s| (s * 3.0).min(1.0))
            .unwrap_or(0.15),
        _ => 0.5,
    };
    0.45 * lyric + 0.3 * tempo + 0.25 * genre
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rich(
        id: i64,
        genres: &[&str],
        tags: &[&str],
        sonic: [f32; 2],
        audio: [f64; 5],
        community: [f32; 2],
        confidence: f32,
    ) -> TrackFeatures {
        TrackFeatures {
            track_id: id,
            genre: genres.first().copied().unwrap_or("").into(),
            ai_genres: genres.iter().map(|v| (*v).into()).collect(),
            ai_specific_tags: tags.iter().map(|v| (*v).into()).collect(),
            enrichment_confidence: confidence,
            enrichment_sources: vec!["fixture".into()],
            sonic_vec: Some(sonic.into()),
            community_vec: Some(community.into()),
            bpm: Some(audio[0]),
            energy: Some(audio[1]),
            brightness: Some(audio[2]),
            dynamic_range: Some(audio[3]),
            rhythmic_activity: Some(audio[4]),
            ..Default::default()
        }
    }

    #[test]
    fn every_caller_gets_the_same_base_context() {
        let a = TrackFeatures {
            track_id: 1,
            bpm: Some(100.0),
            genre: "metal".into(),
            lyric_vec: Some(vec![1.0, 0.0]),
            ..Default::default()
        };
        let b = TrackFeatures {
            track_id: 2,
            bpm: Some(120.0),
            genre: "industrial".into(),
            lyric_vec: Some(vec![0.0, 1.0]),
            ..Default::default()
        };
        let feats = [(1, &a), (2, &b)].into_iter().collect();
        let contexts = [
            from_tracks(&[1, 2], &feats),
            from_weighted(&[(1, 1.0), (2, 1.0)], &feats),
        ];
        for context in &contexts[1..] {
            assert_eq!(contexts[0].centroid, context.centroid);
            assert_eq!(contexts[0].tempo, context.tempo);
            assert_eq!(contexts[0].genres, context.genres);
            assert_eq!(contexts[0].heard, context.heard);
        }
    }

    #[test]
    fn missing_and_invalid_features_are_explicit_and_safe() {
        let sparse = TrackFeatures {
            track_id: 1,
            lyric_vec: Some(vec![]),
            ..Default::default()
        };
        let feats = [(1, &sparse)].into_iter().collect();
        let context = from_tracks(&[1, 2], &feats);
        assert!(context.centroid.is_none() && context.tempo.is_none() && context.genres.is_empty());
        assert_eq!(
            context.coverage,
            TasteCoverage {
                requested_tracks: 2,
                matched_tracks: 1,
                lyric_tracks: 0,
                tempo_tracks: 0,
                genre_tracks: 0
            }
        );
        assert_eq!(context.confidence, 0.5);
        assert!(score(&TrackFeatures::default(), &context).is_finite());
    }

    #[test]
    fn enriched_bridge_and_specific_subgenre_beat_unrelated_or_broad_matches() {
        let seed = rich(1, &["industrial", "electronic"], &["ebm"], [1.0, 0.0], [132.0, 0.8, 0.5, 0.4, 0.8], [1.0, 0.0], 1.0);
        let feats = [(1, &seed)].into_iter().collect();
        let taste = from_weighted(&[(1, 1.0)], &feats);
        let specific = rich(2, &["industrial metal"], &["ebm"], [0.95, 0.05], [135.0, 0.78, 0.52, 0.42, 0.76], [0.9, 0.1], 1.0);
        let broad = rich(3, &["electronic"], &[], [0.95, 0.05], [135.0, 0.78, 0.52, 0.42, 0.76], [0.9, 0.1], 1.0);
        let pop = rich(4, &["dance pop"], &["idol-pop"], [0.0, 1.0], [92.0, 0.35, 0.9, 0.2, 0.25], [0.0, 1.0], 1.0);
        assert!(score(&specific, &taste) > score(&broad, &taste));
        assert!(score(&specific, &taste) > score(&pop, &taste));
    }

    #[test]
    fn missing_low_confidence_and_community_evidence_stay_bounded() {
        let seed = rich(1, &["industrial"], &["ebm"], [1.0, 0.0], [132.0, 0.85, 0.45, 0.5, 0.8], [1.0, 0.0], 1.0);
        let feats = [(1, &seed)].into_iter().collect();
        let taste = from_weighted(&[(1, 1.0)], &feats);

        let mut low_confidence = rich(2, &["industrial"], &["ebm"], [1.0, 0.0], [60.0, 0.05, 0.95, 0.05, 0.05], [1.0, 0.0], 0.05);
        let measured_near = rich(3, &["pop"], &[], [0.0, 1.0], [133.0, 0.83, 0.47, 0.48, 0.79], [0.0, 1.0], 1.0);
        assert!(score(&measured_near, &taste) > score(&low_confidence, &taste), "low-confidence labels dominated measured audio");

        let sonic_opposite = rich(4, &["industrial"], &["ebm"], [-1.0, 0.0], [132.0, 0.85, 0.45, 0.5, 0.8], [1.0, 0.0], 1.0);
        let mut sonic_missing = rich(5, &["industrial"], &["ebm"], [-1.0, 0.0], [132.0, 0.85, 0.45, 0.5, 0.8], [1.0, 0.0], 1.0);
        sonic_missing.sonic_vec = None;
        assert_ne!(score_components(&sonic_opposite, &taste).sonic, score_components(&sonic_missing, &taste).sonic);

        low_confidence.enrichment_sources.clear();
        let unstamped = score_components(&low_confidence, &taste);
        assert_eq!(unstamped.sonic, 0.5, "unstamped enrichment was trusted");

        let sonic_match_community_miss = rich(6, &["industrial"], &["ebm"], [1.0, 0.0], [132.0, 0.85, 0.45, 0.5, 0.8], [0.0, 1.0], 1.0);
        let sonic_miss_community_match = rich(7, &["industrial"], &["ebm"], [-1.0, 0.0], [132.0, 0.85, 0.45, 0.5, 0.8], [1.0, 0.0], 1.0);
        assert!(score(&sonic_match_community_miss, &taste) > score(&sonic_miss_community_match, &taste), "community outweighed a strong sonic mismatch");
    }

    #[test]
    fn enriched_scoring_is_deterministic_and_components_recompose() {
        let seed = rich(1, &["industrial"], &["ebm"], [1.0, 0.0], [132.0, 0.8, 0.5, 0.4, 0.8], [1.0, 0.0], 1.0);
        let feats = [(1, &seed)].into_iter().collect();
        let taste = from_weighted(&[(1, 1.0)], &feats);
        let candidate = rich(2, &["industrial"], &["ebm"], [0.9, 0.1], [134.0, 0.78, 0.52, 0.42, 0.76], [0.8, 0.2], 0.9);
        let first = score_components(&candidate, &taste);
        assert_eq!(first, score_components(&candidate, &taste));
        assert_eq!(first.total, score(&candidate, &taste));
        assert!(first.evidence_coverage > 0.8);
    }

    #[test]
    fn taste_profile_inspection_is_private_except_for_admins() {
        assert!(can_inspect_profile(1, false, 1));
        assert!(!can_inspect_profile(1, false, 2));
        assert!(can_inspect_profile(1, true, 2));
    }

    #[test]
    fn stage10_general_allocation_is_bounded_and_wildcards_clear_the_floor() {
        let mut candidates = Vec::new();
        let classes = [
            (FamiliarityClass::Familiar, 30),
            (FamiliarityClass::Adjacent, 20),
            (FamiliarityClass::Exploratory, 12),
            (FamiliarityClass::Wildcard, 8),
        ];
        let mut id = 1;
        for (class, count) in classes {
            for _ in 0..count {
                candidates.push(AllocationCandidate {
                    id,
                    artist: format!("Artist {id}"),
                    score: if class == FamiliarityClass::Wildcard { 0.41 } else { 0.8 },
                    class,
                });
                id += 1;
            }
        }
        let picked = rerank_allocated(candidates, 30, GENERAL_ALLOCATION);
        assert_eq!(picked.len(), 30);
        let count = |class| picked.iter().filter(|candidate| candidate.class == class).count();
        assert_eq!(count(FamiliarityClass::Familiar), 19);
        assert_eq!(count(FamiliarityClass::Adjacent), 8);
        assert_eq!(count(FamiliarityClass::Exploratory), 2);
        assert_eq!(count(FamiliarityClass::Wildcard), 1);
        assert!(picked
            .iter()
            .filter(|candidate| candidate.class == FamiliarityClass::Wildcard)
            .all(|candidate| candidate.score >= WILDCARD_RELEVANCE_FLOOR));
    }

    #[test]
    fn stage10_exploration_learning_is_gradual_recoverable_and_bounded() {
        let success = exploration_adjustment(10, 10);
        let failure = exploration_adjustment(0, 10);
        assert!(success > 0.0 && success <= 0.03);
        assert!(failure < 0.0 && failure >= -0.03);
        assert_eq!(exploration_adjustment(0, 0), 0.0);
        assert!(exploration_adjustment(1, 2).abs() < success.abs());
    }

    #[test]
    fn stage11_diagnostics_are_private_and_missing_signals_stay_missing() {
        assert!(diagnostics_allowed(1, false, 1));
        assert!(!diagnostics_allowed(1, false, 2));
        assert!(diagnostics_allowed(1, true, 2));
        let value = component_diagnostics(&TrackFeatures::default(), &TasteContext::default());
        for key in ["lyric", "sonic", "measuredAudio", "genre", "specificTag", "community"] {
            assert_eq!(value[key]["present"], false, "{key} claimed missing evidence");
        }
        let serialized = value.to_string();
        assert!(!serialized.contains("AFM_"));
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("/home/"));
    }
}
