//! The hot set: the part of a library that is actually listened to.
//!
//! A home hub holds everything. A box on the internet does not need to, and
//! on matt.attack.fm cannot - the library outgrew the disk long ago. What a
//! server away from home is FOR is the songs you actually play, and that is a
//! far smaller set than the library and a knowable one: the listening history
//! already on the hub says exactly which songs those are.
//!
//! So this is the working set, ranked. A track is hot when it has been
//! listened to at least twice (`minPlays`), or liked - and among hot tracks,
//! the ones played through most recently and most often come first. The
//! ranking matters as much as the filter, because the destination has a disk
//! and the list has to be cut somewhere; cutting a RANKED list means the box
//! fills with the best of the set rather than an arbitrary slice of it.
//!
//! The shape returned is deliberately the same one `/api/library` returns, so
//! the mirror can copy a hot set with the code it already has (see
//! mirror::StartBody::tracks). This endpoint decides WHAT is worth carrying;
//! it copies nothing itself.
//!
//! Read-only, and answerable to a stream token as well as a session, because
//! the thing that asks is another server rather than a signed-in browser.

use crate::{AppState};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// Listened to twice. The plain reading of "songs I have actually played",
/// and low enough that a hot server fills up with real listening rather than
/// only with obsessions.
const DEFAULT_MIN_PLAYS: i64 = 2;

/// A liked song counts as hot however little it has been played: it is the one
/// signal the listener stated out loud, and a hot server that lacked the song
/// you just hearted would be obviously broken.
const LIKED_SCORE: i64 = 5_000;

/// Weights below are ordinal - what matters is the ORDER, not the units.
/// Completed listens outrank starts, because a song started ten times and
/// never finished is a song being skipped.
fn score(plays: i64, completed: i64, skipped: i64, liked: bool, last_at: i64, now: i64) -> i64 {
    let mut s = 0;
    if liked {
        s += LIKED_SCORE;
    }
    // Flattened, so one obsession cannot outrank a hundred ordinary songs -
    // but the multiply happens BEFORE the truncation to whole points, or the
    // flattening becomes a levelling: `sqrt(n) as i64 * 40` gives four plays
    // and eight plays the identical 80, and the ranking that decides what
    // fits on a small disk stops distinguishing anything.
    s += 300 + ((completed as f64).sqrt() * 120.0) as i64;
    s += ((plays as f64).sqrt() * 40.0) as i64;
    // Each abandonment argues against, and cannot drag a song below nothing.
    s -= (skipped * 30).min(s.max(0));
    // Recency, decaying over about a year, so a hot server drifts with taste
    // rather than freezing on whatever was played the month it was set up.
    let age_days = ((now - last_at).max(0)) / 86_400_000;
    s += (365 - age_days.min(365)) / 2;
    s
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `GET /api/hot` - what a hot server should be carrying, hottest first.
///
/// Parameters, all optional:
///  - `minPlays`  how many listens make a song hot (default 2)
///  - `limit`     how many tracks to return at most
///  - `maxBytes`  cut the list to fit a destination's disk
///
/// `maxBytes` is the one that makes this usable on a full box: the caller says
/// how much room it has and gets back the hottest set that fits, already
/// ordered, rather than a list it has to trim itself without knowing what
/// matters.
pub async fn hot(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // A stream token is accepted as well as a session: what asks is a server,
    // and a stream token is the standing read-only capability that outlives
    // the session that minted it (the same asymmetry mirror::StartBody
    // documents).
    let user_id = crate::stream::caller_from_either(&state, &headers, &params)?;

    let min_plays = params
        .get("minPlays")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_MIN_PLAYS)
        .clamp(1, 100);
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(20_000)
        .clamp(1, 100_000);
    let max_bytes = params.get("maxBytes").and_then(|v| v.parse::<u64>().ok());

    let now = now_ms();
    let liked: std::collections::HashSet<i64> =
        state.db.favorites(user_id).into_iter().collect();

    let mut scored: Vec<(i64, i64)> = state
        .db
        .hot_rows(user_id, min_plays)
        .into_iter()
        .map(|r| {
            (
                r.id,
                score(r.plays, r.completed, r.skipped, liked.contains(&r.id), r.last_at, now),
            )
        })
        .collect();

    // Liked songs that never met the play bar still belong - see LIKED_SCORE.
    let already: std::collections::HashSet<i64> = scored.iter().map(|(id, _)| *id).collect();
    for id in &liked {
        if !already.contains(id) {
            scored.push((*id, LIKED_SCORE));
        }
    }

    scored.sort_by(|a, b| b.1.cmp(&a.1));

    // Resolve to real rows, dropping anything deleted or unreadable, and stop
    // at whichever ceiling the caller gave.
    let mut tracks = Vec::new();
    let mut bytes: u64 = 0;
    let mut skipped_for_space = 0usize;
    for (id, _) in scored {
        if tracks.len() >= limit {
            break;
        }
        let Some(track) = state.db.track(id) else {
            continue;
        };
        let size = track.size_bytes.max(0) as u64;
        if let Some(cap) = max_bytes {
            // `continue`, not `break`: one huge file near the ceiling must not
            // stop every smaller song behind it from fitting.
            if bytes + size > cap {
                skipped_for_space += 1;
                continue;
            }
        }
        bytes += size;
        tracks.push(track);
    }

    Ok(Json(json!({
        "minPlays": min_plays,
        "tracks": tracks,
        "count": tracks.len(),
        "bytes": bytes,
        // Said plainly rather than left to be inferred: a caller that asked
        // for a budget deserves to know the set did not fit inside it.
        "skippedForSpace": skipped_for_space,
    })))
}

/// `GET /api/hot/summary` - how big the hot set is, without listing it.
///
/// What you want before pointing a server at this: how many songs qualify at
/// a given bar, and how much disk carrying them would take.
pub async fn summary(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let user_id = crate::stream::caller_from_either(&state, &headers, &params)?;
    let liked: std::collections::HashSet<i64> =
        state.db.favorites(user_id).into_iter().collect();

    // Every bar at once, because the useful question is not "how big is the
    // set at two" but "what bar makes the set fit", and answering that by
    // asking five times is silly.
    let mut out = Vec::new();
    for bar in [1_i64, 2, 3, 5, 10] {
        let rows = state.db.hot_rows(user_id, bar);
        let ids: std::collections::HashSet<i64> = rows
            .iter()
            .map(|r| r.id)
            .chain(liked.iter().copied())
            .collect();
        let mut bytes: u64 = 0;
        let mut count = 0usize;
        for id in ids {
            if let Some(t) = state.db.track(id) {
                bytes += t.size_bytes.max(0) as u64;
                count += 1;
            }
        }
        out.push(json!({ "minPlays": bar, "tracks": count, "bytes": bytes }));
    }

    Ok(Json(json!({
        "bars": out,
        "liked": liked.len(),
        "libraryTracks": state.db.track_count(),
    })))
}

#[cfg(test)]
mod hot_tests {
    use super::*;
    use crate::db::{hot_enough, HotRow};

    fn row(plays: i64, completed: i64, skipped: i64) -> HotRow {
        HotRow { id: 1, plays, completed, skipped, last_at: 0 }
    }

    /// The rule the whole feature is named for.
    #[test]
    fn listened_to_twice_means_listened_to() {
        assert!(hot_enough(&row(2, 0, 0), 2), "played twice, no log opinion");
        assert!(hot_enough(&row(0, 2, 0), 2), "finished twice");
        assert!(!hot_enough(&row(1, 0, 0), 2), "played once");
        // The case that matters: started repeatedly, finished never. The plays
        // table alone would call this hot.
        assert!(!hot_enough(&row(4, 0, 4), 2), "skipped past every time");
        // Skipped sometimes but finished twice is still a song you listen to.
        assert!(hot_enough(&row(9, 2, 7), 2), "finished twice despite skips");
    }

    /// The bug that made the ranking useless: truncating the square root
    /// before scaling gave 4 plays and 8 plays the same score, so a disk-bound
    /// list was cut arbitrarily.
    #[test]
    fn more_listening_always_ranks_higher() {
        let s = |p: i64, c: i64| score(p, c, 0, false, 0, 0);
        for n in 2..40 {
            assert!(
                s(n + 1, 0) > s(n, 0),
                "plays {n} and {} scored the same",
                n + 1
            );
        }
        for n in 1..20 {
            assert!(s(0, n + 1) > s(0, n), "completions {n} did not separate");
        }
        // A song played through outranks one merely started as often.
        assert!(s(4, 4) > s(4, 0));
    }

    #[test]
    fn abandonment_counts_against_and_never_goes_negative() {
        let played = score(6, 3, 0, false, 0, 0);
        let abandoned = score(6, 3, 5, false, 0, 0);
        assert!(abandoned < played);
        // Even absurd skip counts stay at or above zero, so a ranking never
        // sorts a real song below a missing one.
        assert!(score(2, 0, 10_000, false, 0, 0) >= 0);
    }

    #[test]
    fn a_liked_song_outranks_anything_merely_played() {
        // The heart is the one signal stated out loud; the hot server must
        // never lack a song just hearted.
        assert!(score(0, 0, 0, true, 0, 0) > score(500, 500, 0, false, 0, 0));
    }

    #[test]
    fn recent_listening_wins_a_tie() {
        let now = 400 * 86_400_000_i64;
        let fresh = score(3, 2, 0, false, now, now);
        let ancient = score(3, 2, 0, false, 0, now);
        assert!(fresh > ancient);
    }
}
