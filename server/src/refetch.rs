//! Getting the RIGHT recording, when the importer fetched the wrong one.
//!
//! SpotiFLAC resolves a song by searching its providers for the title and
//! artist it was given, and takes what comes back first. Usually right;
//! sometimes it lands on a live cut, a remix, a radio edit, a sped-up upload,
//! or a different song that happens to share a name. The file is tagged
//! correctly - the tags come from the source - so nothing downstream can tell
//! anything is wrong. Only listening finds it, and by then the file is filed,
//! in playlists, and counted in play history.
//!
//! What makes this fixable is exactly that split: **the tags say what was
//! wanted, and the audio is what arrived.** So a bad track carries its own
//! search query. This module takes the tags, asks the catalogues what else
//! matches, downloads several of the answers side by side, and lets someone
//! listen to them before anything is committed.
//!
//! Nothing is destroyed to do it. Candidates live in their own staging
//! directory and never touch the library; the original keeps playing the whole
//! time. Choosing one files it through the ordinary upload pipeline and then
//! REPOINTS the old track's references onto it (playlists, likes, play counts,
//! listen history - see db::repoint_track_refs), so the song keeps its whole
//! past and only its audio changes. The old file is quarantined rather than
//! deleted, the way resolve_duplicates does it, because "wrong" is a judgement
//! and judgements get revised.

use crate::auth;
use crate::imports::{
    find_spotiflac, per_track_timeout, quality, spotiflac_input, AUDIO_EXTENSIONS,
};
use crate::scan;
use crate::search;
use crate::stream::caller_from_either;
use crate::upload;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower::util::ServiceExt;
use tower_http::services::ServeFile;

/// How many alternates to fetch. Five is the number the ear can actually hold
/// in comparison, and every one costs a provider download.
const MAX_CANDIDATES: usize = 5;

/// Two seconds' difference is the same performance encoded twice; more than
/// that is a different take. Used only to LABEL matching candidates, never to
/// hide them - the judgement about which recording is right belongs to the
/// person listening.
const SAME_TAKE_MS: i64 = 2000;

/// A candidate download that stages no new bytes for this long is wedged, not
/// slow, and is killed so the hunt can settle. The same budget imports uses for
/// its own SpotiFLAC runs, and long enough that a real multi-provider ladder
/// negotiating between services is never mistaken for a stall.
const STALL_SECS: u64 = 420;

/// The most a peer may stream for one delivered alternate. A single audio file,
/// even a long lossless one, is comfortably under this; the ceiling only exists
/// because peer_deliver lifts axum's body cap, so an unbounded stream can't fill
/// the hub's disk.
const MAX_DELIVER_BYTES: u64 = 1024 * 1024 * 1024;

type ApiError = (StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;

fn bad(code: StatusCode, msg: &str) -> ApiError {
    (code, msg.to_string())
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// One thing that might be the song you meant.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub index: usize,
    /// The catalogue the alternate was found in, and the provider it was
    /// pulled from - shown because "the Tidal one" is often how a person
    /// remembers which was right.
    pub source: String,
    /// What the CATALOGUE calls it. Worth showing next to the audio's own
    /// length, because "(Live at Wembley)" in a title is frequently the whole
    /// answer and saves listening at all.
    pub title: String,
    pub artist: String,
    pub album: String,
    /// queued | downloading | ready | failed
    pub state: String,
    pub error: Option<String>,
    /// Of the audio that actually arrived - the number that gives a live take
    /// or an extended mix away before a note is played.
    pub duration_ms: Option<i64>,
    pub size_bytes: Option<u64>,
    pub lossless: bool,
    pub codec: String,
    /// An earlier candidate this one duplicates, if any.
    pub same_as: Option<usize>,
    /// Where it landed. Never leaves the server.
    #[serde(skip)]
    pub file: Option<PathBuf>,
    /// The catalogue URL and forced service (empty = the full ladder) this
    /// candidate is fetched from. Server-only: on a hub with no downloader they
    /// are what a peer (the M4) claims and pulls. Never sent to the client.
    #[serde(skip)]
    pub url: String,
    #[serde(skip)]
    pub service: String,
    /// When a peer took this one to download, so a peer that dies mid-pull frees
    /// the candidate for another to claim rather than pinning it forever. A live
    /// peer keeps this fresh with heartbeats.
    #[serde(skip)]
    pub claimed_at: Option<i64>,
    /// True while a peer is actively streaming this candidate's file in. The
    /// write happens without the jobs lock, so this flag - set under the lock
    /// before the write - is what makes a second delivery to the same slot bounce
    /// instead of racing the first onto disk.
    #[serde(skip)]
    pub delivering: bool,
}

/// The track as it stands, so the modal can show what is being replaced.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTrack {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: Option<i64>,
    pub lossless: bool,
    pub codec: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub track_id: i64,
    /// hunting | ready | done | failed
    pub state: String,
    pub error: Option<String>,
    pub current: CurrentTrack,
    pub candidates: Vec<Candidate>,
    #[serde(skip)]
    pub staging: PathBuf,
    /// Who started it. Only they may commit or scrap it.
    #[serde(skip)]
    pub owner: i64,
    /// True when this hub cannot download for itself and the candidates are
    /// offered to a peer (the M4) to pull and ship back. Set once, in hunt().
    #[serde(skip)]
    pub delegated: bool,
    /// Unix seconds the last thing happened on this job - seeded at start, and
    /// bumped every time a peer claims, delivers, or fails a candidate. A
    /// delegated hunt that goes quiet for too long is failed against this, so a
    /// job whose downloader never answered still settles instead of spinning.
    #[serde(skip)]
    pub last_progress: i64,
}

pub struct RefetchManager {
    jobs: tokio::sync::Mutex<HashMap<String, Job>>,
    staging_root: PathBuf,
    /// Unix seconds of the last contact from ANY downloader peer, over any of
    /// the peer endpoints (claim, deliver, fail, beat). This is how a delegated
    /// hunt tells "the downloader is working, just slowly" from "the downloader
    /// is gone": while this is fresh, no hunt's deadline fires, however long a
    /// single pull takes; once it goes stale every waiting hunt gives up. Global
    /// on purpose - one live peer serving hunt A keeps hunt B from crying that
    /// no import machine exists.
    last_peer_seen: std::sync::atomic::AtomicI64,
}

impl RefetchManager {
    /// Staging is wiped at boot: a hunt interrupted by a restart has no
    /// in-memory job left to claim its files, and an un-claimable download is
    /// just disk. The library is untouched by this either way - nothing here
    /// was ever part of it.
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let staging_root = data_dir.join("refetch");
        let _ = std::fs::remove_dir_all(&staging_root);
        let _ = std::fs::create_dir_all(&staging_root);
        Arc::new(RefetchManager {
            jobs: tokio::sync::Mutex::new(HashMap::new()),
            staging_root,
            last_peer_seen: std::sync::atomic::AtomicI64::new(0),
        })
    }

    /// A peer just touched one of the peer endpoints - remember when, so sweep()
    /// knows the downloader is alive.
    fn note_peer_seen(&self, now: i64) {
        self.last_peer_seen
            .store(now, std::sync::atomic::Ordering::Relaxed);
    }

    fn peer_seen(&self) -> i64 {
        self.last_peer_seen.load(std::sync::atomic::Ordering::Relaxed)
    }
}

fn now_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("rf{n:x}")
}

/// Reads what actually arrived: the length, the format, whether it is lossless.
/// Deliberately not scan::read_track - nothing here is a library row, and the
/// only questions worth asking of a candidate are the ones you would ask
/// before pressing play.
fn probe(path: &Path) -> (Option<i64>, bool, String, u64) {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::probe::Probe;

    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let Ok(tagged) = Probe::open(path).and_then(|p| p.read()) else {
        return (None, false, String::new(), size);
    };
    let props = tagged.properties();
    let duration = i64::try_from(props.duration().as_millis()).ok();
    let file_type = tagged.file_type();
    let lossless = matches!(
        file_type,
        lofty::file::FileType::Flac
            | lofty::file::FileType::Wav
            | lofty::file::FileType::Aiff
            | lofty::file::FileType::Ape
            | lofty::file::FileType::WavPack
    ) || (matches!(file_type, lofty::file::FileType::Mp4) && props.bit_depth().is_some());
    let codec = format!("{file_type:?}").to_lowercase();
    (duration, lossless, codec, size)
}

/// Total bytes staged under a directory - the progress signal the stall
/// watchdog in fetch_one reads. Any movement (a growing partial included)
/// counts as the download still being alive.
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(m) = entry.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/// The first audio file under a directory, wherever the downloader chose to
/// put it (providers disagree about whether to make an album folder).
fn find_audio(dir: &Path) -> Option<PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                return Some(p);
            }
        }
    }
    None
}

/// Builds the shortlist to try.
///
/// Two different things go wrong, and the list has to cover both. Sometimes
/// the SONG is wrong - a cover, a same-named track by somebody else - and the
/// fix is a different search result. Sometimes the song is right and the
/// RECORDING is wrong - the provider had a live album and offered that - and
/// the fix is the same track pulled from a different provider. So the plan is
/// the best match through two providers, then the next distinct results, which
/// covers a wrong take and a wrong song with one list.
async fn plan(
    state: &Arc<AppState>,
    title: &str,
    artist: &str,
) -> Vec<(String, String, String, String, String)> {
    let query = format!("{artist} {title}");
    // spotify_catalog rather than spotify_search: it asks SpotiFLAC's own
    // metadata client first, which is the downloader's view of the catalogue
    // and needs no credentials, and only falls back to the web token. A box
    // without Spotify credentials gets nothing from the raw search.
    // Both catalogues at once. These were awaited one after the other, and
    // nothing downloads until the shortlist exists - so every hunt began by
    // paying for two round trips end to end before the first byte of audio was
    // even asked for. They share nothing; there was never a reason to queue them.
    let (mut found, deezer) = tokio::join!(
        search::spotify_catalog(state, &query),
        search::deezer_search(&query)
    );
    found.extend(deezer);

    // Tracks only. NOT filtered by `importable` - that flag means "SpotiFLAC
    // takes this URL as primary input", and Deezer URLs do not qualify, but
    // spotiflac_input resolves them through song.link before we ever hand one
    // over. Filtering here would throw away every Deezer alternate, which is
    // half the catalogue and often the half holding the studio version.
    let mut seen_urls = std::collections::HashSet::new();
    let tracks: Vec<_> = found
        .into_iter()
        .filter(|r| r.kind == "track" && !r.url.is_empty())
        .filter(|r| seen_urls.insert(r.url.clone()))
        .collect();

    shape(&tracks, artist)
}

/// Casefolded, punctuation dropped - enough to tell "Beyoncé" from "Beyonce"
/// and "The Beatles" from "Beatles, The" without pretending to be clever.
fn norm(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether a result is BY the artist we want, rather than merely mentioning
/// them. Containment either way, because a catalogue writes the same billing
/// as "Daft Punk", "Daft Punk & Pharrell" and "Daft Punk, Pharrell Williams" -
/// but "One More Time (Daft Punk)" credited to a covers act contains the name
/// in its TITLE, not its artist, which is why only the artist field is read.
fn artist_matches(wanted: &str, got: &str) -> bool {
    !wanted.is_empty() && (got.contains(wanted) || wanted.contains(got))
}

/// The shortlist rules, with the network taken out so they can be tested.
///
/// The best match goes in twice under two named providers, because the two
/// failures this feature exists for are different: a provider that matched a
/// live album will match it again, so the same track from a DIFFERENT provider
/// is the fix; while a genuinely wrong song needs a different search result
/// entirely. Doing both in one list means neither case needs diagnosing first.
fn shape(
    tracks: &[search::SearchResult],
    artist: &str,
) -> Vec<(String, String, String, String, String)> {
    // Searching a title turns up karaoke and covers - a real search for one
    // Daft Punk song returns "The Backing Tracks - (As Made Famous By Daft
    // Punk)" and a medley by somebody else. Those are never the answer, and
    // with only five slots each one costs a real alternate. So results by the
    // artist we actually want sort first; the rest keep their order behind
    // them, still reachable when the tags themselves were the thing that was
    // wrong.
    let wanted = norm(artist);
    let mut ranked: Vec<&search::SearchResult> = tracks.iter().collect();
    ranked.sort_by_key(|r| !artist_matches(&wanted, &norm(&r.subtitle)));

    let mut out = Vec::new();
    for (i, r) in ranked.iter().enumerate() {
        if out.len() >= MAX_CANDIDATES {
            break;
        }
        if i == 0 {
            out.push((
                r.url.clone(),
                "deezer".to_string(),
                r.title.clone(),
                r.subtitle.clone(),
                format!("{} · Deezer", r.source),
            ));
            out.push((
                r.url.clone(),
                "tidal".to_string(),
                r.title.clone(),
                r.subtitle.clone(),
                format!("{} · Tidal", r.source),
            ));
            continue;
        }
        out.push((
            r.url.clone(),
            String::new(), // the full ladder
            r.title.clone(),
            r.subtitle.clone(),
            r.source.clone(),
        ));
    }
    out.truncate(MAX_CANDIDATES);
    out
}

/// Pulls one candidate into its own directory. A failure here is this
/// candidate's failure and nobody else's. `pub(crate)` so the peer loop
/// (peersync) can run exactly this download on the box that has SpotiFLAC.
pub(crate) async fn fetch_one(
    state: &Arc<AppState>,
    dir: &Path,
    url: &str,
    service: &str,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let program = find_spotiflac().ok_or_else(crate::imports::no_downloader_here)?;
    let input = spotiflac_input(url).await?;

    let mut args: Vec<String> = vec![input, dir.display().to_string()];
    args.push("--service".to_string());
    if service.is_empty() {
        args.extend(crate::imports::services());
    } else {
        args.push(service.to_string());
    }
    args.push("--quality".to_string());
    args.push(quality());
    args.push("--retries".to_string());
    args.push("1".to_string());
    args.push("--timeout".to_string());
    args.push(per_track_timeout());
    if let Ok(api) = std::env::var("AFM_TIDAL_API") {
        if !api.trim().is_empty() {
            args.push("--tidal-api".to_string());
            args.push(api);
        }
    }
    if let Ok(api) = std::env::var("AFM_QOBUZ_API") {
        if !api.trim().is_empty() {
            args.push("--qobuz-local-api".to_string());
            args.push(api);
        }
    }

    let mut child = tokio::process::Command::new(&program)
        .args(&args)
        .env("HOME", state.imports.sf_home())
        // A real stdin: Python dies in init_sys_streams on a closed fd 0.
        // See the same note in imports::run_job.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("SpotiFLAC would not start: {e}"))?;

    // Drain stdout so a full pipe can never wedge the child (a blocked write
    // reads as a stall below), and collect stderr for the failure message.
    if let Some(mut out) = child.stdout.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut sink = Vec::new();
            let _ = out.read_to_end(&mut sink).await;
        });
    }
    let stderr_task = child.stderr.take().map(|mut err| {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf).await;
            buf
        })
    });

    // The wall-clock backstop this caller lacked, and the whole reason a hunt
    // could never finish. `--timeout` above is only a REQUEST to SpotiFLAC; a
    // wedged download or a dead provider relay can ignore it, and then the
    // child never exits - `.output().await` never returned, fetch_one never
    // resolved, and hunt()'s join awaited it forever, so the job stayed
    // 'hunting' and the modal spun with no error, for every song. Bound it as a
    // STALL (no new bytes staged for STALL_SECS) rather than a hard cap, so the
    // legitimate multi-service ladder - minutes per provider - is never cut off
    // while it is still making progress. Mirrors imports::run_job's watchdog;
    // start_kill + kill_on_drop reap the child.
    let mut last_bytes = 0u64;
    let mut last_progress = std::time::Instant::now();
    let mut stalled = false;
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await {
            Ok(_) => break,
            Err(_) => {
                let bytes = dir_bytes(dir);
                if bytes != last_bytes {
                    last_bytes = bytes;
                    last_progress = std::time::Instant::now();
                }
                if last_progress.elapsed() >= std::time::Duration::from_secs(STALL_SECS) {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    stalled = true;
                    break;
                }
            }
        }
    }
    if stalled {
        return Err(format!("no progress for {STALL_SECS}s — the provider looks stuck"));
    }

    let stderr = match stderr_task {
        Some(t) => t.await.unwrap_or_default(),
        None => Vec::new(),
    };
    find_audio(dir).ok_or_else(|| explain(&stderr))
}

/// Why a candidate did not arrive, in words worth showing someone.
///
/// SpotiFLAC draws a tqdm progress bar on stderr, so the LAST line of a failed
/// run is almost always `Progress: 100%|████...| 1/1` - which is not an error,
/// reads as success, and was what the modal showed. Bars are skipped, and when
/// nothing else was said the honest answer is that this provider had nothing,
/// which is the usual reason: a single-service attempt against a provider that
/// does not carry the track.
fn explain(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        // tqdm bars, and the carriage-return redraws of one.
        .filter(|l| !l.contains('\u{2588}') && !l.contains("%|") && !l.starts_with("Progress:"))
        .filter(|l| !l.starts_with("Downloading") && !l.starts_with("Searching"))
        .next_back()
        .unwrap_or("");
    if line.is_empty() {
        "this provider did not have it".to_string()
    } else {
        line.chars().take(160).collect()
    }
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct KeepBody {
    pub index: usize,
}

/// `POST /api/refetch/{track_id}` - start hunting for the right recording.
pub async fn start(
    State(state): State<Arc<AppState>>,
    AxumPath(track_id): AxumPath<i64>,
    headers: HeaderMap,
) -> ApiResult<Json<Job>> {
    // Replacing a library file is a destructive edit to something everyone on
    // the server shares, so it takes the same rank resolve_duplicates does.
    let caller = auth::require_admin(&state.db, &headers)
        .map_err(|s| (s, "admins only".to_string()))?;

    let track = state
        .db
        .track(track_id)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such track"))?;

    // No local downloader is no longer a dead end. On a hub whose files are
    // filled by a downloader PEER (the M4 running SpotiFLAC and shipping over -
    // see peersync), the alternates are offered to that peer and shipped back to
    // stage here, exactly the way the library is filled. hunt() decides which
    // path this is; if no peer ever answers, the job fails with a plain message
    // rather than refusing up front on a box that can in fact re-fetch.

    /*
     * ALREADY HUNTING FOR THIS TRACK? Hand back the hunt in progress.
     *
     * Every open of the modal used to mint a fresh job and start five provider
     * downloads from nothing, because the previous one was scrapped the moment
     * the modal closed. A hunt can take minutes - the per-candidate timeout is
     * five of them - so anybody who closed the box to go and do something else
     * threw away all of the work and then paid for it again from the top. That
     * is the whole reason alternates "never load": they were being cancelled,
     * not failing.
     *
     * Keyed by track AND owner: the staged files are one admin's pending edit
     * to a shared library, and two people should not silently be steering the
     * same one.
     */
    if let Some(live) = state
        .refetch
        .jobs
        .lock()
        .await
        .values()
        .find(|j| j.track_id == track_id && j.owner == caller.id && j.state != "failed")
    {
        return Ok(Json(live.clone()));
    }

    let id = now_id();
    let staging = state.refetch.staging_root.join(&id);
    let _ = std::fs::create_dir_all(&staging);

    let current = CurrentTrack {
        id: track_id,
        title: track.title.clone(),
        artist: track.artist.clone(),
        album: track.album.clone(),
        duration_ms: track.duration.map(|d| (d * 1000.0) as i64),
        lossless: track.lossless,
        codec: track.codec.clone(),
    };

    let job = Job {
        id: id.clone(),
        track_id,
        state: "hunting".to_string(),
        error: None,
        current,
        candidates: Vec::new(),
        staging: staging.clone(),
        owner: caller.id,
        delegated: false,
        last_progress: now_secs(),
    };
    state.refetch.jobs.lock().await.insert(id.clone(), job.clone());

    // The hunt runs on its own; the caller polls.
    let bg = Arc::clone(&state);
    let job_id = id.clone();
    let title = track.title.clone();
    let artist = track.artist.clone();
    tokio::spawn(async move {
        hunt(bg, job_id, title, artist, staging).await;
    });

    Ok(Json(job))
}

/// Finds the alternates, then pulls them all at once.
async fn hunt(
    state: Arc<AppState>,
    job_id: String,
    title: String,
    artist: String,
    staging: PathBuf,
) {
    let shortlist = plan(&state, &title, &artist).await;

    if shortlist.is_empty() {
        let mut jobs = state.refetch.jobs.lock().await;
        if let Some(job) = jobs.get_mut(&job_id) {
            job.state = "failed".to_string();
            job.error = Some(
                "Nothing else in the catalogues matches this song's title and artist.".to_string(),
            );
        }
        return;
    }

    // Seed the rows so the modal can show what is coming before any of it
    // arrives - five "queued" lines read as progress; an empty box reads as
    // broken.
    {
        let mut jobs = state.refetch.jobs.lock().await;
        let Some(job) = jobs.get_mut(&job_id) else {
            return;
        };
        for (i, (url, service, t, a, source)) in shortlist.iter().enumerate() {
            job.candidates.push(Candidate {
                index: i,
                source: source.clone(),
                title: t.clone(),
                artist: a.clone(),
                album: String::new(),
                state: "queued".to_string(),
                error: None,
                duration_ms: None,
                size_bytes: None,
                lossless: false,
                codec: String::new(),
                same_as: None,
                file: None,
                url: url.clone(),
                service: service.clone(),
                claimed_at: None,
                delivering: false,
            });
        }
    }

    // No downloader here: this hub is filled by a peer. Leave every candidate
    // "queued" and flip the job to delegated - the peer channel (peer_claim /
    // peer_deliver / peer_fail below) pulls them on the M4 and ships them back
    // to stage, and the deadline in sweep() settles the job if none ever comes.
    if find_spotiflac().is_none() {
        let mut jobs = state.refetch.jobs.lock().await;
        if let Some(job) = jobs.get_mut(&job_id) {
            job.delegated = true;
            job.last_progress = now_secs();
        }
        return;
    }

    // All at once: five sequential provider downloads is minutes of staring,
    // and they contend for nothing shared - each has its own directory.
    let mut tasks = Vec::new();
    for (i, (url, service, _, _, _)) in shortlist.into_iter().enumerate() {
        let st = Arc::clone(&state);
        let jid = job_id.clone();
        let dir = staging.join(i.to_string());
        tasks.push(tokio::spawn(async move {
            {
                let mut jobs = st.refetch.jobs.lock().await;
                if let Some(c) = jobs.get_mut(&jid).and_then(|j| j.candidates.get_mut(i)) {
                    c.state = "downloading".to_string();
                }
            }
            let result = fetch_one(&st, &dir, &url, &service).await;
            let mut jobs = st.refetch.jobs.lock().await;
            let Some(job) = jobs.get_mut(&jid) else {
                return;
            };
            match result {
                Ok(path) => mark_candidate_ready(job, i, path),
                Err(e) => {
                    if let Some(c) = job.candidates.get_mut(i) {
                        c.state = "failed".to_string();
                        c.error = Some(e);
                    }
                }
            }
        }));
    }
    for t in tasks {
        let _ = t.await;
    }

    let mut jobs = state.refetch.jobs.lock().await;
    if let Some(job) = jobs.get_mut(&job_id) {
        settle(job);
    }
}

/// A candidate's audio has landed at `path` (whether pulled here or shipped by a
/// peer): probe it, label it against the takes already in, and mark it ready.
/// Shared by the local hunt and the peer-delivery handler so both read exactly
/// the same off a finished file.
fn mark_candidate_ready(job: &mut Job, index: usize, path: PathBuf) {
    let (duration_ms, lossless, codec, size) = probe(&path);
    // Same length as an earlier one means the same performance arrived twice.
    // Labelled, not hidden.
    let same_as = job.candidates.iter().find_map(|other| {
        if other.index >= index || other.state != "ready" {
            return None;
        }
        match (other.duration_ms, duration_ms) {
            (Some(a), Some(b)) if (a - b).abs() <= SAME_TAKE_MS => {
                Some(other.same_as.unwrap_or(other.index))
            }
            _ => None,
        }
    });
    if let Some(c) = job.candidates.get_mut(index) {
        c.state = "ready".to_string();
        c.duration_ms = duration_ms;
        c.lossless = lossless;
        c.codec = codec;
        c.size_bytes = Some(size);
        c.same_as = same_as;
        c.file = Some(path);
        c.claimed_at = None;
        c.delivering = false;
    }
}

/// Move a job off 'hunting' once every candidate is terminal (ready or failed).
/// A hunt with nothing playable is a failed hunt, and says so.
fn settle(job: &mut Job) {
    let done = job
        .candidates
        .iter()
        .all(|c| c.state == "ready" || c.state == "failed");
    if !done {
        return;
    }
    let any = job.candidates.iter().any(|c| c.state == "ready");
    if any {
        job.state = "ready".to_string();
    } else {
        job.state = "failed".to_string();
        job.error = Some("Every alternate failed to download.".to_string());
    }
}

/// Unix seconds. The job's own clock for the delegated deadline; the whole point
/// is elapsed real time, so millisecond precision would be false economy.
fn now_secs() -> i64 {
    crate::db::now_ms() / 1000
}

/// A claim whose peer has not been heard from (no heartbeat, no delivery) for
/// this long is re-offered, so a peer that died mid-pull and came back can take
/// it again. A live peer heartbeats every BEAT well inside this, so a working
/// claim is never yanked. Comfortably above the beat interval, below NO_PEER.
const CLAIM_STALE_SECS: i64 = 120;
/// No contact from ANY peer for this long means the downloader is gone, and
/// every waiting hunt gives up with a plain message. A live peer - claiming,
/// heartbeating, or delivering - refreshes the clock long before this, so a
/// single slow pull (a four-provider ladder, a big upload) never trips it.
const NO_PEER_SECS: i64 = 180;

/// Advance a delegated job against the downloader's liveness. Called wherever a
/// delegated job is read or acted on (status polls, peer claims). The rule is
/// simple: while a peer is in contact the hunt WAITS, no matter how slow one
/// pull is; once the peer has gone silent past NO_PEER_SECS, everything still
/// pending is failed so the job always leaves 'hunting'. `peer_seen` is the
/// global last-contact clock (RefetchManager::peer_seen).
fn sweep(job: &mut Job, now: i64, peer_seen: i64) {
    if !job.delegated || job.state != "hunting" {
        return;
    }
    // Re-offer a claim gone quiet past the stale window - a peer that took it,
    // died without reporting, and its heartbeat stopped. A live peer keeps
    // claimed_at fresh, so this only frees a genuinely dead claim.
    for c in job.candidates.iter_mut() {
        if c.state == "downloading" || c.state == "delivering" {
            if let Some(t) = c.claimed_at {
                if now - t > CLAIM_STALE_SECS {
                    c.state = "queued".to_string();
                    c.claimed_at = None;
                    c.delivering = false;
                }
            }
        }
    }
    // The downloader is alive and in contact: wait. A slow ladder or a large
    // upload is not a stall, and nothing here should end it.
    if now - peer_seen <= NO_PEER_SECS {
        return;
    }
    // Silence past the deadline: the downloader is gone. Nothing still pending
    // will arrive, so fail it and let the job settle on whatever did land.
    let any_ready = job.candidates.iter().any(|c| c.state == "ready");
    for c in job.candidates.iter_mut() {
        if c.state != "ready" && c.state != "failed" {
            c.state = "failed".to_string();
            c.error = Some("the downloader stopped responding".to_string());
            c.claimed_at = None;
            c.delivering = false;
        }
    }
    if any_ready {
        settle(job);
    } else {
        job.state = "failed".to_string();
        job.error = Some(
            "No import machine answered. The box that downloads (running SpotiFLAC) must be on and pointed at this server for 'Wrong song?' to fetch alternates."
                .to_string(),
        );
    }
}

/// `GET /api/refetch/{id}` - how the hunt is going.
pub async fn status(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Job>> {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".to_string()))?;
    let now = now_secs();
    let peer_seen = state.refetch.peer_seen();
    let mut jobs = state.refetch.jobs.lock().await;
    let job = jobs
        .get_mut(&id)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such hunt"))?;
    // A poll is the natural moment to advance a delegated hunt's deadlines - the
    // client asks every second or so while the modal is open, which is exactly
    // when a stuck one needs to be told it is stuck.
    sweep(job, now, peer_seen);
    Ok(Json(job.clone()))
}

/// `GET /api/refetch/{id}/audio/{index}` - listen to a candidate before
/// committing to it. Served through ServeFile so it is range-capable: skipping
/// to the middle is how you catch a live take, and a preview you cannot scrub
/// is barely a preview.
pub async fn preview(
    State(state): State<Arc<AppState>>,
    AxumPath((id, index)): AxumPath<(String, usize)>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    caller_from_either(&state, &headers, &params)?;

    let path = {
        let jobs = state.refetch.jobs.lock().await;
        jobs.get(&id)
            .and_then(|j| j.candidates.get(index))
            .and_then(|c| c.file.clone())
            .ok_or(StatusCode::NOT_FOUND)?
    };

    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let mut response = ServeFile::new_with_mime(
        &path,
        &mime.parse().unwrap_or(mime_guess::mime::APPLICATION_OCTET_STREAM),
    )
    .oneshot(request)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_response();
    // The filename's extension is peer-supplied, so forbid content sniffing:
    // a mislabelled body can never be re-interpreted as something executable.
    // In the app this URL is only ever an <audio> source.
    response.headers_mut().insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

/// `POST /api/refetch/{id}/keep` - this one is the song. File it, move the old
/// track's whole history onto it, and scrap everything else.
pub async fn keep(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<KeepBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let caller =
        auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".to_string()))?;

    let (chosen, old_id, staging) = {
        let jobs = state.refetch.jobs.lock().await;
        let job = jobs
            .get(&id)
            .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such hunt"))?;
        // The rule `owner` was added for, finally applied. A hunt is a
        // half-finished judgement about someone else's library, and committing
        // one you did not start swaps a file out from under the person who was
        // still listening to the candidates.
        if job.owner != caller.id {
            return Err(bad(StatusCode::NOT_FOUND, "no such hunt"));
        }
        let cand = job
            .candidates
            .get(body.index)
            .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such candidate"))?;
        let file = cand
            .file
            .clone()
            .ok_or_else(|| bad(StatusCode::BAD_REQUEST, "that one never downloaded"))?;
        (file, job.track_id, job.staging.clone())
    };

    // The old row has to still exist: a second commit of the same hunt, or a
    // track deleted from another device meanwhile, must not file an orphan.
    let old_rel = state
        .db
        .track_rel_path(old_id)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "the track being replaced is gone"))?;

    // 1. File the winner exactly the way an import or an upload files one, so
    //    it is routed, named and indexed by the same rules as everything else.
    let original = chosen
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = original.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let rel = upload::destination_for(&state.music_root, &chosen, &original, &ext);
    let dest = state.music_root.join(&rel);
    let (rel, dest) = upload::unique_destination(&state.music_root, &rel, &dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(internal)?;
    }
    if std::fs::rename(&chosen, &dest).is_err() {
        std::fs::copy(&chosen, &dest).map_err(internal)?;
        let _ = std::fs::remove_file(&chosen);
    }
    if !scan::scan_one(&state.db, &state.music_root, &state.art_dir, &rel) {
        let _ = std::fs::remove_file(&dest);
        return Err(bad(
            StatusCode::UNPROCESSABLE_ENTITY,
            "the chosen file could not be indexed",
        ));
    }
    let new_id = state
        .db
        .track_id_by_path(&rel)
        .ok_or_else(|| internal("filed but not indexed"))?;

    // 2. The song keeps its life: playlists, likes, play counts, history.
    //    This is the whole reason to replace rather than delete-and-re-add.
    state
        .db
        .repoint_track_refs(new_id, &[old_id])
        .map_err(internal)?;

    // 3. The wrong file steps aside. Quarantined, not deleted - the same
    //    caution resolve_duplicates takes, for the same reason.
    let music_root = state.music_root.clone();
    let old_rel_c = old_rel.clone();
    let quarantined = tokio::task::spawn_blocking(move || {
        crate::tools::quarantine_file(&music_root, &old_rel_c)
    })
    .await
    .map_err(internal)?;
    let rev = state.db.current_rev() + 1;
    state.db.tombstone_tracks(&[old_id], rev).map_err(internal)?;

    // 4. Scrap the rest.
    let _ = std::fs::remove_dir_all(&staging);
    state.refetch.jobs.lock().await.remove(&id);

    Ok(Json(serde_json::json!({
        "trackId": new_id,
        "replaced": old_id,
        "quarantined": quarantined.is_ok(),
    })))
}

/// `DELETE /api/refetch/{id}` - none of them were right. Everything staged
/// goes; the library is exactly as it was.
pub async fn scrap(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let caller =
        auth::require_admin(&state.db, &headers).map_err(|s| (s, "admins only".to_string()))?;
    // Taken under the same lock as the ownership test, so a hunt cannot change
    // hands between the check and the removal.
    let mut jobs = state.refetch.jobs.lock().await;
    match jobs.get(&id) {
        Some(job) if job.owner != caller.id => {
            // Same answer as a hunt that does not exist: whose hunts are
            // running is not something to leak by probing ids.
            return Err(bad(StatusCode::NOT_FOUND, "no such hunt"));
        }
        _ => {}
    }
    let job = jobs.remove(&id);
    drop(jobs);
    if let Some(job) = job {
        let _ = std::fs::remove_dir_all(&job.staging);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// --- the peer channel ------------------------------------------------------
//
// When the hub has no downloader of its own, the alternates are pulled by a
// PEER (the M4 running SpotiFLAC) and shipped back here to stage - the same
// division of labour that fills the library, see peersync. The peer POLLS:
// claim a queued candidate, download it there, deliver the file back (or report
// it failed). All three are the same authenticated caller the collector claim
// endpoints trust - the peer presents its hub token.

/// `GET /api/refetch/peer/claim` - a downloader peer asks for one candidate to
/// pull. Hands back the first queued candidate of any delegated hunt, marks it
/// downloading, and returns its url + service. `{claim: null}` when there is
/// nothing to do.
pub async fn peer_claim(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".to_string()))?;
    let now = now_secs();
    // Reaching this endpoint at all is proof the downloader is alive, so the
    // clock is `now` for every hunt swept below - none can conclude the peer is
    // gone while the peer is right here asking for work.
    state.refetch.note_peer_seen(now);
    let mut jobs = state.refetch.jobs.lock().await;
    // Sweep first, so a candidate a dead peer abandoned is back on offer before
    // we pick one.
    for job in jobs.values_mut() {
        sweep(job, now, now);
    }
    for job in jobs.values_mut() {
        if !job.delegated || job.state != "hunting" {
            continue;
        }
        let Some(i) = job.candidates.iter().position(|c| c.state == "queued") else {
            continue;
        };
        let (url, service) = {
            let c = &mut job.candidates[i];
            c.state = "downloading".to_string();
            c.claimed_at = Some(now);
            c.delivering = false;
            (c.url.clone(), c.service.clone())
        };
        job.last_progress = now;
        return Ok(Json(serde_json::json!({
            "claim": { "jobId": job.id, "index": i, "url": url, "service": service }
        })));
    }
    Ok(Json(serde_json::json!({ "claim": null })))
}

/// A peer-supplied filename, reduced to a bare, safe leaf. The peer is trusted
/// to authenticate but its filename is still input: only the final component,
/// no separators, so it can never climb out of the candidate's own directory.
fn sanitize_name(name: &str) -> String {
    let leaf = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let leaf: String = leaf.chars().filter(|c| *c != '/' && *c != '\\').take(180).collect();
    if leaf.trim().is_empty() {
        "candidate.audio".to_string()
    } else {
        leaf
    }
}

/// Stream a request body to a file, bounded by `cap` so the body-cap-lifted
/// deliver route can never be made to write without limit.
async fn stream_to_file(request: Request<Body>, path: &Path, cap: u64) -> ApiResult<()> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(path).await.map_err(internal)?;
    let mut stream = request.into_body().into_data_stream();
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| (StatusCode::BAD_REQUEST, format!("the upload stream broke: {e}")))?;
        written += chunk.len() as u64;
        if written > cap {
            return Err(bad(StatusCode::PAYLOAD_TOO_LARGE, "that alternate is too large"));
        }
        file.write_all(&chunk).await.map_err(internal)?;
    }
    file.flush().await.map_err(internal)?;
    Ok(())
}

/// `POST /api/refetch/peer/deliver/{job_id}/{index}?name=<file>` - a peer ships
/// a downloaded alternate back. The candidate slot is validated and RESERVED
/// under the lock before a byte is written (so a delivery only ever lands in a
/// slot a peer actually holds, and a second delivery to the same slot bounces),
/// then the file is streamed with the lock dropped, then the slot is confirmed
/// still ours before it is marked ready. The route lifts axum's body cap
/// (main.rs) because an alternate is a file, not a chunk.
pub async fn peer_deliver(
    State(state): State<Arc<AppState>>,
    AxumPath((job_id, index)): AxumPath<(String, usize)>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> ApiResult<Json<serde_json::Value>> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".to_string()))?;
    let now0 = now_secs();
    state.refetch.note_peer_seen(now0);
    let name = sanitize_name(params.get("name").map(String::as_str).unwrap_or(""));

    // Validate and RESERVE the slot before writing anything. A delivery is only
    // accepted into a candidate a peer is holding (state "downloading", not
    // already "delivering"); flipping it to "delivering" here, under the lock,
    // is what makes a second or out-of-range delivery bounce instead of racing a
    // file onto disk or filling it for a slot that does not exist.
    let dir = {
        let mut jobs = state.refetch.jobs.lock().await;
        let job = jobs
            .get_mut(&job_id)
            .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such hunt"))?;
        if !job.delegated || job.state != "hunting" {
            return Err(bad(StatusCode::CONFLICT, "this hunt does not take deliveries"));
        }
        let c = job
            .candidates
            .get_mut(index)
            .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such candidate"))?;
        if c.state != "downloading" || c.delivering {
            return Err(bad(
                StatusCode::CONFLICT,
                "that candidate is not awaiting delivery",
            ));
        }
        c.delivering = true;
        c.claimed_at = Some(now0);
        job.last_progress = now0;
        job.staging.join(index.to_string())
    };
    std::fs::create_dir_all(&dir).map_err(internal)?;
    let path = dir.join(&name);

    if let Err(e) = stream_to_file(request, &path, MAX_DELIVER_BYTES).await {
        // The write failed or overran: give the slot back so it can be retried,
        // and drop the partial file.
        let _ = tokio::fs::remove_file(&path).await;
        let mut jobs = state.refetch.jobs.lock().await;
        if let Some(c) = jobs.get_mut(&job_id).and_then(|j| j.candidates.get_mut(index)) {
            if c.delivering {
                c.delivering = false;
                c.state = "queued".to_string();
                c.claimed_at = None;
            }
        }
        return Err(e);
    }

    let now = now_secs();
    let mut jobs = state.refetch.jobs.lock().await;
    let Some(job) = jobs.get_mut(&job_id) else {
        // Scrapped while the file was in flight - drop what landed.
        let _ = std::fs::remove_dir_all(&dir);
        return Err(bad(StatusCode::NOT_FOUND, "no such hunt"));
    };
    // A sweep may have re-queued or failed this slot while the file was in
    // flight (a peer that went quiet, then this late delivery). If the slot is
    // no longer the one we reserved, the hunt has moved on: drop the file rather
    // than resurrect a settled candidate.
    let still_ours = job
        .candidates
        .get(index)
        .map(|c| c.delivering)
        .unwrap_or(false);
    if !still_ours || job.state != "hunting" {
        drop(jobs);
        let _ = tokio::fs::remove_file(&path).await;
        return Ok(Json(serde_json::json!({ "ok": true, "discarded": true })));
    }
    mark_candidate_ready(job, index, path);
    job.last_progress = now;
    settle(job);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct PeerFailBody {
    pub error: Option<String>,
}

/// `POST /api/refetch/peer/fail/{job_id}/{index}` - a peer reporting it could
/// not pull this one. Only a candidate a peer is actually holding
/// (downloading/delivering) can be failed, so a stray caller cannot fail a
/// queued or already-decided one. The hunt settles when the last is accounted.
pub async fn peer_fail(
    State(state): State<Arc<AppState>>,
    AxumPath((job_id, index)): AxumPath<(String, usize)>,
    headers: HeaderMap,
    Json(body): Json<PeerFailBody>,
) -> ApiResult<Json<serde_json::Value>> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".to_string()))?;
    let now = now_secs();
    state.refetch.note_peer_seen(now);
    let mut jobs = state.refetch.jobs.lock().await;
    let Some(job) = jobs.get_mut(&job_id) else {
        return Err(bad(StatusCode::NOT_FOUND, "no such hunt"));
    };
    let c = job
        .candidates
        .get_mut(index)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "no such candidate"))?;
    if c.state != "downloading" && c.state != "delivering" {
        return Err(bad(StatusCode::CONFLICT, "that candidate is not being fetched"));
    }
    c.state = "failed".to_string();
    c.error = Some(
        body.error
            .filter(|e| !e.trim().is_empty())
            .unwrap_or_else(|| "the downloader could not fetch this".to_string()),
    );
    c.claimed_at = None;
    c.delivering = false;
    job.last_progress = now;
    settle(job);
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `POST /api/refetch/peer/beat/{job_id}/{index}` - a peer says it is still on
/// this candidate. Refreshes the global liveness clock (so no waiting hunt gives
/// up while the downloader is working, however slow one pull is) and this
/// claim's own clock (so a slow pull is not re-offered out from under it).
pub async fn peer_beat(
    State(state): State<Arc<AppState>>,
    AxumPath((job_id, index)): AxumPath<(String, usize)>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".to_string()))?;
    let now = now_secs();
    state.refetch.note_peer_seen(now);
    let mut jobs = state.refetch.jobs.lock().await;
    if let Some(job) = jobs.get_mut(&job_id) {
        if let Some(c) = job.candidates.get_mut(index) {
            if c.state == "downloading" || c.state == "delivering" {
                c.claimed_at = Some(now);
                job.last_progress = now;
            }
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod refetch_tests {
    use super::*;

    fn result(id: &str, title: &str, source: &str) -> search::SearchResult {
        search::SearchResult {
            id: id.to_string(),
            kind: "track".to_string(),
            title: title.to_string(),
            subtitle: "Daft Punk".to_string(),
            cover: None,
            url: format!("https://open.spotify.com/track/{id}"),
            source: source.to_string(),
            importable: true,
        }
    }

    #[test]
    fn a_progress_bar_is_never_an_error_message() {
        // The exact shape that reached the modal before: a finished tqdm bar
        // as the last line of a failed run.
        let bar = b"Searching...\nProgress: 100%|\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88| 1/1 [00:02<00:00,  2.3s/it]\n";
        assert_eq!(explain(bar), "this provider did not have it");
        assert_eq!(explain(b""), "this provider did not have it");
        // A real message still gets through.
        let real = b"Progress: 100%|xx| 1/1\nTrack not available in your region\n";
        assert_eq!(explain(real), "Track not available in your region");
    }

    #[test]
    fn best_match_is_tried_through_two_providers() {
        let list = shape(
            &[
                result("a", "One More Time", "spotify"),
                result("b", "One More Time - Live", "spotify"),
                result("c", "One More Time (Remix)", "deezer"),
            ],
            "Daft Punk",
        );
        // Same URL twice, under two different providers - the fix for a
        // provider that matched the wrong recording.
        assert_eq!(list[0].0, list[1].0);
        assert_eq!(list[0].1, "deezer");
        assert_eq!(list[1].1, "tidal");
        // Then the other results, on the full ladder.
        assert!(list[2].0.ends_with("/b"));
        assert_eq!(list[2].1, "");
        assert_eq!(list.len(), 4);
    }

    #[test]
    fn shortlist_is_capped_and_survives_thin_results() {
        let many: Vec<_> = (0..20)
            .map(|i| result(&format!("t{i}"), "Song", "spotify"))
            .collect();
        assert_eq!(shape(&many, "Daft Punk").len(), MAX_CANDIDATES);
        assert!(shape(&[], "Daft Punk").is_empty());
        // A single result still yields the two-provider pair, which is the
        // whole shortlist when the catalogue only knows one version.
        assert_eq!(shape(&many[..1], "Daft Punk").len(), 2);
    }

    /// Hits the live catalogues, so it is opt-in:
    ///   cargo test refetch_tests::alternates -- --ignored --nocapture
    #[ignore]
    #[tokio::test]
    async fn alternates_exist_for_a_real_song() {
        let rows = search::deezer_search("Daft Punk One More Time").await;
        for r in rows.iter().take(8) {
            println!("  {} - {} [{}] {}", r.subtitle, r.title, r.source, r.url);
        }
        assert!(!rows.is_empty(), "deezer returned nothing");
        let shortlist = shape(
            &rows.iter().filter(|r| r.kind == "track").cloned().collect::<Vec<_>>(),
            "Daft Punk",
        );
        for (url, service, title, artist, _) in &shortlist {
            println!("  PLAN [{}] {artist} - {title}  {url}", if service.is_empty() { "ladder" } else { service });
        }
        assert!(!shortlist.is_empty());
        println!("  -> {} candidates planned", shortlist.len());
    }

    // --- the delegated state machine (no network, no SpotiFLAC) -------------
    //
    // sweep(job, now, peer_seen): while the downloader is in contact (peer_seen
    // fresh) the hunt WAITS however slow one pull is; once peer_seen goes stale
    // past NO_PEER_SECS every pending candidate fails and the job settles.

    fn cand(index: usize, state: &str) -> Candidate {
        Candidate {
            index,
            source: String::new(),
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            state: state.to_string(),
            error: None,
            duration_ms: None,
            size_bytes: None,
            lossless: false,
            codec: String::new(),
            same_as: None,
            file: None,
            url: format!("u{index}"),
            service: String::new(),
            claimed_at: None,
            delivering: false,
        }
    }

    fn a_job(delegated: bool, cands: Vec<Candidate>) -> Job {
        Job {
            id: "j".into(),
            track_id: 1,
            state: "hunting".into(),
            error: None,
            current: CurrentTrack {
                id: 1,
                title: String::new(),
                artist: String::new(),
                album: String::new(),
                duration_ms: None,
                lossless: false,
                codec: String::new(),
            },
            candidates: cands,
            staging: PathBuf::from("/tmp/refetch-test-none"),
            owner: 1,
            delegated,
            last_progress: 0,
        }
    }

    #[test]
    fn settle_waits_for_every_candidate_then_prefers_any_ready() {
        let mut j = a_job(true, vec![cand(0, "ready"), cand(1, "downloading")]);
        settle(&mut j);
        assert_eq!(j.state, "hunting", "one still downloading, not done");
        j.candidates[1].state = "failed".into();
        settle(&mut j);
        assert_eq!(j.state, "ready", "one playable is a usable hunt");
    }

    #[test]
    fn settle_all_failed_is_a_failed_hunt() {
        let mut j = a_job(true, vec![cand(0, "failed"), cand(1, "failed")]);
        settle(&mut j);
        assert_eq!(j.state, "failed");
        assert!(j.error.unwrap().contains("failed to download"));
    }

    #[test]
    fn a_live_peer_holds_a_hunt_however_slow() {
        let now = 100_000;
        // Everything still queued, job quiet for an hour - but the peer was seen
        // one second ago. It is working; do not give up on it.
        let mut j = a_job(true, vec![cand(0, "queued"), cand(1, "downloading")]);
        j.candidates[1].claimed_at = Some(now - 5);
        sweep(&mut j, now, now - 1);
        assert_eq!(j.state, "hunting");
        assert_eq!(j.candidates[1].state, "downloading", "a live slow pull is untouched");
    }

    #[test]
    fn a_gone_peer_fails_a_hunt_that_never_landed_anything() {
        let now = 100_000;
        let mut j = a_job(true, vec![cand(0, "queued"), cand(1, "downloading")]);
        // No peer contact for well past the window.
        sweep(&mut j, now, now - NO_PEER_SECS - 1);
        assert_eq!(j.state, "failed");
        assert!(j.error.as_ref().unwrap().contains("import machine"));
        assert!(j.candidates.iter().all(|c| c.state == "failed"));
    }

    #[test]
    fn a_gone_peer_keeps_what_already_landed() {
        let now = 100_000;
        let mut j = a_job(true, vec![cand(0, "ready"), cand(1, "downloading")]);
        sweep(&mut j, now, now - NO_PEER_SECS - 1);
        assert_eq!(j.candidates[1].state, "failed", "the straggler is abandoned");
        assert_eq!(j.state, "ready", "but the one that arrived still carries the hunt");
    }

    #[test]
    fn a_stale_claim_is_reoffered_even_while_the_peer_is_alive() {
        let now = 100_000;
        let mut stuck = cand(0, "downloading");
        stuck.claimed_at = Some(now - CLAIM_STALE_SECS - 1);
        let mut j = a_job(true, vec![stuck, cand(1, "queued")]);
        // Peer alive (fresh), but THIS claim went quiet: re-offer it, do not fail.
        sweep(&mut j, now, now);
        assert_eq!(j.candidates[0].state, "queued", "the abandoned claim is back on offer");
        assert!(j.candidates[0].claimed_at.is_none());
        assert_eq!(j.state, "hunting");
    }

    #[test]
    fn sweep_leaves_a_local_hunt_alone() {
        let now = 100_000;
        // A non-delegated hunt is bounded by its own stall watchdog, never here,
        // no matter how stale the peer clock looks.
        let mut j = a_job(false, vec![cand(0, "downloading")]);
        sweep(&mut j, now, now - NO_PEER_SECS - 999);
        assert_eq!(j.state, "hunting");
        assert_eq!(j.candidates[0].state, "downloading");
    }
}
