//! The other direction of the Subsonic door: this hub as a CLIENT of
//! another OpenSubsonic server (Navidrome, Gonic, Airsonic, another AttackFM
//! with its door open) - to bring a library's playlists, stars and albums
//! here, and to push a playlist from here to there.
//!
//! Per member: the remote is theirs (their account there), and what they
//! import lands as theirs here - the same rule every importer keeps. The
//! songs come down through the remote's own `download` verb, so what lands
//! is the original file with its own tags, and the house filing
//! (upload::destination_for) puts it where a tagged file goes. A song the
//! library already holds is not fetched twice: the importer's identity match
//! (title / artist / album, then title / artist within a few seconds of
//! length) links the local copy instead.
//!
//! Jobs run in the background and are polled, like every import here.
use crate::subsonic_wire as wire;
use crate::{auth, scan, upload, AppState};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

type ApiResult = Result<Json<Value>, (StatusCode, String)>;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// --- the remote ------------------------------------------------------------------------------

#[derive(Clone)]
pub struct Remote {
    base: String,
    user: String,
    pass: String,
    client: reqwest::Client,
}

#[derive(Clone, Debug)]
pub struct RemoteSong {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: i64,
    pub suffix: String,
}

impl Remote {
    pub fn new(base: &str, user: &str, pass: &str) -> Result<Remote, String> {
        let base = base.trim().trim_end_matches('/').to_string();
        if !(base.starts_with("http://") || base.starts_with("https://")) {
            return Err("The server address must start with http:// or https://".into());
        }
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("AttackFM")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Remote { base, user: user.trim().to_string(), pass: pass.to_string(), client })
    }

    fn auth_query(&self) -> Vec<(String, String)> {
        use rand::Rng;
        let salt: String = (0..10).map(|_| rand::thread_rng().sample(rand::distributions::Alphanumeric) as char).collect();
        vec![
            ("u".into(), self.user.clone()),
            ("t".into(), wire::token_for(&self.pass, &salt)),
            ("s".into(), salt),
            ("v".into(), "1.16.1".into()),
            ("c".into(), "attackfm".into()),
            ("f".into(), "json".into()),
        ]
    }

    /// One verb, answered - the envelope opened and a `failed` turned into
    /// the error it names.
    async fn call(&self, method: &str, params: &[(&str, String)]) -> Result<Value, String> {
        let mut query = self.auth_query();
        for (k, v) in params {
            query.push((k.to_string(), v.clone()));
        }
        let res = self
            .client
            .get(format!("{}/rest/{method}", self.base))
            .query(&query)
            .send()
            .await
            .map_err(|e| format!("{method}: {e}"))?;
        let status = res.status();
        let body: Value = res.json().await.map_err(|_| format!("{method}: the server answered {status} with something that is not Subsonic JSON"))?;
        let env = body.get("subsonic-response").cloned().ok_or_else(|| format!("{method}: not a Subsonic server (no subsonic-response)"))?;
        if env.get("status").and_then(|s| s.as_str()) != Some("ok") {
            let msg = env.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("the server said no");
            return Err(format!("{method}: {msg}"));
        }
        Ok(env)
    }

    pub async fn ping(&self) -> Result<(String, String), String> {
        let env = self.call("ping", &[]).await?;
        Ok((
            env.get("type").and_then(|v| v.as_str()).unwrap_or("subsonic").to_string(),
            env.get("serverVersion").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ))
    }

    fn song_of(v: &Value) -> Option<RemoteSong> {
        let id = v.get("id")?;
        let id = id.as_str().map(|s| s.to_string()).or_else(|| id.as_i64().map(|n| n.to_string()))?;
        Some(RemoteSong {
            id,
            title: v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            artist: v.get("artist").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            album: v.get("album").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            duration_ms: v.get("duration").and_then(|x| x.as_i64()).unwrap_or(0) * 1000,
            suffix: v.get("suffix").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        })
    }

    fn songs_in(v: Option<&Value>) -> Vec<RemoteSong> {
        v.and_then(|a| a.as_array()).map(|arr| arr.iter().filter_map(Self::song_of).collect()).unwrap_or_default()
    }

    /// (id, name, owner, song count)
    pub async fn playlists(&self) -> Result<Vec<(String, String, String, i64)>, String> {
        let env = self.call("getPlaylists", &[]).await?;
        Ok(env
            .pointer("/playlists/playlist")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| {
                        let id = p.get("id")?;
                        let id = id.as_str().map(|s| s.to_string()).or_else(|| id.as_i64().map(|n| n.to_string()))?;
                        Some((
                            id,
                            p.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            p.get("owner").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            p.get("songCount").and_then(|x| x.as_i64()).unwrap_or(0),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn playlist(&self, id: &str) -> Result<(String, Vec<RemoteSong>), String> {
        let env = self.call("getPlaylist", &[("id", id.to_string())]).await?;
        let name = env.pointer("/playlist/name").and_then(|x| x.as_str()).unwrap_or("Imported").to_string();
        Ok((name, Self::songs_in(env.pointer("/playlist/entry"))))
    }

    pub async fn starred(&self) -> Result<Vec<RemoteSong>, String> {
        let env = self.call("getStarred2", &[]).await?;
        Ok(Self::songs_in(env.pointer("/starred2/song")))
    }

    /// (id, name, artist, year, song count)
    pub async fn albums(&self, kind: &str, size: i64, offset: i64) -> Result<Vec<(String, String, String, Option<i64>, i64)>, String> {
        let env = self
            .call("getAlbumList2", &[("type", kind.to_string()), ("size", size.to_string()), ("offset", offset.to_string())])
            .await?;
        Ok(env
            .pointer("/albumList2/album")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| {
                        let id = p.get("id")?;
                        let id = id.as_str().map(|s| s.to_string()).or_else(|| id.as_i64().map(|n| n.to_string()))?;
                        Some((
                            id,
                            p.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            p.get("artist").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            p.get("year").and_then(|x| x.as_i64()),
                            p.get("songCount").and_then(|x| x.as_i64()).unwrap_or(0),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn album(&self, id: &str) -> Result<(String, Vec<RemoteSong>), String> {
        let env = self.call("getAlbum", &[("id", id.to_string())]).await?;
        let name = env.pointer("/album/name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        Ok((name, Self::songs_in(env.pointer("/album/song"))))
    }

    pub async fn search_songs(&self, query: &str, count: i64) -> Result<Vec<RemoteSong>, String> {
        let env = self
            .call("search3", &[("query", query.to_string()), ("songCount", count.to_string()), ("artistCount", "0".into()), ("albumCount", "0".into())])
            .await?;
        Ok(Self::songs_in(env.pointer("/searchResult3/song")))
    }

    pub async fn create_playlist(&self, name: &str, ids: &[String], replace: Option<&str>) -> Result<String, String> {
        let mut params: Vec<(&str, String)> = match replace {
            Some(id) => vec![("playlistId", id.to_string()), ("name", name.to_string())],
            None => vec![("name", name.to_string())],
        };
        for id in ids {
            params.push(("songId", id.clone()));
        }
        let env = self.call("createPlaylist", &params).await?;
        Ok(env
            .pointer("/playlist/id")
            .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string())))
            .unwrap_or_default())
    }

    pub fn download_url(&self, id: &str) -> String {
        let q: Vec<String> = self
            .auth_query()
            .into_iter()
            .chain(std::iter::once(("id".to_string(), id.to_string())))
            .map(|(k, v)| format!("{k}={}", form_urlencoded::byte_serialize(v.as_bytes()).collect::<String>()))
            .collect();
        format!("{}/rest/download?{}", self.base, q.join("&"))
    }

    async fn fetch_to(&self, url: &str, dest: &std::path::Path) -> Result<i64, String> {
        use tokio::io::AsyncWriteExt;
        let resp = self.client.get(url).send().await.map_err(|e| format!("{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("answered {}", resp.status()));
        }
        let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if ct.starts_with("application/json") || ct.starts_with("text/xml") || ct.starts_with("application/xml") {
            return Err("the server answered with an error instead of the file".into());
        }
        let tmp = dest.with_extension("part");
        let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| format!("{e}"))?;
        let mut resp = resp;
        let mut written: i64 = 0;
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{e}"))? {
            file.write_all(&chunk).await.map_err(|e| format!("{e}"))?;
            written += chunk.len() as i64;
        }
        file.flush().await.map_err(|e| format!("{e}"))?;
        drop(file);
        tokio::fs::rename(&tmp, dest).await.map_err(|e| format!("{e}"))?;
        Ok(written)
    }
}

fn remote_for(state: &AppState, user_id: i64) -> Result<Remote, (StatusCode, String)> {
    let (url, user, pass, _) = state
        .db
        .subsonic_account(user_id)
        .ok_or((StatusCode::NOT_FOUND, "No other server is connected yet - add one in Settings.".into()))?;
    Remote::new(&url, &user, &pass).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

// --- matching what is already here ---------------------------------------------------------------

fn fold(s: &str) -> String {
    s.trim().to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

struct Owned {
    by_identity: HashMap<String, i64>,
    by_song: HashMap<String, Vec<(i64, Option<i64>)>>,
}

impl Owned {
    fn build(state: &AppState) -> Owned {
        let mut by_identity = HashMap::new();
        let mut by_song: HashMap<String, Vec<(i64, Option<i64>)>> = HashMap::new();
        for row in state.db.match_index() {
            by_identity.insert(format!("{}\u{1}{}\u{1}{}", fold(&row.title), fold(&row.artist), fold(&row.album)), row.id);
            by_song.entry(format!("{}\u{1}{}", fold(&row.title), fold(&row.artist))).or_default().push((row.id, row.duration_ms));
        }
        Owned { by_identity, by_song }
    }

    /// What this job just landed counts as owned from here on. Without
     /// this, a song that is both in a chosen playlist AND starred was
     /// fetched twice - the index was built once, before anything arrived.
    fn remember(&mut self, s: &RemoteSong, id: i64, duration_ms: Option<i64>) {
        self.by_identity.insert(format!("{}\u{1}{}\u{1}{}", fold(&s.title), fold(&s.artist), fold(&s.album)), id);
        self.by_song.entry(format!("{}\u{1}{}", fold(&s.title), fold(&s.artist))).or_default().push((id, duration_ms));
    }

    fn find(&self, s: &RemoteSong) -> Option<i64> {
        if let Some(id) = self.by_identity.get(&format!("{}\u{1}{}\u{1}{}", fold(&s.title), fold(&s.artist), fold(&s.album))) {
            return Some(*id);
        }
        let candidates = self.by_song.get(&format!("{}\u{1}{}", fold(&s.title), fold(&s.artist)))?;
        candidates
            .iter()
            .find(|(_, d)| s.duration_ms <= 0 || d.map_or(true, |d| (d - s.duration_ms).abs() <= 3000))
            .map(|(id, _)| *id)
    }
}

// --- jobs ------------------------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
pub struct Job {
    pub id: String,
    #[serde(skip)]
    pub user_id: i64,
    pub title: String,
    pub state: String,
    pub total: i64,
    pub done: i64,
    pub linked: i64,
    pub downloaded: i64,
    pub failed: i64,
    pub current: String,
    pub error: String,
    pub playlists: Vec<Value>,
    pub starred: i64,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    pub log: Vec<String>,
}

fn jobs() -> &'static Mutex<Vec<Job>> {
    static CELL: OnceLock<Mutex<Vec<Job>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(Vec::new()))
}

fn update(id: &str, f: impl FnOnce(&mut Job)) {
    let mut all = jobs().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(j) = all.iter_mut().find(|j| j.id == id) {
        f(j);
    }
}

fn log(id: &str, line: String) {
    update(id, |j| {
        j.log.push(line);
        if j.log.len() > 60 {
            j.log.remove(0);
        }
    });
}

#[derive(Deserialize, Default)]
pub struct ImportBody {
    #[serde(default)]
    pub playlists: Vec<String>,
    #[serde(default)]
    pub albums: Vec<String>,
    #[serde(default)]
    pub starred: bool,
}

/// Bring one song here: the local copy where one exists, else the file
/// itself through the remote's `download`. Returns the local track id.
async fn land_song(state: &Arc<AppState>, remote: &Remote, owned: &mut Owned, job_id: &str, s: &RemoteSong) -> Result<i64, String> {
    if let Some(id) = owned.find(s) {
        update(job_id, |j| j.linked += 1);
        return Ok(id);
    }
    if state.library_quota_bytes > 0 && state.db.total_bytes() >= state.library_quota_bytes {
        return Err("the library is at its size limit".into());
    }
    let staging = state.data_dir.join("subsonic").join(job_id);
    tokio::fs::create_dir_all(&staging).await.map_err(|e| e.to_string())?;
    let ext = if s.suffix.is_empty() { "mp3".to_string() } else { s.suffix.to_ascii_lowercase() };
    let safe = |x: &str| x.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' }).collect::<String>();
    let original = format!("{} - {}.{ext}", safe(&s.artist), safe(&s.title));
    let tmp = staging.join(format!("{}.{ext}", s.id.replace(['/', '\\'], "_")));
    remote.fetch_to(&remote.download_url(&s.id), &tmp).await?;
    // The house filing: under the one lock every importer takes, so two
    // jobs cannot race the same destination.
    let _filing = state.filing.lock().await;
    let rel = upload::destination_for(&state.music_root, &tmp, &original, &ext);
    let dest = state.music_root.join(&rel);
    let (rel, dest) = upload::unique_destination(&state.music_root, &rel, &dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    if !scan::scan_one(&state.db, &state.music_root, &state.art_dir, &rel) {
        let _ = std::fs::remove_file(&dest);
        return Err("the file could not be indexed".into());
    }
    let id = state.db.track_id_by_path(&rel).ok_or("indexed, but not found by path")?;
    owned.remember(s, id, state.db.track(id).and_then(|t| t.duration).map(|d| (d * 1000.0) as i64));
    update(job_id, |j| j.downloaded += 1);
    Ok(id)
}

async fn run_import(state: Arc<AppState>, job_id: String, user_id: i64, remote: Remote, body: ImportBody) {
    update(&job_id, |j| j.state = "running".into());
    // What to bring, gathered first so the job knows its size.
    let mut sets: Vec<(String, Vec<RemoteSong>, bool)> = Vec::new(); // (playlist name or "", songs, make playlist)
    let mut starred: Vec<RemoteSong> = Vec::new();
    for id in &body.playlists {
        match remote.playlist(id).await {
            Ok((name, songs)) => sets.push((name, songs, true)),
            Err(e) => log(&job_id, format!("playlist {id}: {e}")),
        }
    }
    for id in &body.albums {
        match remote.album(id).await {
            Ok((name, songs)) => sets.push((name, songs, false)),
            Err(e) => log(&job_id, format!("album {id}: {e}")),
        }
    }
    if body.starred {
        match remote.starred().await {
            Ok(songs) => starred = songs,
            Err(e) => log(&job_id, format!("starred: {e}")),
        }
    }
    let total = sets.iter().map(|(_, s, _)| s.len() as i64).sum::<i64>() + starred.len() as i64;
    update(&job_id, |j| j.total = total);
    let mut owned = Owned::build(&state);

    for (name, songs, make_playlist) in sets {
        let mut ids: Vec<i64> = Vec::new();
        for s in &songs {
            update(&job_id, |j| j.current = format!("{} - {}", s.artist, s.title));
            match land_song(&state, &remote, &mut owned, &job_id, s).await {
                Ok(id) => ids.push(id),
                Err(e) => {
                    update(&job_id, |j| j.failed += 1);
                    log(&job_id, format!("{} - {}: {e}", s.artist, s.title));
                }
            }
            update(&job_id, |j| j.done += 1);
        }
        if make_playlist && !ids.is_empty() {
            // A list of the same name from an earlier run is refreshed, not
            // doubled.
            let existing = state.db.playlists(user_id).into_iter().find(|p| p.role == "owner" && p.name.eq_ignore_ascii_case(&name)).map(|p| p.id);
            let pid = match existing {
                Some(id) => Some(id),
                None => state.db.create_playlist(user_id, &name).ok(),
            };
            if let Some(pid) = pid {
                let _ = state.db.set_playlist_tracks(pid, &ids);
                update(&job_id, |j| j.playlists.push(json!({ "id": pid, "name": name, "songs": ids.len() })));
            }
        }
    }
    for s in &starred {
        update(&job_id, |j| j.current = format!("{} - {}", s.artist, s.title));
        match land_song(&state, &remote, &mut owned, &job_id, s).await {
            Ok(id) => {
                let _ = state.db.set_favorite(user_id, id, true);
                // A remote star lands as this user's heart; `land_song` may
                // have matched an audition the collector bought for somebody
                // else, and that one is not theirs to adopt.
                state.db.promote_curator_track_for(id, user_id);
                update(&job_id, |j| j.starred += 1);
            }
            Err(e) => {
                update(&job_id, |j| j.failed += 1);
                log(&job_id, format!("{} - {}: {e}", s.artist, s.title));
            }
        }
        update(&job_id, |j| j.done += 1);
    }
    let _ = tokio::fs::remove_dir_all(state.data_dir.join("subsonic").join(&job_id)).await;
    update(&job_id, |j| {
        j.state = "done".into();
        j.current.clear();
    });
}

// --- routes ------------------------------------------------------------------------------------------

/// `GET /api/subsonic/remote` - which server this member is connected to,
/// never the password.
pub async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    Ok(Json(match state.db.subsonic_account(caller.id) {
        Some((url, user, _, kind)) => json!({ "connected": true, "url": url, "username": user, "serverType": kind }),
        None => json!({ "connected": false }),
    }))
}

#[derive(Deserialize)]
pub struct ConnectBody {
    pub url: String,
    pub username: String,
    pub password: String,
}

/// `PUT /api/subsonic/remote` - connect: the server is asked to ping with
/// these credentials before anything is kept.
pub async fn connect(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<ConnectBody>) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let remote = Remote::new(&body.url, &body.username, &body.password).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let (kind, version) = remote.ping().await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    state
        .db
        .set_subsonic_account(caller.id, &remote.base, &remote.user, &body.password, &kind)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "connected": true, "url": remote.base, "username": remote.user, "serverType": kind, "serverVersion": version })))
}

pub async fn disconnect(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state.db.clear_subsonic_account(caller.id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct BrowseQuery {
    #[serde(default)]
    pub offset: i64,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
}

/// `GET /api/subsonic/remote/{what}` - playlists, starred or albums there,
/// with what the library here already holds of each.
pub async fn browse(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(what): Path<String>,
    Query(q): Query<BrowseQuery>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let remote = remote_for(&state, caller.id)?;
    let bad = |e: String| (StatusCode::BAD_GATEWAY, e);
    match what.as_str() {
        "playlists" => {
            let list = remote.playlists().await.map_err(bad)?;
            let mine: Vec<String> = state.db.playlists(caller.id).into_iter().map(|p| p.name.to_lowercase()).collect();
            Ok(Json(json!({
                "playlists": list.into_iter().map(|(id, name, owner, songs)| json!({
                    "id": id, "name": name, "owner": owner, "songCount": songs,
                    "haveByName": mine.contains(&name.to_lowercase()),
                })).collect::<Vec<_>>()
            })))
        }
        "starred" => {
            let songs = remote.starred().await.map_err(bad)?;
            let owned = Owned::build(&state);
            let have = songs.iter().filter(|s| owned.find(s).is_some()).count();
            Ok(Json(json!({
                "count": songs.len(), "have": have,
                "songs": songs.iter().take(500).map(|s| json!({
                    "id": s.id, "title": s.title, "artist": s.artist, "album": s.album,
                    "durationMs": s.duration_ms, "have": owned.find(s).is_some(),
                })).collect::<Vec<_>>()
            })))
        }
        "albums" => {
            let kind = q.kind.as_deref().unwrap_or("alphabeticalByArtist");
            let list = remote.albums(kind, 100, q.offset).await.map_err(bad)?;
            Ok(Json(json!({
                "offset": q.offset,
                "albums": list.into_iter().map(|(id, name, artist, year, songs)| json!({
                    "id": id, "name": name, "artist": artist, "year": year, "songCount": songs,
                })).collect::<Vec<_>>()
            })))
        }
        _ => Err((StatusCode::NOT_FOUND, "playlists, starred or albums".into())),
    }
}

/// `POST /api/subsonic/remote/import` - start a job. One at a time per
/// member: a second ask while one runs is told so.
pub async fn import(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<ImportBody>) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    if crate::imports::imports_mode() == crate::imports::ImportsMode::Off {
        return Err((StatusCode::FORBIDDEN, "This server does not take imports (AFM_IMPORTS=off).".into()));
    }
    let remote = remote_for(&state, caller.id)?;
    if body.playlists.is_empty() && body.albums.is_empty() && !body.starred {
        return Err((StatusCode::BAD_REQUEST, "Pick something to bring over.".into()));
    }
    {
        let all = jobs().lock().unwrap_or_else(|e| e.into_inner());
        if all.iter().any(|j| j.user_id == caller.id && j.state == "running") {
            return Err((StatusCode::CONFLICT, "An import is already running - let it finish first.".into()));
        }
    }
    let id = auth::random_token()[..12].to_string();
    let title = {
        let mut parts = Vec::new();
        if !body.playlists.is_empty() { parts.push(format!("{} playlist{}", body.playlists.len(), if body.playlists.len() == 1 { "" } else { "s" })); }
        if !body.albums.is_empty() { parts.push(format!("{} album{}", body.albums.len(), if body.albums.len() == 1 { "" } else { "s" })); }
        if body.starred { parts.push("starred songs".into()); }
        format!("From {}: {}", remote.base.trim_start_matches("https://").trim_start_matches("http://"), parts.join(", "))
    };
    {
        let mut all = jobs().lock().unwrap_or_else(|e| e.into_inner());
        all.retain(|j| j.user_id != caller.id || j.state == "running" || now_ms() - j.started_at < 6 * 60 * 60 * 1000);
        all.push(Job {
            id: id.clone(), user_id: caller.id, title, state: "queued".into(), total: 0, done: 0, linked: 0, downloaded: 0, failed: 0,
            current: String::new(), error: String::new(), playlists: Vec::new(), starred: 0, started_at: now_ms(), log: Vec::new(),
        });
    }
    let st = state.clone();
    let jid = id.clone();
    tokio::spawn(async move { run_import(st, jid, caller.id, remote, body).await });
    Ok(Json(json!({ "jobId": id })))
}

/// `GET /api/subsonic/remote/jobs` - this member's jobs, newest first.
pub async fn list_jobs(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let all = jobs().lock().unwrap_or_else(|e| e.into_inner());
    let mut mine: Vec<&Job> = all.iter().filter(|j| j.user_id == caller.id).collect();
    mine.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(Json(json!({ "jobs": mine })))
}

#[derive(Deserialize)]
pub struct ExportBody {
    #[serde(rename = "playlistId")]
    pub playlist_id: i64,
}

/// `POST /api/subsonic/remote/export` - a playlist from here, made there:
/// each song looked up by name on the remote, the list created (or, by
/// the same name, replaced) with the ones it has.
pub async fn export(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<ExportBody>) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    let remote = remote_for(&state, caller.id)?;
    let pl = state
        .db
        .playlists(caller.id)
        .into_iter()
        .find(|p| p.id == body.playlist_id)
        .ok_or((StatusCode::NOT_FOUND, "no such playlist".into()))?;
    let mut ids: Vec<String> = Vec::new();
    let mut missed: Vec<String> = Vec::new();
    for tid in &pl.tracks {
        let Some(t) = state.db.track(*tid) else { continue };
        let query = format!("{} {}", t.title, t.artist);
        let hits = remote.search_songs(&query, 8).await.unwrap_or_default();
        let want_t = fold(&t.title);
        let want_a = fold(&t.artist);
        let hit = hits
            .iter()
            .find(|h| fold(&h.title) == want_t && (fold(&h.artist) == want_a || fold(&h.artist).contains(&want_a) || want_a.contains(&fold(&h.artist))))
            .or_else(|| hits.iter().find(|h| fold(&h.title) == want_t));
        match hit {
            Some(h) => ids.push(h.id.clone()),
            None => missed.push(format!("{} - {}", t.artist, t.title)),
        }
    }
    if ids.is_empty() {
        return Err((StatusCode::NOT_FOUND, "None of those songs are on the other server.".into()));
    }
    let existing = remote
        .playlists()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?
        .into_iter()
        .find(|(_, name, owner, _)| name.eq_ignore_ascii_case(&pl.name) && (owner.is_empty() || owner.eq_ignore_ascii_case(&remote.user)))
        .map(|(id, _, _, _)| id);
    let remote_id = remote.create_playlist(&pl.name, &ids, existing.as_deref()).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(json!({
        "remoteId": remote_id, "name": pl.name, "matched": ids.len(), "missed": missed.len(),
        "missing": missed.into_iter().take(50).collect::<Vec<_>>(), "replaced": existing.is_some(),
    })))
}

/// `POST /api/subsonic/flag` - the owner opens or closes the door.
#[derive(Deserialize)]
pub struct FlagBody {
    pub enabled: bool,
}

pub async fn set_flag(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<FlagBody>) -> ApiResult {
    auth::require_admin(&state.db, &headers).map_err(|s| (s, "only the owner can open or close the Subsonic door".into()))?;
    let value = if body.enabled { "on" } else { "off" };
    state.db.set_server_pref("ai.subsonic.enabled", value).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    crate::ai::set_override("subsonic.enabled", Some(value));
    Ok(Json(json!({ "enabled": crate::subsonic::enabled() })))
}
