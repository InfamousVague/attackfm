//! The small-artist engine: candidates from graphs that fame cannot buy.
//!
//! The Deezer harvest walks a related-artists graph that is itself
//! popularity-weighted, takes each artist's TOP tracks, and (until Phase 0)
//! added a fame bonus on top - three leans toward the already-big in the one
//! pipeline whose purpose is finding the small. This module adds two sources
//! with the opposite grain:
//!
//!  * ListenBrainz's similar-artists graph. Session-based, contribution-
//!    capped (megastars are trimmed by the algorithm itself), keyless, and
//!    MBID-keyed. Paired with the popularity endpoint, "similar to what you
//!    love but under N listeners worldwide" is two HTTP calls.
//!  * MusicBrainz artist relationships. Members, side projects and
//!    collaborators of obscure artists the listener HEARTED - people with
//!    scene provenance who may have no co-listening signal anywhere. This is
//!    the only channel that reaches artists with effectively zero data.
//!
//! Both feed the same candidate pool the Deezer harvest fills, through the
//! same strict artist resolution (a wrong match ingests a stranger's
//! catalog), and their candidates ride the same scoring, collector and
//! audition pipeline as everything else.
//!
//! Etiquette: MusicBrainz asks for 1 request/second and a named UA; every MB
//! call here sleeps 1.1s after itself and the walk does one artist per cycle.
//! The labs endpoints are keyless and answer in bulk, so a whole cycle costs
//! a handful of requests.

use crate::discovery;
use crate::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const MB_UA: &str = "AttackFM/0.3 (https://matt.attack.fm)";
const MB_GAP: Duration = Duration::from_millis(1100);
const LB_GAP: Duration = Duration::from_millis(350);

/// The similarity algorithm ListenBrainz's own radio uses: session-based with
/// per-user contribution capped at 5, which is what keeps megastars from
/// owning every neighbourhood. Verified live before this was written.
const LB_ALGORITHM: &str =
    "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

/// The ceiling that makes this a SMALL-artist engine: similar artists with
/// more worldwide ListenBrainz listeners than this are someone the listener
/// can find without help. Zero means "unknown to LB", which for this purpose
/// is the most interesting answer of all.
const POP_CEILING_LISTENERS: u64 = 12_000;

/// How obscure a hearted artist must be (by the max LB listener count already
/// stored on their tracks) before the scene walk digs around them - the walk
/// exists for the artists nobody else's graph can see.
const OBSCURE_LISTENERS: i64 = 15_000;

/// Similar artists taken per seed, and candidate tracks per new artist. Low on
/// purpose: these are gambles, and artist-level adoption decides whether the
/// catalog gets deepened later.
const SIMS_PER_SEED: usize = 3;
const TRACKS_PER_NEW_ARTIST: usize = 2;
const SEEDS_PER_RUN: usize = 4;
const RELS_PER_WALK: usize = 4;

const HARVEST_EVERY_MS: i64 = 6 * 60 * 60 * 1000;
const WALK_EVERY_MS: i64 = 12 * 60 * 60 * 1000;

fn clocks() -> &'static tokio::sync::Mutex<HashMap<(i64, &'static str), i64>> {
    static CLOCKS: OnceLock<tokio::sync::Mutex<HashMap<(i64, &'static str), i64>>> =
        OnceLock::new();
    CLOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

async fn due(user: i64, kind: &'static str, every_ms: i64) -> bool {
    let mut c = clocks().lock().await;
    let now = now_ms();
    let ok = c.get(&(user, kind)).map(|t| now - t >= every_ms).unwrap_or(true);
    if ok {
        c.insert((user, kind), now);
    }
    ok
}

/// Percent-encoding for one query value - the crate for this is smaller than
/// this comment, but it is still a dependency the M4 build does not need.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(MB_UA)
        .build()
        .ok()
}

/// One collector cycle's worth of both sources, for every active listener.
/// Cheap when nothing is due - two map lookups per user.
pub async fn cycle(state: &Arc<AppState>) {
    let since = now_ms() - 30 * 24 * 60 * 60 * 1000;
    for user in state.db.listeners_since(since) {
        if due(user, "lb-harvest", HARVEST_EVERY_MS).await {
            harvest_similar(state, user).await;
        }
        if due(user, "scene-walk", WALK_EVERY_MS).await {
            scene_walk(state, user).await;
        }
    }
}

/// The artist's MusicBrainz id, by name - cached forever, including misses,
/// because MB politely asks not to be asked twice.
async fn artist_mbid(state: &Arc<AppState>, c: &reqwest::Client, name: &str) -> Option<String> {
    let key = discovery::artist_key_public(name);
    if key.is_empty() {
        return None;
    }
    if let Some(cached) = state.db.mb_artist_cached(&key) {
        return (!cached.is_empty()).then_some(cached);
    }
    let url = format!(
        "https://musicbrainz.org/ws/2/artist?query=artist:%22{}%22&fmt=json&limit=3",
        enc(name)
    );
    let v: Option<serde_json::Value> = async {
        c.get(&url).send().await.ok()?.json().await.ok()
    }
    .await;
    tokio::time::sleep(MB_GAP).await;
    let found = v
        .as_ref()
        .and_then(|v| v.get("artists"))
        .and_then(|a| a.as_array())
        .and_then(|arr| {
            arr.iter().find(|a| {
                a.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| discovery::artist_key_public(n) == key)
                    .unwrap_or(false)
            })
        })
        .and_then(|a| a.get("id"))
        .and_then(|i| i.as_str())
        .map(String::from);
    // A miss is cached as '' - the name simply is not on MB under this
    // spelling, and asking again tomorrow will not change that.
    state.db.mb_artist_store(&key, found.as_deref().unwrap_or(""));
    found
}

/// Similar artists, with the contribution cap doing the anti-fame work.
async fn similar_artists(c: &reqwest::Client, mbid: &str) -> Vec<(String, String, i64)> {
    let url = format!(
        "https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids={mbid}&algorithm={LB_ALGORITHM}"
    );
    let v: Option<serde_json::Value> = async {
        c.get(&url).send().await.ok()?.json().await.ok()
    }
    .await;
    tokio::time::sleep(LB_GAP).await;
    v.and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|a| {
                    Some((
                        a.get("artist_mbid")?.as_str()?.to_string(),
                        a.get("name")?.as_str()?.to_string(),
                        a.get("score").and_then(|s| s.as_i64()).unwrap_or(0),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Worldwide listener counts for a batch of artists, in one POST.
async fn artist_popularity(c: &reqwest::Client, mbids: &[String]) -> HashMap<String, u64> {
    if mbids.is_empty() {
        return HashMap::new();
    }
    let v: Option<serde_json::Value> = async {
        c.post("https://api.listenbrainz.org/1/popularity/artist")
            .json(&serde_json::json!({ "artist_mbids": mbids }))
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()
    }
    .await;
    tokio::time::sleep(LB_GAP).await;
    v.and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|a| {
                    Some((
                        a.get("artist_mbid")?.as_str()?.to_string(),
                        a.get("total_user_count").and_then(|n| n.as_u64()).unwrap_or(0),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 2a: the harvest backbone. Seeds -> LB similar -> popularity ceiling ->
/// strict Deezer resolve -> a couple of tracks each into the shared pool.
pub async fn harvest_similar(state: &Arc<AppState>, user: i64) {
    let Some(c) = client() else { return };
    let since = now_ms() - 30 * 24 * 60 * 60 * 1000;
    let seeds = state.db.top_artists(user, since, SEEDS_PER_RUN as i64);
    if seeds.is_empty() {
        return;
    }
    let owned_artists: HashSet<String> = state
        .db
        .owned_artist_names()
        .into_iter()
        .map(|a| discovery::artist_key_public(&a))
        .collect();

    for (seed_name, _weight) in seeds {
        let Some(mbid) = artist_mbid(state, &c, &seed_name).await else { continue };
        let sims = similar_artists(&c, &mbid).await;
        if sims.is_empty() {
            continue;
        }
        let mbids: Vec<String> = sims.iter().map(|(m, _, _)| m.clone()).collect();
        let pop = artist_popularity(&c, &mbids).await;
        let mut small: Vec<&(String, String, i64)> = sims
            .iter()
            .filter(|(m, name, _)| {
                pop.get(m).copied().unwrap_or(0) <= POP_CEILING_LISTENERS
                    && !owned_artists.contains(&discovery::artist_key_public(name))
            })
            .collect();
        // Highest similarity first - small AND close beats small and random.
        small.sort_by_key(|(_, _, score)| -*score);
        for (_, name, _) in small.into_iter().take(SIMS_PER_SEED) {
            discovery::ingest_artist_by_name(state, user, &c, name, &seed_name, TRACKS_PER_NEW_ARTIST)
                .await;
        }
    }
}

/// 2b: the scene walk. One hearted obscure artist per pass; their members,
/// side projects and collaborators, popularity-gated, into the pool.
pub async fn scene_walk(state: &Arc<AppState>, user: i64) {
    let Some(c) = client() else { return };
    let hearts = state.db.hearted_obscure_artists(user, OBSCURE_LISTENERS);
    let Some(artist) = hearts
        .into_iter()
        .find(|a| state.db.scene_walk_due(user, &discovery::artist_key_public(a), WALK_EVERY_MS))
    else {
        return;
    };
    let key = discovery::artist_key_public(&artist);
    state.db.scene_walk_record(user, &key);

    let Some(mbid) = artist_mbid(state, &c, &artist).await else { return };
    let url = format!("https://musicbrainz.org/ws/2/artist/{mbid}?inc=artist-rels&fmt=json");
    let v: Option<serde_json::Value> = async {
        c.get(&url).send().await.ok()?.json().await.ok()
    }
    .await;
    tokio::time::sleep(MB_GAP).await;
    let Some(rels) = v.as_ref().and_then(|v| v.get("relations")).and_then(|r| r.as_array())
    else {
        return;
    };

    // Any relation that points at another ARTIST is scene provenance: band
    // members, side projects, collaborations. Shared history is the quality
    // gate that defuses obscurity-equals-junk.
    let mut related: Vec<(String, String)> = rels
        .iter()
        .filter_map(|r| {
            let a = r.get("artist")?;
            Some((
                a.get("id")?.as_str()?.to_string(),
                a.get("name")?.as_str()?.to_string(),
            ))
        })
        .collect();
    related.dedup_by(|a, b| a.0 == b.0);
    if related.is_empty() {
        return;
    }
    let mbids: Vec<String> = related.iter().map(|(m, _)| m.clone()).collect();
    let pop = artist_popularity(&c, &mbids).await;
    let owned_artists: HashSet<String> = state
        .db
        .owned_artist_names()
        .into_iter()
        .map(|a| discovery::artist_key_public(&a))
        .collect();
    for (m, name) in related.into_iter().take(RELS_PER_WALK * 2) {
        if pop.get(&m).copied().unwrap_or(0) > POP_CEILING_LISTENERS {
            continue;
        }
        if owned_artists.contains(&discovery::artist_key_public(&name)) {
            continue;
        }
        discovery::ingest_artist_by_name(state, user, &c, &name, &artist, TRACKS_PER_NEW_ARTIST)
            .await;
    }
}
