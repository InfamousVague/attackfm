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
///
/// Through the verified-token cache: a page of album covers is fifty of these
/// arriving at once, and without the cache each one took its turn on the
/// global database Mutex just to re-read an epoch that changes once a year.
fn caller_from_query(state: &AppState, params: &HashMap<String, String>) -> Result<i64, StatusCode> {
    let token = params.get("t").ok_or(StatusCode::UNAUTHORIZED)?;
    auth::verify_stream_token_cached(&state.db, &state.stream_secret, &state.stream_tokens, token)
        .ok_or(StatusCode::UNAUTHORIZED)
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

/// The widths `?size=` will pre-scale a cover to. Two is enough: one for a
/// grid cell, one for a now-playing screen. Any other value - or none - serves
/// the stored original, so a bad parameter degrades to what always worked.
const ART_SIZES: &[u32] = &[160, 640];

/// The `size` parameter, if it names a size this server actually offers.
fn requested_art_size(params: &HashMap<String, String>) -> Option<u32> {
    let size = params.get("size")?.parse::<u32>().ok()?;
    ART_SIZES.contains(&size).then_some(size)
}

/// Where a downscaled variant lives: beside the original, named by the same
/// content hash plus its size. `art_path` can never return it - ids carry no
/// `@` - so variants are invisible to every original-art lookup.
fn art_variant_path(art_dir: &Path, art_id: &str, size: u32) -> PathBuf {
    art_dir.join(format!("{art_id}@{size}.jpg"))
}

/// Whether any entry in `If-None-Match` names one of our validators.
fn if_none_match(headers: &HeaderMap, candidates: &[&str]) -> bool {
    let Some(raw) = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    raw.split(',').map(str::trim).any(|entry| {
        if entry == "*" {
            return true;
        }
        // Weak comparison is the right one for GET revalidation, and a cached
        // entity either is this content hash or is not.
        let entry = entry.strip_prefix("W/").unwrap_or(entry).trim_matches('"');
        candidates.iter().any(|c| *c == entry)
    })
}

/// Builds the `size`-wide JPEG variant of `original` at `dest`, once.
///
/// Blocking work (a full decode of a possibly multi-megabyte image), so it
/// runs on the blocking pool. Returns true when `dest` exists and is servable
/// afterwards. Written to a temp file and renamed into place: two first
/// requests may race here, and the loser's rename simply replaces the winner's
/// identical bytes - nobody ever reads a half-written file.
fn build_art_variant(original: &Path, dest: &Path, size: u32) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    let Ok(bytes) = std::fs::read(original) else { return false };
    let Ok(img) = image::load_from_memory(&bytes) else { return false };
    // resize() preserves aspect ratio within a size x size box and never
    // upscales past sense: a small original is simply re-encoded, so the
    // decode happens once instead of on every request for this size.
    let scaled = if img.width() > size || img.height() > size {
        img.resize(size, size, image::imageops::FilterType::Triangle)
    } else {
        img
    }
    // JPEG has no alpha; covers have no meaningful alpha either.
    .into_rgb8();

    let mut out = Vec::new();
    if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82)
        .encode_image(&scaled)
        .is_err()
    {
        return false;
    }

    let tmp = dest.with_file_name(format!(
        "{}.tmp-{}-{}",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("variant.jpg"),
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    if std::fs::write(&tmp, &out).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    if std::fs::rename(&tmp, dest).is_err() {
        let _ = std::fs::remove_file(&tmp);
        // A failed rename can still mean a concurrent builder won; serve
        // whatever is there if anything is.
        return dest.is_file();
    }
    true
}

/// `GET /api/art/:artId?size=` - a cached cover, optionally pre-scaled.
///
/// Immutable by construction: the id IS the content hash, so a cover can be
/// cached in the client forever and a changed cover is simply a different URL.
/// That makes the caching story unusually clean - the id doubles as a perfect
/// `ETag`, an `If-None-Match` hit is a 304 with no disk touched, and a
/// `?size=160` variant is derived once, cached beside the original, and is
/// just as immutable as its source.
pub async fn art(
    State(state): State<Arc<AppState>>,
    AxumPath(art_id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    caller_from_either(&state, &headers, &params)?;

    // Resolving through art_path also validates the id's alphabet - nothing
    // below builds a path or a header from an id this did not accept.
    let original = scan::art_path(&state.art_dir, &art_id).ok_or(StatusCode::NOT_FOUND)?;

    let size = requested_art_size(&params);
    let original_etag = format!("\"{art_id}\"");
    let variant_etag = size.map(|s| format!("\"{art_id}@{s}\""));

    // A client may hold either representation under this URL: the variant
    // when scaling worked, the original when a request ever fell back. Both
    // derive from the same immutable bytes, so either validator is current.
    let candidates: Vec<&str> = [Some(original_etag.as_str()), variant_etag.as_deref()]
        .into_iter()
        .flatten()
        .map(|tag| tag.trim_matches('"'))
        .collect();
    if if_none_match(&headers, &candidates) {
        let etag = variant_etag.as_deref().unwrap_or(&original_etag);
        return Ok((
            StatusCode::NOT_MODIFIED,
            [
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                (header::ETAG, etag),
            ],
        )
            .into_response());
    }

    // Pick the file to serve: the cached variant, building it on first ask;
    // the original whenever that cannot work.
    let (path, etag) = match size {
        Some(size) => {
            let variant = art_variant_path(&state.art_dir, &art_id, size);
            let ready = variant.is_file() || {
                let original = original.clone();
                let dest = variant.clone();
                tokio::task::spawn_blocking(move || build_art_variant(&original, &dest, size))
                    .await
                    .unwrap_or(false)
            };
            if ready {
                (variant, variant_etag.unwrap_or(original_etag))
            } else {
                // Undecodable original (odd format): serve it as-is, under its
                // own validator so a later fix is still a different tag.
                (original, original_etag)
            }
        }
        None => (original, original_etag),
    };

    let mut response = ServeFile::new(&path)
        .oneshot(request)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CACHE_CONTROL,
        "public, max-age=31536000, immutable".parse().unwrap(),
    );
    if let Ok(value) = etag.parse() {
        response_headers.insert(header::ETAG, value);
    }
    Ok(response)
}

/// Whether an `ffmpeg` is on the PATH. Checked once, at boot: the answer
/// decides whether the transcode endpoint is offered at all, and the client
/// reads it from `/api/server` so it can grey the option out rather than
/// offering a quality setting that would 503.
pub fn ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}


/// The effects a listener may ask for, and the ffmpeg filter each one IS.
///
/// The client sends NAMES, never filter strings. Everything in the right-hand
/// column ends up on an ffmpeg command line, and the rule that keeps that safe
/// is that the vocabulary lives HERE: an unknown name is dropped rather than
/// passed through, so no request can compose a filter of its own. (The bitrate
/// below is clamped for exactly the same reason.)
///
/// Every filter here is in essentially every ffmpeg build - no rubberband, no
/// impulse-response files - so a box that can transcode at all can do all of
/// these. The numbers are not guesses: each was tuned by rendering audio and
/// null-testing it against the dry signal, because the obvious settings turn
/// out to be inaudible. `acrusher` with bit depth alone measured 68 dB below
/// the source (nothing); it needs `samples` - the sample-rate decimation - to
/// be the sound anybody means by "crushed". A soft clipper needs far more gain
/// into it than seems reasonable: +6 dB gave 0.2% distortion, and it takes
/// about +24 dB to reach the few-percent range a real pedal lives in.
///
/// The first field is the stage, which fixes the ORDER the chain is built in.
/// A multi-select hands us a set, not a sequence, and a set has no opinion
/// about whether the echo comes before or after the filter - but the ear does.
/// So the chain is always assembled dirt -> tone -> movement -> space, the
/// order these boxes sit in on a real desk, however they were clicked.
const FX_SPEED: u8 = 0;
const FX_DIRT: u8 = 1;
const FX_TONE: u8 = 2;
const FX_MOVE: u8 = 3;
const FX_SPACE: u8 = 4;

const EFFECTS: &[(u8, &str, &str)] = &[
    // --- speed ---
    // Tempo only, deliberately: dropping pitch WITH tempo the way a tape does
    // needs the file's true sample rate to compute against, and guessing that
    // wrong turns a slowed song into a chipmunk.
    (FX_SPEED, "slow", "atempo=0.92"),
    (FX_SPEED, "fast", "atempo=1.12"),

    // --- dirt ---
    // The pedal. Soft clipping is what an overdrive actually does: peaks round
    // off instead of squaring, so it grits rather than buzzes. The makeup gain
    // afterwards is what keeps it level with the dry track - and it can be a
    // fixed number because a hard-driven clipper puts out the same level for
    // any input worth listening to, which auto-levels quiet tracks for free.
    (FX_DIRT, "drive", "volume=24dB,asoftclip=type=atan:param=0.5,volume=-11dB"),
    (FX_DIRT, "crush", "acrusher=bits=6:samples=6:mode=log:aa=1:mix=1"),

    // --- tone ---
    // The lofi cornerstone: everything above the mids gone, the way a song
    // sounds through a wall, or off a tape, or from the next room.
    (FX_TONE, "lowpass", "lowpass=f=1800"),
    (FX_TONE, "radio", "highpass=f=400,lowpass=f=3000"),
    (FX_TONE, "warm", "highpass=f=45,lowpass=f=11000,volume=2dB"),

    // --- movement ---
    // The wobble of a tape that has been played too many times.
    (FX_MOVE, "wow", "vibrato=f=2.2:d=0.15"),
    (FX_MOVE, "tremolo", "tremolo=f=5:d=0.5"),
    (FX_MOVE, "phaser", "aphaser=type=t:decay=0.4"),

    // --- space ---
    // Cheap rooms. aecho rather than a convolver, which would want an impulse
    // response file that would then have to exist on every server.
    (FX_SPACE, "room", "aecho=0.8:0.85:45:0.3"),
    (FX_SPACE, "hall", "aecho=0.8:0.9:250:0.35"),

    // --- the whole point ---
    // "Lofi" is not one filter, it is a chain, and asking someone to find the
    // five that make it is asking them to already know. So it is one switch:
    // a little dirt, the bits dropped, the top and bottom taken off, and the
    // tape wobble over it. Stacks with the rest - lofi plus room is lofi in a
    // room - because it sits at the tone stage and the others sit elsewhere.
    (
        FX_TONE,
        "lofi",
        "volume=10dB,asoftclip=type=atan:param=0.8,volume=-6dB,\
acrusher=bits=8:samples=4:mode=log:aa=1:mix=0.8,\
highpass=f=120,lowpass=f=3400,vibrato=f=2.2:d=0.15",
    ),
];

/// Turns a requested `fx` list into one `-af` chain: known names only, in
/// signal-chain order, with a limiter on the end because stacking any of these
/// can push the sum past full scale and clipping is not one of the effects.
fn effect_chain(fx: Option<&String>) -> Option<String> {
    let asked = fx?;
    let mut picked: Vec<(u8, &str)> = Vec::new();
    for name in asked.split(',').map(|n| n.trim()).filter(|n| !n.is_empty()).take(12) {
        if let Some((stage, _, filter)) = EFFECTS.iter().find(|(_, id, _)| *id == name) {
            if !picked.iter().any(|(_, f)| f == filter) {
                picked.push((*stage, filter));
            }
        }
    }
    if picked.is_empty() {
        return None;
    }
    // Stable sort: the desk order across stages, click order within one.
    picked.sort_by_key(|(stage, _)| *stage);
    let mut chain: Vec<&str> = picked.into_iter().map(|(_, f)| f).collect();
    chain.push("alimiter=limit=0.95");
    Some(chain.join(","))
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
    command.arg("-i").arg(&path).args(["-map", "0:a:0"]);
    // The effects, when any were asked for and recognised.
    if let Some(chain) = effect_chain(params.get("fx")) {
        command.args(["-af", &chain]);
    }
    command
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

#[cfg(test)]
mod effect_tests {
    use super::*;

    fn chain(s: &str) -> Option<String> {
        effect_chain(Some(&s.to_string()))
    }

    #[test]
    fn nothing_asked_is_no_chain() {
        assert!(effect_chain(None).is_none());
        assert!(chain("").is_none());
        assert!(chain("   ,  ,").is_none());
    }

    /// The one that matters: unknown names are DROPPED, never forwarded. Every
    /// string here is an attempt to reach the ffmpeg command line.
    #[test]
    fn unknown_names_never_reach_ffmpeg() {
        for probe in [
            "definitely_not_a_filter",
            "volume=99dB",
            "lowpass=f=1800",              // a real filter, but spelled as one
            "drive; rm -rf /",
            "drive'",
            "$(reboot)",
            "../../etc/passwd",
            "amovie=/etc/passwd",          // ffmpeg's own file-reading source
        ] {
            assert!(chain(probe).is_none(), "leaked: {probe}");
        }
        // A known name alongside junk keeps only the known one.
        let c = chain("lowpass,volume=99dB,amovie=/etc/passwd").unwrap();
        assert_eq!(c, "lowpass=f=1800,alimiter=limit=0.95");
    }

    #[test]
    fn known_names_become_their_filters() {
        assert!(chain("lowpass").unwrap().starts_with("lowpass=f=1800"));
        assert!(chain("drive").unwrap().contains("asoftclip"));
        assert!(chain("lofi").unwrap().contains("acrusher"));
    }

    /// However they were clicked, the chain comes out in desk order.
    #[test]
    fn chain_is_built_in_signal_order() {
        let c = chain("hall,lowpass,slow,drive,wow").unwrap();
        let at = |needle: &str| c.find(needle).expect(needle);
        assert!(at("atempo") < at("asoftclip"), "speed before dirt: {c}");
        assert!(at("asoftclip") < at("lowpass"), "dirt before tone: {c}");
        assert!(at("lowpass") < at("vibrato"), "tone before movement: {c}");
        assert!(at("vibrato") < at("aecho"), "movement before space: {c}");
        // Reversing the request must not reverse the chain.
        assert_eq!(c, chain("wow,drive,slow,lowpass,hall").unwrap());
    }

    #[test]
    fn every_chain_ends_limited() {
        for id in EFFECTS.iter().map(|(_, id, _)| *id) {
            let c = chain(id).unwrap_or_else(|| panic!("{id} produced nothing"));
            assert!(c.ends_with("alimiter=limit=0.95"), "{id} unlimited: {c}");
        }
    }

    #[test]
    fn duplicates_collapse_and_the_list_is_bounded() {
        assert_eq!(chain("drive,drive,drive").unwrap(), chain("drive").unwrap());
        // Far more names than the cap, all valid: still bounded.
        let many = vec!["room"; 60].join(",");
        assert_eq!(chain(&many).unwrap(), chain("room").unwrap());
    }

    /// Ids are the contract with the client; nothing may contain a comma (the
    /// separator) or shell/ffmpeg punctuation.
    #[test]
    fn ids_are_plain_words() {
        for (_, id, _) in EFFECTS {
            assert!(
                id.chars().all(|c| c.is_ascii_lowercase()),
                "id {id} is not a plain lowercase word"
            );
        }
    }
}
