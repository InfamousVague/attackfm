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
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
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

/// The ElevenLabs model the clips are minted with. Multilingual v2 is their
/// best-sounding one - slower and dearer per character than Flash, but the
/// minting left the request path long ago and every clip is bought exactly
/// once, so the wait is a background's problem and the cost stays pennies.
/// Part of the cache key: raising the model re-speaks the library.
fn tts_model() -> String {
    crate::ai::setting("djTtsModel", "AFM_DJ_TTS_MODEL")
        .unwrap_or_else(|| "eleven_multilingual_v2".to_string())
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
    h.update(tts_model().as_bytes());
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

    // One payer per clip: whoever else is already minting these words, wait
    // for their file instead of buying it twice.
    if !claim(&id) {
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if path.is_file() {
                return Some(id);
            }
        }
        return None;
    }
    let spoken = mint(text, &dir, &id, &path).await;
    release(&id);
    if spoken.is_some() {
        let _ = std::fs::remove_file(sidecar(&dir, &id));
    }
    spoken
}

async fn mint(text: &str, dir: &std::path::Path, id: &str, path: &std::path::Path) -> Option<String> {

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
            .json(&serde_json::json!({ "text": text, "model_id": tts_model() }))
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
    std::fs::rename(&part, path).ok()?;
    Some(id.to_string())
}

/// One beat the set will speak: the words, and the cache id they will land
/// under. The id is a pure function of the text, which is what lets the DJ
/// endpoint answer IMMEDIATELY - ids attach to the reply, the minting runs
/// behind it, and the clip endpoint below can even mint on demand for a
/// listener who asks before the background task gets there. The first cut
/// minted inside the request, and a first-ever set (a dozen unminted beats
/// plus the patter model) blew straight past the client's timeout.
pub struct Beat {
    pub id: String,
    pub text: String,
}

/// The seat's library line for this artist - also the DJ's WRITTEN line when
/// the patter model is absent or over budget, so the toast shows the same
/// words the voice speaks. Pure, and independent of enabled(): a hub with no
/// voice still deserves lines.
pub fn line_for(seat: Seat, artist: &str) -> String {
    let pool = match seat {
        Seat::Opener => OPENERS,
        Seat::Turn => TURNS,
        Seat::Closer => CLOSERS,
    };
    pick(pool, artist)
}

/// The two beats a block speaks: its seat's line, then the artist's name as
/// its own sentence. Pure - no network, no disk.
pub fn block_beats(seat: Seat, artist: &str) -> Vec<Beat> {
    if !enabled() {
        return Vec::new();
    }
    let line = line_for(seat, artist);
    let mut out = vec![Beat { id: clip_key(&line), text: line }];
    let name = artist.trim();
    if !name.is_empty() {
        let drop = format!("{name}.");
        out.push(Beat { id: clip_key(&drop), text: drop });
    }
    out
}

/// The words behind each promised id, kept beside the cache: the clip
/// endpoint reads this to mint on demand when it is asked for a clip the
/// background task has not landed yet (or never will - a restart mid-mint).
/// Removed once the mp3 exists.
fn sidecar(dir: &std::path::Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.txt"))
}

/// Note every beat the set has promised, then mint them behind the reply.
pub fn mint_behind(state: &Arc<AppState>, beats: Vec<Beat>) {
    if beats.is_empty() {
        return;
    }
    let dir = clip_dir(state);
    let _ = std::fs::create_dir_all(&dir);
    for b in &beats {
        if !dir.join(format!("{}.mp3", b.id)).is_file() {
            let _ = std::fs::write(sidecar(&dir, &b.id), &b.text);
        }
    }
    let state = state.clone();
    tokio::spawn(async move {
        let mut seen = HashSet::new();
        for b in beats {
            if seen.insert(b.id.clone()) {
                let _ = speak(&state, &b.text).await;
            }
        }
    });
}

/// Mints in flight, so the background task and an eager clip request cannot
/// both pay the provider for the same words. Claim and release are plain
/// synchronous calls - a guard held anywhere near an await point makes the
/// whole future non-Send, and both callers here are spawned.
fn minting() -> &'static Mutex<HashSet<String>> {
    static M: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashSet::new()))
}

fn claim(id: &str) -> bool {
    let Ok(mut in_flight) = minting().lock() else { return false };
    if in_flight.contains(id) {
        return false;
    }
    in_flight.insert(id.to_string());
    true
}

fn release(id: &str) {
    if let Ok(mut in_flight) = minting().lock() {
        in_flight.remove(id);
    }
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
    let dir = clip_dir(&state);
    let path = dir.join(format!("{id}.mp3"));
    // Asked before the background mint landed (or after a restart ate it):
    // the sidecar still knows the words, so say them now. The fetch simply
    // takes a beat longer, once.
    if !path.is_file() {
        if let Ok(text) = std::fs::read_to_string(sidecar(&dir, &id)) {
            let _ = speak(&state, text.trim()).await;
        }
    }
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
