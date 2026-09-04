//! Stations the DJ suggests: places to tune to, rather than lists to play.
//!
//! The home feed already builds MIXES - a fixed two dozen tracks, chosen once,
//! that play out and end. A station is the other thing: it never ends. The
//! DJ set at `/api/dj` already takes a free-text vibe and keeps going forever,
//! steered by it, but nothing ever suggested a vibe - so a listener had to
//! arrive knowing what to type, which is the same problem as a search box with
//! no shelves under it.
//!
//! So this hands back a handful of named stations, each really a SEED for that
//! endless set: a name, a line saying what it is, and the phrase the DJ steers
//! by. Tuning to one is `/api/dj?seed=<seed>` and nothing more.
//!
//! Two sources, in the same arrangement home.rs uses for mixes and for the
//! same reason:
//!
//!   heuristic  built from the play log alone - a listener's own eras, genres
//!              and heavy artists. Always available, no model required, and
//!              honest about being obvious.
//!   AI         when a model is wired up, it names and shapes stations from a
//!              taste summary. It writes the WORDS and the vibe phrase; it
//!              never picks tracks, because the DJ picks those and a model
//!              inventing a track is the failure mode worth designing out.
//!
//! The model is never waited on. A request gets whatever is cached, and a
//! stale cache regenerates behind it.

use crate::auth;
use crate::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// How long a set of stations stands before it is rebuilt behind the next
/// request. Longer than the daily mixes: a station is a place you go back to,
/// and one that is renamed every morning is not a place.
const TTL: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// The window the taste summary is drawn from.
const WINDOW_30D_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// How many to offer. Enough to feel like a dial, few enough to read.
const WANT: usize = 6;

#[derive(Clone, serde::Serialize)]
pub struct Station {
    pub id: String,
    pub name: String,
    pub blurb: String,
    /// What the DJ steers by - handed straight back as `/api/dj?seed=`.
    pub seed: String,
    /// "ai" | "heuristic", so the client can say where it came from.
    pub flavor: String,
    /// What the station literally MEANS, when it means something literal -
    /// `unplayed`, `genre:{g}`, `artist:{a}` - handed back as
    /// `/api/dj?filter=` so the set is constrained to it rather than merely
    /// steered toward a sentence about it. See `dj::station_filter`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    /// The mood's listening weight by UTC quarter-day, for ordering the
    /// shelf by the hour it is asked for. Server-side only.
    #[serde(skip)]
    pub hours: Option<[f64; 4]>,
}

/// Put the stations that belong to THIS hour first.
///
/// `MoodCluster.hours` has been computed since the profile existed and never
/// read here: a listener's "late and low" mood led the shelf at nine in the
/// morning. The buckets are UTC quarter-days, so the hour they are indexed by
/// is the server's UTC hour - not the client's local one, which the DJ and
/// radio take for their own tilt. Stable: stations with nothing to say about
/// the hour (the heuristics) keep their order among themselves.
fn order_for_hour(stations: &mut [Station], utc_hour: u32) {
    let bucket = ((utc_hour % 24) / 6) as usize;
    let weight = |s: &Station| s.hours.map(|h| h[bucket]).unwrap_or(0.0);
    stations.sort_by(|a, b| weight(b).partial_cmp(&weight(a)).unwrap_or(std::cmp::Ordering::Equal));
}

fn utc_hour_now() -> u32 {
    ((now_ms() / 1000 / 3600) % 24) as u32
}

struct Cached {
    stations: Vec<Station>,
    built_at: std::time::Instant,
    refreshing: bool,
}

#[derive(Default)]
pub struct StationState {
    per_user: tokio::sync::Mutex<HashMap<i64, Cached>>,
}

impl StationState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

/*
 * Through `ai::setting`, NOT a raw env read.
 *
 * `setting` resolves the owner's choice in Settings first and the environment
 * only after. Reading the variable directly means this feature silently ignores
 * the pane that exists to configure it: the model row is changed, the pickers
 * confirm it, and this one carries on asking for whatever the unit file said -
 * with no error anywhere, because a model name is only ever wrong later.
 */

/// Both halves, or nothing.
///
/// A model name is only ever wrong LATER - the request goes out, the endpoint
/// refuses a model it does not have, and the feature reports as an AI that is
/// not working. So "can this run" means a URL AND a model, the same rule
/// `AiClient::new` applies, and the caller falls back to its heuristic exactly
/// as it does when nothing is configured at all.


/// `GET /api/dj/stations` - what the DJ suggests you tune to.
pub async fn stations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let user = caller.id;

    let (mut ready, needs_refresh) = {
        let mut cache = state.stations.per_user.lock().await;
        match cache.get_mut(&user) {
            Some(entry) => {
                let stale = entry.built_at.elapsed() > TTL;
                let start = stale && !entry.refreshing;
                if start {
                    entry.refreshing = true;
                }
                (entry.stations.clone(), start)
            }
            None => {
                // Nothing yet: seed the cache with the heuristics so the first
                // visit is answered immediately, and let the model improve on
                // them in the background.
                let built = heuristic_stations(&state, user);
                cache.insert(
                    user,
                    Cached {
                        stations: built.clone(),
                        built_at: std::time::Instant::now(),
                        refreshing: true,
                    },
                );
                (built, true)
            }
        }
    };

    if needs_refresh {
        /*
         * From the mood profile now, not from a fresh model call.
         *
         * ai_stations was a temperature-0.9 chat request with a 120 second
         * timeout whose entire output was names and vibe phrases - on a box
         * that generates five tokens a second, a hundred seconds of model time
         * to invent words for listening the mood engine has already measured
         * and named. The profile carries better words (its names came from
         * the model once, at build time) and the truth behind them; deriving
         * the seed phrases from it costs nothing and cannot time out. The
         * heuristics remain for a listener with no profile yet.
         */
        let state2 = Arc::clone(&state);
        tokio::spawn(async move {
            let fresh = mood_stations(&state2, user);
            let mut cache = state2.stations.per_user.lock().await;
            if let Some(entry) = cache.get_mut(&user) {
                if let Some(list) = fresh {
                    if !list.is_empty() {
                        entry.stations = list;
                    }
                }
                entry.built_at = std::time::Instant::now();
                entry.refreshing = false;
            }
        });
    }

    order_for_hour(&mut ready, utc_hour_now());
    Ok(Json(json!({ "stations": ready })))
}

/// Stations anybody's play log can answer for, with no model at all.
///
/// Deliberately plain. These are the obvious cuts through a listener's own
/// history - their decade, their genre, their heaviest artist, the songs they
/// have never played - and being obvious is the point: they are always right,
/// always available, and a model that fails leaves the listener with these
/// Forget one listener's cached DJ stations - called when the mood profile
/// they were derived from has just been rebuilt, so the two surfaces cannot
/// spend days wearing different names for the same mood. The next request
/// re-derives from the fresh profile; the TTL stays as the ordinary clock.
pub async fn invalidate(state: &Arc<AppState>, user: i64) {
    state.stations.per_user.lock().await.remove(&user);
}

/// rather than an empty shelf.
fn heuristic_stations(state: &Arc<AppState>, user: i64) -> Vec<Station> {
    let since = now_ms() - WINDOW_30D_MS;
    let mut out: Vec<Station> = Vec::new();

    let top_artists = state.db.top_artists(user, since, 6);
    if let Some((artist, _)) = top_artists.first() {
        out.push(Station {
            id: "heavy-artist".into(),
            name: format!("{artist} and the road out"),
            blurb: format!("Starts where {artist} lives and keeps walking."),
            seed: format!("{artist} and artists who sound like them"),
            flavor: "heuristic".into(),
            filter: Some(format!("artist:{artist}")),
            hours: None,
        });
    }
    if let Some((artist, _)) = top_artists.get(2) {
        out.push(Station {
            id: "second-lane".into(),
            name: format!("The {artist} side"),
            blurb: "Your other lane, given its own hour.".into(),
            seed: format!("in the style of {artist}"),
            flavor: "heuristic".into(),
            filter: Some(format!("artist:{artist}")),
            hours: None,
        });
    }

    for (genre, _) in state.db.top_genres(user, since, 2) {
        if genre.trim().is_empty() {
            continue;
        }
        out.push(Station {
            id: format!("genre-{}", genre.to_lowercase().replace(' ', "-")),
            name: format!("Deep {genre}"),
            blurb: format!("{genre}, past the songs you already know."),
            seed: format!("{genre}, deeper cuts"),
            flavor: "heuristic".into(),
            filter: Some(format!("genre:{genre}")),
            hours: None,
        });
    }

    out.push(Station {
        id: "late".into(),
        name: "After midnight".into(),
        blurb: "Slower, darker, and in no hurry.".into(),
        seed: "late night, slow, atmospheric, quiet".into(),
        flavor: "heuristic".into(),
        filter: None,
        hours: None,
    });
    out.push(Station {
        id: "unplayed".into(),
        name: "Never played".into(),
        blurb: "Records you own and have never once put on.".into(),
        seed: "songs I have never played".into(),
        flavor: "heuristic".into(),
        filter: Some("unplayed".into()),
        hours: None,
    });

    out.truncate(WANT);
    out
}

/// Stations a model names from the listener's taste.
///
/// It writes words and a vibe phrase - never a track list. The DJ chooses the
/// music from the library it can see, so the worst a bad reply can do here is
/// One DJ station per mood cluster, from the stored profile.
///
/// The seed stays a free-text vibe phrase - that is the client contract, and
/// /api/dj embeds whatever it is handed - but the words now come from the
/// measured clusters: their tags, their tempo, their hour of the day. `name`
/// carries the profile's model-written mood name.
fn mood_stations(state: &Arc<AppState>, user: i64) -> Option<Vec<Station>> {
    let profile = crate::mood::load(state, user)?;
    if profile.clusters.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (i, c) in profile.clusters.iter().take(WANT).enumerate() {
        let pace = match c.bpm {
            Some(b) if b < 95.0 => "slow and unhurried",
            Some(b) if b < 125.0 => "mid-tempo",
            Some(_) => "quick and driving",
            None => "any pace",
        };
        let feel = match c.energy {
            Some(e) if e < 0.35 => "soft-edged",
            Some(e) if e < 0.6 => "steady",
            Some(_) => "loud and alive",
            None => "",
        };
        // By CHARS, never String::truncate - a byte index mid-character
        // panics, this string always carries a three-byte em dash, and a panic
        // here dies inside the refresh task that is the only thing that clears
        // the `refreshing` latch. The code this replaced knew that; the lesson
        // must not be lost with it.
        let seed: String = format!("{} — {}, {}", c.tags.join(", "), pace, feel)
            .chars()
            .take(160)
            .collect();
        // The mood names are model-written (once, at profile build). The old
        // guard against a model inventing "KEXP Seattle" stays enforced here -
        // a name that reads as broadcast falls back to the cluster's own tags.
        let name = if reads_as_broadcast(&c.name) {
            super_plain(&c.tags)
        } else {
            c.name.clone()
        };
        out.push(Station {
            id: format!("mood-{}", i + 1),
            name,
            blurb: c.blurb.clone(),
            seed,
            flavor: "ai".into(),
            filter: None,
            hours: Some(c.hours),
        });
    }
    if out.is_empty() {
        return None;
    }
    /*
     * A young profile has one or two moods, and one station is not a shelf.
     * The heuristics that served before the profile existed still know things
     * the profile does not - the heavy artist, the unplayed pile - so they
     * fill the remaining slots rather than being wholly replaced, skipping any
     * that duplicate a mood station's name.
     */
    if out.len() < WANT {
        let names: std::collections::HashSet<String> =
            out.iter().map(|s| s.name.to_lowercase()).collect();
        for h in heuristic_stations(state, user) {
            if out.len() >= WANT {
                break;
            }
            if !names.contains(&h.name.to_lowercase()) {
                out.push(h);
            }
        }
    }
    Some(out)
}

/// Whether a name reads as a real broadcast station rather than a lane.
/// The tags, title-cased, when the model's name cannot be used.
fn super_plain(tags: &[String]) -> String {
    let mut s = tags.first().cloned().unwrap_or_else(|| "Your mood".into());
    if let Some(c) = s.get_mut(0..1) {
        c.make_ascii_uppercase();
    }
    s
}

fn reads_as_broadcast(name: &str) -> bool {
    let lower = name.to_lowercase();
    // Call letters: four capitals starting K or W is the American pattern the
    // model reached for unprompted.
    let call_sign = name
        .split_whitespace()
        .any(|w| w.len() >= 3 && w.chars().all(|c| c.is_ascii_uppercase()) && (w.starts_with('K') || w.starts_with('W') || w.starts_with('B')));
    call_sign
        || lower.split_whitespace().any(|w| w == "fm" || w == "am" || w == "radio")
        // "97.3", "101.1" - a frequency is never a lane.
        || name.split_whitespace().any(|w| {
            w.contains('.') && w.chars().all(|c| c.is_ascii_digit() || c == '.')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_names_are_refused() {
        // The exact names the model produced before the prompt was fixed.
        assert!(reads_as_broadcast("KEXP Seattle"));
        assert!(reads_as_broadcast("BNN - Boston"));
        assert!(reads_as_broadcast("H2 Radio - Houston"));
        assert!(reads_as_broadcast("Indie 103.1"));
        assert!(reads_as_broadcast("Jazz FM"));
    }

    #[test]
    fn real_station_names_pass() {
        // What the fixed prompt actually returns.
        assert!(!reads_as_broadcast("Dreamscapes Velvet"));
        assert!(!reads_as_broadcast("Sunset Shadows"));
        assert!(!reads_as_broadcast("Fuzz and Sunlight"));
        assert!(!reads_as_broadcast("The Slow Hours"));
        assert!(!reads_as_broadcast("Bedroom Static"));
    }

    fn station(id: &str, hours: Option<[f64; 4]>) -> Station {
        Station {
            id: id.into(),
            name: id.into(),
            blurb: String::new(),
            seed: String::new(),
            flavor: "ai".into(),
            filter: None,
            hours,
        }
    }

    /// The mood the listener lives in at THIS hour leads the shelf, and the
    /// stations with no hour of their own keep their order behind.
    #[test]
    fn the_hours_mood_leads_and_the_heuristics_keep_their_order() {
        let mut list = vec![
            station("morning", Some([0.1, 0.7, 0.2, 0.0])),
            station("late", Some([0.6, 0.0, 0.1, 0.3])),
            station("heavy-artist", None),
            station("unplayed", None),
        ];
        order_for_hour(&mut list, 23);
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["late", "morning", "heavy-artist", "unplayed"]);

        order_for_hour(&mut list, 8);
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["morning", "late", "heavy-artist", "unplayed"]);
    }
}
