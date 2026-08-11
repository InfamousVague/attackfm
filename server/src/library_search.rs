//! Library search: full text over the music this server already has.
//!
//! Where `/api/search` asks the outside catalogues what could be imported,
//! this asks the index what is already here - the difference between shopping
//! and finding. The heavy lifting is an FTS5 mirror of `tracks` (see db.rs);
//! what lives here is folding whatever somebody typed into a MATCH expression
//! that cannot be tripped by FTS's own syntax, and shaping the reply into the
//! two shelves the client draws: tracks, and the albums those tracks fall
//! under.

use crate::auth;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

#[derive(Deserialize)]
pub struct LibrarySearchQuery {
    #[serde(default)]
    pub q: String,
    pub limit: Option<i64>,
}

/// Folds raw input into an FTS5 MATCH expression that can only ever be a
/// search. Every whitespace-split token is stripped of the characters FTS
/// reads as syntax and double-quoted, so `don't (live)` searches for those
/// words rather than erroring; the last token gets a prefix star, so the list
/// fills in while a word is still being typed. Tokens are joined bare -
/// FTS's implicit AND. Apostrophes stay: the tokenizer splits `don't` into
/// two terms, and stripping it would make `dont` match nothing.
fn fts_expression(q: &str) -> Option<String> {
    let tokens: Vec<String> = q
        .split_whitespace()
        .filter_map(|word| {
            let clean: String = word
                .chars()
                .filter(|c| !matches!(c, '"' | '*' | '^' | '(' | ')' | ':' | '{' | '}'))
                .collect();
            (!clean.is_empty()).then_some(clean)
        })
        .collect();
    let last = tokens.len().checked_sub(1)?;
    Some(
        tokens
            .iter()
            .enumerate()
            .map(|(i, t)| if i == last { format!("\"{t}\"*") } else { format!("\"{t}\"") })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// `GET /api/library/search?q=&limit=` - tracks and albums already here.
pub async fn search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<LibrarySearchQuery>,
) -> ApiResult {
    auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let limit = params.limit.unwrap_or(60).clamp(1, 200);
    // Nothing typed is nothing found, not an error - the client clears the
    // list as you backspace.
    let Some(expr) = fts_expression(&params.q) else {
        return Ok(Json(json!({ "tracks": [], "albums": [] })));
    };

    let tracks = state.db.search_tracks(&expr, limit);
    // A dozen albums covers the widest genuine hit without the album shelf
    // drowning the track list.
    let albums = state.db.search_albums(&expr, 12);
    Ok(Json(json!({ "tracks": tracks, "albums": albums })))
}
