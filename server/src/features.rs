//! The audio analyser: what each file SOUNDS like, measured off the file.
//!
//! Tags say what a track is called; tempo.rs already measures how fast it
//! moves. This fills in the rest of its character - how loud it sits and how
//! bright its spectrum is - as three numbers on the curator's `track_features`
//! row (energy, brightness, loudness). Deliberately rough-and-ready: these
//! feed mood playlists and the stats page's "your sound" block, not
//! musicology, so a defensible 0-1 beats a laboratory measure that never
//! ships.
//!
//! The job shares a one-core box with live playback, so it is polite to a
//! fault: one track at a time, a sleep between tracks, decoding only ninety
//! seconds from the middle of the file (the middle, because intros and
//! fade-outs are the least representative part of a song), and a long pause
//! whenever anything fails. ffmpeg does the decoding - the same binary the
//! transcode endpoint probes for at boot - and when the box has none, the
//! whole job says so once and stays off.

use crate::tempo;
use crate::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

/// Decode rate. Brightness is a statement about the whole audible spectrum,
/// so this is higher than tempo.rs's beat-hunting 11 kHz; 22.05 kHz puts
/// Nyquist at 11 kHz, which is where "bright" lives.
const RATE: usize = 22_050;
/// FFT window (~93 ms) and hop (50% overlap) for the spectral centroid.
const FFT_SIZE: usize = 2048;
const HOP: usize = 1024;
/// Seconds decoded per track.
const TAKE_SECS: &str = "90";
/// The politeness gap between tracks.
const TRACK_GAP: Duration = Duration::from_secs(4);
/// How long the loop stands down after ANY failure - a failing decode is
/// exactly when the disk and CPU are likely wanted elsewhere.
const FAIL_PAUSE: Duration = Duration::from_secs(60);
/// Between passes once every live track is measured.
const IDLE_SLEEP: Duration = Duration::from_secs(300);

/// Starts the analyser. Runs until the process ends.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        if !state.ffmpeg {
            // Said once, here, rather than once per track forever.
            eprintln!("[features] no ffmpeg on PATH - audio analysis is off");
            return;
        }
        // A breath before the first decode: boot belongs to the scanner.
        tokio::time::sleep(Duration::from_secs(30)).await;
        // In-memory failure counts. Losing them on restart is fine - the
        // durable give-up is the sentinel row below, and an extra retry after
        // a redeploy costs one decode.
        let mut failures: HashMap<i64, u32> = HashMap::new();
        loop {
            let Some((id, rel, duration_ms, has_bpm)) = state.db.next_unanalyzed_track() else {
                tokio::time::sleep(IDLE_SLEEP).await;
                continue;
            };
            match analyze_one(&state, id, &rel, duration_ms, has_bpm).await {
                Ok(()) => {
                    failures.remove(&id);
                    tokio::time::sleep(TRACK_GAP).await;
                }
                Err(why) => {
                    let count = failures.entry(id).or_insert(0);
                    *count += 1;
                    eprintln!("[features] analysis failed for track {id}: {why}");
                    if *count >= 2 {
                        // Two strikes and the track is marked measured with a
                        // silent, dark, tempoless sentinel - otherwise a file
                        // ffmpeg cannot read would be re-decoded every cycle
                        // until somebody deleted it. listen_sound (db.rs)
                        // knows to skip these when averaging.
                        let _ = state.db.save_audio_features(id, None, 0.0, 0.0, -70.0);
                        failures.remove(&id);
                    }
                    tokio::time::sleep(FAIL_PAUSE).await;
                }
            }
        }
    });
}

/// One track, decode to row.
async fn analyze_one(
    state: &Arc<AppState>,
    id: i64,
    rel: &str,
    duration_ms: Option<i64>,
    has_bpm: bool,
) -> Result<(), String> {
    let path = crate::stream::resolve_in_root(&state.music_root, rel)
        .ok_or_else(|| "file is missing from the music root".to_string())?;

    let samples = decode(&path, duration_ms)
        .await
        .ok_or_else(|| "ffmpeg produced no usable audio".to_string())?;
    // The DSP is CPU-bound and long enough to matter; keep it off the async
    // workers other requests are sharing (same reasoning as tempo.rs).
    let (energy, brightness, loudness) = tokio::task::spawn_blocking(move || measure(&samples))
        .await
        .map_err(|e| e.to_string())?;

    // Tempo is tempo.rs's business, reused rather than re-invented - but only
    // asked for when the row has none, since the curator's enricher fills it
    // on its own schedule and an existing measurement always wins anyway.
    let bpm = if has_bpm { None } else { tempo::analyze(&path).await };

    state
        .db
        .save_audio_features(id, bpm, energy, brightness, loudness)
        .map_err(|e| e.to_string())
}

/// A mono f32 window from the middle of the file - a quarter of the way in
/// when the duration is known, the top when it is not. None when ffmpeg
/// fails or hands back less than five seconds, which is too little to call a
/// character.
async fn decode(path: &Path, duration_ms: Option<i64>) -> Option<Vec<f32>> {
    let mut command = tokio::process::Command::new("ffmpeg");
    command.args(["-v", "error"]);
    // -ss before -i seeks by index rather than decoding its way there (see
    // stream.rs) - on a big FLAC that is the whole cost of the middle.
    if let Some(ms) = duration_ms.filter(|&ms| ms > 0) {
        command.arg("-ss").arg(format!("{:.3}", ms as f64 / 1000.0 * 0.25));
    }
    let out = command
        .arg("-i")
        .arg(path)
        .args(["-t", TAKE_SECS, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() || out.stdout.len() < RATE * 4 * 5 {
        return None;
    }
    Some(
        out.stdout
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// The character of one window of audio: `(energy, brightness, loudness)`.
///
/// - **loudness** is plain RMS over the whole window, in dBFS.
/// - **energy** is that loudness on a 0-1 scale: -35 dBFS is a whisper-quiet
///   master, -8 a brickwalled one, and the clamp absorbs everything odder.
/// - **brightness** is the average spectral centroid (Hann windows, 50%
///   overlap) normalised by Nyquist, then mapped so ~0.05 (all lows) reads 0
///   and ~0.35 (hissing bright) reads 1.
fn measure(samples: &[f32]) -> (f64, f64, f64) {
    let mean_sq = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>()
        / samples.len().max(1) as f64;
    // The floor keeps log10 finite on digital silence (~-120 dBFS).
    let loudness = 20.0 * mean_sq.sqrt().max(1e-6).log10();
    let energy = ((loudness + 35.0) / 27.0).clamp(0.0, 1.0);

    let centroid = spectral_centroid(samples);
    let brightness = ((centroid / (RATE as f64 / 2.0) - 0.05) / 0.30).clamp(0.0, 1.0);

    (
        (energy * 1000.0).round() / 1000.0,
        (brightness * 1000.0).round() / 1000.0,
        (loudness * 100.0).round() / 100.0,
    )
}

/// The average spectral centroid in Hz - where the "weight" of the spectrum
/// sits. Silent frames are skipped: silence has no colour, and letting it
/// vote would drag every track with quiet passages toward the same number.
fn spectral_centroid(samples: &[f32]) -> f64 {
    use rustfft::{num_complex::Complex, FftPlanner};
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);

    // Hann, so energy at a window edge is not smeared across the spectrum.
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let x = std::f32::consts::PI * 2.0 * i as f32 / FFT_SIZE as f32;
            0.5 - 0.5 * x.cos()
        })
        .collect();

    let bins = FFT_SIZE / 2;
    let hz_per_bin = RATE as f64 / FFT_SIZE as f64;
    let mut buf = vec![Complex { re: 0.0f32, im: 0.0f32 }; FFT_SIZE];
    let mut sum = 0.0f64;
    let mut frames = 0usize;

    let mut start = 0;
    while start + FFT_SIZE <= samples.len() {
        for i in 0..FFT_SIZE {
            buf[i] = Complex { re: samples[start + i] * window[i], im: 0.0 };
        }
        fft.process(&mut buf);

        let mut mag_sum = 0.0f64;
        let mut weighted = 0.0f64;
        for (k, c) in buf.iter().enumerate().take(bins) {
            let m = c.norm() as f64;
            mag_sum += m;
            weighted += m * (k as f64 * hz_per_bin);
        }
        if mag_sum > 1e-6 {
            sum += weighted / mag_sum;
            frames += 1;
        }
        start += HOP;
    }
    if frames > 0 { sum / frames as f64 } else { 0.0 }
}

// --- status -----------------------------------------------------------------

/// `GET /api/features/status` - how far the analyser has got. `ffmpeg: false`
/// is the client's cue that these numbers will never move on this box.
pub async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    crate::auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let (analyzed, total) = state.db.audio_feature_counts();
    Ok(Json(json!({ "analyzed": analyzed, "total": total, "ffmpeg": state.ffmpeg })))
}
