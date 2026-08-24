//! What each chapter IS, in a line, without giving anything away.
//!
//! A book's embedded chapter marks carry whatever the publisher typed -
//! usually "Chapter 1, Chapter 2", and sometimes a lie: a preamble tagged
//! "Chapter 1" shifts every number after it one off from what the narrator
//! is actually saying. The transcript knows better, because the audio
//! ANNOUNCES itself - "Preamble", "Prologue", "Chapter one: The Winding Key" -
//! within the first breath or two.
//!
//! So once a book has a transcript, this module hands each chapter's OPENING
//! to the owner's model and asks two small questions: what does this chapter
//! call itself, and what is it about - one teasing line, no outcomes. The
//! answers live in `chapter_blurbs`, are served per book, and the client
//! wears them in the Now Playing chapter panel.
//!
//! Only the opening is sent, and that is a feature twice over: a chapter's
//! start says what it is about, its end says how it turns out - exactly what
//! a non-spoiler line must not know - and a small local model gets a prompt
//! it can hold. Runs happen one chapter at a time, off the request path,
//! from the same quiet places the ingest sweep runs. No configured model,
//! no work: everything stays exactly as it looks today.

use crate::{ai, auth, db, AppState};
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// One chapter, named and described by the model.
#[derive(Deserialize)]
struct ChapterNote {
    name: String,
    blurb: String,
}

/// The opening of a chapter is plenty to say what it is; past this, the
/// text only gets closer to the ending it must not reveal.
const OPENING_CHARS: usize = 4500;

/// One sweep at a time, however many doors call for it.
static SWEEPING: AtomicBool = AtomicBool::new(false);

fn chapter_marks(track: &db::Track) -> Vec<(String, i64)> {
    let Value::Array(items) = &track.chapters else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|c| {
            let start = c.get("startMs")?.as_i64()?;
            let title = c
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            Some((title, start))
        })
        .collect()
}

/// The transcript's text inside one time window, oldest first, cut at the
/// opening budget.
fn opening(lines: &[(i64, String)], from_ms: i64, to_ms: i64) -> String {
    let mut out = String::new();
    for (at, text) in lines {
        if *at < from_ms || *at >= to_ms {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(text);
        if out.len() >= OPENING_CHARS {
            out.truncate(OPENING_CHARS);
            break;
        }
    }
    out
}

fn parsed_transcript(raw: &str) -> Vec<(i64, String)> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|l| {
            let at = l.get("startMs")?.as_i64()?;
            let text = l.get("text")?.as_str()?.trim().to_string();
            if text.is_empty() { None } else { Some((at, text)) }
        })
        .collect()
}

/// A spoken number, as narrators say them, up to ninety-nine.
fn spoken_number(words: &str) -> Option<i64> {
    // ZERO IS IN HERE for a reason: a series that opens at "Chapter Zero"
    // (and several do) was unreadable before - `parse` rejected 0 below and no
    // word matched it - so its opening announcement was never recognised and
    // every chapter of the book stayed nameless.
    const ONES: [(&str, i64); 20] = [
        ("zero", 0),
        ("one", 1), ("two", 2), ("three", 3), ("four", 4), ("five", 5),
        ("six", 6), ("seven", 7), ("eight", 8), ("nine", 9), ("ten", 10),
        ("eleven", 11), ("twelve", 12), ("thirteen", 13), ("fourteen", 14),
        ("fifteen", 15), ("sixteen", 16), ("seventeen", 17), ("eighteen", 18),
        ("nineteen", 19),
    ];
    const TENS: [(&str, i64); 8] = [
        ("twenty", 20), ("thirty", 30), ("forty", 40), ("fifty", 50),
        ("sixty", 60), ("seventy", 70), ("eighty", 80), ("ninety", 90),
    ];
    let w = words.trim().to_lowercase();
    if let Ok(n) = w.parse::<i64>() {
        return (n >= 0 && n < 1000).then_some(n);
    }
    if let Some((_, n)) = ONES.iter().find(|(name, _)| *name == w) {
        return Some(*n);
    }
    let mut parts = w.splitn(2, ['-', ' ']);
    let tens = parts.next()?;
    let (_, t) = TENS.iter().find(|(name, _)| *name == tens)?;
    match parts.next() {
        None | Some("") => Some(*t),
        Some(rest) => ONES
            .iter()
            .find(|(name, _)| *name == rest && *name != "ten" && *name != "zero")
            .map(|(_, o)| t + o),
    }
}

fn title_case(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// What the narration DECLARES this section to be, read off the opening
/// deterministically - so a preamble mislabelled "Chapter 1" is fixed by
/// code, whatever model the box runs. The model only ever fills the gaps.
fn declared_name(text: &str) -> Option<String> {
    let head = text.trim_start();
    let lower = head.to_lowercase();
    for plain in [
        "preamble", "prologue", "epilogue", "introduction", "foreword",
        "afterword", "author's note", "authors note", "dedication",
        "interlude", "preface",
    ] {
        if lower.starts_with(plain) {
            let after = head.as_bytes().get(plain.len()).copied();
            // Only when it stands alone as an announcement - "Prologue." -
            // not as the first word of a sentence ("Prologue was the name
            // of the ship").
            if matches!(after, None | Some(b'.') | Some(b':') | Some(b',') | Some(b'!')) {
                return Some(title_case(plain));
            }
        }
    }
    if let Some(rest) = lower.strip_prefix("chapter ") {
        // "chapter twenty-three." or "chapter twenty three: the iron door."
        let end = rest.find(['.', ':', ',', '!', '?']).unwrap_or(rest.len().min(30));
        let n = spoken_number(&rest[..end])?;
        // A short following sentence is the chapter's own title.
        let tail = &rest[end.min(rest.len())..];
        let tail = tail.trim_start_matches(['.', ':', ',', '!', '?']).trim();
        let title = tail
            .split(['.', ':', '!', '?'])
            .next()
            .unwrap_or("")
            .trim();
        if !title.is_empty() && title.len() <= 45 && title.split_whitespace().count() <= 7 {
            return Some(format!("Chapter {n}: {}", title_case(title)));
        }
        return Some(format!("Chapter {n}"));
    }
    None
}

async fn note_for(
    client: &ai::AiClient,
    book: &str,
    author: &str,
    ordinal: usize,
    total: usize,
    label: &str,
    text: &str,
) -> Option<ChapterNote> {
    let system = "You annotate one chapter of an audiobook, from the transcript of its OPENING only. \
FIRST, `name`. Narration usually announces what a section is in its opening words: 'Preamble.', \
'Prologue.', 'Author's note.', 'Chapter twelve: The Iron Door.' If the opening contains such an \
announcement, `name` IS that announcement (title case, digits for spoken numbers, under 60 \
characters) and you must IGNORE the supplied label - embedded labels are often wrong about \
which section is which, and the spoken words are the truth. Only when the opening announces \
nothing do you return the supplied label unchanged. \
SECOND, `blurb`: ONE line of 6 to 14 words saying what the chapter is about, written like an \
episode teaser. Never reveal outcomes, deaths, twists, arrivals or endings; never mention the \
transcript, the narrator, or that this is an audiobook. Plain text only.";
    let prompt = format!(
        "Book: {book}\nAuthor: {author}\nThis is part {ordinal} of {total}. Its embedded label is: {label}\n\nOpening transcript:\n{text}",
    );
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "blurb"],
        "properties": {
            "name":  { "type": "string" },
            "blurb": { "type": "string" }
        }
    });
    client
        .chat_json::<ChapterNote>(system, &prompt, "chapter_note", schema, false)
        .await
        .ok()
        .filter(|n| !n.blurb.trim().is_empty())
}

/// Write notes for one transcribed track. Quiet about everything that is not
/// ready: no model configured, no transcript, nothing missing - all no-ops.
pub async fn generate_for_track(state: &Arc<AppState>, track_id: i64) {
    /*
     * THE MODEL IS OPTIONAL.
     *
     * A description is genuinely written and needs one. A chapter's NAME and
     * its number are not written, they are ANNOUNCED - the narrator says
     * "Chapter Zero." in the first breath - and reading that off the transcript
     * is `declared_name`, which is code and always has been.
     *
     * Returning here when no model is configured meant a hub without AI got
     * neither, so every chapter of every book stayed nameless, and the app fell
     * back to numbering chapters by their position in the list - which is how a
     * book that opens at zero ended up reported one ahead of itself throughout.
     *
     * The enrichment model, not the chat default - reading prose and naming it
     * truthfully is exactly the errand the curator's fast pass runs on.
     */
    let client = ai::AiClient::configured().map(|c| c.with_chat_model(ai::fast_model()));
    let Some(track) = state.db.track(track_id) else {
        return;
    };
    if track.kind != "book" {
        return;
    }
    let Some(raw) = state.db.transcript(track_id) else {
        return;
    };
    let lines = parsed_transcript(&raw);
    if lines.is_empty() {
        return;
    }

    let marks = chapter_marks(&track);
    let end_ms = track.duration.map(|d| (d * 1000.0) as i64).unwrap_or(i64::MAX);
    // A marked single file is its chapters; an unmarked file IS one chapter -
    // a section of a many-file book, described whole.
    let windows: Vec<(String, i64, i64)> = if marks.is_empty() {
        vec![(track.title.clone(), 0, end_ms)]
    } else {
        marks
            .iter()
            .enumerate()
            .map(|(i, (title, start))| {
                let stop = marks.get(i + 1).map(|(_, s)| *s).unwrap_or(end_ms);
                (title.clone(), *start, stop)
            })
            .collect()
    };

    // What is stored already, so a re-run only fills gaps. Held as name AND
    // blurb rather than a set of finished indexes because the two halves now
    // arrive separately: a row with a name and an EMPTY blurb is exactly what a
    // hub with no model writes, and it is NOT finished once a model appears.
    let stored: std::collections::HashMap<i64, (String, String)> = state
        .db
        .chapter_blurbs(&[track_id])
        .into_iter()
        .map(|(_, idx, name, blurb)| (idx, (name, blurb)))
        .collect();

    let total = windows.len();
    for (i, (label, from, to)) in windows.into_iter().enumerate() {
        let existing = stored.get(&(i as i64));
        let named = existing.is_some_and(|(n, _)| !n.trim().is_empty());
        let described = existing.is_some_and(|(_, b)| !b.trim().is_empty());
        // Nothing left to add here: it has a name, and either it has a
        // description or there is no model to write one.
        if named && (described || client.is_none()) {
            continue;
        }
        let text = opening(&lines, from, to);
        if text.len() < 200 {
            // Not enough words to say anything honest about.
            continue;
        }
        let label = if label.trim().is_empty() {
            format!("Chapter {}", i + 1)
        } else {
            label
        };
        // Read off the recording FIRST, by code. The opening's own announcement
        // outranks everything - so a preamble stays a preamble, and "chapter
        // zero" stays zero, on the smallest model and on no model at all.
        let declared = declared_name(&text);
        // A model is asked only when there is one AND the description is still
        // missing. A name already read from the recording costs nothing to keep.
        let note = match (&client, described) {
            (Some(c), false) => {
                note_for(c, &track.album, &track.artist, i + 1, total, &label, &text).await
            }
            _ => None,
        };
        let name = declared
            .or_else(|| {
                note.as_ref()
                    .map(|n| n.name.trim().chars().take(80).collect::<String>())
            })
            .filter(|n| !n.trim().is_empty());
        let blurb = note
            .as_ref()
            .map(|n| n.blurb.trim().chars().take(160).collect::<String>())
            .filter(|b| !b.is_empty());
        if name.is_none() && blurb.is_none() {
            // Neither the recording nor a model said anything this time. A
            // model that cannot answer now is asked again by a later sweep, and
            // writing the file's own title back as a "name" would only hide the
            // gap from that sweep.
            continue;
        }
        // Keep whatever is stored for the half this pass did not produce, so
        // configuring a model later fills in descriptions WITHOUT discarding
        // the names read from the recording.
        let name = name.unwrap_or_else(|| existing.map(|(n, _)| n.clone()).unwrap_or_default());
        let blurb = blurb.unwrap_or_else(|| existing.map(|(_, b)| b.clone()).unwrap_or_default());
        // Provenance: the recording said it, or a model did.
        let by = match (&client, &note) {
            (Some(c), Some(_)) => c.chat_model(),
            _ => "transcript",
        };
        let _ = state.db.set_chapter_blurb(
            track_id,
            i as i64,
            if name.trim().is_empty() { &label } else { &name },
            &blurb,
            by,
        );
    }
}

/// Every transcribed book that is missing notes, one chapter at a time.
/// Called shortly after boot and on a slow interval, like the ingest sweep -
/// and immediately for one track when its transcription finishes.
pub async fn sweep(state: Arc<AppState>) {
    if SWEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    for id in state.db.transcribed_track_ids() {
        generate_for_track(&state, id).await;
    }
    SWEEPING.store(false, Ordering::SeqCst);
}

/// `GET /api/audiobooks/blurbs/{track_id}` - every chapter note for the BOOK
/// this track belongs to, keyed by track id. One request per opened book,
/// never part of the library payload - the transcripts' rule, for the same
/// reason.
pub async fn book(
    State(state): State<Arc<AppState>>,
    AxumPath(track_id): AxumPath<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let siblings = state.db.book_siblings(track_id);
    let ids: Vec<i64> = siblings.iter().map(|(id, _)| *id).collect();
    let mut by_track: serde_json::Map<String, Value> = serde_json::Map::new();
    for (tid, idx, name, blurb) in state.db.chapter_blurbs(&ids) {
        by_track
            .entry(tid.to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .map(|a| a.push(json!({ "idx": idx, "name": name, "blurb": blurb })));
    }
    Ok(Json(json!({ "blurbs": Value::Object(by_track) })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declarations_are_read_off_the_opening() {
        assert_eq!(
            declared_name("Preamble. A note before the winding begins."),
            Some("Preamble".into())
        );
        assert_eq!(
            declared_name("Chapter one. The winding key. Marta pressed on."),
            Some("Chapter 1: The Winding Key".into())
        );
        assert_eq!(
            declared_name("Chapter twenty-three: The Iron Door. Rain again."),
            Some("Chapter 23: The Iron Door".into())
        );
        assert_eq!(declared_name("Chapter 12. Dawn."), Some("Chapter 12: Dawn".into()));
        // A sentence that merely STARTS with the word is not an announcement.
        assert_eq!(declared_name("Prologue was the name of the ship."), None);
        assert_eq!(declared_name("The morning came slowly."), None);
    }

    /// A book that opens at zero. The whole reason this pass exists without a
    /// model: the recording announces the number, and reading it is what stops
    /// every surface counting from position instead.
    #[test]
    fn a_book_that_opens_at_zero_is_read_as_zero() {
        assert_eq!(spoken_number("zero"), Some(0));
        assert_eq!(spoken_number("0"), Some(0));
        assert_eq!(
            declared_name("Chapter zero. The one where I get a cat. Carl here."),
            Some("Chapter 0: The One Where I Get A Cat".into())
        );
        assert_eq!(declared_name("Chapter 0. Donut."), Some("Chapter 0: Donut".into()));
        assert_eq!(declared_name("Chapter zero."), Some("Chapter 0".into()));
        // The chapter after it still reads as one, so the sequence holds.
        assert_eq!(declared_name("Chapter one. Down we go."), Some("Chapter 1: Down We Go".into()));
    }

    /// Numbers a narrator does not say. A wrong number here would renumber a
    /// whole book, so the parser stays narrow.
    #[test]
    fn nonsense_numbers_are_refused() {
        assert_eq!(spoken_number("twenty zero"), None);
        assert_eq!(spoken_number("banana"), None);
        assert_eq!(spoken_number("-1"), None);
        assert_eq!(spoken_number("1000"), None);
        assert_eq!(spoken_number("twenty-three"), Some(23));
    }
}
