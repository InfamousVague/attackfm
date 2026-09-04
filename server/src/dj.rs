//! The DJ: a continuous, steerable set drawn from the listener's OWN library,
//! with a lightweight model writing the patter between runs of tracks - the
//! shape of a radio station, not a static playlist.
//!
//! Track SELECTION happens here in Rust, off the same taste/score the curator
//! uses, so the DJ agrees with the rest of the recommendations. The model only
//! writes WORDS, over a compact already-chosen list, which is why it can use a
//! smaller/faster model than the offline curator (`AFM_DJ_MODEL`) and still feel
//! live. A free-text `seed` steers the whole thing - "something mellow for a
//! rainy morning" - by standing in for the listener's centroid.

use crate::ai::AiClient;
use crate::auth;
use crate::curator::cosine;
use crate::db::TrackFeatures;
use crate::taste::{self, UserTaste};
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use rand::Rng;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

/// At most this many from one artist, so the DJ never gets stuck on a favourite.
const PER_ARTIST_CAP: usize = 2;
/// How many recent plays define "lately" and get held back from the set.
const RECENT_WINDOW: i64 = 80;

/// How wide the rank-weighted draw's head is, in multiples of the set. Six
/// was a near-uniform shuffle of ninety songs over a ranking whose whole
/// spread is a few hundredths; three keeps the press fresh without making
/// seat 1 and seat 45 the same odds - the listener's word for six was "too
/// random".
const DRAW_HEAD: usize = 3;

/// Jitter is only added when the ranking actually has a spread to jitter
/// WITHIN. On a flat ranking - every term degraded to neutral, or a library
/// with no vectors - the same ±0.02 IS the ranking, and the draw becomes a
/// shuffle wearing the taste's name.
const JITTER_SPREAD_FLOOR: f32 = 0.04;

/// How many unmet artists the exploration seats sample among: the most
/// relevant forty, by the same score the rest of the set is ranked on. The
/// Beta draw still decides between them - it is exploration - but inside a
/// pool that is connected to what the listener likes, never a coin flip over
/// every stranger in the library.
const EXPLORE_POOL: usize = 40;

/// How close a dealt song's MEASURED sound must sit to a hearted song's
/// before the card may say "sounds like {that artist}". The fingerprint is
/// derived from the recording; the sonic vector embeds prose about it, and
/// two songs DESCRIBED alike sit close in that space however differently
/// they sound - so the prose floor is higher.
const SOUNDS_LIKE_FINGERPRINT: f32 = 0.85;
const SOUNDS_LIKE_SONIC: f32 = 0.92;

/// The lightest artist affinity that reads as "you finish their songs".
const FINISHES_FLOOR: f32 = 0.15;

/// Why one song was dealt, in facts - the map `/api/dj` and `/api/radio`
/// return as `why`, and the neighbour line the patter dossier carries.
///
/// Every reason here is a real anchor or a measured fact: the seat it took,
/// a heart on file, the listener's own completions of that artist, a
/// ListenBrainz edge to an artist they like, a measured closeness to a song
/// they hearted. No model writes any of it, which is what lets the client
/// put a "not this reason" button beside each one and post the answer back
/// to a scope the harvesters actually read.
pub(crate) struct Why<'a> {
    taste: &'a UserTaste,
    /// Track ids they hearted.
    liked: &'a HashSet<i64>,
    /// Artists they hearted a song by, lowercased as `hearted_artist_keys`
    /// spells them.
    hearted: &'a HashSet<String>,
    /// MusicBrainz id -> display name, for the artists they like.
    liked_mbids: HashMap<String, String>,
    /// A liked artist's ListenBrainz neighbour's mbid -> that liked artist.
    neighbours_of_liked: HashMap<String, String>,
    /// (artist lowercased, artist as spelled, vector, is_fingerprint) for
    /// every hearted song that carries a sound vector.
    liked_sound: Vec<(String, String, Vec<f32>, bool)>,
}

impl<'a> Why<'a> {
    pub(crate) fn build(
        taste: &'a UserTaste,
        feats: &[TrackFeatures],
        liked: &'a HashSet<i64>,
        hearted: &'a HashSet<String>,
    ) -> Why<'a> {
        let mut liked_mbids = HashMap::new();
        let mut neighbours_of_liked = HashMap::new();
        let mut liked_sound = Vec::new();
        for f in feats {
            let lower = f.artist.to_lowercase();
            let likes_artist = hearted.contains(&lower)
                || taste.artists.get(&taste::artist_key(&f.artist)).map_or(false, |a| *a > 0.0);
            if likes_artist {
                if !f.musicbrainz_id.is_empty() {
                    liked_mbids.entry(f.musicbrainz_id.clone()).or_insert_with(|| f.artist.clone());
                }
                for m in &f.listenbrainz_similar {
                    neighbours_of_liked.entry(m.clone()).or_insert_with(|| f.artist.clone());
                }
            }
            if liked.contains(&f.track_id) {
                if let Some(v) = f.audio_fingerprint.as_ref() {
                    liked_sound.push((lower.clone(), f.artist.clone(), v.clone(), true));
                } else if let Some(v) = f.sonic_vec.as_ref() {
                    liked_sound.push((lower.clone(), f.artist.clone(), v.clone(), false));
                }
            }
        }
        Why { taste, liked, hearted, liked_mbids, neighbours_of_liked, liked_sound }
    }

    /// The liked artist this song is next door to on ListenBrainz, either
    /// direction: its own neighbours include one of theirs, or it is on a
    /// liked artist's neighbour list. None when it is nobody's neighbour.
    pub(crate) fn scene_neighbour(&self, f: &TrackFeatures) -> Option<String> {
        let own = taste::artist_key(&f.artist);
        f.listenbrainz_similar
            .iter()
            .filter_map(|m| self.liked_mbids.get(m))
            .chain(
                (!f.musicbrainz_id.is_empty())
                    .then(|| self.neighbours_of_liked.get(&f.musicbrainz_id))
                    .flatten(),
            )
            .find(|name| taste::artist_key(name) != own)
            .cloned()
    }

    /// The hearted song's artist this one measures closest to, when it is
    /// close enough to say so and is somebody else.
    fn sounds_like(&self, f: &TrackFeatures) -> Option<String> {
        let own = f.artist.to_lowercase();
        let mut best: Option<(f32, &str)> = None;
        for (lower, name, v, is_fp) in &self.liked_sound {
            if *lower == own {
                continue;
            }
            let (mine, floor) = if *is_fp {
                (f.audio_fingerprint.as_ref(), SOUNDS_LIKE_FINGERPRINT)
            } else {
                (f.sonic_vec.as_ref(), SOUNDS_LIKE_SONIC)
            };
            let Some(mine) = mine.filter(|m| m.len() == v.len()) else { continue };
            let c = cosine(mine, v);
            if c >= floor && best.map_or(true, |(b, _)| c > b) {
                best = Some((c, name.as_str()));
            }
        }
        best.map(|(_, name)| name.to_string())
    }

    /// The one reason this song is in front of them, or None when nothing
    /// provable applies - in which case the card says nothing rather than
    /// something a model made up.
    pub(crate) fn of(&self, f: &TrackFeatures, explore: bool) -> Option<String> {
        if explore {
            return Some("explore".into());
        }
        let lower = f.artist.to_lowercase();
        if self.liked.contains(&f.track_id) || self.hearted.contains(&lower) {
            return Some("hearted before".into());
        }
        if self.taste.artists.get(&taste::artist_key(&f.artist)).map_or(false, |a| *a >= FINISHES_FLOOR) {
            return Some(format!("you finish {}", f.artist.trim()));
        }
        if let Some(name) = self.scene_neighbour(f) {
            return Some(format!("same scene as {name}"));
        }
        if let Some(name) = self.sounds_like(f) {
            return Some(format!("sounds like {name}"));
        }
        None
    }
}

/// The `why` map for a dealt list: track id -> reason, ids with no
/// provable reason left out.
pub(crate) fn why_map(
    why: &Why<'_>,
    picks: &[i64],
    by_id: &HashMap<i64, &TrackFeatures>,
    explore: &HashSet<i64>,
) -> serde_json::Map<String, Value> {
    picks
        .iter()
        .filter_map(|id| {
            let f = by_id.get(id)?;
            why.of(f, explore.contains(id)).map(|w| (id.to_string(), json!(w)))
        })
        .collect()
}

/// A tempo as a DJ would say it - the bucket, and the number.
pub(crate) fn bpm_bucket(bpm: f64) -> String {
    let n = bpm.round() as i64;
    let word = if bpm < 90.0 {
        "slow"
    } else if bpm < 120.0 {
        "mid-tempo"
    } else if bpm < 140.0 {
        "upbeat"
    } else {
        "fast"
    };
    format!("{word}, around {n} bpm")
}

/// Whether `needle` appears in `hay` as a whole word (both already
/// lowercased): not inside another word, so "low" does not fire on "slow".
fn contains_word(hay: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(at) = hay[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let before_ok = start == 0 || !hay[..start].chars().next_back().map_or(false, char::is_alphanumeric);
        let after_ok = end >= hay.len() || !hay[end..].chars().next().map_or(false, char::is_alphanumeric);
        if before_ok && after_ok {
            return true;
        }
        from = start + needle.len().max(1);
        if from >= hay.len() {
            break;
        }
    }
    false
}

/// The post-check on a spoken line: every year it names must be in the
/// facts it was handed, and every library artist or album it names must be
/// one of THIS run's - a name from elsewhere on the shelf is the model
/// reaching for what it remembers. `allowed` is the run's lines and facts;
/// `names` the library's artist and album names, lowercased, the short ones
/// already dropped. Dumb on purpose: see ai.rs.
pub(crate) fn grounded_line(say: &str, allowed: &str, names: &[String]) -> bool {
    if !crate::ai::years_grounded(say, allowed) {
        return false;
    }
    let say = say.to_lowercase();
    let allowed = allowed.to_lowercase();
    !names.iter().any(|n| contains_word(&say, n) && !allowed.contains(n.as_str()))
}

/// The library's artist and album names the patter check reads: lowercased,
/// deduped, and only the ones long enough that a hit means the name and
/// not a word ("Low", "Air" and "Yes" are all bands).
fn known_names(feats: &[TrackFeatures], albums: Vec<String>) -> Vec<String> {
    let mut out: HashSet<String> = HashSet::new();
    for name in feats.iter().map(|f| f.artist.as_str()).chain(albums.iter().map(String::as_str)) {
        let n = name.trim().to_lowercase();
        if n.chars().count() >= 5 {
            out.insert(n);
        }
    }
    out.into_iter().collect()
}

/// Whether one track may be dealt to this listener at all - the guard every
/// dealing surface applies before it scores anything.
///
/// Two leaks this closes: an audiobook chapter is not a song, whatever its
/// vectors say; and an audition the collector fetched for SOMEBODY ELSE is
/// theirs to judge, not a stranger's to hear first. The listener's own
/// unadopted auditions pass - those are the door into their sets that the
/// exploration seats exist to open.
pub(crate) fn dealable(f: &TrackFeatures, user: i64) -> bool {
    f.kind != "book" && !(f.quarantined && f.curator_user_id != Some(user))
}

/// The time-of-day tilt, lightly: how far to move the energy target (0-1) and
/// the tempo target (bpm) for a client-local hour. Late night leans down,
/// the morning leans up a little, and the rest of the day is left alone.
/// Windows are half-open: 22:00 up to 05:00, 07:00 up to 10:00.
pub(crate) fn hour_nudge(hour: Option<u32>) -> (f64, f64) {
    match hour {
        Some(22..=23) | Some(0..=4) => (-0.10, -8.0),
        Some(7..=9) => (0.05, 5.0),
        _ => (0.0, 0.0),
    }
}

/// The exploration seats' draw: Thompson sampling over per-artist adoption,
/// weighed by relevance, inside the most relevant `EXPLORE_POOL` artists.
///
/// `candidates` is one row per unmet artist - (artist key, relevance of its
/// best track, that track) - and `stats` the sampler's ledger of (offers,
/// adopted) per artist. `sample(a, b)` draws from Beta(a, b); it is passed in
/// so a test can hand the sampler a fixed hand and check the ORDER the seats
/// come out in, which is the thing that was wrong.
///
/// The sort key is `draw × relevance`, not the draw alone: an artist the
/// listener has never been offered still carries the uniform prior and its
/// full share of hope, but a lucky draw for an artist nothing connects to
/// no longer beats a fair draw for one that fits.
pub(crate) fn explore_order(
    mut candidates: Vec<(String, f32, i64)>,
    stats: &HashMap<String, (i64, i64)>,
    n: usize,
    sample: &mut dyn FnMut(f64, f64) -> f64,
) -> Vec<i64> {
    candidates.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(EXPLORE_POOL);
    let mut sampled: Vec<(f64, i64)> = candidates
        .into_iter()
        .map(|(key, relevance, id)| {
            let (offers, adopted) = stats.get(&key).copied().unwrap_or((0, 0));
            let a = 1.0 + adopted as f64;
            let b = 1.0 + (offers - adopted).max(0) as f64;
            (sample(a, b) * f64::from(relevance.max(0.0)), id)
        })
        .collect();
    sampled.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(std::cmp::Ordering::Equal));
    sampled.into_iter().take(n).map(|(_, id)| id).collect()
}

/// The tracks a literal station admits, or None when the filter is not one
/// the DJ knows (the seed alone steers, as before).
///
/// A station used to be a phrase and nothing else: "songs I have never
/// played" was EMBEDDED as a sonic target and the set was whatever sounded
/// like that sentence, played or not. These three mean what they say:
///
///   unplayed     never played by this listener - the same rule the Home
///                shelf's `unplayed` uses, so the two cannot disagree.
///   genre:{g}    carries the tag, in the file genre or the enricher's.
///   artist:{a}   the artist's own songs and their ListenBrainz neighbours,
///                either direction - "and the road out". With no
///                neighbourhood on file the filter is released rather than
///                dealing two songs and calling it a station.
fn station_filter(
    db: &crate::db::Db,
    user: i64,
    filter: &str,
    feats: &[TrackFeatures],
) -> Option<HashSet<i64>> {
    let filter = filter.trim();
    if filter.eq_ignore_ascii_case("unplayed") {
        return Some(db.unplayed(user, i64::MAX).into_iter().collect());
    }
    if let Some(genre) = filter.strip_prefix("genre:") {
        let want = genre.trim().to_lowercase();
        if want.is_empty() {
            return None;
        }
        return Some(
            feats
                .iter()
                .filter(|f| taste::tags_of(f).iter().any(|t| *t == want))
                .map(|f| f.track_id)
                .collect(),
        );
    }
    if let Some(artist) = filter.strip_prefix("artist:") {
        let want = taste::artist_key(artist);
        if want.is_empty() {
            return None;
        }
        let own: Vec<&TrackFeatures> =
            feats.iter().filter(|f| taste::artist_key(&f.artist) == want).collect();
        let mbids: HashSet<&str> = own
            .iter()
            .map(|f| f.musicbrainz_id.as_str())
            .filter(|m| !m.is_empty())
            .collect();
        let neighbours: HashSet<&str> = own
            .iter()
            .flat_map(|f| f.listenbrainz_similar.iter().map(String::as_str))
            .collect();
        let pool: HashSet<i64> = feats
            .iter()
            .filter(|f| {
                taste::artist_key(&f.artist) == want
                    || (!f.musicbrainz_id.is_empty() && neighbours.contains(f.musicbrainz_id.as_str()))
                    || f.listenbrainz_similar.iter().any(|m| mbids.contains(m.as_str()))
            })
            .map(|f| f.track_id)
            .collect();
        return (pool.len() > own.len()).then_some(pool);
    }
    None
}

/// Apply the tilt to a taste's own targets. Only the centres move; the
/// spreads - how sure the model is - are not the hour's business.
pub(crate) fn nudge_for_hour(taste: &mut UserTaste, hour: Option<u32>) {
    let (d_energy, d_tempo) = hour_nudge(hour);
    if d_energy == 0.0 && d_tempo == 0.0 {
        return;
    }
    if let Some((mid, spread)) = taste.tempo {
        taste.tempo = Some(((mid + d_tempo).clamp(40.0, 220.0), spread));
    }
    if let Some((mid, spread)) = taste.energy {
        taste.energy = Some(((mid + d_energy).clamp(0.0, 1.0), spread));
    }
}

/// How long the patter model may hold the reply. Past this the set ships
/// with library lines; the voice never needed the model at all.
const PATTER_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

/// How long a dealt song sits out of the taste set. Three days: long enough
/// that a week of presses reads as a DJ with range, short enough that a small
/// library is not starved - the hold graduates, see dealt_hold.
pub(crate) const TASTE_DEALT_WINDOW_MS: i64 = 72 * 60 * 60 * 1000;

/// The songs to hold back because they were dealt lately - with a FLOOR.
///
/// The all-or-nothing release this replaces ("hold everything dealt in the
/// window, unless that would starve the table, then hold nothing") had a
/// cliff: a heavy presser on a big library could flip the whole ledger off
/// at once, and from then on nothing but jitter separated two presses. So
/// the newest `want` dealt songs are held UNCONDITIONALLY - the set you just
/// got can never be the set you get next, whatever the library's size - and
/// older deals are held only while `pool` can spare them, oldest released
/// first.
pub(crate) fn dealt_hold(
    db: &crate::db::Db,
    user: i64,
    window_ms: i64,
    want: usize,
    pool: usize,
) -> HashSet<i64> {
    let dealt = db.dj_dealt_since(user, crate::db::now_ms() - window_ms);
    let mut held: HashSet<i64> = HashSet::new();
    for (i, (id, _)) in dealt.iter().enumerate() {
        if i < want || pool > held.len() + want * 2 {
            held.insert(*id);
        } else {
            break;
        }
    }
    held
}

/// The draw, not the top: a rank-weighted lottery over a wide head, so closer
/// to the top is still likelier but every press shuffles the deal - seat 1 is
/// ~6x likelier than seat 90. `ranked` best first; the result in drawn order.
/// Shared by the taste set and the chart / new-music doors.
pub(crate) fn weighted_draw(ranked: Vec<(f32, i64)>, head: usize) -> Vec<(f32, i64)> {
    use rand_distr::Distribution;
    let head: Vec<(f32, i64)> = ranked.into_iter().take(head).collect();
    let mut rng = rand::thread_rng();
    let mut drawn: Vec<(f64, (f32, i64))> = head
        .into_iter()
        .enumerate()
        .map(|(i, row)| {
            let weight = 1.0 / (1.0 + i as f64 / 15.0);
            let p: f64 = rand_distr::Uniform::new(0.0f64, 1.0).sample(&mut rng);
            (p.powf(1.0 / weight), row)
        })
        .collect();
    drawn.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    drawn.into_iter().map(|(_, row)| row).collect()
}

/// Runs cut by hand when the model is absent or over budget: the same shape
/// the patter aims for, minus the prose. Seats mirror the voice layer's own
/// choice (opener, turns, a closer once there is more than one run).
fn fallback_blocks(state: &Arc<AppState>, picks: &[i64]) -> Vec<Value> {
    let chunks: Vec<&[i64]> = picks.chunks(3).collect();
    let last = chunks.len().saturating_sub(1);
    chunks
        .iter()
        .enumerate()
        .map(|(i, chunk)| json!({ "say": plain_line(state, seat_at(i, last), chunk[0]), "trackIds": chunk }))
        .collect()
}

/// Which seat a run at index `i` of `last + 1` takes: the voice layer's own
/// choice - an opener, a closer once there is more than one run, turns
/// between.
fn seat_at(i: usize, last: usize) -> crate::voice::Seat {
    if i == 0 {
        crate::voice::Seat::Opener
    } else if i == last && last > 0 {
        crate::voice::Seat::Closer
    } else {
        crate::voice::Seat::Turn
    }
}

/// The plain line for a run: the voice's own library line plus the lead
/// artist's name - the toast shows exactly the words the voice speaks. What
/// a run says when the model is absent, over budget, or caught claiming.
fn plain_line(state: &Arc<AppState>, seat: crate::voice::Seat, lead: i64) -> String {
    let artist = state
        .db
        .titles_for(&[lead])
        .first()
        .map(|(artist, _)| artist.clone())
        .unwrap_or_default();
    let line = crate::voice::line_for(seat, &artist);
    if artist.trim().is_empty() {
        line
    } else {
        format!("{line} {artist}.")
    }
}

const TRAIT_CACHE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Trait extraction is optional polish around an already enriched track. Keep
/// its deadline comfortably below the Booth's 90-second request deadline so a
/// busy or looping local model can never turn "choose the sound" into a client
/// timeout; the canonical enrichment-backed fallback remains useful on its own.
const TRAIT_AI_DEADLINE: Duration = Duration::from_secs(45);
/// Per-generation movement for close matches. Four percentage points peak to
/// peak changes ordering inside a quality tier without letting a weak match
/// leapfrog a clearly better one.
const QUEUE_SCORE_JITTER: f32 = 0.02;

/// The station's blend, mirroring the trait queue's shape: semantic families
/// carry the set, personal signals season it. The two invariants the unit
/// test pins: each family group sums to 1, and the semantic share outweighs
/// the personal share - a station should sound like a TASTE, not a history.
///
/// Where the audio and community families went. The semantic family used to
/// be four cosines against four hand-built centroids - sonic, audio
/// fingerprint, lyric, community - averaged over the last eighty plays with
/// every skip weighing as much as every completion. The taste model now owns
/// the centroids (verdict-weighted, decayed, surface-aware), and it carries
/// the measured "sounds similar" (texture, energy, tempo) and the "same
/// scene" (the artists they return to, and their ListenBrainz neighbours)
/// as terms of its own score - so the history term is where those families
/// live now, and its share grew to match. Semantic still outweighs personal.
const STATION_SEM_SONIC: f32 = 0.60;
const STATION_SEM_LYRIC: f32 = 0.40;
const STATION_W_SEM: f32 = 0.56;
const STATION_W_HISTORY: f32 = 0.30;
const STATION_W_LIKE: f32 = 0.09;
const STATION_W_COLLAB: f32 = 0.05;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DjTrait {
    pub id: String,
    pub label: String,
    pub category: String,
    pub description: String,
    pub weight: f32,
    pub confidence: f32,
    pub query: String,
    #[serde(default)]
    pub signals: TraitSignals,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraitSignals {
    pub energy: Option<f32>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
    pub year_min: Option<i64>,
    pub year_max: Option<i64>,
    #[serde(default)]
    pub genres: Vec<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraitAnalysis {
    summary: String,
    traits: Vec<DjTrait>,
}

#[derive(Clone)]
struct CachedAnalysis {
    at: i64,
    value: TraitAnalysis,
}

static TRAIT_CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, CachedAnalysis>>> = OnceLock::new();

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
pub(crate) fn ai_url() -> Option<String> {
    let url = crate::ai::setting("url", "AFM_AI_URL")?;
    if dj_model().trim().is_empty() {
        return None;
    }
    Some(url)
}

/// The DJ's model. Separate from the offline curator's on purpose: the DJ answers
/// a listener who is waiting, so it wants a small fast model, while curation runs
/// in the background and can afford a big one.
pub(crate) fn dj_model() -> String {
    crate::ai::setting("djModel", "AFM_DJ_MODEL")
        // Then whatever model this box was actually set up with. home-install.sh
        // writes AFM_AI_MODEL and never AFM_DJ_MODEL, so a literal default asked
        // for a model nobody had pulled - and because the feed's `ai` flag is
        // just "a URL is set", that failure was indistinguishable from having no
        // AI at all. Empty is honest; a guess is not.
        .or_else(|| crate::ai::setting("chatModel", "AFM_AI_MODEL"))
        .unwrap_or_default()
}

fn embed_model() -> String {
    std::env::var("AFM_AI_EMBED_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "nomic-embed-text".to_string())
}

/// Embed a free-text vibe so the set can be steered toward it rather than only
/// mirroring what was played last.
async fn embed(text: &str) -> Option<Vec<f32>> {
    let url = ai_url()?;
    let reply: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .ok()?
        .post(format!("{}/v1/embeddings", url.trim_end_matches('/')))
        .json(&json!({ "model": embed_model(), "input": text }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let arr = reply.pointer("/data/0/embedding")?.as_array()?;
    let v: Vec<f32> = arr
        .iter()
        .filter_map(|x| x.as_f64())
        .map(|x| x as f32)
        .collect();
    (v.len() >= 32).then_some(v)
}

#[derive(serde::Deserialize)]
pub struct DjQuery {
    /// A free-text vibe to steer toward. Empty = mirror recent listening.
    #[serde(default)]
    pub seed: String,
    /// How many tracks to hand back (clamped to a sane range).
    #[serde(default)]
    pub count: Option<usize>,
    /// The listener's LOCAL hour, 0-23, for the light time-of-day tilt. The
    /// server does not know their timezone, so the client says. Optional: an
    /// older client sends nothing and gets no tilt.
    #[serde(default)]
    pub hour: Option<u32>,
    /// A hard constraint on the pool, from a station that means something
    /// literal: `unplayed`, `genre:{g}` or `artist:{a}`. The seed still
    /// steers inside it. See `station_filter`.
    #[serde(default)]
    pub filter: Option<String>,
}

/// `GET /api/dj?seed=&count=&hour=&filter=` - a continuous DJ set: runs of the
/// listener's own tracks with the DJ's spoken-style patter between them. The
/// client plays each block's tracks after showing its line, and calls again to
/// keep the set going.
pub async fn station(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DjQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let want = q.count.unwrap_or(15).clamp(6, 30);
    let seed = q.seed.trim().to_string();

    /*
     * Every press builds LIVE, by explicit request (2026-08-31): the banked
     * sets bought the model judgement but killed the variety - a curated
     * build is deliberately jitter-free over the same taste scores, so
     * yesterday's set and today's dealt nearly the same songs, and a press
     * served a copy made hours ago. Real-time selection with a dealt-lately
     * exclusion and a weighted draw (build_reply below) is what makes two
     * presses two different sets. The vibes module is parked, not deleted -
     * see its header - and charts stays a live door because the chart
     * itself is one catalogue fetch.
     */
    if q.count.is_none() {
        // The two catalogue doors that stay live: no model, no taste maths,
        // and cheap enough to build on the press. Either coming up empty falls
        // through to a taste set rather than serving a shrug.
        let live = match crate::vibes::key_for_seed(&seed) {
            Some("charts") => Some(crate::vibes::build_charts_reply(&state, caller.id, false).await),
            Some("newmusic") => {
                Some(crate::vibes::build_new_music_reply(&state, caller.id, false).await)
            }
            _ => None,
        };
        if let Some(body) = live {
            let has = body
                .get("blocks")
                .and_then(|b| b.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if has {
                return Ok(Json(body));
            }
        }
    }

    let ask = Ask { seed: &seed, want, curate: false, hour: q.hour, filter: q.filter.as_deref() };
    let reply = build_reply(&state, caller.id, &ask).await?;
    Ok(Json(reply))
}

/// What one press asks for, so the builder's signature does not grow a
/// positional argument per feature.
pub(crate) struct Ask<'a> {
    pub seed: &'a str,
    pub want: usize,
    /// The offline mode - twice the candidates, no jitter, the model
    /// unhurried and allowed to DROP what does not fit; live keeps the tight
    /// budget and ships whatever is ready.
    pub curate: bool,
    /// Client-local hour, when the client said.
    pub hour: Option<u32>,
    /// A literal constraint on the pool, when the station has one.
    pub filter: Option<&'a str>,
}

/// The whole set, built: picks scored against taste, runs cut, lines written,
/// voice promised. What was asked for - seed, size, the hour, a station's
/// constraint, and whether this is the unhurried offline build - is `Ask`.
pub(crate) async fn build_reply(
    state: &Arc<AppState>,
    user: i64,
    ask: &Ask<'_>,
) -> Result<Value, (StatusCode, String)> {
    let seed = ask.seed.to_string();
    let want = ask.want;
    let curate = ask.curate;

    /*
     * The listener's model - the same one discovery and the mixes read.
     *
     * The station used to build its own: an unweighted average of the last
     * eighty plays, in which a song skipped at eight seconds pulled the
     * centre exactly as hard as one finished and hearted, and the last of
     * the three old terms (lyric / median bpm / genre string) as the history.
     * `UserTaste` is verdict-weighted with a three-week half-life, knows
     * which surface each play came from, keeps a rejected set, and scores
     * the measured "sounds similar", the "same scene" and the "same era" the
     * listener named as what makes a new song feel connected. A listener the
     * ledger has nothing on gets the cold model: every term neutral, the set
     * an honest draw rather than an error.
     */
    let (mut taste, feats) = match crate::curator::user_taste_for(state, user) {
        Some(built) => built,
        None => (UserTaste::cold(user), state.db.all_features()),
    };
    nudge_for_hour(&mut taste, ask.hour);
    let by_id: HashMap<i64, &TrackFeatures> = feats.iter().map(|f| (f.track_id, f)).collect();

    // A seed steers the set. It used to stand in for the LYRIC centroid -
    // "something mellow" compared against what songs say rather than how they
    // sound. The sonic vectors live in the same text-embedding space as the
    // seed, so the seed now steers the sonic term, which is what a vibe is.
    let mut seed_vec: Option<Vec<f32>> = None;
    if !seed.is_empty() {
        seed_vec = embed(&seed).await;
    }

    // A station with a literal meaning constrains the pool before anything
    // is scored; the seed still steers inside it.
    let constrained: Option<HashSet<i64>> =
        ask.filter.and_then(|f| station_filter(&state.db, user, f, &feats));
    let within = |f: &TrackFeatures| constrained.as_ref().map_or(true, |s| s.contains(&f.track_id));

    /*
     * Score the whole library, hold back the very-recently-played so the DJ
     * does not replay the last hour, and cap per artist. The DEALT ledger
     * joins the hold: anything a set offered in the last three days sits out,
     * so consecutive presses cannot deal the same hand - unless the library
     * is small enough that the exclusion would empty the table, in which
     * case variety honestly costs repeats and the hold is released.
     *
     * So does the listener's NO. `taste.rejected` is what they pushed away
     * hard enough to count (an instant skip on a machine pick, not a late
     * bail); the discovery rejections are the dismiss button on a card, at
     * song or artist scope. Neither reached this surface before, so a song
     * refused on the Discover shelf could be dealt back the same evening.
     */
    let mut held: HashSet<i64> = state.db.recent_plays(user, RECENT_WINDOW).into_iter().collect();
    held.extend(taste.rejected.iter().copied());
    held.extend(crate::discovery::rejected_track_ids(&state.db, user));
    let library_size = feats.iter().filter(|f| dealable(f, user) && within(f)).count();
    held.extend(dealt_hold(&state.db, user, TASTE_DEALT_WINDOW_MS, want, library_size));

    /*
     * The blend: the two centroid terms as the semantic family, the whole
     * taste score as the history, hearts and ListenBrainz edges as the
     * seasoning. A term a track cannot answer scores as an AVERAGE track
     * would (`taste.neutral`), not as 0.5 - real cosines sit far above 0.5,
     * so 0.5 turned "has been enriched" into a ranking signal, and the
     * enriched pool is exactly the pool the machine pushed at them.
     *
     * The seed replaces the sonic centroid, so its neutral is computed the
     * same way: the library's typical closeness to the seed.
     */
    let half = |c: f32| (c + 1.0) / 2.0;
    let seed_neutral: f32 = seed_vec
        .as_deref()
        .map(|q| {
            let close: Vec<f32> = feats
                .iter()
                .filter_map(|f| f.sonic_vec.as_deref())
                .map(|v| half(cosine(q, v)))
                .collect();
            if close.is_empty() {
                0.5
            } else {
                close.iter().sum::<f32>() / close.len() as f32
            }
        })
        .unwrap_or(0.5);
    // The ListenBrainz neighbours of the artists they LIKE - a positive
    // affinity, so a hundred skips of one band no longer make its neighbours
    // "collaborative" matches.
    let collaborative_edges: HashSet<&str> = feats
        .iter()
        .filter(|f| taste.artists.get(&taste::artist_key(&f.artist)).map_or(false, |a| *a > 0.0))
        .flat_map(|f| f.listenbrainz_similar.iter().map(String::as_str))
        .collect();
    let liked: HashSet<i64> = state.db.favorites(user).into_iter().collect();

    // One track's honest relevance, jitter-free. Shared by the ranked pool
    // and the exploration seats, so a gamble is judged by the same ear as a
    // safe pick.
    let relevance_of = |f: &TrackFeatures| -> f32 {
        let t = taste::terms(f, &taste);
        let sonic = match (seed_vec.as_deref(), &f.sonic_vec) {
            (Some(q), Some(v)) => half(cosine(q, v)),
            (Some(_), None) => seed_neutral,
            (None, _) => t[taste::TERM_SONIC],
        };
        let sem = STATION_SEM_SONIC * sonic + STATION_SEM_LYRIC * t[taste::TERM_LYRIC];
        let history = taste::score_of(&t, &taste);
        let like = if liked.contains(&f.track_id) { 1.0 } else { 0.0 };
        let collab = if !f.musicbrainz_id.is_empty()
            && collaborative_edges.contains(f.musicbrainz_id.as_str())
        {
            1.0
        } else {
            0.0
        };
        STATION_W_SEM * sem
            + STATION_W_HISTORY * history
            + STATION_W_LIKE * like
            + STATION_W_COLLAB * collab
    };

    let mut ranked: Vec<(f32, i64)> = feats
        .iter()
        // `!quarantined` is the same clause the trait queue applies: an
        // audition under quarantine is a judgement not yet made, and the
        // DB's own invariant says it must never seed a mix. (The exploration
        // seats below are the one door the listener's OWN auditions get.)
        .filter(|f| {
            !held.contains(&f.track_id) && !f.quarantined && f.kind != "book" && within(f)
        })
        .map(|f| (relevance_of(f), f.track_id))
        .collect();
    // Curation wants the honest ranking; the live path keeps a shake of
    // jitter so back-to-back presses do not repeat - but only when there is a
    // ranking underneath it to shake.
    if !curate {
        let (lo, hi) = ranked
            .iter()
            .fold((f32::MAX, f32::MIN), |(lo, hi), (s, _)| (lo.min(*s), hi.max(*s)));
        if ranked.len() > 1 && hi - lo > JITTER_SPREAD_FLOOR {
            let mut rng = rand::thread_rng();
            for row in ranked.iter_mut() {
                row.0 += rng.gen_range(-QUEUE_SCORE_JITTER..=QUEUE_SCORE_JITTER);
            }
        }
    }
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    /*
     * The draw, not the top: a deterministic head of this ranking is the
     * same set every press ("not randomizing", by report). The picks are a
     * weighted sample over a head instead - closer to the top is still
     * likelier, but every press shuffles the deal - which, with the dealt
     * ledger above, is what "generate it fresh" actually means.
     */
    let ranked: Vec<(f32, i64)> = weighted_draw(ranked, want * DRAW_HEAD);

    let artist_of: HashMap<i64, String> = feats
        .iter()
        .map(|f| (f.track_id, f.artist.to_lowercase()))
        .collect();
    let mut picks: Vec<i64> = Vec::new();
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    for (_s, id) in ranked {
        let key = artist_of.get(&id).cloned().unwrap_or_default();
        let c = per_artist.entry(key).or_insert(0);
        if *c >= PER_ARTIST_CAP {
            continue;
        }
        *c += 1;
        picks.push(id);
        // Offline the model gets a wider pool and the right to drop; live
        // takes exactly what will play. Wider, not double: thirty dossiers
        // was a prompt the hub's CPU model could not finish even unhurried.
        if picks.len() >= if curate { want + 6 } else { want } {
            break;
        }
    }
    if picks.is_empty() {
        return Ok(json!({ "ai": false, "vibe": seed, "blocks": [] }));
    }

    /*
     * The exploration slots: two of the set are a considered gamble.
     *
     * A recommender with one listener collapses onto what it already plays -
     * nothing new is ever offered, so nothing new is ever adopted, so nothing
     * new is ever scored. These slots are the structural fix: a couple of
     * positions go to artists the listener has never met (their OWN
     * quarantined auditions included - this is the deliberate door into sets
     * that replaces the accident Phase 0 closed), chosen by Thompson sampling
     * over per-artist adoption. An artist whose offers keep getting finished
     * or hearted wins slots more often; one that keeps getting skipped fades
     * without ever being banned; one never offered at all carries the uniform
     * prior and its full share of hope.
     *
     * Inside a CONNECTED pool. The sample used to run over every unmet
     * artist in the library with the taste score thrown away, so for a
     * never-offered artist - Beta(1,1), uniform - the seat went to a
     * uniformly random stranger: the listener's "too random", twice per set,
     * early. Now each artist's best track is judged by the same relevance as
     * the rest of the set, only the most relevant forty are sampled, and the
     * draw is weighed by relevance (see `explore_order`).
     *
     * Artist-level arms, never track-level: at one household's data size,
     * track arms would never converge on anything.
     */
    let explore_n: usize = if want >= 12 { 2 } else { 1 };
    let explore_picks: Vec<i64> = {
        use rand_distr::Distribution;
        let played = state.db.played_artist_keys(user);
        let taken: HashSet<String> =
            picks.iter().filter_map(|id| artist_of.get(id).cloned()).collect();
        let stats: HashMap<String, (i64, i64)> = state
            .db
            .explore_artist_stats(user)
            .into_iter()
            .map(|(a, offers, adopted)| (a, (offers, adopted)))
            .collect();
        // Candidates: best track per unmet artist, judged by the same blend.
        let mut best: HashMap<String, (f32, i64)> = HashMap::new();
        // The dealt hold applies here too: these seats used to be the one
        // door the ledger never guarded, and "best track per artist" is a
        // fixed answer - an artist that won a seat twice brought the same
        // song both times. Held out, the artist returns with its next-best.
        for f in feats.iter() {
            let key = f.artist.to_lowercase();
            if key.is_empty()
                || !dealable(f, user)
                || !within(f)
                || played.contains(&key)
                || taken.contains(&key)
                || held.contains(&f.track_id)
            {
                continue;
            }
            let sc = relevance_of(f);
            let e = best.entry(key).or_insert((sc, f.track_id));
            if sc > e.0 {
                *e = (sc, f.track_id);
            }
        }
        let mut rng = rand::thread_rng();
        let candidates: Vec<(String, f32, i64)> =
            best.into_iter().map(|(key, (sc, id))| (key, sc, id)).collect();
        explore_order(candidates, &stats, explore_n, &mut |a, b| {
            rand_distr::Beta::new(a, b).map(|d| d.sample(&mut rng)).unwrap_or(0.5)
        })
    };
    // Seated mid-set, not opening it: position 3 and position 10 - deep
    // enough that the set has established itself, early enough to be heard.
    let explore_set: HashSet<i64> = explore_picks.iter().copied().collect();
    for (n, id) in explore_picks.into_iter().enumerate() {
        let at = (3 + n * 7).min(picks.len());
        picks.insert(at, id);
    }
    picks.truncate(want);

    // The offer ledger: what this set put in front of the listener. Adoption
    // is judged against these rows, per impression, not per catalog.
    let offered: Vec<(i64, &str, i64)> = picks
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, if explore_set.contains(id) { "explore" } else { "rank" }, i as i64))
        .collect();
    state.db.record_dj_impressions(user, &offered);

    /*
     * The dossiers: what the patter is ALLOWED to say about each pick.
     *
     * For exactly the small artists the exploration slots promote, the
     * model's world knowledge is empty or fabricated - so every fact the
     * patter may use is computed here, deterministically, from things the
     * retrieval layer knows to be true. The model's job is to phrase them,
     * never to add to them: grounded dossiers are the difference between a
     * sommelier and a confident liar.
     */
    /*
     * Every fact below is already in `by_id` or the taste: the file's year
     * and genre, the enricher's tags and one sonic trait, the measured
     * tempo, and the ListenBrainz edge to an artist they like. The lore
     * shelf (lore.rs) is model-recalled and is deliberately NOT here: it
     * is attached to the finished blocks, marked and hedged, after the
     * patter is written, so the patter can never repeat it as fact.
     */
    let hearted = state.db.hearted_artist_keys(user);
    let why = Why::build(&taste, &feats, &liked, &hearted);
    let dossiers: HashMap<i64, String> = picks
        .iter()
        .map(|id| {
            let mut facts: Vec<String> = Vec::new();
            if explore_set.contains(id) {
                facts.push("their first time in one of these sets".into());
            }
            if let Some(a) = artist_of.get(id) {
                if hearted.contains(a) {
                    facts.push("an artist this listener has hearted before".into());
                }
            }
            if let Some(f) = by_id.get(id) {
                if !f.genre.trim().is_empty() {
                    facts.push(format!("filed under {}", f.genre.trim()));
                }
                if let Some(y) = f.year.filter(|y| *y > 1900) {
                    facts.push(format!("released {y}"));
                }
                let tags: Vec<&str> = f
                    .ai_genres
                    .iter()
                    .chain(f.ai_specific_tags.iter())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .take(2)
                    .collect();
                if !tags.is_empty() {
                    facts.push(format!("tagged {}", tags.join(", ")));
                }
                if let Some(t) = f.ai_sonic_traits.iter().map(|s| s.trim()).find(|s| !s.is_empty()) {
                    facts.push(format!("sounds {t}"));
                }
                if let Some(b) = f.bpm.filter(|b| *b > 0.0) {
                    facts.push(bpm_bucket(b));
                }
                if let Some(name) = why.scene_neighbour(f) {
                    facts.push(format!("shares a ListenBrainz neighbour with {name}"));
                }
            }
            (*id, facts.join("; "))
        })
        .collect();
    // The reason each song is here, for the card's long-press. Facts only.
    let why_out = why_map(&why, &picks, &by_id, &explore_set);
    // What the patter check knows the shelf holds, so a name from elsewhere
    // on it is caught. Computed once per press; the model gets the run.
    let names = known_names(&feats, state.db.album_names());

    // The model writes the patter over the already-chosen ids; a failure just
    // means a set with no words, never a set with no music.
    /*
     * The model writes better patter, but a DJ that answers in half a minute
     * is not a DJ - by request the whole reply lands in single-digit
     * seconds, so the model gets a five-second seat at the desk and the show
     * goes on without it. The fallback is not the old wordless single block:
     * the runs are cut by hand (three tracks, led by their artist) and each
     * say line is the voice's own library line plus the name - the toast
     * shows exactly the words the voice speaks.
     */
    let mut blocks = if curate {
        // Unhurried: the whole point of banking is that the model may think.
        patter(state, &picks, &seed, &dossiers, true, &names)
            .await
            .unwrap_or_else(|| fallback_blocks(state, &picks[..picks.len().min(want)]))
    } else {
        match tokio::time::timeout(PATTER_BUDGET, patter(state, &picks, &seed, &dossiers, false, &names))
            .await
        {
            Ok(Some(blocks)) => blocks,
            _ => fallback_blocks(state, &picks),
        }
    };

    /*
     * The voice, as beats: each block gets its seat's cached library line and
     * the lead artist's name-drop (voice.rs owns the economics - the display
     * patter above stays the model's, rich and per-set, while the SPOKEN
     * layer is built entirely from clips that cache forever). Best-effort
     * and strictly additive: a hub with no provider, or a mint that fails,
     * just leaves the beat silent and the toast carries the set as before.
     */
    /*
     * The lore, by request: one short true thing about each song coming up.
     * Banked builds are background time, so they wait for the model to fill
     * the library's gaps; a live press only READS what is already on file -
     * the bank rebuild the handler spawns behind every vibe press is the one
     * that generates, so the next press speaks. (Generating behind the live
     * reply too was tried and cut: that background task raced the bank build
     * for the same model and the bank froze loreless sets.)
     */
    if curate {
        crate::lore::ensure(state, &picks).await;
    } else {
        // With the banks retired (the old generators), the live reply is
        // where lore gets commissioned: served now from what is on file,
        // written behind for next time. Safe today in the way it was not
        // under banking - ensure's wait-lock has no inline bank pass to
        // starve, and its own cooldowns bound the model time.
        let st = state.clone();
        let ids = picks.clone();
        tokio::spawn(async move {
            crate::lore::ensure(&st, &ids).await;
        });
    }
    let lore = crate::lore::known(state, &picks);
    // What the file itself says about each song - the year and the album -
    // so a lore line can be checked against something before it is spoken.
    let lore_facts = crate::lore::facts_for(state, &picks);
    let mut lore_jobs: Vec<crate::voice::Beat> = Vec::new();
    crate::lore::attach(&mut blocks, &lore, &mut lore_jobs, &lore_facts);
    // Minted on attach's own say-so, not a second enabled() read: the blocks
    // now carry these clip ids, so the sidecars MUST land - a toggle between
    // two reads once banked promises nothing could keep.
    if !lore_jobs.is_empty() {
        crate::voice::mint_behind(state, lore_jobs);
    }

    if crate::voice::enabled() {
        let last = blocks.len().saturating_sub(1);
        let mut jobs: Vec<crate::voice::Beat> = Vec::new();
        for (i, block) in blocks.iter_mut().enumerate() {
            let lead = block
                .get("trackIds")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_i64());
            let Some(lead) = lead else { continue };
            let artist = state
                .db
                .titles_for(&[lead])
                .first()
                .map(|(artist, _)| artist.clone())
                .unwrap_or_default();
            let seat = if i == 0 {
                crate::voice::Seat::Opener
            } else if i == last && last > 0 {
                crate::voice::Seat::Closer
            } else {
                crate::voice::Seat::Turn
            };
            let beats = crate::voice::block_beats(seat, &artist);
            if !beats.is_empty() {
                block["voice"] = json!(beats.iter().map(|b| b.id.clone()).collect::<Vec<_>>());
                jobs.extend(beats);
            }
        }
        // The ids are promises; the speaking happens behind the reply. The
        // clip endpoint keeps the promise even if this task dies first.
        crate::voice::mint_behind(state, jobs);
    }
    // `steered` says whether the seed actually shaped the ranking. When the
    // embedder is down every mood chip silently collapses onto the taste set;
    // saying so lets the client (and an operator reading the JSON) tell a
    // steered set from a shrug wearing the seed's name.
    Ok(json!({
        "ai": ai_url().is_some(),
        "vibe": seed,
        "steered": seed_vec.is_some(),
        "blocks": blocks,
        "why": why_out,
    }))
}

/// Ask the DJ model to break the chosen set into a few runs and open each with a
/// short spoken line. Words only - every id is validated back against `picks`,
/// and any the model drops are appended so the set stays whole.
async fn patter(
    state: &Arc<AppState>,
    picks: &[i64],
    seed: &str,
    dossiers: &HashMap<i64, String>,
    curate: bool,
    names: &[String],
) -> Option<Vec<Value>> {
    let url = ai_url()?;
    let mut lines = Vec::new();
    // Each song's own line, kept by id: the post-check reads a run's lines
    // back as the facts that run was allowed.
    let mut line_of: HashMap<i64, String> = HashMap::new();
    for id in picks {
        if let Some(t) = state.db.track(*id) {
            let facts = dossiers.get(id).filter(|f| !f.is_empty());
            let line = match facts {
                Some(f) => format!("{}|{} — {}|{}", id, t.artist, t.title, f),
                None => format!("{}|{} — {}", id, t.artist, t.title),
            };
            line_of.insert(*id, line.clone());
            lines.push(line);
        }
    }
    if lines.is_empty() {
        return None;
    }
    let vibe = if seed.is_empty() {
        "their recent listening".to_string()
    } else {
        format!("\"{seed}\"")
    };
    /*
     * Two jobs, one voice. Live, the model NARRATES a set already chosen -
     * cover everything, keep the order. Banked (curate), it gets the room to
     * be a DJ: twice the candidates, told to choose the ones that belong
     * together and sequence them - dropping the rest is the point, because
     * judgement is exactly what the listener said the live sets lacked.
     */
    let brief = if curate {
        "These are CANDIDATES, ranked by this listener's taste. CHOOSE about fifteen that belong together for this brief and SEQUENCE them into a set with a shape - an opener, a build, a close. DROP the rest; a smaller set that flows beats a complete one that does not. Split your chosen set into 3-5 consecutive runs."
    } else {
        "Split the set into 3-4 consecutive runs. Cover every track, in order, across the runs."
    };
    let prompt = format!(
        "You are a warm late-night radio DJ introducing a continuous set pulled from ONE listener's OWN library, steered toward {vibe}.\n\
         The songs, one per line as id|artist — title, some lines carrying known facts after a further |:\n{}\n\n\
         {brief} For each run write ONE short spoken DJ line to open it: first person, natural, 1-2 sentences, no exclamation marks, no emojis, name at most one artist.\n\
         When you say anything ABOUT a song or artist, use only that line's listed facts or its artist and title text. Lines without facts are introduced by name and feel alone. Never invent history, biography, genres or claims of any kind.\n\
         Answer with STRICT JSON and nothing else: [{{\"say\":\"...\",\"ids\":[1,2,3]}}] using ONLY the ids above.",
        lines.join("\n"),
    );

    // Live gets a minute; the bank gets whatever the operator granted the
    // model (the AI pane's own timeout) - benching it again with a hardcoded
    // sixty seconds was exactly how the first banked sets shipped library
    // lines instead of judgement.
    let patience = if curate {
        crate::ai::setting("timeoutSecs", "AFM_AI_TIMEOUT_SECS")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(300)
            .max(60)
    } else {
        60
    };
    let reply: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(patience))
        .build()
        .ok()?
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": dj_model(),
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.9,
            // The reply is a JSON skeleton, not prose - bounding it keeps a
            // CPU model from wandering past its own patience.
            "max_tokens": 700,
        }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let content = reply.pointer("/choices/0/message/content")?.as_str()?;
    // Carve the array out of any surrounding prose/fences; ordered and bounds
    // checked so a truncated reply can never panic the slice.
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    if end <= start {
        return None;
    }
    let parsed: Vec<Value> = serde_json::from_str(content.get(start..=end)?).ok()?;

    let valid: HashSet<i64> = picks.iter().copied().collect();
    let mut used: HashSet<i64> = HashSet::new();
    // (line, ids, whether the line passed the check): seats are handed out
    // once the run count is known, so a caught line can take the right one.
    let mut runs: Vec<(String, Vec<i64>, bool)> = Vec::new();
    for m in parsed {
        let say = m
            .get("say")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let ids: Vec<i64> = m
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_i64())
                    .filter(|id| valid.contains(id) && used.insert(*id))
                    .collect()
            })
            .unwrap_or_default();
        if say.is_empty() || ids.is_empty() {
            continue;
        }
        /*
         * The post-check. The prompt says "use only that line's listed
         * facts"; this is what holds when the prompt does not. A year the
         * run's lines never gave, or a library artist or album that is not
         * this run's, is the model reaching for what it remembers - and
         * for the small artists these libraries are full of, what it
         * remembers is somebody else. The line is dropped for the plain
         * one, and logged so an operator can see how often the model
         * strays; the run itself plays exactly as chosen.
         */
        let mut allowed: String = ids.iter().filter_map(|id| line_of.get(id)).cloned().collect::<Vec<_>>().join("\n");
        allowed.push('\n');
        allowed.push_str(seed);
        let ok = grounded_line(&say, &allowed, names);
        if !ok {
            eprintln!("[attackfm] dj patter dropped an ungrounded line: {say:?}");
        }
        runs.push((say, ids, ok));
    }
    let last = runs.len().saturating_sub(1);
    let mut blocks: Vec<Value> = runs
        .into_iter()
        .enumerate()
        .map(|(i, (say, ids, ok))| {
            let say = if ok { say } else { plain_line(state, seat_at(i, last), ids[0]) };
            json!({ "say": say, "trackIds": ids })
        })
        .collect();

    // Live, whatever the model left out still gets played - the selector
    // chose it and narration must not silently cut it. Banked, dropping IS
    // the curation, so leftovers stay on the shelf.
    let leftover: Vec<i64> = if curate {
        Vec::new()
    } else {
        picks.iter().copied().filter(|id| !used.contains(id)).collect()
    };
    if !leftover.is_empty() {
        match blocks
            .last_mut()
            .and_then(|b| b.get_mut("trackIds"))
            .and_then(|v| v.as_array_mut())
        {
            Some(arr) => arr.extend(leftover.into_iter().map(|id| json!(id))),
            None => blocks.push(json!({ "say": "", "trackIds": leftover })),
        }
    }

    (!blocks.is_empty()).then_some(blocks)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSeedBody {
    #[serde(default)]
    pub track_id: Option<i64>,
    #[serde(default)]
    pub track_ids: Vec<i64>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraitQueueBody {
    #[serde(default)]
    pub track_id: Option<i64>,
    #[serde(default)]
    pub track_ids: Vec<i64>,
    pub traits: Vec<DjTrait>,
    pub count: Option<usize>,
}

/// `POST /api/dj/analyze` - ask the configured local model what is musically
/// interesting about one owned song. The model returns concepts, never tracks.
pub async fn analyze_seed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AnalyzeSeedBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".into()))?
        .id;
    let mut seed_ids = body.track_ids;
    if let Some(id) = body.track_id {
        seed_ids.insert(0, id);
    }
    seed_ids.sort_unstable();
    seed_ids.dedup();
    seed_ids.truncate(100);
    if seed_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "choose at least one song".into()));
    }
    let tracks = state.db.tracks_for_curation(&seed_ids);
    if tracks.is_empty() {
        return Err((StatusCode::NOT_FOUND, "no such tracks".into()));
    }
    let source = match body.source.as_str() {
        "album" => "album",
        "playlist" => "playlist",
        _ => "song",
    };
    let is_collection = tracks.len() > 1 || source != "song";
    let dj_note = (!is_collection)
        .then(|| state.db.dj_note(user, tracks[0].id))
        .unwrap_or_default();
    let feature_by_id: HashMap<i64, TrackFeatures> = state
        .db
        .all_features()
        .into_iter()
        .map(|f| (f.track_id, f))
        .collect();
    let model = AiClient::configured()
        .map(|c| c.chat_model().to_string())
        .unwrap_or_default();
    let enrichment_key = tracks
        .iter()
        .map(|t| format!(
            "{}:{}:{}:{}:{}:{}:{}:{:.2}",
            t.ai_genres.join("|"),
            t.ai_specific_tags.join("|"),
            t.ai_sonic_traits.join("|"),
            t.ai_production_descriptors.join("|"),
            t.ai_moods.join("|"),
            t.ai_vibes.join("|"),
            t.ai_influences.join("|"),
            t.ai_confidence,
        ))
        .collect::<Vec<_>>()
        .join(";");
    let cache_key = format!(
        "{}:{:?}:{}:{}:{}",
        source, seed_ids, model, enrichment_key, dj_note
    );
    let cache = TRAIT_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().await.get(&cache_key).cloned() {
        if now_ms() - hit.at < TRAIT_CACHE_MS {
            return Ok(Json(json!({ "source": source, "trackIds": seed_ids,
                "summary": hit.value.summary, "traits": hit.value.traits, "cached": true,
                "ai": !model.is_empty(), "djNote": dj_note })));
        }
    }

    let (analysis, used_ai) = if let Some(client) = AiClient::configured() {
        let prompt = if is_collection {
            let catalogue = tracks
                .iter()
                .map(|track| {
                    let f = feature_by_id.get(&track.id);
                    format!(
                        "{} — {} | enriched genres: {} | specific styles/subgenres: {} | sonic traits: {} | production: {} | moods/vibes: {} / {} | influences: {} | year: {} | bpm: {} | energy: {}",
                        track.artist,
                        track.title,
                        track.ai_genres.join(", "),
                        track.ai_specific_tags.join(", "),
                        track.ai_sonic_traits.join(", "),
                        track.ai_production_descriptors.join(", "),
                        track.ai_moods.join(", "),
                        track.ai_vibes.join(", "),
                        track.ai_influences.join(", "),
                        track
                            .year
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                        f.and_then(|v| v.bpm)
                            .map(|v| format!("{v:.0}"))
                            .unwrap_or_else(|| "unknown".into()),
                        f.and_then(|v| v.energy)
                            .map(|v| format!("{v:.2}"))
                            .unwrap_or_else(|| "unknown".into())
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("Analyze the shared musical identity and useful sonic lanes inside this {} named '{}'. Offer exactly 4 selectable traits. At least 3 MUST describe audible qualities shared by several tracks: groove/rhythm, instrumentation, vocal delivery, production texture, energy, or specific style hybrids. Do not let the collection title, soundtrack/franchise placement, or one outlier define the answer. Queries must describe audible qualities, not proper nouns. The summary should explain the collection's musical center in under 60 words.\n\nTracks:\n{}", source, body.name, catalogue)
        } else {
            let track = &tracks[0];
            let feature = feature_by_id.get(&track.id);
            let lyrics: String = track.lyrics.chars().take(1800).collect();
            format!(
            "Analyze what is musically distinctive about this recording and what a listener may want more of. Offer exactly 4 distinct, selectable traits. At least 3 MUST describe the actual sound: groove/rhythm, instrumentation, vocal delivery, production texture, energy, or a specific hybrid of styles. Prefer supported enriched genres and specific styles/subgenres over broad file tags. Soundtrack, Films/Games, an album, or a franchise is context and MUST NOT be returned as a genre/style or retrieval query. The DJ note is high-value human direction but not verified fact. Keep labels and queries concise, sensory, and free of proper nouns. Do not name recommended songs.\n\nTitle: {}\nArtist: {}\nAlbum (context only): {}\nFile genre tag (possibly broad or wrong): {}\nEnriched broad genres: {}\nEnriched specific styles/subgenres: {}\nEnriched sonic traits: {}\nEnriched production/instrumentation: {}\nEnriched moods: {}\nEnriched vibes: {}\nEnriched influences: {}\nEnriched lyrical themes: {}\nEnrichment summary: {}\nEnrichment confidence: {:.2}\nDJ note: {}\nYear: {}\nBPM: {}\nMeasured energy (0-1): {}\nMeasured brightness (0-1): {}\nLyrics excerpt:\n{}",
            track.title, track.artist, track.album, track.genre,
            track.ai_genres.join(", "), track.ai_specific_tags.join(", "),
            track.ai_sonic_traits.join(", "), track.ai_production_descriptors.join(", "),
            track.ai_moods.join(", "), track.ai_vibes.join(", "), track.ai_influences.join(", "),
            track.ai_lyrical_themes.join(", "), track.ai_summary, track.ai_confidence, dj_note,
            track.year.map(|v| v.to_string()).unwrap_or_else(|| "unknown".into()),
            feature.as_ref().and_then(|f| f.bpm).map(|v| format!("{v:.0}")).unwrap_or_else(|| "unknown".into()),
            feature.as_ref().and_then(|f| f.energy).map(|v| format!("{v:.2}")).unwrap_or_else(|| "unknown".into()),
            feature.as_ref().and_then(|f| f.brightness).map(|v| format!("{v:.2}")).unwrap_or_else(|| "unknown".into()),
            lyrics
        )
        };
        let schema = trait_schema();
        match tokio::time::timeout(
            TRAIT_AI_DEADLINE,
            client.chat_json::<TraitAnalysis>(
                "You are AttackFM's local music curator. Return compact, evidence-aware structured traits for the listener's own library.",
                &prompt, "attackfm_trait_analysis", schema, true,
            ),
        ).await {
            Ok(Ok(value)) => (value, true),
            Ok(Err(error)) => {
                eprintln!("[attackfm] song trait AI failed; using enriched fallback: {error}");
                let track = &tracks[0];
                (heuristic_analysis(track, feature_by_id.get(&track.id)), false)
            }
            Err(_) => {
                eprintln!("[attackfm] song trait AI exceeded 45s; using enriched fallback");
                let track = &tracks[0];
                (heuristic_analysis(track, feature_by_id.get(&track.id)), false)
            }
        }
    } else {
        let track = &tracks[0];
        (
            heuristic_analysis(track, feature_by_id.get(&track.id)),
            false,
        )
    };
    let analysis = sanitize_analysis(analysis);
    if analysis.traits.is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "the DJ could not find useful traits for this song".into(),
        ));
    }
    cache.lock().await.insert(
        cache_key,
        CachedAnalysis {
            at: now_ms(),
            value: analysis.clone(),
        },
    );
    Ok(Json(json!({ "source": source, "trackIds": seed_ids,
        "summary": analysis.summary, "traits": analysis.traits, "cached": false,
        "ai": used_ai, "djNote": dj_note })))
}

/// `POST /api/dj/queue` - turn selected concepts into a semantic and
/// feature-aware target, then rank only real rows from this server's library.
pub async fn trait_queue(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<TraitQueueBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".into()))?
        .id;
    let song_seed = body.track_id;
    let mut seed_ids = body.track_ids;
    if let Some(id) = song_seed {
        seed_ids.insert(0, id);
    }
    seed_ids.sort_unstable();
    seed_ids.dedup();
    if seed_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "choose at least one song".into()));
    }
    let selected: Vec<DjTrait> = body
        .traits
        .into_iter()
        .take(12)
        .map(sanitize_trait)
        .filter(|t| !t.label.is_empty() && !t.query.is_empty())
        .collect();
    if selected.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "select at least one trait".into()));
    }
    let want = body.count.unwrap_or(24).clamp(6, 40);
    // The listener's own model for the history term - the same one the
    // station reads, so the two surfaces agree about what "your listening"
    // means. Its library load doubles as this handler's.
    let (taste, features) = match crate::curator::user_taste_for(&state, user) {
        Some(built) => built,
        None => (UserTaste::cold(user), state.db.all_features()),
    };
    let by_id: HashMap<i64, &TrackFeatures> = features.iter().map(|f| (f.track_id, f)).collect();
    // A collection mix must retain the sound of the whole collection. Earlier
    // this endpoint used the seed ids only as an exclusion list, so after the
    // analysis step the queue had no direct knowledge of the album/playlist at
    // all. Average every available member embedding and measured feature into
    // a stable collection profile; an outlier can contribute, but cannot own it.
    let seed_features: Vec<&TrackFeatures> = seed_ids
        .iter()
        .filter_map(|id| by_id.get(id).copied())
        .collect();
    let collection_centroid =
        average_vectors(seed_features.iter().filter_map(|f| f.lyric_vec.as_deref()));
    let collection_sonic =
        average_vectors(seed_features.iter().filter_map(|f| f.sonic_vec.as_deref()));
    let collection_lyrical = average_vectors(
        seed_features
            .iter()
            .filter_map(|f| f.lyrical_vec.as_deref()),
    );
    let collection_community = average_vectors(
        seed_features
            .iter()
            .filter_map(|f| f.community_vec.as_deref()),
    );
    let collection_energy = average_values(seed_features.iter().filter_map(|f| f.energy));
    let collection_bpm = average_values(seed_features.iter().filter_map(|f| f.bpm));
    let collection_brightness = average_values(seed_features.iter().filter_map(|f| f.brightness));
    let collection_dynamic_range =
        average_values(seed_features.iter().filter_map(|f| f.dynamic_range));
    let collection_rhythmic_activity =
        average_values(seed_features.iter().filter_map(|f| f.rhythmic_activity));
    let collection_audio = average_owned_vectors(
        seed_features
            .iter()
            .filter_map(|feature| audio_vector(feature)),
    );
    let collaborative_candidates: HashSet<&str> = seed_features
        .iter()
        .flat_map(|feature| feature.listenbrainz_similar.iter().map(String::as_str))
        .collect();
    let recent = state.db.recent_plays(user, RECENT_WINDOW);
    let liked: HashSet<i64> = state.db.favorites(user).into_iter().collect();
    // The embedding is primarily a description of audible character. Context
    // can add colour, but letting a soundtrack/scene phrase occupy an equal
    // share made soundtrack cuts recommend other soundtrack cuts regardless
    // of how unlike one another they sounded.
    let target_text = selected
        .iter()
        .map(|t| {
            let importance = category_importance(&t.category);
            format!("audible trait (importance {importance:.1}): {}", t.query)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let semantic = match AiClient::configured() {
        Some(client) => client.embed(&target_text).await.ok(),
        None => None,
    };
    // Lately, plus the listener's no - what they pushed away and what they
    // dismissed - exactly as the station holds them.
    let mut held: HashSet<i64> = recent.into_iter().collect();
    held.extend(taste.rejected.iter().copied());
    held.extend(crate::discovery::rejected_track_ids(&state.db, user));
    let mut rng = rand::thread_rng();
    let mut ranked: Vec<(f32, &TrackFeatures, serde_json::Value)> = features
        .iter()
        .filter(|f| {
            !seed_ids.contains(&f.track_id)
                && !held.contains(&f.track_id)
                && !f.quarantined
                && f.kind != "book"
        })
        .map(|f| {
            let trait_sem = match (&semantic, &f.lyric_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => 0.5,
            };
            let sonic_sem = match (&semantic, &f.sonic_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => trait_sem,
            };
            let lyrical_sem = match (&collection_lyrical, &f.lyrical_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => 0.5,
            };
            let community_sem = match (&collection_community, &f.community_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => 0.5,
            };
            let collection_sem = match (&collection_centroid, &f.lyric_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => 0.5,
            };
            let seed_sonic_sem = match (&collection_sonic, &f.sonic_vec) {
                (Some(q), Some(v)) => (cosine(q, v) + 1.0) / 2.0,
                _ => collection_sem,
            };
            let measured = collection_feature_score(
                f,
                collection_energy,
                collection_bpm,
                collection_brightness,
                collection_dynamic_range,
                collection_rhythmic_activity,
            );
            let audio_embedding = match (&collection_audio, audio_vector(f)) {
                (Some(seed), Some(candidate)) => (cosine(seed, &candidate) + 1.0) / 2.0,
                _ => measured,
            };
            // Traits steer the direction the listener selected, while the
            // members themselves remain nearly half of the musical evidence.
            let sem = 0.45 * sonic_sem
                + 0.25 * seed_sonic_sem
                + 0.15 * audio_embedding
                + 0.08 * lyrical_sem
                + 0.07 * community_sem;
            let specialized = specialized_score(f, &selected);
            let history = taste::score(f, &taste);
            // Likes are a gentle taste vote, not a shortcut to replaying the
            // favourites list. Eight percent is enough to break close sonic
            // matches while the selected sound still owns the ranking.
            let like = if liked.contains(&f.track_id) {
                1.0
            } else {
                0.0
            };
            let collaborative = if !f.musicbrainz_id.is_empty()
                && collaborative_candidates.contains(f.musicbrainz_id.as_str())
            {
                1.0
            } else {
                0.0
            };
            // ListenBrainz is a small positive-only corroborator. Its radio
            // graph reflects listening patterns, not proof that recordings
            // sound alike, so it cannot outweigh semantic or measured sound.
            let relevance = 0.44 * sem
                + 0.32 * specialized
                + 0.12 * history
                + 0.08 * like
                + 0.04 * collaborative;
            let jitter = rng.gen_range(-QUEUE_SCORE_JITTER..=QUEUE_SCORE_JITTER);
            let strongest = [
                ("sound", 0.45 * sonic_sem + 0.25 * seed_sonic_sem),
                ("audio", 0.15 * audio_embedding),
                ("lyrics", 0.08 * lyrical_sem),
                ("community", 0.07 * community_sem + 0.04 * collaborative),
                ("your listening", 0.12 * history + 0.08 * like),
            ]
            .into_iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap();
            let explanation = json!({
                "trackId": f.track_id,
                "reason": format!("Strongest match: {}", strongest.0),
                "scores": { "sonic": sonic_sem, "measuredAudio": audio_embedding,
                    "lyrical": lyrical_sem, "community": community_sem,
                    "history": history, "liked": like, "collaborative": collaborative }
            });
            ((relevance + jitter).clamp(0.0, 1.0), f, explanation)
        })
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut ids = song_seed.into_iter().collect::<Vec<_>>();
    let mut artists: HashMap<String, usize> = ids
        .iter()
        .filter_map(|id| {
            features
                .iter()
                .find(|f| f.track_id == *id)
                .map(|f| (f.artist.to_lowercase(), 1))
        })
        .collect();
    let mut explanations = Vec::new();
    for (_, f, explanation) in ranked {
        let count = artists.entry(f.artist.to_lowercase()).or_insert(0);
        if *count >= PER_ARTIST_CAP {
            continue;
        }
        *count += 1;
        ids.push(f.track_id);
        explanations.push(explanation);
        if ids.len() >= want {
            break;
        }
    }
    // Same offer ledger the station writes: adoption is judged per impression.
    let offered: Vec<(i64, &str, i64)> =
        ids.iter().enumerate().map(|(i, id)| (*id, "rank", i as i64)).collect();
    state.db.record_dj_impressions(user, &offered);
    Ok(Json(
        json!({ "trackIds": ids, "semantic": semantic.is_some(), "explanations": explanations,
        "intent": { "kind": "traits", "seedTrackIds": seed_ids,
            "traits": selected.iter().map(|t| &t.id).collect::<Vec<_>>() } }),
    ))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DjNoteBody {
    pub track_id: i64,
    #[serde(default)]
    pub note: String,
}

/// `POST /api/dj/note` - save human judgement independently of AI enrichment.
pub async fn set_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<DjNoteBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".into()))?
        .id;
    if state.db.tracks_for_curation(&[body.track_id]).is_empty() {
        return Err((StatusCode::NOT_FOUND, "no such track".into()));
    }
    state
        .db
        .set_dj_note(user, body.track_id, &body.note)
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not save DJ note".into(),
            )
        })?;
    Ok(Json(
        json!({ "ok": true, "note": state.db.dj_note(user, body.track_id) }),
    ))
}

fn average_values(values: impl Iterator<Item = f64>) -> Option<f64> {
    let values: Vec<f64> = values.collect();
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn average_vectors<'a>(vectors: impl Iterator<Item = &'a [f32]>) -> Option<Vec<f32>> {
    let vectors: Vec<&[f32]> = vectors.collect();
    let len = vectors.first()?.len();
    if len == 0 {
        return None;
    }
    let usable: Vec<&[f32]> = vectors.into_iter().filter(|v| v.len() == len).collect();
    if usable.is_empty() {
        return None;
    }
    let mut out = vec![0.0; len];
    for vector in &usable {
        for (sum, value) in out.iter_mut().zip(vector.iter()) {
            *sum += *value;
        }
    }
    for value in &mut out {
        *value /= usable.len() as f32;
    }
    Some(out)
}

fn average_owned_vectors(vectors: impl Iterator<Item = Vec<f32>>) -> Option<Vec<f32>> {
    let vectors: Vec<Vec<f32>> = vectors.collect();
    average_vectors(vectors.iter().map(Vec::as_slice))
}

/// Prefer the versioned 48-dimensional spectral/temporal fingerprint measured
/// directly from decoded audio. Older rows fall back to the five explainable
/// measurements while the background analyser backfills them.
fn audio_vector(feature: &TrackFeatures) -> Option<Vec<f32>> {
    if let Some(fingerprint) = feature
        .audio_fingerprint
        .as_ref()
        .filter(|vector| vector.len() == 48)
    {
        return Some(fingerprint.clone());
    }
    let parts = [
        feature.bpm.map(|v| (v / 240.0).clamp(0.0, 1.0)),
        feature.energy,
        feature.brightness,
        feature.dynamic_range,
        feature.rhythmic_activity,
    ];
    (parts.iter().filter(|value| value.is_some()).count() >= 3).then(|| {
        parts
            .into_iter()
            .map(|value| value.unwrap_or(0.5) as f32)
            .collect()
    })
}

fn collection_feature_score(
    feature: &TrackFeatures,
    energy: Option<f64>,
    bpm: Option<f64>,
    brightness: Option<f64>,
    dynamic_range: Option<f64>,
    rhythmic_activity: Option<f64>,
) -> f32 {
    let mut parts = Vec::new();
    if let (Some(target), Some(actual)) = (energy, feature.energy) {
        parts.push((1.0 - (target - actual).abs().min(1.0)) as f32);
    }
    if let (Some(target), Some(actual)) = (bpm, feature.bpm) {
        parts.push((-(target - actual).abs() / 30.0).exp() as f32);
    }
    if let (Some(target), Some(actual)) = (brightness, feature.brightness) {
        parts.push((1.0 - (target - actual).abs().min(1.0)) as f32);
    }
    if let (Some(target), Some(actual)) = (dynamic_range, feature.dynamic_range) {
        parts.push((1.0 - (target - actual).abs().min(1.0)) as f32);
    }
    if let (Some(target), Some(actual)) = (rhythmic_activity, feature.rhythmic_activity) {
        parts.push((1.0 - (target - actual).abs().min(1.0)) as f32);
    }
    if parts.is_empty() {
        0.5
    } else {
        parts.iter().sum::<f32>() / parts.len() as f32
    }
}

fn specialized_score(feature: &TrackFeatures, traits: &[DjTrait]) -> f32 {
    let mut total = 0.0f32;
    let mut weights = 0.0f32;
    for t in traits {
        let w = t.weight.clamp(0.1, 1.5)
            * t.confidence.clamp(0.25, 1.0)
            * category_importance(&t.category);
        let mut parts = Vec::new();
        if let (Some(target), Some(actual)) = (t.signals.energy, feature.energy) {
            parts.push(1.0 - (target - actual as f32).abs().min(1.0));
        }
        if let Some(bpm) = feature.bpm {
            if let (Some(lo), Some(hi)) = (t.signals.bpm_min, t.signals.bpm_max) {
                let gap = if bpm < lo {
                    lo - bpm
                } else if bpm > hi {
                    bpm - hi
                } else {
                    0.0
                };
                parts.push((-gap as f32 / 25.0).exp());
            }
        }
        if let Some(year) = feature.year {
            if let (Some(lo), Some(hi)) = (t.signals.year_min, t.signals.year_max) {
                let gap = if year < lo {
                    lo - year
                } else if year > hi {
                    year - hi
                } else {
                    0
                };
                parts.push((-gap as f32 / 8.0).exp());
            }
        }
        if !t.signals.genres.is_empty()
            && (!feature.ai_genres.is_empty()
                || !feature.ai_specific_tags.is_empty()
                || !feature.genre.trim().is_empty())
        {
            let candidate_genres = if feature.ai_genres.is_empty() && feature.ai_specific_tags.is_empty() {
                vec![feature.genre.to_lowercase()]
            } else {
                feature.ai_genres.iter().chain(&feature.ai_specific_tags)
                    .map(|g| g.to_lowercase()).collect()
            };
            parts.push(
                if t.signals.genres.iter().any(|g| {
                    let wanted = normalized_style(g);
                    candidate_genres.iter().any(|candidate| {
                        let candidate = normalized_style(candidate);
                        candidate.contains(&wanted) || wanted.contains(&candidate)
                    })
                }) {
                    1.0
                } else {
                    0.2
                },
            );
        }
        if !parts.is_empty() {
            total += w * parts.iter().sum::<f32>() / parts.len() as f32;
            weights += w;
        }
    }
    if weights > 0.0 {
        total / weights
    } else {
        0.5
    }
}

fn normalized_style(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn category_importance(category: &str) -> f32 {
    match category {
        "sonic" | "production" | "instrumentation" | "vocals" => 1.25,
        "energy" | "genre_style" | "mood" => 1.0,
        "lyrical_theme" => 0.75,
        // Cultural context is useful DJ knowledge, but a weak similarity
        // signal: a film/game/show is a container, not a sound.
        "scene_culture" | "era" => 0.45,
        _ => 0.75,
    }
}

fn sanitize_analysis(mut analysis: TraitAnalysis) -> TraitAnalysis {
    analysis.summary = analysis.summary.trim().chars().take(240).collect();
    analysis.traits = analysis
        .traits
        .into_iter()
        .take(12)
        .map(sanitize_trait)
        .filter(|t| !t.label.is_empty() && !t.query.is_empty())
        .collect();
    analysis
}

fn sanitize_trait(mut t: DjTrait) -> DjTrait {
    const CATEGORIES: &[&str] = &[
        "sonic",
        "energy",
        "genre_style",
        "vocals",
        "era",
        "mood",
        "production",
        "lyrical_theme",
        "instrumentation",
        "scene_culture",
    ];
    t.label = t.label.trim().chars().take(42).collect();
    t.description = t.description.trim().chars().take(160).collect();
    t.query = t.query.trim().chars().take(180).collect();
    t.category = t.category.trim().to_lowercase();
    if !CATEGORIES.contains(&t.category.as_str()) {
        t.category = "sonic".into();
    }
    t.weight = t.weight.clamp(0.1, 1.5);
    t.confidence = t.confidence.clamp(0.0, 1.0);
    if t.id.trim().is_empty() {
        t.id = t
            .label
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
    }
    t.signals.energy = t.signals.energy.map(|v| v.clamp(0.0, 1.0));
    t.signals.bpm_min = t.signals.bpm_min.map(|v| v.clamp(30.0, 300.0));
    t.signals.bpm_max = t.signals.bpm_max.map(|v| v.clamp(30.0, 300.0));
    t.signals.year_min = t.signals.year_min.map(|v| v.clamp(1900, 2200));
    t.signals.year_max = t.signals.year_max.map(|v| v.clamp(1900, 2200));
    t.signals.genres = t
        .signals
        .genres
        .into_iter()
        .take(5)
        .map(|g| g.trim().chars().take(48).collect())
        .filter(|g: &String| !g.is_empty())
        .collect();
    t
}

fn heuristic_analysis(
    track: &crate::db::CurationTrack,
    feature: Option<&TrackFeatures>,
) -> TraitAnalysis {
    let mut traits = Vec::new();
    let mut add =
        |label: &str, category: &str, description: String, query: String, signals: TraitSignals| {
            traits.push(DjTrait {
                id: label.to_lowercase().replace(' ', "-"),
                label: label.into(),
                category: category.into(),
                description,
                weight: 1.0,
                confidence: 0.7,
                query,
                signals,
            });
        };
    let preferred_genre = track
        .ai_specific_tags
        .iter()
        .chain(&track.ai_genres)
        .next()
        .map(String::as_str)
        .filter(|_| track.ai_confidence >= 0.45)
        .unwrap_or(track.genre.as_str());
    let broad_context = matches!(
        preferred_genre.trim().to_lowercase().as_str(),
        "soundtrack" | "films/games" | "film" | "game" | "video game music"
    );
    if !preferred_genre.trim().is_empty() && !broad_context {
        add(
            preferred_genre,
            "genre_style",
            "More from this musical lane.".into(),
            preferred_genre.to_string(),
            TraitSignals {
                genres: vec![preferred_genre.to_string()],
                ..Default::default()
            },
        );
    }
    // The local model is optional. When it is busy, expose useful choices
    // straight from the canonical enrichment instead of collapsing to broad
    // file tags and measured energy alone.
    if let Some(sonic) = track.ai_sonic_traits.first().filter(|v| !v.trim().is_empty()) {
        add(
            sonic,
            "sonic",
            "More with this enriched sonic character.".into(),
            sonic.to_string(),
            TraitSignals::default(),
        );
    }
    if let Some(production) = track
        .ai_production_descriptors
        .first()
        .filter(|v| !v.trim().is_empty())
    {
        add(
            production,
            "production",
            "More with this production or instrumentation character.".into(),
            production.to_string(),
            TraitSignals::default(),
        );
    }
    if let Some(mood) = track
        .ai_moods
        .iter()
        .chain(&track.ai_vibes)
        .next()
        .filter(|v| !v.trim().is_empty())
    {
        add(
            mood,
            "mood",
            "More with this enriched mood and vibe.".into(),
            mood.to_string(),
            TraitSignals::default(),
        );
    }
    if let Some(year) = track.year {
        let decade = year / 10 * 10;
        add(
            &format!("{decade}s"),
            "era",
            "More music from the same era.".into(),
            format!("music from the {decade}s"),
            TraitSignals {
                year_min: Some(decade),
                year_max: Some(decade + 9),
                ..Default::default()
            },
        );
    }
    if let Some(f) = feature {
        if let Some(e) = f.energy {
            let label = if e >= 0.62 {
                "High energy"
            } else if e <= 0.36 {
                "Low-key"
            } else {
                "Steady energy"
            };
            add(
                label,
                "energy",
                "Matched to the measured intensity of the recording.".into(),
                label.into(),
                TraitSignals {
                    energy: Some(e as f32),
                    bpm_min: f.bpm.map(|b| b - 15.0),
                    bpm_max: f.bpm.map(|b| b + 15.0),
                    ..Default::default()
                },
            );
        }
        if let Some(bright) = f.brightness {
            let label = if bright > 0.58 {
                "Bright sound"
            } else {
                "Dark-toned"
            };
            add(
                label,
                "sonic",
                "A similar overall tonal character.".into(),
                label.into(),
                TraitSignals::default(),
            );
        }
    }
    add(
        "Lyrical character",
        "lyrical_theme",
        "Follow the song's words and subject matter.".into(),
        format!(
            "songs lyrically and thematically like {} by {}",
            track.title, track.artist
        ),
        TraitSignals::default(),
    );
    TraitAnalysis {
        summary: format!("A few directions outward from {}.", track.title),
        traits,
    }
}

fn trait_schema() -> Value {
    json!({
      "type": "object", "additionalProperties": false,
      "required": ["summary", "traits"],
      "properties": {
        "summary": { "type": "string" },
        "traits": { "type": "array", "minItems": 4, "maxItems": 4, "items": {
          "type": "object", "additionalProperties": false,
          "required": ["id", "label", "category", "description", "weight", "confidence", "query", "signals"],
          "properties": {
            "id": { "type": "string" }, "label": { "type": "string" },
            "category": { "type": "string", "enum": ["sonic", "energy", "genre_style", "vocals", "era", "mood", "production", "lyrical_theme", "instrumentation", "scene_culture"] },
            "description": { "type": "string" }, "weight": { "type": "number" },
            "confidence": { "type": "number" }, "query": { "type": "string" },
            "signals": { "type": "object", "additionalProperties": false,
              "required": ["energy", "bpmMin", "bpmMax", "yearMin", "yearMax", "genres"],
              "properties": {
                "energy": { "type": ["number", "null"] }, "bpmMin": { "type": ["number", "null"] },
                "bpmMax": { "type": ["number", "null"] }, "yearMin": { "type": ["integer", "null"] },
                "yearMax": { "type": ["integer", "null"] },
                "genres": { "type": "array", "items": { "type": "string" }, "maxItems": 5 }
              }
            }
          }
        }}
      }
    })
}

#[cfg(test)]
mod ranking_tests {
    use super::*;

    fn feature(bpm: f64, energy: f64, brightness: f64, dynamic: f64, rhythm: f64) -> TrackFeatures {
        TrackFeatures {
            kind: "music".into(),
            track_id: 1,
            bpm: Some(bpm),
            curator_user_id: None,
            added_at: 0,
            lyric_vec: None,
            genre: "test".into(),
            ai_genres: Vec::new(),
            ai_specific_tags: Vec::new(),
            ai_sonic_traits: Vec::new(),
            artist: "test".into(),
            title: "test".into(),
            energy: Some(energy),
            brightness: Some(brightness),
            dynamic_range: Some(dynamic),
            rhythmic_activity: Some(rhythm),
            musicbrainz_id: String::new(),
            listenbrainz_similar: Vec::new(),
            sonic_vec: None,
            lyrical_vec: None,
            community_vec: None,
            audio_fingerprint: None,
            year: None,
            quarantined: false,
            ai_moods: Vec::new(),
        }
    }

    #[test]
    fn local_audio_embedding_is_deterministic_and_bounded() {
        let vector = audio_vector(&feature(120.0, 0.8, 0.2, 0.6, 0.4)).unwrap();
        assert_eq!(vector, vec![0.5, 0.8, 0.2, 0.6, 0.4]);
        assert!(vector.iter().all(|value| (0.0..=1.0).contains(value)));
    }

    #[test]
    fn nearby_audio_ranks_above_an_opposite_profile() {
        let seed = audio_vector(&feature(120.0, 0.8, 0.2, 0.6, 0.4)).unwrap();
        let near = audio_vector(&feature(123.0, 0.78, 0.22, 0.58, 0.42)).unwrap();
        let far = audio_vector(&feature(55.0, 0.1, 0.95, 0.05, 0.95)).unwrap();
        assert!(cosine(&seed, &near) > cosine(&seed, &far));
    }

    #[test]
    fn taste_signals_cannot_outweigh_relevance() {
        let relevance_families = 0.44 + 0.32;
        let personal_tie_breakers = 0.12 + 0.08;
        let collaborative = 0.04;
        assert!(relevance_families > personal_tie_breakers + collaborative);
        assert!(
            (relevance_families + personal_tie_breakers + collaborative - 1.0_f32).abs() < 0.001
        );
    }

    #[test]
    fn specific_subgenres_drive_the_explicit_style_signal() {
        let mut candidate = feature(120.0, 0.6, 0.5, 0.5, 0.5);
        candidate.genre = "electronic".into();
        candidate.ai_genres = vec!["electronic".into()];
        candidate.ai_specific_tags = vec!["future-garage".into()];
        let direction = DjTrait {
            id: "future-garage".into(),
            label: "Future garage".into(),
            category: "genre_style".into(),
            description: String::new(),
            weight: 1.0,
            confidence: 1.0,
            query: "future garage".into(),
            signals: TraitSignals {
                genres: vec!["future garage".into()],
                ..Default::default()
            },
        };
        assert_eq!(specialized_score(&candidate, &[direction]), 1.0);
    }
}

#[cfg(test)]
mod station_weights {
    use super::*;

    #[test]
    fn the_budget_holds() {
        let sem = STATION_SEM_SONIC + STATION_SEM_LYRIC;
        assert!((sem - 1.0).abs() < 1e-6, "semantic family must sum to 1");
        let outer = STATION_W_SEM + STATION_W_HISTORY + STATION_W_LIKE + STATION_W_COLLAB;
        assert!((outer - 1.0).abs() < 1e-6, "outer blend must sum to 1");
        assert!(
            STATION_W_SEM > STATION_W_HISTORY + STATION_W_LIKE + STATION_W_COLLAB,
            "a station sounds like a taste, not a history",
        );
    }
}

#[cfg(test)]
mod explore_seats {
    //! The exploration seats: who may sit in them, and in what order.

    use super::*;

    fn feature(id: i64, artist: &str) -> TrackFeatures {
        TrackFeatures {
            title: String::new(),
            kind: "music".into(),
            track_id: id,
            bpm: Some(120.0),
            curator_user_id: None,
            added_at: 0,
            lyric_vec: None,
            genre: "rock".into(),
            ai_genres: Vec::new(),
            ai_specific_tags: Vec::new(),
            ai_sonic_traits: Vec::new(),
            artist: artist.into(),
            energy: Some(0.5),
            brightness: None,
            dynamic_range: None,
            rhythmic_activity: None,
            musicbrainz_id: String::new(),
            listenbrainz_similar: Vec::new(),
            sonic_vec: None,
            lyrical_vec: None,
            community_vec: None,
            audio_fingerprint: None,
            year: None,
            quarantined: false,
            ai_moods: Vec::new(),
        }
    }

    /// Strictly per person: another member's unadopted audition and an
    /// audiobook never reach the pool; the listener's own audition does.
    #[test]
    fn the_pool_excludes_another_members_audition_and_books() {
        let me = 1;
        assert!(dealable(&feature(1, "a"), me), "the library plays");

        let mut theirs = feature(2, "b");
        theirs.quarantined = true;
        theirs.curator_user_id = Some(2);
        assert!(!dealable(&theirs, me), "another member's audition is never dealt to me");

        let mut mine = feature(3, "c");
        mine.quarantined = true;
        mine.curator_user_id = Some(me);
        assert!(dealable(&mine, me), "my own audition is the door in");

        let mut adopted = feature(4, "d");
        adopted.curator_user_id = Some(2);
        assert!(dealable(&adopted, me), "an adopted pull is ordinary library");

        let mut chapter = feature(5, "e");
        chapter.kind = "book".into();
        assert!(!dealable(&chapter, me), "a chapter is not a song");
    }

    /// A highly relevant artist with a mediocre draw beats an irrelevant
    /// artist with a lucky one - exploration, but inside a connected pool.
    #[test]
    fn the_order_respects_relevance() {
        let stats: HashMap<String, (i64, i64)> = HashMap::new();
        let candidates = vec![
            ("connected".to_string(), 0.90f32, 1i64),
            ("stranger".to_string(), 0.20f32, 2i64),
        ];
        // A fixed hand, dealt in relevance order (the sort happens before
        // the draw): the connected artist gets a mediocre 0.5, the stranger
        // a lucky 0.95. Both are never-offered, so both see the uniform prior.
        let mut calls = 0;
        let mut sampler = |a: f64, b: f64| {
            assert_eq!((a, b), (1.0, 1.0), "never offered: the uniform prior");
            calls += 1;
            if calls == 1 { 0.5 } else { 0.95 }
        };
        let seats = explore_order(candidates, &stats, 1, &mut sampler);
        assert_eq!(seats, vec![1], "0.5 × 0.9 beats 0.95 × 0.2");
    }

    /// The Beta draw only runs over the most relevant forty artists: the
    /// forty-first never gets a seat, however lucky its hand would be.
    #[test]
    fn the_draw_is_confined_to_the_relevant_forty() {
        let stats: HashMap<String, (i64, i64)> = HashMap::new();
        let candidates: Vec<(String, f32, i64)> = (0..60)
            .map(|i| (format!("artist{i}"), 1.0 - i as f32 * 0.01, i as i64))
            .collect();
        // Everyone draws the same: the order is pure relevance, the tail cut.
        let mut flat = |_: f64, _: f64| 1.0;
        let seats = explore_order(candidates, &stats, 60, &mut flat);
        assert_eq!(seats.len(), EXPLORE_POOL);
        assert_eq!(seats[0], 0);
        assert!(!seats.contains(&45), "outside the top forty: not in the hat");
    }

    /// An artist whose offers keep getting adopted asks for more of the
    /// posterior; the sampler is handed the adoption counts, not a flat prior.
    #[test]
    fn adoption_shapes_the_hand_the_sampler_is_dealt() {
        let mut stats: HashMap<String, (i64, i64)> = HashMap::new();
        stats.insert("loved".into(), (4, 3));
        stats.insert("ignored".into(), (4, 0));
        let mut seen: Vec<(f64, f64)> = Vec::new();
        let mut record = |a: f64, b: f64| {
            seen.push((a, b));
            0.5
        };
        let _ = explore_order(
            vec![("loved".into(), 0.5, 1), ("ignored".into(), 0.5, 2)],
            &stats,
            2,
            &mut record,
        );
        seen.sort_by(|x, y| x.partial_cmp(y).unwrap());
        assert_eq!(seen, vec![(1.0, 5.0), (4.0, 2.0)]);
    }

    /// Late night leans down, the morning leans up a little, and the rest of
    /// the day - and a client that never said - is left alone.
    #[test]
    fn the_hour_tilts_only_in_its_windows() {
        assert_eq!(hour_nudge(Some(23)), (-0.10, -8.0));
        assert_eq!(hour_nudge(Some(3)), (-0.10, -8.0));
        assert_eq!(hour_nudge(Some(8)), (0.05, 5.0));
        for h in [5, 6, 10, 14, 19, 21] {
            assert_eq!(hour_nudge(Some(h)), (0.0, 0.0), "hour {h} is nobody's business");
        }
        assert_eq!(hour_nudge(None), (0.0, 0.0), "no hour, no tilt");

        let mut night = UserTaste::cold(1);
        night.tempo = Some((120.0, 6.0));
        night.energy = Some((0.6, 0.1));
        nudge_for_hour(&mut night, Some(23));
        assert_eq!(night.tempo, Some((112.0, 6.0)), "eight bpm slower, spread untouched");
        assert!((night.energy.unwrap().0 - 0.5).abs() < 1e-9, "a tenth calmer");

        let mut morning = UserTaste::cold(1);
        morning.tempo = Some((120.0, 6.0));
        morning.energy = Some((0.6, 0.1));
        nudge_for_hour(&mut morning, Some(8));
        assert_eq!(morning.tempo, Some((125.0, 6.0)));
        assert!((morning.energy.unwrap().0 - 0.65).abs() < 1e-9);

        let mut noon = UserTaste::cold(1);
        noon.tempo = Some((120.0, 6.0));
        nudge_for_hour(&mut noon, Some(13));
        assert_eq!(noon.tempo, Some((120.0, 6.0)), "midday leaves the target alone");

        let mut cold = UserTaste::cold(1);
        nudge_for_hour(&mut cold, Some(23));
        assert!(cold.tempo.is_none() && cold.energy.is_none(), "no target, nothing to tilt");
    }
}

#[cfg(test)]
mod why_and_grounding {
    //! The card's reason is a fact, and the patter may only phrase facts.

    use super::*;

    fn feature(id: i64, artist: &str) -> TrackFeatures {
        TrackFeatures {
            track_id: id,
            kind: "music".into(),
            artist: artist.into(),
            title: format!("song {id}"),
            ..Default::default()
        }
    }

    /// One reason per song, each from a real field: the seat, a heart, the
    /// listener's own completions, a ListenBrainz edge, a measured
    /// closeness - and nothing when nothing applies.
    #[test]
    fn why_is_built_from_facts_only() {
        let mut taste = UserTaste::cold(1);
        taste.artists.insert(taste::artist_key("Big Thief"), 0.6);
        taste.artists.insert(taste::artist_key("Finished Often"), 0.3);

        let mut liked_song = feature(1, "Big Thief");
        liked_song.musicbrainz_id = "mb-bigthief".into();
        liked_song.audio_fingerprint = Some(vec![1.0, 0.0, 0.0]);
        let mut finished = feature(2, "Finished Often");
        finished.audio_fingerprint = Some(vec![0.0, 1.0, 0.0]);
        let mut scene = feature(3, "Someone New");
        scene.listenbrainz_similar = vec!["mb-bigthief".into()];
        let mut close = feature(4, "Sounds Near");
        close.audio_fingerprint = Some(vec![0.98, 0.15, 0.0]);
        let explore = feature(5, "Stranger");
        let nothing = feature(6, "Nobody");
        let feats = vec![liked_song, finished, scene, close, explore, nothing];
        let by_id: HashMap<i64, &TrackFeatures> = feats.iter().map(|f| (f.track_id, f)).collect();

        let liked: HashSet<i64> = [1].into_iter().collect();
        let hearted: HashSet<String> = ["big thief".to_string()].into_iter().collect();
        let why = Why::build(&taste, &feats, &liked, &hearted);
        let seats: HashSet<i64> = [5].into_iter().collect();
        let out = why_map(&why, &[1, 2, 3, 4, 5, 6], &by_id, &seats);

        assert_eq!(out["1"], "hearted before");
        assert_eq!(out["2"], "you finish Finished Often");
        assert_eq!(out["3"], "same scene as Big Thief");
        assert_eq!(out["4"], "sounds like Big Thief", "measured off the fingerprint, against a hearted song");
        assert_eq!(out["5"], "explore");
        assert!(!out.contains_key("6"), "no provable reason, no line: {out:?}");
        assert_eq!(why.scene_neighbour(&feats[2]).as_deref(), Some("Big Thief"), "the dossier's neighbour line");
        assert_eq!(bpm_bucket(84.4), "slow, around 84 bpm");
        assert_eq!(bpm_bucket(128.0), "upbeat, around 128 bpm");
    }

    /// A year the dossier never gave drops the line; a compliant line
    /// stays; a library name from outside the run drops it too.
    #[test]
    fn the_patter_check_drops_a_year_not_in_the_dossier_and_keeps_a_compliant_line() {
        let allowed = "12|Big Thief — Not|released 2019; upbeat, around 128 bpm\n13|Big Thief — Cattails\nsomething mellow";
        let names: Vec<String> = ["big thief", "the national", "trouble will find me"]
            .into_iter()
            .map(String::from)
            .collect();
        assert!(grounded_line("Here is Big Thief, from 2019, keeping it at a run.", allowed, &names));
        assert!(!grounded_line("Big Thief's 2016 record, next.", allowed, &names), "2016 was never listed");
        assert!(
            !grounded_line("This one always reminds me of The National.", allowed, &names),
            "an artist from elsewhere on the shelf is a memory"
        );
        assert!(
            !grounded_line("Off the album Trouble Will Find Me.", allowed, &names),
            "and so is an album"
        );
        assert!(grounded_line("Something mellow, as asked - Big Thief.", allowed, &names), "the seed and the run's own artist are fine");
        assert!(contains_word("slow burner", "slow") && !contains_word("slow burner", "low"));
    }
}
