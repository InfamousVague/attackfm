//! The owner's view of the server's Local AI, and the activity feed beside it.
//!
//! Admin only, both halves and on purpose. The endpoint URL and the model names
//! are the operator's business rather than a listener's, and the report is about
//! the operator's hardware - how slow the box is, what has been failing. Every
//! route here goes through `require_admin`, and hiding the row in the app is a
//! courtesy on top of that, never the gate itself.
//!
//! Settings resolve owner-choice-then-environment through `ai::setting`, and a
//! write persists to `server_prefs` AND updates the live overlay, so a save
//! takes effect on the next loop tick rather than at the next restart. Sending
//! `null` for a field clears the override and hands the decision back to the
//! environment - which is why the response reports `overrides` and
//! `envDefaults` separately: the owner should be able to see what they have
//! taken over and what they would fall back to.

use crate::auth::require_admin;
use crate::db::{ActivityRow, NewActivity};
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

type Reply = Result<Json<Value>, StatusCode>;

/// Every AI function the server has, in the order an owner would read them:
/// what runs most often first, the deliberate slow ones after.
///
/// The ids are the `schema_name` each feature already passes to `chat_json`,
/// which is what lets the stats be collected without any call site knowing it
/// is being measured. A function that has never run still appears here, with
/// zero calls - "nothing has used the refinement pass yet" is an answer, and an
/// empty list would look like a broken report.
/// How many activity rows a page carries.
///
/// Small on purpose: this sits inside a settings pane on a phone, under five
/// other sections, and a long feed there is not a feature - it is the reason
/// nobody scrolls to the bottom of the page. Older rows are one tap away.
const AI_PAGE: i64 = 8;

/*
 * These ids MUST be the exact `schema_name` each feature passes to `chat_json`,
 * because that string is the statistics key. Three of them had drifted with the
 * prompts they name - a v1 that became v3, a rename, a dropped suffix - and the
 * only symptom was three rows reading "never run" forever while the work they
 * describe was happening every few minutes. Nothing failed and nothing warned.
 *
 * `unattributed` below is the guard: anything recorded under an id that is not
 * in this table is reported rather than dropped, so the next drift shows up as
 * a row nobody named instead of as silence.
 */
const FUNCTIONS: &[(&str, &str, &str, &str)] = &[
    // id, label, uses, which model setting drives it
    ("embed", "Lyric and descriptor embeddings", "embed", "embedModel"),
    ("attackfm_fast_profile_v4", "Fast song profile", "chat", "fastModel"),
    ("attackfm_fast_profile_repair_v1", "Profile repair", "chat", "fastModel"),
    ("attackfm_refinement_patch_v3", "Evidence audit", "chat", "refinementModel"),
    ("attackfm_specific_tag_registry_v1", "Specific tag decisions", "chat", "fastModel"),
    ("attackfm_trait_analysis", "DJ trait analysis", "chat", "chatModel"),
    ("attackfm_mood_names_v1", "Mood naming", "chat", "chatModel"),
];

fn model_for(which: &str) -> Option<String> {
    match which {
        "embedModel" => Some(
            crate::ai::setting("embedModel", "AFM_AI_EMBED_MODEL")
                .unwrap_or_else(|| "nomic-embed-text".into()),
        ),
        "fastModel" => Some(crate::ai::fast_model()),
        "refinementModel" => Some(crate::ai::refinement_model()),
        _ => crate::ai::setting("chatModel", "AFM_AI_MODEL"),
    }
}

/// The effective settings, plus what the owner has taken over and what the
/// environment would say if they gave it back.
fn settings_json() -> Value {
    // (wire name, env name, default when neither answers)
    let strings: &[(&str, &str, Option<&str>)] = &[
        ("url", "AFM_AI_URL", None),
        ("chatModel", "AFM_AI_MODEL", None),
        ("embedModel", "AFM_AI_EMBED_MODEL", Some("nomic-embed-text")),
        ("fastModel", "AFM_FAST_ENRICH_MODEL", Some("qwen3.5:9b")),
        ("refinementModel", "AFM_REFINEMENT_MODEL", Some("gemma4:12b")),
        ("djModel", "AFM_DJ_MODEL", None),
        // The DJ's mouth. Default matches voice.rs's own (George); the pane
        // offers the popular five, verified against the account's list.
        ("djVoiceId", "AFM_DJ_VOICE_ID", Some("JBFqnCBsd6RMkjVDRZzb")),
    ];
    let mut out = serde_json::Map::new();
    /*
     * The Spotify cookie is reported as a BOOLEAN and never as itself.
     *
     * It is a live session credential for the owner's Spotify account - anyone
     * holding it can act as them - so the pane is told whether one is set and
     * nothing more. There is no read path for the value anywhere in this
     * server: it goes in through save_settings and comes out only as a request
     * header inside the fetcher.
     */
    out.insert(
        "spotifyCookieSet".into(),
        json!(crate::ai::setting("spotifyCookie", "AFM_SPOTIFY_SP_DC").is_some()),
    );
    out.insert(
        "canvasStock".into(),
        json!(crate::ai::setting("canvasStock", "AFM_CANVAS_STOCK")
            .is_some_and(|v| v != "false" && v != "0")),
    );
    let mut overrides = serde_json::Map::new();
    let mut env_defaults = serde_json::Map::new();
    for (name, env, fallback) in strings {
        let effective = crate::ai::setting(name, env).or_else(|| fallback.map(str::to_string));
        out.insert((*name).into(), json!(effective));
        if crate::ai::override_for(name).is_some() {
            overrides.insert((*name).into(), json!(true));
        }
        let from_env = std::env::var(env)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| fallback.map(str::to_string));
        env_defaults.insert((*name).into(), json!(from_env));
    }

    let timeout = crate::ai::setting("timeoutSecs", "AFM_AI_TIMEOUT_SECS")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(75)
        .clamp(10, 900);
    out.insert("timeoutSecs".into(), json!(timeout));
    if crate::ai::override_for("timeoutSecs").is_some() {
        overrides.insert("timeoutSecs".into(), json!(true));
    }
    env_defaults.insert(
        "timeoutSecs".into(),
        json!(std::env::var("AFM_AI_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(75)),
    );

    for switch in ["chatEnabled", "embeddingsEnabled"] {
        out.insert(switch.into(), json!(crate::ai::enabled(switch)));
        if crate::ai::override_for(switch).is_some() {
            overrides.insert(switch.into(), json!(true));
        }
        env_defaults.insert(switch.into(), json!(true));
    }

    out.insert("overrides".into(), Value::Object(overrides));
    out.insert("envDefaults".into(), Value::Object(env_defaults));
    Value::Object(out)
}

/// Ask the endpoint whether it is there, and what it can do.
///
/// `GET /v1/models` rather than a chat call: it is the one request every
/// OpenAI-compatible server answers cheaply, it needs no model to be loaded,
/// and it comes back with the list - which is the answer to the question an
/// owner actually has, which is "is the model I named one this box HAS".
async fn probe_endpoint() -> Value {
    let now = crate::db::now_ms() / 1000;
    let Some(base) = crate::ai::setting("url", "AFM_AI_URL") else {
        return json!({
            "checkedAt": now, "reachable": null, "latencyMs": null,
            "models": [], "error": "No endpoint is configured."
        });
    };
    let base = base.trim_end_matches('/').to_string();
    // A short deadline of its own: this one runs while somebody is looking at
    // a spinner, and the loops' generous timeout is for generating text, not
    // for finding out whether anything is listening.
    let Ok(http) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    else {
        return json!({ "checkedAt": now, "reachable": false, "latencyMs": null, "models": [], "error": "could not build a client" });
    };
    let started = Instant::now();
    match http.get(format!("{base}/v1/models")).send().await {
        Ok(response) if response.status().is_success() => {
            let ms = started.elapsed().as_millis() as i64;
            let body: Value = response.json().await.unwrap_or(json!({}));
            let models: Vec<String> = body
                .get("data")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| r.get("id").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            json!({ "checkedAt": now, "reachable": true, "latencyMs": ms, "models": models, "error": null })
        }
        Ok(response) => json!({
            "checkedAt": now, "reachable": false, "latencyMs": null, "models": [],
            "error": format!("the endpoint answered {}", response.status())
        }),
        Err(e) => json!({
            "checkedAt": now, "reachable": false, "latencyMs": null, "models": [],
            "error": format!("{e}")
        }),
    }
}

fn activity_json(rows: Vec<ActivityRow>) -> Vec<Value> {
    rows.into_iter()
        .map(|r| {
            json!({
                "id": r.id, "at": r.at, "source": r.source, "kind": r.kind,
                "state": r.state, "key": r.key, "title": r.title, "body": r.body,
                "trackId": r.track_id,
                "detail": r.detail.and_then(|d| serde_json::from_str::<Value>(&d).ok()),
            })
        })
        .collect()
}

/// The models this endpoint HAS, for the pickers - on a short leash.
///
/// The full probe is deliberately not run on the way in, because it reports
/// latency and reachability and a cold or absent Ollama makes that slow. This
/// is the cheap half of the same call and the pane needs it up front: without
/// the list there is nothing to choose FROM, and naming a model becomes typing
/// a string and hoping. Two seconds, and an empty list on anything else - the
/// pickers fall back to a plain text box, which is exactly what they were.
async fn installed_models() -> Vec<String> {
    let Some(base) = crate::ai::setting("url", "AFM_AI_URL") else {
        return Vec::new();
    };
    let base = base.trim_end_matches('/').to_string();
    let Ok(http) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return Vec::new();
    };
    let Ok(response) = http.get(format!("{base}/v1/models")).send().await else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(body) = response.json::<Value>().await else {
        return Vec::new();
    };
    body.get("data")
        .and_then(Value::as_array)
        .map(|rows| {
            let mut names: Vec<String> = rows
                .iter()
                .filter_map(|r| r.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
            names.sort();
            names
        })
        .unwrap_or_default()
}

/// `GET /api/ai` - everything the pane draws, in one request.
///
/// One request rather than four because every part of it is cheap and the pane
/// shows them together: four round trips would only buy four separate ways for
/// the screen to be half-drawn. The probe is the exception and is NOT run here
/// - it can take seconds against a cold Ollama, and a settings pane that takes
/// eight seconds to appear is worse than one with a "check now" button.
pub async fn report(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Reply {
    let caller = require_admin(&state.db, &headers)?;
    let stats = crate::ai::stats_snapshot();
    // Survives a restart, so "never run" means never rather than "not in the
    // ninety seconds since the last deploy".
    let ever = crate::ai::stored_last_runs(&state.db);
    let mut total_calls = 0u64;
    let mut total_failures = 0u64;
    let mut total_ms = 0u64;
    let functions: Vec<Value> = FUNCTIONS
        .iter()
        .map(|(id, label, uses, which)| {
            let stat = stats.get(*id).cloned().unwrap_or_default();
            total_calls += stat.calls;
            total_failures += stat.failures;
            total_ms += stat.total_ms;
            json!({
                "id": id,
                "label": label,
                "uses": uses,
                "model": model_for(which),
                "calls": stat.calls,
                "failures": stat.failures,
                "avgMs": (stat.calls > 0).then(|| (stat.total_ms / stat.calls) as i64),
                "lastAt": (stat.last_at > 0).then_some(stat.last_at),
                // The last time this ran AT ALL, restarts included. The pane
                // reads it only when there is nothing since boot to show.
                "everAt": ever.get(*id).copied().filter(|v| *v > 0),
                "lastOk": stat.last_ok,
            })
        })
        .collect();

    let curator = {
        let s = state.curator.status.lock().await;
        json!({
            "phase": s.phase, "lastCurated": s.last_curated,
            "ai": s.ai, "chat": s.chat, "embeddings": s.embeddings
        })
    };

    // Recorded work that no row above claims - see the note on FUNCTIONS.
    let named: std::collections::HashSet<&str> = FUNCTIONS.iter().map(|f| f.0).collect();
    let unattributed: Vec<serde_json::Value> = stats
        .iter()
        .filter(|(id, _)| !named.contains(id.as_str()))
        .map(|(id, stat)| json!({ "id": id, "calls": stat.calls, "lastAt": stat.last_at }))
        .collect();

    Ok(Json(json!({
        "settings": settings_json(),
        // What is on the box, so a model can be CHOSEN rather than spelled.
        "installed": installed_models().await,
        // Never probed on the way in - see the note above. The pane shows this
        // as "not checked yet" until somebody presses the button.
        "health": { "checkedAt": null, "reachable": null, "latencyMs": null, "models": [], "error": null },
        "functions": functions,
        "totals": {
            "calls": total_calls,
            "failures": total_failures,
            "avgMs": (total_calls > 0).then(|| (total_ms / total_calls) as i64),
            "sinceBoot": crate::ai::since_boot_secs(),
            "unattributed": unattributed,
        },
        // What is being done right now, if anything - the thing the pane polls
        // so a pass that takes minutes is something to watch rather than a
        // button that went quiet.
        "running": crate::ai::current_task(),
        // The mood profile for the pane's Taste page, centroids stripped -
        // they are a few KB of floats per cluster that only the scorer reads.
        "mood": crate::mood::load(&state, caller.id).map(|p| json!({
            "builtAt": p.built_at,
            "evidence": p.evidence,
            "clusters": p.clusters.iter().map(|c| json!({
                "name": c.name, "blurb": c.blurb, "share": c.share,
                "bpm": c.bpm, "energy": c.energy, "tags": c.tags,
                "exemplars": state.db.titles_for(&c.exemplar_ids).into_iter()
                    .map(|(a, t)| format!("{t} — {a}")).collect::<Vec<_>>(),
                "hours": c.hours,
            })).collect::<Vec<_>>(),
        })),
        "curator": curator,
        // The FIRST page, at the same size every later page uses - the pane
        // pages from here rather than fetching its own page one, so opening
        // the pane is still one request.
        "recent": activity_json(state.db.activity_from("ai", 0, AI_PAGE)),
        // Whether there is anything older, asked the cheap way: request one
        // more than a page and see if it comes back. A count(*) over a table
        // that only grows would cost more every week to answer the same yes.
        "recentHasMore": state.db.activity_from("ai", 0, AI_PAGE + 1).len() as i64 > AI_PAGE,
    })))
}

/// `null` means CLEAR, absent means LEAVE ALONE - and serde cannot tell them
/// apart on its own.
///
/// `Option<Option<T>>` with only `#[serde(default)]` collapses both cases to
/// the outer `None`: a JSON null is deserialized as the missing-field default,
/// so "hand this value back to the environment" silently did nothing while
/// reporting success. This forces the field to be deserialized when it is
/// present at all, so an explicit null arrives as `Some(None)`.
fn explicit<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    // Two levels of Option, and both matter: the outer is "the client did not
    // mention this field", the inner is "the client asked to CLEAR it". Without
    // the distinction, a patch touching one field would clear every other.
    #[serde(default, deserialize_with = "explicit")]
    url: Option<Option<String>>,
    #[serde(default, deserialize_with = "explicit")]
    chat_model: Option<Option<String>>,
    #[serde(default, deserialize_with = "explicit")]
    embed_model: Option<Option<String>>,
    #[serde(default, deserialize_with = "explicit")]
    fast_model: Option<Option<String>>,
    #[serde(default, deserialize_with = "explicit")]
    refinement_model: Option<Option<String>>,
    #[serde(default, deserialize_with = "explicit")]
    dj_model: Option<Option<String>>,
    #[serde(default, deserialize_with = "explicit")]
    dj_voice_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "explicit")]
    timeout_secs: Option<Option<i64>>,
    #[serde(default, deserialize_with = "explicit")]
    chat_enabled: Option<Option<bool>>,
    #[serde(default, deserialize_with = "explicit")]
    embeddings_enabled: Option<Option<bool>>,
    /*
     * Not AI, but the same problem and so the same door.
     *
     * The Spotify session cookie used to be read straight off the environment,
     * which meant it lived in whatever launched the process and was lost the
     * moment the box was rebuilt - silently, because a missing cookie looks
     * exactly like a library of songs that have no Canvas. Kept here it is in
     * the database, which is the thing that survives a reinstall.
     */
    #[serde(default, deserialize_with = "explicit")]
    spotify_cookie: Option<Option<String>>,
    /// Whether a song with no Canvas gets one of the shipped stand-in loops.
    /// Off unless asked for: the card's own cover is the better face.
    #[serde(default, deserialize_with = "explicit")]
    canvas_stock: Option<Option<bool>>,
}

/// `POST /api/ai/settings` - take a value over, or hand it back to the unit file.
pub async fn save_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(patch): Json<SettingsPatch>,
) -> Reply {
    require_admin(&state.db, &headers)?;

    let mut apply = |name: &str, value: Option<String>| {
        let key = format!("{}{}", crate::ai::PREF_PREFIX, name);
        match value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            Some(v) => {
                let _ = state.db.set_server_pref(&key, v);
                crate::ai::set_override(name, Some(v));
            }
            None => {
                let _ = state.db.clear_server_pref(&key);
                crate::ai::set_override(name, None);
            }
        }
    };

    if let Some(v) = patch.url {
        // Stored without a trailing slash so the value the owner sees is the
        // value the loops use; every caller appends /v1/... to it.
        apply("url", v.map(|s| s.trim().trim_end_matches('/').to_string()));
    }
    if let Some(v) = patch.chat_model {
        apply("chatModel", v);
    }
    if let Some(v) = patch.embed_model {
        apply("embedModel", v);
    }
    if let Some(v) = patch.fast_model {
        apply("fastModel", v);
    }
    if let Some(v) = patch.refinement_model {
        apply("refinementModel", v);
    }
    if let Some(v) = patch.dj_model {
        apply("djModel", v);
    }
    if let Some(v) = patch.dj_voice_id {
        apply("djVoiceId", v);
    }
    if let Some(v) = patch.timeout_secs {
        apply("timeoutSecs", v.map(|n| n.clamp(10, 900).to_string()));
    }
    if let Some(v) = patch.chat_enabled {
        apply("chatEnabled", v.map(|b| b.to_string()));
    }
    if let Some(v) = patch.spotify_cookie {
        apply("spotifyCookie", v);
    }
    if let Some(v) = patch.canvas_stock {
        apply("canvasStock", v.map(|b| b.to_string()));
    }
    if let Some(v) = patch.embeddings_enabled {
        apply("embeddingsEnabled", v.map(|b| b.to_string()));
    }

    Ok(Json(settings_json()))
}

/// `POST /api/ai/probe` - ask the endpoint now, while somebody is watching.
pub async fn probe(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Reply {
    require_admin(&state.db, &headers)?;
    let health = probe_endpoint().await;
    let ok = health.get("reachable").and_then(Value::as_bool) == Some(true);
    state.db.record_activity(NewActivity {
        source: "ai",
        kind: "probe",
        state: if ok { "done" } else { "failed" },
        key: "ai:probe",
        title: if ok { "Model endpoint answered" } else { "Model endpoint did not answer" },
        body: &health
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let ms = health.get("latencyMs").and_then(Value::as_i64).unwrap_or(0);
                let n = health.get("models").and_then(Value::as_array).map_or(0, Vec::len);
                format!("{n} models, {ms}ms")
            }),
        track_id: None,
        detail: None,
    });
    Ok(Json(health))
}

#[derive(Deserialize)]
pub struct RunWhat {
    what: String,
}

/// `POST /api/ai/run` - do now what a loop would get to eventually.
///
/// The loops are deliberately patient: they stand down while anyone is playing
/// and they take one song at a time. That is right for a shared box and
/// maddening when you are sitting in front of it wanting to know whether the
/// model you just configured works at all. This is the "go on then" button.
/// What each button does, and what it says while doing it.
///
/// One table rather than five match arms of near-identical spawn code: they all
/// claim the box, narrate, run, record and release in exactly the same order,
/// and the only things that differ are the words and the closure in the middle.
struct Task {
    what: &'static str,
    label: &'static str,
    /// What the reader is told the moment it starts.
    opening: &'static str,
}

const TASKS: &[Task] = &[
    Task { what: "discover", label: "Finding new music", opening: "asking about artists like the ones you play" },
    Task { what: "mix", label: "Building your mixes", opening: "reading what you have been playing" },
    Task { what: "dates", label: "Topping up Music Date", opening: "looking for something you do not own" },
    Task { what: "curate", label: "Full curation pass", opening: "reading the library" },
];

pub async fn run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RunWhat>,
) -> Reply {
    let caller = require_admin(&state.db, &headers)?;
    let Some(task) = TASKS.iter().find(|t| t.what == body.what) else {
        return Err(StatusCode::BAD_REQUEST);
    };

    /*
     * One at a time, and the refusal is an answer rather than an error.
     *
     * These passes share a model, a rate-limited catalogue and a download slot,
     * so two at once finish later than either alone would. CONFLICT rather than
     * a spawn-anyway, so the pane can say which job is in the way instead of
     * appearing to start a second one that then does nothing.
     */
    let Some(hold) = crate::ai::claim_task(task.what, task.label, task.opening) else {
        return Err(StatusCode::CONFLICT);
    };

    let st = state.clone();
    let user = caller.id;
    let what = task.what;
    let label = task.label;
    // Spawned, not awaited: these run for minutes and the caller is a settings
    // pane, not a job runner. Progress is the running task plus the feed.
    tokio::spawn(async move {
        // Moved in so the box is freed when this future ends, however it ends.
        let _hold = hold;
        let key = format!("ai:{what}:{}", crate::db::now_ms());
        st.db.record_activity(NewActivity {
            source: "ai",
            kind: what,
            state: "started",
            key: &key,
            title: label,
            body: "Asked for from Settings",
            track_id: None,
            detail: None,
        });

        let outcome = match what {
            "discover" => {
                let before = st.db.discovery_counts(user).0;
                let since = crate::db::now_ms() - 30 * 24 * 60 * 60 * 1000;
                let seeds = st.db.top_artists(user, since, 8);
                if seeds.is_empty() {
                    "Nothing to go on yet - play a few things first.".to_string()
                } else {
                    crate::discovery::harvest_seeded(&st, user, seeds).await;
                    crate::ai::task_step("listening to what came back");
                    crate::discovery::listen_cycle(&st, user).await;
                    let after = st.db.discovery_counts(user).0;
                    match after - before {
                        0 => format!("Nothing new this time - {after} still waiting to be judged."),
                        n => format!("{n} more to consider, {after} in the pool."),
                    }
                }
            }
            "mix" => {
                /*
                 * "Make me a new mix" now means the whole programme: read the
                 * mood off recent listening, rebuild the blended stations on
                 * it, then the daily mixes. Mood first because the stations
                 * are shaped by it - rebuilding them against yesterday's
                 * profile and then refreshing the profile would be the work
                 * in the wrong order.
                 */
                crate::ai::task_step("reading the mood of your last three weeks");
                let profile = crate::mood::rebuild(&st, user).await;
                let stations = match &profile {
                    Some(prof) => {
                        crate::ai::task_step("building a station for each mood");
                        let n = crate::programmer::rebuild_now(&st, user, prof);
                        crate::stations::invalidate(&st, user).await;
                        n
                    }
                    None => 0,
                };
                crate::ai::task_step("rebuilding the daily mixes");
                let mixes = crate::home::rebuild_mixes(&st, user).await;
                match (profile, stations, mixes) {
                    (None, _, 0) => {
                        "Not enough recent listening to work from yet - play a few things first."
                            .to_string()
                    }
                    (None, _, m) => format!("{m} mixes rebuilt. Not enough listening yet to read a mood."),
                    (Some(prof), st_n, m) => format!(
                        "Read {} moods off your last three weeks, built {st_n} station{} on them, and rebuilt {m} mixes.",
                        prof.clusters.len(),
                        if st_n == 1 { "" } else { "s" },
                    ),
                }
            }
            "dates" => {
                crate::ai::task_step("looking for something you do not own");
                let pool = crate::collector::top_up(&st, user).await;
                format!(
                    "{pool} candidates in the pool. Anything bought has to download \
                     before it becomes a card, so give it a few minutes."
                )
            }
            _ => {
                crate::ai::task_step("reading the library");
                if crate::curator::run_once(st.clone()).await {
                    "Work was done".to_string()
                } else {
                    "Nothing needed doing".to_string()
                }
            }
        };

        st.db.record_activity(NewActivity {
            source: "ai",
            kind: what,
            state: "done",
            key: &key,
            title: label,
            body: &outcome,
            track_id: None,
            detail: None,
        });
    });

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Since {
    #[serde(default)]
    since: i64,
    #[serde(default = "default_limit")]
    limit: i64,
}

fn default_limit() -> i64 {
    50
}

/// `GET /api/activity` - what the machinery has been doing, after `since`.
///
/// Any signed-in caller, not just the owner: the verbose-notifications switch
/// is per device and the events are about the library everyone shares. Nothing
/// here names a person.
pub async fn activity(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Since>,
) -> Reply {
    crate::auth::require_caller(&state.db, &headers)?;
    let (rows, latest) = state.db.activity_since(q.since, q.limit);
    Ok(Json(json!({ "events": activity_json(rows), "latestId": latest })))
}

#[derive(Deserialize)]
pub struct Before {
    #[serde(default)]
    before: i64,
}

/// `GET /api/ai/activity?before=<id>` - one page older than `before`.
///
/// Separate from `/api/activity` deliberately. That one is the verbose
/// watcher's: everything AFTER an id, oldest first, so a device can catch up on
/// what it missed. This one is a reader's: one page BEFORE an id, newest first,
/// for somebody scrolling back through what the model has been doing. Same
/// table, opposite directions, and folding them into one endpoint with a mode
/// flag would make both harder to read than either is now.
pub async fn activity_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Before>,
) -> Reply {
    require_admin(&state.db, &headers)?;
    // One more than a page, so "is there an older page" needs no second query
    // and no count. The extra row is dropped before answering.
    let mut rows = state.db.activity_from("ai", q.before, AI_PAGE + 1);
    let has_more = rows.len() as i64 > AI_PAGE;
    rows.truncate(AI_PAGE as usize);
    Ok(Json(json!({ "events": activity_json(rows), "hasMore": has_more })))
}
