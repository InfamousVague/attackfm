//! The trending lane: what is popping off RIGHT NOW that the listener has
//! never heard.
//!
//! The other two research lanes deliberately look away from popularity - the
//! taste walk expands from artists you already play, and the ListenBrainz
//! engine caps how famous a find may be. Both are blind to the thing a person
//! means by "what's everyone playing right now?". This lane looks straight at
//! it, from two open sources:
//!
//!   - Deezer's global chart: today's most-streamed tracks, each arriving with
//!     an ext id, cover, preview clip and importable link - already in the
//!     pool's own currency.
//!   - ListenBrainz fresh releases: records out in the last two weeks, ranked
//!     by how many real scrobbles they are suddenly getting. New AND moving,
//!     which is the definition of popping off - resolved to Deezer tracks
//!     through the same catalogue the rest of discovery uses.
//!
//! What keeps this from being a chart mirror: candidates land in the same pool
//! as everything else and are MEASURED like everything else - preview tempo,
//! lyric embedding - then scored by taste and mood. The chart decides what is
//! considered; the listener's own model decides what surfaces. A hit far from
//! your taste sinks like anything else far from your taste.
//!
//! Fetches are server-wide (the chart is the chart) and fanned per listener
//! with per-listener dedupe against what they own and already have pooled.

use crate::AppState;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// The chart moves daily; asking more often than twice a day is noise.
const FETCH_EVERY_MS: i64 = 12 * 60 * 60 * 1000;
/// How much of the chart to consider. Deep enough to survive heavy dedupe on
/// a listener who already owns the hits. 100 is Deezer's page limit.
const CHART_TAKE: usize = 100;
/// Fresh releases considered per sweep, after sorting by listen count.
const FRESH_TAKE: usize = 40;
/// Politeness between resolve calls, same as the taste walk's.
const GAP: Duration = Duration::from_millis(700);
/// Per-listener ceilings per sweep, so one sweep cannot flood a pool the
/// scoring then has to dig the taste walk's finds back out of.
const CHART_PER_USER: usize = 50;
const FRESH_PER_USER: usize = 15;
/// How many of THIS lane's rows a listener's pool keeps stocked. The old
/// ceiling was pool-TOTAL (target + reserve), and a heavy dater's pool sits
/// far above the target permanently - so the chart lane was silently barred
/// from adding anything and their trending shelf ran down to scraps while
/// "more top hits" was the standing request. The lane now counts its own
/// rows: bounded exactly as before, but never starved by the rest of the
/// pool's politics.
const TREND_KEEP: usize = 50;
const FRESH_KEEP: usize = 20;

fn meta_key() -> &'static str {
    "trending.fetched_at"
}

/// One candidate as the pool takes it.
struct Found {
    ext_id: String,
    title: String,
    artist: String,
    cover: String,
    url: String,
    preview: String,
    /// The lane's own standing, 0-1: chart position or fresh listen share.
    rank: f64,
    lane: &'static str,
}

/// The server-wide sweep: fetch once, fan to every active listener.
pub async fn cycle(state: &Arc<AppState>) {
    let now = crate::db::now_ms();
    let last = state
        .db
        .meta_get(meta_key())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if now - last < FETCH_EVERY_MS {
        return;
    }

    let mut found = chart_tracks().await;
    found.extend(fresh_releases().await);
    if found.is_empty() {
        // The clock is NOT stamped: a network that was down for a minute must
        // not silence the lane for twelve hours. The next cycle tries again,
        // and the fetchers' own politeness bounds the retry cost.
        return;
    }
    let _ = state.db.meta_set(meta_key(), &now.to_string());

    for user in crate::collector::daters(state) {
        fan_to(state, user, &found);
    }
}

/// Give one listener the sweep's findings, minus what they own, have pooled,
/// or have already judged in Music Date.
fn fan_to(state: &Arc<AppState>, user: i64, found: &[Found]) {
    /*
     * The same pool ceiling the taste walk honours. Without it this lane
     * filled the pool past POOL_TARGET, and since harvest() refuses to run at
     * the target and nothing prunes discoveries by age, the taste walk would
     * have been gated off for good - the trending lane quietly starving the
     * lane that actually knows the listener.
     */
    /*
     * The ceiling is the taste walk's target PLUS a reserve, not the target
     * itself. The first version used the bare target and starved the exact
     * listener this lane exists for: an established pool sits at or above the
     * target permanently (harvest stops there, and the pruner keeps it near
     * POOL_KEEP), so "room below the target" was zero forever. The reserve is
     * this lane's own space above the walk's line; the pruner bounds the total.
     */
    let owned = crate::discovery::owned_keys(state);
    let lanes = state.db.discovery_lanes(user);
    let stocked = |name: &str| lanes.values().filter(|(lane, _)| lane == name).count();
    let mut chart_room = TREND_KEEP.saturating_sub(stocked("trending"));
    let mut fresh_room = FRESH_KEEP.saturating_sub(stocked("fresh"));
    if chart_room == 0 && fresh_room == 0 {
        return;
    }
    // Rows the OTHER lanes already pooled. add_discovery is an upsert whose
    // conflict arm overwrites seed and popularity - fanning over a taste-walk
    // find would blank the "because you play X" it was harvested for and
    // replace its fame number with a chart rank. A candidate two lanes found
    // stays the first lane's.
    let pooled = state.db.discovery_ext_ids(user);
    let mut chart_added = 0usize;
    let mut fresh_added = 0usize;
    for f in found {
        if chart_room == 0 && fresh_room == 0 {
            break;
        }
        let cap = if f.lane == "trending" { CHART_PER_USER } else { FRESH_PER_USER };
        let (count, room) = if f.lane == "trending" {
            (&mut chart_added, &mut chart_room)
        } else {
            (&mut fresh_added, &mut fresh_room)
        };
        if *count >= cap || *room == 0 {
            continue;
        }
        if owned.contains(&crate::discovery::key_of(&f.artist, &f.title)) {
            continue;
        }
        if lanes.contains_key(&f.ext_id) || pooled.contains(&f.ext_id) {
            continue;
        }
        /*
         * seed stays EMPTY for this lane. Everywhere else seed is "the artist
         * of yours this hangs off", which drives both the client's "because
         * you play X" line and the tag stand-in in scoring. A chart candidate
         * hangs off nothing of yours - saying so is the honest answer, the
         * client already renders nothing for an empty seed, and scoring
         * renormalises over the terms it can answer.
         */
        if state
            .db
            .add_discovery(user, &f.ext_id, &f.title, &f.artist, &f.cover, &f.url, &f.preview, "", f.rank)
            .is_ok()
        {
            let _ = state.db.tag_discovery_lane(user, &f.ext_id, f.lane, f.rank);
            *count += 1;
            *room -= 1;
        }
    }
}

/// Today's chart as (artist, title) pairs in chart order - what the Charts
/// vibe matches the library and the landed auditions against.
pub(crate) async fn chart_pairs() -> Vec<(String, String)> {
    chart_tracks().await.into_iter().map(|f| (f.artist, f.title)).collect()
}

/// Today's global chart, straight from Deezer.
async fn chart_tracks() -> Vec<Found> {
    let c = crate::discovery::client(15);
    let Ok(resp) = c
        .get("https://api.deezer.com/chart/0/tracks")
        .query(&[("limit", CHART_TAKE.to_string())])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = resp.json::<Value>().await else { return Vec::new() };
    let Some(rows) = body.get("data").and_then(Value::as_array) else { return Vec::new() };
    let total = rows.len().max(1) as f64;
    rows.iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let id = t.get("id").and_then(Value::as_u64)?;
            Some(Found {
                ext_id: format!("deezer:track:{id}"),
                title: t.get("title").and_then(Value::as_str)?.to_string(),
                artist: t.pointer("/artist/name").and_then(Value::as_str)?.to_string(),
                cover: t
                    .pointer("/album/cover_medium")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                url: t.get("link").and_then(Value::as_str).unwrap_or("").to_string(),
                preview: t.get("preview").and_then(Value::as_str).unwrap_or("").to_string(),
                // Position IS the rank: first on the chart is 1.0.
                rank: 1.0 - (i as f64) / total,
                lane: "trending",
            })
        })
        .collect()
}

/// Records out in the last two weeks that people are suddenly playing,
/// resolved to Deezer so they carry a preview and an importable link.
async fn fresh_releases() -> Vec<Found> {
    let c = crate::discovery::client(25);
    let Ok(resp) = c
        .get("https://api.listenbrainz.org/1/explore/fresh-releases/")
        .query(&[("days", "14")])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = resp.json::<Value>().await else { return Vec::new() };
    let Some(rows) = body.pointer("/payload/releases").and_then(Value::as_array) else {
        return Vec::new();
    };

    // Sort by listen count ourselves - "fresh AND moving" is the point, and
    // the endpoint's own order is by date.
    let mut releases: Vec<(&Value, i64)> = rows
        .iter()
        .map(|r| (r, r.get("listen_count").and_then(Value::as_i64).unwrap_or(0)))
        .filter(|(_, n)| *n > 0)
        .collect();
    releases.sort_by(|a, b| b.1.cmp(&a.1));
    let top: Vec<&Value> = releases.into_iter().take(FRESH_TAKE).map(|(r, _)| r).collect();
    let max_listens = top
        .first()
        .and_then(|r| r.get("listen_count").and_then(Value::as_i64))
        .unwrap_or(1)
        .max(1) as f64;

    let mut out = Vec::new();
    for r in top {
        let Some(artist) = r.get("artist_credit_name").and_then(Value::as_str) else { continue };
        let Some(release) = r.get("release_name").and_then(Value::as_str) else { continue };
        let listens = r.get("listen_count").and_then(Value::as_i64).unwrap_or(0) as f64;
        tokio::time::sleep(GAP).await;
        if let Some(mut f) = resolve_release_track(&c, artist, release).await {
            f.rank = (listens / max_listens).clamp(0.05, 1.0);
            f.lane = "fresh";
            out.push(f);
        }
    }
    out
}

/// One playable track off a named release, via Deezer search. The first hit
/// with a preview wins; a release Deezer does not carry resolves to nothing,
/// which just means this one stays a headline instead of a candidate.
async fn resolve_release_track(c: &reqwest::Client, artist: &str, release: &str) -> Option<Found> {
    let q = format!("artist:\"{artist}\" album:\"{release}\"");
    let resp = c
        .get("https://api.deezer.com/search")
        .query(&[("q", q.as_str()), ("limit", "5")])
        .send()
        .await
        .ok()?;
    let body = resp.json::<Value>().await.ok()?;
    let rows = body.get("data").and_then(Value::as_array)?;
    /*
     * The artist must actually MATCH, folded - no falling back to whatever
     * Deezer ranked first. The taste walk learned this the hard way: its
     * artist resolver has a strict mode with no first-hit fallback because a
     * near-name (a tribute act, a remixer, a same-named nobody) resolves
     * cleanly and poisons the pool with a wrong record wearing the right
     * label. A fresh release Deezer cannot answer for by name just stays a
     * headline instead of a candidate.
     */
    let wanted = crate::discovery::artist_key_public(artist);
    let t = rows
        .iter()
        .filter(|t| {
            t.pointer("/artist/name")
                .and_then(Value::as_str)
                .is_some_and(|n| crate::discovery::artist_key_public(n) == wanted)
        })
        .find(|t| t.get("preview").and_then(Value::as_str).is_some_and(|p| !p.is_empty()))?;
    let id = t.get("id").and_then(Value::as_u64)?;
    Some(Found {
        ext_id: format!("deezer:track:{id}"),
        title: t.get("title").and_then(Value::as_str)?.to_string(),
        artist: t.pointer("/artist/name").and_then(Value::as_str)?.to_string(),
        cover: t
            .pointer("/album/cover_medium")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        url: t.get("link").and_then(Value::as_str).unwrap_or("").to_string(),
        preview: t.get("preview").and_then(Value::as_str).unwrap_or("").to_string(),
        rank: 0.0,
        lane: "fresh",
    })
}
