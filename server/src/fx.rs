//! The hi-fi chain: parameterized, ordered audio nodes, compiled here.
//!
//! The original rack (stream.rs EFFECTS) is a fixed menu: names in, filters
//! out, order decided by the desk. This is the other instrument: the client
//! describes a CHAIN - which nodes, with which settings, in which order - and
//! this module turns it into the `-af` string the encoder runs.
//!
//! The invariant is inherited from the rack and matters more here, not less:
//! **no request composes ffmpeg syntax.** The client sends typed parameters;
//! every number lands in a clamp before it lands in a format string, every
//! string is a tag matched against the registry below, and an unknown node is
//! dropped rather than passed through. The attack surface of `fx2` is exactly
//! the attack surface of `fx`: none, just wider vocabulary.
//!
//! Two lessons from the first rack are load-bearing:
//!  - Order is the user's. A set has no opinion about whether the compressor
//!    comes before the EQ, but the ear does, and this time the whole point is
//!    letting the listener decide. Nodes compile in the order they arrive.
//!  - The limiter is not optional. Any chain of boosts can push past full
//!    scale, and clipping is never one of the effects anybody asked for.

use crate::auth;
use crate::AppState;
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// One node as the wire carries it: a tag plus flat numeric params. Unknown
/// tags fail THIS node's parse, not the whole chain - the caller skips them.
#[derive(Deserialize)]
#[serde(tag = "t")]
enum Node {
    /// Input trim, in dB. The knob you reach for before anything else.
    #[serde(rename = "pre")]
    Pre { g: f64 },
    /// One parametric bell: centre frequency, gain, and how narrow.
    #[serde(rename = "peq")]
    Peq { f: f64, g: f64, q: Option<f64> },
    /// Low shelf - the bass knob.
    #[serde(rename = "bass")]
    Bass { g: f64, f: Option<f64> },
    /// High shelf - the treble knob.
    #[serde(rename = "treble")]
    Treble { g: f64, f: Option<f64> },
    /// High-pass: everything below the corner goes.
    #[serde(rename = "hp")]
    Hp { f: f64 },
    /// Low-pass: everything above the corner goes.
    #[serde(rename = "lp")]
    Lp { f: f64 },
    /// Compressor, the four controls that matter plus makeup.
    #[serde(rename = "comp")]
    Comp {
        thr: Option<f64>,
        ratio: Option<f64>,
        att: Option<f64>,
        rel: Option<f64>,
        mk: Option<f64>,
    },
    /// Stereo width: side level. 1 is as recorded, under is narrower, over is
    /// wider, 0.05 is very nearly mono.
    #[serde(rename = "width")]
    Width { amt: f64 },
    /// Headphone crossfeed - a little of each channel into the other, the way
    /// speakers in a room do it for free.
    #[serde(rename = "xfeed")]
    Xfeed { amt: Option<f64> },
    /// The gentle leveler. No knobs on purpose: dynaudnorm has thirteen and
    /// the one thing anybody means by "even it out" is the default.
    #[serde(rename = "level")]
    Level {},
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        // A NaN cannot come out of JSON, but an Infinity can ("1e999" parses
        // to it) - and Infinity.clamp() would hand it straight through.
        (lo + hi) / 2.0
    }
}

impl Node {
    /// The one place params meet ffmpeg syntax. Every number is clamped on
    /// this line or the line above it; nothing else in the file formats.
    fn compile(&self) -> String {
        match self {
            Node::Pre { g } => format!("volume={:.2}dB", clamp(*g, -12.0, 12.0)),
            Node::Peq { f, g, q } => format!(
                "equalizer=f={:.1}:t=q:w={:.2}:g={:.2}",
                clamp(*f, 20.0, 20000.0),
                clamp(q.unwrap_or(1.0), 0.1, 10.0),
                clamp(*g, -18.0, 18.0),
            ),
            Node::Bass { g, f } => format!(
                "bass=g={:.2}:f={:.1}",
                clamp(*g, -18.0, 18.0),
                clamp(f.unwrap_or(100.0), 40.0, 500.0),
            ),
            Node::Treble { g, f } => format!(
                "treble=g={:.2}:f={:.1}",
                clamp(*g, -18.0, 18.0),
                clamp(f.unwrap_or(8000.0), 1000.0, 16000.0),
            ),
            Node::Hp { f } => format!("highpass=f={:.1}", clamp(*f, 20.0, 2000.0)),
            Node::Lp { f } => format!("lowpass=f={:.1}", clamp(*f, 1000.0, 20000.0)),
            Node::Comp { thr, ratio, att, rel, mk } => format!(
                // acompressor takes threshold as an amplitude or dB string;
                // attack/release in ms. Makeup below 1 is rejected by some
                // builds, so it is expressed in dB the same as threshold.
                "acompressor=threshold={:.1}dB:ratio={:.1}:attack={:.0}:release={:.0}:makeup={:.1}dB",
                clamp(thr.unwrap_or(-18.0), -60.0, 0.0),
                clamp(ratio.unwrap_or(3.0), 1.0, 20.0),
                clamp(att.unwrap_or(20.0), 1.0, 500.0),
                clamp(rel.unwrap_or(250.0), 20.0, 2000.0),
                clamp(mk.unwrap_or(0.0), 0.0, 24.0),
            ),
            Node::Width { amt } => {
                format!("stereotools=slev={:.3}", clamp(*amt, 0.05, 2.5))
            }
            Node::Xfeed { amt } => {
                format!("crossfeed=strength={:.2}", clamp(amt.unwrap_or(0.5), 0.0, 1.0))
            }
            Node::Level {} => "dynaudnorm=p=0.95:m=10".to_string(),
        }
    }
}

/// Longest chain honoured. Sixteen is more boxes than any desk, and the cap
/// is what keeps a hostile URL from stacking a thousand compressors.
const MAX_NODES: usize = 16;
/// The raw JSON is length-capped before it is even parsed, for the same
/// reason the node count is.
const MAX_WIRE: usize = 4096;

/// Turns the `fx2` query value - a URL-encoded JSON array of nodes - into one
/// `-af` chain, or None when nothing in it survives. Unknown node types and
/// unparseable entries are dropped one by one rather than failing the chain:
/// a newer client against an older server loses the node the server has not
/// heard of, not its whole sound.
pub fn chain_from_wire(fx2: Option<&String>) -> Option<String> {
    let raw = fx2?;
    if raw.is_empty() || raw.len() > MAX_WIRE {
        return None;
    }
    let items: Vec<Value> = serde_json::from_str(raw).ok()?;
    let mut filters: Vec<String> = Vec::new();
    for item in items.into_iter().take(MAX_NODES) {
        if let Ok(node) = serde_json::from_value::<Node>(item) {
            filters.push(node.compile());
        }
    }
    if filters.is_empty() {
        return None;
    }
    // The safety net every chain of boosts earns.
    filters.push("alimiter=limit=0.95".to_string());
    Some(filters.join(","))
}

/// `GET /api/fx/nodes` - the vocabulary, as data.
///
/// The plugin ships its own catalogue (it has to render offline), but the
/// server publishing what it actually honours - with the real clamp ranges -
/// is what lets a future UI grey out a node an older box would silently drop.
pub async fn nodes() -> Json<Value> {
    Json(json!({
        "api": 1,
        "nodes": [
            { "t": "pre",    "params": { "g": { "min": -12, "max": 12, "default": 0 } } },
            { "t": "peq",    "params": { "f": { "min": 20, "max": 20000, "default": 1000 },
                                          "g": { "min": -18, "max": 18, "default": 0 },
                                          "q": { "min": 0.1, "max": 10, "default": 1.0 } } },
            { "t": "bass",   "params": { "g": { "min": -18, "max": 18, "default": 0 },
                                          "f": { "min": 40, "max": 500, "default": 100 } } },
            { "t": "treble", "params": { "g": { "min": -18, "max": 18, "default": 0 },
                                          "f": { "min": 1000, "max": 16000, "default": 8000 } } },
            { "t": "hp",     "params": { "f": { "min": 20, "max": 2000, "default": 30 } } },
            { "t": "lp",     "params": { "f": { "min": 1000, "max": 20000, "default": 18000 } } },
            { "t": "comp",   "params": { "thr": { "min": -60, "max": 0, "default": -18 },
                                          "ratio": { "min": 1, "max": 20, "default": 3 },
                                          "att": { "min": 1, "max": 500, "default": 20 },
                                          "rel": { "min": 20, "max": 2000, "default": 250 },
                                          "mk": { "min": 0, "max": 24, "default": 0 } } },
            { "t": "width",  "params": { "amt": { "min": 0.05, "max": 2.5, "default": 1.0 } } },
            { "t": "xfeed",  "params": { "amt": { "min": 0, "max": 1, "default": 0.5 } } },
            { "t": "level",  "params": {} }
        ]
    }))
}

// --- presets ----------------------------------------------------------------

#[derive(Deserialize)]
pub struct PresetBody {
    pub name: String,
    /// The chain as the wire carries it - a JSON array of nodes.
    pub chain: Value,
}

type ApiResult = Result<Json<Value>, (StatusCode, String)>;

/// `GET /api/fx/presets` - this listener's saved chains.
pub async fn presets(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let rows = state.db.fx_presets(caller.id);
    Ok(Json(json!({ "presets": rows.into_iter().map(|(id, name, chain, updated)| {
        json!({
            "id": id,
            "name": name,
            // Stored canonical (it was validated on the way in), parsed here
            // so the client gets an array, not a string of an array.
            "chain": serde_json::from_str::<Value>(&chain).unwrap_or(Value::Array(vec![])),
            "updatedAt": updated,
        })
    }).collect::<Vec<_>>() })))
}

/// `POST /api/fx/presets` - save a chain under a name. Same name replaces:
/// "save" from the rack means "make this the one called Warm Nights", and two
/// rows with one name would make the picker a lottery.
pub async fn save_preset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PresetBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let name = body.name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err((StatusCode::BAD_REQUEST, "a preset needs a name under 60 characters".into()));
    }
    // Validated exactly like the stream would: parse, drop what does not
    // survive, and refuse a preset that compiles to nothing - saving silence
    // under a name is a support ticket later.
    let wire = body.chain.to_string();
    if chain_from_wire(Some(&wire)).is_none() {
        return Err((StatusCode::BAD_REQUEST, "that chain has no nodes this server knows".into()));
    }
    let id = state
        .db
        .fx_preset_save(caller.id, name, &wire)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true, "id": id })))
}

/// `DELETE /api/fx/presets/{id}` - mine only; someone else's id is a 404, not
/// a 403, so ids cannot be probed for existence.
pub async fn delete_preset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let gone = state
        .db
        .fx_preset_delete(caller.id, id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !gone {
        return Err((StatusCode::NOT_FOUND, "no such preset".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(s: &str) -> Option<String> {
        chain_from_wire(Some(&s.to_string()))
    }

    #[test]
    fn compiles_in_user_order() {
        let chain = wire(r#"[{"t":"lp","f":8000},{"t":"pre","g":3}]"#).unwrap();
        // lp FIRST because the user put it first - the old rack would have
        // reordered these, and not reordering is this rack's whole point.
        assert!(chain.starts_with("lowpass=f=8000.0,volume=3.00dB"));
        assert!(chain.ends_with("alimiter=limit=0.95"));
    }

    #[test]
    fn clamps_and_survives_hostility() {
        // Out-of-range numbers pinned, an unknown node between two real ones
        // dropped, neighbours kept. (An Infinity cannot arrive at all:
        // serde_json refuses 1e999 at parse - measured, not assumed - so the
        // clamp's non-finite arm is belt-and-braces for non-JSON callers.)
        let chain = wire(
            r#"[{"t":"pre","g":900},{"t":"evil","cmd":"x"},{"t":"hp","f":1e308}]"#,
        )
        .unwrap();
        assert!(chain.contains("volume=12.00dB"));
        assert!(chain.contains("highpass=f=2000.0"));
        assert!(!chain.contains("evil"));
        // And the whole-array refusal for a true out-of-range float:
        assert!(wire(r#"[{"t":"pre","g":1e999}]"#).is_none());
    }

    #[test]
    fn no_syntax_can_ride_a_string() {
        // The only strings in the wire format are the tags; a tag that is not
        // in the registry kills its node. Nothing else is ever interpolated.
        assert!(wire(r#"[{"t":"pre,volume=0:x","g":0}]"#).is_none());
        assert!(wire(r#"[{"t":"lavfi"}]"#).is_none());
    }

    #[test]
    fn caps_hold() {
        let many = format!(
            "[{}]",
            std::iter::repeat(r#"{"t":"pre","g":1}"#).take(50).collect::<Vec<_>>().join(",")
        );
        let chain = wire(&many).unwrap();
        // 16 nodes + the limiter.
        assert_eq!(chain.matches("volume=").count(), 16);
        let huge = format!(r#"[{{"t":"pre","g":{} }}]"#, "1".repeat(5000));
        assert!(wire(&huge).is_none());
    }
}
