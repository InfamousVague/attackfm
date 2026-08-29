//! The listen log and the stats read off it: what one listener actually
//! played, how long, and what that adds up to.
//!
//! `/api/plays` (home.rs) stays the home feed's cheap signal - one row per
//! qualifying play, joined live against `tracks`. This log is the durable
//! account: every playback the client reports, with the track's tags
//! snapshotted into the row at insert time and no foreign key back to
//! `tracks`, so the numbers a listener earned survive retagging, quota
//! eviction, and re-import under a new id. The client batches events and
//! posts them when it can; nothing here assumes they arrive promptly, in
//! order, or exactly once per play.
//!
//! The summary endpoint buckets hours and days in the CLIENT's timezone,
//! passed as `tzMin` - "you listen at 9pm" is a fact about the listener's
//! wall clock, and the server has no idea where that wall is.

use crate::auth;
use crate::db::Db;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The most events one batch may carry. A client syncing a week offline fits
/// comfortably; anything past this is a loop, not a listener.
const MAX_BATCH: usize = 200;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- recording -------------------------------------------------------------

#[derive(Deserialize)]
pub struct RecordBody {
    pub events: Vec<IncomingListen>,
}

/// One playback as the client reports it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingListen {
    pub track_id: i64,
    /// Epoch ms when playback started - the client's clock, trusted as data.
    pub started_at: i64,
    pub ms_listened: i64,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub completed: bool,
    #[serde(default)]
    pub skipped: bool,
    /// Where playback came from ("album", "playlist:4", ...), opaque here.
    #[serde(default)]
    pub context: String,
}

/// `POST /api/listens` - a batch of listen events for the calling listener.
/// Replies with how many were accepted; events for tracks the server has
/// never heard of are dropped, not errors - see ingest below.
pub async fn record(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RecordBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if body.events.len() > MAX_BATCH {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("at most {MAX_BATCH} events per batch"),
        ));
    }
    let accepted = ingest(&state.db, caller.id, &body.events);
    Ok(Json(json!({ "ok": true, "accepted": accepted })))
}

/// Files a batch of events under one user, returning how many landed.
///
/// Standalone rather than inlined in the handler on purpose: this is the one
/// place a listen becomes durable, so anything that reacts to listening (the
/// curator's promotion pass, most immediately) hooks in here or right after
/// it, with the events already snapshotted and clamped.
pub(crate) fn ingest(db: &Db, user_id: i64, events: &[IncomingListen]) -> usize {
    let mut accepted = 0;
    for e in events {
        // Snapshot the tags now - the whole point of the table is that the
        // stats stay right after the track is retagged or evicted. A track id
        // the server has never indexed cannot be snapshotted, so its event is
        // dropped rather than filed half-blank.
        let Some(tags) = db.track_tags(e.track_id) else {
            continue;
        };
        // A day is the ceiling any honest event fits under; anything longer
        // is a client clock bug arriving dressed as data.
        let ms = e.ms_listened.clamp(0, DAY_MS);
        if db
            .insert_listen(
                user_id,
                e.track_id,
                &tags,
                e.started_at,
                ms,
                e.duration_ms.filter(|d| *d > 0),
                e.completed,
                e.skipped,
                e.context.trim(),
            )
            .is_ok()
        {
            accepted += 1;
            // Adoption: playing a collector download all the way through moves
            // it off the audition shelf and into the library proper - whoever
            // did the listening, since wanted is wanted. The rev bump inside
            // carries the change to every synced client.
            if e.completed {
                db.promote_curator_track(e.track_id);
            }
        }
    }
    accepted
}

// --- the summary ------------------------------------------------------------

#[derive(Deserialize)]
pub struct SummaryQuery {
    #[serde(default)]
    pub range: Option<String>,
    /// The client's getTimezoneOffset(): minutes to subtract from UTC to
    /// reach the listener's wall clock.
    #[serde(rename = "tzMin", default)]
    pub tz_min: Option<i64>,
}

/// Minutes, rounded, from a millisecond sum - every "minutes" in the reply.
fn minutes(ms: i64) -> i64 {
    (ms as f64 / 60_000.0).round() as i64
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Gregorian date for a count of days since 1970-01-01 (the standard
/// civil-from-days arithmetic), so the day labels need no date crate.
fn day_label(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `GET /api/stats/summary?range=week|month|year|all&tzMin=` - one listener's
/// listening, added up, entirely from the listen log.
pub async fn summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<SummaryQuery>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let range = q.range.as_deref().unwrap_or("week");
    let tz_min = q.tz_min.unwrap_or(0);
    let payload = summary_payload(&state, caller.id, range, tz_min)
        .ok_or((StatusCode::BAD_REQUEST, "range must be week, month, year or all".into()))?;
    Ok(Json(payload))
}

/// The whole summary, buildable for ANY member - the caller-scoped handler
/// above and the friend-profile door (profile.rs) both serve exactly this,
/// so a friend's stats page and your own are the same shape by construction.
/// None means the range string was not one of the four.
pub fn summary_payload(
    state: &Arc<AppState>,
    user: i64,
    range: &str,
    tz_min: i64,
) -> Option<serde_json::Value> {
    let now = now_ms();
    let since = match range {
        "week" => now - 7 * DAY_MS,
        "month" => now - 30 * DAY_MS,
        "year" => now - 365 * DAY_MS,
        "all" => 0,
        _ => return None,
    };
    // Clamped to the offsets that exist on Earth; the sign convention makes
    // UTC+14 arrive as -840.
    let tz_min = tz_min.clamp(-14 * 60, 14 * 60);
    let today = (now - tz_min * 60_000).div_euclid(DAY_MS);

    let totals = state.db.listen_totals(user, since);

    let top_artists: Vec<_> = state
        .db
        .top_listen_artists(user, since, 10)
        .into_iter()
        .map(|(artist, plays, ms, cover)| {
            json!({ "artist": artist, "plays": plays, "minutes": minutes(ms), "coverTrackId": cover })
        })
        .collect();

    let top_tracks: Vec<_> = state
        .db
        .top_listen_tracks(user, since, 10)
        .into_iter()
        .map(|(id, title, artist, plays, ms)| {
            json!({ "trackId": id, "title": title, "artist": artist, "plays": plays, "minutes": minutes(ms) })
        })
        .collect();

    let top_albums: Vec<_> = state
        .db
        .top_listen_albums(user, since, 10)
        .into_iter()
        .map(|(album, artist, plays, ms)| {
            json!({ "album": album, "artist": artist, "plays": plays, "minutes": minutes(ms) })
        })
        .collect();

    // Genre tags come off files comma-joined ("Indie, Rock"); split them so
    // each half counts whole, merging spellings that differ only by case and
    // keeping the first spelling seen as the display name.
    let mut genres: HashMap<String, (String, i64)> = HashMap::new();
    for (tag, ms) in state.db.listen_genre_ms(user, since) {
        for part in tag.split(',') {
            let name = part.trim();
            if name.is_empty() {
                continue;
            }
            let slot = genres
                .entry(name.to_lowercase())
                .or_insert_with(|| (name.to_string(), 0));
            slot.1 += ms;
        }
    }
    let mut top_genres: Vec<(String, i64)> = genres.into_values().collect();
    top_genres.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top_genres.truncate(8);
    let top_genres: Vec<_> = top_genres
        .into_iter()
        .map(|(genre, ms)| json!({ "genre": genre, "minutes": minutes(ms) }))
        .collect();

    let clock: Vec<i64> = state
        .db
        .listen_clock(user, since, tz_min)
        .iter()
        .map(|ms| minutes(*ms))
        .collect();

    // A dense day series, zero-filled, oldest first - a chart wants every
    // day on the axis, not just the ones with listening on them. "all"
    // begins where the history does, capped at a year of bars.
    let day_ms = state.db.listen_day_ms(user, since, tz_min);
    let start_day = if since > 0 {
        (since - tz_min * 60_000).div_euclid(DAY_MS)
    } else {
        day_ms
            .first()
            .map(|(d, _)| *d)
            .unwrap_or(today)
            .max(today - 365)
    };
    let filled: HashMap<i64, i64> = day_ms.into_iter().collect();
    let by_day: Vec<_> = (start_day..=today)
        .map(|d| json!({ "day": day_label(d), "minutes": minutes(filled.get(&d).copied().unwrap_or(0)) }))
        .collect();

    // The streak ends today - or yesterday, so it does not read as broken
    // before the evening's listening has happened yet. Anchored on whether
    // TODAY has a listen rather than on the newest row, because a client
    // clock running minutes ahead can file a listen under tomorrow, and that
    // must not cost the whole streak.
    let streak_days = {
        let days = state.db.completed_listen_days(user, tz_min);
        let mut streak = 0i64;
        let mut expect = if days.contains(&today) { today } else { today - 1 };
        for &d in &days {
            if d == expect {
                streak += 1;
                expect -= 1;
            } else if d < expect {
                break;
            }
        }
        streak
    };

    let rate = |n: i64| {
        if totals.events > 0 {
            round3(n as f64 / totals.events as f64)
        } else {
            0.0
        }
    };

    // Under ten measured tracks the average is an anecdote, not a sound.
    let (measured, energy, brightness, bpm) = state.db.listen_sound(user, since);
    let sound = if measured >= 10 {
        json!({
            "bpm": bpm.map(|b| (b * 10.0).round() / 10.0),
            "energy": round3(energy),
            "brightness": round3(brightness),
        })
    } else {
        serde_json::Value::Null
    };

    Some(json!({
        "range": range,
        "since": since,
        "minutes": minutes(totals.ms),
        "plays": totals.plays,
        "uniqueTracks": totals.unique_tracks,
        "uniqueArtists": totals.unique_artists,
        "topArtists": top_artists,
        "topTracks": top_tracks,
        "topAlbums": top_albums,
        "topGenres": top_genres,
        "clock": clock,
        "byDay": by_day,
        "streakDays": streak_days,
        "skipRate": rate(totals.skipped),
        "completionRate": rate(totals.completed),
        "firstListens": state.db.first_listen_count(user, since),
        "sound": sound,
    }))
}
