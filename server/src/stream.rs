//! Delivering bytes: original-file direct play, cover art, and the optional
//! transcode.
//!
//! **Direct play is the point.** A lossless library streamed losslessly is just
//! the file, served with byte ranges - no decode, no re-encode, no per-listener
//! CPU beyond a `sendfile`. FLAC and ALAC both play natively in the WebViews
//! this app runs in (WKWebView on iOS, Chromium's on Android and the desktop),
//! so the `<audio>` element that plays a local file plays a remote one the same
//! way and the analyser graph reads it the same way. That is why the client
//! needed no player changes to gain a server.
//!
//! Transcoding exists for the other case - a phone on a metered cellular link
//! that would rather have 256k AAC than 900k FLAC - and is strictly opt-in. It
//! costs a core per stream, which on a one-vCPU box is the whole machine, so
//! nothing reaches for it unless asked.

use crate::auth;
use crate::scan;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// Resolves a library-relative path against the music root, refusing anything
/// that climbs out of it.
///
/// These paths come from the index, which built them with `strip_prefix` on its
/// own walk, so they are already contained. This checks anyway: the cost is one
/// `canonicalize` on a request that is about to read a file regardless, and the
/// failure it prevents is serving `/etc/shadow` to anyone who ever manages to
/// get a `../` into the database.
pub fn resolve_in_root(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let candidate = root.join(rel);
    let real = candidate.canonicalize().ok()?;
    let real_root = root.canonicalize().ok()?;
    real.starts_with(&real_root).then_some(real)
}

/// The Content-Type an audio file streams under, by extension.
///
/// Curated rather than guessed, because the guess loses on the platform that
/// matters most: `mime_guess` labels `.m4a` as `audio/m4a`, which is not a
/// registered type, and iOS's media engine - unlike Chromium's - refuses a
/// source whose declared type it does not recognise rather than sniffing the
/// bytes. The result was every m4a in the library failing on iPhone with
/// MEDIA_ERR_SRC_NOT_SUPPORTED while playing fine in the desktop app. The
/// registered name for AAC/ALAC in an MP4 container is `audio/mp4`.
fn audio_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("m4a" | "m4b" | "mp4" | "alac") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("aiff" | "aif") => "audio/aiff",
        // Opus almost always travels in an Ogg container; audio/ogg covers
        // both it and Vorbis, and Safari keys on the container either way.
        Some("ogg" | "oga" | "opus") => "audio/ogg",
        Some("aac") => "audio/aac",
        Some("wma") => "audio/x-ms-wma",
        Some("ape") => "audio/x-ape",
        Some("wv") => "audio/x-wavpack",
        _ => "application/octet-stream",
    }
}

/// Checks the `t=` stream token on a media request.
fn caller_from_query(state: &AppState, params: &HashMap<String, String>) -> Result<i64, StatusCode> {
    let token = params.get("t").ok_or(StatusCode::UNAUTHORIZED)?;
    auth::verify_stream_token(&state.db, &state.stream_secret, token).ok_or(StatusCode::UNAUTHORIZED)
}

/// A media request may also authenticate the ordinary way. Handy for `curl`
/// and for any client that can set headers - the query token exists for
/// `<audio src>`, which cannot.
pub fn caller_from_either(
    state: &AppState,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
) -> Result<i64, StatusCode> {
    if let Ok(caller) = auth::require_caller(&state.db, headers) {
        return Ok(caller.id);
    }
    caller_from_query(state, params)
}

/// `GET /api/stream/:id` - the original file, with byte ranges.
///
/// `ServeFile` does the whole HTTP dance: `Range`, `If-Range`, `ETag`,
/// `Last-Modified`, `206 Partial Content` and the multipart form of it. That
/// matters more than it sounds: a media element seeking in a 40 MB FLAC issues
/// range requests constantly, and getting `206` handling subtly wrong is the
/// difference between a scrub bar that works and one that re-downloads the
/// track on every drag.
pub async fn stream(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    caller_from_either(&state, &headers, &params)?;

    let rel = state.db.track_rel_path(id).ok_or(StatusCode::NOT_FOUND)?;
    let path = resolve_in_root(&state.music_root, &rel).ok_or(StatusCode::NOT_FOUND)?;

    let mime = audio_mime(&path);

    let mut response = ServeFile::new_with_mime(
        &path,
        &mime.parse().unwrap_or(mime_guess::mime::APPLICATION_OCTET_STREAM),
    )
    .oneshot(request)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_response();

    // The client asks for these two by name: the badge that says a stream is
    // lossless, and the length it needs before metadata has loaded.
    let track_headers = response.headers_mut();
    track_headers.insert(
        "x-attackfm-track",
        id.to_string().parse().unwrap_or_else(|_| "0".parse().unwrap()),
    );
    Ok(response)
}

/// `GET /api/art/:artId` - a cached cover.
///
/// Immutable by construction: the id IS the content hash, so a cover can be
/// cached in the client forever and a changed cover is simply a different URL.
pub async fn art(
    State(state): State<Arc<AppState>>,
    AxumPath(art_id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    caller_from_either(&state, &headers, &params)?;

    let path = scan::art_path(&state.art_dir, &art_id).ok_or(StatusCode::NOT_FOUND)?;
    let mut response = ServeFile::new(&path)
        .oneshot(request)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "public, max-age=31536000, immutable".parse().unwrap(),
    );
    Ok(response)
}

/// Whether an `ffmpeg` is on the PATH. Checked once, at boot: the answer
/// decides whether the transcode endpoint is offered at all, and the client
/// reads it from `/api/server` so it can grey the option out rather than
/// offering a quality setting that would 503.
pub fn ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `GET /api/transcode/:id?bitrate=&seek=` - a re-encoded stream.
///
/// The body is ffmpeg's stdout piped straight through, so there is no length
/// and no byte ranges to offer: a live encode has no addressable end. Seeking
/// is therefore a fresh request with `seek=<seconds>`, which is what `-ss`
/// before `-i` costs almost nothing to honour. The client's player knows to
/// re-request rather than to scrub when it is on this path.
pub async fn transcode(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    caller_from_either(&state, &headers, &params)?;
    if !state.ffmpeg {
        // Nothing to fall back to here: the caller asked for a re-encode, and
        // silently handing back the original would blow the data budget that
        // made them ask.
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let rel = state.db.track_rel_path(id).ok_or(StatusCode::NOT_FOUND)?;
    let path = resolve_in_root(&state.music_root, &rel).ok_or(StatusCode::NOT_FOUND)?;

    // Clamped rather than trusted: the bitrate lands on an ffmpeg command line.
    let bitrate = params
        .get("bitrate")
        .and_then(|b| b.parse::<u32>().ok())
        .unwrap_or(256)
        .clamp(64, 512);
    let seek = params
        .get("seek")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .unwrap_or(0.0);

    let mut command = tokio::process::Command::new("ffmpeg");
    // -ss before -i seeks by keyframe index instead of decoding up to the
    // point, which is the difference between instant and a minute.
    if seek > 0.0 {
        command.arg("-ss").arg(format!("{seek:.3}"));
    }
    command
        .arg("-i")
        .arg(&path)
        .args(["-map", "0:a:0"])
        .args(["-c:a", "aac"])
        .args(["-b:a", &format!("{bitrate}k")])
        // ADTS: a self-framing stream a media element can start playing from
        // the first packet, without a container index it will never receive.
        .args(["-f", "adts"])
        .args(["-loglevel", "error"])
        .arg("-")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        // Without this the encoder outlives a listener who skips track, and a
        // one-core box collects orphans until it has no core left.
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let stdout = child.stdout.take().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    // The child is moved into a task that reaps it, so the process is waited on
    // rather than left a zombie once the body is done.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    let stream = tokio_util_reader_stream(stdout);
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "audio/aac"),
            (header::CACHE_CONTROL, "no-store"),
            // Says plainly what the body cannot do, so a client does not try to
            // scrub a pipe.
            (header::ACCEPT_RANGES, "none"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

/// Adapts an async reader into the stream `Body::from_stream` wants, without
/// pulling in `tokio-util` for the one thing it would be used for.
fn tokio_util_reader_stream<R>(reader: R) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    use tokio::io::AsyncReadExt;
    futures_util::stream::unfold(reader, |mut reader| async move {
        let mut buf = vec![0u8; 32 * 1024];
        match reader.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(buf), reader))
            }
            Err(e) => Some((Err(e), reader)),
        }
    })
}
