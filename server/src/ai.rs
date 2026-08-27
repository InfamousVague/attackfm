//! Small OpenAI-compatible client shared by the server's AI features.
//!
//! Chat and embeddings deliberately remain separate models. The configured
//! endpoint is expected to be local (Ollama by default), but the protocol is
//! the ordinary OpenAI-compatible one so operators retain model choice.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

/// The operator's choices, layered over the environment.
///
/// A process-wide overlay rather than a `&Db` threaded through `configured()`.
/// Every one of its five call sites sits in a background loop that has no
/// database handle in reach, and adding one to each would push a parameter
/// through code that has nothing to do with settings. There is exactly one
/// server process, the values are tiny, and they change only when the owner
/// saves - so a read-mostly lock loaded at boot is both simpler and cheaper.
///
/// Keys are the wire names (`url`, `chatModel`, ...), not the env names: this
/// is what the owner set, and the environment is what it falls back TO.
static OVERRIDES: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();

/// The prefix every AI choice is stored under in `server_prefs`.
pub const PREF_PREFIX: &str = "ai.";

fn overrides() -> &'static RwLock<HashMap<String, String>> {
    OVERRIDES.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Read the operator's choices out of the database once, at boot.
pub fn load_overrides(db: &crate::db::Db) {
    let stored = db.server_prefs_under(PREF_PREFIX);
    let mut map = HashMap::new();
    for (key, value) in stored {
        if let Some(name) = key.strip_prefix(PREF_PREFIX) {
            map.insert(name.to_string(), value);
        }
    }
    if let Ok(mut guard) = overrides().write() {
        *guard = map;
    }
}

/// Set or clear one choice in the live overlay. The caller persists it.
pub fn set_override(name: &str, value: Option<&str>) {
    if let Ok(mut guard) = overrides().write() {
        match value {
            Some(v) if !v.trim().is_empty() => {
                guard.insert(name.to_string(), v.trim().to_string());
            }
            _ => {
                guard.remove(name);
            }
        }
    }
}

/// What the owner chose for `name`, if anything.
pub fn override_for(name: &str) -> Option<String> {
    overrides().read().ok()?.get(name).cloned()
}

/// The owner's choice, else the environment, else nothing - the one resolution
/// order, in one place, so a route and a loop can never disagree about it.
pub fn setting(name: &str, env: &str) -> Option<String> {
    override_for(name)
        .or_else(|| std::env::var(env).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The fast enrichment model: the usability layer that gives a song its first
/// pass. Defaulted, unlike the chat model, because it is cheap and something
/// has to run - the curator would otherwise do nothing at all on a box whose
/// operator never named one.
pub fn fast_model() -> String {
    setting("fastModel", "AFM_FAST_ENRICH_MODEL").unwrap_or_else(|| "qwen3.5:9b".into())
}

/// The auditor that goes back over a profile and removes what the evidence
/// does not support. Bigger and slower than the fast pass by design.
pub fn refinement_model() -> String {
    setting("refinementModel", "AFM_REFINEMENT_MODEL").unwrap_or_else(|| "gemma4:12b".into())
}

/// Whether a switch is on. Absent means on: the features predate the switches,
/// and an owner who has never opened the pane should not have them turned off.
pub fn enabled(name: &str) -> bool {
    override_for(name).map(|v| v != "false").unwrap_or(true)
}

/// How one AI function has fared since the process started.
///
/// Since boot, deliberately, and the API says so. These are the operator's
/// diagnostics - "is the model answering, and how slowly" - which is a question
/// about the machine as it is running now. Persisting them would turn a live
/// reading into a lifetime average, where a box that was healthy for a month
/// hides an endpoint that has been failing all morning.
#[derive(Clone, Default)]
pub struct FnStat {
    pub calls: u64,
    pub failures: u64,
    pub total_ms: u64,
    pub last_at: i64,
    pub last_ok: Option<bool>,
}

static STATS: OnceLock<RwLock<HashMap<String, FnStat>>> = OnceLock::new();
static BOOTED: OnceLock<Instant> = OnceLock::new();

fn stats() -> &'static RwLock<HashMap<String, FnStat>> {
    STATS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Seconds the process has been up, for the report's `sinceBoot`.
pub fn since_boot_secs() -> i64 {
    BOOTED.get_or_init(Instant::now).elapsed().as_secs() as i64
}

/// Start the clock. Called at boot so `sinceBoot` measures the process and not
/// the first AI call.
pub fn mark_boot() {
    let _ = BOOTED.get_or_init(Instant::now);
}

fn record(id: &str, ok: bool, ms: u64) {
    let Ok(mut guard) = stats().write() else {
        return;
    };
    let entry = guard.entry(id.to_string()).or_default();
    entry.calls += 1;
    if !ok {
        entry.failures += 1;
    }
    entry.total_ms += ms;
    entry.last_at = crate::db::now_ms() / 1000;
    entry.last_ok = Some(ok);
}

/// Where the durable half of the statistics lives.
///
/// The counters above are per-process on purpose - a box that was healthy for a
/// month should not hide an endpoint failing this morning - but that made a
/// restart look exactly like a feature that has never worked. Everything read
/// "never run" a minute after a deploy, on a server whose models were resident
/// in memory from work it had just finished.
///
/// So the last time each function ran is kept as well. Only the timestamp:
/// merged with `max`, it needs no delta tracking and cannot double-count, and
/// "last used four minutes ago" is the whole of what the reader was asking.
const LAST_RUN_KEY: &str = "ai.lastrun";

/// When each function last ran, across restarts.
pub fn stored_last_runs(db: &crate::db::Db) -> HashMap<String, i64> {
    db.meta_get(LAST_RUN_KEY)
        .and_then(|raw| serde_json::from_str::<HashMap<String, i64>>(&raw).ok())
        .unwrap_or_default()
}

/// Fold this process's activity into the stored record. Called from a loop that
/// already runs on a timer rather than from `record`, which is on the hot path
/// of every embedding.
pub fn flush_last_runs(db: &crate::db::Db) {
    let live = stats_snapshot();
    if live.is_empty() {
        return;
    }
    let mut stored = stored_last_runs(db);
    if merge_last_runs(&mut stored, live.iter().map(|(id, s)| (id.as_str(), s.last_at))) {
        if let Ok(raw) = serde_json::to_string(&stored) {
            let _ = db.meta_set(LAST_RUN_KEY, &raw);
        }
    }
}

/// Fold live timestamps into the stored ones, newest wins. Returns whether
/// anything moved, so an idle server does not rewrite the same row every cycle.
fn merge_last_runs<'a>(
    stored: &mut HashMap<String, i64>,
    live: impl Iterator<Item = (&'a str, i64)>,
) -> bool {
    let mut changed = false;
    for (id, at) in live {
        if at > stored.get(id).copied().unwrap_or(0) {
            stored.insert(id.to_string(), at);
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod last_run_tests {
    use super::*;

    /// The merge takes the NEWEST of the two and reports whether it moved.
    ///
    /// Both halves matter. Taking the newest is what lets a per-process counter
    /// be folded into a durable record without tracking deltas or
    /// double-counting; reporting no change is what keeps an idle server from
    /// rewriting the same row every five minutes forever.
    #[test]
    fn last_runs_keep_the_newest_and_report_movement() {
        let mut stored: HashMap<String, i64> = HashMap::new();
        stored.insert("embed".into(), 500);
        stored.insert("chat".into(), 900);

        assert!(
            merge_last_runs(&mut stored, [("embed", 700), ("audit", 100)].into_iter()),
            "a newer run and an unseen function both count as movement",
        );
        assert_eq!(stored.get("embed"), Some(&700), "newer wins");
        assert_eq!(stored.get("audit"), Some(&100), "a first run is recorded");
        assert_eq!(stored.get("chat"), Some(&900), "untouched by this pass");

        // A restart: the process has no history, so every live value is 0 and
        // must not erase what is on disk.
        assert!(
            !merge_last_runs(&mut stored, [("embed", 0), ("chat", 0)].into_iter()),
            "a fresh process reports nothing newer, so nothing is written",
        );
        assert_eq!(stored.get("embed"), Some(&700), "the record survives a restart");
    }
}

/// Every function that has actually run, by id.
pub fn stats_snapshot() -> HashMap<String, FnStat> {
    stats().read().map(|g| g.clone()).unwrap_or_default()
}

#[derive(Clone)]
pub struct AiClient {
    base_url: String,
    chat_model: String,
    embed_model: String,
    http: reqwest::Client,
}

impl AiClient {
    /// The client the loops use, or None when there is nothing configured.
    ///
    /// Reads through `setting`, so the owner's choice in the app wins over the
    /// unit file and an operator who has never opened the pane is exactly where
    /// they were. Cheap enough to call per use - it is two map lookups and a
    /// client build - which is why the call sites were left alone.
    pub fn configured() -> Option<Self> {
        // The whole feature can be switched off from the pane without unsetting
        // anything: the loops all reach for a client and skip when there is
        // none, so refusing to hand one out IS the off switch.
        if !enabled("chatEnabled") {
            return None;
        }
        let base_url = setting("url", "AFM_AI_URL")?
            .trim_end_matches('/')
            .to_string();
        if base_url.is_empty() {
            return None;
        }
        let chat_model = setting("chatModel", "AFM_AI_MODEL")?;
        if chat_model.is_empty() {
            return None;
        }
        let embed_model = setting("embedModel", "AFM_AI_EMBED_MODEL")
            .unwrap_or_else(|| "nomic-embed-text".into());
        let timeout = setting("timeoutSecs", "AFM_AI_TIMEOUT_SECS")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(75)
            // Large local refinement models can legitimately need more than
            // five minutes on CPU-only hosts. Keep a hard ceiling, but honor
            // an operator's explicit timeout up to fifteen minutes.
            .clamp(10, 900);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout))
            .build()
            .ok()?;
        Some(Self {
            base_url,
            chat_model,
            embed_model,
            http,
        })
    }

    pub fn chat_model(&self) -> &str {
        &self.chat_model
    }

    pub fn with_chat_model(mut self, model: String) -> Self {
        if !model.trim().is_empty() {
            self.chat_model = model;
        }
        self
    }

    /// Request schema-constrained JSON. Ollama accepts OpenAI's
    /// `response_format`; older compatible servers may ignore it, so the
    /// response is still parsed defensively with a bounded JSON-object fallback.
    /// The measured door. Every feature already names itself through
    /// `schema_name`, which is why instrumenting here covers all of them
    /// without touching a single call site: the schema IS the function id.
    pub async fn chat_json<T: DeserializeOwned>(
        &self,
        system: &str,
        prompt: &str,
        schema_name: &str,
        schema: Value,
        reasoning: bool,
    ) -> Result<T, String> {
        let started = Instant::now();
        let out = self
            .chat_json_inner(system, prompt, schema_name, schema, reasoning)
            .await;
        record(
            schema_name,
            out.is_ok(),
            started.elapsed().as_millis() as u64,
        );
        out
    }

    async fn chat_json_inner<T: DeserializeOwned>(
        &self,
        system: &str,
        prompt: &str,
        schema_name: &str,
        schema: Value,
        reasoning: bool,
    ) -> Result<T, String> {
        // Patch responses contain three complete field sets plus provenance,
        // so the fast-profile ceiling truncates otherwise valid refinement
        // JSON on slower local models.
        // A catch-up is several paragraphs by definition, and the default
        // ceiling cuts one off mid-sentence - which reads as a broken feature
        // rather than a short answer.
        let max_tokens = if schema_name.contains("refinement_patch") || schema_name == "book_recap" {
            1200
        } else {
            500
        };
        let mut body = json!({
            "model": self.chat_model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": prompt }
            ],
            "temperature": 0.35,
            // Structured feature calls should be short. Small local models can
            // otherwise loop inside a JSON array until the HTTP timeout, which
            // is reported to the client as an unavailable AI endpoint.
            "max_tokens": max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": { "name": schema_name, "strict": true, "schema": schema }
            }
        });
        // Ollama exposes model reasoning through the OpenAI-compatible request.
        // Explicitly disable it for structured feature extraction: Qwen 3.5
        // otherwise may spend the entire token budget in message.reasoning and
        // return empty content. Deliberate analysis calls retain a low budget.
        body["reasoning_effort"] = json!(if reasoning { "low" } else { "none" });
        let endpoint = format!("{}/v1/chat/completions", self.base_url);
        let mut response = self
            .http
            .post(&endpoint)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("local AI is unavailable: {e}"))?;
        // Models such as Qwen 2.5 reject Ollama's thinking flag even though
        // they support json_schema. Remove only that flag first, preserving
        // the schema. If the server still refuses the request, then fall back
        // to generic JSON mode for older OpenAI-compatible implementations.
        if !response.status().is_success() {
            if let Some(object) = body.as_object_mut() {
                object.remove("reasoning_effort");
            }
            response = self
                .http
                .post(&endpoint)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("local AI is unavailable: {e}"))?;
        }
        if !response.status().is_success() {
            body["response_format"] = json!({ "type": "json_object" });
            response = self
                .http
                .post(&endpoint)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("local AI is unavailable: {e}"))?;
        }
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(format!(
                "local AI rejected the request ({status}): {detail}"
            ));
        }
        let reply: Value = response
            .json()
            .await
            .map_err(|e| format!("local AI returned an unreadable response: {e}"))?;
        let content = reply
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| "local AI returned no structured content".to_string())?;
        capture_response(&self.chat_model, schema_name, content);
        parse_json(content).and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
    }

    pub async fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        // The one function with no schema to name it, so it names itself. An
        // owner who has switched embeddings off still gets a clean refusal
        // rather than a timeout against an endpoint nobody meant to call.
        if !enabled("embeddingsEnabled") {
            return Err("embeddings are switched off for this server".into());
        }
        let started = Instant::now();
        let out = self.embed_inner(text).await;
        record("embed", out.is_ok(), started.elapsed().as_millis() as u64);
        out
    }

    async fn embed_inner(&self, text: &str) -> Result<Vec<f32>, String> {
        let reply: Value = self
            .http
            .post(format!("{}/v1/embeddings", self.base_url))
            .json(&json!({ "model": self.embed_model, "input": text }))
            .send()
            .await
            .map_err(|e| format!("local embeddings are unavailable: {e}"))?
            .error_for_status()
            .map_err(|e| format!("embedding request failed: {e}"))?
            .json()
            .await
            .map_err(|e| format!("embedding response was unreadable: {e}"))?;
        let arr = reply
            .pointer("/data/0/embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| "embedding response contained no vector".to_string())?;
        let vector: Vec<f32> = arr
            .iter()
            .filter_map(Value::as_f64)
            .map(|n| n as f32)
            .collect();
        if vector.len() < 32 {
            Err("embedding vector was too small".into())
        } else {
            Ok(vector)
        }
    }
}

/// Optional JSONL capture for bounded model evaluations. Disabled unless the
/// operator supplies an explicit path, so ordinary servers do not retain raw
/// model output.
fn capture_response(model: &str, schema_name: &str, content: &str) {
    let Ok(path) = std::env::var("AFM_AI_CAPTURE_PATH") else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }
    let record = json!({
        "captured_at_ms": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        "model": model,
        "schema": schema_name,
        "content": content,
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{record}");
    }
}

fn parse_json(content: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str(content.trim()) {
        return Ok(value);
    }
    let start = content
        .find('{')
        .ok_or_else(|| "structured response contained no JSON".to_string())?;
    let end = content
        .rfind('}')
        .ok_or_else(|| "structured response contained incomplete JSON".to_string())?;
    if end <= start {
        return Err("structured response contained incomplete JSON".into());
    }
    serde_json::from_str(&content[start..=end])
        .map_err(|e| format!("invalid structured response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_fenced_object() {
        assert_eq!(parse_json(r#"{"ok":true}"#).unwrap()["ok"], true);
        assert_eq!(
            parse_json("```json\n{\"ok\":true}\n```").unwrap()["ok"],
            true
        );
    }
}
