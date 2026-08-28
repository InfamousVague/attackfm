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
/// Candidates considered per listener per cycle.
const CANDIDATES: i64 = 24;
/// How long a pull may sit queued before its job is presumed dead.
const STALE_PULL_MS: i64 = 24 * 60 * 60 * 1000;
/// How much adoption history a tuning step needs before it moves the dial.
const TUNE_MIN_SAMPLES: i64 = 5;

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
const OUTSTANDING_OFFERS: usize = 20;
/// How many wants one cycle may raise when this box is only offering them.
/// Bounded so a first run against a deep pool does not put the whole cap up in
/// one go and leave the peer nothing to pace itself against.
const OFFERS_PER_CYCLE: usize = 5;

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
    for (pull_id, user_id, _marker, _url, _title, _artist, created_at) in state.db.delegated_pulls()
    {
        let ids = state.db.pull_path_track_ids(pull_id);
        if !ids.is_empty() && state.db.land_pull(pull_id, user_id, &ids).unwrap_or(0) > 0 {
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
    // no one.
    if state.db.delegated_pulls().len() >= OUTSTANDING_OFFERS {
        return;
    }
    // People first: a human's import in flight means the queue is not ours.
    {
        let jobs = state.imports.jobs.lock().await;
        let busy = jobs.iter().any(|j| {
            (j.state == "queued" || j.state == "downloading")
                && (j.origin != "collector" || j.state == "downloading")
        });
        if busy {
            return;
        }
    }

    let since = now_ms() - WINDOW_30D_MS;
    let mut raised = 0usize;
    for user in state.db.listeners_since(since) {
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
        let pick = state
            .db
            .top_discoveries(user, CANDIDATES)
            .into_iter()
            .filter(|d| !pulled.contains(&d.ext_id) && !d.url.trim().is_empty())
            .find(|d| d.score as f64 >= bar && measured(d));
        let Some(candidate) = pick else { continue };

        if buy(state, user, &candidate).await {
            /*
             * One at a time across all listeners - unless this box is only
             * OFFERING, in which case one per listener.
             *
             * The rotation exists because a buy occupies the download queue,
             * and one listener should not hold it while everyone else waits.
             * When the downloading happens on a peer that rule is measuring
             * something this box no longer does: an offer costs a row, the
             * peer takes them one at a time at its own pace, and the twenty
             * outstanding cap is the real backstop. Rotating per listener
             * keeps the fairness and drops the throttle - with five listeners
             * that is five wants a cycle instead of one.
             */
            if crate::imports::imports_mode() != crate::imports::ImportsMode::CollectorOnly {
                return;
            }
            raised += 1;
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
async fn buy(state: &Arc<AppState>, user: i64, d: &DiscoveryRow) -> bool {
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

    let reason = reason_for(d).await;
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
async fn reason_for(d: &DiscoveryRow) -> String {
    let plain = if d.seed.trim().is_empty() {
        String::new()
    } else {
        format!("Because you play {}.", d.seed.trim())
    };
    let (Some(url), Some(model)) = (crate::curator::ai_url(), crate::curator::ai_chat_model())
    else {
        return plain;
    };
    let prompt = format!(
        "One warm sentence (max 14 words, no exclamation marks) telling a listener why \
         \"{}\" by {} was downloaded for them, given they play a lot of {}. \
         Answer with the sentence only.",
        d.title,
        d.artist,
        if d.seed.trim().is_empty() { "similar music" } else { d.seed.trim() },
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
    let Some((id, url, title, artist)) = state.db.claim_offered_pull() else {
        return Ok(Json(serde_json::json!({ "pull": null })));
    };
    Ok(Json(serde_json::json!({
        "pull": { "id": id, "url": url, "title": title, "artist": artist }
    })))
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
