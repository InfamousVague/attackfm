//! The collector: the curator's buying arm.
//!
//! Discovery (discovery.rs) already finds music you do not own, listens to it,
//! and scores it against your taste - and then waits for you to notice the
//! shelf. This module stops waiting. On a slow loop it takes the best-scored
//! candidates and BUYS them: resolves each to a link the importer accepts and
//! raises the same import job a tap would have, without the tap.
//!
//! The honesty rules that make autonomy tolerable:
//!
//! - **Nothing lands in your library.** A collector download is stamped as an
//!   audition (tracks.curator_user_id, unpromoted) and appears only on the
//!   For-you shelf. A completed listen or a heart adopts it; until then the
//!   rest of the app does not know it exists.
//! - **A budget, hard.** Unadopted auditions may hold at most the configured
//!   cap (250 GB unless changed). At the cap the collector STOPS and says so -
//!   it never deletes anything to make room. Adopting or removing music is
//!   what resumes it.
//! - **People first.** It never queues while a person's own import is in
//!   flight, and it raises one job at a time.
//! - **It learns.** The exploration dial rises when auditions get adopted and
//!   falls when they sit - the skip data the listen log carries is the same
//!   signal, priced into the discovery scores it reads.

use crate::db::DiscoveryRow;
use crate::AppState;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

/// Between cycles. Continuous in spirit, polite in practice: a cycle is cheap
/// when there is nothing to do, and a pull per few minutes outruns anyone's
/// listening.
const CYCLE: Duration = Duration::from_secs(5 * 60);
/// How long a failed pull blocks its candidate before it may be tried again.
/// "The catalogue answered and did not have it" is a fact about the catalogue
/// THAT day - tracks appear, matches improve - so a failure ages out instead
/// of condemning the candidate forever. Long, because most failures do repeat.
const FAILED_RETRY_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// The listening window that makes someone a current listener.
const WINDOW_30D_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// The default budget for unadopted auditions.
const DEFAULT_CAP_BYTES: i64 = 250_000_000_000;
/// How deep the buying pass looks for someone's next offer. This was 24 and
/// starved the exact listener the collector serves best: after weeks of
/// dating, a heavy dater's top twenty-four BY SCORE are all already pulled,
/// so every pass found nothing and their shelf sat still while five hundred
/// measured candidates waited just below the window. The bar still guards
/// quality; depth just means "the best UNPULLED ones".
const CANDIDATES: i64 = 400;
/// Offers one listener may be raised in one pass. One-per-pass at a
/// five-minute cycle capped the hungriest shelf at twelve an hour before a
/// single claim was even counted; three keeps the pace a peer can feel.
const PER_LISTENER_PER_CYCLE: usize = 3;
/// How long a pull may sit queued before its job is presumed dead.
const STALE_PULL_MS: i64 = 24 * 60 * 60 * 1000;

/// Every Nth seat at the date belongs to today's chart: the trending lane
/// already lands the global chart in the pool, but taste-ranked buying meant
/// a hit far from your taste never survived the threshold - so the deck was
/// all echo and no radio. One seat in three was the radio's, by request;
/// one in TWO since "add in more top hits" (2026-08-30).
const CHART_EVERY: usize = 2;
/// The cadence counts buys inside this window, so a listener who takes a
/// month off starts a fresh rotation instead of inheriting a stale remainder.
const CHART_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// How much adoption history a tuning step needs before it moves the dial.
const TUNE_MIN_SAMPLES: i64 = 5;

/// The date deck every account is entitled to, listening history or not.
/// Below this floor a user joins the collector's rotation cold.
const COLD_DECK_FLOOR: i64 = 40;

/// Everyone the collector serves: recent listeners, plus anyone whose date
/// deck sits under the floor - a brand-new account included. The pool, the
/// measurement pass and the buying pass all iterate THIS list; iterating
/// recent listeners alone meant a quiet friend opened Music Date to nothing.
pub(crate) fn daters(state: &Arc<AppState>) -> Vec<i64> {
    let since = now_ms() - WINDOW_30D_MS;
    let mut out = state.db.listeners_since(since);
    for user in state.db.cold_shelf_users(COLD_DECK_FLOOR) {
        if !out.contains(&user) {
            out.push(user);
        }
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The budget, operator-adjustable through the settings endpoint.
pub(crate) fn cap_bytes(state: &Arc<AppState>) -> i64 {
    state
        .db
        .meta_get("collector.cap_bytes")
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_CAP_BYTES)
}

/// The score a candidate needs before the collector spends on it. The dial
/// buys reach: an adventurous collector accepts weaker matches, a conservative
/// one waits for near-certainties. The band keeps even 100% adventure above
/// the "every term neutral" score of 0.5, so noise is never bought.
fn threshold(exploration: f64) -> f64 {
    0.72 - 0.16 * exploration.clamp(0.0, 1.0)
}

/// Whether anything about this candidate was actually MEASURED.
///
/// A score is three terms, each falling back to a neutral 0.5 when its input is
/// missing - which means a candidate nobody has measured scores on popularity
/// alone and can drift over the bar on fame rather than fit. The collector
/// spends real disk, so it waits until at least one term is real: a tempo taken
/// off the preview, or a lyric vector read for it. Suggesting such a candidate
/// is still fine (that costs nothing); BUYING it is not.
fn measured(d: &DiscoveryRow) -> bool {
    d.bpm.is_some() || d.lyric_vec.is_some()
}

/// Starts the collector. Runs until the process ends.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Let the boot scan and the curator's first cycle have the box first.
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            settle_pulls(&state).await;
            settle_delegated(&state).await;
            // Cheap, and it rides a timer that already exists: the AI
            // counters are per-process, so without this a restart erases
            // every sign that any of it has ever worked.
            crate::ai::flush_last_runs(&state.db);
            pull_cycle(&state).await;
            settle_pending_likes(&state).await;
            settle_playlist_wants(&state).await;
            // The standing chart playlists ride the same loop; their own
            // daily clock makes this a cheap no-op almost every pass.
            crate::chartlists::cycle(&state).await;
            // New Music's own hourly backstop - the listening hooks do the
            // rest the moment a song is met or lands.
            crate::chartlists::new_music_cycle(&state).await;
            tune_cycle(&state);
            // The small-artist sources fill the same pool the Deezer harvest
            // does; their own clocks make this a no-op most cycles.
            crate::listenbrainz::cycle(&state).await;
            tokio::time::sleep(CYCLE).await;
        }
    });
}

/// How long a delegated pull waits for a peer to deliver it before the hub
/// forgets it ever asked. Long enough to cover a home server that is off for
/// the night, short enough that the pool moves on.
const UNANSWERED_MS: i64 = 24 * 60 * 60 * 1000;
/// How many wants may be outstanding at once. Offers accumulate while no peer
/// is listening - one every cycle, per listener - and a queue that grows all
/// week is not a queue, it is a backlog nobody asked for. At the cap the
/// collector simply stops raising new ones until the peer catches up.
const OUTSTANDING_OFFERS: usize = 40;
/// How many wants one cycle may raise when this box is only offering them.
/// Bounded so a first run against a deep pool does not put the whole cap up in
/// one go and leave the peer nothing to pace itself against.
/// Twelve, up from five: with the peer able to keep its queue fed (see
/// peersync's claim gate) the day's ceiling is download time, not offers -
/// and a listener who judges a whole sitting deserves a shelf that refills
/// the same afternoon, not three cards a day.
const OFFERS_PER_CYCLE: usize = 12;

/// Walks pulls whose import is still out and settles the finished ones:
/// a done job stamps its tracks as auditions, a failed or vanished one is
/// recorded as failed so the same candidate is never bought again.
async fn settle_pulls(state: &Arc<AppState>) {
    let open = state.db.open_pulls();
    if open.is_empty() {
        return;
    }
    let jobs = state.imports.jobs.lock().await.clone();
    for (pull_id, user_id, job_id) in open {
        let job = jobs.iter().find(|j| j.id == job_id);
        match job {
            Some(j) if j.state == "done" => {
                // A job that finished having gained nothing new still closes
                // its pull: land_pull only marks it landed when something took
                // the stamp, so say so explicitly rather than leaving the pull
                // open against a job that is never going to change again.
                if state.db.land_pull(pull_id, user_id, &j.track_ids).unwrap_or(0) == 0 {
                    let _ = state.db.mark_pull_landed(pull_id);
                } else {
                    // A new audition for this listener: it belongs in their
                    // New Music now, not on the next clock tick.
                    crate::chartlists::refresh_new_music_for(state, user_id);
                }
            }
            Some(j) if j.state == "error" => {
                let _ = state.db.fail_pull(pull_id);
            }
            // Still moving - leave it.
            Some(_) => {}
            // The queue no longer remembers the job (cleared, or a restart
            // that predates persistence of this job). After a day, stop
            // waiting for an answer that is not coming.
            None => {
                let _ = state.db.fail_pull_if_stale(pull_id, now_ms() - STALE_PULL_MS);
            }
        }
    }
}

/// Settles the pulls that are out with a peer.
///
/// These have no local job to ask, so the peer TELLS us: when its upload
/// finishes, the hub replies with the rel_path it filed the file under, and the
/// peer reports that back against the pull. Settling is then an exact lookup.
///
/// It matched by artist and title once, against everything recently added. That
/// was wrong in a way worth recording: any track that happened to arrive in the
/// window with a similar name was annexed as one listener's private audition -
/// hidden from every other client, and UNLINKED FROM DISK if that listener
/// swiped past it in Music Date. A pull now lands on the files it was told
/// about, or on nothing at all.
///
/// NOTHING IS DOWNLOADED HERE when nobody answers. A first version had this box
/// fetch the song itself after ten minutes, so that a hub with no peer still
/// stocked its own shelves. That served an operator nobody has been: setting
/// collector mode is itself the statement that this box does not download, and
/// on the box it was written for the local downloader cannot reach a provider
/// at all - so every fallback was a guaranteed failure that then condemned its
/// candidate for a month. An unanswered offer is now simply forgotten, which
/// puts the song back in the pool to be offered again when a peer is listening.
async fn settle_delegated(state: &Arc<AppState>) {
    for (pull_id, user_id, marker, _url, _title, _artist, created_at, ext_id, kind) in
        state.db.delegated_pulls()
    {
        let ids = state.db.pull_path_track_ids(pull_id);
        /*
         * A member's pasted link, downloaded elsewhere (imports::enqueue on a
         * hub in collector mode). The files are THEIRS - a finished import,
         * not an audition - so the card is completed rather than the tracks
         * stamped, and a day unanswered is a failure the card can say, not a
         * candidate quietly returned to a pool it never came from.
         *
         * WHOLE, not first. An album arrives one report per file over a
         * window, so the card is finished only when the link's own listing
         * is accounted for, or when the files have stopped coming. And a
         * song this box already held is part of the answer: a peer only
         * pushes what is missing here, so the listing is also matched by
         * identity against the library.
         */
        if kind == "import" {
            let job = crate::imports::delegated_job_id(&ext_id);
            let (expected, total) = match job {
                Some(j) => crate::imports::delegated_expectation(state, j).await,
                None => (Vec::new(), None),
            };
            let mut have = ids.clone();
            for id in held_track_ids(state, &expected) {
                if !have.contains(&id) {
                    have.push(id);
                }
            }
            let last_at = state.db.pull_last_path_at(pull_id);
            let complete = match total {
                Some(t) if t > 0 => have.len() as u32 >= t,
                _ => last_at > 0 && now_ms() - last_at >= IMPORT_QUIET_MS,
            };
            // Everything the listing named was here all along: no peer needed.
            let held_only = ids.is_empty() && !expected.is_empty() && have.len() >= expected.len();
            if !have.is_empty() && (complete || held_only) {
                if state.db.land_import_pull(pull_id).is_ok() {
                    if let Some(job) = job {
                        crate::imports::land_delegated(state, job, &have).await;
                    }
                }
                continue;
            }
            // The clock restarts at the claim (claim_offered_pull), so a taken
            // pull gets its day from the peer picking it up, not from the paste.
            if now_ms() - created_at > UNANSWERED_MS {
                let _ = state.db.fail_pull(pull_id);
                if let Some(job) = job {
                    let why = if marker == crate::db::Db::PULL_TAKEN {
                        "The download box took it but never delivered it. Retry to offer it again."
                    } else {
                        "No download box answered in a day. Retry when it is back."
                    };
                    crate::imports::fail_delegated(state, job, why).await;
                }
            }
            continue;
        }
        if !ids.is_empty() && state.db.land_pull(pull_id, user_id, &ids).unwrap_or(0) > 0 {
            crate::chartlists::refresh_new_music_for(state, user_id);
            continue;
        }
        /*
         * FORGOTTEN, not failed.
         *
         * `fail_pull` means "the catalogue does not have this song", and
         * pulled_ext_ids honours that for thirty days. "No peer was listening"
         * is not a fact about the song, and burning a good candidate for a
         * month because a home server was switched off overnight is exactly the
         * damage this distinction avoids. Dropping the row lets the ordinary
         * scoring offer it again; the paths and tracks tables cascade with it.
         */
        if now_ms() - created_at > UNANSWERED_MS {
            let _ = state.db.forget_pull(pull_id);
        }
    }
}

/// How long a delegated link with no listing of its own waits after its last
/// file before the card is finished: an album's files arrive one report each,
/// and one settle cycle of silence is the sign they have stopped.
const IMPORT_QUIET_MS: i64 = 5 * 60 * 1000;

/// The library's own copies of the songs a listing names, by identity - the
/// exact credit first, the lead credit second, the way `matching_identity`
/// reads a promised heart. Used for a delegated link: what was already here
/// counts toward the card, since a peer never pushes those.
pub(crate) fn held_track_ids(state: &Arc<AppState>, expected: &[(String, String)]) -> Vec<i64> {
    if expected.is_empty() {
        return Vec::new();
    }
    let identities = state.db.track_identities();
    let mut out: Vec<i64> = Vec::new();
    for (artist, title) in expected {
        if artist.trim().is_empty() || title.trim().is_empty() {
            continue;
        }
        let exact = crate::discovery::key_of(artist, title);
        let lead = crate::discovery::lead_key(artist, title);
        let hit = identities
            .iter()
            .find(|(_, a, t, _)| crate::discovery::key_of(a, t) == exact)
            .or_else(|| identities.iter().find(|(_, a, t, _)| crate::discovery::lead_key(a, t) == lead));
        if let Some((id, ..)) = hit {
            if !out.contains(id) {
                out.push(*id);
            }
        }
    }
    out
}

/// How long a promised heart waits for its song before the promise lapses.
const PENDING_LIKE_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The track a promised key names, if this box holds it.
///
/// Exact credit first, lead credit second (discovery::lead_key): a promise
/// says "Czarface" and the file that lands says "CZARFACE, Frankie Pulitzer",
/// which are different keys for one song. Matched exactly, the settle pass
/// walks past a song that is right there and the heart waits out its whole
/// thirty-day life on a band captioned "still downloading". Two passes, so an
/// exact match on any row always beats a lead-only match on another.
fn matching_identity<'a>(
    identities: &'a [(i64, String, String, i64)],
    user: i64,
    k: &str,
) -> Option<&'a (i64, String, String, i64)> {
    let mine = |owner: &i64| *owner == 0 || *owner == user;
    identities
        .iter()
        .find(|(_, artist, title, owner)| mine(owner) && crate::discovery::key_of(artist, title) == k)
        .or_else(|| {
            identities.iter().find(|(_, artist, title, owner)| {
                mine(owner) && crate::discovery::lead_key(artist, title) == k
            })
        })
}

/// Keep the hearts promised on Discover: any pending like whose song has
/// landed - by import, by delegation, by hand - becomes a real favourite.
/// Matching by folded identity is SAFE here in the way it never was for
/// delegated pulls: the worst wrong match is a heart on a same-named song,
/// not an annexed file.
async fn settle_pending_likes(state: &Arc<AppState>) {
    let rows = state.db.pending_likes_all();
    if rows.is_empty() {
        return;
    }
    let identities = state.db.track_identities();
    let now = now_ms();
    for (user, k, created_at) in rows {
        if now - created_at > PENDING_LIKE_TTL_MS {
            let _ = state.db.pending_like_remove(user, &k);
            continue;
        }
        let hit = matching_identity(&identities, user, &k);
        if let Some((id, _, _, _)) = hit {
            let _ = state.db.set_favorite(user, *id, true);
            state.db.promote_curator_track(*id);
            let _ = state.db.pending_like_remove(user, &k);
            // Hearted = met: it leaves New Music now.
            crate::chartlists::refresh_new_music_for(state, user);
            continue;
        }
        /*
         * NOT LANDED, AND NOTHING COMING.
         *
         * A pending like's download can die - the job fails, the queue is
         * cleared, the box restarts mid-pull - and the heart then stood on the
         * Liked page saying "still downloading" for thirty days over an empty
         * queue. The person asked for this song ONCE, explicitly; asking the
         * catalogue again on their behalf is the promise being kept, not
         * initiative.
         *
         * Bounded hard: only when no matching job is queued or running, only
         * after ten minutes of grace (the ordinary landing path needs no
         * help), and at most once a day per heart, stamped in meta - a song
         * the providers genuinely cannot produce costs one failed job a day
         * for its thirty-day life, then ages out.
         */
        retry_pending_like(state, user, &k, created_at, now).await;
    }
}

/// One bounded re-ask for a heart whose download died. See the caller's note.
async fn retry_pending_like(state: &Arc<AppState>, user: i64, k: &str, created_at: i64, now: i64) {
    const GRACE_MS: i64 = 10 * 60 * 1000;
    const RETRY_EVERY_MS: i64 = 24 * 60 * 60 * 1000;
    if now - created_at < GRACE_MS {
        return;
    }
    let (title, artist) = match state
        .db
        .pending_likes_for(user)
        .into_iter()
        .find(|(key, _, _, _)| key == k)
    {
        Some((_, t, a, _)) => (t, a),
        None => return,
    };
    // A live job for this song means the wire is doing its work; stand down.
    {
        let jobs = state.imports.jobs.lock().await;
        let moving = jobs.iter().any(|j| {
            (j.state == "queued" || j.state == "downloading")
                && j.subtitle
                    .as_deref()
                    .map(|a| crate::discovery::key_of(a, &j.title) == k)
                    .unwrap_or(false)
        });
        if moving {
            return;
        }
    }
    let stamp_key = format!("pending_like.retry.{user}.{k}");
    let stamped = state
        .db
        .meta_get(&stamp_key)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if now - stamped < RETRY_EVERY_MS {
        return;
    }
    let _ = state.db.meta_set(&stamp_key, &now.to_string());

    // The same resolve the collector's own buys use: the catalogue's URL for
    // this exact song, through whichever provider answers.
    let query = format!("{artist} {title}");
    let rows = crate::search::spotify_catalog(state, &query).await;
    let hit = rows.iter().find(|r| {
        r.kind == "track" && same_artist(&r.subtitle, &artist) && same_title(&r.title, &title)
    });
    let Some(found) = hit else { return };
    let via = state
        .db
        .user_by_id(user)
        .map(|u| format!("a liked song, retried · for {}", u.username))
        .unwrap_or_else(|| "a liked song, retried".to_string());
    let _ = crate::imports::enqueue_internal(
        state, &found.url, &title, &artist, "track", user, &via,
    )
    .await;
}

// --- playlist wants (planned, not-yet-owned playlist members) --------------
//
// A want is the playlist twin of a pending like: a song filed into a list that
// this box does not own yet. The machinery mirrors settle_pending_likes almost
// exactly - land it, or bounded-retry its download - with two deliberate
// differences: it files the landed track into its PLAYLIST rather than into
// Liked, and it never touches favourites (the listener filed it somewhere on
// purpose; auto-liking everything they queue would flood Liked).

/// Whether a link is one the importer takes directly - the same rule the client
/// uses (see resolveImport.ts `importable`). A Deezer/other link needs resolving
/// to its Spotify twin first.
fn importable_url(url: &str) -> bool {
    url.contains("open.spotify.com/") || url.starts_with("spotify:")
}

/// Whether a queued/running job is already fetching this key. Shared by the
/// pending-like and want retries so neither piles a second job on a live one.
async fn job_moving_for(state: &Arc<AppState>, k: &str) -> bool {
    let jobs = state.imports.jobs.lock().await;
    jobs.iter().any(|j| {
        (j.state == "queued" || j.state == "downloading")
            && j.subtitle
                .as_deref()
                .map(|a| crate::discovery::key_of(a, &j.title) == k)
                .unwrap_or(false)
    })
}

/// Resolve a song to a fetchable catalogue link by name, then enqueue it. The
/// same path the collector's own buys and the pending-like retry use.
async fn resolve_and_enqueue(
    state: &Arc<AppState>,
    user: i64,
    title: &str,
    artist: &str,
    via_label: &str,
) {
    let query = format!("{artist} {title}");
    let rows = crate::search::spotify_catalog(state, &query).await;
    let hit = rows.iter().find(|r| {
        r.kind == "track" && same_artist(&r.subtitle, artist) && same_title(&r.title, title)
    });
    let Some(found) = hit else { return };
    let via = state
        .db
        .user_by_id(user)
        .map(|u| format!("{via_label} · for {}", u.username))
        .unwrap_or_else(|| via_label.to_string());
    let _ =
        crate::imports::enqueue_internal(state, &found.url, title, artist, "track", user, &via)
            .await;
}

/// Start a want's download NOW - what the add endpoint spawns so the song
/// begins arriving the moment it is filed, rather than waiting for the sweep's
/// grace period. Uses the client's link straight when it is fetchable, else
/// resolves the twin by name. No stamp and no grace: this is the deliberate
/// first ask, not a retry.
pub async fn kick_want_download(
    state: &Arc<AppState>,
    user: i64,
    title: &str,
    artist: &str,
    url: &str,
) {
    // This is a person choosing a specific song to fetch - the same class the
    // pasted-link door refuses when the box is not a downloader. Respect that
    // door here too: on a CollectorOnly/Off box the immediate fetch is skipped
    // (the want is still recorded, and the bounded settle-retry - the
    // collector keeping a promise, like the pending-like retry - carries it).
    if crate::imports::imports_mode() != crate::imports::ImportsMode::On {
        return;
    }
    let k = crate::discovery::key_of(artist, title);
    if job_moving_for(state, &k).await {
        return;
    }
    if !url.is_empty() && importable_url(url) {
        let via = state
            .db
            .user_by_id(user)
            .map(|u| format!("a playlist song · for {}", u.username))
            .unwrap_or_else(|| "a playlist song".to_string());
        let _ = crate::imports::enqueue_internal(state, url, title, artist, "track", user, &via)
            .await;
        return;
    }
    resolve_and_enqueue(state, user, title, artist, "a playlist song").await;
}

/// If a track matching this want's key is now owned, append it to the playlist
/// (tail, order preserved, no duplicate) and drop the want. Returns true when
/// the want is settled. `identities` is the shared snapshot the caller already
/// holds. Idempotent: a want already gone is a no-op the caller treats as done.
fn try_settle_want(
    state: &Arc<AppState>,
    user: i64,
    playlist_id: i64,
    k: &str,
    identities: &[(i64, String, String, i64)],
) -> bool {
    let hit = matching_identity(identities, user, k);
    let Some((id, _, _, _)) = hit else {
        return false;
    };
    // Atomic single-row append - NOT read-ids + set-whole-list, which would
    // race concurrent edits and prune soft-deleted members. See the note on
    // Db::playlist_append_track.
    let _ = state.db.playlist_append_track(playlist_id, *id);
    let _ = state.db.playlist_want_remove(playlist_id, k);
    true
}

/// The client's fast path: it noticed a want's key land in the library and asks
/// the box to file it at once rather than wait for the next sweep. Returns
/// whether it settled. Ownership is the caller's to check.
pub fn settle_want_now(state: &Arc<AppState>, user: i64, playlist_id: i64, k: &str) -> bool {
    let identities = state.db.track_identities();
    try_settle_want(state, user, playlist_id, k, &identities)
}

/// The sweep: file every landed want into its list, age out the stale, and
/// bounded-retry the downloads that died. Rides the same loop as
/// settle_pending_likes.
async fn settle_playlist_wants(state: &Arc<AppState>) {
    let rows = state.db.playlist_wants_all();
    if rows.is_empty() {
        return;
    }
    let identities = state.db.track_identities();
    let now = now_ms();
    for (user, playlist_id, k, title, artist, created_at) in rows {
        if now - created_at > PENDING_LIKE_TTL_MS {
            let _ = state.db.playlist_want_remove(playlist_id, &k);
            continue;
        }
        if try_settle_want(state, user, playlist_id, &k, &identities) {
            continue;
        }
        retry_want_download(state, user, &k, &title, &artist, created_at, now).await;
    }
}

/// One bounded re-ask for a want whose download died - the pending-like retry,
/// filed to a playlist instead of a heart. Same bounds: past grace, not already
/// moving, at most once a day per want.
async fn retry_want_download(
    state: &Arc<AppState>,
    user: i64,
    k: &str,
    title: &str,
    artist: &str,
    created_at: i64,
    now: i64,
) {
    const GRACE_MS: i64 = 10 * 60 * 1000;
    const RETRY_EVERY_MS: i64 = 24 * 60 * 60 * 1000;
    if now - created_at < GRACE_MS {
        return;
    }
    if job_moving_for(state, k).await {
        return;
    }
    let stamp_key = format!("playlist_want.retry.{user}.{k}");
    let stamped = state
        .db
        .meta_get(&stamp_key)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if now - stamped < RETRY_EVERY_MS {
        return;
    }
    let _ = state.db.meta_set(&stamp_key, &now.to_string());
    resolve_and_enqueue(state, user, title, artist, "a playlist song, retried").await;
}

/// One buying pass: for each current listener with the collector on, consider
/// their best unbought candidates and raise at most one import.
async fn pull_cycle(state: &Arc<AppState>) {
    // No tool to import with means no pulls - the status endpoint says so
    // rather than a queue of jobs that all fail.
    if crate::search::spotiflac_python().is_none() {
        return;
    }
    // The budget is global (it is one disk): at the cap the collector stops
    // whole, and the For-you shelf carries the message.
    if state.db.collector_ledger_bytes() >= cap_bytes(state) {
        return;
    }
    // Nobody is taking what has already been offered; adding to the pile helps
    // no one. Members' delegated links are not the collector's pile - a burst
    // of pastes must not eat its offer budget, nor count as its backlog.
    if state.db.delegated_pulls().iter().filter(|r| r.8 != "import").count() >= OUTSTANDING_OFFERS {
        return;
    }
    // People first: a human's import in flight means the queue is not ours.
    // A delegated card waits on another box and holds no slot here.
    {
        let jobs = state.imports.jobs.lock().await;
        let busy = jobs.iter().any(|j| {
            crate::imports::local(j)
                && (j.state == "queued" || j.state == "downloading")
                && (j.origin != "collector" || j.state == "downloading")
        });
        if busy {
            return;
        }
    }

    let mut raised = 0usize;
    let mut cold_raised = 0usize;
    // Hungriest first: the listener with the emptiest audition shelf gets the
    // cycle's offers before anyone comfortable. One heavy dater used to see
    // three cards a day while quieter shelves sat full - the round-robin was
    // fair to accounts and unfair to appetites. Cold shelves ride along via
    // daters(), and their emptiness puts them at the front of this line.
    let mut listeners = daters(state);
    listeners.sort_by_key(|u| state.db.audition_count(*u));
    for user in listeners {
        let (enabled, exploration) = state.db.collector_state(user);
        if !enabled {
            continue;
        }
        // Taste moved since these candidates were scored; re-rank the pool
        // against who the listener is NOW before choosing from it. This is
        // the caller rescore() spent months waiting for.
        crate::discovery::rescore(state, user);
        let pulled = state.db.pulled_ext_ids(user, now_ms() - FAILED_RETRY_AFTER_MS);
        let bar = threshold(exploration);
        let lanes = state.db.discovery_lanes(user);
        /*
         * The chart's seat. Every CHART_EVERY-th buy is offered to the
         * trending lane first, ranked by chart position rather than taste
         * score, and EXEMPT from the exploration threshold - the chart earns
         * its seat by being the chart, which is precisely the music a taste
         * model cannot vouch for. Measurement is still required (a date card
         * needs its sound), and when the lane has nothing measured and
         * unpulled the seat falls back to the ordinary taste pick rather
         * than going empty.
         */
        // Buys already made this pass, so the alternating chart seat keeps
        // counting straight while the pass raises several.
        let mut mine = 0usize;
        let mut recent = state.db.pulled_ext_ids(user, now_ms() - CHART_WINDOW_MS).len();
        let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
        // No listening history means no taste to score against - the chart is
        // the only honest signal, so a cold shelf is stocked chart-first
        // (the chart seat is already exempt from the taste bar). Cold
        // shelves share HALF of each pass, never all of it: five empty
        // accounts out-hunger every real listener by definition, and the
        // person who asked for faster dates must not fund the promise alone.
        let cold = state.db.recent_plays(user, 5).is_empty();
        if cold && cold_raised >= OFFERS_PER_CYCLE / 2 {
            continue;
        }
        while mine < PER_LISTENER_PER_CYCLE {
            let chart_turn = cold || recent % CHART_EVERY == CHART_EVERY - 1;
            let chart_pick = if chart_turn {
                let mut charted: Vec<_> = state
                    .db
                    .top_discoveries(user, CANDIDATES)
                    .into_iter()
                    .filter(|d| lanes.get(&d.ext_id).is_some_and(|(lane, _)| lane == "trending"))
                    .filter(|d| {
                        !pulled.contains(&d.ext_id)
                            && !taken.contains(&d.ext_id)
                            && !d.url.trim().is_empty()
                            && measured(d)
                    })
                    .collect();
                charted.sort_by(|a, b| {
                    b.popularity.partial_cmp(&a.popularity).unwrap_or(std::cmp::Ordering::Equal)
                });
                charted.into_iter().next()
            } else {
                None
            };
            let pick = chart_pick.or_else(|| {
                state
                    .db
                    .top_discoveries(user, CANDIDATES)
                    .into_iter()
                    .filter(|d| {
                        !pulled.contains(&d.ext_id)
                            && !taken.contains(&d.ext_id)
                            && !d.url.trim().is_empty()
                    })
                    .find(|d| d.score as f64 >= bar && measured(d))
            });
            let Some(candidate) = pick else { break };
            let charted = lanes
                .get(&candidate.ext_id)
                .is_some_and(|(lane, _)| lane == "trending");

            if !buy(state, user, &candidate, charted).await {
                break;
            }
            /*
             * One at a time across all listeners - unless this box is only
             * OFFERING, in which case a few per listener.
             *
             * The rotation exists because a buy occupies the download queue,
             * and one listener should not hold it while everyone else waits.
             * When the downloading happens on a peer that rule is measuring
             * something this box no longer does: an offer costs a row, the
             * peer takes them at its own pace, and the outstanding cap is
             * the real backstop. Hungriest-first order plus a small
             * per-listener allowance keeps the fairness and drops the
             * throttle that held the hungriest shelf to one want a cycle.
             */
            if crate::imports::imports_mode() != crate::imports::ImportsMode::CollectorOnly {
                return;
            }
            taken.insert(candidate.ext_id.clone());
            mine += 1;
            recent += 1;
            raised += 1;
            if cold {
                cold_raised += 1;
            }
            if raised >= OFFERS_PER_CYCLE {
                return;
            }
        }
    }
}

/// One listener asking for more to choose from: look for candidates around what
/// they have been playing, then let the buying pass consider them.
///
/// The same two steps `date_done` runs when somebody reaches the end of the
/// deck, reached from Settings instead of from the deck. Returns how many
/// candidates the pool holds afterwards, because the honest report is about the
/// POOL - a buying pass raises at most one download and the card it becomes
/// does not exist until that download lands, minutes later, on another machine.
pub(crate) async fn top_up(state: &Arc<AppState>, user: i64) -> i64 {
    let since = now_ms() - WINDOW_30D_MS;
    let seeds: Vec<(String, i64)> = state
        .db
        .top_artists(user, since, 8)
        .into_iter()
        .map(|(name, weight)| (name, weight))
        .collect();
    if !seeds.is_empty() {
        crate::discovery::harvest_seeded(state, user, seeds).await;
    }
    crate::ai::task_step("choosing something to fetch");
    pull_cycle(state).await;
    let (pool, _) = state.db.discovery_counts(user);
    pool
}

/// Resolve a candidate to a link the importer takes and raise the job.
/// True when a job went up (whatever becomes of it).
pub(crate) async fn buy(state: &Arc<AppState>, user: i64, d: &DiscoveryRow, charted: bool) -> bool {
    // Discovery candidates carry Deezer links, which the importer refuses as
    // primary input - the same dead end the artist page had, solved the same
    // way: find the Spotify twin by name and hand over that.
    let query = format!("{} {}", d.artist, d.title);
    let rows = crate::search::spotify_catalog(state, &query).await;
    let resolved = rows.iter().find(|r| {
        r.kind == "track"
            && r.importable
            && same_artist(&r.subtitle, &d.artist)
            && same_title(&r.title, &d.title)
    });
    let Some(hit) = resolved else {
        // Nothing came back AT ALL means this box could not reach Spotify -
        // no SpotiFLAC and no web token - which says nothing about the record.
        // Condemning the candidate then would quietly burn the whole discovery
        // pool on a misconfigured hub, marking every song "not on Spotify"
        // forever. Leave it for a later cycle instead.
        if rows.is_empty() {
            return false;
        }
        // The catalogue answered and did not have it: record the failure so the
        // candidate is never reconsidered, rather than re-searched every cycle.
        let _ = state.db.record_pull(
            user, &d.ext_id, "track", &d.title, &d.artist, &d.url, "", d.score as f64, "",
        );
        if let Ok(pull) = state.db.pull_id_for(user, &d.ext_id) {
            let _ = state.db.fail_pull(pull);
        }
        return false;
    };

    /*
     * THE REASON NO LONGER STANDS IN THE DOOR.
     *
     * reason_for is a chat-model call, and it ran inline before the pull was
     * even recorded - so on a hub whose model takes a minute a sentence, a
     * three-offer pass spent three model-minutes before one download was
     * raised, and the whole cycle budget went on copywriting. That is the
     * shape behind "music dates arrive slow": the date pool fills at the rate
     * the model writes captions for it.
     *
     * The pull goes up NOW with the plain-sentence reason (already the
     * fallback for a hub with no model at all); the model's warmer line lands
     * on the row behind the download, where its latency costs nobody a song.
     */
    let reason = plain_reason(d, charted);
    {
        let st = Arc::clone(state);
        // Only the fields the reason mentions travel; the vector stays put.
        let d2 = DiscoveryRow {
            ext_id: d.ext_id.clone(),
            title: d.title.clone(),
            artist: d.artist.clone(),
            cover: String::new(),
            url: String::new(),
            preview: String::new(),
            seed: d.seed.clone(),
            popularity: 0.0,
            bpm: None,
            lyric_vec: None,
            score: d.score,
        };
        let user2 = user;
        tokio::spawn(async move {
            let warm = reason_for(&d2, charted).await;
            if !warm.is_empty() && warm != plain_reason(&d2, charted) {
                let _ = st.db.update_pull_reason(user2, &d2.ext_id, &warm);
            }
        });
    }
    // Named for the queue: the machine that pulled it, and who it is for.
    let via = state
        .db
        .user_by_id(user)
        .map(|u| format!("the collector · for {}", u.username))
        .unwrap_or_else(|| "the collector".to_string());
    /*
     * A box in collector mode offers the download to a PEER before doing it
     * itself.
     *
     * That is the setup this exists for: the hub decides what is worth having
     * (it holds the listening, the taste vectors and the discovery pool), and
     * another box holds the downloader and the disk. The want is recorded here
     * with no job behind it; a peer claims it, fetches it, and its finished
     * import is copied back up by peersync like any other. Nothing waits on the
     * hub being able to reach the peer, which is the direction that actually
     * fails.
     *
     * If no peer takes it, `settle_delegated` gives up waiting and this box
     * downloads it after all - so a hub with no peer still stocks itself, just
     * a few minutes later.
     */
    if crate::imports::imports_mode() == crate::imports::ImportsMode::CollectorOnly {
        return state
            .db
            .record_pull(
                user,
                &d.ext_id,
                "track",
                &d.title,
                &d.artist,
                &hit.url,
                &reason,
                d.score as f64,
                crate::db::Db::PULL_OFFERED,
            )
            .is_ok();
    }

    match crate::imports::enqueue_internal(
        state, &hit.url, &d.title, &d.artist, "collector", user, &via,
    )
    .await
    {
        Ok(job_id) => {
            let _ = state.db.record_pull(
                user,
                &d.ext_id,
                "track",
                &d.title,
                &d.artist,
                &hit.url,
                &reason,
                d.score as f64,
                &job_id,
            );
            true
        }
        Err(_) => false,
    }
}

/// Why the curator chose it: the model's one line when a chat model is
/// configured, the seed artist's plain sentence when not. Failure is the
/// plain sentence too - a missing reason should never cost a pull.
/// The reason a pull can have RIGHT NOW, with no model in the room.
fn plain_reason(d: &DiscoveryRow, charted: bool) -> String {
    if charted {
        // The honest story for a chart pick - it hangs off nobody's taste.
        "Topping the charts right now.".to_string()
    } else if d.seed.trim().is_empty() {
        String::new()
    } else {
        format!("Because you play {}.", d.seed.trim())
    }
}

async fn reason_for(d: &DiscoveryRow, charted: bool) -> String {
    let plain = plain_reason(d, charted);
    let (Some(url), Some(model)) = (crate::curator::ai_url(), crate::curator::ai_chat_model())
    else {
        return plain;
    };
    let prompt = format!(
        "One warm sentence (max 14 words, no exclamation marks) telling a listener why \
         \"{}\" by {} was downloaded for them, given {}. \
         Answer with the sentence only.",
        d.title,
        d.artist,
        if charted {
            "it is high on today's global charts".to_string()
        } else if d.seed.trim().is_empty() {
            "they play similar music".to_string()
        } else {
            format!("they play a lot of {}", d.seed.trim())
        },
    );
    let reply = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .unwrap_or_default()
        .post(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.6,
        }))
        .send()
        .await;
    let Ok(reply) = reply else { return plain };
    let Ok(body) = reply.json::<serde_json::Value>().await else { return plain };
    body.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(|s| s.trim().trim_matches('"').chars().take(140).collect::<String>())
        .filter(|s| !s.is_empty())
        .unwrap_or(plain)
}

/// The self-tuning pass: once a day per listener, read the scoreboard and move
/// the dial. Auditions older than a day that got adopted argue for reach;
/// auditions still sitting argue for caution.
fn tune_cycle(state: &Arc<AppState>) {
    // The deal ledger only needs its windows (three days for taste, a day for
    // the doors) and the adoption look-back; with three doors dealing it grew
    // a row per seat per press forever.
    state.db.prune_dj_impressions(now_ms() - 90 * 86_400_000);
    let since = now_ms() - WINDOW_30D_MS;
    for user in state.db.listeners_since(since) {
        let (_, exploration) = state.db.collector_state(user);
        if !state.db.collector_tune_due(user, now_ms() - 24 * 60 * 60 * 1000) {
            continue;
        }
        let (adopted, landed) = state.db.pull_adoption(user, now_ms() - 24 * 60 * 60 * 1000);
        if landed < TUNE_MIN_SAMPLES {
            continue;
        }
        let rate = adopted as f64 / landed as f64;
        // A third adopted holds the dial still; better pushes out, worse
        // pulls in. Small steps - taste moves slowly and so should this.
        let next = (exploration + (rate - 0.35) * 0.2).clamp(0.15, 0.85);
        let _ = state.db.set_collector_exploration(user, next);
    }
}

/// Whether two artist billings name the same act, with either allowed to carry
/// extra names ("Drake" vs "Drake, Future"). The same rule the client's
/// resolver uses, over discovery's fold.
fn same_artist(a: &str, b: &str) -> bool {
    let fa = crate::discovery::fold(a);
    let fb = crate::discovery::fold(b);
    if fa.is_empty() || fb.is_empty() {
        return false;
    }
    fa == fb
        || format!(" {fa} ").contains(&format!(" {fb} "))
        || format!(" {fb} ").contains(&format!(" {fa} "))
}

/// Same recording by name: exact after folding, or the found title extending
/// the wanted one (a deluxe edition is the record; a different record whose
/// name merely starts the same is not, but for single TRACKS the risk runs the
/// other way and prefix is how remaster suffixes read).
fn same_title(found: &str, wanted: &str) -> bool {
    let ff = crate::discovery::fold(found);
    let fw = crate::discovery::fold(wanted);
    !fw.is_empty() && (ff == fw || ff.starts_with(&format!("{fw} ")))
}

// --- endpoints ---------------------------------------------------------------

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;

use crate::auth;

/// Hands one wanted download to a peer that has asked for work.
///
/// Ordinary caller auth, exactly like `/api/library/missing` and the upload
/// routes the same peer already uses - this is one more call on a channel that
/// is already trusted, not a new door.
pub async fn claim(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    // A download box is LISTENING - whether or not there was anything to hand
    // it. This is the clock the pasted-link door reads (imports::enqueue), and
    // stamping it only on a take meant a quiet week for the collector shut
    // that door on every member while the peer was polling the whole time.
    let _ = state.db.meta_set("collector.peer_seen_at", &now_ms().to_string());
    let Some((id, url, title, artist)) = state.db.claim_offered_pull() else {
        return Ok(Json(serde_json::json!({ "pull": null })));
    };
    // `kind` says whose want this is: the collector's own pick, or a member's
    // pasted link ("import"). A peer that predates the field ignores it.
    let kind = state.db.pull_kind(id).unwrap_or_else(|| "track".to_string());
    Ok(Json(serde_json::json!({
        "pull": { "id": id, "url": url, "title": title, "artist": artist, "kind": kind }
    })))
}

/// A peer reporting that a claimed pull FAILED on its side - the provider
/// did not have it, the download stalled, anything its card would say. Only a
/// member's delegated link is failed outright (the card gets the sentence and
/// a Retry); the collector's own pulls keep their existing fate, forgotten
/// after a day, because "the peer could not fetch it today" is not the
/// thirty-day "the catalogue does not have it" that `fail_pull` means there.
pub async fn failed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FailedBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if body.pull_id <= 0 {
        return Err((StatusCode::BAD_REQUEST, "pullId is required".into()));
    }
    let Some((_user, ext_id, kind)) = state.db.pull_owner_kind(body.pull_id) else {
        return Ok(Json(serde_json::json!({ "ok": true, "known": false })));
    };
    if kind == "import" {
        if state.db.fail_taken_pull(body.pull_id).unwrap_or(false) {
            if let Some(job) = crate::imports::delegated_job_id(&ext_id) {
                // A peer's own summary is short; the route is open to any
                // signed-in caller like the rest of the channel, so the card
                // takes a sentence, never a page.
                let why: String = body.error.trim().chars().take(600).collect();
                let why = if why.is_empty() {
                    "The download box could not fetch it.".to_string()
                } else {
                    why
                };
                crate::imports::fail_delegated(&state, job, &why).await;
            }
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedBody {
    pub pull_id: i64,
    #[serde(default)]
    pub error: String,
}

/// A peer reporting what a claimed pull actually produced, as the rel_path the
/// hub itself replied with when the upload finished. This is what a delegated
/// pull settles on - see `settle_delegated` for why it is not a name match.
pub async fn claimed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ClaimedBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let path = body.path.trim();
    if body.pull_id <= 0 || path.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "pullId and path are required".into()));
    }
    state
        .db
        .record_pull_path(body.pull_id, path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedBody {
    pub pull_id: i64,
    /// Empty when the peer could not start the download at all: the pull goes
    /// back on the offer queue rather than sitting claimed by nobody until it
    /// ages out.
    #[serde(default)]
    pub path: String,
}

/// A peer handing a claim back, having failed to start it.
pub async fn release(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ClaimedBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    // A member's link handed back by a peer that predates the failure report
    // is failed here rather than re-offered: the same box would take it and
    // hand it back again every minute, and the card would say "queued" for a
    // day. An updated peer says why through /api/collector/failed instead.
    if let Some((_user, ext_id, kind)) = state.db.pull_owner_kind(body.pull_id) {
        if kind == "import" {
            if state.db.fail_taken_pull(body.pull_id).unwrap_or(false) {
                if let Some(job) = crate::imports::delegated_job_id(&ext_id) {
                    crate::imports::fail_delegated(
                        &state,
                        job,
                        "The download box could not take it - it may be out of room. Retry later.",
                    )
                    .await;
                }
            }
            return Ok(Json(serde_json::json!({ "ok": true })));
        }
    }
    state
        .db
        .release_claimed_pull(body.pull_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `GET /api/curator/pulls` - the collector accounting for itself: the dials,
/// the ledger against the cap, and what it bought lately. `userId` is how the
/// client matches quarantined tracks to "mine".
/// What a finished Date is worth: the verdicts, so the next batch is shaped by
/// them rather than by the same background guess that produced this one.
#[derive(serde::Deserialize)]
pub struct DateDone {
    /// Auditions kept - the strongest signal there is, since the listener just
    /// said yes to them one at a time.
    #[serde(default)]
    pub kept: Vec<i64>,
    /// Auditions passed on. Not punishment - their artists are simply left out
    /// of the seeds, so the next batch reaches somewhere else.
    #[serde(default)]
    pub passed: Vec<i64>,
}


/// Record what a listener decided, and reclaim the disk a pass frees.
///
/// Shared by `/api/date/verdict` (one swipe, as it happens) and
/// `/api/date/done` (the whole sitting, plus a harvest). The split matters:
/// verdicts used to reach the server ONLY when a deck ran completely dry, so a
/// listener who swiped through six cards and closed the app had told the
/// server nothing at all, and the same six came back on the next device.
///
/// A pass is the one verdict that can free space, because an unadopted
/// audition exists for exactly one listener and for exactly this purpose.
/// `discard_audition` refuses anything else - see its ownership test - so the
/// unlink here cannot reach a track that is genuinely part of a library.
fn apply_verdicts(state: &Arc<AppState>, user: i64, body: &DateDone) -> (usize, u64) {
    for id in &body.kept {
        state.db.record_date_verdict(user, *id, "kept");
    }
    let mut freed: u64 = 0;
    let mut discarded = 0usize;
    for id in &body.passed {
        state.db.record_date_verdict(user, *id, "passed");
        let Some(rel) = state.db.discard_audition(user, *id) else { continue };
        discarded += 1;
        // resolve_in_root, not a bare join: the path comes out of the database
        // and this is an unlink. Anything climbing out of the music root is
        // refused rather than followed.
        if let Some(abs) = crate::stream::resolve_in_root(&state.music_root, &rel) {
            freed += std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            if let Err(e) = std::fs::remove_file(&abs) {
                eprintln!("[collector] could not remove passed audition {rel}: {e}");
            }
        }
    }
    if discarded > 0 {
        println!(
            "[collector] {discarded} audition(s) passed on and removed, {:.1} MB reclaimed",
            freed as f64 / 1_048_576.0
        );
    }
    (discarded, freed)
}

/// `POST /api/date/verdict` - one swipe, recorded now rather than at the end.
pub async fn date_verdict(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<DateDone>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let (discarded, freed) = apply_verdicts(&state, caller.id, &body);
    Ok(Json(serde_json::json!({ "discarded": discarded, "freedBytes": freed })))
}

/// `POST /api/date/done` - the deck ran out; go and get more, now.
///
/// The page has always ended on "the DJ fetches more as it learns what you
/// keep", and nothing made that true: the collector runs on its own clock and
/// harvests from a six-hourly sweep, so reaching the end of a Date and reaching
/// for the app an hour later looked identical. This is the promise, kept.
///
/// The seeds are the verdicts, in order of how much they say: the artists
/// behind what was just kept first, then the artists behind everything ever
/// liked, minus anyone just passed on. It answers immediately - a harvest walks
/// a catalogue over tens of seconds and nobody should hold a request open for
/// it - and the work runs behind.
/// `GET /api/date/briefing?ids=1,2,3` - the DJ's word on the next few date
/// cards: one short spoken line per song, its title and the collector's own
/// reason for choosing it. Text is assembled from facts already on file (the
/// pull's reason line - the model wrote it at buy time when a model exists),
/// so this costs no model call; the voice rides the same cached-clip
/// machinery as the DJ's set beats, minted behind the reply.
/// `GET /api/date/candidates?count=` - preview dates: the caller's best
/// measured, unpulled candidates, each carrying its thirty-second preview.
/// This is what unchains Music Date from the download queue: the pool holds
/// hundreds of measured songs while the peer that fetches full files may be
/// asleep for hours - so the deck deals the PREVIEWS, a pass costs nothing,
/// and only a keep spends the peer's bandwidth.
pub async fn date_candidates(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller =
        crate::auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let want = q
        .get("count")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(25)
        .clamp(1, 40);
    // Two optional decks, chosen from the app: "new" deals only the fresh shelf
    // (editorial just-released), "tiny" deals only the obscure - the small acts,
    // most-unknown first. Anything else is the ordinary seated mix.
    let mode = q.get("mode").map(String::as_str).unwrap_or("");
    let fresh_only = mode == "new";
    let tiny = mode == "tiny";
    let pulled = state.db.pulled_ext_ids(caller.id, now_ms() - FAILED_RETRY_AFTER_MS);
    // Judged by song, not by id: a candidate the catalogue re-offered under a
    // new id, or one that slipped into the pool before its verdict was kept
    // by song, is still a song this listener has already answered.
    let judged = state.db.candidate_judged_keys(caller.id);
    let all: Vec<crate::db::DiscoveryRow> = state
        .db
        .top_discoveries(caller.id, 400)
        .into_iter()
        .filter(|d| {
            !d.preview.trim().is_empty()
                && !pulled.contains(&d.ext_id)
                // A tiny act rarely has lyrics or a tempo read, and the deck
                // would starve if it demanded one: the thirty-second preview is
                // all a date needs, so the analysis gate is dropped for that
                // deck only.
                && (tiny || measured(d))
                && !judged.contains(&crate::discovery::key_of(&d.artist, &d.title))
        })
        .collect();
    let mut total = all.len();
    let lanes = state.db.discovery_lanes(caller.id);
    let lane_of = |d: &crate::db::DiscoveryRow| {
        lanes.get(&d.ext_id).map(|(lane, _)| lane.as_str()).unwrap_or("taste").to_string()
    };
    let card_of = |d: &crate::db::DiscoveryRow| {
        json!({
            "extId": d.ext_id, "title": d.title, "artist": d.artist,
            "cover": d.cover, "preview": d.preview, "seed": d.seed,
            "lane": lane_of(d),
        })
    };
    let mut cards: Vec<serde_json::Value> = Vec::new();
    if fresh_only || tiny {
        // A single ordered bench, no five-card seating. New = the fresh shelf,
        // most-charting first. Tiny = the taste pool (charts/fresh excluded,
        // they are popular by construction), most-obscure first; no popularity
        // floor, so it always yields the smallest acts on hand rather than an
        // empty deck.
        let mut bench: Vec<&crate::db::DiscoveryRow> = all
            .iter()
            .filter(|d| {
                let lane = lane_of(d);
                if fresh_only {
                    lane == "fresh"
                } else {
                    lane != "trending" && lane != "fresh"
                }
            })
            .collect();
        bench.sort_by(|a, b| {
            if tiny {
                a.popularity.partial_cmp(&b.popularity).unwrap_or(std::cmp::Ordering::Equal)
            } else {
                b.popularity.partial_cmp(&a.popularity).unwrap_or(std::cmp::Ordering::Equal)
            }
        });
        // "N left to meet" should count this deck, not the whole pool.
        total = bench.len();
        for d in bench.into_iter().take(want) {
            cards.push(card_of(d));
        }
    } else {
        /*
         * SEATED, not just ranked: a pure taste ordering sinks exactly the music
         * a date deck exists to introduce - the chart hit far from your taste,
         * the release that came out on Friday. The deal runs a five-card
         * pattern: three from taste, one from the chart (by chart position),
         * one from the fresh shelf (editorial order), each seat falling back to
         * the next bench when its own is empty - the same reasoning as the
         * collector's own chart seat.
         */
        let mut by_pop = |name: &str| -> std::collections::VecDeque<&crate::db::DiscoveryRow> {
            let mut rows: Vec<&crate::db::DiscoveryRow> =
                all.iter().filter(|d| lane_of(d) == name).collect();
            rows.sort_by(|a, b| {
                b.popularity.partial_cmp(&a.popularity).unwrap_or(std::cmp::Ordering::Equal)
            });
            rows.into_iter().collect()
        };
        let mut chart = by_pop("trending");
        let mut fresh = by_pop("fresh");
        let mut taste: std::collections::VecDeque<&crate::db::DiscoveryRow> =
            all.iter().filter(|d| lane_of(d) == "taste").collect();
        let mut used: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut seat = 0usize;
        while cards.len() < want {
            let benches: [&mut std::collections::VecDeque<&crate::db::DiscoveryRow>; 3] =
                match seat % 5 {
                    2 => [&mut chart, &mut fresh, &mut taste],
                    4 => [&mut fresh, &mut chart, &mut taste],
                    _ => [&mut taste, &mut chart, &mut fresh],
                };
            let mut pick: Option<&crate::db::DiscoveryRow> = None;
            for bench in benches {
                while let Some(d) = bench.pop_front() {
                    if used.insert(&d.ext_id) {
                        pick = Some(d);
                        break;
                    }
                }
                if pick.is_some() {
                    break;
                }
            }
            let Some(d) = pick else { break };
            cards.push(card_of(d));
            seat += 1;
        }
    }
    // The dealt hand's bands get their shelf entries written behind this
    // reply, so the briefing that follows has something true to say.
    {
        let names: Vec<String> = cards
            .iter()
            .filter_map(|c| c.get("artist").and_then(|a| a.as_str()).map(str::to_string))
            .collect();
        let st = state.clone();
        tokio::spawn(async move {
            crate::lore::ensure_artists(&st, &names).await;
        });
    }
    Ok(Json(json!({ "candidates": cards, "total": total })))
}

/// Deezer's fan count for an artist - the honest "how big are they" number.
async fn deezer_fans(c: &reqwest::Client, id: u64) -> Option<u64> {
    let v: serde_json::Value = c
        .get(format!("https://api.deezer.com/artist/{id}"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v.get("nb_fan").and_then(|x| x.as_u64())
}

/// A short discography: the artist's albums, newest first, one line each with
/// its year, deduped by title. Facts straight from Deezer - true even for an
/// act no model has ever heard of, which is the whole point of not leaving the
/// profile to the model's memory.
async fn deezer_discography(c: &reqwest::Client, id: u64) -> Vec<String> {
    let Ok(resp) = c
        .get(format!("https://api.deezer.com/artist/{id}/albums"))
        .query(&[("limit", "50")])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(v) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    let Some(items) = v.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut rows: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
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

/// `GET /api/date/artist?name=` - who the current card's artist is, for the
/// date's profile panel. The prose is the honest one-line lore we already keep
/// (who they are, where they are from), absent for an artist the model does not
/// recognise and filled behind this reply for next time; the discography and
/// fan count are pulled LIVE from Deezer, so even an unknown small act gets a
/// true short profile instead of an invented one.
pub async fn date_artist(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    crate::auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let name = q.get("name").map(|s| s.trim().to_string()).unwrap_or_default();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name is required".into()));
    }

    let blurb = crate::lore::known_artists(&state, std::slice::from_ref(&name))
        .get(&crate::discovery::artist_key_public(&name))
        .cloned()
        .unwrap_or_default();

    let c = crate::discovery::client(12);
    let (fans, discography) = match crate::discovery::deezer_artist_id_public(&c, &name).await {
        Some(id) => tokio::join!(deezer_fans(&c, id), deezer_discography(&c, id)),
        None => (None, Vec::new()),
    };

    // No prose yet: research this artist behind the reply so a later visit has
    // it, exactly as the deal itself does for the dealt hand.
    if blurb.is_empty() {
        let st = state.clone();
        let n = name.clone();
        tokio::spawn(async move {
            crate::lore::ensure_artists(&st, &[n]).await;
        });
    }

    Ok(Json(json!({ "blurb": blurb, "discography": discography, "fans": fans })))
}

/// `GET /api/date/preview?extId=` - a FRESH preview URL, resolved live.
/// Deezer's preview links carry expiring signatures, and the pool's stored
/// copies are up to weeks old - dealing one to the deck froze the card on a
/// dead source. The card asks here as it warms, and the store is refreshed
/// on the way through so the next deal starts fresher.
pub async fn date_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller =
        crate::auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let ext = q.get("extId").map(String::as_str).unwrap_or("");
    let Some(id) = ext.strip_prefix("deezer:track:").and_then(|v| v.parse::<u64>().ok()) else {
        return Err((StatusCode::BAD_REQUEST, "not a catalogue track".into()));
    };
    let fresh = match crate::discovery::client(12)
        .get(format!("https://api.deezer.com/track/{id}"))
        .send()
        .await
    {
        Ok(resp) => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("preview").and_then(|p| p.as_str()).map(str::to_string))
            .filter(|p| !p.trim().is_empty()),
        Err(_) => None,
    };
    match fresh {
        Some(preview) => {
            state.db.update_discovery_preview(caller.id, ext, &preview);
            Ok(Json(json!({ "preview": preview })))
        }
        None => Err((StatusCode::NOT_FOUND, "the catalogue has no clip for this one".into())),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateVerdictBody {
    pub ext_id: String,
    pub kept: bool,
}

/// `POST /api/date/candidate-verdict` - the swipe on a preview date. A pass
/// forgets the candidate (the pool's own dismiss semantics - the harvest may
/// one day argue its case again). A keep buys it through the same door the
/// collector uses AND writes a pending like, so the landing sweep both
/// favourites and adopts it - a kept date has always meant a heart.
pub async fn date_candidate_verdict(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CandidateVerdictBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller =
        crate::auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some(d) = state.db.discovery_get(caller.id, &body.ext_id) else {
        // Judged elsewhere, or swept between deal and swipe: the swipe stands.
        return Ok(Json(json!({ "ok": true, "gone": true })));
    };
    // Remembered by SONG before anything else happens, so a pass that deletes
    // the row and a keep whose pull later fails both stay judged: the next
    // harvest finds the same song under whatever id and leaves it alone.
    state.db.record_candidate_verdict(
        caller.id,
        &crate::discovery::key_of(&d.artist, &d.title),
        if body.kept { "kept" } else { "passed" },
    );
    if body.kept {
        let charted = state
            .db
            .discovery_lanes(caller.id)
            .get(&d.ext_id)
            .is_some_and(|(lane, _)| lane == "trending");
        let bought = buy(&state, caller.id, &d, charted).await;
        let k = crate::discovery::key_of(&d.artist, &d.title);
        let _ = state.db.pending_like_put(caller.id, &k, &d.title, &d.artist);
        return Ok(Json(json!({ "ok": true, "queued": bought })));
    }
    state.db.forget_discovery(caller.id, &body.ext_id);
    Ok(Json(json!({ "ok": true })))
}

pub async fn date_briefing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller =
        crate::auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let ids: Vec<i64> = q
        .get("ids")
        .map(String::as_str)
        .unwrap_or("")
        .split(',')
        .filter_map(|v| v.trim().parse::<i64>().ok())
        .take(3)
        .collect();
    let ext_ids: Vec<String> = q
        .get("extIds")
        .map(String::as_str)
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .take(3)
        .collect();

    // What the cards are, in the deck's own order: landed auditions first,
    // preview candidates after - (title, artist, the tailored why).
    let mut cards: Vec<(String, String, String)> = Vec::new();
    for id in ids {
        if !state.db.audition_of(id, caller.id) {
            continue;
        }
        let Some(t) = state.db.track(id) else { continue };
        let why = state.db.pull_reason_for_track(caller.id, id).unwrap_or_default();
        cards.push((t.title, t.artist, why));
    }
    let lanes = state.db.discovery_lanes(caller.id);
    for ext in &ext_ids {
        let Some(d) = state.db.discovery_get(caller.id, ext) else { continue };
        let why = match lanes.get(&d.ext_id).map(|(lane, _)| lane.as_str()) {
            Some("trending") => "It's on the charts right now.".to_string(),
            Some("fresh") => "It's a brand-new release.".to_string(),
            _ if !d.seed.trim().is_empty() => format!("It came up because you play {}.", d.seed),
            _ => String::new(),
        };
        cards.push((d.title, d.artist, why));
    }
    cards.truncate(3);

    /*
     * "Tell me about the BAND, not just why it's here": the artist shelf
     * leads when it knows the act - who they are, where from, what they're
     * known for - and the tailored why becomes the garnish. The shelf fills
     * behind this very request, so a band unknown at first ask is usually
     * spoken for by the next visit.
     */
    let artists: Vec<String> = cards.iter().map(|(_, a, _)| a.clone()).collect();
    let band = crate::lore::known_artists(&state, &artists);
    {
        let st = state.clone();
        let names = artists.clone();
        tokio::spawn(async move {
            crate::lore::ensure_artists(&st, &names).await;
        });
    }

    let mut songs: Vec<serde_json::Value> = Vec::new();
    let mut jobs: Vec<crate::voice::Beat> = Vec::new();
    for (seat, (title, artist, why)) in cards.into_iter().enumerate() {
        let opener = match seat {
            0 => "First up on your date:",
            1 => "Then,",
            _ => "And after that,",
        };
        let mut say = format!("{opener} {title} by {artist}.");
        if let Some(about) = band.get(&crate::discovery::artist_key_public(&artist)) {
            say.push(' ');
            say.push_str(about);
            if !about.ends_with(['.', '!', '?']) {
                say.push('.');
            }
        }
        if !why.is_empty() && say.chars().count() + why.chars().count() < 260 {
            let mut why: String = why.chars().take(180).collect();
            if !why.ends_with(['.', '!', '?']) {
                why.push('.');
            }
            say.push(' ');
            say.push_str(&why);
        }
        let mut voice: Vec<String> = Vec::new();
        if crate::voice::enabled() {
            let beat = crate::voice::beat(&say);
            voice.push(beat.id.clone());
            jobs.push(beat);
        }
        songs.push(serde_json::json!({ "say": say, "voice": voice }));
    }
    if !jobs.is_empty() {
        crate::voice::mint_behind(&state, jobs);
    }
    Ok(Json(serde_json::json!({ "songs": songs })))
}

pub async fn date_done(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<DateDone>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    /*
     * THE VERDICTS ARE WRITTEN DOWN NOW, and a pass reclaims its disk.
     *
     * Both halves used to be dropped on the floor. `kept` and `passed` were
     * read to build seeds and then forgotten, so the only memory of a pass was
     * one browser's localStorage: a second device re-dealt every card that had
     * already been turned down, and the file it had fetched sat there forever.
     * On the hub this was written against that was 766 unadopted auditions
     * holding 19.1GB, none of which anything was ever going to clear.
     *
     * A pass is the one verdict that can free space, because an unadopted
     * audition exists for exactly one listener and for exactly this purpose.
     * `discard_audition` refuses to touch anything else - see its ownership
     * test - so the unlink below cannot reach a track that is genuinely part
     * of somebody's library.
     */
    apply_verdicts(&state, caller.id, &body);

    // Just-passed artists are excluded rather than down-weighted: a pass is a
    // small, cheap "not this", and the honest reading of it is "look elsewhere"
    // rather than a permanent mark against an artist the listener may love.
    let avoid: std::collections::HashSet<String> = state
        .db
        .artists_for(&body.passed)
        .into_iter()
        .map(|(name, _)| crate::discovery::fold(&name))
        .collect();

    let mut seeds: Vec<(String, i64)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let liked = state.db.favorites(caller.id);
    for (name, n) in state.db.artists_for(&body.kept).into_iter().chain(state.db.artists_for(&liked)) {
        let key = crate::discovery::fold(&name);
        if key.is_empty() || avoid.contains(&key) || !seen.insert(key) {
            continue;
        }
        seeds.push((name, n));
        if seeds.len() >= 8 {
            break;
        }
    }

    let seeded = seeds.len();
    if seeded > 0 {
        let bg = Arc::clone(&state);
        let user = caller.id;
        tokio::spawn(async move {
            crate::discovery::harvest_seeded(&bg, user, seeds).await;
            // Then buy one straight away rather than waiting out the cycle: the
            // listener is standing in front of an empty deck.
            pull_cycle(&bg).await;
        });
    }
    Ok(Json(serde_json::json!({ "seeded": seeded })))
}

pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let (enabled, exploration) = state.db.collector_state(caller.id);
    let ledger = state.db.collector_ledger_bytes();
    let cap = cap_bytes(&state);
    let recent: Vec<serde_json::Value> = state
        .db
        .recent_pulls(caller.id, 20)
        .into_iter()
        // A member's delegated link is their download card, not a collector
        // find: it already shows on the Downloads page and in the incoming
        // band, and here it would read as a pick nobody made.
        .filter(|row| row.2 != "import")
        .map(|(title, artist, kind, pull_state, at, reason, job)| {
            json!({
                "title": title,
                "artist": artist,
                "kind": kind,
                /*
                 * The client's vocabulary, and WHERE the download is, which
                 * used to be the same word for three different situations.
                 *
                 * Since the collector can hand its downloading to another box,
                 * a "queued" pull is one of three things: nobody has taken it,
                 * a peer is fetching it, or this box is. They fail in different
                 * places and want different words, and collapsing them is why
                 * there was no way to see whether any of this was working.
                 */
                "state": match pull_state.as_str() {
                    "queued" if job == crate::db::Db::PULL_OFFERED => "offered",
                    "queued" if job == crate::db::Db::PULL_TAKEN => "fetching",
                    "queued" => "queued",
                    "promoted" => "promoted",
                    "failed" => "failed",
                    _ => "landed",
                },
                "at": at,
                "reason": reason,
            })
        })
        .collect();
    Ok(Json(json!({
        "userId": caller.id,
        "enabled": enabled,
        "halted": if ledger >= cap { serde_json::Value::from("cap") } else { serde_json::Value::Null },
        "ledgerBytes": ledger,
        "capBytes": cap,
        "exploration": exploration,
        "importable": crate::search::spotiflac_python().is_some(),
        // Where the downloading happens, and whether the box doing it is
        // actually showing up. Null rather than 0 for "no peer has ever taken
        // one", which is a different thing from "a peer took one long ago".
        "delegates": crate::imports::imports_mode() == crate::imports::ImportsMode::CollectorOnly,
        "downloadsHere": crate::imports::find_spotiflac().is_some()
            && crate::imports::imports_mode() != crate::imports::ImportsMode::CollectorOnly,
        "peerSeenAt": state
            .db
            .meta_get("collector.peer_seen_at")
            .and_then(|v| v.parse::<i64>().ok())
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "landedToday": state.db.pulls_landed_since(caller.id, crate::db::now_ms() - 86_400_000),
        "recent": recent,
    })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBody {
    pub enabled: Option<bool>,
    pub cap_bytes: Option<i64>,
}

/// `POST /api/curator/pulls/settings` - the enabled switch is anyone's own;
/// the budget is the operator's, because it is the operator's disk.
pub async fn settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SettingsBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if let Some(on) = body.enabled {
        state
            .db
            .set_collector_enabled(caller.id, on)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    if let Some(cap) = body.cap_bytes {
        if !caller.is_admin {
            return Err((StatusCode::FORBIDDEN, "only an admin can resize the budget".into()));
        }
        if cap < 1_000_000_000 {
            return Err((StatusCode::BAD_REQUEST, "the budget needs at least a gigabyte".into()));
        }
        state
            .db
            .meta_set("collector.cap_bytes", &cap.to_string())
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod delegation_tests {
    use super::*;

    /// A database of its own per test. Sharing one path across tests in the
    /// same process is two connections to one file and cargo runs them at the
    /// same time: the second gets "database is locked", not a real failure.
    fn db(name: &str) -> crate::db::Db {
        let dir = std::env::temp_dir().join(format!("afm-delegate-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::Db::open(&dir.join("t.sqlite")).unwrap()
    }

    fn offer(db: &crate::db::Db, ext: &str, title: &str, artist: &str) -> i64 {
        db.record_pull(
            db.first_admin_id().unwrap(),
            ext,
            "track",
            title,
            artist,
            "https://open.spotify.com/track/x",
            "",
            0.9,
            crate::db::Db::PULL_OFFERED,
        )
        .unwrap()
    }

    /// A member's pasted link rides the offer channel as its own KIND of pull,
    /// and settles as a finished import rather than an audition: no stamp,
    /// no size against the collector's budget, and a failure only while a peer
    /// actually holds it.
    #[test]
    fn a_members_link_is_its_own_kind_of_pull() {
        let db = db("import-pull");
        let _owner = db.create_user("collector-test", "x", true).unwrap();
        let member = db.create_user("member", "x", false).unwrap();
        // The collector's own pick was offered FIRST...
        let pick = offer(&db, "deezer:track:1", "Some Pick", "Some Artist");
        let link = "https://open.spotify.com/track/y";
        let id = db
            .record_pull(member, "import:job1", "import", "Spotify track", "", link, "", 0.0, crate::db::Db::PULL_OFFERED)
            .unwrap();
        // The settle pass tells a member's link from the collector's pick by
        // what the offered row carries.
        let rows = db.delegated_pulls();
        let row = rows.iter().find(|r| r.0 == id).expect("offered");
        assert_eq!((row.7.as_str(), row.8.as_str()), ("import:job1", "import"));
        assert_eq!(db.pull_kind(id).as_deref(), Some("import"));
        assert_eq!(db.pull_owner_kind(id), Some((member, "import:job1".to_string(), "import".to_string())));
        // Nobody holds it yet: a failure report against a bare offer is noise.
        assert!(!db.fail_taken_pull(id).unwrap(), "an offer nobody took cannot fail");
        // ...and the person's link still goes first.
        let (claimed, ..) = db.claim_offered_pull().expect("claimable");
        assert_eq!(claimed, id, "a member's link is claimed before the collector's picks");
        // An offer nobody took can be withdrawn; a taken one cannot.
        assert!(!db.forget_offered_pull(id).unwrap(), "taken: not withdrawable");
        assert!(db.forget_offered_pull(pick).unwrap(), "offered: withdrawn");
        // A path reported against a taken import pull counts, and starts the
        // quiet clock the settle pass reads.
        assert_eq!(db.pull_last_path_at(id), 0);
        db.record_pull_path(id, "Some/Where.flac").unwrap();
        assert!(db.pull_last_path_at(id) > 0, "the clock started");
        assert!(db.fail_taken_pull(id).unwrap(), "the peer that holds it can fail it");
        assert!(!db.fail_taken_pull(id).unwrap(), "but only once");
        // Retry re-arms the SAME row - the card's key is the pull's key.
        let again = db
            .record_pull(member, "import:job1", "import", "Spotify track", "", link, "", 0.0, crate::db::Db::PULL_OFFERED)
            .unwrap();
        assert_eq!(again, id);
        assert_eq!(db.claim_offered_pull().map(|r| r.0), Some(id));
        db.land_import_pull(id).unwrap();
        assert!(db.delegated_pulls().iter().all(|r| r.0 != id), "landed rows are settled");
        assert!(!db.fail_taken_pull(id).unwrap(), "a landed pull cannot fail");
        assert_eq!(db.collector_ledger_bytes(), 0, "a member's import is not the collector's spend");
    }

    /// An offer goes to exactly ONE peer. Two boxes asking in the same second
    /// both downloading the same song is the whole reason claiming marks the
    /// row rather than just reading it.
    #[test]
    fn an_offer_is_taken_once() {
        let db = db("claim");
        let me = db.create_user("collector-test", "x", true).unwrap();
        assert_eq!(db.first_admin_id(), Some(me), "the peer files downloads under the owner");
        offer(&db, "a", "Blue in Green", "Miles Davis");
        offer(&db, "b", "So What", "Miles Davis");

        let first = db.claim_offered_pull().expect("one offer");
        let second = db.claim_offered_pull().expect("the other offer");
        assert_ne!(first.0, second.0, "the same pull was handed out twice");
        assert!(db.claim_offered_pull().is_none(), "nothing is left to take");

        // Taken, but still open: they are settled by the tracks arriving.
        assert_eq!(db.delegated_pulls().len(), 2);
        assert!(
            db.open_pulls().is_empty(),
            "a delegated pull has no local job for the settle loop to find",
        );
    }

    /// A delegated pull lands on the file the peer NAMED, and a pull that
    /// gained nothing stays open instead of closing over an empty hand.
    ///
    /// The second half is the one that bit: land_pull used to mark a pull
    /// 'landed' whatever it stamped, and pulled_ext_ids blocks every state but
    /// 'failed' - so a pull that stamped nothing silently retired its candidate
    /// for good, with no track and no card to show for it.
    #[test]
    fn a_delegated_pull_lands_on_the_file_it_was_told_about() {
        let db = db("land");
        let me = db.create_user("collector-test", "x", true).unwrap();
        let first = offer(&db, "a", "Blue in Green", "Miles Davis");
        let second = offer(&db, "b", "Blue in Green", "Miles Davis");
        // A report only counts against a pull a peer actually took.
        db.claim_offered_pull().expect("first");
        db.claim_offered_pull().expect("second");

        let mut track = crate::db::ScannedTrack::default();
        track.rel_path = "Miles Davis/Kind of Blue/03 Blue in Green.flac".to_string();
        track.title = "Blue in Green".to_string();
        track.artist = "Miles Davis".to_string();
        db.upsert_track(&track, 1).unwrap();

        // Nothing is owed until a peer says what it delivered.
        assert!(db.pull_path_track_ids(first).is_empty(), "no report, no tracks");

        db.record_pull_path(first, &track.rel_path).unwrap();
        let ids = db.pull_path_track_ids(first);
        assert_eq!(ids.len(), 1, "the reported path resolves to its track");
        assert_eq!(db.land_pull(first, me, &ids).unwrap(), 1, "it takes the stamp");

        /*
         * The same file reported against a second pull - two listeners offered
         * the same recording, one copy delivered. It is already an audition, so
         * nothing takes the stamp, and the pull must stay open rather than
         * retire its candidate having gained nothing.
         */
        db.record_pull_path(second, &track.rel_path).unwrap();
        let ids = db.pull_path_track_ids(second);
        assert_eq!(ids.len(), 1, "the path still resolves");
        assert_eq!(db.land_pull(second, me, &ids).unwrap(), 0, "somebody already has it");
        assert!(
            db.delegated_pulls().iter().any(|r| r.0 == second),
            "a pull that gained nothing is still open",
        );
        assert!(
            !db.delegated_pulls().iter().any(|r| r.0 == first),
            "the one that landed is settled",
        );
    }

    /// A claim the peer could not start goes back on the offer queue rather
    /// than sitting taken by nobody until it ages out.
    #[test]
    fn an_unstartable_claim_is_handed_back() {
        let db = db("release");
        db.create_user("collector-test", "x", true).unwrap();
        let pull = offer(&db, "a", "So What", "Miles Davis");

        db.claim_offered_pull().expect("claimable");
        assert!(db.claim_offered_pull().is_none(), "taken, so not on offer");

        db.release_claimed_pull(pull).unwrap();
        assert_eq!(
            db.claim_offered_pull().map(|c| c.0),
            Some(pull),
            "handed back, so the next peer can take it",
        );

        /*
         * And a want nobody ever came for is FORGOTTEN, not failed. fail_pull
         * would leave a 'failed' row, which pulled_ext_ids honours for thirty
         * days - condemning a perfectly good song because a home server was off
         * for the night. Dropping the row is what puts it back in the pool.
         */
        db.forget_pull(pull).unwrap();
        assert!(db.delegated_pulls().is_empty(), "the row is gone");
        assert!(
            !db.pulled_ext_ids(db.first_admin_id().unwrap(), 0).contains("a"),
            "and nothing is left blocking the candidate",
        );
    }
}
