//! Song lore: one short true thing the DJ can say about a record.
//!
//! By request the DJ tells "a bit of lore about each song coming up, without
//! being too verbose" - so each track in a set carries at most ONE short
//! model-written sentence: the album it came from, the story behind it, what
//! it is known for. The model is told, hard, to say nothing when it does not
//! recognise the exact song - for the small artists these libraries are full
//! of, an empty line is the honest one, and the set just plays.
//!
//! Economics mirror the voice layer's: lore belongs to the SONG, so one row
//! in `song_lore` (and one minted clip) serves every listener and every set
//! forever. Generation rides BEHIND the live replies (spawned; the wait-lock
//! and cooldowns bound the model time): served sets speak what is on file
//! and commission the gaps for next time. History: under the banked-sets era
//! generation lived inline in the banks instead, because a behind-live spawn
//! holding the old SKIP-latch starved the banks' own pass - with the banks
//! retired (2026-08-31) the spawn is the one generator again, now safely.

use crate::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

/// How long an "asked, unknown" verdict stands before the model may be asked
/// again - models change, and a re-ask costs one line in a batch.
const RETRY_EMPTY_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// Songs per model call. Small on purpose: the hub's CPU model finishes a
/// six-line brief reliably where a whole-set brief wanders past its patience.
const BATCH: usize = 6;
/// The verbosity ceiling, enforced here rather than trusted to the prompt.
const MAX_WORDS: usize = 26;
const MAX_CHARS: usize = 190;

/// One generation task hub-wide, and callers WAIT rather than skip: every
/// caller is a background bank build, so waiting is free, and a skip-latch
/// here silently banked loreless sets whenever two builds raced. The lock is
/// held across the model calls on purpose - lore shares its model with
/// enrichment, Music Date and the vibe bank, and serialising is the point.
fn lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// When the model last failed a lore call outright, so a broken config burns
/// one call per cooldown, not one per press.
fn last_failure() -> &'static AtomicI64 {
    static T: AtomicI64 = AtomicI64::new(0);
    &T
}
const FAILURE_COOLDOWN_MS: i64 = 10 * 60 * 1000;

/// The lore already on file for these ids, ready to attach: non-empty rows
/// only. Pure DB, safe on the request path.
pub fn known(state: &AppState, ids: &[i64]) -> HashMap<i64, String> {
    state
        .db
        .lore_rows(ids)
        .into_iter()
        .filter(|(_, body, _)| !body.is_empty())
        .map(|(id, body, _)| (id, body))
        .collect()
}

/// Which of these ids still owe the model a visit: never asked, or an empty
/// verdict old enough to retry.
fn wanted(state: &AppState, ids: &[i64]) -> Vec<i64> {
    let rows: HashMap<i64, (String, i64)> = state
        .db
        .lore_rows(ids)
        .into_iter()
        .map(|(id, body, at)| (id, (body, at)))
        .collect();
    let now = crate::db::now_ms();
    let mut seen = std::collections::HashSet::new();
    ids.iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .filter(|id| match rows.get(id) {
            None => true,
            Some((body, at)) => body.is_empty() && now - at > RETRY_EMPTY_MS,
        })
        .collect()
}

/// Fill the gaps for these ids, model permitting. Call from background time
/// only - a batch on the hub's CPU model takes real minutes, and callers
/// queue on the lore lock. The gap list is computed AFTER the lock lands, so
/// a pass never re-asks what the pass ahead of it just wrote.
pub async fn ensure(state: &std::sync::Arc<AppState>, ids: &[i64]) {
    let Some(url) = crate::dj::ai_url() else { return };
    if wanted(state, ids).is_empty() {
        return;
    }
    let now = crate::db::now_ms();
    if now - last_failure().load(Ordering::Relaxed) < FAILURE_COOLDOWN_MS {
        return;
    }
    let _held = lock().lock().await;
    let todo = wanted(state, ids);
    for chunk in todo.chunks(BATCH) {
        let lines: Vec<String> = chunk
            .iter()
            .filter_map(|id| {
                state.db.track(*id).map(|t| {
                    let year = t.year.map(|y| y.to_string()).unwrap_or_default();
                    format!("{}|{} — {}|{}", id, t.artist, t.title, year)
                })
            })
            .collect();
        if lines.is_empty() {
            continue;
        }
        match batch_lore(&url, &lines).await {
            Some(replies) => {
                /*
                 * Only ids the model actually ANSWERED are written. An id it
                 * left out of the reply is not a verdict - sealing it as a
                 * 14-day "unknown" because a truncated reply dropped a key
                 * was how songs lost their lore to a lossy JSON round-trip.
                 */
                for (id, line) in &replies {
                    if chunk.contains(id) {
                        let _ = state.db.lore_put(*id, &trim_lore(line));
                    }
                }
            }
            // The model was unreachable or unparseable: write nothing and
            // stand down for a while - a broken config must not burn a full
            // model call on every press forever.
            None => {
                last_failure().store(crate::db::now_ms(), Ordering::Relaxed);
                break;
            }
        }
    }
}

/// One model call over a handful of songs. Returns the parsed id -> line map,
/// or None when the call itself failed (as opposed to the model not knowing).
async fn batch_lore(url: &str, lines: &[String]) -> Option<HashMap<i64, String>> {
    let prompt = format!(
        "You are a radio DJ's researcher. For each song below (id|artist — title|year), write ONE short\n\
         factual sentence of real background a DJ could say on air: the album or era it came from, the\n\
         story behind it, a chart moment, what it is known for. At most 20 words, plain and warm, no\n\
         exclamation marks.\n\
         HONESTY RULE: if you do not confidently recognise that exact song or artist, the value MUST be\n\
         an empty string. Never guess, never invent, never describe the title's words as if they were facts.\n\n\
         {}\n\n\
         Answer with STRICT JSON and nothing else: an object mapping each id to its sentence or \"\",\n\
         e.g. {{\"12\":\"...\",\"31\":\"\"}}.",
        lines.join("\n"),
    );
    // The bank's own patience: lore only ever runs in background time.
    let patience = crate::ai::setting("timeoutSecs", "AFM_AI_TIMEOUT_SECS")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(300)
        .max(60);
    let reply: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(patience))
        .build()
        .ok()?
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": crate::dj::dj_model(),
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.4,
            "max_tokens": 400,
        }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let content = reply.pointer("/choices/0/message/content")?.as_str()?;
    parse_lore_reply(content)
}

/// Carve the JSON object out of whatever prose or fences surround it and read
/// it as id -> line. Bounds-checked; a truncated reply reads as a failed call.
fn parse_lore_reply(content: &str) -> Option<HashMap<i64, String>> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    if end <= start {
        return None;
    }
    let parsed: HashMap<String, Value> = serde_json::from_str(content.get(start..=end)?).ok()?;
    Some(
        parsed
            .into_iter()
            .filter_map(|(k, v)| {
                let id = k.trim().parse::<i64>().ok()?;
                let line = v.as_str().unwrap_or("").trim().to_string();
                Some((id, line))
            })
            .collect(),
    )
}

/// The verbosity gate, and the honesty backstop: a line that rambles past the
/// ceiling, or that is the model talking about itself instead of the song,
/// stores as empty - "no lore" beats bad lore.
fn trim_lore(line: &str) -> String {
    let line = line.trim().trim_matches('"').trim();
    if line.is_empty()
        || line.len() > MAX_CHARS
        || line.split_whitespace().count() > MAX_WORDS
    {
        return String::new();
    }
    let lower = line.to_lowercase();
    for refusal in ["i don't", "i do not", "unknown", "not sure", "no information", "cannot", "as an ai"] {
        if lower.starts_with(refusal) || lower == *refusal {
            return String::new();
        }
    }
    line.to_string()
}

/// Attach lore to finished blocks: each block gains `lore` - a map from track
/// id to its line and (when the hub can speak) the clip that says it. The
/// beats land in `jobs` for the caller's one mint_behind call.
pub fn attach(
    blocks: &mut [Value],
    lore: &HashMap<i64, String>,
    jobs: &mut Vec<crate::voice::Beat>,
) {
    let can_speak = crate::voice::enabled();
    for block in blocks.iter_mut() {
        let ids: Vec<i64> = block
            .get("trackIds")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
            .unwrap_or_default();
        let mut entry = serde_json::Map::new();
        for id in ids {
            let Some(line) = lore.get(&id).filter(|l| !l.is_empty()) else { continue };
            let mut one = json!({ "say": line });
            if can_speak {
                let beat = crate::voice::beat(line);
                one["voice"] = json!([beat.id]);
                jobs.push(beat);
            }
            entry.insert(id.to_string(), one);
        }
        if !entry.is_empty() {
            block["lore"] = Value::Object(entry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_fenced_reply() {
        let content = "Sure. ```json\n{\"12\":\"Their 2021 debut single.\",\"31\":\"\"}\n```";
        let map = parse_lore_reply(content).unwrap();
        assert_eq!(map.get(&12).unwrap(), "Their 2021 debut single.");
        assert_eq!(map.get(&31).unwrap(), "");
        assert!(parse_lore_reply("no json here").is_none());
    }

    #[test]
    fn the_verbosity_gate_holds() {
        assert_eq!(trim_lore("  \"From their 2019 album.\"  "), "From their 2019 album.");
        assert_eq!(trim_lore(""), "");
        assert_eq!(trim_lore("I don't recognise this song."), "");
        let rambling = "word ".repeat(30);
        assert_eq!(trim_lore(&rambling), "");
    }
}
