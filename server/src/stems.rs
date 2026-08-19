//! Stems: a track pulled apart into vocals, drums, bass and everything else.
//!
//! This is the one thing a licensed streaming service structurally cannot
//! offer - separating a master is a derivative work, and the labels do not
//! clear it - and it is nearly free for someone who owns the file. A model
//! does the separation; ffmpeg packs the result; the pad sampler plays it.
//!
//! Shape of the thing:
//!
//!   ask     POST /api/stems/{track}          queues it, returns the state
//!   watch   GET  /api/stems/{track}          state + what exists so far
//!   play    GET  /api/stems/{track}/{stem}   the audio itself
//!
//! Separation is minutes of GPU, not milliseconds, so nothing here is
//! synchronous: a track is queued, one worker walks the queue, and the client
//! polls. One at a time on purpose - the box is also somebody's stereo, and
//! two demucs runs would make both of them slow AND make playback stutter.
//!
//! Storage is the constraint that shaped the rest, and the answer changed.
//! Six stems of lossless audio are several times the album they came from, and
//! separating a whole library would cost more disk than the library itself. The
//! first cut spent that budget on Opus at 128k, reasoning that a stem is
//! simpler spectral content than a mix - true of the stem, false of the use.
//! These are played SOLO and looped, where nothing is left in the mix to mask a
//! codec, and separation artefacts land in the same places codec artefacts do.
//!
//! So stems are FLAC, and the budget is spent on the CACHE being small rather
//! than the files being lossy: it is budgeted and evicted coldest-first,
//! exactly like the phone's download cache. That trade works because a stem is
//! never the only copy of anything - the original file is still there - so
//! evicting one costs a re-separation, not data. Nobody separates their whole
//! library; they separate the songs they are working on.

use crate::auth;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

/// How far the one running separation has got.
///
/// Somebody who presses Stems on a song nobody has separated waits minutes, and
/// a spinner for minutes is indistinguishable from a hang. demucs prints its
/// own percentage as it works, so there is a real number to show - this is
/// where it is parked between the worker writing it and a poll reading it.
///
/// One job at a time is the existing design (the box is also somebody's stereo)
/// so one slot is enough, and the track id says whose it is. Nothing here is
/// persisted: a restart re-runs the job from the top, and a stored percentage
/// would be a claim about work that stopped happening.
#[derive(Default)]
pub struct Working {
    inner: std::sync::Mutex<Option<Progress>>,
}

#[derive(Clone)]
pub struct Progress {
    pub track_id: i64,
    /// 0..1 through the separation itself, or 0 before demucs says anything.
    pub fraction: f32,
    /// What is happening, in words: `separating` while the model runs,
    /// `packing` while the parts are written out.
    pub phase: &'static str,
    /// How many parts have been filed, of how many the model produces.
    pub filed: usize,
}

impl Working {
    pub fn set(&self, track_id: i64, fraction: f32, phase: &'static str, filed: usize) {
        if let Ok(mut slot) = self.inner.lock() {
            *slot = Some(Progress { track_id, fraction: fraction.clamp(0.0, 1.0), phase, filed });
        }
    }

    pub fn clear(&self) {
        if let Ok(mut slot) = self.inner.lock() {
            *slot = None;
        }
    }

    /// The progress for one track, or None when the worker is elsewhere - which
    /// is the answer that tells a client it is QUEUED behind something rather
    /// than being worked on.
    pub fn get(&self, track_id: i64) -> Option<Progress> {
        self.inner
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .filter(|p| p.track_id == track_id)
    }
}

/// Pulls a percentage out of one line of demucs' output.
///
/// It draws a progress bar to stderr with a carriage return rather than a
/// newline, so the "lines" arrive as one long string with `\r` in it and the
/// last percentage in a chunk is the current one. Anything unrecognised leaves
/// the number where it was, which is why this returns an Option rather than
/// zero - a chunk of warning text must not reset the bar to the start.
fn percent_in(chunk: &str) -> Option<f32> {
    let mut found = None;
    let bytes = chunk.as_bytes();
    for (i, _) in chunk.match_indices('%') {
        // Walk back over the digits immediately before the sign.
        let mut start = i;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start == i {
            continue;
        }
        if let Ok(n) = chunk[start..i].parse::<f32>() {
            if (0.0..=100.0).contains(&n) {
                found = Some(n / 100.0);
            }
        }
    }
    found
}

/// The separator, and part of a stem's identity: a better model later can sit
/// beside what is already on disk instead of quietly mixing two qualities.
const MODEL: &str = "htdemucs_6s";
/// What demucs produces, in the order the pads want them.
///
/// Six rather than four. The four-stem model calls everything that is not a
/// voice, a drum or a bass "other", which on most records is the guitars, the
/// keys, the strings and the pads all welded into one pad you can only mute
/// wholesale - the least useful control on the board, and the one people reach
/// for first. htdemucs_6s splits guitar and piano out of it, so "other" finally
/// means what is left rather than most of the song.
///
/// The model is part of a stem's identity (it is in the primary key), so a
/// track separated by the old model keeps its four files and is simply not a
/// match for this one - it re-separates on next use rather than serving a mix
/// of two vintages.
const STEMS: [&str; 6] = ["vocals", "drums", "bass", "guitar", "piano", "other"];
/// How much disk the stem cache may hold before the coldest track is dropped.
/// Generous, because the volume has room and a re-separation is minutes.
const BUDGET_BYTES: i64 = 120 * 1024 * 1024 * 1024;
/// Never let the cache push the volume below this much free.
const KEEP_FREE_BYTES: i64 = 20 * 1024 * 1024 * 1024;
/// A separation that has not finished by now is not going to.
///
/// Fifteen minutes, when this was written, was enormous: four stems on Metal is
/// well under a minute a track. Two things have happened since. The model is
/// htdemucs_6s, which is half again as much work as the four-stem one. And a
/// box whose torch has no Metal falls back to CPU by itself - correct, but ten
/// to thirty minutes for a four-minute song, which the old ceiling killed
/// silently at the fifteen-minute mark. On top of that the FIRST run of a model
/// downloads its weights - about 300MB for this one - inside this same budget.
///
/// So it is generous now. The cost of being generous is one stuck job holding
/// the queue; the cost of being tight is killing real work and reporting it as
/// a failure the person cannot act on, which is what was happening.
const TIMEOUT: Duration = Duration::from_secs(2700);
/// A ceiling on packing ONE part. Lossless-encoding a song is seconds; this is
/// here so a wedged ffmpeg cannot hold the worker, not to cut real work short.
const PACK_TIMEOUT: Duration = Duration::from_secs(300);
/// How often the worker looks for something to do when idle.
const IDLE: Duration = Duration::from_secs(20);

/// How far in the past a prefetched stem's `used_at` is written: ten years, so
/// a guess sorts below every genuine use forever while guesses still order
/// among themselves by age.
const COLD_OFFSET_MS: i64 = 10 * 365 * 24 * 60 * 60 * 1000;

/// The prefetcher's own ceiling - half the cache. It must never be the thing
/// that triggers the eviction sweep, or it evicts its own work and remakes it.
const PREFETCH_BUDGET_BYTES: i64 = BUDGET_BYTES / 2;

/// How long an evicted song is left alone. The cache decided it was not worth
/// the room; asking again tomorrow is how a treadmill starts.
const PREFETCH_COOLDOWN_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Between enumeration passes.
const PREFETCH_SWEEP: Duration = Duration::from_secs(900);

/// Claimed per pass, so one pass cannot queue a whole library.
const PREFETCH_BATCH: i64 = 16;
/// Stems are stored LOSSLESS.
///
/// They were Opus at 128k, on the reasoning that a stem is simpler spectral
/// content than a full mix. That is true of the stem and false of the use: a
/// stem is played SOLO, chopped, looped and pitched, with nothing else in the
/// mix to mask anything. Separation artefacts and codec artefacts land in the
/// same places - smeared transients, watery high end - and at 128k the codec's
/// contribution stops being inaudible the moment the rest of the band is not
/// there to hide it. FLAC also survives being re-encoded by the mix endpoint,
/// which Opus was quietly being asked to do twice.
///
/// It costs disk: roughly five times per stem, and six stems rather than four.
/// The cache has a budget and an eviction sweep for exactly this reason, and a
/// re-separation is minutes rather than a loss.
const STEM_CODEC: &str = "flac";

/// Where stems live: `<data>/stems/<trackId>/<stem>.flac`.
fn stem_root(state: &AppState) -> PathBuf {
    state.data_dir.join("stems")
}

// --- the worker --------------------------------------------------------------

/// Starts the separator. Runs until the process ends.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let python = match separator_bin() {
            Some(p) => p,
            None => {
                // Said once. The endpoints still answer - they just report
                // that nothing can be separated here.
                eprintln!("[stems] no demucs found - stem separation is off");
                return;
            }
        };
        loop {
            // A person's request always wins. A prefetch starts only when the
            // queue is empty, and is never interrupted once running: killing a
            // demucs pass 20 seconds in throws that GPU away, and the person
            // waits at most one job, which queuedAhead already reports.
            let (track_id, rel, cold) = match state.db.next_stem_job() {
                Some((id, rel)) => (id, rel, false),
                None => match state.db.next_prefetch_job() {
                    Some((id, rel)) => (id, rel, true),
                    None => {
                        tokio::time::sleep(IDLE).await;
                        continue;
                    }
                },
            };
            if cold {
                let _ = state.db.mark_prefetch(track_id, "running", "");
            } else {
                let _ = state.db.mark_stem_job(track_id, "running", "");
            }
            // Claimed before the work starts, so a poll landing in the first
            // seconds says "separating, 0%" rather than "queued" - which reads
            // as nobody having picked it up.
            state.separating.set(track_id, 0.0, "separating", 0);
            match separate(&state, &python, cold, track_id, &rel).await {
                Ok(()) => {
                    if cold {
                        let _ = state.db.mark_prefetch(track_id, "done", "");
                    } else {
                        let _ = state.db.mark_stem_job(track_id, "done", "");
                    }
                    evict_if_needed(&state).await;
                }
                Err(why) => {
                    eprintln!("[stems] track {track_id}: {why}");
                    if cold {
                        let _ = state.db.mark_prefetch(track_id, "failed", &why);
                    } else {
                        let _ = state.db.mark_stem_job(track_id, "failed", &why);
                    }
                }
            }
            // Whichever way it ended, nothing is running now - and a stale
            // percentage would have the next poller watching a finished job.
            state.separating.clear();
        }
    });
}

/// Keeps liked songs and playlist tracks separated before anyone opens them.
///
/// This only ever QUEUES. The single worker above drains `stem_jobs` first and
/// reaches `stem_prefetch` only when nobody is waiting, so a person asking for a
/// song can never end up behind a guess.
///
/// Three independent brakes stop this becoming a treadmill, any one of which
/// would do on its own:
///   - it stops at half the cache budget, so it cannot trigger the eviction
///     sweep by itself;
///   - its output is written cold, so when the sweep does run it takes the
///     guesses before it takes anybody's real work;
///   - an evicted song is remembered in `stem_prefetch` - the one table
///     forget_stems does not touch - and left alone for a month.
///
/// AFM_STEM_PREFETCH=off turns it off entirely.
pub fn spawn_prefetch(state: Arc<AppState>) {
    tokio::spawn(async move {
        if std::env::var("AFM_STEM_PREFETCH").map(|v| v == "off").unwrap_or(false) {
            eprintln!("[stems] separating ahead is off (AFM_STEM_PREFETCH=off)");
            return;
        }
        if separator_bin().is_none() {
            // Nothing written, so installing demucs later starts clean.
            eprintln!("[stems] no demucs found - separating ahead is off");
            return;
        }
        // Boot belongs to the scanner and the other indexers; this is the least
        // urgent thing the box does.
        tokio::time::sleep(Duration::from_secs(300)).await;

        loop {
            if state.db.prefetch_bytes(MODEL) >= PREFETCH_BUDGET_BYTES {
                tokio::time::sleep(PREFETCH_SWEEP).await;
                continue;
            }
            // Never be the reason the volume drops into the reserve: a full disk
            // makes every real separation end in an eviction sweep.
            if free_bytes(&stem_root(&state)).unwrap_or(i64::MAX) < KEEP_FREE_BYTES * 2 {
                tokio::time::sleep(PREFETCH_SWEEP).await;
                continue;
            }
            let wanted =
                state
                    .db
                    .prefetch_candidates(MODEL, crate::db::now_ms(), PREFETCH_BATCH);
            for (track_id, reason) in &wanted {
                let _ = state.db.want_prefetch(*track_id, reason);
            }
            if !wanted.is_empty() {
                eprintln!("[stems] {} song(s) queued to separate ahead", wanted.len());
            }
            tokio::time::sleep(PREFETCH_SWEEP).await;
        }
    });
}

/// The demucs binary, from the venv the installer makes or from PATH.
fn separator_bin() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("AFM_DEMUCS") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let venv = PathBuf::from(&home).join(".attackfm/venvs/stems/bin/demucs");
        if venv.is_file() {
            return Some(venv);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("demucs");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Separates one track and files the results. The whole job, start to finish.
async fn separate(
    state: &Arc<AppState>,
    python: &Path,
    // True when nobody asked: the stems are written cold, so the cache
    // sacrifices guesses before work somebody actually did.
    cold: bool,
    track_id: i64,
    rel: &str,
) -> Result<(), String> {
    let source = crate::stream::resolve_in_root(&state.music_root, rel)
        .ok_or_else(|| format!("cannot resolve {rel} under the music root"))?;

    // Work in a scratch directory that is thrown away whichever way this ends:
    // demucs writes multi-hundred-megabyte WAVs, and a failed run that left
    // them behind would fill the disk one attempt at a time.
    let scratch = state.data_dir.join("stems-work").join(track_id.to_string());
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    tokio::fs::create_dir_all(&scratch)
        .await
        .map_err(|e| format!("cannot make a workspace: {e}"))?;

    let run = tokio::process::Command::new(python)
        .arg("-n")
        .arg(MODEL)
        // Metal. On a machine without it demucs falls back to CPU by itself,
        // which is slow but not wrong.
        .arg("-d")
        .arg("mps")
        .arg("--out")
        .arg(&scratch)
        .arg(&source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match run {
        Ok(c) => c,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&scratch).await;
            return Err(format!("could not start demucs: {e}"));
        }
    };
    // Read as it arrives rather than at the end, so the percentage demucs is
    // printing can be shown while it still means something. The full text is
    // still collected, because a failure is explained by its last two lines.
    let stderr = child.stderr.take();
    let watch = state.separating.clone();
    let log = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        let Some(mut s) = stderr else { return buf };
        let mut chunk = [0u8; 4096];
        loop {
            match s.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&chunk[..n]);
                    if let Some(f) = percent_in(&text) {
                        watch.set(track_id, f, "separating", 0);
                    }
                    buf.push_str(&text);
                }
            }
        }
        buf
    });

    let finished = tokio::time::timeout(TIMEOUT, child.wait()).await;
    let out = match finished {
        Err(_) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_dir_all(&scratch).await;
            return Err(format!(
                "{MODEL} did not finish within {} minutes - if this machine has no Metal, \
                 demucs is running on the CPU and needs longer",
                TIMEOUT.as_secs() / 60
            ));
        }
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_dir_all(&scratch).await;
            return Err(format!("demucs did not run: {e}"));
        }
        Ok(Ok(status)) => status,
    };
    let text = log.await.unwrap_or_default();
    if !out.success() {
        let _ = tokio::fs::remove_dir_all(&scratch).await;
        let tail: Vec<&str> = text
            .lines()
            .rev()
            .filter(|l| !l.trim().is_empty())
            .take(2)
            .collect();
        return Err(format!("demucs failed ({})", tail.join(" | ")));
    }

    // demucs writes <out>/<model>/<track name>/<stem>.wav. The track name is
    // the source file's stem, which can be anything at all, so the tree is
    // walked for the four names rather than rebuilt from the input path.
    let dest_dir = stem_root(state).join(track_id.to_string());
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| format!("cannot make the stem directory: {e}"))?;

    let mut filed = 0;
    for stem in STEMS {
        let Some(wav) = find_wav(&scratch, stem) else {
            continue;
        };
        let packed_path = dest_dir.join(format!("{stem}.{STEM_CODEC}"));
        // Bounded, like the separation itself. This used to be the one step
        // with no ceiling at all: demucs was killed if it hung, and then six
        // ffmpeg encodes ran afterwards with nothing watching them - so a stall
        // here held the single worker, and therefore every other song's
        // separation, for as long as the process lived.
        let packed = tokio::time::timeout(
            PACK_TIMEOUT,
            tokio::process::Command::new("ffmpeg")
                .args(["-nostdin", "-v", "error", "-y", "-i"])
                .arg(&wav)
                // Lossless, and compression_level 5 because these are written
                // once and read many times: the slower levels buy a few percent
                // of disk for real time on a job already minutes long.
                .args(["-c:a", "flac", "-compression_level", "5"])
                .arg(&packed_path)
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .unwrap_or_else(|_| Err(std::io::Error::other("packing timed out")));
        let bytes = tokio::fs::metadata(&packed_path)
            .await
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        match packed {
            // A zero-length output counts as a failure however ffmpeg exited:
            // a file that exists and holds nothing is worse than no file,
            // because the row would claim a stem the pads cannot play.
            Ok(out) if out.status.success() && bytes > 0 => {
                let rel_path = format!("{track_id}/{stem}.{STEM_CODEC}");
                let used_at = if cold {
                        crate::db::now_ms() - COLD_OFFSET_MS
                    } else {
                        crate::db::now_ms()
                    };
                    let _ = state
                        .db
                        .save_stem_at(track_id, stem, MODEL, &rel_path, bytes, used_at);
                filed += 1;
                // Packing is a real, countable phase - six lossless encodes of a
                // whole song each - so it gets its own progress rather than
                // sitting at 100% while somebody watches nothing happen.
                state
                    .separating
                    .set(track_id, filed as f32 / STEMS.len() as f32, "packing", filed);
            }
            other => {
                // One stem failing to pack is not worth losing the others
                // over; the client shows what exists.
                let why = match other {
                    Ok(out) => {
                        let err = String::from_utf8_lossy(&out.stderr);
                        let tail = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
                        if bytes == 0 && out.status.success() {
                            format!("produced an empty file ({tail})")
                        } else {
                            format!("ffmpeg failed ({tail})")
                        }
                    }
                    Err(e) => format!("could not start ffmpeg: {e}"),
                };
                eprintln!("[stems] track {track_id} {stem}: {why}");
                let _ = tokio::fs::remove_file(&packed_path).await;
            }
        }
    }

    let _ = tokio::fs::remove_dir_all(&scratch).await;
    if filed == 0 {
        // Distinguish the two failures that look alike from outside: the
        // model produced nothing, or it produced stems that would not pack.
        let separated = STEMS.iter().filter(|s| find_wav(&scratch, s).is_some()).count();
        let _ = tokio::fs::remove_dir_all(&dest_dir).await;
        return Err(if separated == 0 {
            "demucs produced no stems".to_string()
        } else {
            format!("separated {separated} stems but none of them would pack")
        });
    }
    Ok(())
}

/// Finds a stem's wav anywhere under the scratch tree.
fn find_wav(root: &Path, stem: &str) -> Option<PathBuf> {
    let wanted = format!("{stem}.wav");
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().and_then(|n| n.to_str()) == Some(wanted.as_str()) {
                return Some(path);
            }
        }
    }
    None
}

/// Drops the coldest tracks until the cache is inside its budget and the
/// volume has room to breathe.
async fn evict_if_needed(state: &Arc<AppState>) {
    for _ in 0..64 {
        let used = state.db.stems_bytes();
        let free = free_bytes(&stem_root(state)).unwrap_or(i64::MAX);
        if used <= BUDGET_BYTES && free >= KEEP_FREE_BYTES {
            return;
        }
        let Some((track_id, paths)) = state.db.coldest_stem_track() else {
            return;
        };
        for rel in paths {
            let _ = tokio::fs::remove_file(stem_root(state).join(rel)).await;
        }
        let _ = tokio::fs::remove_dir_all(stem_root(state).join(track_id.to_string())).await;
        let _ = state.db.forget_stems(track_id);
        // forget_stems erases track_stems AND stem_jobs, so this is the only
        // surviving record that the song was ever separated - and the only
        // thing stopping the prefetcher queueing it again on its next pass.
        let _ = state.db.note_stem_eviction(track_id, PREFETCH_COOLDOWN_MS);
    }
}

/// Free space on the volume holding a path.
fn free_bytes(path: &Path) -> Option<i64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c` is a valid NUL-terminated path and `stat` is written by the
    // call it is passed to.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut stat) != 0 {
            return None;
        }
        Some(stat.f_bavail as i64 * stat.f_frsize as i64)
    }
}

// --- the endpoints -----------------------------------------------------------

type ApiResult = Result<Json<Value>, (StatusCode, String)>;

/// `POST /api/stems/{track}` - ask for a track to be pulled apart.
/// `GET /api/stems/prefetch` - how far ahead the separator has got.
///
/// Registered BEFORE `/api/stems/{track}` in main.rs, or axum reads "prefetch"
/// as a track id and the i64 extractor rejects it.
pub async fn prefetch_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult {
    auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let (wanted, done, failed, evicted) = state.db.prefetch_summary();
    Ok(Json(json!({
        "enabled": separator_bin().is_some()
            && !std::env::var("AFM_STEM_PREFETCH").map(|v| v == "off").unwrap_or(false),
        "wanted": wanted,
        "done": done,
        "failed": failed,
        "evicted": evicted,
        "bytes": state.db.prefetch_bytes(MODEL),
        "budgetBytes": PREFETCH_BUDGET_BYTES,
    })))
}

pub async fn request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(track_id): AxumPath<i64>,
) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".to_string()))?;
    if separator_bin().is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "this server has no separator installed".to_string(),
        ));
    }
    let state_name = state
        .db
        .request_stems(track_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "state": state_name })))
}

/// `GET /api/stems/{track}` - where that ask has got to, and what exists.
pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(track_id): AxumPath<i64>,
) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".to_string()))?;
    let (job_state, error, rows) = state.db.stems_for(track_id, MODEL);
    // Only when this track is the one being worked on. A queued job reports no
    // progress at all, which is the truth: nothing has started, and a bar
    // sitting at zero would say the same thing far less clearly.
    let live = state.separating.get(track_id);
    Ok(Json(json!({
        "state": job_state,
        "error": error,
        "available": separator_bin().is_some(),
        "parts": STEMS.len(),
        "progress": live.as_ref().map(|p| p.fraction),
        "phase": live.as_ref().map(|p| p.phase),
        // What it is waiting BEHIND. Only meaningful while it waits, and the
        // difference between "your server is thinking" and "your server is
        // busy with two other songs first" is the difference between a person
        // waiting and a person deciding something is broken.
        "queuedAhead": if job_state == "queued" {
            Some(state.db.stems_queued_ahead(track_id))
        } else {
            None
        },
        "stems": rows
            .into_iter()
            .map(|(stem, _rel, bytes)| json!({ "stem": stem, "bytes": bytes }))
            .collect::<Vec<_>>(),
    })))
}

/// Shortest block worth a round trip, and the longest one anybody may ask for.
///
/// The ceiling is a memory budget, not a policy. The sampler decodes what it
/// asks for into float PCM - 353KB a second per part, so six parts of one
/// minute is 127MB - and it holds the block that is playing plus the one after
/// it. Twenty seconds is the point where two block-sets still fit comfortably
/// on a phone.
const MIN_BLOCK: f64 = 1.0;
const MAX_BLOCK: f64 = 20.0;

/// A 44-byte canonical WAV header for a block of 16-bit PCM.
///
/// Written here rather than by ffmpeg because ffmpeg cannot write a correct one
/// to a PIPE: the RIFF and data chunk sizes are patched by seeking back to the
/// start when the encode finishes, and a pipe does not rewind, so a piped
/// `-f wav` carries placeholder lengths. Some decoders read to end-of-buffer
/// anyway; the sampler must not depend on which. Asking for raw `s16le` and
/// putting the header on ourselves means every length in the file is exact.
fn wav_header(pcm_len: usize, channels: u16, rate: u32) -> Vec<u8> {
    let block_align = channels * 2;
    let byte_rate = rate * u32::from(block_align);
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&((36 + pcm_len) as u32).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    h.extend_from_slice(&1u16.to_le_bytes()); // format: PCM
    h.extend_from_slice(&channels.to_le_bytes());
    h.extend_from_slice(&rate.to_le_bytes());
    h.extend_from_slice(&byte_rate.to_le_bytes());
    h.extend_from_slice(&block_align.to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    h.extend_from_slice(b"data");
    h.extend_from_slice(&(pcm_len as u32).to_le_bytes());
    h
}

/// `GET /api/stems/{track}/{stem}` - the audio.
///
/// Whole by default: a caller that wants one part of a song wants the part, and
/// a range request would only add round trips before the first sound.
///
/// `?from=<seconds>&len=<seconds>` asks for a BLOCK instead, and that is what
/// the sampler uses. It plays a whole song out of six parts at once, which it
/// cannot do by holding them: six whole stems decoded is most of half a
/// gigabyte of float PCM and no phone has that to spare. So it streams them -
/// a block of every part, decoded and scheduled, then the next one - and the
/// only thing this endpoint has to guarantee is that the same `from` and `len`
/// give every part exactly the same number of samples. That is what keeps six
/// separately-fetched blocks landing on the same instant.
///
/// `&fmt=flac` for the same block losslessly compressed, which is roughly half
/// the bytes. WAV is the default because every browser decodes it; a client
/// that has checked its own decoder can ask for FLAC and halve its traffic.
/// Both are lossless and both are sample-exact - the choice costs nothing but
/// bandwidth either way.
pub async fn file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((track_id, stem)): AxumPath<(i64, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, (StatusCode, String)> {
    // The stream token, because an <audio> element and a fetch for an
    // ArrayBuffer cannot both carry a header - same door the rest of the
    // audio uses.
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".to_string()))?;
    if !STEMS.contains(&stem.as_str()) {
        return Err((StatusCode::NOT_FOUND, "no such stem".to_string()));
    }
    let rel = state
        .db
        .stem_path(track_id, &stem, MODEL)
        .ok_or((StatusCode::NOT_FOUND, "not separated yet".to_string()))?;
    let path = stem_root(&state).join(rel);

    if let Some(len) = params.get("len").and_then(|v| v.parse::<f64>().ok()) {
        let from = params
            .get("from")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0)
            .max(0.0);
        let flac = params.get("fmt").map(String::as_str) == Some("flac");
        return block(&state, &path, from, len, flac).await;
    }

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "the stem file has gone".to_string()))?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "audio/flac")
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .body(Body::from(bytes))
        .unwrap())
}

/// Cuts `len` seconds from `from` and hands it back whole.
///
/// Collected in full rather than streamed. The caller decodes the entire block
/// before it can play a sample of it, and a WAV header cannot be written until
/// the byte count is known - so there is nothing to gain by answering early,
/// and streaming would mean lying about the length in the header.
async fn block(
    state: &Arc<AppState>,
    path: &Path,
    from: f64,
    len: f64,
    flac: bool,
) -> Result<Response, (StatusCode, String)> {
    if !state.ffmpeg {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "no ffmpeg on this server".into()));
    }
    let len = len.clamp(MIN_BLOCK, MAX_BLOCK);
    let mut command = tokio::process::Command::new("ffmpeg");
    command
        .args(["-nostdin", "-v", "error"])
        .arg("-i")
        .arg(path)
        // AFTER the input, so the seek is decoded to the exact sample rather
        // than snapped to a frame boundary. Every part of one track is cut with
        // the same numbers, and only an exact cut keeps them in phase.
        .args(["-ss", &format!("{from:.4}")])
        .args(["-t", &format!("{len:.4}")])
        .args(["-ac", "2", "-ar", "44100"]);
    if flac {
        // Level 3 rather than the default 5: this is encoded per request while
        // somebody is waiting for it, and the last two levels buy about a
        // percent of size for real time.
        command.args(["-c:a", "flac", "-compression_level", "3", "-f", "flac", "-"]);
    } else {
        command.args(["-c:a", "pcm_s16le", "-f", "s16le", "-"]);
    }
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if output.stdout.is_empty() {
        // Past the end of the stem, or a file ffmpeg could not read. Either way
        // there is no block here, and an empty one would decode to silence that
        // looks loaded.
        return Err((StatusCode::NOT_FOUND, "nothing at that point in the song".into()));
    }
    let (kind, body) = if flac {
        ("audio/flac", output.stdout)
    } else {
        let mut wav = wav_header(output.stdout.len(), 2, 44100);
        wav.extend_from_slice(&output.stdout);
        ("audio/wav", wav)
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, kind)
        // Blocks are addressed by exact offset, so the same request always
        // means the same samples - and a seek back over ground already played
        // costs nothing.
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(body))
        .unwrap())
}

/// The stem files for a track with some parts left out, in board order.
///
/// This is what lets the ordinary player play a song with the vocal removed. It
/// used to take a whole separate deck to do that - one that seized the output,
/// paused the real player, and ran its own transport - and the cost was a second
/// set of controls that had nothing to do with the seek bar you were looking at.
/// Muting a part is not a different kind of playback; it is the same song with
/// something taken out, which is exactly what the encoder already does for every
/// other effect. So the stems are handed to the transcoder as inputs, and the
/// rest of the player carries on knowing nothing about it.
///
/// Empty when the track has not been separated, or when nothing is dropped, or
/// when every part is - all three of which mean "just play the file", and the
/// last of which would otherwise be an ffmpeg command with no inputs.
pub fn kept_stem_paths(state: &AppState, track_id: i64, dropped: &[String]) -> Vec<PathBuf> {
    if dropped.is_empty() {
        return Vec::new();
    }
    let root = stem_root(state);
    let mut keep = Vec::new();
    for stem in STEMS {
        if dropped.iter().any(|d| d == stem) {
            continue;
        }
        let Some(rel) = state.db.stem_path(track_id, stem, MODEL) else {
            continue;
        };
        let path = root.join(rel);
        if path.is_file() {
            keep.push(path);
        }
    }
    keep
}

/// The part names a client asked to drop, filtered to ones that exist.
///
/// Never interpolated: a name that is not in the registry is discarded rather
/// than passed along, so nothing a caller writes can reach an ffmpeg argument.
pub fn parse_drop(raw: Option<&String>) -> Vec<String> {
    let Some(raw) = raw else { return Vec::new() };
    raw.split(',')
        .map(str::trim)
        .filter(|s| STEMS.contains(s))
        .map(str::to_string)
        .collect()
}

/// `GET /api/stems/{track}/mix?t=<streamToken>&drop=vocals`
///
/// The track with a part taken out, as one stream - which is karaoke when the
/// part is the vocal.
///
/// Mixed here rather than in the browser on purpose. The client COULD fetch
/// three stems and start three buffer sources together, and they would even
/// stay in sync, but it would hold ninety megabytes of decoded audio to do it
/// and could not seek without rebuilding all three. One stream is a plain
/// `<audio>` element: seekable, cheap, and it behaves like every other song
/// in the app.
///
/// `amix` with `normalize=0` because the parts were separated from one mix
/// and adding them back is meant to reconstruct it - normalising would divide
/// each by three and hand back something four decibels quiet. The limiter
/// catches the rare case where the sum overshoots.
pub async fn mix(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(track_id): AxumPath<i64>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, (StatusCode, String)> {
    crate::stream::caller_from_either(&state, &headers, &params)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !state.ffmpeg {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "no ffmpeg on this server".into()));
    }
    // What to leave out. Only a known stem name, matched against the registry
    // - the tag is never interpolated into anything.
    let drop = params.get("drop").map(String::as_str).unwrap_or("vocals");
    if !STEMS.contains(&drop) {
        return Err((StatusCode::BAD_REQUEST, "no such part".into()));
    }

    let root = stem_root(&state);
    let mut inputs: Vec<PathBuf> = Vec::new();
    for stem in STEMS {
        if stem == drop {
            continue;
        }
        let Some(rel) = state.db.stem_path(track_id, stem, MODEL) else {
            continue;
        };
        let path = root.join(rel);
        if path.is_file() {
            inputs.push(path);
        }
    }
    if inputs.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            "this track has not been separated yet".into(),
        ));
    }

    let mut command = tokio::process::Command::new("ffmpeg");
    command.args(["-nostdin", "-v", "error"]);
    // Seeking re-runs the encode from a point, exactly as the transcode
    // endpoint does - a live encode has no addressable end to range over.
    if let Some(seek) = params.get("seek").and_then(|v| v.parse::<f64>().ok()) {
        if seek > 0.0 {
            command.arg("-ss").arg(format!("{seek:.3}"));
        }
    }
    for path in &inputs {
        command.arg("-i").arg(path);
    }
    let filter = format!(
        "amix=inputs={}:normalize=0,alimiter=limit=0.95",
        inputs.len()
    );
    command
        .args(["-filter_complex", &filter])
        .args(["-c:a", "aac", "-b:a", "192k", "-f", "adts", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "no output".to_string()))?;
    // The child is adopted by the stream: when the listener goes away the body
    // is dropped, the pipe closes, and ffmpeg stops on its own.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    let body = Body::from_stream(crate::stream::reader_stream(stdout));
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "audio/aac")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap())
}

#[cfg(test)]
mod block_tests {
    use super::*;

    #[test]
    fn a_wav_header_declares_the_exact_lengths_it_was_given() {
        // The whole reason this is hand-written: every length must be right,
        // because a piped ffmpeg cannot go back and fix them.
        let pcm = 44_100 * 2 * 2; // one second, stereo, 16-bit
        let h = wav_header(pcm, 2, 44100);
        assert_eq!(h.len(), 44);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(&h[8..12], b"WAVE");
        assert_eq!(&h[36..40], b"data");
        let riff = u32::from_le_bytes(h[4..8].try_into().unwrap());
        let data = u32::from_le_bytes(h[40..44].try_into().unwrap());
        assert_eq!(data as usize, pcm);
        assert_eq!(riff as usize, pcm + 36, "RIFF size counts everything after itself");
        let byte_rate = u32::from_le_bytes(h[28..32].try_into().unwrap());
        assert_eq!(byte_rate, 44_100 * 4);
        let align = u16::from_le_bytes(h[32..34].try_into().unwrap());
        assert_eq!(align, 4);
    }

    #[test]
    fn a_block_request_cannot_ask_for_more_than_a_phone_can_hold() {
        // The sampler holds two block-sets of six parts at once. At the ceiling
        // that is six parts times twenty seconds times two, decoded to float -
        // and the point of the clamp is that no client, current or future, can
        // ask for a number that puts that past what a phone will give it.
        let resident = MAX_BLOCK * 44_100.0 * 2.0 * 4.0 * 6.0 * 2.0;
        assert!(resident < 220_000_000.0, "two block-sets is {resident} bytes");
        assert!(MIN_BLOCK > 0.0 && MIN_BLOCK < MAX_BLOCK);
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;

    #[test]
    fn the_last_percentage_in_a_chunk_is_the_current_one() {
        // demucs redraws its bar with carriage returns, so one read can carry
        // several frames of it. The newest is the one at the end.
        assert_eq!(percent_in("  4%|#   \r 12%|##  \r 37%|### "), Some(0.37));
        assert_eq!(percent_in("100%|####|"), Some(1.0));
        assert_eq!(percent_in("0%|"), Some(0.0));
    }

    #[test]
    fn a_chunk_with_no_percentage_leaves_the_bar_alone() {
        // The important half: demucs writes warnings to the same stream, and a
        // warning must not reset a bar that is most of the way along.
        assert_eq!(percent_in("Selected model is a bag of 1 models"), None);
        assert_eq!(percent_in(""), None);
        assert_eq!(percent_in("%"), None);
        assert_eq!(percent_in("nan%"), None);
        // Out of range is somebody else's number, not a percentage of this.
        assert_eq!(percent_in("240%"), None);
    }

    #[test]
    fn progress_belongs_to_one_track_at_a_time() {
        // The point of the track id: a client polling about a song that is
        // QUEUED behind another one must not be shown the other one's bar.
        let w = Working::default();
        w.set(7, 0.5, "separating", 0);
        assert!(w.get(7).is_some());
        assert!(w.get(8).is_none(), "another track's poll sees nothing");
        w.clear();
        assert!(w.get(7).is_none());
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;

    #[test]
    fn only_real_part_names_survive_the_wire() {
        // The whole reason this exists: what a client sends ends up deciding
        // which FILES become ffmpeg inputs, so anything unrecognised is dropped
        // rather than carried along.
        let raw = "vocals, drums , nonsense, ../../etc/passwd,piano".to_string();
        assert_eq!(parse_drop(Some(&raw)), vec!["vocals", "drums", "piano"]);
        assert!(parse_drop(None).is_empty());
        assert!(parse_drop(Some(&String::new())).is_empty());
        assert!(parse_drop(Some(&"; rm -rf /".to_string())).is_empty());
    }

    #[test]
    fn every_name_in_the_registry_is_accepted() {
        // The mirror of the test above: the filter must not be so strict that a
        // legitimate part cannot be muted.
        for stem in STEMS {
            assert_eq!(parse_drop(Some(&stem.to_string())), vec![stem.to_string()]);
        }
    }
}
