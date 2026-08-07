//! SQLite schema and queries.
//!
//! The whole library lives in one file under the data directory. Every table is
//! created on boot, so a fresh box needs no migration step - and every later
//! column is added by `migrate` the same way, since the server is expected to
//! be redeployed over a database that is already carrying somebody's music.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

/// The single connection, behind a mutex.
///
/// One writer is the right shape for this: a music server's writes are the
/// scanner and the odd playlist edit, while the reads that actually matter -
/// range requests for audio - never come here at all (a stream token is
/// verified by HMAC, and the bytes are served off the filesystem). WAL keeps
/// concurrent readers from queueing behind the scanner.
pub struct Db {
    conn: Mutex<Connection>,
}

/// A row of the library as the API hands it out.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Track {
    pub id: i64,
    pub title: String,
    pub artist: String,
    #[serde(rename = "albumArtist")]
    pub album_artist: String,
    pub album: String,
    #[serde(rename = "trackNo")]
    pub track_no: Option<i64>,
    #[serde(rename = "discNo")]
    pub disc_no: Option<i64>,
    pub year: Option<i64>,
    pub genre: String,
    pub lyrics: String,
    /// Length in seconds, to match what the client's local scanner produces.
    pub duration: Option<f64>,
    pub codec: String,
    /// Whether the source file is lossless - what the client's badge reads.
    pub lossless: bool,
    #[serde(rename = "sampleRate")]
    pub sample_rate: Option<i64>,
    #[serde(rename = "bitDepth")]
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    /// Kilobits per second, as stored.
    pub bitrate: Option<i64>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    /// Epoch milliseconds, matching the client's `addedAt`.
    #[serde(rename = "addedAt")]
    pub added_at: i64,
    /// The cover art's content hash, or null when the file carries none.
    #[serde(rename = "artId")]
    pub art_id: Option<String>,
    pub rev: i64,
}

/// What the scanner has learned about one file, before it becomes a row.
#[derive(Debug, Clone, Default)]
pub struct ScannedTrack {
    pub rel_path: String,
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub year: Option<i64>,
    pub genre: String,
    pub lyrics: String,
    pub duration_ms: Option<i64>,
    pub codec: String,
    pub lossless: bool,
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    pub bitrate: Option<i64>,
    pub size_bytes: i64,
    pub mtime: i64,
    pub art_id: Option<String>,
}

pub struct User {
    pub id: i64,
    pub username: String,
    pub pass_hash: String,
    pub is_admin: bool,
    pub stream_epoch: i64,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash    TEXT NOT NULL,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  -- Bumping this invalidates every stream token this user holds and nobody
  -- else's, which is what "sign out everywhere" costs.
  stream_epoch INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);

CREATE TABLE IF NOT EXISTS tracks (
  id           INTEGER PRIMARY KEY,
  rel_path     TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  artist       TEXT NOT NULL,
  album_artist TEXT NOT NULL,
  album        TEXT NOT NULL,
  track_no     INTEGER,
  disc_no      INTEGER,
  year         INTEGER,
  genre        TEXT NOT NULL DEFAULT '',
  lyrics       TEXT NOT NULL DEFAULT '',
  duration_ms  INTEGER,
  codec        TEXT NOT NULL DEFAULT '',
  lossless     INTEGER NOT NULL DEFAULT 0,
  sample_rate  INTEGER,
  bit_depth    INTEGER,
  channels     INTEGER,
  bitrate      INTEGER,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  mtime        INTEGER NOT NULL DEFAULT 0,
  art_id       TEXT,
  added_at     INTEGER NOT NULL,
  -- The delta-sync stamp: a client asks for everything above the rev it last
  -- saw. Tombstones keep their row so removals sync too.
  rev          INTEGER NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tracks_rev ON tracks(rev);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_artist, album, disc_no, track_no);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist);

CREATE TABLE IF NOT EXISTS favorites (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlists_user ON playlists(user_id);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);

-- Where each listener left off, so a phone can pick up what the desktop
-- started. One row per user per track.
CREATE TABLE IF NOT EXISTS play_state (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
"#;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A poisoned lock means a previous writer panicked mid-statement. The
        // connection itself is still usable (SQLite is transactional), and
        // refusing every later request would turn one bad file into an outage.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // --- meta -------------------------------------------------------------

    pub fn meta_get(&self, key: &str) -> Option<String> {
        self.lock()
            .query_row("SELECT v FROM meta WHERE k = ?1", params![key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn meta_set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO meta (k, v) VALUES (?1, ?2)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![key, value],
        )?;
        Ok(())
    }

    /// The library's current revision - the highest stamp any row carries.
    pub fn current_rev(&self) -> i64 {
        self.lock()
            .query_row("SELECT COALESCE(MAX(rev), 0) FROM tracks", [], |r| r.get(0))
            .unwrap_or(0)
    }

    // --- users ------------------------------------------------------------

    pub fn user_count(&self) -> i64 {
        self.lock()
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .unwrap_or(0)
    }

    pub fn create_user(&self, username: &str, pass_hash: &str, is_admin: bool) -> rusqlite::Result<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO users (username, pass_hash, is_admin, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![username, pass_hash, is_admin as i64, now_ms()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    fn read_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
        Ok(User {
            id: row.get(0)?,
            username: row.get(1)?,
            pass_hash: row.get(2)?,
            is_admin: row.get::<_, i64>(3)? != 0,
            stream_epoch: row.get(4)?,
        })
    }

    pub fn user_by_name(&self, username: &str) -> Option<User> {
        self.lock()
            .query_row(
                "SELECT id, username, pass_hash, is_admin, stream_epoch FROM users WHERE username = ?1",
                params![username],
                Self::read_user,
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn user_by_id(&self, id: i64) -> Option<User> {
        self.lock()
            .query_row(
                "SELECT id, username, pass_hash, is_admin, stream_epoch FROM users WHERE id = ?1",
                params![id],
                Self::read_user,
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn list_users(&self) -> Vec<(i64, String, bool)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT id, username, is_admin FROM users ORDER BY id") else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0))
        });
        rows.map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn delete_user(&self, id: i64) -> rusqlite::Result<()> {
        self.lock().execute("DELETE FROM users WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Invalidates every stream token the user holds.
    pub fn bump_stream_epoch(&self, id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE users SET stream_epoch = stream_epoch + 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    // --- session tokens ---------------------------------------------------

    pub fn create_token(&self, token: &str, user_id: i64) -> rusqlite::Result<()> {
        let now = now_ms();
        self.lock().execute(
            "INSERT INTO tokens (token, user_id, created_at, last_seen) VALUES (?1, ?2, ?3, ?3)",
            params![token, user_id, now],
        )?;
        Ok(())
    }

    pub fn user_for_token(&self, token: &str) -> Option<User> {
        let conn = self.lock();
        let user = conn
            .query_row(
                "SELECT u.id, u.username, u.pass_hash, u.is_admin, u.stream_epoch
                   FROM tokens t JOIN users u ON u.id = t.user_id
                  WHERE t.token = ?1",
                params![token],
                Self::read_user,
            )
            .optional()
            .ok()
            .flatten()?;
        let _ = conn.execute(
            "UPDATE tokens SET last_seen = ?2 WHERE token = ?1",
            params![token, now_ms()],
        );
        Some(user)
    }

    pub fn delete_token(&self, token: &str) -> rusqlite::Result<()> {
        self.lock()
            .execute("DELETE FROM tokens WHERE token = ?1", params![token])?;
        Ok(())
    }

    // --- library ----------------------------------------------------------

    /// Every indexed path with the mtime and size the index believes it has, so
    /// the scanner can skip files that have not moved since last time.
    pub fn scan_fingerprints(&self) -> std::collections::HashMap<String, (i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT rel_path, mtime, size_bytes FROM tracks WHERE deleted = 0")
        else {
            return Default::default();
        };
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?)))
        });
        rows.map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    /// Inserts or refreshes one scanned file, stamping it with `rev`.
    ///
    /// `added_at` is preserved across a re-scan: a file whose tags were fixed
    /// is not newly arrived, and the client's "recently added" sort would lie
    /// if every re-read pushed it back to the top.
    pub fn upsert_track(&self, t: &ScannedTrack, rev: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO tracks (
                 rel_path, title, artist, album_artist, album, track_no, disc_no, year,
                 genre, lyrics, duration_ms, codec, lossless, sample_rate, bit_depth,
                 channels, bitrate, size_bytes, mtime, art_id, added_at, rev, deleted
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                 ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 ?16, ?17, ?18, ?19, ?20, ?21, ?22, 0
             )
             ON CONFLICT(rel_path) DO UPDATE SET
                 title = excluded.title, artist = excluded.artist,
                 album_artist = excluded.album_artist, album = excluded.album,
                 track_no = excluded.track_no, disc_no = excluded.disc_no,
                 year = excluded.year, genre = excluded.genre, lyrics = excluded.lyrics,
                 duration_ms = excluded.duration_ms, codec = excluded.codec,
                 lossless = excluded.lossless, sample_rate = excluded.sample_rate,
                 bit_depth = excluded.bit_depth, channels = excluded.channels,
                 bitrate = excluded.bitrate, size_bytes = excluded.size_bytes,
                 mtime = excluded.mtime, art_id = excluded.art_id,
                 rev = excluded.rev, deleted = 0",
            params![
                t.rel_path, t.title, t.artist, t.album_artist, t.album, t.track_no, t.disc_no,
                t.year, t.genre, t.lyrics, t.duration_ms, t.codec, t.lossless as i64,
                t.sample_rate, t.bit_depth, t.channels, t.bitrate, t.size_bytes, t.mtime,
                t.art_id, now_ms(), rev
            ],
        )?;
        Ok(())
    }

    /// Tombstones the paths that the walk no longer found, so clients learn
    /// about removals on their next delta.
    pub fn tombstone_missing(&self, present: &std::collections::HashSet<String>, rev: i64) -> i64 {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT rel_path FROM tracks WHERE deleted = 0") else {
            return 0;
        };
        let indexed: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default();
        drop(stmt);
        let mut gone = 0;
        for path in indexed {
            if present.contains(&path) {
                continue;
            }
            if conn
                .execute(
                    "UPDATE tracks SET deleted = 1, rev = ?2 WHERE rel_path = ?1",
                    params![path, rev],
                )
                .is_ok()
            {
                gone += 1;
            }
        }
        gone
    }

    fn read_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
        let duration_ms: Option<i64> = row.get(11)?;
        Ok(Track {
            id: row.get(0)?,
            title: row.get(1)?,
            artist: row.get(2)?,
            album_artist: row.get(3)?,
            album: row.get(4)?,
            track_no: row.get(5)?,
            disc_no: row.get(6)?,
            year: row.get(7)?,
            genre: row.get(8)?,
            lyrics: row.get(9)?,
            duration: duration_ms.map(|ms| ms as f64 / 1000.0),
            codec: row.get(12)?,
            lossless: row.get::<_, i64>(13)? != 0,
            sample_rate: row.get(14)?,
            bit_depth: row.get(15)?,
            channels: row.get(16)?,
            bitrate: row.get(17)?,
            size_bytes: row.get(18)?,
            added_at: row.get(19)?,
            art_id: row.get(20)?,
            rev: row.get(21)?,
        })
    }

    const TRACK_COLS: &'static str = "id, title, artist, album_artist, album, track_no, disc_no, \
         year, genre, lyrics, deleted, duration_ms, codec, lossless, sample_rate, bit_depth, \
         channels, bitrate, size_bytes, added_at, art_id, rev";

    /// Everything stamped above `since`, live rows and tombstones alike. The
    /// tombstones come back as bare ids so a client can drop them.
    pub fn tracks_since(&self, since: i64, limit: i64) -> (Vec<Track>, Vec<i64>) {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks WHERE rev > ?1 ORDER BY rev, id LIMIT ?2",
            Self::TRACK_COLS
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return (Vec::new(), Vec::new());
        };
        let mut live = Vec::new();
        let mut removed = Vec::new();
        let rows = stmt.query_map(params![since, limit], |r| {
            let deleted: i64 = r.get(10)?;
            Ok((deleted != 0, Self::read_track(r)?))
        });
        if let Ok(rows) = rows {
            for (is_deleted, track) in rows.filter_map(Result::ok) {
                if is_deleted {
                    removed.push(track.id);
                } else {
                    live.push(track);
                }
            }
        }
        (live, removed)
    }

    pub fn track(&self, id: i64) -> Option<Track> {
        let sql = format!(
            "SELECT {} FROM tracks WHERE id = ?1 AND deleted = 0",
            Self::TRACK_COLS
        );
        self.lock()
            .query_row(&sql, params![id], Self::read_track)
            .optional()
            .ok()
            .flatten()
    }

    /// The on-disk path of a track, relative to the music root. Used by the
    /// streamer, which deliberately reads nothing else.
    pub fn track_rel_path(&self, id: i64) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT rel_path FROM tracks WHERE id = ?1 AND deleted = 0",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn track_count(&self) -> i64 {
        self.lock()
            .query_row("SELECT COUNT(*) FROM tracks WHERE deleted = 0", [], |r| r.get(0))
            .unwrap_or(0)
    }

    pub fn total_bytes(&self) -> i64 {
        self.lock()
            .query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM tracks WHERE deleted = 0",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    pub fn path_is_indexed(&self, rel_path: &str) -> bool {
        self.lock()
            .query_row(
                "SELECT 1 FROM tracks WHERE rel_path = ?1 AND deleted = 0",
                params![rel_path],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    // --- favourites -------------------------------------------------------

    pub fn favorites(&self, user_id: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT f.track_id FROM favorites f JOIN tracks t ON t.id = f.track_id
              WHERE f.user_id = ?1 AND t.deleted = 0 ORDER BY f.added_at DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| r.get(0))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn set_favorite(&self, user_id: i64, track_id: i64, on: bool) -> rusqlite::Result<()> {
        let conn = self.lock();
        if on {
            conn.execute(
                "INSERT OR IGNORE INTO favorites (user_id, track_id, added_at) VALUES (?1, ?2, ?3)",
                params![user_id, track_id, now_ms()],
            )?;
        } else {
            conn.execute(
                "DELETE FROM favorites WHERE user_id = ?1 AND track_id = ?2",
                params![user_id, track_id],
            )?;
        }
        Ok(())
    }

    // --- playlists --------------------------------------------------------

    pub fn create_playlist(&self, user_id: i64, name: &str) -> rusqlite::Result<i64> {
        let conn = self.lock();
        let now = now_ms();
        conn.execute(
            "INSERT INTO playlists (user_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![user_id, name, now],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Every playlist the user owns, each with its track ids in order.
    pub fn playlists(&self, user_id: i64) -> Vec<(i64, String, i64, Vec<i64>)> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT id, name, updated_at FROM playlists WHERE user_id = ?1 ORDER BY name")
        else {
            return Vec::new();
        };
        let heads: Vec<(i64, String, i64)> = stmt
            .query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default();
        drop(stmt);
        let Ok(mut items) = conn.prepare(
            "SELECT pt.track_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
              WHERE pt.playlist_id = ?1 AND t.deleted = 0 ORDER BY pt.position",
        ) else {
            return Vec::new();
        };
        heads
            .into_iter()
            .map(|(id, name, updated)| {
                let tracks: Vec<i64> = items
                    .query_map(params![id], |r| r.get(0))
                    .map(|r| r.filter_map(Result::ok).collect())
                    .unwrap_or_default();
                (id, name, updated, tracks)
            })
            .collect()
    }

    pub fn playlist_owner(&self, playlist_id: i64) -> Option<i64> {
        self.lock()
            .query_row(
                "SELECT user_id FROM playlists WHERE id = ?1",
                params![playlist_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Replaces a playlist's contents wholesale - the client owns the order, so
    /// an edit is a new list rather than a diff.
    pub fn set_playlist_tracks(&self, playlist_id: i64, track_ids: &[i64]) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
        for (position, track_id) in track_ids.iter().enumerate() {
            // A track that has since vanished is skipped rather than failing
            // the whole save.
            let _ = tx.execute(
                "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
                 VALUES (?1, ?2, ?3)",
                params![playlist_id, track_id, position as i64],
            );
        }
        tx.execute(
            "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
            params![playlist_id, now_ms()],
        )?;
        tx.commit()
    }

    pub fn rename_playlist(&self, playlist_id: i64, name: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE playlists SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![playlist_id, name, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_playlist(&self, playlist_id: i64) -> rusqlite::Result<()> {
        self.lock()
            .execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
        Ok(())
    }

    // --- resume positions -------------------------------------------------

    pub fn set_play_state(&self, user_id: i64, track_id: i64, position_ms: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO play_state (user_id, track_id, position_ms, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id, track_id) DO UPDATE SET
                 position_ms = excluded.position_ms, updated_at = excluded.updated_at",
            params![user_id, track_id, position_ms, now_ms()],
        )?;
        Ok(())
    }

    /// The most recent resume points, newest first - what a phone asks for when
    /// it wants to carry on where the desktop stopped.
    pub fn play_states(&self, user_id: i64, limit: i64) -> Vec<(i64, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT p.track_id, p.position_ms, p.updated_at
               FROM play_state p JOIN tracks t ON t.id = p.track_id
              WHERE p.user_id = ?1 AND t.deleted = 0
              ORDER BY p.updated_at DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }
}
