//! Signing into a server with a central identity.
//!
//! A listener no longer types a username and password at a server; they carry a
//! token the registry signed, and this is where a server turns that token into
//! access. The signature is checked OFFLINE against the registry's public key
//! (fetched once), so per-request auth never calls the registry - it stays fast,
//! and stays working if the registry blips.
//!
//! The flow, once a token is verified:
//!   - already a member here → straight in, as their own account;
//!   - no owner on this server yet → the first arrival becomes the owner;
//!   - otherwise → they need an invite to this server, checked with the
//!     registry, and joining binds their registry id to a fresh local account.
//!
//! That last part is the whole point: an invited friend gets THEIR OWN user row
//! - their own playlists, favourites and history - instead of landing inside the
//! owner's account, which is what happened before any of this existed.

use crate::{auth, AppState};
use afm_identity::Verifier2;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

type ApiError = (StatusCode, String);
type ApiResult = Result<Json<Value>, ApiError>;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The address this request actually arrived on, as the listener typed it.
///
/// The whole point: a server behind a reverse proxy never sees its own public
/// name, so it cannot answer "is this invite for me?" from configuration it was
/// never given. It CAN read the name the request came in under. Caddy and nginx
/// both forward it, and the standard header wins over the literal Host because
/// behind a proxy Host is the upstream (a .ts.net name, or localhost) rather
/// than the domain a person typed.
///
/// This is not a security boundary and is not treated as one: it is only ever
/// used to ACCEPT an invite that already passed the registry's signature,
/// alongside the configured address, never to grant anything on its own.
fn request_origin(headers: &HeaderMap) -> Option<String> {
    let get = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').next().unwrap_or(v).trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let host = get("x-forwarded-host").or_else(|| get("host"))?;
    let scheme = get("x-forwarded-proto").unwrap_or_else(|| "https".to_string());
    Some(format!("{scheme}://{host}"))
}

/// Two server URLs naming the same place, trailing slash and case aside.
fn same_server(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('/').to_ascii_lowercase();
    !a.is_empty() && norm(a) == norm(b)
}

/// The registry's public key, fetched once and kept. Fetched lazily on the
/// first `enter` if boot could not reach the registry, so a registry that comes
/// up late does not need a server restart.
async fn ensure_verifier(state: &AppState) -> Option<Verifier2> {
    {
        let held = state.registry_verifier.lock().await;
        if let Some(v) = held.as_ref() {
            return Some(v.clone());
        }
    }
    let url = format!("{}/v1/pubkey", state.registry_url.trim_end_matches('/'));
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().ok()?;
    let body: Value = client.get(&url).send().await.ok()?.json().await.ok()?;
    let pk = body.get("publicKey").and_then(|v| v.as_str())?;
    let verifier = Verifier2::from_public_b64(pk)?;
    *state.registry_verifier.lock().await = Some(verifier.clone());
    Some(verifier)
}

/// Fetch the registry's public key at boot. Failure is not fatal: local
/// username/password auth still works, and the key is fetched on demand later.
pub async fn prime_verifier(state: Arc<AppState>) {
    if ensure_verifier(&state).await.is_some() {
        println!("[attackfm] registry identity verified against {}", state.registry_url);
    } else {
        eprintln!("[attackfm] registry {} unreachable at boot; identity sign-in will retry on demand", state.registry_url);
    }
}

/// The session an entering account gets - the exact shape `/api/auth/login`
/// returns, so the client machinery downstream is unchanged.
fn session_json(state: &AppState, user: &crate::db::User) -> Result<Value, ApiError> {
    let token = auth::random_token();
    state
        .db
        .create_token(&token, user.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let stream_token = auth::mint_stream_token(&state.stream_secret, user.id, user.stream_epoch);
    Ok(json!({
        "token": token,
        "streamToken": stream_token,
        "streamTokenExpires": auth::STREAM_TOKEN_TTL_SECS,
        "user": { "id": user.id, "username": user.username, "isAdmin": user.is_admin },
    }))
}

/// Create the local account a registry identity gets on this server, and bind
/// the two. The local username is the handle when free, else the handle plus
/// the registry id - never silently attaching to an existing local account,
/// which would let anyone who took a handle inherit that account's data.
fn admit(state: &AppState, sub: i64, handle: &str, owner: bool) -> Result<crate::db::User, ApiError> {
    let username = if state.db.user_by_name(handle).is_none() {
        handle.to_string()
    } else {
        format!("{handle}.{sub}")
    };
    let user_id = state
        .db
        .create_user(&username, "", owner)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not create your account here".into()))?;
    state
        .db
        .add_registry_member(sub, user_id, handle, if owner { "owner" } else { "member" })
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not record membership".into()))?;
    state
        .db
        .user_by_id(user_id)
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "account vanished after creation".into()))
}

#[derive(Deserialize)]
pub struct EnterBody {
    /// The registry-issued identity token.
    token: String,
    /// An invite code, needed the first time a non-owner joins an established
    /// server. Ignored once a membership exists.
    #[serde(default)]
    invite: String,
}

#[derive(Deserialize)]
pub struct LinkBody {
    /// The registry identity to bind to the currently signed-in local account.
    token: String,
}

/// `POST /api/registry/link` - claim your central identity for THIS local
/// account. The migration primitive: an existing user (the owner, say) signs in
/// the old way, then binds their registry account to the local one they already
/// have, so their library, playlists and history stay theirs and they enter as
/// themselves ever after. Secure because it needs both proofs at once - the
/// local session AND the registry token.
pub async fn link(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<LinkBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in to this server first".to_string()))?;
    let verifier = ensure_verifier(&state)
        .await
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "The identity service is unreachable right now.".into()))?;
    let claims = verifier
        .verify(body.token.trim(), now_secs())
        .map_err(|_| (StatusCode::UNAUTHORIZED, "That identity token is not valid.".into()))?;
    state
        .db
        .add_registry_member(claims.sub, caller.id, &claims.handle, if caller.is_admin { "owner" } else { "member" })
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not link the account".into()))?;
    Ok(Json(json!({ "ok": true, "handle": claims.handle })))
}

/// `POST /api/registry/enter` - trade a registry identity for a session here.
pub async fn enter(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<EnterBody>,
) -> ApiResult {
    let verifier = ensure_verifier(&state)
        .await
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "The identity service is unreachable right now.".into()))?;
    let claims = verifier
        .verify(body.token.trim(), now_secs())
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Your sign-in has expired. Open the app again.".into()))?;
    let sub = claims.sub;
    let handle = claims.handle;

    // Already a member: in as themselves, no invite needed.
    if let Some((user_id, _role)) = state.db.registry_member(sub) {
        if let Some(user) = state.db.user_by_id(user_id) {
            return Ok(Json(session_json(&state, &user)?));
        }
        // The local user was deleted out from under the membership; re-admit.
    }

    // A server with no owner yet crowns its first arrival.
    if !state.db.has_any_admin() {
        let user = admit(&state, sub, &handle, true)?;
        return Ok(Json(session_json(&state, &user)?));
    }

    // Established server: invite-only.
    let code = body.invite.trim();
    if code.is_empty() {
        return Err((
            StatusCode::FORBIDDEN,
            "This server is invite-only. Ask a member for an invite link.".into(),
        ));
    }

    // Check the invite with the registry: it must name THIS server, be unspent
    // and unexpired. The check is the registry's public preview - no secret.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not check the invite".into()))?;
    let preview_url = format!("{}/v1/invites/{}", state.registry_url.trim_end_matches('/'), code);
    let preview: Value = client
        .get(&preview_url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| (StatusCode::BAD_REQUEST, "That invite is not valid.".into()))?
        .json()
        .await
        .map_err(|_| (StatusCode::BAD_REQUEST, "That invite could not be read.".into()))?;

    // Does this invite name THIS server? Two ways to be sure, and either will do.
    //
    // AFM_PUBLIC_URL is the configured answer, and the better one when it is
    // set. But it defaults to empty, and a server behind a reverse proxy is
    // exactly the case where nobody thinks to set it - so for a while every
    // invite ever minted was rejected as "for a different server", which sent
    // the person joining to check their link and the operator to check the
    // registry while the fault was one unset variable here.
    //
    // So the address the request ARRIVED on counts too. That is the name the
    // listener actually typed, which is by definition the name this server
    // answers to. It cannot be used to grant anything by itself: we are already
    // past the registry's signed, unspent, unexpired check, and this only
    // decides whether a valid invite belongs here.
    let inv_server = preview.get("serverUrl").and_then(|v| v.as_str()).unwrap_or("");
    let arrived_on = request_origin(&headers);
    let matches_config = same_server(inv_server, &state.public_url);
    let matches_request = arrived_on
        .as_deref()
        .is_some_and(|origin| same_server(inv_server, origin));

    if !matches_config && !matches_request {
        // Name every address involved. "That invite is for a different server"
        // on its own is the least useful true sentence available here.
        let here = match (&state.public_url, arrived_on.as_deref()) {
            (c, Some(o)) if !c.trim().is_empty() && !same_server(c, o) => {
                format!("{c} (and this request arrived on {o})")
            }
            (c, _) if !c.trim().is_empty() => c.clone(),
            (_, Some(o)) => o.to_string(),
            _ => "an address this server has not been told".to_string(),
        };
        return Err((
            StatusCode::BAD_REQUEST,
            format!("That invite is for {inv_server}, and this is {here}."),
        ));
    }
    if preview.get("spent").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err((StatusCode::GONE, "That invite has already been used.".into()));
    }
    if preview.get("expired").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err((StatusCode::GONE, "That invite has expired.".into()));
    }

    let user = admit(&state, sub, &handle, false)?;

    // Tell the registry the invite is spent, using the caller's own verified
    // token, so both sides' records agree. Best-effort: the join already holds.
    let redeem_url = format!("{}/v1/invites/{}/redeem", state.registry_url.trim_end_matches('/'), code);
    let _ = client
        .post(&redeem_url)
        .header("authorization", format!("Bearer {}", body.token.trim()))
        .send()
        .await;

    Ok(Json(session_json(&state, &user)?))
}

#[cfg(test)]
mod invite_target_tests {
    use super::{request_origin, same_server};
    use axum::http::{HeaderMap, HeaderName};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                k.parse::<HeaderName>().expect("valid header name"),
                v.parse().expect("valid header value"),
            );
        }
        h
    }

    /// The forwarded name beats the literal Host, because behind a proxy Host
    /// is the upstream - a .ts.net name or localhost - and never what a
    /// listener typed. Getting this backwards would reintroduce the bug for
    /// every proxied server, which is all of them worth inviting people to.
    #[test]
    fn the_forwarded_name_wins_over_the_upstream_one() {
        let h = headers(&[
            ("host", "headless-mac.tail83699e.ts.net"),
            ("x-forwarded-host", "matt.attack.fm"),
            ("x-forwarded-proto", "https"),
        ]);
        assert_eq!(request_origin(&h).as_deref(), Some("https://matt.attack.fm"));
    }

    /// Unproxied, Host is the only answer there is, and https is the safer
    /// assumption for anything a person reaches from outside.
    #[test]
    fn an_unproxied_request_falls_back_to_host() {
        let h = headers(&[("host", "music.example.com")]);
        assert_eq!(request_origin(&h).as_deref(), Some("https://music.example.com"));
    }

    /// A proxy chain forwards a comma-joined list; the first entry is the
    /// client's own view, which is the one that matches an invite.
    #[test]
    fn a_chain_of_proxies_uses_the_first_name() {
        let h = headers(&[("x-forwarded-host", "matt.attack.fm, inner.example")]);
        assert_eq!(request_origin(&h).as_deref(), Some("https://matt.attack.fm"));
    }

    #[test]
    fn no_headers_means_no_answer() {
        assert_eq!(request_origin(&HeaderMap::new()), None);
    }


    /// The trailing slash and the case are the two ways the same address gets
    /// typed differently, and both used to reject a perfectly good invite.
    #[test]
    fn the_same_address_matches_however_it_is_written() {
        assert!(same_server("https://matt.attack.fm", "https://matt.attack.fm/"));
        assert!(same_server("https://MATT.attack.fm/", "https://matt.attack.fm"));
    }

    /// An unset AFM_PUBLIC_URL is why "that invite is for a different server"
    /// could be the answer to every invite ever minted: the comparison is
    /// against an empty string, which matches nothing. The caller checks for
    /// this before comparing and says so; this pins the behaviour it relies on.
    #[test]
    fn an_unconfigured_server_matches_nothing() {
        assert!(!same_server("https://matt.attack.fm", ""));
        assert!(!same_server("", "https://matt.attack.fm"));
    }

    #[test]
    fn a_different_host_is_a_different_server() {
        assert!(!same_server("https://matt.attack.fm", "https://someone.attack.fm"));
        // Scheme and port are part of the address, not decoration.
        assert!(!same_server("http://matt.attack.fm", "https://matt.attack.fm"));
    }
}
