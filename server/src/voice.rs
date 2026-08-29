//! The DJ's voice: cached speech for the booth's lines.
//!
//! The patter the model writes is display text - rich, per-set, and different
//! every time, which is exactly wrong for a paid text-to-speech bill. So the
//! SPOKEN layer speaks in beats, the way the radio actually talks: a short
//! generic line from a fixed library ("Up next, something to move to."),
//! then the artist's name as its own sentence ("Wet Leg."). Both cache
//! forever under a hash of (provider, voice, text): the library costs a few
//! thousand characters ONCE, an artist's name-drop costs a dozen characters
//! once per artist, and after that every set the DJ opens is free.
//!
//! Providers, in order: ElevenLabs when a key is configured (the flagship
//! sound - eleven_flash_v2_5, half-price and fast), else a local command
//! (`AFM_TTS_CMD`, e.g. a Kokoro wrapper - see server/install-voice.sh) so a
//! hub without credits still speaks, else silence: the DJ's text toast works
//! exactly as before, the clips are strictly additive.

use crate::auth;
use crate::AppState;
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// The connective library. Written without artist names on purpose - the name
/// is its own cached beat - and kept short: a DJ line is a breath, not a
/// paragraph. Three pools for the three seats a block can sit in.
const OPENERS: &[&str] = &[
    "Alright, here we go.",
    "Let's get this started.",
    "This is your set. Starting now.",
    "Cued up and ready. Here it comes.",
    "First up, something you already love.",
    "Let's open with a favourite.",
    "Right where we left off.",
    "Turn it up a little. We're on.",
];
const TURNS: &[&str] = &[
    "Up next.",
    "Keeping it moving.",
    "Here's one more.",
    "And now, this.",
    "Staying in the pocket.",
    "Let's shift gears a little.",
    "You've had this one on repeat.",
    "This one never misses.",
    "A little deeper into the library.",
    "One you might not have played in a while.",
    "Something new for you. Tell me if it lands.",
    "Trust me on this one.",
];
const CLOSERS: &[&str] = &[
    "Taking us home.",
    "Last stretch. Make it count.",
    "One more before we go.",
    "Closing it out with this.",
];

/// Which seat a block sits in, for choosing the pool.
pub enum Seat {
    Opener,
    Turn,
    Closer,
}

/// The voice the clips are minted in. Part of the cache key, so switching
/// voices re-speaks the library rather than serving the old voice's clips.
fn voice_id() -> String {
    crate::ai::setting("djVoiceId", "AFM_DJ_VOICE_ID")
        .unwrap_or_else(|| "JBFqnCBsd6RMkjVDRZzb".to_string())
}

fn eleven_key() -> Option<String> {
    crate::ai::setting("elevenLabsKey", "AFM_ELEVENLABS_KEY")
}

fn tts_cmd() -> Option<String> {
    crate::ai::setting("ttsCmd", "AFM_TTS_CMD")
}

/// Whether this hub can speak at all. Checked before any work is spent.
pub fn enabled() -> bool {
    eleven_key().is_some() || tts_cmd().is_some()
}

fn clip_dir(state: &Arc<AppState>) -> PathBuf {
    state.data_dir.join("djvoice")
}

/// The cache key IS the filename: what was said, by which voice, through
/// which door. Hex, so it is safe on disk and in a URL with no escaping.
fn clip_key(text: &str) -> String {
    let provider = if eleven_key().is_some() { "11l" } else { "cmd" };
    let mut h = Sha256::new();
    h.update(provider.as_bytes());
    h.update(b"|");
    h.update(voice_id().as_bytes());
    h.update(b"|");
    h.update(text.as_bytes());
    h.finalize()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// A stable pick from a pool: the same artist in the same seat hears the same
/// line week to week (which is what makes it cacheable AND makes the DJ feel
/// like it has habits), while different artists spread across the pool.
fn pick(pool: &[&str], salt: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    let n = u64::from_le_bytes(h.finalize()[..8].try_into().unwrap_or_default());
    pool[(n % pool.len() as u64) as usize].to_string()
}

/// Speak one text, through whichever provider is configured, into the cache.
/// Returns the clip id, or None when nothing could speak it - the caller
/// simply leaves that beat silent.
async fn speak(state: &Arc<AppState>, text: &str) -> Option<String> {
    let id = clip_key(text);
    let dir = clip_dir(state);
    let path = dir.join(format!("{id}.mp3"));
    if path.is_file() {
        return Some(id);
    }
    std::fs::create_dir_all(&dir).ok()?;

    let bytes: Vec<u8> = if let Some(key) = eleven_key() {
        let voice = voice_id();
        let url = format!(
            "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"
        );
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .ok()?
            .post(url)
            .header("xi-api-key", key)
            .json(&serde_json::json!({ "text": text, "model_id": "eleven_flash_v2_5" }))
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            eprintln!("[voice] elevenlabs refused ({}) for {:?}", resp.status(), text);
            return None;
        }
        resp.bytes().await.ok()?.to_vec()
    } else if let Some(cmd) = tts_cmd() {
        // The command contract: {text} and {out} are substituted, the command
        // writes an mp3 at {out} and exits zero. install-voice.sh provides a
        // Kokoro wrapper with exactly this shape.
        let staged = dir.join(format!("{id}.part.mp3"));
        let line = cmd
            .replace("{text}", &text.replace('\'', ""))
            .replace("{out}", &staged.to_string_lossy());
        let ok = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&line)
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok || !staged.is_file() {
            let _ = std::fs::remove_file(&staged);
            return None;
        }
        let bytes = std::fs::read(&staged).ok()?;
        let _ = std::fs::remove_file(&staged);
        bytes
    } else {
        return None;
    };

    if bytes.is_empty() {
        return None;
    }
    // Atomic land: never let a half-written clip answer a request.
    let part = dir.join(format!("{id}.writing"));
    std::fs::write(&part, &bytes).ok()?;
    std::fs::rename(&part, &path).ok()?;
    Some(id)
}

/// The two beats a block speaks: its seat's line, then the artist's name as
/// its own sentence. Either can be None (a failed mint stays silent); the
/// order is the speaking order.
pub async fn block_clips(state: &Arc<AppState>, seat: Seat, artist: &str) -> Vec<String> {
    if !enabled() {
        return Vec::new();
    }
    let pool = match seat {
        Seat::Opener => OPENERS,
        Seat::Turn => TURNS,
        Seat::Closer => CLOSERS,
    };
    let line = pick(pool, artist);
    let mut out = Vec::new();
    // A whole-set budget is the caller's business; each beat gets its own
    // modest one so a stuck provider cannot hold a set hostage.
    if let Ok(Some(id)) = tokio::time::timeout(Duration::from_secs(12), speak(state, &line)).await {
        out.push(id);
    }
    let name = artist.trim();
    if !name.is_empty() {
        let drop = format!("{name}.");
        if let Ok(Some(id)) = tokio::time::timeout(Duration::from_secs(12), speak(state, &drop)).await
        {
            out.push(id);
        }
    }
    out
}

/// `GET /api/voice/{id}` - one cached clip, for the signed-in listener.
pub async fn serve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if auth::require_caller(&state.db, &headers).is_err() {
        return (StatusCode::UNAUTHORIZED, "sign in first").into_response();
    }
    // The id is a hex hash and nothing else - anything longer or stranger is
    // someone probing for paths.
    if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return (StatusCode::BAD_REQUEST, "no such clip").into_response();
    }
    let path = clip_dir(&state).join(format!("{id}.mp3"));
    match std::fs::read(&path) {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "audio/mpeg".to_string()),
                // Content-addressed: the clip at this id can never change.
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable".to_string()),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "no such clip").into_response(),
    }
}
