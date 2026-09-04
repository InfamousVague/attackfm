//! A catalogue clip, fresh, streamed by the hub.
//!
//! Deezer's thirty-second previews come with expiring signatures, and the
//! pool keeps the URL it saw at harvest - up to weeks old by the time a
//! Discover card is tapped. The Date deck learned this first and asks
//! `/api/date/preview` for a fresh link as a card warms; a shelf cannot warm
//! two dozen cards, and an <audio> element on iOS must be handed a playable
//! URL INSIDE the tap (WebKit's gesture rule: an await before play() loses
//! it). So the hub hands out a same-origin path per card, signed for the day
//! the way the wall's covers are, and resolves the fresh link only when the
//! path is actually asked for - one Deezer call per play, remembered for
//! twenty minutes. iOS requires byte-range support from any server hosting
//! media, so the clip is buffered whole (it is half a megabyte) and ranges
//! are honoured off the buffer.
use crate::{auth, discovery, AppState};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const FRESH_FOR: Duration = Duration::from_secs(20 * 60);

/// The path a card carries: same origin as everything else it plays, and
/// valid for the day the shelf was served (plus the day after, like the wall).
pub fn path_for(secret: &[u8], ext_id: &str) -> String {
    let sig = auth::public_sig(secret, &format!("preview.{ext_id}"));
    format!("/api/preview/{ext_id}/{sig}")
}

fn cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static C: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A preview link that works right now, off the catalogue rather than the
/// pool's stale copy.
async fn fresh_url(ext_id: &str) -> Option<String> {
    if let Some((url, at)) = cache().lock().ok().and_then(|c| c.get(ext_id).cloned()) {
        if at.elapsed() < FRESH_FOR {
            return Some(url);
        }
    }
    let id = ext_id.strip_prefix("deezer:track:")?.parse::<u64>().ok()?;
    let v = discovery::client(12)
        .get(format!("https://api.deezer.com/track/{id}"))
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()?;
    let url = v.get("preview")?.as_str()?.trim().to_string();
    if url.is_empty() {
        return None;
    }
    if let Ok(mut c) = cache().lock() {
        c.insert(ext_id.to_string(), (url.clone(), Instant::now()));
    }
    Some(url)
}

/// `GET /api/preview/{ext_id}/{sig}`.
pub async fn clip(
    State(state): State<Arc<AppState>>,
    Path((ext_id, sig)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    if !auth::public_sig_ok(&state.stream_secret, &format!("preview.{ext_id}"), &sig) {
        return Err(StatusCode::FORBIDDEN);
    }
    let url = fresh_url(&ext_id).await.ok_or(StatusCode::NOT_FOUND)?;
    let resp = discovery::client(20).get(&url).send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !resp.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let bytes = resp.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    Ok(serve(&bytes, range.as_deref()))
}

/// The clip, or the slice of it a Range header asks for.
pub fn serve(bytes: &[u8], range: Option<&str>) -> Response {
    let len = bytes.len();
    let head = |status: StatusCode| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "audio/mpeg")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "private, max-age=600")
    };
    if let Some((start, end)) = range.and_then(|r| parse_range(r, len)) {
        let body = bytes[start..=end].to_vec();
        return head(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(header::CONTENT_LENGTH, body.len())
            .body(Body::from(body))
            .expect("static headers");
    }
    head(StatusCode::OK)
        .header(header::CONTENT_LENGTH, len)
        .body(Body::from(bytes.to_vec()))
        .expect("static headers")
}

/// "bytes=a-b", "bytes=a-", "bytes=-n" as an inclusive (start, end) inside
/// `len`; None for anything else, which is served whole rather than refused.
fn parse_range(spec: &str, len: usize) -> Option<(usize, usize)> {
    if len == 0 {
        return None;
    }
    let spec = spec.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: usize = n.parse().ok()?;
            if n == 0 {
                return None;
            }
            (len.saturating_sub(n), len - 1)
        }
        (a, "") => (a.parse().ok()?, len - 1),
        (a, b) => (a.parse().ok()?, b.parse::<usize>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_honoured_off_the_buffer_the_way_ios_needs() {
        let clip: Vec<u8> = (0..100u8).collect();
        let whole = serve(&clip, None);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.headers()[header::CONTENT_LENGTH], "100");
        assert_eq!(whole.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(whole.headers()[header::CONTENT_TYPE], "audio/mpeg");

        let part = serve(&clip, Some("bytes=10-19"));
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(part.headers()[header::CONTENT_LENGTH], "10");

        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)), "open-ended, what WebKit sends first");
        assert_eq!(parse_range("bytes=-5", 100), Some((95, 99)), "suffix");
        assert_eq!(parse_range("bytes=50-500", 100), Some((50, 99)), "clamped to the clip");
        assert_eq!(parse_range("bytes=200-", 100), None, "past the end: served whole, not refused");
        assert_eq!(parse_range("garbage", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
    }

    #[test]
    fn the_path_carries_a_signature_the_route_accepts_and_a_forged_one_fails() {
        let secret = b"a-secret";
        let p = path_for(secret, "deezer:track:123");
        let (ext, sig) = p.strip_prefix("/api/preview/").unwrap().rsplit_once('/').unwrap();
        assert_eq!(ext, "deezer:track:123");
        assert!(auth::public_sig_ok(secret, &format!("preview.{ext}"), sig));
        assert!(!auth::public_sig_ok(secret, "preview.deezer:track:124", sig), "one signature, one song");
        assert!(!auth::public_sig_ok(b"other", &format!("preview.{ext}"), sig));
    }
}
