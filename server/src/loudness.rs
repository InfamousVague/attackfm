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
            let mut said = false;
            for (id, rel) in pending {
                // Resolved rather than joined: the same guard every other
                // reader of this library uses, which also means a row whose
                // file has gone is skipped here instead of failing ffmpeg.
                let Some(path) = crate::stream::resolve_in_root(&state.music_root, &rel) else {
                    if !said {
                        eprintln!("[loudness] cannot resolve {rel} under the music root");
                        said = true;
                    }
                    continue;
                };
                match measure_reported(&path).await {
                    Ok(m) => {
                        if let Err(e) = state.db.save_loudness(id, m.lufs, m.peak_db, m.lra) {
                            eprintln!("[loudness] could not store track {id}: {e}");
                            tokio::time::sleep(FAIL_PAUSE).await;
                        }
                        // The shape came free with the measurement. A track
                        // whose progress lines were unreadable still gets its
                        // three numbers - the drawing is the nicety, the
                        // loudness is the thing playback needs.
                        if !m.wave.is_empty() {
                            if let Err(e) = state.db.save_waveform(id, &m.wave) {
                                eprintln!("[loudness] could not store shape for {id}: {e}");
                            }
                        }
                    }
                    Err(why) => {
                        // Once per batch: a library with a bad codec in it
                        // should say so, not print four thousand times.
                        if !said {
                            eprintln!("[loudness] {} - {why}", path.display());
                            said = true;
                        }
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

/// `GET /api/waveform/:id` - one track's shape, for drawing on the seek bar.
///
/// Asked for per track rather than shipped with the library, which is the same
/// rule the transcripts and the chapter notes keep: two hundred bytes is
/// nothing on its own and six thousand of them is a payload a phone thinks
/// twice about. The client asks when a track is opened and holds the answer.
///
/// Plain numbers rather than base64: the array costs a few hundred bytes more
/// over the wire, gzips to about the same, and saves the client a decode step
/// on the one path that runs while music is starting.
pub async fn shape(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i64>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    match state.db.waveform(id) {
        Some(columns) => Ok(Json(json!({ "columns": columns }))),
        // Not an error: the sweep simply has not reached this one yet, and the
        // client draws its live meter instead. A 404 would make every
        // unmeasured track print a failure in the console.
        None => Ok(Json(json!({ "columns": serde_json::Value::Null }))),
    }
}

/// One decimal is the whole useful precision of a loudness measurement, and
/// it halves the payload against the raw f64s.
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// How many columns a stored waveform is drawn from.
///
/// A seek bar is a few hundred pixels wide at most, on the widest window this
/// app has; 200 columns is finer than anyone can point at and costs 200 bytes.
/// Fixed rather than per-second, so a three-minute song and a twelve-hour book
/// cost the same and the client can draw either without knowing the duration.
pub const WAVE_COLUMNS: usize = 200;

/// The floor a column is measured against, in dB below the track's own
/// loudest moment. Wider and a quiet intro flattens into the baseline; much
/// narrower and everything reads as full height. 45 dB keeps a real intro
/// visible while still letting a drop look like a drop.
const WAVE_RANGE_DB: f64 = 45.0;

/// What one pass of ebur128 tells us.
#[derive(Debug, Clone)]
pub struct Measured {
    pub lufs: f64,
    pub peak_db: f64,
    pub lra: f64,
    /// The track's shape: `WAVE_COLUMNS` heights, 0-255, or empty when the
    /// progress lines were unreadable. Free - see `envelope`.
    pub wave: Vec<u8>,
}

/// The same, with the reason kept. A job that can only say "it did not work"
/// is a job nobody can debug from the outside - which is exactly the hole
/// this fell into on its first deploy, sitting at zero measurements with an
/// empty log.
pub async fn measure_reported(path: &Path) -> Result<Measured, String> {
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
        .map_err(|e| format!("could not start ffmpeg: {e}"))?;

    let stderr = child.stderr.take().ok_or("ffmpeg gave no stderr")?;
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
        return Err(format!("timed out after {}s", TIMEOUT.as_secs()));
    }
    let text = reader.await.map_err(|e| format!("could not read ffmpeg: {e}"))?;
    parse(&text)
        .map(|m| Measured { wave: envelope(&text), ..m })
        .ok_or_else(|| {
            // ffmpeg's own last words are far more use than "parse failed" -
            // they name a missing file, a codec it lacks, or a permission.
            let tail: Vec<&str> = text
                .lines()
                .rev()
                .filter(|l| !l.trim().is_empty())
                .take(2)
                .collect();
            format!("no usable summary ({})", tail.join(" | "))
        })
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
        // Filled by the caller, which still has the whole of stderr; `parse`
        // is given only the summary's job so its tests stay about the summary.
        wave: Vec::new(),
    })
}

/*
 * The track's shape, out of the same breath.
 *
 * ebur128 does not only print a summary. On the way through it prints one
 * progress line per 100ms of audio, each carrying the momentary loudness of
 * the moment it just passed:
 *
 *   [Parsed_ebur128_0 @ 0x...] t: 7.90  TARGET:-23 LUFS  M: -27.8  S: -27.8 ...
 *
 * That is a 10Hz envelope of the whole file - the quiet intro, the drop, the
 * long outro - and until now it was read into a String, scanned for the last
 * "Summary:", and thrown away. Keeping it costs nothing: no second decode, no
 * second pass, not even a second read. The file is already being walked.
 *
 * WHY MOMENTARY AND NOT TRUE PEAK. The lines also carry `FTPK`, the frame's
 * true peak, which is closer to what a sample-accurate waveform drawing shows.
 * Momentary loudness is the better answer here anyway: it is gated and
 * K-weighted, so it tracks what the track SOUNDS like rather than what its
 * samples reach, and a brickwalled master does not flatten into a solid block.
 *
 * WHY RELATIVE dB AND NOT LINEAR AMPLITUDE. Scaling `10^(dB/20)` against the
 * loudest column is technically the honest amplitude, and it draws a quiet
 * intro 26dB down as five percent of the height - a flat line. Heights are
 * therefore dB below the track's own peak, over `WAVE_RANGE_DB`, which is what
 * every waveform display worth looking at does.
 */
fn envelope(text: &str) -> Vec<u8> {
    // Momentary values in order, one per 100ms.
    let mut moments: Vec<f64> = Vec::new();
    for line in text.lines() {
        // Only the progress lines, never the summary block - which repeats
        // these field names with the final values and would otherwise add a
        // phantom column.
        if !line.contains(" t: ") {
            continue;
        }
        let Some(at) = line.find("M:") else { continue };
        // `M:-120.7` and `M: -22.3` are both printed, depending on how wide
        // the number is; splitting on whitespace alone loses the first.
        let rest = line[at + 2..].trim_start();
        let Some(word) = rest.split_whitespace().next() else { continue };
        let Ok(v) = word.parse::<f64>() else { continue };
        moments.push(v);
    }
    if moments.len() < 4 {
        return Vec::new();
    }

    /*
     * The first few readings are an artefact, not silence.
     *
     * Momentary loudness is a 400ms window, so until 400ms of audio has gone
     * through it the window is part empty and reads near the -120 floor. Every
     * track would otherwise start with a four-column notch that is not in the
     * music. They are dropped rather than clamped, because clamping would draw
     * them as real silence at the very place a listener looks first.
     */
    let start = moments.len().min(4);
    let moments = &moments[start..];
    if moments.is_empty() {
        return Vec::new();
    }

    // The loudest moment is the top of the drawing. `-inf` and the floor are
    // not moments, they are the absence of one.
    let peak = moments
        .iter()
        .copied()
        .filter(|v| v.is_finite() && *v > -70.0)
        .fold(f64::NEG_INFINITY, f64::max);
    if !peak.is_finite() {
        return Vec::new();
    }

    let mut out = Vec::with_capacity(WAVE_COLUMNS);
    for col in 0..WAVE_COLUMNS {
        let from = col * moments.len() / WAVE_COLUMNS;
        let to = (((col + 1) * moments.len()) / WAVE_COLUMNS).max(from + 1);
        // The loudest moment in the column, not the average: averaging in a
        // log domain is meaningless, and a peak-held column is what makes a
        // single hit read as a hit rather than as a smear.
        let loudest = moments[from..to.min(moments.len())]
            .iter()
            .copied()
            .filter(|v| v.is_finite())
            .fold(f64::NEG_INFINITY, f64::max);
        let height = if loudest.is_finite() {
            ((1.0 + (loudest - peak) / WAVE_RANGE_DB).clamp(0.0, 1.0) * 255.0).round()
        } else {
            0.0
        };
        out.push(height as u8);
    }
    out
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

    /// The whole path, against real ffmpeg: generate a tone at a known level,
    /// measure it, and check the answer. Skips itself where there is no
    /// ffmpeg rather than failing a machine that was never going to pass.
    #[tokio::test]
    async fn measures_a_real_file_end_to_end() {
        let dir = std::env::temp_dir().join("afm-loudness-test");
        let _ = std::fs::create_dir_all(&dir);
        let wav = dir.join("tone.flac");
        let made = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("sine=frequency=440:duration=6:sample_rate=44100,pan=stereo|c0=c0|c1=c0")
            .args(["-af", "volume=-9dB"])
            .arg(&wav)
            .status();
        match made {
            Ok(st) if st.success() => {}
            // No ffmpeg here, or it refused: not this test's business.
            _ => return,
        }
        let m = measure(&wav).await.expect("a generated tone measures");
        // A -9 dBFS sine sits near -21 LUFS; the tolerance is wide because the
        // point is "it read the file and produced a sane number", not a
        // calibration check on ffmpeg's own filter.
        assert!(m.lufs < -5.0 && m.lufs > -40.0, "implausible loudness: {}", m.lufs);
        assert!(m.peak_db <= 0.0, "peak above full scale: {}", m.peak_db);
        let _ = std::fs::remove_file(&wav);
    }

    #[test]
    fn the_running_lines_above_the_summary_do_not_win() {
        // The per-frame line at the top carries I: and LRA: too. Reading it
        // instead of the summary would report whatever the loudness happened
        // to be at that moment.
        let m = parse(REAL).expect("summary parses");
        assert!((m.lufs - -27.8).abs() < 0.001, "took the summary, not the frame line");
    }

    /// One progress line, as ffmpeg actually prints it.
    fn line(t: f64, m: f64) -> String {
        // The no-space form is deliberate for wide numbers: ffmpeg pads the
        // field, so `M:-120.7` and `M: -22.3` both occur and a parser that
        // splits on whitespace alone silently loses the first.
        let m_field = if m <= -100.0 {
            format!("M:{m:.1}")
        } else {
            format!("M: {m:.1}")
        };
        format!(
            "[Parsed_ebur128_0 @ 0x1] t: {t:.4}  TARGET:-23 LUFS    {m_field} S: {m:.1}     I: -22.3 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.5 dBFS"
        )
    }

    /// A quiet intro, a loud middle, a quiet outro - and the drawing says so.
    #[test]
    fn envelope_follows_the_shape() {
        let mut text = String::new();
        // 4 leading window-fill readings at the floor, then 300 real ones.
        for i in 0..4 {
            text.push_str(&line(i as f64 * 0.1, -120.7));
            text.push('\n');
        }
        for i in 0..300 {
            let t = 0.4 + i as f64 * 0.1;
            let m = if i < 100 {
                -47.8
            } else if i < 200 {
                -21.8
            } else {
                -43.7
            };
            text.push_str(&line(t, m));
            text.push('\n');
        }

        let w = envelope(&text);
        assert_eq!(w.len(), WAVE_COLUMNS, "one column per slot");

        let third = WAVE_COLUMNS / 3;
        let intro = w[third / 2] as f64;
        let middle = w[WAVE_COLUMNS / 2] as f64;
        let outro = w[WAVE_COLUMNS - third / 2] as f64;

        assert_eq!(middle, 255.0, "the loudest stretch is the top of the drawing");
        assert!(intro < middle, "the intro reads quieter than the drop");
        assert!(outro < middle, "so does the outro");
        // 26dB down over a 45dB range is a bit above two fifths height - the
        // point being that it is VISIBLE, which a linear amplitude scaling
        // (5% of full) would not be.
        assert!(
            (0.30..0.55).contains(&(intro / 255.0)),
            "a 26dB-down intro should sit near two fifths, got {}",
            intro / 255.0
        );
        assert!(outro > intro, "the outro is 4dB louder than the intro");
    }

    /// The window-fill floor at the head is dropped, not drawn as silence.
    #[test]
    fn envelope_drops_the_windows_fill() {
        let mut text = String::new();
        for i in 0..4 {
            text.push_str(&line(i as f64 * 0.1, -120.7));
            text.push('\n');
        }
        for i in 0..200 {
            text.push_str(&line(0.4 + i as f64 * 0.1, -20.0));
            text.push('\n');
        }
        let w = envelope(&text);
        assert!(
            w.iter().all(|&h| h == 255),
            "a track at one level is one level all the way across, with no notch at the start"
        );
    }

    /// Nothing usable in, nothing out - never a drawing of noise.
    #[test]
    fn envelope_refuses_what_it_cannot_read() {
        assert!(envelope("").is_empty());
        assert!(envelope("[Parsed_ebur128_0 @ 0x1] Summary:\n  I: -22.3 LUFS").is_empty());
        // All floor: no moment to measure the others against.
        let mut floor = String::new();
        for i in 0..40 {
            floor.push_str(&line(i as f64 * 0.1, -120.7));
            floor.push('\n');
        }
        assert!(envelope(&floor).is_empty());
    }
}
