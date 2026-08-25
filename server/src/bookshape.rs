//! What a transcript says about the shape of a reading.
//!
//! Two things fall out of a transcript that nothing else in the app can know,
//! and both are properties of the FILE rather than of the listener - so they
//! are computed once, stored beside the transcript, and shared by everyone on
//! the server.
//!
//! **The pace.** Words divided by the span they were read across. It is the
//! number that answers "do I want 1.25x for this one" before starting rather
//! than ten minutes in, and it costs one pass over text that is already on
//! disk.
//!
//! **The card and the credits.** Nearly every ripped or public-domain reading
//! opens with a minute that is not the book - "This is a LibriVox recording,
//! all LibriVox recordings are in the public domain…", or a publisher's
//! trailer - and closes with a sponsor read or a list of who recorded it. The
//! transcript can see both, so the app can offer to start after the first and
//! stop before the second.
//!
//! HEURISTICS, DELIBERATELY, AND CONSERVATIVE ONES. The cost of a false
//! positive here is silently skipping the first minute of somebody's book,
//! which is far worse than not offering to skip at all - a listener who is
//! offered nothing has lost nothing. So every rule below has to match a known
//! phrase near a boundary, the skip is bounded to a plausible length, and the
//! answer is only ever an OFFER: nothing is applied unless the listener says
//! so, per book, and the marks are reported so a client can show what it would
//! actually cut.

use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

/// A transcript line as it is stored: `[{startMs, endMs, text}]`.
#[derive(Deserialize)]
struct Line {
    #[serde(rename = "startMs")]
    start_ms: i64,
    #[serde(rename = "endMs")]
    end_ms: i64,
    text: String,
}

/// What was found. Zeroes mean "nothing worth offering", never "start of file".
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookShape {
    /// Words per minute across the read span, rounded. 0 when unknown.
    pub wpm: i64,
    /// A word for the number, so a card does not have to own the thresholds.
    pub pace: String,
    /// Where the opening card ends and the book begins. 0 when none was found.
    pub opening_ms: i64,
    /// Where the closing credits begin. 0 when none was found.
    pub credits_ms: i64,
    /// What the opening card actually says, trimmed - so the offer can show it
    /// rather than asking somebody to trust a number.
    pub opening_text: String,
    pub credits_text: String,
    pub words: i64,
}

/// The furthest into a book an opening card may plausibly end.
///
/// Three minutes is generous for a LibriVox preamble and a title read, and
/// short enough that a mis-detection cannot eat a chapter. A "card" that
/// appears to run longer than this is not a card.
const OPENING_CEILING_MS: i64 = 3 * 60_000;

/// The same at the other end. Credits run longer than cards - a full cast list
/// or a sponsor read - but not by that much.
const CREDITS_CEILING_MS: i64 = 4 * 60_000;

/// Under this, a "book" is a clip and none of this applies.
const MIN_BOOK_MS: i64 = 5 * 60_000;

/// Phrases that only appear in a preamble, never in prose.
///
/// Deliberately specific. "public domain" alone would match a book ABOUT
/// copyright; paired with the recording's own boilerplate it does not.
const OPENING_MARKERS: &[&str] = &[
    "librivox recording",
    "librivox.org",
    "recording is in the public domain",
    "recordings are in the public domain",
    "volunteers around the world",
    "this is an audible",
    "audible studios",
    "audio book",
    "audiobook",
    "brought to you by",
    "presented by",
    "unabridged",
    "narrated by",
    "read by",
    "produced by",
    "published by",
    "copyright",
    "all rights reserved",
];

/// Phrases that mark the book STARTING - the far edge of the card.
///
/// Finding one of these is much stronger evidence than the absence of markers,
/// because it says where the prose begins rather than where the boilerplate
/// stopped being obvious.
const BOOK_STARTS: &[&str] = &[
    "chapter one",
    "chapter 1",
    "chapter i.",
    "part one",
    "book one",
    "prologue",
    "introduction",
    "preface",
    "section one",
];

/// Phrases that only appear once the reading is over.
const CREDITS_MARKERS: &[&str] = &[
    "end of",
    "the end.",
    "this has been",
    "thank you for listening",
    "thanks for listening",
    "hope you have enjoyed",
    "hope you've enjoyed",
    "librivox",
    "public domain",
    "recorded by",
    "read by",
    "narrated by",
    "audible",
    "for more information",
    "visit ",
];

fn norm(s: &str) -> String {
    s.to_lowercase()
}

fn has_marker(text: &str, markers: &[&str]) -> bool {
    let t = norm(text);
    markers.iter().any(|m| t.contains(m))
}

/// Read the shape out of a stored transcript.
///
/// `duration_ms` is the track's own length, used only as a sanity bound - the
/// transcript's last line can fall short of the file's end and that is normal.
pub fn analyse(lines_json: &str, duration_ms: i64) -> BookShape {
    let Ok(lines) = serde_json::from_str::<Vec<Line>>(lines_json) else {
        return BookShape::default();
    };
    let lines: Vec<Line> = lines.into_iter().filter(|l| !l.text.trim().is_empty()).collect();
    if lines.len() < 8 {
        return BookShape::default();
    }

    // ---- the pace ----------------------------------------------------------
    let words: i64 = lines
        .iter()
        .map(|l| l.text.split_whitespace().count() as i64)
        .sum();
    let first = lines.first().map(|l| l.start_ms).unwrap_or(0);
    let last = lines.last().map(|l| l.end_ms).unwrap_or(0);
    // The READ span, not the file's length. A file with two minutes of silence
    // welded on the end did not make its narrator slower.
    let span_ms = (last - first).max(1);
    let wpm = ((words as f64) / (span_ms as f64 / 60_000.0)).round() as i64;
    let pace = match wpm {
        0 => "",
        w if w < 125 => "unhurried",
        w if w < 145 => "measured",
        w if w < 165 => "steady",
        w if w < 185 => "brisk",
        _ => "quick",
    }
    .to_string();

    let mut shape = BookShape {
        wpm: wpm.clamp(0, 400),
        pace,
        words,
        ..Default::default()
    };

    // Nothing else applies to something too short to have a preamble.
    let total = if duration_ms > 0 { duration_ms } else { last };
    if total < MIN_BOOK_MS {
        return shape;
    }

    // ---- the opening card --------------------------------------------------
    //
    // Walk forward while the lines still look like boilerplate. Two ways to
    // stop, and the first that fires wins: a line that names the start of the
    // book (strong), or a run of lines with no marker at all (weak, and only
    // trusted once at least one marker HAS been seen).
    let mut seen_marker = false;
    let mut plain_run = 0;
    let mut opening_end = 0i64;
    let mut opening_text = String::new();
    for line in lines.iter() {
        if line.start_ms > OPENING_CEILING_MS {
            break;
        }
        if has_marker(&line.text, BOOK_STARTS) {
            // The book itself. Everything before this line is the card - but
            // only call it one if something in it actually looked like a card.
            if seen_marker {
                opening_end = line.start_ms;
            }
            break;
        }
        if has_marker(&line.text, OPENING_MARKERS) {
            seen_marker = true;
            plain_run = 0;
            opening_end = line.end_ms;
            if opening_text.len() < 180 {
                if !opening_text.is_empty() {
                    opening_text.push(' ');
                }
                opening_text.push_str(line.text.trim());
            }
        } else if seen_marker {
            plain_run += 1;
            // Three ordinary sentences in a row: the boilerplate is behind us.
            if plain_run >= 3 {
                break;
            }
        }
    }
    // A card that would skip nothing, or that ran past its ceiling, is not one.
    if seen_marker && opening_end > 2_000 && opening_end <= OPENING_CEILING_MS {
        shape.opening_ms = opening_end;
        shape.opening_text = opening_text.chars().take(180).collect();
    }

    // ---- the closing credits ----------------------------------------------
    //
    // Backwards from the end, for the FIRST line of the closing run: the last
    // line that is still prose marks where the credits start.
    let mut credits_start = 0i64;
    let mut credits_text = String::new();
    for line in lines.iter().rev() {
        if last - line.start_ms > CREDITS_CEILING_MS {
            break;
        }
        if has_marker(&line.text, CREDITS_MARKERS) {
            credits_start = line.start_ms;
            credits_text = line.text.trim().chars().take(180).collect();
        } else if credits_start > 0 {
            // Prose again, below the credits: the run has been walked past.
            break;
        }
    }
    // Must actually save something, and must not eat the end of the book.
    if credits_start > 0 && last - credits_start > 3_000 && credits_start > total / 2 {
        shape.credits_ms = credits_start;
        shape.credits_text = credits_text;
    }

    shape
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: i64, end: i64, text: &str) -> String {
        format!(r#"{{"startMs":{start},"endMs":{end},"text":"{text}"}}"#)
    }

    fn transcript(parts: Vec<String>) -> String {
        format!("[{}]", parts.join(","))
    }

    /// A LibriVox reading: the standard preamble, then the book, then the
    /// standard sign-off.
    fn librivox() -> String {
        let mut v = vec![
            line(0, 6_000, "This is a LibriVox recording."),
            line(6_000, 14_000, "All LibriVox recordings are in the public domain."),
            line(14_000, 22_000, "For more information please visit librivox.org"),
            line(22_000, 30_000, "Recording by Jane Reader, Chapter One of Middlemarch."),
        ];
        for i in 0..40 {
            let s = 30_000 + i * 20_000;
            v.push(line(s, s + 20_000, "Miss Brooke had that kind of beauty which seems to be thrown into relief by poor dress and every turn of the sentence carried on"));
        }
        let tail = 30_000 + 40 * 20_000;
        v.push(line(tail, tail + 6_000, "End of Middlemarch by George Eliot."));
        v.push(line(tail + 6_000, tail + 14_000, "This recording is in the public domain, read by Jane Reader."));
        transcript(v)
    }

    #[test]
    fn pace_comes_out_of_the_words_and_the_span() {
        let s = analyse(&librivox(), 900_000);
        assert!(s.wpm > 0, "a pace should be readable");
        assert!(!s.pace.is_empty(), "and it should have a word for it");
        assert!(s.words > 400);
    }

    #[test]
    fn the_librivox_card_is_found_and_the_book_is_not_eaten() {
        let s = analyse(&librivox(), 900_000);
        assert!(s.opening_ms > 0, "the preamble should be found");
        assert!(s.opening_ms <= 30_000, "and should not run into the prose");
        assert!(s.credits_ms > 0, "the sign-off should be found");
        assert!(s.credits_ms > 700_000, "and should be at the end, not the middle");
    }

    /// The case that matters most: a book that opens straight into prose must
    /// be offered nothing at all.
    #[test]
    fn a_book_with_no_card_offers_no_skip() {
        let mut v = Vec::new();
        for i in 0..50 {
            let s = i * 20_000;
            v.push(line(s, s + 20_000, "It was the best of times it was the worst of times it was the age of wisdom it was the age of foolishness"));
        }
        let s = analyse(&transcript(v), 1_000_000);
        assert_eq!(s.opening_ms, 0, "nothing to skip means nothing offered");
        assert_eq!(s.credits_ms, 0);
        assert!(s.wpm > 0, "but the pace is still known");
    }

    #[test]
    fn a_clip_is_not_a_book() {
        let v = vec![
            line(0, 5_000, "This is a LibriVox recording."),
            line(5_000, 10_000, "All LibriVox recordings are in the public domain."),
            line(10_000, 20_000, "A short thing that is over almost at once and has no chapters"),
            line(20_000, 30_000, "and carries on only a little longer than that before stopping"),
            line(30_000, 40_000, "with nothing much in it at all to speak of really"),
            line(40_000, 50_000, "and then it ends without ceremony or credit"),
            line(50_000, 60_000, "which is the whole of it from start to finish"),
            line(60_000, 70_000, "and there is no more to say about the matter"),
        ];
        let s = analyse(&transcript(v), 70_000);
        assert_eq!(s.opening_ms, 0, "too short to have a preamble worth skipping");
    }

    #[test]
    fn rubbish_in_is_not_a_panic() {
        assert_eq!(analyse("not json", 0).wpm, 0);
        assert_eq!(analyse("[]", 0).wpm, 0);
    }
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ShapeQuery {
    /// Comma-separated track ids. The shelf asks for everything on it at once
    /// rather than one request per book.
    ids: String,
}

/// How many books one request may ask about. A shelf is not unbounded and a
/// caller that wants more can ask twice.
const MAX_IDS: usize = 100;

/// `GET /api/books/shape?ids=1,2,3`
///
/// Any signed-in caller: this describes files in the shared library, and names
/// nobody. Answers only for books that HAVE a shape - a missing id means "not
/// transcribed, or nothing worth offering", which the client renders as
/// silence rather than as an absence.
pub async fn shape(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ShapeQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    crate::auth::require_caller(&state.db, &headers)?;
    let mut out = serde_json::Map::new();
    for raw in q.ids.split(',').take(MAX_IDS) {
        let Ok(id) = raw.trim().parse::<i64>() else {
            continue;
        };
        // Cached, or worked out now and cached. The backfill below normally
        // gets there first; this is what makes a book transcribed before any
        // of this existed still answer on the first shelf that asks.
        let shape = match state.db.book_shape(id) {
            Some(s) => Some(s),
            None => state.db.transcript(id).map(|lines| {
                let duration = state
                    .db
                    .track(id)
                    .and_then(|t| t.duration)
                    .map(|d| (d * 1000.0) as i64)
                    .unwrap_or(0);
                let s = analyse(&lines, duration);
                let _ = state.db.set_book_shape(id, &s);
                s
            }),
        };
        if let Some(s) = shape {
            out.insert(id.to_string(), serde_json::to_value(&s).unwrap_or(json!(null)));
        }
    }
    Ok(Json(json!({ "shapes": out })))
}

/// Work through transcripts made before this existed, a few at a time.
///
/// Spawned at boot and then done: analysing is milliseconds per book and the
/// list only shrinks. Bounded per lap anyway, so a library with a thousand
/// readings does not spend its first second of uptime parsing all of them.
pub fn spawn_backfill(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            let todo = state.db.tracks_needing_shape(8);
            if todo.is_empty() {
                return;
            }
            // Whether this lap actually shrank the list. The work list is
            // "transcripts with no shape row", so a lap that stores nothing
            // hands back the same ids next time - and without this the loop
            // spins on them at full speed forever. Found exactly that way: a
            // transcript whose track had gone left a foreign key that could
            // never be satisfied, and the backfill hammered the database
            // about it several times a second for as long as the server ran.
            let mut progressed = false;
            for id in todo {
                let duration = state
                    .db
                    .track(id)
                    .and_then(|t| t.duration)
                    .map(|d| (d * 1000.0) as i64)
                    .unwrap_or(0);
                let shape = match state.db.transcript(id) {
                    Some(lines) => analyse(&lines, duration),
                    // Listed as needing one but carrying no transcript. Store
                    // an empty shape so the question is answered rather than
                    // asked again on the next lap.
                    None => BookShape::default(),
                };
                if state.db.set_book_shape(id, &shape).is_ok() {
                    progressed = true;
                }
                // A breath between books: this is housekeeping and must never
                // be the reason a stream stutters.
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            if !progressed {
                eprintln!(
                    "[bookshape] backfill stopping: nothing in this batch could be stored"
                );
                return;
            }
        }
    });
}
