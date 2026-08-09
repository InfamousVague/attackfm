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


/// One user's Spotify link, as stored.
pub struct SpotifyAccountRow {
    pub client_id: String,
    pub refresh_token: String,
    pub access_token: Option<String>,
    pub expires_at: i64,
    pub display_name: Option<String>,
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

-- The listening log: one row per qualifying play (a track that ran past the
-- report threshold), append-only. What the home page's shelves and the mix
-- engine read taste from - play_state above is "where did I stop", this is
-- "what do I actually listen to".
CREATE TABLE IF NOT EXISTS spotify_accounts (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  access_token  TEXT,
  expires_at    INTEGER NOT NULL DEFAULT 0,
  display_name  TEXT
);

CREATE TABLE IF NOT EXISTS spotify_synced (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  snapshot TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS plays (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_user_time ON plays(user_id, played_at DESC);
-- Probed by unplayed()'s NOT EXISTS, which asks "did this user play THIS
-- track" - a lookup the time index above cannot serve.
CREATE INDEX IF NOT EXISTS plays_user_track ON plays(user_id, track_id);
-- The home shelves order live tracks by recency; without this the "new" and
-- "unplayed" shelves full-scan and filesort the library on every load.
CREATE INDEX IF NOT EXISTS tracks_added ON tracks(added_at DESC) WHERE deleted = 0;

-- What the curator has learned about a track beyond its tags: the tempo it
-- moves at, and a vector standing for what its words are about. Filled in
-- slowly by the background curator rather than at scan time - the tempo comes
-- off the public catalogue and the vector off a language model, and neither
-- should hold up indexing a folder of music.
--
-- A row exists as soon as a track has been LOOKED AT, with null columns where
-- the lookup found nothing, so the enricher can tell "not tried yet" from
-- "tried, nothing there" and stop asking about the same track forever.
CREATE TABLE IF NOT EXISTS track_features (
  track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  bpm        REAL,
  bpm_source TEXT NOT NULL DEFAULT '',
  -- Raw little-endian f32s; vec_dims says how many. A BLOB rather than a
  -- vector extension: a few hundred floats per track is nothing to scan, and
  -- it keeps the database a plain file anyone can copy.
  lyric_vec  BLOB,
  vec_dims   INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS features_checked ON track_features(checked_at);

-- The playlists the curator built for one listener, rebuilt in place on its
-- own schedule. Slug identifies the recipe ("tempo-lane"), so a rebuild
-- replaces the last one rather than piling up a new list every cycle.
CREATE TABLE IF NOT EXISTS curated (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug      TEXT NOT NULL,
  name      TEXT NOT NULL,
  blurb     TEXT NOT NULL DEFAULT '',
  -- JSON array of track ids, in the order the curator wants them heard.
  track_ids TEXT NOT NULL DEFAULT '[]',
  built_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug)
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

    /// The id of the track filed at this library-relative path, if indexed.
    /// The importer asks right after scan_one so a finished job can name the
    /// track ids it produced - what lets a client play an import on arrival.
    pub fn track_id_by_path(&self, rel_path: &str) -> Option<i64> {
        self.lock()
            .query_row("SELECT id FROM tracks WHERE rel_path = ?1", params![rel_path], |r| r.get(0))
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

    /// Drops every session token the account holds - the other half of a
    /// revoke. The epoch bump above kills stream tokens already minted, but a
    /// surviving session token would just mint a fresh one on the client's
    /// next `/api/me`, quietly undoing the revoke.
    pub fn delete_tokens_for_user(&self, user_id: i64) -> rusqlite::Result<()> {
        self.lock().execute("DELETE FROM tokens WHERE user_id = ?1", params![user_id])?;
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

    /// Every live track's identity - title, artist, album artist, album,
    /// duration - for the sync precheck to match a client's local files
    /// against. Tags rather than hashes: the same song re-ripped should read
    /// as already here, and nobody hashes forty gigabytes to ask that.
    pub fn sync_identities(&self) -> Vec<(String, String, String, String, Option<i64>)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT title, artist, album_artist, album, duration_ms FROM tracks WHERE deleted = 0",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
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
    /// The third value is the highest rev this page SAW - tombstones
    /// included. Folding tombstone revs in matters: a page of nothing but
    /// deletions once reported rev == since with more == true, which a
    /// paging client reads as "ask again from the same place", forever.
    pub fn tracks_since(&self, since: i64, limit: i64) -> (Vec<Track>, Vec<i64>, i64) {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks WHERE rev > ?1 ORDER BY rev, id LIMIT ?2",
            Self::TRACK_COLS
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return (Vec::new(), Vec::new(), since);
        };
        let mut live = Vec::new();
        let mut removed = Vec::new();
        let mut max_rev = since;
        let rows = stmt.query_map(params![since, limit], |r| {
            let deleted: i64 = r.get(10)?;
            Ok((deleted != 0, Self::read_track(r)?))
        });
        if let Ok(rows) = rows {
            for (is_deleted, track) in rows.filter_map(Result::ok) {
                max_rev = max_rev.max(track.rev);
                if is_deleted {
                    removed.push(track.id);
                } else {
                    live.push(track);
                }
            }
        }
        (live, removed, max_rev)
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

    // --- the listening log --------------------------------------------------

    /// Appends one qualifying play.
    pub fn record_play(&self, user_id: i64, track_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO plays (user_id, track_id, played_at) VALUES (?1, ?2, ?3)",
            params![user_id, track_id, now_ms()],
        )?;
        Ok(())
    }

    /// Distinct recently played live tracks, newest first.
    pub fn recent_plays(&self, user_id: i64, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT p.track_id FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0
             WHERE p.user_id = ?1 GROUP BY p.track_id ORDER BY MAX(p.played_at) DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The heavy rotation: most-played live tracks inside the window.
    pub fn top_plays(&self, user_id: i64, since_ms: i64, limit: i64) -> Vec<(i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT p.track_id, COUNT(*) AS n
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0
             WHERE p.user_id = ?1 AND p.played_at >= ?2
             GROUP BY p.track_id ORDER BY n DESC, MAX(p.played_at) DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since_ms, limit], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Play counts grouped by artist inside the window, most-played first -
    /// the compact taste summary the mix engine reasons from.
    pub fn top_artists(&self, user_id: i64, since_ms: i64, limit: i64) -> Vec<(String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            // NOCASE grouping so \"MF DOOM\" and \"MF Doom\" count as one artist -
            // matching tracks_by_artist's own NOCASE lookup, so the ranked
            // names and the tracks they resolve to never disagree.
            "SELECT t.artist, COUNT(*) AS n
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0
             WHERE p.user_id = ?1 AND p.played_at >= ?2
             GROUP BY t.artist COLLATE NOCASE ORDER BY n DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since_ms, limit], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Play counts grouped by genre inside the window, most-played first -
    /// blank genres skipped. Genres are often comma-joined ("Pop, R&B"); this
    /// counts the whole string as one bucket, which is enough to name a mix.
    pub fn top_genres(&self, user_id: i64, since_ms: i64, limit: i64) -> Vec<(String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.genre, COUNT(*) AS n
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0
             WHERE p.user_id = ?1 AND p.played_at >= ?2 AND TRIM(t.genre) <> ''
             GROUP BY t.genre ORDER BY n DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since_ms, limit], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Live tracks in a genre, newest first - genre-mix material.
    pub fn tracks_by_genre(&self, genre: &str, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM tracks WHERE deleted = 0 AND genre = ?1 COLLATE NOCASE
             ORDER BY added_at DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![genre, limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The albums behind the user's recent plays, newest touch first - each as
    /// its FULL ordered track-id list (disc then track). The server owns album
    /// identity and order here so the client never has to: it plays the list
    /// as given, which is what keeps two same-named albums by different artists
    /// from ever merging, and multi-disc albums in disc order.
    pub fn recent_album_track_lists(&self, user_id: i64, album_limit: i64) -> Vec<Vec<i64>> {
        let conn = self.lock();
        // The recent (album_artist, album) pairs, newest touch first. Collected
        // into owned strings so the statement is done before the per-album
        // queries below reuse the connection.
        let pairs: Vec<(String, String)> = {
            let Ok(mut stmt) = conn.prepare(
                "SELECT t.album_artist, t.album, MAX(p.played_at) AS last
                 FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0
                 WHERE p.user_id = ?1 AND TRIM(t.album) <> ''
                 GROUP BY t.album_artist, t.album ORDER BY last DESC LIMIT ?2",
            ) else {
                return Vec::new();
            };
            stmt.query_map(params![user_id, album_limit], |r| Ok((r.get(0)?, r.get(1)?)))
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default()
        };

        let mut out = Vec::new();
        for (album_artist, album) in pairs {
            let Ok(mut stmt) = conn.prepare(
                "SELECT id FROM tracks WHERE deleted = 0 AND album_artist = ?1 AND album = ?2
                 ORDER BY disc_no, track_no",
            ) else {
                continue;
            };
            let ids: Vec<i64> = stmt
                .query_map(params![album_artist, album], |r| r.get(0))
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default();
            if !ids.is_empty() {
                out.push(ids);
            }
        }
        out
    }

    /// Live tracks the user has NEVER logged a play for, newest additions
    /// first - the pool "fresh finds" and discovery mixes draw from.
    pub fn unplayed(&self, user_id: i64, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t WHERE t.deleted = 0
               AND NOT EXISTS (SELECT 1 FROM plays p WHERE p.user_id = ?1 AND p.track_id = t.id)
             ORDER BY t.added_at DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Newest live tracks by added_at, for the "recently added" shelf.
    pub fn recently_added(&self, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM tracks WHERE deleted = 0 ORDER BY added_at DESC LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every live track by an artist, album order - mix material.
    pub fn tracks_by_artist(&self, artist: &str, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM tracks WHERE deleted = 0 AND artist = ?1 COLLATE NOCASE
             ORDER BY album, disc_no, track_no LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![artist, limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

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

    // --- Spotify account link ---------------------------------------------

    pub fn spotify_account(&self, user_id: i64) -> Option<SpotifyAccountRow> {
        self.lock()
            .query_row(
                "SELECT client_id, refresh_token, access_token, expires_at, display_name
                   FROM spotify_accounts WHERE user_id = ?1",
                params![user_id],
                |r| {
                    Ok(SpotifyAccountRow {
                        client_id: r.get(0)?,
                        refresh_token: r.get(1)?,
                        access_token: r.get(2)?,
                        expires_at: r.get(3)?,
                        display_name: r.get(4)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn spotify_save_account(
        &self,
        user_id: i64,
        client_id: &str,
        refresh_token: &str,
        access_token: &str,
        expires_at: i64,
        display_name: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO spotify_accounts (user_id, client_id, refresh_token, access_token, expires_at, display_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id) DO UPDATE SET
                 client_id = excluded.client_id, refresh_token = excluded.refresh_token,
                 access_token = excluded.access_token, expires_at = excluded.expires_at,
                 display_name = excluded.display_name",
            params![user_id, client_id, refresh_token, access_token, expires_at, display_name],
        )?;
        Ok(())
    }

    /// Refresh-token rotation: persisted before the new access token is used.
    pub fn spotify_update_tokens(
        &self,
        user_id: i64,
        refresh_token: &str,
        access_token: &str,
        expires_at: i64,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE spotify_accounts SET refresh_token = ?2, access_token = ?3, expires_at = ?4
              WHERE user_id = ?1",
            params![user_id, refresh_token, access_token, expires_at],
        )?;
        Ok(())
    }

    /// Disconnect keeps the client id and the sync bookkeeping - a reconnect
    /// should pick up where the account left off, not re-list everything new.
    pub fn spotify_clear_tokens(&self, user_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE spotify_accounts SET refresh_token = '', access_token = NULL, expires_at = 0, display_name = NULL
              WHERE user_id = ?1",
            params![user_id],
        )?;
        Ok(())
    }

    pub fn spotify_synced(&self, user_id: i64) -> std::collections::HashMap<String, String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT key, snapshot FROM spotify_synced WHERE user_id = ?1")
        else {
            return Default::default();
        };
        stmt.query_map(params![user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn spotify_mark_synced(&self, user_id: i64, key: &str, snapshot: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO spotify_synced (user_id, key, snapshot) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, key) DO UPDATE SET snapshot = excluded.snapshot",
            params![user_id, key, snapshot],
        )?;
        Ok(())
    }
    // --- what the curator knows ----------------------------------------------

    /// Title, artist, genre and lyric length for a set of tracks - what the
    /// enricher needs to look a track up and what a prompt needs to describe
    /// it. Only live tracks come back.
    pub fn tracks_for_curation(&self, ids: &[i64]) -> Vec<CurationTrack> {
        if ids.is_empty() {
            return Vec::new();
        }
        let conn = self.lock();
        let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id, title, artist, album, genre, lyrics, duration_ms
             FROM tracks WHERE deleted = 0 AND id IN ({list})"
        );
        let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
        stmt.query_map([], |r| {
            Ok(CurationTrack {
                id: r.get(0)?,
                title: r.get(1)?,
                artist: r.get(2)?,
                album: r.get(3)?,
                genre: r.get(4)?,
                lyrics: r.get(5)?,
                duration_ms: r.get(6)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// The next tracks the enricher should look at: never-seen ones first,
    /// then any whose lookup is older than `stale_before`. Bounded so one
    /// pass over a big library is many small, resumable batches.
    /// `stale_before` retires a full lookup; `empty_before` retires one that
    /// came back with nothing at all. The second is much sooner on purpose: a
    /// track with neither tempo nor vector learned nothing, and the reason is
    /// as often a bad query or a model that was not up yet as it is a track the
    /// world does not know.
    pub fn tracks_needing_features(
        &self,
        limit: i64,
        stale_before: i64,
        empty_before: i64,
    ) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t
             LEFT JOIN track_features f ON f.track_id = t.id
             WHERE t.deleted = 0 AND (
                 f.track_id IS NULL
                 OR f.checked_at < ?2
                 OR (f.bpm IS NULL AND f.vec_dims = 0 AND f.checked_at < ?3)
             )
             ORDER BY f.checked_at IS NOT NULL, f.checked_at ASC, t.added_at DESC
             LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit, stale_before, empty_before], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Records what the lookup found. Nulls are a real answer ("looked, found
    /// nothing"); the stamp is what stops the enricher asking again tomorrow.
    /// A vector already stored is kept when this pass did not compute one, so
    /// a tempo refresh never throws away an embedding.
    pub fn save_features(
        &self,
        track_id: i64,
        bpm: Option<f64>,
        bpm_source: &str,
        lyric_vec: Option<&[f32]>,
    ) -> rusqlite::Result<()> {
        let blob: Option<Vec<u8>> =
            lyric_vec.map(|v| v.iter().flat_map(|f| f.to_le_bytes()).collect());
        let dims = lyric_vec.map(|v| v.len() as i64).unwrap_or(0);
        self.lock().execute(
            "INSERT INTO track_features (track_id, bpm, bpm_source, lyric_vec, vec_dims, checked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(track_id) DO UPDATE SET
               bpm        = COALESCE(excluded.bpm, track_features.bpm),
               bpm_source = CASE WHEN excluded.bpm IS NULL THEN track_features.bpm_source
                                 ELSE excluded.bpm_source END,
               lyric_vec  = COALESCE(excluded.lyric_vec, track_features.lyric_vec),
               vec_dims   = CASE WHEN excluded.lyric_vec IS NULL THEN track_features.vec_dims
                                 ELSE excluded.vec_dims END,
               checked_at = excluded.checked_at",
            params![track_id, bpm, bpm_source, blob, dims, now_ms()],
        )?;
        Ok(())
    }

    /// Every live track's features, for the pass that scores a whole library
    /// against a taste. A few hundred floats per track: cheap to hold, and the
    /// alternative (a query per candidate) is far worse.
    pub fn all_features(&self) -> Vec<TrackFeatures> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT f.track_id, f.bpm, f.lyric_vec, f.vec_dims, t.genre, t.artist
             FROM track_features f JOIN tracks t ON t.id = f.track_id AND t.deleted = 0",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            let blob: Option<Vec<u8>> = r.get(2)?;
            let dims: i64 = r.get(3)?;
            let vec = blob.filter(|b| dims > 0 && b.len() == dims as usize * 4).map(|b| {
                b.chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect::<Vec<f32>>()
            });
            Ok(TrackFeatures {
                track_id: r.get(0)?,
                bpm: r.get(1)?,
                lyric_vec: vec,
                genre: r.get(4)?,
                artist: r.get(5)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// The spread of tempos the curator has measured: (min, median, max).
    /// What makes the numbers checkable - a library whose every track came
    /// back at one value would be an analyser reading noise, not a taste.
    pub fn tempo_spread(&self) -> Option<(f64, f64, f64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT f.bpm FROM track_features f JOIN tracks t ON t.id = f.track_id
             AND t.deleted = 0 WHERE f.bpm IS NOT NULL ORDER BY f.bpm",
        ) else {
            return None;
        };
        let all: Vec<f64> = stmt
            .query_map([], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default();
        if all.is_empty() {
            return None;
        }
        Some((all[0], all[all.len() / 2], all[all.len() - 1]))
    }

    /// How far the enrichment has got: (tracks looked at, with a tempo, with a
    /// vector, total live tracks).
    pub fn feature_counts(&self) -> (i64, i64, i64, i64) {
        let conn = self.lock();
        let one = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
        (
            one("SELECT COUNT(*) FROM track_features f JOIN tracks t ON t.id = f.track_id AND t.deleted = 0"),
            one("SELECT COUNT(*) FROM track_features f JOIN tracks t ON t.id = f.track_id AND t.deleted = 0 WHERE f.bpm IS NOT NULL"),
            one("SELECT COUNT(*) FROM track_features f JOIN tracks t ON t.id = f.track_id AND t.deleted = 0 WHERE f.vec_dims > 0"),
            one("SELECT COUNT(*) FROM tracks WHERE deleted = 0"),
        )
    }

    // --- the curator's playlists ---------------------------------------------

    /// Everyone who has listened since `since_ms` - who the curator builds for.
    pub fn listeners_since(&self, since_ms: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT DISTINCT user_id FROM plays WHERE played_at >= ?1")
        else {
            return Vec::new();
        };
        stmt.query_map(params![since_ms], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Writes one curated list, replacing whatever that recipe built last time.
    pub fn put_curated(
        &self,
        user_id: i64,
        slug: &str,
        name: &str,
        blurb: &str,
        track_ids: &[i64],
    ) -> rusqlite::Result<()> {
        let json = serde_json::to_string(track_ids).unwrap_or_else(|_| "[]".into());
        self.lock().execute(
            "INSERT INTO curated (user_id, slug, name, blurb, track_ids, built_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id, slug) DO UPDATE SET
               name = excluded.name, blurb = excluded.blurb,
               track_ids = excluded.track_ids, built_at = excluded.built_at",
            params![user_id, slug, name, blurb, json, now_ms()],
        )?;
        Ok(())
    }

    /// One listener's curated lists, newest build first.
    pub fn curated_for(&self, user_id: i64) -> Vec<CuratedList> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT slug, name, blurb, track_ids, built_at FROM curated
             WHERE user_id = ?1 ORDER BY built_at DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| {
            let raw: String = r.get(3)?;
            Ok(CuratedList {
                slug: r.get(0)?,
                name: r.get(1)?,
                blurb: r.get(2)?,
                track_ids: serde_json::from_str(&raw).unwrap_or_default(),
                built_at: r.get(4)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }
}

/// A track as the curator reads it, for looking up and for describing.
pub struct CurationTrack {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub lyrics: String,
    pub duration_ms: Option<i64>,
}

/// What is known about one track's sound and words.
pub struct TrackFeatures {
    pub track_id: i64,
    pub bpm: Option<f64>,
    pub lyric_vec: Option<Vec<f32>>,
    pub genre: String,
    pub artist: String,
}

/// One playlist the curator built.
pub struct CuratedList {
    pub slug: String,
    pub name: String,
    pub blurb: String,
    pub track_ids: Vec<i64>,
    pub built_at: i64,
}
