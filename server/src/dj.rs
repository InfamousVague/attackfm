//! The DJ: a continuous, steerable set drawn from the listener's OWN library,
//! with a lightweight model writing the patter between runs of tracks - the
//! shape of a radio station, not a static playlist.
//!
//! Track SELECTION happens here in Rust, off the same taste/score the curator
//! uses, so the DJ agrees with the rest of the recommendations. The model only
//! writes WORDS, over a compact already-chosen list, which is why it can use a
//! smaller/faster model than the offline curator (`AFM_DJ_MODEL`) and still feel
//! live. A free-text `seed` steers the whole thing - "something mellow for a
//! rainy morning" - by standing in for the listener's centroid.

use crate::auth;
use crate::curator::{score, taste_from};
use crate::db::TrackFeatures;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// At most this many from one artist, so the DJ never gets stuck on a favourite.
const PER_ARTIST_CAP: usize = 2;
/// How many recent plays define "lately" and get held back from the set.
const RECENT_WINDOW: i64 = 80;

fn ai_url() -> Option<String> {
    std::env::var("AFM_AI_URL").ok().filter(|s| !s.trim().is_empty())
}

/// The DJ's model. Separate from the offline curator's on purpose: the DJ answers
/// a listener who is waiting, so it wants a small fast model, while curation runs
/// in the background and can afford a big one.
fn dj_model() -> String {
    std::env::var("AFM_DJ_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "qwen2.5:7b".to_string())
}

fn embed_model() -> String {
    std::env::var("AFM_AI_EMBED_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "nomic-embed-text".to_string())
}

/// Embed a free-text vibe so the set can be steered toward it rather than only
/// mirroring what was played last.
async fn embed(text: &str) -> Option<Vec<f32>> {
    let url = ai_url()?;
    let reply: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .ok()?
        .post(format!("{}/v1/embeddings", url.trim_end_matches('/')))
        .json(&json!({ "model": embed_model(), "input": text }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let arr = reply.pointer("/data/0/embedding")?.as_array()?;
    let v: Vec<f32> = arr.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect();
    (v.len() >= 32).then_some(v)
}

#[derive(serde::Deserialize)]
pub struct DjQuery {
    /// A free-text vibe to steer toward. Empty = mirror recent listening.
    #[serde(default)]
    pub seed: String,
    /// How many tracks to hand back (clamped to a sane range).
    #[serde(default)]
    pub count: Option<usize>,
}

/// `GET /api/dj?seed=&count=` - a continuous DJ set: runs of the listener's own
/// tracks with the DJ's spoken-style patter between them. The client plays each
/// block's tracks after showing its line, and calls again to keep the set going.
pub async fn station(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DjQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let want = q.count.unwrap_or(15).clamp(6, 30);
    let seed = q.seed.trim().to_string();

    // Taste: the same profile the curator scores against, from recent plays.
    let feats = state.db.all_features();
    let by_id: HashMap<i64, &TrackFeatures> = feats.iter().map(|f| (f.track_id, f)).collect();
    let recent = state.db.recent_plays(caller.id, RECENT_WINDOW);
    let mut taste = taste_from(&recent, &by_id);

    // A seed steers the set: embed it and let it stand in for the centroid, so
    // "something mellow" pulls mellow even out of a loud week.
    if !seed.is_empty() {
        if let Some(v) = embed(&seed).await {
            taste.centroid = Some(v);
        }
    }

    // Score the whole library, hold back the very-recently-played so the DJ does
    // not replay the last hour, and cap per artist.
    let held: HashSet<i64> = taste.heard.clone();
    let mut ranked: Vec<(f32, i64)> = feats
        .iter()
        .filter(|f| !held.contains(&f.track_id))
        .map(|f| (score(f, &taste), f.track_id))
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let artist_of: HashMap<i64, String> =
        feats.iter().map(|f| (f.track_id, f.artist.to_lowercase())).collect();
    let mut picks: Vec<i64> = Vec::new();
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    for (_s, id) in ranked {
        let key = artist_of.get(&id).cloned().unwrap_or_default();
        let c = per_artist.entry(key).or_insert(0);
        if *c >= PER_ARTIST_CAP {
            continue;
        }
        *c += 1;
        picks.push(id);
        if picks.len() >= want {
            break;
        }
    }
    if picks.is_empty() {
        return Ok(Json(json!({ "ai": false, "vibe": seed, "blocks": [] })));
    }

    // The model writes the patter over the already-chosen ids; a failure just
    // means a set with no words, never a set with no music.
    let blocks = patter(&state, &picks, &seed)
        .await
        .unwrap_or_else(|| vec![json!({ "say": "", "trackIds": picks.clone() })]);
    Ok(Json(json!({ "ai": ai_url().is_some(), "vibe": seed, "blocks": blocks })))
}

/// Ask the DJ model to break the chosen set into a few runs and open each with a
/// short spoken line. Words only - every id is validated back against `picks`,
/// and any the model drops are appended so the set stays whole.
async fn patter(state: &Arc<AppState>, picks: &[i64], seed: &str) -> Option<Vec<Value>> {
    let url = ai_url()?;
    let mut lines = Vec::new();
    for id in picks {
        if let Some(t) = state.db.track(*id) {
            lines.push(format!("{}|{} — {}", id, t.artist, t.title));
        }
    }
    if lines.is_empty() {
        return None;
    }
    let vibe = if seed.is_empty() {
        "their recent listening".to_string()
    } else {
        format!("\"{seed}\"")
    };
    let prompt = format!(
        "You are a warm late-night radio DJ introducing a continuous set pulled from ONE listener's OWN library, steered toward {vibe}.\n\
         The set, in play order, one per line as id|artist — title:\n{}\n\n\
         Split the set into 3-4 consecutive runs. For each run write ONE short spoken DJ line to open it: first person, natural, 1-2 sentences, no exclamation marks, no emojis, name at most one artist. Cover every track, in order, across the runs.\n\
         Answer with STRICT JSON and nothing else: [{{\"say\":\"...\",\"ids\":[1,2,3]}}] using ONLY the ids above, keeping their order.",
        lines.join("\n"),
    );

    let reply: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .ok()?
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": dj_model(),
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.9,
        }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let content = reply.pointer("/choices/0/message/content")?.as_str()?;
    // Carve the array out of any surrounding prose/fences; ordered and bounds
    // checked so a truncated reply can never panic the slice.
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    if end <= start {
        return None;
    }
    let parsed: Vec<Value> = serde_json::from_str(content.get(start..=end)?).ok()?;

    let valid: HashSet<i64> = picks.iter().copied().collect();
    let mut used: HashSet<i64> = HashSet::new();
    let mut blocks: Vec<Value> = Vec::new();
    for m in parsed {
        let say = m.get("say").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let ids: Vec<i64> = m
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_i64())
                    .filter(|id| valid.contains(id) && used.insert(*id))
                    .collect()
            })
            .unwrap_or_default();
        if say.is_empty() || ids.is_empty() {
            continue;
        }
        blocks.push(json!({ "say": say, "trackIds": ids }));
    }

    // Whatever the model left out still gets played, tacked onto the last run so
    // nothing the selector chose is silently dropped.
    let leftover: Vec<i64> = picks.iter().copied().filter(|id| !used.contains(id)).collect();
    if !leftover.is_empty() {
        match blocks.last_mut().and_then(|b| b.get_mut("trackIds")).and_then(|v| v.as_array_mut()) {
            Some(arr) => arr.extend(leftover.into_iter().map(|id| json!(id))),
            None => blocks.push(json!({ "say": "", "trackIds": leftover })),
        }
    }

    (!blocks.is_empty()).then_some(blocks)
}
