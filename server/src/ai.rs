//! Small OpenAI-compatible client shared by the server's AI features.
//!
//! Chat and embeddings deliberately remain separate models. The configured
//! endpoint is expected to be local (Ollama by default), but the protocol is
//! the ordinary OpenAI-compatible one so operators retain model choice.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::io::Write;
use std::time::Duration;

#[derive(Clone)]
pub struct AiClient {
    base_url: String,
    chat_model: String,
    embed_model: String,
    http: reqwest::Client,
}

impl AiClient {
    pub fn configured() -> Option<Self> {
        let base_url = std::env::var("AFM_AI_URL")
            .ok()?
            .trim()
            .trim_end_matches('/')
            .to_string();
        if base_url.is_empty() {
            return None;
        }
        let chat_model = std::env::var("AFM_AI_MODEL").ok()?.trim().to_string();
        if chat_model.is_empty() {
            return None;
        }
        let embed_model = std::env::var("AFM_AI_EMBED_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "nomic-embed-text".into());
        let timeout = std::env::var("AFM_AI_TIMEOUT_SECS")
            .ok()
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
    pub async fn chat_json<T: DeserializeOwned>(
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
        let max_tokens = if schema_name.contains("refinement_patch") {
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
