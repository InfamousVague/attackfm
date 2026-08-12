//! The rewind: what this listener had on repeat around this date, in each
//! past year that has anything to say. The plays table already remembers
//! every timestamped play, so a "this week in 2024" is one bounded GROUP BY
//! per year - no new bookkeeping, just a different question to the same
//! ledger.
//!
//! Windows are anniversary-centred (±7 days around now minus k years) rather
//! than ISO-week-aligned: the page says "around this date", the maths stays
//! timezone-free, and a listener a few hours east or west of the server
//! cannot fall out of their own week.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::json;

use crate::auth;
use crate::AppState;

/// A tropical year in milliseconds - the 0.25 keeps anniversaries from
/// drifting a day every four years of rewinding.
const YEAR_MS: i64 = (365.25 * 24.0 * 60.0 * 60.0 * 1000.0) as i64;
const WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// How far back the page looks. Beyond this the plays thin out and the
/// answer stops being a memory and starts being an outlier.
const YEARS_BACK: i64 = 8;
/// A year needs at least this many distinct tracks to make a shelf.
const MIN_TRACKS: usize = 3;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `GET /api/rewind` - per past year: the tracks this user played around
/// this date, most-played first. Track ids resolve client-side against the
/// synced library; a track since deleted never appears (the query joins
/// through live tracks).
pub async fn rewind(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let now = now_ms();
    let mut years = Vec::new();
    for k in 1..=YEARS_BACK {
        let centre = now - k * YEAR_MS;
        if centre < 0 {
            break;
        }
        let plays = state
            .db
            .plays_between(caller.id, centre - WINDOW_MS, centre + WINDOW_MS, 30);
        if plays.len() < MIN_TRACKS {
            continue;
        }
        years.push(json!({
            "yearsAgo": k,
            "tracks": plays
                .iter()
                .map(|(id, n)| json!({ "id": id, "plays": n }))
                .collect::<Vec<_>>(),
        }));
    }
    Ok(Json(json!({ "years": years })))
}
