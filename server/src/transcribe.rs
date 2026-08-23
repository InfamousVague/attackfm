//! Transcribing a book, so the words can be read while they are read aloud.
//!
//! NOT live, and that is the design rather than a shortcut. The audio is a
//! file that is not going to change, so transcribing it once ahead of time
//! gives exactly the experience live recognition would - words lighting up in
//! time with the narration - and hands back three things live never could: a
//! transcript you can scroll ahead in, tap to jump to, and search. Running
//! speech recognition on a phone against audio it is streaming would be
//! slower, less accurate, and paid for in battery, to produce something worse.
//!
//! Books only. `kind = 'book'` is checked before anything is queued: pointing
//! this at a music library would spend hours of the box's time producing
//! transcripts of songs nobody asked for.
//!
//! On request only, like separating stems - this is the same kind of expensive,
//! and the same rule applies. A twelve-hour book is an overnight errand on a
//! good machine, not something to start because a file happened to arrive.
//!
//! | Route | What it does |
//! |---|---|
//! | GET  /api/transcribe/status     | is the tool here, and which model |
//! | POST /api/transcribe/{track_id} | queue a book |
//! | GET  /api/transcribe/jobs       | the queue, newest first |
//! | GET  /api/transcribe/{track_id} | the transcript itself, or 404 |

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use crate::{auth, AppState};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The whisper.cpp CLI, by override then PATH then Homebrew's own place.
///
/// `whisper-cli` is what the current formula installs; older builds called the
/// same program `main`, which is too generic a name to go looking for on a
/// PATH - so it is only accepted from an explicit override.
fn whisper_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AFM_WHISPER_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    for name in ["whisper-cli", "whisper-cpp"] {
        if let Ok(out) = std::process::Command::new("which").arg(name).output() {
            if out.status.success() {
                let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !found.is_empty() {
                    return Some(PathBuf::from(found));
                }
            }
        }
    }
    for guess in ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"] {
        let p = PathBuf::from(guess);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// The model weights. Kept in the DATA directory rather than beside the binary:
/// it is state the operator chose, it is large, and it should travel with the
/// rest of the server's data rather than be reinstalled by a package manager.
fn whisper_model(state: &AppState) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AFM_WHISPER_MODEL") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let dir = state.data_dir.join("whisper");
    // Best first: a better model already there wins over the default.
    for name in [
        "ggml-medium.en.bin",
        "ggml-medium.bin",
        "ggml-small.en.bin",
        "ggml-small.bin",
        "ggml-base.en.bin",
        "ggml-base.bin",
        "ggml-tiny.en.bin",
        "ggml-tiny.bin",
    ] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

// --- The queue ---------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeJob {
    pub id: String,
    pub track_id: i64,
    pub title: String,
    /// queued | preparing | transcribing | done | error
    pub state: String,
    pub error: String,
    pub lines: i64,
    pub queued_at: i64,
}

#[derive(Default)]
pub struct TranscribeState {
    pub jobs: tokio::sync::Mutex<Vec<TranscribeJob>>,
    /// One at a time. Whisper will take every core it is given, and a second
    /// job would not finish the first any sooner - it would only make both
    /// slower and the box unusable while they ran.
    pub running: tokio::sync::Mutex<()>,
}

impl TranscribeState {
    pub fn new() -> Self {
        Self::default()
    }
}

async fn set_job(state: &Arc<AppState>, id: &str, f: impl FnOnce(&mut TranscribeJob)) {
    let mut jobs = state.transcribe.jobs.lock().await;
    if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
        f(j);
    }
}

// --- Routes ------------------------------------------------------------------

/// `GET /api/transcribe/status`
pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let bin = whisper_bin();
    let model = whisper_model(&state);
    Ok(Json(json!({
        "available": bin.is_some() && model.is_some(),
        "toolInstalled": bin.is_some(),
        "model": model
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string()),
        // WHERE it wants one. A missing model is the likeliest state this
        // endpoint reports and the hardest to act on, because the answer is a
        // path only the server knows - the data directory is chosen at install
        // time and is not guessable from a phone. Sent so the app can show it
        // rather than leaving somebody to find it.
        "modelDir": state.data_dir.join("whisper").to_string_lossy().to_string(),
    })))
}

/// `GET /api/transcribe/jobs`
pub async fn jobs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let jobs = state.transcribe.jobs.lock().await.clone();
    Ok(Json(json!({ "jobs": jobs.into_iter().rev().collect::<Vec<_>>() })))
}

/// `GET /api/transcribe/{track_id}` - the lines, for the surface that reads
/// along. 404 rather than an empty list, so "not made yet" and "made, and this
/// book is silent" stay different answers.
pub async fn get(
    State(state): State<Arc<AppState>>,
    AxumPath(track_id): AxumPath<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some(lines) = state.db.transcript(track_id) else {
        return Err((StatusCode::NOT_FOUND, "no transcript for that book".into()));
    };
    let parsed: Value = serde_json::from_str(&lines).unwrap_or(Value::Array(vec![]));
    Ok(Json(json!({ "trackId": track_id, "lines": parsed })))
}

/// `POST /api/transcribe/{track_id}` - queue a book.
pub async fn queue(
    State(state): State<Arc<AppState>>,
    AxumPath(track_id): AxumPath<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((
            StatusCode::FORBIDDEN,
            "only an admin can spend the server's time transcribing".into(),
        ));
    }
    let Some(track) = state.db.track(track_id) else {
        return Err((StatusCode::NOT_FOUND, "no such track".into()));
    };
    // Books only, checked here rather than trusted from the caller.
    if track.kind != "book" {
        return Err((
            StatusCode::BAD_REQUEST,
            "only audiobooks are transcribed".into(),
        ));
    }
    if whisper_bin().is_none() {
        return Err((
            StatusCode::PRECONDITION_FAILED,
            "this server has no speech recogniser installed".into(),
        ));
    }
    if whisper_model(&state).is_none() {
        return Err((
            StatusCode::PRECONDITION_FAILED,
            "this server has no speech model to read with".into(),
        ));
    }
    if state.db.has_transcript(track_id) {
        return Ok(Json(json!({ "queued": false, "reason": "already transcribed" })));
    }

    let id = format!("tr{track_id}-{}", now_ms());
    {
        let mut jobs = state.transcribe.jobs.lock().await;
        if jobs.iter().any(|j| j.track_id == track_id && j.state != "done" && j.state != "error") {
            return Ok(Json(json!({ "queued": false, "reason": "already in the queue" })));
        }
        jobs.push(TranscribeJob {
            id: id.clone(),
            track_id,
            title: track.title.clone(),
            state: "queued".into(),
            error: String::new(),
            lines: 0,
            queued_at: now_ms(),
        });
        // The queue is a record of this run, not a ledger. Old finished jobs
        // are dropped so a long-lived server does not grow one for ever.
        let len = jobs.len();
        if len > 40 {
            jobs.drain(0..len - 40);
        }
    }

    let worker_state = state.clone();
    let worker_id = id.clone();
    tokio::spawn(async move { run(worker_state, worker_id, track_id).await });
    Ok(Json(json!({ "queued": true, "id": id })))
}

/// `POST /api/transcribe/redo` - queue every transcribed book whose lines
/// lack per-word clocks, so a library transcribed before word tracking
/// catches up. Admin, like queueing one: this spends hours of the box's
/// time. Existing transcripts stay readable until their replacement lands -
/// the worker overwrites on completion, never deletes up front.
pub async fn redo(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((
            StatusCode::FORBIDDEN,
            "only an admin can spend the server's time transcribing".into(),
        ));
    }
    if whisper_bin().is_none() || whisper_model(&state).is_none() {
        return Err((
            StatusCode::PRECONDITION_FAILED,
            "this server has no speech recogniser or model".into(),
        ));
    }
    let wanting = state.db.transcripts_without_words();
    let mut queued = 0;
    for track_id in &wanting {
        let Some(track) = state.db.track(*track_id) else { continue };
        let id = format!("tr{track_id}-{}", now_ms());
        {
            let mut jobs = state.transcribe.jobs.lock().await;
            if jobs
                .iter()
                .any(|j| j.track_id == *track_id && j.state != "done" && j.state != "error")
            {
                continue;
            }
            jobs.push(TranscribeJob {
                id: id.clone(),
                track_id: *track_id,
                title: track.title.clone(),
                state: "queued".into(),
                error: String::new(),
                lines: 0,
                queued_at: now_ms(),
            });
            let len = jobs.len();
            if len > 40 {
                jobs.drain(0..len - 40);
            }
        }
        let worker_state = state.clone();
        let tid = *track_id;
        tokio::spawn(async move { run(worker_state, id, tid).await });
        queued += 1;
    }
    Ok(Json(json!({ "queued": queued, "considered": wanting.len() })))
}

// --- The work ----------------------------------------------------------------

async fn run(state: Arc<AppState>, job_id: String, track_id: i64) {
    let _one_at_a_time = state.transcribe.running.lock().await;

    let fail = |msg: String| {
        let state = state.clone();
        let job_id = job_id.clone();
        async move {
            set_job(&state, &job_id, |j| {
                j.state = "error".into();
                j.error = msg;
            })
            .await;
        }
    };

    let Some(track) = state.db.track(track_id) else {
        fail("that book is no longer in the library".into()).await;
        return;
    };
    // `track_rel_path` rather than a field: Track carries what a client needs
    // to show, and the on-disk location deliberately is not part of that.
    let Some(rel) = state.db.track_rel_path(track_id) else {
        fail("that book is no longer in the library".into()).await;
        return;
    };
    let audio = state.music_root.join(&rel);
    if !audio.is_file() {
        fail("the book's file is missing".into()).await;
        return;
    }
    let (Some(bin), Some(model)) = (whisper_bin(), whisper_model(&state)) else {
        fail("the speech recogniser or its model went away".into()).await;
        return;
    };

    // 1. Whisper wants 16 kHz mono PCM and nothing else. Decoding to that up
    //    front is also the only step that understands m4b, mp3 and flac alike,
    //    so the recogniser never has to.
    set_job(&state, &job_id, |j| j.state = "preparing".into()).await;
    let stage = state.data_dir.join("transcribe").join(&job_id);
    if tokio::fs::create_dir_all(&stage).await.is_err() {
        fail("could not make room to work in".into()).await;
        return;
    }
    let wav = stage.join("audio.wav");
    let mut ff = if std::path::Path::new("/usr/bin/nice").exists() {
        let mut c = tokio::process::Command::new("/usr/bin/nice");
        c.arg("-n").arg("15").arg("ffmpeg");
        c
    } else {
        tokio::process::Command::new("ffmpeg")
    };
    ff.arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&audio)
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&wav)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // A long book is a long decode; generous, but not unbounded.
    let decoded = tokio::time::timeout(Duration::from_secs(3600), ff.status()).await;
    if !matches!(decoded, Ok(Ok(s)) if s.success()) || !wav.is_file() {
        let _ = tokio::fs::remove_dir_all(&stage).await;
        fail("could not decode that book to something readable".into()).await;
        return;
    }

    // 2. The reading itself. Hours, for a book - hence no timeout that could
    //    kill a job that is working, only the one-at-a-time lock above.
    set_job(&state, &job_id, |j| j.state = "transcribing".into()).await;
    let out_base = stage.join("out");
    /*
     * Politely. Whisper takes every core it can see, and on the same box that
     * serves the library that reads as the SERVER going down: the app's log
     * filled with "could not connect" bursts that tracked transcription jobs
     * exactly. `nice` keeps the recogniser at the back of the queue - the
     * book takes somewhat longer and nobody's music stops answering.
     */
    let mut wh = if std::path::Path::new("/usr/bin/nice").exists() {
        let mut c = tokio::process::Command::new("/usr/bin/nice");
        c.arg("-n").arg("15").arg(&bin);
        c
    } else {
        tokio::process::Command::new(&bin)
    };
    wh.arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&wav)
        // One WORD per segment: the reading face follows the narrator word by
        // word, and whisper's own per-token clock is the only honest source
        // for that. Lines are still merged below exactly as before - the
        // segments arrive finer, the shape stored stays sentence-sized.
        .arg("--max-len")
        .arg("1")
        .arg("--split-on-word")
        .arg("--output-json")
        .arg("--output-file")
        .arg(&out_base)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let read = wh.status().await;
    let json_path = stage.join("out.json");
    if !matches!(read, Ok(s) if s.success()) || !json_path.is_file() {
        let _ = tokio::fs::remove_dir_all(&stage).await;
        fail("the recogniser could not read that book".into()).await;
        return;
    }

    // 3. Whisper's shape into ours: `[{startMs, endMs, text}]`, which is the
    //    same timed-line shape the app already draws for synced lyrics.
    let raw = tokio::fs::read(&json_path).await.unwrap_or_default();
    let parsed: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    /*
     * Merged toward sentence-sized lines as they are stored. Whisper's
     * segments run a few seconds each, which is the right grain for karaoke
     * and the wrong one for an audiobook: a long book becomes tens of
     * thousands of rows that every reader downstream then has to defend
     * against. Ten seconds a line reads naturally, keeps an eighteen-hour
     * book under seven thousand lines, and loses nothing anyone taps for.
     */
    const MERGE_MS: i64 = 10_000;
    // A line under construction: its window, its text, and each word with the
    // moment it is spoken. Words ride the stored lines as compact pairs
    // ([startMs, "word"]) - an eighteen-hour book is ninety thousand of them,
    // and the pair form is half the size of objects saying the same thing.
    let mut lines: Vec<Value> = Vec::new();
    let mut words: Vec<Value> = Vec::new();
    let mut open: Option<(i64, i64, String)> = None;
    let mut close = |open: &mut Option<(i64, i64, String)>,
                     words: &mut Vec<Value>,
                     lines: &mut Vec<Value>| {
        if let Some((start, end, text)) = open.take() {
            lines.push(json!({
                "startMs": start,
                "endMs": end,
                "text": text.trim(),
                "words": std::mem::take(words),
            }));
        }
    };
    if let Some(segments) = parsed.get("transcription").and_then(|t| t.as_array()) {
        for seg in segments {
            let text = seg
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if text.is_empty() {
                continue;
            }
            let from = seg
                .get("offsets")
                .and_then(|o| o.get("from"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let to = seg
                .get("offsets")
                .and_then(|o| o.get("to"))
                .and_then(|v| v.as_i64())
                .unwrap_or(from);
            // Extend the open line while it is still short; close it and
            // start anew once it has had its ten seconds.
            match &mut open {
                Some((start, end, line)) if to - *start < MERGE_MS => {
                    line.push(' ');
                    line.push_str(&text);
                    *end = to;
                }
                _ => {
                    close(&mut open, &mut words, &mut lines);
                    open = Some((from, to, text.clone()));
                }
            }
            words.push(json!([from, text]));
        }
    }
    close(&mut open, &mut words, &mut lines);
    let _ = tokio::fs::remove_dir_all(&stage).await;

    if lines.is_empty() {
        fail("the recogniser found no speech in that book".into()).await;
        return;
    }

    let count = lines.len() as i64;
    let model_name = model
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if state
        .db
        .set_transcript(track_id, &Value::Array(lines).to_string(), &model_name)
        .is_err()
    {
        fail("could not save the transcript".into()).await;
        return;
    }
    set_job(&state, &job_id, |j| {
        j.state = "done".into();
        j.lines = count;
    })
    .await;

    // The words are down; now say what each chapter is. Detached, because
    // naming is the AI's errand and the transcription queue should not wait
    // on a model that might not even be configured.
    let st = state.clone();
    tokio::spawn(async move {
        crate::chapter_blurbs::generate_for_track(&st, track_id).await;
    });
}
