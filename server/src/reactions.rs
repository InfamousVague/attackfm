//! Thumbs in the DJ and on the radio - the listener's word on a song the
//! machine chose, given while it plays.
//!
//! The listener asked for every way of saying no: "less like this" on a
//! card, thumbs in the DJ and radio, and a long-press that can reject the
//! REASON a song was dealt. This is the thumb. It does three things and
//! deliberately not a fourth:
//!
//! - It is recorded (`dj_reactions`), so the explore sampler can count an
//!   up as adoption and a down as a louder failure than a skip.
//! - A down writes the rejection memory the harvesters and every dealer
//!   read (`discovery_rejections`): the song by default, the artist when
//!   the listener says `scope: "artist"` - which is what "less like this"
//!   means on a thing that has an artist.
//! - A down on a song the listener had hearted leaves the heart alone. The
//!   heart is their explicit word; a thumb in the moment does not unsay it.
//! - An up is NOT a heart. Hearts stay explicit; if they want it in their
//!   likes they will heart it.
use crate::{auth, discovery, taste, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactBody {
    pub track_id: i64,
    /// "up" or "down".
    pub reaction: String,
    #[serde(default)]
    pub position_ms: i64,
    /// "artist" widens a down to the whole artist. Anything else, or
    /// nothing, means the song.
    #[serde(default)]
    pub scope: Option<String>,
}

/// `POST /api/dj/react`.
pub async fn react(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ReactBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let reaction = body.reaction.trim().to_lowercase();
    if reaction != "up" && reaction != "down" {
        return Err((StatusCode::BAD_REQUEST, "reaction must be up or down".into()));
    }
    let Some(track) = state.db.track(body.track_id) else {
        return Err((StatusCode::NOT_FOUND, "no such song".into()));
    };
    let now = crate::db::now_ms();
    state.db.record_dj_reaction(caller.id, body.track_id, &reaction, body.position_ms, now);
    let mut rejected: Option<&str> = None;
    if reaction == "down" {
        if body.scope.as_deref() == Some("artist") {
            state.db.reject_discovery(caller.id, "artist", &taste::artist_key(&track.artist));
            rejected = Some("artist");
        } else {
            state
                .db
                .reject_discovery(caller.id, "track", &discovery::key_of(&track.artist, &track.title));
            rejected = Some("track");
        }
    }
    Ok(Json(json!({ "ok": true, "reaction": reaction, "rejected": rejected })))
}
