//! Who an artist is, built before anyone asks.
//!
//! Music Date deals a hand of songs by people you have never heard of, and the
//! panel under the card is meant to answer "who is this" in the two seconds
//! before you judge them. It used to build that answer when the card became
//! current: three uncached Deezer calls, per card, every time. So the first
//! card of every sitting showed "Looking them up…", and an artist you met last
//! week was looked up again from scratch.
//!
//! This builds it ahead of the user instead, and keeps it. The hand is dealt,
//! and the same fire-and-forget pass that already researches the dealt band
//! names now builds their whole profile too, so by the time the third card is
//! in hand the twenty-fifth already has a profile waiting.
//!
//! **Everything here is a fact somebody else vouches for.** The model writes
//! the one-line prose (lore.rs) and nothing else - no model-supplied genre,
//! origin, year or fan count ever lands in this table. That is the whole
//! design: a profile of a tiny act is thin rather than invented, and the
//! `sources` list says exactly who answered so the panel can render a block
//! only when it has a real source behind it.
//!
//! Four sources, and none of them is required:
//!   - **Deezer**  fans, album count, a discography, their top songs, and who
//!                 the catalogue puts near them.
//!   - **MusicBrainz** where they are from, when they started, person or band,
//!                 and the curated genre tags.
//!   - **ListenBrainz** how many people actually listen.
//!   - **Spotify** genres, followers and a 0-100 popularity - only when the hub
//!                 has its own app credentials.
//!
//! **Rate limits are the real constraint**, not the code. A naive twenty-five
//! artist build is a hundred-request burst that degrades the harvest, the
//! importer and search - not just this feature. So: artists are built one at a
//! time with the catalogue's own politeness gap between them, requests run
//! concurrently only WITHIN one artist, MusicBrainz gets its 1.1s, and the
//! cold inline build (someone opened a card we have never seen) is Deezer-only
//! so a person waiting on a panel never waits on MusicBrainz etiquette.

use crate::AppState;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// How long a built profile stands before it is worth rebuilding. Fan counts
/// drift and discographies grow, but neither by the day.
const STALE_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// How long after a failed or empty attempt before asking again. An artist the
/// catalogues genuinely do not have must not be re-asked on every deal.
const RETRY_MS: i64 = 60 * 60 * 1000;
/// The inline build's whole budget. A person is looking at the card.
const FAST_BUDGET: Duration = Duration::from_secs(8);
/// How many artists one background pass builds. Times the gap below, this is
/// the burst this feature is allowed to be.
const BATCH: usize = 8;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Artists currently being built, so two decks dealing the same act do not
/// both go and fetch them.
///
/// Its own set rather than `lore::lock()`: that mutex is held across model
/// calls, and queueing a catalogue lookup behind a 300 second model timeout is
/// how a profile pass turns into a stall.
fn claimed() -> &'static std::sync::Mutex<HashSet<String>> {
    static CLAIMED: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
        std::sync::OnceLock::new();
    CLAIMED.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

/// Take the claim for these keys, returning only the ones we now own.
fn claim(keys: &[String]) -> Vec<String> {
    let mut set = claimed().lock().unwrap();
    keys.iter().filter(|k| set.insert((*k).clone())).cloned().collect()
}

fn release(keys: &[String]) {
    let mut set = claimed().lock().unwrap();
    for k in keys {
        set.remove(k);
    }
}

/// Zero is not a fact.
///
/// Deezer answers `0` for a fan count it does not have as readily as for an
/// artist nobody follows, and a panel that says "0 fans on Deezer" is stating
/// something it does not know. Every count here goes through this, so an
/// absent number renders nothing at all.
fn positive(n: Option<u64>) -> Option<u64> {
    n.filter(|v| *v > 0)
}

/// What the catalogue says, with nothing invented.
///
/// Only ever called with a STRICT artist match. `deezer_artist_id_public`
/// falls back to the first search hit, which is right for a throwaway
/// suggestion and catastrophic here: this answer is about to be cached and
/// shown as fact under the artist's name.
async fn deezer_layer(c: &reqwest::Client, name: &str) -> Option<Value> {
    let id = crate::discovery::deezer_artist_id_strict(c, name).await?;
    // One artist, so these may run together - the gap that matters is BETWEEN
    // artists, and this is four requests about one of them.
    let (obj, albums, top, related) = tokio::join!(
        crate::discovery::deezer_artist_object(c, id),
        deezer_discography(c, id),
        deezer_top_titles(c, id),
        crate::discovery::deezer_related(c, id),
    );
    let obj = obj.unwrap_or_else(|| json!({}));
    Some(json!({
        "fans": positive(obj.get("nb_fan").and_then(|x| x.as_u64())),
        "albums": positive(obj.get("nb_album").and_then(|x| x.as_u64())),
        "picture": obj.get("picture_xl").and_then(|x| x.as_str()).filter(|s| !s.is_empty()),
        "discography": albums,
        "top": top,
        "related": related
            .unwrap_or_default()
            .into_iter()
            .map(|(_, n)| n)
            .take(6)
            .collect::<Vec<String>>(),
    }))
}

/// A short discography: albums, newest first, one line each with its year,
/// deduped by title. Facts straight from the catalogue - true even for an act
/// no model has heard of, which is the point of not leaving this to a model.
async fn deezer_discography(c: &reqwest::Client, id: u64) -> Vec<String> {
    let Ok(resp) = c
        .get(format!("https://api.deezer.com/artist/{id}/albums"))
        .query(&[("limit", "50")])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(v) = resp.json::<Value>().await else {
        return Vec::new();
    };
    let Some(items) = v.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut rows: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for a in items {
        let title = a.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if title.is_empty() || !seen.insert(title.to_lowercase()) {
            continue;
        }
        let date = a.get("release_date").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let year = date.get(0..4).unwrap_or("").to_string();
        let line = if year.is_empty() { title } else { format!("{title} ({year})") };
        rows.push((date, line));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|(_, line)| line).take(6).collect()
}

/// The songs of theirs most people reach for - the "start here" a stranger
/// actually wants.
async fn deezer_top_titles(c: &reqwest::Client, id: u64) -> Vec<String> {
    let Ok(resp) = c
        .get(format!("https://api.deezer.com/artist/{id}/top"))
        .query(&[("limit", "5")])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(v) = resp.json::<Value>().await else {
        return Vec::new();
    };
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("title").and_then(|x| x.as_str()).map(str::to_string))
                .filter(|t| !t.is_empty())
                .take(5)
                .collect()
        })
        .unwrap_or_default()
}

/// The Deezer-only build, for the request path. No MusicBrainz (its 1.1s
/// etiquette makes a burst of them a stall), no ListenBrainz. Marked partial
/// so the sweep knows to come back and deepen it, and so the client re-asks.
pub async fn build_fast(state: &Arc<AppState>, name: &str) -> Value {
    let c = crate::discovery::client(6);
    let layer = tokio::time::timeout(FAST_BUDGET, deezer_layer(&c, name))
        .await
        .ok()
        .flatten();
    let key = crate::discovery::artist_key_public(name);
    let now = now_ms();
    match layer {
        Some(d) => {
            let body = json!({ "deezer": d, "partial": true });
            // built_at 0 = "the full pass has never run on this one". That is
            // what lets `ensure` come back and deepen it immediately instead
            // of mistaking a fresh shallow row for a finished profile.
            let _ = state
                .db
                .artist_profile_put(&key, name, &body.to_string(), "deezer", 0, now);
            body
        }
        None => {
            // Reached and not found, or not reached. Either way the attempt
            // clock moves and any profile already stored is left alone.
            state.db.artist_profile_touch(&key, name, now);
            json!({ "partial": true })
        }
    }
}

/// The full build for one artist. Sequential by source, because the sources
/// have different etiquette and only Deezer is fast.
async fn build_full(state: &Arc<AppState>, name: &str) -> (Value, Vec<&'static str>) {
    let mut body = serde_json::Map::new();
    let mut sources: Vec<&'static str> = Vec::new();

    let c = crate::discovery::client(10);
    if let Some(d) = deezer_layer(&c, name).await {
        body.insert("deezer".into(), d);
        sources.push("deezer");
    }

    // Spotify: two requests on this hub's own app credentials. Absent when the
    // hub has none configured, and then the layer simply is not there.
    if let Some(sp) = crate::search::spotify_artist(name).await {
        let mut genres: Vec<String> = sp
            .get("genres")
            .and_then(|g| g.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        genres.truncate(4);
        let followers = positive(sp.pointer("/followers/total").and_then(|x| x.as_u64()));
        let popularity = sp.get("popularity").and_then(|x| x.as_u64());
        let image = sp
            .pointer("/images/0/url")
            .and_then(|x| x.as_str())
            .map(String::from);
        if !genres.is_empty() || followers.is_some() || popularity.is_some() {
            body.insert(
                "spotify".into(),
                json!({ "genres": genres, "followers": followers, "popularity": popularity, "image": image }),
            );
            sources.push("spotify");
        }
    }

    // MusicBrainz, then ListenBrainz on the mbid it just resolved. Both behind
    // the same client, so there is one MusicBrainz user-agent in this process
    // rather than a fourth.
    if let Some(mb_client) = crate::listenbrainz::client() {
        if let Some(mbid) = crate::listenbrainz::artist_mbid(state, &mb_client, name).await {
            if let Some(facts) = crate::listenbrainz::artist_facts(&mb_client, &mbid).await {
                body.insert("musicbrainz".into(), facts);
                sources.push("musicbrainz");
            }
            let pop = crate::listenbrainz::artist_popularity(&mb_client, &[mbid.clone()]).await;
            if let Some(listeners) = positive(pop.get(&mbid).copied()) {
                body.insert("listenbrainz".into(), json!({ "listeners": listeners }));
                sources.push("listenbrainz");
            }
        }
    }

    (Value::Object(body), sources)
}

/// Build profiles for these artists, behind whatever asked. Fire-and-forget:
/// awaited inside a handler this would turn a 50ms deal into a minute and a
/// half.
pub async fn ensure(state: &Arc<AppState>, names: &[String]) {
    if names.is_empty() {
        return;
    }
    let now = now_ms();
    // Dedupe by folded key, keeping the first spelling seen as the display one.
    let mut want: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for n in names {
        let n = n.trim();
        if n.is_empty() {
            continue;
        }
        let k = crate::discovery::artist_key_public(n);
        if k.is_empty() || !seen.insert(k.clone()) {
            continue;
        }
        want.push((k, n.to_string()));
    }

    let keys: Vec<String> = want.iter().map(|(k, _)| k.clone()).collect();
    let gaps: HashSet<String> = state
        .db
        .artist_profile_gaps(&keys, now - STALE_MS, now - RETRY_MS)
        .into_iter()
        .collect();
    let todo: Vec<(String, String)> = want.into_iter().filter(|(k, _)| gaps.contains(k)).collect();
    if todo.is_empty() {
        return;
    }
    let mine = claim(&todo.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>());
    let mine_set: HashSet<String> = mine.iter().cloned().collect();
    let todo: Vec<(String, String)> = todo.into_iter().filter(|(k, _)| mine_set.contains(k)).collect();

    for (k, name) in todo.iter().take(BATCH) {
        let (body, sources) = build_full(state, name).await;
        let now = now_ms();
        if sources.is_empty() {
            state.db.artist_profile_touch(k, name, now);
        } else {
            let _ = state
                .db
                .artist_profile_put(k, name, &body.to_string(), &sources.join(","), now, now);
        }
        // Between ARTISTS, not between requests about one of them.
        tokio::time::sleep(crate::discovery::CATALOGUE_GAP).await;
    }
    release(&mine);

    // The prose last: it is the slowest and the only optional one, and every
    // profile above is already usable without it.
    let plain: Vec<String> = todo.into_iter().map(|(_, n)| n).collect();
    crate::lore::ensure_artists(state, &plain).await;
}

/// The stored profiles for these names, spliced with the prose and with what
/// this listener already owns. A pure database read - safe on a request path,
/// and it must STAY one: the moment this grows a network call, dealing a hand
/// stops being instant.
pub fn known(state: &AppState, user_id: i64, names: &[String]) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    if names.is_empty() {
        return out;
    }
    let keys: Vec<String> = names
        .iter()
        .map(|n| crate::discovery::artist_key_public(n))
        .collect();
    let rows = state.db.artist_profile_rows(&keys);
    let by_key: HashMap<String, (String, String)> = rows
        .into_iter()
        .map(|(k, body, sources, _)| (k, (body, sources)))
        .collect();
    let blurbs = crate::lore::known_artists(state, names);

    for name in names {
        let k = crate::discovery::artist_key_public(name);
        let blurb = blurbs.get(&k).cloned().unwrap_or_default();
        let (tracks, hearted) = state.db.artist_holdings(user_id, name);
        let Some((body, sources)) = by_key.get(&k) else {
            // No profile yet, but the prose and the holdings are still true.
            if blurb.is_empty() && tracks == 0 {
                continue;
            }
            out.insert(
                name.clone(),
                json!({ "blurb": blurb, "sources": [], "yours": { "tracks": tracks, "hearted": hearted } }),
            );
            continue;
        };
        let mut v: Value = serde_json::from_str(body).unwrap_or_else(|_| json!({}));
        if let Some(map) = v.as_object_mut() {
            map.insert("blurb".into(), json!(blurb));
            map.insert(
                "sources".into(),
                json!(sources
                    .split(',')
                    .filter(|s| !s.trim().is_empty())
                    .collect::<Vec<&str>>()),
            );
            map.insert("yours".into(), json!({ "tracks": tracks, "hearted": hearted }));
        }
        out.insert(name.clone(), v);
    }
    out
}

/// The ahead-of-everyone pass: keep filling in the artists the pool already
/// holds, so a deck dealt tomorrow is warm before it is dealt.
pub fn spawn_warm(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Let the boot scan, the curator and the collector have the box first.
        tokio::time::sleep(Duration::from_secs(200)).await;
        loop {
            let names = state.db.discovery_artists(BATCH * 3);
            if !names.is_empty() {
                ensure(&state, &names).await;
            }
            tokio::time::sleep(Duration::from_secs(900)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deezer answers 0 for "no data" as readily as for "nobody", and a panel
    /// that prints "0 fans" is stating something it does not know.
    #[test]
    fn zero_is_not_a_fact() {
        assert_eq!(positive(Some(0)), None);
        assert_eq!(positive(None), None);
        assert_eq!(positive(Some(1)), Some(1));
    }

    /// Two decks dealing the same artist must not both go and fetch them.
    #[test]
    fn an_artist_is_claimed_once() {
        let keys = vec!["claimtest one".to_string(), "claimtest two".to_string()];
        let first = claim(&keys);
        assert_eq!(first.len(), 2);
        let second = claim(&keys);
        assert!(second.is_empty(), "a claimed artist must not be handed out twice");
        release(&keys);
        assert_eq!(claim(&keys).len(), 2);
        release(&keys);
    }
}
