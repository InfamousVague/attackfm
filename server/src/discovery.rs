//! Discovery: music you do not own, judged the same way music you do own is.
//!
//! The curator next door can only ever recommend from the shelf - it scores a
//! library you already have. This module goes outside it, and the point is that
//! it does not settle for "people who liked X also liked Y". Every candidate is
//! actually listened to before it is offered:
//!
//! - **What it is about.** The lyrics come from lrclib (free, keyless - the
//!   same place the app's own lyrics pane reads from) and go through the same
//!   local embedding model your library did. So a song you have never heard can
//!   be compared, in words, against the centre of gravity of everything you
//!   play.
//! - **How fast it moves.** Deezer ships a thirty-second preview with every
//!   track. ffmpeg reads that URL straight into the same spectral-flux tempo
//!   analyser your own files went through - a real measurement, not a lookup.
//! - **Who it hangs off.** Candidates are harvested from the artists related to
//!   the ones you actually play, so the pool starts in the right neighbourhood
//!   rather than at the global charts.
//! - **How it lands elsewhere.** The catalogue's own popularity, as a tiebreak
//!   only - it should nudge, never decide, or the feed collapses into the
//!   charts.
//!
//! All of it runs on the same slow background loop as the curator: a couple of
//! candidates a cycle, resumable, cached forever once measured. Nothing here is
//! in a hurry - a recommendation that arrives tomorrow is still a good one.
//!
//! The result is a shelf of things to acquire, each carrying the reason it is
//! there. Acting on one is the app's existing import path; dismissing one
//! forgets it.

use crate::AppState;
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// Candidates listened to per cycle. Each one costs a lyrics fetch, an
/// embedding and a preview download, so this stays small.
/// Twelve, up from four: measurement was the pipeline's narrowest neck - the
/// pool held 562 candidates and only 34 were measured, so the collector had
/// almost nothing it was allowed to buy. The expensive half (the lyric embed)
/// is the CHEAP ollama op; the preview fetch dominates and twelve is still
/// polite to the preview hosts.
const LISTEN_BATCH: i64 = 12;
/// Stop harvesting once this many candidates are waiting - the pool should be
/// deep enough to choose from, not unbounded.
pub(crate) const POOL_TARGET: i64 = 180;
/// How many MEASURED candidates a pool keeps. Above this the worst-scored are
/// dropped - they are re-derivable, they are by definition the least likely to
/// ever surface, and a pool that only grows eventually walls out every lane:
/// this listener's sat at 635 rows, which silenced the trending lane entirely
/// and had gated the taste walk off for weeks.
pub(crate) const POOL_KEEP: i64 = 200;

/// Bound the pool. forget_discovery per row rather than one DELETE, so the
/// lane sidecar goes with each candidate.
pub fn prune_pool(state: &Arc<AppState>, user: i64) {
    // A week's grace before a row may be pruned - see discovery_overflow.
    let settled = now_ms() - 7 * 86_400_000;
    for ext_id in state.db.discovery_overflow(user, POOL_KEEP, settled) {
        state.db.forget_discovery(user, &ext_id);
    }
}
/// How often to go looking for new candidates.
const HARVEST_EVERY_MS: i64 = 6 * 60 * 60 * 1000;
/// Artists of yours to expand from, and how far each expands.
const SEED_ARTISTS: i64 = 8;
const RELATED_PER_SEED: usize = 8;
const TRACKS_PER_ARTIST: usize = 6;
/// Politeness between catalogue calls.
const GAP: Duration = Duration::from_millis(700);
/// A dismissed TRACK hard-blocks re-harvest for this long (Stage 7).
const TRACK_REJECT_HARD_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// A dismissed ARTIST hard-blocks for this long...
const ARTIST_REJECT_HARD_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// ...and stays out of the SEED seat for this much longer again: rejection
/// softens with age instead of either vanishing overnight or banning forever.
const ARTIST_REJECT_SOFT_MS: i64 = 2 * ARTIST_REJECT_HARD_MS;
/// The weakest score the discovery feed will show. Lower than any collector
/// threshold on purpose: suggesting costs nothing, buying does (Stage 9).
pub(crate) const FEED_FLOOR: f64 = 0.45;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn client(secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(secs))
        .user_agent("AttackFM/0.1 (personal music server)")
        .build()
        .unwrap_or_default()
}

/// Lowercase, unaccented, punctuation folded to single spaces. A catalogue and
/// a file's tags almost never agree character for character - "Beyoncé" against
/// "Beyonce", "Don't" against "Dont" - and a filter that misses is a shelf
/// offering music the listener already owns.
/// fold(), then with the joiner words dropped: "&", "+" and "and" all read as
/// nothing, so "Florence + The Machine" and "Florence and the Machine" carry
/// the same key. Only for ARTIST identity matching - titles keep full fold().
pub fn artist_key_public(value: &str) -> String {
    artist_key(value)
}

fn artist_key(value: &str) -> String {
    fold(value)
        .split_whitespace()
        .filter(|w| *w != "and" && *w != "the")
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn fold(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut gap = false;
    for ch in value.chars() {
        // An apostrophe is dropped, not spaced: "Don't" and "Dont" are the same
        // song, and one tagger in three leaves it out.
        if ch == '\'' || ch == '\u{2019}' || ch == '\u{02bc}' {
            continue;
        }
        let plain = deaccent(ch);
        if plain.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.extend(plain.to_lowercase());
        } else {
            gap = true;
        }
    }
    out
}

/// The Latin letters a tagger and a catalogue disagree about. Anything outside
/// this passes through unchanged - a CJK title still folds to itself.
fn deaccent(ch: char) -> char {
    match ch {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' => 'a',
        'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' | 'Ā' => 'A',
        'é' | 'è' | 'ê' | 'ë' | 'ē' => 'e',
        'É' | 'È' | 'Ê' | 'Ë' | 'Ē' => 'E',
        'í' | 'ì' | 'î' | 'ï' | 'ī' => 'i',
        'Í' | 'Ì' | 'Î' | 'Ï' | 'Ī' => 'I',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'ō' => 'o',
        'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' | 'Ø' | 'Ō' => 'O',
        'ú' | 'ù' | 'û' | 'ü' | 'ū' => 'u',
        'Ú' | 'Ù' | 'Û' | 'Ü' | 'Ū' => 'U',
        'ñ' => 'n',
        'Ñ' => 'N',
        'ç' => 'c',
        'Ç' => 'C',
        _ => ch,
    }
}

/// Words that mark an aside as saying nothing about WHICH recording this is.
/// Deliberately short: "remix", "live" and "acoustic" are absent, because a
/// track wearing one of those is a different performance, not the same file.
const NOISE_WORDS: [&str; 16] = [
    "feat",
    "ft",
    "featuring",
    "remaster",
    "remastered",
    "explicit",
    "clean",
    "radio edit",
    "single version",
    "album version",
    "bonus",
    "deluxe",
    "expanded",
    "edition",
    "anniversary",
    "original mix",
];

fn is_noise(segment: &str) -> bool {
    let s = fold(segment);
    if s.is_empty() {
        return true;
    }
    // A bare year is NOT noise. "Alive (2007)" is a record; "Alive - 2007
    // Remaster" is caught below by the word, not the number. Erring the other
    // way would hide a song the listener does not have.
    let padded = format!(" {s} ");
    NOISE_WORDS.iter().any(|w| padded.contains(&format!(" {w} ")))
}

/// A title reduced to the recording it names: bracketed asides and a trailing
/// " - ..." dropped when, and only when, they are noise.
fn title_key(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut aside = String::new();
    let mut depth = 0u32;
    for ch in title.chars() {
        match ch {
            '(' | '[' if depth == 0 => {
                depth = 1;
                aside.clear();
            }
            ')' | ']' if depth == 1 => {
                depth = 0;
                if !is_noise(&aside) {
                    out.push(' ');
                    out.push_str(&aside);
                }
            }
            _ if depth == 1 => aside.push(ch),
            _ => out.push(ch),
        }
    }
    // An unclosed bracket: keep what was swallowed rather than losing the title.
    if depth == 1 {
        out.push(' ');
        out.push_str(&aside);
    }
    let parts: Vec<&str> = out.split(" - ").collect();
    if parts.len() > 1 && is_noise(parts[parts.len() - 1]) {
        out = parts[..parts.len() - 1].join(" - ");
    }
    fold(&out)
}

pub(crate) fn key_of(artist: &str, title: &str) -> String {
    format!("{}|{}", fold(artist), title_key(title))
}

#[cfg(test)]
mod key_tests {
    use super::*;

    #[test]
    fn tags_and_catalogue_meet_in_the_middle() {
        // Accents, punctuation and case are spelling, not identity.
        assert_eq!(key_of("Beyoncé", "Don't Hurt Yourself"), key_of("BEYONCE", "Dont Hurt Yourself"));
        // Asides that do not change the recording.
        assert_eq!(key_of("The Weeknd", "Blinding Lights"), key_of("The Weeknd", "Blinding Lights (Explicit)"));
        assert_eq!(key_of("Queen", "Bohemian Rhapsody"), key_of("Queen", "Bohemian Rhapsody - 2011 Remaster"));
        assert_eq!(key_of("Doja Cat", "Kiss Me More"), key_of("Doja Cat", "Kiss Me More (feat. SZA)"));
    }

    #[test]
    fn different_recordings_stay_different() {
        // A remix, a live take and a re-recording are other songs; folding them
        // together would hide music the listener does not actually have.
        assert_ne!(key_of("Dua Lipa", "Levitating"), key_of("Dua Lipa", "Levitating (DaBaby Remix)"));
        assert_ne!(key_of("Nirvana", "Come As You Are"), key_of("Nirvana", "Come As You Are (Live)"));
        assert_ne!(key_of("Taylor Swift", "Red"), key_of("Taylor Swift", "Red (Taylor's Version)"));
        // A parenthetical that is part of the name survives.
        assert_ne!(key_of("Daft Punk", "Alive"), key_of("Daft Punk", "Alive (2007)"));
    }
}

/// One harvest seed and the retrieval lane that produced it (Stage 7
/// provenance: every candidate carries this lane forever).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SeedSpec {
    pub(crate) name: String,
    pub(crate) plays: i64,
    pub(crate) lane: &'static str,
}

/// Who discovery expands from for one listener.
///
/// Seeds come ONLY from this listener's own behavior: recent top artists
/// first, then long-term top artists, and - for someone with no play history
/// at all - the artists behind their favorites, then their playlists. A
/// listener with none of those gets an empty answer: the neutral cold-start
/// state. Server inventory is NEVER a seed; whose files happen to be on the
/// disk is not a statement of this listener's taste (the old
/// library-size fallback this replaced conflated the two). Artists inside
/// their rejection soft window are kept out of the seed seat.
pub(crate) fn harvest_seeds(db: &crate::db::Db, user: i64, now: i64) -> Vec<SeedSpec> {
    let since = now - 30 * 24 * 60 * 60 * 1000;
    let soft_rejected = db.rejected_keys_since(user, "artist", now - ARTIST_REJECT_SOFT_MS);
    let mut seeds: Vec<SeedSpec> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push = |name: String, plays: i64, lane: &'static str,
                    seeds: &mut Vec<SeedSpec>, seen: &mut HashSet<String>| {
        let key = artist_key(&name);
        if key.is_empty() || soft_rejected.contains(&key) || !seen.insert(key) {
            return;
        }
        seeds.push(SeedSpec { name, plays, lane });
    };
    for (name, plays) in db.top_artists(user, since, SEED_ARTISTS) {
        push(name, plays, "recent-artist", &mut seeds, &mut seen);
    }
    for (name, plays) in db.top_artists(user, 0, SEED_ARTISTS) {
        push(name, plays, "long-term-artist", &mut seeds, &mut seen);
    }
    if seeds.is_empty() {
        let favorites = db.favorites(user);
        for (name, plays) in db.artists_for(&favorites) {
            push(name, plays, "favorites", &mut seeds, &mut seen);
        }
        if seeds.is_empty() {
            for (name, plays) in db.playlist_artist_counts(user, SEED_ARTISTS) {
                push(name, plays, "playlist", &mut seeds, &mut seen);
            }
        }
    }
    seeds.truncate(SEED_ARTISTS.max(0) as usize);
    seeds
}

/// The folded track key rejection memory is keyed on (Stage 7).
pub(crate) fn candidate_track_key(artist: &str, title: &str) -> String {
    key_of(artist, title)
}

/// The whole library as comparison keys - what a candidate is tested against.
pub(crate) fn owned_keys(state: &Arc<AppState>) -> HashSet<String> {
    state
        .db
        .owned_names()
        .into_iter()
        .map(|(artist, title)| key_of(&artist, &title))
        .collect()
}

/// When each user last harvested, so the six-hourly sweep is per listener.
#[derive(Default)]
pub struct DiscoveryState {
    pub last_harvest: tokio::sync::Mutex<std::collections::HashMap<i64, i64>>,
    /// Per-user cache of AI-grouped "new music" playlists. Refreshed daily and
    /// regenerated in the background, so a request never waits on the model.
    new_music: tokio::sync::Mutex<std::collections::HashMap<i64, CachedNewMusic>>,
}

struct CachedNewMusic {
    playlists: Vec<serde_json::Value>,
    /// Wall-clock ms, not an Instant: the durable copy in `new_music_cache`
    /// has to seed this across restarts, and an Instant cannot time-travel.
    built_at: i64,
    refreshing: bool,
}

/// New-music playlists refresh once a day.
const NM_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/*
 * Through `ai::setting`, NOT a raw env read.
 *
 * `setting` resolves the owner's choice in Settings first and the environment
 * only after. Reading the variable directly means this feature silently ignores
 * the pane that exists to configure it: the model row is changed, the pickers
 * confirm it, and this one carries on asking for whatever the unit file said -
 * with no error anywhere, because a model name is only ever wrong later.
 */
fn nm_ai_url() -> Option<String> {
    crate::ai::setting("url", "AFM_AI_URL")
}
fn nm_ai_model() -> Option<String> {
    crate::ai::setting("chatModel", "AFM_AI_MODEL")
}

impl DiscoveryState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

// --- harvest -----------------------------------------------------------------

/// Fills the candidate pool for one listener from the neighbourhood of the
/// artists they actually play.
/// Harvest from artists the CALLER just named, ignoring both the clock and the
/// pool cap.
///
/// The background sweep is rate-limited and stops once the pool is full,
/// because nobody asked it to run. This one is different: the listener reached
/// the end of a Date and asked for more, and a request answered with "not yet,
/// come back in six hours" is a refusal dressed as a policy. The seeds are the
/// artists behind what they just kept and what they have always liked, so the
/// next batch is shaped by the verdicts they just gave.
pub async fn harvest_seeded(state: &Arc<AppState>, user: i64, seeds: Vec<(String, i64)>) {
    if seeds.is_empty() {
        return;
    }
    // The clock still gets stamped: an on-demand run counts as the sweep for
    // this window, so the two cannot both go out to Deezer at once.
    state.discovery.last_harvest.lock().await.insert(user, now_ms());
    let seeds = seeds
        .into_iter()
        .map(|(name, plays)| SeedSpec { name, plays, lane: "date-verdict" })
        .collect();
    harvest_from(state, user, seeds).await;
}

pub async fn harvest(state: &Arc<AppState>, user: i64) {
    {
        let mut last = state.discovery.last_harvest.lock().await;
        let due = last.get(&user).map(|t| now_ms() - t >= HARVEST_EVERY_MS).unwrap_or(true);
        if !due {
            return;
        }
        last.insert(user, now_ms());
    }
    let (pool, _) = state.db.discovery_counts(user);
    if pool >= POOL_TARGET {
        return;
    }

    let seeds = harvest_seeds(&state.db, user, now_ms());
    if seeds.is_empty() {
        // The honest cold start: nothing about this listener is known yet, so
        // nothing is harvested in their name. Onboarding picks, favorites, or
        // an imported playlist are what open the door.
        return;
    }
    harvest_from(state, user, seeds).await;
}

/// The walk itself: seeds -> their neighbours -> candidates you do not own.
/// Shared by the background sweep and the on-demand run so the two can never
/// drift into harvesting differently.
async fn harvest_from(state: &Arc<AppState>, user: i64, seeds: Vec<SeedSpec>) {
    let owned = owned_keys(state);
    let c = client(15);

    for seed in seeds {
        let seed_name = seed.name;
        let lane = seed.lane;
        // Your artist, in the catalogue's terms.
        let Some(seed_id) = deezer_artist_id(&c, &seed_name, true).await else { continue };
        tokio::time::sleep(GAP).await;

        // Their neighbours - and the seed itself, since their back catalogue is
        // full of things you may not own either.
        let mut artists: Vec<(u64, String)> = vec![(seed_id, seed_name.clone())];
        if let Some(rel) = deezer_related(&c, seed_id).await {
            artists.extend(rel.into_iter().take(RELATED_PER_SEED));
        }
        tokio::time::sleep(GAP).await;

        for (artist_id, artist_name) in artists {
            let Some(tracks) = deezer_top(&c, artist_id).await else { continue };
            for t in tracks.into_iter().take(TRACKS_PER_ARTIST) {
                if owned.contains(&key_of(&t.artist, &t.title)) {
                    continue;
                }
                if is_rejected(&state.db, user, &t.artist, &t.title) {
                    continue;
                }
                let _ = state.db.add_discovery(
                    user,
                    &t.ext_id,
                    &t.title,
                    &t.artist,
                    &t.cover,
                    &t.url,
                    &t.preview,
                    &seed_name,
                    t.popularity,
                    lane,
                );
            }
            tokio::time::sleep(GAP).await;
            let _ = artist_name;
        }
    }
}

/// Resolve one artist by NAME (strictly - a wrong match ingests a stranger's
/// catalog) and add a few of their tracks to the pool. The door the
/// ListenBrainz harvest and the scene walk share with nobody else: candidates
/// from any source ride the same insertion, dedupe and scoring as Deezer's.
pub async fn ingest_artist_by_name(
    state: &Arc<AppState>,
    user: i64,
    c: &reqwest::Client,
    artist: &str,
    seed_name: &str,
    take: usize,
    lane: &'static str,
) -> usize {
    let Some(id) = deezer_artist_id(c, artist, true).await else { return 0 };
    tokio::time::sleep(GAP).await;
    let Some(tracks) = deezer_top(c, id).await else { return 0 };
    tokio::time::sleep(GAP).await;
    let owned = owned_keys(state);
    let mut added = 0usize;
    for t in tracks.into_iter().take(take) {
        if owned.contains(&key_of(&t.artist, &t.title)) {
            continue;
        }
        if is_rejected(&state.db, user, &t.artist, &t.title) {
            continue;
        }
        if state
            .db
            .add_discovery(
                user, &t.ext_id, &t.title, &t.artist, &t.cover, &t.url, &t.preview, seed_name,
                t.popularity, lane,
            )
            .is_ok()
        {
            added += 1;
        }
    }
    added
}

/// Whether durable rejection memory (Stage 7) currently blocks this
/// candidate: a dismissed track inside its hard window, or a dismissed artist
/// inside theirs.
pub(crate) fn is_rejected(db: &crate::db::Db, user: i64, artist: &str, title: &str) -> bool {
    let now = now_ms();
    db.rejection_active(user, "artist", &artist_key(artist), now, ARTIST_REJECT_HARD_MS)
        || db.rejection_active(user, "track", &candidate_track_key(artist, title), now, TRACK_REJECT_HARD_MS)
}

struct CandidateTrack {
    ext_id: String,
    title: String,
    artist: String,
    cover: String,
    url: String,
    preview: String,
    popularity: f64,
}

/// The catalogue's id for an artist by name. Public so the album filler can
/// reach the same lookup rather than keeping a second copy of it.
pub async fn deezer_artist_id_public(c: &reqwest::Client, name: &str) -> Option<u64> {
    deezer_artist_id(c, name, false).await
}

/// A title reduced to the recording it names. Public for the same reason.
pub fn title_key_public(title: &str) -> String {
    title_key(title)
}

async fn deezer_artist_id(c: &reqwest::Client, name: &str, strict: bool) -> Option<u64> {
    let v: serde_json::Value = c
        .get("https://api.deezer.com/search/artist")
        .query(&[("q", name), ("limit", "3")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let items = v.get("data")?.as_array()?;
    let want = name.to_lowercase();
    /*
     * A folded match is always PREFERRED; whether a miss may fall back to
     * Deezer's first hit depends on who is asking. Harvest must not fall
     * back: among small bands same-name collisions are the rule, and a wrong
     * first hit means ingesting a stranger's entire catalog. The read-only
     * callers (the Rabbit hole hop, the album-gaps shelf) keep the fallback -
     * for them a wrong guess costs a bad suggestion, an empty answer costs
     * the whole feature.
     *
     * The match key folds "&"/"+" against "and" too: "Simon & Garfunkel" in
     * the tags versus "Simon and Garfunkel" in the catalogue would otherwise
     * mismatch identically on every cycle - a permanent miss wearing the
     * costume of a transient one.
     */
    let want_key = artist_key(&want);
    let matched = items.iter().find(|a| {
        a.get("name")
            .and_then(|n| n.as_str())
            .map(|n| artist_key(n) == want_key)
            .unwrap_or(false)
    });
    let chosen = if strict { matched } else { matched.or_else(|| items.first()) };
    chosen.and_then(|a| a.get("id")).and_then(|i| i.as_u64())
}

async fn deezer_related(c: &reqwest::Client, id: u64) -> Option<Vec<(u64, String)>> {
    let v: serde_json::Value = c
        .get(format!("https://api.deezer.com/artist/{id}/related"))
        .query(&[("limit", "10")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    Some(
        v.get("data")?
            .as_array()?
            .iter()
            .filter_map(|a| {
                Some((
                    a.get("id")?.as_u64()?,
                    a.get("name")?.as_str()?.to_string(),
                ))
            })
            .collect(),
    )
}

async fn deezer_top(c: &reqwest::Client, id: u64) -> Option<Vec<CandidateTrack>> {
    let v: serde_json::Value = c
        .get(format!("https://api.deezer.com/artist/{id}/top"))
        .query(&[("limit", "8")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let items = v.get("data")?.as_array()?;
    // Deezer's rank runs to about a million; normalise so popularity is a
    // nudge in [0,1] rather than a number that swamps every other term.
    Some(
        items
            .iter()
            .filter_map(|t| {
                let id = t.get("id")?.as_u64()?;
                let title = t.get("title")?.as_str()?.to_string();
                let artist = t.pointer("/artist/name")?.as_str()?.to_string();
                if title.is_empty() || artist.is_empty() {
                    return None;
                }
                Some(CandidateTrack {
                    ext_id: format!("deezer:track:{id}"),
                    title,
                    artist,
                    cover: t
                        .pointer("/album/cover_medium")
                        .and_then(|x| x.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    url: t.get("link").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                    preview: t
                        .get("preview")
                        .and_then(|x| x.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    popularity: (t.get("rank").and_then(|x| x.as_f64()).unwrap_or(0.0)
                        / 1_000_000.0)
                        .clamp(0.0, 1.0),
                })
            })
            .collect(),
    )
}

// --- listening ---------------------------------------------------------------

/// Lyrics for a track nobody here owns, from lrclib - the same free database
/// the app's own lyrics pane reads.
async fn fetch_lyrics(c: &reqwest::Client, artist: &str, title: &str) -> Option<String> {
    let v: serde_json::Value = c
        .get("https://lrclib.net/api/get")
        .query(&[("artist_name", artist), ("track_name", title)])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let words = v
        .get("plainLyrics")
        .and_then(|x| x.as_str())
        .filter(|s| s.trim().len() >= 40)?
        .to_string();
    Some(words)
}

/// Listens to a few waiting candidates: reads their words, measures their
/// tempo, and scores them against this listener.
pub async fn listen_cycle(state: &Arc<AppState>, user: i64) -> bool {
    let waiting = state.db.discoveries_needing_work(user, LISTEN_BATCH);
    if waiting.is_empty() {
        return false;
    }
    // A cold shelf has no taste to read, but its chart candidates still
    // need their measurements - a date card needs its sound. The house
    // prior scores everything neutral, which for a chart pick is the truth.
    let (taste, all) = match crate::curator::user_taste_for(state, user) {
        Some(pair) => pair,
        None => (crate::taste::UserTaste::cold(user), state.db.all_features()),
    };
    let by_id: std::collections::HashMap<i64, &crate::db::TrackFeatures> =
        all.iter().map(|f| (f.track_id, f)).collect();
    let lanes = state.db.discovery_lanes(user);
    let mood = crate::mood::load(state, user);
    let c = client(20);

    for cand in waiting {
        // The words, embedded by the same model the library went through - so
        // the two vectors live in the same space and cosine means something.
        let vec = match fetch_lyrics(&c, &cand.artist, &cand.title).await {
            Some(words) => crate::curator::embed_text(&words).await,
            None => None,
        };
        // The tempo, measured off the preview rather than guessed.
        let bpm = if cand.preview.is_empty() {
            None
        } else {
            crate::tempo::analyze_url(&cand.preview).await
        };

        // The seed artist IS the genre signal, as the old comment said - so
        // now it is actually used instead of being noted and then passed as
        // None, which made a quarter of the score a constant.
        let tags = crate::taste::artist_tags(&by_id, &cand.seed);
        let score = crate::taste::score_candidate(&taste, vec.as_deref(), bpm, &tags) as f64
            + score_extras(lanes.get(&cand.ext_id), cand.popularity, mood.as_ref(), vec.as_deref(), bpm);

        let _ = state.db.save_discovery_features(user, &cand.ext_id, bpm, vec.as_deref(), score);
        tokio::time::sleep(GAP).await;
    }
    true
}

/// The popularity term, inverted.
///
/// This used to be `+ 0.1 * popularity` - a fame BONUS, in the one pipeline
/// whose whole purpose is finding small artists. A candidate with no lyrics
/// and no BPM scored neutral everywhere plus its fame, so famous unmeasured
/// tracks floated over obscure measured ones. The nudge now rewards
/// smallness, at half the old weight so taste still dominates: a perfect
/// match stays a perfect match, and between two equal matches the smaller
/// artist wins.
fn pop_nudge(popularity: f64) -> f64 {
    0.05 * (1.0 - popularity.clamp(0.0, 1.0))
}

/// What sits on TOP of the taste score: the lane's own nudge plus the mood
/// term. One function so listen_cycle and rescore cannot drift apart.
///
/// The nudge is lane-aware because the lanes disagree about fame on purpose.
/// The taste walk and the scene engine exist to find SMALL artists, so their
/// candidates keep the inverted nudge. The trending and fresh lanes exist to
/// answer "what is popping off" - inverting fame there would penalise a
/// candidate for the very thing it was harvested for, so they get a small
/// bonus scaled by their own chart standing instead. Same ceiling either way:
/// the nudge never outweighs taste.
///
/// The mood term is the profile's vote, +/-0.10 around neutral: a candidate
/// near a mood the listener is actually living in right now outranks one near
/// nothing, and one that matches none of the current moods is gently held
/// back. No profile, no term - scoring stays exactly what it was.
fn score_extras(
    lane: Option<&(String, f64)>,
    popularity: f64,
    mood: Option<&crate::mood::MoodProfile>,
    vec: Option<&[f32]>,
    bpm: Option<f64>,
) -> f64 {
    let nudge = match lane.map(|(l, r)| (l.as_str(), *r)) {
        Some(("trending" | "fresh", rank)) => 0.05 * rank.clamp(0.0, 1.0),
        _ => pop_nudge(popularity),
    };
    let mood_term = match mood {
        Some(p) => (crate::mood::affinity(p, vec, bpm) - 0.5) * 0.2,
        None => 0.0,
    };
    nudge + mood_term
}

/// Rescores everything already listened to. Taste moves; a pool scored against
/// last month's listening would slowly stop being about you.
/// Called from the collector's cycle, once per listener per pass, so the pool
/// follows the listener rather than the day each candidate happened to land.
pub fn rescore(state: &Arc<AppState>, user: i64) {
    // Pool first, taste second: the pool is a bounded read, taste_for loads
    // and decodes every track's feature blobs - a listener with nothing to
    // rescore should not pay for the heavy half.
    let pool = state.db.all_discoveries(user);
    if pool.is_empty() {
        return;
    }
    let (taste, all) = match crate::curator::user_taste_for(state, user) {
        Some(pair) => pair,
        // The cold shelf again: neutral scores are honest scores here.
        None => (crate::taste::UserTaste::cold(user), state.db.all_features()),
    };
    let by_id: std::collections::HashMap<i64, &crate::db::TrackFeatures> =
        all.iter().map(|f| (f.track_id, f)).collect();
    let lanes = state.db.discovery_lanes(user);
    let mood = crate::mood::load(state, user);
    // The seed artist's tags stand in for the candidate's own, which this
    // endpoint never supplies. A quarter of every score used to be the literal
    // constant 0.5 because `None` was passed for genre here; the seed is the
    // reason the candidate is in the pool at all, so its tags are the closest
    // honest answer available.
    let mut seed_tags: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for d in pool {
        let tags = seed_tags
            .entry(d.seed.to_lowercase())
            .or_insert_with(|| crate::taste::artist_tags(&by_id, &d.seed))
            .clone();
        let score = crate::taste::score_candidate(&taste, d.lyric_vec.as_deref(), d.bpm, &tags)
            as f64
            + score_extras(lanes.get(&d.ext_id), d.popularity, mood.as_ref(), d.lyric_vec.as_deref(), d.bpm);
        state.db.set_discovery_score(user, &d.ext_id, score);
    }
}

/// Drops candidates the listener has since acquired - the shelf must not offer
/// what is already in the library.
pub fn prune_owned(state: &Arc<AppState>, user: i64) {
    let owned = owned_keys(state);
    for d in state.db.all_discoveries(user) {
        if owned.contains(&key_of(&d.artist, &d.title)) {
            state.db.forget_discovery(user, &d.ext_id);
        }
    }
}

// --- endpoints ---------------------------------------------------------------

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use crate::auth;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryOut {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub cover: String,
    pub url: String,
    pub preview: String,
    /// The artist of theirs this hangs off - the "because you play X" line.
    pub seed: String,
    pub bpm: Option<f64>,
    /// Whether its words were actually read, so the client can say why it is
    /// here honestly rather than implying more than was measured.
    pub lyrics_read: bool,
    pub score: f64,
    pub retrieval_lane: String,
    pub familiarity_class: String,
    pub bridge: String,
}

pub(crate) fn discovery_class(score: f64, seed: &str, lane: &str) -> Option<&'static str> {
    if seed.trim().is_empty() || lane.trim().is_empty() {
        return None;
    }
    if score >= 0.62 {
        Some("adjacent")
    } else if score >= 0.52 {
        Some("exploratory")
    } else if score >= FEED_FLOOR {
        Some("wildcard")
    } else {
        None
    }
}

/// `GET /api/new-music` - AI-grouped playlists of music this listener does NOT
/// own yet, drawn from the discovery pool. Refreshed daily; the grouping is
/// regenerated in the background so the request itself never waits on a model.
pub async fn new_music(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    Ok(Json(json!({ "playlists": new_music_lists(&state, caller.id).await })))
}

async fn new_music_lists(state: &Arc<AppState>, user: i64) -> Vec<serde_json::Value> {
    if nm_ai_url().is_none() {
        return Vec::new();
    }
    let mut cache = state.discovery.new_music.lock().await;
    // A restart used to empty this shelf for everyone: the cache was memory
    // alone, and a box that redeploys often served [] all day. The durable
    // copy seeds it back.
    if !cache.contains_key(&user) {
        if let Some((body, at)) = state.db.new_music_get(user) {
            if let Ok(pls) = serde_json::from_str::<Vec<serde_json::Value>>(&body) {
                cache.insert(user, CachedNewMusic { playlists: pls, built_at: at, refreshing: false });
            }
        }
    }
    let now = crate::db::now_ms();
    let entry = cache.get(&user);
    let fresh = entry.map(|e| now - e.built_at < NM_TTL_MS && !e.playlists.is_empty()).unwrap_or(false);
    if fresh {
        return entry.map(|e| e.playlists.clone()).unwrap_or_default();
    }
    // Serve whatever we have (stale or empty) at once; kick a background rebuild.
    let stale = entry.map(|e| e.playlists.clone()).unwrap_or_default();
    let already = entry.map(|e| e.refreshing).unwrap_or(false);
    if !already {
        cache
            .entry(user)
            .and_modify(|e| e.refreshing = true)
            .or_insert(CachedNewMusic {
                playlists: Vec::new(),
                built_at: crate::db::now_ms(),
                refreshing: true,
            });
        let bg = Arc::clone(state);
        // What the shelf held before this rebuild, so only genuinely NEW work
        // interrupts anyone: a daily refresh that reassembles the same
        // playlists is housekeeping, not news.
        let before: Vec<String> = cache
            .get(&user)
            .map(|e| {
                e.playlists
                    .iter()
                    .filter_map(|p| p.get("title").and_then(|t| t.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        tokio::spawn(async move {
            let built = build_new_music(&bg, user).await;
            let mut cache = bg.discovery.new_music.lock().await;
            match built {
                Some(pls) if !pls.is_empty() => {
                    let fresh: Vec<&str> = pls
                        .iter()
                        .filter_map(|p| p.get("title").and_then(|t| t.as_str()))
                        .filter(|t| !before.iter().any(|b| b == t))
                        .collect();
                    if !fresh.is_empty() {
                        let body = if fresh.len() == 1 {
                            format!("\u{201c}{}\u{201d} is ready to hear.", fresh[0])
                        } else {
                            format!(
                                "\u{201c}{}\u{201d} and {} more are ready to hear.",
                                fresh[0],
                                fresh.len() - 1
                            )
                        };
                        crate::push::notify(
                            &bg,
                            user,
                            crate::push::Kind::Curated,
                            "Your curator has been busy".into(),
                            body,
                        );
                    }
                    if let Ok(body) = serde_json::to_string(&pls) {
                        let _ = bg.db.new_music_put(user, &body);
                    }
                    cache.insert(
                        user,
                        CachedNewMusic { playlists: pls, built_at: crate::db::now_ms(), refreshing: false },
                    );
                }
                _ => {
                    // Failure backs off in MEMORY only - a restart retries,
                    // and the durable copy keeps serving yesterday's answer.
                    if let Some(e) = cache.get_mut(&user) {
                        e.refreshing = false;
                        e.built_at = crate::db::now_ms();
                    }
                }
            }
        });
    }
    stale
}

/// The model groups the discovery pool into a few themed playlists of unowned
/// music; every ext_id is validated back against the pool, and the full track is
/// attached so the client can preview or import it.
fn nm_item(d: &crate::db::DiscoveryRow) -> serde_json::Value {
    json!({
        "id": d.ext_id, "title": d.title, "artist": d.artist, "cover": d.cover,
        "url": d.url, "preview": d.preview, "seed": d.seed, "bpm": d.bpm,
        "lyricsRead": d.lyric_vec.is_some(), "score": d.score,
        "retrievalLane": d.lane,
        "familiarityClass": discovery_class(d.score, &d.seed, &d.lane),
    })
}

/// One proactive rebuild per curator pass: the shelf is READY when the
/// listener arrives instead of assembling behind their first visit - and
/// only one, because the grouping chat is minutes of the shared model's
/// time and five at once is how Music Date starved before.
pub async fn new_music_warm_one(state: &Arc<AppState>) {
    if nm_ai_url().is_none() {
        return;
    }
    let since = crate::db::now_ms() - 30 * 86_400_000;
    for user in state.db.listeners_since(since) {
        let now = crate::db::now_ms();
        let stale = {
            let cache = state.discovery.new_music.lock().await;
            match cache.get(&user) {
                Some(e) => !e.refreshing && (now - e.built_at > NM_TTL_MS || e.playlists.is_empty()),
                None => state
                    .db
                    .new_music_get(user)
                    .map(|(_, at)| now - at > NM_TTL_MS)
                    .unwrap_or(true),
            }
        };
        if stale {
            // Serving discards the value; the point is the rebuild it kicks.
            let _ = new_music_lists(state, user).await;
            return;
        }
    }
}

async fn build_new_music(state: &Arc<AppState>, user: i64) -> Option<Vec<serde_json::Value>> {
    let url = nm_ai_url()?;
    let model = nm_ai_model()?;
    let pool = state.db.top_discoveries(user, 90);
    if pool.len() < 6 {
        return None;
    }

    /*
     * The two lane lists come out in CODE, before the model sees anything.
     *
     * "Popping off right now" and "Fresh this week" are facts about where a
     * candidate came from, not a vibe for a model to intuit - the chart lane
     * and the fresh-release lane already are those playlists. Building them
     * here costs zero tokens on a box that generates five a second, they
     * cannot be mis-grouped, and the model's slow call is saved for the one
     * job only it can do: hearing the moods in the taste-walk finds.
     */
    let lanes = state.db.discovery_lanes(user);
    let mut lead = Vec::new();
    for (lane, id, title, blurb) in [
        ("trending", "nm-popping", "Popping off right now", "What everyone is suddenly playing - the cuts of it near your taste."),
        ("fresh", "nm-fresh", "Fresh this week", "Just released, and already moving."),
    ] {
        let items: Vec<serde_json::Value> = pool
            .iter()
            .filter(|d| lanes.get(&d.ext_id).is_some_and(|(l, _)| l == lane))
            .take(12)
            .map(nm_item)
            .collect();
        if items.len() >= 4 {
            lead.push(json!({ "id": id, "title": title, "blurb": blurb, "items": items }));
        }
    }

    // The model groups what is left - the taste and scene finds.
    let pool: Vec<crate::db::DiscoveryRow> = pool
        .into_iter()
        .filter(|d| !lanes.get(&d.ext_id).is_some_and(|(l, _)| l == "trending" || l == "fresh"))
        .take(60)
        .collect();
    if pool.len() < 6 {
        return (!lead.is_empty()).then_some(lead);
    }
    let mut lines = Vec::new();
    for (i, d) in pool.iter().enumerate() {
        lines.push(format!("{}|{} — {} (near {})", i + 1, d.artist, d.title, d.seed));
    }
    let prompt = format!(
        "You build 'new music' playlists for one listener from tracks they do NOT own yet - fresh picks harvested from artists near their taste. Candidates, one per line as N|artist — title (near = the artist of theirs it came from):\n{}\n\n\
         Group them into 3-5 themed playlists of new music, each a coherent scene or vibe - a genre lane, a 'because you play X' set, or a mood. Titles short and evocative (2-4 words); one-line blurbs, warm and plain, no exclamation marks. Each playlist 5-12 tracks.\n\
         Answer with STRICT JSON only: [{{\"title\":\"...\",\"blurb\":\"...\",\"ids\":[N,...]}}] using ONLY the numbers N above.",
        lines.join("\n"),
    );
    // Generous, because nothing waits on it: the list is built in the
    // background and served from cache. Two minutes was cutting it fine -
    // grouping sixty candidates into named sets is several hundred tokens of
    // JSON, and the box this runs on manages about five a second on CPU, so
    // the model was being cut off mid-array and the whole build discarded.
    let reply: serde_json::Value = client(600)
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({ "model": model, "messages": [{ "role": "user", "content": prompt }], "temperature": 0.8, "max_tokens": 900 }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let content = reply.pointer("/choices/0/message/content")?.as_str()?;
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    if end <= start {
        return None;
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(content.get(start..=end)?).ok()?;

    let n = pool.len();
    let mut used: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (i, m) in parsed.into_iter().take(5).enumerate() {
        let title = m.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let blurb = m.get("blurb").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let items: Vec<serde_json::Value> = m
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_i64())
                    .filter_map(|k| usize::try_from(k).ok())
                    .filter(|k| *k >= 1 && *k <= n && used.insert(*k))
                    .filter_map(|k| pool.get(k - 1))
                    .map(nm_item)
                    .collect()
            })
            .unwrap_or_default();
        if title.is_empty() || items.len() < 4 {
            continue;
        }
        out.push(json!({ "id": format!("nm-{i}"), "title": title, "blurb": blurb, "items": items }));
    }
    let mut all = lead;
    all.extend(out);
    (!all.is_empty()).then_some(all)
}

/// `GET /api/discoveries` - the best of what this listener does not own.
pub async fn feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    // Before answering, not on the background sweep's schedule: a song
    // downloaded a minute ago must not come back as a suggestion on the very
    // next poll. The pool is small and this is a poll every few minutes.
    prune_owned(&state, caller.id);
    let mut items = Vec::new();
    for d in state.db.top_discoveries(caller.id, 80) {
        let Some(class) = discovery_class(d.score, &d.seed, &d.lane) else { continue };
        state.db.record_recommendation_exposure(
            caller.id,
            "discovery",
            &d.ext_id,
            None,
            &d.artist,
            class,
        );
        let bridge = format!("Because you play {}", d.seed);
        items.push(DiscoveryOut {
            id: d.ext_id,
            title: d.title,
            artist: d.artist,
            cover: d.cover,
            url: d.url,
            preview: d.preview,
            seed: d.seed,
            bpm: d.bpm,
            lyrics_read: d.lyric_vec.is_some(),
            score: d.score,
            retrieval_lane: d.lane,
            familiarity_class: class.into(),
            bridge,
        });
        if items.len() >= 40 {
            break;
        }
    }
    let (pool, listened) = state.db.discovery_counts(caller.id);
    Ok(Json(json!({
        "items": items,
        "progress": { "pool": pool, "listened": listened },
        // What the page needs to ask for listening honestly: how many distinct
        // songs this listener has played in the window, and how many the taste
        // model actually waits for. Both come from the gate itself, so the copy
        // ("2 of 4 songs") can never drift from the rule it describes.
        "taste": {
            "heard": crate::recommendation::heard_count(&state, caller.id),
            "needed": crate::recommendation::TASTE_MIN_TRACKS,
        },
    })))
}

#[derive(serde::Deserialize)]
pub struct DismissQuery {
    pub id: String,
    /// "track" (default) or "artist" - how wide the "not for me" reaches.
    pub scope: Option<String>,
}

/// `POST /api/discoveries/dismiss?id=&scope=` - not for me.
///
/// Durable (Stage 7): the candidate row is forgotten AND the rejection is
/// remembered, so the next harvest does not bring the same music straight
/// back. A track rejection hard-blocks that recording for 90 days; an artist
/// rejection blocks the artist for 30 days and keeps them out of the seed
/// seat for 30 more. Rejection softens with age rather than banning forever.
pub async fn dismiss(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DismissQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let row = state
        .db
        .all_discoveries(caller.id)
        .into_iter()
        .chain(state.db.discoveries_needing_work(caller.id, 1000))
        .find(|d| d.ext_id == q.id);
    if q.scope.as_deref() == Some("artist") {
        let artist = row.as_ref().map(|d| d.artist.clone()).unwrap_or_default();
        let key = artist_key(&artist);
        if !key.is_empty() {
            state.db.reject_discovery(caller.id, "artist", &key);
        }
    } else if let Some(d) = &row {
        state
            .db
            .reject_discovery(caller.id, "track", &candidate_track_key(&d.artist, &d.title));
    }
    state.db.forget_discovery(caller.id, &q.id);
    Ok(Json(json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
pub struct RelatedQuery {
    pub artist: String,
}

/// `GET /api/related?artist=` - one artist's neighbours in the catalogue's
/// own map, with enough face (picture, fan count) to draw a card. This is
/// the Rabbit hole plugin's step function: the client walks the graph one
/// hop at a time, and every hop is this endpoint with a new name. Live
/// against Deezer rather than cached: a hop is two small requests, and the
/// page's own session cache absorbs the repeats.
pub async fn related(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<RelatedQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let c = client(15);
    let Some(id) = deezer_artist_id(&c, &q.artist, false).await else {
        return Ok(Json(json!({ "artists": [] })));
    };
    let Ok(reply) = c
        .get(format!("https://api.deezer.com/artist/{id}/related"))
        .query(&[("limit", "18")])
        .send()
        .await
    else {
        return Ok(Json(json!({ "artists": [] })));
    };
    let v: serde_json::Value = reply.json().await.unwrap_or(json!({}));
    let artists: Vec<serde_json::Value> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|a| {
                    Some(json!({
                        "name": a.get("name")?.as_str()?,
                        "picture": a.get("picture_medium").and_then(|p| p.as_str()),
                        "fans": a.get("nb_fan").and_then(|f| f.as_u64()),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(json!({ "artists": artists })))
}
