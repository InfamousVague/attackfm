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

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpecificTagCandidate {
    pub canonical_tag: String,
    pub description: String,
    pub status: String,
    pub usage_count: i64,
    pub similarity: f32,
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
    /// Set when the COLLECTOR downloaded this track rather than a person: the
    /// account it was fetched for. Such a track auditions on that account's
    /// For-you shelf until `curator_promoted` - a completed listen or a heart
    /// - moves it into the library proper. Null for everything a person added.
    #[serde(rename = "curatorUserId")]
    pub curator_user_id: Option<i64>,
    #[serde(rename = "curatorPromoted")]
    pub curator_promoted: bool,
    /// 'music' or 'book' - which shelf this row belongs to. Books are kept out
    /// of every music surface (mixes, shuffle, search, the curator's taste),
    /// and the audiobooks page shows exactly and only them.
    pub kind: String,
    /// Chapter markers for a single-file audiobook - `[{title, startMs}]` in
    /// reading order, an empty array for everything else. Derived from the file
    /// at scan (ffprobe), so it survives a re-scan and needs no separate sync.
    pub chapters: serde_json::Value,
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
    /// Chapter markers as a JSON string (`[{title, startMs}]`), empty when the
    /// file carries none. The scanner fills it for single-file audiobooks.
    pub chapters: String,
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

/// A live track's identity, carrying the id the matcher needs to report.
pub struct MatchRow {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub duration_ms: Option<i64>,
}

/// One watched Spotify collection and where its mirror stands.
#[derive(Clone)]
pub struct MirrorHead {
    pub key: String,
    pub kind: String,
    pub spotify_id: String,
    pub playlist_id: Option<i64>,
    pub name: String,
    pub owner: String,
    pub image: String,
    pub snapshot: String,
    pub head_snapshot: String,
    pub watch: bool,
    pub state: String,
    pub error: String,
    pub total: i64,
    pub resolved: i64,
    pub queued: i64,
    pub missing: i64,
    pub ambiguous: i64,
    pub local_name: String,
    pub resolved_rev: i64,
    pub next_check: i64,
    pub checked_at: i64,
    pub synced_at: i64,
}

/// One entry in a mirrored collection.
#[derive(Clone)]
pub struct MirrorItem {
    pub track_uid: String,
    pub occurrence: i64,
    pub position: i64,
    pub isrc: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub duration_ms: Option<i64>,
    pub added_at: i64,
    pub track_id: Option<i64>,
    pub match_method: String,
    pub state: String,
    pub attempts: i64,
    pub next_try_at: i64,
    pub job_id: String,
    pub note: String,
}

#[derive(Clone, Copy, Default)]
pub struct MirrorCounts {
    pub total: i64,
    pub resolved: i64,
    pub queued: i64,
    pub missing: i64,
    pub ambiguous: i64,
}

const MIRROR_COLS: &str = "key, kind, spotify_id, playlist_id, name, owner, image, snapshot, \
     head_snapshot, watch, state, error, total, resolved, queued, missing, ambiguous, \
     local_name, resolved_rev, next_check, checked_at, synced_at";

fn mirror_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MirrorHead> {
    Ok(MirrorHead {
        key: r.get(0)?,
        kind: r.get(1)?,
        spotify_id: r.get(2)?,
        playlist_id: r.get(3)?,
        name: r.get(4)?,
        owner: r.get(5)?,
        image: r.get(6)?,
        snapshot: r.get(7)?,
        head_snapshot: r.get(8)?,
        watch: r.get::<_, i64>(9)? != 0,
        state: r.get(10)?,
        error: r.get(11)?,
        total: r.get(12)?,
        resolved: r.get(13)?,
        queued: r.get(14)?,
        missing: r.get(15)?,
        ambiguous: r.get(16)?,
        local_name: r.get(17)?,
        resolved_rev: r.get(18)?,
        next_check: r.get(19)?,
        checked_at: r.get(20)?,
        synced_at: r.get(21)?,
    })
}

const ITEM_COLS: &str = "track_uid, occurrence, position, isrc, title, artist, album, \
     album_artist, duration_ms, added_at, track_id, match_method, state, attempts, next_try_at, \
     job_id, note";

fn item_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MirrorItem> {
    Ok(MirrorItem {
        track_uid: r.get(0)?,
        occurrence: r.get(1)?,
        position: r.get(2)?,
        isrc: r.get(3)?,
        title: r.get(4)?,
        artist: r.get(5)?,
        album: r.get(6)?,
        album_artist: r.get(7)?,
        duration_ms: r.get(8)?,
        added_at: r.get(9)?,
        track_id: r.get(10)?,
        match_method: r.get(11)?,
        state: r.get(12)?,
        attempts: r.get(13)?,
        next_try_at: r.get(14)?,
        job_id: r.get(15)?,
        note: r.get(16)?,
    })
}

/// How much a pin is trusted. A stored pin is only replaced by a strictly
/// higher rank, so a listener's correction outlives every later guess.
fn ext_method_rank(method: &str) -> i64 {
    match method {
        "manual" => 4,
        "download" | "isrc" => 3,
        "strict" => 2,
        _ => 1,
    }
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

-- The bridge to central identity: a registry account (its id is the token's
-- `sub`) mapped to the local user row that carries this person's playlists,
-- favourites and history on THIS server. One row per member. This is how an
-- invited friend enters under their OWN account instead of the owner's - the
-- bug this whole re-architecture exists to kill.
CREATE TABLE IF NOT EXISTS registry_members (
  registry_sub INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle       TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
  joined_at    INTEGER NOT NULL
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
  sonic_vec BLOB,
  sonic_vec_dims INTEGER NOT NULL DEFAULT 0,
  lyrical_vec BLOB,
  lyrical_vec_dims INTEGER NOT NULL DEFAULT 0,
  community_vec BLOB,
  community_vec_dims INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0,
  -- The audio analyser's half (features.rs): character measured off the file
  -- itself, on its own clock - `analyzed_at` of 0 is "not measured yet", the
  -- way `checked_at` works for the enricher above. Nullable so the curator's
  -- inserts stay valid. On a database that predates them these four arrive
  -- via migrate(), since IF NOT EXISTS skips a table that already exists.
  energy      REAL,
  brightness  REAL,
  loudness    REAL,
  dynamic_range REAL,
  rhythmic_activity REAL,
  audio_fingerprint BLOB,
  audio_fingerprint_dims INTEGER NOT NULL DEFAULT 0,
  audio_fingerprint_version INTEGER NOT NULL DEFAULT 0,
  analyzed_at INTEGER NOT NULL DEFAULT 0,
  ai_summary  TEXT NOT NULL DEFAULT '',
  ai_genres   TEXT NOT NULL DEFAULT '',
  ai_vibes    TEXT NOT NULL DEFAULT '',
  ai_sonic_traits TEXT NOT NULL DEFAULT '',
  ai_lyrical_themes TEXT NOT NULL DEFAULT '',
  ai_confidence REAL NOT NULL DEFAULT 0,
  ai_sources TEXT NOT NULL DEFAULT '',
  external_tags TEXT NOT NULL DEFAULT '',
  musicbrainz_id TEXT NOT NULL DEFAULT '',
  listenbrainz_similar TEXT NOT NULL DEFAULT '',
  listenbrainz_listens INTEGER NOT NULL DEFAULT 0,
  listenbrainz_listeners INTEGER NOT NULL DEFAULT 0,
  listenbrainz_checked_at INTEGER NOT NULL DEFAULT 0,
  ai_enriched_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS features_checked ON track_features(checked_at);

-- Layered semantic enrichment. The old ai_* columns above remain a canonical
-- compatibility projection while clients and ranking code migrate gradually.
CREATE TABLE IF NOT EXISTS song_profile_layers (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 3,
  fast_profile TEXT NOT NULL DEFAULT '',
  refinement_patch TEXT NOT NULL DEFAULT '',
  canonical_profile TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '',
  fast_model TEXT NOT NULL DEFAULT '',
  fast_prompt_version TEXT NOT NULL DEFAULT '',
  fast_created_at INTEGER NOT NULL DEFAULT 0,
  refinement_model TEXT NOT NULL DEFAULT '',
  refinement_prompt_version TEXT NOT NULL DEFAULT '',
  refined_at INTEGER NOT NULL DEFAULT 0,
  migrated_from TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS song_profiles_fast_queue ON song_profile_layers(fast_created_at);
CREATE INDEX IF NOT EXISTS song_profiles_refine_queue ON song_profile_layers(refined_at);

-- A deliberately small, learned vocabulary for open-ended music descriptors.
-- Model wording is never destroyed: aliases retain the observed phrase while
-- canonical tags become stable discovery keys. New concepts begin provisional
-- and earn established status through repeated use.
CREATE TABLE IF NOT EXISTS specific_tag_registry (
  id INTEGER PRIMARY KEY,
  canonical_tag TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  embedding BLOB,
  embedding_dims INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'provisional',
  usage_count INTEGER NOT NULL DEFAULT 0,
  track_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS specific_tag_aliases (
  normalized_alias TEXT PRIMARY KEY,
  raw_alias TEXT NOT NULL,
  tag_id INTEGER NOT NULL REFERENCES specific_tag_registry(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS track_specific_tag_evidence (
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  raw_tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  canonical_tag TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL,
  candidate_tags TEXT NOT NULL DEFAULT '[]',
  decided_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(track_id, raw_tag)
);
CREATE INDEX IF NOT EXISTS specific_tags_status_usage ON specific_tag_registry(status,usage_count DESC);

-- Personal, human DJ judgement. Enrichment refreshes never overwrite it.
CREATE TABLE IF NOT EXISTS track_dj_notes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

-- Music this listener does NOT own, harvested from the public catalogue and
-- scored against their taste the same way their own library is. A row is a
-- candidate, enriched slowly: lyrics from lrclib, tempo measured off the
-- catalogue's thirty-second preview, then a score. `checked_at` of 0 means
-- "harvested, not yet listened to".
CREATE TABLE IF NOT EXISTS discoveries (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The catalogue's own id, e.g. "deezer:track:12345".
  ext_id     TEXT NOT NULL,
  title      TEXT NOT NULL,
  artist     TEXT NOT NULL,
  cover      TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  preview    TEXT NOT NULL DEFAULT '',
  -- Why it was surfaced: the artist of yours it hangs off.
  seed       TEXT NOT NULL DEFAULT '',
  -- How well the catalogue thinks it does, 0-1 within this harvest.
  popularity REAL NOT NULL DEFAULT 0,
  bpm        REAL,
  lyric_vec  BLOB,
  vec_dims   INTEGER NOT NULL DEFAULT 0,
  score      REAL NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0,
  found_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, ext_id)
);
CREATE INDEX IF NOT EXISTS discoveries_score ON discoveries(user_id, score DESC);

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

-- A stable external identity for a local track, as a sidecar rather than a
-- column on `tracks`: open() is execute_batch(SCHEMA) and nothing else, so a
-- new TABLE lands on the deployed database and a new COLUMN silently never
-- would. Global rather than per-user because the library itself is shared -
-- a song one listener resolved is resolved for everyone, no second download
-- and no second fuzzy match.
--
-- Keyed on track_id, so a pin survives re-tagging; and because upsert_track
-- conflicts on rel_path it survives a re-scan too. Every read joins tracks
-- and checks deleted = 0, so a pin whose target was tombstoned reads as
-- unresolved and is re-run rather than pointing at a ghost.
CREATE TABLE IF NOT EXISTS track_ext_ids (
  source     TEXT    NOT NULL,          -- 'spotify' (bare id) | 'isrc'
  ext_id     TEXT    NOT NULL,
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  -- How it was decided, RANKED. A pin may only be replaced by a strictly
  -- better one: manual > download = isrc > strict > loose. That ranking is
  -- what makes a correction permanent while still letting a later ISRC read
  -- upgrade an earlier loose guess.
  method     TEXT    NOT NULL DEFAULT 'loose',
  matched_by TEXT    NOT NULL DEFAULT '',
  linked_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, ext_id)
);
CREATE INDEX IF NOT EXISTS track_ext_ids_track ON track_ext_ids(track_id);

-- One watched Spotify collection <-> one local playlist. `key` reuses the
-- convention spotify_synced already composes ('playlist:{id}' | 'album:{id}'
-- | 'liked'), so the new tables need no translation against old bookkeeping.
--
-- playlist_id is ON DELETE SET NULL, not CASCADE: deleting the local playlist
-- unlinks it and the next sync builds a fresh one, rather than throwing away
-- the resolution work. No column is added to `playlists`.
CREATE TABLE IF NOT EXISTS spotify_mirrors (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT    NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'playlist',
  spotify_id    TEXT    NOT NULL DEFAULT '',
  playlist_id   INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL DEFAULT '',
  owner         TEXT    NOT NULL DEFAULT '',
  image         TEXT    NOT NULL DEFAULT '',
  collaborative INTEGER NOT NULL DEFAULT 0,
  public        INTEGER NOT NULL DEFAULT 0,
  -- The snapshot whose items are FULLY mirrored below. For 'liked' (saved
  -- tracks carry no snapshot_id) this is a synthesized "{total}:{newest}".
  snapshot      TEXT    NOT NULL DEFAULT '',
  -- The snapshot last SEEN by the cheap one-request head poll. head_snapshot
  -- != snapshot is exactly "changed", decided on the server with no client
  -- assertion involved.
  head_snapshot TEXT    NOT NULL DEFAULT '',
  watch         INTEGER NOT NULL DEFAULT 0,
  -- idle | enumerating | resolving | downloading | partial | synced | error
  state         TEXT    NOT NULL DEFAULT 'idle',
  error         TEXT    NOT NULL DEFAULT '',
  -- Durable counters, so the progress surface survives a restart and reads
  -- the same on every device.
  total         INTEGER NOT NULL DEFAULT 0,
  resolved      INTEGER NOT NULL DEFAULT 0,
  queued        INTEGER NOT NULL DEFAULT 0,
  missing       INTEGER NOT NULL DEFAULT 0,
  ambiguous     INTEGER NOT NULL DEFAULT 0,
  -- The name last WRITTEN onto playlists.name. If the live name has drifted
  -- from this, the listener renamed it and upstream must not clobber that.
  local_name    TEXT    NOT NULL DEFAULT '',
  detached_at   INTEGER NOT NULL DEFAULT 0,
  -- current_rev() at the last resolve pass. When the library rev moves past
  -- it, the unresolved rows are worth another run: new files may satisfy
  -- them for free.
  resolved_rev  INTEGER NOT NULL DEFAULT 0,
  next_check    INTEGER NOT NULL DEFAULT 0,
  backoff_secs  INTEGER NOT NULL DEFAULT 900,
  checked_at    INTEGER NOT NULL DEFAULT 0,
  synced_at     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS spotify_mirrors_due   ON spotify_mirrors(watch, next_check);
CREATE INDEX IF NOT EXISTS spotify_mirrors_local ON spotify_mirrors(playlist_id);

-- One row per playlist ENTRY, keyed by (track_uid, occurrence) rather than by
-- position. That is load-bearing: an upstream reorder rewrites `position`
-- while track_id - the expensive thing - survives untouched. `occurrence`
-- exists because Spotify permits the same track twice in one playlist.
--
-- No foreign key on track_id on purpose: a tombstoned track must not erase
-- mirror history. Validity is re-checked at materialize time.
CREATE TABLE IF NOT EXISTS spotify_items (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,
  -- Bare Spotify track id, preferring linked_from.id so the uid is stable
  -- across markets. 'local:{position}' for local-file entries, which have no
  -- id and resolve straight to 'unavailable'.
  track_uid    TEXT    NOT NULL,
  occurrence   INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL,
  isrc         TEXT    NOT NULL DEFAULT '',
  title        TEXT    NOT NULL DEFAULT '',
  artist       TEXT    NOT NULL DEFAULT '',
  album        TEXT    NOT NULL DEFAULT '',
  album_artist TEXT    NOT NULL DEFAULT '',
  duration_ms  INTEGER,
  added_at     INTEGER NOT NULL DEFAULT 0,
  track_id     INTEGER,
  match_method TEXT    NOT NULL DEFAULT '',
  -- pending | resolved | queued | missing | ambiguous | unavailable | ignored
  state        TEXT    NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  -- Backoff ladder: 1h, 6h, 24h, 7d, then dormant until an explicit retry, so
  -- a track no provider carries stops being fetched forever.
  next_try_at  INTEGER NOT NULL DEFAULT 0,
  job_id       TEXT    NOT NULL DEFAULT '',
  note         TEXT    NOT NULL DEFAULT '',
  updated_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key, track_uid, occurrence)
);
CREATE INDEX IF NOT EXISTS spotify_items_order ON spotify_items(user_id, key, position);
CREATE INDEX IF NOT EXISTS spotify_items_due   ON spotify_items(state, next_try_at);
CREATE INDEX IF NOT EXISTS spotify_items_job   ON spotify_items(job_id);

-- Free while we are here: "which playlists hold this track" and every cascade
-- check on a track delete currently full-scan, since the only index on
-- playlist_tracks is its (playlist_id, position) primary key.
CREATE INDEX IF NOT EXISTS playlist_tracks_track ON playlist_tracks(track_id);

-- Friends. A request is one row that exists until it is answered; a
-- friendship is one row, not two, with the lower id always in a_id so
-- "are these two friends" is a single primary-key lookup rather than an OR
-- over both orderings.
CREATE TABLE IF NOT EXISTS friend_requests (
  id         INTEGER PRIMARY KEY,
  from_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  -- One pending ask per direction: asking twice is the same ask.
  UNIQUE(from_user, to_user)
);
CREATE INDEX IF NOT EXISTS friend_requests_to   ON friend_requests(to_user);
CREATE INDEX IF NOT EXISTS friend_requests_from ON friend_requests(from_user);

CREATE TABLE IF NOT EXISTS friendships (
  a_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  since INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships(b_id);

-- The registry: identities that outlive any one server.
--
-- Everything above this line is about accounts on THIS box. A registry
-- account is the other thing: a handle a person claims once and carries
-- between instances, so two people who each run their own AttackFM can find
-- each other at all. It is deliberately a separate table from `users` - the
-- same person has a local login AND a handle, and conflating them would mean
-- your friends list broke every time you moved servers.
CREATE TABLE IF NOT EXISTS registry_accounts (
  id         INTEGER PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash  TEXT NOT NULL,
  -- Where this person's library answers, announced by their own app. Empty
  -- until they have announced once; a friend with no address can be added
  -- but not reached.
  server_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS registry_tokens (
  token      TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES registry_accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_tokens_account ON registry_tokens(account_id);

CREATE TABLE IF NOT EXISTS registry_requests (
  id         INTEGER PRIMARY KEY,
  from_id    INTEGER NOT NULL REFERENCES registry_accounts(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES registry_accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id)
);
CREATE INDEX IF NOT EXISTS registry_requests_to ON registry_requests(to_id);

-- One row per pair, lower id first. `a_shares`/`b_shares` are what each side
-- has agreed to hand the other, as a comma-separated set of
-- catalog|playlists|liked|stats - stored per DIRECTION, because sharing is
-- not symmetric: letting someone into your library is not agreeing to be in
-- theirs.
CREATE TABLE IF NOT EXISTS registry_friendships (
  a_id     INTEGER NOT NULL REFERENCES registry_accounts(id) ON DELETE CASCADE,
  b_id     INTEGER NOT NULL REFERENCES registry_accounts(id) ON DELETE CASCADE,
  since    INTEGER NOT NULL,
  a_shares TEXT NOT NULL DEFAULT '',
  b_shares TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (a_id, b_id)
);
CREATE INDEX IF NOT EXISTS registry_friendships_b ON registry_friendships(b_id);

-- What a person's library looks like from outside, refreshed when their app
-- announces. Cached here so a friends list can show every friend's numbers
-- without waking every friend's server.
CREATE TABLE IF NOT EXISTS registry_stats (
  account_id INTEGER PRIMARY KEY REFERENCES registry_accounts(id) ON DELETE CASCADE,
  songs      INTEGER NOT NULL DEFAULT 0,
  playlists  INTEGER NOT NULL DEFAULT 0,
  liked      INTEGER NOT NULL DEFAULT 0,
  artists    INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- A device that has asked to be told things: one row per (listener, token).
-- The token is APNs's, opaque here, and rotates on the device's own schedule -
-- so it is the key rather than a device id, and a rotated token simply
-- registers again alongside the old one. APNs tells us when a token is dead
-- (410 Gone); `retire_push_token` is what deletes it, so nothing here has to
-- guess at liveness.
CREATE TABLE IF NOT EXISTS push_devices (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token     TEXT    NOT NULL,
  platform  TEXT    NOT NULL DEFAULT 'ios',
  label     TEXT    NOT NULL DEFAULT '',
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, token)
);

-- What each listener wants to hear about. A row per (listener, kind) rather
-- than a column per kind, because a new kind of notification must be able to
-- land on a deployed database - see the note above about columns.
--
-- ABSENT means on. Notifications a listener has never expressed a view about
-- should work; only an explicit 0 silences one. That way adding a kind does
-- not require back-filling every existing listener to make it function.
CREATE TABLE IF NOT EXISTS push_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL,      -- 'curated' | 'drops' | 'friends' | 'digest'
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind)
);

-- When each kind last went out to each listener. The digest reads it to know
-- whether a few days have passed, and every kind reads it to avoid sending the
-- same thing twice when a trigger fires repeatedly.
CREATE TABLE IF NOT EXISTS push_sent (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- The library's full-text index: an external-content FTS5 mirror of `tracks`,
-- so a search reads the index and joins back for the row. External content
-- rather than a copy because the lyrics column alone would double the file.
-- The triggers keep it in step with every write, tombstones included - a
-- tombstone is an UPDATE here, so the row stays indexed and every search
-- filters deleted = 0 on the way out, like every other read.
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title, artist, album_artist, album, genre, lyrics,
  content='tracks', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS tracks_fts_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts (rowid, title, artist, album_artist, album, genre, lyrics)
  VALUES (new.id, new.title, new.artist, new.album_artist, new.album, new.genre, new.lyrics);
END;
CREATE TRIGGER IF NOT EXISTS tracks_fts_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts (tracks_fts, rowid, title, artist, album_artist, album, genre, lyrics)
  VALUES ('delete', old.id, old.title, old.artist, old.album_artist, old.album, old.genre, old.lyrics);
END;
CREATE TRIGGER IF NOT EXISTS tracks_fts_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts (tracks_fts, rowid, title, artist, album_artist, album, genre, lyrics)
  VALUES ('delete', old.id, old.title, old.artist, old.album_artist, old.album, old.genre, old.lyrics);
  INSERT INTO tracks_fts (rowid, title, artist, album_artist, album, genre, lyrics)
  VALUES (new.id, new.title, new.artist, new.album_artist, new.album, new.genre, new.lyrics);
END;

-- What each listener searched for and actually opened, kept on the server so
-- every device shows the same short memory. Denormalised on purpose: kind+key
-- name the thing (a local track, an external album, an artist page), and
-- title, subtitle, cover and url are enough to draw it - the server only
-- remembers, it never interprets.
CREATE TABLE IF NOT EXISTS search_recents (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT    NOT NULL,
  key      TEXT    NOT NULL,
  title    TEXT    NOT NULL,
  subtitle TEXT    NOT NULL DEFAULT '',
  cover    TEXT    NOT NULL DEFAULT '',
  url      TEXT    NOT NULL DEFAULT '',
  at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, key)
);
CREATE INDEX IF NOT EXISTS search_recents_time ON search_recents(user_id, at DESC);

-- What actually got listened to, event by event: one row per playback the
-- client reports, append-only. Deliberately denormalised - title, artist,
-- album and genre are snapshotted from the track at insert time, and track_id
-- carries NO foreign key - because a listening history must outlive the
-- library it was heard from: tracks get retagged, evicted for quota, and
-- re-imported under new ids, and none of that should subtract minutes from
-- last year. `plays` above is the home feed's cheap signal ("this counted");
-- this is the full account ("how long, finished or skipped, from where"),
-- which is what the stats surface reads.
CREATE TABLE IF NOT EXISTS listen_events (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  album       TEXT NOT NULL,
  genre       TEXT NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  ms_listened INTEGER NOT NULL,
  duration_ms INTEGER,
  completed   INTEGER NOT NULL,
  skipped     INTEGER NOT NULL,
  context     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS listen_events_user_time ON listen_events(user_id, started_at DESC);
-- Probed by the "new to you" count's NOT EXISTS, which asks "had this user
-- ever played THIS track" - the same lookup shape plays_user_track serves.
CREATE INDEX IF NOT EXISTS listen_events_user_track ON listen_events(user_id, track_id);

-- The collector's ledger (collector.rs): every autonomous download it has
-- raised, from the moment it chose one through landing, adoption or failure.
-- One row per (user, catalogue id) forever - the UNIQUE is also the memory
-- that stops the same candidate being bought twice.
CREATE TABLE IF NOT EXISTS curator_pulls (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ext_id     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'track',
  title      TEXT NOT NULL,
  artist     TEXT NOT NULL,
  url        TEXT NOT NULL,
  -- Why the curator chose it - the model's one line when there is a model,
  -- the seed artist's when there is not.
  reason     TEXT NOT NULL DEFAULT '',
  score      REAL NOT NULL DEFAULT 0,
  job_id     TEXT NOT NULL DEFAULT '',
  -- queued | landed | promoted | failed
  state      TEXT NOT NULL DEFAULT 'queued',
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, ext_id)
);
CREATE INDEX IF NOT EXISTS curator_pulls_user_time ON curator_pulls(user_id, created_at DESC);

-- Which library rows a landed pull became - what lets an adoption find its
-- pull, and a pull report its real size.
CREATE TABLE IF NOT EXISTS curator_pull_tracks (
  pull_id  INTEGER NOT NULL REFERENCES curator_pulls(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL,
  PRIMARY KEY (pull_id, track_id)
);

-- The collector's per-listener dials. A row appears the first time a dial is
-- touched or tuned; absence means the defaults (enabled, exploration 0.5).
CREATE TABLE IF NOT EXISTS collector_state (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  exploration REAL NOT NULL DEFAULT 0.5,
  tuned_at    INTEGER NOT NULL DEFAULT 0
);
"#;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn comma_terms(raw: String) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether a track has been listened to enough to be worth carrying.
///
/// "Listened to twice" cannot just mean two rows in `plays`: that table
/// records a song STARTING, so a track skipped past every time it came up
/// looks identical to one played through. Where the listen log has an opinion
/// - a completion or an abandonment - it wins, and a song with nothing but
/// abandonments is out however often it started. Where it has no opinion
/// (history older than the log, or a client that never reported), the play
/// count stands as it always did.
pub fn hot_enough(r: &HotRow, min_plays: i64) -> bool {
    if r.completed >= min_plays {
        return true;
    }
    // Judged, and judged against.
    if r.completed == 0 && r.skipped >= min_plays {
        return false;
    }
    r.plays >= min_plays
}

/// How much a listener has actually played one track. See `hot_rows`.
#[derive(Clone, Copy)]
pub struct HotRow {
    pub id: i64,
    /// Times it was started.
    pub plays: i64,
    /// Times it was played THROUGH - the number that means "listened to".
    pub completed: i64,
    /// Times it was started and abandoned. A song with many of these and no
    /// completions is being rejected, however often it appears in `plays`.
    pub skipped: i64,
    pub last_at: i64,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Self::migrate(&conn)?;
        Self::migrate_legacy_profiles(&conn)?;
        Self::backfill_search_index(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Adds columns that postdate a deployed database's tables. The SCHEMA
    /// above is all IF NOT EXISTS, so a table that already exists keeps its
    /// old shape and a column added there lands only on fresh databases; each
    /// one is checked against what the table actually has, so re-running on
    /// every boot costs a pragma read and nothing else.
    fn migrate(conn: &Connection) -> rusqlite::Result<()> {
        let have: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('track_features')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        // The audio analyser's columns (features.rs), riding the curator's
        // table: nullable, with analyzed_at = 0 standing for "not measured
        // yet", so every existing row simply reads as unanalysed.
        for (name, decl) in [
            ("energy", "energy REAL"),
            ("brightness", "brightness REAL"),
            ("loudness", "loudness REAL"),
            ("dynamic_range", "dynamic_range REAL"),
            ("rhythmic_activity", "rhythmic_activity REAL"),
            ("audio_fingerprint", "audio_fingerprint BLOB"),
            (
                "audio_fingerprint_dims",
                "audio_fingerprint_dims INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "audio_fingerprint_version",
                "audio_fingerprint_version INTEGER NOT NULL DEFAULT 0",
            ),
            ("sonic_vec", "sonic_vec BLOB"),
            (
                "sonic_vec_dims",
                "sonic_vec_dims INTEGER NOT NULL DEFAULT 0",
            ),
            ("lyrical_vec", "lyrical_vec BLOB"),
            (
                "lyrical_vec_dims",
                "lyrical_vec_dims INTEGER NOT NULL DEFAULT 0",
            ),
            ("community_vec", "community_vec BLOB"),
            (
                "community_vec_dims",
                "community_vec_dims INTEGER NOT NULL DEFAULT 0",
            ),
            ("analyzed_at", "analyzed_at INTEGER NOT NULL DEFAULT 0"),
            ("ai_summary", "ai_summary TEXT NOT NULL DEFAULT ''"),
            ("ai_genres", "ai_genres TEXT NOT NULL DEFAULT ''"),
            ("ai_vibes", "ai_vibes TEXT NOT NULL DEFAULT ''"),
            (
                "ai_sonic_traits",
                "ai_sonic_traits TEXT NOT NULL DEFAULT ''",
            ),
            (
                "ai_lyrical_themes",
                "ai_lyrical_themes TEXT NOT NULL DEFAULT ''",
            ),
            ("ai_confidence", "ai_confidence REAL NOT NULL DEFAULT 0"),
            ("ai_sources", "ai_sources TEXT NOT NULL DEFAULT ''"),
            ("external_tags", "external_tags TEXT NOT NULL DEFAULT ''"),
            ("musicbrainz_id", "musicbrainz_id TEXT NOT NULL DEFAULT ''"),
            (
                "listenbrainz_similar",
                "listenbrainz_similar TEXT NOT NULL DEFAULT ''",
            ),
            (
                "listenbrainz_listens",
                "listenbrainz_listens INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "listenbrainz_listeners",
                "listenbrainz_listeners INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "listenbrainz_checked_at",
                "listenbrainz_checked_at INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "ai_enriched_at",
                "ai_enriched_at INTEGER NOT NULL DEFAULT 0",
            ),
        ] {
            if !have.iter().any(|c| c == name) {
                conn.execute(&format!("ALTER TABLE track_features ADD COLUMN {decl}"), [])?;
            }
        }
        // The collector's attribution on tracks themselves (collector.rs):
        // who a download was fetched for, and whether anyone has adopted it.
        // On the tracks table because the quarantine travels with the row -
        // the delta sync carries it to every client with no second query.
        let have: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('tracks')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        for (name, decl) in [
            ("curator_user_id", "curator_user_id INTEGER"),
            (
                "curator_promoted",
                "curator_promoted INTEGER NOT NULL DEFAULT 0",
            ),
            ("chapters", "chapters TEXT NOT NULL DEFAULT ''"),
        ] {
            if !have.iter().any(|c| c == name) {
                conn.execute(&format!("ALTER TABLE tracks ADD COLUMN {decl}"), [])?;
            }
        }
        // What a row IS (audiobooks.rs): 'music' or 'book', derived from where
        // the file lives so it can never drift from the folder. On the tracks
        // table because every surface needs the split - the delta sync carries
        // it to clients, mixes and search exclude books server-side, and the
        // shelf the books live on reads it back. The backfill catches files
        // already sitting in Audiobooks/ before this column existed.
        if !have.iter().any(|c| c == "kind") {
            conn.execute(
                "ALTER TABLE tracks ADD COLUMN kind TEXT NOT NULL DEFAULT 'music'",
                [],
            )?;
            conn.execute(
                "UPDATE tracks SET kind = 'book' WHERE rel_path LIKE 'Audiobooks/%'",
                [],
            )?;
        }
        Ok(())
    }

    fn migrate_legacy_profiles(conn: &Connection) -> rusqlite::Result<()> {
        let rows = {
            let mut stmt = conn.prepare(
                "SELECT f.track_id,f.ai_summary,f.ai_genres,f.ai_vibes,f.ai_sonic_traits,
                 f.ai_lyrical_themes,f.ai_confidence,f.ai_enriched_at,length(trim(t.lyrics))>0
                 FROM track_features f JOIN tracks t ON t.id=f.track_id
                 LEFT JOIN song_profile_layers p ON p.track_id=f.track_id
                 WHERE p.track_id IS NULL AND trim(f.ai_summary)<>''",
            )?;
            let mapped = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, f32>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, bool>(8)?,
                ))
            })?;
            mapped.filter_map(Result::ok).collect::<Vec<_>>()
        };
        for (id, summary, genres, moods, traits, themes, confidence, at, has_lyrics) in rows {
            let category = crate::enrichment::CategoryConfidence {
                genres: confidence,
                moods: confidence,
                vibes: confidence,
                musical_traits: confidence,
                lyrical_themes: confidence,
                specific_tags: confidence,
            };
            let profile = crate::enrichment::SemanticProfile {
                summary,
                genres: comma_terms(genres),
                moods: comma_terms(moods),
                musical_traits: comma_terms(traits),
                lyrical_themes: comma_terms(themes),
                confidence: category,
                ..Default::default()
            }
            .normalize(has_lyrics);
            let encoded = serde_json::to_string(&profile).unwrap_or_default();
            let provenance = crate::enrichment::provenance(&profile, &profile, None).to_string();
            conn.execute("INSERT OR IGNORE INTO song_profile_layers
                (track_id,schema_version,fast_profile,canonical_profile,provenance,fast_model,fast_prompt_version,fast_created_at,migrated_from)
                VALUES (?1,?2,?3,?3,?4,'legacy-unknown','legacy-v2',?5,'attackfm_song_profile_v2')",
                params![id,crate::enrichment::PROFILE_SCHEMA_VERSION,encoded,provenance,at.max(1)])?;
        }
        Ok(())
    }

    /// Fills the search index from `tracks` when it is empty and the library
    /// is not - the one boot where this server lands on a database that
    /// predates the index. The triggers keep it current from then on, but
    /// they only see writes made after they exist.
    fn backfill_search_index(conn: &Connection) -> rusqlite::Result<()> {
        // Not COUNT(*) on tracks_fts itself: an external-content FTS table
        // answers that from the CONTENT table, so it reads as full the moment
        // `tracks` has rows, indexed or not. The docsize shadow table holds
        // one row per document actually indexed - exactly the question.
        let indexed: i64 =
            conn.query_row("SELECT COUNT(*) FROM tracks_fts_docsize", [], |r| r.get(0))?;
        if indexed > 0 {
            return Ok(());
        }
        // Tombstones included, matching what the triggers maintain: a
        // tombstone is an UPDATE to `tracks`, so its row stays indexed and
        // the search queries filter deleted = 0 on the way out.
        conn.execute(
            "INSERT INTO tracks_fts (rowid, title, artist, album_artist, album, genre, lyrics)
             SELECT id, title, artist, album_artist, album, genre, lyrics FROM tracks",
            [],
        )?;
        Ok(())
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
            .query_row("SELECT v FROM meta WHERE k = ?1", params![key], |r| {
                r.get(0)
            })
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

    // --- registry membership -------------------------------------------------

    /// The local user a registry account maps to on this server, if it has
    /// joined. `(user_id, role)`.
    pub fn registry_member(&self, sub: i64) -> Option<(i64, String)> {
        let conn = self.lock();
        conn.query_row(
            "SELECT user_id, role FROM registry_members WHERE registry_sub = ?1",
            [sub],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Bind a registry account to a local user as a member of this server.
    pub fn add_registry_member(
        &self,
        sub: i64,
        user_id: i64,
        handle: &str,
        role: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO registry_members (registry_sub, user_id, handle, role, joined_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(registry_sub) DO UPDATE SET role = excluded.role, handle = excluded.handle",
            params![sub, user_id, handle, role, now_ms()],
        )?;
        Ok(())
    }

    /// Whether this server has any admin at all - false only on a brand-new
    /// server, where the first person through the door becomes the owner.
    pub fn has_any_admin(&self) -> bool {
        let conn = self.lock();
        conn.query_row("SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1", [], |_| {
            Ok(())
        })
        .optional()
        .ok()
        .flatten()
        .is_some()
    }

    pub fn create_user(
        &self,
        username: &str,
        pass_hash: &str,
        is_admin: bool,
    ) -> rusqlite::Result<i64> {
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

    /// Replaces a user's password hash and signs every device out.
    ///
    /// The epoch bump is not optional politeness: a password is reset because
    /// the old one is not trusted, and stream tokens minted under it keep
    /// working until their epoch is stale. Changing the secret without it
    /// would leave whoever prompted the reset still streaming.
    pub fn set_password_hash(&self, username: &str, hash: &str) -> rusqlite::Result<bool> {
        let changed = self.lock().execute(
            "UPDATE users SET pass_hash = ?2, stream_epoch = stream_epoch + 1
              WHERE username = ?1 COLLATE NOCASE",
            rusqlite::params![username, hash],
        )?;
        Ok(changed > 0)
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
            .query_row(
                "SELECT id FROM tracks WHERE rel_path = ?1",
                params![rel_path],
                |r| r.get(0),
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
        let Ok(mut stmt) = conn.prepare("SELECT id, username, is_admin FROM users ORDER BY id")
        else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)));
        rows.map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn delete_user(&self, id: i64) -> rusqlite::Result<()> {
        self.lock()
            .execute("DELETE FROM users WHERE id = ?1", params![id])?;
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
        self.lock()
            .execute("DELETE FROM tokens WHERE user_id = ?1", params![user_id])?;
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
        let Ok(mut stmt) =
            conn.prepare("SELECT rel_path, mtime, size_bytes FROM tracks WHERE deleted = 0")
        else {
            return Default::default();
        };
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))));
        rows.map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
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
        rows.map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
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
                 channels, bitrate, size_bytes, mtime, art_id, added_at, rev, deleted, kind,
                 chapters
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                 ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 ?16, ?17, ?18, ?19, ?20, ?21, ?22, 0, ?23, ?24
             )
             ON CONFLICT(rel_path) DO UPDATE SET
                 kind = excluded.kind,
                 chapters = excluded.chapters,
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
                t.rel_path,
                t.title,
                t.artist,
                t.album_artist,
                t.album,
                t.track_no,
                t.disc_no,
                t.year,
                t.genre,
                t.lyrics,
                t.duration_ms,
                t.codec,
                t.lossless as i64,
                t.sample_rate,
                t.bit_depth,
                t.channels,
                t.bitrate,
                t.size_bytes,
                t.mtime,
                t.art_id,
                now_ms(),
                rev,
                kind_for(&t.rel_path),
                t.chapters
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
            curator_user_id: row.get(22)?,
            curator_promoted: row.get::<_, i64>(23)? != 0,
            kind: row.get(24)?,
            chapters: {
                // Stored as a JSON string; hand the client the parsed array, or
                // an empty one if it is blank or somehow unparseable.
                let raw: String = row.get(25)?;
                serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!([]))
            },
        })
    }

    const TRACK_COLS: &'static str = "id, title, artist, album_artist, album, track_no, disc_no, \
         year, genre, lyrics, deleted, duration_ms, codec, lossless, sample_rate, bit_depth, \
         channels, bitrate, size_bytes, added_at, art_id, rev, curator_user_id, \
         COALESCE(curator_promoted, 0), COALESCE(kind, 'music'), COALESCE(chapters, '')";

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

    /// The cover behind one track, for the by-track art route: a mirror's
    /// client knows this server's TRACK ids (from the holdings map) but not
    /// its art ids, which are named per-server.
    pub fn track_art_id(&self, id: i64) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT art_id FROM tracks WHERE id = ?1 AND deleted = 0",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
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
            .query_row("SELECT COUNT(*) FROM tracks WHERE deleted = 0", [], |r| {
                r.get(0)
            })
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

    /// The albums this library holds by one artist, with the tracks it has of
    /// each. What the album filler diffs against a catalogue tracklist.
    ///
    /// Grouped case-insensitively, because one album's worth of files is often
    /// tagged three slightly different ways, and an album split in two by its
    /// own capitalisation would read as two half-empty records.
    pub fn albums_by_artist(&self, artist: &str) -> Vec<(String, Vec<(String, Option<i64>)>)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            // EITHER credit, because a record with a guest on two songs has
            // three track artists and one album artist - matching the track
            // credit alone loses those songs, and a record whose songs are ALL
            // credited that way disappears from the artist entirely.
            "SELECT album, title, track_no FROM tracks
              WHERE deleted = 0 AND TRIM(album) <> ''
                AND (LOWER(TRIM(artist)) = LOWER(TRIM(?1))
                     OR LOWER(TRIM(COALESCE(album_artist, ''))) = LOWER(TRIM(?1)))
              ORDER BY album, COALESCE(track_no, 9999), title",
        ) else {
            return Vec::new();
        };
        let rows: Vec<(String, String, Option<i64>)> = stmt
            .query_map(rusqlite::params![artist], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?))
            })
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default();
        let mut out: Vec<(String, Vec<(String, Option<i64>)>)> = Vec::new();
        for (album, title, no) in rows {
            let key = album.trim().to_lowercase();
            match out.last_mut() {
                Some((name, tracks)) if name.trim().to_lowercase() == key => {
                    tracks.push((title, no))
                }
                _ => out.push((album, vec![(title, no)])),
            }
        }
        out
    }

    /// The artists behind a set of track ids, most-represented first.
    ///
    /// What a handful of songs is really saying: you did not keep THAT
    /// recording so much as that sound, and the catalogue is walked by artist.
    /// Empty ids answer empty rather than the whole library.
    pub fn artists_for(&self, ids: &[i64]) -> Vec<(String, i64)> {
        if ids.is_empty() {
            return Vec::new();
        }
        let conn = self.lock();
        let holes = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT artist, COUNT(*) n FROM tracks
              WHERE id IN ({holes}) AND deleted = 0 AND TRIM(artist) <> ''
              GROUP BY LOWER(TRIM(artist)) ORDER BY n DESC"
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        let bound: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        stmt.query_map(bound.as_slice(), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

/// One track's standing in a listener's history, for deciding what a hot
    /// server should carry.
    pub fn hot_rows(&self, user_id: i64, min_plays: i64) -> Vec<HotRow> {
        let conn = self.lock();
        let mut rows: std::collections::HashMap<i64, HotRow> = std::collections::HashMap::new();

        // Plays: the coarse count, and what "listened to twice" means plainly.
        if let Ok(mut stmt) = conn.prepare(
            "SELECT track_id, COUNT(*) n, MAX(played_at) last FROM plays
              WHERE user_id = ?1 GROUP BY track_id",
        ) {
            if let Ok(mapped) = stmt.query_map(params![user_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
            }) {
                for (id, n, last) in mapped.filter_map(Result::ok) {
                    let e = rows.entry(id).or_insert(HotRow { id, plays: 0, completed: 0, skipped: 0, last_at: 0 });
                    e.plays = n;
                    e.last_at = e.last_at.max(last);
                }
            }
        }

        // Completed listens and abandonments, which is the honest half. The
        // `plays` count above records that a song STARTED; a song started four
        // times and finished none is one being skipped past, and on a box that
        // is short of disk that distinction is the whole point.
        if let Ok(mut stmt) = conn.prepare(
            "SELECT track_id,
                    SUM(CASE WHEN completed = 1 AND skipped = 0 THEN 1 ELSE 0 END) done,
                    SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) skip,
                    MAX(started_at) last
               FROM listen_events WHERE user_id = ?1 GROUP BY track_id",
        ) {
            if let Ok(mapped) = stmt.query_map(params![user_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            }) {
                for (id, done, skip, last) in mapped.filter_map(Result::ok) {
                    let e = rows.entry(id).or_insert(HotRow { id, plays: 0, completed: 0, skipped: 0, last_at: 0 });
                    e.completed = done;
                    e.skipped = skip;
                    e.last_at = e.last_at.max(last);
                }
            }
        }

        rows.into_values().filter(|r| hot_enough(r, min_plays)).collect()
    }

    /// Every live track as (id, rel_path, artist, title) - what a hot server
    /// needs to decide which of its files have gone cold.
    pub fn all_track_paths(&self) -> Vec<(i64, String, String, String)> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT id, rel_path, artist, title FROM tracks WHERE deleted = 0")
        else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

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
        let Ok(mut stmt) = conn
            .prepare("SELECT id, name, updated_at FROM playlists WHERE user_id = ?1 ORDER BY name")
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

    /// One playlist's live track ids, in order.
    pub fn playlist_track_ids(&self, playlist_id: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT pt.track_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
              WHERE pt.playlist_id = ?1 AND t.deleted = 0 ORDER BY pt.position",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![playlist_id], |r| r.get(0))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
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

    /// A playlist's current name - what the mirror compares against to notice
    /// the listener renamed it locally.
    pub fn playlist_name(&self, playlist_id: i64) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT name FROM playlists WHERE id = ?1",
                params![playlist_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
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
            "SELECT p.track_id FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0 AND COALESCE(t.kind, 'music') <> 'book'
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
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0 AND COALESCE(t.kind, 'music') <> 'book'
             WHERE p.user_id = ?1 AND p.played_at >= ?2
             GROUP BY p.track_id ORDER BY n DESC, MAX(p.played_at) DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since_ms, limit], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Plays inside one window of the past: what the rewind page calls "around
    /// this date, years ago". Same shape as `top_plays`, bounded both ends.
    pub fn plays_between(
        &self,
        user_id: i64,
        from_ms: i64,
        to_ms: i64,
        limit: i64,
    ) -> Vec<(i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT p.track_id, COUNT(*) AS n
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0 AND COALESCE(t.kind, 'music') <> 'book'
             WHERE p.user_id = ?1 AND p.played_at >= ?2 AND p.played_at < ?3
             GROUP BY p.track_id ORDER BY n DESC, MAX(p.played_at) DESC LIMIT ?4",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, from_ms, to_ms, limit], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    // --- friends -------------------------------------------------------
    //
    // A friendship is stored once, lower id first, so every question about a
    // pair is one primary-key lookup. Everything below normalises before it
    // touches the table.

    /// Every friend of this user: (id, username), by name.
    pub fn friends_of(&self, user_id: i64) -> Vec<(i64, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT u.id, u.username FROM friendships f
             JOIN users u ON u.id = CASE WHEN f.a_id = ?1 THEN f.b_id ELSE f.a_id END
             WHERE f.a_id = ?1 OR f.b_id = ?1
             ORDER BY u.username COLLATE NOCASE",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Pending asks aimed AT this user: (request id, their id, their name).
    pub fn incoming_requests(&self, user_id: i64) -> Vec<(i64, i64, String)> {
        self.requests_where("r.to_user = ?1", "r.from_user", user_id)
    }

    /// Pending asks this user SENT: (request id, their id, their name).
    pub fn outgoing_requests(&self, user_id: i64) -> Vec<(i64, i64, String)> {
        self.requests_where("r.from_user = ?1", "r.to_user", user_id)
    }

    fn requests_where(&self, whose: &str, other: &str, user_id: i64) -> Vec<(i64, i64, String)> {
        let conn = self.lock();
        let sql = format!(
            "SELECT r.id, u.id, u.username FROM friend_requests r
             JOIN users u ON u.id = {other}
             WHERE {whose} ORDER BY r.created_at DESC",
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn are_friends(&self, a: i64, b: i64) -> bool {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        let conn = self.lock();
        conn.query_row(
            "SELECT 1 FROM friendships WHERE a_id = ?1 AND b_id = ?2",
            params![lo, hi],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Files a request. Returns its id, or the id of the one already standing.
    pub fn add_friend_request(&self, from: i64, to: i64) -> rusqlite::Result<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT OR IGNORE INTO friend_requests (from_user, to_user, created_at)
             VALUES (?1, ?2, ?3)",
            params![from, to, now_ms()],
        )?;
        Ok(conn.query_row(
            "SELECT id FROM friend_requests WHERE from_user = ?1 AND to_user = ?2",
            params![from, to],
            |r| r.get(0),
        )?)
    }

    /// A pending request by id: (from, to). None once it has been answered.
    pub fn friend_request(&self, id: i64) -> Option<(i64, i64)> {
        let conn = self.lock();
        conn.query_row(
            "SELECT from_user, to_user FROM friend_requests WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    }

    pub fn delete_friend_request(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM friend_requests WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Makes the pair friends and clears any ask in either direction, so an
    /// accepted request cannot leave a mirror-image one standing behind it.
    pub fn add_friendship(&self, a: i64, b: i64) -> rusqlite::Result<()> {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        let conn = self.lock();
        conn.execute(
            "INSERT OR IGNORE INTO friendships (a_id, b_id, since) VALUES (?1, ?2, ?3)",
            params![lo, hi, now_ms()],
        )?;
        conn.execute(
            "DELETE FROM friend_requests
             WHERE (from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)",
            params![a, b],
        )?;
        Ok(())
    }

    pub fn remove_friendship(&self, a: i64, b: i64) -> rusqlite::Result<()> {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        let conn = self.lock();
        conn.execute(
            "DELETE FROM friendships WHERE a_id = ?1 AND b_id = ?2",
            params![lo, hi],
        )?;
        Ok(())
    }

    /// Finds a user by exact name, case-insensitively - how one person names
    /// another when adding them.
    pub fn user_by_username(&self, username: &str) -> Option<(i64, String)> {
        let conn = self.lock();
        conn.query_row(
            "SELECT id, username FROM users WHERE username = ?1 COLLATE NOCASE",
            params![username],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    }

    /// One artist's most-played songs, all-time: (track id, play count),
    /// most-played first. NOCASE on the artist so "MF DOOM" and "MF Doom"
    /// are one page. Feeds the library's artist view - its Top songs list.
    pub fn top_plays_for_artist(&self, user_id: i64, artist: &str, limit: i64) -> Vec<(i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT p.track_id, COUNT(*) AS n
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0 AND COALESCE(t.kind, 'music') <> 'book'
             WHERE p.user_id = ?1 AND t.artist = ?2 COLLATE NOCASE
             GROUP BY p.track_id ORDER BY n DESC, MAX(p.played_at) DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, artist, limit], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
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
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0 AND COALESCE(t.kind, 'music') <> 'book'
             WHERE p.user_id = ?1 AND p.played_at >= ?2
             GROUP BY t.artist COLLATE NOCASE ORDER BY n DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since_ms, limit], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
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
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0 AND COALESCE(t.kind, 'music') <> 'book'
             WHERE p.user_id = ?1 AND p.played_at >= ?2 AND TRIM(t.genre) <> ''
             GROUP BY t.genre ORDER BY n DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since_ms, limit], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
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
                 FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0 AND COALESCE(t.kind, 'music') <> 'book'
                 WHERE p.user_id = ?1 AND TRIM(t.album) <> ''
                 GROUP BY t.album_artist, t.album ORDER BY last DESC LIMIT ?2",
            ) else {
                return Vec::new();
            };
            stmt.query_map(params![user_id, album_limit], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
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
        let Ok(mut stmt) =
            conn.prepare("SELECT id FROM tracks WHERE deleted = 0 ORDER BY added_at DESC LIMIT ?1")
        else {
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

    pub fn set_play_state(
        &self,
        user_id: i64,
        track_id: i64,
        position_ms: i64,
    ) -> rusqlite::Result<()> {
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
        let Ok(mut stmt) =
            conn.prepare("SELECT key, snapshot FROM spotify_synced WHERE user_id = ?1")
        else {
            return Default::default();
        };
        stmt.query_map(params![user_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn spotify_mark_synced(
        &self,
        user_id: i64,
        key: &str,
        snapshot: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO spotify_synced (user_id, key, snapshot) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, key) DO UPDATE SET snapshot = excluded.snapshot",
            params![user_id, key, snapshot],
        )?;
        Ok(())
    }

    // --- the Spotify mirror ---------------------------------------------------

    /// Every user with a live Spotify link - who the sync loop has work for.
    pub fn spotify_users(&self) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT user_id FROM spotify_accounts WHERE refresh_token != ''")
        else {
            return Vec::new();
        };
        stmt.query_map([], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Resolve external ids to live local tracks. A pin whose target was
    /// tombstoned simply misses, so the caller re-runs the ladder instead of
    /// handing back a ghost.
    pub fn ext_id_lookup(
        &self,
        source: &str,
        ext_ids: &[String],
    ) -> std::collections::HashMap<String, i64> {
        if ext_ids.is_empty() {
            return Default::default();
        }
        let conn = self.lock();
        let mut found = std::collections::HashMap::new();
        // Chunked rather than one giant IN list: SQLite's variable limit is
        // 999 by default and a big playlist blows straight past it.
        for chunk in ext_ids.chunks(400) {
            let holes = std::iter::repeat("?")
                .take(chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT e.ext_id, e.track_id FROM track_ext_ids e
                 JOIN tracks t ON t.id = e.track_id
                 WHERE t.deleted = 0 AND e.source = ? AND e.ext_id IN ({holes})"
            );
            let Ok(mut stmt) = conn.prepare(&sql) else {
                continue;
            };
            let mut args: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
            args.push(&source);
            for id in chunk {
                args.push(id);
            }
            let pairs: Vec<(String, i64)> = stmt
                .query_map(args.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default();
            found.extend(pairs);
        }
        found
    }

    /// Record how an external id maps to a local track. A stored pin is only
    /// ever replaced by a strictly better-ranked one (or when its target has
    /// been tombstoned), so a re-sync never thrashes a good match and a
    /// listener's manual correction is permanent.
    pub fn ext_id_pin(
        &self,
        source: &str,
        ext_id: &str,
        track_id: i64,
        method: &str,
        matched_by: &str,
    ) -> rusqlite::Result<()> {
        let rank = ext_method_rank(method);
        self.lock().execute(
            "INSERT INTO track_ext_ids (source, ext_id, track_id, method, matched_by, linked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(source, ext_id) DO UPDATE SET
               track_id   = excluded.track_id,
               method     = excluded.method,
               matched_by = excluded.matched_by,
               linked_at  = excluded.linked_at
             WHERE ?7 > CASE track_ext_ids.method
                          WHEN 'manual'   THEN 4
                          WHEN 'download' THEN 3
                          WHEN 'isrc'     THEN 3
                          WHEN 'strict'   THEN 2
                          ELSE 1 END
                OR NOT EXISTS (
                     SELECT 1 FROM tracks t
                      WHERE t.id = track_ext_ids.track_id AND t.deleted = 0)",
            params![source, ext_id, track_id, method, matched_by, now_ms(), rank],
        )?;
        Ok(())
    }

    pub fn ext_id_unpin(&self, source: &str, ext_id: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM track_ext_ids WHERE source = ?1 AND ext_id = ?2",
            params![source, ext_id],
        )?;
        Ok(())
    }

    /// Every live track's identity CARRYING its id - `sync_identities` is the
    /// same query without one, and the matcher needs to know what it matched.
    pub fn match_index(&self) -> Vec<MatchRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, title, artist, album_artist, album, duration_ms
               FROM tracks WHERE deleted = 0",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            Ok(MatchRow {
                id: r.get(0)?,
                title: r.get(1)?,
                artist: r.get(2)?,
                album_artist: r.get(3)?,
                album: r.get(4)?,
                duration_ms: r.get(5)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn spotify_mirror(&self, user_id: i64, key: &str) -> Option<MirrorHead> {
        let conn = self.lock();
        conn.query_row(
            &format!("SELECT {MIRROR_COLS} FROM spotify_mirrors WHERE user_id = ?1 AND key = ?2"),
            params![user_id, key],
            mirror_from_row,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn spotify_mirrors(&self, user_id: i64) -> Vec<MirrorHead> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(&format!(
            "SELECT {MIRROR_COLS} FROM spotify_mirrors WHERE user_id = ?1 ORDER BY name"
        )) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], mirror_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Create the mirror head if it is new, otherwise leave every field the
    /// sync engine owns alone and refresh only what the listing knows.
    pub fn spotify_mirror_seed(
        &self,
        user_id: i64,
        key: &str,
        kind: &str,
        spotify_id: &str,
        name: &str,
        owner: &str,
        image: &str,
        head_snapshot: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO spotify_mirrors
               (user_id, key, kind, spotify_id, name, owner, image, head_snapshot)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(user_id, key) DO UPDATE SET
               name          = excluded.name,
               owner         = excluded.owner,
               image         = excluded.image,
               head_snapshot = excluded.head_snapshot",
            params![
                user_id,
                key,
                kind,
                spotify_id,
                name,
                owner,
                image,
                head_snapshot
            ],
        )?;
        Ok(())
    }

    pub fn spotify_mirror_set_watch(
        &self,
        user_id: i64,
        key: &str,
        watch: bool,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE spotify_mirrors SET watch = ?3, next_check = 0 WHERE user_id = ?1 AND key = ?2",
            params![user_id, key, i64::from(watch)],
        )?;
        Ok(())
    }

    pub fn spotify_mirror_set_state(
        &self,
        user_id: i64,
        key: &str,
        state: &str,
        error: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE spotify_mirrors SET state = ?3, error = ?4 WHERE user_id = ?1 AND key = ?2",
            params![user_id, key, state, error],
        )?;
        Ok(())
    }

    pub fn spotify_mirror_set_playlist(
        &self,
        user_id: i64,
        key: &str,
        playlist_id: i64,
        local_name: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE spotify_mirrors SET playlist_id = ?3, local_name = ?4
              WHERE user_id = ?1 AND key = ?2",
            params![user_id, key, playlist_id, local_name],
        )?;
        Ok(())
    }

    /// Stamp the end of a pass: what was mirrored, when, and when to look again.
    pub fn spotify_mirror_stamp(
        &self,
        user_id: i64,
        key: &str,
        snapshot: &str,
        resolved_rev: i64,
        next_check: i64,
        synced: bool,
    ) -> rusqlite::Result<()> {
        let now = now_ms();
        self.lock().execute(
            "UPDATE spotify_mirrors SET
               snapshot     = ?3,
               resolved_rev = ?4,
               next_check   = ?5,
               checked_at   = ?6,
               synced_at    = CASE WHEN ?7 THEN ?6 ELSE synced_at END
             WHERE user_id = ?1 AND key = ?2",
            params![
                user_id,
                key,
                snapshot,
                resolved_rev,
                next_check,
                now,
                synced
            ],
        )?;
        Ok(())
    }

    pub fn spotify_mirror_head_seen(
        &self,
        user_id: i64,
        key: &str,
        head_snapshot: &str,
        next_check: i64,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE spotify_mirrors SET head_snapshot = ?3, next_check = ?4, checked_at = ?5
              WHERE user_id = ?1 AND key = ?2",
            params![user_id, key, head_snapshot, next_check, now_ms()],
        )?;
        Ok(())
    }

    /// Watched mirrors whose next check is due, soonest first.
    pub fn spotify_mirrors_due(&self, now_ms_val: i64, limit: i64) -> Vec<(i64, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT user_id, key FROM spotify_mirrors
              WHERE watch = 1 AND next_check <= ?1
              ORDER BY next_check LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![now_ms_val, limit], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Recount a mirror from its items and write the counters onto the head,
    /// so the progress surface is restart-safe rather than in-memory.
    pub fn spotify_mirror_recount(
        &self,
        user_id: i64,
        key: &str,
    ) -> rusqlite::Result<MirrorCounts> {
        let conn = self.lock();
        let counts = conn.query_row(
            "SELECT COUNT(*),
                    SUM(state = 'resolved'),
                    SUM(state = 'queued'),
                    SUM(state IN ('missing','unavailable','ignored')),
                    SUM(state = 'ambiguous')
               FROM spotify_items WHERE user_id = ?1 AND key = ?2",
            params![user_id, key],
            |r| {
                Ok(MirrorCounts {
                    total: r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    resolved: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    queued: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    missing: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    ambiguous: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                })
            },
        )?;
        conn.execute(
            "UPDATE spotify_mirrors SET total = ?3, resolved = ?4, queued = ?5,
                                        missing = ?6, ambiguous = ?7
              WHERE user_id = ?1 AND key = ?2",
            params![
                user_id,
                key,
                counts.total,
                counts.resolved,
                counts.queued,
                counts.missing,
                counts.ambiguous
            ],
        )?;
        Ok(counts)
    }

    pub fn spotify_mirror_forget(&self, user_id: i64, key: &str) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM spotify_items WHERE user_id = ?1 AND key = ?2",
            params![user_id, key],
        )?;
        tx.execute(
            "DELETE FROM spotify_mirrors WHERE user_id = ?1 AND key = ?2",
            params![user_id, key],
        )?;
        tx.commit()
    }

    pub fn spotify_items(&self, user_id: i64, key: &str) -> Vec<MirrorItem> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(&format!(
            "SELECT {ITEM_COLS} FROM spotify_items
              WHERE user_id = ?1 AND key = ?2 ORDER BY position"
        )) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, key], item_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Replace a mirror's body with what upstream just reported, in one
    /// transaction, CARRYING FORWARD the resolution of every row that is still
    /// there. Only position and metadata are refreshed - that carry-forward is
    /// the whole reason the table is keyed by (uid, occurrence) and not by
    /// position, and it is what makes an upstream reorder nearly free.
    pub fn spotify_items_replace(
        &self,
        user_id: i64,
        key: &str,
        fetched: &[MirrorItem],
    ) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let now = now_ms();
        let tx = conn.transaction()?;
        for item in fetched {
            tx.execute(
                "INSERT INTO spotify_items
                   (user_id, key, track_uid, occurrence, position, isrc, title, artist,
                    album, album_artist, duration_ms, added_at, state, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',?13)
                 ON CONFLICT(user_id, key, track_uid, occurrence) DO UPDATE SET
                   position     = excluded.position,
                   isrc         = CASE WHEN excluded.isrc != '' THEN excluded.isrc
                                       ELSE spotify_items.isrc END,
                   title        = excluded.title,
                   artist       = excluded.artist,
                   album        = excluded.album,
                   album_artist = excluded.album_artist,
                   duration_ms  = excluded.duration_ms,
                   added_at     = excluded.added_at,
                   updated_at   = excluded.updated_at",
                params![
                    user_id,
                    key,
                    item.track_uid,
                    item.occurrence,
                    item.position,
                    item.isrc,
                    item.title,
                    item.artist,
                    item.album,
                    item.album_artist,
                    item.duration_ms,
                    item.added_at,
                    now
                ],
            )?;
        }
        // Anything no longer upstream leaves the mirror. Building the keep-set
        // as a temp table beats a 3,000-hole NOT IN list.
        tx.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS _keep (uid TEXT, occ INTEGER); DELETE FROM _keep;",
        )?;
        {
            let mut ins = tx.prepare("INSERT INTO _keep (uid, occ) VALUES (?1, ?2)")?;
            for item in fetched {
                ins.execute(params![item.track_uid, item.occurrence])?;
            }
        }
        tx.execute(
            "DELETE FROM spotify_items
              WHERE user_id = ?1 AND key = ?2
                AND (track_uid, occurrence) NOT IN (SELECT uid, occ FROM _keep)",
            params![user_id, key],
        )?;
        tx.execute_batch("DROP TABLE IF EXISTS _keep;")?;
        tx.commit()
    }

    /// Rows the resolver should look at: never-tried ones first, then those
    /// whose backoff has come due.
    pub fn spotify_items_pending(
        &self,
        user_id: i64,
        key: &str,
        now_ms_val: i64,
        limit: i64,
    ) -> Vec<MirrorItem> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(&format!(
            "SELECT {ITEM_COLS} FROM spotify_items
              WHERE user_id = ?1 AND key = ?2
                AND state IN ('pending','missing','ambiguous')
                AND next_try_at <= ?3
              ORDER BY position LIMIT ?4"
        )) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, key, now_ms_val, limit], item_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spotify_item_set(
        &self,
        user_id: i64,
        key: &str,
        uid: &str,
        occurrence: i64,
        state: &str,
        track_id: Option<i64>,
        method: &str,
        job_id: &str,
        note: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE spotify_items SET
               state = ?5, track_id = ?6, match_method = ?7, job_id = ?8,
               note = ?9, updated_at = ?10
             WHERE user_id = ?1 AND key = ?2 AND track_uid = ?3 AND occurrence = ?4",
            params![
                user_id,
                key,
                uid,
                occurrence,
                state,
                track_id,
                method,
                job_id,
                note,
                now_ms()
            ],
        )?;
        Ok(())
    }

    /// Push a failed entry down the backoff ladder: 1h, 6h, 24h, 7d, then
    /// dormant until someone asks for a retry.
    pub fn spotify_item_defer(
        &self,
        user_id: i64,
        key: &str,
        uid: &str,
        occurrence: i64,
        note: &str,
    ) -> rusqlite::Result<()> {
        const LADDER_MS: [i64; 4] = [3_600_000, 21_600_000, 86_400_000, 604_800_000];
        let conn = self.lock();
        let attempts: i64 = conn
            .query_row(
                "SELECT attempts FROM spotify_items
                  WHERE user_id = ?1 AND key = ?2 AND track_uid = ?3 AND occurrence = ?4",
                params![user_id, key, uid, occurrence],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let next = LADDER_MS
            .get(attempts as usize)
            .copied()
            .map(|d| now_ms() + d)
            .unwrap_or(i64::MAX);
        conn.execute(
            "UPDATE spotify_items SET state = 'missing', attempts = attempts + 1,
                                      next_try_at = ?5, job_id = '', note = ?6,
                                      updated_at = ?7
              WHERE user_id = ?1 AND key = ?2 AND track_uid = ?3 AND occurrence = ?4",
            params![user_id, key, uid, occurrence, next, note, now_ms()],
        )?;
        Ok(())
    }

    /// Clear the backoff on a mirror's unfindable rows so they are tried again.
    pub fn spotify_items_retry(&self, user_id: i64, key: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE spotify_items SET attempts = 0, next_try_at = 0, state = 'pending', note = ''
              WHERE user_id = ?1 AND key = ?2 AND state IN ('missing','ambiguous')",
            params![user_id, key],
        )?;
        Ok(())
    }

    /// Which mirror entry a download job belongs to, for the completion hook.
    pub fn spotify_item_by_job(&self, job_id: &str) -> Option<(i64, String, String, i64)> {
        self.lock()
            .query_row(
                "SELECT user_id, key, track_uid, occurrence FROM spotify_items
                  WHERE job_id = ?1 AND state = 'queued' LIMIT 1",
                params![job_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// The honest sibling of `set_playlist_tracks`: same wholesale replace, but
    /// it reports which ids failed to land instead of swallowing the error, so
    /// a mirror can tell the difference between "wrote 300" and "wrote 12".
    pub fn set_playlist_tracks_checked(
        &self,
        playlist_id: i64,
        track_ids: &[i64],
    ) -> rusqlite::Result<(usize, Vec<i64>)> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
        let mut landed = 0usize;
        let mut dropped = Vec::new();
        for (position, track_id) in track_ids.iter().enumerate() {
            match tx.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position)
                 VALUES (?1, ?2, ?3)",
                params![playlist_id, track_id, position as i64],
            ) {
                Ok(_) => landed += 1,
                Err(_) => dropped.push(*track_id),
            }
        }
        tx.execute(
            "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
            params![playlist_id, now_ms()],
        )?;
        tx.commit()?;
        Ok((landed, dropped))
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
        let list = ids
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT t.id, t.title, t.artist, t.album, t.genre, t.lyrics, t.duration_ms,
                    f.bpm IS NOT NULL, COALESCE(f.vec_dims, 0) > 0, t.year,
                    f.bpm, f.energy, f.brightness, f.loudness,
                    f.dynamic_range, f.rhythmic_activity,
                    COALESCE(f.ai_summary,''), COALESCE(f.ai_genres,''),
                    COALESCE(f.ai_vibes,''), COALESCE(f.ai_sonic_traits,''),
                    COALESCE(f.ai_lyrical_themes,''), COALESCE(f.ai_confidence,0)
             FROM tracks t LEFT JOIN track_features f ON f.track_id = t.id
             WHERE t.deleted = 0 AND t.id IN ({list})"
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            Ok(CurationTrack {
                id: r.get(0)?,
                title: r.get(1)?,
                artist: r.get(2)?,
                album: r.get(3)?,
                genre: r.get(4)?,
                lyrics: r.get(5)?,
                duration_ms: r.get(6)?,
                has_bpm: r.get(7)?,
                has_vec: r.get(8)?,
                year: r.get(9)?,
                bpm: r.get(10)?,
                energy: r.get(11)?,
                brightness: r.get(12)?,
                loudness: r.get(13)?,
                dynamic_range: r.get(14)?,
                rhythmic_activity: r.get(15)?,
                ai_summary: r.get(16)?,
                ai_genres: comma_terms(r.get(17)?),
                ai_moods: comma_terms(r.get(18)?),
                ai_sonic_traits: comma_terms(r.get(19)?),
                ai_lyrical_themes: comma_terms(r.get(20)?),
                ai_confidence: r.get(21)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn dj_note(&self, user_id: i64, track_id: i64) -> String {
        self.lock()
            .query_row(
                "SELECT note FROM track_dj_notes WHERE user_id=?1 AND track_id=?2",
                params![user_id, track_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    pub fn set_dj_note(&self, user_id: i64, track_id: i64, note: &str) -> rusqlite::Result<()> {
        let note: String = note.trim().chars().take(2000).collect();
        self.lock().execute(
            "INSERT INTO track_dj_notes (user_id,track_id,note,updated_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(user_id,track_id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at",
            params![user_id, track_id, note, now_ms()],
        )?;
        Ok(())
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
        vector_before: i64,
        want_vectors: bool,
    ) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t
             LEFT JOIN track_features f ON f.track_id = t.id
             WHERE t.deleted = 0 AND (
                 f.track_id IS NULL
                 OR f.checked_at < ?2
                 OR (?4 AND COALESCE(f.vec_dims, 0) = 0 AND f.checked_at < ?3)
             )
             ORDER BY f.checked_at IS NOT NULL, f.checked_at ASC, t.added_at DESC
             LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(
            params![limit, stale_before, vector_before, want_vectors],
            |r| r.get(0),
        )
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

    /// Next durable AI-enrichment jobs. A zero stamp is a newly indexed song;
    /// old rows are revisited occasionally as tags and lyrics improve.
    pub fn tracks_needing_ai_enrichment(&self, limit: i64, stale_before: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t LEFT JOIN track_features f ON f.track_id=t.id
             WHERE t.deleted=0 AND (COALESCE(f.ai_enriched_at,0) < ?2
                    OR (COALESCE(f.ai_enriched_at,0) > 0 AND COALESCE(f.ai_sources,'') = '')
                    OR (COALESCE(f.musicbrainz_id,'') <> ''
                        AND COALESCE(f.listenbrainz_checked_at,0) = 0
                        AND COALESCE(f.ai_sources,'') <> 'rejected_v2')
                    OR (COALESCE(f.ai_sources,'') <> ''
                        AND COALESCE(f.ai_sources,'') <> 'rejected_v2'
                        AND COALESCE(f.sonic_vec_dims,0) = 0))
             ORDER BY CASE WHEN COALESCE(f.ai_sources,'') = '' THEN 0 ELSE 1 END,
                      COALESCE(f.ai_enriched_at,0), t.added_at DESC LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit, stale_before], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn tracks_needing_fast_profile(&self, limit: i64, stale_before: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t
             LEFT JOIN song_profile_layers p ON p.track_id=t.id
             LEFT JOIN track_features f ON f.track_id=t.id
             WHERE t.deleted=0 AND COALESCE(p.fast_created_at,0) < ?2
               AND NOT (COALESCE(f.ai_sources,'')='rejected_v3'
                        AND COALESCE(f.ai_enriched_at,0) >= ?2)
             ORDER BY COALESCE(p.fast_created_at,0), t.added_at DESC LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit, stale_before], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn tracks_needing_refinement(&self, limit: i64, stale_before: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t JOIN song_profile_layers p ON p.track_id=t.id
             WHERE t.deleted=0 AND p.fast_created_at>0 AND p.fast_profile<>''
               AND (p.refined_at=0 OR p.refined_at < ?2)
             ORDER BY p.refined_at, p.fast_created_at LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit, stale_before], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn fast_profile(&self, track_id: i64) -> Option<crate::enrichment::SemanticProfile> {
        let raw: String = self
            .lock()
            .query_row(
                "SELECT fast_profile FROM song_profile_layers WHERE track_id=?1",
                params![track_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn save_layered_profile(
        &self,
        track_id: i64,
        fast: &crate::enrichment::SemanticProfile,
        patch: Option<&crate::enrichment::RefinementPatch>,
        canonical: &crate::enrichment::SemanticProfile,
        model: &str,
        prompt_version: &str,
        refinement: bool,
    ) -> rusqlite::Result<()> {
        let fast_json = serde_json::to_string(fast).unwrap_or_default();
        let patch_json = patch
            .and_then(|p| serde_json::to_string(p).ok())
            .unwrap_or_default();
        let canonical_json = serde_json::to_string(canonical).unwrap_or_default();
        let provenance = crate::enrichment::provenance(fast, canonical, patch).to_string();
        let now = now_ms();
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO song_profile_layers (track_id,schema_version,fast_profile,refinement_patch,canonical_profile,provenance,fast_model,fast_prompt_version,fast_created_at,refinement_model,refinement_prompt_version,refined_at)
             VALUES (?1,3,?2,?3,?4,?5,CASE WHEN ?7 THEN '' ELSE ?6 END,CASE WHEN ?7 THEN '' ELSE ?8 END,CASE WHEN ?7 THEN 0 ELSE ?9 END,CASE WHEN ?7 THEN ?6 ELSE '' END,CASE WHEN ?7 THEN ?8 ELSE '' END,CASE WHEN ?7 THEN ?9 ELSE 0 END)
             ON CONFLICT(track_id) DO UPDATE SET schema_version=3,
               fast_profile=CASE WHEN ?7 THEN song_profile_layers.fast_profile ELSE excluded.fast_profile END,
               refinement_patch=CASE WHEN ?7 THEN excluded.refinement_patch ELSE '' END,
               canonical_profile=excluded.canonical_profile,provenance=excluded.provenance,
               fast_model=CASE WHEN ?7 THEN song_profile_layers.fast_model ELSE excluded.fast_model END,
               fast_prompt_version=CASE WHEN ?7 THEN song_profile_layers.fast_prompt_version ELSE excluded.fast_prompt_version END,
               fast_created_at=CASE WHEN ?7 THEN song_profile_layers.fast_created_at ELSE excluded.fast_created_at END,
               refinement_model=CASE WHEN ?7 THEN excluded.refinement_model ELSE '' END,
               refinement_prompt_version=CASE WHEN ?7 THEN excluded.refinement_prompt_version ELSE '' END,
               refined_at=CASE WHEN ?7 THEN excluded.refined_at ELSE 0 END",
            params![track_id,fast_json,patch_json,canonical_json,provenance,model,refinement,prompt_version,now])?;
        // Compatibility projection: every existing consumer sees canonical.
        tx.execute("INSERT INTO track_features (track_id,ai_summary,ai_genres,ai_vibes,ai_sonic_traits,ai_lyrical_themes,ai_confidence,ai_sources,ai_enriched_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
            ON CONFLICT(track_id) DO UPDATE SET ai_summary=excluded.ai_summary,ai_genres=excluded.ai_genres,
              ai_vibes=excluded.ai_vibes,ai_sonic_traits=excluded.ai_sonic_traits,
              ai_lyrical_themes=excluded.ai_lyrical_themes,ai_confidence=excluded.ai_confidence,
              ai_sources=excluded.ai_sources,ai_enriched_at=excluded.ai_enriched_at",
            params![track_id,canonical.summary,canonical.genres.join(", "),canonical.moods.join(", "),
              canonical.musical_traits.join(", "),canonical.lyrical_themes.join(", "),canonical.confidence_average(),
              if refinement { "layered:fast+refined" } else { "layered:fast" },now])?;
        tx.commit()
    }

    pub fn specific_tag_exact(&self, normalized: &str) -> Option<String> {
        self.lock().query_row(
            "SELECT r.canonical_tag FROM specific_tag_aliases a JOIN specific_tag_registry r ON r.id=a.tag_id WHERE a.normalized_alias=?1
             UNION ALL SELECT canonical_tag FROM specific_tag_registry WHERE canonical_tag=?1 LIMIT 1",
            params![normalized], |r| r.get(0)
        ).optional().ok().flatten()
    }

    pub fn specific_tag_candidates(
        &self,
        embedding: &[f32],
        limit: usize,
    ) -> Vec<SpecificTagCandidate> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT canonical_tag,description,status,usage_count,embedding,embedding_dims FROM specific_tag_registry WHERE embedding IS NOT NULL") else { return Vec::new() };
        let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Vec<u8>>(4)?,
                r.get::<_, i64>(5)?,
            ))
        }) else {
            return Vec::new();
        };
        let mut out = rows
            .filter_map(Result::ok)
            .filter_map(|(tag, description, status, usage_count, bytes, dims)| {
                if dims as usize != embedding.len() || bytes.len() != embedding.len() * 4 {
                    return None;
                }
                let stored: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect();
                let dot: f32 = stored.iter().zip(embedding).map(|(a, b)| a * b).sum();
                let norms = stored.iter().map(|v| v * v).sum::<f32>().sqrt()
                    * embedding.iter().map(|v| v * v).sum::<f32>().sqrt();
                Some(SpecificTagCandidate {
                    canonical_tag: tag,
                    description,
                    status,
                    usage_count,
                    similarity: if norms > 0.0 { dot / norms } else { 0.0 },
                })
            })
            .collect::<Vec<_>>();
        out.sort_by(|a, b| b.similarity.total_cmp(&a.similarity));
        out.truncate(limit);
        out
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_specific_tag_decision(
        &self,
        track_id: i64,
        raw_tag: &str,
        normalized: &str,
        canonical: Option<&str>,
        decision: &str,
        candidates: &serde_json::Value,
        decided_by: &str,
        description: &str,
        embedding: Option<&[f32]>,
    ) -> rusqlite::Result<()> {
        let now = now_ms();
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        if let Some(tag) = canonical {
            let first_for_track: bool = !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM track_specific_tag_evidence WHERE track_id=?1 AND canonical_tag=?2)",
                params![track_id,tag], |r| r.get::<_,bool>(0))?;
            let blob =
                embedding.map(|v| v.iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<_>>());
            tx.execute("INSERT INTO specific_tag_registry (canonical_tag,description,embedding,embedding_dims,status,usage_count,track_count,created_at,last_used_at)
                VALUES (?1,?2,?3,?4,'provisional',1,?5,?6,?6)
                ON CONFLICT(canonical_tag) DO UPDATE SET usage_count=usage_count+1,track_count=track_count+?5,last_used_at=?6,
                  status=CASE WHEN track_count+?5>=5 THEN 'established' ELSE status END,
                  description=CASE WHEN description='' THEN excluded.description ELSE description END,
                  embedding=COALESCE(embedding,excluded.embedding),embedding_dims=CASE WHEN embedding IS NULL THEN excluded.embedding_dims ELSE embedding_dims END",
                params![tag,description,blob,embedding.map(|v|v.len() as i64).unwrap_or(0),i64::from(first_for_track),now])?;
            let tag_id: i64 = tx.query_row(
                "SELECT id FROM specific_tag_registry WHERE canonical_tag=?1",
                params![tag],
                |r| r.get(0),
            )?;
            tx.execute("INSERT OR IGNORE INTO specific_tag_aliases(normalized_alias,raw_alias,tag_id,created_at) VALUES(?1,?2,?3,?4)",params![normalized,raw_tag,tag_id,now])?;
        }
        tx.execute("INSERT OR REPLACE INTO track_specific_tag_evidence(track_id,raw_tag,normalized_tag,canonical_tag,decision,candidate_tags,decided_by,created_at)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![track_id,raw_tag,normalized,canonical.unwrap_or(""),decision,candidates.to_string(),decided_by,now])?;
        tx.commit()
    }

    pub fn profile_debug(&self, track_id: i64) -> Option<serde_json::Value> {
        self.lock().query_row(
            "SELECT json_object('trackId',t.id,'sourceMetadata',json_object('title',t.title,'artist',t.artist,'album',t.album,'genre',t.genre,'year',t.year),
             'measuredAudioFacts',json_object('bpm',f.bpm,'energy',f.energy,'brightness',f.brightness,'loudness',f.loudness,'dynamicRange',f.dynamic_range,'rhythmicActivity',f.rhythmic_activity,'durationSeconds',t.duration_ms/1000.0),
             'fastProfile',json(CASE WHEN p.fast_profile='' THEN '{}' ELSE p.fast_profile END),
             'refinementPatch',json(CASE WHEN p.refinement_patch='' THEN '{}' ELSE p.refinement_patch END),
             'canonicalProfile',json(CASE WHEN p.canonical_profile='' THEN '{}' ELSE p.canonical_profile END),
             'versions',json_object('schema',p.schema_version,'fastModel',p.fast_model,'fastPrompt',p.fast_prompt_version,'fastAt',p.fast_created_at,'refinementModel',p.refinement_model,'refinementPrompt',p.refinement_prompt_version,'refinedAt',p.refined_at,'migratedFrom',p.migrated_from))
             FROM tracks t LEFT JOIN track_features f ON f.track_id=t.id LEFT JOIN song_profile_layers p ON p.track_id=t.id WHERE t.id=?1 AND t.deleted=0",
            params![track_id], |r| r.get::<_,String>(0)
        ).optional().ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok())
    }

    pub fn save_ai_enrichment(
        &self,
        track_id: i64,
        summary: &str,
        genres: &[String],
        vibes: &[String],
        sonic_traits: &[String],
        lyrical_themes: &[String],
        confidence: f32,
        sources: &[String],
        external_tags: &[String],
        musicbrainz_id: &str,
        listenbrainz_similar: &[String],
        listenbrainz_listens: i64,
        listenbrainz_listeners: i64,
        sonic_vector: Option<&[f32]>,
        lyrical_vector: Option<&[f32]>,
        community_vector: Option<&[f32]>,
        vector: Option<&[f32]>,
    ) -> rusqlite::Result<()> {
        let blob: Option<Vec<u8>> =
            vector.map(|v| v.iter().flat_map(|f| f.to_le_bytes()).collect());
        let dims = vector.map(|v| v.len() as i64).unwrap_or(0);
        let encode = |value: Option<&[f32]>| {
            value.map(|v| v.iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<u8>>())
        };
        let sonic_blob = encode(sonic_vector);
        let lyrical_blob = encode(lyrical_vector);
        let community_blob = encode(community_vector);
        self.lock().execute(
            "INSERT INTO track_features (track_id, lyric_vec, vec_dims, checked_at, ai_summary, ai_genres, ai_vibes, ai_sonic_traits, ai_lyrical_themes, ai_confidence, ai_sources, external_tags, musicbrainz_id, listenbrainz_similar, listenbrainz_listens, listenbrainz_listeners, listenbrainz_checked_at, ai_enriched_at, sonic_vec, sonic_vec_dims, lyrical_vec, lyrical_vec_dims, community_vec, community_vec_dims)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?4,?4,?17,?18,?19,?20,?21,?22)
             ON CONFLICT(track_id) DO UPDATE SET
               lyric_vec=COALESCE(excluded.lyric_vec,track_features.lyric_vec),
               vec_dims=CASE WHEN excluded.lyric_vec IS NULL THEN track_features.vec_dims ELSE excluded.vec_dims END,
               ai_summary=excluded.ai_summary, ai_genres=excluded.ai_genres,
               ai_vibes=excluded.ai_vibes, ai_sonic_traits=excluded.ai_sonic_traits,
               ai_lyrical_themes=excluded.ai_lyrical_themes, ai_confidence=excluded.ai_confidence,
               ai_sources=excluded.ai_sources, external_tags=excluded.external_tags,
               musicbrainz_id=excluded.musicbrainz_id,
               listenbrainz_similar=excluded.listenbrainz_similar,
               listenbrainz_listens=excluded.listenbrainz_listens,
               listenbrainz_listeners=excluded.listenbrainz_listeners,
               listenbrainz_checked_at=excluded.listenbrainz_checked_at,
               sonic_vec=COALESCE(excluded.sonic_vec,track_features.sonic_vec),
               sonic_vec_dims=CASE WHEN excluded.sonic_vec IS NULL THEN track_features.sonic_vec_dims ELSE excluded.sonic_vec_dims END,
               lyrical_vec=COALESCE(excluded.lyrical_vec,track_features.lyrical_vec),
               lyrical_vec_dims=CASE WHEN excluded.lyrical_vec IS NULL THEN track_features.lyrical_vec_dims ELSE excluded.lyrical_vec_dims END,
               community_vec=COALESCE(excluded.community_vec,track_features.community_vec),
               community_vec_dims=CASE WHEN excluded.community_vec IS NULL THEN track_features.community_vec_dims ELSE excluded.community_vec_dims END,
               ai_enriched_at=excluded.ai_enriched_at",
            params![track_id, blob, dims, now_ms(), summary, genres.join(", "), vibes.join(", "), sonic_traits.join(", "), lyrical_themes.join(", "), confidence, sources.join(", "), external_tags.join(", "), musicbrainz_id, listenbrainz_similar.join(","), listenbrainz_listens, listenbrainz_listeners, sonic_blob, sonic_vector.map(|v| v.len() as i64).unwrap_or(0), lyrical_blob, lyrical_vector.map(|v| v.len() as i64).unwrap_or(0), community_blob, community_vector.map(|v| v.len() as i64).unwrap_or(0)],
        )?;
        Ok(())
    }

    /// Record a structurally valid but low-quality model attempt without
    /// replacing the last useful profile. This prevents one difficult track
    /// from sitting at the front of the durable queue and hammering the model
    /// and public catalogues every few seconds.
    pub fn mark_ai_enrichment_rejected(&self, track_id: i64) {
        let _ = self.lock().execute(
            "INSERT INTO track_features (track_id, ai_enriched_at, ai_sources)
             VALUES (?1, ?2, 'rejected_v3')
             ON CONFLICT(track_id) DO UPDATE SET
               ai_enriched_at=excluded.ai_enriched_at,
               ai_sources=excluded.ai_sources",
            params![track_id, now_ms()],
        );
    }

    /// Every live track's features, for the pass that scores a whole library
    /// against a taste. A few hundred floats per track: cheap to hold, and the
    /// alternative (a query per candidate) is far worse.
    pub fn all_features(&self) -> Vec<TrackFeatures> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id, f.bpm, f.lyric_vec, COALESCE(f.vec_dims, 0), t.genre, t.artist,
                     f.energy, f.brightness, f.dynamic_range, f.rhythmic_activity, t.year,
                     COALESCE(f.musicbrainz_id,''), COALESCE(f.listenbrainz_similar,''),
                     f.sonic_vec, COALESCE(f.sonic_vec_dims,0), f.lyrical_vec,
                     COALESCE(f.lyrical_vec_dims,0), f.community_vec, COALESCE(f.community_vec_dims,0),
                     (t.curator_user_id IS NOT NULL AND COALESCE(t.curator_promoted, 0) = 0),
                     f.audio_fingerprint, COALESCE(f.audio_fingerprint_dims,0),
                     COALESCE(f.ai_genres,''), COALESCE(f.ai_sonic_traits,'')
             FROM tracks t LEFT JOIN track_features f ON f.track_id = t.id
             WHERE t.deleted = 0",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            let blob: Option<Vec<u8>> = r.get(2)?;
            let dims: i64 = r.get(3)?;
            let vec = blob
                .filter(|b| dims > 0 && b.len() == dims as usize * 4)
                .map(|b| {
                    b.chunks_exact(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect::<Vec<f32>>()
                });
            let decode = |blob: Option<Vec<u8>>, dims: i64| {
                blob.filter(|b| dims > 0 && b.len() == dims as usize * 4)
                    .map(|b| {
                        b.chunks_exact(4)
                            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                            .collect()
                    })
            };
            Ok(TrackFeatures {
                track_id: r.get(0)?,
                bpm: r.get(1)?,
                lyric_vec: vec,
                genre: r.get(4)?,
                ai_genres: comma_terms(r.get(22)?),
                ai_sonic_traits: comma_terms(r.get(23)?),
                artist: r.get(5)?,
                energy: r.get(6)?,
                brightness: r.get(7)?,
                dynamic_range: r.get(8)?,
                rhythmic_activity: r.get(9)?,
                year: r.get(10)?,
                musicbrainz_id: r.get(11)?,
                listenbrainz_similar: r
                    .get::<_, String>(12)?
                    .split(',')
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .collect(),
                sonic_vec: decode(r.get(13)?, r.get(14)?),
                lyrical_vec: decode(r.get(15)?, r.get(16)?),
                community_vec: decode(r.get(17)?, r.get(18)?),
                quarantined: r.get::<_, i64>(19)? != 0,
                audio_fingerprint: decode(r.get(20)?, r.get(21)?),
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
        let Ok(mut stmt) = conn.prepare("SELECT DISTINCT user_id FROM plays WHERE played_at >= ?1")
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

    // --- discoveries: music not owned yet --------------------------------------

    // --- push notifications -------------------------------------------------

    /// Remember a device that wants to be told things. Re-registering the same
    /// token just refreshes its label and timestamp - a device that reinstalls
    /// or re-signs-in should not accumulate rows.
    pub fn add_push_token(&self, user_id: i64, token: &str, platform: &str, label: &str) {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO push_devices (user_id, token, platform, label, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id, token) DO UPDATE SET label = excluded.label, added_at = excluded.added_at",
            rusqlite::params![user_id, token, platform, label, now_ms()],
        );
    }

    /// Forget a device - a sign-out, or a listener switching notifications off
    /// on that device specifically.
    pub fn remove_push_token(&self, user_id: i64, token: &str) {
        let conn = self.lock();
        let _ = conn.execute(
            "DELETE FROM push_devices WHERE user_id = ?1 AND token = ?2",
            rusqlite::params![user_id, token],
        );
    }

    /// Drop a token APNs has told us is dead (410 Gone), whoever it belonged
    /// to. Keyed on the token alone: the point is that it is not deliverable
    /// anywhere, and a stale row would be retried on every send forever.
    pub fn retire_push_token(&self, token: &str) {
        let conn = self.lock();
        let _ = conn.execute(
            "DELETE FROM push_devices WHERE token = ?1",
            rusqlite::params![token],
        );
    }

    /// Every device to send a given listener's notifications to.
    pub fn push_tokens(&self, user_id: i64) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT token FROM push_devices WHERE user_id = ?1") else {
            return Vec::new();
        };
        stmt.query_map(rusqlite::params![user_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Whether this listener wants this kind. Absent means yes - see the
    /// schema note: a kind nobody has an opinion about should still work.
    pub fn push_wants(&self, user_id: i64, kind: &str) -> bool {
        let conn = self.lock();
        conn.query_row(
            "SELECT enabled FROM push_prefs WHERE user_id = ?1 AND kind = ?2",
            rusqlite::params![user_id, kind],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v != 0)
        .unwrap_or(true)
    }

    /// Every explicit preference this listener has set, for the settings pane.
    pub fn push_prefs(&self, user_id: i64) -> Vec<(String, bool)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT kind, enabled FROM push_prefs WHERE user_id = ?1")
        else {
            return Vec::new();
        };
        stmt.query_map(rusqlite::params![user_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn set_push_pref(&self, user_id: i64, kind: &str, enabled: bool) {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO push_prefs (user_id, kind, enabled) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled",
            rusqlite::params![user_id, kind, i64::from(enabled)],
        );
    }

    /// When this kind last went out to this listener, epoch millis, or 0.
    pub fn push_last_sent(&self, user_id: i64, kind: &str) -> i64 {
        let conn = self.lock();
        conn.query_row(
            "SELECT sent_at FROM push_sent WHERE user_id = ?1 AND kind = ?2",
            rusqlite::params![user_id, kind],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
    }

    pub fn mark_push_sent(&self, user_id: i64, kind: &str) {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO push_sent (user_id, kind, sent_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, kind) DO UPDATE SET sent_at = excluded.sent_at",
            rusqlite::params![user_id, kind, now_ms()],
        );
    }

    /// Every listener with at least one device registered - who the digest
    /// sweep walks.
    pub fn push_audience(&self) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT DISTINCT user_id FROM push_devices") else {
            return Vec::new();
        };
        stmt.query_map([], |r| r.get::<_, i64>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// How many live tracks landed after a moment - what a digest is made of.
    pub fn tracks_added_since(&self, since_ms: i64) -> i64 {
        let conn = self.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE deleted = 0 AND added_at > ?1",
            rusqlite::params![since_ms],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
    }

    /// The titles this library holds from one record, for marking a catalogue
    /// tracklist up. Same either-credit rule as albums_by_artist.
    pub fn album_track_titles(&self, artist: &str, album: &str) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT title FROM tracks
              WHERE deleted = 0
                AND LOWER(TRIM(album)) = LOWER(TRIM(?2))
                AND (LOWER(TRIM(artist)) = LOWER(TRIM(?1))
                     OR LOWER(TRIM(COALESCE(album_artist, ''))) = LOWER(TRIM(?1)))",
        ) else {
            return Vec::new();
        };
        stmt.query_map(rusqlite::params![artist, album], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Who is behind a batch of new arrivals, if anyone in particular: the
    /// commonest artist among live rows added after a moment, with their
    /// share. Turns "12 songs landed" into a sentence worth reading.
    pub fn top_artist_added_since(&self, since_ms: i64) -> Option<(String, i64)> {
        let conn = self.lock();
        conn.query_row(
            // NOCASE for the same reason top_artists uses it: two spellings of
            // one name must not split the count and lose to a third artist.
            "SELECT t.artist, COUNT(*) AS n FROM tracks t
             WHERE t.deleted = 0 AND t.added_at > ?1 AND TRIM(t.artist) <> ''
             GROUP BY t.artist COLLATE NOCASE ORDER BY n DESC LIMIT 1",
            rusqlite::params![since_ms],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok()
    }

    /// Auditions this listener has not met yet: collector pulls fetched FOR
    /// them that no listen or heart has adopted. The same predicate Date mode
    /// deals from, counted rather than listed.
    pub fn auditions_waiting(&self, user_id: i64) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM tracks
                 WHERE deleted = 0 AND curator_user_id = ?1
                   AND COALESCE(curator_promoted, 0) = 0",
                rusqlite::params![user_id],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// A window of listening, as (plays, milliseconds). Songs with no duration
    /// on the row count toward the tally and contribute no time, which is the
    /// honest way round - a recap may understate the hours, never invent them.
    pub fn listening_since(&self, user_id: i64, since_ms: i64) -> (i64, i64) {
        let conn = self.lock();
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(COALESCE(t.duration_ms, 0)), 0)
             FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0
             WHERE p.user_id = ?1 AND p.played_at >= ?2",
            rusqlite::params![user_id, since_ms],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .unwrap_or((0, 0))
    }

    /// Every (artist, title) this library holds, raw. Whoever compares them
    /// owns the folding - the discovery feed matches these against a catalogue
    /// that spells things differently, and that rule lives with the feed.
    pub fn owned_names(&self) -> Vec<(String, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT artist, title FROM tracks WHERE deleted = 0")
        else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Files a harvested candidate. Existing rows keep whatever has already
    /// been learned about them - a re-harvest must not wipe a tempo that cost
    /// a preview download to measure.
    #[allow(clippy::too_many_arguments)]
    pub fn add_discovery(
        &self,
        user_id: i64,
        ext_id: &str,
        title: &str,
        artist: &str,
        cover: &str,
        url: &str,
        preview: &str,
        seed: &str,
        popularity: f64,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO discoveries
               (user_id, ext_id, title, artist, cover, url, preview, seed, popularity, found_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(user_id, ext_id) DO UPDATE SET
               popularity = excluded.popularity, seed = excluded.seed",
            params![
                user_id,
                ext_id,
                title,
                artist,
                cover,
                url,
                preview,
                seed,
                popularity,
                now_ms()
            ],
        )?;
        Ok(())
    }

    /// Candidates that have not been listened to yet, oldest find first.
    pub fn discoveries_needing_work(&self, user_id: i64, limit: i64) -> Vec<DiscoveryRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT ext_id, title, artist, cover, url, preview, seed, popularity, bpm,
                    lyric_vec, vec_dims, score
             FROM discoveries WHERE user_id = ?1 AND checked_at = 0
             ORDER BY popularity DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], discovery_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Records what listening to a candidate found, and its score.
    pub fn save_discovery_features(
        &self,
        user_id: i64,
        ext_id: &str,
        bpm: Option<f64>,
        lyric_vec: Option<&[f32]>,
        score: f64,
    ) -> rusqlite::Result<()> {
        let blob: Option<Vec<u8>> =
            lyric_vec.map(|v| v.iter().flat_map(|f| f.to_le_bytes()).collect());
        let dims = lyric_vec.map(|v| v.len() as i64).unwrap_or(0);
        self.lock().execute(
            "UPDATE discoveries SET bpm = COALESCE(?3, bpm),
               lyric_vec = COALESCE(?4, lyric_vec),
               vec_dims = CASE WHEN ?4 IS NULL THEN vec_dims ELSE ?5 END,
               score = ?6, checked_at = ?7
             WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id, bpm, blob, dims, score, now_ms()],
        )?;
        Ok(())
    }

    /// Rescores everything already listened to - what a changed taste needs.
    pub fn all_discoveries(&self, user_id: i64) -> Vec<DiscoveryRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT ext_id, title, artist, cover, url, preview, seed, popularity, bpm,
                    lyric_vec, vec_dims, score
             FROM discoveries WHERE user_id = ?1 AND checked_at > 0",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], discovery_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn set_discovery_score(&self, user_id: i64, ext_id: &str, score: f64) {
        let _ = self.lock().execute(
            "UPDATE discoveries SET score = ?3 WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id, score],
        );
    }

    /// The best of what this listener does not own, scored highest first.
    pub fn top_discoveries(&self, user_id: i64, limit: i64) -> Vec<DiscoveryRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT ext_id, title, artist, cover, url, preview, seed, popularity, bpm,
                    lyric_vec, vec_dims, score
             FROM discoveries WHERE user_id = ?1 AND checked_at > 0
             ORDER BY score DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], discovery_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Drops a candidate - what "I own this now" and "not for me" both do.
    pub fn forget_discovery(&self, user_id: i64, ext_id: &str) {
        let _ = self.lock().execute(
            "DELETE FROM discoveries WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id],
        );
    }

    /// How many candidates are waiting, and how many have been listened to.
    pub fn discovery_counts(&self, user_id: i64) -> (i64, i64) {
        let conn = self.lock();
        let one = |sql: &str| -> i64 {
            conn.query_row(sql, params![user_id], |r| r.get(0))
                .unwrap_or(0)
        };
        (
            one("SELECT COUNT(*) FROM discoveries WHERE user_id = ?1"),
            one("SELECT COUNT(*) FROM discoveries WHERE user_id = ?1 AND checked_at > 0"),
        )
    }

    // --- library search ---------------------------------------------------

    /// The tracks a library search matches, best first. `q` arrives already
    /// folded into FTS5 MATCH syntax (library_search.rs owns that); an
    /// expression FTS cannot parse simply reads as no rows, the same as every
    /// other defensive read here.
    ///
    /// The bm25 weights hand the title the lead, artists close behind, then
    /// album, genre, and lyrics trailing - a song is found by what it is
    /// called before what it says. The CTE is MATERIALIZED on purpose: left
    /// to itself the planner flattens it into the outer query, where bm25()
    /// is no longer sitting directly on its FTS table and SQLite refuses it.
    pub fn search_tracks(&self, q: &str, limit: i64) -> Vec<Track> {
        let conn = self.lock();
        let sql = format!(
            "WITH hits AS MATERIALIZED (
                 SELECT rowid AS fts_id, bm25(tracks_fts, 4.0, 3.0, 3.0, 2.0, 1.0, 0.5) AS rank
                   FROM tracks_fts WHERE tracks_fts MATCH ?1
             )
             SELECT {} FROM tracks JOIN hits f ON f.fts_id = tracks.id
             WHERE deleted = 0 ORDER BY f.rank LIMIT ?2",
            Self::TRACK_COLS
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        stmt.query_map(params![q, limit], Self::read_track)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The albums a library search matches, each group ranked by its
    /// best-scoring track. The count is the album's real size rather than how
    /// many rows happened to match, and the cover id prefers a member track
    /// that actually carries art.
    pub fn search_albums(&self, q: &str, limit: i64) -> Vec<AlbumHit> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "WITH hits AS MATERIALIZED (
                 SELECT rowid AS fts_id, bm25(tracks_fts, 4.0, 3.0, 3.0, 2.0, 1.0, 0.5) AS rank
                   FROM tracks_fts WHERE tracks_fts MATCH ?1
             )
             SELECT t.album, t.album_artist, MAX(t.year),
                    (SELECT COUNT(*) FROM tracks c
                      WHERE c.deleted = 0 AND c.album = t.album AND c.album_artist = t.album_artist),
                    COALESCE(MIN(CASE WHEN t.art_id IS NOT NULL THEN t.id END), MIN(t.id)),
                    MIN(f.rank) AS best
               FROM tracks t JOIN hits f ON f.fts_id = t.id
              WHERE t.deleted = 0 AND t.album <> ''
              GROUP BY t.album, t.album_artist
              ORDER BY best LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![q, limit], |r| {
            Ok(AlbumHit {
                album: r.get(0)?,
                album_artist: r.get(1)?,
                year: r.get(2)?,
                track_count: r.get(3)?,
                cover_id: r.get(4)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    // --- search recents ---------------------------------------------------

    /// What this listener searched for and opened, newest first.
    pub fn recents(&self, user_id: i64, limit: i64) -> Vec<RecentRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT kind, key, title, subtitle, cover, url, at
               FROM search_recents WHERE user_id = ?1 ORDER BY at DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], |r| {
            Ok(RecentRow {
                kind: r.get(0)?,
                key: r.get(1)?,
                title: r.get(2)?,
                subtitle: r.get(3)?,
                cover: r.get(4)?,
                url: r.get(5)?,
                at: r.get(6)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Records one opened result, bumping it to the top when it was already
    /// there - and prunes the tail past the newest forty while the write is
    /// here anyway, so the list can never grow without bound.
    pub fn touch_recent(
        &self,
        user_id: i64,
        kind: &str,
        key: &str,
        title: &str,
        subtitle: &str,
        cover: &str,
        url: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO search_recents (user_id, kind, key, title, subtitle, cover, url, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(user_id, kind, key) DO UPDATE SET
                 title = excluded.title, subtitle = excluded.subtitle,
                 cover = excluded.cover, url = excluded.url, at = excluded.at",
            params![user_id, kind, key, title, subtitle, cover, url, now_ms()],
        )?;
        conn.execute(
            "DELETE FROM search_recents WHERE user_id = ?1 AND (kind, key) NOT IN (
                 SELECT kind, key FROM search_recents WHERE user_id = ?1
                  ORDER BY at DESC LIMIT 40)",
            params![user_id],
        )?;
        Ok(())
    }

    pub fn remove_recent(&self, user_id: i64, kind: &str, key: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM search_recents WHERE user_id = ?1 AND kind = ?2 AND key = ?3",
            params![user_id, kind, key],
        )?;
        Ok(())
    }

    pub fn clear_recents(&self, user_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM search_recents WHERE user_id = ?1",
            params![user_id],
        )?;
        Ok(())
    }

    // --- the listening log --------------------------------------------------

    /// The tags a listen event snapshots, straight off the track row. No
    /// deleted filter on purpose: the listen happened while the file was
    /// here, and an eviction between play and report must not erase the
    /// history - a tombstone still knows what it was called.
    pub fn track_tags(&self, id: i64) -> Option<(String, String, String, String)> {
        self.lock()
            .query_row(
                "SELECT title, artist, album, genre FROM tracks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Files one listen event, snapshot and all.
    pub fn insert_listen(
        &self,
        user_id: i64,
        track_id: i64,
        tags: &(String, String, String, String),
        started_at: i64,
        ms_listened: i64,
        duration_ms: Option<i64>,
        completed: bool,
        skipped: bool,
        context: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO listen_events (user_id, track_id, title, artist, album, genre,
                                        started_at, ms_listened, duration_ms, completed, skipped, context)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                user_id,
                track_id,
                tags.0,
                tags.1,
                tags.2,
                tags.3,
                started_at,
                ms_listened,
                duration_ms,
                completed as i64,
                skipped as i64,
                context
            ],
        )?;
        Ok(())
    }

    /// One row of totals over a listening window. A "play" throughout these
    /// stats is Spotify's sense of one: the track finished, or it ran at
    /// least thirty seconds - a three-second skip is an event but not a play.
    pub fn listen_totals(&self, user_id: i64, since: i64) -> ListenTotals {
        self.lock()
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(completed = 1 OR ms_listened >= 30000), 0),
                        COALESCE(SUM(ms_listened), 0),
                        COUNT(DISTINCT track_id),
                        COUNT(DISTINCT artist),
                        COALESCE(SUM(completed), 0),
                        COALESCE(SUM(skipped), 0)
                   FROM listen_events WHERE user_id = ?1 AND started_at >= ?2",
                params![user_id, since],
                |r| {
                    Ok(ListenTotals {
                        events: r.get(0)?,
                        plays: r.get(1)?,
                        ms: r.get(2)?,
                        unique_tracks: r.get(3)?,
                        unique_artists: r.get(4)?,
                        completed: r.get(5)?,
                        skipped: r.get(6)?,
                    })
                },
            )
            .unwrap_or_default()
    }

    /// Who got listened to most, by minutes: `(artist, plays, ms, cover)`.
    /// The cover is a live track by that artist that actually carries art -
    /// the client builds `/api/art/{id}` from it - or None once the artist
    /// has left the library, which the snapshot columns exist to survive.
    pub fn top_listen_artists(
        &self,
        user_id: i64,
        since: i64,
        limit: i64,
    ) -> Vec<(String, i64, i64, Option<i64>)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT e.artist,
                    COALESCE(SUM(e.completed = 1 OR e.ms_listened >= 30000), 0),
                    COALESCE(SUM(e.ms_listened), 0) AS ms,
                    (SELECT t.id FROM tracks t
                      WHERE t.deleted = 0 AND t.art_id IS NOT NULL
                        AND (t.artist = e.artist OR t.album_artist = e.artist)
                      LIMIT 1)
               FROM listen_events e
              WHERE e.user_id = ?1 AND e.started_at >= ?2 AND e.artist <> ''
              GROUP BY e.artist ORDER BY ms DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// The most-played tracks: `(track_id, title, artist, plays, ms)`. Rows
    /// group on the id, so a retag mid-window is still one track; MAX just
    /// picks one of its snapshots to name it by.
    pub fn top_listen_tracks(
        &self,
        user_id: i64,
        since: i64,
        limit: i64,
    ) -> Vec<(i64, String, String, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT e.track_id, MAX(e.title), MAX(e.artist),
                    COALESCE(SUM(e.completed = 1 OR e.ms_listened >= 30000), 0) AS plays,
                    COALESCE(SUM(e.ms_listened), 0) AS ms
               FROM listen_events e
              WHERE e.user_id = ?1 AND e.started_at >= ?2
              GROUP BY e.track_id ORDER BY plays DESC, ms DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// The most-listened albums, by minutes: `(album, artist, plays, ms)`.
    /// The artist leg is whichever artist appears most within that album's
    /// events, because compilations disagree with themselves about who the
    /// album belongs to.
    pub fn top_listen_albums(
        &self,
        user_id: i64,
        since: i64,
        limit: i64,
    ) -> Vec<(String, String, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT e.album,
                    COALESCE((SELECT e2.artist FROM listen_events e2
                       WHERE e2.user_id = ?1 AND e2.started_at >= ?2 AND e2.album = e.album
                       GROUP BY e2.artist ORDER BY COUNT(*) DESC LIMIT 1), ''),
                    COALESCE(SUM(e.completed = 1 OR e.ms_listened >= 30000), 0),
                    COALESCE(SUM(e.ms_listened), 0) AS ms
               FROM listen_events e
              WHERE e.user_id = ?1 AND e.started_at >= ?2 AND e.album <> ''
              GROUP BY e.album ORDER BY ms DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Milliseconds listened per raw genre TAG. The tags are comma-joined
    /// strings as they came off the files; splitting them into genres is the
    /// caller's business (listens.rs), not SQL's.
    pub fn listen_genre_ms(&self, user_id: i64, since: i64) -> Vec<(String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT genre, COALESCE(SUM(ms_listened), 0)
               FROM listen_events
              WHERE user_id = ?1 AND started_at >= ?2 AND genre <> ''
              GROUP BY genre",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Milliseconds listened per local hour of day, an event counted whole
    /// against the hour it STARTED in. `tz_min` is the client's
    /// getTimezoneOffset(): the minutes to subtract from UTC to reach the
    /// listener's wall clock.
    pub fn listen_clock(&self, user_id: i64, since: i64, tz_min: i64) -> [i64; 24] {
        let mut clock = [0i64; 24];
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT ((started_at - ?3 * 60000) / 3600000) % 24, COALESCE(SUM(ms_listened), 0)
               FROM listen_events WHERE user_id = ?1 AND started_at >= ?2
              GROUP BY 1",
        ) else {
            return clock;
        };
        let rows = stmt
            .query_map(params![user_id, since, tz_min], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })
            .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
            .unwrap_or_default();
        for (hour, ms) in rows {
            if (0..24).contains(&hour) {
                clock[hour as usize] = ms;
            }
        }
        clock
    }

    /// Milliseconds listened per local day, as `(days since epoch, ms)`,
    /// oldest first. SQL only buckets; the caller densifies the series and
    /// turns day numbers into dates.
    pub fn listen_day_ms(&self, user_id: i64, since: i64, tz_min: i64) -> Vec<(i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT (started_at - ?3 * 60000) / 86400000, COALESCE(SUM(ms_listened), 0)
               FROM listen_events WHERE user_id = ?1 AND started_at >= ?2
              GROUP BY 1 ORDER BY 1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since, tz_min], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Every distinct local day carrying at least one COMPLETED listen,
    /// newest first, as days since epoch - what the streak is counted over.
    pub fn completed_listen_days(&self, user_id: i64, tz_min: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT DISTINCT (started_at - ?2 * 60000) / 86400000
               FROM listen_events WHERE user_id = ?1 AND completed = 1
              ORDER BY 1 DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, tz_min], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// How many events in the window belong to tracks this user had never
    /// played before the window opened - the "new to you" count.
    pub fn first_listen_count(&self, user_id: i64, since: i64) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM listen_events e
                  WHERE e.user_id = ?1 AND e.started_at >= ?2
                    AND NOT EXISTS (SELECT 1 FROM listen_events p
                                     WHERE p.user_id = ?1 AND p.track_id = e.track_id
                                       AND p.started_at < ?2)",
                params![user_id, since],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// The average character of what this listener actually played, weighted
    /// by plays: `(tracks measured, energy, brightness, bpm)`. Only tracks
    /// the analyser has really measured count - `analyzed_at > 0` and not the
    /// gave-up sentinel (see features.rs), whose zeros would read as a taste
    /// for silence. A track listened to but never played to the thirty-second
    /// bar still weighs one, so the averages stay defined. The bpm leg
    /// averages whatever the shared column holds - the curator's measurement
    /// or the analyser's - over the tracks that have one.
    pub fn listen_sound(&self, user_id: i64, since: i64) -> (i64, f64, f64, Option<f64>) {
        self.lock()
            .query_row(
                "WITH listened AS (
                     SELECT track_id,
                            MAX(COALESCE(SUM(completed = 1 OR ms_listened >= 30000), 0), 1) AS w
                       FROM listen_events WHERE user_id = ?1 AND started_at >= ?2
                      GROUP BY track_id
                 )
                 SELECT COUNT(*),
                        COALESCE(SUM(f.energy * l.w) / SUM(l.w), 0),
                        COALESCE(SUM(f.brightness * l.w) / SUM(l.w), 0),
                        SUM(CASE WHEN f.bpm IS NOT NULL THEN f.bpm * l.w END) * 1.0 /
                            SUM(CASE WHEN f.bpm IS NOT NULL THEN l.w END)
                   FROM listened l JOIN track_features f ON f.track_id = l.track_id
                  WHERE f.analyzed_at > 0 AND f.energy IS NOT NULL AND f.loudness > -69.5",
                params![user_id, since],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap_or((0, 0.0, 0.0, None))
    }

    // --- audio character ----------------------------------------------------

    /// The next live track the audio analyser has not measured, newest first
    /// so a fresh import gets its character while anyone still cares:
    /// `(id, rel_path, duration_ms, already has a bpm)`. The predicate is the
    /// analyser's own stamp, not `checked_at` - that one belongs to the
    /// curator's enricher, and the two must not fight over whose turn it is.
    pub fn next_unanalyzed_track(&self) -> Option<(i64, String, Option<i64>, bool)> {
        self.lock()
            .query_row(
                "SELECT t.id, t.rel_path, t.duration_ms, f.bpm IS NOT NULL
                   FROM tracks t LEFT JOIN track_features f ON f.track_id = t.id
                  WHERE t.deleted = 0 AND (COALESCE(f.analyzed_at, 0) = 0
                        OR f.dynamic_range IS NULL OR f.rhythmic_activity IS NULL
                        OR COALESCE(f.audio_fingerprint_version, 0) < 1)
                  ORDER BY t.added_at DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Records what the analyser measured, without disturbing the curator's
    /// half of the row: an existing tempo always wins over the analyser's
    /// (and keeps its bpm_source), a vector is never touched, and a fresh row
    /// leaves checked_at at 0 so the enricher still gets its turn.
    pub fn save_audio_features(
        &self,
        track_id: i64,
        bpm: Option<f64>,
        energy: f64,
        brightness: f64,
        loudness: f64,
        dynamic_range: f64,
        rhythmic_activity: f64,
        audio_fingerprint: Option<&[f32]>,
    ) -> rusqlite::Result<()> {
        let fingerprint_blob: Option<Vec<u8>> =
            audio_fingerprint.map(|v| v.iter().flat_map(|f| f.to_le_bytes()).collect());
        let fingerprint_dims = audio_fingerprint.map(|v| v.len() as i64).unwrap_or(0);
        self.lock().execute(
            "INSERT INTO track_features (track_id, bpm, bpm_source, energy, brightness, loudness, dynamic_range, rhythmic_activity, audio_fingerprint, audio_fingerprint_dims, audio_fingerprint_version, analyzed_at)
             VALUES (?1, ?2, CASE WHEN ?2 IS NULL THEN '' ELSE 'dsp' END, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10)
             ON CONFLICT(track_id) DO UPDATE SET
               bpm         = COALESCE(track_features.bpm, excluded.bpm),
               bpm_source  = CASE WHEN track_features.bpm IS NULL AND excluded.bpm IS NOT NULL
                                  THEN 'dsp' ELSE track_features.bpm_source END,
               energy      = excluded.energy,
               brightness  = excluded.brightness,
               loudness    = excluded.loudness,
               dynamic_range = excluded.dynamic_range,
               rhythmic_activity = excluded.rhythmic_activity,
               audio_fingerprint = excluded.audio_fingerprint,
               audio_fingerprint_dims = excluded.audio_fingerprint_dims,
               audio_fingerprint_version = excluded.audio_fingerprint_version,
               analyzed_at = excluded.analyzed_at",
            params![track_id, bpm, energy, brightness, loudness, dynamic_range, rhythmic_activity, fingerprint_blob, fingerprint_dims, now_ms()],
        )?;
        Ok(())
    }

    /// How far the audio analyser has got: (live tracks measured, live
    /// tracks). The gave-up sentinel counts as measured here - the number is
    /// progress toward done, and a track that will never analyse is done.
    pub fn audio_feature_counts(&self) -> (i64, i64, i64) {
        let conn = self.lock();
        let one = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
        (
            one("SELECT COUNT(*) FROM track_features f JOIN tracks t ON t.id = f.track_id AND t.deleted = 0 WHERE f.analyzed_at > 0"),
            one("SELECT COUNT(*) FROM track_features f JOIN tracks t ON t.id = f.track_id AND t.deleted = 0 WHERE f.audio_fingerprint_version >= 1 AND f.audio_fingerprint_dims = 48"),
            one("SELECT COUNT(*) FROM tracks WHERE deleted = 0"),
        )
    }

    // --- the collector ------------------------------------------------------

    /// The listener's dials, defaults standing in for an absent row.
    pub fn collector_state(&self, user_id: i64) -> (bool, f64) {
        self.lock()
            .query_row(
                "SELECT enabled, exploration FROM collector_state WHERE user_id = ?1",
                params![user_id],
                |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?)),
            )
            .unwrap_or((true, 0.5))
    }

    pub fn set_collector_enabled(&self, user_id: i64, enabled: bool) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO collector_state (user_id, enabled) VALUES (?1, ?2)
             ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled",
            params![user_id, enabled as i64],
        )?;
        Ok(())
    }

    pub fn set_collector_exploration(
        &self,
        user_id: i64,
        exploration: f64,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO collector_state (user_id, exploration, tuned_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET exploration = excluded.exploration, tuned_at = excluded.tuned_at",
            params![user_id, exploration, now_ms()],
        )?;
        Ok(())
    }

    /// What the budget meters: bytes of collector music nobody has adopted.
    /// Global, not per-user - it is one disk.
    pub fn collector_ledger_bytes(&self) -> i64 {
        self.lock()
            .query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM tracks
                 WHERE deleted = 0 AND curator_user_id IS NOT NULL AND COALESCE(curator_promoted, 0) = 0",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// Remembers a pull the moment it is chosen. Err on a duplicate (user,
    /// ext_id) is the dedupe working, not a failure.
    pub fn record_pull(
        &self,
        user_id: i64,
        ext_id: &str,
        kind: &str,
        title: &str,
        artist: &str,
        url: &str,
        reason: &str,
        score: f64,
        job_id: &str,
    ) -> rusqlite::Result<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO curator_pulls (user_id, ext_id, kind, title, artist, url, reason, score, job_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![user_id, ext_id, kind, title, artist, url, reason, score, job_id, now_ms()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Everything ever pulled for this user, for the "would buying this be
    /// buying it twice" check - failed pulls included, deliberately: a link
    /// that failed once fails again, and retrying forever is a loop.
    pub fn pulled_ext_ids(&self, user_id: i64) -> std::collections::HashSet<String> {
        let conn = self.lock();
        let mut stmt = match conn.prepare("SELECT ext_id FROM curator_pulls WHERE user_id = ?1") {
            Ok(s) => s,
            Err(_) => return Default::default(),
        };
        stmt.query_map(params![user_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Pulls whose import is still out - what the landing check walks.
    pub fn open_pulls(&self) -> Vec<(i64, i64, String)> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT id, user_id, job_id FROM curator_pulls WHERE state = 'queued' AND job_id != ''",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// A pull's import landed: stamp the tracks it became as this listener's
    /// auditions, remember which they were, and settle the pull's real size.
    /// Only rows nobody already owns take the stamp - an import that resolved
    /// to a track a person had added stays theirs.
    pub fn land_pull(&self, pull_id: i64, user_id: i64, track_ids: &[i64]) -> rusqlite::Result<()> {
        let rev = self.current_rev() + 1;
        let conn = self.lock();
        let mut bytes = 0i64;
        for id in track_ids {
            let changed = conn.execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 0, rev = ?2
                 WHERE id = ?3 AND curator_user_id IS NULL AND added_at > ?4",
                params![user_id, rev, id, now_ms() - 60 * 60 * 1000],
            )?;
            if changed > 0 {
                conn.execute(
                    "INSERT OR IGNORE INTO curator_pull_tracks (pull_id, track_id) VALUES (?1, ?2)",
                    params![pull_id, id],
                )?;
                bytes += conn
                    .query_row(
                        "SELECT size_bytes FROM tracks WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
            }
        }
        conn.execute(
            "UPDATE curator_pulls SET state = 'landed', bytes = ?1 WHERE id = ?2",
            params![bytes, pull_id],
        )?;
        Ok(())
    }

    pub fn fail_pull(&self, pull_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET state = 'failed' WHERE id = ?1",
            params![pull_id],
        )?;
        Ok(())
    }

    /// Adoption: a completed listen or a heart on an auditioning track moves it
    /// into the library proper, whoever did the listening - wanted is wanted.
    /// The rev bump is what carries the change to every synced client.
    pub fn promote_curator_track(&self, track_id: i64) -> bool {
        let rev = self.current_rev() + 1;
        let conn = self.lock();
        let changed = conn
            .execute(
                "UPDATE tracks SET curator_promoted = 1, rev = ?1
                 WHERE id = ?2 AND curator_user_id IS NOT NULL AND COALESCE(curator_promoted, 0) = 0",
                params![rev, track_id],
            )
            .unwrap_or(0);
        if changed > 0 {
            // A pull all of whose tracks are adopted reads as promoted.
            let _ = conn.execute(
                "UPDATE curator_pulls SET state = 'promoted' WHERE state = 'landed' AND id IN (
                   SELECT pt.pull_id FROM curator_pull_tracks pt WHERE pt.track_id = ?1
                 ) AND NOT EXISTS (
                   SELECT 1 FROM curator_pull_tracks pt2
                   JOIN tracks t ON t.id = pt2.track_id
                   WHERE pt2.pull_id IN (SELECT pull_id FROM curator_pull_tracks WHERE track_id = ?1)
                     AND COALESCE(t.curator_promoted, 0) = 0 AND t.deleted = 0
                 )",
                params![track_id],
            );
        }
        changed > 0
    }

    /// The recent-pulls list the settings pane shows, newest first.
    pub fn recent_pulls(
        &self,
        user_id: i64,
        limit: i64,
    ) -> Vec<(String, String, String, String, i64, String)> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT title, artist, kind, state, created_at, reason
             FROM curator_pulls WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![user_id, limit], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// What arrived lately: live, non-quarantined rows, newest first - the
    /// Fresh-finds list is this, in arrival order.
    pub fn recent_track_ids(&self, since_ms: i64, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM tracks
             WHERE deleted = 0 AND added_at >= ?1
               AND (curator_user_id IS NULL OR COALESCE(curator_promoted, 0) = 1)
             ORDER BY added_at DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![since_ms, limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// A queued pull whose job the queue no longer remembers, once it is old
    /// enough that no answer is coming.
    pub fn fail_pull_if_stale(&self, pull_id: i64, created_before_ms: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET state = 'failed'
             WHERE id = ?1 AND state = 'queued' AND created_at < ?2",
            params![pull_id, created_before_ms],
        )?;
        Ok(())
    }

    pub fn pull_id_for(&self, user_id: i64, ext_id: &str) -> rusqlite::Result<i64> {
        self.lock().query_row(
            "SELECT id FROM curator_pulls WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id],
            |r| r.get(0),
        )
    }

    /// Whether a tuning pass is due - true when the dial has not moved since
    /// `before_ms`. The set itself stamps tuned_at, closing the loop.
    pub fn collector_tune_due(&self, user_id: i64, before_ms: i64) -> bool {
        self.lock()
            .query_row(
                "SELECT tuned_at FROM collector_state WHERE user_id = ?1",
                params![user_id],
                |r| r.get::<_, i64>(0),
            )
            .map(|t| t < before_ms)
            .unwrap_or(true)
    }

    /// How the exploration dial reads its own scoreboard: of the pulls that
    /// landed at least this long ago, how many were adopted?
    pub fn pull_adoption(&self, user_id: i64, landed_before_ms: i64) -> (i64, i64) {
        let conn = self.lock();
        conn.query_row(
            "SELECT COALESCE(SUM(state = 'promoted'), 0), COUNT(*) FROM curator_pulls
             WHERE user_id = ?1 AND state IN ('landed', 'promoted') AND created_at < ?2",
            params![user_id, landed_before_ms],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0))
    }

    // --- library tools (tools.rs) -------------------------------------------

    /// Every live row, full shape - the duplicate finder clusters these in
    /// memory rather than teaching SQL the normalisation rules.
    pub fn all_live_tracks(&self) -> Vec<Track> {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks WHERE deleted = 0 ORDER BY id",
            Self::TRACK_COLS
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        stmt.query_map([], Self::read_track)
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The files of one album: (id, rel_path) for every live track whose
    /// album and album artist match, case-insensitively.
    pub fn album_files(&self, album: &str, album_artist: &str) -> Vec<(i64, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, rel_path FROM tracks
              WHERE deleted = 0 AND lower(album) = lower(?1) AND lower(album_artist) = lower(?2)
              ORDER BY disc_no, track_no, id",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![album, album_artist], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Re-points every per-user reference from each dropped track to the kept
    /// one, skipping any move that would collide with a unique key (a listener
    /// who had favourited both copies keeps one favourite, not an error).
    /// The leftovers such a skip strands are deleted - their meaning has moved.
    pub fn repoint_track_refs(&self, keep: i64, drops: &[i64]) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        for &drop in drops {
            // (user_id, track_id) primary keys: OR IGNORE skips the user who
            // already references the kept id, then the stranded row goes.
            tx.execute(
                "UPDATE OR IGNORE favorites SET track_id = ?1 WHERE track_id = ?2",
                params![keep, drop],
            )?;
            tx.execute("DELETE FROM favorites WHERE track_id = ?1", params![drop])?;
            tx.execute(
                "UPDATE OR IGNORE play_state SET track_id = ?1 WHERE track_id = ?2",
                params![keep, drop],
            )?;
            tx.execute("DELETE FROM play_state WHERE track_id = ?1", params![drop])?;
            // No unique key involves track_id on these three.
            tx.execute(
                "UPDATE playlist_tracks SET track_id = ?1 WHERE track_id = ?2",
                params![keep, drop],
            )?;
            tx.execute(
                "UPDATE plays SET track_id = ?1 WHERE track_id = ?2",
                params![keep, drop],
            )?;
            tx.execute(
                "UPDATE listen_events SET track_id = ?1 WHERE track_id = ?2",
                params![keep, drop],
            )?;
        }
        tx.commit()
    }

    /// Tombstones a set of rows under one rev, so the next delta sync's
    /// removed[] carries them - the same shape tombstone_missing produces.
    pub fn tombstone_tracks(&self, ids: &[i64], rev: i64) -> rusqlite::Result<()> {
        let conn = self.lock();
        for id in ids {
            conn.execute(
                "UPDATE tracks SET deleted = 1, rev = ?2 WHERE id = ?1",
                params![id, rev],
            )?;
        }
        Ok(())
    }

    /// Disk by artist: (artist, bytes, tracks), heaviest first.
    pub fn storage_by_artist(&self, limit: i64) -> Vec<(String, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT artist, COALESCE(SUM(size_bytes), 0), COUNT(*) FROM tracks
              WHERE deleted = 0 GROUP BY artist ORDER BY 2 DESC LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Disk by album: (album, album_artist, bytes, tracks), heaviest first.
    pub fn storage_by_album(&self, limit: i64) -> Vec<(String, String, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT album, album_artist, COALESCE(SUM(size_bytes), 0), COUNT(*) FROM tracks
              WHERE deleted = 0 GROUP BY album, album_artist ORDER BY 3 DESC LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Disk by codec: (codec, bytes, tracks), heaviest first.
    pub fn storage_by_codec(&self) -> Vec<(String, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT codec, COALESCE(SUM(size_bytes), 0), COUNT(*) FROM tracks
              WHERE deleted = 0 GROUP BY codec ORDER BY 2 DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The biggest albums nobody listens to: (album, album_artist, bytes,
    /// listens) for albums with at most `max_plays` listen events, largest
    /// first. Listens are counted through track ids, so a retagged album
    /// keeps its history.
    pub fn rarely_played_albums(
        &self,
        max_plays: i64,
        limit: i64,
    ) -> Vec<(String, String, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.album, t.album_artist, COALESCE(SUM(t.size_bytes), 0) AS bytes,
                    (SELECT COUNT(*) FROM listen_events le
                      JOIN tracks lt ON lt.id = le.track_id
                     WHERE lt.album = t.album AND lt.album_artist = t.album_artist) AS plays
               FROM tracks t
              WHERE t.deleted = 0 AND t.album != ''
              GROUP BY t.album, t.album_artist
             HAVING plays <= ?1
              ORDER BY bytes DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![max_plays, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// One user's playlists with the identity of every track, for the backup
    /// export: (name, [(rel_path, title, artist, album)]) in playlist order.
    pub fn export_playlists(
        &self,
        user_id: i64,
    ) -> Vec<(String, Vec<(String, String, String, String)>)> {
        let conn = self.lock();
        let Ok(mut heads) =
            conn.prepare("SELECT id, name FROM playlists WHERE user_id = ?1 ORDER BY name")
        else {
            return Vec::new();
        };
        let lists: Vec<(i64, String)> = heads
            .query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default();
        drop(heads);
        let Ok(mut items) = conn.prepare(
            "SELECT t.rel_path, t.title, t.artist, t.album
               FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
              WHERE pt.playlist_id = ?1 AND t.deleted = 0 ORDER BY pt.position",
        ) else {
            return Vec::new();
        };
        lists
            .into_iter()
            .map(|(id, name)| {
                let tracks: Vec<(String, String, String, String)> = items
                    .query_map(params![id], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                    })
                    .map(|r| r.filter_map(Result::ok).collect())
                    .unwrap_or_default();
                (name, tracks)
            })
            .collect()
    }

    /// One user's favourites as library-relative paths, oldest heart first.
    pub fn favorite_paths(&self, user_id: i64) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.rel_path FROM favorites f JOIN tracks t ON t.id = f.track_id
              WHERE f.user_id = ?1 AND t.deleted = 0 ORDER BY f.added_at",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| r.get(0))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// One playlist's rows as an M3U needs them: (title, artist, duration_ms,
    /// rel_path) in playlist order.
    pub fn playlist_export_rows(
        &self,
        playlist_id: i64,
    ) -> Vec<(String, String, Option<i64>, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.title, t.artist, t.duration_ms, t.rel_path
               FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
              WHERE pt.playlist_id = ?1 AND t.deleted = 0 ORDER BY pt.position",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![playlist_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map(|r| r.filter_map(Result::ok).collect())
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
    pub year: Option<i64>,
    /// Already measured - so a lyrics-only pass skips the audio analysis.
    pub has_bpm: bool,
    /// Already embedded.
    pub has_vec: bool,
    pub bpm: Option<f64>,
    pub energy: Option<f64>,
    pub brightness: Option<f64>,
    /// Difference between quiet and loud short windows, normalized to 0-1.
    pub dynamic_range: Option<f64>,
    /// Short-window spectral change, normalized to 0-1.
    pub rhythmic_activity: Option<f64>,
    pub loudness: Option<f64>,
    pub ai_summary: String,
    pub ai_genres: Vec<String>,
    pub ai_moods: Vec<String>,
    pub ai_sonic_traits: Vec<String>,
    pub ai_lyrical_themes: Vec<String>,
    pub ai_confidence: f64,
}

/// What is known about one track's sound and words.
pub struct TrackFeatures {
    pub track_id: i64,
    pub bpm: Option<f64>,
    pub lyric_vec: Option<Vec<f32>>,
    pub genre: String,
    pub ai_genres: Vec<String>,
    pub ai_sonic_traits: Vec<String>,
    pub artist: String,
    /// The analyser's audio character (features.rs), None until measured.
    pub energy: Option<f64>,
    pub brightness: Option<f64>,
    /// Difference between quiet and loud short windows, normalized to 0-1.
    pub dynamic_range: Option<f64>,
    /// Short-window spectral change, normalized to 0-1.
    pub rhythmic_activity: Option<f64>,
    pub musicbrainz_id: String,
    pub listenbrainz_similar: Vec<String>,
    pub sonic_vec: Option<Vec<f32>>,
    pub lyrical_vec: Option<Vec<f32>>,
    pub community_vec: Option<Vec<f32>>,
    /// Versioned spectral/temporal fingerprint measured directly from audio.
    pub audio_fingerprint: Option<Vec<f32>>,
    /// The tag's release year, for the decade stations.
    pub year: Option<i64>,
    /// Collector quarantine: an unadopted audition must not seed anyone's
    /// mixes - it is not part of the library yet.
    pub quarantined: bool,
}

/// One playlist the curator built.
pub struct CuratedList {
    pub slug: String,
    pub name: String,
    pub blurb: String,
    pub track_ids: Vec<i64>,
    pub built_at: i64,
}

/// One album a library search surfaced, aggregated from the tracks that
/// matched inside it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AlbumHit {
    pub album: String,
    #[serde(rename = "albumArtist")]
    pub album_artist: String,
    pub year: Option<i64>,
    #[serde(rename = "trackCount")]
    pub track_count: i64,
    /// One member track's id - what the client builds `/api/art/{id}` from.
    #[serde(rename = "coverId")]
    pub cover_id: i64,
}

/// The one-row totals behind a stats summary window.
#[derive(Default)]
pub struct ListenTotals {
    pub events: i64,
    pub plays: i64,
    pub ms: i64,
    pub unique_tracks: i64,
    pub unique_artists: i64,
    pub completed: i64,
    pub skipped: i64,
}

/// One remembered search result, as the API hands it back.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecentRow {
    pub kind: String,
    pub key: String,
    pub title: String,
    pub subtitle: String,
    pub cover: String,
    pub url: String,
    pub at: i64,
}

/// One candidate from the wider catalogue.
pub struct DiscoveryRow {
    pub ext_id: String,
    pub title: String,
    pub artist: String,
    pub cover: String,
    pub url: String,
    pub preview: String,
    pub seed: String,
    pub popularity: f64,
    pub bpm: Option<f64>,
    pub lyric_vec: Option<Vec<f32>>,
    pub score: f64,
}

fn discovery_from_row(r: &rusqlite::Row) -> rusqlite::Result<DiscoveryRow> {
    let blob: Option<Vec<u8>> = r.get(9)?;
    let dims: i64 = r.get(10)?;
    let vec = blob
        .filter(|b| dims > 0 && b.len() == dims as usize * 4)
        .map(|b| {
            b.chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect::<Vec<f32>>()
        });
    Ok(DiscoveryRow {
        ext_id: r.get(0)?,
        title: r.get(1)?,
        artist: r.get(2)?,
        cover: r.get(3)?,
        url: r.get(4)?,
        preview: r.get(5)?,
        seed: r.get(6)?,
        popularity: r.get(7)?,
        bpm: r.get(8)?,
        lyric_vec: vec,
        score: r.get(11)?,
    })
}

/// Which shelf a file belongs to, decided by where it lives. The Audiobooks/
/// folder IS the contract: the book importer files there, a listener dropping
/// their own m4b/mp3 rips there gets the same treatment, and nothing outside
/// it can ever be mistaken for a book.
pub fn kind_for(rel_path: &str) -> &'static str {
    if rel_path.starts_with("Audiobooks/") {
        "book"
    } else {
        "music"
    }
}
