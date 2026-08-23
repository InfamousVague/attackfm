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
            pull_cycle(&state).await;
            tune_cycle(&state);
            // The small-artist sources fill the same pool the Deezer harvest
            // does; their own clocks make this a no-op most cycles.
            crate::listenbrainz::cycle(&state).await;
            tokio::time::sleep(CYCLE).await;
        }
    });
}

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
                let _ = state.db.land_pull(pull_id, user_id, &j.track_ids);
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
            // One job at a time across all listeners: the next cycle serves
            // the next person. Fairness by rotation, not by parallelism.
            return;
        }
    }
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
        .map(|(title, artist, kind, pull_state, at, reason)| {
            json!({
                "title": title,
                "artist": artist,
                "kind": kind,
                // The client's vocabulary: a queued pull reads as landed-in-
                // progress rather than exposing the queue's internals.
                "state": match pull_state.as_str() {
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
