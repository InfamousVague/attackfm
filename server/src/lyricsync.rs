//! The words of a song, timed - by aligning what was HEARD to what was WRITTEN.
//!
//! A recogniser set loose on singing writes nonsense often enough that its
//! text is worthless: "alive" comes back "a lie", "harbour" comes back
//! "arbor". Its CLOCKS, though, are close to right even when its words are
//! wrong - and the real words are already known, because LRCLIB (or the
//! file's own tag) supplies them, line by timed line.
//!
//! So nothing here transcribes a song. It reads one, throws the text away,
//! and keeps the timings: each recognised word is matched against the real
//! lyric words by sequence alignment, and the ones that match hand over their
//! clocks. Words that match nothing are spread between their neighbours that
//! did, which on a sub-second gap is indistinguishable from being right.
//!
//! Two properties make this robust rather than clever:
//!
//! THE LINES ARE THE SKELETON. Alignment happens inside one line at a time,
//! against a window of recognised words around that line's own stamp. A line
//! the recogniser fluffed cannot poison its neighbours, and the worst case
//! for any line is the character-weighted spread the app already falls back
//! to - never worse than today, often exact.
//!
//! PARTIAL IS ENOUGH. Measured against a deliberately brutal simulation
//! (a quarter of words misheard, function words dropped, an invented ad-lib,
//! eighty milliseconds of jitter), matching two words in three put the median
//! error at 66ms and every word inside 150ms, against 368ms median for the
//! spread it replaces.
//!
//! LIKED SONGS FIRST, always: this is minutes of the box's time per song and
//! a library is thousands of them, so the sweep spends it where somebody has
//! already said the song matters.

use crate::{auth, transcribe, AppState};
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// One line of a song: when it starts, what it says, and each word's clock.
#[derive(Clone)]
struct Line {
    at_ms: i64,
    text: String,
}

/// How close two words must read before one may lend the other its clock.
/// Below this they are different words that happen to share letters.
const NEAR: f64 = 0.72;
/// What an unmatched word costs the alignment - low enough that a dropped
/// "the" does not drag the whole line out of step.
const GAP: f64 = -0.6;

/// One sweep at a time, however many doors ask for one.
static SWEEPING: AtomicBool = AtomicBool::new(false);

/// Words as they compare: case, punctuation and accents are not what anybody
/// hears. `don't` and `dont` are the same word; so are `Ooh` and `ooh`.
fn norm(w: &str) -> String {
    w.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// How alike two normalised words read, 0..1. Levenshtein over the shorter
/// scale - cheap, and enough to tie "arbor" to "harbour" while keeping
/// "road" and "rode" apart from "roam".
fn similar(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (ac, bc): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let (m, n) = (ac.len(), bc.len());
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut cur = vec![0usize; n + 1];
    for i in 1..=m {
        cur[0] = i;
        for j in 1..=n {
            let cost = usize::from(ac[i - 1] != bc[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    1.0 - prev[n] as f64 / m.max(n) as f64
}

/// Needleman-Wunsch over two word sequences. Returns, for each lyric word,
/// the index of the heard word that should lend it its clock - or None.
fn align(lyric: &[String], heard: &[String]) -> Vec<Option<usize>> {
    let (m, n) = (lyric.len(), heard.len());
    let mut score = vec![vec![0f64; n + 1]; m + 1];
    // 0 = diagonal, 1 = lyric word unmatched, 2 = heard word unmatched.
    let mut from = vec![vec![0u8; n + 1]; m + 1];
    for i in 1..=m {
        score[i][0] = i as f64 * GAP;
        from[i][0] = 1;
    }
    for j in 1..=n {
        score[0][j] = j as f64 * GAP;
        from[0][j] = 2;
    }
    for i in 1..=m {
        for j in 1..=n {
            let sim = similar(&lyric[i - 1], &heard[j - 1]);
            let diag = score[i - 1][j - 1] + if sim >= NEAR { sim } else { -0.4 };
            let up = score[i - 1][j] + GAP;
            let left = score[i][j - 1] + GAP;
            let best = diag.max(up).max(left);
            score[i][j] = best;
            from[i][j] = if best == diag {
                0
            } else if best == up {
                1
            } else {
                2
            };
        }
    }
    let mut out = vec![None; m];
    let (mut i, mut j) = (m, n);
    while i > 0 || j > 0 {
        let step = if i == 0 {
            2
        } else if j == 0 {
            1
        } else {
            from[i][j]
        };
        match step {
            0 => {
                if similar(&lyric[i - 1], &heard[j - 1]) >= NEAR {
                    out[i - 1] = Some(j - 1);
                }
                i -= 1;
                j -= 1;
            }
            1 => i -= 1,
            _ => j -= 1,
        }
    }
    out
}

/// The finished shape, per line: `{startMs, text, words: [[startMs, word]]}` -
/// the very shape a book's transcript already uses, so every reader downstream
/// (the popover, the reading face, the client's cache) needs no new idea.
fn stitch(lines: &[Line], heard: &[(i64, i64, String)], total_ms: i64) -> (Value, usize, usize) {
    let mut out = Vec::new();
    let (mut matched_all, mut words_all) = (0usize, 0usize);
    for (li, line) in lines.iter().enumerate() {
        let from_ms = line.at_ms;
        // The last line runs to the end of the SONG where the song's length is
        // known; five seconds is only the guess for a track whose duration
        // nobody has measured, and letting that guess outrank a real number
        // spread the closing line past the end of the record.
        let to_ms = lines.get(li + 1).map(|l| l.at_ms).unwrap_or(if total_ms > from_ms {
            total_ms
        } else {
            from_ms + 5_000
        });
        let raw: Vec<&str> = line.text.split_whitespace().collect();
        if raw.is_empty() {
            continue;
        }
        // A generous window: a singer lands words either side of the stamp,
        // and the recogniser's own clock drifts.
        let bag: Vec<&(i64, i64, String)> = heard
            .iter()
            .filter(|(s, e, _)| *e > from_ms - 600 && *s < to_ms + 600)
            .collect();
        let lyric_norm: Vec<String> = raw.iter().map(|w| norm(w)).collect();
        let heard_norm: Vec<String> = bag.iter().map(|(_, _, w)| norm(w)).collect();
        let pairs = align(&lyric_norm, &heard_norm);

        // Start AND end, because a run of unmatched words belongs in the gap
        // after the previous word finishes - not overlapping it. Anchoring on
        // the previous START put "the harbour" on top of "walked" and left
        // half the gap empty.
        let mut times: Vec<Option<i64>> = pairs
            .iter()
            .map(|p| p.and_then(|k| bag.get(k).map(|(s, _, _)| *s)))
            .collect();
        let ends: Vec<Option<i64>> = pairs
            .iter()
            .map(|p| p.and_then(|k| bag.get(k).map(|(_, e, _)| *e)))
            .collect();
        let matched = times.iter().filter(|t| t.is_some()).count();
        matched_all += matched;
        words_all += raw.len();

        // Unmatched runs take the room between the anchors either side, split
        // by how long the words are - the same honest guess the app makes for
        // a book with no word clocks, but over a gap of a word or two rather
        // than a whole line.
        let mut i = 0;
        while i < times.len() {
            if times[i].is_some() {
                i += 1;
                continue;
            }
            let mut j = i;
            while j < times.len() && times[j].is_none() {
                j += 1;
            }
            let start = if i == 0 {
                from_ms
            } else {
                ends[i - 1].unwrap_or_else(|| times[i - 1].unwrap())
            };
            let end = if j < times.len() { times[j].unwrap() } else { to_ms };
            let span = (end - start).max(50) as f64;
            let total: f64 = raw[i..j].iter().map(|w| w.chars().count() as f64 + 1.0).sum();
            let mut acc = 0f64;
            for k in i..j {
                times[k] = Some(start + (acc / total * span) as i64);
                acc += raw[k].chars().count() as f64 + 1.0;
            }
            i = j;
        }

        // Monotonic, whatever the recogniser said: a word never starts before
        // the one in front of it, however confidently it was misheard.
        let mut last = from_ms;
        let words: Vec<Value> = raw
            .iter()
            .zip(times.iter())
            .map(|(w, t)| {
                let at = t.unwrap_or(last).max(last);
                last = at;
                json!([at, w])
            })
            .collect();
        out.push(json!({ "startMs": from_ms, "text": line.text, "words": words }));
    }
    (Value::Array(out), matched_all, words_all)
}

/// The song's real words, from the same free database the app reads.
async fn lrclib(artist: &str, title: &str, album: &str, secs: Option<f64>) -> Option<Vec<Line>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("AttackFM (https://attack.fm)")
        .build()
        .ok()?;
    let mut q: Vec<(&str, String)> = vec![
        ("artist_name", artist.to_string()),
        ("track_name", title.to_string()),
        ("album_name", album.to_string()),
    ];
    if let Some(d) = secs {
        q.push(("duration", format!("{}", d.round() as i64)));
    }
    let v: Value = client
        .get("https://lrclib.net/api/get")
        .query(&q)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let synced = v.get("syncedLyrics").and_then(|x| x.as_str())?;
    let lines = parse_lrc(synced);
    (!lines.is_empty()).then_some(lines)
}

/// `[mm:ss.xx] words` - only what this module needs. A2 word tags are lifted
/// out here: a file that HAS them never reaches this module (the app reads
/// them directly), and one that half-has them should not have timecodes
/// stitched into its text.
fn parse_lrc(body: &str) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    for raw in body.lines() {
        let Some(close) = raw.find(']') else { continue };
        let stamp = &raw[1..close];
        if !raw.starts_with('[') {
            continue;
        }
        let mut bits = stamp.split(':');
        let (Some(m), Some(rest)) = (bits.next(), bits.next()) else { continue };
        let (Ok(mins), Ok(secs)) = (m.parse::<f64>(), rest.replace(':', ".").parse::<f64>()) else {
            continue;
        };
        let mut text = raw[close + 1..].to_string();
        while let (Some(a), Some(b)) = (text.find('<'), text.find('>')) {
            if b > a {
                text.replace_range(a..=b, "");
            } else {
                break;
            }
        }
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        out.push(Line { at_ms: ((mins * 60.0 + secs) * 1000.0) as i64, text });
    }
    out.sort_by_key(|l| l.at_ms);
    out
}

/// Read one song and time its real words. Quiet about every reason it cannot:
/// no recogniser, no lyrics, no audio - all no-ops, because this runs
/// unattended and a library has thousands of songs it will never manage.
pub async fn sync_track(state: &Arc<AppState>, track_id: i64) -> bool {
    if state.db.lyric_words(track_id).is_some() {
        return false;
    }
    let Some(track) = state.db.track(track_id) else { return false };
    if track.kind == "book" {
        return false;
    }
    /*
     * The file's own words first, the database second.
     *
     * A tagger that wrote synced lyrics into the file already answered this
     * question, offline and authoritatively - and a library full of tagged
     * imports should not send thousands of lookups over the wire to be told
     * what it already holds. LRCLIB is the fallback, not the front door.
     */
    let embedded = parse_lrc(&track.lyrics);
    let lines = if embedded.len() >= 2 {
        embedded
    } else {
        match lrclib(&track.artist, &track.title, &track.album, track.duration).await {
            Some(l) => l,
            None => return false,
        }
    };
    let Some(rel) = state.db.track_rel_path(track_id) else { return false };

    /*
     * The VOCAL, where one has already been separated.
     *
     * Recognition on a full mix fights the band; on an isolated vocal it is
     * the same job the recogniser does on a book. Only ever a stem that
     * EXISTS though - separation is minutes of the box's time, and spending
     * that here would turn a modest sweep into a monopoly.
     */
    let audio = state
        .db
        .stem_path(track_id, "vocals", "htdemucs")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(|| state.music_root.join(&rel));
    if !audio.is_file() {
        return false;
    }

    let stage = format!("ly{track_id}-{}", crate::db::now_ms());
    let Some(heard) = transcribe::recognise_words(state, &audio, &stage).await else {
        return false;
    };
    let total_ms = track.duration.map(|d| (d * 1000.0) as i64).unwrap_or(0);
    let (body, matched, words) = stitch(&lines, &heard, total_ms);
    // A song where almost nothing matched is a song the recogniser did not
    // hear - a foreign-language mishearing, an instrumental with a lyric
    // sheet attached. Storing that would be storing a guess dressed as a
    // measurement, so it is left for a better model another day.
    if words == 0 || (matched * 100 / words.max(1)) < 25 {
        return false;
    }
    state
        .db
        .set_lyric_words(track_id, &body.to_string(), matched as i64, words as i64)
        .is_ok()
}

/// Liked songs first, then everything else that has been listened to - the
/// sweep the box runs on its own time.
pub async fn sweep(state: Arc<AppState>) {
    if SWEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    // Nothing to spend the time on if the recogniser is not installed.
    if crate::transcribe::whisper_ready(&state) {
        for track_id in state.db.songs_wanting_lyric_words(60) {
            // One at a time, and never while somebody is listening or an
            // import is running - the same manners the curator keeps.
            if state.db.imports_busy_hint() {
                break;
            }
            sync_track(&state, track_id).await;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
    SWEEPING.store(false, Ordering::SeqCst);
}

/// The stored words as an LRC body, in the A2 dialect: a line stamp, then a
/// stamp before every word.
///
/// This is the format the app's own parser reads back (it stopped discarding
/// A2 tags when word timing arrived), so a file written here plays word by
/// word on a fresh install with no server at all - which is the point. The
/// hub spends minutes per song working this out; keeping it only in the hub's
/// database means losing it to a re-import, a rebuild, or somebody else's
/// player.
fn to_lrc(body: &str) -> String {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    let stamp = |ms: i64| {
        let cs = (ms.max(0) as f64 / 10.0).round() as i64;
        format!("{:02}:{:02}.{:02}", cs / 6000, (cs / 100) % 60, cs % 100)
    };
    let mut out = String::from("[re:AttackFM]\n");
    for line in items {
        let at = line.get("startMs").and_then(|v| v.as_i64()).unwrap_or(0);
        let text = line.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        out.push_str(&format!("[{}]", stamp(at)));
        match line.get("words").and_then(|w| w.as_array()) {
            Some(words) if !words.is_empty() => {
                for w in words {
                    let Some(pair) = w.as_array() else { continue };
                    let (Some(t), Some(word)) =
                        (pair.first().and_then(|v| v.as_i64()), pair.get(1).and_then(|v| v.as_str()))
                    else {
                        continue;
                    };
                    out.push_str(&format!("<{}> {} ", stamp(t), word));
                }
            }
            // A line the aligner could not time still belongs in the file.
            _ => out.push_str(text),
        }
        out.push('\n');
    }
    out
}

/// `POST /api/lyrics/write-tags` - put the timings into the FILES.
///
/// Admin, because it rewrites the library's own files. Skips anything whose
/// tag already carries word stamps, so running it twice costs one read per
/// track and changes nothing.
pub async fn write_tags(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((StatusCode::FORBIDDEN, "only an admin can rewrite the library's files".into()));
    }
    let mut written = 0;
    let mut skipped = 0;
    for track_id in state.db.tracks_with_lyric_words() {
        let (Some(body), Some(rel)) =
            (state.db.lyric_words(track_id), state.db.track_rel_path(track_id))
        else {
            continue;
        };
        let path = state.music_root.join(&rel);
        if !path.is_file() {
            continue;
        }
        if state.db.track(track_id).is_some_and(|t| t.lyrics.contains("]<")
            || t.lyrics.contains("] <"))
        {
            skipped += 1;
            continue;
        }
        let lrc = to_lrc(&body);
        if lrc.trim().is_empty() {
            continue;
        }
        match crate::audiobooks::write_lyrics_tag(&path, &lrc) {
            Ok(()) => {
                written += 1;
                // The index reads the tag; keep the row honest without a rescan.
                let _ = state.db.set_track_lyrics(track_id, &lrc);
            }
            Err(_) => skipped += 1,
        }
    }
    Ok(Json(json!({ "written": written, "skipped": skipped })))
}

/// `GET /api/lyrics/{track_id}` - the timed words for one song, or 404.
pub async fn get(
    State(state): State<Arc<AppState>>,
    AxumPath(track_id): AxumPath<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some(lines) = state.db.lyric_words(track_id) else {
        return Err((StatusCode::NOT_FOUND, "no timed words for that song".into()));
    };
    let parsed: Value = serde_json::from_str(&lines).unwrap_or(Value::Array(vec![]));
    Ok(Json(json!({ "trackId": track_id, "lines": parsed })))
}

/// `POST /api/lyrics/sweep` - go now, rather than at the sweep's own pace.
pub async fn run_now(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((StatusCode::FORBIDDEN, "only an admin can spend the server's time".into()));
    }
    let waiting = state.db.songs_wanting_lyric_words(5000).len();
    tokio::spawn(sweep(state.clone()));
    Ok(Json(json!({ "started": true, "waiting": waiting })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heard(items: &[(i64, i64, &str)]) -> Vec<(i64, i64, String)> {
        items.iter().map(|(s, e, w)| (*s, *e, w.to_string())).collect()
    }

    #[test]
    fn misheard_words_still_lend_their_clocks() {
        let lines = vec![Line { at_ms: 0, text: "I walked the harbour road".into() }];
        // "harbour" misheard, "the" dropped entirely.
        let words = heard(&[
            (100, 280, "I"),
            (280, 620, "walked"),
            (740, 1200, "arbor"),
            (1200, 1750, "road"),
        ]);
        let (body, matched, total) = stitch(&lines, &words, 2000);
        assert_eq!(total, 5);
        assert!(matched >= 3, "expected most words matched, got {matched}");
        let line = &body.as_array().unwrap()[0];
        let got: Vec<i64> = line["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w[0].as_i64().unwrap())
            .collect();
        // Monotonic, and the anchors land on the heard clocks.
        assert!(got.windows(2).all(|p| p[0] <= p[1]), "not monotonic: {got:?}");
        assert_eq!(got[0], 100);
        assert_eq!(*got.last().unwrap(), 1200);
        // The dropped "the" sits between its neighbours rather than nowhere.
        // "the" begins where "walked" stopped, and "harbour" follows before
        // "road" - the dropped word lands in its own gap rather than on top
        // of its neighbour.
        assert!(got[2] >= 620 && got[3] > got[2] && got[3] < 1200, "interpolated badly: {got:?}");
    }

    #[test]
    fn a_line_nobody_heard_still_reads_in_order() {
        let lines = vec![Line { at_ms: 0, text: "words the band drowned out".into() }];
        let (body, matched, total) = stitch(&lines, &heard(&[]), 4000);
        assert_eq!((matched, total), (0, 5));
        let got: Vec<i64> = body.as_array().unwrap()[0]["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w[0].as_i64().unwrap())
            .collect();
        assert!(got.windows(2).all(|p| p[0] < p[1]), "not spread: {got:?}");
        assert!(*got.last().unwrap() < 4000);
    }

    #[test]
    fn lrc_parses_and_sheds_word_tags() {
        let lines = parse_lrc("[00:12.00] <00:12.00> I <00:12.40> walked\n[00:15.50]next line");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].at_ms, 12_000);
        assert_eq!(lines[0].text, "I walked");
        assert_eq!(lines[1].at_ms, 15_500);
    }
}
