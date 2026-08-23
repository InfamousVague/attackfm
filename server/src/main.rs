//! AttackFM server - a personal music library, streamed losslessly.
//!
//! One binary, one SQLite file, one folder of music. It indexes what is in the
//! folder, hands clients a delta of what changed, and serves the original files
//! over byte ranges so a phone plays the same FLAC the desktop does.
//!
//! Configuration is entirely environment variables, so the systemd unit is the
//! whole deployment story:
//!
//! | Variable | Default | What it is |
//! |---|---|---|
//! | `AFM_PORT` | `8788` | The port to bind. Loopback only unless `AFM_BIND` says otherwise. |
//! | `AFM_BIND` | `127.0.0.1` | Interface to bind. Left on loopback so Caddy is the only way in. |
//! | `AFM_DATA_DIR` | `./data` | The database, the art cache, and in-flight uploads. |
//! | `AFM_MUSIC_DIR` | `./music` | The library itself. Point this at a mounted volume when the box's disk runs out. |
//! | `AFM_SERVER_NAME` | `AttackFM` | What the client shows in its server settings. |
//! | `AFM_QUOTA_GB` | `0` | A ceiling on the library, in gigabytes. 0 means no ceiling. |
//! | `AFM_SCAN_MINUTES` | `15` | How often to re-walk the music folder. 0 turns the timer off. |
//! | `AFM_PLUGINS_DIR` | `<data>/plugins` | The plugin repository served at `/plugins`. |
//! | `AFM_ASSETS_DIR` | `<data>/assets` | Drop folder for generated artwork, served at `/api/assets` (checkout set beneath). |
//! | `AFM_PUBLIC_URL` | *(empty)* | The public origin, e.g. `https://matt.attack.fm` - needed for the Spotify OAuth redirect. |

mod ai;
mod ai_admin;
mod appbundle;
mod albums;
mod api;
mod mirror;
mod audible;
mod ingest;
mod transcribe;
mod audiobooks;
mod chapter_blurbs;
mod auth;
mod canvas;
mod collector;
mod connect;
mod curator;
mod fx;
mod db;
mod discover;
mod discovery;
mod dj;
mod enrichment;
mod features;
mod loudness;
mod stations;
mod stems;
mod friends;
mod home;
mod hot;
mod imports;
mod listenbrainz;
mod jams;
mod library_search;
mod listens;
mod pair;
mod playlist_covers;
mod push;
mod radio;
mod recents;
mod refetch;
mod registry_auth;
mod rewind;
mod scan;
mod search;
mod spotify;
mod spotify_sync;
mod stream;
mod tempo;
mod tools;
mod upload;

use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::routing::{delete, get, post, put};
use axum::Router;
use db::Db;
use scan::ScanProgress;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::compression::predicate::{NotForContentType, Predicate, SizeAbove};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

pub struct AppState {
    pub db: Arc<Db>,
    pub music_root: PathBuf,
    pub art_dir: PathBuf,
    /// The data directory itself, for things that live beside art and uploads
    /// rather than inside them - the published app bundle among them.
    pub data_dir: PathBuf,
    pub upload_dir: PathBuf,
    pub stream_secret: Vec<u8>,
    /// Recently verified stream tokens, so a wall of cover art does not
    /// serialize one epoch lookup per image behind the database Mutex.
    pub stream_tokens: auth::StreamTokenCache,
    pub progress: Arc<ScanProgress>,
    pub server_name: String,
    pub library_quota_bytes: i64,
    /// Whether an ffmpeg was found at boot - decides if transcoding is offered.
    pub ffmpeg: bool,
    /// The server's public origin (AFM_PUBLIC_URL), for OAuth redirect URIs.
    pub public_url: String,
    /// The hub's own Spotify app (AFM_SPOTIFY_CLIENT_ID), used when a listener
    /// has not brought their own. Not a secret: PKCE puts the client id in the
    /// authorize URL in plain sight, which is why there is no secret at all.
    pub spotify_client_id: String,
    /// The central identity directory (AFM_REGISTRY_URL) this server trusts.
    pub registry_url: String,
    /// Its public key, fetched once and cached, for verifying identity tokens
    /// offline. `None` until fetched (boot, or the first sign-in that needs it).
    pub registry_verifier: Arc<tokio::sync::Mutex<Option<afm_identity::Verifier2>>>,
    /// The push sender, or None on a server with no Apple key configured -
    /// which is most of them. See push.rs: the pipeline runs either way.
    pub apns: Option<push::Apns>,
    /// Spotify logins parked between /connect and the browser's /callback.
    pub spotify: Arc<spotify::SpotifyLogins>,
    /// The playlist-mirror engine's in-memory half. Every durable counter
    /// lives in the database, so this holds only the in-flight set.
    pub spotify_sync: Arc<spotify_sync::SpotifySyncState>,
    /// The server-side import queue - links any signed-in device enqueues,
    /// downloaded where the music lives.
    pub imports: Arc<imports::ImportManager>,
    pub refetch: Arc<refetch::RefetchManager>,
    /// Live one-time device-pairing codes (the QR "link a device" flow).
    pub pairing: Arc<pair::PairStore>,
    /// How far the separator has got on the one job it is running.
    ///
    /// In memory rather than in the job row, because it IS ephemeral: a server
    /// that restarts mid-separation re-runs that job from the top, so a stored
    /// percentage could only ever be a stale claim about work that is no longer
    /// happening. See stems::Working.
    pub separating: Arc<stems::Working>,
    /// Per-track Spotify Canvas URLs (looping now-playing clip). Inert unless
    /// AFM_SPOTIFY_SP_DC is set - the review box never has it.
    pub canvas: Arc<canvas::CanvasCache>,
    /// Held across every "find a free name, then move the file in and index
    /// it" sequence - uploads and imports alike - so two never resolve to the
    /// same destination in the shared library between the check and the move.
    pub filing: Arc<tokio::sync::Mutex<()>>,
    /// One library being pulled into this one, and how far along it is.
    pub mirror: Arc<mirror::MirrorState>,
    /// The home feed's per-user mix cache (AI curation on a long TTL).
    pub home: Arc<home::HomeState>,
    /// The DJ's suggested stations, cached per listener - see stations.rs.
    pub stations: Arc<stations::StationState>,
    /// Cached suggested-playlist metadata for the discover surface.
    pub discover: Arc<discover::DiscoverState>,
    /// AttackFM Connect: device registry + the authoritative playback session,
    /// so any device can see and drive what's playing on any other.
    pub connect: Arc<connect::ConnectState>,
    /// Live listening rooms: friends following one host's clock.
    pub jams: Arc<jams::JamState>,
    /// The curator: the always-running process that learns what this listener
    /// likes and builds playlists from it.
    pub curator: Arc<curator::CuratorState>,
    /// The audiobook download queue - small, serial, in-memory (audiobooks.rs).
    pub audiobooks: Arc<audiobooks::BookQueue>,
    /// The owner's Audible connection - device tokens and any login mid-flow.
    pub audible: Arc<audible::AudibleState>,
    pub ingest: Arc<ingest::IngestState>,
    pub transcribe: Arc<transcribe::TranscribeState>,
    /// Per-listener harvest clocks for the discovery pool.
    pub discovery: Arc<discovery::DiscoveryState>,
    /// When this process came up - the uptime the stats endpoint reports.
    pub started: std::time::Instant,
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// The whole command line: two flags that report and exit.
///
/// Everything else is configured by environment, but a binary people install on
/// their own machines has to answer `--version` and `--help` — an installer or
/// a package manager asking "is this thing runnable?" must not get a music
/// server bound to a port for its trouble. (Which is exactly what the installer
/// got before this existed: its sanity check hung forever.)
/// `attackfm-server --set-password <username>` - set a password from the box
/// the library lives on.
///
/// It exists because there is no other way back in: the app can only change a
/// password you can already sign in with, and the hash is Argon2, so no amount
/// of sqlite by hand can write one. This reuses `auth::hash_password`, the
/// exact function the login path verifies against, which is the point of
/// putting it in this binary rather than in a script beside it.
///
/// The new password is generated HERE and printed once, on the machine of the
/// person running it. Nine characters from an alphabet with no look-alikes, so
/// it survives being read off a screen and typed into a phone.
fn set_password_cli(username: Option<&str>) -> ! {
    let Some(username) = username.filter(|u| !u.trim().is_empty()) else {
        eprintln!("usage: attackfm-server --set-password <username>");
        eprintln!("       AFM_DATA_DIR must point at the server's data directory.");
        std::process::exit(2);
    };
    let data_dir = std::path::PathBuf::from(env_or("AFM_DATA_DIR", "./data"));
    let db = match db::Db::open(&data_dir.join("attackfm.db")) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("cannot open the database under {}: {e}", data_dir.display());
            eprintln!("set AFM_DATA_DIR to the directory the server runs with.");
            std::process::exit(1);
        }
    };
    // No look-alikes: 0/O and 1/l/I are the characters a password read aloud
    // or off a screen gets wrong, and this one is meant to be typed by hand.
    const ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let password: String = (0..9)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect();
    let hash = match auth::hash_password(&password) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("could not hash the password: {e}");
            std::process::exit(1);
        }
    };
    match db.set_password_hash(username, &hash) {
        Ok(true) => {
            println!();
            println!("  {username}'s new password:  {password}");
            println!();
            println!("  Every device is signed out; sign in again with this.");
            println!("  It is printed once and stored only as a hash - write it down now.");
            std::process::exit(0);
        }
        Ok(false) => {
            eprintln!("no user named '{username}' on this server.");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("could not write the new password: {e}");
            std::process::exit(1);
        }
    }
}

fn handle_cli_flags() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--set-password") {
        set_password_cli(args.get(1).map(String::as_str));
    }
    for arg in args {
        match arg.as_str() {
            "-V" | "--version" => {
                println!("attackfm-server {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "-h" | "--help" => {
                println!(
                    "attackfm-server {}\n\
                     \n\
                     A personal music library, streamed losslessly.\n\
                     Configured entirely by environment variables:\n\
                     \n\
                     Recovery:\n\
                       --set-password <user>   set a new password, printed once\n\
                     \n\
                       AFM_BIND           interface to bind      (default 127.0.0.1)\n\
                       AFM_PORT           port                   (default 8788)\n\
                       AFM_DATA_DIR       index + art cache      (default ./data)\n\
                       AFM_MUSIC_DIR      the library            (default ./music)\n\
                       AFM_SERVER_NAME    shown in the client    (default AttackFM)\n\
                       AFM_QUOTA_GB       upload ceiling in GB   (default 0 = none)\n\
                       AFM_SCAN_MINUTES   rescan interval        (default 15, 0 = off)\n\
                     \n\
                       -V, --version      print the version and exit\n\
                       -h, --help         print this and exit\n",
                    env!("CARGO_PKG_VERSION")
                );
                std::process::exit(0);
            }
            other => {
                eprintln!("attackfm-server: unknown argument {other:?} (try --help)");
                std::process::exit(2);
            }
        }
    }
}

/// Put the places tools actually live back on PATH.
///
/// This is the one environmental difference between the hub and the VPS that
/// nothing in an error message would ever point at. launchd hands a LaunchAgent
/// a bare `/usr/bin:/bin:/usr/sbin:/sbin`, and on an Apple Silicon Mac every
/// tool the server shells out to - ffmpeg, ffprobe, and whatever the importer
/// runs - lives in /opt/homebrew/bin instead. On Linux they are in /usr/bin,
/// which is already on that list, so the same binary that works on the VPS
/// quietly cannot find any of them at home. Run from a terminal it works too,
/// because a login shell has the full PATH - which is exactly how a fault like
/// this stays invisible to whoever is debugging it.
///
/// Appends rather than prepends: an operator who set PATH deliberately keeps
/// their order, and a directory that does not exist is never added.
fn ensure_tool_path() {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&current).collect();
    let mut extra: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]
        .iter()
        .map(PathBuf::from)
        .collect();
    // pipx puts console scripts here, which is where SpotiFLAC lands.
    if let Some(home) = std::env::var_os("HOME") {
        extra.push(PathBuf::from(home).join(".local/bin"));
    }
    for dir in extra {
        if dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    if let Ok(joined) = std::env::join_paths(dirs) {
        std::env::set_var("PATH", joined);
    }
}

#[tokio::main]
async fn main() {
    handle_cli_flags();
    ensure_tool_path();

    let port: u16 = env_or("AFM_PORT", "8788").parse().unwrap_or(8788);
    let bind = env_or("AFM_BIND", "127.0.0.1");
    let data_dir = PathBuf::from(env_or("AFM_DATA_DIR", "./data"));
    let music_root = PathBuf::from(env_or("AFM_MUSIC_DIR", "./music"));
    let server_name = env_or("AFM_SERVER_NAME", "AttackFM");
    let quota_gb: i64 = env_or("AFM_QUOTA_GB", "0").parse().unwrap_or(0);
    let scan_minutes: u64 = env_or("AFM_SCAN_MINUTES", "15").parse().unwrap_or(15);
    let public_url = env_or("AFM_PUBLIC_URL", "");
    let spotify_client_id = env_or("AFM_SPOTIFY_CLIENT_ID", "");
    let registry_url = env_or("AFM_REGISTRY_URL", "https://registry.attack.fm");

    let art_dir = data_dir.join("art");
    let upload_dir = data_dir.join("uploads");
    // The plugin repository this server offers its clients: static bundles
    // plus an index.json, published by `npm run redeploy -- plugins`. Served
    // unauthenticated - a plugin repo is a distribution channel, and the app
    // fetches it before anyone signs in.
    let plugins_dir = PathBuf::from(env_or(
        "AFM_PLUGINS_DIR",
        &data_dir.join("plugins").display().to_string(),
    ));
    // The generated artwork the app's surfaces wear (genre tiles, mix covers,
    // empty states). AFM_ASSETS_DIR is the drop folder and wins; the set that
    // ships with the checkout stands beneath it as a fallback, so a bare
    // install still has every face. Unauthenticated like /plugins - cosmetic,
    // fetched before anyone signs in.
    let assets_dir = PathBuf::from(env_or(
        "AFM_ASSETS_DIR",
        &data_dir.join("assets").display().to_string(),
    ));
    let assets_baked = PathBuf::from(env_or("AFM_ASSETS_BAKED", "server/assets/artwork"));
    for dir in [
        &data_dir,
        &art_dir,
        &upload_dir,
        &music_root,
        &plugins_dir,
        &assets_dir,
    ] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[attackfm] cannot create {}: {e}", dir.display());
            std::process::exit(1);
        }
    }

    let db = match Db::open(&data_dir.join("attackfm.db")) {
        Ok(db) => Arc::new(db),
        Err(e) => {
            eprintln!("[attackfm] cannot open the database: {e}");
            std::process::exit(1);
        }
    };

    let stream_secret = auth::stream_secret(&db);
    let ffmpeg = stream::ffmpeg_available();
    let progress = Arc::new(ScanProgress::default());

    let state = Arc::new(AppState {
        db: db.clone(),
        music_root: music_root.clone(),
        art_dir: art_dir.clone(),
        data_dir: data_dir.clone(),
        upload_dir,
        stream_secret,
        stream_tokens: auth::StreamTokenCache::default(),
        progress: progress.clone(),
        server_name,
        library_quota_bytes: quota_gb.max(0) * 1024 * 1024 * 1024,
        ffmpeg,
        imports: imports::ImportManager::new(&data_dir),
        refetch: refetch::RefetchManager::new(&data_dir),
        pairing: pair::PairStore::new(),
        separating: Arc::new(stems::Working::default()),
        canvas: canvas::CanvasCache::new(),
        public_url,
        spotify_client_id,
        registry_url,
        registry_verifier: Arc::new(tokio::sync::Mutex::new(None)),
        apns: push::Apns::from_env(),
        spotify: Arc::new(spotify::SpotifyLogins::default()),
        spotify_sync: Arc::new(spotify_sync::SpotifySyncState::default()),
        filing: Arc::new(tokio::sync::Mutex::new(())),
        mirror: Arc::new(mirror::MirrorState::default()),
        home: home::HomeState::new(),
        stations: stations::StationState::new(),
        discover: discover::DiscoverState::new(),
        connect: connect::ConnectState::new(),
        jams: jams::JamState::new(),
        curator: curator::CuratorState::new(),
        audiobooks: Arc::new(audiobooks::BookQueue::default()),
        audible: Arc::new(audible::AudibleState::new(&data_dir)),
        ingest: Arc::new(ingest::IngestState::new()),
        transcribe: Arc::new(transcribe::TranscribeState::new()),
        discovery: discovery::DiscoveryState::new(),
        started: std::time::Instant::now(),
    });

    // Fetch the registry's public key so identity sign-in verifies offline.
    // Non-fatal if the registry is down: it retries on first use.
    tokio::spawn(registry_auth::prime_verifier(state.clone()));
    // The digest's hourly walk. Costs a handful of queries against nobody
    // until a device registers, and sends nothing without an APNs key.
    tokio::spawn(push::sweeps(state.clone()));

    // Index what is already there before taking requests, in the background so
    // a large library does not hold the port closed.
    // Audiobook piles dropped in import/ sort themselves - see ingest.rs.
    ingest::spawn_sweep(state.clone());
    // Chapter notes ride the same rhythm as the ingest sweep: a beat after
    // boot for anything transcribed while the box was down, then patiently.
    {
        let st = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(90)).await;
            loop {
                chapter_blurbs::sweep(st.clone()).await;
                tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            }
        });
    }
    scan::spawn_scan(
        db.clone(),
        music_root.clone(),
        art_dir.clone(),
        progress.clone(),
    );

    // The import runner: downloads links onto this box and indexes them as
    // they land, so every device's catalog follows.
    imports::spawn_scheduler(state.clone());

    // The curator: enriches the library with tempo and lyric vectors, and
    // rebuilds each listener's playlists from what they actually play.
    // The operator's AI choices, read once into the process-wide overlay that
    // `ai::setting` consults ahead of the environment. Before the loops start,
    // so the very first cycle already honours what was saved in the app.
    ai::load_overrides(&state.db);
    ai::mark_boot();
    curator::spawn(state.clone());
    // The buying arm rides beside the curator: same taste, real money - er,
    // real disk. See collector.rs for the honesty rules.
    collector::spawn(state.clone());

    // The audio analyser: measures each file's loudness and brightness (and a
    // tempo where the curator has none), one polite track at a time.
    features::spawn(state.clone());
    // Real loudness per track, for playback normalisation - see loudness.rs.
    loudness::spawn(state.clone());
    // Stems, for the Pads sampler - see stems.rs.
    stems::spawn(state.clone());
    // Keeps liked songs and playlist tracks separated ahead of being asked, so
    // nobody waits on demucs for a song they were always going to open. It only
    // queues; the worker above runs, and drains people's requests first.
    stems::spawn_prefetch(state.clone());

    // The Spotify mirror: keeps watched playlists, albums and saved tracks in
    // step with their local copies.
    spotify_sync::spawn(state.clone());

    if scan_minutes > 0 {
        let db = db.clone();
        let music_root = music_root.clone();
        let art_dir = art_dir.clone();
        let progress = progress.clone();
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(std::time::Duration::from_secs(scan_minutes * 60));
            // The first tick fires immediately and the boot scan already covers
            // it, so it is spent here rather than duplicating that work.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                scan::spawn_scan(
                    db.clone(),
                    music_root.clone(),
                    art_dir.clone(),
                    progress.clone(),
                );
            }
        });
    }

    // Bearer tokens rather than cookies, so there is no ambient authority for a
    // wildcard origin to hand out: a request without the header is anonymous no
    // matter where it came from. The exposed headers are what a media element
    // needs to seek - a `206` whose `Content-Range` the page cannot read is a
    // scrub bar that does not work.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::HEAD,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        .expose_headers([
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::CONTENT_TYPE,
            header::ETAG,
            HeaderValue::from_static("x-attackfm-track")
                .as_bytes()
                .try_into()
                .unwrap(),
        ]);

    let app = Router::new()
        .route("/api/server", get(api::server_info))
        .route("/api/auth/register", post(api::register))
        .route("/api/auth/login", post(api::login))
        .route("/api/auth/logout", post(api::logout))
        // Sign in with a central-registry identity, invite-gated after the
        // first (owner) arrival. This is how an invited friend enters under
        // their own account rather than the owner's.
        .route("/api/registry/enter", post(registry_auth::enter))
        // Bind your registry identity to your existing local account here (the
        // owner's migration path), keeping all your data.
        .route("/api/registry/link", post(registry_auth::link))
        // Device pairing: a signed-in device mints a code (start), a fresh one
        // spends it for a session (claim) - the QR "link a device" flow.
        .route("/api/pair/start", post(pair::start))
        .route("/api/pair/claim", post(pair::claim))
        // Spotify Canvas for the playing track (inert without AFM_SPOTIFY_SP_DC).
        .route("/api/canvas", get(canvas::canvas))
        .route("/api/canvas/media/{id}", get(canvas::media))
        .route("/api/me", get(api::me))
        .route("/api/library", get(api::library))
        .route("/api/library/missing", post(api::library_missing))
        .route("/api/library/search", get(library_search::search))
        // Library housekeeping (tools.rs): tag editing, cover replacement,
        // duplicate handling, disk accounting, portable exports.
        .route("/api/tracks/{id}/tags", post(tools::write_tags))
        .route("/api/art/candidates", get(tools::art_candidates))
        .route("/api/album-art", post(tools::set_album_art))
        .route("/api/library/duplicates", get(tools::duplicates))
        .route(
            "/api/library/duplicates/resolve",
            post(tools::resolve_duplicates),
        )
        .route("/api/storage", get(tools::storage))
        .route("/api/library/remove", post(tools::remove_tracks))
        .route("/api/library/trash", get(tools::trash_status))
        .route("/api/library/trash/purge", post(tools::purge_trash))
        .route("/api/export/backup", get(tools::export_backup))
        .route("/api/playlists/{id}/export.m3u", get(tools::export_m3u))
        .route("/api/playlists/import", post(tools::import_playlist))
        .route("/api/imports", get(imports::list).post(imports::enqueue))
        // Getting the right recording when the importer fetched the wrong one.
        .route("/api/refetch/track/{track_id}", post(refetch::start))
        .route(
            "/api/refetch/{id}",
            get(refetch::status).delete(refetch::scrap),
        )
        .route("/api/refetch/{id}/audio/{index}", get(refetch::preview))
        .route("/api/refetch/{id}/keep", post(refetch::keep))
        .route("/api/imports/clear", post(imports::clear))
        .route("/api/imports/{id}", axum::routing::delete(imports::remove))
        .route("/api/imports/{id}/cancel", post(imports::cancel))
        .route("/api/imports/{id}/retry", post(imports::retry))
        .route("/api/scan", get(api::scan_status).post(api::scan_now))
        .route("/api/stats", get(api::stats))
        .route("/api/stats/summary", get(listens::summary))
        .route("/api/favorites", get(api::favorites))
        .route("/api/favorites/{id}", put(api::set_favorite))
        .route(
            "/api/playlists",
            get(api::playlists).post(api::create_playlist),
        )
        .route(
            "/api/playlists/{id}",
            put(api::update_playlist).delete(api::delete_playlist),
        )
        // The cover is its own route because it is BYTES, not JSON - putting an
        // image through the playlist body would base64 it onto every edit.
        .route(
            "/api/playlists/{id}/cover",
            get(playlist_covers::get)
                .post(playlist_covers::upload)
                .delete(playlist_covers::remove),
        )
        .route(
            "/api/play-state",
            get(api::play_states).post(api::set_play_state),
        )
        .route("/api/plays", post(home::record_play))
        .route("/api/listens", post(listens::record))
        .route("/api/artist-top", get(home::artist_top))
        .route("/api/friends", get(friends::list))
        .route("/api/friends/requests", post(friends::request))
        .route("/api/friends/requests/{id}/accept", post(friends::accept))
        .route("/api/friends/requests/{id}/decline", post(friends::decline))
        .route("/api/friends/{user_id}", delete(friends::remove))
        .route("/api/jams", get(jams::list).post(jams::create))
        .route("/api/jams/{id}/join", post(jams::join))
        .route("/api/jams/{id}/leave", post(jams::leave))
        .route("/api/jams/{id}/state", post(jams::set_state))
        .route("/api/jams/{id}/queue", post(jams::add_to_queue))
        .route("/api/home", get(home::feed))
        .route("/api/discover", get(discover::feed))
        .route("/api/push/register", post(push::register))
        .route("/api/push/unregister", post(push::unregister))
        .route("/api/push/prefs", get(push::prefs).post(push::set_pref))
        .route("/api/search", get(search::search))
        .route("/api/search/playlists", get(search::playlist_search))
        .route("/api/recents", get(recents::list).post(recents::add))
        .route("/api/recents/remove", post(recents::remove))
        .route("/api/recents/clear", post(recents::clear))
        .route("/api/artist", get(search::artist))
        .route("/api/ai", get(ai_admin::report))
        .route("/api/ai/settings", post(ai_admin::save_settings))
        .route("/api/ai/activity", get(ai_admin::activity_page))
        .route("/api/ai/probe", post(ai_admin::probe))
        .route("/api/ai/run", post(ai_admin::run))
        .route("/api/activity", get(ai_admin::activity))
        .route("/api/curator", get(curator::feed))
        .route("/api/curator/pulls", get(collector::status))
        .route("/api/date/done", post(collector::date_done))
        .route("/api/albums/gaps", get(albums::gaps))
        .route("/api/album/tracks", get(albums::tracks))
        .route("/api/app/bundle", get(appbundle::manifest))
        .route("/api/app/bundle/{name}", get(appbundle::file))
        // What a hot server should be carrying: the listened-to working set.
        .route("/api/hot", get(hot::hot))
        .route("/api/hot/summary", get(hot::summary))
        .route("/api/mirror/start", post(mirror::start))
        .route("/api/mirror/status", get(mirror::status))
        .route("/api/curator/pulls/settings", post(collector::settings))
        .route("/api/dj", get(dj::station))
        .route("/api/dj/stations", get(stations::stations))
        .route("/api/dj/analyze", post(dj::analyze_seed))
        .route("/api/dj/note", post(dj::set_note))
        .route("/api/dj/queue", post(dj::trait_queue))
        .route("/api/features/status", get(features::status))
        .route(
            "/api/debug/song-profiles/{id}",
            get(enrichment::debug_profile),
        )
        .route("/api/queue/enhance", post(curator::enhance_queue))
        .route(
            "/api/playlists/{id}/suggestions",
            get(curator::playlist_suggestions),
        )
        .route("/api/discoveries", get(discovery::feed))
        .route("/api/new-music", get(discovery::new_music))
        .route("/api/discoveries/dismiss", post(discovery::dismiss))
        .route("/api/related", get(discovery::related))
        .route("/api/household", get(radio::household))
        .route("/api/radio", get(radio::radio))
        .route("/api/rewind", get(rewind::rewind))
        .route("/api/connect", get(connect::connect))
        .route("/api/users", get(api::list_users))
        .route("/api/users/{id}", delete(api::delete_user))
        .route("/api/users/{id}/revoke", post(api::revoke_streams))
        .route("/api/upload/init", post(upload::init))
        .route("/api/upload/{id}", get(upload::status).put(upload::chunk))
        .route("/api/upload/{id}/finish", post(upload::finish))
        .route("/api/stream/{id}", get(stream::stream))
        .route("/api/art/{id}", get(stream::art))
        .route("/api/art/track/{id}", get(stream::art_by_track))
        .route("/api/transcode/{id}", get(stream::transcode))
        .route("/api/fx/nodes", get(fx::nodes))
        .route("/api/loudness", get(loudness::table))
        .route("/api/tempo", get(features::tempo_table))
        // Before the {track} route: axum would otherwise read "prefetch" as a
        // track id and the i64 extractor would reject it.
        .route(
            "/api/stems/prefetch",
            get(stems::prefetch_status).post(stems::set_prefetch),
        )
        .route("/api/stems/prefetch/liked", post(stems::set_liked))
        .route("/api/stems/prune", post(stems::prune))
        .route("/api/stems/{track}", get(stems::status).post(stems::request))
        .route("/api/stems/{track}/mix", get(stems::mix))
        .route("/api/stems/{track}/{stem}", get(stems::file))
        .route("/api/fx/presets", get(fx::presets).post(fx::save_preset))
        .route("/api/fx/presets/{id}", axum::routing::delete(fx::delete_preset))
        .route("/api/spotify/status", get(spotify::status))
        .route("/api/spotify/connect", post(spotify::connect))
        .route("/api/spotify/callback", get(spotify::callback))
        .route("/api/spotify/disconnect", post(spotify::disconnect))
        .route("/api/spotify/library", get(spotify::library))
        .route("/api/spotify/synced", post(spotify::mark_synced))
        .route("/api/spotify/watch", post(spotify::watch))
        .route(
            "/api/spotify/sync",
            get(spotify::sync_status).post(spotify::sync_now),
        )
        .route(
            "/api/spotify/mirror/{key}/items",
            get(spotify::mirror_items),
        )
        .route(
            "/api/spotify/mirror/{key}/retry",
            post(spotify::mirror_retry),
        )
        .route(
            "/api/spotify/mirror/{key}/forget",
            post(spotify::mirror_forget),
        )
        .route("/api/audiobooks/blurbs/{track_id}", get(chapter_blurbs::book))
        .route("/api/audiobooks/search", get(audiobooks::search))
        .route("/api/audiobooks/import", post(audiobooks::import))
        .route("/api/audiobooks/jobs", get(audiobooks::jobs))
        .route("/api/audible/status", get(audible::status))
        .route("/api/audible/login/start", post(audible::login_start))
        .route("/api/audible/login/complete", post(audible::login_complete))
        .route("/api/audible/logout", post(audible::logout))
        .route("/api/audible/library", get(audible::library))
        .route("/api/audible/import", post(audible::import))
        .route("/api/audible/jobs", get(audible::audible_jobs))
        // Reading a book's words along with it. Books only, on request only -
        // see transcribe.rs for why neither is negotiable.
        // Sorting a dropped pile of files into a real book - see ingest.rs.
        .route("/api/audiobooks/ingest", get(ingest::status).post(ingest::run))
        .route("/api/transcribe/redo", post(transcribe::redo))
        .route("/api/transcribe/status", get(transcribe::status))
        .route("/api/transcribe/jobs", get(transcribe::jobs))
        .route("/api/transcribe/{track_id}", get(transcribe::get).post(transcribe::queue))
        .nest_service("/plugins", ServeDir::new(&plugins_dir))
        .nest_service(
            "/api/assets",
            ServeDir::new(&assets_dir).fallback(ServeDir::new(&assets_baked)),
        )
        .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
        // Gzip for the JSON (a full /api/library of a large library is
        // megabytes of very compressible text - lyrics, paths, titles - and
        // this cuts it roughly 4x for every client at once). Media stays
        // untouched: FLAC and JPEG do not compress, and the streams' Range
        // handling must never sit behind an encoder.
        .layer(
            CompressionLayer::new().compress_when(
                SizeAbove::new(1024)
                    .and(NotForContentType::new("audio/"))
                    .and(NotForContentType::new("video/"))
                    .and(NotForContentType::new("image/")),
            ),
        )
        .layer(cors)
        .with_state(state);

    let addr = format!("{bind}:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[attackfm] cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    println!("[attackfm] listening on {addr}");
    println!("[attackfm] music   {}", music_root.display());
    println!("[attackfm] data    {}", data_dir.display());
    println!(
        "[attackfm] transcode {}",
        if ffmpeg {
            "available"
        } else {
            "unavailable (no ffmpeg on PATH)"
        }
    );

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("[attackfm] server error: {e}");
    }
}

/// Waits for whichever stop actually arrives.
///
/// Only Ctrl-C was handled here, which meant the one signal this server really
/// receives - systemd's SIGTERM on every `systemctl restart`, so every redeploy
/// - was never caught. The default action for an unhandled SIGTERM is immediate
/// termination, so each restart cut every in-flight audio body mid-byte. With
/// it caught, axum stops accepting and lets the responses already on the wire
/// finish (bounded by the unit's TimeoutStopSec) instead of dropping them.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            // No SIGTERM handler available: fall back to the old behaviour
            // rather than refusing to start.
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    println!("[attackfm] shutting down");
}

#[cfg(test)]
mod set_password_tests {
    /// The reset must produce a hash the LOGIN path accepts, and must not
    /// leave the old one working - the two halves of "reset".
    #[test]
    fn a_reset_password_verifies_and_the_old_one_stops() {
        let dir = std::env::temp_dir().join(format!("afm-pw-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::Db::open(&dir.join("t.db")).unwrap();
        let first = crate::auth::hash_password("original-secret").unwrap();
        db.create_user("tester", &first, true).unwrap();
        let before = db.user_by_name("tester").unwrap();
        assert!(crate::auth::verify_password("original-secret", &before.pass_hash));

        let fresh = crate::auth::hash_password("Kq7mRt2vX").unwrap();
        assert!(db.set_password_hash("tester", &fresh).unwrap());

        let after = db.user_by_name("tester").unwrap();
        assert!(crate::auth::verify_password("Kq7mRt2vX", &after.pass_hash), "new password must work");
        assert!(!crate::auth::verify_password("original-secret", &after.pass_hash), "old must not");
        // Sign-out-everywhere: tokens minted under the old epoch are stale.
        assert!(after.stream_epoch > before.stream_epoch, "stream epoch must bump");
        // Case-insensitive, matching the users table's own COLLATE NOCASE.
        assert!(db.set_password_hash("TESTER", &fresh).unwrap());
        assert!(!db.set_password_hash("nobody-here", &fresh).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod favorite_rebind_tests {
    use crate::db::{Db, ScannedTrack};
    use std::collections::HashSet;

    fn song(rel_path: &str, artist: &str, title: &str) -> ScannedTrack {
        ScannedTrack {
            rel_path: rel_path.into(),
            title: title.into(),
            artist: artist.into(),
            album_artist: artist.into(),
            album: "An Album".into(),
            track_no: Some(1), disc_no: Some(1), year: Some(2020),
            genre: String::new(), lyrics: String::new(), duration_ms: Some(180_000),
            codec: "flac".into(), lossless: true, sample_rate: Some(44_100),
            bit_depth: Some(16), channels: Some(2), bitrate: Some(900),
            size_bytes: 1, mtime: 1, art_id: None, chapters: String::new(),
        }
    }

    /// The reported bug, end to end: a liked song's FILE MOVES, so the row is
    /// tombstoned and a new one takes its place - and the heart, which points
    /// at the old id, silently stops being returned.
    #[test]
    fn a_heart_follows_its_song_to_a_new_path() {
        let dir = std::env::temp_dir().join(format!("afm-fav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();
        let user = db.create_user("listener", "x", true).unwrap();

        db.upsert_track(&song("old/place.flac", "Ratking", "Canal"), 1).unwrap();
        let old_id = db.track_id_by_path("old/place.flac").expect("indexed");
        db.set_favorite(user, old_id, true).unwrap();
        assert_eq!(db.favorites(user), vec![old_id], "hearted");

        // The file is re-filed: new row, and the old one tombstoned.
        db.upsert_track(&song("Ratking/An Album/01 Canal.flac", "Ratking", "Canal"), 2).unwrap();
        let mut present = HashSet::new();
        present.insert("Ratking/An Album/01 Canal.flac".to_string());
        db.tombstone_missing(&present, 2);

        // This is the bug: the heart is gone from the list.
        assert!(db.favorites(user).is_empty(), "the reported symptom");

        // And this is the cure.
        assert_eq!(db.rebind_orphaned_favorites(), 1, "one heart moved");
        let new_id = db.track_id_by_path("Ratking/An Album/01 Canal.flac").unwrap();
        assert_eq!(db.favorites(user), vec![new_id], "hearted again, on the live row");

        // Idempotent: running it again finds nothing left to do.
        assert_eq!(db.rebind_orphaned_favorites(), 0, "nothing to repeat");

        // A heart whose song is really gone is left alone, not thrown away.
        db.upsert_track(&song("gone/forever.flac", "Someone", "Vanished"), 3).unwrap();
        let gone_id = db.track_id_by_path("gone/forever.flac").unwrap();
        db.set_favorite(user, gone_id, true).unwrap();
        db.tombstone_missing(&present, 4);
        assert_eq!(db.rebind_orphaned_favorites(), 0, "no twin, no move");
        std::fs::remove_dir_all(&dir).ok();
    }
}
