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
//! | `AFM_PUBLIC_URL` | *(empty)* | The public origin, e.g. `https://matt.attack.fm` - needed for the Spotify OAuth redirect. |

mod api;
mod auth;
mod canvas;
mod connect;
mod curator;
mod db;
mod discover;
mod discovery;
mod dj;
mod friends;
mod home;
mod imports;
mod jams;
mod pair;
mod registry_auth;
mod scan;
mod spotify;
mod spotify_sync;
mod search;
mod stream;
mod tempo;
mod upload;

use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::routing::{delete, get, post, put};
use axum::Router;
use db::Db;
use scan::ScanProgress;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

pub struct AppState {
    pub db: Arc<Db>,
    pub music_root: PathBuf,
    pub art_dir: PathBuf,
    pub upload_dir: PathBuf,
    pub stream_secret: Vec<u8>,
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
    /// Spotify logins parked between /connect and the browser's /callback.
    pub spotify: Arc<spotify::SpotifyLogins>,
    /// The playlist-mirror engine's in-memory half. Every durable counter
    /// lives in the database, so this holds only the in-flight set.
    pub spotify_sync: Arc<spotify_sync::SpotifySyncState>,
    /// The server-side import queue - links any signed-in device enqueues,
    /// downloaded where the music lives.
    pub imports: Arc<imports::ImportManager>,
    /// Live one-time device-pairing codes (the QR "link a device" flow).
    pub pairing: Arc<pair::PairStore>,
    /// Per-track Spotify Canvas URLs (looping now-playing clip). Inert unless
    /// AFM_SPOTIFY_SP_DC is set - the review box never has it.
    pub canvas: Arc<canvas::CanvasCache>,
    /// Held across every "find a free name, then move the file in and index
    /// it" sequence - uploads and imports alike - so two never resolve to the
    /// same destination in the shared library between the check and the move.
    pub filing: Arc<tokio::sync::Mutex<()>>,
    /// The home feed's per-user mix cache (AI curation on a long TTL).
    pub home: Arc<home::HomeState>,
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
    /// Per-listener harvest clocks for the discovery pool.
    pub discovery: Arc<discovery::DiscoveryState>,
    /// When this process came up - the uptime the stats endpoint reports.
    pub started: std::time::Instant,
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

/// The whole command line: two flags that report and exit.
///
/// Everything else is configured by environment, but a binary people install on
/// their own machines has to answer `--version` and `--help` — an installer or
/// a package manager asking "is this thing runnable?" must not get a music
/// server bound to a port for its trouble. (Which is exactly what the installer
/// got before this existed: its sanity check hung forever.)
fn handle_cli_flags() {
    for arg in std::env::args().skip(1) {
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

#[tokio::main]
async fn main() {
    handle_cli_flags();

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
    let plugins_dir = PathBuf::from(env_or("AFM_PLUGINS_DIR", &data_dir.join("plugins").display().to_string()));
    for dir in [&data_dir, &art_dir, &upload_dir, &music_root, &plugins_dir] {
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
        upload_dir,
        stream_secret,
        progress: progress.clone(),
        server_name,
        library_quota_bytes: quota_gb.max(0) * 1024 * 1024 * 1024,
        ffmpeg,
        imports: imports::ImportManager::new(&data_dir),
        pairing: pair::PairStore::new(),
        canvas: canvas::CanvasCache::new(),
        public_url,
        spotify_client_id,
        registry_url,
        registry_verifier: Arc::new(tokio::sync::Mutex::new(None)),
        spotify: Arc::new(spotify::SpotifyLogins::default()),
        spotify_sync: Arc::new(spotify_sync::SpotifySyncState::default()),
        filing: Arc::new(tokio::sync::Mutex::new(())),
        home: home::HomeState::new(),
        discover: discover::DiscoverState::new(),
        connect: connect::ConnectState::new(),
        jams: jams::JamState::new(),
        curator: curator::CuratorState::new(),
        discovery: discovery::DiscoveryState::new(),
        started: std::time::Instant::now(),
    });

    // Fetch the registry's public key so identity sign-in verifies offline.
    // Non-fatal if the registry is down: it retries on first use.
    tokio::spawn(registry_auth::prime_verifier(state.clone()));

    // Index what is already there before taking requests, in the background so
    // a large library does not hold the port closed.
    scan::spawn_scan(db.clone(), music_root.clone(), art_dir.clone(), progress.clone());

    // The import runner: downloads links onto this box and indexes them as
    // they land, so every device's catalog follows.
    imports::spawn_scheduler(state.clone());

    // The curator: enriches the library with tempo and lyric vectors, and
    // rebuilds each listener's playlists from what they actually play.
    curator::spawn(state.clone());

    // The Spotify mirror: keeps watched playlists, albums and saved tracks in
    // step with their local copies.
    spotify_sync::spawn(state.clone());

    if scan_minutes > 0 {
        let db = db.clone();
        let music_root = music_root.clone();
        let art_dir = art_dir.clone();
        let progress = progress.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(scan_minutes * 60));
            // The first tick fires immediately and the boot scan already covers
            // it, so it is spent here rather than duplicating that work.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                scan::spawn_scan(db.clone(), music_root.clone(), art_dir.clone(), progress.clone());
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
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::HEAD, Method::OPTIONS])
        .allow_headers(Any)
        .expose_headers([
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::CONTENT_TYPE,
            header::ETAG,
            HeaderValue::from_static("x-attackfm-track").as_bytes().try_into().unwrap(),
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
        .route("/api/imports", get(imports::list).post(imports::enqueue))
        .route("/api/imports/clear", post(imports::clear))
        .route(
            "/api/imports/{id}",
            axum::routing::delete(imports::remove),
        )
        .route("/api/imports/{id}/cancel", post(imports::cancel))
        .route("/api/imports/{id}/retry", post(imports::retry))
        .route("/api/scan", get(api::scan_status).post(api::scan_now))
        .route("/api/stats", get(api::stats))
        .route("/api/favorites", get(api::favorites))
        .route("/api/favorites/{id}", put(api::set_favorite))
        .route("/api/playlists", get(api::playlists).post(api::create_playlist))
        .route(
            "/api/playlists/{id}",
            put(api::update_playlist).delete(api::delete_playlist),
        )
        .route("/api/play-state", get(api::play_states).post(api::set_play_state))
        .route("/api/plays", post(home::record_play))
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
        .route("/api/search", get(search::search))
        .route("/api/artist", get(search::artist))
        .route("/api/curator", get(curator::feed))
        .route("/api/dj", get(dj::station))
        .route("/api/playlists/{id}/suggestions", get(curator::playlist_suggestions))
        .route("/api/discoveries", get(discovery::feed))
        .route("/api/new-music", get(discovery::new_music))
        .route("/api/discoveries/dismiss", post(discovery::dismiss))
        .route("/api/connect", get(connect::connect))
        .route("/api/users", get(api::list_users))
        .route("/api/users/{id}", delete(api::delete_user))
        .route("/api/users/{id}/revoke", post(api::revoke_streams))
        .route("/api/upload/init", post(upload::init))
        .route("/api/upload/{id}", get(upload::status).put(upload::chunk))
        .route("/api/upload/{id}/finish", post(upload::finish))
        .route("/api/stream/{id}", get(stream::stream))
        .route("/api/art/{id}", get(stream::art))
        .route("/api/transcode/{id}", get(stream::transcode))
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
        .route("/api/spotify/mirror/{key}/items", get(spotify::mirror_items))
        .route("/api/spotify/mirror/{key}/retry", post(spotify::mirror_retry))
        .route("/api/spotify/mirror/{key}/forget", post(spotify::mirror_forget))
        .nest_service("/plugins", ServeDir::new(&plugins_dir))
        .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
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
        if ffmpeg { "available" } else { "unavailable (no ffmpeg on PATH)" }
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
