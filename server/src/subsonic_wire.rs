//! The Subsonic wire: the envelope every `/rest` answer wears, the error
//! codes the protocol names, and the two encodings - JSON, and the XML the
//! original API spoke and older clients still expect.
//!
//! One shape drives both: handlers build a `serde_json::Value` in the JSON
//! layout the OpenSubsonic spec documents, and the XML is derived from it by
//! the protocol's own convention - an object's scalar members are attributes,
//! its arrays are repeated child elements named by the key, and a member
//! called `value` is the element's text (that is how `genre` and `lyrics`
//! carry their names and words).
use serde_json::{json, Map, Value};

pub const API_VERSION: &str = "1.16.1";
pub const SERVER_TYPE: &str = "AttackFM";

/// The protocol's error codes, by name.
#[derive(Clone, Copy)]
pub enum SubsonicError {
    Generic = 0,
    MissingParameter = 10,
    ClientTooOld = 20,
    ServerTooOld = 30,
    WrongCredentials = 40,
    TokenNotSupported = 41,
    NotAuthorized = 50,
    TrialOver = 60,
    NotFound = 70,
}

/// Which encoding the client asked for (`f=`). Absent means XML, as it has
/// since 2008; every modern client says `json`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Xml,
    /// JSONP: JSON wrapped in `callback(...)`.
    Jsonp,
}

impl Format {
    pub fn from_param(f: Option<&str>) -> Format {
        match f.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("json") => Format::Json,
            Some("jsonp") => Format::Jsonp,
            _ => Format::Xml,
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Format::Json => "application/json; charset=utf-8",
            Format::Jsonp => "application/javascript; charset=utf-8",
            Format::Xml => "application/xml; charset=utf-8",
        }
    }
}

/// The base of every answer: what a `ping` is, entirely.
fn envelope(status: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("status".into(), Value::from(status));
    m.insert("version".into(), Value::from(API_VERSION));
    m.insert("type".into(), Value::from(SERVER_TYPE));
    m.insert("serverVersion".into(), Value::from(env!("CARGO_PKG_VERSION")));
    m.insert("openSubsonic".into(), Value::from(true));
    m
}

/// An answer: the base plus one payload member (`artists`, `album`, ...),
/// or nothing more for the verbs that only acknowledge.
pub fn ok(payload: Option<(&str, Value)>) -> Value {
    let mut m = envelope("ok");
    if let Some((key, value)) = payload {
        m.insert(key.into(), value);
    }
    json!({ "subsonic-response": Value::Object(m) })
}

pub fn failed(code: SubsonicError, message: &str) -> Value {
    let mut m = envelope("failed");
    m.insert("error".into(), json!({ "code": code as i64, "message": message }));
    json!({ "subsonic-response": Value::Object(m) })
}

/// The document in the asked-for encoding.
pub fn encode(doc: &Value, format: Format, callback: Option<&str>) -> String {
    match format {
        Format::Json => doc.to_string(),
        Format::Jsonp => {
            let cb = callback.filter(|c| c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '$')).unwrap_or("callback");
            format!("{cb}({});", doc)
        }
        Format::Xml => {
            let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
            if let Some(root) = doc.get("subsonic-response") {
                write_element(&mut out, "subsonic-response", root, true);
            }
            out
        }
    }
}

fn xml_escape(s: &str, attr: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attr => out.push_str("&quot;"),
            // Control characters are not XML; a title with one would break
            // the whole document for the client.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// One element from an object: scalars as attributes, `value` as text,
/// arrays as repeated children, objects as single children.
fn write_element(out: &mut String, name: &str, v: &Value, root: bool) {
    let Some(obj) = v.as_object() else {
        // A bare scalar in an array (rare in this API) becomes an element
        // with text.
        if let Some(text) = scalar(v) {
            out.push('<');
            out.push_str(name);
            out.push('>');
            out.push_str(&xml_escape(&text, false));
            out.push_str("</");
            out.push_str(name);
            out.push('>');
        }
        return;
    };
    out.push('<');
    out.push_str(name);
    if root {
        out.push_str(" xmlns=\"http://subsonic.org/restapi\"");
    }
    let mut text: Option<String> = None;
    let mut children: Vec<(&String, &Value)> = Vec::new();
    for (k, val) in obj {
        if k == "value" {
            text = scalar(val);
            continue;
        }
        match val {
            Value::Null => {}
            // An empty list writes nothing, so the element can self-close.
            Value::Array(items) if items.is_empty() => {}
            Value::Array(_) | Value::Object(_) => children.push((k, val)),
            other => {
                if let Some(s) = scalar(other) {
                    out.push(' ');
                    out.push_str(k);
                    out.push_str("=\"");
                    out.push_str(&xml_escape(&s, true));
                    out.push('"');
                }
            }
        }
    }
    if children.is_empty() && text.is_none() {
        out.push_str("/>");
        return;
    }
    out.push('>');
    if let Some(t) = text {
        out.push_str(&xml_escape(&t, false));
    }
    for (k, val) in children {
        match val {
            Value::Array(items) => {
                for item in items {
                    write_element(out, k, item, false);
                }
            }
            other => write_element(out, k, other, false),
        }
    }
    out.push_str("</");
    out.push_str(name);
    out.push('>');
}

/// The Subsonic token: `t = md5(password + salt)`, hex, lower-case.
pub fn token_for(password: &str, salt: &str) -> String {
    use md5::{Digest, Md5};
    let mut h = Md5::new();
    h.update(password.as_bytes());
    h.update(salt.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A `p=` password as sent: plain, or `enc:` followed by hex of the bytes.
pub fn decode_password(p: &str) -> String {
    if let Some(hex) = p.strip_prefix("enc:") {
        let bytes: Option<Vec<u8>> = (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
            .collect();
        if let Some(bytes) = bytes {
            return String::from_utf8_lossy(&bytes).into_owned();
        }
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_follows_the_convention() {
        let doc = ok(Some((
            "genres",
            json!({ "genre": [{ "value": "Rock & Roll", "songCount": 3, "albumCount": 1 }] }),
        )));
        let xml = encode(&doc, Format::Xml, None);
        // serde_json's map is ordered by key, so attributes are checked by
        // presence, not by position.
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?><subsonic-response xmlns=\"http://subsonic.org/restapi\""), "{xml}");
        assert!(xml.contains(" status=\"ok\""), "{xml}");
        assert!(xml.contains("<genres><genre albumCount=\"1\" songCount=\"3\">Rock &amp; Roll</genre></genres>"), "{xml}");
        assert!(xml.ends_with("</subsonic-response>"));
    }

    #[test]
    fn empty_payload_self_closes() {
        let doc = ok(Some(("playlists", json!({ "playlist": [] }))));
        let xml = encode(&doc, Format::Xml, None);
        assert!(xml.contains("<playlists/>"), "{xml}");
    }

    #[test]
    fn token_matches_the_spec_example() {
        // The published example: password "sesame", salt "c19b2d" -> 26719a1196d2a940705a59634eb18eab
        assert_eq!(token_for("sesame", "c19b2d"), "26719a1196d2a940705a59634eb18eab");
    }

    #[test]
    fn enc_password_decodes() {
        assert_eq!(decode_password("enc:736573616d65"), "sesame");
        assert_eq!(decode_password("plain"), "plain");
    }
}
