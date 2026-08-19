//! How loud a track actually is, so playback can even the library out.
//!
//! A library assembled over twenty years is a loudness war in a box: a 1979
//! vinyl rip sits ten decibels under a 2019 remaster, and the listener pays
//! for it with the volume knob. Every serious player has solved this the same
//! way since ReplayGain in 2001 - measure each track once, store the number,
//! and apply the difference at playback - and this is that measurement.
//!
//! Three numbers, all from one pass of ffmpeg's `ebur128` filter, which is the
//! ITU-R BS.1770 / EBU R128 standard the whole industry agrees on:
//!
//!   I    integrated loudness (LUFS) - the whole track's perceived level,
//!        gated so silence and fade-outs do not drag it down.
//!   TP   true peak (dBTP) - the highest the waveform ACTUALLY reaches once
//!        reconstructed, which is what decides whether a boost is safe.
//!   LRA  loudness range (LU) - how far the quiet parts sit below the loud
//!        ones. The honest answer to "is this master crushed".
//!
//! Deliberately not done here: applying it. The gain is a client decision -
//! it depends on the listener's target and on whether they want album or
//! track normalisation - and doing it here would force every stream through
//! the encoder just to change a volume. The client multiplies one gain node
//! instead, which costs nothing and leaves the raw file path untouched.
//!
//! The job is as polite as features.rs, for the same reason: it shares a box
//! with live playback. One track at a time, a gap between tracks, a long
//! stand-down after any failure, and a full stop when there is no ffmpeg.

use crate::auth;
use crate::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::json;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

/// Tracks claimed per sweep of the database. Small: the point is a steady
/// trickle that finishes eventually, not a stampede that finishes sooner.
const BATCH: i64 = 24;
/// The politeness gap between tracks. A full decode is heavier than
/// features.rs's ninety-second sip, so this is longer.
const TRACK_GAP: Duration = Duration::from_secs(6);
/// How long the loop stands down after anything fails - a failing decode is
/// exactly when the disk is likely wanted elsewhere.
const FAIL_PAUSE: Duration = Duration::from_secs(90);
/// Between passes once every live track has a reading.
const IDLE_SLEEP: Duration = Duration::from_secs(600);
/// A track that takes longer than this to measure is not worth the box it is
/// starving; ffmpeg is killed and the track left unmeasured for a later pass.
const TIMEOUT: Duration = Duration::from_secs(180);

/// Starts the loudness analyser. Runs until the process ends.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        if !state.ffmpeg {
            // Said once, here, rather than once per track forever.
            eprintln!("[loudness] no ffmpeg on PATH - loudness analysis is off");
            return;
        }
        // Boot belongs to the scanner; this can wait a minute.
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            let pending = state.db.tracks_needing_loudness(BATCH);
            if pending.is_empty() {
                tokio::time::sleep(IDLE_SLEEP).await;
                continue;
            }
            for (id, rel) in pending {
                let path = state.music_root.join(&rel);
                match measure(&path).await {
                    Some(m) => {
                        if let Err(e) = state.db.save_loudness(id, m.lufs, m.peak_db, m.lra) {
                            eprintln!("[loudness] could not store track {id}: {e}");
                            tokio::time::sleep(FAIL_PAUSE).await;
                        }
                    }
                    None => {
                        // No row is written, so the track is simply offered
                        // again next pass. A file ffmpeg cannot read is worth
                        // retrying after a restart or a re-rip, and writing a
                        // sentinel would only make that harder.
                        tokio::time::sleep(FAIL_PAUSE).await;
                    }
                }
                tokio::time::sleep(TRACK_GAP).await;
            }
        }
    });
}

/// `GET /api/loudness` - every measurement, as the client's lookup table.
///
/// Rows rather than objects: one line per track instead of four repeated key
/// names, which is the difference between a payload a phone holds happily and
/// one it thinks twice about. `[trackId, lufs, peakDb, lra]`.
///
/// `target` rides along so the server owns the reference level. -14 LUFS is
/// where streaming has trained everyone's ears; a listener who prefers the
/// ReplayGain-era -18 changes it on the client, which is why the client is
/// what applies the gain.
pub async fn table(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let rows: Vec<serde_json::Value> = state
        .db
        .all_loudness()
        .into_iter()
        .map(|(id, lufs, peak, lra)| {
            json!([id, round1(lufs), round1(peak), round1(lra)])
        })
        .collect();
    Ok(Json(json!({ "target": -14.0, "tracks": rows })))
}

/// One decimal is the whole useful precision of a loudness measurement, and
/// it halves the payload against the raw f64s.
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// What one pass of ebur128 tells us.
#[derive(Debug, Clone, Copy)]
pub struct Measured {
    pub lufs: f64,
    pub peak_db: f64,
    pub lra: f64,
}

/// Measures one file. None when ffmpeg fails, times out, or prints a summary
/// this cannot read - in every case the caller simply tries again later.
pub async fn measure(path: &Path) -> Option<Measured> {
    let mut child = tokio::process::Command::new("ffmpeg")
        .arg("-nostdin")
        .arg("-v")
        .arg("info")
        .arg("-i")
        .arg(path)
        // `peak=true` is what turns on the true-peak measurement; without it
        // the summary carries loudness but no ceiling, and a ceiling is the
        // half that keeps a boost from clipping.
        .arg("-af")
        .arg("ebur128=peak=true")
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // ebur128 prints its summary to stderr, as ffmpeg prints everything
        // that is not the output stream.
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let stderr = child.stderr.take()?;
    let reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        let mut stderr = stderr;
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let waited = tokio::time::timeout(TIMEOUT, child.wait()).await;
    if waited.is_err() {
        let _ = child.kill().await;
        return None;
    }
    let text = reader.await.ok()?;
    parse(&text)
}

/// Pulls the three numbers out of ebur128's trailing summary.
///
/// The block looks like this, indented, at the very end of stderr:
///
/// ```text
/// [Parsed_ebur128_0 @ 0x...] Summary:
///
///   Integrated loudness:
///     I:         -14.2 LUFS
///     Threshold: -24.8 LUFS
///
///   Loudness range:
///     LRA:         7.4 LU
///     ...
///
///   True peak:
///     Peak:       -0.3 dBFS
/// ```
///
/// Parsed by walking for the labels rather than by line offsets: ffmpeg's
/// summary has gained and lost lines across versions, and a parser keyed on
/// position breaks silently on the next upgrade - as a wrong loudness number,
/// which is worse than no number.
fn parse(text: &str) -> Option<Measured> {
    // The summary is the LAST such block: ffmpeg prints per-frame lines above
    // it that carry the same field names with running values.
    let summary_at = text.rfind("Summary:")?;
    let tail = &text[summary_at..];

    let mut lufs: Option<f64> = None;
    let mut lra: Option<f64> = None;
    let mut peak: Option<f64> = None;
    // Which sub-block we are in, because "Peak:" appears under both "True
    // peak" and (in some builds) "Sample peak", and only the true one is the
    // ceiling that matters.
    let mut in_true_peak = false;

    for line in tail.lines() {
        let t = line.trim();
        if t.starts_with("True peak") {
            in_true_peak = true;
            continue;
        }
        if t.starts_with("Sample peak") {
            in_true_peak = false;
            continue;
        }
        if let Some(v) = after_label(t, "I:") {
            lufs = Some(v);
        } else if let Some(v) = after_label(t, "LRA:") {
            lra = Some(v);
        } else if in_true_peak {
            if let Some(v) = after_label(t, "Peak:") {
                peak = Some(v);
            }
        }
    }

    let lufs = lufs?;
    // A silent or near-silent file measures as -inf (ffmpeg prints "-inf" or a
    // very large negative). Storing that would ask the client for an infinite
    // boost, so it is refused as unmeasurable.
    if !lufs.is_finite() || lufs < -70.0 {
        return None;
    }
    Some(Measured {
        lufs,
        // A missing true peak is treated as "assume the worst": 0 dBTP leaves
        // no room, so the client will decline to boost rather than clip.
        peak_db: peak.filter(|p| p.is_finite()).unwrap_or(0.0),
        lra: lra.filter(|l| l.is_finite()).unwrap_or(0.0),
    })
}

/// The number after `label` on a line, if the line is that label's.
fn after_label(line: &str, label: &str) -> Option<f64> {
    let rest = line.strip_prefix(label)?;
    rest.split_whitespace().next()?.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real ffmpeg 8.1 summary, verbatim from a measured file.
    /// Captured verbatim from ffmpeg 8.1 - including the muxer lines that
    /// follow the summary, which is why the parser hunts for the LAST
    /// "Summary:" rather than reading from the end of stderr.
    const REAL: &str = r#"
[Parsed_ebur128_0 @ 0x14e704080] t: 7.90  TARGET:-23 LUFS    M: -27.8 S: -27.8     I: -27.8 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x7c50c24900] Summary:

  Integrated loudness:
    I:         -27.8 LUFS
    Threshold: -37.7 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -47.7 LUFS
    LRA low:   -27.8 LUFS
    LRA high:  -27.8 LUFS

  True peak:
    Peak:      -27.1 dBFS
[out#0/null @ 0x7c50c24180] video:0KiB audio:1378KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:00:08.00 bitrate=N/A speed= 315x elapsed=0:00:00.02
"#;

    #[test]
    fn reads_a_real_summary() {
        let m = parse(REAL).expect("summary parses");
        assert!((m.lufs - -27.8).abs() < 0.001);
        assert!((m.lra - 0.0).abs() < 0.001);
        assert!((m.peak_db - -27.1).abs() < 0.001);
    }

    #[test]
    fn prefers_true_peak_over_sample_peak() {
        // Some builds print both. The true peak is the higher, later number,
        // and it is the one a boost has to respect.
        let both = REAL.replace(
            "  True peak:\n    Peak:      -27.1 dBFS",
            "  Sample peak:\n    Peak:      -29.9 dBFS\n\n  True peak:\n    Peak:      -27.1 dBFS",
        );
        let m = parse(&both).expect("summary parses");
        assert!((m.peak_db - -27.1).abs() < 0.001);
    }

    #[test]
    fn silence_is_unmeasurable_rather_than_infinitely_quiet() {
        let quiet = REAL.replace("I:         -27.8 LUFS", "I:         -inf LUFS");
        assert!(parse(&quiet).is_none());
        let floor = REAL.replace("I:         -27.8 LUFS", "I:         -91.2 LUFS");
        assert!(parse(&floor).is_none());
    }

    #[test]
    fn a_missing_peak_refuses_headroom_rather_than_inventing_it() {
        let no_peak = REAL.replace("  True peak:\n    Peak:      -27.1 dBFS", "");
        let m = parse(&no_peak).expect("loudness still parses");
        assert_eq!(m.peak_db, 0.0);
    }

    #[test]
    fn the_running_lines_above_the_summary_do_not_win() {
        // The per-frame line at the top carries I: and LRA: too. Reading it
        // instead of the summary would report whatever the loudness happened
        // to be at that moment.
        let m = parse(REAL).expect("summary parses");
        assert!((m.lufs - -27.8).abs() < 0.001, "took the summary, not the frame line");
    }
}
