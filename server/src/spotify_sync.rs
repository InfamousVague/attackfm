//! Keeping a Spotify collection and a local playlist the same thing.
//!
//! The account link (`spotify.rs`) could always SEE the user's playlists; what
//! it could not do was open one. Importing a playlist meant handing its public
//! URL to SpotiFLAC, which scrapes the embed page - so a private playlist was
//! refused outright, order came back as album track numbers rather than the
//! order the playlist is actually in, and re-importing something already owned
//! produced nothing at all. None of that is fixable from the outside, which is
//! why this module reads the playlist as the user instead.
//!
//! One pass over a watched collection is three stages:
//!
//!   ENUMERATE  ask the Web API for every entry, in order, with ids and ISRCs
//!              (`spotify::fetch_items`), and write them into `spotify_items`.
//!              The table is keyed by (track_uid, occurrence), NOT by position,
//!              so an upstream reorder rewrites positions while every hard-won
//!              resolution below survives untouched.
//!
//!   RESOLVE    decide which local track each entry IS, cheapest rung first:
//!              a stored pin, then ISRC, then tags. The answer is pinned in
//!              `track_ext_ids`, so the second sync of a playlist does almost
//!              no work and a listener's correction is never overwritten by a
//!              later guess. Whatever is left over is queued for download, a
//!              bounded number at a time.
//!
//!   MATERIALIZE write the resolved entries, in Spotify's order, into a real
//!              local playlist. This runs BEFORE the downloads finish, so the
//!              playlist shows up holding everything already owned and fills
//!              in as the rest lands, rather than appearing empty for an hour.
//!
//! Upstream is the source of truth for a mirror's membership and order - it is
//! a mirror, not a copy that drifts. A local RENAME is respected, because the
//! name is the one thing a listener is likely to change on purpose.

use crate::db::{MirrorItem, MatchRow};
use crate::{imports, spotify, AppState};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// How long after boot the loop waits before its first pass, so a restart does
/// not race the scan and the curator for a one-core box.
const BOOT_DELAY_SECS: u64 = 25;
/// Cadence when the last cycle found work, and when it did not.
const BUSY_SECS: u64 = 15;
const IDLE_SECS: u64 = 300;
/// How often a watched collection is re-polled when nothing has changed.
const RECHECK_SECS: i64 = 900;
/// Full enumerations per cycle, across all users - the rate-limit budget.
const ENUMERATIONS_PER_CYCLE: usize = 3;
/// Outstanding download jobs per mirror. The import queue rewrites its whole
/// json file on every progress tick and linearly scans itself to pick the next
/// job, so dropping three hundred jobs in at once would turn that into a
/// per-second O(n) rewrite. Refilled each cycle as jobs land.
const DOWNLOAD_WINDOW: usize = 25;
/// Tag matching allows the same drift the up-sync precheck does.
const DURATION_TOLERANCE_MS: i64 = 3000;

/// What the engine keeps in memory. Every durable counter lives on
/// `spotify_mirrors`, so a restart loses nothing but the in-flight set.
#[derive(Default)]
pub struct SpotifySyncState {
    inflight: tokio::sync::Mutex<HashSet<String>>,
    notify: tokio::sync::Notify,
}

impl SpotifySyncState {
    /// Wake the loop now rather than at the next tick.
    pub fn poke(&self) {
        self.notify.notify_one();
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Title + artist, the album-agnostic identity. The same normalisation the
/// import filer uses, so the two agree about what "already have it" means.
fn track_key(title: &str, artist: &str) -> String {
    format!("{}\u{1}{}", norm(title), norm(artist))
}

fn dur_close(a: Option<i64>, b: Option<i64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= DURATION_TOLERANCE_MS,
        // An unknown length on either side does not veto a name match.
        _ => true,
    }
}

/// The library, indexed for matching. Built once per pass rather than per
/// entry: a 300-track playlist against a 20,000-track library is one scan, not
/// three hundred.
struct MatchIndex {
    by_track: HashMap<String, Vec<Candidate>>,
}

struct Candidate {
    id: i64,
    album: String,
    duration_ms: Option<i64>,
}

impl MatchIndex {
    fn build(rows: Vec<MatchRow>) -> Self {
        let mut by_track: HashMap<String, Vec<Candidate>> = HashMap::new();
        for row in rows {
            let cand = Candidate {
                id: row.id,
                album: norm(&row.album),
                duration_ms: row.duration_ms,
            };
            let k1 = track_key(&row.title, &row.artist);
            // A compilation credits the track to its performer and the record
            // to someone else; both spellings have to find it.
            let k2 = track_key(&row.title, &row.album_artist);
            if k1 != k2 {
                by_track.entry(k2).or_default().push(Candidate {
                    id: cand.id,
                    album: cand.album.clone(),
                    duration_ms: cand.duration_ms,
                });
            }
            by_track.entry(k1).or_default().push(cand);
        }
        Self { by_track }
    }

    /// What this Spotify entry is locally, and how sure we are.
    ///
    /// Returns `Ambiguous` rather than picking when several live tracks fit
    /// equally well - guessing there is how a mirror quietly fills with the
    /// wrong recordings, and a wrong pin is worse than a visible gap.
    fn resolve(&self, item: &MirrorItem) -> TagVerdict {
        let Some(candidates) = self.by_track.get(&track_key(&item.title, &item.artist)) else {
            return TagVerdict::None;
        };
        let fits: Vec<&Candidate> = candidates
            .iter()
            .filter(|c| dur_close(c.duration_ms, item.duration_ms))
            .collect();
        if fits.is_empty() {
            return TagVerdict::None;
        }
        // The album agreeing too makes it the same release, not just the same
        // song - good enough to call strict.
        let album = norm(&item.album);
        if !album.is_empty() {
            let on_album: Vec<&&Candidate> = fits.iter().filter(|c| c.album == album).collect();
            if on_album.len() == 1 {
                return TagVerdict::Strict(on_album[0].id);
            }
        }
        match fits.len() {
            1 => TagVerdict::Loose(fits[0].id),
            _ => TagVerdict::Ambiguous(fits.iter().take(8).map(|c| c.id).collect()),
        }
    }
}

enum TagVerdict {
    Strict(i64),
    Loose(i64),
    Ambiguous(Vec<i64>),
    None,
}

/// Add a collection to the mirror and start watching it.
pub async fn watch(
    state: &Arc<AppState>,
    user_id: i64,
    key: &str,
    on: bool,
) -> Result<(), String> {
    let (kind, spotify_id) = split_key(key)?;
    // Seed the head if this is the first time the key has been seen, so a
    // watch can be turned on straight from a listing without a prior sync.
    if state.db.spotify_mirror(user_id, key).is_none() {
        state
            .db
            .spotify_mirror_seed(user_id, key, kind, spotify_id, "", "", "", "")
            .map_err(|e| e.to_string())?;
    }
    state
        .db
        .spotify_mirror_set_watch(user_id, key, on)
        .map_err(|e| e.to_string())?;
    state.spotify_sync.poke();
    Ok(())
}

/// `playlist:{id}` / `album:{id}` / `liked` -> (kind, id).
pub fn split_key(key: &str) -> Result<(&str, &str), String> {
    if key == "liked" {
        return Ok(("liked", ""));
    }
    match key.split_once(':') {
        Some(("playlist", id)) if !id.is_empty() => Ok(("playlist", id)),
        Some(("album", id)) if !id.is_empty() => Ok(("album", id)),
        _ => Err(format!("not a syncable key: {key}")),
    }
}

/// One full pass over one collection. Safe to call concurrently: a key already
/// being worked is skipped rather than run twice.
pub async fn sync_one(state: &Arc<AppState>, user_id: i64, key: &str, force: bool) -> bool {
    let guard_key = format!("{user_id}\u{1}{key}");
    {
        let mut inflight = state.spotify_sync.inflight.lock().await;
        if !inflight.insert(guard_key.clone()) {
            return false;
        }
    }
    let result = sync_inner(state, user_id, key, force).await;
    state.spotify_sync.inflight.lock().await.remove(&guard_key);
    if let Err(err) = result {
        let _ = state.db.spotify_mirror_set_state(user_id, key, "error", &err);
        // Back off rather than hammering a broken link every cycle.
        let _ = state.db.spotify_mirror_head_seen(
            user_id,
            key,
            "",
            now_ms() + RECHECK_SECS * 1000,
        );
        return true;
    }
    true
}

async fn sync_inner(
    state: &Arc<AppState>,
    user_id: i64,
    key: &str,
    force: bool,
) -> Result<(), String> {
    let (kind, spotify_id) = split_key(key)?;
    let http = spotify::http_client().map_err(|(_, e)| e)?;

    let head = state
        .db
        .spotify_mirror(user_id, key)
        .ok_or("that collection is not being mirrored")?;

    // The cheap question first: has it actually moved? Watching two hundred
    // playlists costs two hundred one-request polls a cycle, and only a
    // snapshot that really changed pays for a full enumeration.
    let upstream = spotify::head_snapshot(state, user_id, &http, kind, spotify_id).await?;
    let changed = force || upstream != head.snapshot || head.total == 0;

    if changed {
        state.db.spotify_mirror_set_state(user_id, key, "enumerating", "").ok();
        let items = spotify::fetch_items(state, user_id, &http, kind, spotify_id).await?;
        // Carries every existing resolution forward; only positions and
        // metadata are refreshed, and entries gone from upstream are dropped.
        state
            .db
            .spotify_items_replace(user_id, key, &items)
            .map_err(|e| e.to_string())?;
    }

    state.db.spotify_mirror_set_state(user_id, key, "resolving", "").ok();
    resolve_pass(state, user_id, key).await?;
    materialize(state, user_id, key)?;
    let queued = enqueue_missing(state, user_id, key).await?;

    let counts = state
        .db
        .spotify_mirror_recount(user_id, key)
        .map_err(|e| e.to_string())?;
    let complete = counts.missing == 0 && counts.ambiguous == 0 && counts.queued == 0;
    let phase = if queued > 0 || counts.queued > 0 {
        "downloading"
    } else if complete {
        "synced"
    } else {
        "partial"
    };
    state.db.spotify_mirror_set_state(user_id, key, phase, "").ok();
    // The snapshot is only banked when the mirror actually holds all of it;
    // otherwise the next pass re-examines rather than declaring victory.
    let banked = if complete { upstream.as_str() } else { head.snapshot.as_str() };
    state
        .db
        .spotify_mirror_stamp(
            user_id,
            key,
            banked,
            state.db.current_rev(),
            now_ms() + RECHECK_SECS * 1000,
            complete,
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Decide what every unresolved entry is, cheapest rung first.
async fn resolve_pass(state: &Arc<AppState>, user_id: i64, key: &str) -> Result<(), String> {
    let pending = state.db.spotify_items_pending(user_id, key, now_ms(), 5000);
    if pending.is_empty() {
        return Ok(());
    }

    // Rung 1: a pin from a previous sync, or from another user who already
    // resolved the same song. Costs one query for the whole playlist.
    let uids: Vec<String> = pending.iter().map(|i| i.track_uid.clone()).collect();
    let by_spotify = state.db.ext_id_lookup("spotify", &uids);

    // Rung 2: ISRC - the recording industry's own id for a recording, and the
    // only identifier here that is not a guess.
    let isrcs: Vec<String> = pending
        .iter()
        .filter(|i| !i.isrc.is_empty())
        .map(|i| i.isrc.clone())
        .collect();
    let by_isrc = state.db.ext_id_lookup("isrc", &isrcs);

    // Rung 3: tags. Only built if something actually needs it.
    let needs_tags = pending
        .iter()
        .any(|i| !by_spotify.contains_key(&i.track_uid) && !by_isrc.contains_key(&i.isrc));
    let index = needs_tags.then(|| MatchIndex::build(state.db.match_index()));

    for item in &pending {
        if item.state == "unavailable" || item.state == "ignored" {
            continue;
        }
        if let Some(&track_id) = by_spotify.get(&item.track_uid) {
            set_resolved(state, user_id, key, item, track_id, "pin");
            continue;
        }
        if !item.isrc.is_empty() {
            if let Some(&track_id) = by_isrc.get(&item.isrc) {
                set_resolved(state, user_id, key, item, track_id, "isrc");
                continue;
            }
        }
        let Some(index) = index.as_ref() else { continue };
        match index.resolve(item) {
            TagVerdict::Strict(id) => set_resolved(state, user_id, key, item, id, "strict"),
            TagVerdict::Loose(id) => set_resolved(state, user_id, key, item, id, "loose"),
            TagVerdict::Ambiguous(ids) => {
                let _ = state.db.spotify_item_set(
                    user_id,
                    key,
                    &item.track_uid,
                    item.occurrence,
                    "ambiguous",
                    None,
                    "",
                    "",
                    &format!("{} tracks here could be this one", ids.len()),
                );
            }
            TagVerdict::None => {
                // Nothing local fits. Left pending so enqueue_missing picks it
                // up; a failed download is what moves it to `missing`.
                let _ = state.db.spotify_item_set(
                    user_id,
                    key,
                    &item.track_uid,
                    item.occurrence,
                    "pending",
                    None,
                    "",
                    "",
                    "",
                );
            }
        }
    }
    Ok(())
}

/// Mark an entry resolved and remember the answer for next time.
fn set_resolved(
    state: &Arc<AppState>,
    user_id: i64,
    key: &str,
    item: &MirrorItem,
    track_id: i64,
    method: &str,
) {
    let _ = state.db.spotify_item_set(
        user_id,
        key,
        &item.track_uid,
        item.occurrence,
        "resolved",
        Some(track_id),
        method,
        "",
        "",
    );
    // Pin both identities we now know, so the next sync - of this playlist or
    // any other holding the same song - skips straight to rung 1.
    if !item.track_uid.starts_with("local:") {
        let _ = state
            .db
            .ext_id_pin("spotify", &item.track_uid, track_id, method, "ladder");
    }
    if !item.isrc.is_empty() {
        let _ = state.db.ext_id_pin("isrc", &item.isrc, track_id, method, "ladder");
    }
}

/// Write the mirror into its local playlist, in Spotify's order, holding
/// whatever is resolved right now. Deliberately not deferred until everything
/// downloads: a playlist that appears immediately with two thirds of its songs
/// is far more useful than nothing for an hour.
fn materialize(state: &Arc<AppState>, user_id: i64, key: &str) -> Result<(), String> {
    let head = state
        .db
        .spotify_mirror(user_id, key)
        .ok_or("that collection is not being mirrored")?;
    let items = state.db.spotify_items(user_id, key);

    let name = if head.name.is_empty() {
        key.to_string()
    } else {
        head.name.clone()
    };
    let playlist_id = match head.playlist_id {
        Some(id) => {
            // Respect a local rename: the name is the one thing a listener
            // changes on purpose, so upstream only writes it while the local
            // name is still the one we last wrote.
            if let Some(current) = state.db.playlist_name(id) {
                if current == head.local_name && current != name {
                    let _ = state.db.rename_playlist(id, &name);
                    let _ = state.db.spotify_mirror_set_playlist(user_id, key, id, &name);
                }
            }
            id
        }
        None => {
            let id = state
                .db
                .create_playlist(user_id, &name)
                .map_err(|e| e.to_string())?;
            state
                .db
                .spotify_mirror_set_playlist(user_id, key, id, &name)
                .map_err(|e| e.to_string())?;
            id
        }
    };

    // Resolved entries only, in upstream order, compacted - a gap for a song
    // still downloading simply is not there yet.
    let track_ids: Vec<i64> = items
        .iter()
        .filter(|i| i.state == "resolved")
        .filter_map(|i| i.track_id)
        .collect();
    let (_landed, dropped) = state
        .db
        .set_playlist_tracks_checked(playlist_id, &track_ids)
        .map_err(|e| e.to_string())?;
    // A dropped id means its track was deleted under us; unresolve those so
    // the next pass looks for them again instead of silently losing them.
    if !dropped.is_empty() {
        let gone: HashSet<i64> = dropped.into_iter().collect();
        for item in items.iter().filter(|i| i.track_id.is_some_and(|t| gone.contains(&t))) {
            let _ = state.db.spotify_item_set(
                user_id,
                key,
                &item.track_uid,
                item.occurrence,
                "pending",
                None,
                "",
                "",
                "the local file it matched is gone",
            );
        }
    }
    Ok(())
}

/// Queue downloads for what is still unaccounted for, a bounded number at a
/// time so one big sync cannot swamp the import queue.
async fn enqueue_missing(state: &Arc<AppState>, user_id: i64, key: &str) -> Result<usize, String> {
    let items = state.db.spotify_items(user_id, key);
    let outstanding = items.iter().filter(|i| i.state == "queued").count();
    if outstanding >= DOWNLOAD_WINDOW {
        return Ok(0);
    }
    let room = DOWNLOAD_WINDOW - outstanding;
    let now = now_ms();
    let mut raised = 0usize;
    for item in items
        .iter()
        .filter(|i| (i.state == "pending" || i.state == "missing") && i.next_try_at <= now)
        .filter(|i| !i.track_uid.starts_with("local:"))
        .take(room)
    {
        // A single track by its own URL - which the importer already
        // understands, and which works whether or not the playlist it came
        // from is public.
        let url = format!("https://open.spotify.com/track/{}", item.track_uid);
        let label = if item.artist.is_empty() {
            item.title.clone()
        } else {
            format!("{} — {}", item.title, item.artist)
        };
        // Named for the queue: the mirror, and whose account it feeds.
        let via = state
            .db
            .user_by_id(user_id)
            .map(|u| format!("Spotify mirror · {}", u.username))
            .unwrap_or_else(|| "Spotify mirror".to_string());
        match imports::enqueue_internal(state, &url, &label, "Spotify sync", key, user_id, &via)
            .await
        {
            Ok(job_id) => {
                let _ = state.db.spotify_item_set(
                    user_id,
                    key,
                    &item.track_uid,
                    item.occurrence,
                    "queued",
                    None,
                    "",
                    &job_id,
                    "",
                );
                raised += 1;
            }
            Err(err) => {
                // Out of quota is a real stop, not a per-track failure.
                let _ = state.db.spotify_mirror_set_state(user_id, key, "error", &err);
                return Err(err);
            }
        }
    }
    Ok(raised)
}

/// Route a finished import back to the mirror entry that raised it. A no-op
/// for an ordinary pasted link.
pub async fn on_job_finished(state: &Arc<AppState>, job_id: &str) {
    let Some((user_id, key, uid, occurrence)) = state.db.spotify_item_by_job(job_id) else {
        return;
    };
    let job = {
        let jobs = state.imports.jobs.lock().await;
        jobs.iter().find(|j| j.id == job_id).cloned()
    };
    let Some(job) = job else { return };

    if job.state == "done" {
        // A sync job is always one track, so the first id it produced is the
        // one - no title matching needed. `owned_track_ids` covers the case
        // where the download turned out to be something already filed.
        let resolved = job.track_ids.first().or_else(|| job.owned_track_ids.first()).copied();
        if let Some(track_id) = resolved {
            let _ = state.db.spotify_item_set(
                user_id, &key, &uid, occurrence, "resolved", Some(track_id), "download", "", "",
            );
            let _ = state.db.ext_id_pin("spotify", &uid, track_id, "download", "sync");
            // Re-materialize so the playlist grows as songs land.
            let _ = materialize(state, user_id, &key);
            let _ = state.db.spotify_mirror_recount(user_id, &key);
            return;
        }
        let _ = state.db.spotify_item_defer(
            user_id,
            &key,
            &uid,
            occurrence,
            "the download finished but produced no track",
        );
    } else if job.state == "error" {
        let _ = state.db.spotify_item_defer(
            user_id,
            &key,
            &uid,
            occurrence,
            job.error.as_deref().unwrap_or("the download failed"),
        );
    } else {
        return;
    }
    let _ = state.db.spotify_mirror_recount(user_id, &key);
    state.spotify_sync.poke();
}

/// The background loop: poll what is watched, enumerate what moved, refill the
/// download window, and keep the local playlists caught up.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(BOOT_DELAY_SECS)).await;
        loop {
            let worked = cycle(&state).await;
            let wait = if worked { BUSY_SECS } else { IDLE_SECS };
            // Either the timer or a poke from an endpoint, whichever is first.
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(wait)) => {}
                _ = state.spotify_sync.notify.notified() => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(id: i64, title: &str, artist: &str, album: &str, dur: Option<i64>) -> MatchRow {
        MatchRow {
            id,
            title: title.into(),
            artist: artist.into(),
            album_artist: artist.into(),
            album: album.into(),
            duration_ms: dur,
        }
    }

    fn entry(title: &str, artist: &str, album: &str, dur: Option<i64>) -> MirrorItem {
        MirrorItem {
            track_uid: "uid".into(),
            occurrence: 0,
            position: 0,
            isrc: String::new(),
            title: title.into(),
            artist: artist.into(),
            album: album.into(),
            album_artist: artist.into(),
            duration_ms: dur,
            added_at: 0,
            track_id: None,
            match_method: String::new(),
            state: "pending".into(),
            attempts: 0,
            next_try_at: 0,
            job_id: String::new(),
            note: String::new(),
        }
    }

    #[test]
    fn album_agreement_makes_it_strict() {
        let index = MatchIndex::build(vec![local(1, "Redbone", "Childish Gambino", "Awaken", Some(326_000))]);
        match index.resolve(&entry("Redbone", "Childish Gambino", "Awaken", Some(326_000))) {
            TagVerdict::Strict(1) => {}
            _ => panic!("expected a strict match"),
        }
    }

    #[test]
    fn casing_and_padding_do_not_matter() {
        let index = MatchIndex::build(vec![local(1, "Redbone", "Childish Gambino", "Awaken", Some(326_000))]);
        match index.resolve(&entry("  REDBONE ", "childish gambino", "awaken", Some(326_000))) {
            TagVerdict::Strict(1) => {}
            _ => panic!("normalisation should have matched"),
        }
    }

    #[test]
    fn a_single_fit_on_another_album_is_loose() {
        // Same song, listed on a compilation upstream - still the recording we
        // own, but not the same release, so it is not claimed as strict.
        let index = MatchIndex::build(vec![local(7, "Redbone", "Childish Gambino", "Awaken", Some(326_000))]);
        match index.resolve(&entry("Redbone", "Childish Gambino", "Greatest Hits", Some(326_000))) {
            TagVerdict::Loose(7) => {}
            _ => panic!("expected a loose match"),
        }
    }

    #[test]
    fn two_equal_candidates_are_ambiguous_not_a_guess() {
        // A studio cut and a live take of the same length. Picking one here is
        // how the wrong recording ends up in a playlist, so neither is chosen.
        let index = MatchIndex::build(vec![
            local(1, "Song", "Band", "Studio", Some(200_000)),
            local(2, "Song", "Band", "Live", Some(200_000)),
        ]);
        match index.resolve(&entry("Song", "Band", "Compilation", Some(200_000))) {
            TagVerdict::Ambiguous(ids) => assert_eq!(ids.len(), 2),
            _ => panic!("expected ambiguity rather than a guess"),
        }
    }

    #[test]
    fn a_different_length_is_a_different_recording() {
        // An eight-minute remix is not the three-minute single.
        let index = MatchIndex::build(vec![local(1, "Song", "Band", "Album", Some(180_000))]);
        match index.resolve(&entry("Song", "Band", "Album", Some(480_000))) {
            TagVerdict::None => {}
            _ => panic!("duration should have ruled this out"),
        }
    }

    #[test]
    fn small_encode_drift_still_matches() {
        let index = MatchIndex::build(vec![local(1, "Song", "Band", "Album", Some(180_000))]);
        match index.resolve(&entry("Song", "Band", "Album", Some(182_500))) {
            TagVerdict::Strict(1) => {}
            _ => panic!("2.5s of drift should be tolerated"),
        }
    }

    #[test]
    fn an_unknown_length_does_not_veto_a_name_match() {
        let index = MatchIndex::build(vec![local(1, "Song", "Band", "Album", None)]);
        match index.resolve(&entry("Song", "Band", "Album", Some(180_000))) {
            TagVerdict::Strict(1) => {}
            _ => panic!("an unknown length should not block the match"),
        }
    }

    #[test]
    fn nothing_local_resolves_to_nothing() {
        let index = MatchIndex::build(vec![local(1, "Other", "Band", "Album", Some(180_000))]);
        match index.resolve(&entry("Song", "Band", "Album", Some(180_000))) {
            TagVerdict::None => {}
            _ => panic!("expected no match"),
        }
    }

    #[test]
    fn a_compilation_is_found_by_its_album_artist() {
        // Credited to the performer upstream, filed under the compiler here.
        let mut row = local(5, "Track", "Various Artists", "Chillout", Some(200_000));
        row.artist = "Real Performer".into();
        let index = MatchIndex::build(vec![row]);
        match index.resolve(&entry("Track", "Various Artists", "Chillout", Some(200_000))) {
            TagVerdict::Strict(5) | TagVerdict::Loose(5) => {}
            _ => panic!("the album-artist spelling should also find it"),
        }
    }

    #[test]
    fn keys_split_into_kind_and_id() {
        assert_eq!(split_key("playlist:abc").unwrap(), ("playlist", "abc"));
        assert_eq!(split_key("album:xyz").unwrap(), ("album", "xyz"));
        assert_eq!(split_key("liked").unwrap(), ("liked", ""));
        assert!(split_key("playlist:").is_err());
        assert!(split_key("nonsense").is_err());
    }
}

async fn cycle(state: &Arc<AppState>) -> bool {
    let due = state.db.spotify_mirrors_due(now_ms(), ENUMERATIONS_PER_CYCLE as i64);
    let mut worked = false;
    for (user_id, key) in due {
        if sync_one(state, user_id, &key, false).await {
            worked = true;
        }
    }

    // Mirrors that are mid-flight still need their download window refilled and
    // their playlist topped up as tracks land, without paying for a poll.
    for user_id in state.db.spotify_users() {
        for head in state.db.spotify_mirrors(user_id) {
            if !head.watch || head.state == "synced" {
                continue;
            }
            let has_room = head.queued < DOWNLOAD_WINDOW as i64;
            // New files may satisfy an unresolved entry for free.
            let library_moved = state.db.current_rev() > head.resolved_rev;
            if !has_room && !library_moved {
                continue;
            }
            if library_moved {
                let _ = resolve_pass(state, user_id, &head.key).await;
                let _ = materialize(state, user_id, &head.key);
            }
            if enqueue_missing(state, user_id, &head.key).await.unwrap_or(0) > 0 {
                worked = true;
            }
            let _ = state.db.spotify_mirror_recount(user_id, &head.key);
        }
    }
    worked
}
