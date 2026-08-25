//! "Catch me up" - what has happened in this book, up to your bookmark, and
//! not one word past it.
//!
//! A book put down for three weeks is a book you cannot pick up. The recording
//! carries on from the second you stopped and expects you to remember who
//! everyone is, and the only cures on offer today are re-listening to an hour
//! you have already heard or reading a summary on the web that will spoil the
//! ending in its first line.
//!
//! The hub already holds the three things that fix this: the transcript (what
//! the book says), the owner's model (something that can read it), and the
//! bookmark ledger (exactly where you stopped). This module joins them.
//!
//! THE SPOILER BOUND IS STRUCTURAL, NOT A PROMPT.
//!
//! The model is never shown text from past the mark. Chapters are summarised
//! ahead of time into `book_recap_parts`, each row carrying the window it was
//! read from, and the catch-up takes rows that END at or before the bookmark -
//! plus the words of the chapter you are inside, cut at your exact position.
//! A model cannot reveal an ending it was not given, so asking it not to is a
//! second line of defence rather than the first.
//!
//! The chapter summaries are the opposite of the blurbs next door. A blurb is
//! a teaser and must never say how a chapter turns out; a recap part is read
//! only by someone who has already heard it, so the outcomes ARE the content.
//! Same windows, same indexes, opposite rules - which is why they are two
//! tables rather than two columns.
//!
//! Everything expensive happens off the request path, in the sweep that writes
//! the blurbs. Pressing the button is one model call over text already on disk.
//! No model configured, no transcript, or a sweep that has not reached this
//! book yet: the button says so plainly and nothing else changes.

use crate::chapter_blurbs::{chapter_windows, parsed_transcript};
use crate::{ai, auth, AppState};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// How much of a chapter goes into one model call. A local model asked to read
/// a whole thirty-minute chapter at once either truncates it or times out, so
/// a long chapter is read in pieces and its summary is the pieces in order.
const CHUNK_CHARS: usize = 8000;

/// The ceiling on those pieces. Past four, the window is not a chapter - it is
/// an unmarked book file - and reading forty thousand characters of it adds
/// detail no recap has room for. The rest is sampled rather than dropped.
const MAX_CHUNKS: usize = 4;

/// The words you last heard, quoted back to the model so the catch-up ends
/// where you stopped rather than at the last chapter boundary.
const TAIL_CHARS: usize = 2400;

/// Chapter summaries in one catch-up prompt. A long book runs past what a
/// local model can hold, and the oldest chapters are the ones a reader has
/// least need of in detail - so the far past is dropped, and the response says
/// so rather than quietly claiming to cover the whole book.
const MAX_PARTS: usize = 45;

/// A second press inside the same chapter is the same question. Past this, or
/// across a chapter boundary, it is a different one.
const REUSE_WINDOW_MS: i64 = 5 * 60_000;

/// One sweep at a time, however many doors call for it.
static SWEEPING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct ChunkNote {
    summary: String,
}

#[derive(Deserialize)]
struct CatchUpNote {
    recap: Vec<String>,
    #[serde(default)]
    threads: Vec<String>,
}

#[derive(Deserialize)]
pub struct RecapQuery {
    /// Where the reader stopped, in ms into this track. Absent means "wherever
    /// the ledger says" - the phone that has been off for three weeks does not
    /// know its own position until it starts playing.
    ms: Option<i64>,
    /// Write it again even if a stored one would have done.
    fresh: Option<u8>,
}

/// The transcript's text inside one window, in order, as up to `MAX_CHUNKS`
/// pieces of about `CHUNK_CHARS`.
///
/// A window longer than the ceiling is SAMPLED - every nth line, evenly across
/// the whole span - rather than truncated at the ceiling. Truncation would
/// summarise the first half of a chapter and call it the chapter; sampling
/// thins the detail but keeps the shape, which is what a recap is.
fn window_chunks(lines: &[(i64, String)], from_ms: i64, to_ms: i64) -> Vec<String> {
    let inside: Vec<&str> = lines
        .iter()
        .filter(|(at, _)| *at >= from_ms && *at < to_ms)
        .map(|(_, t)| t.as_str())
        .collect();
    if inside.is_empty() {
        return Vec::new();
    }
    let total: usize = inside.iter().map(|t| t.len() + 1).sum();
    let budget = CHUNK_CHARS * MAX_CHUNKS;
    let kept: Vec<&str> = if total <= budget {
        inside
    } else {
        // Ceil, so the stride always brings the total under the budget.
        let stride = total.div_ceil(budget).max(2);
        inside
            .iter()
            .enumerate()
            .filter(|(i, _)| i % stride == 0)
            .map(|(_, t)| *t)
            .collect()
    };
    let mut chunks = Vec::new();
    let mut buf = String::new();
    for line in kept {
        if !buf.is_empty() && buf.len() + line.len() + 1 > CHUNK_CHARS {
            chunks.push(std::mem::take(&mut buf));
        }
        if !buf.is_empty() {
            buf.push(' ');
        }
        buf.push_str(line);
    }
    if !buf.trim().is_empty() {
        chunks.push(buf);
    }
    chunks.truncate(MAX_CHUNKS);
    chunks
}

/// The last words before the mark, cut at a sentence where one is near, so the
/// quote does not open mid-clause.
fn tail_before(lines: &[(i64, String)], from_ms: i64, mark_ms: i64) -> String {
    let text = lines
        .iter()
        .filter(|(at, _)| *at >= from_ms && *at <= mark_ms)
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if text.len() <= TAIL_CHARS {
        return text;
    }
    let cut = text.len() - TAIL_CHARS;
    // char_indices, not a byte slice: a transcript is full of curly quotes and
    // em dashes, and slicing one in half panics.
    let start = text
        .char_indices()
        .map(|(i, _)| i)
        .find(|i| *i >= cut)
        .unwrap_or(0);
    let rest = &text[start..];
    match rest.find(". ") {
        Some(i) if i < 400 => rest[i + 2..].to_string(),
        _ => rest.to_string(),
    }
}

async fn chunk_summary(
    client: &ai::AiClient,
    book: &str,
    author: &str,
    label: &str,
    part: usize,
    of: usize,
    text: &str,
) -> Option<String> {
    let system = "You are building a listener's memory of an audiobook they have already heard. \
Given one stretch of transcript, write 1 to 3 plain sentences saying WHAT HAPPENS in it: who is \
present, what they do, what changes, what is decided or discovered. Outcomes are required, not \
withheld - the reader has heard this already and is trying to remember it. Use the names the text \
uses. Never mention the transcript, the narration, the recording or that this is an audiobook, and \
never write about anything the text does not contain. Plain prose, no lists, no preamble.";
    let of_note = if of > 1 {
        format!(" This is stretch {part} of {of} of that section, in order.")
    } else {
        String::new()
    };
    let prompt = format!(
        "Book: {book}\nAuthor: {author}\nSection: {label}.{of_note}\n\nTranscript:\n{text}",
    );
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary"],
        "properties": { "summary": { "type": "string" } }
    });
    client
        .chat_json::<ChunkNote>(system, &prompt, "recap_part", schema, false)
        .await
        .ok()
        .map(|n| n.summary.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Read one book file into recap parts, one window at a time. Quiet about
/// everything that is not ready: no model, no transcript, nothing missing.
pub async fn generate_for_track(state: &Arc<AppState>, track_id: i64) {
    if !ai::enabled("bookRecaps") {
        return;
    }
    // The fast enrichment model, like the blurbs: this is reading prose and
    // saying what it says, which is exactly that pass's errand - and a book is
    // dozens of these calls, so the cheap door is the only affordable one.
    let Some(client) = ai::AiClient::configured().map(|c| c.with_chat_model(ai::fast_model()))
    else {
        return;
    };
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

    let windows = chapter_windows(&track);
    let stored: std::collections::HashSet<i64> = state
        .db
        .recap_parts(&[track_id])
        .into_iter()
        .map(|(_, idx, _, _, _)| idx)
        .collect();

    for (i, (label, from, to)) in windows.into_iter().enumerate() {
        if stored.contains(&(i as i64)) {
            continue;
        }
        let chunks = window_chunks(&lines, from, to);
        if chunks.is_empty() || chunks.iter().map(|c| c.len()).sum::<usize>() < 200 {
            // Not enough words to say anything true about.
            continue;
        }
        let label = if label.trim().is_empty() {
            format!("Chapter {}", i + 1)
        } else {
            label
        };
        let of = chunks.len();
        let mut said: Vec<String> = Vec::new();
        for (n, chunk) in chunks.iter().enumerate() {
            match chunk_summary(
                &client,
                &track.album,
                &track.artist,
                &label,
                n + 1,
                of,
                chunk,
            )
            .await
            {
                Some(s) => said.push(s),
                // A model that stalls mid-chapter leaves a HALF summary, and a
                // half summary stored is a hole no later sweep would notice.
                // Abandon the window; the next sweep starts it again.
                None => return,
            }
        }
        let summary = said.join(" ");
        if summary.trim().is_empty() {
            continue;
        }
        let _ = state.db.set_recap_part(
            track_id,
            i as i64,
            from,
            // An unmarked file's window runs to i64::MAX when the file has no
            // duration; stored as its last spoken word instead, so "ends
            // before the bookmark" stays a comparison and not a special case.
            if to == i64::MAX {
                lines.last().map(|(at, _)| *at + 1).unwrap_or(from)
            } else {
                to
            },
            &summary,
            client.chat_model(),
        );
    }
}

/// Every transcribed book that is missing recap parts, one window at a time -
/// the blurbs' sweep, on the same schedule and for the same reason.
pub async fn sweep(state: Arc<AppState>) {
    if SWEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    for id in state.db.transcribed_track_ids() {
        generate_for_track(&state, id).await;
    }
    SWEEPING.store(false, Ordering::SeqCst);
}

async fn write_catch_up(
    client: &ai::AiClient,
    book: &str,
    author: &str,
    place: &str,
    chapters: &[(String, String)],
    tail: &str,
    clipped: bool,
) -> Option<CatchUpNote> {
    let system = "You remind someone what has happened in a book they put down weeks ago and are \
about to pick up again. \
EVERYTHING you are given happened BEFORE they stopped. You know nothing whatsoever about what \
happens afterwards, so never foreshadow, never hint at what is coming, and never speculate. \
`recap`: 2 to 4 short paragraphs, most recent events last, written as a reminder to someone who \
has heard all of it - name the people, say what actually happened, keep the thread of the story. \
`threads`: up to 4 very short lines, each an open question or an unresolved situation standing \
exactly where they stopped. \
Never mention the transcript, the narration, chapters, summaries, or that this is an audiobook. \
Never say how long the book is or how much is left. Write about the story only. Plain prose.";
    let mut body = String::new();
    if clipped {
        body.push_str(
            "(The earliest part of the book is not included. Begin with what you are given.)\n\n",
        );
    }
    for (label, summary) in chapters {
        body.push_str(&format!("{label}: {summary}\n"));
    }
    if !tail.is_empty() {
        body.push_str(&format!(
            "\nThe last words they heard, ending exactly where they stopped:\n\"{tail}\"\n"
        ));
    }
    let prompt = format!(
        "Book: {book}\nAuthor: {author}\nThey stopped at: {place}\n\nWhat has happened so far:\n{body}",
    );
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["recap", "threads"],
        "properties": {
            "recap":   { "type": "array", "items": { "type": "string" } },
            "threads": { "type": "array", "items": { "type": "string" } }
        }
    });
    client
        .chat_json::<CatchUpNote>(system, &prompt, "book_recap", schema, false)
        .await
        .ok()
        .filter(|n| n.recap.iter().any(|p| !p.trim().is_empty()))
}

/// `GET /api/audiobooks/recap/{track_id}?ms=&fresh=` - the catch-up for one
/// reader, bounded at their mark.
pub async fn catch_up(
    State(state): State<Arc<AppState>>,
    AxumPath(track_id): AxumPath<i64>,
    Query(q): Query<RecapQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let Some(track) = state.db.track(track_id) else {
        return Err((StatusCode::NOT_FOUND, "no such track".into()));
    };
    if track.kind != "book" {
        return Ok(Json(json!({ "ready": false, "reason": "not-a-book" })));
    }

    // The client's own position wins when it has one - it is playing, and the
    // ledger is written behind it. Otherwise the ledger IS the answer, which is
    // the case this feature exists for: a book not touched in three weeks.
    let mark = q
        .ms
        .filter(|ms| *ms > 0)
        .or_else(|| state.db.play_state(caller.id, track_id))
        .unwrap_or(0);

    // Reading order, whatever shape the book arrived in.
    let siblings = state.db.book_siblings(track_id);
    let ids: Vec<i64> = if siblings.is_empty() {
        vec![track_id]
    } else {
        siblings.iter().map(|(id, _)| *id).collect()
    };
    let here = ids.iter().position(|id| *id == track_id).unwrap_or(0);

    // Truthful chapter names, from the pass that reads them off the recording.
    let names: std::collections::HashMap<(i64, i64), String> = state
        .db
        .chapter_blurbs(&ids)
        .into_iter()
        .filter(|(_, _, name, _)| !name.trim().is_empty())
        .map(|(tid, idx, name, _)| ((tid, idx), name))
        .collect();

    let stored = state.db.recap_parts(&ids);
    /*
     * THE BOUND.
     *
     * A file before this one contributes whole. THIS file contributes only the
     * windows that END at or before the mark. A file after it contributes
     * nothing - there is nothing to say about a chapter you have not heard.
     */
    let mut taken: Vec<(String, String)> = Vec::new();
    for (pos, id) in ids.iter().enumerate() {
        if pos > here {
            break;
        }
        let mut rows: Vec<&(i64, i64, i64, i64, String)> =
            stored.iter().filter(|(tid, ..)| tid == id).collect();
        rows.sort_by_key(|(_, idx, ..)| *idx);
        for (tid, idx, _start, end, summary) in rows {
            if pos == here && *end > mark {
                continue;
            }
            let label = names
                .get(&(*tid, *idx))
                .cloned()
                .unwrap_or_else(|| format!("Chapter {}", idx + 1));
            taken.push((label, summary.clone()));
        }
    }

    // The words of the chapter you are INSIDE, from its start to your exact
    // position. Without this the recap stops at the last chapter boundary,
    // which can be forty minutes short of where you actually are.
    let raw = state.db.transcript(track_id);
    let lines = raw.as_deref().map(parsed_transcript).unwrap_or_default();
    let windows = chapter_windows(&track);
    let (here_label, here_from) = windows
        .iter()
        .enumerate()
        .rev()
        .find(|(_, (_, from, _))| *from <= mark)
        .map(|(i, (label, from, _))| {
            let named = names
                .get(&(track_id, i as i64))
                .cloned()
                .filter(|n| !n.trim().is_empty());
            (
                named.unwrap_or_else(|| {
                    if label.trim().is_empty() {
                        format!("Chapter {}", i + 1)
                    } else {
                        label.clone()
                    }
                }),
                *from,
            )
        })
        .unwrap_or_else(|| (track.title.clone(), 0));
    let tail = tail_before(&lines, here_from, mark);

    if taken.is_empty() && tail.len() < 400 {
        // Nothing has happened yet that they could have forgotten.
        return Ok(Json(json!({ "ready": false, "reason": "at-the-start" })));
    }
    if taken.is_empty() && stored.is_empty() {
        let reason = if lines.is_empty() {
            "no-transcript"
        } else {
            // Transcribed, but the sweep has not read it yet.
            "reading"
        };
        return Ok(Json(json!({ "ready": false, "reason": reason })));
    }

    // The far past goes first when a book runs past what a model can hold.
    let clipped = taken.len() > MAX_PARTS;
    if clipped {
        taken.drain(..taken.len() - MAX_PARTS);
    }

    let counted = taken.len() as i64;
    let held = state.db.book_recap(caller.id, track_id);
    if q.fresh.unwrap_or(0) == 0 {
        if let Some((upto, parts, body, at)) = &held {
            if *parts == counted && (mark - *upto).abs() < REUSE_WINDOW_MS {
                if let Ok(mut v) = serde_json::from_str::<Value>(body) {
                    if let Some(o) = v.as_object_mut() {
                        o.insert("ready".into(), json!(true));
                        o.insert("cached".into(), json!(true));
                        o.insert("at".into(), json!(at));
                        o.insert(
                            "upto".into(),
                            json!({ "ms": upto, "label": here_label, "chapters": parts }),
                        );
                        o.insert("clipped".into(), json!(clipped));
                        return Ok(Json(v));
                    }
                }
            }
        }
    }

    let Some(client) = ai::AiClient::configured() else {
        return Ok(Json(json!({ "ready": false, "reason": "no-model" })));
    };
    let note = write_catch_up(
        &client,
        &track.album,
        &track.artist,
        &here_label,
        &taken,
        &tail,
        clipped,
    )
    .await;
    let Some(note) = note else {
        // A model that cannot answer now is not a broken feature - it is a busy
        // or absent one, and the last good recap is better than an error.
        if let Some((upto, parts, body, at)) = held {
            if let Ok(mut v) = serde_json::from_str::<Value>(&body) {
                if let Some(o) = v.as_object_mut() {
                    o.insert("ready".into(), json!(true));
                    o.insert("cached".into(), json!(true));
                    o.insert("stale".into(), json!(true));
                    o.insert("at".into(), json!(at));
                    o.insert(
                        "upto".into(),
                        json!({ "ms": upto, "label": here_label, "chapters": parts }),
                    );
                    return Ok(Json(v));
                }
            }
        }
        return Ok(Json(json!({ "ready": false, "reason": "model-silent" })));
    };

    let body = json!({
        "recap": note.recap.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect::<Vec<_>>(),
        "threads": note.threads.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>(),
    });
    let _ = state.db.set_book_recap(
        caller.id,
        track_id,
        mark,
        counted,
        &body.to_string(),
        client.chat_model(),
    );
    let mut out = body;
    if let Some(o) = out.as_object_mut() {
        o.insert("ready".into(), json!(true));
        o.insert("cached".into(), json!(false));
        o.insert("clipped".into(), json!(clipped));
        o.insert(
            "upto".into(),
            json!({ "ms": mark, "label": here_label, "chapters": counted }),
        );
    }
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(n: usize) -> Vec<(i64, String)> {
        (0..n)
            .map(|i| (i as i64 * 1000, format!("Line number {i} of the reading.")))
            .collect()
    }

    /// The bound the whole feature rests on: text from past the mark never
    /// reaches the model, whatever the prompt says.
    #[test]
    fn a_window_never_reaches_past_its_end() {
        let l = lines(50);
        let chunks = window_chunks(&l, 10_000, 20_000);
        let joined = chunks.join(" ");
        assert!(joined.contains("Line number 10 "));
        assert!(joined.contains("Line number 19 "));
        assert!(!joined.contains("Line number 20 "));
        assert!(!joined.contains("Line number 9 "));
    }

    /// A chapter longer than the ceiling is thinned across its whole span, not
    /// cut off half way - a recap of the first half of a chapter, presented as
    /// the chapter, is worse than a thinner one.
    #[test]
    fn a_long_window_is_sampled_not_truncated() {
        let long: Vec<(i64, String)> = (0..8000)
            .map(|i| (i as i64 * 100, format!("Sentence {i} said something.")))
            .collect();
        let chunks = window_chunks(&long, 0, i64::MAX);
        let joined = chunks.join(" ");
        assert!(joined.len() <= CHUNK_CHARS * MAX_CHUNKS + CHUNK_CHARS);
        // The end of the chapter survives, which truncation would have lost.
        assert!(joined.contains("Sentence 7"));
        assert!(joined.contains("Sentence 0 "));
    }

    /// The tail stops AT the mark. A tail that ran one line past it would
    /// leak the next sentence of a book into its own recap.
    #[test]
    fn the_tail_stops_at_the_mark() {
        let l = lines(50);
        let tail = tail_before(&l, 0, 30_000);
        assert!(tail.contains("Line number 30"));
        assert!(!tail.contains("Line number 31"));
    }

    /// Curly quotes and dashes live in every transcript; the tail's cut is by
    /// character, not by byte, or a long chapter would panic the request.
    #[test]
    fn the_tail_cuts_on_characters() {
        let fat: Vec<(i64, String)> = (0..400)
            .map(|i| (i as i64 * 10, format!("“Well—{i},” she said, and went on.")))
            .collect();
        let tail = tail_before(&fat, 0, i64::MAX);
        assert!(tail.len() <= TAIL_CHARS);
        assert!(!tail.is_empty());
    }
}
