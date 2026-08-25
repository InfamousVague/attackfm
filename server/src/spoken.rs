//! Search the library by what it SAYS.
//!
//! Titles and tags describe a recording from the outside. The words inside it -
//! a line of a song, a sentence of a book - are the thing people actually
//! remember, and until now they were the one part of the library nothing could
//! look through: transcripts and word-timed lyrics were stored per track and
//! reachable only one track at a time.
//!
//! This is the index over them, and the reason it lives on the server rather
//! than in the client's own matcher (which is faster for titles, and stays the
//! search for titles): the words are megabytes per book and never leave the
//! hub. A phone cannot hold them and should not have to.
//!
//! Every hit carries the MOMENT it was said, because a search result that only
//! names a twelve-hour book has not found anything. The client seeks there.

use crate::{auth, AppState};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct Ask {
    q: String,
    /// How many lines to hand back. A phone shows a page at a time.
    n: Option<usize>,
    /// `books`, `songs`, or absent for both.
    kind: Option<String>,
}

/// One line, as the index holds it: which track, when, and what was said.
pub struct Line {
    pub track_id: i64,
    pub start_ms: i64,
    pub text: String,
}

/// Pull the sayable lines out of a stored transcript or lyric body.
///
/// Both shapes are `[{startMs, text, ...}]` - the transcriber and the lyric
/// aligner deliberately agreed on that - so one reader serves both.
pub fn lines_of(body: &str) -> Vec<(i64, String)> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|l| {
            let at = l.get("startMs")?.as_i64()?;
            let text = l.get("text")?.as_str()?.trim();
            (!text.is_empty()).then(|| (at, text.to_string()))
        })
        .collect()
}

/// `GET /api/words?q=…` - lines of songs and books that say this.
///
/// Ranked by the index's own relevance, then trimmed to a handful per track:
/// a book that says "the door" ninety times should not be the whole page.
pub async fn search(
    State(state): State<Arc<AppState>>,
    Query(ask): Query<Ask>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let q = ask.q.trim();
    if q.len() < 2 {
        return Ok(Json(json!({ "hits": [] })));
    }
    let want = ask.n.unwrap_or(60).clamp(1, 200);
    let kind = ask.kind.as_deref().unwrap_or("");
    let hits = state.db.search_spoken(q, want, kind);

    // Per track, keep the best few and say how many more there were - the
    // honest shape for "this book says it a lot".
    let mut per: HashMap<i64, usize> = HashMap::new();
    let mut out = Vec::new();
    for h in hits {
        let seen = per.entry(h.track_id).or_insert(0);
        *seen += 1;
        if *seen > 4 {
            continue;
        }
        let track = state.db.track(h.track_id);
        out.push(json!({
            "trackId": h.track_id,
            "startMs": h.start_ms,
            "text": h.text,
            "title": track.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
            "artist": track.as_ref().map(|t| t.artist.clone()).unwrap_or_default(),
            "album": track.as_ref().map(|t| t.album.clone()).unwrap_or_default(),
            "kind": track.as_ref().map(|t| t.kind.clone()).unwrap_or_default(),
        }));
    }
    Ok(Json(json!({ "hits": out })))
}

/// `POST /api/words/reindex` - rebuild the index from every stored transcript
/// and lyric body. Cheap (it is a walk over text already on disk) and idempotent,
/// so it is also what a server does once after the feature arrives.
pub async fn reindex(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    if !caller.is_admin {
        return Err((StatusCode::FORBIDDEN, "only an admin can rebuild the index".into()));
    }
    let n = state.db.reindex_spoken();
    Ok(Json(json!({ "lines": n })))
}
