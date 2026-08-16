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
                        let _ = state
                            .db
                            .save_audio_features(id, None, 0.0, 0.0, -70.0, 0.0, 0.0, None);
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
    let (measurements, fingerprint) =
        tokio::task::spawn_blocking(move || (measure(&samples), audio_fingerprint(&samples)))
            .await
            .map_err(|e| e.to_string())?;
    let (energy, brightness, loudness, dynamic_range, rhythmic_activity) = measurements;

    // Tempo is tempo.rs's business, reused rather than re-invented - but only
    // asked for when the row has none, since the curator's enricher fills it
    // on its own schedule and an existing measurement always wins anyway.
    let bpm = if has_bpm {
        None
    } else {
        tempo::analyze(&path).await
    };

    state
        .db
        .save_audio_features(
            id,
            bpm,
            energy,
            brightness,
            loudness,
            dynamic_range,
            rhythmic_activity,
            fingerprint.as_deref(),
        )
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
        command
            .arg("-ss")
            .arg(format!("{:.3}", ms as f64 / 1000.0 * 0.25));
    }
    let out = command
        .arg("-i")
        .arg(path)
        .args([
            "-t", TAKE_SECS, "-ac", "1", "-ar", "22050", "-f", "f32le", "-",
        ])
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
fn measure(samples: &[f32]) -> (f64, f64, f64, f64, f64) {
    let mean_sq = samples
        .iter()
        .map(|s| (*s as f64) * (*s as f64))
        .sum::<f64>()
        / samples.len().max(1) as f64;
    // The floor keeps log10 finite on digital silence (~-120 dBFS).
    let loudness = 20.0 * mean_sq.sqrt().max(1e-6).log10();
    let energy = ((loudness + 35.0) / 27.0).clamp(0.0, 1.0);

    let centroid = spectral_centroid(samples);
    let brightness = ((centroid / (RATE as f64 / 2.0) - 0.05) / 0.30).clamp(0.0, 1.0);
    let (dynamic_range, rhythmic_activity) = window_character(samples);

    (
        (energy * 1000.0).round() / 1000.0,
        (brightness * 1000.0).round() / 1000.0,
        (loudness * 100.0).round() / 100.0,
        (dynamic_range * 1000.0).round() / 1000.0,
        (rhythmic_activity * 1000.0).round() / 1000.0,
    )
}

/// Two complementary time-domain descriptors from 50 ms windows. Dynamic
/// range is the 90th-to-10th percentile RMS gap; rhythmic activity is the
/// average absolute change between adjacent windows. Both are normalized so
/// they can participate in similarity scoring without library-wide fitting.
fn window_character(samples: &[f32]) -> (f64, f64) {
    let width = RATE / 20;
    let mut rms: Vec<f64> = samples
        .chunks_exact(width)
        .map(|window| {
            (window.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / width as f64).sqrt()
        })
        .collect();
    if rms.len() < 4 {
        return (0.0, 0.0);
    }
    let activity =
        rms.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (rms.len() - 1) as f64;
    let rhythmic_activity = (activity / 0.035).clamp(0.0, 1.0);
    rms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let low = rms[rms.len() / 10].max(1e-6);
    let high = rms[rms.len() * 9 / 10].max(low);
    let gap_db = 20.0 * (high / low).log10();
    ((gap_db / 18.0).clamp(0.0, 1.0), rhythmic_activity)
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
    let mut buf = vec![
        Complex {
            re: 0.0f32,
            im: 0.0f32
        };
        FFT_SIZE
    ];
    let mut sum = 0.0f64;
    let mut frames = 0usize;

    let mut start = 0;
    while start + FFT_SIZE <= samples.len() {
        for i in 0..FFT_SIZE {
            buf[i] = Complex {
                re: samples[start + i] * window[i],
                im: 0.0,
            };
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
    if frames > 0 {
        sum / frames as f64
    } else {
        0.0
    }
}

/// A compact, versioned fingerprint derived from the recording rather than
/// tags or prose. Each FFT frame is reduced to 16 logarithmic frequency bands;
/// the vector stores their mean distribution, variation, and average temporal
/// change. L2 normalization makes cosine comparison insensitive to mastering
/// level. This is deliberately model-free so it works on every AttackFM host.
fn audio_fingerprint(samples: &[f32]) -> Option<Vec<f32>> {
    use rustfft::{num_complex::Complex, FftPlanner};
    const BANDS: usize = 16;
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let x = std::f32::consts::TAU * i as f32 / FFT_SIZE as f32;
            0.5 - 0.5 * x.cos()
        })
        .collect();
    let mut sum = [0.0f64; BANDS];
    let mut sum_sq = [0.0f64; BANDS];
    let mut delta = [0.0f64; BANDS];
    let mut previous: Option<[f64; BANDS]> = None;
    let mut frames = 0usize;
    let mut buf = vec![
        Complex {
            re: 0.0f32,
            im: 0.0f32
        };
        FFT_SIZE
    ];

    for frame in samples.windows(FFT_SIZE).step_by(HOP) {
        for i in 0..FFT_SIZE {
            buf[i] = Complex {
                re: frame[i] * window[i],
                im: 0.0,
            };
        }
        fft.process(&mut buf);
        let mut bands = [0.0f64; BANDS];
        for (bin, value) in buf.iter().enumerate().take(FFT_SIZE / 2).skip(4) {
            let hz = bin as f64 * RATE as f64 / FFT_SIZE as f64;
            let position = (hz / 40.0).ln() / ((RATE as f64 / 2.0 / 40.0).ln());
            let band = (position * BANDS as f64)
                .floor()
                .clamp(0.0, (BANDS - 1) as f64) as usize;
            bands[band] += value.norm_sqr() as f64;
        }
        // Log power compresses peaks, then per-frame normalization captures
        // timbre instead of simple loudness (already represented separately).
        for value in &mut bands {
            *value = (1.0 + *value).ln();
        }
        let norm = bands.iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm <= 1e-9 {
            continue;
        }
        for value in &mut bands {
            *value /= norm;
        }
        for i in 0..BANDS {
            sum[i] += bands[i];
            sum_sq[i] += bands[i] * bands[i];
            if let Some(prev) = previous {
                delta[i] += (bands[i] - prev[i]).abs();
            }
        }
        previous = Some(bands);
        frames += 1;
    }
    if frames < 8 {
        return None;
    }
    let mut out = Vec::with_capacity(BANDS * 3);
    for i in 0..BANDS {
        out.push((sum[i] / frames as f64) as f32);
    }
    for i in 0..BANDS {
        let mean = sum[i] / frames as f64;
        out.push((sum_sq[i] / frames as f64 - mean * mean).max(0.0).sqrt() as f32);
    }
    for i in 0..BANDS {
        out.push((delta[i] / (frames - 1) as f64) as f32);
    }
    let norm = out.iter().map(|v| v * v).sum::<f32>().sqrt();
    (norm > 1e-9).then(|| out.into_iter().map(|v| v / norm).collect())
}

// --- status -----------------------------------------------------------------

/// `GET /api/features/status` - how far the analyser has got. `ffmpeg: false`
/// is the client's cue that these numbers will never move on this box.
pub async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    crate::auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let (analyzed, fingerprinted, total) = state.db.audio_feature_counts();
    Ok(Json(
        json!({ "analyzed": analyzed, "fingerprinted": fingerprinted,
            "fingerprintVersion": 1, "total": total, "ffmpeg": state.ffmpeg }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_signal_has_little_dynamic_or_rhythmic_change() {
        let samples = vec![0.25; RATE * 2];
        let (dynamic_range, rhythmic_activity) = window_character(&samples);
        assert!(dynamic_range < 0.01);
        assert!(rhythmic_activity < 0.01);
    }

    #[test]
    fn alternating_windows_register_as_dynamic_and_active() {
        let width = RATE / 20;
        let samples: Vec<f32> = (0..40)
            .flat_map(|window| vec![if window % 2 == 0 { 0.02 } else { 0.5 }; width])
            .collect();
        let (dynamic_range, rhythmic_activity) = window_character(&samples);
        assert!(dynamic_range > 0.9);
        assert!(rhythmic_activity > 0.9);
    }

    #[test]
    fn fingerprint_is_normalized_and_distinguishes_spectra() {
        let tone = |hz: f32| {
            (0..RATE * 2)
                .map(|i| (std::f32::consts::TAU * hz * i as f32 / RATE as f32).sin() * 0.3)
                .collect::<Vec<_>>()
        };
        let low = audio_fingerprint(&tone(110.0)).unwrap();
        let nearby = audio_fingerprint(&tone(120.0)).unwrap();
        let high = audio_fingerprint(&tone(6000.0)).unwrap();
        let cosine = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        assert_eq!(low.len(), 48);
        assert!((cosine(&low, &low) - 1.0).abs() < 0.001);
        assert!(cosine(&low, &nearby) > cosine(&low, &high));
    }
}
