//! Copying finished imports up to the hub.
//!
//! The setup this exists for: the downloader (SpotiFLAC and its stack) is
//! installed on one box, and the library everybody actually plays from lives on
//! another. Without this, a link imported on the peer landed on the peer's disk
//! and nowhere else - the hub, the fast box, the one the phone is signed into,
//! never heard about it.
//!
//! So a peer keeps an OUTBOX. Every file an import files locally is written to
//! `peer_sync_queue`, and one worker drains it by acting as an ordinary
//! authenticated client of the hub's existing endpoints: `/api/library/missing`
//! to ask what the hub is short of, then `/api/upload/*` to push it. Nothing
//! new goes on the wire, and the hub needs no idea that a peer exists.
//!
//! Roles come from configuration, not from a build: a box with
//! `AFM_PEER_SYNC_URL` and `AFM_PEER_SYNC_TOKEN` set is a peer, and a box
//! without them is a hub and starts no worker at all.
//!
//! Deliberately NOT here: any backfill of a library that already exists. Only
//! `on_job_finished` ever enqueues. Whole-library copying is mirror.rs, where
//! the destination PULLS - which is also what stops two peers pointed at each
//! other passing the same files back and forth forever.

use crate::auth;
use crate::db::{NewActivity, PeerSyncRow};
use crate::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

/// Boot belongs to the scanner: a peer that just came up is walking its music
/// folder, and a parallel upload only makes that slower.
const BOOT_DELAY: Duration = Duration::from_secs(20);
/// Between waves while there is work.
const BUSY: Duration = Duration::from_secs(2);
/// Between waves when the outbox is empty. A poke jumps this.
const IDLE: Duration = Duration::from_secs(60);
/// How long a stalled queue waits before trying the hub again. Fixing a token
/// or freeing disk on the hub must heal this without restarting the peer.
const STALL_RECHECK: Duration = Duration::from_secs(300);
/// Rows per wave - one `/api/library/missing` call covers the lot.
const BATCH: usize = 32;
/// 1 MiB per PUT, and not a byte more: no `DefaultBodyLimit` is configured on
/// the server, so axum's 2 MB default applies to the chunk handler and a larger
/// slice is refused by the extractor before the route is ever entered. The
/// app's own uploader has used exactly this size since it was written.
const CHUNK: usize = 1024 * 1024;
/// Newest activity rows the status route hands back.
const RECENT: usize = 20;

/// Where this box sends what it downloads.
struct Hub {
    url: String,
    token: String,
    concurrency: usize,
}

/// The hub configuration, read once.
///
/// The trailing slash is stripped here rather than at each call site, because
/// `https://hub/` plus `/api/upload/init` is a 404 that reads like a version
/// mismatch on the other end rather than a typo in a systemd unit.
///
/// No separate enable flag: both values present means enabled. A flag that can
/// disagree with the configuration is one more state to get wrong, and the
/// status route already reports which of the two it is.
fn hub() -> Option<&'static Hub> {
    static HUB: std::sync::OnceLock<Option<Hub>> = std::sync::OnceLock::new();
    HUB.get_or_init(|| {
        let url = std::env::var("AFM_PEER_SYNC_URL").unwrap_or_default();
        let url = url.trim().trim_end_matches('/').to_string();
        let token = std::env::var("AFM_PEER_SYNC_TOKEN")
            .unwrap_or_default()
            .trim()
            .to_string();
        if url.is_empty() || token.is_empty() {
            return None;
        }
        let concurrency = std::env::var("AFM_PEER_SYNC_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(2)
            .clamp(1, 8);
        Some(Hub {
            url,
            token,
            concurrency,
        })
    })
    .as_ref()
}

/// The host of a URL, for anything a person reads. The token never leaves this
/// box, and neither does anything URL-shaped that could be carrying one.
fn host_of(url: &str) -> String {
    let bare = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    bare.split('/').next().unwrap_or(bare).to_string()
}

/// One client for the life of the process, same shape as the mirror's.
fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .user_agent(concat!(
                "AttackFM/",
                env!("CARGO_PKG_VERSION"),
                " (peer sync)"
            ))
            .build()
            .unwrap_or_default()
    })
}

/// Why the queue is standing still, when it is.
pub struct Stall {
    pub reason: String,
    /// Unix seconds, like every other timestamp the API hands out.
    pub since: i64,
}

/// The in-memory half. Every durable thing is a row in `peer_sync_queue`; this
/// holds only what a restart is allowed to forget.
#[derive(Default)]
pub struct PeerSyncState {
    /// A dead credential or a full hub is not a per-file failure, and must not
    /// spend forty files' worth of backoff ladder proving that forty files fail
    /// identically. The queue stops instead, says why, and re-checks itself.
    stall: std::sync::Mutex<Option<Stall>>,
    notify: tokio::sync::Notify,
}

impl PeerSyncState {
    /// Wake the worker now rather than at the end of its idle sleep.
    pub fn poke(&self) {
        self.notify.notify_one();
    }

    fn stall_now(&self, reason: &str) {
        let mut held = self.stall.lock().unwrap_or_else(|e| e.into_inner());
        if held.as_ref().is_some_and(|s| s.reason == reason) {
            return;
        }
        // Said on entry and on exit only - never once per file, which is how a
        // stalled queue turns into a screenful of the same line.
        eprintln!("[peersync] holding off: {reason}");
        *held = Some(Stall {
            reason: reason.to_string(),
            since: crate::db::now_ms() / 1000,
        });
    }

    /// Whether the queue is still standing down. Clears the stall once the
    /// recheck window is up, so the worker tries the hub again by itself.
    fn stalled(&self) -> bool {
        let mut held = self.stall.lock().unwrap_or_else(|e| e.into_inner());
        let Some(stall) = held.as_ref() else {
            return false;
        };
        let waited = crate::db::now_ms() / 1000 - stall.since;
        if waited < STALL_RECHECK.as_secs() as i64 {
            return true;
        }
        eprintln!("[peersync] trying the hub again");
        *held = None;
        false
    }

    fn snapshot(&self) -> Option<(String, i64)> {
        self.stall
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|s| (s.reason.clone(), s.since))
    }

    fn clear_stall(&self) {
        *self.stall.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// What became of one file.
enum Outcome {
    /// Carries the rel_path the HUB filed it under, which is not necessarily
    /// the one this box holds - the hub re-derives the path from the file's own
    /// tags and suffixes a collision. A delegated pull is settled on that exact
    /// string, so it has to come back from the hub rather than be assumed.
    Done(String),
    /// Worth trying again: the network, a timeout, a hub that lost the id.
    Transient(String),
    /// Not worth trying again by itself - the same bytes would be rejected the
    /// same way. Needs a person, and the retry route.
    Terminal(String),
    /// The hub is unusable, not this file. Nothing is charged to the row.
    Stalled(String),
}

/// Starts the outbox worker. Returns immediately on a hub - a box with nowhere
/// to sync to says nothing and does nothing.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let Some(hub) = hub() else { return };
        eprintln!(
            "[peersync] copying finished imports to {}",
            host_of(&hub.url)
        );
        // An 'uploading' row is a lie the moment this process restarts: nothing
        // is uploading. The upload id survives in the row, so the retry resumes
        // rather than re-sending from zero.
        state.db.peer_sync_reclaim_stuck();
        tokio::time::sleep(BOOT_DELAY).await;
        loop {
            let took = take_a_want(&state, hub).await;
            let worked = cycle(&state, hub).await || took;
            tokio::select! {
                _ = tokio::time::sleep(if worked { BUSY } else { IDLE }) => {}
                _ = state.peersync.notify.notified() => {}
            }
        }
    });
}

/// Asks the hub whether its collector wants anything downloaded here.
///
/// The other direction of the same arrangement. A hub that refuses pasted links
/// (`AFM_IMPORTS=collector`) still decides what is worth having - it holds the
/// listening and the taste - but has no downloader worth using. It records the
/// want; this box, which has SpotiFLAC and the disk, comes and takes it.
///
/// A PULL rather than the hub pushing, for two reasons. The peer already holds
/// a credential for the hub and the hub holds none for the peer, so nothing new
/// has to be configured or kept secret. And inbound-to-peer is the leg that
/// actually fails here - a home box behind a tunnel - while this direction is
/// the one already proven by every upload.
///
/// The finished import needs no special handling afterwards: `on_job_finished`
/// puts its files in the outbox like any other, they go up, and the hub matches
/// them to the pull when they land.
async fn take_a_want(state: &Arc<AppState>, hub: &Hub) -> bool {
    // Nothing to download with: leave the want. Claiming is destructive - it
    // takes the row off the hub's offer - so it must not happen unless this box
    // can act on it now.
    if crate::imports::find_spotiflac().is_none() {
        note_claim("no downloader on this box");
        return false;
    }
    /*
     * Busy means DOWNLOADING, not "has a queued card".
     *
     * This read `queued || downloading` and that was a trap with no way out: a
     * job that is queued and never starts - one left behind by a restart, or
     * waiting on a slot that never frees - blocked every future claim for the
     * life of the process. The hub would go on offering into a silence that
     * nothing in the logs explained. A queued card means the scheduler will get
     * to it; one more want behind it costs nothing.
     */
    {
        /*
         * A running download no longer blocks the NEXT claim - that gate
         * serialized the whole day: claim, download for minutes, sit out an
         * idle poll, claim again, and a heavy dater got three cards a day
         * from a pipeline capable of dozens an hour. Depth is the honest
         * limit: keep a couple queued so downloads run back to back, and
         * stop there so a stall never piles up a backlog.
         */
        let jobs = state.imports.jobs.lock().await;
        let pending = jobs
            .iter()
            .filter(|j| j.state == "queued" || j.state == "downloading")
            .count();
        if pending >= 3 {
            note_claim(&format!("{pending} downloads already in hand here"));
            return false;
        }
    }
    let Some(owner) = state.db.first_admin_id() else {
        note_claim("no admin account on this box to file downloads under");
        return false;
    };

    let reply = http()
        .post(format!("{}/api/collector/claim", hub.url))
        .bearer_auth(&hub.token)
        .send()
        .await;
    let reply = match reply {
        Ok(r) => r,
        Err(e) => {
            note_claim(&format!("could not reach {}: {e}", host_of(&hub.url)));
            return false;
        }
    };
    if !reply.status().is_success() {
        note_claim(&format!(
            "{} answered {} - {}",
            host_of(&hub.url),
            reply.status(),
            if reply.status() == StatusCode::UNAUTHORIZED {
                "the sync credential is not valid there any more"
            } else if reply.status() == StatusCode::NOT_FOUND {
                "that hub is too old to hand out work"
            } else {
                "refused"
            },
        ));
        return false;
    }
    let Ok(body) = reply.json::<serde_json::Value>().await else {
        note_claim("the hub's answer could not be read");
        return false;
    };
    let pull = &body["pull"];
    let (Some(url), Some(title), Some(artist)) = (
        pull["url"].as_str(),
        pull["title"].as_str(),
        pull["artist"].as_str(),
    ) else {
        note_claim("nothing wanted right now");
        return false;
    };
    note_claim("");

    let pull_id = pull["id"].as_i64().unwrap_or(0);
    // A member's pasted link rides the same channel as the collector's picks
    // (kind "import"). On THIS box either kind files exactly as a collector
    // pick always has: a plain library row under the first admin, with no
    // audition stamp (that stamp is the hub's land_pull against ITS pull row -
    // this box records none) and nothing that ever reclaims it. The hub
    // decides what the copy up there becomes.
    let kind = pull["kind"].as_str().unwrap_or("track");
    let via = if kind == "import" {
        format!("a member of {}", host_of(&hub.url))
    } else {
        format!("the collector · for {}", host_of(&hub.url))
    };

    match crate::imports::enqueue_internal(state, url, title, artist, "collector", owner, &via).await {
        Ok(job_id) => {
            // Written BEFORE anything can finish: the upload reports against
            // this mapping, and a job that beat the write would deliver a file
            // the hub could never tie to its pull.
            let _ = state.db.meta_set(&claim_key(&job_id), &pull_id.to_string());
            eprintln!("[peersync] fetching {title} - {artist} for {} ({kind})", host_of(&hub.url));
            true
        }
        /*
         * Hand it straight back.
         *
         * The claim is destructive - the hub took the row off its offer queue
         * the moment it answered - so a box that cannot start the download has
         * quietly eaten somebody's want. enqueue_internal's one refusal is the
         * box-wide library quota, which is not a fact about this song and will
         * refuse the next one too, so a peer at quota would otherwise drain the
         * hub's offers one per wave and download none of them.
         */
        Err(e) => {
            eprintln!("[peersync] could not take {title}: {e}");
            // A member's link is FAILED with the reason, so their card says
            // "library is at its quota" within the minute instead of waiting
            // out a day; the collector's own picks are handed back to be
            // offered again, as ever.
            let (route, body) = if kind == "import" {
                ("failed", serde_json::json!({ "pullId": pull_id, "error": e }))
            } else {
                ("release", serde_json::json!({ "pullId": pull_id }))
            };
            let _ = http()
                .post(format!("{}/api/collector/{route}", hub.url))
                .bearer_auth(&hub.token)
                .json(&body)
                .send()
                .await;
            false
        }
    }
}

/// Why this box last declined to take work from the hub.
///
/// The downloading half of a delegated pull happens HERE, and when it silently
/// does not happen there is nothing on the hub to explain it - the offers just
/// sit there. This is the missing sentence, and it is reported through the sync
/// status so it can be read from the app rather than off a log on a machine
/// nobody can ssh into. Empty means the last attempt worked.
static CLAIM_NOTE: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();

fn note_claim(reason: &str) {
    let slot = CLAIM_NOTE.get_or_init(|| std::sync::Mutex::new(String::new()));
    if let Ok(mut held) = slot.lock() {
        // Said once per change, not once per wave: this runs every minute.
        if *held != reason {
            if !reason.is_empty() {
                eprintln!("[peersync] not taking work: {reason}");
            }
            *held = reason.to_string();
        }
    }
}

fn claim_note() -> String {
    CLAIM_NOTE
        .get_or_init(|| std::sync::Mutex::new(String::new()))
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/// The pull a claimed job is working for, remembered across a restart.
///
/// A key per job rather than a table: the mapping is wanted exactly once, by
/// exactly one reader, and a job that never finishes should cost nothing to
/// forget.
fn claim_key(job_id: &str) -> String {
    format!("peer.claim.{job_id}")
}

/// Tell the hub which file a claimed pull turned into, naming it as the hub
/// itself filed it. Nothing to say for an ordinary upload.
async fn report_delivery(state: &Arc<AppState>, hub: &'static Hub, job_id: &str, filed: &str) {
    if job_id.is_empty() || filed.is_empty() {
        return;
    }
    let Some(pull) = state
        .db
        .meta_get(&claim_key(job_id))
        .and_then(|v| v.parse::<i64>().ok())
    else {
        return;
    };
    let sent = http()
        .post(format!("{}/api/collector/claimed", hub.url))
        .bearer_auth(&hub.token)
        .json(&serde_json::json!({ "pullId": pull, "path": filed }))
        .send()
        .await;
    match sent {
        // Left in place on failure: the row is 'done' and will not be pushed
        // again, so the next finished file for the same job is the only other
        // chance to mention this pull. An unreported pull is not lost, it is
        // downloaded again by the hub once its patience runs out.
        Ok(r) if r.status().is_success() => {}
        _ => eprintln!("[peersync] could not tell {} about pull {pull}", host_of(&hub.url)),
    }
}

/// The other outcome: a claimed pull this box could not finish. Best effort,
/// once - an older hub answers 404 and the pull simply ages out there as it
/// always did.
async fn report_failure(state: &Arc<AppState>, hub: &'static Hub, job_id: &str, error: &str) {
    let Some(pull) = state
        .db
        .meta_get(&claim_key(job_id))
        .and_then(|v| v.parse::<i64>().ok())
    else {
        return;
    };
    let _ = http()
        .post(format!("{}/api/collector/failed", hub.url))
        .bearer_auth(&hub.token)
        .json(&serde_json::json!({ "pullId": pull, "error": error }))
        .send()
        .await;
}

/// A finished import owes the hub its files.
///
/// Rows and a poke only. This is called while the job still holds its download
/// slot and `PLAYLIST_SLOTS` is 1, so a megabyte-paced upload here would wedge
/// every playlist import queued behind it.
pub async fn on_job_finished(state: &Arc<AppState>, job_id: &str) {
    let Some(hub) = hub() else {
        return;
    };
    let job = {
        let jobs = state.imports.jobs.lock().await;
        // The card can have been removed between the flush and this call - the
        // same read the other two completion hooks do.
        let Some(job) = jobs.iter().find(|j| j.id == job_id) else {
            return;
        };
        job.clone()
    };
    if job.state == "error" {
        // A claimed pull that failed here is told to the hub at once, so a
        // member's card says why today rather than "queued" for a day.
        report_failure(state, hub, job_id, job.error.as_deref().unwrap_or("download failed")).await;
        return;
    }
    if job.state != "done" {
        return;
    }

    // `owned_track_ids` as well as `track_ids`: a run that found every track
    // already filed on THIS box reports them as owned and files nothing, and
    // the hub - which may have none of them - would silently never be told.
    //
    // Enqueued from track ids rather than from `job.files`, because the ids
    // carry the tags the hub's precheck matches on, and because the path is
    // read back from the catalog row that actually exists.
    let mut queued = 0usize;
    for id in job.track_ids.iter().chain(job.owned_track_ids.iter()) {
        let Some(rel) = state.db.track_rel_path(*id) else {
            continue;
        };
        let size = state.db.track(*id).map(|t| t.size_bytes).unwrap_or(0);
        if state.db.peer_sync_enqueue(&rel, *id, job_id, size) {
            queued += 1;
        }
    }
    if queued > 0 {
        state.peersync.poke();
    }
}

/// One wave: ask the hub what it is short of, then push that much of it.
///
/// Returns whether anything moved, which is only used to pick the next sleep.
async fn cycle(state: &Arc<AppState>, hub: &'static Hub) -> bool {
    if state.peersync.stalled() {
        return false;
    }
    let due = state.db.peer_sync_due(crate::db::now_ms(), BATCH);
    if due.is_empty() {
        return false;
    }

    // Rows whose track has since left this library have nothing to send. Doing
    // this before the precheck also keeps the request's indices lined up with
    // the rows they came from.
    let mut rows: Vec<PeerSyncRow> = Vec::with_capacity(due.len());
    let mut tracks: Vec<serde_json::Value> = Vec::with_capacity(due.len());
    for row in due {
        let Some(track) = state.db.track(row.track_id) else {
            state
                .db
                .peer_sync_finish(&row.rel_path, "skipped", "this box no longer holds the track");
            continue;
        };
        tracks.push(json!({
            "title": track.title,
            "artist": track.artist,
            "album": track.album,
            // Already seconds on this side, which is the unit the endpoint
            // wants - no conversion, and none wanted.
            "duration": track.duration,
        }));
        rows.push(row);
    }
    if rows.is_empty() {
        return true;
    }

    let (missing, present) = match ask_missing(hub, &tracks).await {
        Ok(answer) => answer,
        Err(reason) => {
            // Rows are left exactly as they were. A hub that cannot answer this
            // is a hub that cannot be pushed to either, and hammering it every
            // minute would neither help nor be visible anywhere.
            state.peersync.stall_now(&reason);
            return false;
        }
    };

    // Whatever the hub did not name is already there. Skipping it is not an
    // optimisation: `unique_destination` on the far side never overwrites, so
    // re-pushing a file the hub holds files a second copy as "Title (2).flac",
    // forever, once per sync.
    let mut to_push = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        if missing.contains(&index) {
            to_push.push(row);
        } else {
            state
                .db
                .peer_sync_finish(&row.rel_path, "skipped", "the hub already has it");
            // A song the hub held all along still counts as DELIVERED for the
            // pull that asked for it - otherwise a member's link to a song
            // already in the library waited a day and then read as failed.
            // The hub names its own file; that is what the pull lands on.
            if let Some(path) = present.get(&index) {
                report_delivery(state, hub, &row.job_id, path).await;
            }
        }
    }
    if to_push.is_empty() {
        return true;
    }

    // Bounded, and joined before this function returns, so the loop is
    // self-limiting and no pile of tasks can build up behind a slow hub.
    let mut queue = to_push.into_iter();
    let mut running = tokio::task::JoinSet::new();
    loop {
        while running.len() < hub.concurrency {
            let Some(row) = queue.next() else { break };
            if !state.db.peer_sync_claim(&row.rel_path) {
                continue;
            }
            let state = state.clone();
            running.spawn(async move { push_one(&state, hub, row).await });
        }
        if running.join_next().await.is_none() {
            break;
        }
    }
    true
}

/// Ask the hub which of these it lacks. `Err` names why nobody could be asked.
/// What the hub is short of (indices into `tracks`), and for what it already
/// holds, the path of its own copy - an older hub sends only the first.
async fn ask_missing(
    hub: &'static Hub,
    tracks: &[serde_json::Value],
) -> Result<(std::collections::HashSet<usize>, std::collections::HashMap<usize, String>), String> {
    let reply = http()
        .post(format!("{}/api/library/missing", hub.url))
        .bearer_auth(&hub.token)
        .json(&json!({ "tracks": tracks }))
        .send()
        .await
        .map_err(|e| format!("the hub could not be reached ({e})"))?;
    match reply.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => return Err(unauthorized_reason()),
        status => return Err(format!("the hub answered {status} when asked what it is missing")),
    }
    let body: serde_json::Value = reply
        .json()
        .await
        .map_err(|e| format!("the hub's answer could not be read ({e})"))?;
    let missing = body
        .get("missing")
        .and_then(|m| m.as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(|v| v.as_u64())
                .map(|v| v as usize)
                .collect()
        })
        .unwrap_or_default();
    let present = body
        .get("present")
        .and_then(|p| p.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let index = row.get("index")?.as_u64()? as usize;
                    let path = row.get("path")?.as_str()?.to_string();
                    Some((index, path))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((missing, present))
}

fn unauthorized_reason() -> String {
    // Its own wording on purpose: a revoked token is the one failure here that
    // a person can fix in thirty seconds, and folding it into "upload failed"
    // hides it behind forty identical rows.
    "the hub rejected this server's token - give the peer its own hub account".to_string()
}

/// Push one file, then settle its row.
async fn push_one(state: &Arc<AppState>, hub: &'static Hub, row: PeerSyncRow) {
    let outcome = transfer(state, hub, &row).await;
    let rel = row.rel_path.as_str();
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match outcome {
        Outcome::Done(filed) => {
            state.db.peer_sync_finish(rel, "done", "");
            report_delivery(state, hub, &row.job_id, &filed).await;
            state.db.record_activity(NewActivity {
                source: "peersync",
                kind: "sync",
                state: "done",
                key: &format!("peersync:{rel}"),
                title: name,
                body: &format!("copied to {}", host_of(&hub.url)),
                track_id: Some(row.track_id).filter(|id| *id > 0),
                detail: None,
            });
        }
        Outcome::Transient(reason) => state.db.peer_sync_defer(rel, &reason),
        Outcome::Terminal(reason) => {
            state.db.peer_sync_finish(rel, "failed", &reason);
            // Loud, because nothing else will retry it: a terminal failure sits
            // in the outbox until somebody presses the button.
            state.db.record_activity(NewActivity {
                source: "peersync",
                kind: "sync",
                state: "failed",
                key: &format!("peersync:{rel}"),
                title: name,
                body: &reason,
                track_id: Some(row.track_id).filter(|id| *id > 0),
                detail: None,
            });
        }
        Outcome::Stalled(reason) => {
            // The row is put back untouched. A stall must never burn an
            // attempt: when the hub's credential comes back, the whole backlog
            // has to still be there waiting for it.
            state.db.peer_sync_finish(rel, "pending", "");
            state.peersync.stall_now(&reason);
        }
    }
}

/// init (if needed) -> resume -> chunks -> finish.
///
/// Strictly sequential within one file. The hub reports `received` as the temp
/// file's LENGTH, not as offset-plus-length, so two overlapping PUTs against
/// one upload id report a size that skips the hole between them and `finish`
/// then accepts a corrupt file. Concurrency lives one level up, across files.
async fn transfer(state: &Arc<AppState>, hub: &'static Hub, row: &PeerSyncRow) -> Outcome {
    let rel = row.rel_path.as_str();
    let Some(abs) = crate::stream::resolve_in_root(&state.music_root, rel) else {
        return Outcome::Terminal("the file is no longer on this box".into());
    };
    let size = match tokio::fs::metadata(&abs).await {
        Ok(meta) => meta.len(),
        Err(e) => return Outcome::Terminal(format!("the file could not be read ({e})")),
    };
    if size == 0 {
        return Outcome::Terminal("the file is empty".into());
    }
    let name = rel.rsplit('/').next().unwrap_or(rel).to_string();

    let mut upload_id = row.upload_id.clone();
    if upload_id.is_empty() {
        match init(hub, &name, size as i64).await {
            Ok(id) => {
                // Persisted BEFORE a byte moves. An id minted and then
                // forgotten is a sparse file on the hub that nothing reaps and
                // nothing can resume - the transfer starts again from zero and
                // the abandoned bytes stay there.
                state.db.peer_sync_progress(rel, &id, 0);
                upload_id = id;
            }
            Err(outcome) => return outcome,
        }
    }

    let mut sent = match received(hub, &upload_id).await {
        Ok(n) => n,
        Err(outcome) => return outcome,
    };
    if sent > size {
        // The hub holds more than this file has - a stale temp under a reused
        // id. Start it again rather than finishing something that is not this.
        state.db.peer_sync_reset(rel);
        return Outcome::Transient("the hub holds more of this file than exists".into());
    }

    let mut file = match tokio::fs::File::open(&abs).await {
        Ok(f) => f,
        Err(e) => return Outcome::Terminal(format!("the file could not be opened ({e})")),
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if let Err(e) = file.seek(std::io::SeekFrom::Start(sent)).await {
        return Outcome::Transient(format!("the file could not be read from {sent} ({e})"));
    }

    let mut buf = vec![0u8; CHUNK];
    let mut since_write = 0u32;
    while sent < size {
        let want = ((size - sent) as usize).min(CHUNK);
        let read = match file.read(&mut buf[..want]).await {
            Ok(0) => return Outcome::Transient("the file ended sooner than its size said".into()),
            Ok(n) => n,
            Err(e) => return Outcome::Transient(format!("the file could not be read ({e})")),
        };
        let reply = http()
            .put(format!("{}/api/upload/{}?offset={}", hub.url, upload_id, sent))
            .bearer_auth(&hub.token)
            .body(buf[..read].to_vec())
            .send()
            .await;
        let reply = match reply {
            Ok(r) => r,
            Err(e) => return Outcome::Transient(format!("the chunk did not arrive ({e})")),
        };
        match reply.status() {
            StatusCode::OK => {}
            StatusCode::UNAUTHORIZED => return Outcome::Stalled(unauthorized_reason()),
            StatusCode::INSUFFICIENT_STORAGE => return Outcome::Stalled(no_room_reason()),
            StatusCode::NOT_FOUND => {
                // The hub no longer knows this upload. The handle is worthless;
                // clearing it makes the next attempt mint a fresh one.
                state.db.peer_sync_reset(rel);
                return Outcome::Transient("the hub forgot this upload".into());
            }
            status => {
                return Outcome::Transient(format!("the hub answered {status} to a chunk"));
            }
        }
        let body: serde_json::Value = reply.json().await.unwrap_or_default();
        let now = body.get("received").and_then(|v| v.as_u64()).unwrap_or(0);
        if now <= sent {
            return Outcome::Transient("the hub did not advance".into());
        }
        sent = now;
        since_write += 1;
        // Written every few chunks rather than every one: this counter exists
        // only for the status readout, and after a restart the truth is
        // re-derived from the hub itself - so a lossy count costs nothing and
        // a write per megabyte would not.
        if since_write >= 8 {
            state.db.peer_sync_progress(rel, &upload_id, sent as i64);
            since_write = 0;
        }
    }
    state.db.peer_sync_progress(rel, &upload_id, sent as i64);

    let reply = http()
        .post(format!("{}/api/upload/{}/finish", hub.url, upload_id))
        .bearer_auth(&hub.token)
        .send()
        .await;
    let reply = match reply {
        Ok(r) => r,
        Err(e) => return Outcome::Transient(format!("the hub did not answer the finish ({e})")),
    };
    match reply.status() {
        StatusCode::OK => {
            let filed = reply
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|b| b["path"].as_str().map(str::to_string))
                .unwrap_or_default();
            Outcome::Done(filed)
        }
        StatusCode::UNAUTHORIZED => Outcome::Stalled(unauthorized_reason()),
        StatusCode::INSUFFICIENT_STORAGE => Outcome::Stalled(no_room_reason()),
        // Both mean the hub's copy is not what this box holds. Drop the handle
        // and send it again from the start.
        StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND => {
            let why = detail(reply).await;
            state.db.peer_sync_reset(rel);
            Outcome::Transient(format!("the hub would not close the upload ({why})"))
        }
        // The hub deleted it: unreadable as audio on its side, so the same
        // bytes will be deleted again. Nothing but a person changes this.
        StatusCode::UNPROCESSABLE_ENTITY => {
            Outcome::Terminal("the hub could not read it as audio and removed it".into())
        }
        status => Outcome::Transient(format!("the hub answered {status} to the finish")),
    }
}

/// Open an upload on the hub and return its id.
async fn init(hub: &'static Hub, filename: &str, size: i64) -> Result<String, Outcome> {
    let reply = http()
        .post(format!("{}/api/upload/init", hub.url))
        .bearer_auth(&hub.token)
        .json(&json!({ "filename": filename, "size": size }))
        .send()
        .await
        .map_err(|e| Outcome::Transient(format!("the hub did not answer ({e})")))?;
    match reply.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => return Err(Outcome::Stalled(unauthorized_reason())),
        StatusCode::INSUFFICIENT_STORAGE => return Err(Outcome::Stalled(no_room_reason())),
        // The hub will not take this shape of file at all, or thinks it too
        // big. Both answers are about the file, and both are the same next
        // time. `AUDIO_EXTENSIONS` on the import side is a subset of `ACCEPTED`
        // on the upload side today, so this should be unreachable - if a new
        // format is ever added to one list and not the other, this is where it
        // will show up rather than in a silent retry loop.
        StatusCode::UNSUPPORTED_MEDIA_TYPE | StatusCode::PAYLOAD_TOO_LARGE => {
            let why = detail(reply).await;
            return Err(Outcome::Terminal(format!("the hub refused the file ({why})")));
        }
        status => {
            return Err(Outcome::Transient(format!(
                "the hub answered {status} to the upload request"
            )))
        }
    }
    let body: serde_json::Value = reply
        .json()
        .await
        .map_err(|e| Outcome::Transient(format!("the hub's answer could not be read ({e})")))?;
    body.get("uploadId")
        .and_then(|v| v.as_str())
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string())
        .ok_or_else(|| Outcome::Transient("the hub gave no upload id".into()))
}

/// How much of an upload the hub already holds - the resume primitive.
///
/// An unknown id answers `0` here rather than 404, so zero is ambiguous between
/// "fresh" and "gone". That ambiguity is resolved by the first PUT, which does
/// 404 on a dead id.
async fn received(hub: &'static Hub, upload_id: &str) -> Result<u64, Outcome> {
    let reply = http()
        .get(format!("{}/api/upload/{}", hub.url, upload_id))
        .bearer_auth(&hub.token)
        .send()
        .await
        .map_err(|e| Outcome::Transient(format!("the hub did not answer ({e})")))?;
    match reply.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => return Err(Outcome::Stalled(unauthorized_reason())),
        status => {
            return Err(Outcome::Transient(format!(
                "the hub answered {status} when asked what it holds"
            )))
        }
    }
    let body: serde_json::Value = reply
        .json()
        .await
        .map_err(|e| Outcome::Transient(format!("the hub's answer could not be read ({e})")))?;
    Ok(body.get("received").and_then(|v| v.as_u64()).unwrap_or(0))
}

fn no_room_reason() -> String {
    "the hub's library is at its quota - hammering it will not free disk".to_string()
}

/// The body of a refusal. Every `/api/upload/*` error is `text/plain`, never
/// JSON, so reading it as JSON gets an empty string where the reason was.
async fn detail(reply: reqwest::Response) -> String {
    let text = reply.text().await.unwrap_or_default();
    let text = text.trim();
    if text.is_empty() {
        "no reason given".to_string()
    } else {
        text.chars().take(200).collect()
    }
}

/// `GET /api/peersync` - what this box owes its hub, if it has one.
///
/// Always 200, including on a hub: "I am not a peer" is an answer, and a client
/// that got a 404 for it would have to treat a perfectly healthy server as
/// broken.
pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some(hub) = hub() else {
        return Ok(Json(json!({ "configured": false })));
    };
    let counts = state.db.peer_sync_counts();
    let recent: Vec<serde_json::Value> = state
        .db
        .peer_sync_recent(RECENT)
        .into_iter()
        .map(|r| {
            json!({
                "path": r.rel_path,
                "state": r.state,
                "attempts": r.attempts,
                "error": r.error,
                "sentBytes": r.sent_bytes,
                "sizeBytes": r.size_bytes,
                "at": r.updated_at / 1000,
            })
        })
        .collect();
    Ok(Json(json!({
        "configured": true,
        // The host, never the URL: a URL in a status payload is one careless
        // log line away from carrying the token beside it.
        "hub": host_of(&hub.url),
        "counts": {
            "pending": counts.pending,
            "uploading": counts.uploading,
            "done": counts.done,
            "skipped": counts.skipped,
            "failed": counts.failed,
        },
        // Whether this box is taking downloads on the hub's behalf, and why not
        // when it is not.
        "claiming": {
            "canDownload": crate::imports::find_spotiflac().is_some(),
            "why": claim_note(),
        },
        "stall": state.peersync.snapshot().map(|(reason, since)| json!({
            "reason": reason,
            "since": since,
        })),
        "recent": recent,
    })))
}

#[derive(serde::Deserialize, Default)]
pub struct RetryBody {
    /// One library-relative path, or absent for every failed row.
    #[serde(default)]
    pub path: Option<String>,
}

/// `POST /api/peersync/retry` - queue failed pushes again.
///
/// Admin, because it schedules work on the operator's own box rather than on
/// the caller's account.
pub async fn retry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<RetryBody>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".into()))?;
    let path = body.and_then(|Json(b)| b.path).filter(|p| !p.is_empty());
    // Asking for a retry is also how a person says "I fixed the hub": clearing
    // the stall means they do not have to wait out the recheck window as well.
    state.peersync.clear_stall();
    let requeued = state.db.peer_sync_retry(path.as_deref());
    state.peersync.poke();
    Ok(Json(json!({ "requeued": requeued })))
}

// --- the "Wrong song?" downloader half -------------------------------------
//
// Same split as the outbox above, the other direction: a hub with no downloader
// offers the alternates a re-fetch needs, and this peer - the box that HAS
// SpotiFLAC - claims them, pulls them here, and ships each back to stage on the
// hub for auditioning (refetch::peer_claim / peer_deliver / peer_fail). One at a
// time on purpose: a person is watching a modal fill, and five parallel
// SpotiFLAC children on a box that is also streaming is not a kindness.

/// Between refetch-claim polls when the hub had nothing to fetch. Shorter than
/// the outbox's IDLE because someone is waiting on the answer in real time.
const REFETCH_IDLE: Duration = Duration::from_secs(5);
/// The whole file goes up in one request, not 1 MiB chunks, so it needs its own
/// generous ceiling rather than the client's 120s: a large lossless alternate
/// over a home uplink can take minutes.
const REFETCH_DELIVER_TIMEOUT: Duration = Duration::from_secs(600);
/// How often the peer tells the hub it is still working a claim. Comfortably
/// under the hub's CLAIM_STALE/NO_PEER windows so a live pull never looks dead.
const REFETCH_BEAT: Duration = Duration::from_secs(30);

/// Start the refetch downloader loop, if this box is a peer AND can download.
/// A hub (no peer config) or a box with no SpotiFLAC starts nothing.
pub fn spawn_refetch(state: Arc<AppState>) {
    let Some(hub) = hub() else {
        return;
    };
    if crate::imports::find_spotiflac().is_none() {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(BOOT_DELAY).await;
        let scratch = state.data_dir.join("refetch-peer");
        let _ = std::fs::remove_dir_all(&scratch);
        loop {
            match claim_refetch(&state, hub).await {
                // Took one - there may be more of the same hunt, look again now.
                true => {}
                // Nothing offered, or the hub was unreachable: wait a beat.
                false => tokio::time::sleep(REFETCH_IDLE).await,
            }
        }
    });
}

/// Claim one refetch candidate from the hub, pull it, and ship it back (or
/// report it failed). Returns whether it did any work.
async fn claim_refetch(state: &Arc<AppState>, hub: &'static Hub) -> bool {
    let Ok(resp) = http()
        .get(format!("{}/api/refetch/peer/claim", hub.url))
        .bearer_auth(&hub.token)
        .send()
        .await
    else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return false;
    };
    let claim = &body["claim"];
    if claim.is_null() {
        return false;
    }
    let (Some(job_id), Some(index), Some(url)) = (
        claim["jobId"].as_str().map(str::to_string),
        claim["index"].as_u64().map(|n| n as usize),
        claim["url"].as_str().map(str::to_string),
    ) else {
        return false;
    };
    let service = claim["service"].as_str().unwrap_or("").to_string();

    // Heartbeat the hub for the WHOLE span of this claim - the download and the
    // upload both - so however slow one pull is, the hub knows the downloader is
    // alive and no waiting hunt (this one or another) gives up on it. Aborted
    // the moment the work resolves, below.
    let beat = {
        let job_id = job_id.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(REFETCH_BEAT).await;
                let _ = http()
                    .post(format!("{}/api/refetch/peer/beat/{job_id}/{index}", hub.url))
                    .bearer_auth(&hub.token)
                    .send()
                    .await;
            }
        })
    };

    let dir = state
        .data_dir
        .join("refetch-peer")
        .join(format!("{job_id}-{index}"));
    let _ = std::fs::remove_dir_all(&dir);

    match crate::refetch::fetch_one(state, &dir, &url, &service).await {
        Ok(path) => {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "candidate.audio".to_string());
            match tokio::fs::read(&path).await {
                Ok(bytes) => {
                    let sent = http()
                        .post(format!("{}/api/refetch/peer/deliver/{job_id}/{index}", hub.url))
                        .query(&[("name", name.as_str())])
                        .bearer_auth(&hub.token)
                        .timeout(REFETCH_DELIVER_TIMEOUT)
                        .body(bytes)
                        .send()
                        .await;
                    // Report a failed delivery back so the slot fails promptly
                    // rather than sitting claimed until the stale timeout. A
                    // delivery the hub already accepted (response merely lost)
                    // leaves the candidate "ready", so this fail is a no-op 409
                    // there - harmless.
                    match sent {
                        Ok(r) if r.status().is_success() => {}
                        Ok(r) => {
                            let code = r.status();
                            fail_refetch(hub, &job_id, index, &format!("the hub refused the delivery ({code})")).await;
                        }
                        Err(e) => {
                            fail_refetch(hub, &job_id, index, &format!("could not reach the hub to deliver: {e}")).await;
                        }
                    }
                }
                Err(e) => fail_refetch(hub, &job_id, index, &format!("staged file unreadable: {e}")).await,
            }
        }
        Err(e) => fail_refetch(hub, &job_id, index, &e).await,
    }
    beat.abort();
    let _ = std::fs::remove_dir_all(&dir);
    true
}

/// Tell the hub this candidate could not be pulled, so its slot fails rather
/// than sitting claimed until the hub's patience runs out.
async fn fail_refetch(hub: &'static Hub, job_id: &str, index: usize, err: &str) {
    let _ = http()
        .post(format!("{}/api/refetch/peer/fail/{job_id}/{index}", hub.url))
        .bearer_auth(&hub.token)
        .json(&json!({ "error": err }))
        .send()
        .await;
}
