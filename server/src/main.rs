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

mod api;
mod auth;
mod db;
mod scan;
mod stream;
mod upload;

use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::routing::{delete, get, post, put};
use axum::Router;
use db::Db;
use scan::ScanProgress;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

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

    let art_dir = data_dir.join("art");
    let upload_dir = data_dir.join("uploads");
    for dir in [&data_dir, &art_dir, &upload_dir, &music_root] {
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
    });

    // Index what is already there before taking requests, in the background so
    // a large library does not hold the port closed.
    scan::spawn_scan(db.clone(), music_root.clone(), art_dir.clone(), progress.clone());

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
        .route("/api/me", get(api::me))
        .route("/api/library", get(api::library))
        .route("/api/scan", get(api::scan_status).post(api::scan_now))
        .route("/api/favorites", get(api::favorites))
        .route("/api/favorites/{id}", put(api::set_favorite))
        .route("/api/playlists", get(api::playlists).post(api::create_playlist))
        .route(
            "/api/playlists/{id}",
            put(api::update_playlist).delete(api::delete_playlist),
        )
        .route("/api/play-state", get(api::play_states).post(api::set_play_state))
        .route("/api/users", get(api::list_users))
        .route("/api/users/{id}", delete(api::delete_user))
        .route("/api/users/{id}/revoke", post(api::revoke_streams))
        .route("/api/upload/init", post(upload::init))
        .route("/api/upload/{id}", get(upload::status).put(upload::chunk))
        .route("/api/upload/{id}/finish", post(upload::finish))
        .route("/api/stream/{id}", get(stream::stream))
        .route("/api/art/{id}", get(stream::art))
        .route("/api/transcode/{id}", get(stream::transcode))
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

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    println!("[attackfm] shutting down");
}
