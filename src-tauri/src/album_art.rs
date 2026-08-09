//! Album-art lookup, extracted from the retired local import engine.
//!
//! Art lookup is core UI - the artist page's album covers - not part of the
//! import feature, which is why this survives the engine's removal: the
//! frontend privacy switch (`onlineMetadataEnabled`) still gates the call, and
//! nothing here can fetch music, only a cover URL.

use std::time::Duration;

/// A crisp album cover URL from the iTunes Search API, or None.
#[tauri::command]
pub async fn music_album_art(artist: String, album: String) -> Option<String> {
    let term = format!("{} {}", artist.trim(), album.trim());
    if term.trim().is_empty() {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let body = client
        .get("https://itunes.apple.com/search")
        .query(&[
            ("media", "music"),
            ("entity", "album"),
            ("limit", "1"),
            ("term", term.as_str()),
        ])
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let data: serde_json::Value = serde_json::from_str(&body).ok()?;
    let art = data.pointer("/results/0/artworkUrl100").and_then(|v| v.as_str())?;
    // The API returns a 100px thumb; bump the size token for a crisp cover.
    Some(art.replace("100x100bb", "600x600bb"))
}
