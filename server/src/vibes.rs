//! The banked sets: one finished DJ set per vibe, built where time is free.
//!
//! Live, the DJ answers in seconds, which bought speed by benching the
//! model - a taste-scored ranking with jitter and no judgement, which a
//! listener correctly reads as glorified shuffle. The judgement happens HERE
//! instead: in the background the model is unhurried, offered twice the
//! candidates, and allowed to drop what does not fit - it curates, sequences
//! and speaks, the voice mints, and the finished set sits banked. Pressing a
//! vibe serves the banked set instantly, consumes it, and banks the next one
//! behind the reply - by request, "pre-fetch each of the vibes and re-fetch
//! whenever we use them up".

use crate::AppState;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};

/// The vibes the client's chips speak, verbatim - the seed string IS the
/// contract (DjLauncher MOODS), and the empty seed is the taste press.
const VIBES: &[(&str, &str)] = &[
    ("taste", ""),
    ("chill", "something chill and unhurried"),
    ("energy", "high energy, turn it up"),
    ("latenight", "late night, low lights"),
    ("focus", "steady focus, no distractions"),
];

/// A banked set older than this is served (still better than waiting) but
/// rebuilt behind the reply - taste moves, and a week-old "fresh" is stale.
const STALE_MS: i64 = 20 * 60 * 60 * 1000;

pub fn key_for_seed(seed: &str) -> Option<&'static str> {
    VIBES.iter().find(|(_, s)| *s == seed.trim()).map(|(k, _)| *k)
}

fn seed_for_key(key: &str) -> Option<&'static str> {
    VIBES.iter().find(|(k, _)| *k == key).map(|(_, s)| *s)
}

/// Builds in flight, so a press and the curator cycle cannot stack two
/// model runs for the same (listener, vibe).
fn building() -> &'static Mutex<HashSet<String>> {
    static M: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashSet::new()))
}

fn claim(user: i64, key: &str) -> bool {
    let tag = format!("{user}:{key}");
    let Ok(mut in_flight) = building().lock() else { return false };
    if in_flight.contains(&tag) {
        return false;
    }
    in_flight.insert(tag);
    true
}

fn release(user: i64, key: &str) {
    if let Ok(mut in_flight) = building().lock() {
        in_flight.remove(&format!("{user}:{key}"));
    }
}

/// The banked set for this seed, if the seed names a vibe and one is waiting.
/// Consumes it and banks a replacement behind the reply.
pub fn take(state: &Arc<AppState>, user: i64, seed: &str) -> Option<Value> {
    let key = key_for_seed(seed)?;
    let (body, built_at, consumed_at) = state.db.dj_set_get(user, key)?;
    if consumed_at >= built_at {
        return None;
    }
    let parsed: Value = serde_json::from_str(&body).ok()?;
    // An empty banked set is a build that came up dry - fall through to live.
    if parsed.get("blocks").and_then(|b| b.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
        return None;
    }
    let _ = state.db.dj_set_consume(user, key);
    let st = state.clone();
    tokio::spawn(async move {
        rebuild(&st, user, key).await;
    });
    let _ = built_at; // freshness is folded into consumption above
    Some(parsed)
}

/// Bank one vibe for one listener. The curated path: double candidates, no
/// jitter, the model unhurried and allowed to drop - see dj::build_reply.
pub async fn rebuild(state: &Arc<AppState>, user: i64, key: &str) {
    let Some(seed) = seed_for_key(key) else { return };
    if !claim(user, key) {
        return;
    }
    let built = crate::dj::build_reply(state, user, seed, 15, true).await;
    if let Ok(body) = built {
        let has_blocks = body
            .get("blocks")
            .and_then(|b| b.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if has_blocks {
            let _ = state.db.dj_set_put(user, key, &body.to_string());
        }
    }
    release(user, key);
}

/// The seed-addressed door the live handler banks through.
pub async fn rebuild_for_seed(state: &Arc<AppState>, user: i64, seed: &str) {
    if let Some(key) = key_for_seed(seed) {
        rebuild(state, user, key).await;
    }
}

/// The curator's pass: make sure every vibe this listener could press has a
/// fresh set waiting. Consumed and stale ones rebuild; the rest cost one
/// SELECT each.
pub async fn cycle(state: &Arc<AppState>, user: i64) {
    let now = crate::db::now_ms();
    for (key, _) in VIBES {
        let wants_build = match state.db.dj_set_get(user, key) {
            None => true,
            Some((_, built_at, consumed_at)) => consumed_at >= built_at || now - built_at > STALE_MS,
        };
        if wants_build {
            rebuild(state, user, key).await;
        }
    }
}
