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
//! Storage is the constraint that shaped the rest. Four stems of lossless
//! audio is roughly four times the album it came from; at ~4,600 tracks that
//! is more disk than the library itself. So stems are Opus (transparent for
//! this purpose, ~4 MB a stem) and the whole cache is budgeted and evicted
//! coldest-first, exactly like the phone's download cache. A stem is never
//! the only copy of anything - the original file is still there - so evicting
//! one costs a re-separation, not data.

use crate::auth;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

/// The separator, and part of a stem's identity: a better model later can sit
/// beside what is already on disk instead of quietly mixing two qualities.
const MODEL: &str = "htdemucs";
/// What demucs produces, in the order the pads want them.
const STEMS: [&str; 4] = ["vocals", "drums", "bass", "other"];
/// How much disk the stem cache may hold before the coldest track is dropped.
/// Generous, because the volume has room and a re-separation is minutes.
const BUDGET_BYTES: i64 = 120 * 1024 * 1024 * 1024;
/// Never let the cache push the volume below this much free.
const KEEP_FREE_BYTES: i64 = 20 * 1024 * 1024 * 1024;
/// A separation that has not finished by now is not going to.
const TIMEOUT: Duration = Duration::from_secs(900);
/// How often the worker looks for something to do when idle.
const IDLE: Duration = Duration::from_secs(20);
/// Opus bitrate per stem. A stem is simpler spectral content than a full mix,
/// so this is past transparent for chopping and looping.
const OPUS_KBPS: &str = "128";

/// Where stems live: `<data>/stems/<trackId>/<stem>.opus`.
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
        let opus = dest_dir.join(format!("{stem}.opus"));
        let packed = tokio::process::Command::new("ffmpeg")
            .args(["-nostdin", "-v", "error", "-y", "-i"])
            .arg(&wav)
            .args(["-c:a", "libopus", "-b:a", OPUS_KBPS.to_string().as_str(), "-vbr", "on"])
            .arg(&opus)
            .stdin(Stdio::null())
            .status()
            .await;
        match packed {
            Ok(s) if s.success() => {
                let bytes = tokio::fs::metadata(&opus)
                    .await
                    .map(|m| m.len() as i64)
                    .unwrap_or(0);
                let rel_path = format!("{track_id}/{stem}.opus");
                let _ = state.db.save_stem(track_id, stem, MODEL, &rel_path, bytes);
                filed += 1;
            }
            _ => {
                // One stem failing to pack is not worth losing the other
                // three over; the client shows what exists.
                eprintln!("[stems] track {track_id}: could not pack {stem}");
            }
        }
    }

    let _ = tokio::fs::remove_dir_all(&scratch).await;
    if filed == 0 {
        return Err("demucs produced nothing this could read".to_string());
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
    let (job_state, error, rows) = state.db.stems_for(track_id);
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
        .stem_path(track_id, &stem)
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
