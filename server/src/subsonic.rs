//! The Subsonic door: this library, spoken in the API that Navidrome, Gonic,
//! Airsonic and the Subsonic server before them all speak - so any of the
//! clients built for those (Symfonium, play:Sub, DSub, Feishin, Supersonic,
//! Amperfy, substreamer...) can browse and play what is here.
//!
//! Off by default. The owner turns it on in Settings (`subsonic.enabled`,
//! or `AFM_SUBSONIC=1` in the unit file), and each member who wants it mints
//! their own app password there - the protocol authenticates with
//! `md5(password + salt)`, which needs the password on this side, and the
//! account password is an argon2 hash and stays one.
//!
//! Every verb answers on `/rest/{name}` and `/rest/{name}.view`, by GET or by
//! POST form (the OpenSubsonic `formPost` extension), in JSON or XML as the
//! client asks (`f=`). Handlers build the JSON layout the spec documents and
//! subsonic_wire derives the XML from it. Errors are protocol errors - an
//! HTTP 200 whose body says `failed` - because that is what the clients
//! expect and what their error screens read.
//!
//! What is not here: albums and artists are derived from the tracks (the
//! library has no album table), so their ids are hashes of their names,
//! minted by the index below and stable for as long as the names are.
use crate::subsonic_wire::{self as wire, Format, SubsonicError as E};
use crate::{ai, auth, listens, stream, AppState};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

const IGNORED_ARTICLES: &str = "The El La Los Las Le Les";
const MUSIC_FOLDER_ID: i64 = 1;

// --- the request ---------------------------------------------------------------

/// Every parameter, in order, name by name - the API repeats names for
/// lists (`id=1&id=2`), so this is a list and not a map.
struct Params(Vec<(String, String)>);

impl Params {
    fn get(&self, k: &str) -> Option<&str> {
        self.0.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
    }
    fn all(&self, k: &str) -> Vec<&str> {
        self.0.iter().filter(|(n, _)| n == k).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty()).collect()
    }
    fn i64(&self, k: &str) -> Option<i64> {
        self.get(k).and_then(|v| v.parse().ok())
    }
    fn bool(&self, k: &str) -> Option<bool> {
        self.get(k).map(|v| matches!(v, "true" | "1" | "yes"))
    }
}

/// The person behind the request, from `u` and either `p` or `t`+`s`.
fn authenticate(state: &AppState, p: &Params) -> Result<crate::db::User, (E, &'static str)> {
    let Some(u) = p.get("u") else { return Err((E::MissingParameter, "Required parameter is missing: u")) };
    let Some(user) = state.db.user_by_name_ci(u.trim()) else {
        return Err((E::WrongCredentials, "Wrong username or password"));
    };
    let secret = state.db.subsonic_secret(user.id);
    if let (Some(t), Some(s)) = (p.get("t"), p.get("s")) {
        // Token auth needs a password we can read: the member's app
        // password. Without one minted, the honest answer is 41 - the client
        // then falls back to `p`, which the account password does verify.
        let Some(secret) = secret else {
            return Err((E::TokenNotSupported, "Token authentication not supported for this user: mint an app password in AttackFM Settings"));
        };
        if wire::token_for(&secret, s).eq_ignore_ascii_case(t.trim()) {
            return Ok(user);
        }
        return Err((E::WrongCredentials, "Wrong username or password"));
    }
    if let Some(pw) = p.get("p") {
        let pw = wire::decode_password(pw);
        if secret.as_deref() == Some(pw.as_str()) || auth::verify_password(&pw, &user.pass_hash) {
            return Ok(user);
        }
        return Err((E::WrongCredentials, "Wrong username or password"));
    }
    Err((E::MissingParameter, "Required parameter is missing: p or t+s"))
}

pub fn enabled() -> bool {
    matches!(ai::setting("subsonic.enabled", "AFM_SUBSONIC").as_deref().map(|v| v.to_ascii_lowercase()).as_deref(), Some("1" | "on" | "true" | "yes"))
}

fn respond(doc: &Value, format: Format, callback: Option<&str>) -> Response {
    (StatusCode::OK, [(header::CONTENT_TYPE, format.content_type())], wire::encode(doc, format, callback)).into_response()
}

// --- ids and shapes ------------------------------------------------------------

fn short_hash(s: &str) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn artist_key(album_artist: &str) -> String {
    album_artist.trim().to_lowercase()
}

fn artist_id(album_artist: &str) -> String {
    format!("ar-{}", short_hash(&artist_key(album_artist)))
}

fn album_id(album_artist: &str, album: &str) -> String {
    format!("al-{}", short_hash(&format!("{}|{}", artist_key(album_artist), album.trim().to_lowercase())))
}

/// The album artist the library groups by: the tag, else the track artist.
fn album_artist_of(t: &crate::db::Track) -> &str {
    if t.album_artist.trim().is_empty() { &t.artist } else { &t.album_artist }
}

/// ISO-8601 UTC from epoch milliseconds - what `created`, `starred` and
/// `changed` carry. Hand-rolled: the box has no calendar crate.
fn iso8601(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant), proleptic Gregorian.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn suffix_of(rel_path: &str) -> String {
    std::path::Path::new(rel_path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// The index by first letter the browse verbs want, with the protocol's
/// ignored articles set aside ("The National" files under N).
fn index_letter(name: &str) -> String {
    let mut n = name.trim();
    for article in IGNORED_ARTICLES.split(' ') {
        if n.len() > article.len() + 1 && n[..article.len()].eq_ignore_ascii_case(article) && n.as_bytes()[article.len()] == b' ' {
            n = n[article.len() + 1..].trim_start();
            break;
        }
    }
    match n.chars().next() {
        Some(c) if c.is_ascii_alphabetic() => c.to_ascii_uppercase().to_string(),
        Some(c) if c.is_numeric() => "#".into(),
        Some(c) => c.to_uppercase().to_string(),
        None => "#".into(),
    }
}

// --- the album / artist index ----------------------------------------------------

#[derive(Clone)]
struct Album {
    id: String,
    artist_id: String,
    name: String,
    artist: String,
    year: Option<i64>,
    songs: i64,
    duration_ms: i64,
    added_at: i64,
    art: String,
    genre: String,
}

#[derive(Clone)]
struct Artist {
    id: String,
    name: String,
    albums: Vec<usize>,
    art: String,
}

struct Index {
    rev: i64,
    albums: Vec<Album>,
    album_by_id: HashMap<String, usize>,
    artists: Vec<Artist>,
    artist_by_id: HashMap<String, usize>,
}

fn index_cell() -> &'static Mutex<Option<Arc<Index>>> {
    static CELL: OnceLock<Mutex<Option<Arc<Index>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// The library's albums and artists, rebuilt when the library changes (its
/// rev moves) and shared otherwise. One query, a few thousand rows at most.
fn index(state: &AppState) -> Arc<Index> {
    let rev = state.db.current_rev();
    if let Some(i) = index_cell().lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if i.rev == rev {
            return i.clone();
        }
    }
    let mut albums = Vec::new();
    let mut album_by_id = HashMap::new();
    let mut artists: Vec<Artist> = Vec::new();
    let mut artist_by_id: HashMap<String, usize> = HashMap::new();
    for (aa, album, year, songs, duration_ms, added_at, art, genre) in state.db.subsonic_albums() {
        let aid = artist_id(&aa);
        let artist_ix = match artist_by_id.get(&aid) {
            Some(ix) => *ix,
            None => {
                artists.push(Artist { id: aid.clone(), name: aa.clone(), albums: Vec::new(), art: String::new() });
                artist_by_id.insert(aid.clone(), artists.len() - 1);
                artists.len() - 1
            }
        };
        let al = Album { id: album_id(&aa, &album), artist_id: aid, name: album, artist: aa, year, songs, duration_ms, added_at, art, genre };
        if artists[artist_ix].art.is_empty() && !al.art.is_empty() {
            artists[artist_ix].art = al.art.clone();
        }
        album_by_id.insert(al.id.clone(), albums.len());
        artists[artist_ix].albums.push(albums.len());
        albums.push(al);
    }
    let built = Arc::new(Index { rev, albums, album_by_id, artists, artist_by_id });
    *index_cell().lock().unwrap_or_else(|e| e.into_inner()) = Some(built.clone());
    built
}

// --- JSON shapes -------------------------------------------------------------------

struct Person {
    starred: HashMap<i64, i64>,
    plays: HashMap<i64, i64>,
}

fn artist_json(a: &Artist, ix: &Index) -> Value {
    let mut v = json!({ "id": a.id, "name": a.name, "albumCount": a.albums.len() });
    if !a.art.is_empty() {
        v["coverArt"] = Value::from(a.art.clone());
    }
    let _ = ix;
    v
}

fn album_json(a: &Album, person: Option<&Person>) -> Value {
    let mut v = json!({
        "id": a.id, "name": a.name, "album": a.name, "title": a.name,
        "artist": a.artist, "artistId": a.artist_id,
        "songCount": a.songs, "duration": a.duration_ms / 1000,
        "created": iso8601(a.added_at), "isDir": true, "parent": a.artist_id,
    });
    if let Some(y) = a.year {
        v["year"] = Value::from(y);
    }
    if !a.genre.is_empty() {
        v["genre"] = Value::from(a.genre.clone());
    }
    if !a.art.is_empty() {
        v["coverArt"] = Value::from(a.art.clone());
    }
    let _ = person;
    v
}

fn child_json(t: &crate::db::Track, rel_path: &str, person: Option<&Person>) -> Value {
    let aa = album_artist_of(t);
    let mime = stream::audio_mime(std::path::Path::new(rel_path));
    let mut v = json!({
        "id": t.id.to_string(),
        "parent": album_id(aa, &t.album),
        "isDir": false,
        "title": t.title,
        "album": t.album,
        "artist": t.artist,
        "albumId": album_id(aa, &t.album),
        "artistId": artist_id(aa),
        "duration": t.duration.map(|d| d.round() as i64).unwrap_or(0),
        "size": t.size_bytes,
        "contentType": mime,
        "suffix": suffix_of(rel_path),
        "path": rel_path,
        "created": iso8601(t.added_at),
        "type": if t.kind == "book" { "audiobook" } else { "music" },
        "isVideo": false,
    });
    if let Some(n) = t.track_no { v["track"] = Value::from(n); }
    if let Some(n) = t.disc_no { v["discNumber"] = Value::from(n); }
    if let Some(y) = t.year { v["year"] = Value::from(y); }
    if !t.genre.is_empty() { v["genre"] = Value::from(t.genre.clone()); }
    if let Some(b) = t.bitrate { v["bitRate"] = Value::from(b); }
    if let Some(sr) = t.sample_rate { v["samplingRate"] = Value::from(sr); }
    if let Some(bd) = t.bit_depth { v["bitDepth"] = Value::from(bd); }
    if let Some(ch) = t.channels { v["channelCount"] = Value::from(ch); }
    if let Some(art) = &t.art_id { v["coverArt"] = Value::from(art.clone()); }
    if let Some(p) = person {
        if let Some(at) = p.starred.get(&t.id) { v["starred"] = Value::from(iso8601(*at)); }
        if let Some(n) = p.plays.get(&t.id) { v["playCount"] = Value::from(*n); }
    }
    v
}

fn person_for(state: &AppState, user_id: i64) -> Person {
    Person {
        starred: state.db.favorites_with_time(user_id).into_iter().collect(),
        plays: state.db.play_counts(user_id),
    }
}

fn tracks_of_album(state: &AppState, al: &Album) -> Vec<(crate::db::Track, String)> {
    state.db.subsonic_tracks(
        "lower(COALESCE(NULLIF(album_artist, ''), artist)) = lower(?1) AND lower(album) = lower(?2)",
        &[&al.artist, &al.name],
        "disc_no, track_no, id",
        10_000,
        0,
    )
}

fn tracks_by_ids(state: &AppState, ids: &[i64]) -> Vec<(crate::db::Track, String)> {
    if ids.is_empty() {
        return Vec::new();
    }
    let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    let rows = state.db.subsonic_tracks(&format!("id IN ({list})"), &[], "id", ids.len() as i64, 0);
    // Back in the asked-for order.
    let mut by_id: HashMap<i64, (crate::db::Track, String)> = rows.into_iter().map(|r| (r.0.id, r)).collect();
    ids.iter().filter_map(|i| by_id.remove(i)).collect()
}

// --- now playing (in memory) --------------------------------------------------------

struct Playing {
    track_id: i64,
    at_ms: i64,
    client: String,
}

fn now_playing_cell() -> &'static Mutex<HashMap<i64, Playing>> {
    static CELL: OnceLock<Mutex<HashMap<i64, Playing>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// --- the dispatcher ------------------------------------------------------------------

/// `/rest/{method}` and `/rest/{method}.view`, GET or POST.
pub async fn dispatch(
    State(state): State<Arc<AppState>>,
    Path(method): Path<String>,
    request: Request<Body>,
) -> Response {
    let method = method.trim_end_matches(".view").to_string();
    let (parts, body) = request.into_parts();
    let mut params: Vec<(String, String)> = parts
        .uri
        .query()
        .map(|q| form_urlencoded::parse(q.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect())
        .unwrap_or_default();
    if parts.method == axum::http::Method::POST {
        let is_form = parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.starts_with("application/x-www-form-urlencoded"));
        if is_form {
            if let Ok(bytes) = axum::body::to_bytes(body, 1 << 20).await {
                params.extend(form_urlencoded::parse(&bytes).map(|(k, v)| (k.into_owned(), v.into_owned())));
            }
        }
    }
    let p = Params(params);
    let format = Format::from_param(p.get("f"));
    let callback = p.get("callback").map(|s| s.to_string());

    if !enabled() {
        return respond(&wire::failed(E::NotAuthorized, "The Subsonic API is switched off on this server"), format, callback.as_deref());
    }
    let user = match authenticate(&state, &p) {
        Ok(u) => u,
        Err((code, msg)) => return respond(&wire::failed(code, msg), format, callback.as_deref()),
    };

    // The two binary verbs answer with bytes, not an envelope.
    match method.as_str() {
        "stream" | "download" => return stream_song(&state, &p, &parts.uri, &parts.headers, method == "download").await,
        "getCoverArt" => return cover_art(&state, &p, &parts.uri, &parts.headers).await,
        _ => {}
    }

    let doc = match handle(&state, &user, &method, &p).await {
        Ok(doc) => doc,
        Err((code, msg)) => wire::failed(code, &msg),
    };
    respond(&doc, format, callback.as_deref())
}

type Answer = Result<Value, (E, String)>;

fn missing(name: &str) -> (E, String) {
    (E::MissingParameter, format!("Required parameter is missing: {name}"))
}

fn not_found(what: &str) -> (E, String) {
    (E::NotFound, format!("{what} not found"))
}

async fn handle(state: &AppState, user: &crate::db::User, method: &str, p: &Params) -> Answer {
    let me = || person_for(state, user.id);
    match method {
        "ping" => Ok(wire::ok(None)),
        "getLicense" => Ok(wire::ok(Some(("license", json!({ "valid": true, "email": "", "licenseExpires": "2099-12-31T00:00:00.000Z" }))))),
        "getOpenSubsonicExtensions" => Ok(wire::ok(Some((
            "openSubsonicExtensions",
            json!([
                { "name": "formPost", "versions": [1] },
                { "name": "songLyrics", "versions": [1] },
                { "name": "transcodeOffset", "versions": [1] },
            ]),
        )))),
        "getMusicFolders" => Ok(wire::ok(Some((
            "musicFolders",
            json!({ "musicFolder": [{ "id": MUSIC_FOLDER_ID, "name": state.server_name }] }),
        )))),
        "getUser" => Ok(wire::ok(Some(("user", user_json(user))))),
        "getUsers" => Ok(wire::ok(Some(("users", json!({ "user": [user_json(user)] }))))),
        "getScanStatus" => Ok(wire::ok(Some(("scanStatus", json!({ "scanning": false, "count": state.db.track_count() }))))),
        "startScan" => Ok(wire::ok(Some(("scanStatus", json!({ "scanning": false, "count": state.db.track_count() }))))),

        // --- browsing, ID3 style -------------------------------------------------
        "getArtists" | "getIndexes" => {
            let ix = index(state);
            let mut buckets: Vec<(String, Vec<Value>)> = Vec::new();
            for a in &ix.artists {
                let letter = index_letter(&a.name);
                match buckets.iter_mut().find(|(l, _)| *l == letter) {
                    Some((_, list)) => list.push(artist_json(a, &ix)),
                    None => buckets.push((letter, vec![artist_json(a, &ix)])),
                }
            }
            buckets.sort_by(|a, b| a.0.cmp(&b.0));
            let index_json: Vec<Value> = buckets.into_iter().map(|(name, artist)| json!({ "name": name, "artist": artist })).collect();
            let key = if method == "getArtists" { "artists" } else { "indexes" };
            Ok(wire::ok(Some((key, json!({ "ignoredArticles": IGNORED_ARTICLES, "lastModified": now_ms(), "index": index_json })))))
        }
        "getArtist" => {
            let id = p.get("id").ok_or_else(|| missing("id"))?;
            let ix = index(state);
            let a = ix.artist_by_id.get(id).map(|i| &ix.artists[*i]).ok_or_else(|| not_found("Artist"))?;
            let mut v = artist_json(a, &ix);
            v["album"] = Value::Array(a.albums.iter().map(|i| album_json(&ix.albums[*i], None)).collect());
            Ok(wire::ok(Some(("artist", v))))
        }
        "getAlbum" => {
            let id = p.get("id").ok_or_else(|| missing("id"))?;
            let ix = index(state);
            let al = ix.album_by_id.get(id).map(|i| &ix.albums[*i]).ok_or_else(|| not_found("Album"))?;
            let person = me();
            let mut v = album_json(al, Some(&person));
            v["song"] = Value::Array(tracks_of_album(state, al).iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect());
            Ok(wire::ok(Some(("album", v))))
        }
        "getSong" => {
            let id = p.i64("id").ok_or_else(|| missing("id"))?;
            let person = me();
            let (t, rp) = tracks_by_ids(state, &[id]).into_iter().next().ok_or_else(|| not_found("Song"))?;
            Ok(wire::ok(Some(("song", child_json(&t, &rp, Some(&person))))))
        }
        "getMusicDirectory" => {
            let id = p.get("id").ok_or_else(|| missing("id"))?;
            let ix = index(state);
            if let Some(a) = ix.artist_by_id.get(id).map(|i| &ix.artists[*i]) {
                let child: Vec<Value> = a.albums.iter().map(|i| album_json(&ix.albums[*i], None)).collect();
                return Ok(wire::ok(Some(("directory", json!({ "id": a.id, "name": a.name, "child": child })))));
            }
            if let Some(al) = ix.album_by_id.get(id).map(|i| &ix.albums[*i]) {
                let person = me();
                let child: Vec<Value> = tracks_of_album(state, al).iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect();
                return Ok(wire::ok(Some(("directory", json!({ "id": al.id, "parent": al.artist_id, "name": al.name, "child": child })))));
            }
            Err(not_found("Directory"))
        }
        "getGenres" => {
            let mut merged: HashMap<String, (i64, i64)> = HashMap::new();
            for (raw, songs, albums) in state.db.subsonic_genres() {
                for tag in raw.split([',', ';', '/']).map(str::trim).filter(|t| !t.is_empty()) {
                    let e = merged.entry(tag.to_string()).or_insert((0, 0));
                    e.0 += songs;
                    e.1 += albums;
                }
            }
            let mut list: Vec<(String, (i64, i64))> = merged.into_iter().collect();
            list.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then_with(|| a.0.cmp(&b.0)));
            let genre: Vec<Value> = list.into_iter().map(|(name, (s, a))| json!({ "value": name, "songCount": s, "albumCount": a })).collect();
            Ok(wire::ok(Some(("genres", json!({ "genre": genre })))))
        }
        "getAlbumList" | "getAlbumList2" => {
            let kind = p.get("type").unwrap_or("alphabeticalByName");
            let size = p.i64("size").unwrap_or(10).clamp(1, 500) as usize;
            let offset = p.i64("offset").unwrap_or(0).max(0) as usize;
            let ix = index(state);
            let mut list: Vec<&Album> = ix.albums.iter().collect();
            match kind {
                "random" => {
                    use rand::seq::SliceRandom;
                    list.shuffle(&mut rand::thread_rng());
                }
                "newest" => list.sort_by(|a, b| b.added_at.cmp(&a.added_at)),
                "alphabeticalByArtist" => list.sort_by(|a, b| a.artist.to_lowercase().cmp(&b.artist.to_lowercase()).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))),
                "byYear" => {
                    let from = p.i64("fromYear").unwrap_or(0);
                    let to = p.i64("toYear").unwrap_or(9999);
                    let (lo, hi) = if from <= to { (from, to) } else { (to, from) };
                    list.retain(|a| a.year.is_some_and(|y| y >= lo && y <= hi));
                    if from > to { list.sort_by(|a, b| b.year.cmp(&a.year)); } else { list.sort_by(|a, b| a.year.cmp(&b.year)); }
                }
                "byGenre" => {
                    let g = p.get("genre").unwrap_or("").to_lowercase();
                    list.retain(|a| a.genre.to_lowercase().split([',', ';', '/']).any(|t| t.trim() == g));
                }
                "frequent" | "recent" => {
                    // Off this listener's plays: albums ranked by how much (or how
                    // recently) they play them.
                    let recent = state.db.recent_plays(user.id, 400);
                    let rows = tracks_by_ids(state, &recent);
                    let mut score: HashMap<String, (i64, usize)> = HashMap::new();
                    for (n, (t, _)) in rows.iter().enumerate() {
                        let id = album_id(album_artist_of(t), &t.album);
                        let e = score.entry(id).or_insert((0, n));
                        e.0 += 1;
                    }
                    list.retain(|a| score.contains_key(&a.id));
                    if kind == "frequent" {
                        list.sort_by(|a, b| score[&b.id].0.cmp(&score[&a.id].0));
                    } else {
                        list.sort_by(|a, b| score[&a.id].1.cmp(&score[&b.id].1));
                    }
                }
                "starred" => {
                    let starred: std::collections::HashSet<i64> = state.db.favorites(user.id).into_iter().collect();
                    let ids: Vec<i64> = starred.iter().copied().collect();
                    let rows = tracks_by_ids(state, &ids);
                    let albums: std::collections::HashSet<String> = rows.iter().map(|(t, _)| album_id(album_artist_of(t), &t.album)).collect();
                    list.retain(|a| albums.contains(&a.id));
                }
                _ => {}
            }
            let person = me();
            let page: Vec<Value> = list.into_iter().skip(offset).take(size).map(|a| album_json(a, Some(&person))).collect();
            let key = if method == "getAlbumList2" { "albumList2" } else { "albumList" };
            Ok(wire::ok(Some((key, json!({ "album": page })))))
        }
        "getRandomSongs" => {
            let size = p.i64("size").unwrap_or(10).clamp(1, 500);
            let mut clauses = vec!["kind IS NOT 'book'".to_string()];
            let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(g) = p.get("genre") { clauses.push(format!("lower(genre) LIKE ?{}", args.len() + 1)); args.push(Box::new(format!("%{}%", g.to_lowercase()))); }
            if let Some(y) = p.i64("fromYear") { clauses.push(format!("year >= ?{}", args.len() + 1)); args.push(Box::new(y)); }
            if let Some(y) = p.i64("toYear") { clauses.push(format!("year <= ?{}", args.len() + 1)); args.push(Box::new(y)); }
            let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
            let rows = state.db.subsonic_tracks(&clauses.join(" AND "), &refs, "RANDOM()", size, 0);
            let person = me();
            Ok(wire::ok(Some(("randomSongs", json!({ "song": rows.iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect::<Vec<_>>() })))))
        }
        "getSongsByGenre" => {
            let g = p.get("genre").ok_or_else(|| missing("genre"))?.to_lowercase();
            let count = p.i64("count").unwrap_or(10).clamp(1, 500);
            let offset = p.i64("offset").unwrap_or(0);
            let like = format!("%{g}%");
            let rows = state.db.subsonic_tracks("lower(genre) LIKE ?1", &[&like], "album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no", count, offset);
            let person = me();
            Ok(wire::ok(Some(("songsByGenre", json!({ "song": rows.iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect::<Vec<_>>() })))))
        }
        "getStarred" | "getStarred2" => {
            let person = me();
            let mut ids: Vec<(i64, i64)> = person.starred.iter().map(|(a, b)| (*a, *b)).collect();
            ids.sort_by(|a, b| b.1.cmp(&a.1));
            let rows = tracks_by_ids(state, &ids.iter().map(|(id, _)| *id).collect::<Vec<_>>());
            let song: Vec<Value> = rows.iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect();
            let key = if method == "getStarred2" { "starred2" } else { "starred" };
            Ok(wire::ok(Some((key, json!({ "artist": [], "album": [], "song": song })))))
        }
        "star" | "unstar" => {
            let on = method == "star";
            let ix = index(state);
            let mut ids: Vec<i64> = p.all("id").iter().filter_map(|s| s.parse().ok()).collect();
            // An album or artist starred is every song in it starred: the
            // library stars songs, and this is what that means.
            for id in p.all("albumId").into_iter().chain(p.all("id").into_iter().filter(|s| s.starts_with("al-"))) {
                if let Some(al) = ix.album_by_id.get(id).map(|i| &ix.albums[*i]) {
                    ids.extend(tracks_of_album(state, al).into_iter().map(|(t, _)| t.id));
                }
            }
            for id in p.all("artistId").into_iter().chain(p.all("id").into_iter().filter(|s| s.starts_with("ar-"))) {
                if let Some(a) = ix.artist_by_id.get(id).map(|i| &ix.artists[*i]) {
                    for i in &a.albums {
                        ids.extend(tracks_of_album(state, &ix.albums[*i]).into_iter().map(|(t, _)| t.id));
                    }
                }
            }
            for id in ids {
                let _ = state.db.set_favorite(user.id, id, on);
                if on {
                    state.db.promote_curator_track(id);
                }
            }
            Ok(wire::ok(None))
        }

        // --- search ----------------------------------------------------------------
        "search2" | "search3" => {
            let q = p.get("query").unwrap_or("").trim().trim_matches('"').to_string();
            let artist_count = p.i64("artistCount").unwrap_or(20).clamp(0, 500) as usize;
            let artist_offset = p.i64("artistOffset").unwrap_or(0).max(0) as usize;
            let album_count = p.i64("albumCount").unwrap_or(20).clamp(0, 500) as usize;
            let album_offset = p.i64("albumOffset").unwrap_or(0).max(0) as usize;
            let song_count = p.i64("songCount").unwrap_or(20).clamp(0, 500) as i64;
            let song_offset = p.i64("songOffset").unwrap_or(0).max(0) as i64;
            let ix = index(state);
            let person = me();
            let (artists, albums, songs): (Vec<Value>, Vec<Value>, Vec<Value>) = if q.is_empty() || q == "*" {
                // The empty search is how clients sync a whole library, a
                // page at a time; every list answers in a fixed order.
                let artists = ix.artists.iter().skip(artist_offset).take(artist_count).map(|a| artist_json(a, &ix)).collect();
                let albums = ix.albums.iter().skip(album_offset).take(album_count).map(|a| album_json(a, Some(&person))).collect();
                let rows = state.db.subsonic_tracks("1", &[], "id", song_count, song_offset);
                let songs = rows.iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect();
                (artists, albums, songs)
            } else {
                let needle = q.to_lowercase();
                let artists = ix.artists.iter().filter(|a| a.name.to_lowercase().contains(&needle)).skip(artist_offset).take(artist_count).map(|a| artist_json(a, &ix)).collect();
                let albums = ix.albums.iter().filter(|a| a.name.to_lowercase().contains(&needle) || a.artist.to_lowercase().contains(&needle)).skip(album_offset).take(album_count).map(|a| album_json(a, Some(&person))).collect();
                let songs = match crate::library_search::fts_expression(&q) {
                    Some(expr) => {
                        let hits = state.db.search_tracks(&expr, song_count + song_offset);
                        let ids: Vec<i64> = hits.iter().skip(song_offset as usize).map(|t| t.id).collect();
                        tracks_by_ids(state, &ids).iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect()
                    }
                    None => Vec::new(),
                };
                (artists, albums, songs)
            };
            let key = if method == "search3" { "searchResult3" } else { "searchResult2" };
            Ok(wire::ok(Some((key, json!({ "artist": artists, "album": albums, "song": songs })))))
        }

        // --- playlists ---------------------------------------------------------------
        "getPlaylists" => {
            let rows = state.db.playlists(user.id);
            let list: Vec<Value> = rows.iter().map(|pl| playlist_json(state, pl, false, None)).collect();
            Ok(wire::ok(Some(("playlists", json!({ "playlist": list })))))
        }
        "getPlaylist" => {
            let id = p.i64("id").ok_or_else(|| missing("id"))?;
            let pl = state.db.playlists(user.id).into_iter().find(|pl| pl.id == id).ok_or_else(|| not_found("Playlist"))?;
            let person = me();
            Ok(wire::ok(Some(("playlist", playlist_json(state, &pl, true, Some(&person))))))
        }
        "createPlaylist" => {
            let songs: Vec<i64> = p.all("songId").iter().filter_map(|s| s.parse().ok()).collect();
            let id = match p.i64("playlistId") {
                Some(id) => {
                    let role = state.db.playlist_role(id, user.id).ok_or_else(|| not_found("Playlist"))?;
                    if role == "viewer" {
                        return Err((E::NotAuthorized, "You may only listen to that playlist".into()));
                    }
                    state.db.set_playlist_tracks(id, &songs).map_err(|e| (E::Generic, e.to_string()))?;
                    if let Some(name) = p.get("name") {
                        let _ = state.db.rename_playlist(id, name);
                    }
                    id
                }
                None => {
                    let name = p.get("name").ok_or_else(|| missing("name"))?;
                    let id = state.db.create_playlist(user.id, name).map_err(|e| (E::Generic, e.to_string()))?;
                    state.db.set_playlist_tracks(id, &songs).map_err(|e| (E::Generic, e.to_string()))?;
                    id
                }
            };
            let pl = state.db.playlists(user.id).into_iter().find(|pl| pl.id == id).ok_or_else(|| not_found("Playlist"))?;
            let person = me();
            Ok(wire::ok(Some(("playlist", playlist_json(state, &pl, true, Some(&person))))))
        }
        "updatePlaylist" => {
            let id = p.i64("playlistId").ok_or_else(|| missing("playlistId"))?;
            let role = state.db.playlist_role(id, user.id).ok_or_else(|| not_found("Playlist"))?;
            if role == "viewer" {
                return Err((E::NotAuthorized, "You may only listen to that playlist".into()));
            }
            if let Some(name) = p.get("name") {
                state.db.rename_playlist(id, name).map_err(|e| (E::Generic, e.to_string()))?;
            }
            if let Some(comment) = p.get("comment") {
                let _ = state.db.set_playlist_meta(id, Some(comment), None, None);
            }
            let remove: Vec<usize> = p.all("songIndexToRemove").iter().filter_map(|s| s.parse().ok()).collect();
            if !remove.is_empty() {
                let mut ids = state.db.playlist_track_ids(id);
                let mut keep = Vec::with_capacity(ids.len());
                for (i, t) in ids.drain(..).enumerate() {
                    if !remove.contains(&i) {
                        keep.push(t);
                    }
                }
                state.db.set_playlist_tracks(id, &keep).map_err(|e| (E::Generic, e.to_string()))?;
            }
            for s in p.all("songIdToAdd") {
                if let Ok(t) = s.parse::<i64>() {
                    let _ = state.db.playlist_append_track(id, t);
                }
            }
            Ok(wire::ok(None))
        }
        "deletePlaylist" => {
            let id = p.i64("id").ok_or_else(|| missing("id"))?;
            let role = state.db.playlist_role(id, user.id).ok_or_else(|| not_found("Playlist"))?;
            if role != "owner" {
                return Err((E::NotAuthorized, "Only the playlist's owner can delete it".into()));
            }
            state.db.delete_playlist(id).map_err(|e| (E::Generic, e.to_string()))?;
            Ok(wire::ok(None))
        }

        // --- listening ---------------------------------------------------------------
        "scrobble" => {
            let ids: Vec<i64> = p.all("id").iter().filter_map(|s| s.parse().ok()).collect();
            if ids.is_empty() {
                return Err(missing("id"));
            }
            let submission = p.bool("submission").unwrap_or(true);
            let times = p.all("time");
            if submission {
                let mut events = Vec::new();
                for (n, id) in ids.iter().enumerate() {
                    let started = times.get(n).and_then(|t| t.parse::<i64>().ok()).unwrap_or_else(now_ms);
                    let duration_ms = state.db.track(*id).and_then(|t| t.duration).map(|d| (d * 1000.0) as i64);
                    events.push(listens::IncomingListen {
                        track_id: *id,
                        started_at: started,
                        ms_listened: duration_ms.unwrap_or(0),
                        duration_ms,
                        completed: true,
                        skipped: false,
                        context: "subsonic".into(),
                    });
                    let _ = state.db.record_play(user.id, *id);
                }
                listens::ingest(&state.db, user.id, &events);
            } else {
                let client = p.get("c").unwrap_or("subsonic").to_string();
                now_playing_cell().lock().unwrap_or_else(|e| e.into_inner()).insert(user.id, Playing { track_id: ids[0], at_ms: now_ms(), client });
            }
            Ok(wire::ok(None))
        }
        "getNowPlaying" => {
            let now = now_ms();
            let entries: Vec<(i64, i64, i64, String)> = now_playing_cell()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .filter(|(_, pl)| now - pl.at_ms < 15 * 60 * 1000)
                .map(|(uid, pl)| (*uid, pl.track_id, pl.at_ms, pl.client.clone()))
                .collect();
            let person = me();
            let mut entry = Vec::new();
            for (uid, tid, at, client) in entries {
                let Some(u) = state.db.user_by_id(uid) else { continue };
                if let Some((t, rp)) = tracks_by_ids(state, &[tid]).into_iter().next() {
                    let mut v = child_json(&t, &rp, Some(&person));
                    v["username"] = Value::from(u.username);
                    v["minutesAgo"] = Value::from((now - at) / 60_000);
                    v["playerId"] = Value::from(0);
                    v["playerName"] = Value::from(client);
                    entry.push(v);
                }
            }
            Ok(wire::ok(Some(("nowPlaying", json!({ "entry": entry })))))
        }
        "getPlayQueue" => {
            let Some((ids_json, current, position, changed, changed_by)) = state.db.subsonic_queue(user.id) else {
                return Ok(wire::ok(None));
            };
            let ids: Vec<i64> = serde_json::from_str(&ids_json).unwrap_or_default();
            let person = me();
            let entry: Vec<Value> = tracks_by_ids(state, &ids).iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect();
            let mut v = json!({ "username": user.username, "position": position, "changed": iso8601(changed), "changedBy": changed_by, "entry": entry });
            if let Some(c) = current { v["current"] = Value::from(c.to_string()); }
            Ok(wire::ok(Some(("playQueue", v))))
        }
        "savePlayQueue" => {
            let ids: Vec<i64> = p.all("id").iter().filter_map(|s| s.parse().ok()).collect();
            let current = p.i64("current");
            let position = p.i64("position").unwrap_or(0);
            let by = p.get("c").unwrap_or("subsonic");
            state
                .db
                .set_subsonic_queue(user.id, &serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into()), current, position, by)
                .map_err(|e| (E::Generic, e.to_string()))?;
            // The library's own resume point rides along, so the app picks
            // up where the other client stopped.
            if let Some(c) = current {
                let _ = state.db.set_play_state(user.id, c, position);
            }
            Ok(wire::ok(None))
        }
        "getBookmarks" => Ok(wire::ok(Some(("bookmarks", json!({ "bookmark": [] }))))),
        "getPodcasts" => Ok(wire::ok(Some(("podcasts", json!({ "channel": [] }))))),
        "getNewestPodcasts" => Ok(wire::ok(Some(("newestPodcasts", json!({ "episode": [] }))))),
        "getInternetRadioStations" => Ok(wire::ok(Some(("internetRadioStations", json!({ "internetRadioStation": [] }))))),
        "getShares" => Ok(wire::ok(Some(("shares", json!({ "share": [] }))))),
        "getChatMessages" => Ok(wire::ok(Some(("chatMessages", json!({ "chatMessage": [] }))))),
        "getVideos" => Ok(wire::ok(Some(("videos", json!({ "video": [] }))))),

        // --- words and pictures ---------------------------------------------------------
        "getLyrics" => {
            let artist = p.get("artist").unwrap_or("");
            let title = p.get("title").unwrap_or("");
            let rows = state.db.subsonic_tracks("lower(title) = lower(?1) AND lower(artist) = lower(?2)", &[&title, &artist], "id", 1, 0);
            let text = rows.first().map(|(t, _)| t.lyrics.clone()).unwrap_or_default();
            Ok(wire::ok(Some(("lyrics", json!({ "artist": artist, "title": title, "value": text })))))
        }
        "getLyricsBySongId" => {
            let id = p.i64("id").ok_or_else(|| missing("id"))?;
            let t = state.db.track(id).ok_or_else(|| not_found("Song"))?;
            let mut list = Vec::new();
            if let Some(lines) = state.db.lyric_words(id).and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
                let synced: Vec<Value> = lines
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|l| {
                                let start = l.get("startMs").or_else(|| l.get("start")).or_else(|| l.get("t")).and_then(|v| v.as_i64());
                                let text = l
                                    .get("text")
                                    .or_else(|| l.get("line"))
                                    .or_else(|| l.get("value"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .or_else(|| {
                                        l.get("words").and_then(|w| w.as_array()).map(|ws| {
                                            ws.iter().filter_map(|w| w.get("w").or_else(|| w.get("text")).and_then(|v| v.as_str())).collect::<Vec<_>>().join(" ")
                                        })
                                    })?;
                                let mut v = json!({ "value": text });
                                if let Some(s) = start { v["start"] = Value::from(s); }
                                Some(v)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !synced.is_empty() {
                    list.push(json!({ "displayArtist": t.artist, "displayTitle": t.title, "lang": "xxx", "offset": 0, "synced": true, "line": synced }));
                }
            }
            if list.is_empty() && !t.lyrics.trim().is_empty() {
                let line: Vec<Value> = t.lyrics.lines().map(|l| json!({ "value": l })).collect();
                list.push(json!({ "displayArtist": t.artist, "displayTitle": t.title, "lang": "xxx", "offset": 0, "synced": false, "line": line }));
            }
            Ok(wire::ok(Some(("lyricsList", json!({ "structuredLyrics": list })))))
        }
        "getArtistInfo" | "getArtistInfo2" => {
            let id = p.get("id").unwrap_or("");
            let ix = index(state);
            let art = ix.artist_by_id.get(id).map(|i| ix.artists[*i].art.clone()).unwrap_or_default();
            let key = if method == "getArtistInfo2" { "artistInfo2" } else { "artistInfo" };
            let mut v = json!({ "similarArtist": [] });
            if !art.is_empty() {
                let base = format!("/rest/getCoverArt?id={art}");
                v["smallImageUrl"] = Value::from(format!("{base}&size=160"));
                v["mediumImageUrl"] = Value::from(format!("{base}&size=640"));
                v["largeImageUrl"] = Value::from(base);
            }
            Ok(wire::ok(Some((key, v))))
        }
        "getAlbumInfo" | "getAlbumInfo2" => {
            let key = if method == "getAlbumInfo2" { "albumInfo" } else { "albumInfo" };
            Ok(wire::ok(Some((key, json!({})))))
        }
        "getTopSongs" => {
            let artist = p.get("artist").unwrap_or("");
            let count = p.i64("count").unwrap_or(50).clamp(1, 200);
            let ids = state.db.tracks_by_artist(artist, count);
            let person = me();
            let song: Vec<Value> = tracks_by_ids(state, &ids).iter().map(|(t, rp)| child_json(t, rp, Some(&person))).collect();
            Ok(wire::ok(Some(("topSongs", json!({ "song": song })))))
        }
        "getSimilarSongs" | "getSimilarSongs2" => {
            let key = if method == "getSimilarSongs2" { "similarSongs2" } else { "similarSongs" };
            Ok(wire::ok(Some((key, json!({ "song": [] })))))
        }
        _ => Err((E::Generic, format!("Unknown method: {method}"))),
    }
}

fn user_json(user: &crate::db::User) -> Value {
    json!({
        "username": user.username,
        "scrobblingEnabled": true,
        "adminRole": user.is_admin,
        "settingsRole": user.is_admin,
        "downloadRole": true,
        "uploadRole": false,
        "playlistRole": true,
        "coverArtRole": true,
        "commentRole": false,
        "podcastRole": false,
        "streamRole": true,
        "jukeboxRole": false,
        "shareRole": false,
        "videoConversionRole": false,
        "folder": [MUSIC_FOLDER_ID],
    })
}

fn playlist_json(state: &AppState, pl: &crate::db::PlaylistRow, with_entries: bool, person: Option<&Person>) -> Value {
    let rows = if with_entries || true { tracks_by_ids(state, &pl.tracks) } else { Vec::new() };
    let duration: i64 = rows.iter().map(|(t, _)| t.duration.unwrap_or(0.0).round() as i64).sum();
    let mut v = json!({
        "id": pl.id.to_string(),
        "name": pl.name,
        "comment": pl.description,
        "owner": pl.owner_name,
        "public": pl.role != "owner",
        "songCount": pl.tracks.len(),
        "duration": duration,
        "created": iso8601(pl.updated_at),
        "changed": iso8601(pl.updated_at),
    });
    if let Some((t, _)) = rows.first() {
        if let Some(art) = &t.art_id {
            v["coverArt"] = Value::from(art.clone());
        }
    }
    if with_entries {
        v["entry"] = Value::Array(rows.iter().map(|(t, rp)| child_json(t, rp, person)).collect());
    }
    v
}

// --- bytes: stream / download / getCoverArt ----------------------------------------------

fn bare_request(uri: &Uri, headers: &HeaderMap) -> Request<Body> {
    let mut req = Request::new(Body::empty());
    *req.uri_mut() = uri.clone();
    for name in [header::RANGE, header::IF_RANGE, header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE] {
        if let Some(v) = headers.get(&name) {
            req.headers_mut().insert(name, v.clone());
        }
    }
    req
}

async fn stream_song(state: &AppState, p: &Params, uri: &Uri, headers: &HeaderMap, download: bool) -> Response {
    let Some(id) = p.i64("id") else { return (StatusCode::BAD_REQUEST, "id").into_response() };
    let Some(rel) = state.db.track_rel_path(id) else { return StatusCode::NOT_FOUND.into_response() };
    let Some(path) = stream::resolve_in_root(&state.music_root, &rel) else { return StatusCode::NOT_FOUND.into_response() };
    let max_kbps = p.i64("maxBitRate").unwrap_or(0);
    let format = p.get("format").unwrap_or("").to_ascii_lowercase();
    let offset = p.i64("timeOffset").unwrap_or(0).max(0);
    let want_transcode = !download && format != "raw" && (max_kbps > 0 || matches!(format.as_str(), "aac" | "mp3" | "opus") || offset > 0);
    if want_transcode && state.ffmpeg {
        // The house transcoder's shape (stream::transcode): AAC in ADTS, the
        // bitrate the client asked for within the same bounds. MP3 or Opus
        // when the client insists and ffmpeg has the encoder; a client that
        // reads the advertised transcodedSuffix takes whichever arrives.
        let kbps = if max_kbps > 0 { max_kbps.clamp(64, 320) } else { 192 };
        let (codec, container, mime): (&str, &str, &str) = match format.as_str() {
            "mp3" => ("libmp3lame", "mp3", "audio/mpeg"),
            "opus" => ("libopus", "ogg", "audio/ogg"),
            _ => ("aac", "adts", "audio/aac"),
        };
        let mut cmd = tokio::process::Command::new("ffmpeg");
        cmd.arg("-v").arg("error").arg("-nostdin");
        if offset > 0 {
            cmd.arg("-ss").arg(offset.to_string());
        }
        cmd.arg("-i").arg(&path).arg("-vn").arg("-map_metadata").arg("-1").arg("-c:a").arg(codec).arg("-b:a").arg(format!("{kbps}k")).arg("-f").arg(container).arg("pipe:1");
        cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).stdin(std::process::Stdio::null());
        if let Ok(mut child) = cmd.spawn() {
            if let Some(stdout) = child.stdout.take() {
                let body = Body::from_stream(stream::reader_stream(stdout));
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return (
                    StatusCode::OK,
                    [
                        (header::CONTENT_TYPE, mime.to_string()),
                        (header::CACHE_CONTROL, "no-store".to_string()),
                        (header::ACCEPT_RANGES, "none".to_string()),
                    ],
                    body,
                )
                    .into_response();
            }
        }
        // ffmpeg would not start: the original, which every client can play.
    }
    use tower::ServiceExt;
    let mime = stream::audio_mime(&path);
    let request = bare_request(uri, headers);
    match tower_http::services::ServeFile::new_with_mime(&path, &mime.parse().unwrap_or(mime_guess::mime::APPLICATION_OCTET_STREAM)).oneshot(request).await {
        Ok(mut res) => {
            if download {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("song").replace('"', "");
                if let Ok(v) = format!("attachment; filename=\"{name}\"").parse() {
                    res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
                }
            }
            res.into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn cover_art(state: &AppState, p: &Params, uri: &Uri, headers: &HeaderMap) -> Response {
    let Some(id) = p.get("id") else { return (StatusCode::BAD_REQUEST, "id").into_response() };
    // An album's or artist's id, a song's number, a playlist's, or the art
    // id itself - whatever the client kept from what we told it.
    let art_id = if let Some(rest) = id.strip_prefix("al-").map(|_| id) {
        let ix = index(state);
        ix.album_by_id.get(rest).map(|i| ix.albums[*i].art.clone())
    } else if id.starts_with("ar-") {
        let ix = index(state);
        ix.artist_by_id.get(id).map(|i| ix.artists[*i].art.clone())
    } else if let Some(pl) = id.strip_prefix("pl-").and_then(|s| s.parse::<i64>().ok()) {
        state.db.playlist_track_ids(pl).first().and_then(|t| state.db.track_art_id(*t))
    } else if let Ok(tid) = id.parse::<i64>() {
        state.db.track_art_id(tid)
    } else {
        Some(id.to_string())
    };
    let Some(art_id) = art_id.filter(|a| !a.is_empty()) else { return StatusCode::NOT_FOUND.into_response() };
    // The house keeps two sizes; the client's number lands on the nearest.
    let mut params = HashMap::new();
    if let Some(size) = p.i64("size") {
        let house = if size <= 240 { 160 } else if size <= 800 { 640 } else { 0 };
        if house > 0 {
            params.insert("size".to_string(), house.to_string());
        }
    }
    let request = bare_request(uri, headers);
    match stream::serve_art(state, &art_id, &params, headers, request).await {
        Ok(res) => res,
        Err(code) => code.into_response(),
    }
}

// --- the app's side of the door: Settings -----------------------------------------------------

/// `GET /api/subsonic` - whether the door is open and whether this member
/// has an app password (never the password itself, after minting).
pub async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<axum::Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    Ok(axum::Json(json!({
        "enabled": enabled(),
        "hasSecret": state.db.subsonic_secret(caller.id).is_some(),
        "username": caller.username,
        "url": if state.public_url.is_empty() { Value::Null } else { Value::from(state.public_url.clone()) },
    })))
}

/// `POST /api/subsonic/secret` - mint (or re-mint) this member's app
/// password. Shown once, in the reply; the app copies it into the client.
pub async fn mint_secret(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<axum::Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    let secret: String = (0..20).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect();
    state.db.set_subsonic_secret(caller.id, &secret).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(axum::Json(json!({ "secret": secret, "username": caller.username })))
}

/// `DELETE /api/subsonic/secret` - revoke it; clients holding it stop working.
pub async fn revoke_secret(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<axum::Json<Value>, (StatusCode, String)> {
    let caller = auth::require_caller(&state.db, &headers).map_err(|s| (s, "sign in first".into()))?;
    state.db.clear_subsonic_secret(caller.id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(axum::Json(json!({ "ok": true })))
}
