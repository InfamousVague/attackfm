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
const TIMEOUT: Duration = Duration::from_secs(900);
/// How often the worker looks for something to do when idle.
const IDLE: Duration = Duration::from_secs(20);
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
            let Some((track_id, rel)) = state.db.next_stem_job() else {
                tokio::time::sleep(IDLE).await;
                continue;
            };
            let _ = state.db.mark_stem_job(track_id, "running", "");
            match separate(&state, &python, track_id, &rel).await {
                Ok(()) => {
                    let _ = state.db.mark_stem_job(track_id, "done", "");
                    evict_if_needed(&state).await;
                }
                Err(why) => {
                    eprintln!("[stems] track {track_id}: {why}");
                    let _ = state.db.mark_stem_job(track_id, "failed", &why);
                }
            }
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
    let stderr = child.stderr.take();
    let log = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_string(&mut buf).await;
        }
        buf
    });

    let finished = tokio::time::timeout(TIMEOUT, child.wait()).await;
    let out = match finished {
        Err(_) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_dir_all(&scratch).await;
            return Err(format!("timed out after {}s", TIMEOUT.as_secs()));
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
        let packed = tokio::process::Command::new("ffmpeg")
            .args(["-nostdin", "-v", "error", "-y", "-i"])
            .arg(&wav)
            // Lossless, and compression_level 5 because these are written once
            // and read many times: the slower levels buy a few percent of disk
            // for real time on a job that is already minutes long.
            .args(["-c:a", "flac", "-compression_level", "5"])
            .arg(&packed_path)
            .stdin(Stdio::null())
            .output()
            .await;
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
                let _ = state.db.save_stem(track_id, stem, MODEL, &rel_path, bytes);
                filed += 1;
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
    Ok(Json(json!({
        "state": job_state,
        "error": error,
        "available": separator_bin().is_some(),
        "stems": rows
            .into_iter()
            .map(|(stem, _rel, bytes)| json!({ "stem": stem, "bytes": bytes }))
            .collect::<Vec<_>>(),
    })))
}

/// `GET /api/stems/{track}/{stem}` - the audio.
///
/// Read whole rather than ranged: a stem is a few megabytes and the sampler
/// wants all of it decoded into memory anyway, so a range request would only
/// add round trips to the moment before the first pad works.
pub async fn file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((track_id, stem)): AxumPath<(i64, String)>,
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
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "the stem file has gone".to_string()))?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "audio/ogg")
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .body(Body::from(bytes))
        .unwrap())
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
