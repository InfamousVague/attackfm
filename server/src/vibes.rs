//! The banked sets: one finished DJ set per vibe, built where time is free.
//!
//! PARKED (2026-08-31): take()/rebuild()/cycle() no longer have callers on
//! the serving path - by explicit request the DJ builds every set live,
//! because banked sets (deliberately jitter-free) dealt the same songs on
//! every press. build_charts_reply remains LIVE and used. Do not delete;
//! see attackfm-parked-not-dead.
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
    // The charts, by request: what everyone is playing, from what is ALREADY
    // on this box - the songs you own that are charting, and the chart hits
    // the collector has quietly pre-downloaded as auditions.
    ("charts", "the charts right now"),
    // New music, by request: the dates waiting to meet you and the library's
    // own future - what just arrived that you have not heard. No taste maths;
    // newness IS the curation, exactly as the chart is for charts.
    ("newmusic", "the new music waiting for me"),
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

/// How long a chart or new-music deal sits out of the next press. A day: the
/// chart itself refetches every twelve hours, so a hit is dealt at most once
/// per chart day, and the graduated hold (dj::dealt_hold) releases the tail
/// when a small match would otherwise run dry.
const DEALT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// The new-music candidates, in seat order: this listener's waiting auditions
/// (the collector's finds, newest first), then the library's arrivals they
/// have not met (newest first) - with seats kept for arrivals, so an old
/// audition backlog cannot fill the whole set. "Met" is decided in SQL
/// (db::new_mix_candidates): a play, any listen event, a heart, a date verdict.
///
/// ONE selection for both faces of new music, so they cannot disagree: the
/// playlist (`draw = false`, deterministic - a rewrite of an identical list
/// is a no-op) and the DJ's chip (`draw = true` - a rank-weighted lottery
/// within each inventory, newest likeliest, plus the dealt hold, so two
/// presses are two sets).
pub fn new_music_ids(db: &crate::db::Db, user: i64, cap: usize, draw: bool) -> Vec<i64> {
    let now = crate::db::now_ms();
    let (auditions, arrivals) =
        db.new_mix_candidates(user, now - 60 * 86_400_000, now - 21 * 86_400_000);
    let held: HashSet<i64> = if draw {
        let pool = auditions.len() + arrivals.len();
        crate::dj::dealt_hold(db, user, DEALT_WINDOW_MS, cap, pool)
    } else {
        HashSet::new()
    };
    // Newest first is the ranking; the draw keeps newest likeliest but shuffles.
    let pick = |ids: Vec<i64>| -> Vec<i64> {
        let ids: Vec<i64> = ids.into_iter().filter(|id| !held.contains(id)).collect();
        if !draw {
            return ids;
        }
        let ranked: Vec<(f32, i64)> =
            ids.into_iter().enumerate().map(|(i, id)| (-(i as f32), id)).collect();
        crate::dj::weighted_draw(ranked, 36).into_iter().map(|(_, id)| id).collect()
    };
    let auditions = pick(auditions);
    let arrivals = pick(arrivals);
    // Seats: auditions lead, but arrivals keep at least a quarter of the set.
    let arrival_floor = (cap / 4).min(arrivals.len());
    let audition_seats = cap.saturating_sub(arrival_floor);
    let mut ids: Vec<i64> = auditions.iter().copied().take(audition_seats).collect();
    for id in &arrivals {
        if ids.len() >= cap {
            break;
        }
        ids.push(*id);
    }
    // Backfill from the auditions the seat floor held back.
    for id in auditions.iter().skip(audition_seats) {
        if ids.len() >= cap {
            break;
        }
        ids.push(*id);
    }
    ids.dedup();
    ids
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
    let built = if key == "charts" {
        Ok(build_charts_reply(state, user, true).await)
    } else if key == "newmusic" {
        Ok(build_new_music_reply(state, user, true).await)
    } else {
        let ask = crate::dj::Ask { seed, want: 15, curate: true, hour: None, filter: None, preview: false };
        crate::dj::build_reply(state, user, &ask).await
    };
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

/// The Charts set: today's chart matched against what this box already has.
/// No model, no taste maths - the chart itself is the curation, and the set
/// is exactly the hits that are HERE: library rows first-class, and the
/// collector's pre-downloaded chart auditions right beside them (the one
/// place the quarantine does get to play, because "hear what is charting"
/// is precisely what those files were fetched for). Chart order, capped.
/// `curate` is the banked path: it owns background time, so it WAITS for the
/// lore pass before freezing the body. The live door only reads - the bank
/// rebuild the handler spawns is where charts lore gets written.
pub async fn build_charts_reply(state: &Arc<AppState>, user: i64, curate: bool) -> Value {
    let chart = crate::trending::chart_pairs().await;
    let seed = seed_for_key("charts").unwrap_or_default();
    if chart.is_empty() {
        return serde_json::json!({ "ai": false, "vibe": seed, "blocks": [] });
    }
    let mut by_key: std::collections::HashMap<String, (i64, String)> =
        std::collections::HashMap::new();
    for (id, artist, title, audition_owner) in state.db.track_identities() {
        // A row is playable for THIS listener when it is real library, or
        // their own audition. Someone else's audition stays theirs.
        if audition_owner != 0 && audition_owner != user {
            continue;
        }
        by_key.entry(crate::discovery::key_of(&artist, &title)).or_insert((id, artist));
    }
    // Every chart hit on this box, in chart order, then a rank-weighted draw
    // over that head with the dealt hold - so a press deals a DIFFERENT
    // eighteen from the same chart rather than the same top eighteen, and the
    // set you just got sits out of the next one. Two chart spellings of one
    // song fold to one key and hand back the same row - it takes one seat.
    let artist_of: std::collections::HashMap<i64, String> =
        by_key.values().map(|(id, a)| (*id, a.clone())).collect();
    let mut matched: Vec<(f32, i64)> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for (i, (artist, title)) in chart.iter().enumerate() {
        if let Some((id, _)) = by_key.get(&crate::discovery::key_of(artist, title)) {
            if seen.insert(*id) {
                matched.push((-(i as f32), *id));
            }
        }
    }
    let held = crate::dj::dealt_hold(&state.db, user, DEALT_WINDOW_MS, 18, matched.len());
    let drawn = crate::dj::weighted_draw(
        matched.into_iter().filter(|(_, id)| !held.contains(id)).collect(),
        54,
    );
    let mut ids: Vec<i64> = Vec::new();
    let mut artists: Vec<String> = Vec::new();
    let mut per_artist: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (_, id) in drawn {
        let Some(real_artist) = artist_of.get(&id) else { continue };
        let cap = per_artist.entry(real_artist.to_lowercase()).or_insert(0);
        if *cap >= 2 {
            continue;
        }
        *cap += 1;
        ids.push(id);
        artists.push(real_artist.clone());
        if ids.len() >= 18 {
            break;
        }
    }
    // This door deals too now, so the ledger sees it - that is what keeps
    // the next press different. Its own slot, so the taste set's exploration
    // counters (explore_artist_stats) do not count a chart deal as an offer.
    state.db.record_dj_impressions(
        user,
        &ids.iter().enumerate().map(|(i, id)| (*id, "charts", i as i64)).collect::<Vec<_>>(),
    );
    // Chart hits are exactly the songs the model DOES know. The banked
    // build waits for the gaps to fill before the body freezes; the live
    // door serves what is on file and leaves the writing to the rebuild
    // already spawned behind it.
    if curate {
        crate::lore::ensure(state, &ids).await;
    } else {
        // The live chart door commissions its own lore now that no bank does.
        let st = state.clone();
        let ids = ids.clone();
        tokio::spawn(async move {
            crate::lore::ensure(&st, &ids).await;
        });
    }
    let lore = crate::lore::known(state, &ids);
    let mut lore_jobs: Vec<crate::voice::Beat> = Vec::new();

    let mut blocks: Vec<Value> = Vec::new();
    let chunk_count = ids.chunks(3).count();
    for (i, chunk) in ids.chunks(3).enumerate() {
        let lead = artists.get(i * 3).cloned().unwrap_or_default();
        let seat = if i == 0 {
            crate::voice::Seat::Opener
        } else if i + 1 == chunk_count && chunk_count > 1 {
            crate::voice::Seat::Closer
        } else {
            crate::voice::Seat::Turn
        };
        let line = crate::voice::line_for(seat, &lead);
        let say = if lead.trim().is_empty() { line.clone() } else { format!("{line} {lead}.") };
        let mut block = serde_json::json!({ "say": say, "trackIds": chunk });
        let beats = crate::voice::block_beats(seat, &lead);
        if !beats.is_empty() {
            block["voice"] =
                serde_json::json!(beats.iter().map(|b| b.id.clone()).collect::<Vec<_>>());
            crate::voice::mint_behind(state, beats);
        }
        blocks.push(block);
    }
    crate::lore::attach(&mut blocks, &lore, &mut lore_jobs, &crate::lore::facts_for(state, &ids));
    if !lore_jobs.is_empty() {
        crate::voice::mint_behind(state, lore_jobs);
    }
    serde_json::json!({ "ai": false, "vibe": seed, "blocks": blocks })
}

/// The New Music set: this listener's waiting music dates, and the library's
/// arrivals they have not met - woven, dates leading.
///
/// The same shape and manners as the charts set: no model and no taste
/// scoring, because for a set whose whole promise is "you have not heard
/// this", newness is the curation and a taste rank would just bury the
/// newest under last month's listening. Auditions lead two-to-one - they
/// were fetched FOR this listener, and playing one through is the adoption
/// gesture - with plain arrivals woven between so the set still breathes.
pub async fn build_new_music_reply(state: &Arc<AppState>, user: i64, curate: bool) -> Value {
    let seed = seed_for_key("newmusic").unwrap_or_default();
    // One selection shared with the New Music playlist (chartlists), drawn:
    // met songs are excluded in SQL, auditions lead with seats kept for
    // arrivals, newest is likeliest, and the dealt hold keeps two presses
    // two sets. The chip deals, so the ledger records it.
    let ids = new_music_ids(&state.db, user, 18, true);
    state.db.record_dj_impressions(
        user,
        &ids.iter().enumerate().map(|(i, id)| (*id, "newmusic", i as i64)).collect::<Vec<_>>(),
    );

    if ids.is_empty() {
        return serde_json::json!({ "ai": false, "vibe": seed, "blocks": [] });
    }

    // Artists for the voice's name-drops, one lookup per seat.
    let artists: Vec<String> = ids
        .iter()
        .map(|id| state.db.track(*id).map(|t| t.artist).unwrap_or_default())
        .collect();

    if curate {
        crate::lore::ensure(state, &ids).await;
    } else {
        let st = state.clone();
        let ids2 = ids.clone();
        tokio::spawn(async move {
            crate::lore::ensure(&st, &ids2).await;
        });
    }
    let lore = crate::lore::known(state, &ids);
    let mut lore_jobs: Vec<crate::voice::Beat> = Vec::new();

    let mut blocks: Vec<Value> = Vec::new();
    let chunk_count = ids.chunks(3).count();
    for (i, chunk) in ids.chunks(3).enumerate() {
        let lead = artists.get(i * 3).cloned().unwrap_or_default();
        let seat = if i == 0 {
            crate::voice::Seat::Opener
        } else if i + 1 == chunk_count && chunk_count > 1 {
            crate::voice::Seat::Closer
        } else {
            crate::voice::Seat::Turn
        };
        let line = crate::voice::line_for(seat, &lead);
        let say = if lead.trim().is_empty() { line.clone() } else { format!("{line} {lead}.") };
        let mut block = serde_json::json!({ "say": say, "trackIds": chunk });
        let beats = crate::voice::block_beats(seat, &lead);
        if !beats.is_empty() {
            block["voice"] =
                serde_json::json!(beats.iter().map(|b| b.id.clone()).collect::<Vec<_>>());
            crate::voice::mint_behind(state, beats);
        }
        blocks.push(block);
    }
    crate::lore::attach(&mut blocks, &lore, &mut lore_jobs, &crate::lore::facts_for(state, &ids));
    if !lore_jobs.is_empty() {
        crate::voice::mint_behind(state, lore_jobs);
    }
    serde_json::json!({ "ai": false, "vibe": seed, "blocks": blocks })
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
            // ONE build per pass: five model runs back to back starved the
            // enrichment and measurement loops that share the same ollama,
            // and those feed Music Date. The bank fills over a few passes;
            // a press still triggers its own immediate rebuild.
            return;
        }
    }
}
