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

use crate::curator::{cosine, taste_for};
use crate::AppState;
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// Candidates listened to per cycle. Each one costs a lyrics fetch, an
/// embedding and a preview download, so this stays small.
const LISTEN_BATCH: i64 = 4;
/// Stop harvesting once this many candidates are waiting - the pool should be
/// deep enough to choose from, not unbounded.
const POOL_TARGET: i64 = 180;
/// How often to go looking for new candidates.
const HARVEST_EVERY_MS: i64 = 6 * 60 * 60 * 1000;
/// Artists of yours to expand from, and how far each expands.
const SEED_ARTISTS: i64 = 8;
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

fn client(secs: u64) -> reqwest::Client {
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

fn key_of(artist: &str, title: &str) -> String {
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

/// The whole library as comparison keys - what a candidate is tested against.
fn owned_keys(state: &Arc<AppState>) -> HashSet<String> {
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
    built_at: std::time::Instant,
    refreshing: bool,
}

/// New-music playlists refresh once a day.
const NM_TTL: Duration = Duration::from_secs(24 * 60 * 60);

fn nm_ai_url() -> Option<String> {
    std::env::var("AFM_AI_URL").ok().filter(|s| !s.trim().is_empty())
}
fn nm_ai_model() -> Option<String> {
    std::env::var("AFM_AI_MODEL").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl DiscoveryState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

// --- harvest -----------------------------------------------------------------

/// Fills the candidate pool for one listener from the neighbourhood of the
/// artists they actually play.
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

    let since = now_ms() - 30 * 24 * 60 * 60 * 1000;
    let seeds = state.db.top_artists(user, since, SEED_ARTISTS);
    if seeds.is_empty() {
        return;
    }
    let owned = owned_keys(state);
    let c = client(15);

    for (seed_name, _) in seeds {
        // Your artist, in the catalogue's terms.
        let Some(seed_id) = deezer_artist_id(&c, &seed_name).await else { continue };
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
                );
            }
            tokio::time::sleep(GAP).await;
            let _ = artist_name;
        }
    }
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

async fn deezer_artist_id(c: &reqwest::Client, name: &str) -> Option<u64> {
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
    items
        .iter()
        .find(|a| {
            a.get("name").and_then(|n| n.as_str()).map(|n| n.to_lowercase() == want).unwrap_or(false)
        })
        .or_else(|| items.first())
        .and_then(|a| a.get("id"))
        .and_then(|i| i.as_u64())
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
    let Some(taste) = taste_for(state, user) else { return false };
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

        let score = crate::curator::score_parts(
            &taste,
            vec.as_deref(),
            bpm,
            // A candidate carries no genre from this endpoint; the artist it
            // hangs off is the genre signal, and it is already why it is here.
            None,
        ) as f64
            // Popularity nudges, at a tenth of the weight of the rest.
            + 0.1 * cand.popularity;

        let _ = state.db.save_discovery_features(user, &cand.ext_id, bpm, vec.as_deref(), score);
        tokio::time::sleep(GAP).await;
    }
    true
}

/// Rescores everything already listened to. Taste moves; a pool scored against
/// last month's listening would slowly stop being about you.
pub fn rescore(state: &Arc<AppState>, user: i64) {
    let Some(taste) = taste_for(state, user) else { return };
    for d in state.db.all_discoveries(user) {
        let score = crate::curator::score_parts(&taste, d.lyric_vec.as_deref(), d.bpm, None) as f64
            + 0.1 * d.popularity;
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
    let entry = cache.get(&user);
    let fresh = entry.map(|e| e.built_at.elapsed() < NM_TTL && !e.playlists.is_empty()).unwrap_or(false);
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
                built_at: std::time::Instant::now(),
                refreshing: true,
            });
        let bg = Arc::clone(state);
        tokio::spawn(async move {
            let built = build_new_music(&bg, user).await;
            let mut cache = bg.discovery.new_music.lock().await;
            match built {
                Some(pls) if !pls.is_empty() => {
                    cache.insert(
                        user,
                        CachedNewMusic { playlists: pls, built_at: std::time::Instant::now(), refreshing: false },
                    );
                }
                _ => {
                    if let Some(e) = cache.get_mut(&user) {
                        e.refreshing = false;
                        e.built_at = std::time::Instant::now();
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
async fn build_new_music(state: &Arc<AppState>, user: i64) -> Option<Vec<serde_json::Value>> {
    let url = nm_ai_url()?;
    let model = nm_ai_model()?;
    let pool = state.db.top_discoveries(user, 60);
    if pool.len() < 6 {
        return None;
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
    let reply: serde_json::Value = client(120)
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({ "model": model, "messages": [{ "role": "user", "content": prompt }], "temperature": 0.8 }))
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
                    .map(|d| {
                        json!({
                            "id": d.ext_id, "title": d.title, "artist": d.artist, "cover": d.cover,
                            "url": d.url, "preview": d.preview, "seed": d.seed, "bpm": d.bpm,
                            "lyricsRead": d.lyric_vec.is_some(), "score": d.score,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if title.is_empty() || items.len() < 4 {
            continue;
        }
        out.push(json!({ "id": format!("nm-{i}"), "title": title, "blurb": blurb, "items": items }));
    }
    (!out.is_empty()).then_some(out)
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
    })))
}

#[derive(serde::Deserialize)]
pub struct DismissQuery {
    pub id: String,
}

/// `POST /api/discoveries/dismiss?id=` - not for me. Forgotten rather than
/// hidden, so the harvest is free to find something better in its place.
pub async fn dismiss(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DismissQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state.db.forget_discovery(caller.id, &q.id);
    Ok(Json(json!({ "ok": true })))
}
