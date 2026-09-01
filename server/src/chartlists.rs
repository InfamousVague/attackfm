//! The standing chart playlists: Top Worldwide, Top USA, and friends -
//! prepared ahead of time and refreshed daily, by request.
//!
//! Sources are the editorial charts Deezer maintains in the open (the ids are
//! verified stable, owned by the "Deezer Charts" account), plus Spotify's
//! famous chart playlists ATTEMPTED through any connected account - Spotify
//! has been walling its editorial lists off from API apps, so a fetch that
//! fails just means that playlist sits this refresh out, silently.
//!
//! Each list materialises per listener as an ordinary playlist in a "Charts"
//! folder, holding the chart's songs that are actually ON this box (library
//! rows only - never someone's private audition), in chart order. Created
//! once per listener per list and UPDATED in place forever after; a listener
//! who deletes one has answered, and it is never rebuilt for them - the
//! seeded ledger in meta is what remembers.

use crate::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// Refresh cadence. Twenty hours, same rhythm the vibe bank keeps: "daily"
/// without a fixed hour, so a restart never doubles a day's work.
const REFRESH_MS: i64 = 20 * 60 * 60 * 1000;
/// Politeness between catalogue calls, same as the taste walk's.
const GAP: Duration = Duration::from_millis(700);
/// A list materialises once it can offer at least this many songs - an
/// empty "Top UK" teaches nothing except that the box is not British yet.
const MIN_MATCHES: usize = 5;

enum Source {
    /// A Deezer playlist id - the editorial charts account's lists.
    Deezer(u64),
    /// A Deezer editorial GENRE chart (api.deezer.com/chart/{genre}/tracks).
    /// This is what answers "the charts are all the same list with a
    /// different flag on it": a genre chart is a different WORLD, not a
    /// different country's ranking of the same twenty songs.
    DeezerChart(u64),
    /// A Spotify playlist id, fetched through any connected account.
    Spotify(&'static str),
}

/// slug (the ledger key), display name, where it comes from.
fn sources() -> Vec<(&'static str, &'static str, Source)> {
    vec![
        ("top-worldwide", "Top Worldwide", Source::Deezer(3155776842)),
        ("top-usa", "Top USA", Source::Deezer(1313621735)),
        ("top-uk", "Top UK", Source::Deezer(1111142221)),
        ("top-canada", "Top Canada", Source::Deezer(1652248171)),
        ("top-australia", "Top Australia", Source::Deezer(1313616925)),
        // The genre seats. Ids are Deezer's own editorial genre ids, read off
        // api.deezer.com/genre; "indie" is Deezer's Alternative chart, the
        // nearest thing the catalogue has to that word.
        ("top-pop", "Top Pop", Source::DeezerChart(132)),
        ("top-indie", "Top Indie & Alt", Source::DeezerChart(85)),
        ("top-rnb", "Top R&B", Source::DeezerChart(165)),
        ("top-hiphop", "Top Hip-Hop", Source::DeezerChart(116)),
        ("top-rock", "Top Rock", Source::DeezerChart(152)),
        ("top-dance", "Top Dance", Source::DeezerChart(113)),
        ("sp-top-global", "Top 50 Global", Source::Spotify("37i9dQZEVXbMDoHDwVN2tF")),
        ("sp-top-usa", "Top 50 USA", Source::Spotify("37i9dQZEVXbLRQDuF5jeBp")),
        ("sp-viral-global", "Viral 50 Global", Source::Spotify("37i9dQZEVXbLiRSasKsNU9")),
        ("sp-todays-top-hits", "Today's Top Hits", Source::Spotify("37i9dQZF1DXcBWIGoYBM5M")),
    ]
}

fn clock_key() -> &'static str {
    "chartlists.fetched_at"
}

/// The daily pass. Rides the collector's loop; the clock inside makes it a
/// cheap no-op between refreshes.
pub async fn cycle(state: &Arc<AppState>) {
    let now = crate::db::now_ms();
    let last = state
        .db
        .meta_get(clock_key())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if now - last < REFRESH_MS {
        return;
    }
    // Stamped up front: a half-failed refresh retries tomorrow, not in five
    // minutes forever - each source already degrades to "skip this time".
    let _ = state.db.meta_set(clock_key(), &now.to_string());

    // The box's own songs, by folded identity. Library rows only: an
    // audition is one listener's private maybe, and these playlists are for
    // everyone.
    let mut by_key: HashMap<String, i64> = HashMap::new();
    for (id, artist, title, audition_owner) in state.db.track_identities() {
        if audition_owner != 0 {
            continue;
        }
        by_key.entry(crate::discovery::key_of(&artist, &title)).or_insert(id);
    }

    let users: Vec<i64> = state.db.list_users().into_iter().map(|(id, _, _)| id).collect();
    for (slug, title, source) in sources() {
        let pairs = match source {
            Source::Deezer(id) => deezer_pairs(id).await,
            Source::DeezerChart(genre) => deezer_chart_pairs(genre).await,
            Source::Spotify(id) => spotify_pairs(state, id).await,
        };
        if pairs.is_empty() {
            continue;
        }
        // Chart order, one seat per song even when a chart repeats itself.
        let mut ids: Vec<i64> = Vec::new();
        let mut seen: HashSet<i64> = HashSet::new();
        for (artist, song) in &pairs {
            if let Some(id) = by_key.get(&crate::discovery::key_of(artist, song)) {
                if seen.insert(*id) {
                    ids.push(*id);
                }
            }
        }
        for user in &users {
            refresh_for(state, *user, slug, title, "Charts", CHART_BLURB, &ids);
        }
        tokio::time::sleep(GAP).await;
    }

    // New Music no longer rides this 20h chart clock - it has its own hourly
    // backstop (new_music_cycle) and, more to the point, rebuilds the moment a
    // song is met. See refresh_new_music_for.
}

/// Rebuild one listener's New Music Mix from the selection the DJ's chip
/// shares (vibes::new_music_ids, undrawn) - pure DB, idempotent (refresh_for
/// skips an identical list). Called on the hourly clock below AND from the
/// listening path - a play, a listen event, a heart, a landed pull - so a
/// song leaves the list when it is met, not a day later, and a new arrival
/// joins it within the client's next poll.
pub fn refresh_new_music_for(state: &Arc<AppState>, user: i64) {
    // One-time re-file: New Music Mix used to sit in a "Made for you" folder
    // of exactly one item. That name is now a Home shelf of the personalized
    // mixes (daily/mood/daylist - see mixes.rs), so the playlist moves to its
    // own honest "New music" folder. Idempotent: after the move nothing
    // matches the old folder, so it is a no-op on every later call.
    for p in state.db.playlists(user) {
        if p.folder == "Made for you" && p.name == "New Music Mix" {
            let _ = state.db.set_playlist_meta(p.id, None, Some("New music"), None);
        }
    }
    let ids = crate::vibes::new_music_ids(&state.db, user, 30, false);
    refresh_for(state, user, "new-music-mix", "New Music Mix", "New music", MIX_BLURB, &ids);
}

/// The backstop clock for New Music: once an hour per listener, for the
/// arrivals no listening hook sees - a folder scan, another listener's
/// upload. Per-user meta stamp like the programmer's, stamped AFTER the
/// rewrite so a failed pass retries next loop rather than in an hour.
const NEW_MUSIC_FRESH_MS: i64 = 60 * 60 * 1000;

fn new_music_key(user: i64) -> String {
    format!("newmix.built.{user}")
}

pub async fn new_music_cycle(state: &Arc<AppState>) {
    let now = crate::db::now_ms();
    for (user, _, _) in state.db.list_users() {
        let last = state
            .db
            .meta_get(&new_music_key(user))
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        if now - last < NEW_MUSIC_FRESH_MS {
            continue;
        }
        refresh_new_music_for(state, user);
        let _ = state.db.meta_set(&new_music_key(user), &now.to_string());
    }
}

const CHART_BLURB: &str =
    "Refreshed daily from the charts - the songs already on this server.";
const MIX_BLURB: &str =
    "New to you, refreshed daily: what the collector found for you, and the library's newest arrivals you haven't played.";

/// One listener's copy of one list: update in place, create once, and never
/// resurrect what they deleted.
fn refresh_for(
    state: &Arc<AppState>,
    user: i64,
    slug: &str,
    title: &str,
    folder: &str,
    blurb: &str,
    ids: &[i64],
) {
    let seeded_key = format!("chartlists.seeded.{user}");
    let mut seeded: Vec<String> = state
        .db
        .meta_get(&seeded_key)
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let existing = state
        .db
        .playlists(user)
        .into_iter()
        .find(|p| p.folder == folder && p.name == title);
    match existing {
        Some(p) => {
            // Order changes daily; rewriting an identical list is a no-op
            // worth skipping so updated_at stays honest.
            if p.tracks != ids {
                let _ = state.db.set_playlist_tracks(p.id, ids);
            }
        }
        None => {
            if seeded.iter().any(|s| s == slug) {
                // They deleted it; that answer stands.
                return;
            }
            if ids.len() < MIN_MATCHES {
                return;
            }
            if let Ok(pid) = state.db.create_playlist(user, title) {
                let _ = state.db.set_playlist_meta(pid, Some(blurb), Some(folder), None);
                let _ = state.db.set_playlist_tracks(pid, ids);
                seeded.push(slug.to_string());
                let _ = state
                    .db
                    .meta_set(&seeded_key, &serde_json::to_string(&seeded).unwrap_or_default());
            }
        }
    }
}

/// A Deezer genre chart's songs as (artist, title). Same wire shape as a
/// playlist's tracks, different door.
async fn deezer_chart_pairs(genre: u64) -> Vec<(String, String)> {
    deezer_paged(format!("https://api.deezer.com/chart/{genre}/tracks?limit=100")).await
}

/// A Deezer playlist's songs as (artist, title), paged to the end.
async fn deezer_pairs(id: u64) -> Vec<(String, String)> {
    deezer_paged(format!("https://api.deezer.com/playlist/{id}/tracks?limit=100")).await
}

async fn deezer_paged(start: String) -> Vec<(String, String)> {
    let c = crate::discovery::client(20);
    let mut url = start;
    let mut out = Vec::new();
    loop {
        let Ok(resp) = c.get(&url).send().await else { break };
        let Ok(body) = resp.json::<serde_json::Value>().await else { break };
        for t in body.get("data").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
            let artist = t.pointer("/artist/name").and_then(|v| v.as_str()).unwrap_or("");
            let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if !artist.is_empty() && !title.is_empty() {
                out.push((artist.to_string(), title.to_string()));
            }
        }
        match body.get("next").and_then(|v| v.as_str()) {
            Some(next) if !next.is_empty() && out.len() < 400 => url = next.to_string(),
            _ => break,
        }
    }
    out
}

/// A Spotify playlist's songs, through the first account that can ask.
/// Spotify walls editorial lists off from many API apps - an error here is
/// expected weather, and the playlist simply sits this refresh out.
async fn spotify_pairs(state: &Arc<AppState>, id: &str) -> Vec<(String, String)> {
    let Ok(http) = crate::spotify::http_client() else { return Vec::new() };
    for (user, _, _) in state.db.list_users() {
        if state.db.spotify_account(user).map(|a| a.refresh_token.is_empty()).unwrap_or(true) {
            continue;
        }
        match crate::spotify::fetch_items(state, user, &http, "playlist", id).await {
            Ok(items) => {
                return items
                    .into_iter()
                    .filter(|i| !i.artist.is_empty() && !i.title.is_empty())
                    .map(|i| (i.artist, i.title))
                    .collect();
            }
            Err(_) => return Vec::new(),
        }
    }
    Vec::new()
}
