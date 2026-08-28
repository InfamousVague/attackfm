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

    /// Whatever is being separated right now, whichever track it is.
    ///
    /// `get` answers "is MY song being worked on", which is the right question
    /// for somebody waiting on one. This is the other one: "what is the machine
    /// doing", which is what a progress readout in settings needs - it has no
    /// particular track in mind and wants to name the one in front of it.
    pub fn current(&self) -> Option<Progress> {
        self.inner.lock().ok().and_then(|slot| slot.clone())
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

/// Check the stem index against the disk, at boot.
///
/// The index can outlive the files. Moving a server carries the database and
/// the music and can perfectly well leave the stems cache behind - and the
/// cache is the one thing that is pure derived data, so nobody thinks to bring
/// it. What is left is an index insisting on 965 separated songs with twelve
/// files on disk, and the failure is SILENT in the worst way: `/api/stems/<id>`
/// reports six parts, the console draws six working faders, and the stream
/// finds no files, falls through to an ordinary transcode and plays the song
/// unchanged. Pulling a vocal to nothing does nothing at all.
///
/// (Doubly so across that particular move: the old box wrote `.opus` parts and
/// this one writes `.flac`, so even a copied cache would have missed.)
///
/// So: every path the index claims is checked once, and the ones that are not
/// there are forgotten - which makes the status honest, and lets the song be
/// separated again by whoever asks next.
pub fn reconcile(state: &Arc<AppState>) {
    let root = stem_root(state);
    let mut gone: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for (track_id, rel) in state.db.all_stem_paths() {
        if !root.join(&rel).is_file() {
            gone.insert(track_id);
        }
    }
    if gone.is_empty() {
        return;
    }
    for track_id in &gone {
        let _ = state.db.forget_stems(*track_id);
        let _ = state.db.rearm_stem_prefetch(*track_id);
    }
    eprintln!(
        "[stems] {} songs were indexed as separated but their parts are gone - forgotten, so they can be made again",
        gone.len(),
    );
}

#[cfg(test)]
mod reconcile_tests {
    /// A stem row whose file is gone must stop being believed - and the song
    /// must become eligible again.
    ///
    /// This is the shape of the bug it exists for: the index survived a server
    /// move and the cache did not, so `/api/stems/<id>` reported six parts, the
    /// console drew six working faders, and the stream - finding no files -
    /// played the song unchanged. Nothing errored anywhere.
    #[test]
    fn a_stem_row_without_its_file_is_forgotten() {
        let dir = std::env::temp_dir().join(format!("afm-stems-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::Db::open(&dir.join("t.sqlite")).unwrap();
        let user = db.create_user("stem-test", "x", true).unwrap();
        assert!(user > 0);

        let mut track = crate::db::ScannedTrack::default();
        track.rel_path = "A/B/song.flac".to_string();
        track.title = "Song".to_string();
        track.artist = "A".to_string();
        db.upsert_track(&track, 1).unwrap();
        assert!(db.all_stem_paths().is_empty(), "setup: no stems indexed");

        let track_id = db
            .track_id_by_path("A/B/song.flac")
            .expect("the scanned track has an id");

        // Two parts indexed: one whose file exists, one whose file never will.
        let root = dir.join("stems");
        std::fs::create_dir_all(root.join(track_id.to_string())).unwrap();
        std::fs::write(root.join(format!("{track_id}/vocals.flac")), b"x").unwrap();
        db.save_stem(track_id, "vocals", super::MODEL, &format!("{track_id}/vocals.flac"), 1)
            .unwrap();
        db.save_stem(track_id, "drums", super::MODEL, &format!("{track_id}/drums.opus"), 1)
            .unwrap();
        assert_eq!(db.all_stem_paths().len(), 2, "setup: both rows indexed");

        // The reconcile predicate, applied the way reconcile() applies it.
        let missing: Vec<i64> = db
            .all_stem_paths()
            .into_iter()
            .filter(|(_, rel)| !root.join(rel).is_file())
            .map(|(t, _)| t)
            .collect();
        assert_eq!(missing, vec![track_id], "the .opus row is the one that is gone");

        for t in missing {
            db.forget_stems(t).unwrap();
            db.rearm_stem_prefetch(t).unwrap();
        }
        assert!(
            db.all_stem_paths().is_empty(),
            "a song missing ANY part is forgotten whole - a half-separated song \
             is not something the mixer can use",
        );
    }
}

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
            // The song's own name, for the activity row: "Anthology" reads as
            // something happening to your library, "track 4812" reads as a log.
            let name = state
                .db
                .track_label(track_id)
                .map(|(title, artist)| format!("{title} — {artist}"))
                .unwrap_or_else(|| format!("track {track_id}"));
            let key = format!("stems:{track_id}");
            state.db.record_activity(crate::db::NewActivity {
                source: "stems",
                kind: "separate",
                state: "started",
                key: &key,
                title: "Taking a song apart",
                // Whether anybody asked is the difference between "this is for
                // you, now" and "the box is using an idle minute", and it is
                // the first thing an owner wants to know from a 3am notice.
                body: &if cold {
                    format!("{name} · ahead of being asked")
                } else {
                    name.clone()
                },
                track_id: Some(track_id),
                detail: None,
            });
            match separate(&state, &python, cold, track_id, &rel).await {
                Ok(()) => {
                    if cold {
                        let _ = state.db.mark_prefetch(track_id, "done", "");
                    } else {
                        let _ = state.db.mark_stem_job(track_id, "done", "");
                    }
                    state.db.record_activity(crate::db::NewActivity {
                        source: "stems",
                        kind: "separate",
                        state: "done",
                        key: &key,
                        title: "Song taken apart",
                        body: &name,
                        track_id: Some(track_id),
                        detail: None,
                    });
                    evict_if_needed(&state).await;
                }
                Err(why) => {
                    eprintln!("[stems] track {track_id}: {why}");
                    if cold {
                        let _ = state.db.mark_prefetch(track_id, "failed", &why);
                    } else {
                        let _ = state.db.mark_stem_job(track_id, "failed", &why);
                    }
                    state.db.record_activity(crate::db::NewActivity {
                        source: "stems",
                        kind: "separate",
                        state: "failed",
                        key: &key,
                        title: "Could not take a song apart",
                        body: &format!("{name} · {why}"),
                        track_id: Some(track_id),
                        detail: None,
                    });
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
/// The key the operator's switch is stored under.
pub const PREFETCH_PREF: &str = "stems.prefetch";

/// Whether LIKED songs are one of the things separated ahead.
///
/// Its own switch because Liked is not a playlist row and so cannot carry the
/// per-list `auto_stem` flag, and because it is the collection most people
/// would want separated if they wanted anything separated at all. Off by
/// default like everything else here.
pub const LIKED_PREF: &str = "stems.liked";

pub fn liked_wanted(state: &AppState) -> bool {
    matches!(state.db.server_pref(LIKED_PREF).as_deref(), Some("on"))
}

/// Whether to separate ahead, right now.
///
/// Checked on every sweep rather than once at boot, so flipping the switch in
/// the app takes effect within the sweep interval instead of at the next
/// restart. The stored choice wins; with none stored the environment variable
/// still decides, so an operator who set AFM_STEM_PREFETCH=off before this
/// switch existed is not quietly overridden by the default.
pub fn prefetch_wanted(state: &AppState) -> bool {
    match state.db.server_pref(PREFETCH_PREF).as_deref() {
        Some("off") => false,
        Some(_) => true,
        // OFF until asked for. It defaulted to on, which - paired with the old
        // "everything liked or playlisted" rule - meant a box started pulling
        // a whole library apart the day it was installed, and the first anyone
        // knew of it was the disk. AFM_STEM_PREFETCH=on still turns it on
        // without opening the app, for an operator who wants it from boot.
        None => std::env::var("AFM_STEM_PREFETCH").map(|v| v == "on").unwrap_or(false),
    }
}

pub fn spawn_prefetch(state: Arc<AppState>) {
    tokio::spawn(async move {
        if separator_bin().is_none() {
            // Nothing written, so installing demucs later starts clean.
            eprintln!("[stems] no demucs found - separating ahead is off");
            return;
        }
        // Boot belongs to the scanner and the other indexers; this is the least
        // urgent thing the box does.
        tokio::time::sleep(Duration::from_secs(300)).await;

        loop {
            // Re-read each pass: the switch is live, and a paused prefetcher
            // must keep its loop rather than exiting, or turning it back on
            // would need a restart.
            if !prefetch_wanted(&state) {
                tokio::time::sleep(PREFETCH_SWEEP).await;
                continue;
            }
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
                    .prefetch_candidates(
                        MODEL,
                        crate::db::now_ms(),
                        PREFETCH_BATCH,
                        liked_wanted(&state),
                    );
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

/// Which device demucs runs on.
///
/// This used to be the literal `mps` with a comment promising that a machine
/// without Metal "falls back to CPU by itself, which is slow but not wrong".
/// It does not. On Linux torch raises `PyTorch is not linked with support for
/// mps devices` and the separation fails outright - so the moment the hub
/// moved off the Mac, every stem job died on its first tensor and stems looked
/// like a feature that had simply stopped existing.
///
/// mps is still right where it applies, and it applies exactly where the OS
/// says it might, so the default follows the platform. The override is for the
/// case neither branch can guess: a Linux box with a CUDA card, where `cuda`
/// is worth an order of magnitude over the honest default.
fn separator_device() -> String {
    if let Ok(explicit) = std::env::var("AFM_DEMUCS_DEVICE") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if cfg!(target_os = "macos") {
        "mps".to_string()
    } else {
        "cpu".to_string()
    }
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
        .arg("-d")
        .arg(separator_device())
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
    // The honest denominator: every liked-or-playlisted song, and how many of
    // THOSE are already apart. See Db::prefetch_total for why the queue's own
    // counts cannot answer this.
    let (separated, total) = state.db.prefetch_total(MODEL);
    // What the machine is doing this second, named. A number that only moves
    // when a whole song finishes looks stuck for the minute each one takes.
    let running = state.separating.current().map(|p| {
        let (title, artist) = state
            .db
            .track_label(p.track_id)
            .unwrap_or_else(|| (String::new(), String::new()));
        json!({
            "trackId": p.track_id,
            "title": title,
            "artist": artist,
            "fraction": p.fraction,
            "phase": p.phase,
            "filed": p.filed,
        })
    });
    Ok(Json(json!({
        "enabled": prefetch_wanted(&state),
        // Whether Liked is one of the things separated ahead. Absent on an
        // older app, which simply does not draw the switch.
        "liked": liked_wanted(&state),
        // Distinct from `enabled`: a server with no demucs cannot do this at
        // all, and a switch that flips but changes nothing is worse than a row
        // that explains itself.
        "available": separator_bin().is_some(),
        "wanted": wanted,
        "done": done,
        "failed": failed,
        "evicted": evicted,
        "separated": separated,
        "total": total,
        "running": running,
        "bytes": state.db.prefetch_bytes(MODEL),
        "budgetBytes": PREFETCH_BUDGET_BYTES,
    })))
}

/// `POST /api/stems/prefetch` - the operator turns separating-ahead on or off.
///
/// Admin only: it spends the server's GPU and up to half its stem cache, which
/// is the operator's to give, not each listener's.
pub async fn set_prefetch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((
            StatusCode::FORBIDDEN,
            "only an admin can change what the server does in the background".to_string(),
        ));
    }
    let on = body.get("enabled").and_then(|v| v.as_bool()).ok_or((
        StatusCode::BAD_REQUEST,
        "enabled must be true or false".to_string(),
    ))?;
    state
        .db
        .set_server_pref(PREFETCH_PREF, if on { "on" } else { "off" })
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "enabled": on })))
}

/// `POST /api/stems/prefetch/liked` - whether Liked is separated ahead.
pub async fn set_liked(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((
            StatusCode::FORBIDDEN,
            "only an admin can change what the server does in the background".to_string(),
        ));
    }
    let on = body.get("enabled").and_then(|v| v.as_bool()).ok_or((
        StatusCode::BAD_REQUEST,
        "enabled must be true or false".to_string(),
    ))?;
    state
        .db
        .set_server_pref(LIKED_PREF, if on { "on" } else { "off" })
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "enabled": on })))
}

/// `POST /api/stems/prune` - delete the separations nothing asks to keep.
///
/// The keep set is exactly what the prefetcher maintains: Liked while its
/// switch is on, plus the lists that opted in. Everything else is a leftover
/// of the old rule that separated anything ever filed anywhere, which is how
/// the cache outgrew its disk.
///
/// `?dry=1` answers with the count and the bytes and deletes nothing, because
/// the only safe way to offer a bulk delete is to let it be read first.
///
/// Deleting is safe in the sense that matters: a stem is derived from a file
/// the server still has, so the worst case is separating it again on the next
/// ask. It is not safe in TIME - a re-separation is minutes of GPU - which is
/// why it is admin-only and deliberate rather than automatic.
pub async fn prune(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((
            StatusCode::FORBIDDEN,
            "only an admin can clear the server's separations".to_string(),
        ));
    }
    let dry = params.get("dry").map(|v| v == "1").unwrap_or(false);
    let doomed = state.db.stems_outside_keep(liked_wanted(&state));
    let bytes = state.db.stems_bytes_for(&doomed.iter().map(|(id, _)| *id).collect::<Vec<_>>());
    if dry {
        return Ok(Json(json!({
            "dry": true,
            "tracks": doomed.len(),
            "bytes": bytes,
        })));
    }
    let root = stem_root(&state);
    for (track_id, paths) in &doomed {
        for rel in paths {
            let _ = tokio::fs::remove_file(root.join(rel)).await;
        }
        let _ = tokio::fs::remove_dir_all(root.join(track_id.to_string())).await;
        let _ = state.db.forget_stems(*track_id);
        // The same cooldown eviction uses: forget_stems erases every record
        // that the song was separated, and without this the prefetcher would
        // queue it again the moment it qualified.
        let _ = state.db.note_stem_eviction(*track_id, PREFETCH_COOLDOWN_MS);
    }
    eprintln!("[stems] pruned {} song(s) outside the keep set", doomed.len());
    Ok(Json(json!({ "tracks": doomed.len(), "bytes": bytes })))
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

/// Per-stem playback gains, as `(name, gain)` pairs. Wire form is `name:gain`
/// comma-separated - `vocals:0.2,drums:0` - so a part can sit FAINT rather than
/// only in or out. The name is filtered to the registry (nothing a caller
/// writes reaches an ffmpeg arg) and the gain clamped to [0, 1]; a stem absent
/// from the list plays at full. `None` when nothing parseable was asked for.
pub fn parse_levels(raw: Option<&String>) -> Option<Vec<(String, f32)>> {
    let raw = raw?;
    let mut out = Vec::new();
    for pair in raw.split(',') {
        let mut it = pair.splitn(2, ':');
        let name = it.next().unwrap_or("").trim();
        let Some(gain) = it.next() else { continue };
        if !STEMS.contains(&name) {
            continue;
        }
        let Ok(g) = gain.trim().parse::<f32>() else { continue };
        if !g.is_finite() {
            continue;
        }
        out.push((name.to_string(), g.clamp(0.0, 1.0)));
    }
    (!out.is_empty()).then_some(out)
}

/// The old `drop` param expressed as levels: every dropped part at gain 0, so
/// one code path serves both a client that sends `lvl` and one that has not yet
/// updated and still sends `drop`.
pub fn levels_from_drop(raw: Option<&String>) -> Option<Vec<(String, f32)>> {
    let dropped = parse_drop(raw);
    (!dropped.is_empty()).then(|| dropped.into_iter().map(|s| (s, 0.0)).collect())
}

/// For a separated track, the `(stem file, gain)` list to mix: every stem that
/// exists on disk, at the gain the levels ask for (default 1.0 when unlisted),
/// with a fully-silent stem left out entirely so it costs no decode.
///
/// Empty when nothing is actually attenuated (all gains are full) or the track
/// has no stems - the caller then transcodes the original file, which IS the
/// mix, rather than paying six decodes to reconstruct something identical.
pub fn leveled_stem_inputs(
    state: &AppState,
    track_id: i64,
    levels: Option<&[(String, f32)]>,
) -> Vec<(PathBuf, f32)> {
    let Some(levels) = levels else { return Vec::new() };
    if levels.iter().all(|(_, g)| *g >= 0.999) {
        return Vec::new();
    }
    let root = stem_root(state);
    let mut out = Vec::new();
    for stem in STEMS {
        let gain = levels.iter().find(|(n, _)| n == stem).map(|(_, g)| *g).unwrap_or(1.0);
        if gain <= 0.001 {
            continue;
        }
        let Some(rel) = state.db.stem_path(track_id, stem, MODEL) else { continue };
        let path = root.join(rel);
        if path.is_file() {
            out.push((path, gain));
        }
    }
    out
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
