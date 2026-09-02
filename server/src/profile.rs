//! A member's profile, as their housemates may see it.
//!
//! The friends graph lives in the registry and spans servers, but the DATA a
//! profile is made of - the listen log, the hearts, the library - lives here,
//! on the hub. So the deal is drawn along the wall of the house: anyone who is
//! a member of THIS server may see another member's full profile (their stats
//! page, their liked songs), because being let onto someone's home server is
//! already the bigger act of trust. Across servers the registry still carries
//! only the week glance; nothing here changes that.
//!
//! Sharing is a per-member switch (default ON, matching the week share) kept
//! in the meta table - the schema-batch trap means a users column would never
//! land on a deployed database, and one k/v row per objector is honest about
//! how rare "off" is expected to be. The switch guards the whole profile: off
//! means housemates see a closed door, not a thinner page.

use crate::auth;
use crate::db::Db;
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<serde_json::Value>, ApiError>;

fn share_key(user: i64) -> String {
    format!("profile.share.{user}")
}

/// On unless the member has said otherwise - the same default the week share
/// ships with, and the same "off is the only stored state" shape.
pub fn sharing_on(db: &Db, user: i64) -> bool {
    db.meta_get(&share_key(user)).as_deref() != Some("off")
}

/// `GET /api/profile/sharing` - the caller's own switch.
pub async fn get_sharing(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    Ok(Json(json!({ "sharing": sharing_on(&state.db, caller.id) })))
}

#[derive(Deserialize)]
pub struct SharingBody {
    pub sharing: bool,
}

/// `PUT /api/profile/sharing` - flip it.
pub async fn set_sharing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SharingBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let value = if body.sharing { "on" } else { "off" };
    state
        .db
        .meta_set(&share_key(caller.id), value)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true, "sharing": body.sharing })))
}

#[derive(Deserialize)]
pub struct ProfileQuery {
    #[serde(default)]
    pub range: Option<String>,
    #[serde(rename = "tzMin", default)]
    pub tz_min: Option<i64>,
}

/// `GET /api/profile/{who}?range=&tzMin=` - the full profile of a member of
/// this server: the same stats payload their own stats page is built from,
/// plus their liked songs as track ids (the caller shares this library, so
/// ids resolve locally - no track metadata needs to cross).
///
/// `who` is a registry handle when the friend came through the registry, or a
/// plain username; both are tried, handle first, since that is what the
/// friends page actually holds.
pub async fn profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(who): Path<String>,
    Query(q): Query<ProfileQuery>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;

    let who = who.trim();
    let (user_id, username, handle, member_since) = state
        .db
        .member_by_handle(who)
        .or_else(|| {
            // A friend who signed into this hub directly, never through the
            // registry: their handle and their username are the same word,
            // give or take the capitals they typed.
            state
                .db
                .user_by_name_ci(who)
                .map(|u| (u.id, u.username, String::new(), 0))
        })
        .ok_or((StatusCode::NOT_FOUND, "no such member here".into()))?;

    let its_me = user_id == caller.id;
    // Friends only, as the page promises. The hub's friend graph is the
    // registry's, mirrored by the app (friends.rs) - a member who is not a
    // friend of this person has no business with their listening, whatever
    // the sharing switch says: that switch is "share with FRIENDS".
    if !its_me && !state.db.friends_of(user_id).iter().any(|(id, _)| *id == caller.id) {
        return Err((StatusCode::FORBIDDEN, "they keep their listening to themselves".into()));
    }
    let sharing = sharing_on(&state.db, user_id);
    if !its_me && !sharing {
        // A closed door, not a thinner page - and the same body either way,
        // so the client can render the "keeps it private" face without
        // guessing from a status code alone.
        return Err((StatusCode::FORBIDDEN, "they keep their listening to themselves".into()));
    }

    let range = q.range.as_deref().unwrap_or("week");
    let stats = crate::listens::summary_payload(&state, user_id, range, q.tz_min.unwrap_or(0))
        .ok_or((StatusCode::BAD_REQUEST, "range must be week, month, year or all".into()))?;

    // Newest first, as favorites() already orders them. Capped: a profile is
    // a visit, not a sync - the count carries the true size.
    let all = state.db.favorites(user_id);
    let favorites_total = all.len();
    let favorites: Vec<i64> = all.into_iter().take(200).collect();

    Ok(Json(json!({
        "userId": user_id,
        "username": username,
        "handle": handle,
        "memberSince": if member_since > 0 { Some(member_since) } else { None },
        "sharing": sharing,
        "stats": stats,
        "favorites": favorites,
        "favoritesTotal": favorites_total,
    })))
}
