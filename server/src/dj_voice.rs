//! Speaking to the DJ.
//!
//! The Booth's other options are all taps on somebody else's words - a mood
//! chip, a needle drop. This one is the listener's own sentence: hold the mic,
//! say what you want, and two things happen at once.
//!
//! The FAST half is a set from what is already here: the transcript goes
//! straight into the same `seed` the mood chips use, so the whole existing
//! pipeline - taste scoring, patter, the spoken beats - plays a set steered by
//! the words within seconds. Nothing about that pipeline changes; the mic is
//! just a new way of writing the brief.
//!
//! The SLOW half is the part a chip cannot do: the brief usually names music
//! the library does not hold ("some new French house", "that band like Fugazi
//! but slower"), so the chat model turns it into a shortlist of real outside
//! recordings and the collector starts pulling them the way it pulls its own
//! finds - same delegated-download door, same audition quarantine, same
//! adoption rules. They land in For-you and the Just-downloaded list over the
//! next minutes, while the fast half is already playing.
//!
//! Speech-to-text is the whisper install the audiobook transcriber already
//! uses - one clip, a few seconds of audio - so a hub set up for read-along
//! needs nothing new. A hub without whisper says so plainly instead of
//! pretending to listen.

use crate::ai::AiClient;
use crate::auth;
use crate::db::DiscoveryRow;
use crate::AppState;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

type ApiResult = Result<Json<Value>, (StatusCode, String)>;

/// A spoken brief is a sentence, not a podcast. The server has no
/// DefaultBodyLimit configured, so axum's own 2 MB ceiling already stands at
/// the door (see the identical note in peersync.rs) - this constant matches it
/// rather than promising room the extractor would refuse anyway. Two megabytes
/// is minutes of voice-bitrate opus; the client stops recording long before.
const MAX_CLIP_BYTES: usize = 2 * 1024 * 1024;

/// How many outside recordings one brief may set the collector on. The brief
/// is one sentence; eight downloads is a generous reading of one sentence.
const MAX_PULLS: usize = 8;

/// `POST /api/dj/hear` - the raw clip in, the transcript and the fetch list out.
///
/// The client then starts the set itself through the ordinary `/api/dj` door
/// with the transcript as the seed - deliberately NOT done here, so the set
/// rides every existing behaviour (banked vibes, patter, voice beats) without
/// this endpoint holding a copy of any of it.
pub async fn hear(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let caller =
        auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if body.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no audio arrived".into()));
    }
    if body.len() > MAX_CLIP_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "that clip is too long".into()));
    }
    let (Some(bin), Some(model)) = (
        crate::transcribe::whisper_bin(),
        crate::transcribe::whisper_model(&state),
    ) else {
        // The same tool the audiobook transcriber uses, and the same honest
        // refusal it gives: this is a server install, not an app update.
        return Err((
            StatusCode::PRECONDITION_FAILED,
            "This server has no speech recogniser installed. It is the same whisper install read-along uses — set that up and the DJ can hear you.".into(),
        ));
    };

    let heard = transcribe_clip(&state, &bin, &model, &body)
        .await
        .unwrap_or_default();
    if heard.is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "The DJ couldn't make that out. Try again a little closer to the mic.".into(),
        ));
    }

    // The outside shortlist, inline: one chat call, a few seconds, and the
    // answer belongs in this response - "fetching these for you" is half the
    // point of speaking. No model, no shortlist; the set still plays.
    let picks = shortlist(&state, &heard).await;
    let fetching: Vec<Value> = picks
        .iter()
        .map(|(t, a)| json!({ "title": t, "artist": a }))
        .collect();

    // The pulls themselves run behind the reply - each one is a catalogue
    // resolve plus a download enqueue, and the listener is waiting to hear
    // music, not to watch downloads queue.
    if !picks.is_empty() {
        let st = state.clone();
        let user = caller.id;
        let brief = heard.clone();
        tokio::spawn(async move {
            for (title, artist) in picks {
                let d = DiscoveryRow {
                    // The brief in the ext id keeps one request's pulls from
                    // colliding with the discovery pool's ids, and the upsert
                    // on (user, ext_id) makes repeating yourself harmless.
                    ext_id: format!("voice:{}|{}", artist.to_lowercase(), title.to_lowercase()),
                    title,
                    artist,
                    cover: String::new(),
                    url: String::new(),
                    preview: String::new(),
                    // reason_for reads the seed when there is no model moment
                    // to spare; the brief IS the reason here.
                    seed: brief.clone(),
                    popularity: 0.0,
                    bpm: None,
                    lyric_vec: None,
                    // Above the collector's own candidates on the queue: the
                    // listener literally asked for this one out loud.
                    score: 10.0,
                    energy: None,
                    brightness: None,
                    rhythmic: None,
                    released: None,
                };
                let _ = crate::collector::buy(&st, user, &d, false, None).await;
            }
        });
    }

    Ok(Json(json!({ "heard": heard, "fetching": fetching })))
}

/// One clip through ffmpeg and whisper, back as plain text.
///
/// The same two-stage pipeline transcribe.rs runs on audiobooks, cut down for
/// a clip that is seconds long: no word clocks, no JSON, just `-nt` stdout.
async fn transcribe_clip(
    state: &Arc<AppState>,
    bin: &std::path::Path,
    model: &std::path::Path,
    clip: &[u8],
) -> Option<String> {
    let stage = state.data_dir.join("transcribe").join(format!(
        "voice-{}",
        crate::db::now_ms()
    ));
    tokio::fs::create_dir_all(&stage).await.ok()?;
    let raw = stage.join("clip");
    let wav = stage.join("in.wav");
    tokio::fs::write(&raw, clip).await.ok()?;

    // The clip arrives as whatever the WebView's recorder produces - webm on
    // Android, mp4 on iOS - and ffmpeg reads either without being told which.
    let decoded = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("ffmpeg")
            .args(["-y", "-loglevel", "error", "-i"])
            .arg(&raw)
            .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
            .arg(&wav)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await;
    if !matches!(decoded, Ok(Ok(st)) if st.success()) || !wav.is_file() {
        let _ = tokio::fs::remove_dir_all(&stage).await;
        return None;
    }

    let read = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new(bin)
            .arg("-m")
            .arg(model)
            .arg("-f")
            .arg(&wav)
            // Plain text on stdout - a brief needs no timestamps.
            .arg("-nt")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output(),
    )
    .await;
    let _ = tokio::fs::remove_dir_all(&stage).await;
    let out = match read {
        Ok(Ok(o)) if o.status.success() => o.stdout,
        _ => return None,
    };
    let text = String::from_utf8_lossy(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    // Whisper writes bracketed noise notes for silence - "[BLANK_AUDIO]",
    // "(wind blowing)" - which are not a brief and must not steer a set.
    let said = text.trim_matches(|c| c == '[' || c == ']' || c == '(' || c == ')');
    if said.is_empty() || text.starts_with('[') || text.starts_with('(') {
        return None;
    }
    /*
     * And its UNBRACKETED hallucinations. Fed pure silence, whisper does not
     * say nothing - it says "you", or thanks an audience it imagines from its
     * training data. Measured on this exact pipeline: one second of digital
     * silence transcribed as "you", which would then have steered a whole set.
     * An accidental tap on the mic is mostly silence, so this is the ordinary
     * misfire, not a corner. Real one-word briefs ("jazz") survive the floor.
     */
    let bare = text
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != ' ', "");
    const IMAGINED: [&str; 4] = ["you", "thank you", "thanks for watching", "bye"];
    if bare.len() < 4 || IMAGINED.contains(&bare.trim()) {
        return None;
    }
    Some(text)
}

#[derive(Deserialize)]
struct Shortlist {
    picks: Vec<Pick>,
}
#[derive(Deserialize)]
struct Pick {
    title: String,
    artist: String,
}

/// The brief as a list of real outside recordings, or nothing.
///
/// Nothing is the common and correct answer for briefs about what is already
/// here ("play my chill stuff, louder") - the model is told to return an empty
/// list rather than invent, and everything it does name is checked against the
/// library so a request for a song you own does not buy a duplicate.
async fn shortlist(state: &Arc<AppState>, brief: &str) -> Vec<(String, String)> {
    let Some(client) = AiClient::configured() else {
        return Vec::new();
    };
    let schema = json!({
        "type": "object",
        "properties": {
            "picks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "artist": { "type": "string" }
                    },
                    "required": ["title", "artist"]
                }
            }
        },
        "required": ["picks"]
    });
    let system = "You turn a listener's spoken request into specific recordings worth downloading. \
        Name only real, existing songs - canonical studio recordings, exact titles, exact artist names. \
        Only name songs when the request asks for music the listener likely does not have: a genre to \
        explore, an era, an artist, 'something new'. If the request is about how to play what they \
        already own (a mood, a volume, 'my liked songs'), return an empty list. Never invent a song.";
    let prompt = format!("The listener said: \"{brief}\"\nName up to {MAX_PULLS} recordings, or none.");
    let Ok(list) = client
        .chat_json::<Shortlist>(system, &prompt, "dj_voice_shortlist", schema, false)
        .await
    else {
        return Vec::new();
    };
    list.picks
        .into_iter()
        .map(|p| (p.title.trim().to_string(), p.artist.trim().to_string()))
        .filter(|(t, a)| !t.is_empty() && !a.is_empty())
        // What the library already holds is not fetched again.
        .filter(|(t, a)| !state.db.has_title_artist(t, a))
        .take(MAX_PULLS)
        .collect()
}
