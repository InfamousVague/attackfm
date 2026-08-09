//! Tempo, measured from the audio rather than looked up.
//!
//! The catalogues were the obvious source and turned out to be a dead end:
//! Deezer publishes a `bpm` field that reads 0 for almost everything outside
//! the charts, and Spotify's audio-features endpoint is behind a token the
//! anonymous web player no longer mints. Meanwhile the server is sitting on the
//! actual audio files. So the tempo is computed here, which is both more
//! accurate for a personal library full of small artists and more in keeping
//! with the rest of this server: nothing leaves the box.
//!
//! The method is the standard one, kept deliberately small:
//!
//! 1. ffmpeg decodes a minute from the middle of the track (the middle, because
//!    intros and fade-outs are the least rhythmic part of a song) down to mono
//!    at 11 kHz - plenty for beats, which live under 200 Hz and in broadband
//!    transients.
//! 2. A spectral-flux onset envelope: how much the spectrum GREW frame to
//!    frame. Growth is what a drum hit is; steady tone is not.
//! 3. Autocorrelation of that envelope over the lags that correspond to 60-190
//!    BPM. The lag that best predicts itself is the beat period.
//!
//! Octave errors - hearing 85 as 170 - are the classic failure, so the search
//! is weighted toward the range most music actually occupies and a winner
//! outside it is compared against its own half and double before being kept.

use std::path::Path;
use std::process::Stdio;

/// Decode rate. Beats are low-frequency and broadband; 11 kHz is ample and
/// keeps the FFT work trivial on a small box.
const RATE: usize = 11_025;
/// FFT window (~46 ms) and hop (~12 ms), giving ~86 envelope frames a second -
/// fine enough to place a beat inside a few milliseconds.
const FFT_SIZE: usize = 512;
const HOP: usize = 128;
/// Seconds decoded, and where from.
const SKIP_SECS: &str = "30";
const TAKE_SECS: &str = "60";

/// Frames per second of the onset envelope.
fn fps() -> f64 {
    RATE as f64 / HOP as f64
}

/// Reads a mono f32 stream of the middle of the file. None when ffmpeg is
/// missing, the format defeats it, or the track is too short to judge.
async fn decode(input: &std::ffi::OsStr) -> Option<Vec<f32>> {
    // The middle first, then the whole thing. The second pass is what rescues
    // anything shorter than the skip - interludes, sketches, sub-90-second
    // songs - which would otherwise silently have no tempo at all.
    for skip in [SKIP_SECS, "0"] {
        let out = tokio::process::Command::new("ffmpeg")
            .args(["-v", "quiet", "-ss", skip, "-t", TAKE_SECS, "-i"])
            .arg(input)
            .args(["-ac", "1", "-ar", &RATE.to_string(), "-f", "f32le", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await
            .ok()?;
        // Ten seconds is the floor: fewer frames than that and the
        // autocorrelation is reading noise.
        if out.status.success() && out.stdout.len() >= RATE * 4 * 10 {
            return Some(
                out.stdout
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect(),
            );
        }
    }
    None
}

/// The onset envelope: per frame, how much the magnitude spectrum grew.
fn onset_envelope(samples: &[f32]) -> Vec<f32> {
    use rustfft::{num_complex::Complex, FftPlanner};
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    // Hann, so a beat landing at a window edge is not smeared into the next.
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let x = std::f32::consts::PI * 2.0 * i as f32 / FFT_SIZE as f32;
            0.5 - 0.5 * x.cos()
        })
        .collect();

    let bins = FFT_SIZE / 2;
    let mut prev = vec![0.0f32; bins];
    let mut env = Vec::with_capacity(samples.len() / HOP);
    let mut buf = vec![Complex { re: 0.0f32, im: 0.0f32 }; FFT_SIZE];

    let mut start = 0;
    while start + FFT_SIZE <= samples.len() {
        for i in 0..FFT_SIZE {
            buf[i] = Complex { re: samples[start + i] * window[i], im: 0.0 };
        }
        fft.process(&mut buf);

        let mut flux = 0.0f32;
        for k in 0..bins {
            // Log compression: without it a loud chorus dominates the whole
            // envelope and the quiet verse contributes no beats at all.
            let mag = (1.0 + buf[k].norm()).ln();
            let grew = mag - prev[k];
            if grew > 0.0 {
                flux += grew;
            }
            prev[k] = mag;
        }
        env.push(flux);
        start += HOP;
    }
    env
}

/// Subtracts a local average and rectifies, so what remains is peaks rather
/// than loudness. Without this the autocorrelation locks onto song structure
/// (the chorus arriving every 30 seconds) instead of the beat.
fn sharpen(env: &[f32]) -> Vec<f32> {
    let w = (fps() as usize).max(1); // ~1s window
    let mut out = Vec::with_capacity(env.len());
    for i in 0..env.len() {
        let lo = i.saturating_sub(w);
        let hi = (i + w + 1).min(env.len());
        let mean: f32 = env[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
        out.push((env[i] - mean).max(0.0));
    }
    out
}

/// Autocorrelation at one lag, normalised by overlap length.
fn autocorr(x: &[f32], lag: usize) -> f32 {
    if lag >= x.len() {
        return 0.0;
    }
    let n = x.len() - lag;
    let mut sum = 0.0f32;
    for i in 0..n {
        sum += x[i] * x[i + lag];
    }
    sum / n as f32
}

/// The tempo of one file, in BPM. None when it cannot be told confidently.
pub async fn analyze(path: &Path) -> Option<f64> {
    analyze_input(path.as_os_str()).await
}

/// The tempo of a track the server does not own, measured off the catalogue's
/// own thirty-second preview. ffmpeg reads the URL directly, so nothing is
/// written to disk - and thirty seconds is comfortably above the ten the
/// autocorrelation needs.
pub async fn analyze_url(url: &str) -> Option<f64> {
    analyze_input(std::ffi::OsStr::new(url)).await
}

async fn analyze_input(input: &std::ffi::OsStr) -> Option<f64> {
    let samples = decode(input).await?;
    // The DSP is CPU-bound and long enough to matter; keep it off the async
    // worker that other requests are sharing.
    tokio::task::spawn_blocking(move || estimate(&samples)).await.ok()?
}

fn estimate(samples: &[f32]) -> Option<f64> {
    let env = sharpen(&onset_envelope(samples));
    if env.len() < 200 {
        return None;
    }
    let fps = fps();

    // Lags spanning 60-190 BPM.
    let lag_for = |bpm: f64| (60.0 * fps / bpm).round() as usize;
    let min_lag = lag_for(190.0).max(2);
    let max_lag = lag_for(60.0).min(env.len() / 2);
    if max_lag <= min_lag {
        return None;
    }

    let mut best = (0.0f32, 0usize);
    for lag in min_lag..=max_lag {
        let bpm = 60.0 * fps / lag as f64;
        // A gentle prior toward the range most music sits in. Not a hard
        // filter - a genuine 170 BPM track should still win on strength - but
        // enough to break ties away from the octave errors.
        let prior = (-((bpm - 120.0) / 90.0).powi(2)).exp() as f32;
        let score = autocorr(&env, lag) * (0.6 + 0.4 * prior);
        if score > best.0 {
            best = (score, lag);
        }
    }
    if best.1 == 0 {
        return None;
    }

    let bpm = 60.0 * fps / best.1 as f64;
    // Octave check: if the half or double of the winner sits in the comfortable
    // range and the winner does not, trust the relative - a strong beat and its
    // half-time are the same signal, and only one of them is the tempo people
    // would tap.
    let comfy = |b: f64| (70.0..=170.0).contains(&b);
    let candidates = [bpm, bpm * 2.0, bpm / 2.0];
    let picked = if comfy(bpm) {
        bpm
    } else {
        candidates.into_iter().find(|b| comfy(*b)).unwrap_or(bpm)
    };
    (30.0..=220.0).contains(&picked).then_some((picked * 10.0).round() / 10.0)
}
