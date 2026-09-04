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
use std::collections::{HashMap, HashSet};
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

/*
 * How long "not for me" is honoured.
 *
 * A dismissal is the one piece of taste a listener states outright, and until
 * now it lasted until the next harvest - which promptly offered the same song
 * back, because everything that made it a good candidate was still true.
 *
 * A song is refused for longer than an artist, because refusing a song is a
 * narrow, confident statement and refusing an artist is a mood. Neither is
 * forever: a refusal from last winter is history, not a life sentence, and the
 * row outlives its block so seed selection can still take the hint (below)
 * without the pool being permanently narrowed by one bad evening.
 */
const TRACK_REJECT_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const ARTIST_REJECT_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// "Less like this" on a card's REASON - a refused anchor (scope 'anchor',
/// written by `refuse_card` from the dismiss endpoint) keeps every candidate
/// that hangs off it out of the harvest and pulls the ones already pooled
/// down for this long. Longer than an artist refusal: the listener did not
/// say "not them", they said "not that thread".
const ANCHOR_REJECT_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// The most a refused anchor can cost a candidate. Enough to sink one whose
/// only thread was refused below every honest match; never enough to hide
/// one the listener has other reasons to meet.
const ANCHOR_REJECT_PENALTY: f64 = 0.15;
/// Artists of yours to expand from, and how far each expands.
const SEED_ARTISTS: usize = 8;
const RELATED_PER_SEED: usize = 8;
const TRACKS_PER_ARTIST: usize = 6;
/// Politeness between catalogue calls.
const GAP: Duration = Duration::from_millis(700);

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

/// The same identity keyed on the LEAD credit alone.
///
/// A promise carries the artist a catalogue printed ("Czarface"); the file
/// that lands carries the artist its tags print ("CZARFACE, Frankie
/// Pulitzer"). Those are not the same key, so the settle pass walked straight
/// past a song sitting in the library and the heart stayed pending for its
/// whole thirty-day life. Everything after the first separator is the
/// collaboration list - exactly the part the two sources disagree about - so
/// dropping it is what lets them meet. The TITLE still has to match on its own
/// key: this widens who, never what.
pub(crate) fn lead_key(artist: &str, title: &str) -> String {
    let lower = artist.to_lowercase();
    let mut cut = artist.len();
    for sep in [",", ";", "&", " feat.", " feat ", " featuring ", " with ", " x ", "/"] {
        if let Some(i) = lower.find(sep) {
            if i < cut {
                cut = i;
            }
        }
    }
    let lead = artist[..cut].trim();
    format!("{}|{}", fold(if lead.is_empty() { artist } else { lead }), title_key(title))
}

#[cfg(test)]
mod key_tests {
    use super::*;

    #[test]
    fn a_featured_credit_does_not_hide_the_song() {
        // The exact case that stranded three hearts: the promise named the
        // lead, the file named the whole room.
        assert_ne!(
            key_of("Czarface", "Grim-Visaged War"),
            key_of("CZARFACE, Frankie Pulitzer", "Grim-Visaged War")
        );
        assert_eq!(
            lead_key("Czarface", "Grim-Visaged War"),
            lead_key("CZARFACE, Frankie Pulitzer", "Grim-Visaged War")
        );
        // Every separator a credit list is built from.
        for other in [
            "Czarface & Friends", "Czarface feat. Someone", "Czarface featuring Someone",
            "Czarface with Someone", "Czarface x Someone", "Czarface/Someone", "Czarface; Someone",
        ] {
            assert_eq!(
                lead_key("Czarface", "Grim-Visaged War"),
                lead_key(other, "Grim-Visaged War"),
                "{other}"
            );
        }
        // It widens WHO, never WHAT: a different song by the same lead stays
        // a different key, and so does a different lead.
        assert_ne!(lead_key("Czarface", "Grim-Visaged War"), lead_key("Czarface", "Air Raid"));
        assert_ne!(lead_key("Czarface", "Grim-Visaged War"), lead_key("MF DOOM", "Grim-Visaged War"));
        // An artist whose NAME contains a separator keeps its own identity
        // rather than folding to an empty lead.
        assert_eq!(lead_key("& Friends", "Song"), lead_key("& Friends", "Song"));
    }

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

/// The artists a harvest grows FROM: what this listener has said yes to,
/// strongest first - hearts and Music Date keeps, then finished listens,
/// each decayed - trimmed to `n`. See `Db::heart_weighted_artists`.
///
/// This replaces two things. Play-start counts (`top_artists`), which
/// rewarded curiosity over conviction: the artist you tried four times and
/// skipped four times out-seeded the one you hearted. And the fallback that
/// seeded a quiet listener from the whole hub's library - everybody's
/// shelves, not theirs - which is where a housemate's taste used to leak
/// into a pool that is supposed to be strictly one person's. A listener
/// with no hearts and no finished listens has said nothing yet, and the
/// harvest waits for them to say something rather than guessing.
///
/// No window on the read: the sixty-day half-life inside it already ranks
/// this week's heart above last winter's, and a listener whose only hearts
/// ARE from last winter should be harvested from them, not from nothing.
pub(crate) fn seed_artists(state: &Arc<AppState>, user: i64, n: usize) -> Vec<String> {
    state
        .db
        .heart_weighted_artists(user, 0, now_ms())
        .into_iter()
        .take(n)
        .map(|(name, _)| name)
        .collect()
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
    harvest_from(state, user, seeds.into_iter().map(|(name, _)| name).collect()).await;
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

    // Hearts and keeps, then finished listens - never play starts, never the
    // hub's library. Nothing to grow from means nothing grows: see
    // `seed_artists` for why the old fallback went.
    let seeds = seed_artists(state, user, SEED_ARTISTS);
    if seeds.is_empty() {
        return;
    }
    harvest_from(state, user, seeds).await;
}

/// The walk itself: seeds -> their neighbours -> candidates you do not own.
/// Shared by the background sweep and the on-demand run so the two can never
/// drift into harvesting differently.
async fn harvest_from(state: &Arc<AppState>, user: i64, seeds: Vec<String>) {
    let owned = owned_keys(state);
    let refused = refused_anchors(&state.db, user);
    let c = client(15);

    for seed_name in seeds {
        // Your artist, in the catalogue's terms.
        let Some(seed_id) = deezer_artist_id(&c, &seed_name, true).await else { continue };
        tokio::time::sleep(GAP).await;

        // Their neighbours - and the seed itself, since their back catalogue is
        // full of things you may not own either. Each carries the THREAD its
        // candidates will be filed under: the seed's own songs are
        // 'same_artist' at full strength; a neighbour is 'deezer_related' at
        // 1/(1+rank), the rank counted from one so that even the nearest
        // neighbour (0.5) never reads as close as the artist themselves.
        let mut artists: Vec<(u64, &'static str, f64)> = vec![(seed_id, "same_artist", 1.0)];
        if let Some(rel) = deezer_related(&c, seed_id).await {
            artists.extend(
                rel.into_iter()
                    .take(RELATED_PER_SEED)
                    .enumerate()
                    .map(|(i, (id, _name))| (id, "deezer_related", 1.0 / (2.0 + i as f64))),
            );
        }
        tokio::time::sleep(GAP).await;

        for (artist_id, kind, strength) in artists {
            let Some(tracks) = deezer_top(&c, artist_id).await else { continue };
            for t in tracks.into_iter().take(TRACKS_PER_ARTIST) {
                if owned.contains(&key_of(&t.artist, &t.title))
                    || is_rejected(&state.db, user, &t.artist, &t.title)
                {
                    continue;
                }
                file_candidate(&state.db, user, &t, &seed_name, kind, strength, &refused);
            }
            tokio::time::sleep(GAP).await;
        }
    }
}

/// The threads this listener has cut - "less like this" said about a card's
/// REASON (scope 'anchor'), still inside its window. Read once per walk;
/// `file_candidate` asks it about every candidate.
pub(crate) fn refused_anchors(db: &crate::db::Db, user: i64) -> HashSet<String> {
    db.rejected_keys_since(user, "anchor", now_ms() - ANCHOR_REJECT_MS)
}

/// The one way a catalogue track enters the pool from this module.
///
/// Through `add_discovery`'s judged-song guard first - and ONLY if the row
/// was taken does the candidate acquire its thread to `anchor` (the artist of
/// the listener's it was reached from, `kind` and `strength` saying how) and
/// its release date. A song the listener already passed on is refused at the
/// door and must not collect threads on the way out. Returns whether it went
/// in.
///
/// A REFUSED thread is not a reason. When the listener has said "less like
/// this" about `anchor` (`refused`, scope 'anchor'), a candidate reached
/// only through it is not filed at all - the pool would otherwise refill
/// with the very thread they cut, and `rescore`'s penalty would spend its
/// whole life sinking rows that should never have landed. A candidate that
/// ALSO hangs off a thread they did not cut stays: they said no to the
/// reason, not to the song, and it keeps its other reasons and gains no new
/// thread from the refused one.
fn file_candidate(
    db: &crate::db::Db,
    user: i64,
    t: &CandidateTrack,
    anchor: &str,
    kind: &str,
    strength: f64,
    refused: &HashSet<String>,
) -> bool {
    if refused.contains(&artist_key(anchor)) {
        // Filed under a cut thread: nothing happens. If another walk filed
        // this song under a thread they kept, it is in the pool on THAT
        // reason and stays; if not, it never lands.
        return false;
    }
    let taken = db
        .add_discovery(
            user, &t.ext_id, &t.title, &t.artist, &t.cover, &t.url, &t.preview, anchor,
            t.popularity,
        )
        .unwrap_or(false);
    if !taken {
        return false;
    }
    db.add_discovery_anchor(user, &t.ext_id, anchor, kind, strength);
    if let Some(released) = &t.released {
        db.set_discovery_released(user, &t.ext_id, released);
    }
    true
}

/// Resolve one artist by NAME (strictly - a wrong match ingests a stranger's
/// catalog) and add a few of their tracks to the pool. The door the
/// ListenBrainz harvest and the scene walk share with nobody else: candidates
/// from any source ride the same insertion, dedupe and scoring as Deezer's.
///
/// `kind` and `strength` are the thread each candidate is filed under - the
/// ListenBrainz score, the MusicBrainz relation - which used to be thrown
/// away at this door. Returns the ids that went in, so the caller can tag
/// them with its lane.
#[allow(clippy::too_many_arguments)]
pub async fn ingest_artist_by_name(
    state: &Arc<AppState>,
    user: i64,
    c: &reqwest::Client,
    artist: &str,
    seed_name: &str,
    kind: &str,
    strength: f64,
    take: usize,
) -> Vec<String> {
    let Some(id) = deezer_artist_id(c, artist, true).await else { return Vec::new() };
    tokio::time::sleep(GAP).await;
    let Some(tracks) = deezer_top(c, id).await else { return Vec::new() };
    tokio::time::sleep(GAP).await;
    let owned = owned_keys(state);
    let refused = refused_anchors(&state.db, user);
    let mut added = Vec::new();
    for t in tracks.into_iter().take(take) {
        if owned.contains(&key_of(&t.artist, &t.title))
            || is_rejected(&state.db, user, &t.artist, &t.title)
        {
            continue;
        }
        if file_candidate(&state.db, user, &t, seed_name, kind, strength, &refused) {
            added.push(t.ext_id);
        }
    }
    added
}

/// The listener ASKED for this one, out loud (dj_voice.rs). It enters the
/// pool through the same door as every other candidate - the judged-song
/// guard, the rejection memory the caller already consulted - filed under
/// its own artist as a `keep` thread at full strength, and its seed set to
/// the sentence the card will show. Returns whether it is now in the pool,
/// which is NOT yet a download: the collector buys only what the pool
/// measures and scores above its floor, asked for or not.
pub(crate) fn file_asked(db: &crate::db::Db, user: i64, t: &CandidateTrack) -> bool {
    let taken = db
        .add_discovery(
            user, &t.ext_id, &t.title, &t.artist, &t.cover, &t.url, &t.preview, ASKED_SEED,
            t.popularity,
        )
        .unwrap_or(false);
    if !taken {
        return false;
    }
    db.add_discovery_anchor(user, &t.ext_id, &t.artist, "keep", 1.0);
    if let Some(released) = &t.released {
        db.set_discovery_released(user, &t.ext_id, released);
    }
    true
}

/// The seed a spoken request's candidates carry - what the card says.
pub(crate) const ASKED_SEED: &str = "you asked for this";

/// Whether this listener has said no to this song, or to whoever made it,
/// recently enough that offering it again would be ignoring them.
///
/// Keyed with `key_of` and `artist_key` - the same folds the rest of the pool
/// uses - so a re-offer under a different spelling is still the same refusal.
pub(crate) fn is_rejected(db: &crate::db::Db, user: i64, artist: &str, title: &str) -> bool {
    let now = now_ms();
    db.rejection_active(user, "artist", &artist_key(artist), now, ARTIST_REJECT_MS)
        || db.rejection_active(user, "track", &key_of(artist, title), now, TRACK_REJECT_MS)
}

/// Every LIBRARY track this listener's active rejections cover - the same
/// question as `is_rejected`, asked once for the whole library instead of
/// twice per candidate, for the surfaces that score every row on a press.
///
/// A "no" to a discovery card is a no to the song and, at artist scope, to
/// whoever made it; until now the DJ and the radio never read it, so a track
/// dismissed on the Discover shelf could be dealt back the same evening. Same
/// folds, same windows as the check above, so a re-offer under a different
/// spelling is still the same refusal.
pub(crate) fn rejected_track_ids(db: &crate::db::Db, user: i64) -> std::collections::HashSet<i64> {
    let now = now_ms();
    let artists = db.rejected_keys_since(user, "artist", now - ARTIST_REJECT_MS);
    let tracks = db.rejected_keys_since(user, "track", now - TRACK_REJECT_MS);
    if artists.is_empty() && tracks.is_empty() {
        return Default::default();
    }
    db.track_identities()
        .into_iter()
        .filter(|(_, artist, title, _)| {
            artists.contains(&artist_key(artist)) || tracks.contains(&key_of(artist, title))
        })
        .map(|(id, _, _, _)| id)
        .collect()
}

pub(crate) struct CandidateTrack {
    pub(crate) ext_id: String,
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) cover: String,
    pub(crate) url: String,
    pub(crate) preview: String,
    pub(crate) popularity: f64,
    /// When it came out, if the catalogue said. The top-tracks listing
    /// usually does not; read opportunistically, never invented.
    pub(crate) released: Option<String>,
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

/// The catalogue's id for an artist, but only when the name really matches.
///
/// The difference from `deezer_artist_id_public` is the whole reason this
/// exists: that one falls back to Deezer's first hit, which is right for a
/// read-only suggestion and wrong for anything DURABLE. Among small acts
/// same-name collisions are the rule, and a wrong first hit cached as an
/// artist's profile is a stranger's fan count and a stranger's discography
/// shown under their name on every card they appear on, until the row expires.
/// A miss here is a profile that stays thin, which is the honest failure.
pub(crate) async fn deezer_artist_id_strict(c: &reqwest::Client, name: &str) -> Option<u64> {
    deezer_artist_id(c, name, true).await
}

/// The whole `/artist/{id}` object in ONE request - fan count, album count,
/// picture and link all come from the same body, where the old profile code
/// spent a request per field.
pub(crate) async fn deezer_artist_object(c: &reqwest::Client, id: u64) -> Option<serde_json::Value> {
    c.get(format!("https://api.deezer.com/artist/{id}"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

/// The politeness gap, so callers outside this module keep the same rhythm.
pub(crate) const CATALOGUE_GAP: Duration = GAP;

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

pub(crate) async fn deezer_related(c: &reqwest::Client, id: u64) -> Option<Vec<(u64, String)>> {
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
    Some(items.iter().filter_map(candidate_from).collect())
}

/// One Deezer track object as a pool candidate, or None when it has no id,
/// title or artist. Shared by the top-tracks walk and the by-name resolver
/// so the two cannot read the catalogue differently.
fn candidate_from(t: &serde_json::Value) -> Option<CandidateTrack> {
    let id = t.get("id")?.as_u64()?;
    let title = t.get("title")?.as_str()?.to_string();
    let artist = t.pointer("/artist/name")?.as_str()?.to_string();
    if title.is_empty() || artist.is_empty() {
        return None;
    }
    // Deezer's rank runs to about a million; normalise so popularity is a
    // nudge in [0,1] rather than a number that swamps every other term.
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
        popularity: (t.get("rank").and_then(|x| x.as_f64()).unwrap_or(0.0) / 1_000_000.0)
            .clamp(0.0, 1.0),
        released: t
            .get("release_date")
            .or_else(|| t.pointer("/album/release_date"))
            .and_then(|x| x.as_str())
            .map(str::to_string),
    })
}

/// A named recording in the catalogue's own terms, or None when the
/// catalogue does not hold that exact song by that exact artist.
///
/// Strict on both names - the artist through `artist_key`, the title
/// through `title_key` - because the caller is the DJ's voice shortlist: a
/// chat model naming songs from memory, which is exactly where a near-miss
/// becomes a stranger's record bought under a familiar title.
pub(crate) async fn resolve_track(
    c: &reqwest::Client,
    artist: &str,
    title: &str,
) -> Option<CandidateTrack> {
    let q = format!("artist:\"{}\" track:\"{}\"", artist.trim(), title.trim());
    let v: serde_json::Value = c
        .get("https://api.deezer.com/search")
        .query(&[("q", q.as_str()), ("limit", "5")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let want_artist = artist_key(artist);
    let want_title = title_key(title);
    if want_artist.is_empty() || want_title.is_empty() {
        return None;
    }
    v.get("data")?
        .as_array()?
        .iter()
        .filter_map(candidate_from)
        .find(|t| artist_key(&t.artist) == want_artist && title_key(&t.title) == want_title)
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
    let ear = Ear::open(state, user);
    let c = client(20);

    for cand in waiting {
        ear.measure_and_score(state, user, &c, &cand).await;
        tokio::time::sleep(GAP).await;
    }
    true
}

/// Everything one measuring pass needs that is the LISTENER's rather than
/// the candidate's: their taste, the library's features, the lanes, the
/// mood profile and the cut threads. Opened once per pass, because the
/// taste build decodes every track's vectors and a dozen candidates must
/// not pay for it a dozen times.
pub(crate) struct Ear {
    taste: crate::taste::UserTaste,
    all: Vec<crate::db::TrackFeatures>,
    lanes: HashMap<String, (String, f64)>,
    mood: Option<crate::mood::MoodProfile>,
    anchors: HashMap<String, (f64, f64)>,
}

impl Ear {
    pub(crate) fn open(state: &Arc<AppState>, user: i64) -> Ear {
        // A cold shelf has no taste to read, but its chart candidates still
        // need their measurements - a date card needs its sound. The house
        // prior scores everything neutral, which for a chart pick is the truth.
        let (taste, all) = match crate::curator::user_taste_for(state, user) {
            Some(pair) => pair,
            None => (crate::taste::UserTaste::cold(user), state.db.all_features()),
        };
        Ear {
            taste,
            all,
            lanes: state.db.discovery_lanes(user),
            mood: crate::mood::load(state, user),
            anchors: anchor_ledger(state, user),
        }
    }

    /// Listen to one candidate - its words, its tempo, what it sounds like -
    /// score it against this listener and write both down. Returns the
    /// score. Shared by the background pass and the DJ's spoken shortlist,
    /// so a song the listener asked for is judged by exactly the ear that
    /// judges everything else.
    pub(crate) async fn measure_and_score(
        &self,
        state: &Arc<AppState>,
        user: i64,
        c: &reqwest::Client,
        cand: &crate::db::DiscoveryRow,
    ) -> f64 {
        let by_id: HashMap<i64, &crate::db::TrackFeatures> =
            self.all.iter().map(|f| (f.track_id, f)).collect();
        // The words, embedded by the same model the library went through - so
        // the two vectors live in the same space and cosine means something.
        let vec = match fetch_lyrics(c, &cand.artist, &cand.title).await {
            Some(words) => crate::curator::embed_text(&words).await,
            None => None,
        };
        // The tempo, measured off the preview rather than guessed - and, off
        // the same thirty seconds, what it SOUNDS like: energy and brightness
        // on the library's own scales, so the candidate can answer the two
        // terms every candidate used to be neutral on.
        let (bpm, sound) = if cand.preview.is_empty() {
            (None, None)
        } else {
            (
                crate::tempo::analyze_url(&cand.preview).await,
                crate::features::measure_url(&cand.preview).await,
            )
        };
        let (energy, brightness) = match sound {
            Some((energy, brightness, _dynamic_range, rhythmic)) => {
                state.db.set_discovery_measured(user, &cand.ext_id, energy, brightness, rhythmic);
                (Some(energy), Some(brightness))
            }
            None => (cand.energy, cand.brightness),
        };
        let year = cand.released.as_deref().and_then(crate::taste::released_year);

        // The seed artist IS the genre signal, as the old comment said - so
        // now it is actually used instead of being noted and then passed as
        // None, which made a quarter of the score a constant. A candidate
        // the listener asked for by name carries no seed artist - its own
        // artist stands in, which is the honest "same scene" for it.
        let scene = if cand.seed == ASKED_SEED { cand.artist.as_str() } else { cand.seed.as_str() };
        let tags = crate::taste::artist_tags(&by_id, scene);
        let score = crate::taste::score_candidate(
            &self.taste, vec.as_deref(), bpm, &tags, scene, year, energy, brightness,
        ) as f64
            + score_extras(self.lanes.get(&cand.ext_id), cand.popularity, self.mood.as_ref(), vec.as_deref(), bpm)
            - anchor_penalty(self.anchors.get(&cand.ext_id));

        let _ = state.db.save_discovery_features(user, &cand.ext_id, bpm, vec.as_deref(), score);
        score
    }
}

/// Every candidate's threads, summed, beside the share of them the listener
/// has cut: ext_id -> (total strength, refused strength). One read for a
/// whole pass, where a lookup per candidate would be hundreds.
///
/// A refused anchor is "less like this" said about a card's REASON (scope
/// 'anchor' in `discovery_rejections`, written by `refuse_card`). A listener
/// who has cut no thread reads an empty set here and this costs nothing.
fn anchor_ledger(state: &Arc<AppState>, user: i64) -> HashMap<String, (f64, f64)> {
    let refused = state.db.rejected_keys_since(user, "anchor", now_ms() - ANCHOR_REJECT_MS);
    let mut ledger: HashMap<String, (f64, f64)> = HashMap::new();
    for (ext_id, key, _kind, strength) in state.db.discovery_anchor_rows(user) {
        let e = ledger.entry(ext_id).or_insert((0.0, 0.0));
        e.0 += strength;
        if refused.contains(&key) {
            e.1 += strength;
        }
    }
    ledger
}

/// What a candidate loses for hanging off a thread the listener cut, scaled
/// by how much of its connection that thread was: the whole penalty when
/// every anchor is refused, a share of it when one among several is.
fn anchor_penalty(entry: Option<&(f64, f64)>) -> f64 {
    match entry {
        Some((total, refused)) if *total > 0.0 && *refused > 0.0 => {
            ANCHOR_REJECT_PENALTY * (refused / total).clamp(0.0, 1.0)
        }
        _ => 0.0,
    }
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
    let anchors = anchor_ledger(state, user);
    // The seed artist's tags stand in for the candidate's own, which this
    // endpoint never supplies. A quarter of every score used to be the literal
    // constant 0.5 because `None` was passed for genre here; the seed is the
    // reason the candidate is in the pool at all, so its tags are the closest
    // honest answer available.
    let mut seed_tags: HashMap<String, Vec<String>> = HashMap::new();
    for d in pool {
        // An asked-for song has no seed artist; its own artist is its scene.
        let scene = if d.seed == ASKED_SEED { d.artist.as_str() } else { d.seed.as_str() };
        let tags = seed_tags
            .entry(scene.to_lowercase())
            .or_insert_with(|| crate::taste::artist_tags(&by_id, scene))
            .clone();
        let year = d.released.as_deref().and_then(crate::taste::released_year);
        let score = crate::taste::score_candidate(
            &taste, d.lyric_vec.as_deref(), d.bpm, &tags, scene, year, d.energy, d.brightness,
        ) as f64
            + score_extras(lanes.get(&d.ext_id), d.popularity, mood.as_ref(), d.lyric_vec.as_deref(), d.bpm)
            - anchor_penalty(anchors.get(&d.ext_id));
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
    /// EVERY artist of theirs this hangs off, and how: the card's reason is
    /// one of these, never a sentence a model wrote. Strongest first.
    pub anchors: Vec<AnchorOut>,
    pub bpm: Option<f64>,
    /// Whether its words were actually read, so the client can say why it is
    /// here honestly rather than implying more than was measured.
    pub lyrics_read: bool,
    pub score: f64,
}

/// One thread between a candidate and an artist of the listener's.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorOut {
    /// The artist, as the library spells it.
    pub artist: String,
    /// How they connect: deezer_related, lb_similar, mb_member, mb_side,
    /// mb_collab, same_artist, keep.
    pub kind: String,
    /// How close, 0-1 in the kind's own terms.
    pub strength: f64,
}

/// The facts one shelf-naming line may carry about a candidate's artist:
/// what the profile sources said (MusicBrainz's town, start year and genres;
/// ListenBrainz's listener count; Spotify's genres when MB had none) and the
/// threads that reached it. Nothing here is written by a model - the prose
/// blurb in the same profile row is deliberately not read.
fn nm_facts(profile: Option<&serde_json::Value>, anchors: &[AnchorOut]) -> String {
    let mut facts: Vec<String> = Vec::new();
    if let Some(p) = profile {
        if let Some(from) = p.pointer("/musicbrainz/from").and_then(|v| v.as_str()) {
            if !from.trim().is_empty() {
                facts.push(format!("from {}", from.trim()));
            }
        }
        if let Some(began) = p.pointer("/musicbrainz/began").and_then(|v| v.as_str()) {
            if !began.trim().is_empty() {
                facts.push(format!("began {}", began.trim()));
            }
        }
        let genres: Vec<&str> = ["/musicbrainz/genres", "/spotify/genres"]
            .into_iter()
            .filter_map(|path| p.pointer(path).and_then(|g| g.as_array()))
            .find(|g| !g.is_empty())
            .map(|g| g.iter().filter_map(|x| x.as_str()).take(3).collect())
            .unwrap_or_default();
        if !genres.is_empty() {
            facts.push(format!("genres {}", genres.join(", ")));
        }
        if let Some(n) = p.pointer("/listenbrainz/listeners").and_then(|v| v.as_u64()) {
            if n > 0 {
                facts.push(format!("{n} ListenBrainz listeners"));
            }
        }
    }
    let threads: Vec<String> = anchors
        .iter()
        .take(2)
        .map(|a| match a.kind.as_str() {
            "same_artist" => format!("by {}", a.artist),
            "deezer_related" => format!("Deezer files them next to {}", a.artist),
            "lb_similar" => format!("ListenBrainz lists them beside {}", a.artist),
            "mb_member" | "mb_side" | "mb_collab" => format!("related to {} on MusicBrainz", a.artist),
            "keep" => format!("asked for, near {}", a.artist),
            _ => format!("near {}", a.artist),
        })
        .collect();
    facts.extend(threads);
    facts.join("; ")
}

/// The threads of one candidate, for a payload.
fn anchors_of(db: &crate::db::Db, user: i64, ext_id: &str) -> Vec<AnchorOut> {
    db.discovery_anchors_for(user, ext_id)
        .into_iter()
        .map(|(artist, kind, strength)| AnchorOut { artist, kind, strength })
        .collect()
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
fn nm_item(db: &crate::db::Db, user: i64, secret: &[u8], d: &crate::db::DiscoveryRow) -> serde_json::Value {
    let anchors: Vec<serde_json::Value> = anchors_of(db, user, &d.ext_id)
        .into_iter()
        .map(|a| json!({ "artist": a.artist, "kind": a.kind, "strength": a.strength }))
        .collect();
    // The hub's own signed path (preview.rs): the stored catalogue link
    // expires, and a row that plays it plays nothing.
    let preview = if d.preview.is_empty() {
        String::new()
    } else {
        crate::preview::path_for(secret, &d.ext_id)
    };
    json!({
        "id": d.ext_id, "title": d.title, "artist": d.artist, "cover": d.cover,
        "url": d.url, "preview": preview, "seed": d.seed, "anchors": anchors, "bpm": d.bpm,
        "lyricsRead": d.lyric_vec.is_some(), "score": d.score,
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
            .map(|d| nm_item(&state.db, user, &state.stream_secret, d))
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
    /*
     * Facts on every line, so the model can name a REAL scene.
     *
     * The line used to be artist, title and seed, and the model was asked to
     * hear "a coherent scene" in sixty names it had mostly never seen - so
     * it named what it remembered, or guessed: a 2011 Sheffield post-punk
     * scene for a band from Lisbon. Every fact here is on file already -
     * MusicBrainz's town and start year and genres, ListenBrainz's listener
     * count, the threads the candidate hangs off - and the prompt is fenced
     * to those facts. The id validation below is unchanged: the model still
     * only ever groups, it never adds a track.
     */
    let artist_keys: Vec<String> = pool.iter().map(|d| artist_key_public(&d.artist)).collect();
    let profiles: HashMap<String, serde_json::Value> = state
        .db
        .artist_profile_rows(&artist_keys)
        .into_iter()
        .filter_map(|(k, body, _, _)| serde_json::from_str(&body).ok().map(|v| (k, v)))
        .collect();
    let mut lines = Vec::new();
    for (i, d) in pool.iter().enumerate() {
        let anchors = anchors_of(&state.db, user, &d.ext_id);
        let facts = nm_facts(profiles.get(&artist_key_public(&d.artist)), &anchors);
        let mut line = format!("{}|{} — {} (near {})", i + 1, d.artist, d.title, d.seed);
        if !facts.is_empty() {
            line.push_str(" | ");
            line.push_str(&facts);
        }
        lines.push(line);
    }
    let prompt = format!(
        "You build 'new music' playlists for one listener from tracks they do NOT own yet - fresh picks harvested from artists near their taste. Candidates, one per line as N|artist — title (near = the artist of theirs it came from), some with known facts after a further |:\n{}\n\n\
         Group them into 3-5 themed playlists of new music, each a coherent scene or vibe - a genre lane, a 'because you play X' set, or a mood. Titles short and evocative (2-4 words); one-line blurbs, warm and plain, no exclamation marks. Each playlist 5-12 tracks.\n\
         Name the through-line using ONLY the artists, titles and facts listed; no years, genres, places or claims not in the list.\n\
         Answer with STRICT JSON only: [{{\"title\":\"...\",\"blurb\":\"...\",\"ids\":[N,...]}}] using ONLY the numbers N above.",
        lines.join("\n"),
    );
    let allowed = lines.join("\n");
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
        let title = m.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
        let blurb = m.get("blurb").and_then(|v| v.as_str()).unwrap_or("").trim();
        // The fence, enforced: a title past forty characters or a blurb
        // past a hundred and forty is not a name, and a year the facts did
        // not supply is a claim - the blurb goes, the grouping stays.
        let Some((title, blurb)) = crate::ai::fence_naming(title, blurb, &allowed) else {
            continue;
        };
        let items: Vec<serde_json::Value> = m
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_i64())
                    .filter_map(|k| usize::try_from(k).ok())
                    .filter(|k| *k >= 1 && *k <= n && used.insert(*k))
                    .filter_map(|k| pool.get(k - 1))
                    .map(|d| nm_item(&state.db, user, &state.stream_secret, d))
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
    let items: Vec<DiscoveryOut> = state
        .db
        .top_discoveries(caller.id, 40)
        .into_iter()
        .map(|d| DiscoveryOut {
            anchors: anchors_of(&state.db, caller.id, &d.ext_id),
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
        })
        .collect();
    let (pool, listened) = state.db.discovery_counts(caller.id);
    Ok(Json(json!({
        "items": items,
        "progress": { "pool": pool, "listened": listened },
        // What the page needs to ask for listening honestly: how many distinct
        // songs this listener has played in the window, and how many the taste
        // model actually waits for. Both come from the gate itself, so the copy
        // ("2 of 4 songs") can never drift from the rule it describes.
        "taste": {
            "heard": crate::curator::taste_heard(&state, caller.id),
            "needed": crate::curator::TASTE_MIN_TRACKS,
        },
    })))
}

#[derive(serde::Deserialize)]
pub struct DismissQuery {
    pub id: String,
    /// `artist` refuses everyone by that name; `anchor` refuses the REASON
    /// the card gave (its strongest thread, or the one named in `anchor`);
    /// anything else (or absent) refuses just this song.
    pub scope: Option<String>,
    /// With `scope=anchor`: which of the card's threads to cut, as the card
    /// spelled it. Absent means the strongest.
    pub anchor: Option<String>,
}

/// `POST /api/discoveries/dismiss?id=&scope=&anchor=` - not for me.
/// Forgotten rather than hidden, so the harvest is free to find something
/// better in its place.
pub async fn dismiss(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DismissQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let refused = refuse_card(&state.db, caller.id, &q.id, q.scope.as_deref(), q.anchor.as_deref());
    state.db.forget_discovery(caller.id, &q.id);
    Ok(Json(json!({ "ok": true, "rejected": refused })))
}

/// Remember the refusal before forgetting the row.
///
/// The row still goes - the pool is free to find something better in its
/// place, which is the point of forgetting rather than hiding. What is kept
/// is the JUDGEMENT, so the next harvest does not spend the slot it just
/// freed on the same song. Read by id first: one indexed lookup, because
/// the pool is hundreds of rows and this runs on a tap.
///
/// Scope `anchor` is "less like this" said about the card's REASON: the
/// thread (an artist of theirs the candidate was reached from) goes into the
/// rejection memory under scope 'anchor', where `file_candidate` refuses to
/// file anything under it and `rescore` sinks what already hangs off it.
/// The song itself is refused too - they dismissed the card - so the next
/// walk does not bring the same record back on some other thread within the
/// hour. Returns what was written, for the reply.
pub(crate) fn refuse_card(
    db: &crate::db::Db,
    user: i64,
    ext_id: &str,
    scope: Option<&str>,
    anchor: Option<&str>,
) -> Vec<&'static str> {
    let Some(d) = db.discovery_get(user, ext_id) else { return Vec::new() };
    let mut wrote = Vec::new();
    match scope {
        Some("artist") => {
            db.reject_discovery(user, "artist", &artist_key(&d.artist));
            wrote.push("artist");
        }
        Some("anchor") => {
            let named = anchor.map(str::trim).filter(|a| !a.is_empty()).map(String::from);
            let thread = named.or_else(|| {
                db.discovery_anchors_for(user, ext_id).into_iter().next().map(|(a, _, _)| a)
            });
            if let Some(thread) = thread {
                db.reject_discovery(user, "anchor", &artist_key(&thread));
                wrote.push("anchor");
            }
            db.reject_discovery(user, "track", &key_of(&d.artist, &d.title));
            wrote.push("track");
        }
        _ => {
            db.reject_discovery(user, "track", &key_of(&d.artist, &d.title));
            wrote.push("track");
        }
    }
    wrote
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


#[cfg(test)]
mod rejection_memory {
    //! "Not for me" used to last until the next harvest, which promptly
    //! offered the same song back - everything that made it a good candidate
    //! was still true, and nothing remembered that it had been refused.

    use super::*;

    /// Its own directory per test: the module's tests run in parallel threads
    /// of one process, so a path keyed only on the pid is one database shared
    /// by four tests, and the second to reach `create_user` fails on UNIQUE.
    fn fresh(name: &str) -> crate::db::Db {
        let d = std::env::temp_dir().join(format!("afm-reject-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        crate::db::Db::open(&d.join("t.sqlite")).unwrap()
    }

    #[test]
    fn a_dismissed_song_is_not_offered_again() {
        let db = fresh("song");
        let me = db.create_user("me", "", true).unwrap();

        db.reject_discovery(me, "track", &key_of("Boards of Canada", "Dayvan Cowboy"));

        // The same song, re-offered under a different spelling: key_of folds it.
        assert!(is_rejected(&db, me, "BOARDS OF CANADA", "Dayvan Cowboy"));
        // A different song by the same artist is still welcome - refusing a
        // song is a narrow statement, not a ban on the artist.
        assert!(!is_rejected(&db, me, "Boards of Canada", "Roygbiv"));
    }

    #[test]
    fn dismissing_an_artist_refuses_all_of_them() {
        let db = fresh("artist");
        let me = db.create_user("me", "", true).unwrap();
        db.reject_discovery(me, "artist", &artist_key("Boards of Canada"));
        assert!(is_rejected(&db, me, "Boards of Canada", "Roygbiv"));
        assert!(is_rejected(&db, me, "boards of canada", "Olson"));
    }

    #[test]
    fn a_refusal_is_mine_and_it_lapses() {
        let db = fresh("mine");
        let me = db.create_user("me", "", true).unwrap();
        let you = db.create_user("you", "", false).unwrap();
        let key = key_of("Boards of Canada", "Dayvan Cowboy");
        db.reject_discovery(me, "track", &key);

        // Somebody else's taste is not mine.
        assert!(!is_rejected(&db, you, "Boards of Canada", "Dayvan Cowboy"));

        // And it is a window, not a life sentence: far enough past it, the
        // block is over even though the memory is still on file.
        let now = now_ms();
        assert!(db.rejection_active(me, "track", &key, now, TRACK_REJECT_MS));
        assert!(
            !db.rejection_active(me, "track", &key, now + TRACK_REJECT_MS + 1, TRACK_REJECT_MS),
            "a refusal from long enough ago stops blocking"
        );
        assert!(
            db.rejected_keys_since(me, "track", 0).contains(&key),
            "the memory outlives the block, for seed selection to take the hint"
        );
    }

    #[test]
    fn an_empty_key_is_never_stored() {
        let db = fresh("empty");
        let me = db.create_user("me", "", true).unwrap();
        // A row with no artist must not become a rejection that matches every
        // other artist-less candidate.
        db.reject_discovery(me, "artist", &artist_key("   "));
        assert!(db.rejected_keys_since(me, "artist", 0).is_empty());
    }

    fn candidate(n: u64, artist: &str, title: &str) -> CandidateTrack {
        CandidateTrack {
            ext_id: format!("deezer:track:{n}"),
            title: title.into(),
            artist: artist.into(),
            cover: String::new(),
            url: String::new(),
            preview: String::new(),
            popularity: 0.1,
            released: None,
        }
    }

    /// "Less like this" on the card's REASON: scope `anchor` writes the
    /// thread into the rejection memory - the strongest thread when none is
    /// named, the named one when it is - and the song goes with it.
    #[test]
    fn dismissing_the_reason_refuses_the_anchor() {
        let db = fresh("anchor");
        let me = db.create_user("me", "", true).unwrap();
        let none: HashSet<String> = HashSet::new();
        let t = candidate(1, "Someone New", "First Song");
        assert!(file_candidate(&db, me, &t, "Big Thief", "deezer_related", 0.5, &none));
        db.add_discovery_anchor(me, &t.ext_id, "Adrianne Lenker", "lb_similar", 0.9);

        let wrote = refuse_card(&db, me, &t.ext_id, Some("anchor"), None);
        assert_eq!(wrote, vec!["anchor", "track"]);
        let cut = db.rejected_keys_since(me, "anchor", 0);
        assert!(cut.contains(&artist_key("Adrianne Lenker")), "the strongest thread: {cut:?}");
        assert!(!cut.contains(&artist_key("Big Thief")), "the weaker one is not touched");
        assert!(is_rejected(&db, me, "Someone New", "First Song"), "and the song itself is refused");

        // Named, the named thread is the one cut.
        let u = candidate(2, "Another Act", "Other Song");
        assert!(file_candidate(&db, me, &u, "Big Thief", "deezer_related", 0.5, &none));
        refuse_card(&db, me, &u.ext_id, Some("anchor"), Some("Big Thief"));
        assert!(db.rejected_keys_since(me, "anchor", 0).contains(&artist_key("Big Thief")));
    }

    /// The harvest hears the cut thread: a candidate reached ONLY through a
    /// refused anchor is not filed; one reached through a thread they kept
    /// lands, and gains no thread from the refused one.
    #[test]
    fn a_candidate_whose_only_thread_is_cut_is_skipped_at_ingest() {
        let db = fresh("ingest");
        let me = db.create_user("me", "", true).unwrap();
        db.reject_discovery(me, "anchor", &artist_key("The National"));
        let refused = refused_anchors(&db, me);
        assert!(refused.contains(&artist_key("the national")), "the fold is the pool's");

        let only = candidate(3, "Stranger", "Hanging Off Nothing");
        assert!(!file_candidate(&db, me, &only, "The National", "deezer_related", 0.5, &refused));
        assert!(db.discovery_get(me, &only.ext_id).is_none(), "never landed");

        let kept = candidate(4, "Neighbour", "Two Threads");
        assert!(file_candidate(&db, me, &kept, "Big Thief", "deezer_related", 0.5, &refused));
        assert!(!file_candidate(&db, me, &kept, "The National", "deezer_related", 0.9, &refused));
        let threads = db.discovery_anchors_for(me, &kept.ext_id);
        assert_eq!(threads.len(), 1, "the refused thread is not a reason: {threads:?}");
        assert_eq!(threads[0].0, "Big Thief");
        assert!(db.discovery_get(me, &kept.ext_id).is_some(), "still in the pool on the kept thread");
    }

    /// A spoken request files into the POOL, not into a download: the row
    /// carries the sentence the card will show and a `keep` thread to its
    /// own artist, and the rejection memory still stands in the door.
    #[test]
    fn an_asked_for_song_enters_the_pool_under_its_own_name() {
        let db = fresh("asked");
        let me = db.create_user("me", "", true).unwrap();
        let t = candidate(5, "Fugazi", "Waiting Room");
        assert!(file_asked(&db, me, &t));
        let row = db.discovery_get(me, &t.ext_id).expect("pooled");
        assert_eq!(row.seed, ASKED_SEED);
        let threads = db.discovery_anchors_for(me, &t.ext_id);
        assert_eq!(threads.len(), 1);
        assert_eq!((threads[0].0.as_str(), threads[0].1.as_str()), ("Fugazi", "keep"));
        assert!(!is_rejected(&db, me, "Fugazi", "Waiting Room"), "asking is not a no");
    }
}
