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
/// How many of Deezer's editorial selection to pull per sweep - the supply the
/// fresh lane (and the date's "New music" deck) draws from.
const FRESH_TAKE: usize = 40;
/// Politeness between resolve calls, same as the taste walk's.
const GAP: Duration = Duration::from_millis(700);
/// Per-listener ceilings per sweep, so one sweep cannot flood a pool the
/// scoring then has to dig the taste walk's finds back out of.
const CHART_PER_USER: usize = 50;
// Widened with the date's "New music only" deck: a fresh-only deal needs a pool
// deeper than a garnish seat did, so the fresh lane both fills faster per sweep
// and keeps more (FRESH_KEEP below).
const FRESH_PER_USER: usize = 30;
/// How many of THIS lane's rows a listener's pool keeps stocked. The old
/// ceiling was pool-TOTAL (target + reserve), and a heavy dater's pool sits
/// far above the target permanently - so the chart lane was silently barred
/// from adding anything and their trending shelf ran down to scraps while
/// "more top hits" was the standing request. The lane now counts its own
/// rows: bounded exactly as before, but never starved by the rest of the
/// pool's politics.
///
/// Twenty-five each, down from fifty and sixty. These two lanes hang off
/// nothing of the listener's - a chart row has no anchor - and at 110 of a
/// 200-row pool they were more than half of it, which is the "too random"
/// the listener named. The connected lanes (the taste walk, the small-artist
/// engine) now get the room.
const TREND_KEEP: usize = 25;
const FRESH_KEEP: usize = 25;

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
    /// When it came out, when the catalogue said - the editorial selection
    /// carries the album's `release_date`; the chart does not.
    released: Option<String>,
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
    // The chart as it stands, so "rising" can be a comparison next time.
    // Position is the rank: first on the chart is 1.
    let chart: Vec<(String, String, f64)> = found
        .iter()
        .enumerate()
        .map(|(i, f)| (f.ext_id.clone(), crate::discovery::artist_key_public(&f.artist), (i + 1) as f64))
        .collect();
    if !chart.is_empty() {
        state.db.snapshot_chart(now, &chart);
    }
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
        // Only a row the pool TOOK gets its lane tag and its date. A song the
        // listener already judged is refused at the door and must not leave
        // a lane row behind - that fossil would block nothing useful and
        // count against the lane's room.
        if let Ok(true) = state
            .db
            .add_discovery(user, &f.ext_id, &f.title, &f.artist, &f.cover, &f.url, &f.preview, "", f.rank)
        {
            let _ = state.db.tag_discovery_lane(user, &f.ext_id, f.lane, f.rank);
            if let Some(released) = &f.released {
                state.db.set_discovery_released(user, &f.ext_id, released);
            }
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
                released: t.get("release_date").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect()
}

/// The catalogue's own "new and worth it": Deezer's editorial selection -
/// the albums their editors are pushing right now - resolved to one playable
/// track each. This replaced the ListenBrainz fresh-releases feed, which
/// stopped populating listen counts (verified 2026-08-31: 3,292 releases,
/// every listen_count zero) and so could never again say "fresh AND moving".
async fn fresh_releases() -> Vec<Found> {
    let c = crate::discovery::client(25);
    let Ok(resp) = c
        .get("https://api.deezer.com/editorial/0/selection")
        .query(&[("limit", FRESH_TAKE.to_string())])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = resp.json::<Value>().await else { return Vec::new() };
    let Some(albums) = body.get("data").and_then(Value::as_array) else { return Vec::new() };
    let total = albums.len().max(1) as f64;

    let mut out = Vec::new();
    for (i, album) in albums.iter().enumerate() {
        let Some(album_id) = album.get("id").and_then(Value::as_u64) else { continue };
        let cover = album
            .pointer("/cover_medium")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let released = album.get("release_date").and_then(Value::as_str).map(str::to_string);
        tokio::time::sleep(GAP).await;
        let Ok(resp) = c
            .get(format!("https://api.deezer.com/album/{album_id}/tracks"))
            .query(&[("limit", "3")])
            .send()
            .await
        else {
            continue;
        };
        let Ok(tracks) = resp.json::<Value>().await else { continue };
        let Some(rows) = tracks.get("data").and_then(Value::as_array) else { continue };
        let Some(t) = rows
            .iter()
            .find(|t| t.get("preview").and_then(Value::as_str).is_some_and(|p| !p.is_empty()))
        else {
            continue;
        };
        let Some(id) = t.get("id").and_then(Value::as_u64) else { continue };
        let (Some(title), Some(artist)) = (
            t.get("title").and_then(Value::as_str),
            t.pointer("/artist/name").and_then(Value::as_str),
        ) else {
            continue;
        };
        out.push(Found {
            ext_id: format!("deezer:track:{id}"),
            title: title.to_string(),
            artist: artist.to_string(),
            cover,
            url: t.get("link").and_then(Value::as_str).unwrap_or("").to_string(),
            preview: t.get("preview").and_then(Value::as_str).unwrap_or("").to_string(),
            // Editorial order IS the rank: the lead pick is 1.0.
            rank: 1.0 - (i as f64) / total,
            lane: "fresh",
            released,
        });
    }
    out
}



// ---------------------------------------------------------------------------
// Three shelves, each labelled, never blended.
//
// The listener wanted trending three ways and wanted to be able to tell them
// apart: the global charts filtered through their taste, what is rising in
// their own scene, and what their friends on this hub have been finishing.
// Three arrays, three labels the client renders verbatim, and an empty one
// is absent rather than folded into its neighbour - a shelf that quietly
// merges "rising in your scene" into "charts" is how "too random" starts.

/// Below this a chart row is famous, not for them. The global shelf ranks by
/// score and never by popularity; the floor is what keeps a slow week from
/// filling the shelf with whatever the chart had.
const GLOBAL_FLOOR: f64 = 0.5;
const SHELF: usize = 24;
const FRIENDS_WINDOW_MS: i64 = 14 * 86_400_000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendItem {
    pub ext_id: String,
    pub title: String,
    pub artist: String,
    pub cover: String,
    pub url: String,
    pub preview: String,
    pub seed: String,
    pub lane: String,
    pub bpm: Option<f64>,
    pub score: f64,
    /// 1-based chart position now, when it is on the chart.
    pub rank: Option<f64>,
    /// Places climbed since about a week ago; positive is rising.
    pub rank_delta: Option<f64>,
    pub anchors: Vec<crate::discovery::AnchorOut>,
    pub measured: Measured,
    pub released: Option<String>,
}

/// What was actually measured about a candidate, so a card can be honest.
#[derive(serde::Serialize)]
pub struct Measured {
    pub tempo: bool,
    pub lyrics: bool,
    pub texture: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendItem {
    pub track_id: i64,
    pub listeners: Vec<String>,
    pub completions: i64,
    pub last_at: i64,
}

/// Everything the composition needs, read once.
pub struct ShelfInput {
    pub pool: Vec<crate::db::DiscoveryRow>,
    /// ext_id -> (lane, rank) from `discovery_lanes`.
    pub lanes: std::collections::HashMap<String, (String, f64)>,
    /// ext_id -> (artist_key, rank_now, delta) from `chart_rank_deltas`.
    pub deltas: std::collections::HashMap<String, (String, f64, f64)>,
    /// ext_id -> the threads that put it in the pool: (anchor_key, kind, strength).
    pub anchors: std::collections::HashMap<String, Vec<(String, String, f64)>>,
    /// Folded keys of the artists they have said yes to.
    pub hearted: std::collections::HashSet<String>,
    /// (anchor display name) per ext_id, for the card - strongest first.
    pub anchor_names: std::collections::HashMap<String, Vec<(String, String, f64)>>,
    pub friends: Vec<crate::db::FriendPlay>,
}

fn item(d: &crate::db::DiscoveryRow, inp: &ShelfInput) -> TrendItem {
    TrendItem {
        ext_id: d.ext_id.clone(),
        title: d.title.clone(),
        artist: d.artist.clone(),
        cover: d.cover.clone(),
        url: d.url.clone(),
        preview: d.preview.clone(),
        seed: d.seed.clone(),
        lane: inp.lanes.get(&d.ext_id).map(|(l, _)| l.clone()).unwrap_or_default(),
        bpm: d.bpm,
        score: d.score,
        rank: inp.deltas.get(&d.ext_id).map(|x| x.1),
        rank_delta: inp.deltas.get(&d.ext_id).map(|x| x.2),
        anchors: inp
            .anchor_names
            .get(&d.ext_id)
            .map(|v| {
                v.iter()
                    .map(|(artist, kind, strength)| crate::discovery::AnchorOut {
                        artist: artist.clone(),
                        kind: kind.clone(),
                        strength: *strength,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        measured: Measured {
            tempo: d.bpm.is_some(),
            lyrics: d.lyric_vec.is_some(),
            texture: d.energy.is_some(),
        },
        released: d.released.clone(),
    }
}

/// The three shelves from one read of the pool. Pure, so it can be tested
/// without a hub.
pub fn compose(inp: &ShelfInput) -> serde_json::Value {
    let lane_of = |e: &str| inp.lanes.get(e).map(|(l, _)| l.as_str()).unwrap_or("");

    // Global: chart rows for THIS listener, by score, floored. Never by fame.
    let mut global: Vec<&crate::db::DiscoveryRow> = inp
        .pool
        .iter()
        .filter(|d| lane_of(&d.ext_id) == "trending" && d.score >= GLOBAL_FLOOR)
        .collect();
    global.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let global: Vec<TrendItem> = global.into_iter().take(SHELF).map(|d| item(d, inp)).collect();

    // Scene: anchored to an artist they love, AND either climbing the chart
    // or found by walking their scene. Rising first, then by score.
    let anchored = |e: &str| {
        inp.anchors
            .get(e)
            .map(|v| v.iter().any(|(k, _, _)| inp.hearted.contains(k)))
            .unwrap_or(false)
    };
    let mut scene: Vec<(f64, &crate::db::DiscoveryRow)> = inp
        .pool
        .iter()
        .filter_map(|d| {
            if !anchored(&d.ext_id) {
                return None;
            }
            let delta = inp.deltas.get(&d.ext_id).map(|x| x.2).unwrap_or(0.0);
            (delta > 0.0 || lane_of(&d.ext_id) == "scene").then_some((delta, d))
        })
        .collect();
    scene.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.1.score.partial_cmp(&a.1.score).unwrap_or(std::cmp::Ordering::Equal))
    });
    let scene: Vec<TrendItem> = scene.into_iter().take(SHELF).map(|(_, d)| item(d, inp)).collect();

    // Friends: library rows their friends finished, so it plays instantly.
    let mut names: Vec<String> = Vec::new();
    for f in &inp.friends {
        for n in &f.listeners {
            if !names.contains(n) {
                names.push(n.clone());
            }
        }
    }
    let friends: Vec<FriendItem> = inp
        .friends
        .iter()
        .map(|f| FriendItem {
            track_id: f.track_id,
            listeners: f.listeners.clone(),
            completions: f.completions,
            last_at: f.last_at,
        })
        .collect();

    serde_json::json!({
        "global":  { "id": "trend-global",  "label": "Charts, filtered for you", "items": global },
        "scene":   { "id": "trend-scene",   "label": "Rising in your scene",     "items": scene },
        "friends": { "id": "trend-friends", "label": "Friends on this hub", "names": names, "items": friends },
    })
}

/// `GET /api/trending`.
pub async fn shelves(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<axum::Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let caller = crate::auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".into()))?;
    let user = caller.id;
    let now = crate::db::now_ms();
    let pool = state.db.top_discoveries(user, 400);
    let mut anchors: std::collections::HashMap<String, Vec<(String, String, f64)>> = Default::default();
    for (ext_id, key, kind, strength) in state.db.discovery_anchor_rows(user) {
        anchors.entry(ext_id).or_default().push((key, kind, strength));
    }
    let hearted: std::collections::HashSet<String> = state
        .db
        .heart_weighted_artists(user, now - 180 * 86_400_000, now)
        .into_iter()
        .map(|(name, _)| crate::discovery::artist_key_public(&name))
        .collect();
    let mut anchor_names: std::collections::HashMap<String, Vec<(String, String, f64)>> = Default::default();
    for d in &pool {
        if anchors.contains_key(&d.ext_id) {
            anchor_names.insert(d.ext_id.clone(), state.db.discovery_anchors_for(user, &d.ext_id));
        }
    }
    let inp = ShelfInput {
        lanes: state.db.discovery_lanes(user),
        deltas: state.db.chart_rank_deltas(),
        friends: state.db.friends_completed_since(user, now - FRIENDS_WINDOW_MS),
        pool,
        anchors,
        hearted,
        anchor_names,
    };
    Ok(axum::Json(compose(&inp)))
}

#[cfg(test)]
mod shelves_tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn row(e: &str, artist: &str, score: f64) -> crate::db::DiscoveryRow {
        crate::db::DiscoveryRow {
            ext_id: e.into(),
            title: format!("song {e}"),
            artist: artist.into(),
            cover: String::new(),
            url: String::new(),
            preview: "p".into(),
            seed: String::new(),
            popularity: 0.9,
            bpm: Some(120.0),
            lyric_vec: None,
            score,
            energy: None,
            brightness: None,
            rhythmic: None,
            released: None,
        }
    }

    fn input() -> ShelfInput {
        let pool = vec![
            row("famous", "Chart Act", 0.2),      // trending, below the floor
            row("good", "Chart Act", 0.8),        // trending, above it
            row("better", "Chart Act", 0.9),      // trending, above it
            row("riser", "Loved One", 0.6),       // anchored to a hearted artist, climbing
            row("faller", "Loved One", 0.7),      // anchored, slipping
            row("walk", "Loved One", 0.5),        // anchored, lane scene
            row("stranger", "Nobody", 0.95),      // rising but anchored to nobody they love
        ];
        let mut lanes = HashMap::new();
        for e in ["famous", "good", "better", "riser", "faller", "stranger"] {
            lanes.insert(e.to_string(), ("trending".to_string(), 0.5));
        }
        lanes.insert("walk".into(), ("scene".into(), 0.5));
        let mut deltas = HashMap::new();
        deltas.insert("riser".into(), ("loved one".into(), 3.0, 4.0));
        deltas.insert("faller".into(), ("loved one".into(), 9.0, -2.0));
        deltas.insert("stranger".into(), ("nobody".into(), 1.0, 20.0));
        let mut anchors = HashMap::new();
        for e in ["riser", "faller", "walk"] {
            anchors.insert(e.to_string(), vec![("loved one".to_string(), "lb_similar".to_string(), 0.8)]);
        }
        anchors.insert("stranger".into(), vec![("nobody".into(), "deezer_related".into(), 0.5)]);
        let hearted: HashSet<String> = ["loved one".to_string()].into_iter().collect();
        ShelfInput {
            pool,
            lanes,
            deltas,
            anchors,
            hearted,
            anchor_names: HashMap::new(),
            friends: vec![crate::db::FriendPlay {
                track_id: 7,
                completions: 3,
                listeners: vec!["ana".into(), "ben".into()],
                last_at: 5,
            }],
        }
    }

    fn ids(v: &serde_json::Value, shelf: &str) -> Vec<String> {
        v[shelf]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["extId"].as_str().unwrap_or("").to_string())
            .collect()
    }

    #[test]
    fn global_is_by_score_above_the_floor_and_never_by_fame() {
        let out = compose(&input());
        assert_eq!(ids(&out, "global"), vec!["stranger", "better", "good", "faller", "riser"]);
        assert!(!ids(&out, "global").contains(&"famous".to_string()), "below the floor");
        assert_eq!(out["global"]["label"], "Charts, filtered for you");
    }

    #[test]
    fn scene_rows_all_carry_an_anchor_they_love_and_rise_first() {
        let out = compose(&input());
        // riser (delta 4) first, then walk (scene lane, delta 0); faller is
        // slipping and stranger is anchored to nobody they love.
        assert_eq!(ids(&out, "scene"), vec!["riser", "walk"]);
        assert_eq!(out["scene"]["label"], "Rising in your scene");
        let riser = &out["scene"]["items"][0];
        assert_eq!(riser["rankDelta"], 4.0);
        assert_eq!(riser["rank"], 3.0);
        assert_eq!(riser["measured"]["tempo"], true);
        assert_eq!(riser["measured"]["texture"], false);
    }

    #[test]
    fn friends_shelf_names_the_friends_and_an_empty_shelf_is_an_empty_array() {
        let out = compose(&input());
        assert_eq!(out["friends"]["names"], serde_json::json!(["ana", "ben"]));
        assert_eq!(out["friends"]["items"][0]["trackId"], 7);
        let mut empty = input();
        empty.friends.clear();
        empty.pool.clear();
        let out = compose(&empty);
        for shelf in ["global", "scene", "friends"] {
            assert_eq!(out[shelf]["items"].as_array().unwrap().len(), 0, "{shelf}");
        }
    }
}
