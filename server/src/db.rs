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
/// One playlist as the API sends it: its head, its decoration, its songs.
///
/// A struct rather than the tuple this used to be. Three more fields turned an
/// unlabelled six-tuple into something no reader could hold - and the ordering
/// of `description, folder, cover` is exactly the kind of thing that swaps
/// silently and puts a folder name in a description.
pub struct PlaylistRow {
    pub id: i64,
    pub name: String,
    pub updated_at: i64,
    pub description: String,
    pub folder: String,
    pub cover: String,
    /// Separate this list's songs ahead of being asked.
    pub auto_stem: bool,
    pub tracks: Vec<i64>,
    /// Whose list it is, and what the asking user may do with it: 'owner',
    /// 'editor' (add and remove songs) or 'viewer' (see and play).
    pub owner_id: i64,
    pub owner_name: String,
    pub role: String,
}

/// One line of a shared list's news, as playlist_activity_for hands it out.
/// Names are joined in so the feed never has to ask twice.
#[derive(Debug, Clone)]
pub struct PlaylistActivityRow {
    pub id: i64,
    pub playlist_id: i64,
    pub playlist_name: String,
    pub owner_id: i64,
    pub owner_name: String,
    pub actor_id: i64,
    pub actor_name: String,
    pub kind: String,
    pub track_id: Option<i64>,
    pub at: i64,
}

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

/// How many activity rows are kept. Roughly a week of an ordinarily busy hub,
/// and small enough that the table never becomes a thing anyone has to think
/// about. Nothing reads further back than the pane's newest page anyway.
const ACTIVITY_KEEP: i64 = 4_000;

/// One thing the background machinery did, on the way in.
///
/// Borrowed rather than owned: every caller is a loop that already has these
/// as slices, and a log line should not cost a round of allocations.
pub struct NewActivity<'a> {
    pub source: &'a str,
    pub kind: &'a str,
    pub state: &'a str,
    pub key: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub track_id: Option<i64>,
    /// Free-form JSON, as a string. The client treats it as opaque.
    pub detail: Option<String>,
}

/// One activity row, on the way out.
pub struct ActivityRow {
    pub id: i64,
    /// Unix SECONDS, like every other timestamp the API hands out.
    pub at: i64,
    pub source: String,
    pub kind: String,
    pub state: String,
    pub key: String,
    pub title: String,
    pub body: String,
    pub track_id: Option<i64>,
    pub detail: Option<String>,
}

/// One file the peer owes the hub, as the outbox holds it.
pub struct PeerSyncRow {
    pub rel_path: String,
    pub track_id: i64,
    pub job_id: String,
    pub state: String,
    pub upload_id: String,
    pub sent_bytes: i64,
    pub size_bytes: i64,
    pub attempts: i64,
    pub next_try_at: i64,
    pub error: String,
    pub queued_at: i64,
    /// Epoch milliseconds, like every other clock in this table.
    pub updated_at: i64,
}

/// The outbox at a glance - what the status route reports.
pub struct PeerSyncCounts {
    pub pending: i64,
    pub uploading: i64,
    pub done: i64,
    pub skipped: i64,
    pub failed: i64,
}

const PEER_SYNC_COLS: &str = "rel_path, track_id, job_id, state, upload_id, sent_bytes, \
                              size_bytes, attempts, next_try_at, error, queued_at, updated_at";

fn peer_sync_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PeerSyncRow> {
    Ok(PeerSyncRow {
        rel_path: r.get(0)?,
        track_id: r.get(1)?,
        job_id: r.get(2)?,
        state: r.get(3)?,
        upload_id: r.get(4)?,
        sent_bytes: r.get(5)?,
        size_bytes: r.get(6)?,
        attempts: r.get(7)?,
        next_try_at: r.get(8)?,
        error: r.get(9)?,
        queued_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
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
  -- What it is for, where it files, and the cover it wears. Empty rather than
  -- NULL throughout: every reader wants a string, and a migration that adds a
  -- nullable column makes every one of them handle a case that means the same
  -- thing as "". The migration in ensure_columns adds these to older files.
  description TEXT NOT NULL DEFAULT '',
  folder      TEXT NOT NULL DEFAULT '',
  -- A relative path under the covers directory, never the image itself.
  cover       TEXT NOT NULL DEFAULT '',
  -- Whether the separator should pull this list's songs apart ahead of being
  -- asked. Off by default and opted into per list: separating everything a
  -- person ever playlisted is how the stem cache grew past its welcome.
  auto_stem   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlists_user ON playlists(user_id);

CREATE TABLE IF NOT EXISTS fx_presets (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  chain      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);

-- Songs a listener has filed into a playlist that this box does NOT own yet -
-- the "plan to acquire" members of a playlist. Kept apart from playlist_tracks
-- (which is a hard FK to a real track) exactly the way pending_likes is kept
-- apart from favourites: keyed by the same folded identity the discovery layer
-- settles on (k = fold(artist)|titleKey(title) == key_of), per playlist. The
-- moment a matching track lands, the collector's sweep appends its real id to
-- playlist_tracks and deletes the want here, so the ghost dissolves into an
-- ordinary row. Additive - no existing table is touched.
CREATE TABLE IF NOT EXISTS playlist_wants (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  k           TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  artist      TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, k)
);

-- Who else a playlist is open to. The owner is playlists.user_id and is never
-- a row here; a row is a friend the owner let in, as a viewer (sees and plays)
-- or an editor (adds and removes songs too). A NEW table rather than a column
-- on playlists, because the schema batch never re-runs on a deployed box - a
-- new column would need the ensure_columns pass, a new table just appears.
CREATE TABLE IF NOT EXISTS playlist_members (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer',
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, user_id)
);
CREATE INDEX IF NOT EXISTS playlist_members_user ON playlist_members(user_id);

-- What happened on a shared list, kept for the people it happened TO. Until
-- this table nothing recorded WHO added a song or WHEN a list was shared -
-- playlist_tracks is (list, track, position) and a share simply appeared in
-- the friend's list response - so there was no way to tell a member "ana
-- added Dreams" or to show an invite as anything but a new row. One row per
-- event: `shared` (owner let target_id in), `added` / `removed` (actor put
-- track_id in or took it out), `left` (target_id let themselves out),
-- `unshared` (owner showed target_id out). Who gets told what is decided at
-- read time (playlist_activity_for), never here. Pruned past sixty days on
-- write, the way chart_snapshots is.
CREATE TABLE IF NOT EXISTS playlist_activity (
  id          INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  actor_id    INTEGER NOT NULL,
  target_id   INTEGER,
  kind        TEXT NOT NULL,
  track_id    INTEGER,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_activity_list ON playlist_activity(playlist_id, at);

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

-- What a listener decided about an audition on Music Date.
--
-- There was no such table, which is why a pass cost nothing and changed
-- nothing: the deck's verdicts were read once inside the request that reported
-- them and then dropped, and the only record of a pass lived in one browser's
-- localStorage. A second device re-dealt every card that had already been
-- turned down, and the file sat on the disk forever.
--
-- Keyed on (user_id, track_id) because an audition belongs to exactly one
-- listener: there is no second opinion to record.
CREATE TABLE IF NOT EXISTS date_verdicts (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL,
  verdict  TEXT    NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS date_verdicts_user ON date_verdicts(user_id, at DESC);

-- The global chart as it stood at one moment. "Rising" is a comparison,
-- and until this table existed there was nothing to compare against: the
-- chart was fetched, fanned into the pool, and forgotten. Twelve-hourly
-- rows, pruned past five weeks. `rank` is the 1-based chart position.
CREATE TABLE IF NOT EXISTS chart_snapshots (
  fetched_at INTEGER NOT NULL,
  ext_id     TEXT    NOT NULL,
  artist_key TEXT    NOT NULL,
  rank       REAL    NOT NULL,
  PRIMARY KEY (fetched_at, ext_id)
);
CREATE INDEX IF NOT EXISTS chart_snapshots_artist ON chart_snapshots(artist_key, fetched_at);

-- A thumb in the DJ or on the radio: the listener's word on a song the
-- machine chose, at the moment they gave it. 'up' or 'down'. A down also
-- writes the rejection memory (see reactions.rs); an up is recorded and
-- nothing more - hearts stay explicit, a thumb is not a heart.
CREATE TABLE IF NOT EXISTS dj_reactions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL,
  reaction    TEXT    NOT NULL,
  position_ms INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dj_reactions_user ON dj_reactions(user_id, created_at DESC);

-- What a listener decided about a PREVIEW date - a pool candidate that was
-- never a track. Keyed by the normalised artist+title (discovery::key_of),
-- not the catalogue's ext_id, because a pass used to just DELETE the
-- candidate row and the next harvest (six-hourly, or the one a finished deck
-- kicks off from the very artists just kept) found the same song again and
-- dealt it again. The key survives the row; the harvester checks it before
-- inserting, and the deal checks it before dealing.
CREATE TABLE IF NOT EXISTS date_candidate_verdicts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT    NOT NULL,
  verdict TEXT    NOT NULL,
  at      INTEGER NOT NULL,
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

-- "Not for me", remembered.
--
-- Dismissing a discovery used to forget the row and nothing else, so the very
-- next harvest was free to offer the same song back - and did, because the
-- thing that made it a good candidate is still true. The refusal is the one
-- piece of taste a listener states out loud, and it was the one we did not
-- keep.
--
-- Two scopes: 'track' (the folded artist|title key, same vocabulary as
-- date_candidate_verdicts) and 'artist' (the folded artist name). The row is
-- kept past its hard block on purpose - the memory is still worth having for
-- seed selection after the block lapses, and for saying why something has not
-- come back.
CREATE TABLE IF NOT EXISTS discovery_rejections (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  key         TEXT NOT NULL,
  rejected_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope, key)
);

-- Which research lane a pool candidate came in through. A sidecar rather than
-- a column on discoveries, because open() lands new TABLES on a deployed
-- database and never new columns. Lanes: 'taste' (artists near your plays),
-- 'scene' (the small-artist engine), 'trending' (the charts), 'fresh' (new
-- releases people are suddenly playing). Absent rows read as 'taste', which is
-- what everything harvested before lanes existed was.
CREATE TABLE IF NOT EXISTS discovery_lanes (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ext_id   TEXT NOT NULL,
  lane     TEXT NOT NULL,
  -- The lane's own standing for this candidate: chart position or fresh-release
  -- listen count, normalised 0-1. Popularity in the lane's terms, kept apart
  -- from the taste score.
  rank     REAL NOT NULL DEFAULT 0,
  found_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ext_id)
);

-- Every thread between a pool candidate and something of the listener's.
--
-- `discoveries.seed` is ONE artist name, overwritten by whichever harvester
-- last saw the candidate. That was the whole record of why a song was in the
-- pool: no second anchor, no relation kind, no strength - a candidate reached
-- from two of your artists kept only the later one, and a card could say
-- nothing truer than "because you play X". This table is the thread itself,
-- one row per (candidate, your artist, how they connect). `kind` is the
-- source of the connection: 'deezer_related' (the catalogue's neighbour
-- graph, strength 1/(1+rank)), 'lb_similar' (ListenBrainz co-listening, the
-- score normalised to the seed's top neighbour), 'mb_member' / 'mb_side' /
-- 'mb_collab' (a MusicBrainz relationship: shared a band, a side project, a
-- collaboration), 'same_artist' (their own back catalogue), 'keep' (an
-- artist from a Music Date keep). `anchor_key` is the pool's identity fold
-- of the artist (discovery::artist_key, the same vocabulary as an 'artist'
-- rejection); `anchor_name` is the name as the library spells it, for the
-- card. Anchors are written only after `add_discovery` ACCEPTED the row, so
-- a judged song cannot acquire threads it will never be dealt on.
CREATE TABLE IF NOT EXISTS discovery_anchors (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ext_id      TEXT    NOT NULL,
  anchor_key  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  strength    REAL    NOT NULL,
  anchor_name TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, ext_id, anchor_key, kind)
);
CREATE INDEX IF NOT EXISTS discovery_anchors_anchor ON discovery_anchors(user_id, anchor_key);

-- One listener's mood profile: what they have ACTUALLY been playing lately,
-- clustered. Rebuilt daily by the programmer; read whole by scoring, the
-- station builder and the settings pane. A JSON blob like transcripts, for the
-- same reason - one writer, few readers, never queried by parts.
CREATE TABLE IF NOT EXISTS dj_sets (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vibe        TEXT NOT NULL,
  -- The finished reply, exactly as /api/dj would say it: {ai, vibe, blocks}.
  body        TEXT NOT NULL,
  built_at    INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, vibe)
);

-- One short spoken-style fact per SONG, model-written, shared by every
-- listener (lore belongs to the record, not the person). An empty body is a
-- negative cache: the model was asked and did not know - kept so sets do not
-- re-ask every press, retried once it has aged out (the model may improve).
-- A like promised before the song exists: hearted on Discover while the
-- download is still in flight. Keyed by the folded artist+title identity the
-- discovery layer already uses; the collector's sweep turns each row into a
-- real favourite the moment a matching track lands, however it lands.
-- The AI-grouped "new music" shelf, durable: the in-memory copy died with
-- every restart, and on a box that redeploys often the shelf read as
-- permanently empty. One row per user, the served JSON verbatim.
CREATE TABLE IF NOT EXISTS new_music_cache (
  user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body     TEXT NOT NULL,
  built_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  k          TEXT NOT NULL,
  title      TEXT NOT NULL,
  artist     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, k)
);

-- One short true thing about an ARTIST, model-written and shared - the date
-- briefing's "tell me about the band". Same contract as song_lore: empty
-- body = asked-and-unknown (negative cache), keyed by the folded artist name.
CREATE TABLE IF NOT EXISTS artist_lore (
  k        TEXT PRIMARY KEY,
  artist   TEXT NOT NULL,
  body     TEXT NOT NULL,
  built_at INTEGER NOT NULL
);

-- The catalogue's read on one ARTIST, cached hub-wide so the second date that
-- meets them is instant. A band is a band whoever is listening - the same
-- argument artist_lore makes - so this is not per-user.
--
-- The body is JSON rather than columns on purpose: open() lands new TABLES on
-- a deployed database and never new columns, so a JSON payload is the only
-- shape that can gain a field later without a migrate() entry.
--
-- The PROSE deliberately stays out of here. It lives in artist_lore and is
-- spliced in when the profile is served, so a blurb that lands later deepens
-- every cached profile without rewriting a single row.
CREATE TABLE IF NOT EXISTS artist_profiles (
  k          TEXT PRIMARY KEY,
  artist     TEXT NOT NULL,
  body       TEXT NOT NULL,
  -- Which sources actually answered, comma separated. The client renders a
  -- block only when its source is in here, so an empty list is a profile that
  -- says nothing rather than one that guesses.
  sources    TEXT NOT NULL DEFAULT '',
  -- The last SUCCESSFUL build, and the last ATTEMPT. Split because a failed
  -- build must advance the attempt clock and leave the body alone: an outage
  -- should never blank a profile somebody already has.
  built_at   INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artist_profiles_stale ON artist_profiles(checked_at);

CREATE TABLE IF NOT EXISTS song_lore (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  body     TEXT NOT NULL,
  built_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mood_profiles (
  user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  built_at INTEGER NOT NULL,
  profile  TEXT NOT NULL
);

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
  context     TEXT NOT NULL DEFAULT '',
  -- The shape of the sitting - see migrate() for what each one is for.
  ended_at_ms INTEGER,
  volume_ups  INTEGER NOT NULL DEFAULT 0,
  seek_backs  INTEGER NOT NULL DEFAULT 0,
  device      TEXT NOT NULL DEFAULT ''
);

-- What the DJ actually offered, so adoption can be judged per impression
-- rather than per catalog: a track queued five times and never finished is a
-- signal, and without this table it is indistinguishable from a track never
-- offered at all. slot names the mechanism ('rank' = scored pick,
-- 'explore' = an exploration slot's gamble).
CREATE TABLE IF NOT EXISTS dj_impressions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   INTEGER NOT NULL,
  slot       TEXT NOT NULL DEFAULT 'rank',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dj_impressions_user ON dj_impressions(user_id, track_id);

-- MusicBrainz artist ids by folded name, cached forever including misses:
-- MB politely asks not to be asked twice, and a name that is not there today
-- will not be there tomorrow under the same spelling.
CREATE TABLE IF NOT EXISTS mb_artists (
  name_key   TEXT PRIMARY KEY,
  mbid       TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL
);

-- Which hearted artists the scene walk has already dug around, so the walk
-- rotates instead of circling one favourite.
CREATE TABLE IF NOT EXISTS scene_walks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_key TEXT NOT NULL,
  walked_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, artist_key)
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

-- Real loudness, as opposed to track_features.loudness - which is a rough 0-1
-- impression taken from ninety seconds of the middle of a file and is right
-- for mood playlists and wrong for gain. These are the ITU/EBU numbers,
-- measured across the WHOLE track, and they are what playback normalisation
-- rides on:
--   lufs    integrated loudness in LUFS, negative, quiet is more negative
--   peak_db true peak in dBTP - the reason a boost can be refused, since
--           lifting a track that already touches 0 dBFS is just clipping
--   lra     loudness range in LU, the honest "how dynamic is this master"
-- Its own table on purpose: Db::open only ever runs CREATE TABLE IF NOT
-- EXISTS, so a new TABLE lands on the deployed database and a new COLUMN
-- silently never would.
-- Separated stems: one row per (track, stem). The audio itself lives on disk
-- under the data dir - a few megabytes per stem is not a thing to put in
-- SQLite - and this is the index plus the cache bookkeeping.
--
-- `model` is part of the identity so a better separator later can coexist
-- with what is already on disk instead of silently mixing two qualities.
CREATE TABLE IF NOT EXISTS track_stems (
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  stem       TEXT NOT NULL,          -- vocals | drums | bass | other
  model      TEXT NOT NULL,
  rel_path   TEXT NOT NULL,          -- under <data>/stems
  bytes      INTEGER NOT NULL,
  made_at    INTEGER NOT NULL,
  used_at    INTEGER NOT NULL,       -- for eviction: least recently played
  PRIMARY KEY (track_id, stem, model)
);
CREATE INDEX IF NOT EXISTS track_stems_used ON track_stems(used_at);

-- The work queue. A track is asked for once and separated once; the client
-- polls this rather than holding a connection open for the minutes it takes.
CREATE TABLE IF NOT EXISTS stem_jobs (
  track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  state        TEXT NOT NULL,        -- queued | running | done | failed
  error        TEXT NOT NULL DEFAULT '',
  requested_at INTEGER NOT NULL,
  started_at   INTEGER NOT NULL DEFAULT 0,
  finished_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stem_jobs_state ON stem_jobs(state, requested_at);

-- Songs separated before anyone asks - and, more importantly, the memory of the
-- ones the cache has since thrown away.
--
-- A separate TABLE, for two reasons. A new table lands on a deployed database
-- through execute_batch(SCHEMA); a new column silently does not. And
-- forget_stems() deletes the track_stems AND stem_jobs rows on eviction, which
-- leaves an evicted song indistinguishable from one never separated - so the
-- prefetcher would queue it again, and again, at ~24s of GPU a lap, forever.
-- This is the one table eviction does not touch.
CREATE TABLE IF NOT EXISTS transcripts (
  track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  -- `[{startMs, endMs, text}]`, in order. Held as a blob of JSON rather than a
  -- row per line because it is only ever read whole, by one reader, for one
  -- book - and a twelve-hour reading is tens of thousands of lines that no
  -- query will ever want to filter.
  lines      TEXT    NOT NULL,
  -- Which model said so, so a transcript made by a small model can be told
  -- apart from one made by a better one later.
  model      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);

-- What each chapter of a book IS, said by an AI that has read its opening.
-- One row per (track, chapter): a single-file book's marks index within the
-- one track; a book of sections has one row per section at idx 0. `name` is
-- what the audio DECLARES itself to be - a preamble tagged "Chapter 1" gets
-- called a preamble - and `blurb` is one non-spoiler line. A separate table
-- for the same reason transcripts are: it lands on deployed databases.
CREATE TABLE IF NOT EXISTS chapter_blurbs (
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  blurb      TEXT    NOT NULL,
  model      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, idx)
);

-- What HAPPENED in each chapter, for the catch-up. The blurb next door is a
-- teaser and must never reveal an outcome; this is its opposite - the outcomes
-- are the whole point, because a recap is read by someone who already heard
-- them. Written chapter at a time, off the request path, from the same sweep,
-- so pressing "Catch me up" is one model call over text already on disk.
--
-- `start_ms`/`end_ms` are the window inside the track, and they are what makes
-- the spoiler bound enforceable by SQL rather than by trust: the recap takes
-- rows that END at or before the bookmark and no others.
-- Songs Spotify has NO Canvas for.
--
-- The clip itself is kept as a sidecar beside the audio, so a hit is remembered
-- by the file existing. A MISS had nowhere to live but a HashMap cleared on
-- every restart, which meant a library of canvas-less songs paid for a Spotify
-- lookup each, every boot, forever - and until each answer came back the card
-- showed a stand-in. Remembering the noes is what stops that.
--
-- `checked_at` so a sweep can eventually re-ask: an artist who releases a
-- Canvas next year should not be written off permanently by one lookup today.
CREATE TABLE IF NOT EXISTS canvas_misses (
  track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS book_recap_parts (
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  start_ms   INTEGER NOT NULL DEFAULT 0,
  end_ms     INTEGER NOT NULL DEFAULT 0,
  summary    TEXT    NOT NULL,
  model      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, idx)
);

-- The finished catch-up, per reader per book. One row: a recap is only ever
-- wanted for where you ARE, and where you are moves. `upto_ms` and `parts`
-- together say what it was written from, which is how a second press inside
-- the same chapter is answered from here instead of paying for the model again.
CREATE TABLE IF NOT EXISTS book_recaps (
  user_id    INTEGER NOT NULL,
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  upto_ms    INTEGER NOT NULL,
  parts      INTEGER NOT NULL DEFAULT 0,
  body       TEXT    NOT NULL,
  model      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, track_id)
);

-- A song's real lyrics with a clock on every word: LRCLIB's lines, timed
-- against what the recogniser heard (see lyricsync.rs). `matched`/`words`
-- record how much of it was measured rather than interpolated, so a later
-- pass with a better model can tell whether it would be an improvement.
CREATE TABLE IF NOT EXISTS lyric_words (
  track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  lines      TEXT    NOT NULL,
  matched    INTEGER NOT NULL DEFAULT 0,
  words      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- Every line anything in the library SAYS: a book's transcript, a song's
-- aligned lyrics. Not content-linked to a table (the text lives inside JSON
-- blobs, one row per track), so it is written alongside those blobs and
-- rebuilt wholesale by reindex_spoken() - which is cheap, because the words
-- are already on disk and the walk is text.
CREATE VIRTUAL TABLE IF NOT EXISTS spoken_fts USING fts5(
  text,
  track_id UNINDEXED,
  start_ms UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- What a transcript says about the shape of a reading: how fast it is read,
-- where the publisher's card ends and where the credits begin. Derived, so it
-- is cached rather than authoritative - deleting a row costs one re-analysis.
--
-- Its own table rather than columns on `transcripts` for the usual reason (a
-- new table lands through execute_batch(SCHEMA), a new column does not), and
-- because the two have different lifetimes: re-transcribing with a better
-- model should replace this, and nothing else should.
CREATE TABLE IF NOT EXISTS book_shape (
  track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  wpm          INTEGER NOT NULL DEFAULT 0,
  pace         TEXT    NOT NULL DEFAULT '',
  -- 0 means "none found", never "the start of the file". The offer is only
  -- made for a positive number.
  opening_ms   INTEGER NOT NULL DEFAULT 0,
  credits_ms   INTEGER NOT NULL DEFAULT 0,
  opening_text TEXT    NOT NULL DEFAULT '',
  credits_text TEXT    NOT NULL DEFAULT '',
  words        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stem_prefetch (
  track_id       INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  state          TEXT NOT NULL,             -- wanted | running | done | failed | evicted
  reason         TEXT NOT NULL DEFAULT '',  -- liked | playlist
  queued_at      INTEGER NOT NULL,
  finished_at    INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  error          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS stem_prefetch_state ON stem_prefetch(state, queued_at);

-- What the background machinery has been doing, at CYCLE level: a song pulled
-- into stems, an AI pass, a collector sweep. Two readers, one need each - the
-- verbose-notifications watcher turns new rows into bell rows, and the Local AI
-- pane shows the owner what the model has been up to. One table serving both is
-- the point; a second channel for either would be a second thing to keep in
-- step.
--
-- Server-wide, not per user: the prefetcher takes songs apart library-wide with
-- no owner on the job and the AI passes run for everyone, so there is nobody to
-- address. The reader's own verbose switch is the opt-in.
--
-- `key` pairs a start with its finish (`stems:<trackId>`), which is what lets a
-- client replace the "started" row rather than stack a second one beside it.
CREATE TABLE IF NOT EXISTS activity_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  source   TEXT NOT NULL,
  kind     TEXT NOT NULL,
  state    TEXT NOT NULL,
  key      TEXT NOT NULL,
  title    TEXT NOT NULL,
  body     TEXT NOT NULL,
  track_id INTEGER,
  detail   TEXT
);
-- Every read is "everything after this id", and the pane also filters by source.
CREATE INDEX IF NOT EXISTS activity_events_source ON activity_events(source, id);

-- Server-wide choices the operator makes from the app rather than from a unit
-- file. Deliberately a key/value table and not columns: these are settings, not
-- data, and a new COLUMN does not land on a deployed database through
-- execute_batch(SCHEMA) while a new TABLE does.
CREATE TABLE IF NOT EXISTS server_prefs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The Subsonic door (subsonic.rs). A per-user app password, separate from
-- the account's: the protocol's token scheme is md5(password + salt), which
-- needs the password itself on this side, and the account password is an
-- argon2 hash on purpose. So a Subsonic client gets its own random secret,
-- shown once in Settings and revocable there, and never the real one.
CREATE TABLE IF NOT EXISTS subsonic_secrets (
  user_id    INTEGER PRIMARY KEY,
  secret     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A Subsonic client's saved play queue (savePlayQueue / getPlayQueue): the
-- song ids, which one is current and how far in, so the same person picks
-- up on another client where this one left off.
-- Another OpenSubsonic server this member imports from and exports to
-- (subsonic_remote.rs): where it is and who they are there. The password is
-- kept as typed because that API's token is md5(password + salt) - the same
-- class of secret as the Spotify cookie, never read back out by any route.
CREATE TABLE IF NOT EXISTS subsonic_accounts (
  user_id     INTEGER PRIMARY KEY,
  url         TEXT NOT NULL,
  username    TEXT NOT NULL,
  password    TEXT NOT NULL,
  server_type TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subsonic_queue (
  user_id    INTEGER PRIMARY KEY,
  ids        TEXT NOT NULL,
  current    INTEGER,
  position   INTEGER NOT NULL DEFAULT 0,
  changed    INTEGER NOT NULL,
  changed_by TEXT NOT NULL DEFAULT ''
);

-- The enumeration probes both by track_id, which neither primary key serves:
-- favorites is keyed (user_id, track_id) and playlist_tracks (playlist_id,
-- position). Without these it full-scans both on every pass.
CREATE INDEX IF NOT EXISTS favorites_track ON favorites(track_id);
CREATE INDEX IF NOT EXISTS playlist_tracks_track ON playlist_tracks(track_id);

CREATE TABLE IF NOT EXISTS track_loudness (
  track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  lufs        REAL NOT NULL,
  peak_db     REAL NOT NULL,
  lra         REAL NOT NULL,
  measured_at INTEGER NOT NULL
);

-- The shape of a track, for drawing on a seek bar before a note is played.
--
-- `columns` is a fixed-width run of bytes, one per column of the drawing, each
-- 0-255 for how loud that slice of the track is against the track's own
-- loudest moment. Fixed width so a song and a twelve-hour book cost the same
-- and the client never has to know the duration to draw it.
--
-- A separate table rather than a column on track_loudness because the two are
-- filled by the same pass but not always together: every track measured before
-- this existed has loudness and no shape, and the sweep uses exactly that
-- difference to find them.
-- Songs whose word clocks should be worked out AGAIN.
--
-- A marker rather than a deletion, and that distinction is the whole point.
-- The first re-timing worked by clearing `lyric_words`, because the sweep only
-- offers a song it has no clocks for - which meant asking for a better answer
-- threw away the working one first, and every song in the library read
-- unsynced for however many hours the recogniser needed to catch up. Marked
-- instead, the old timing keeps playing until the new one overwrites it.
CREATE TABLE IF NOT EXISTS lyric_stale (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  asked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS track_waveform (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  columns  BLOB NOT NULL,
  made_at  INTEGER NOT NULL
);

-- Which library rows a landed pull became - what lets an adoption find its
-- pull, and a pull report its real size.
CREATE TABLE IF NOT EXISTS curator_pull_tracks (
  pull_id  INTEGER NOT NULL REFERENCES curator_pulls(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL,
  PRIMARY KEY (pull_id, track_id)
);

-- What a PEER reported it delivered for a delegated pull, as the hub's own
-- rel_path (the peer learns it from the upload's reply, since the hub re-derives
-- the path from the file's tags and may suffix a collision).
--
-- This exists because the first version settled a delegated pull by MATCHING
-- artist and title against everything recently added, which quietly annexed
-- whatever else happened to arrive: an unrelated upload became one listener's
-- private audition, vanished from every other client, and was unlinked from
-- disk if that listener swiped past it. A pull now lands on exactly the files
-- it was told about, or on nothing.
CREATE TABLE IF NOT EXISTS curator_pull_paths (
  pull_id  INTEGER NOT NULL REFERENCES curator_pulls(id) ON DELETE CASCADE,
  rel_path TEXT    NOT NULL,
  PRIMARY KEY (pull_id, rel_path)
);

-- The collector's per-listener dials. A row appears the first time a dial is
-- touched or tuned; absence means the defaults (enabled, exploration 0.5).
CREATE TABLE IF NOT EXISTS collector_state (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  exploration REAL NOT NULL DEFAULT 0.5,
  tuned_at    INTEGER NOT NULL DEFAULT 0
);

-- The peer-sync outbox: files this box downloaded that the hub has not got
-- yet. Its own table on purpose - Db::open only ever runs CREATE TABLE IF NOT
-- EXISTS, so a new TABLE lands on a deployed database and a new COLUMN
-- silently never would.
--
-- Keyed by rel_path, not by import job id. A job card is mutable and
-- disposable - a retry blanks its files, a remove deletes it, and boot
-- rewrites an interrupted job to error - so a queue pointing at one would lose
-- the push the moment the listener tidied their download list.
CREATE TABLE IF NOT EXISTS peer_sync_queue (
  rel_path    TEXT    PRIMARY KEY,
  track_id    INTEGER NOT NULL DEFAULT 0,
  job_id      TEXT    NOT NULL DEFAULT '',
  -- pending | uploading | done | skipped | failed
  state       TEXT    NOT NULL DEFAULT 'pending',
  -- The hub's upload id, held across restarts. /api/upload/init always mints a
  -- fresh id over a fresh empty file, so a forgotten id both restarts the
  -- transfer from zero AND orphans the bytes already on the hub's disk, where
  -- nothing reaps them.
  upload_id   TEXT    NOT NULL DEFAULT '',
  sent_bytes  INTEGER NOT NULL DEFAULT 0,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  -- Backoff ladder: 1m, 5m, 15m, 1h, then 6h forever. Unlike spotify_items
  -- this one never goes dormant: a hub that was off for a weekend must still
  -- catch up by itself when it comes back, with nobody pressing a button.
  next_try_at INTEGER NOT NULL DEFAULT 0,
  error       TEXT    NOT NULL DEFAULT '',
  queued_at   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS peer_sync_due ON peer_sync_queue(state, next_try_at);
"#;

pub(crate) fn now_ms() -> i64 {
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

/// Everything about a sitting beyond how long it lasted and the two verdicts.
/// All optional on the wire: an older client sends none of it and the row
/// lands as it always did.
#[derive(Default, Clone)]
pub struct ListenShape {
    /// Deck position when the sitting closed, ms. Where they bailed.
    pub ended_at_ms: Option<i64>,
    pub volume_ups: i64,
    pub seek_backs: i64,
    /// "iPhone", "macOS", "car", "speaker" - the client's own word.
    pub device: String,
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
        /*
         * A BOOK FILED AS MUSIC IS RE-READ, not merely relabelled.
         *
         * Run every start, not once, because the mistake it repairs happens
         * after any migration: the folder test used to be case-SENSITIVE, so
         * a library whose owner made `audiobooks/` indexed every book as
         * music. Relabelling the rows would not be enough - the scanner skips
         * files whose size and mtime it already agrees with, so those rows
         * would keep the album, cover and (absent) chapters they were read
         * with. Clearing mtime is what makes the next walk read them properly.
         *
         * LIKE is case-insensitive for ASCII in SQLite, which is exactly the
         * spelling-blindness wanted here. Self-limiting: once a row comes back
         * as a book the WHERE stops matching it, so this costs one indexed
         * lookup per start thereafter.
         */
        conn.execute(
            "UPDATE tracks SET mtime = 0 WHERE kind <> 'book' AND rel_path LIKE 'Audiobooks/%'",
            [],
        )?;
        // What a playlist IS beyond its songs: what it is for, where it files,
        // and which picture it wears. On the PLAYLISTS table rather than beside
        // it, so it belongs to the playlist rather than to whoever happened to
        // decorate it - a household member opening a shared list sees the same
        // description the person who wrote it does.
        //
        // `cover` holds a relative path under the covers directory, never the
        // image. Bytes in a row make every playlist read carry them, and the
        // list endpoint returns every playlist a user owns on every heartbeat.
        let have: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('playlists')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        for (name, decl) in [
            ("description", "description TEXT NOT NULL DEFAULT ''"),
            ("folder", "folder TEXT NOT NULL DEFAULT ''"),
            ("cover", "cover TEXT NOT NULL DEFAULT ''"),
            ("auto_stem", "auto_stem INTEGER NOT NULL DEFAULT 0"),
        ] {
            if !have.iter().any(|c| c == name) {
                conn.execute(&format!("ALTER TABLE playlists ADD COLUMN {decl}"), [])?;
            }
        }
        // Which DEVICE a session belongs to, so one phone can be signed out of
        // one hub without every other device of the same person going with it.
        // Same runtime ALTER as above: the schema batch never re-runs on a
        // deployed box.
        let have: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('tokens')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        if !have.iter().any(|c| c == "device") {
            conn.execute("ALTER TABLE tokens ADD COLUMN device TEXT NOT NULL DEFAULT ''", [])?;
        }

        /*
         * What a listen looked like, not just that it happened.
         *
         * The ledger recorded how long was heard and two verdicts - completed,
         * skipped - and nothing about the shape of the sitting. Four things it
         * could not say, each one a signal the curator wants:
         *   ended_at_ms  WHERE the listener bailed. A skip in the intro and a
         *                skip at the chorus are different verdicts on a song,
         *                and ms_listened cannot tell them apart when a seek is
         *                involved.
         *   volume_ups   turned it up mid-song. Nobody turns up a song they
         *                are about to skip.
         *   seek_backs   rewound to hear a part again. The most deliberate
         *                approval a listener gives without a heart.
         *   device       where it was heard - a phone, a desktop, a car, a
         *                speaker in the kitchen. The same taste plays
         *                differently in each.
         * Runtime ALTERs, same as the four above: the schema batch never
         * re-runs on a deployed box.
         */
        let have: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('listen_events')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        for (name, decl) in [
            ("ended_at_ms", "ended_at_ms INTEGER"),
            ("volume_ups", "volume_ups INTEGER NOT NULL DEFAULT 0"),
            ("seek_backs", "seek_backs INTEGER NOT NULL DEFAULT 0"),
            ("device", "device TEXT NOT NULL DEFAULT ''"),
        ] {
            if !have.iter().any(|c| c == name) {
                conn.execute(&format!("ALTER TABLE listen_events ADD COLUMN {decl}"), [])?;
            }
        }

        /*
         * `discoveries` - what a candidate SOUNDS like, measured off its
         * preview clip, and when it came out. A candidate could answer two of
         * the score's terms (its words and its tempo); the texture and era
         * terms - two of the three things the listener said make a new song
         * feel connected - fell back to neutral for every one of them.
         */
        let have: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('discoveries')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        for (name, decl) in [
            ("energy", "energy REAL"),
            ("brightness", "brightness REAL"),
            ("rhythmic", "rhythmic REAL"),
            ("released", "released TEXT"),
        ] {
            if !have.iter().any(|c| c == name) {
                conn.execute(&format!("ALTER TABLE discoveries ADD COLUMN {decl}"), [])?;
            }
        }

        /*
         * `curator_pulls.origin` - WHO raised the pull: the collector's own
         * buying pass ('collector'), or a person (a Date keep, an artist-page
         * listen, a pasted link - left empty). The chart cadence counts the
         * collector's buys and nothing else; before this it read every row in
         * the ledger, so three artist-page taps could hand the next seat to
         * the chart.
         */
        let have: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('curator_pulls')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        if !have.iter().any(|c| c == "origin") {
            conn.execute("ALTER TABLE curator_pulls ADD COLUMN origin TEXT NOT NULL DEFAULT ''", [])?;
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
    /// The name to hang on this box in front of a friend: the registry owner's
    /// handle when the hub was claimed through the registry, else the first
    /// admin's username. Public through /api/server so an app can say
    /// "Matt's server" for songs that come from here.
    pub fn owner_display_name(&self) -> Option<String> {
        let conn = self.lock();
        let owner: Option<String> = conn
            .query_row(
                "SELECT handle FROM registry_members WHERE role = 'owner' ORDER BY joined_at LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if let Some(h) = owner.filter(|h| !h.trim().is_empty()) {
            return Some(h);
        }
        conn.query_row(
            "SELECT username FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

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

    /// The local seat behind a registry handle, for the profile door:
    /// (user_id, username, handle as stored, joined_at). Case-insensitive,
    /// matching the registry's own collation on handles.
    pub fn member_by_handle(&self, handle: &str) -> Option<(i64, String, String, i64)> {
        let conn = self.lock();
        conn.query_row(
            "SELECT m.user_id, u.username, m.handle, m.joined_at
               FROM registry_members m JOIN users u ON u.id = m.user_id
              WHERE m.handle = ?1 COLLATE NOCASE
              ORDER BY m.joined_at ASC LIMIT 1",
            params![handle],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .ok()
        .flatten()
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

    /// The same, case-blind - for matching a REGISTRY handle (always lower
    /// case on the wire) against a username somebody typed with capitals when
    /// they signed into this hub directly. Exact match wins where both exist.
    pub fn user_by_name_ci(&self, username: &str) -> Option<User> {
        self.user_by_name(username).or_else(|| {
            self.lock()
                .query_row(
                    "SELECT id, username, pass_hash, is_admin, stream_epoch FROM users
                      WHERE username = ?1 COLLATE NOCASE ORDER BY id ASC LIMIT 1",
                    params![username],
                    Self::read_user,
                )
                .optional()
                .ok()
                .flatten()
        })
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
        self.create_token_for(token, user_id, "")
    }

    /// Mint a session, labelled with the device that asked, and reap the dead.
    ///
    /// Sessions never expired and every entry minted a new row, so a person on
    /// three hubs left a row behind every time they switched - forever. A row
    /// unused for ninety days is a device that is gone; it goes here, on the
    /// one write every sign-in already makes, so no sweep is needed.
    pub fn create_token_for(&self, token: &str, user_id: i64, device: &str) -> rusqlite::Result<()> {
        let now = now_ms();
        let conn = self.lock();
        let _ = conn.execute(
            "DELETE FROM tokens WHERE last_seen < ?1",
            params![now - 90 * 24 * 3600 * 1000],
        );
        conn.execute(
            "INSERT INTO tokens (token, user_id, created_at, last_seen, device) VALUES (?1, ?2, ?3, ?3, ?4)",
            params![token, user_id, now, device.chars().take(80).collect::<String>()],
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

    /// Every indexed path with the mtime and size the index believes it has, and
    /// the cover it believes was cached, so the scanner can skip files that have
    /// not moved since last time.
    ///
    /// THE ART ID IS HERE FOR A REASON. mtime and size describe the audio file;
    /// they say nothing about the derived cover sitting in the art cache, which
    /// is a separate directory that can be lost on its own - restored from a
    /// backup that only covered the database, moved between machines, wiped to
    /// reclaim disk. When that happens every row still names an `art_id`, the
    /// files are all "unchanged", and the scanner skips every one of them, so
    /// the cache can never refill. The library then shows blank covers forever
    /// with nothing in any log to say why. Carrying the id lets the scan check
    /// the claim instead of trusting it.
    pub fn scan_fingerprints(
        &self,
    ) -> std::collections::HashMap<String, (i64, i64, Option<String>)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn
            .prepare("SELECT rel_path, mtime, size_bytes, art_id FROM tracks WHERE deleted = 0")
        else {
            return Default::default();
        };
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
        });
        rows.map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every live track's identity - title, artist, album artist, album,
    /// duration - for the sync precheck to match a client's local files
    /// against. Tags rather than hashes: the same song re-ripped should read
    /// as already here, and nobody hashes forty gigabytes to ask that.
    pub fn sync_identities(
        &self,
    ) -> Vec<(String, String, String, String, Option<i64>, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT title, artist, album_artist, album, duration_ms, rel_path
             FROM tracks WHERE deleted = 0",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
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
    /// How many tracks the library currently holds - live rows, not tombstones.
    /// Used by the scan to tell "the folder is empty" from "the folder could
    /// not be read", which look identical from the walk alone.
    pub fn live_track_count(&self) -> i64 {
        self.lock()
            .query_row("SELECT COUNT(*) FROM tracks WHERE deleted = 0", [], |r| r.get(0))
            .unwrap_or(0)
    }

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
    /// SCOPED TO THE CALLER, and that is a privacy fix rather than a tidy-up.
    ///
    /// A collector audition is a track the server bought speculatively FOR one
    /// listener; until they adopt it, it carries `curator_user_id = <them>` and
    /// `curator_promoted = 0`. This query used to hand every such row to every
    /// client and leave the filtering to the browser - `DatePage.tsx` did
    /// `.filter((t) => !status || t.curatorUserId === status.userId)`, which
    /// fails OPEN: `status` comes from a separate request, and any failure of
    /// that request left `status` null and showed one person's auditions to
    /// everybody.
    ///
    /// Filtering here instead means the bytes never leave the server, so no
    /// client bug can leak them and no client has to be trusted to try. It also
    /// makes the Date deck per-user for free: a client can only ever be dealt
    /// its own cards, because it is only ever sent its own cards.
    ///
    /// Adoption bumps `rev`, so a track that becomes visible later arrives on
    /// the next page like any other change.
    pub fn tracks_since(&self, user_id: i64, since: i64, limit: i64) -> (Vec<Track>, Vec<i64>, i64) {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks
             WHERE rev > ?1
               AND (curator_user_id IS NULL
                    OR COALESCE(curator_promoted, 0) = 1
                    OR curator_user_id = ?3)
             ORDER BY rev, id LIMIT ?2",
            Self::TRACK_COLS
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return (Vec::new(), Vec::new(), since);
        };
        let mut live = Vec::new();
        let mut removed = Vec::new();
        let mut max_rev = since;
        let rows = stmt.query_map(params![since, limit, user_id], |r| {
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

    /// A random handful of distinct covers, for a wall with no sign-in.
    pub fn random_art_ids(&self, limit: i64) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT art_id FROM (SELECT DISTINCT art_id FROM tracks
               WHERE deleted = 0 AND art_id IS NOT NULL AND art_id != '')
             ORDER BY RANDOM() LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit], |r| r.get::<_, String>(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// The same wall, but for a signed-in member: what THEY may hear. Their
    /// own auditions and everyone's promoted music, never another member's
    /// unadopted pull and never a book's cover. The public wall is a glance
    /// at the whole box; this one is the face of the Discover page and a
    /// member's page must not show them a sleeve they cannot play.
    pub fn random_art_ids_for(&self, user_id: i64, limit: i64) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT art_id FROM (SELECT DISTINCT art_id FROM tracks
               WHERE deleted = 0 AND art_id IS NOT NULL AND art_id != ''
                 AND COALESCE(kind, 'music') != 'book'
                 AND (curator_user_id IS NULL OR curator_user_id = ?1
                      OR COALESCE(curator_promoted, 0) = 1))
             ORDER BY RANDOM() LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], |r| r.get::<_, String>(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// Track ids a member may hear, at random (see `random_art_ids_for`).
    pub fn random_track_ids_for(&self, user_id: i64, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM tracks
              WHERE deleted = 0 AND COALESCE(kind, 'music') != 'book'
                AND (curator_user_id IS NULL OR curator_user_id = ?1
                     OR COALESCE(curator_promoted, 0) = 1)
              ORDER BY RANDOM() LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], |r| r.get::<_, i64>(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// A random handful of track ids (canvas::sample_sidecars sifts them).
    pub fn random_track_ids(&self, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT id FROM tracks WHERE deleted = 0 ORDER BY RANDOM() LIMIT ?1")
        else {
            return Vec::new();
        };
        stmt.query_map(params![limit], |r| r.get::<_, i64>(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    pub fn track_count(&self) -> i64 {
        self.lock()
            .query_row("SELECT COUNT(*) FROM tracks WHERE deleted = 0", [], |r| {
                r.get(0)
            })
            .unwrap_or(0)
    }

    /// The glance an invite shows before anyone joins - counts, nothing named.
    pub fn artist_count(&self) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(DISTINCT artist) FROM tracks WHERE deleted = 0 AND artist <> ''",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    pub fn album_count(&self) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(DISTINCT album) FROM tracks WHERE deleted = 0 AND album <> ''",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    pub fn playlist_count(&self) -> i64 {
        self.lock()
            .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get(0))
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

    /// Moves hearts off tombstoned rows onto the live song they name.
    ///
    /// A like is stored as a track id, and a track id does not survive a file
    /// MOVING. `upsert_track` keys on rel_path, so a renamed or re-filed file
    /// lands as a new row with a new id while the old row is tombstoned - and
    /// `favorites` above joins on `t.deleted = 0`, so the heart silently stops
    /// being returned. Nothing was deleted (there is no DELETE on tracks
    /// anywhere, so the ON DELETE CASCADE never fires); the row is still
    /// sitting there pointing at a headstone.
    ///
    /// So: for every heart on a dead row, look for a LIVE row naming the same
    /// recording - the same folded artist and title key the importer and the
    /// mirror already use to decide two files are the same song - and move the
    /// heart there, keeping the date it was given.
    ///
    /// Run after a scan, because a scan is precisely when the live twin
    /// appears. Cheap when there is nothing to do: one indexed query that
    /// returns no rows, and it stops.
    pub fn rebind_orphaned_favorites(&self) -> usize {
        let conn = self.lock();
        // (user, dead track, artist, title, when it was hearted)
        let orphans: Vec<(i64, i64, String, String, i64)> = {
            let Ok(mut stmt) = conn.prepare(
                "SELECT f.user_id, f.track_id, t.artist, t.title, f.added_at
                   FROM favorites f JOIN tracks t ON t.id = f.track_id
                  WHERE t.deleted = 1",
            ) else {
                return 0;
            };
            stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
        };
        if orphans.is_empty() {
            return 0;
        }

        // The live library, by identity. Built once for the whole batch: a
        // per-heart lookup would be a table scan each, and this only runs when
        // there is something to repair.
        let live: std::collections::HashMap<(String, String), i64> = {
            let Ok(mut stmt) =
                conn.prepare("SELECT id, artist, title FROM tracks WHERE deleted = 0")
            else {
                return 0;
            };
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map(|rows| {
                rows.filter_map(Result::ok)
                    .map(|(id, artist, title)| {
                        (
                            (
                                crate::discovery::fold(&artist),
                                crate::discovery::title_key_public(&title),
                            ),
                            id,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
        };

        let mut moved = 0usize;
        for (user_id, dead_id, artist, title, added_at) in orphans {
            let key = (
                crate::discovery::fold(&artist),
                crate::discovery::title_key_public(&title),
            );
            let Some(&live_id) = live.get(&key) else {
                // No twin in the library: the song really is gone, and the
                // heart stays where it is. It costs nothing, it is invisible
                // either way, and it comes back the day the file does.
                continue;
            };
            if live_id == dead_id {
                continue;
            }
            // The date it was hearted travels with it - Liked is ordered by
            // that, and a repair must not shuffle the list to the top.
            if conn
                .execute(
                    "INSERT OR IGNORE INTO favorites (user_id, track_id, added_at)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![user_id, live_id, added_at],
                )
                .is_err()
            {
                continue;
            }
            let _ = conn.execute(
                "DELETE FROM favorites WHERE user_id = ?1 AND track_id = ?2",
                rusqlite::params![user_id, dead_id],
            );
            moved += 1;
        }
        moved
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

    // --- the hi-fi chain's presets ---------------------------------------

    /// Saved chains, newest-touched first - the order a picker wants.
    pub fn fx_presets(&self, user_id: i64) -> Vec<(i64, String, String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, name, chain, updated_at FROM fx_presets
              WHERE user_id = ?1 ORDER BY updated_at DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Save-or-replace by (user, name): re-saving "Warm Nights" updates it.
    pub fn fx_preset_save(&self, user_id: i64, name: &str, chain: &str) -> rusqlite::Result<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO fx_presets (user_id, name, chain, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id, name)
             DO UPDATE SET chain = excluded.chain, updated_at = excluded.updated_at",
            params![user_id, name, chain, now_ms()],
        )?;
        let id = conn.query_row(
            "SELECT id FROM fx_presets WHERE user_id = ?1 AND name = ?2",
            params![user_id, name],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    /// True when a row actually went - the handler turns false into 404.
    pub fn fx_preset_delete(&self, user_id: i64, id: i64) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "DELETE FROM fx_presets WHERE user_id = ?1 AND id = ?2",
            params![user_id, id],
        )?;
        Ok(n > 0)
    }

    pub fn create_playlist(&self, user_id: i64, name: &str) -> rusqlite::Result<i64> {
        let conn = self.lock();
        let now = now_ms();
        conn.execute(
            "INSERT INTO playlists (user_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![user_id, name, now],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Every playlist the user can see - their own, and the ones friends let
    /// them into - each with its track ids in order and the role they hold on
    /// it. One list, so a shared playlist sits among the user's own on every
    /// surface without any client having to ask twice.
    pub fn playlists(&self, user_id: i64) -> Vec<PlaylistRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT p.id, p.name, p.updated_at, p.description, p.folder, p.cover, p.auto_stem,
                    p.user_id, u.username, 'owner' AS role
               FROM playlists p JOIN users u ON u.id = p.user_id
              WHERE p.user_id = ?1
             UNION ALL
             SELECT p.id, p.name, p.updated_at, p.description, p.folder, p.cover, p.auto_stem,
                    p.user_id, u.username, m.role
               FROM playlist_members m
               JOIN playlists p ON p.id = m.playlist_id
               JOIN users u ON u.id = p.user_id
              WHERE m.user_id = ?1
              ORDER BY name",
        ) else {
            return Vec::new();
        };
        let heads: Vec<(i64, String, i64, String, String, String, i64, i64, String, String)> = stmt
            .query_map(params![user_id], |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
                    r.get(7)?, r.get(8)?, r.get(9)?,
                ))
            })
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
            .map(|(id, name, updated, description, folder, cover, auto_stem, owner_id, owner_name, role)| {
                let tracks: Vec<i64> = items
                    .query_map(params![id], |r| r.get(0))
                    .map(|r| r.filter_map(Result::ok).collect())
                    .unwrap_or_default();
                PlaylistRow {
                    id,
                    name,
                    updated_at: updated,
                    description,
                    folder,
                    cover,
                    auto_stem: auto_stem != 0,
                    tracks,
                    owner_id,
                    owner_name,
                    role,
                }
            })
            .collect()
    }

    /// What `user_id` may do with a playlist: Some("owner") for their own,
    /// the member row's role for one shared with them, None when it is not
    /// theirs to see at all. The one predicate every playlist route asks.
    pub fn playlist_role(&self, playlist_id: i64, user_id: i64) -> Option<String> {
        let conn = self.lock();
        let owner: Option<i64> = conn
            .query_row("SELECT user_id FROM playlists WHERE id = ?1", params![playlist_id], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        match owner {
            None => None,
            Some(o) if o == user_id => Some("owner".to_string()),
            Some(_) => conn
                .query_row(
                    "SELECT role FROM playlist_members WHERE playlist_id = ?1 AND user_id = ?2",
                    params![playlist_id, user_id],
                    |r| r.get(0),
                )
                .optional()
                .ok()
                .flatten(),
        }
    }

    /// Everyone let into a playlist: (user_id, username, role). The owner is
    /// not among them - callers already know the owner from the row.
    pub fn playlist_members(&self, playlist_id: i64) -> Vec<(i64, String, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT m.user_id, u.username, m.role FROM playlist_members m
               JOIN users u ON u.id = m.user_id
              WHERE m.playlist_id = ?1 ORDER BY u.username COLLATE NOCASE",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![playlist_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Let a user in, or change what they may do. Upsert on the pair, so
    /// promoting a viewer to editor is the same call as adding them. Returns
    /// true when the row is NEW - the share - and false for a role change on
    /// someone already in, so the caller can tell an invite from a promotion.
    pub fn playlist_member_put(&self, playlist_id: i64, user_id: i64, role: &str) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let present: bool = tx
            .query_row(
                "SELECT 1 FROM playlist_members WHERE playlist_id = ?1 AND user_id = ?2",
                params![playlist_id, user_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        tx.execute(
            "INSERT INTO playlist_members (playlist_id, user_id, role, added_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(playlist_id, user_id) DO UPDATE SET role = excluded.role",
            params![playlist_id, user_id, role, now_ms()],
        )?;
        tx.commit()?;
        Ok(!present)
    }

    /// Returns true when a member row actually went.
    pub fn playlist_member_remove(&self, playlist_id: i64, user_id: i64) -> rusqlite::Result<bool> {
        let gone = self.lock().execute(
            "DELETE FROM playlist_members WHERE playlist_id = ?1 AND user_id = ?2",
            params![playlist_id, user_id],
        )?;
        Ok(gone > 0)
    }

    /// Write down one thing that happened on a list - see the table comment
    /// for the kinds. The track edits (`added`, `removed`) are recorded ONLY
    /// when the list has somebody let in: a private list's own edits are
    /// nobody's news, and writing them would fill the table for nothing. The
    /// membership kinds always land - `shared` is what creates the first
    /// member, and `left`/`unshared` are called after the row is gone, so a
    /// last member leaving would otherwise vanish without the owner hearing.
    /// Returns whether a row was written. Rows past sixty days go with it.
    pub fn playlist_activity_record(
        &self,
        playlist_id: i64,
        actor_id: i64,
        kind: &str,
        target_id: Option<i64>,
        track_id: Option<i64>,
    ) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        if matches!(kind, "added" | "removed") {
            let shared: bool = tx
                .query_row(
                    "SELECT 1 FROM playlist_members WHERE playlist_id = ?1 LIMIT 1",
                    params![playlist_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !shared {
                tx.commit()?;
                return Ok(false);
            }
        }
        let now = now_ms();
        tx.execute(
            "INSERT INTO playlist_activity (playlist_id, actor_id, target_id, kind, track_id, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![playlist_id, actor_id, target_id, kind, track_id, now],
        )?;
        tx.execute(
            "DELETE FROM playlist_activity WHERE at < ?1",
            params![now - 60 * 86_400_000],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// What is news to `user_id` about the lists they share, newest first:
    /// at most `limit` rows at or after `since`. The rules, because they ARE
    /// the feature:
    ///  - nobody is told about their own actions;
    ///  - the OWNER hears everything on their list - every add and remove,
    ///    every share they made (they made it, so it is filtered as their
    ///    own), every leave;
    ///  - a MEMBER hears the adds and removes from their own `added_at` on -
    ///    a newcomer is not handed the history from before they joined - and
    ///    the share that let them in; other people's shares and leaves are
    ///    not theirs to hear;
    ///  - someone shown OUT hears that, and only that, though they are no
    ///    longer on the list - "you were removed" is news precisely because
    ///    the list has just stopped being theirs to see;
    ///  - a stranger hears nothing at all, rows or no rows.
    pub fn playlist_activity_for(&self, user_id: i64, since: i64, limit: usize) -> Vec<PlaylistActivityRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT a.id, a.playlist_id, p.name, p.user_id, o.username,
                    a.actor_id, COALESCE(u.username, ''), a.kind, a.track_id, a.at
               FROM playlist_activity a
               JOIN playlists p ON p.id = a.playlist_id
               JOIN users o ON o.id = p.user_id
               LEFT JOIN users u ON u.id = a.actor_id
               LEFT JOIN playlist_members m ON m.playlist_id = a.playlist_id AND m.user_id = ?1
              WHERE a.at >= ?2
                AND a.actor_id != ?1
                AND (
                      p.user_id = ?1
                   OR (m.user_id IS NOT NULL AND a.kind IN ('added', 'removed') AND a.at >= m.added_at)
                   OR (m.user_id IS NOT NULL AND a.kind = 'shared' AND a.target_id = ?1)
                   OR (a.kind = 'unshared' AND a.target_id = ?1)
                )
              ORDER BY a.at DESC, a.id DESC
              LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since, limit as i64], |r| {
            Ok(PlaylistActivityRow {
                id: r.get(0)?,
                playlist_id: r.get(1)?,
                playlist_name: r.get(2)?,
                owner_id: r.get(3)?,
                owner_name: r.get(4)?,
                actor_id: r.get(5)?,
                actor_name: r.get(6)?,
                kind: r.get(7)?,
                track_id: r.get(8)?,
                at: r.get(9)?,
            })
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// The little a feed line needs to name a song: (title, artist, art id).
    /// Deliberately NOT `track()`, which hides soft-deleted rows: a song that
    /// was added and has since gone from disk should still be named in the
    /// line that says it was added. None only when the row itself is gone.
    pub fn track_caption(&self, id: i64) -> Option<(String, String, Option<String>)> {
        self.lock()
            .query_row(
                "SELECT title, artist, art_id FROM tracks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Take ONE track out of a playlist, atomically, and close the gap in the
    /// positions - the counterpart of playlist_append_track, and for the same
    /// reason: a collaborator's remove must not be a read-modify-write of the
    /// whole list that can swallow somebody else's add landing beside it. All
    /// under one held lock. Returns true when a row actually went.
    pub fn playlist_remove_track(&self, playlist_id: i64, track_id: i64) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let gone = tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
        )?;
        if gone == 0 {
            tx.commit()?;
            return Ok(false);
        }
        // Renumber densely so a later append (MAX(position)+1) and the client's
        // ordered read both keep agreeing about where the tail is.
        let ids: Vec<i64> = {
            let mut st = tx.prepare(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position",
            )?;
            let rows = st.query_map(params![playlist_id], |r| r.get(0))?;
            rows.filter_map(Result::ok).collect()
        };
        for (position, tid) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE playlist_tracks SET position = ?3 WHERE playlist_id = ?1 AND track_id = ?2",
                params![playlist_id, tid, position as i64],
            )?;
        }
        tx.execute(
            "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
            params![playlist_id, now_ms()],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// One playlist's decoration, changed a field at a time.
    ///
    /// Each is Option so a caller can send only what it means to change - a
    /// description edit must not blank the folder, and a PUT that carried every
    /// field would make two devices editing different things overwrite each
    /// other with whatever they last read.
    pub fn set_playlist_meta(
        &self,
        playlist_id: i64,
        description: Option<&str>,
        folder: Option<&str>,
        cover: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.lock();
        let now = now_ms();
        if let Some(v) = description {
            conn.execute(
                "UPDATE playlists SET description = ?2, updated_at = ?3 WHERE id = ?1",
                params![playlist_id, v, now],
            )?;
        }
        if let Some(v) = folder {
            conn.execute(
                "UPDATE playlists SET folder = ?2, updated_at = ?3 WHERE id = ?1",
                params![playlist_id, v, now],
            )?;
        }
        if let Some(v) = cover {
            conn.execute(
                "UPDATE playlists SET cover = ?2, updated_at = ?3 WHERE id = ?1",
                params![playlist_id, v, now],
            )?;
        }
        Ok(())
    }

    /// The file a playlist's cover points at, for serving and for cleanup.
    pub fn playlist_cover(&self, playlist_id: i64) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT cover FROM playlists WHERE id = ?1",
                params![playlist_id],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .filter(|c| !c.is_empty())
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

    /// Append ONE track to a playlist's tail, atomically, without disturbing
    /// any other row. Returns true when it was newly added, false when the
    /// track was already there.
    ///
    /// This exists instead of "read the ids, push one, set the whole list"
    /// because that read-modify-write is two separate lock acquisitions with
    /// nothing serialising them - a concurrent edit landing in between is lost
    /// when the wholesale rewrite reinserts the stale snapshot. It is also why
    /// the settle path uses THIS and not set_playlist_tracks: a wholesale
    /// rewrite is built from the deleted=0 view, so a track that is momentarily
    /// soft-deleted (a file mid-rename during a scan) would be pruned from the
    /// list for good. Appending one row touches nothing else, so neither hazard
    /// applies. The whole read-check-insert runs under one held lock.
    pub fn playlist_append_track(
        &self,
        playlist_id: i64,
        track_id: i64,
    ) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let present: bool = tx
            .query_row(
                "SELECT 1 FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2 LIMIT 1",
                params![playlist_id, track_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if present {
            tx.commit()?;
            return Ok(false);
        }
        let next: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
            params![playlist_id, track_id, next],
        )?;
        tx.execute(
            "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
            params![playlist_id, now_ms()],
        )?;
        tx.commit()?;
        Ok(true)
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
    // --- the Subsonic door (subsonic.rs) ---------------------------------------

    pub fn subsonic_secret(&self, user_id: i64) -> Option<String> {
        self.lock()
            .query_row("SELECT secret FROM subsonic_secrets WHERE user_id = ?1", params![user_id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_subsonic_secret(&self, user_id: i64, secret: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO subsonic_secrets (user_id, secret, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at",
            params![user_id, secret, now_ms()],
        )?;
        Ok(())
    }

    pub fn clear_subsonic_secret(&self, user_id: i64) -> rusqlite::Result<()> {
        self.lock().execute("DELETE FROM subsonic_secrets WHERE user_id = ?1", params![user_id])?;
        Ok(())
    }

    /// (url, username, password, server_type)
    pub fn subsonic_account(&self, user_id: i64) -> Option<(String, String, String, String)> {
        self.lock()
            .query_row(
                "SELECT url, username, password, server_type FROM subsonic_accounts WHERE user_id = ?1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_subsonic_account(&self, user_id: i64, url: &str, username: &str, password: &str, server_type: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO subsonic_accounts (user_id, url, username, password, server_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id) DO UPDATE SET url = excluded.url, username = excluded.username,
               password = excluded.password, server_type = excluded.server_type, created_at = excluded.created_at",
            params![user_id, url, username, password, server_type, now_ms()],
        )?;
        Ok(())
    }

    pub fn clear_subsonic_account(&self, user_id: i64) -> rusqlite::Result<()> {
        self.lock().execute("DELETE FROM subsonic_accounts WHERE user_id = ?1", params![user_id])?;
        Ok(())
    }

    /// (ids json, current, position, changed, changed_by)
    pub fn subsonic_queue(&self, user_id: i64) -> Option<(String, Option<i64>, i64, i64, String)> {
        self.lock()
            .query_row(
                "SELECT ids, current, position, changed, changed_by FROM subsonic_queue WHERE user_id = ?1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_subsonic_queue(
        &self,
        user_id: i64,
        ids_json: &str,
        current: Option<i64>,
        position: i64,
        changed_by: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO subsonic_queue (user_id, ids, current, position, changed, changed_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id) DO UPDATE SET ids = excluded.ids, current = excluded.current,
               position = excluded.position, changed = excluded.changed, changed_by = excluded.changed_by",
            params![user_id, ids_json, current, position, now_ms(), changed_by],
        )?;
        Ok(())
    }

    /// Favourites with when they were starred: (track_id, added_at ms).
    pub fn favorites_with_time(&self, user_id: i64) -> Vec<(i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT f.track_id, f.added_at FROM favorites f
               JOIN tracks t ON t.id = f.track_id AND t.deleted = 0
              WHERE f.user_id = ?1 ORDER BY f.added_at DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// Play counts per track for one listener, off the cheap `plays` log.
    pub fn play_counts(&self, user_id: i64) -> std::collections::HashMap<i64, i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT track_id, COUNT(*) FROM plays WHERE user_id = ?1 GROUP BY track_id") else {
            return Default::default();
        };
        stmt.query_map(params![user_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// Live, adopted tracks matching `where_sql` (a fragment over the tracks
    /// table's columns), with their paths - the Subsonic door's one query
    /// shape. Auditions another member has not adopted are never listed:
    /// they are that member's, not the library's.
    pub fn subsonic_tracks(
        &self,
        where_sql: &str,
        args: &[&dyn rusqlite::ToSql],
        order_sql: &str,
        limit: i64,
        offset: i64,
    ) -> Vec<(Track, String)> {
        let conn = self.lock();
        let sql = format!(
            "SELECT {}, rel_path FROM tracks
              WHERE deleted = 0 AND (curator_user_id IS NULL OR curator_promoted = 1) AND ({where_sql})
              ORDER BY {order_sql} LIMIT {} OFFSET {}",
            Self::TRACK_COLS,
            limit.max(0),
            offset.max(0)
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        stmt.query_map(args, |r| Ok((Self::read_track(r)?, r.get::<_, String>(26)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// Every album, grouped the way the library groups them - by album artist
    /// (the track artist where none is tagged) and album, case-blind - with
    /// the numbers a Subsonic album row carries.
    /// (album_artist, album, year, songs, duration_ms, added_at, art_id, genre)
    pub fn subsonic_albums(&self) -> Vec<(String, String, Option<i64>, i64, i64, i64, String, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT MAX(COALESCE(NULLIF(album_artist, ''), artist)) AS aa, MAX(album), MIN(year), COUNT(*),
                    COALESCE(SUM(duration_ms), 0), MIN(added_at), COALESCE(MAX(art_id), ''), COALESCE(MAX(NULLIF(genre, '')), '')
               FROM tracks
              WHERE deleted = 0 AND (curator_user_id IS NULL OR curator_promoted = 1) AND kind IS NOT 'book'
              GROUP BY lower(COALESCE(NULLIF(album_artist, ''), artist)), lower(album)
              ORDER BY aa COLLATE NOCASE, MAX(album) COLLATE NOCASE",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Raw genre tags with song and album counts; tags may be comma-joined
    /// as they came off the files, which the caller splits.
    pub fn subsonic_genres(&self) -> Vec<(String, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT genre, COUNT(*), COUNT(DISTINCT lower(COALESCE(NULLIF(album_artist, ''), artist)) || '|' || lower(album))
               FROM tracks WHERE deleted = 0 AND genre != '' AND (curator_user_id IS NULL OR curator_promoted = 1)
              GROUP BY genre",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    pub fn record_play(&self, user_id: i64, track_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO plays (user_id, track_id, played_at) VALUES (?1, ?2, ?3)",
            params![user_id, track_id, now_ms()],
        )?;
        Ok(())
    }

    /// Distinct recently played live tracks, newest first.
    pub fn mb_artist_cached(&self, name_key: &str) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT mbid FROM mb_artists WHERE name_key = ?1",
                params![name_key],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn mb_artist_store(&self, name_key: &str, mbid: &str) {
        let _ = self.lock().execute(
            "INSERT INTO mb_artists (name_key, mbid, checked_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name_key) DO UPDATE SET mbid = excluded.mbid, checked_at = excluded.checked_at",
            params![name_key, mbid, now_ms()],
        );
    }

    pub fn scene_walk_due(&self, user_id: i64, artist_key: &str, every_ms: i64) -> bool {
        let last: Option<i64> = self
            .lock()
            .query_row(
                "SELECT walked_at FROM scene_walks WHERE user_id = ?1 AND artist_key = ?2",
                params![user_id, artist_key],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        last.map(|t| now_ms() - t >= every_ms).unwrap_or(true)
    }

    pub fn scene_walk_record(&self, user_id: i64, artist_key: &str) {
        let _ = self.lock().execute(
            "INSERT INTO scene_walks (user_id, artist_key, walked_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, artist_key) DO UPDATE SET walked_at = excluded.walked_at",
            params![user_id, artist_key, now_ms()],
        );
    }

    /// Every artist name in the live library - the "do we already own them"
    /// side of the small-artist gates.
    pub fn owned_artist_names(&self) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT DISTINCT artist FROM tracks WHERE deleted = 0 AND artist != ''")
        else {
            return Vec::new();
        };
        stmt.query_map([], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Hearted artists whose most-listened track sits under the worldwide
    /// listener ceiling - the obscure favourites the scene walk digs around.
    /// Freshest hearts first, so a new obsession gets walked before an old one
    /// gets re-walked.
    pub fn hearted_obscure_artists(&self, user_id: i64, max_listeners: i64) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.artist
             FROM favorites f
             JOIN tracks t ON t.id = f.track_id AND t.deleted = 0 AND t.artist != ''
             LEFT JOIN track_features tf ON tf.track_id = t.id
             WHERE f.user_id = ?1
             GROUP BY LOWER(t.artist)
             HAVING MAX(COALESCE(tf.listenbrainz_listeners, 0)) <= ?2
             ORDER BY MAX(f.added_at) DESC
             LIMIT 12",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, max_listeners], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Artists this listener has hearted at least one song by.
    pub fn hearted_artist_keys(&self, user_id: i64) -> std::collections::HashSet<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT DISTINCT LOWER(t.artist) FROM favorites f
             JOIN tracks t ON t.id = f.track_id WHERE f.user_id = ?1",
        ) else {
            return Default::default();
        };
        stmt.query_map(params![user_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Artists this listener has actually MET. The complement is the
    /// exploration pool.
    ///
    /// A meeting is a sitting of ten seconds or a completion - the listener's
    /// own line (taste.rs MISTAP_MS). It used to be any listen event at all,
    /// which meant a thumb slipping onto a song for six seconds retired that
    /// artist from exploration forever: the sampler never got to offer them
    /// again, so it never learned anything about them. `plays` needs no gate
    /// of its own - the client writes one only after thirty seconds, or half
    /// of a very short track.
    pub fn played_artist_keys(&self, user_id: i64) -> std::collections::HashSet<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT DISTINCT LOWER(artist) FROM listen_events
             WHERE user_id = ?1 AND (ms_listened >= 10000 OR completed = 1)
             UNION SELECT DISTINCT LOWER(t.artist) FROM plays p JOIN tracks t ON t.id = p.track_id
             WHERE p.user_id = ?1",
        ) else {
            return Default::default();
        };
        stmt.query_map(params![user_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// One row per DJ set: what was offered, in what slot, at what position.
    pub fn record_dj_impressions(&self, user_id: i64, items: &[(i64, &str, i64)]) {
        let conn = self.lock();
        let now = now_ms();
        for (track_id, slot, position) in items {
            let _ = conn.execute(
                "INSERT INTO dj_impressions (user_id, track_id, slot, position, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![user_id, track_id, slot, position, now],
            );
        }
    }

    /// Drop impressions older than `before`. The ledger only ever needs the
    /// dealt window and the adoption look-back, and it grew a row per seat per
    /// press forever - with the chart and new-music doors now dealing too.
    pub fn prune_dj_impressions(&self, before: i64) {
        let _ = self.lock().execute(
            "DELETE FROM dj_impressions WHERE created_at < ?1",
            params![before],
        );
    }

    /// A fresher preview URL for a pooled candidate - Deezer's carry expiring
    /// signatures, so the stored one goes stale within days.
    pub fn update_discovery_preview(&self, user_id: i64, ext_id: &str, preview: &str) {
        let _ = self.lock().execute(
            "UPDATE discoveries SET preview = ?3 WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id, preview],
        );
    }

    /// What the DJ has dealt this listener since `since`, newest deal first:
    /// (track_id, when it was last dealt). The variety ledger - a set that can
    /// re-deal yesterday's set is a playlist wearing a DJ's name. Ordered so a
    /// caller can hold the most recent deals unconditionally and graduate the
    /// older ones (see dj::dealt_hold).
    pub fn dj_dealt_since(&self, user_id: i64, since: i64) -> Vec<(i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT track_id, MAX(created_at) AS at FROM dj_impressions
             WHERE user_id = ?1 AND created_at > ?2
             GROUP BY track_id ORDER BY at DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Per-artist exploration ledger: how often the DJ has offered this
    /// artist, and how often an offer was adopted. The Thompson sampler's two
    /// counters.
    ///
    /// What the ledger reads as a verdict, per impression:
    ///
    ///   adopted   a listen AFTER the offer that finished, or reached six
    ///             tenths of the track's real length - a listener who stayed
    ///             for most of a song said yes even if the last chorus lost
    ///             them - or a heart after the offer, or a THUMB UP after
    ///             the offer (reactions.rs): the listener's word, in the
    ///             moment, that the machine was right.
    ///   refused   a THUMB DOWN after the offer, with no thumb up beside it.
    ///             Louder than a skip: a skip is a hand that left, a thumb
    ///             down is a sentence. It counts as three failures - one for
    ///             the offer itself and two on top - so the Beta's `b` moves
    ///             by more than a plain skip would move it, and the artist
    ///             fades from the seats faster without ever being banned.
    ///   dropped   the only listens after the offer were under ten seconds
    ///             and unfinished. A mis-tap is not a no; it is not counted
    ///             as an offer at all, so it can neither fail the artist nor
    ///             adopt them. The listener's own rule (taste.rs MISTAP_MS).
    ///   failed    everything else: never played, or played and left.
    ///
    /// The slot vocabulary is exactly the two DJ-set seats. Radio writes its
    /// own slot and is deliberately NOT read here - see radio.rs.
    pub fn explore_artist_stats(&self, user_id: i64) -> Vec<(String, i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT artist,
                    SUM(CASE WHEN refused = 1 THEN 3
                             WHEN adopted = 1 THEN 1
                             WHEN touched = 1 AND heard = 0 THEN 0
                             ELSE 1 END),
                    SUM(CASE WHEN refused = 1 THEN 0 ELSE adopted END)
             FROM (
               SELECT artist, adopted, touched, heard,
                      (thumbed_down = 1 AND thumbed_up = 0) AS refused
               FROM (
                 SELECT LOWER(t.artist) AS artist,
                        (EXISTS(
                            SELECT 1 FROM listen_events le
                            WHERE le.user_id = i.user_id AND le.track_id = i.track_id
                              AND le.started_at >= i.created_at
                              AND (le.completed = 1
                                   OR le.ms_listened >= 0.6 * le.duration_ms))
                         OR EXISTS(
                            SELECT 1 FROM favorites f
                            WHERE f.user_id = i.user_id AND f.track_id = i.track_id
                              AND f.added_at >= i.created_at)
                         OR EXISTS(
                            SELECT 1 FROM dj_reactions r
                            WHERE r.user_id = i.user_id AND r.track_id = i.track_id
                              AND r.created_at >= i.created_at AND r.reaction = 'up')) AS adopted,
                        EXISTS(
                            SELECT 1 FROM dj_reactions r
                            WHERE r.user_id = i.user_id AND r.track_id = i.track_id
                              AND r.created_at >= i.created_at AND r.reaction = 'up') AS thumbed_up,
                        EXISTS(
                            SELECT 1 FROM dj_reactions r
                            WHERE r.user_id = i.user_id AND r.track_id = i.track_id
                              AND r.created_at >= i.created_at AND r.reaction = 'down') AS thumbed_down,
                        EXISTS(
                            SELECT 1 FROM listen_events le
                            WHERE le.user_id = i.user_id AND le.track_id = i.track_id
                              AND le.started_at >= i.created_at) AS touched,
                        EXISTS(
                            SELECT 1 FROM listen_events le
                            WHERE le.user_id = i.user_id AND le.track_id = i.track_id
                              AND le.started_at >= i.created_at
                              AND (le.ms_listened >= 10000 OR le.completed = 1)) AS heard
                 FROM dj_impressions i JOIN tracks t ON t.id = i.track_id
                 WHERE i.user_id = ?1 AND i.slot IN ('rank', 'explore')
               )
             )
             GROUP BY artist",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every verdict one listener has passed in the window, richest form.
    ///
    /// This is the query the curation half should always have been running.
    /// The query it replaced (`weighted_recent_listens`, gone with its last
    /// caller when the DJ and radio moved onto `taste::UserTaste`) collapsed a
    /// listener's history into one number per track with a fixed rubric baked
    /// into SQL - completed 1.0, skipped 0.15, capped at 3 - which could not
    /// express WHEN it happened, HOW MUCH was heard against the track's real
    /// length, or WHICH SURFACE offered it. All three columns were already
    /// being written; none of them could get out through that function.
    ///
    /// So this one hands back the rows and lets `taste.rs` decide what they
    /// mean. Books are excluded: an audiobook's completion curve has nothing
    /// to say about which song to play next.
    /// `since` is epoch MILLISECONDS - started_at's own unit. The returned
    /// `Verdict.at` is unix SECONDS, which is what the taste math runs on.
    ///
    /// The conversion happens HERE, at the boundary, because it went missing
    /// entirely once: started_at (ms) was poured straight into `at` (documented
    /// as seconds), so `now_secs - at` was hugely negative, `.max(0)` clamped
    /// it to zero days, and every verdict scored recency 1.0. The 21-day
    /// half-life - the thing that makes taste follow what a listener has been
    /// playing LATELY rather than everything they ever played - had silently
    /// never applied. The window filter was the same bug in the other
    /// direction: a seconds cutoff against a milliseconds column matches every
    /// row ever written.
    pub fn taste_verdicts(&self, user_id: i64, since_ms: i64, limit: i64) -> Vec<crate::taste::Verdict> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT le.track_id, le.started_at, le.ms_listened, le.duration_ms,
                    le.completed, le.skipped, le.context,
                    EXISTS(SELECT 1 FROM favorites f
                           WHERE f.user_id = le.user_id AND f.track_id = le.track_id),
                    le.ended_at_ms, le.volume_ups, le.seek_backs, le.device,
                    EXISTS(SELECT 1 FROM playlist_tracks pt
                           JOIN playlists p ON p.id = pt.playlist_id
                           WHERE p.user_id = le.user_id AND pt.track_id = le.track_id)
             FROM listen_events le
             JOIN tracks t ON t.id = le.track_id AND t.deleted = 0
                          AND COALESCE(t.kind, 'music') <> 'book'
             WHERE le.user_id = ?1 AND le.started_at >= ?2
             ORDER BY le.started_at DESC
             LIMIT ?3",
        ) else {
            return Vec::new();
        };
        let mut rows: Vec<crate::taste::Verdict> = stmt
            .query_map(params![user_id, since_ms, limit], |r| {
                Ok(crate::taste::Verdict {
                    track_id: r.get(0)?,
                    at: r.get::<_, i64>(1)? / 1000,
                    ms_listened: r.get(2)?,
                    duration_ms: r.get(3).ok(),
                    completed: r.get::<_, i64>(4)? != 0,
                    skipped: r.get::<_, i64>(5)? != 0,
                    context: r.get::<_, String>(6).unwrap_or_default(),
                    hearted: r.get::<_, i64>(7)? != 0,
                    ended_at_ms: r.get(8).ok(),
                    volume_ups: r.get(9).unwrap_or(0),
                    seek_backs: r.get(10).unwrap_or(0),
                    device: r.get::<_, String>(11).unwrap_or_default(),
                    playlisted: r.get::<_, i64>(12).unwrap_or(0) != 0,
                    returns: 0,
                })
            })
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default();

        /*
         * Returns: how many times they had already come back to this track in
         * the week before each sitting. Counted here, over the rows already in
         * hand, rather than as a correlated subquery per row - the rows arrive
         * newest first, so a per-track list of times answers it in one pass.
         * Bails do not count as coming back.
         */
        let mut times: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
        for v in &rows {
            if !v.skipped {
                times.entry(v.track_id).or_default().push(v.at);
            }
        }
        const WEEK: i64 = 7 * 24 * 60 * 60;
        for v in rows.iter_mut() {
            if let Some(ts) = times.get(&v.track_id) {
                v.returns = ts.iter().filter(|t| **t < v.at && v.at - **t <= WEEK).count() as i64;
            }
        }
        rows
    }

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
    /// Whether an account exists on this hub at all - the whole test for
    /// whether a playlist can be shared with it (see `playlist_member_add`).
    pub fn user_exists(&self, user_id: i64) -> bool {
        self.lock()
            .query_row("SELECT 1 FROM users WHERE id = ?1", params![user_id], |_| Ok(()))
            .is_ok()
    }

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

    /*
     * THE HOME SHELVES' MATERIAL, SCOPED TO THE LISTENER THEY ARE FOR.
     *
     * The `_for` readers below - genre blend, jump-back-in, the fresh row,
     * artist spotlight - are what Home and its mixes are built from. Each used
     * to ask the tracks table with no idea whose shelf it was filling, so
     * another member's unadopted collector audition was fair material for
     * YOUR mix, and so was every chapter of every audiobook. Eleven people
     * share this hub; what the collector bought on somebody else's taste must
     * never turn up as a suggestion on yours.
     *
     * The rule is the one `tracks_since` states and `unplayed` already
     * follows: a collector pull belongs to the listener who pulled it until a
     * listen or a heart of THEIRS adopts it, and a book is not a song. The
     * predicate is lifted from `unplayed` word for word rather than reworded,
     * so every door Home reads through agrees about what "yours to be shown"
     * means.
     */

    /// Live tracks in a genre, newest first - genre-mix material, as
    /// `user_id` is entitled to see it.
    pub fn tracks_by_genre_for(&self, user_id: i64, genre: &str, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t WHERE t.deleted = 0 AND t.genre = ?2 COLLATE NOCASE
               AND COALESCE(t.kind, 'music') <> 'book'
               AND (t.curator_user_id IS NULL
                    OR COALESCE(t.curator_promoted, 0) = 1
                    OR t.curator_user_id = ?1)
             ORDER BY t.added_at DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, genre, limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The albums behind the user's recent plays, newest touch first - each as
    /// its FULL ordered track-id list (disc then track). The server owns album
    /// identity and order here so the client never has to: it plays the list
    /// as given, which is what keeps two same-named albums by different artists
    /// from ever merging, and multi-disc albums in disc order.
    ///
    /// Both halves carry the owner predicate. The album list is where the leak
    /// was: the collector lands one song from an album you already own, and
    /// until you adopt it a housemate's jump-back-in of that album played your
    /// audition as track seven.
    pub fn recent_album_track_lists_for(&self, user_id: i64, album_limit: i64) -> Vec<Vec<i64>> {
        let conn = self.lock();
        // The recent (album_artist, album) pairs, newest touch first. Collected
        // into owned strings so the statement is done before the per-album
        // queries below reuse the connection.
        let pairs: Vec<(String, String)> = {
            let Ok(mut stmt) = conn.prepare(
                "SELECT t.album_artist, t.album, MAX(p.played_at) AS last
                 FROM plays p JOIN tracks t ON t.id = p.track_id
                 WHERE p.user_id = ?1 AND t.deleted = 0 AND TRIM(t.album) <> ''
                   AND COALESCE(t.kind, 'music') <> 'book'
                   AND (t.curator_user_id IS NULL
                        OR COALESCE(t.curator_promoted, 0) = 1
                        OR t.curator_user_id = ?1)
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
                "SELECT t.id FROM tracks t WHERE t.deleted = 0 AND t.album_artist = ?1 AND t.album = ?2
                   AND COALESCE(t.kind, 'music') <> 'book'
                   AND (t.curator_user_id IS NULL
                        OR COALESCE(t.curator_promoted, 0) = 1
                        OR t.curator_user_id = ?3)
                 ORDER BY t.disc_no, t.track_no",
            ) else {
                continue;
            };
            let ids: Vec<i64> = stmt
                .query_map(params![album_artist, album, user_id], |r| r.get(0))
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
    /*
     * Songs this listener has never played - and only songs, and only ones
     * that are theirs to be shown.
     *
     * Both callers are Home shelves: the "fresh finds" row, and the candidate
     * list handed to the AI that writes the mixes. Neither wants an audiobook
     * chapter, and neither should see somebody else's unadopted audition - a
     * collector pull belongs to the listener who pulled it until a listen or a
     * heart adopts it, which is exactly the rule `tracks_since` already states
     * and enforces a few hundred lines up. This was the one door that did not
     * ask, so another member's audition and every chapter of every book were
     * eligible material for your Home mix.
     *
     * Found by the audit in PR #3, which was right about it; the predicate is
     * main's own, lifted from `tracks_since` rather than reinvented.
     */
    pub fn unplayed(&self, user_id: i64, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t WHERE t.deleted = 0
               AND COALESCE(t.kind, 'music') <> 'book'
               AND (t.curator_user_id IS NULL
                    OR COALESCE(t.curator_promoted, 0) = 1
                    OR t.curator_user_id = ?1)
               AND NOT EXISTS (SELECT 1 FROM plays p WHERE p.user_id = ?1 AND p.track_id = t.id)
             ORDER BY t.added_at DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Newest live tracks by added_at, for the "recently added" shelf - as
    /// `user_id` is entitled to see them. Their own pending auditions count:
    /// the collector fetched those FOR them, and "what arrived lately" that
    /// hides them is not what it says it is (`recent_track_ids` argues the
    /// same). Somebody else's do not.
    pub fn recently_added_for(&self, user_id: i64, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t WHERE t.deleted = 0
               AND COALESCE(t.kind, 'music') <> 'book'
               AND (t.curator_user_id IS NULL
                    OR COALESCE(t.curator_promoted, 0) = 1
                    OR t.curator_user_id = ?1)
             ORDER BY t.added_at DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, limit], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every live track by an artist, album order - mix material, as
    /// `user_id` is entitled to see it.
    pub fn tracks_by_artist_for(&self, user_id: i64, artist: &str, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tracks t WHERE t.deleted = 0 AND t.artist = ?2 COLLATE NOCASE
               AND COALESCE(t.kind, 'music') <> 'book'
               AND (t.curator_user_id IS NULL
                    OR COALESCE(t.curator_promoted, 0) = 1
                    OR t.curator_user_id = ?1)
             ORDER BY t.album, t.disc_no, t.track_no LIMIT ?3",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, artist, limit], |r| r.get(0))
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
    /// Resume positions for one account, newest first.
    ///
    /// `kind` narrows to one sort of track, and for books that is not a
    /// convenience - it is the difference between a bookmark surviving and not.
    /// The list is capped and ordered by recency, so with several books on the
    /// go the oldest one's mark is the first thing pushed off the end: a reader
    /// three books deep would find the one they had not touched this week had
    /// simply forgotten where it was. Asking for books alone means a book only
    /// ever competes with other books.
    pub fn play_states(&self, user_id: i64, limit: i64, kind: Option<&str>) -> Vec<(i64, i64, i64)> {
        let conn = self.lock();
        let sql = match kind {
            Some(_) => {
                "SELECT p.track_id, p.position_ms, p.updated_at
                   FROM play_state p JOIN tracks t ON t.id = p.track_id
                  WHERE p.user_id = ?1 AND t.deleted = 0 AND t.kind = ?3
                  ORDER BY p.updated_at DESC LIMIT ?2"
            }
            None => {
                "SELECT p.track_id, p.position_ms, p.updated_at
                   FROM play_state p JOIN tracks t ON t.id = p.track_id
                  WHERE p.user_id = ?1 AND t.deleted = 0
                  ORDER BY p.updated_at DESC LIMIT ?2"
            }
        };
        let Ok(mut stmt) = conn.prepare(sql) else {
            return Vec::new();
        };
        let row = |r: &rusqlite::Row<'_>| Ok((r.get(0)?, r.get(1)?, r.get(2)?));
        match kind {
            Some(k) => stmt
                .query_map(params![user_id, limit, k], row)
                .map(|r| r.filter_map(Result::ok).collect())
                .unwrap_or_default(),
            None => stmt
                .query_map(params![user_id, limit], row)
                .map(|r| r.filter_map(Result::ok).collect())
                .unwrap_or_default(),
        }
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

    // --- the peer-sync outbox -------------------------------------------------
    //
    // A peer downloads, the hub keeps the library. Everything below is the
    // durable half of that: rows survive a restart, so a box that went down
    // mid-transfer still owes the hub the same files when it comes back.

    /// Put a landed file in the outbox. `false` when it was already there.
    ///
    /// INSERT OR IGNORE rather than a replace: re-importing the same link -
    /// which happens every time a playlist is re-synced - must not queue the
    /// file a second time, and must not blank the upload id of a push already
    /// halfway to the hub.
    pub fn peer_sync_enqueue(
        &self,
        rel_path: &str,
        track_id: i64,
        job_id: &str,
        size_bytes: i64,
    ) -> bool {
        let now = now_ms();
        self.lock()
            .execute(
                /*
                 * ON CONFLICT rather than OR IGNORE, and the guard matters.
                 *
                 * The table is keyed by rel_path and never pruned, so a row
                 * that has already been sent stays forever - and OR IGNORE
                 * meant the SECOND time a file was owed to the hub (a delegated
                 * pull that resolved to something this box already held, or a
                 * row left 'failed' by a transfer that died) nothing was
                 * queued at all. Silence, and a hub that waits for a file
                 * nobody is going to send.
                 *
                 * The WHERE keeps that from touching a transfer in flight:
                 * only a settled row is re-armed, so an 'uploading' row keeps
                 * its upload_id and its resume point.
                 */
                "INSERT INTO peer_sync_queue
                   (rel_path, track_id, job_id, state, size_bytes, queued_at, updated_at)
                 VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?5)
                 ON CONFLICT(rel_path) DO UPDATE SET
                   state = 'pending', job_id = excluded.job_id, track_id = excluded.track_id,
                   size_bytes = excluded.size_bytes, attempts = 0, next_try_at = 0,
                   error = '', upload_id = '', sent_bytes = 0, updated_at = excluded.updated_at
                 WHERE peer_sync_queue.state IN ('done', 'failed', 'skipped')",
                params![rel_path, track_id, job_id, size_bytes, now],
            )
            .unwrap_or(0)
            > 0
    }

    /// The next files owed to the hub - oldest first, so a backlog drains in
    /// the order it was downloaded.
    pub fn peer_sync_due(&self, now_ms_val: i64, limit: usize) -> Vec<PeerSyncRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(&format!(
            "SELECT {PEER_SYNC_COLS} FROM peer_sync_queue
              WHERE state = 'pending' AND next_try_at <= ?1
              ORDER BY queued_at LIMIT ?2"
        )) else {
            return Vec::new();
        };
        stmt.query_map(params![now_ms_val, limit as i64], peer_sync_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Take a row for this worker. The `state = 'pending'` guard is what makes
    /// it a claim rather than a wish: the retry route can poke the queue in the
    /// middle of a wave, and two tasks uploading one file would interleave
    /// their PUTs against a single upload id and hand the hub a hole.
    pub fn peer_sync_claim(&self, rel_path: &str) -> bool {
        self.lock()
            .execute(
                "UPDATE peer_sync_queue SET state = 'uploading', updated_at = ?2
                  WHERE rel_path = ?1 AND state = 'pending'",
                params![rel_path, now_ms()],
            )
            .unwrap_or(0)
            == 1
    }

    /// Remember the hub's upload id and how far the transfer has got. Written
    /// before the first byte moves: an id minted and forgotten is bytes on the
    /// hub's disk that nothing on either box can find again.
    pub fn peer_sync_progress(&self, rel_path: &str, upload_id: &str, sent: i64) {
        let _ = self.lock().execute(
            "UPDATE peer_sync_queue SET upload_id = ?2, sent_bytes = ?3, updated_at = ?4
              WHERE rel_path = ?1",
            params![rel_path, upload_id, sent, now_ms()],
        );
    }

    /// A transient failure: back to pending, one step down the ladder.
    ///
    /// The upload id is deliberately KEPT - it is the resume handle, and the
    /// next attempt asks the hub how much of it landed rather than starting a
    /// 40 MB FLAC again.
    pub fn peer_sync_defer(&self, rel_path: &str, error: &str) {
        const LADDER_MS: [i64; 4] = [60_000, 300_000, 900_000, 3_600_000];
        // Six hours, forever. Never dormant: a hub that was off all weekend
        // must be caught up when it returns without anyone asking.
        const TAIL_MS: i64 = 21_600_000;
        let conn = self.lock();
        let attempts: i64 = conn
            .query_row(
                "SELECT attempts FROM peer_sync_queue WHERE rel_path = ?1",
                params![rel_path],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let wait = LADDER_MS.get(attempts as usize).copied().unwrap_or(TAIL_MS);
        let _ = conn.execute(
            "UPDATE peer_sync_queue SET state = 'pending', attempts = attempts + 1,
                                        next_try_at = ?2, error = ?3, updated_at = ?4
              WHERE rel_path = ?1",
            params![rel_path, now_ms() + wait, error, now_ms()],
        );
    }

    /// Settle a row: `done`, `skipped` (the hub already has it) or `failed`.
    pub fn peer_sync_finish(&self, rel_path: &str, state: &str, error: &str) {
        let _ = self.lock().execute(
            "UPDATE peer_sync_queue SET state = ?2, error = ?3, updated_at = ?4
              WHERE rel_path = ?1",
            params![rel_path, state, error, now_ms()],
        );
    }

    /// Throw away the resume handle - for when the hub says it no longer knows
    /// the id. The row stays queued; the next attempt re-inits from zero.
    pub fn peer_sync_reset(&self, rel_path: &str) {
        let _ = self.lock().execute(
            "UPDATE peer_sync_queue SET upload_id = '', sent_bytes = 0, updated_at = ?2
              WHERE rel_path = ?1",
            params![rel_path, now_ms()],
        );
    }

    /// At boot: an `uploading` row is a lie, because nothing is uploading.
    pub fn peer_sync_reclaim_stuck(&self) -> usize {
        self.lock()
            .execute(
                "UPDATE peer_sync_queue SET state = 'pending', updated_at = ?1
                  WHERE state = 'uploading'",
                params![now_ms()],
            )
            .unwrap_or(0)
    }

    pub fn peer_sync_counts(&self) -> PeerSyncCounts {
        let conn = self.lock();
        let of = |state: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM peer_sync_queue WHERE state = ?1",
                params![state],
                |r| r.get(0),
            )
            .unwrap_or(0)
        };
        PeerSyncCounts {
            pending: of("pending"),
            uploading: of("uploading"),
            done: of("done"),
            skipped: of("skipped"),
            failed: of("failed"),
        }
    }

    /// What the status pane shows: anything failed first, because that is the
    /// only state a person can do something about, then the newest work.
    pub fn peer_sync_recent(&self, limit: usize) -> Vec<PeerSyncRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(&format!(
            "SELECT {PEER_SYNC_COLS} FROM peer_sync_queue
              ORDER BY (state = 'failed') DESC, updated_at DESC LIMIT ?1"
        )) else {
            return Vec::new();
        };
        stmt.query_map(params![limit as i64], peer_sync_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Queue failed pushes again - one path, or all of them.
    ///
    /// The upload id is cleared here, unlike in `peer_sync_defer`: a terminal
    /// failure means the hub-side temp is not to be trusted (a finish that
    /// returned 422 has already deleted it), so the retry starts clean.
    pub fn peer_sync_retry(&self, rel_path: Option<&str>) -> usize {
        let conn = self.lock();
        let sql = "UPDATE peer_sync_queue
                      SET state = 'pending', attempts = 0, next_try_at = 0,
                          error = '', upload_id = '', sent_bytes = 0, updated_at = ?1
                    WHERE state = 'failed'";
        match rel_path {
            Some(rel) => conn
                .execute(&format!("{sql} AND rel_path = ?2"), params![now_ms(), rel])
                .unwrap_or(0),
            None => conn.execute(sql, params![now_ms()]).unwrap_or(0),
        }
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
                    COALESCE(f.ai_lyrical_themes,''), COALESCE(f.ai_confidence,0),
                    COALESCE(p.canonical_profile,'')
             FROM tracks t LEFT JOIN track_features f ON f.track_id = t.id
             LEFT JOIN song_profile_layers p ON p.track_id = t.id
             WHERE t.deleted = 0 AND t.id IN ({list})"
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            let canonical_raw: String = r.get(22)?;
            let canonical: Option<crate::enrichment::SemanticProfile> =
                serde_json::from_str(&canonical_raw).ok();
            let legacy_genres = comma_terms(r.get(17)?);
            let legacy_moods = comma_terms(r.get(18)?);
            let legacy_traits = comma_terms(r.get(19)?);
            let legacy_themes = comma_terms(r.get(20)?);
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
                ai_summary: canonical.as_ref().map(|p| p.summary.clone()).filter(|v| !v.is_empty()).unwrap_or(r.get(16)?),
                ai_genres: canonical.as_ref().map(|p| p.genres.clone()).filter(|v| !v.is_empty()).unwrap_or(legacy_genres),
                ai_moods: canonical.as_ref().map(|p| p.moods.clone()).filter(|v| !v.is_empty()).unwrap_or(legacy_moods),
                ai_vibes: canonical.as_ref().map(|p| p.vibes.clone()).unwrap_or_default(),
                ai_sonic_traits: canonical.as_ref().map(|p| p.musical_traits.clone()).filter(|v| !v.is_empty()).unwrap_or(legacy_traits),
                ai_lyrical_themes: canonical.as_ref().map(|p| p.lyrical_themes.clone()).filter(|v| !v.is_empty()).unwrap_or(legacy_themes),
                ai_specific_tags: canonical.as_ref().map(|p| p.specific_tags.clone()).unwrap_or_default(),
                ai_production_descriptors: canonical.as_ref().map(|p| p.production_descriptors.clone()).unwrap_or_default(),
                ai_influences: canonical.as_ref().map(|p| p.influences.clone()).unwrap_or_default(),
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
                     COALESCE(f.ai_genres,''), COALESCE(f.ai_sonic_traits,''),
                     COALESCE(p.canonical_profile,''),
                     t.curator_user_id, t.added_at, COALESCE(t.kind, 'music'), t.title
             FROM tracks t LEFT JOIN track_features f ON f.track_id = t.id
             LEFT JOIN song_profile_layers p ON p.track_id = t.id
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
            let canonical_raw: String = r.get(24)?;
            let canonical: Option<crate::enrichment::SemanticProfile> =
                serde_json::from_str(&canonical_raw).ok();
            Ok(TrackFeatures {
                track_id: r.get(0)?,
                bpm: r.get(1)?,
                lyric_vec: vec,
                genre: r.get(4)?,
                ai_genres: canonical.as_ref().map(|p| p.genres.clone()).filter(|v| !v.is_empty())
                    .unwrap_or(comma_terms(r.get(22)?)),
                ai_moods: canonical.as_ref().map(|p| p.moods.clone()).unwrap_or_default(),
                ai_specific_tags: canonical.as_ref().map(|p| p.specific_tags.clone()).unwrap_or_default(),
                ai_sonic_traits: canonical.as_ref().map(|p| p.musical_traits.clone()).filter(|v| !v.is_empty())
                    .unwrap_or(comma_terms(r.get(23)?)),
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
                curator_user_id: r.get(25)?,
                added_at: r.get(26).unwrap_or(0),
                audio_fingerprint: decode(r.get(20)?, r.get(21)?),
                kind: r.get(27)?,
                title: r.get(28)?,
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

    /// Current semantic-enrichment pass: normalized fast profiles completed,
    /// normalized refinements completed, tracks eligible for refinement, and
    /// total live tracks. Rejected fast profiles count as processed for this
    /// pass, but not as refinement targets.
    pub fn layered_enrichment_counts(&self, stale_before: i64) -> (i64, i64, i64, i64) {
        let conn = self.lock();
        let one = |sql: &str| -> i64 {
            conn.query_row(sql, params![stale_before], |r| r.get(0))
                .unwrap_or(0)
        };
        (
            one(
                "SELECT COUNT(*) FROM tracks t
                 LEFT JOIN song_profile_layers p ON p.track_id=t.id
                 LEFT JOIN track_features f ON f.track_id=t.id
                 WHERE t.deleted=0 AND (
                   COALESCE(p.fast_created_at,0) >= ?1 OR
                   (COALESCE(f.ai_sources,'')='rejected_v3' AND COALESCE(f.ai_enriched_at,0) >= ?1)
                 )",
            ),
            one(
                "SELECT COUNT(*) FROM tracks t JOIN song_profile_layers p ON p.track_id=t.id
                 WHERE t.deleted=0 AND p.refined_at >= ?1 AND p.refinement_patch<>''",
            ),
            one(
                "SELECT COUNT(*) FROM tracks t JOIN song_profile_layers p ON p.track_id=t.id
                 WHERE t.deleted=0 AND p.fast_created_at >= ?1 AND p.fast_profile<>''",
            ),
            conn.query_row("SELECT COUNT(*) FROM tracks WHERE deleted=0", [], |r| r.get(0))
                .unwrap_or(0),
        )
    }

    // --- the curator's playlists ---------------------------------------------

    /// Everyone who has listened since `since_ms` - who the curator builds for.
    /// Every account whose waiting date deck is thinner than `floor` -
    /// including accounts that have never played a note. The cold-start set:
    /// a promise like "forty suggestions when she opens the app" has to hold
    /// for someone the plays table has never heard of.
    pub fn cold_shelf_users(&self, floor: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT u.id FROM users u
             LEFT JOIN (SELECT curator_user_id AS uid, COUNT(*) AS n FROM tracks
                        WHERE deleted = 0 AND curator_user_id IS NOT NULL
                          AND COALESCE(curator_promoted, 0) = 0
                        GROUP BY curator_user_id) a ON a.uid = u.id
             WHERE COALESCE(a.n, 0) < ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![floor], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

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
    /// Remove one built list - a station whose mood no longer exists must not
    /// linger with last month's name on it.
    pub fn delete_curated(&self, user_id: i64, slug: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM curated WHERE user_id = ?1 AND slug = ?2",
            params![user_id, slug],
        )?;
        Ok(())
    }

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
    ///
    /// Returns whether the row was taken - inserted or refreshed. `false`
    /// means the judged-song guard below refused it, and a caller must write
    /// NOTHING else about the candidate (no anchors, no lane): a song the
    /// listener already passed on has no business acquiring threads.
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
    ) -> rusqlite::Result<bool> {
        // A song this listener has already ruled on as a preview date is not
        // a discovery, whatever id the catalogue gives it this time. Checked
        // HERE, in the one door every harvester (taste walk, on-demand seed,
        // the charts) comes through, so no lane can forget to ask.
        let changed = self.lock().execute(
            "INSERT INTO discoveries
               (user_id, ext_id, title, artist, cover, url, preview, seed, popularity, found_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
              WHERE NOT EXISTS (
                SELECT 1 FROM date_candidate_verdicts v WHERE v.user_id = ?1 AND v.key = ?11)
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
                now_ms(),
                crate::discovery::key_of(artist, title)
            ],
        )?;
        Ok(changed > 0)
    }

    /// One thread between a pool candidate and an artist of the listener's.
    /// Only ever called after `add_discovery` returned true - see there.
    ///
    /// The same (candidate, artist, kind) seen again keeps the STRONGER of
    /// the two strengths: a neighbour that was eighth in one walk and second
    /// in the next is as close as the closer sighting says.
    pub fn add_discovery_anchor(
        &self,
        user_id: i64,
        ext_id: &str,
        anchor_name: &str,
        kind: &str,
        strength: f64,
    ) {
        let key = crate::discovery::artist_key_public(anchor_name);
        if key.is_empty() || kind.is_empty() {
            return;
        }
        let _ = self.lock().execute(
            "INSERT INTO discovery_anchors (user_id, ext_id, anchor_key, kind, strength, anchor_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id, ext_id, anchor_key, kind) DO UPDATE SET
               strength = MAX(strength, excluded.strength),
               anchor_name = excluded.anchor_name",
            params![user_id, ext_id, key, kind, strength.clamp(0.0, 1.0), anchor_name.trim()],
        );
    }

    /// Why one candidate is in the pool: (artist as the library spells it,
    /// kind, strength), strongest thread first. The card's reason is drawn
    /// from these and never written by a model.
    pub fn discovery_anchors_for(&self, user_id: i64, ext_id: &str) -> Vec<(String, String, f64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT CASE WHEN anchor_name = '' THEN anchor_key ELSE anchor_name END, kind, strength
             FROM discovery_anchors WHERE user_id = ?1 AND ext_id = ?2
             ORDER BY strength DESC, kind",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, ext_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Every thread in one listener's pool, as (ext_id, anchor_key, kind,
    /// strength) - one read for a whole rescore, where a lookup per row
    /// would be hundreds.
    pub fn discovery_anchor_rows(&self, user_id: i64) -> Vec<(String, String, String, f64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT ext_id, anchor_key, kind, strength FROM discovery_anchors WHERE user_id = ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, f64>(3)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Candidates that have not been listened to yet, the best-connected
    /// first and, among equals, the least famous.
    ///
    /// This used to be `ORDER BY popularity DESC` - the most famous
    /// candidates were measured first, so the chart rows became offerable
    /// while the small connected finds the whole pipeline exists for sat
    /// unmeasured behind them. The sum of a candidate's anchor strengths is
    /// how many threads tie it to this listener; a row with none (a chart
    /// pick) waits its turn.
    pub fn discoveries_needing_work(&self, user_id: i64, limit: i64) -> Vec<DiscoveryRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT d.ext_id, d.title, d.artist, d.cover, d.url, d.preview, d.seed, d.popularity, d.bpm,
                    d.lyric_vec, d.vec_dims, d.score, d.energy, d.brightness, d.rhythmic, d.released
             FROM discoveries d WHERE d.user_id = ?1 AND d.checked_at = 0
             ORDER BY (SELECT COALESCE(SUM(a.strength), 0) FROM discovery_anchors a
                        WHERE a.user_id = d.user_id AND a.ext_id = d.ext_id) DESC,
                      d.popularity ASC
             LIMIT ?2",
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
                    lyric_vec, vec_dims, score, energy, brightness, rhythmic, released
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
    /// One pooled candidate by its catalogue id, for a verdict on a preview.
    /// Remember a dismissal, so the next harvest does not bring the same music
    /// straight back. `scope` is 'track' (the folded artist|title key) or
    /// 'artist' (the folded artist name). Re-dismissing refreshes the clock.
    pub fn reject_discovery(&self, user_id: i64, scope: &str, key: &str) {
        if key.trim().is_empty() {
            return;
        }
        let _ = self.lock().execute(
            "INSERT INTO discovery_rejections (user_id, scope, key, rejected_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id, scope, key) DO UPDATE SET rejected_at = excluded.rejected_at",
            params![user_id, scope, key, now_ms()],
        );
    }

    /// Whether a rejection still blocks. Inside its window it does; past it the
    /// row remains - a refusal from a year ago is history, not a life sentence,
    /// and tastes change.
    pub fn rejection_active(
        &self,
        user_id: i64,
        scope: &str,
        key: &str,
        now: i64,
        window_ms: i64,
    ) -> bool {
        self.lock()
            .query_row(
                "SELECT rejected_at FROM discovery_rejections
                 WHERE user_id = ?1 AND scope = ?2 AND key = ?3",
                params![user_id, scope, key],
                |r| r.get::<_, i64>(0),
            )
            .map(|at| now - at < window_ms)
            .unwrap_or(false)
    }

    /// Every rejection key in one scope since a moment - what seed selection
    /// reads to keep a recently dismissed artist out of the driver's seat even
    /// after their hard block has lapsed.
    pub fn rejected_keys_since(
        &self,
        user_id: i64,
        scope: &str,
        since: i64,
    ) -> std::collections::HashSet<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT key FROM discovery_rejections
             WHERE user_id = ?1 AND scope = ?2 AND rejected_at >= ?3",
        ) else {
            return Default::default();
        };
        stmt.query_map(params![user_id, scope, since], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The artists this listener has SAID yes to, weighted and strongest
    /// first - the seed list for every harvester, so what the pool grows FROM
    /// is hearts and keeps, never play counts.
    ///
    /// A heart and a Music Date keep weigh 1.0; a completed listen of ten
    /// seconds or more weighs 0.4 - the listener ranked hearts and keeps as
    /// their strongest signal, and a finished song is a quieter one. Each is
    /// decayed with a sixty-day half-life on when it happened, so the seeds
    /// follow where their taste is NOW rather than where it was in spring.
    /// Artists dismissed in the last thirty days are left out entirely
    /// (`rejected_keys_since`, scope "artist") - the read discovery.rs
    /// promised at its top and never wired. Books never seed.
    ///
    /// Returns (display name as the library spells it, weight). Keys are
    /// folded via `taste::artist_key`, so "Big Thief" and "big thief" are one.
    pub fn heart_weighted_artists(&self, user_id: i64, since_ms: i64, now_ms: i64) -> Vec<(String, f32)> {
        let rows: Vec<(String, f64, i64)> = {
            let conn = self.lock();
            let Ok(mut stmt) = conn.prepare(
                "SELECT t.artist, 1.0, f.added_at FROM favorites f
                   JOIN tracks t ON t.id = f.track_id AND t.deleted = 0 AND COALESCE(t.kind,'') != 'book'
                  WHERE f.user_id = ?1 AND f.added_at >= ?2
                 UNION ALL
                 SELECT t.artist, 1.0, d.at FROM date_verdicts d
                   JOIN tracks t ON t.id = d.track_id AND t.deleted = 0
                  WHERE d.user_id = ?1 AND d.verdict = 'kept' AND d.at >= ?2
                 UNION ALL
                 SELECT t.artist, 0.4, le.started_at FROM listen_events le
                   JOIN tracks t ON t.id = le.track_id AND t.deleted = 0 AND COALESCE(t.kind,'') != 'book'
                  WHERE le.user_id = ?1 AND le.completed = 1 AND le.ms_listened >= 10000
                    AND le.started_at >= ?2",
            ) else {
                return Vec::new();
            };
            stmt.query_map(params![user_id, since_ms], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, i64>(2)?))
            })
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
        };
        let rejected = self.rejected_keys_since(user_id, "artist", now_ms - 30 * 86_400_000);
        let mut weight: std::collections::HashMap<String, (String, f32)> = Default::default();
        for (artist, w, at) in rows {
            let key = crate::taste::artist_key(&artist);
            // The rejection ledger is written in the POOL's fold
            // (discovery::artist_key: accents and joiners dropped), not the
            // taste model's trim-and-lowercase - "The National" dismissed
            // is "national" on file, and a lookup by "the national" would
            // never find it. Ask in the vocabulary the answer is kept in.
            if key.is_empty() || rejected.contains(&crate::discovery::artist_key_public(&artist)) {
                continue;
            }
            let age_days = ((now_ms - at).max(0) as f32) / 86_400_000.0;
            let decayed = (w as f32) * 0.5f32.powf(age_days / 60.0);
            let e = weight.entry(key).or_insert_with(|| (artist.trim().to_string(), 0.0));
            e.1 += decayed;
        }
        let mut out: Vec<(String, f32)> = weight.into_values().collect();
        out.sort_by(|a, b| {
            b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.0.cmp(&b.0))
        });
        out
    }

    /// What the preview sounded like, measured off the clip - the texture a
    /// library track gets from its file, so a candidate can answer the same
    /// terms. Values are on the analyser's 0..1 scales.
    pub fn set_discovery_measured(
        &self,
        user_id: i64,
        ext_id: &str,
        energy: f64,
        brightness: f64,
        rhythmic: f64,
    ) {
        let _ = self.lock().execute(
            "UPDATE discoveries SET energy = ?3, brightness = ?4, rhythmic = ?5
              WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id, energy, brightness, rhythmic],
        );
    }

    /// When it came out, as the catalogue spells it (an ISO date or a bare
    /// year). First writer wins: a release date does not change.
    pub fn set_discovery_released(&self, user_id: i64, ext_id: &str, released: &str) {
        let released = released.trim();
        if released.is_empty() {
            return;
        }
        let _ = self.lock().execute(
            "UPDATE discoveries SET released = ?3
              WHERE user_id = ?1 AND ext_id = ?2 AND COALESCE(released, '') = ''",
            params![user_id, ext_id, released],
        );
    }

    /// A thumb, as given. Returns the row id.
    pub fn record_dj_reaction(
        &self,
        user_id: i64,
        track_id: i64,
        reaction: &str,
        position_ms: i64,
        now: i64,
    ) -> i64 {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO dj_reactions (user_id, track_id, reaction, position_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![user_id, track_id, reaction, position_ms.max(0), now],
        );
        conn.last_insert_rowid()
    }

    /// The listener's thumbs since a moment: track_id -> (ups, downs). What
    /// the explore sampler reads so a thumb-up counts as adoption and a
    /// thumb-down as a louder failure than a skip.
    pub fn dj_reactions_since(&self, user_id: i64, since: i64) -> std::collections::HashMap<i64, (i64, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT track_id,
                    SUM(CASE WHEN reaction = 'up' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN reaction = 'down' THEN 1 ELSE 0 END)
               FROM dj_reactions WHERE user_id = ?1 AND created_at >= ?2 GROUP BY track_id",
        ) else {
            return Default::default();
        };
        stmt.query_map(params![user_id, since], |r| {
            Ok((r.get::<_, i64>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Write down the chart as it stands: (ext_id, folded artist, 1-based
    /// position). Rows older than five weeks go with it.
    pub fn snapshot_chart(&self, fetched_at: i64, rows: &[(String, String, f64)]) {
        let mut conn = self.lock();
        let Ok(tx) = conn.transaction() else { return };
        for (ext_id, artist_key, rank) in rows {
            let _ = tx.execute(
                "INSERT OR REPLACE INTO chart_snapshots (fetched_at, ext_id, artist_key, rank)
                 VALUES (?1, ?2, ?3, ?4)",
                params![fetched_at, ext_id, artist_key, rank],
            );
        }
        let _ = tx.execute(
            "DELETE FROM chart_snapshots WHERE fetched_at < ?1",
            params![fetched_at - 35 * 86_400_000],
        );
        let _ = tx.commit();
    }

    /// Where each charted song stands now against roughly a week ago:
    /// ext_id -> (artist_key, rank_now, delta). `delta > 0` is rising, in
    /// places climbed. A song that was not on the chart a week ago and is
    /// now has climbed from just below the bottom - being new to the chart
    /// IS the rise. With only one snapshot on file nothing can be compared
    /// and every delta is 0: a shelf built on it stays honest and empty.
    pub fn chart_rank_deltas(&self) -> std::collections::HashMap<String, (String, f64, f64)> {
        let conn = self.lock();
        let latest: i64 = conn
            .query_row("SELECT COALESCE(MAX(fetched_at), 0) FROM chart_snapshots", [], |r| r.get(0))
            .unwrap_or(0);
        if latest == 0 {
            return Default::default();
        }
        // The newest snapshot that is at least a week older than the latest,
        // else the oldest there is - "about a week ago", as best we can.
        let reference: i64 = conn
            .query_row(
                "SELECT COALESCE(
                    (SELECT MAX(fetched_at) FROM chart_snapshots WHERE fetched_at <= ?1),
                    (SELECT MIN(fetched_at) FROM chart_snapshots))",
                params![latest - 7 * 86_400_000],
                |r| r.get(0),
            )
            .unwrap_or(latest);
        let read = |at: i64| -> Vec<(String, String, f64)> {
            let Ok(mut stmt) =
                conn.prepare("SELECT ext_id, artist_key, rank FROM chart_snapshots WHERE fetched_at = ?1")
            else {
                return Vec::new();
            };
            stmt.query_map(params![at], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default()
        };
        let now_rows = read(latest);
        let before: std::collections::HashMap<String, f64> = if reference < latest {
            read(reference).into_iter().map(|(e, _, r)| (e, r)).collect()
        } else {
            Default::default()
        };
        let bottom = now_rows.len() as f64 + 1.0;
        now_rows
            .into_iter()
            .map(|(ext_id, artist_key, rank)| {
                let delta = if reference < latest {
                    before.get(&ext_id).copied().unwrap_or(bottom) - rank
                } else {
                    0.0
                };
                (ext_id, (artist_key, rank, delta))
            })
            .collect()
    }

    /// What this listener's FRIENDS finished lately that they have not met -
    /// friends through `friendships` only, never the hub's other members.
    /// Excludes anything the caller has already heard past a mis-tap or
    /// hearted, books, and another member's unadopted audition (which is
    /// not theirs to hear yet). Most-listeners first, then most recent.
    pub fn friends_completed_since(&self, user_id: i64, since: i64) -> Vec<FriendPlay> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT le.track_id, COUNT(*), GROUP_CONCAT(DISTINCT u.username), MAX(le.started_at)
               FROM listen_events le
               JOIN users u ON u.id = le.user_id
               JOIN tracks t ON t.id = le.track_id AND t.deleted = 0
                    AND COALESCE(t.kind, 'music') <> 'book'
                    AND (t.curator_user_id IS NULL OR COALESCE(t.curator_promoted, 0) = 1)
              WHERE le.user_id IN (SELECT CASE WHEN f.a_id = ?1 THEN f.b_id ELSE f.a_id END
                                     FROM friendships f WHERE f.a_id = ?1 OR f.b_id = ?1)
                AND le.completed = 1 AND le.started_at >= ?2
                AND NOT EXISTS (SELECT 1 FROM listen_events m
                                 WHERE m.user_id = ?1 AND m.track_id = le.track_id
                                   AND (m.completed = 1 OR m.ms_listened >= 10000))
                AND NOT EXISTS (SELECT 1 FROM favorites fv
                                 WHERE fv.user_id = ?1 AND fv.track_id = le.track_id)
              GROUP BY le.track_id
              ORDER BY COUNT(DISTINCT le.user_id) DESC, MAX(le.started_at) DESC
              LIMIT 24",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since], |r| {
            let names: String = r.get(2)?;
            Ok(FriendPlay {
                track_id: r.get(0)?,
                completions: r.get(1)?,
                listeners: names.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect(),
                last_at: r.get(3)?,
            })
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// What one candidate's preview sounded like - its measured energy, on
    /// the analyser's 0..1 scale - or None when nobody has listened yet.
    /// This is the texture term a Music Date card owns up to having measured.
    pub fn discovery_texture(&self, user_id: i64, ext_id: &str) -> Option<f64> {
        self.lock()
            .query_row(
                "SELECT energy FROM discoveries WHERE user_id = ?1 AND ext_id = ?2",
                params![user_id, ext_id],
                |r| r.get::<_, Option<f64>>(0),
            )
            .ok()
            .flatten()
    }

    /// When one candidate came out, as the catalogue spelled it.
    pub fn discovery_released(&self, user_id: i64, ext_id: &str) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT released FROM discoveries WHERE user_id = ?1 AND ext_id = ?2",
                params![user_id, ext_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
    }

    /// The two readers above over a whole pool in one pass: ext_id ->
    /// (texture, released). A deal walks four hundred rows and must not ask
    /// four hundred questions.
    pub fn discovery_extras(
        &self,
        user_id: i64,
    ) -> std::collections::HashMap<String, (Option<f64>, Option<String>)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT ext_id, energy, released FROM discoveries
              WHERE user_id = ?1 AND (energy IS NOT NULL OR COALESCE(released, '') != '')",
        ) else {
            return Default::default();
        };
        stmt.query_map(params![user_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (
                    r.get::<_, Option<f64>>(1)?,
                    r.get::<_, Option<String>>(2)?.filter(|s| !s.trim().is_empty()),
                ),
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn discovery_get(&self, user_id: i64, ext_id: &str) -> Option<DiscoveryRow> {
        let conn = self.lock();
        conn.query_row(
            "SELECT ext_id, title, artist, cover, url, preview, seed, popularity, bpm,
                    lyric_vec, vec_dims, score, energy, brightness, rhythmic, released
             FROM discoveries WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id],
            discovery_from_row,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn top_discoveries(&self, user_id: i64, limit: i64) -> Vec<DiscoveryRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT ext_id, title, artist, cover, url, preview, seed, popularity, bpm,
                    lyric_vec, vec_dims, score, energy, brightness, rhythmic, released
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
        // The lane tag goes with it: a fossil lane row would both leak and
        // block the candidate from ever being fanned to this listener again.
        let _ = self.lock().execute(
            "DELETE FROM discovery_lanes WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id],
        );
        // And its threads: a candidate that is gone hangs off nothing.
        let _ = self.lock().execute(
            "DELETE FROM discovery_anchors WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id],
        );
    }

    /// How many candidates are waiting, and how many have been listened to.
    /// Tag a pool candidate with the lane it came in through. Idempotent per
    /// (user, candidate); a candidate found by two lanes keeps the FIRST - the
    /// lane is provenance, not a ranking, and "the charts also have it" does
    /// not change where it was found.
    pub fn tag_discovery_lane(
        &self,
        user_id: i64,
        ext_id: &str,
        lane: &str,
        rank: f64,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT OR IGNORE INTO discovery_lanes (user_id, ext_id, lane, rank, found_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![user_id, ext_id, lane, rank, now_ms()],
        )?;
        Ok(())
    }

    /// The measured pool rows beyond the keep-limit, worst score first - what
    /// the pruner deletes. Unmeasured rows are never offered up: they are the
    /// queue the listener already paid harvest calls for, and they leave by
    /// being measured, not by being crowded out.
    /// Only rows past `settled_before` are ever offered up. A NEW candidate
    /// competing on score against the settled top of a deep pool loses by
    /// construction - the incumbents are the best of everything ever
    /// harvested - so without this the trending lane's finds were measured
    /// and then evicted within two cycles, before any shelf or buyer had
    /// seen them. Age is the fair judge: a week on the shelf, then score
    /// decides.
    pub fn discovery_overflow(&self, user_id: i64, keep: i64, settled_before: i64) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT ext_id FROM discoveries
             WHERE user_id = ?1 AND checked_at > 0 AND found_at < ?3
             ORDER BY score DESC LIMIT -1 OFFSET ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, keep, settled_before], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every ext_id currently in one listener's pool, measured or not.
    pub fn discovery_ext_ids(&self, user_id: i64) -> std::collections::HashSet<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT ext_id FROM discoveries WHERE user_id = ?1")
        else {
            return Default::default();
        };
        stmt.query_map(params![user_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every lane tag for one listener's pool, ext_id -> (lane, rank).
    pub fn discovery_lanes(&self, user_id: i64) -> std::collections::HashMap<String, (String, f64)> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT ext_id, lane, rank FROM discovery_lanes WHERE user_id = ?1")
        else {
            return Default::default();
        };
        stmt.query_map(params![user_id], |r| {
            Ok((r.get::<_, String>(0)?, (r.get::<_, String>(1)?, r.get::<_, f64>(2)?)))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// The listener's own unadopted auditions - the collector's fetches still
    /// waiting on a listen. These are the "new music" a blended station may
    /// honestly include: on disk, playable, and adopted by exactly the
    /// completed listen a station invites.
    /// How many unadopted auditions wait on this listener's shelf - the
    /// collector serves the hungriest first.
    /// Every live track's identity for chart matching: id, artist, title,
    /// and whose unadopted audition it is (0 = a real library row).
    pub fn track_identities(&self) -> Vec<(i64, String, String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, artist, title,
                    CASE WHEN curator_user_id IS NOT NULL AND COALESCE(curator_promoted, 0) = 0
                         THEN curator_user_id ELSE 0 END
             FROM tracks WHERE deleted = 0 AND COALESCE(kind, 'music') <> 'book'",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every album name in the live library, once each. The DJ's patter
    /// check reads it: a record the model names that is on this shelf but
    /// not in the line's own facts is a memory, not a fact.
    pub fn album_names(&self) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT DISTINCT album FROM tracks WHERE deleted = 0 AND TRIM(album) <> ''",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn new_music_get(&self, user_id: i64) -> Option<(String, i64)> {
        self.lock()
            .query_row(
                "SELECT body, built_at FROM new_music_cache WHERE user_id = ?1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn new_music_put(&self, user_id: i64, body: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO new_music_cache (user_id, body, built_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET body = ?2, built_at = ?3",
            params![user_id, body, now_ms()],
        )?;
        Ok(())
    }

    /// The New Music Mix's two inventories, newest first: this listener's own
    /// unadopted auditions, and the library's plain arrivals since `since`.
    pub fn new_mix_candidates(
        &self,
        user_id: i64,
        auditions_since: i64,
        arrivals_since: i64,
    ) -> (Vec<i64>, Vec<i64>) {
        let conn = self.lock();
        let read = |sql: &str, ps: &[&dyn rusqlite::ToSql]| -> Vec<i64> {
            let Ok(mut stmt) = conn.prepare(sql) else { return Vec::new() };
            stmt.query_map(ps, |r| r.get(0))
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default()
        };
        // "New to them" means they have never MET the song, decided here in
        // SQL rather than against a window of recent plays: the old
        // `recent_plays(400)` forgot anything played more than four hundred
        // distinct songs ago, and never saw a song sampled and skipped inside
        // thirty seconds (no play row lands that early), a heart, or a date
        // verdict - all of which are the listener meeting the song and
        // deciding. Any listen event counts. All four ledgers are indexed on
        // (user_id, track_id). Applied to BOTH inventories - a promoted
        // audition used to walk straight back in as an arrival.
        const NOT_MET: &str = "
               AND NOT EXISTS (SELECT 1 FROM plays p WHERE p.user_id = ?1 AND p.track_id = t.id)
               AND NOT EXISTS (SELECT 1 FROM listen_events le WHERE le.user_id = ?1 AND le.track_id = t.id)
               AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = ?1 AND f.track_id = t.id)
               AND NOT EXISTS (SELECT 1 FROM date_verdicts d WHERE d.user_id = ?1 AND d.track_id = t.id)";
        // Auditions are bounded in age too: an unadopted backlog from months
        // ago is not "new music", and unbounded it filled every seat.
        let auditions = read(
            &format!(
                "SELECT t.id FROM tracks t WHERE t.deleted = 0 AND t.kind = 'music'
                   AND t.curator_user_id = ?1 AND COALESCE(t.curator_promoted, 0) = 0
                   AND t.added_at > ?2{NOT_MET}
                 ORDER BY t.added_at DESC"
            ),
            &[&user_id, &auditions_since],
        );
        let arrivals = read(
            &format!(
                "SELECT t.id FROM tracks t WHERE t.deleted = 0 AND t.kind = 'music'
                   AND t.added_at > ?2
                   AND (t.curator_user_id IS NULL OR COALESCE(t.curator_promoted, 0) = 1){NOT_MET}
                 ORDER BY t.added_at DESC"
            ),
            &[&user_id, &arrivals_since],
        );
        (auditions, arrivals)
    }

    /// Every pending like on the box: (user_id, k, created_at). The sweep's
    /// read - it wants everyone's at once.
    pub fn pending_likes_all(&self) -> Vec<(i64, String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT user_id, k, created_at FROM pending_likes")
        else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// One listener's pending likes, newest first: (k, title, artist, created_at).
    pub fn pending_likes_for(&self, user_id: i64) -> Vec<(String, String, String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT k, title, artist, created_at FROM pending_likes
             WHERE user_id = ?1 ORDER BY created_at DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn pending_like_put(
        &self,
        user_id: i64,
        k: &str,
        title: &str,
        artist: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO pending_likes (user_id, k, title, artist, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id, k) DO NOTHING",
            params![user_id, k, title, artist, now_ms()],
        )?;
        Ok(())
    }

    pub fn pending_like_remove(&self, user_id: i64, k: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM pending_likes WHERE user_id = ?1 AND k = ?2",
            params![user_id, k],
        )?;
        Ok(())
    }

    // --- playlist wants (planned, not-yet-owned playlist members) ----------

    /// Files a not-yet-owned song into a playlist. Idempotent per (playlist, k);
    /// a re-add refreshes the title/artist/url in case a later sighting knows
    /// them better but does not disturb the created order.
    pub fn playlist_want_put(
        &self,
        user_id: i64,
        playlist_id: i64,
        k: &str,
        title: &str,
        artist: &str,
        url: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO playlist_wants (user_id, playlist_id, k, title, artist, url, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(playlist_id, k) DO UPDATE SET
               title = excluded.title, artist = excluded.artist, url = excluded.url",
            params![user_id, playlist_id, k, title, artist, url, now_ms()],
        )?;
        Ok(())
    }

    /// One playlist's wants, oldest first (they were filed in an order):
    /// (k, title, artist, url, created_at).
    pub fn playlist_wants_for(
        &self,
        playlist_id: i64,
    ) -> Vec<(String, String, String, String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT k, title, artist, url, created_at FROM playlist_wants
             WHERE playlist_id = ?1 ORDER BY created_at ASC",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![playlist_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Every want across a user's playlists: (user_id, playlist_id, k, title,
    /// artist, created_at). The collector's settle sweep reads this to know
    /// which lists a just-landed key belongs to, and to age wants out.
    pub fn playlist_wants_all(&self) -> Vec<(i64, i64, String, String, String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT user_id, playlist_id, k, title, artist, created_at FROM playlist_wants",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn playlist_want_remove(&self, playlist_id: i64, k: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM playlist_wants WHERE playlist_id = ?1 AND k = ?2",
            params![playlist_id, k],
        )?;
        Ok(())
    }

    /// Whether this track is currently one of this listener's waiting
    /// auditions - the date deck's own membership rule.
    pub fn audition_of(&self, track_id: i64, user_id: i64) -> bool {
        let conn = self.lock();
        conn.query_row(
            "SELECT 1 FROM tracks
             WHERE id = ?1 AND deleted = 0 AND curator_user_id = ?2
               AND COALESCE(curator_promoted, 0) = 0",
            params![track_id, user_id],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Why the collector chose the song a landed audition came from - the
    /// pull's own reason line, newest first when a track somehow has two.
    pub fn pull_reason_for_track(&self, user_id: i64, track_id: i64) -> Option<String> {
        let conn = self.lock();
        conn.query_row(
            "SELECT p.reason FROM curator_pull_tracks pt
             JOIN curator_pulls p ON p.id = pt.pull_id
             WHERE pt.track_id = ?2 AND p.user_id = ?1
             ORDER BY p.created_at DESC LIMIT 1",
            params![user_id, track_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
    }

    pub fn audition_count(&self, user_id: i64) -> i64 {
        let conn = self.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM tracks
             WHERE deleted = 0 AND curator_user_id = ?1 AND COALESCE(curator_promoted, 0) = 0",
            params![user_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    pub fn audition_ids(&self, user_id: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM tracks
             WHERE deleted = 0 AND curator_user_id = ?1 AND COALESCE(curator_promoted, 0) = 0",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The controlled mood words for a set of tracks, from the enrichment
    /// projection. They live in the ai_vibes COLUMN - save_layered_profile
    /// writes canonical.moods there - which is exactly the sort of fact that
    /// should be knowable from one place; this is that place.
    pub fn mood_words_for(&self, ids: &[i64]) -> std::collections::HashMap<i64, Vec<String>> {
        let mut out = std::collections::HashMap::new();
        if ids.is_empty() {
            return out;
        }
        let conn = self.lock();
        let marks = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT track_id, COALESCE(ai_vibes, '') FROM track_features WHERE track_id IN ({marks})"
        );
        let Ok(mut stmt) = conn.prepare(&sql) else { return out };
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        });
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                let words: Vec<String> = row
                    .1
                    .split(',')
                    .map(|w| w.trim().to_lowercase())
                    .filter(|w| !w.is_empty())
                    .collect();
                if !words.is_empty() {
                    out.insert(row.0, words);
                }
            }
        }
        out
    }

    /// (artist, title) for a handful of tracks, in the order asked.
    pub fn titles_for(&self, ids: &[i64]) -> Vec<(String, String)> {
        let conn = self.lock();
        let mut out = Vec::new();
        for id in ids {
            if let Ok(row) = conn.query_row(
                "SELECT artist, title FROM tracks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ) {
                out.push(row);
            }
        }
        out
    }

    /// The stored mood profile, if one has been built: (built_at, json).
    /// The banked DJ set for one vibe: (body, built_at, consumed_at).
    pub fn dj_set_get(&self, user: i64, vibe: &str) -> Option<(String, i64, i64)> {
        let conn = self.lock();
        conn.query_row(
            "SELECT body, built_at, consumed_at FROM dj_sets WHERE user_id = ?1 AND vibe = ?2",
            params![user, vibe],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn dj_set_put(&self, user: i64, vibe: &str, body: &str) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO dj_sets (user_id, vibe, body, built_at, consumed_at)
             VALUES (?1, ?2, ?3, ?4, 0)
             ON CONFLICT(user_id, vibe) DO UPDATE SET body = ?3, built_at = ?4, consumed_at = 0",
            params![user, vibe, body, now_ms()],
        )?;
        Ok(())
    }

    pub fn dj_set_consume(&self, user: i64, vibe: &str) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE dj_sets SET consumed_at = ?3 WHERE user_id = ?1 AND vibe = ?2",
            params![user, vibe, now_ms()],
        )?;
        Ok(())
    }

    /// Every stored lore row among `ids`: (track_id, body, built_at).
    /// Empty bodies ride along so the caller can tell "asked, unknown" from
    /// "never asked".
    pub fn lore_rows(&self, ids: &[i64]) -> Vec<(i64, String, i64)> {
        let conn = self.lock();
        let mut out = Vec::new();
        for id in ids {
            if let Ok(row) = conn.query_row(
                "SELECT track_id, body, built_at FROM song_lore WHERE track_id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ) {
                out.push(row);
            }
        }
        out
    }

    pub fn artist_lore_rows(&self, keys: &[String]) -> Vec<(String, String, i64)> {
        let conn = self.lock();
        let mut out = Vec::new();
        for k in keys {
            if let Ok(row) = conn.query_row(
                "SELECT k, body, built_at FROM artist_lore WHERE k = ?1",
                params![k],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ) {
                out.push(row);
            }
        }
        out
    }

    /// Distinct artist names sitting in the discovery pool, most promising
    /// first - the ones a deck is most likely to deal next, so warming them is
    /// warming what someone is actually about to meet.
    pub fn discovery_artists(&self, limit: usize) -> Vec<String> {
        let db = self.conn.lock().unwrap();
        let Ok(mut stmt) = db.prepare(
            "SELECT artist FROM discoveries
             WHERE TRIM(artist) != ''
             GROUP BY LOWER(artist)
             ORDER BY MAX(score) DESC
             LIMIT ?1",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([limit as i64], |r| r.get::<_, String>(0));
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// The cached profiles for these folded keys: (k, body JSON, sources, built_at).
    pub fn artist_profile_rows(&self, keys: &[String]) -> Vec<(String, String, String, i64)> {
        let db = self.conn.lock().unwrap();
        let mut out = Vec::new();
        for k in keys {
            let row = db.query_row(
                "SELECT k, body, sources, built_at FROM artist_profiles WHERE k = ?1",
                [k],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            );
            if let Ok(v) = row {
                out.push(v);
            }
        }
        out
    }

    /// Store a built profile.
    ///
    /// The guard is the point: a build that answered from FEWER sources than
    /// the stored row never overwrites it. A Deezer-only inline build racing a
    /// full background one would otherwise throw away the deep profile the
    /// sweep just wrote, and the card would visibly lose its genres.
    pub fn artist_profile_put(
        &self,
        k: &str,
        artist: &str,
        body: &str,
        sources: &str,
        built_at: i64,
        now: i64,
    ) -> rusqlite::Result<()> {
        let depth = sources.split(',').filter(|s| !s.trim().is_empty()).count() as i64;
        let db = self.conn.lock().unwrap();
        db.execute(
            "INSERT INTO artist_profiles (k, artist, body, sources, built_at, checked_at)
             VALUES (?1, ?2, ?3, ?4, ?7, ?5)
             ON CONFLICT(k) DO UPDATE SET
               artist = excluded.artist,
               body = excluded.body,
               sources = excluded.sources,
               built_at = excluded.built_at,
               checked_at = excluded.checked_at
             WHERE ?6 >= (
               LENGTH(artist_profiles.sources) - LENGTH(REPLACE(artist_profiles.sources, ',', ''))
             ) + (CASE WHEN artist_profiles.sources = '' THEN 0 ELSE 1 END)",
            rusqlite::params![k, artist, body, sources, now, depth, built_at],
        )?;
        Ok(())
    }

    /// An attempt that found nothing. Advances the attempt clock ONLY, so a
    /// name the catalogues do not know is not asked about again this hour and
    /// a profile that already exists survives the miss untouched.
    pub fn artist_profile_touch(&self, k: &str, artist: &str, now: i64) {
        let db = self.conn.lock().unwrap();
        let _ = db.execute(
            "INSERT INTO artist_profiles (k, artist, body, sources, built_at, checked_at)
             VALUES (?1, ?2, '{}', '', 0, ?3)
             ON CONFLICT(k) DO UPDATE SET checked_at = ?3",
            rusqlite::params![k, artist, now],
        );
    }

    /// Which of these keys have no usable profile yet, or one old enough to
    /// rebuild - and are not inside their retry cooldown.
    pub fn artist_profile_gaps(
        &self,
        keys: &[String],
        stale_before: i64,
        retry_before: i64,
    ) -> Vec<String> {
        let db = self.conn.lock().unwrap();
        let mut out = Vec::new();
        for k in keys {
            let row: Option<(i64, i64, String)> = db
                .query_row(
                    "SELECT built_at, checked_at, sources FROM artist_profiles WHERE k = ?1",
                    [k],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            /*
             * Three states, not two, and the difference decides whether the
             * deep pass ever runs:
             *
             *   no row              never looked at        -> build
             *   built_at 0, sources SHALLOW: the inline Deezer-only build ran
             *                       because somebody was waiting on a panel,
             *                       and the full pass has never run -> build
             *                       NOW, with no cooldown. Getting this wrong
             *                       is what left every profile stuck on
             *                       `partial` forever: the shallow build
             *                       stamped built_at, the gap query saw a fresh
             *                       row, and the deepening never happened.
             *   built_at 0, no src  the last attempt FAILED or found nothing
             *                       -> respect the cooldown
             *   built_at > 0        fully built -> only when genuinely stale
             */
            match row {
                None => out.push(k.clone()),
                Some((0, _, sources)) if !sources.trim().is_empty() => out.push(k.clone()),
                Some((0, checked, _)) => {
                    if checked < retry_before {
                        out.push(k.clone());
                    }
                }
                Some((built, checked, _)) => {
                    if built < stale_before && checked < retry_before {
                        out.push(k.clone());
                    }
                }
            }
        }
        out
    }

    /// How much of an artist this listener already has here: tracks on the hub,
    /// and how many of them they have hearted.
    pub fn artist_holdings(&self, user_id: i64, artist: &str) -> (i64, i64) {
        let db = self.conn.lock().unwrap();
        let tracks: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE deleted = 0 AND LOWER(artist) = LOWER(?1)",
                [artist],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let hearted: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM favorites f JOIN tracks t ON t.id = f.track_id
                 WHERE f.user_id = ?1 AND t.deleted = 0 AND LOWER(t.artist) = LOWER(?2)",
                rusqlite::params![user_id, artist],
                |r| r.get(0),
            )
            .unwrap_or(0);
        (tracks, hearted)
    }

    pub fn artist_lore_put(&self, k: &str, artist: &str, body: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO artist_lore (k, artist, body, built_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(k) DO UPDATE SET body = ?3, built_at = ?4
             WHERE NOT (?3 = '' AND artist_lore.body != '')",
            params![k, artist, body, now_ms()],
        )?;
        Ok(())
    }

    pub fn lore_put(&self, track_id: i64, body: &str) -> rusqlite::Result<()> {
        let conn = self.lock();
        // A real line is permanent: an empty verdict arriving late (a racing
        // pass, a moodier model) must never blank lore a listener already has.
        conn.execute(
            "INSERT INTO song_lore (track_id, body, built_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(track_id) DO UPDATE SET body = ?2, built_at = ?3
             WHERE NOT (?2 = '' AND song_lore.body != '')",
            params![track_id, body, now_ms()],
        )?;
        Ok(())
    }

    pub fn mood_profile(&self, user_id: i64) -> Option<(i64, String)> {
        self.lock()
            .query_row(
                "SELECT built_at, profile FROM mood_profiles WHERE user_id = ?1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
    }

    pub fn save_mood_profile(&self, user_id: i64, profile: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO mood_profiles (user_id, built_at, profile) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET built_at = excluded.built_at,
               profile = excluded.profile",
            params![user_id, now_ms(), profile],
        )?;
        Ok(())
    }

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
    /// Songs this listener came BACK to inside a window, and how many times.
    ///
    /// Two sittings on the same song in a week, neither of them queued by a
    /// playlist, is the truest "I like this" a listener gives short of a
    /// heart - and nothing counted it. Sittings under the skip line do not
    /// count as returns: bailing twice is not coming back.
    pub fn recent_repeats(&self, user_id: i64, since: i64) -> std::collections::HashMap<i64, i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT track_id, COUNT(*) FROM listen_events
              WHERE user_id = ?1 AND started_at >= ?2 AND skipped = 0
              GROUP BY track_id HAVING COUNT(*) >= 2",
        ) else {
            return Default::default();
        };
        stmt.query_map(params![user_id, since], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

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
        shape: &ListenShape,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO listen_events (user_id, track_id, title, artist, album, genre,
                                        started_at, ms_listened, duration_ms, completed, skipped, context,
                                        ended_at_ms, volume_ups, seek_backs, device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                context,
                shape.ended_at_ms,
                shape.volume_ups,
                shape.seek_backs,
                shape.device
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
    // --- stems ------------------------------------------------------------

    /// Ask for a track's stems. Idempotent: a track already queued, running or
    /// done keeps the state it has, so a listener tapping twice does not send
    /// it round again. A FAILED job is retried, because the usual reason is a
    /// file that has since been replaced.
    pub fn request_stems(&self, track_id: i64) -> rusqlite::Result<String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO stem_jobs (track_id, state, requested_at)
             VALUES (?1, 'queued', ?2)
             ON CONFLICT(track_id) DO UPDATE SET
               state        = CASE WHEN stem_jobs.state = 'failed' THEN 'queued' ELSE stem_jobs.state END,
               error        = CASE WHEN stem_jobs.state = 'failed' THEN '' ELSE stem_jobs.error END,
               requested_at = CASE WHEN stem_jobs.state = 'failed' THEN ?2 ELSE stem_jobs.requested_at END",
            params![track_id, now_ms()],
        )?;
        conn.query_row(
            "SELECT state FROM stem_jobs WHERE track_id = ?1",
            params![track_id],
            |r| r.get(0),
        )
    }

    /// The next track waiting to be separated, oldest ask first.
    pub fn next_stem_job(&self) -> Option<(i64, String)> {
        let conn = self.lock();
        conn.query_row(
            "SELECT j.track_id, t.rel_path FROM stem_jobs j
               JOIN tracks t ON t.id = j.track_id
              WHERE j.state = 'queued' AND t.deleted = 0
              ORDER BY j.requested_at ASC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    }

    /// How many separations are ahead of this one in the queue.
    ///
    /// One worker takes one job at a time, so a song asked for while another is
    /// being separated simply waits - and until this existed there was no way to
    /// say so. A client could only report "waiting", which for a queue of three
    /// behind a job that takes minutes reads exactly like a server doing nothing
    /// at all. Counts by request order, which is the order the worker takes them.
    pub fn stems_queued_ahead(&self, track_id: i64) -> i64 {
        let conn = self.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM stem_jobs
              WHERE state IN ('queued','running')
                AND requested_at < (SELECT requested_at FROM stem_jobs WHERE track_id = ?1)",
            params![track_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    pub fn mark_stem_job(&self, track_id: i64, state: &str, error: &str) -> rusqlite::Result<()> {
        let now = now_ms();
        self.lock().execute(
            "UPDATE stem_jobs SET state = ?2, error = ?3,
               started_at  = CASE WHEN ?2 = 'running' THEN ?4 ELSE started_at END,
               finished_at = CASE WHEN ?2 IN ('done','failed') THEN ?4 ELSE finished_at END
             WHERE track_id = ?1",
            params![track_id, state, error, now],
        )?;
        Ok(())
    }

    /// Records a stem, choosing how warm it counts as.
    ///
    /// Eviction takes the track with the smallest MAX(used_at), and save_stem
    /// stamps used_at = now - so a night of prefetching would make guesses the
    /// hottest rows in the cache and evict the song somebody separated by hand
    /// yesterday. A prefetch is written far in the past instead: below every
    /// genuine use forever, still ordered among other guesses by age. The
    /// promotion already exists - stem_path() stamps used_at on every read, so
    /// the first real play of a prefetched song joins the warm set.
    pub fn save_stem_at(
        &self,
        track_id: i64,
        stem: &str,
        model: &str,
        rel_path: &str,
        bytes: i64,
        used_at: i64,
    ) -> rusqlite::Result<()> {
        let now = now_ms();
        self.lock().execute(
            "INSERT INTO track_stems (track_id, stem, model, rel_path, bytes, made_at, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(track_id, stem, model) DO UPDATE SET
               rel_path = excluded.rel_path, bytes = excluded.bytes, made_at = excluded.made_at",
            params![track_id, stem, model, rel_path, bytes, now, used_at],
        )?;
        Ok(())
    }

    pub fn save_stem(
        &self,
        track_id: i64,
        stem: &str,
        model: &str,
        rel_path: &str,
        bytes: i64,
    ) -> rusqlite::Result<()> {
        let now = now_ms();
        self.lock().execute(
            "INSERT INTO track_stems (track_id, stem, model, rel_path, bytes, made_at, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(track_id, stem, model) DO UPDATE SET
               rel_path = excluded.rel_path, bytes = excluded.bytes, made_at = excluded.made_at",
            params![track_id, stem, model, rel_path, bytes, now],
        )?;
        Ok(())
    }

    /// One track's stems, and the job state that explains their absence.
    /// A track's stems FOR ONE MODEL, with the job's state.
    ///
    /// The model argument is not decoration. `model` is part of the primary
    /// key precisely so a better separator can land beside an older one instead
    /// of overwriting it - but this query used to ignore it, so the moment two
    /// models existed for a track it returned both sets welded together: ten
    /// rows, two vintages, two `vocals`. The caller then served whichever came
    /// first. Asking for one model is what makes the coexistence real rather
    /// than theoretical.
    pub fn stems_for(&self, track_id: i64, model: &str) -> (String, String, Vec<(String, String, i64)>) {
        let conn = self.lock();
        let (state, error): (String, String) = conn
            .query_row(
                "SELECT state, error FROM stem_jobs WHERE track_id = ?1",
                params![track_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_else(|_| ("none".to_string(), String::new()));
        let mut rows = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT stem, rel_path, bytes FROM track_stems
             WHERE track_id = ?1 AND model = ?2 ORDER BY stem",
        ) {
            if let Ok(iter) = stmt.query_map(params![track_id, model], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            }) {
                rows = iter.filter_map(Result::ok).collect();
            }
        }
        (state, error, rows)
    }

    /// One stem's file, and a note that it was wanted just now - which is what
    /// the eviction sweep reads.
    pub fn stem_path(&self, track_id: i64, stem: &str, model: &str) -> Option<String> {
        let conn = self.lock();
        // Model-qualified for the same reason stems_for is: without it, a track
        // that has been separated twice answers "vocals" with whichever row the
        // planner happened to reach, which is a coin toss between a four-stem
        // vintage and a six-stem one.
        let path: String = conn
            .query_row(
                "SELECT rel_path FROM track_stems WHERE track_id = ?1 AND stem = ?2 AND model = ?3",
                params![track_id, stem, model],
                |r| r.get(0),
            )
            .ok()?;
        let _ = conn.execute(
            "UPDATE track_stems SET used_at = ?4 WHERE track_id = ?1 AND stem = ?2 AND model = ?3",
            params![track_id, stem, model, now_ms()],
        );
        Some(path)
    }

    /// Total bytes held by the stem cache, for the budget.
    pub fn stems_bytes(&self) -> i64 {
        self.lock()
            .query_row("SELECT COALESCE(SUM(bytes),0) FROM track_stems", [], |r| r.get(0))
            .unwrap_or(0)
    }

    /// The coldest track's stems, for eviction. All of a track's stems go
    /// together: three quarters of a kit is not a kit.
    pub fn coldest_stem_track(&self) -> Option<(i64, Vec<String>)> {
        let conn = self.lock();
        let track_id: i64 = conn
            .query_row(
                "SELECT track_id FROM track_stems GROUP BY track_id
                  ORDER BY MAX(used_at) ASC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok()?;
        let mut paths = Vec::new();
        if let Ok(mut stmt) =
            conn.prepare("SELECT rel_path FROM track_stems WHERE track_id = ?1")
        {
            if let Ok(iter) = stmt.query_map(params![track_id], |r| r.get::<_, String>(0)) {
                paths = iter.filter_map(Result::ok).collect();
            }
        }
        Some((track_id, paths))
    }

    // --- the operator's own switches ------------------------------------------

    /// A server-wide setting, or None if it has never been set.
    ///
    /// None is meaningful: it means "nobody has chosen", which is what lets an
    /// environment variable still act as the default for an operator who set one
    /// before this table existed.
    /// A book's transcript, or None when nobody has made one.
    ///
    /// Deliberately NOT part of any library payload: this is fetched for one
    /// book at the moment somebody opens it. A transcript is the largest thing
    /// this database holds per row, and the library listing is the one request
    /// every device makes constantly.
    pub fn transcript(&self, track_id: i64) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT lines FROM transcripts WHERE track_id = ?1",
                params![track_id],
                |r| r.get(0),
            )
            .ok()
    }

    pub fn set_transcript(&self, track_id: i64, lines: &str, model: &str) -> rusqlite::Result<()> {
        self.index_spoken(track_id, lines);
        self.lock().execute(
            "INSERT INTO transcripts (track_id, lines, model, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(track_id) DO UPDATE SET lines = ?2, model = ?3, created_at = ?4",
            params![track_id, lines, model, now_ms()],
        )?;
        Ok(())
    }

    /// Whether a book already has one, without paying to read it back.
    /// Every stored chapter note for a set of tracks - one book's worth.
    pub fn chapter_blurbs(&self, track_ids: &[i64]) -> Vec<(i64, i64, String, String)> {
        if track_ids.is_empty() {
            return Vec::new();
        }
        let marks = std::iter::repeat("?")
            .take(track_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT track_id, idx, name, blurb FROM chapter_blurbs
             WHERE track_id IN ({marks}) ORDER BY track_id, idx"
        );
        let lock = self.lock();
        let mut stmt = match lock.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(rusqlite::params_from_iter(track_ids.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        });
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    pub fn set_chapter_blurb(
        &self,
        track_id: i64,
        idx: i64,
        name: &str,
        blurb: &str,
        model: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO chapter_blurbs (track_id, idx, name, blurb, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(track_id, idx) DO UPDATE SET
               name = excluded.name, blurb = excluded.blurb,
               model = excluded.model, created_at = excluded.created_at",
            params![track_id, idx, name, blurb, model, now_ms() / 1000],
        )?;
        Ok(())
    }

    pub fn clear_chapter_blurbs(&self, track_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM chapter_blurbs WHERE track_id = ?1",
            params![track_id],
        )?;
        Ok(())
    }

    /// How many notes a track holds - enough to tell "done" from "not started"
    /// against the chapter count the caller knows.
    pub fn chapter_blurb_count(&self, track_id: i64) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM chapter_blurbs WHERE track_id = ?1",
                params![track_id],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    // --- Canvas ------------------------------------------------------------

    /// Whether this track has been looked up and found to have no Canvas, and
    /// how long ago. `None` means never asked.
    pub fn canvas_miss_age(&self, track_id: i64, now: i64) -> Option<i64> {
        self.lock()
            .query_row(
                "SELECT checked_at FROM canvas_misses WHERE track_id = ?1",
                params![track_id],
                |r| r.get::<_, i64>(0),
            )
            .ok()
            .map(|at| now - at)
    }

    pub fn mark_canvas_miss(&self, track_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO canvas_misses (track_id, checked_at) VALUES (?1, ?2)
             ON CONFLICT(track_id) DO UPDATE SET checked_at = excluded.checked_at",
            params![track_id, now_ms()],
        )?;
        Ok(())
    }

    /// A clip arrived after all; the track is no longer a known miss.
    pub fn clear_canvas_miss(&self, track_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM canvas_misses WHERE track_id = ?1",
            params![track_id],
        )?;
        Ok(())
    }

    /// Forget every recorded miss, so the sweep asks about all of them again.
    /// The kept clips are untouched - only the noes are worth re-asking.
    /// Whether a live track already answers to this name - the check that keeps
    /// a spoken brief from downloading a song the library already holds. Loose
    /// on case, strict on words: the same normalisation the client's search
    /// would forgive is not applied here, because a false "yes" silently eats a
    /// wanted download while a false "no" merely costs one duplicate the
    /// importer's own dedupe then catches.
    pub fn has_title_artist(&self, title: &str, artist: &str) -> bool {
        self.lock()
            .query_row(
                "SELECT 1 FROM tracks
                 WHERE deleted = 0 AND title = ?1 COLLATE NOCASE AND artist = ?2 COLLATE NOCASE
                 LIMIT 1",
                params![title, artist],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    pub fn forget_canvas_misses(&self) -> rusqlite::Result<usize> {
        self.lock().execute("DELETE FROM canvas_misses", [])
    }

    /// Songs worth asking Spotify about, most recently listened first.
    ///
    /// Recency first because a sweep over a big library takes hours and the
    /// songs somebody actually plays are the ones whose cards get looked at.
    /// Known misses younger than `retry_after_ms` are left out; the rest come
    /// back so a Canvas released since is eventually found.
    pub fn tracks_wanting_canvas(&self, limit: i64, retry_after_ms: i64) -> Vec<(i64, String, String)> {
        let cutoff = now_ms() - retry_after_ms;
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id, t.title, t.artist
               FROM tracks t
               LEFT JOIN canvas_misses m ON m.track_id = t.id
               LEFT JOIN (SELECT track_id, MAX(updated_at) AS seen
                            FROM play_state GROUP BY track_id) p ON p.track_id = t.id
              WHERE t.deleted = 0 AND t.kind = 'music'
                AND t.title <> '' AND t.artist <> ''
                AND (m.track_id IS NULL OR m.checked_at < ?2)
              ORDER BY COALESCE(p.seen, 0) DESC, t.id DESC
              LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit, cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    // --- The catch-up ------------------------------------------------------

    /// Every stored recap part for a set of tracks, in reading order:
    /// `(track_id, idx, start_ms, end_ms, summary)`.
    pub fn recap_parts(&self, track_ids: &[i64]) -> Vec<(i64, i64, i64, i64, String)> {
        if track_ids.is_empty() {
            return Vec::new();
        }
        let marks = std::iter::repeat("?")
            .take(track_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT track_id, idx, start_ms, end_ms, summary FROM book_recap_parts
             WHERE track_id IN ({marks}) ORDER BY track_id, idx"
        );
        let lock = self.lock();
        let mut stmt = match lock.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(rusqlite::params_from_iter(track_ids.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        });
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    pub fn set_recap_part(
        &self,
        track_id: i64,
        idx: i64,
        start_ms: i64,
        end_ms: i64,
        summary: &str,
        model: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO book_recap_parts (track_id, idx, start_ms, end_ms, summary, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(track_id, idx) DO UPDATE SET
               start_ms = excluded.start_ms, end_ms = excluded.end_ms,
               summary = excluded.summary, model = excluded.model,
               created_at = excluded.created_at",
            params![track_id, idx, start_ms, end_ms, summary, model, now_ms()],
        )?;
        Ok(())
    }

    /// Thrown away when a book is re-transcribed: the parts were read off the
    /// old text and a recap assembled from both would be neither.
    pub fn clear_recap_parts(&self, track_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM book_recap_parts WHERE track_id = ?1",
            params![track_id],
        )?;
        Ok(())
    }

    /// The stored catch-up for one reader and one book file:
    /// `(upto_ms, parts, body, created_at)`.
    pub fn book_recap(&self, user_id: i64, track_id: i64) -> Option<(i64, i64, String, i64)> {
        self.lock()
            .query_row(
                "SELECT upto_ms, parts, body, created_at FROM book_recaps
                 WHERE user_id = ?1 AND track_id = ?2",
                params![user_id, track_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok()
    }

    pub fn set_book_recap(
        &self,
        user_id: i64,
        track_id: i64,
        upto_ms: i64,
        parts: i64,
        body: &str,
        model: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO book_recaps (user_id, track_id, upto_ms, parts, body, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(user_id, track_id) DO UPDATE SET
               upto_ms = excluded.upto_ms, parts = excluded.parts,
               body = excluded.body, model = excluded.model,
               created_at = excluded.created_at",
            params![user_id, track_id, upto_ms, parts, body, model, now_ms()],
        )?;
        Ok(())
    }

    /// Where this reader stopped in one track, if they ever started it.
    pub fn play_state(&self, user_id: i64, track_id: i64) -> Option<i64> {
        self.lock()
            .query_row(
                "SELECT position_ms FROM play_state WHERE user_id = ?1 AND track_id = ?2",
                params![user_id, track_id],
                |r| r.get(0),
            )
            .ok()
    }

    pub fn lyric_words(&self, track_id: i64) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT lines FROM lyric_words WHERE track_id = ?1",
                params![track_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Forget the word clocks for one song, or for every song.
    ///
    /// The sweep only ever offers a song it has NO words for, which is right
    /// while it is working through a library for the first time and wrong
    /// afterwards: a song aligned by an older pass, or against a lyric sheet
    /// that has since been corrected, is never looked at again. This is how a
    /// listener says "that one is wrong, do it properly".
    ///
    /// Only the derived clocks go. The lyrics themselves are the source and are
    /// left alone - throwing those away would mean fetching them again to redo
    /// work that is only about their timing.
    /// Has this song been asked for a better answer than the one it has?
    pub fn lyrics_stale(&self, track_id: i64) -> bool {
        self.lock()
            .query_row(
                "SELECT 1 FROM lyric_stale WHERE track_id = ?1",
                params![track_id],
                |_| Ok(()),
            )
            .is_ok()
    }

    pub fn mark_lyrics_stale(&self, track_id: Option<i64>) -> usize {
        let lock = self.lock();
        let done = match track_id {
            Some(id) => lock.execute(
                "INSERT OR REPLACE INTO lyric_stale (track_id, asked_at) VALUES (?1, ?2)",
                params![id, now_ms()],
            ),
            // Every song that HAS clocks, so a whole-library re-time is a
            // queue rather than a demolition.
            None => lock.execute(
                "INSERT OR REPLACE INTO lyric_stale (track_id, asked_at)
                 SELECT track_id, ?1 FROM lyric_words",
                params![now_ms()],
            ),
        };
        done.unwrap_or(0)
    }

    pub fn set_lyric_words(
        &self,
        track_id: i64,
        lines: &str,
        matched: i64,
        words: i64,
    ) -> rusqlite::Result<()> {
        self.index_spoken(track_id, lines);
        // Answered, so it is no longer owed one.
        let _ = self
            .lock()
            .execute("DELETE FROM lyric_stale WHERE track_id = ?1", params![track_id]);
        self.lock().execute(
            "INSERT INTO lyric_words (track_id, lines, matched, words, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(track_id) DO UPDATE SET
               lines = excluded.lines, matched = excluded.matched,
               words = excluded.words, created_at = excluded.created_at",
            params![track_id, lines, matched, words, now_ms() / 1000],
        )?;
        Ok(())
    }

    /// The cached shape of a reading, if it has been worked out.
    pub fn book_shape(&self, track_id: i64) -> Option<crate::bookshape::BookShape> {
        self.lock()
            .query_row(
                "SELECT wpm, pace, opening_ms, credits_ms, opening_text, credits_text, words
                 FROM book_shape WHERE track_id = ?1",
                params![track_id],
                |r| {
                    Ok(crate::bookshape::BookShape {
                        wpm: r.get(0)?,
                        pace: r.get(1)?,
                        opening_ms: r.get(2)?,
                        credits_ms: r.get(3)?,
                        opening_text: r.get(4)?,
                        credits_text: r.get(5)?,
                        words: r.get(6)?,
                    })
                },
            )
            .ok()
    }

    pub fn set_book_shape(
        &self,
        track_id: i64,
        shape: &crate::bookshape::BookShape,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO book_shape
               (track_id, wpm, pace, opening_ms, credits_ms, opening_text, credits_text, words, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(track_id) DO UPDATE SET
               wpm = excluded.wpm, pace = excluded.pace,
               opening_ms = excluded.opening_ms, credits_ms = excluded.credits_ms,
               opening_text = excluded.opening_text, credits_text = excluded.credits_text,
               words = excluded.words, created_at = excluded.created_at",
            params![
                track_id,
                shape.wpm,
                shape.pace,
                shape.opening_ms,
                shape.credits_ms,
                shape.opening_text,
                shape.credits_text,
                shape.words,
                now_ms() / 1000,
            ],
        )?;
        Ok(())
    }

    /// Whether anything is being imported right now - the sweep stands down
    /// rather than compete with work somebody is waiting on.
    pub fn imports_busy_hint(&self) -> bool {
        false
    }

    /// Replace one track's lines in the spoken index.
    ///
    /// Called wherever a transcript or a lyric body is written, so the index
    /// never drifts from the text it indexes. Deleting first makes it
    /// idempotent - re-transcribing a book replaces its words rather than
    /// doubling them.
    pub fn index_spoken(&self, track_id: i64, body: &str) {
        let lines = crate::spoken::lines_of(body);
        let lock = self.lock();
        let _ = lock.execute("DELETE FROM spoken_fts WHERE track_id = ?1", params![track_id]);
        let Ok(mut stmt) =
            lock.prepare("INSERT INTO spoken_fts (text, track_id, start_ms) VALUES (?1, ?2, ?3)")
        else {
            return;
        };
        for (at, text) in lines {
            let _ = stmt.execute(params![text, track_id, at]);
        }
    }

    /// Rebuild the whole index from the transcripts and lyric bodies on disk.
    /// Returns how many lines it holds afterwards.
    pub fn reindex_spoken(&self) -> i64 {
        let bodies: Vec<(i64, String)> = {
            let lock = self.lock();
            let mut all = Vec::new();
            for sql in [
                "SELECT track_id, lines FROM transcripts",
                "SELECT track_id, lines FROM lyric_words",
            ] {
                if let Ok(mut stmt) = lock.prepare(sql) {
                    if let Ok(rows) = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))) {
                        all.extend(rows.flatten());
                    }
                }
            }
            all
        };
        {
            let lock = self.lock();
            let _ = lock.execute("DELETE FROM spoken_fts", []);
        }
        for (id, body) in bodies {
            self.index_spoken(id, &body);
        }
        self.lock()
            .query_row("SELECT COUNT(*) FROM spoken_fts", [], |r| r.get(0))
            .unwrap_or(0)
    }

    /// Lines that say this, best first. `kind` narrows to books or songs.
    pub fn search_spoken(&self, query: &str, limit: usize, kind: &str) -> Vec<crate::spoken::Line> {
        // FTS5 takes a query language; a listener types a sentence. Quoting
        // each word and joining them makes "the winding key" a phrase-ish AND
        // rather than a syntax error on an apostrophe.
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|w| {
                let clean: String = w.chars().filter(|c| c.is_alphanumeric() || *c == '\'').collect();
                format!("\"{}\"", clean.replace('\'', ""))
            })
            .filter(|t| t.len() > 2)
            .collect();
        if terms.is_empty() {
            return Vec::new();
        }
        let expr = terms.join(" ");
        let narrow = match kind {
            "books" => " AND t.kind = 'book'",
            "songs" => " AND t.kind <> 'book'",
            _ => "",
        };
        let sql = format!(
            "SELECT f.track_id, f.start_ms, f.text
             FROM spoken_fts f JOIN tracks t ON t.id = f.track_id
             WHERE spoken_fts MATCH ?1 AND t.deleted = 0{narrow}
             ORDER BY bm25(spoken_fts), f.start_ms
             LIMIT ?2"
        );
        let lock = self.lock();
        let Ok(mut stmt) = lock.prepare(&sql) else { return Vec::new() };
        let rows = stmt.query_map(params![expr, limit as i64], |r| {
            Ok(crate::spoken::Line { track_id: r.get(0)?, start_ms: r.get(1)?, text: r.get(2)? })
        });
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    pub fn tracks_with_lyric_words(&self) -> Vec<i64> {
        let lock = self.lock();
        let Ok(mut stmt) = lock.prepare("SELECT track_id FROM lyric_words ORDER BY track_id") else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| r.get(0));
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    /// Keep the indexed row in step with a tag this server just rewrote.
    pub fn set_track_lyrics(&self, track_id: i64, lyrics: &str) -> rusqlite::Result<()> {
        self.lock()
            .execute("UPDATE tracks SET lyrics = ?2 WHERE id = ?1", params![track_id, lyrics])?;
        Ok(())
    }

    /// Songs waiting for their words to be timed, LIKED FIRST.
    ///
    /// The order IS the feature: this costs minutes of the box per song and a
    /// library is thousands of them, so anything anybody has hearted comes
    /// first, then what has actually been played (most-played first), and
    /// nothing else at all - an unplayed, unloved track can wait for somebody
    /// to want it. Books are excluded: their words come from the transcriber.
    pub fn songs_wanting_lyric_words(&self, limit: i64) -> Vec<i64> {
        let lock = self.lock();
        let mut stmt = match lock.prepare(
            "SELECT t.id FROM tracks t
             LEFT JOIN lyric_words lw ON lw.track_id = t.id
             LEFT JOIN favorites f    ON f.track_id  = t.id
             LEFT JOIN (SELECT track_id, COUNT(*) AS plays FROM plays GROUP BY track_id) p
                    ON p.track_id = t.id
             LEFT JOIN lyric_stale st ON st.track_id = t.id
             WHERE t.deleted = 0 AND t.kind <> 'book'
               AND (lw.track_id IS NULL OR st.track_id IS NOT NULL)
               AND (f.track_id IS NOT NULL OR p.plays > 0)
             ORDER BY (f.track_id IS NOT NULL) DESC, COALESCE(p.plays, 0) DESC, t.id
             LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![limit], |r| r.get(0));
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    /// Transcribed books whose lines carry no per-word clocks - the ones a
    /// word-level re-run would improve. The LIKE probe is crude but honest:
    /// `"words"` appears in every worded line and in nothing else the old
    /// shape could hold.
    pub fn transcripts_without_words(&self) -> Vec<i64> {
        let lock = self.lock();
        let mut stmt = match lock.prepare(
            "SELECT t.id FROM transcripts tr JOIN tracks t ON t.id = tr.track_id
             WHERE t.deleted = 0 AND t.kind = 'book'
               AND tr.lines NOT LIKE '%\"words\"%'
             ORDER BY t.id",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |r| r.get(0));
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    /// Transcribed book tracks, for the blurb sweep to consider.
    pub fn transcribed_track_ids(&self) -> Vec<i64> {
        let lock = self.lock();
        let mut stmt = match lock.prepare(
            "SELECT t.id FROM transcripts tr JOIN tracks t ON t.id = tr.track_id
             WHERE t.deleted = 0 AND t.kind = 'book' ORDER BY t.id",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |r| r.get(0));
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    /// Every live track in the same folder as this one - the BOOK, under the
    /// folder contract: a book is its directory.
    pub fn book_siblings(&self, track_id: i64) -> Vec<(i64, String)> {
        let Some(rel) = self.track_rel_path(track_id) else {
            return Vec::new();
        };
        let dir = match rel.rfind('/') {
            Some(i) => &rel[..i + 1],
            None => "",
        };
        let lock = self.lock();
        let mut stmt = match lock.prepare(
            "SELECT id, rel_path FROM tracks
             WHERE deleted = 0 AND kind = 'book' AND rel_path LIKE ?1 || '%'
               AND rel_path NOT LIKE ?1 || '%/%'
             ORDER BY rel_path",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![dir], |r| Ok((r.get(0)?, r.get(1)?)));
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    /// Transcribed but never analysed - the backfill's work list.
    pub fn tracks_needing_shape(&self, limit: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.track_id FROM transcripts t
             LEFT JOIN book_shape s ON s.track_id = t.track_id
             WHERE s.track_id IS NULL LIMIT ?1",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![limit], |r| r.get(0));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    }

    pub fn has_transcript(&self, track_id: i64) -> bool {
        self.lock()
            .query_row(
                "SELECT 1 FROM transcripts WHERE track_id = ?1",
                params![track_id],
                |_| Ok(()),
            )
            .is_ok()
    }

    pub fn server_pref(&self, key: &str) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT value FROM server_prefs WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .ok()
    }

    pub fn set_server_pref(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO server_prefs (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Forget an operator's choice, so the environment decides again.
    pub fn clear_server_pref(&self, key: &str) -> rusqlite::Result<()> {
        self.lock()
            .execute("DELETE FROM server_prefs WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Every operator choice under a prefix, for loading the AI overlay at boot
    /// in one query rather than one per key.
    pub fn server_prefs_under(&self, prefix: &str) -> Vec<(String, String)> {
        let conn = self.lock();
        let Ok(mut stmt) =
            conn.prepare("SELECT key, value FROM server_prefs WHERE key LIKE ?1 || '%'")
        else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![prefix], |r| Ok((r.get(0)?, r.get(1)?)));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    }

    // --- what the machinery has been doing ------------------------------------

    /// Write one activity row and return its id.
    ///
    /// Infallible by design: this is a side channel about work, and a failure
    /// to describe the work must never fail the work. Callers are loops that
    /// have no sensible way to handle an error from a log line.
    pub fn record_activity(&self, ev: NewActivity<'_>) -> i64 {
        let conn = self.lock();
        let done = conn.execute(
            "INSERT INTO activity_events (at, source, kind, state, key, title, body, track_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                now_ms() / 1000,
                ev.source,
                ev.kind,
                ev.state,
                ev.key,
                ev.title,
                ev.body,
                ev.track_id,
                ev.detail,
            ],
        );
        if done.is_err() {
            return 0;
        }
        let id = conn.last_insert_rowid();
        // Bounded, and trimmed here rather than on a timer: the only thing that
        // grows this table is a write, so the only moment it can need trimming
        // is just after one. The margin stops a busy loop re-trimming on every
        // single row.
        if id % 200 == 0 {
            let _ = conn.execute(
                "DELETE FROM activity_events WHERE id <= ?1",
                params![id - ACTIVITY_KEEP],
            );
        }
        id
    }

    /// Events after `since` (exclusive), oldest first, plus the newest id that
    /// exists at all - which is how a caller that asked for a bounded page still
    /// learns where the end is.
    pub fn activity_since(&self, since: i64, limit: i64) -> (Vec<ActivityRow>, i64) {
        let conn = self.lock();
        let latest: i64 = conn
            .query_row("SELECT COALESCE(MAX(id), 0) FROM activity_events", [], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        // `since` of 0 means "the most recent page", which is a SEED for a
        // watcher rather than a week of history to announce. Newest-first from
        // the end, then flipped, so the page is the last N and not the first N.
        let (sql, newest_first) = if since <= 0 {
            (
                "SELECT id, at, source, kind, state, key, title, body, track_id, detail
                 FROM activity_events ORDER BY id DESC LIMIT ?2",
                true,
            )
        } else {
            (
                "SELECT id, at, source, kind, state, key, title, body, track_id, detail
                 FROM activity_events WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
                false,
            )
        };
        let Ok(mut stmt) = conn.prepare(sql) else {
            return (Vec::new(), latest);
        };
        let rows = stmt.query_map(params![since, limit.clamp(1, 200)], |r| {
            Ok(ActivityRow {
                id: r.get(0)?,
                at: r.get(1)?,
                source: r.get(2)?,
                kind: r.get(3)?,
                state: r.get(4)?,
                key: r.get(5)?,
                title: r.get(6)?,
                body: r.get(7)?,
                track_id: r.get(8)?,
                detail: r.get(9)?,
            })
        });
        let mut out: Vec<ActivityRow> = rows.map(|r| r.flatten().collect()).unwrap_or_default();
        if newest_first {
            out.reverse();
        }
        (out, latest)
    }

    /// The newest events from one source, newest first - what the Local AI pane
    /// shows without pulling the whole feed.
    /// One page of a source's events, newest first, ending just before `before`.
    ///
    /// A CURSOR, not an offset. The table is appended to constantly - a
    /// separation finishing while somebody reads page two would shift every
    /// numbered page under them and show a row twice or not at all. Paging by
    /// "older than this id" is stable against writes by construction, which is
    /// the only kind of paging worth putting on a live log.
    ///
    /// `before` of 0 means "from the newest".
    pub fn activity_from(&self, source: &str, before: i64, limit: i64) -> Vec<ActivityRow> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, at, source, kind, state, key, title, body, track_id, detail
             FROM activity_events
             WHERE source = ?1 AND (?2 <= 0 OR id < ?2)
             ORDER BY id DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![source, before, limit.clamp(1, 200)], |r| {
            Ok(ActivityRow {
                id: r.get(0)?,
                at: r.get(1)?,
                source: r.get(2)?,
                kind: r.get(3)?,
                state: r.get(4)?,
                key: r.get(5)?,
                title: r.get(6)?,
                body: r.get(7)?,
                track_id: r.get(8)?,
                detail: r.get(9)?,
            })
        });
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    }

    // --- separating ahead of being asked -------------------------------------

    /// Songs worth separating before anyone opens them, best first.
    ///
    /// Liked before playlisted, then most recently added. The order is what
    /// makes an over-budget library behave: enqueueing stops part-way down, so
    /// what fits is what somebody is most likely to open rather than whatever
    /// happened to sort first.
    ///
    /// Excluded: already separated, already queued by a person, and - the brake
    /// that matters - anything evicted inside its cooldown.
    pub fn prefetch_candidates(
        &self,
        model: &str,
        now: i64,
        limit: i64,
        include_liked: bool,
    ) -> Vec<(i64, String)> {
        let conn = self.lock();
        let Ok(mut q) = conn.prepare(
            "SELECT t.id,
                    CASE WHEN ?4 = 1 AND EXISTS (SELECT 1 FROM favorites f WHERE f.track_id = t.id)
                         THEN 'liked' ELSE 'playlist' END AS reason
               FROM tracks t
              WHERE t.deleted = 0
                -- OPT-IN ONLY. This used to read 'liked OR in any playlist at
                -- all', which is every song anybody ever filed anywhere - the
                -- reason the stem cache outgrew the disk it lives on. A list
                -- now has to ask, and Liked asks through its own switch.
                AND ((?4 = 1 AND EXISTS (SELECT 1 FROM favorites f WHERE f.track_id = t.id))
                  OR EXISTS (SELECT 1 FROM playlist_tracks pt
                               JOIN playlists p ON p.id = pt.playlist_id
                              WHERE pt.track_id = t.id AND p.auto_stem = 1))
                AND NOT EXISTS (SELECT 1 FROM track_stems s
                                 WHERE s.track_id = t.id AND s.model = ?1)
                AND NOT EXISTS (SELECT 1 FROM stem_jobs j
                                 WHERE j.track_id = t.id AND j.state IN ('queued','running'))
                AND NOT EXISTS (SELECT 1 FROM stem_prefetch p
                                 WHERE p.track_id = t.id
                                   AND (p.state IN ('failed','running','done')
                                        OR p.cooldown_until > ?2))
              ORDER BY reason = 'liked' DESC, t.added_at DESC
              LIMIT ?3",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = q.query_map(params![model, now, limit, include_liked as i64], |r| {
            Ok((r.get(0)?, r.get(1)?))
        }) else {
            return Vec::new();
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    /// Every separated track that nothing asks to keep, with the files to
    /// delete. The keep set is exactly what the prefetcher would maintain:
    /// Liked when its switch is on, plus the lists that opted in. Anything
    /// else is a leftover of the old separate-everything rule.
    pub fn stems_outside_keep(&self, keep_liked: bool) -> Vec<(i64, Vec<String>)> {
        let conn = self.lock();
        let Ok(mut q) = conn.prepare(
            "SELECT s.track_id, s.rel_path FROM track_stems s
              WHERE NOT (?1 = 1 AND EXISTS
                    (SELECT 1 FROM favorites f WHERE f.track_id = s.track_id))
                AND NOT EXISTS (SELECT 1 FROM playlist_tracks pt
                                  JOIN playlists p ON p.id = pt.playlist_id
                                 WHERE pt.track_id = s.track_id AND p.auto_stem = 1)
              ORDER BY s.track_id",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = q.query_map(params![keep_liked as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        }) else {
            return Vec::new();
        };
        let mut out: Vec<(i64, Vec<String>)> = Vec::new();
        for (id, rel) in rows.filter_map(|r| r.ok()) {
            match out.last_mut() {
                Some((last, paths)) if *last == id => paths.push(rel),
                _ => out.push((id, vec![rel])),
            }
        }
        out
    }

    /// What a set of tracks' separations weigh, for a prune to report before
    /// it deletes anything.
    pub fn stems_bytes_for(&self, track_ids: &[i64]) -> i64 {
        if track_ids.is_empty() {
            return 0;
        }
        let conn = self.lock();
        let list = track_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        conn.query_row(
            &format!("SELECT COALESCE(SUM(bytes), 0) FROM track_stems WHERE track_id IN ({list})"),
            [],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Turn separating-ahead on or off for one list.
    pub fn set_playlist_auto_stem(&self, playlist_id: i64, on: bool) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE playlists SET auto_stem = ?2, updated_at = ?3 WHERE id = ?1",
            params![playlist_id, on as i64, now_ms()],
        )?;
        Ok(())
    }

    /// Marks a song as wanted, without disturbing one that already finished.
    pub fn want_prefetch(&self, track_id: i64, reason: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO stem_prefetch (track_id, state, reason, queued_at)
             VALUES (?1, 'wanted', ?2, ?3)
             ON CONFLICT(track_id) DO UPDATE SET
               state = 'wanted', reason = excluded.reason, queued_at = excluded.queued_at",
            params![track_id, reason, now_ms()],
        )?;
        Ok(())
    }

    /// The oldest song wanted but not yet started.
    pub fn next_prefetch_job(&self) -> Option<(i64, String)> {
        self.lock()
            .query_row(
                "SELECT p.track_id, t.rel_path FROM stem_prefetch p
                   JOIN tracks t ON t.id = p.track_id
                  WHERE p.state = 'wanted' AND t.deleted = 0
                  ORDER BY p.queued_at ASC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
    }

    /// Moves a prefetch on. Three failures and it is left alone for good: a file
    /// demucs cannot read will not become readable by being retried nightly.
    pub fn mark_prefetch(&self, track_id: i64, state: &str, error: &str) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE stem_prefetch
                SET state = ?2, error = ?3, finished_at = ?4,
                    attempts = attempts + CASE WHEN ?2 = 'running' THEN 1 ELSE 0 END
              WHERE track_id = ?1",
            params![track_id, state, error, now_ms()],
        )?;
        conn.execute(
            "UPDATE stem_prefetch SET state = 'failed'
              WHERE track_id = ?1 AND attempts >= 3 AND state != 'done'",
            params![track_id],
        )?;
        Ok(())
    }

    /// Remembers that the cache threw a song's stems away.
    ///
    /// forget_stems() erases every other trace, so without this the next pass
    /// cannot tell an evicted song from a new one and re-queues it at once -
    /// which on a library bigger than the cache never ends.
    pub fn note_stem_eviction(&self, track_id: i64, cooldown_ms: i64) -> rusqlite::Result<()> {
        let now = now_ms();
        self.lock().execute(
            "INSERT INTO stem_prefetch (track_id, state, reason, queued_at, finished_at, cooldown_until)
             VALUES (?1, 'evicted', 'evicted', ?2, ?2, ?3)
             ON CONFLICT(track_id) DO UPDATE SET
               state = 'evicted', finished_at = ?2, cooldown_until = ?3",
            params![track_id, now, now + cooldown_ms],
        )?;
        Ok(())
    }

    /// Bytes held by stems this prefetcher made, so it can stop at its own
    /// ceiling rather than at the cache's.
    pub fn prefetch_bytes(&self, model: &str) -> i64 {
        self.lock()
            .query_row(
                "SELECT COALESCE(SUM(s.bytes), 0) FROM track_stems s
                   JOIN stem_prefetch p ON p.track_id = s.track_id
                  WHERE s.model = ?1 AND p.state = 'done'",
                params![model],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// (wanted, done, failed, evicted), for the readout.
    /// Every song this is ultimately trying to separate: liked or playlisted,
    /// not deleted.
    ///
    /// The counts in `prefetch_summary` are the QUEUE's view - what has been
    /// enqueued so far - and the queue is filled a batch at a time, so on a big
    /// library "wanted" is a few dozen however much is really left. That reads
    /// as nearly finished while thousands wait. This is the denominator that
    /// makes the readout honest.
    pub fn prefetch_total(&self, model: &str) -> (i64, i64) {
        let conn = self.lock();
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tracks t
                  WHERE t.deleted = 0
                    AND (EXISTS (SELECT 1 FROM favorites f WHERE f.track_id = t.id)
                      OR EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id))",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        // Separated is counted against the SAME set, not against every stem on
        // disk: a song separated because somebody asked for it, and which is
        // neither liked nor in a list, is not progress toward this job.
        let separated: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tracks t
                  WHERE t.deleted = 0
                    AND (EXISTS (SELECT 1 FROM favorites f WHERE f.track_id = t.id)
                      OR EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id))
                    AND EXISTS (SELECT 1 FROM track_stems s
                                 WHERE s.track_id = t.id AND s.model = ?1)",
                params![model],
                |r| r.get(0),
            )
            .unwrap_or(0);
        (separated, total)
    }

    /// A track's title and artist, for naming the one being worked on.
    pub fn track_label(&self, track_id: i64) -> Option<(String, String)> {
        self.lock()
            .query_row(
                "SELECT title, artist FROM tracks WHERE id = ?1",
                params![track_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
    }

    pub fn prefetch_summary(&self) -> (i64, i64, i64, i64) {
        let conn = self.lock();
        let n = |state: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM stem_prefetch WHERE state = ?1",
                params![state],
                |r| r.get(0),
            )
            .unwrap_or(0)
        };
        (n("wanted"), n("done"), n("failed"), n("evicted"))
    }

    /// Every separated part the index believes in: track, and where it says the
    /// file is. For checking that claim against the disk.
    pub fn all_stem_paths(&self) -> Vec<(i64, String)> {
        let conn = self.lock();
        let mut stmt = match conn.prepare("SELECT track_id, rel_path FROM track_stems") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Let a song be separated again after its parts turned out to be gone.
    ///
    /// `stem_prefetch` is deliberately the one table eviction does not touch,
    /// so a song thrown out under budget pressure is not fetched again forever.
    /// A song whose files VANISHED is a different fact: nothing chose to drop
    /// it, the index simply stopped being true. Clearing the memory is what
    /// lets the prefetcher pick it up again.
    pub fn rearm_stem_prefetch(&self, track_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM stem_prefetch WHERE track_id = ?1",
            params![track_id],
        )?;
        Ok(())
    }

    pub fn forget_stems(&self, track_id: i64) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM track_stems WHERE track_id = ?1", params![track_id])?;
        conn.execute("DELETE FROM stem_jobs WHERE track_id = ?1", params![track_id])?;
        Ok(())
    }

    /// One track's measured loudness. Replaces any earlier reading: a
    /// re-measure happens because the file changed, and the new number is the
    /// true one.
    pub fn save_loudness(
        &self,
        track_id: i64,
        lufs: f64,
        peak_db: f64,
        lra: f64,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO track_loudness (track_id, lufs, peak_db, lra, measured_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(track_id) DO UPDATE SET
               lufs = excluded.lufs, peak_db = excluded.peak_db,
               lra = excluded.lra, measured_at = excluded.measured_at",
            params![track_id, lufs, peak_db, lra, now_ms()],
        )?;
        Ok(())
    }

    /// One track's drawn shape. Replaces any earlier one, for the same reason
    /// the loudness does: a re-measure means the file changed.
    pub fn save_waveform(&self, track_id: i64, columns: &[u8]) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO track_waveform (track_id, columns, made_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(track_id) DO UPDATE SET
               columns = excluded.columns, made_at = excluded.made_at",
            params![track_id, columns, now_ms()],
        )?;
        Ok(())
    }

    /// One track's shape, or None where the sweep has not reached it.
    pub fn waveform(&self, track_id: i64) -> Option<Vec<u8>> {
        let conn = self.lock();
        conn.query_row(
            "SELECT columns FROM track_waveform WHERE track_id = ?1",
            params![track_id],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .ok()
    }

    /// Live tracks the analyser still owes something, oldest-added first so a
    /// library that has been sitting there is served before today's imports.
    /// Books are skipped: nobody normalises a chapter against a song.
    ///
    /// "Something" is loudness OR a drawn shape. One ffmpeg pass produces
    /// both, so they are asked for together - and the OR is what backfills a
    /// library that was fully measured before shapes existed, without a
    /// migration and without a second sweep to maintain.
    pub fn tracks_needing_loudness(&self, limit: i64) -> Vec<(i64, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id, t.rel_path FROM tracks t
              LEFT JOIN track_loudness l ON l.track_id = t.id
              LEFT JOIN track_waveform w ON w.track_id = t.id
              WHERE t.deleted = 0 AND t.kind = 'music'
                AND (l.track_id IS NULL OR w.track_id IS NULL)
              ORDER BY t.added_at ASC LIMIT ?1",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![limit], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every known tempo, for a client that needs a beat grid. Same compact
    /// shape as the loudness table and for the same reason: the caller holds
    /// it all and consults it per track.
    pub fn all_bpm(&self) -> Vec<(i64, f64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT f.track_id, f.bpm FROM track_features f
               JOIN tracks t ON t.id = f.track_id
              WHERE f.bpm IS NOT NULL AND f.bpm > 0 AND t.deleted = 0",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every measurement, for the client's normalisation table. Compact by
    /// design - one row per track, four numbers - because the client holds the
    /// whole thing in memory and consults it on every track change.
    pub fn all_loudness(&self) -> Vec<(i64, f64, f64, f64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT l.track_id, l.lufs, l.peak_db, l.lra FROM track_loudness l
               JOIN tracks t ON t.id = l.track_id
              WHERE t.deleted = 0",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

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
        /*
         * UPSERT, not INSERT. curator_pulls is UNIQUE(user_id, ext_id), so a
         * retry of an aged-out failure cannot "record a fresh row" - a plain
         * INSERT errors, both callers swallow the error, and the two halves
         * of the retry break differently: the still-missing branch re-fails
         * the OLD row without touching created_at (so it never re-blocks and
         * retries every cycle forever), and the success branch imports a job
         * no 'queued' row tracks (so it bypasses audition and the budget).
         * Re-arming the existing row - state back to queued, fresh clock,
         * fresh job - is what a retry actually means here.
         */
        conn.execute(
            "INSERT INTO curator_pulls (user_id, ext_id, kind, title, artist, url, reason, score, job_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(user_id, ext_id) DO UPDATE SET
               state = 'queued', job_id = excluded.job_id, url = excluded.url,
               reason = excluded.reason, score = excluded.score, bytes = 0,
               created_at = excluded.created_at
             WHERE curator_pulls.state != 'queued'",
            params![user_id, ext_id, kind, title, artist, url, reason, score, job_id, now_ms()],
        )?;
        // The WHERE on the update arm: a LIVE row is never re-pointed. A
        // second buy of a song already queued, taken by a peer or downloading
        // used to swap the row's job for the new one and orphan the first,
        // whose file then landed with no stamp at all. Callers check
        // pull_state_for before buying; this is the belt to that brace.
        // last_insert_rowid lies on the UPDATE arm; ask for the row properly.
        conn.query_row(
            "SELECT id FROM curator_pulls WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id],
            |r| r.get(0),
        )
    }

    /// Everything currently blocking a re-buy for this user.
    ///
    /// Live pulls (queued/landed/promoted) block forever - buying twice is
    /// buying twice. FAILED pulls block only until `failed_retry_before_ms`:
    /// a failure used to condemn its candidate permanently, but "the
    /// catalogue did not have it" is a fact about the catalogue that day, and
    /// a transient miss was burning good candidates for good. A failure older
    /// than the cutoff simply stops blocking; a retry records a fresh row.
    pub fn pulled_ext_ids(
        &self,
        user_id: i64,
        failed_retry_before_ms: i64,
    ) -> std::collections::HashSet<String> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT ext_id FROM curator_pulls
             WHERE user_id = ?1 AND (state != 'failed' OR created_at >= ?2)",
        ) {
            Ok(s) => s,
            Err(_) => return Default::default(),
        };
        stmt.query_map(params![user_id, failed_retry_before_ms], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Who raised this pull. Stamped by the collector's own pass on the rows
    /// it buys ('collector'); a person's pulls keep the default ''.
    pub fn set_pull_origin(&self, user_id: i64, ext_id: &str, origin: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET origin = ?3 WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id, origin],
        )?;
        Ok(())
    }

    /// The collector's own buys for this listener since a moment, failures
    /// left out - the count the chart cadence alternates on. A Date keep or
    /// an artist-page listen is a person's pull and does not move the seat.
    pub fn collector_buys_since(&self, user_id: i64, since_ms: i64) -> usize {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM curator_pulls
                  WHERE user_id = ?1 AND origin = 'collector'
                    AND state != 'failed' AND created_at >= ?2",
                params![user_id, since_ms],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            .max(0) as usize
    }

    /// Pulls whose import is still out - what the landing check walks.
    pub fn open_pulls(&self) -> Vec<(i64, i64, String)> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT id, user_id, job_id FROM curator_pulls
             WHERE state = 'queued' AND job_id != '' AND job_id NOT IN (?1, ?2)",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        // Delegated pulls are settled by arrival, not by a local job - walking
        // them here would only ever find nothing and age them out.
        stmt.query_map(params![Self::PULL_OFFERED, Self::PULL_TAKEN], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// A pull's import landed: stamp the tracks it became as this listener's
    /// auditions, remember which they were, and settle the pull's real size.
    /// Only rows nobody already owns take the stamp - an import that resolved
    /// to a track a person had added stays theirs.
    /// Returns HOW MANY tracks took the stamp, which is not always the count
    /// handed in: a row somebody already owns, or one that is not newly added,
    /// is deliberately left alone. The caller decides what a zero means - for a
    /// local job it means "done, nothing new", for a delegated one it means the
    /// files have not actually arrived yet and the pull must keep waiting.
    pub fn land_pull(&self, pull_id: i64, user_id: i64, track_ids: &[i64]) -> rusqlite::Result<usize> {
        let rev = self.current_rev() + 1;
        let conn = self.lock();
        let mut bytes = 0i64;
        let mut stamped = 0usize;
        for id in track_ids {
            let changed = conn.execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 0, rev = ?2
                 WHERE id = ?3 AND curator_user_id IS NULL AND added_at > ?4",
                params![user_id, rev, id, now_ms() - 60 * 60 * 1000],
            )?;
            if changed > 0 {
                stamped += 1;
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
        // Only a pull that actually gained something is landed. Marking one
        // 'landed' with nothing behind it used to block its candidate for good:
        // pulled_ext_ids blocks every state except 'failed', so the listener
        // could never be offered that recording again and never got a card.
        if stamped > 0 {
            conn.execute(
                "UPDATE curator_pulls SET state = 'landed', bytes = ?1 WHERE id = ?2",
                params![bytes, pull_id],
            )?;
        }
        Ok(stamped)
    }

    /// Settle a pull that finished without gaining anything - every track it
    /// resolved to was already in the library. The local path calls this so a
    /// finished job still closes its pull, which is what it has always done.
    pub fn mark_pull_landed(&self, pull_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET state = 'landed' WHERE id = ?1",
            params![pull_id],
        )?;
        Ok(())
    }

    /// A peer says this pull produced this file, named as the HUB's own
    /// rel_path. Idempotent: a repeated report is the same row.
    /// The model's warmer sentence, landing on a pull that already went up with
    /// the plain one. Keyed the way the upsert is (user, ext_id), and only ever
    /// improves copy - a row already failed or claimed keeps its reason too,
    /// because the reason describes WHY it was wanted, which failure does not
    /// change.
    pub fn update_pull_reason(
        &self,
        user_id: i64,
        ext_id: &str,
        reason: &str,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET reason = ?3 WHERE user_id = ?1 AND ext_id = ?2",
            params![user_id, ext_id, reason],
        )?;
        Ok(())
    }

    pub fn record_pull_path(&self, pull_id: i64, rel_path: &str) -> rusqlite::Result<()> {
        // Only against a pull somebody actually took. The route is open to any
        // signed-in caller, like the rest of the peer channel, and a report is
        // what decides which file becomes an audition - so it may not name a
        // pull that is merely on offer, already landed, or in the local queue.
        // A member's delegated link ('import') is the exception on the marker:
        // it never becomes an audition, and a peer that took it, hit a snag and
        // handed it back still owes the files it did push.
        let conn = self.lock();
        let n = conn.execute(
            "INSERT OR IGNORE INTO curator_pull_paths (pull_id, rel_path)
             SELECT ?1, ?2 WHERE EXISTS (
               SELECT 1 FROM curator_pulls WHERE id = ?1 AND state = 'queued'
                 AND (job_id = ?3 OR kind = 'import')
             )",
            params![pull_id, rel_path, Self::PULL_TAKEN],
        )?;
        if n > 0 {
            // The clock the settle pass reads to know a many-file link has
            // stopped arriving: an album lands one file per report.
            conn.execute(
                "INSERT INTO meta (k, v) VALUES (?1, ?2)
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                params![Self::path_clock_key(pull_id), now_ms().to_string()],
            )?;
        }
        Ok(())
    }

    fn path_clock_key(pull_id: i64) -> String {
        format!("pull.path_at.{pull_id}")
    }

    /// When a delegated pull last gained a file, in ms; 0 when it never has.
    pub fn pull_last_path_at(&self, pull_id: i64) -> i64 {
        self.lock()
            .query_row(
                "SELECT v FROM meta WHERE k = ?1",
                params![Self::path_clock_key(pull_id)],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    }

    /// Drop an offer nobody has taken. False when the row is gone or a peer
    /// already holds it - then the download is happening and cannot be called
    /// off from here.
    pub fn forget_offered_pull(&self, pull_id: i64) -> rusqlite::Result<bool> {
        let n = self.lock().execute(
            "DELETE FROM curator_pulls WHERE id = ?1 AND state = 'queued' AND job_id = ?2",
            params![pull_id, Self::PULL_OFFERED],
        )?;
        Ok(n > 0)
    }

    /// The live track ids a delegated pull was told about, in the order the
    /// paths were reported. A path with no live row yet simply is not there.
    pub fn pull_path_track_ids(&self, pull_id: i64) -> Vec<i64> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT t.id FROM curator_pull_paths p
             JOIN tracks t ON t.rel_path = p.rel_path AND t.deleted = 0
             WHERE p.pull_id = ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![pull_id], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Hand a claimed pull back to the offer queue - the peer took it and could
    /// not start it. Guarded on the marker so it can never resurrect a pull
    /// that has since been landed or given to the local queue.
    pub fn release_claimed_pull(&self, pull_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET job_id = ?1 WHERE id = ?2 AND job_id = ?3",
            params![Self::PULL_OFFERED, pull_id, Self::PULL_TAKEN],
        )?;
        Ok(())
    }

    /*
     * A delegated pull's `job_id`, while the download is somewhere other than
     * this box's own queue.
     *
     * The field holds a local job id in the ordinary case, and the settle loop
     * looks that id up in the in-memory queue. A pull being fetched by a PEER
     * has no such id - the job exists on another machine - so it carries one of
     * these two words instead, and is settled by the tracks turning up rather
     * than by a job finishing. Words rather than a new column because `job_id`
     * already means "where the download is", and local ids are timestamps.
     */
    pub const PULL_OFFERED: &str = "peer";
    pub const PULL_TAKEN: &str = "peer:taken";
    /// A pull CLAIMED but not yet raised: `buy_outcome` writes the row before
    /// the catalogue search and the queue, so a second buy of the same song
    /// in the same second finds it live and stands down - two callers used to
    /// both raise a job, and the loser's file landed with no stamp. The word
    /// is replaced by the job id (or a peer marker) the moment there is one.
    pub const PULL_PENDING: &str = "pending";

    /// Point a pull at the download that is now carrying it: the local job's
    /// id, or the peer marker, with the link the importer was actually given.
    pub fn set_pull_job(&self, pull_id: i64, job_id: &str, url: &str, reason: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET job_id = ?2, url = ?3, reason = ?4, created_at = ?5
             WHERE id = ?1 AND state = 'queued'",
            params![pull_id, job_id, url, reason, now_ms()],
        )?;
        Ok(())
    }

    /// Where a pull's download is right now - its job id or marker.
    pub fn pull_job(&self, pull_id: i64) -> Option<String> {
        self.lock()
            .query_row("SELECT job_id FROM curator_pulls WHERE id = ?1", params![pull_id], |r| r.get(0))
            .ok()
    }

    /// A failed pull whose local job is being retried goes back to queued
    /// against that same job, so the retry's file is stamped like the first
    /// attempt's would have been. True when a row moved.
    pub fn rearm_pull_for_job(&self, job_id: &str) -> rusqlite::Result<bool> {
        let n = self.lock().execute(
            "UPDATE curator_pulls SET state = 'queued', created_at = ?2
             WHERE job_id = ?1 AND state = 'failed'",
            params![job_id, now_ms()],
        )?;
        Ok(n > 0)
    }

    /// A download box spoke to this hub - any call on the peer channel counts.
    pub fn note_peer_seen(&self) {
        let _ = self.lock().execute(
            "INSERT INTO meta (k, v) VALUES ('collector.peer_seen_at', ?1)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![now_ms().to_string()],
        );
    }

    /// Take one offered pull for a peer to download. At most one, and marked
    /// taken in the same lock so two peers asking at once cannot both get it.
    /// A person's pasted link ('import') goes before the collector's own
    /// speculative picks, oldest first within each - somebody is watching that
    /// card. Taking restarts the row's clock: the day it is given to be
    /// delivered runs from the claim, not from when it was first offered.
    pub fn claim_offered_pull(&self) -> Option<(i64, String, String, String)> {
        let conn = self.lock();
        let row = conn
            .query_row(
                "SELECT id, url, title, artist FROM curator_pulls
                 WHERE state = 'queued' AND job_id = ?1
                 ORDER BY (kind = 'import') DESC, created_at LIMIT 1",
                params![Self::PULL_OFFERED],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )
            .ok()?;
        conn.execute(
            "UPDATE curator_pulls SET job_id = ?1, created_at = ?3 WHERE id = ?2",
            params![Self::PULL_TAKEN, row.0, now_ms()],
        )
        .ok()?;
        // When a download box last showed up. With the downloading happening on
        // another machine there is otherwise NOTHING here that distinguishes
        // "the peer is working through them" from "nobody has ever answered",
        // and those look identical from the offers alone.
        let _ = conn.execute(
            "INSERT INTO meta (k, v) VALUES ('collector.peer_seen_at', ?1)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![now_ms().to_string()],
        );
        Some(row)
    }

    /// Pulls that are out with a peer: id, user, marker, url, title, artist,
    /// when they were raised, the pull's key, and its kind ('track' for the
    /// collector's own picks, 'import' for a member's delegated link).
    pub fn delegated_pulls(
        &self,
    ) -> Vec<(i64, i64, String, String, String, String, i64, String, String)> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT id, user_id, job_id, url, title, artist, created_at, ext_id, kind
             FROM curator_pulls
             WHERE state = 'queued' AND job_id IN (?1, ?2)",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![Self::PULL_OFFERED, Self::PULL_TAKEN], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Recently added tracks no audition has claimed - the pool a delegated
    /// pull is matched against when its files arrive from the peer.
    pub fn recent_unowned_tracks(&self, since_ms: i64) -> Vec<(i64, String, String)> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT id, title, artist FROM tracks
             WHERE added_at >= ?1 AND curator_user_id IS NULL",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![since_ms], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// How many of this listener's pulls actually landed since `since_ms` -
    /// the plain answer to "is it working".
    pub fn pulls_landed_since(&self, user_id: i64, since_ms: i64) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM curator_pulls
                 WHERE user_id = ?1 AND created_at >= ?2
                   AND state IN ('landed', 'promoted', 'passed')",
                params![user_id, since_ms],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// Drop a pull entirely, as though it had never been raised.
    ///
    /// Not `fail_pull`: a failure is a claim about the SONG and blocks it for
    /// thirty days. A want that no peer ever came for says nothing about the
    /// song, so the row goes and the candidate returns to the pool. The paths
    /// and tracks tables cascade.
    pub fn forget_pull(&self, pull_id: i64) -> rusqlite::Result<()> {
        self.lock()
            .execute("DELETE FROM curator_pulls WHERE id = ?1", params![pull_id])?;
        Ok(())
    }

    /// The account a peer files someone else's download under. The owner is
    /// the only account a sync box can assume exists.
    pub fn first_admin_id(&self) -> Option<i64> {
        self.lock()
            .query_row(
                "SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok()
    }

    pub fn fail_pull(&self, pull_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET state = 'failed' WHERE id = ?1",
            params![pull_id],
        )?;
        Ok(())
    }

    /// A member's delegated link landed: the pull is settled without a stamp
    /// (the files are a finished import, not an audition) and without a size,
    /// so it never counts against the collector's budget - the member's disk
    /// is the library's, the same as any import.
    pub fn land_import_pull(&self, pull_id: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE curator_pulls SET state = 'landed', bytes = 0
             WHERE id = ?1 AND state = 'queued'",
            params![pull_id],
        )?;
        Ok(())
    }

    /// Fail a pull a peer holds, and only one it holds: a report against an
    /// offer nobody took, or a pull already landed, changes nothing. True
    /// when the row moved.
    pub fn fail_taken_pull(&self, pull_id: i64) -> rusqlite::Result<bool> {
        let n = self.lock().execute(
            "UPDATE curator_pulls SET state = 'failed'
             WHERE id = ?1 AND state = 'queued' AND job_id = ?2",
            params![pull_id, Self::PULL_TAKEN],
        )?;
        Ok(n > 0)
    }

    /// What a pull is: the collector's 'track'/'album', or a member's 'import'.
    pub fn pull_kind(&self, pull_id: i64) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT kind FROM curator_pulls WHERE id = ?1",
                params![pull_id],
                |r| r.get(0),
            )
            .ok()
    }

    /// Whose pull, under what key, of what kind.
    pub fn pull_owner_kind(&self, pull_id: i64) -> Option<(i64, String, String)> {
        self.lock()
            .query_row(
                "SELECT user_id, ext_id, kind FROM curator_pulls WHERE id = ?1",
                params![pull_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()
    }

    /// Adoption: a completed listen or a heart on an auditioning track moves it
    /// into the library proper, whoever did the listening - wanted is wanted.
    /// The rev bump is what carries the change to every synced client.
    /// Write down what a listener decided about one audition.
    pub fn record_date_verdict(&self, user_id: i64, track_id: i64, verdict: &str) {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO date_verdicts (user_id, track_id, verdict, at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id, track_id) DO UPDATE SET verdict = excluded.verdict, at = excluded.at",
            params![user_id, track_id, verdict, now_ms()],
        );
    }

    /// Every date verdict with its wording and when: (track_id, verdict, at ms).
    /// The taste model reads these as explicit yes/no rows - a keep is a heart
    /// that never went through the shelf, a pass is a no on thirty seconds.
    pub fn date_verdict_rows(&self, user_id: i64, since_ms: i64) -> Vec<(i64, String, i64)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT track_id, verdict, at FROM date_verdicts WHERE user_id = ?1 AND at >= ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![user_id, since_ms], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Auditions this listener has already judged, so the deck never re-deals
    /// a card they have turned down - on this device or any other.
    pub fn date_judged(&self, user_id: i64) -> std::collections::HashSet<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT track_id FROM date_verdicts WHERE user_id = ?1")
        else {
            return std::collections::HashSet::new();
        };
        stmt.query_map(params![user_id], |r| r.get::<_, i64>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Write down what a listener decided about a preview date, by song
    /// rather than by catalogue id - see `date_candidate_verdicts`.
    pub fn record_candidate_verdict(&self, user_id: i64, key: &str, verdict: &str) {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO date_candidate_verdicts (user_id, key, verdict, at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id, key) DO UPDATE SET verdict = excluded.verdict, at = excluded.at",
            params![user_id, key, verdict, now_ms()],
        );
    }

    /// Every song this listener has already judged as a preview date, so the
    /// deal never hands one back however many times the catalogue offers it.
    pub fn candidate_judged_keys(&self, user_id: i64) -> std::collections::HashSet<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT key FROM date_candidate_verdicts WHERE user_id = ?1")
        else {
            return std::collections::HashSet::new();
        };
        stmt.query_map(params![user_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// How many preview dates this listener has judged one way since a
    /// moment - "every third keep this sitting" is read off this.
    pub fn candidate_verdicts_since(&self, user_id: i64, verdict: &str, since_ms: i64) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM date_candidate_verdicts
                  WHERE user_id = ?1 AND verdict = ?2 AND at >= ?3",
                params![user_id, verdict, since_ms],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// Turn down an audition: tombstone the row and hand back the file to
    /// delete, if and only if this listener is the one it was fetched for.
    ///
    /// THE OWNERSHIP TEST IS THE SAFETY. A track is only discardable while it
    /// is an UNADOPTED audition belonging to the caller - `curator_user_id =
    /// them AND curator_promoted = 0`. Anything else is either somebody else's
    /// audition or a real part of the library, and the WHERE clause refuses
    /// both. That is what makes deleting the file safe to do automatically:
    /// nothing else on the server can be referring to it, because until it is
    /// adopted it was never part of anyone's library but this one deck.
    ///
    /// The path comes back rather than being unlinked here so the caller does
    /// the filesystem work outside the database lock, and so a delete that
    /// fails leaves a tombstoned row rather than a live row pointing at a file
    /// that is already gone.
    pub fn discard_audition(&self, user_id: i64, track_id: i64) -> Option<String> {
        let rev = self.current_rev() + 1;
        let conn = self.lock();
        let path: String = conn
            .query_row(
                "SELECT rel_path FROM tracks
                 WHERE id = ?1 AND deleted = 0
                   AND curator_user_id = ?2 AND COALESCE(curator_promoted, 0) = 0",
                params![track_id, user_id],
                |r| r.get(0),
            )
            .ok()?;
        let changed = conn
            .execute(
                "UPDATE tracks SET deleted = 1, rev = ?1
                 WHERE id = ?2 AND curator_user_id = ?3 AND COALESCE(curator_promoted, 0) = 0",
                params![rev, track_id, user_id],
            )
            .unwrap_or(0);
        if changed == 0 {
            return None;
        }
        // The pull that brought it is finished with, one way or the other.
        let _ = conn.execute(
            "UPDATE curator_pulls SET state = 'passed' WHERE state = 'landed' AND id IN (
               SELECT pt.pull_id FROM curator_pull_tracks pt WHERE pt.track_id = ?1
             )",
            params![track_id],
        );
        Some(path)
    }

    /// Adoption: `user_id`'s listen or heart moves a collector audition off
    /// their For-you shelf and into the library proper. True when it did.
    ///
    /// ONLY THE OWNER'S GESTURE COUNTS, and that is the whole point of the
    /// `user_id`. This used to take a track id alone and flip whichever
    /// audition it named, whoever had touched it - which on a hub with one
    /// person is the same thing, and on this one, with eleven, is not. A
    /// collector pull is a bet placed against ONE listener's taste; until that
    /// listener says yes it is theirs and invisible to everyone else
    /// (`tracks_since`). But a housemate could still reach it - a shared
    /// playlist, a direct id, a Subsonic client - and one completed play from
    /// them promoted it library-wide: onto every other member's Home, into the
    /// DJ and New Music pools, and off the owner's own shelf before they had
    /// ever heard it. Somebody else's listening was deciding your suggestions.
    ///
    /// So the row has to be the actor's to promote. Any other member's action
    /// is a no-op here, and whatever they did on their own account (a
    /// favourite row, a play) stays theirs - harmless, since it points at a
    /// track they are never shown.
    pub fn promote_curator_track_for(&self, track_id: i64, user_id: i64) -> bool {
        let rev = self.current_rev() + 1;
        let conn = self.lock();
        let changed = conn
            .execute(
                "UPDATE tracks SET curator_promoted = 1, rev = ?1
                 WHERE id = ?2 AND curator_user_id = ?3 AND COALESCE(curator_promoted, 0) = 0",
                params![rev, track_id, user_id],
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
    ) -> Vec<(String, String, String, String, i64, String, String)> {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT title, artist, kind, state, created_at, reason, job_id
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
                r.get(6)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// What arrived lately, newest first - the Fresh-finds list is this, in
    /// arrival order.
    ///
    /// `for_user` is whose shelf is being built, and it decides which unadopted
    /// collector pulls count as arrivals. Their own do: the collector fetched
    /// those FOR them, and a list of what turned up lately that silently omits
    /// everything the collector went and got is not the list it claims to be.
    /// Another listener's do not - that pull was chosen against somebody else's
    /// taste, and adopting it is their gesture to make.
    pub fn recent_track_ids(&self, since_ms: i64, limit: i64, for_user: i64) -> Vec<i64> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM tracks
             WHERE deleted = 0 AND added_at >= ?1
               AND (curator_user_id IS NULL
                    OR COALESCE(curator_promoted, 0) = 1
                    OR curator_user_id = ?3)
             ORDER BY added_at DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![since_ms, limit, for_user], |r| r.get(0))
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

    /// A pull's state and where its download is (a local job id, or the peer
    /// markers), or None when this listener has no row for the song.
    pub fn pull_state_for(&self, user_id: i64, ext_id: &str) -> Option<(String, String)> {
        self.lock()
            .query_row(
                "SELECT state, job_id FROM curator_pulls WHERE user_id = ?1 AND ext_id = ?2",
                params![user_id, ext_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
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
        /*
         * Adopted BY THE LISTENER WHOSE PULL IT WAS - which `state` cannot say.
         *
         * `promote_curator_track` used to take a track id and no user: it
         * flipped every pull row containing that track to 'promoted', whoever
         * did the listening. (It is `promote_curator_track_for` now, and only
         * the owner's own gesture flips their row - but the row's `state` is
         * still the wrong place to read adoption FROM.) On a hub with one
         * person that was the same thing. On a hub with eleven it was not: a
         * housemate hearting a song your collector fetched marked YOUR pull
         * adopted, your dial read "my picks are landing", and it spent more
         * on the strength of somebody else's taste. The measure has to name
         * who adopted, and `state` has nowhere to put that.
         *
         * So it is derived instead of stored. Adoption is a completed listen
         * or a heart (collector.rs), and both are already recorded per user -
         * `listen_events_user_track` and the `favorites` primary key are
         * exactly the "did THIS user touch THIS track" lookups these probes
         * need. No new column, nothing to backfill, and no second copy of the
         * rule to drift from the one the promotion path already follows.
         *
         * A COMPLETED listen, not a `plays` row. `plays` is written by
         * `POST /api/plays` with no qualification at all - "the client
         * decides what qualifies" - so a bare row there is a play START, and
         * starting a song says you were curious, not that the pick landed.
         * The dial used to read a heart and an eight-second bail as the same
         * yes. `listen_events.completed` is the listener's own rule (finished,
         * or ran long enough to count) and the same fact the promotion path
         * adopts on.
         *
         * Found by PR #3, which fixed it with three new columns and a
         * backfill; the fact was already on file.
         */
        conn.query_row(
            "SELECT COALESCE(SUM(
                      EXISTS (
                        SELECT 1 FROM curator_pull_tracks pt
                         WHERE pt.pull_id = cp.id
                           AND (EXISTS (SELECT 1 FROM favorites f
                                         WHERE f.user_id = cp.user_id AND f.track_id = pt.track_id)
                             OR EXISTS (SELECT 1 FROM listen_events le
                                         WHERE le.user_id = cp.user_id AND le.track_id = pt.track_id
                                           AND le.completed = 1))
                      )
                    ), 0),
                    COUNT(*)
               FROM curator_pulls cp
              WHERE cp.user_id = ?1 AND cp.state IN ('landed', 'promoted')
                AND cp.created_at < ?2",
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
    pub ai_vibes: Vec<String>,
    pub ai_sonic_traits: Vec<String>,
    pub ai_lyrical_themes: Vec<String>,
    pub ai_specific_tags: Vec<String>,
    pub ai_production_descriptors: Vec<String>,
    pub ai_influences: Vec<String>,
    pub ai_confidence: f64,
}

/// What is known about one track's sound and words.
#[derive(Default)]
pub struct TrackFeatures {
    pub track_id: i64,
    /// 'music' or 'book' - stations and mixes must never deal a chapter.
    pub kind: String,
    pub bpm: Option<f64>,
    pub lyric_vec: Option<Vec<f32>>,
    pub genre: String,
    pub ai_genres: Vec<String>,
    /// The controlled mood vocabulary for this track (canonical.moods) - what
    /// the ai-vibe mood mixes group by. Empty until the enricher reaches it.
    pub ai_moods: Vec<String>,
    pub ai_specific_tags: Vec<String>,
    pub ai_sonic_traits: Vec<String>,
    pub artist: String,
    /// The tag title, so a list can fold a track to the same `artist|title`
    /// key a "not this one" was recorded under (discovery::key_of).
    pub title: String,
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
    /// WHOSE audition it is, when it is one. `quarantined` is a global fact -
    /// "somebody has not adopted this yet" - and on its own it cannot tell the
    /// listener the collector fetched a track FOR from everyone else, so every
    /// list simply refused all of them. Carrying the owner lets a listener's own
    /// pulls into their own lists while another's stay out of them.
    pub curator_user_id: Option<i64>,
    /// When the row landed. Arrival IS the ranking for a list about newness.
    pub added_at: i64,
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
/// One song a listener's friends finished lately, and who.
#[derive(Clone, Debug, PartialEq)]
pub struct FriendPlay {
    pub track_id: i64,
    pub completions: i64,
    pub listeners: Vec<String>,
    pub last_at: i64,
}

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
    /// What the preview SOUNDED like, on the analyser's 0..1 scales - the
    /// same energy and brightness a library track carries, so a candidate
    /// can answer the energy and texture terms. None until listened to.
    pub energy: Option<f64>,
    pub brightness: Option<f64>,
    pub rhythmic: Option<f64>,
    /// When it came out, as the catalogue spelled it ("2019-04-12" or
    /// "2019"); `taste::released_year` reads the year off it.
    pub released: Option<String>,
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
        energy: r.get(12)?,
        brightness: r.get(13)?,
        rhythmic: r.get(14)?,
        released: r.get::<_, Option<String>>(15)?.filter(|s| !s.trim().is_empty()),
    })
}

/// Which shelf a file belongs to, decided by where it lives. The Audiobooks/
/// folder IS the contract: the book importer files there, a listener dropping
/// their own m4b/mp3 rips there gets the same treatment, and nothing outside
/// it can ever be mistaken for a book.
pub fn kind_for(rel_path: &str) -> &'static str {
    if book_prefix(rel_path).is_some() {
        "book"
    } else {
        "music"
    }
}

/// The rest of the path after the audiobooks folder, if that is where it lives.
///
/// CASE-INSENSITIVE, and that is not politeness - it is the difference between
/// a feature working and silently not. macOS filesystems are case-preserving
/// but case-INSENSITIVE, so somebody who makes `audiobooks/` and drops books in
/// it has, as far as the operating system is concerned, put them in the same
/// place as `Audiobooks/`. Every tool on the machine agrees. A `starts_with`
/// did not, so those files indexed as MUSIC: no chapters read, no book shelf,
/// and a folder that looks exactly right on disk.
pub fn book_prefix(rel_path: &str) -> Option<&str> {
    const FOLDER: &str = "Audiobooks/";
    // Compared as BYTES, not by slicing the &str. `rel_path[..11]` panics when
    // byte 11 lands inside a multi-byte character, which is not a rare shape -
    // any library with a Japanese, Cyrillic or accented folder near the root
    // has one. It took down a tokio worker on
    // `アトラスサウンドチーム, ATLUS GAME MUSIC` during the 2026-08-26 migration.
    //
    // FOLDER is pure ASCII, so a byte-wise ASCII-insensitive compare is exactly
    // equivalent for every path that could match, and simply returns false -
    // rather than panicking - for every path that could not.
    let head = rel_path.as_bytes().get(..FOLDER.len())?;
    if head.eq_ignore_ascii_case(FOLDER.as_bytes()) {
        Some(&rel_path[FOLDER.len()..])
    } else {
        None
    }
}

#[cfg(test)]
mod book_prefix_utf8 {
    use super::book_prefix;

    #[test]
    fn multibyte_near_the_prefix_length_does_not_panic() {
        // Byte 11 falls inside the third character here; the old slice paniced.
        assert_eq!(book_prefix("アトラスサウンドチーム/01 track.flac"), None);
        assert_eq!(book_prefix("Ünderscore/x.flac"), None);
        assert_eq!(book_prefix("短/a.m4b"), None);
    }

    #[test]
    fn still_matches_either_case() {
        assert_eq!(book_prefix("Audiobooks/A/B.m4b"), Some("A/B.m4b"));
        assert_eq!(book_prefix("audiobooks/A/B.m4b"), Some("A/B.m4b"));
        assert_eq!(book_prefix("AUDIOBOOKS/A/B.m4b"), Some("A/B.m4b"));
        assert_eq!(book_prefix("Music/A/B.flac"), None);
        assert_eq!(book_prefix("short"), None);
    }
}

#[cfg(test)]
mod pull_retry_window {
    //! A failed pull ages out of the exclusion set; live pulls never do.

    #[test]
    fn failed_pulls_become_retryable_after_the_window() {
        let dir = std::env::temp_dir().join(format!("afm-pulls-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = super::Db::open(&dir.join("t.sqlite")).unwrap();
        let user = db.create_user("puller", "x", false).unwrap();

        // A live pull, a fresh failure, and an old failure.
        db.record_pull(user, "live", "track", "T", "A", "u", "", 0.5, "").unwrap();
        let fresh = db.record_pull(user, "fresh-fail", "track", "T", "A", "u", "", 0.5, "").unwrap();
        db.fail_pull(fresh).unwrap();
        let old = db.record_pull(user, "old-fail", "track", "T", "A", "u", "", 0.5, "").unwrap();
        db.fail_pull(old).unwrap();
        db.lock()
            .execute("UPDATE curator_pulls SET created_at = 1 WHERE id = ?1", super::params![old])
            .unwrap();

        let cutoff = super::now_ms() - 1000; // failures older than a second may retry
        let blocking = db.pulled_ext_ids(user, cutoff);
        assert!(blocking.contains("live"), "live pulls block forever");
        assert!(blocking.contains("fresh-fail"), "a recent failure still blocks");
        assert!(!blocking.contains("old-fail"), "an aged failure stops blocking");

        // The retry itself: re-recording the SAME ext_id must re-arm the row -
        // one row, state queued, fresh clock - not error against the UNIQUE
        // constraint or leave the old failure in charge.
        let rearmed = db.record_pull(user, "old-fail", "track", "T", "A", "u2", "", 0.7, "job9")
            .expect("a retry must not violate UNIQUE(user_id, ext_id)");
        assert_eq!(rearmed, old, "the retry re-arms the existing row, not a duplicate");
        let (state, job): (String, String) = db
            .lock()
            .query_row(
                "SELECT state, job_id FROM curator_pulls WHERE id = ?1",
                super::params![rearmed],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "queued");
        assert_eq!(job, "job9");
        assert!(db.pulled_ext_ids(user, cutoff).contains("old-fail"), "re-armed rows block again");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod taste_verdict_units {
    //! started_at is epoch MILLISECONDS; the taste math runs on SECONDS.
    //!
    //! The conversion went missing once, and the failure was perfectly silent:
    //! `now_secs - at_ms` is hugely negative, `.max(0)` reads it as "today",
    //! and every verdict scores recency 1.0 - the 21-day half-life never
    //! applied to anything, so taste weighed a listen from six months ago
    //! exactly like last night's. The window filter matched every row ever
    //! written for the same reason. This pins both conversions at the one
    //! boundary they now live at.

    #[test]
    fn verdicts_come_back_in_seconds_and_the_window_is_milliseconds() {
        let dir = std::env::temp_dir().join(format!("afm-taste-units-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = super::Db::open(&dir.join("t.sqlite")).unwrap();
        let user = db.create_user("units", "x", true).unwrap();
        db.lock()
            .execute(
                "INSERT INTO tracks (id, rel_path, title, artist, album_artist, album, added_at, rev)
                 VALUES (7, 'a.flac', 'T', 'A', 'A', 'Al', 0, 1)",
                [],
            )
            .unwrap();

        let now_ms = super::now_ms();
        let recent_ms = now_ms - 2 * 86_400_000; // two days ago
        let ancient_ms = now_ms - 400 * 86_400_000; // outside any window
        let tags = (String::from("T"), String::from("A"), String::from("Al"), String::new());
        db.insert_listen(user, 7, &tags, recent_ms, 200_000, Some(210_000), true, false, "home", &crate::db::ListenShape::default())
            .unwrap();
        db.insert_listen(user, 7, &tags, ancient_ms, 200_000, Some(210_000), true, false, "home", &crate::db::ListenShape::default())
            .unwrap();

        // The window is in the column's own unit, so the ancient row is out.
        let window_ms = now_ms - 180 * 86_400_000;
        let got = db.taste_verdicts(user, window_ms, 100);
        assert_eq!(got.len(), 1, "a ms window must exclude the 400-day-old row");

        // And `at` is seconds, so recency actually decays: two days into a
        // 21-day half-life is ~0.94, not the 1.0 the ms-as-seconds bug froze
        // every verdict at.
        let v = &got[0];
        assert!((v.at - recent_ms / 1000).abs() <= 1, "at is unix seconds");
        let r = v.weight(now_ms / 1000) / (v.sentiment() * v.confidence());
        assert!((0.90..0.98).contains(&r), "recency should be ~0.94, got {r}");
    }
}

#[cfg(test)]
mod stem_model_isolation {
    //! Two separations of one track must not be served as one set.
    //!
    //! `model` has always been in the primary key so a better separator could
    //! land beside an older one. The lookups ignored it, so the moment a track
    //! had been separated twice they returned both vintages welded together -
    //! two `vocals`, ten rows - and handed back whichever the planner reached
    //! first. That is the exact failure the schema was shaped to avoid.

    #[test]
    fn a_track_separated_twice_answers_one_model_at_a_time() {
        let dir = std::env::temp_dir().join(format!("afm-stems-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = super::Db::open(&dir.join("t.sqlite")).unwrap();

        // A row in tracks, because track_stems references it.
        db.lock()
            .execute(
                "INSERT INTO tracks (id, rel_path, title, artist, album_artist, album, added_at, rev)
                 VALUES (1, 'a.flac', 'T', 'A', 'A', 'Al', 0, 1)",
                [],
            )
            .unwrap();

        // The old four-stem vintage, then the new six-stem one.
        for stem in ["vocals", "drums", "bass", "other"] {
            db.save_stem(1, stem, "htdemucs", &format!("1/{stem}.opus"), 10).unwrap();
        }
        for stem in ["vocals", "drums", "bass", "guitar", "piano", "other"] {
            db.save_stem(1, stem, "htdemucs_6s", &format!("1/{stem}.flac"), 20).unwrap();
        }

        let (_, _, old) = db.stems_for(1, "htdemucs");
        let (_, _, new) = db.stems_for(1, "htdemucs_6s");
        assert_eq!(old.len(), 4, "the old model still answers with its own four");
        assert_eq!(new.len(), 6, "the new model answers with six, not ten");
        assert!(new.iter().any(|(s, _, _)| s == "guitar"), "guitar is a stem of its own now");

        // And one stem resolves to the file belonging to the model asked for,
        // rather than to whichever row the planner happened to reach.
        assert!(db.stem_path(1, "vocals", "htdemucs").unwrap().ends_with(".opus"));
        assert!(db.stem_path(1, "vocals", "htdemucs_6s").unwrap().ends_with(".flac"));
        assert!(db.stem_path(1, "guitar", "htdemucs").is_none(), "the old model had no guitar");
    }
}

#[cfg(test)]
mod stem_prefetch_brakes {
    //! The two things that stop separating-ahead becoming a treadmill.
    //!
    //! Both of these have been silently lost once already: the eviction note
    //! went missing from a build that compiled clean, and only a dead-constant
    //! warning gave it away. They are cheap to assert and expensive to lose.

    fn db(name: &str) -> super::Db {
        let dir = std::env::temp_dir().join(format!("afm-prefetch-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        super::Db::open(&dir.join("t.sqlite")).unwrap()
    }

    /// Puts a track in the library and likes it, so it is a prefetch candidate.
    fn liked_track(db: &super::Db, rel: &str) -> i64 {
        let user = db.create_user(&format!("u{rel}"), "x", false).unwrap();
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path, title, artist, album_artist, album, deleted, added_at, rev)
                 VALUES (?1, 't', 'a', 'a', 'al', 0, 1, 1)",
                super::params![rel],
            )
            .unwrap();
        let id: i64 = db
            .lock()
            .query_row("SELECT id FROM tracks WHERE rel_path = ?1", super::params![rel], |r| r.get(0))
            .unwrap();
        db.lock()
            .execute(
                "INSERT INTO favorites (user_id, track_id, added_at) VALUES (?1, ?2, 1)",
                super::params![user, id],
            )
            .unwrap();
        id
    }

    /// Puts a track in the library and into a playlist, without liking it.
    fn playlisted_track(db: &super::Db, rel: &str) -> i64 {
        let user = db.create_user(&format!("p{rel}"), "x", false).unwrap();
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path, title, artist, album_artist, album, deleted, added_at, rev)
                 VALUES (?1, 't', 'a', 'a', 'al', 0, 1, 1)",
                super::params![rel],
            )
            .unwrap();
        let id: i64 = db
            .lock()
            .query_row("SELECT id FROM tracks WHERE rel_path = ?1", super::params![rel], |r| r.get(0))
            .unwrap();
        let pl = db.create_playlist(user, "list").unwrap();
        db.set_playlist_tracks(pl, &[id]).unwrap();
        id
    }

    /// The readout's denominator counts the JOB, not the disk.
    ///
    /// It would be easy to answer this with "how many stems exist", and it would
    /// be wrong in both directions: a song separated because somebody asked for
    /// it, which is neither liked nor listed, is not progress toward this; and a
    /// liked song counts whether or not the queue has reached it yet.
    #[test]
    fn the_total_counts_the_job_rather_than_the_disk() {
        let db = db("total");
        let liked = liked_track(&db, "liked.flac");
        let listed = playlisted_track(&db, "listed.flac");

        let (done, total) = db.prefetch_total("m");
        assert_eq!(total, 2, "liked and playlisted are both in the job");
        assert_eq!(done, 0, "nothing separated yet");

        // Separating the liked one moves the numerator only.
        db.save_stem_at(liked, "vocals", "m", "a/vocals.flac", 10, super::now_ms()).unwrap();
        let (done, total) = db.prefetch_total("m");
        assert_eq!((done, total), (1, 2), "one of two apart");

        // A song nobody liked or listed, separated on request, is NOT progress -
        // it inflates neither half.
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path, title, artist, album_artist, album, deleted, added_at, rev)
                 VALUES ('stray.flac', 't', 'a', 'a', 'al', 0, 1, 1)",
                [],
            )
            .unwrap();
        let stray: i64 = db
            .lock()
            .query_row("SELECT id FROM tracks WHERE rel_path = 'stray.flac'", [], |r| r.get(0))
            .unwrap();
        db.save_stem_at(stray, "vocals", "m", "b/vocals.flac", 10, super::now_ms()).unwrap();
        assert_eq!(db.prefetch_total("m"), (1, 2), "a song outside the job changes neither half");

        // And a different model shares no credit: the numerator is per-model.
        assert_eq!(db.prefetch_total("other").0, 0, "another model has separated none of them");
        let _ = listed;
    }

    #[test]
    fn an_evicted_song_is_not_queued_again() {
        let db = db("evict");
        let id = liked_track(&db, "a.flac");
        let now = super::now_ms();

        // Liked and unseparated: it is a candidate.
        let first = db.prefetch_candidates("m", now, 10, true);
        assert!(first.iter().any(|(t, _)| *t == id), "a liked song should be wanted");

        // Separated, then evicted - which is forget_stems plus the note. This is
        // the exact sequence evict_if_needed runs.
        db.save_stem_at(id, "vocals", "m", "a/vocals.flac", 10, now).unwrap();
        db.forget_stems(id).unwrap();
        db.note_stem_eviction(id, 30 * 24 * 60 * 60 * 1000).unwrap();

        // forget_stems left no trace in track_stems or stem_jobs, so WITHOUT the
        // note this song is indistinguishable from a new one and comes straight
        // back - which is the treadmill.
        let again = db.prefetch_candidates("m", now, 10, true);
        assert!(
            !again.iter().any(|(t, _)| *t == id),
            "an evicted song must not be re-queued while it is cooling down",
        );

        // And it becomes eligible again once the cooldown has passed, rather
        // than being excluded for good.
        let later = db.prefetch_candidates("m", now + 31 * 24 * 60 * 60 * 1000, 10, true);
        assert!(
            later.iter().any(|(t, _)| *t == id),
            "after the cooldown it may be considered again",
        );
    }

    #[test]
    fn separating_ahead_waits_to_be_asked() {
        let db = db("optin");
        let id = liked_track(&db, "b.flac");
        let now = super::now_ms();

        // Liked, but the Liked switch is off: nothing is wanted. This is the
        // whole change - the old rule queued anything liked or filed anywhere,
        // which was every song a person had ever touched.
        assert!(
            db.prefetch_candidates("m", now, 10, false).is_empty(),
            "a liked song must not be queued while Liked is switched off",
        );

        // The same song in a playlist that has not opted in: still nothing.
        let owner = db.create_user("listmaker", "x", false).unwrap();
        let list = db.create_playlist(owner, "Late nights").unwrap();
        db.set_playlist_tracks(list, &[id]).unwrap();
        assert!(
            db.prefetch_candidates("m", now, 10, false).is_empty(),
            "being in a playlist is not by itself a reason to separate",
        );

        // The list opts in, and now it is wanted.
        db.set_playlist_auto_stem(list, true).unwrap();
        let wanted = db.prefetch_candidates("m", now, 10, false);
        assert!(
            wanted.iter().any(|(t, _)| *t == id),
            "a song in an opted-in list should be queued",
        );

        // And the prune keeps exactly what the prefetcher would maintain.
        db.save_stem_at(id, "vocals", "m", "b/vocals.flac", 10, now).unwrap();
        assert!(
            db.stems_outside_keep(false).is_empty(),
            "a song an opted-in list wants must survive the prune",
        );
        db.set_playlist_auto_stem(list, false).unwrap();
        assert!(
            db.stems_outside_keep(false).iter().any(|(t, _)| *t == id),
            "once nothing asks for it, its separation is the prune's business",
        );
        assert!(
            db.stems_outside_keep(true).is_empty(),
            "unless Liked is switched on, which this song is in",
        );
    }

    #[test]
    fn a_guess_is_evicted_before_real_work() {
        let db = db("cold");
        let guessed = liked_track(&db, "guess.flac");
        let asked_for = liked_track(&db, "asked.flac");
        let now = super::now_ms();

        // The asked-for song was separated an hour ago; the guess is made NOW.
        // By wall clock the guess is therefore the newest row, and would be the
        // LAST thing evicted - which is the bug. The cold offset is the only
        // thing that can reverse that, so this ordering is what gives the test
        // its teeth: write the guess warm and the assertion below flips.
        db.save_stem_at(asked_for, "vocals", "m", "a/vocals.flac", 10, now - 3_600_000)
            .unwrap();
        db.save_stem_at(guessed, "vocals", "m", "g/vocals.flac", 10, now - COLD)
            .unwrap();

        let (coldest, _) = db.coldest_stem_track().expect("something must be evictable");
        assert_eq!(
            coldest, guessed,
            "the cache must sacrifice the guess, not the song somebody separated by hand",
        );
    }

    /// Mirrors stems.rs COLD_OFFSET_MS.
    const COLD: i64 = 10 * 365 * 24 * 60 * 60 * 1000;
}

#[cfg(test)]
mod book_bookmarks_are_not_crowded_out {
    //! Several books on the go, each keeping its own place.
    //!
    //! The bookmark ledger is one list, capped and ordered by recency, so the
    //! book you have not opened this week was the first thing pushed off the
    //! end - and a reader three books deep found one of them had simply
    //! forgotten where it was. Asking for books alone, with room for all of
    //! them, is what keeps a place kept.

    #[test]
    fn the_least_recently_read_book_still_knows_its_place() {
        let dir = std::env::temp_dir().join(format!("afm-marks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = super::Db::open(&dir.join("t.sqlite")).unwrap();
        let user = db.create_user("reader", "x", false).unwrap();

        let add = |rel: &str, kind: &str| -> i64 {
            db.lock()
                .execute(
                    "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                     VALUES (?1,?1,'a','a','al',0,0,?2)",
                    super::params![rel, kind],
                )
                .unwrap();
            db.lock().last_insert_rowid()
        };
        let stamp = |track: i64, at: i64| {
            db.lock()
                .execute(
                    "UPDATE play_state SET updated_at = ?1 WHERE track_id = ?2",
                    super::params![at, track],
                )
                .unwrap();
        };

        // Three books of fifty sections - one long series is enough to fill the
        // old hundred on its own, let alone three.
        let mut sections = Vec::new();
        for b in 0..3 {
            for s in 0..50 {
                let id = add(&format!("Audiobooks/b{b}-{s}.m4b"), "book");
                db.set_play_state(user, id, 60_000).unwrap();
                // Book 0 is the one read least recently.
                stamp(id, 1_000 + (b as i64) * 1_000 + s as i64);
                sections.push((b, id));
            }
        }
        // Music keeps positions too, and it is the most recent thing here.
        for m in 0..40 {
            let id = add(&format!("m{m}.flac"), "music");
            db.set_play_state(user, id, 5_000).unwrap();
            stamp(id, 900_000 + m as i64);
        }

        let oldest_book_section = sections.iter().find(|(b, _)| *b == 0).unwrap().1;

        // The old shape: one capped list serving everything.
        let mixed = db.play_states(user, 100, None);
        assert_eq!(mixed.len(), 100, "the unfiltered list is capped");
        assert!(
            mixed.iter().any(|(_, pos, _)| *pos == 5_000),
            "music takes room in it"
        );
        assert!(
            !mixed.iter().any(|(t, _, _)| *t == oldest_book_section),
            "and the least recently read book falls off the end - the bug"
        );

        // Asking for books, with room for them.
        let books = db.play_states(user, 2_000, Some("book"));
        assert_eq!(books.len(), 150, "every section of every book keeps its mark");
        assert!(
            books.iter().all(|(_, pos, _)| *pos == 60_000),
            "no music in a list of books"
        );
        assert!(
            books.iter().any(|(t, _, _)| *t == oldest_book_section),
            "including the book that has waited longest"
        );

        // The cap is still a cap: it bounds the read, it just is not reached.
        assert_eq!(db.play_states(user, 10, Some("book")).len(), 10);
    }
}

#[cfg(test)]
mod canvas_misses_survive_a_restart {
    //! A song Spotify has no Canvas for.
    //!
    //! The clip for a HIT is remembered by the file kept beside the song. A
    //! MISS had nowhere to live but a HashMap cleared on every restart, so the
    //! canvas-less half of a library was looked up again on every boot - one
    //! Spotify request each, every time, and a stand-in on the card until each
    //! answer came back. Writing the noes down is what stops that.

    #[test]
    fn a_no_is_remembered_and_can_be_forgotten_on_purpose() {
        let dir = std::env::temp_dir().join(format!("afm-canvas-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = super::Db::open(&dir.join("t.sqlite")).unwrap();

        let add = |rel: &str| -> i64 {
            db.lock()
                .execute(
                    "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                     VALUES (?1,?1,'Vane','Vane','al',0,0,'music')",
                    super::params![rel],
                )
                .unwrap();
            db.lock().last_insert_rowid()
        };
        let a = add("a.flac");
        let b = add("b.flac");

        let now = super::now_ms();
        assert!(db.canvas_miss_age(a, now).is_none(), "never asked");

        db.mark_canvas_miss(a).unwrap();
        assert!(
            db.canvas_miss_age(a, super::now_ms()).is_some_and(|age| age < 5_000),
            "a no, just recorded",
        );

        // The queue skips a fresh miss and keeps offering everything else.
        let want: Vec<i64> = db
            .tracks_wanting_canvas(50, 30 * 24 * 60 * 60 * 1000)
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        assert!(!want.contains(&a), "a fresh no is not re-asked");
        assert!(want.contains(&b), "everything else still is");

        // A clip that turns up later clears the no.
        db.clear_canvas_miss(a).unwrap();
        assert!(db.canvas_miss_age(a, super::now_ms()).is_none());

        // And the one button for "these stopped working" forgets them all.
        db.mark_canvas_miss(a).unwrap();
        db.mark_canvas_miss(b).unwrap();
        assert_eq!(db.forget_canvas_misses().unwrap(), 2);
        assert_eq!(db.tracks_wanting_canvas(50, 30 * 24 * 60 * 60 * 1000).len(), 2);
    }

    /// The retry window is what stops a no being permanent: an artist who adds
    /// a Canvas to a back-catalogue track should be found eventually.
    #[test]
    fn an_old_no_is_asked_again() {
        let dir = std::env::temp_dir().join(format!("afm-canvas-old-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = super::Db::open(&dir.join("t.sqlite")).unwrap();
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES ('x.flac','x','Vane','Vane','al',0,0,'music')",
                [],
            )
            .unwrap();
        let id = db.lock().last_insert_rowid();

        // Recorded a year ago.
        db.lock()
            .execute(
                "INSERT INTO canvas_misses (track_id, checked_at) VALUES (?1, ?2)",
                super::params![id, super::now_ms() - 365 * 24 * 60 * 60 * 1000],
            )
            .unwrap();

        let month = 30 * 24 * 60 * 60 * 1000;
        assert_eq!(
            db.tracks_wanting_canvas(50, month).len(),
            1,
            "past the retry window it is offered again",
        );
    }
}

#[cfg(test)]
mod audition_visibility {
    //! An unadopted collector audition belongs to exactly one listener, and
    //! must not reach anybody else's client. This used to be enforced in the
    //! browser (`DatePage.tsx` filtered `forYou` by `curatorUserId`), which
    //! failed open whenever the request that told it who you were failed.

    use super::*;

    fn track(rel: &str, title: &str) -> ScannedTrack {
        ScannedTrack {
            rel_path: rel.into(),
            title: title.into(),
            artist: "A".into(),
            album: "Al".into(),
            duration_ms: Some(200_000),
            ..Default::default()
        }
    }

    #[test]
    fn one_listeners_audition_is_invisible_to_another() {
        let dir = std::env::temp_dir().join(format!("afm-vis-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.sqlite")).unwrap();
        let alice = db.create_user("alice", "x", true).unwrap();
        let bob = db.create_user("bob", "x", false).unwrap();

        db.upsert_track(&track("shared.flac", "Shared"), 1).unwrap();
        db.upsert_track(&track("audition.flac", "Audition"), 2).unwrap();
        let audition = db.track_id_by_path("audition.flac").expect("indexed");

        // Mark it as an unadopted audition bought for alice.
        db.lock()
            .execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 0, rev = 3 WHERE id = ?2",
                params![alice, audition],
            )
            .unwrap();

        let titles = |uid: i64| -> Vec<String> {
            db.tracks_since(uid, 0, 100).0.into_iter().map(|t| t.title).collect()
        };

        let seen_by_alice = titles(alice);
        let seen_by_bob = titles(bob);

        assert!(seen_by_alice.contains(&"Audition".to_string()), "the buyer sees their own card");
        assert!(
            !seen_by_bob.contains(&"Audition".to_string()),
            "another listener must NEVER be sent it: {seen_by_bob:?}"
        );
        assert!(seen_by_bob.contains(&"Shared".to_string()), "the ordinary library is unaffected");
    }

    /// The Home shelves ask `unplayed` for material, and it used to ask only
    /// "never played, newest first" - so another listener's unadopted audition
    /// and every chapter of every audiobook were eligible to be dealt to you,
    /// and handed to the AI that writes your mixes. The same rule
    /// `tracks_since` enforces above applies here.
    #[test]
    fn unplayed_hides_books_and_another_listeners_audition() {
        let dir = std::env::temp_dir().join(format!("afm-unplayed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.sqlite")).unwrap();
        let alice = db.create_user("alice", "x", true).unwrap();
        let bob = db.create_user("bob", "x", false).unwrap();

        db.upsert_track(&track("song.flac", "Ordinary Song"), 1).unwrap();
        db.upsert_track(&track("chapter.m4b", "Chapter One"), 2).unwrap();
        db.upsert_track(&track("hers.flac", "Alices Audition"), 3).unwrap();
        db.upsert_track(&track("adopted.flac", "Adopted Pull"), 4).unwrap();

        let book = db.track_id_by_path("chapter.m4b").unwrap();
        let hers = db.track_id_by_path("hers.flac").unwrap();
        let adopted = db.track_id_by_path("adopted.flac").unwrap();
        {
            let c = db.lock();
            c.execute("UPDATE tracks SET kind = 'book' WHERE id = ?1", params![book]).unwrap();
            c.execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 0 WHERE id = ?2",
                params![alice, hers],
            )
            .unwrap();
            // Bought for alice but already adopted: it is ordinary library now.
            c.execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 1 WHERE id = ?2",
                params![alice, adopted],
            )
            .unwrap();
        }

        let titles = |uid: i64| -> Vec<String> {
            db.unplayed(uid, 100)
                .into_iter()
                .filter_map(|id| db.track(id).map(|t| t.title))
                .collect()
        };

        let bobs = titles(bob);
        assert!(bobs.contains(&"Ordinary Song".to_string()), "the plain library still comes through");
        assert!(bobs.contains(&"Adopted Pull".to_string()), "an adopted pull is ordinary library");
        assert!(!bobs.contains(&"Chapter One".to_string()), "a book is not mix material: {bobs:?}");
        assert!(
            !bobs.contains(&"Alices Audition".to_string()),
            "another listener's audition must never be dealt: {bobs:?}"
        );

        // The buyer still sees her own, exactly as she does everywhere else.
        assert!(titles(alice).contains(&"Alices Audition".to_string()), "the buyer keeps hers");
    }

    #[test]
    fn adoption_makes_it_visible_to_everyone_on_the_next_page() {
        let dir = std::env::temp_dir().join(format!("afm-vis2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.sqlite")).unwrap();
        let alice = db.create_user("alice", "x", true).unwrap();
        let bob = db.create_user("bob", "x", false).unwrap();

        db.upsert_track(&track("a.flac", "Audition"), 1).unwrap();
        let id = db.track_id_by_path("a.flac").unwrap();
        db.lock()
            .execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 0, rev = 2 WHERE id = ?2",
                params![alice, id],
            )
            .unwrap();
        assert!(db.tracks_since(bob, 0, 100).0.is_empty(), "hidden while pending");

        db.promote_curator_track_for(id, alice);
        let seen: Vec<String> =
            db.tracks_since(bob, 0, 100).0.into_iter().map(|t| t.title).collect();
        assert_eq!(seen, vec!["Audition".to_string()], "adopted tracks join the library");
    }

    /// Arrivals are per-listener, because "what turned up lately" that omits
    /// everything the collector bought for you is not what it says it is - and
    /// that omission is exactly why a shelf built on this looked like it only
    /// ever reshuffled music the listener already owned.
    #[test]
    fn my_own_pull_is_an_arrival_and_someone_elses_is_not() {
        let dir = std::env::temp_dir().join(format!("afm-arrivals-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.sqlite")).unwrap();
        let alice = db.create_user("alice", "x", true).unwrap();
        let bob = db.create_user("bob", "x", false).unwrap();

        for (path, title) in [("own.flac", "Mine"), ("theirs.flac", "Theirs"), ("lib.flac", "Library")] {
            db.upsert_track(&track(path, title), 1).unwrap();
        }
        let mine = db.track_id_by_path("own.flac").unwrap();
        let theirs = db.track_id_by_path("theirs.flac").unwrap();
        for (owner, id) in [(alice, mine), (bob, theirs)] {
            db.lock()
                .execute(
                    "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 0 WHERE id = ?2",
                    params![owner, id],
                )
                .unwrap();
        }
        // Everything landed just now, so a window of any width holds all three.
        let titles = |uid: i64| -> Vec<String> {
            db.recent_track_ids(0, 100, uid)
                .into_iter()
                .filter_map(|id| db.track_rel_path(id))
                .collect()
        };

        let for_alice = titles(alice);
        assert!(for_alice.contains(&"own.flac".to_string()), "my own pull is an arrival: {for_alice:?}");
        assert!(
            !for_alice.contains(&"theirs.flac".to_string()),
            "somebody else's unadopted pull is not mine to be offered: {for_alice:?}"
        );
        assert!(for_alice.contains(&"lib.flac".to_string()), "the shared library is unaffected");

        let for_bob = titles(bob);
        assert!(for_bob.contains(&"theirs.flac".to_string()), "and the rule is symmetric: {for_bob:?}");
        assert!(!for_bob.contains(&"own.flac".to_string()), "not the other way round: {for_bob:?}");
    }
}

#[cfg(test)]
mod discarding_auditions {
    //! `discard_audition` is the one path that deletes a listener's files, so
    //! what it REFUSES matters more than what it does.

    use super::*;

    fn track(rel: &str) -> ScannedTrack {
        ScannedTrack {
            rel_path: rel.into(),
            title: rel.into(),
            artist: "A".into(),
            duration_ms: Some(1000),
            ..Default::default()
        }
    }

    fn db_with(dir: &str) -> (Db, std::path::PathBuf) {
        let d = std::env::temp_dir().join(format!("{dir}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let db = Db::open(&d.join("t.sqlite")).unwrap();
        (db, d)
    }

    fn make_audition(db: &Db, owner: i64, rel: &str) -> i64 {
        db.upsert_track(&track(rel), 1).unwrap();
        let id = db.track_id_by_path(rel).unwrap();
        db.lock()
            .execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 0 WHERE id = ?2",
                params![owner, id],
            )
            .unwrap();
        id
    }

    #[test]
    fn the_owner_can_discard_their_own_pending_audition() {
        let (db, _d) = db_with("afm-disc1");
        let me = db.create_user("me", "x", true).unwrap();
        let id = make_audition(&db, me, "audition.flac");

        assert_eq!(db.discard_audition(me, id), Some("audition.flac".into()));
        let gone: i64 = db
            .lock()
            .query_row("SELECT deleted FROM tracks WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(gone, 1, "tombstoned, so every client drops it");
    }

    #[test]
    fn nobody_can_discard_somebody_elses_audition() {
        let (db, _d) = db_with("afm-disc2");
        let alice = db.create_user("alice", "x", true).unwrap();
        let bob = db.create_user("bob", "x", false).unwrap();
        let id = make_audition(&db, alice, "hers.flac");

        assert_eq!(db.discard_audition(bob, id), None, "not bob's to throw away");
        let alive: i64 = db
            .lock()
            .query_row("SELECT deleted FROM tracks WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(alive, 0, "and it is untouched");
    }

    #[test]
    fn an_adopted_track_is_library_and_cannot_be_discarded() {
        let (db, _d) = db_with("afm-disc3");
        let me = db.create_user("me", "x", true).unwrap();
        let id = make_audition(&db, me, "kept.flac");
        db.promote_curator_track_for(id, me);

        assert_eq!(db.discard_audition(me, id), None, "adopted music is not an audition");
    }

    #[test]
    fn an_ordinary_library_track_is_never_discardable() {
        let (db, _d) = db_with("afm-disc4");
        let me = db.create_user("me", "x", true).unwrap();
        db.upsert_track(&track("mine.flac"), 1).unwrap();
        let id = db.track_id_by_path("mine.flac").unwrap();

        assert_eq!(db.discard_audition(me, id), None, "it was never an audition");
    }

    #[test]
    fn a_verdict_is_remembered_so_the_card_is_not_dealt_twice() {
        let (db, _d) = db_with("afm-disc5");
        let me = db.create_user("me", "x", true).unwrap();
        let a = make_audition(&db, me, "a.flac");
        let b = make_audition(&db, me, "b.flac");

        db.record_date_verdict(me, a, "passed");
        db.record_date_verdict(me, b, "kept");
        let judged = db.date_judged(me);
        assert!(judged.contains(&a) && judged.contains(&b));
        assert!(db.date_judged(db.create_user("other", "x", false).unwrap()).is_empty());

        // Changing your mind overwrites rather than duplicating.
        db.record_date_verdict(me, a, "kept");
        assert_eq!(db.date_judged(me).len(), 2);
    }
}

#[cfg(test)]
mod judged_candidates {
    //! A preview date that was passed on (or kept) must never be dealt again,
    //! however many times the catalogue re-offers it - under this id or a new
    //! one. The row used to be deleted and nothing remembered the verdict.

    use super::*;

    fn fresh() -> Db {
        let d = std::env::temp_dir().join(format!("judged-candidates-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    fn offer(db: &Db, me: i64, ext: &str, artist: &str, title: &str) {
        db.add_discovery(me, ext, title, artist, "", "", "https://p/preview.mp3", "seed", 50.0).unwrap();
    }

    #[test]
    fn a_judged_song_is_not_rediscovered() {
        let db = fresh();
        let me = db.create_user("me", "", true).unwrap();
        offer(&db, me, "dz-1", "Boards of Canada", "Dayvan Cowboy");
        assert!(db.discovery_get(me, "dz-1").is_some(), "an unjudged offer lands");

        // The swipe: remembered by song, then the row goes (as the endpoint does).
        db.record_candidate_verdict(me, &crate::discovery::key_of("Boards of Canada", "Dayvan Cowboy"), "passed");
        db.forget_discovery(me, "dz-1");
        assert!(db.discovery_get(me, "dz-1").is_none());

        // The next harvest offers the same song under a NEW id, spelled a
        // little differently - key_of folds the spelling.
        offer(&db, me, "dz-2", "BOARDS OF CANADA", "Dayvan Cowboy (Remastered)");
        assert!(db.discovery_get(me, "dz-2").is_none(), "a passed song must not come back");

        // A different song from the same artist is still welcome.
        offer(&db, me, "dz-3", "Boards of Canada", "Roygbiv");
        assert!(db.discovery_get(me, "dz-3").is_some());

        // The ledger reads back, and a change of mind overwrites.
        assert!(db.candidate_judged_keys(me).contains(&crate::discovery::key_of("Boards of Canada", "Dayvan Cowboy")));
        db.record_candidate_verdict(me, &crate::discovery::key_of("Boards of Canada", "Dayvan Cowboy"), "kept");
        assert_eq!(db.candidate_judged_keys(me).len(), 1);

        // Someone else's verdict is not mine.
        let you = db.create_user("you", "", false).unwrap();
        offer(&db, you, "dz-2", "Boards of Canada", "Dayvan Cowboy");
        assert!(db.discovery_get(you, "dz-2").is_some());
    }
}

#[cfg(test)]
mod pool_threads {
    //! Why a candidate is in the pool, kept as data: which artists of the
    //! listener's it hangs off and how (`discovery_anchors`), what the pool
    //! grows FROM (`heart_weighted_artists`), and which candidates get
    //! listened to first (`discoveries_needing_work`).

    use super::*;

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-threads-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    /// A plain library row by one artist.
    fn add_track(db: &Db, rel: &str, artist: &str) -> i64 {
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES (?1,?1,?2,?2,'Al',0,0,'music')",
                params![rel, artist],
            )
            .unwrap();
        db.track_id_by_path(rel).expect("indexed")
    }

    fn offer(db: &Db, me: i64, ext: &str, artist: &str, title: &str, popularity: f64) -> bool {
        db.add_discovery(me, ext, title, artist, "", "", "https://p/preview.mp3", "seed", popularity)
            .unwrap()
    }

    /// The judged-song guard refuses a row, and a refused row must not
    /// acquire threads: `add_discovery` now SAYS whether it took the row,
    /// and anchors are written only on a yes.
    #[test]
    fn anchors_are_written_only_after_an_accepted_insert() {
        let db = fresh("guard");
        let me = db.create_user("me", "", true).unwrap();

        assert!(offer(&db, me, "dz-1", "Boards of Canada", "Roygbiv", 0.2), "a fresh offer is taken");
        db.add_discovery_anchor(me, "dz-1", "Big Thief", "deezer_related", 0.5);
        db.add_discovery_anchor(me, "dz-1", "Autechre", "lb_similar", 0.9);
        let anchors = db.discovery_anchors_for(me, "dz-1");
        assert_eq!(anchors.len(), 2);
        assert_eq!(anchors[0].0, "Autechre", "strongest thread first: {anchors:?}");
        assert_eq!(anchors[0].1, "lb_similar");

        // Re-seen from another walk: the row is refreshed (true), and the
        // same thread seen closer keeps the closer strength.
        assert!(offer(&db, me, "dz-1", "Boards of Canada", "Roygbiv", 0.3), "an upsert is still a yes");
        db.add_discovery_anchor(me, "dz-1", "Big Thief", "deezer_related", 0.8);
        db.add_discovery_anchor(me, "dz-1", "Big Thief", "deezer_related", 0.4);
        let big_thief = db
            .discovery_anchors_for(me, "dz-1")
            .into_iter()
            .find(|(a, _, _)| a == "Big Thief")
            .unwrap();
        assert!((big_thief.2 - 0.8).abs() < 1e-9, "the stronger sighting wins: {}", big_thief.2);

        // A song the listener already passed on is refused at the door.
        db.record_candidate_verdict(me, &crate::discovery::key_of("Boards of Canada", "Dayvan Cowboy"), "passed");
        assert!(!offer(&db, me, "dz-2", "Boards of Canada", "Dayvan Cowboy", 0.5), "a judged key is refused");
        assert!(db.discovery_get(me, "dz-2").is_none());
        // ... and the harvester, following the rule, writes nothing else -
        // but even one that did not would leave no thread on a row that
        // is not there once the candidate is forgotten.
        assert!(db.discovery_anchors_for(me, "dz-2").is_empty());

        // Forgetting a candidate takes its threads with it.
        db.forget_discovery(me, "dz-1");
        assert!(db.discovery_anchors_for(me, "dz-1").is_empty());
    }

    /// The seed list is what the listener SAID yes to. A heart outranks any
    /// number of play starts; a finished listen counts, quietly; a play that
    /// was merely started counts for nothing; a dismissed artist never seeds.
    #[test]
    fn seeds_come_from_hearts_before_play_counts_and_never_from_a_rejected_artist() {
        let db = fresh("seeds");
        let me = db.create_user("me", "", true).unwrap();
        let now = now_ms();

        let loved = add_track(&db, "loved.flac", "Big Thief");
        let finished = add_track(&db, "finished.flac", "Autechre");
        let started = add_track(&db, "started.flac", "Drake");
        let refused = add_track(&db, "refused.flac", "The National");

        // One heart.
        db.set_favorite(me, loved, true).unwrap();
        // Two finished listens: 0.4 each, 0.8 - still under one heart.
        let tags = (String::new(), String::new(), String::new(), String::new());
        for _ in 0..2 {
            db.insert_listen(me, finished, &tags, now, 200_000, Some(200_000), true, false, "library", &ListenShape::default())
                .unwrap();
        }
        // Five play STARTS, none finished: the old seed list's favourite.
        for _ in 0..5 {
            db.record_play(me, started).unwrap();
        }
        // Hearted AND dismissed as an artist last week: the dismiss endpoint
        // writes the pool's fold ("national", joiners dropped).
        db.set_favorite(me, refused, true).unwrap();
        db.reject_discovery(me, "artist", &crate::discovery::artist_key_public("The National"));

        let seeds: Vec<String> =
            db.heart_weighted_artists(me, 0, now).into_iter().map(|(name, _)| name).collect();
        assert_eq!(seeds, vec!["Big Thief".to_string(), "Autechre".to_string()], "{seeds:?}");
        assert!(!seeds.iter().any(|s| s == "Drake"), "play starts are not a yes");
        assert!(!seeds.iter().any(|s| s == "The National"), "a dismissed artist never seeds");

        // Somebody else's hearts are not mine.
        let you = db.create_user("you", "", false).unwrap();
        assert!(db.heart_weighted_artists(you, 0, now).is_empty());
    }

    /// Measurement used to start with the most famous candidate. The
    /// connected go first now - the sum of their threads, strongest first -
    /// and among the unconnected the least famous, so a small find is
    /// offerable before a chart row.
    #[test]
    fn work_is_ordered_connected_first_then_least_famous() {
        let db = fresh("order");
        let me = db.create_user("me", "", true).unwrap();

        assert!(offer(&db, me, "chart-hit", "Drake", "Big Hit", 0.95));
        assert!(offer(&db, me, "chart-small", "Nobody", "Small Chart Row", 0.10));
        assert!(offer(&db, me, "one-thread", "Autechre", "Tri Repetae", 0.30));
        db.add_discovery_anchor(me, "one-thread", "Boards of Canada", "lb_similar", 0.6);
        assert!(offer(&db, me, "two-threads", "Plaid", "Eyen", 0.90));
        db.add_discovery_anchor(me, "two-threads", "Boards of Canada", "lb_similar", 0.5);
        db.add_discovery_anchor(me, "two-threads", "Autechre", "deezer_related", 0.5);

        let order: Vec<String> =
            db.discoveries_needing_work(me, 10).into_iter().map(|d| d.ext_id).collect();
        assert_eq!(
            order,
            vec!["two-threads", "one-thread", "chart-small", "chart-hit"],
            "connected first, then the least famous: {order:?}"
        );

        // And what a row carries reads back: the sound and the date land on
        // the candidate for the scorer to use.
        db.set_discovery_measured(me, "one-thread", 0.7, 0.6, 0.4);
        db.set_discovery_released(me, "one-thread", "1995-11-06");
        let row = db.discovery_get(me, "one-thread").unwrap();
        assert_eq!(row.energy, Some(0.7));
        assert_eq!(row.brightness, Some(0.6));
        assert_eq!(row.rhythmic, Some(0.4));
        assert_eq!(row.released.as_deref(), Some("1995-11-06"));
        // First writer wins on the date.
        db.set_discovery_released(me, "one-thread", "2020");
        assert_eq!(db.discovery_get(me, "one-thread").unwrap().released.as_deref(), Some("1995-11-06"));
    }
}


#[cfg(test)]
mod pull_adoption_is_per_listener {
    //! `pull_adoption` is derived from completed listens and favourites
    //! rather than read off `curator_pulls.state`, because a pull row can be
    //! flipped by a promotion and the state has no room to say WHOSE gesture
    //! did it. On a one-person hub that is harmless. On a shared one it meant
    //! a housemate's listen tuned YOUR collector's spending. (Promotion
    //! itself is now owner-only - `promote_curator_track_for` - but the
    //! dial's measure stays derived, so the two never have to agree by
    //! accident.) And it is a COMPLETED listen: a bare `plays` row is a
    //! start, and a start is not adoption.

    use super::*;
    use crate::listens::{ingest, IncomingListen};

    /// One sitting on `track_id`, finished or not.
    fn listen(track_id: i64, completed: bool) -> IncomingListen {
        IncomingListen {
            track_id,
            started_at: 1_000,
            ms_listened: if completed { 180_000 } else { 8_000 },
            duration_ms: Some(200_000),
            completed,
            skipped: !completed,
            context: "test".into(),
            ended_at_ms: None,
            volume_ups: 0,
            seek_backs: 0,
            device: String::new(),
        }
    }

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-adopt-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    /// A plain library row, the way the other db tests make one.
    fn add_track(db: &Db, rel: &str) -> i64 {
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES (?1,?1,'A','A','Al',0,0,'music')",
                params![rel],
            )
            .unwrap();
        db.track_id_by_path(rel).expect("indexed")
    }

    /// Give `user` a landed pull carrying `track_id`, created far enough back
    /// to be inside the adoption window.
    fn landed_pull(db: &Db, user: i64, ext: &str, track_id: i64) -> i64 {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO curator_pulls (user_id, ext_id, kind, title, artist, url, state, created_at)
             VALUES (?1, ?2, 'track', 't', 'A', 'u', 'landed', 1)",
            params![user, ext],
        )
        .unwrap();
        let pull: i64 = conn.query_row("SELECT last_insert_rowid()", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO curator_pull_tracks (pull_id, track_id) VALUES (?1, ?2)",
            params![pull, track_id],
        )
        .unwrap();
        pull
    }

    #[test]
    fn a_housemates_listen_does_not_tune_my_collector() {
        let db = fresh("housemate");
        let me = db.create_user("me", "x", true).unwrap();
        let you = db.create_user("you", "x", false).unwrap();

        let id = add_track(&db, "song.flac");

        // We both had it pulled.
        landed_pull(&db, me, "dz-1", id);
        landed_pull(&db, you, "dz-1", id);

        // YOU play it through. That is your adoption, on any hub.
        assert_eq!(ingest(&db, you, &[listen(id, true)]), 1);
        // ...and the promotion path runs as it does after any completed play.
        // A plain library row has no owner to adopt it, so this is a no-op on
        // the track; what matters is that my dial reads the LISTENS, not this.
        db.promote_curator_track_for(id, you);

        let now = now_ms();
        assert_eq!(db.pull_adoption(you, now), (1, 1), "your own listen is your adoption");
        assert_eq!(
            db.pull_adoption(me, now),
            (0, 1),
            "my pull landed but I never touched it - it must not read as adopted"
        );

        // Now I heart it. That is mine, and it counts.
        db.set_favorite(me, id, true).unwrap();
        assert_eq!(db.pull_adoption(me, now), (1, 1), "a heart of my own is adoption");
    }

    /// A play START is not a yes. The home feed's `plays` row is written
    /// with no qualification, and the dial read it as adoption - so a song
    /// bailed on at eight seconds argued for MORE reach. Only a completed
    /// listen or a heart counts.
    #[test]
    fn a_bare_play_is_not_adoption() {
        let db = fresh("bare-play");
        let me = db.create_user("me", "x", true).unwrap();
        let started = add_track(&db, "started.flac");
        let finished = add_track(&db, "finished.flac");
        let hearted = add_track(&db, "hearted.flac");
        landed_pull(&db, me, "dz-1", started);
        landed_pull(&db, me, "dz-2", finished);
        landed_pull(&db, me, "dz-3", hearted);
        let now = now_ms();

        // A play row, and even a sitting that was bailed on: nothing.
        db.record_play(me, started).unwrap();
        assert_eq!(ingest(&db, me, &[listen(started, false)]), 1);
        assert_eq!(db.pull_adoption(me, now), (0, 3), "a start is not adoption");

        // Finishing one counts; hearting another counts.
        assert_eq!(ingest(&db, me, &[listen(finished, true)]), 1);
        assert_eq!(db.pull_adoption(me, now), (1, 3), "a completed listen is adoption");
        db.set_favorite(me, hearted, true).unwrap();
        assert_eq!(db.pull_adoption(me, now), (2, 3), "a heart is adoption");
    }
}

#[cfg(test)]
mod promotion_is_the_owners_gesture {
    //! A collector audition is adopted by the listener it was pulled for, and
    //! by nobody else. `promote_curator_track` used to take a track id alone,
    //! so any member's completed play or heart promoted somebody else's
    //! audition library-wide - onto every Home, into the DJ and New Music
    //! pools, and off the owner's own For-you shelf unheard.

    use super::*;

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-promote-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    /// An unadopted audition bought for `owner`. Stamped rev 1 so it is on
    /// the sync page for whoever is allowed to see it - a rev-0 row would be
    /// invisible to everyone and prove nothing.
    fn audition(db: &Db, owner: i64, rel: &str) -> i64 {
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind,curator_user_id,curator_promoted)
                 VALUES (?1,?1,'A','A','Al',0,1,'music',?2,0)",
                params![rel, owner],
            )
            .unwrap();
        db.track_id_by_path(rel).expect("indexed")
    }

    /// A landed pull of `user`'s carrying these tracks.
    fn landed_pull(db: &Db, user: i64, ext: &str, track_ids: &[i64]) -> i64 {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO curator_pulls (user_id, ext_id, kind, title, artist, url, state, created_at)
             VALUES (?1, ?2, 'track', 't', 'A', 'u', 'landed', 1)",
            params![user, ext],
        )
        .unwrap();
        let pull: i64 = conn.query_row("SELECT last_insert_rowid()", [], |r| r.get(0)).unwrap();
        for id in track_ids {
            conn.execute(
                "INSERT INTO curator_pull_tracks (pull_id, track_id) VALUES (?1, ?2)",
                params![pull, id],
            )
            .unwrap();
        }
        pull
    }

    fn promoted(db: &Db, id: i64) -> i64 {
        db.lock()
            .query_row(
                "SELECT COALESCE(curator_promoted, 0) FROM tracks WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn pull_state(db: &Db, pull: i64) -> String {
        db.lock()
            .query_row("SELECT state FROM curator_pulls WHERE id = ?1", params![pull], |r| r.get(0))
            .unwrap()
    }

    fn hearted(db: &Db, user: i64, id: i64) -> bool {
        db.lock()
            .query_row(
                "SELECT COUNT(*) FROM favorites WHERE user_id = ?1 AND track_id = ?2",
                params![user, id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            > 0
    }

    fn visible_to(db: &Db, uid: i64) -> Vec<String> {
        db.tracks_since(uid, 0, 100).0.into_iter().map(|t| t.title).collect()
    }

    /// The heart path - `api::set_favorite`, the Subsonic star, a settled
    /// pending like - is `set_favorite` then `promote_curator_track_for`, in
    /// that order. Bob hearts Alice's audition: his heart stands, hers stays
    /// hers. Alice hearts it: adopted, and Bob can see it at last.
    #[test]
    fn a_housemates_heart_leaves_my_audition_where_it_was() {
        let db = fresh("heart");
        let alice = db.create_user("alice", "x", true).unwrap();
        let bob = db.create_user("bob", "x", false).unwrap();
        let id = audition(&db, alice, "hers.flac");
        let pull = landed_pull(&db, alice, "dz-1", &[id]);
        assert!(visible_to(&db, alice).contains(&"hers.flac".to_string()), "she can see her own card");
        assert!(!visible_to(&db, bob).contains(&"hers.flac".to_string()), "he cannot");

        // Bob's heart - reached through a shared playlist, a direct id, a
        // Subsonic client; it does not matter how.
        db.set_favorite(bob, id, true).unwrap();
        assert!(!db.promote_curator_track_for(id, bob), "not bob's to adopt");
        assert_eq!(promoted(&db, id), 0, "still alice's audition");
        assert_eq!(pull_state(&db, pull), "landed", "her pull is still waiting on HER");
        assert!(hearted(&db, bob, id), "his favourite row stays: harmless, he is never shown it");
        assert!(
            !visible_to(&db, bob).contains(&"hers.flac".to_string()),
            "and it is still invisible to him"
        );

        // Alice's own heart is the adoption.
        db.set_favorite(alice, id, true).unwrap();
        assert!(db.promote_curator_track_for(id, alice), "the owner's heart adopts");
        assert_eq!(promoted(&db, id), 1);
        assert_eq!(pull_state(&db, pull), "promoted", "and her pull reads as landed well");
        assert!(
            visible_to(&db, bob).contains(&"hers.flac".to_string()),
            "adopted, it joins the library for everyone"
        );
    }

    /// The pull flips to 'promoted' only once EVERY track in it is adopted -
    /// the side-effect pull completion counts on - and only the owner's
    /// gestures move it there.
    #[test]
    fn the_pull_follows_the_owners_adoptions_and_nobody_elses() {
        let db = fresh("pull");
        let alice = db.create_user("alice", "x", true).unwrap();
        let bob = db.create_user("bob", "x", false).unwrap();
        let a = audition(&db, alice, "a.flac");
        let b = audition(&db, alice, "b.flac");
        let pull = landed_pull(&db, alice, "dz-album", &[a, b]);

        // Bob plays both all the way through. Nothing moves.
        assert!(!db.promote_curator_track_for(a, bob));
        assert!(!db.promote_curator_track_for(b, bob));
        assert_eq!((promoted(&db, a), promoted(&db, b)), (0, 0));
        assert_eq!(pull_state(&db, pull), "landed");

        // Alice adopts one: the pull is half-done, so still landed.
        assert!(db.promote_curator_track_for(a, alice));
        assert_eq!(pull_state(&db, pull), "landed", "one of two is not the whole pull");
        // ...and the other: now it reads as promoted.
        assert!(db.promote_curator_track_for(b, alice));
        assert_eq!(pull_state(&db, pull), "promoted");

        // A second adoption is not a second event.
        assert!(!db.promote_curator_track_for(a, alice), "already adopted");
    }

    /// A plain library row was never anybody's audition, so nobody's gesture
    /// "adopts" it - the admin's included.
    #[test]
    fn an_ordinary_track_has_no_owner_to_adopt_it() {
        let db = fresh("plain");
        let me = db.create_user("me", "x", true).unwrap();
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES ('lib.flac','lib.flac','A','A','Al',0,1,'music')",
                [],
            )
            .unwrap();
        let id = db.track_id_by_path("lib.flac").unwrap();
        assert!(!db.promote_curator_track_for(id, me));
        assert_eq!(promoted(&db, id), 0);
    }
}

#[cfg(test)]
mod home_shelves_are_per_listener {
    //! The four Home readers - artist spotlight, genre blend, the fresh row,
    //! jump-back-in - deal only what the listener is entitled to see: the
    //! shared library, adopted pulls, and their OWN pending auditions. Not a
    //! housemate's audition, and never an audiobook chapter. Same rule as
    //! `unplayed` and `tracks_since`; these were the doors that did not ask.

    use super::*;

    fn track(rel: &str, title: &str) -> ScannedTrack {
        ScannedTrack {
            rel_path: rel.into(),
            title: title.into(),
            artist: "A".into(),
            album_artist: "A".into(),
            album: "Al".into(),
            genre: "Ambient".into(),
            duration_ms: Some(200_000),
            ..Default::default()
        }
    }

    /// A library of four, all by one artist on one album in one genre, so any
    /// reader keyed on those returns all four unless the rule stops it: an
    /// ordinary song, a book chapter, alice's pending audition, and a pull of
    /// hers she already adopted. Returns (db, alice, bob).
    fn library(name: &str) -> (Db, i64, i64) {
        let d = std::env::temp_dir().join(format!("afm-shelves-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let db = Db::open(&d.join("t.sqlite")).unwrap();
        let alice = db.create_user("alice", "x", true).unwrap();
        let bob = db.create_user("bob", "x", false).unwrap();

        db.upsert_track(&track("song.flac", "Ordinary Song"), 1).unwrap();
        db.upsert_track(&track("chapter.m4b", "Chapter One"), 2).unwrap();
        db.upsert_track(&track("hers.flac", "Alices Audition"), 3).unwrap();
        db.upsert_track(&track("adopted.flac", "Adopted Pull"), 4).unwrap();
        let book = db.track_id_by_path("chapter.m4b").unwrap();
        let hers = db.track_id_by_path("hers.flac").unwrap();
        let adopted = db.track_id_by_path("adopted.flac").unwrap();
        {
            let c = db.lock();
            c.execute("UPDATE tracks SET kind = 'book' WHERE id = ?1", params![book]).unwrap();
            c.execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 0 WHERE id = ?2",
                params![alice, hers],
            )
            .unwrap();
            // Bought for alice but already adopted: ordinary library now.
            c.execute(
                "UPDATE tracks SET curator_user_id = ?1, curator_promoted = 1 WHERE id = ?2",
                params![alice, adopted],
            )
            .unwrap();
        }
        (db, alice, bob)
    }

    fn titles(db: &Db, ids: Vec<i64>) -> Vec<String> {
        ids.into_iter().filter_map(|id| db.track(id).map(|t| t.title)).collect()
    }

    /// The assertion every reader shares: bob gets the library and the
    /// adopted pull, never the book or alice's audition; alice gets hers, and
    /// not the book either.
    fn check(reader: &str, for_bob: Vec<String>, for_alice: Vec<String>) {
        let has = |v: &Vec<String>, s: &str| v.iter().any(|t| t == s);
        assert!(has(&for_bob, "Ordinary Song"), "{reader}: the plain library comes through: {for_bob:?}");
        assert!(has(&for_bob, "Adopted Pull"), "{reader}: an adopted pull is ordinary library: {for_bob:?}");
        assert!(!has(&for_bob, "Chapter One"), "{reader}: a book is not shelf material: {for_bob:?}");
        assert!(
            !has(&for_bob, "Alices Audition"),
            "{reader}: another listener's audition must never be dealt: {for_bob:?}"
        );
        assert!(has(&for_alice, "Alices Audition"), "{reader}: the buyer keeps hers: {for_alice:?}");
        assert!(has(&for_alice, "Ordinary Song"), "{reader}: and the library too: {for_alice:?}");
        assert!(!has(&for_alice, "Chapter One"), "{reader}: a chapter is not a song for her either: {for_alice:?}");
    }

    #[test]
    fn artist_spotlight_deals_only_what_is_yours() {
        let (db, alice, bob) = library("artist");
        check(
            "tracks_by_artist_for",
            titles(&db, db.tracks_by_artist_for(bob, "a", 100)),
            titles(&db, db.tracks_by_artist_for(alice, "A", 100)),
        );
    }

    #[test]
    fn genre_blend_deals_only_what_is_yours() {
        let (db, alice, bob) = library("genre");
        check(
            "tracks_by_genre_for",
            titles(&db, db.tracks_by_genre_for(bob, "ambient", 100)),
            titles(&db, db.tracks_by_genre_for(alice, "Ambient", 100)),
        );
    }

    #[test]
    fn the_fresh_row_deals_only_what_is_yours() {
        let (db, alice, bob) = library("fresh");
        check(
            "recently_added_for",
            titles(&db, db.recently_added_for(bob, 100)),
            titles(&db, db.recently_added_for(alice, 100)),
        );
    }

    /// Jump-back-in hands over whole albums. All four rows share one album,
    /// so one play of the ordinary song surfaces it - and the list that comes
    /// back must still be only what this listener may see, not "the album".
    #[test]
    fn jump_back_in_deals_only_what_is_yours() {
        let (db, alice, bob) = library("albums");
        let song = db.track_id_by_path("song.flac").unwrap();
        db.record_play(bob, song).unwrap();
        db.record_play(alice, song).unwrap();
        let flat = |uid: i64| -> Vec<String> {
            titles(&db, db.recent_album_track_lists_for(uid, 12).into_iter().flatten().collect())
        };
        check("recent_album_track_lists_for", flat(bob), flat(alice));
    }
}

#[cfg(test)]
mod dj_thumbs {
    //! A thumb is counted, and a down is remembered wherever songs are dealt.
    use super::*;

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-react-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    #[test]
    fn a_thumb_is_counted_and_a_down_is_remembered_as_a_rejection() {
        let db = fresh("thumb");
        let me = db.create_user("me", "x", true).unwrap();
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES ('s.flac','Song','Some Artist','Some Artist','Al',0,0,'music')",
                [],
            )
            .unwrap();
        let id = db.track_id_by_path("s.flac").unwrap();

        db.record_dj_reaction(me, id, "up", 40_000, 1_000);
        db.record_dj_reaction(me, id, "down", 50_000, 2_000);
        db.record_dj_reaction(me, id, "down", 60_000, 3_000);
        let tally = db.dj_reactions_since(me, 0);
        assert_eq!(tally.get(&id), Some(&(1, 2)));
        assert!(db.dj_reactions_since(me, 2_500).get(&id) == Some(&(0, 1)), "since is honoured");

        // The route's own effect, without the route: a down writes the memory.
        db.reject_discovery(me, "track", &crate::discovery::key_of("Some Artist", "Song"));
        assert!(crate::discovery::is_rejected(&db, me, "Some Artist", "Song"));
        assert!(!crate::discovery::is_rejected(&db, me, "Some Artist", "Other Song"), "the song, not the artist");
        db.reject_discovery(me, "artist", &crate::taste::artist_key("Some Artist"));
        assert!(crate::discovery::is_rejected(&db, me, "Some Artist", "Other Song"), "artist scope widens it");
    }
}

#[cfg(test)]
mod wall_of_mine {
    //! The Discover hero's wall shows a member only what they may hear.
    use super::*;

    #[test]
    fn never_another_members_unadopted_audition_and_never_a_book() {
        let d = std::env::temp_dir().join(format!("afm-wall-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let db = Db::open(&d.join("t.sqlite")).unwrap();
        let me = db.create_user("me", "x", true).unwrap();
        let other = db.create_user("other", "x", false).unwrap();
        let mut add = |rel: &str, art: &str, kind: &str, owner: Option<i64>, promoted: bool| {
            db.lock()
                .execute(
                    "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind,
                                         art_id,curator_user_id,curator_promoted)
                     VALUES (?1,?1,'A','A','Al',0,0,?2,?3,?4,?5)",
                    rusqlite::params![rel, kind, art, owner, promoted as i64],
                )
                .unwrap();
            db.track_id_by_path(rel).unwrap()
        };
        let plain = add("p.flac", "art-plain", "music", None, false);
        let mine = add("m.flac", "art-mine", "music", Some(me), false);
        let theirs = add("t.flac", "art-theirs", "music", Some(other), false);
        let promoted = add("q.flac", "art-promoted", "music", Some(other), true);
        let book = add("b.m4b", "art-book", "book", None, false);

        let mut art = db.random_art_ids_for(me, 100);
        art.sort();
        assert_eq!(art, vec!["art-mine", "art-plain", "art-promoted"]);
        let mut ids = db.random_track_ids_for(me, 100);
        ids.sort();
        let mut want = vec![plain, mine, promoted];
        want.sort();
        assert_eq!(ids, want, "not {theirs} (another's pull) nor {book} (a book)");

        // The public wall still glances at the whole box - that is its job.
        assert_eq!(db.random_art_ids(100).len(), 5);
    }
}

#[cfg(test)]
mod trending_shelves {
    //! "Rising" as a comparison between two snapshots, and "friends on this
    //! hub" as friends only - never the other members, never what you met.

    use super::*;
    use crate::listens::{ingest, IncomingListen};

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-trend-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    fn row(e: &str, a: &str, rank: f64) -> (String, String, f64) {
        (e.into(), a.into(), rank)
    }

    #[test]
    fn a_rise_is_places_climbed_and_a_debut_climbs_from_the_bottom() {
        let db = fresh("rise");
        let day = 86_400_000;
        db.snapshot_chart(1_000 * day, &[row("a", "x", 1.0), row("b", "y", 5.0)]);
        // One snapshot: nothing to compare, nothing rises.
        assert!(db.chart_rank_deltas().values().all(|(_, _, d)| *d == 0.0));

        db.snapshot_chart(1_008 * day, &[row("a", "x", 3.0), row("b", "y", 2.0), row("c", "z", 1.0)]);
        let d = db.chart_rank_deltas();
        assert_eq!(d["a"].2, -2.0, "slipped two places");
        assert_eq!(d["b"].2, 3.0, "climbed three");
        assert_eq!(d["c"].2, 3.0, "a debut at #1 on a chart of three climbed from just below #3");
        assert_eq!(d["c"].0, "z");
        assert_eq!(d["a"].1, 3.0);
    }

    #[test]
    fn old_snapshots_are_pruned() {
        let db = fresh("prune");
        let day = 86_400_000;
        db.snapshot_chart(1_000 * day, &[row("a", "x", 1.0)]);
        db.snapshot_chart(1_040 * day, &[row("a", "x", 1.0)]);
        let n: i64 = db
            .lock()
            .query_row("SELECT COUNT(DISTINCT fetched_at) FROM chart_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "five weeks is the memory");
    }

    fn track(db: &Db, rel: &str, kind: &str, owner: Option<i64>, promoted: bool) -> i64 {
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind,
                                     curator_user_id,curator_promoted)
                 VALUES (?1,?1,'A','A','Al',0,0,?2,?3,?4)",
                rusqlite::params![rel, kind, owner, promoted as i64],
            )
            .unwrap();
        db.track_id_by_path(rel).unwrap()
    }

    fn done(track_id: i64, at: i64) -> IncomingListen {
        IncomingListen {
            track_id,
            started_at: at,
            ms_listened: 180_000,
            duration_ms: Some(200_000),
            completed: true,
            skipped: false,
            context: "test".into(),
            ended_at_ms: None,
            volume_ups: 0,
            seek_backs: 0,
            device: String::new(),
        }
    }

    #[test]
    fn friends_only_and_never_what_you_met() {
        let db = fresh("friends");
        let me = db.create_user("me", "x", true).unwrap();
        let friend = db.create_user("ana", "x", false).unwrap();
        let stranger = db.create_user("stranger", "x", false).unwrap();
        let other = db.create_user("other", "x", false).unwrap();
        db.lock()
            .execute("INSERT INTO friendships (a_id, b_id, since) VALUES (?1, ?2, 0)", [friend, me])
            .unwrap();

        let fresh_song = track(&db, "1.flac", "music", None, false);
        let met = track(&db, "2.flac", "music", None, false);
        let others_audition = track(&db, "3.flac", "music", Some(other), false);
        let book = track(&db, "4.m4b", "book", None, false);
        let promoted = track(&db, "5.flac", "music", Some(other), true);

        let t = 1_000_000;
        ingest(&db, me, &[done(met, t)]);
        ingest(&db, friend, &[done(fresh_song, t + 1), done(met, t + 2), done(others_audition, t + 3), done(book, t + 4), done(promoted, t + 5)]);
        ingest(&db, stranger, &[done(fresh_song, t + 6)]);

        let got = db.friends_completed_since(me, 0);
        let ids: Vec<i64> = got.iter().map(|p| p.track_id).collect();
        assert_eq!(ids, vec![promoted, fresh_song], "{got:?}");
        let f = got.iter().find(|p| p.track_id == fresh_song).unwrap();
        assert_eq!(f.completions, 1, "the stranger's completion is not counted");
        assert_eq!(f.listeners, vec!["ana".to_string()]);
        assert_eq!(f.last_at, t + 1);

        // A friendship is one row, read from either side: what I finish that
        // Ana has not met shows up for her - and `met`, which we both
        // finished, does not.
        let mine_only = track(&db, "6.flac", "music", None, false);
        ingest(&db, me, &[done(mine_only, t + 7)]);
        let hers: Vec<i64> = db.friends_completed_since(friend, 0).iter().map(|p| p.track_id).collect();
        assert_eq!(hers, vec![mine_only], "one row, either side; the shared song is hidden");
    }
}

#[cfg(test)]
mod seeds_from_hearts {
    //! What the pool grows FROM. Hearts and keeps outrank play counts, a
    //! dismissed artist never seeds, and a book never does either.

    use super::*;
    use crate::listens::{ingest, IncomingListen};

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-seeds-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    fn track(db: &Db, rel: &str, artist: &str, kind: &str) -> i64 {
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES (?1,?1,?2,?2,'Al',0,0,?3)",
                rusqlite::params![rel, artist, kind],
            )
            .unwrap();
        db.track_id_by_path(rel).unwrap()
    }

    fn finished(track_id: i64, started_at: i64) -> IncomingListen {
        IncomingListen {
            track_id,
            started_at,
            ms_listened: 180_000,
            duration_ms: Some(200_000),
            completed: true,
            skipped: false,
            context: "test".into(),
            ended_at_ms: None,
            volume_ups: 0,
            seek_backs: 0,
            device: String::new(),
        }
    }

    #[test]
    fn hearts_outrank_play_counts_and_the_dismissed_never_seed() {
        let db = fresh("rank");
        let me = db.create_user("me", "x", true).unwrap();
        let now = now_ms();
        let hearted = track(&db, "h.flac", "Big Thief", "music");
        let played = track(&db, "p.flac", "Someone Loud", "music");
        let dismissed = track(&db, "d.flac", "Never Again", "music");
        let book = track(&db, "b.m4b", "A Narrator", "book");

        db.set_favorite(me, hearted, true).unwrap();
        // Two finished plays of the loud one - 0.8 in total, under one heart.
        assert_eq!(ingest(&db, me, &[finished(played, now - 1_000), finished(played, now - 2_000)]), 2);
        // A heart on the dismissed one, then the dismissal: the heart is moot.
        db.set_favorite(me, dismissed, true).unwrap();
        db.reject_discovery(me, "artist", &crate::taste::artist_key("Never Again"));
        // A finished audiobook chapter is not a music seed.
        assert_eq!(ingest(&db, me, &[finished(book, now - 3_000)]), 1);

        let seeds = db.heart_weighted_artists(me, 0, now);
        let names: Vec<&str> = seeds.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["Big Thief", "Someone Loud"], "{seeds:?}");
        assert!(seeds[0].1 > seeds[1].1, "one heart outweighs two finished plays: {seeds:?}");
        assert!((seeds[1].1 - 0.8).abs() < 0.01, "two completed listens at 0.4 each: {seeds:?}");
    }

    #[test]
    fn a_date_keep_is_a_heart_and_old_evidence_fades() {
        let db = fresh("keep");
        let me = db.create_user("me", "x", true).unwrap();
        let now = now_ms();
        let kept = track(&db, "k.flac", "Kept Artist", "music");
        let passed = track(&db, "x.flac", "Passed Artist", "music");
        db.record_date_verdict(me, kept, "kept");
        db.record_date_verdict(me, passed, "passed");
        let seeds = db.heart_weighted_artists(me, 0, now);
        assert_eq!(seeds.len(), 1, "a pass is not a seed: {seeds:?}");
        assert_eq!(seeds[0].0, "Kept Artist");
        assert!((seeds[0].1 - 1.0).abs() < 0.01);

        // The same keep seen from sixty days later weighs half.
        let later = db.heart_weighted_artists(me, 0, now + 60 * 86_400_000);
        assert!((later[0].1 - 0.5).abs() < 0.02, "{later:?}");
    }
}

#[cfg(test)]
mod listen_shape {
    //! The four things a sitting can now say beyond how long it lasted: where
    //! it ended, whether the dial went up, whether they rewound, and where it
    //! was heard. Plus the query that turns "came back to it" into a number.

    use super::*;
    use crate::listens::{ingest, IncomingListen, RecordBody};

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-shape-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    fn track(db: &Db, rel: &str) -> i64 {
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES (?1,?1,'A','A','Al',0,0,'music')",
                rusqlite::params![rel],
            )
            .unwrap();
        db.track_id_by_path(rel).unwrap()
    }

    fn event(track_id: i64, started_at: i64, ms: i64, skipped: bool) -> IncomingListen {
        IncomingListen {
            track_id,
            started_at,
            ms_listened: ms,
            duration_ms: Some(200_000),
            completed: false,
            skipped,
            context: "test".into(),
            ended_at_ms: Some(87_500),
            volume_ups: 2,
            seek_backs: 1,
            device: "iPhone/car".into(),
        }
    }

    #[test]
    fn the_shape_lands_on_the_row() {
        let db = fresh("lands");
        let me = db.create_user("me", "x", true).unwrap();
        let id = track(&db, "a.flac");
        assert_eq!(ingest(&db, me, &[event(id, 1_000, 60_000, false)]), 1);
        let row: (Option<i64>, i64, i64, String) = db
            .lock()
            .query_row(
                "SELECT ended_at_ms, volume_ups, seek_backs, device FROM listen_events WHERE user_id = ?1",
                [me],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row, (Some(87_500), 2, 1, "iPhone/car".to_string()));
    }

    /// An older client sends none of it; the row still lands, defaulted.
    #[test]
    fn an_old_client_still_lands() {
        let db = fresh("old");
        let me = db.create_user("me", "x", true).unwrap();
        let id = track(&db, "a.flac");
        let body: RecordBody = serde_json::from_str(&format!(
            r#"{{"events":[{{"trackId":{id},"startedAt":1000,"msListened":60000,"completed":false,"skipped":false,"context":""}}]}}"#
        ))
        .unwrap();
        assert_eq!(ingest(&db, me, &body.events), 1);
        let row: (Option<i64>, i64, String) = db
            .lock()
            .query_row(
                "SELECT ended_at_ms, volume_ups, device FROM listen_events WHERE user_id = ?1",
                [me],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (None, 0, String::new()));
    }

    /// Coming back to a song inside the window counts; bailing on it twice
    /// does not - and it is mine, not the hub's.
    #[test]
    fn repeats_count_returns_not_bails() {
        let db = fresh("repeats");
        let me = db.create_user("me", "x", true).unwrap();
        let you = db.create_user("you", "x", false).unwrap();
        let loved = track(&db, "loved.flac");
        let bailed = track(&db, "bailed.flac");
        let once = track(&db, "once.flac");
        let now = 1_000_000_000i64;
        let day = 86_400_000;
        ingest(&db, me, &[
            event(loved, now - 6 * day, 150_000, false),
            event(loved, now - 2 * day, 150_000, false),
            event(loved, now - 1 * day, 150_000, false),
            event(bailed, now - 3 * day, 12_000, true),
            event(bailed, now - 2 * day, 11_000, true),
            event(once, now - 1 * day, 150_000, false),
            // Outside the window: does not count.
            event(once, now - 20 * day, 150_000, false),
        ]);
        // Somebody else returning to it is their taste, not mine.
        ingest(&db, you, &[event(bailed, now - 2 * day, 150_000, false), event(bailed, now - 1 * day, 150_000, false)]);

        let mine = db.recent_repeats(me, now - 7 * day);
        assert_eq!(mine.get(&loved), Some(&3), "three returns in a week");
        assert!(!mine.contains_key(&bailed), "two bails are not two returns: {mine:?}");
        assert!(!mine.contains_key(&once), "one listen in the window is not a return");
        let theirs = db.recent_repeats(you, now - 7 * day);
        assert_eq!(theirs.get(&bailed), Some(&2), "and theirs is theirs");
    }
}

#[cfg(test)]
mod explore_ledger_skip_semantics {
    //! The listener's own rule for the exploration sampler: under ten seconds
    //! says nothing, and staying for most of a song is a yes. A four-second
    //! bail used to be an offer FAILURE for the artist and, worse, a meeting
    //! that retired them from exploration for good.

    use super::*;

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-explore-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    fn track(db: &Db, rel: &str, artist: &str) -> i64 {
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES (?1,?1,?2,?2,'Al',0,0,'music')",
                rusqlite::params![rel, artist],
            )
            .unwrap();
        db.track_id_by_path(rel).unwrap()
    }

    fn sat(db: &Db, user: i64, track_id: i64, artist: &str, at: i64, ms: i64, completed: bool) {
        db.insert_listen(
            user,
            track_id,
            &("t".into(), artist.into(), "Al".into(), String::new()),
            at,
            ms,
            Some(200_000),
            completed,
            !completed && ms < 30_000,
            "booth",
            &ListenShape::default(),
        )
        .unwrap();
    }

    fn stats_for(db: &Db, user: i64, artist: &str) -> Option<(i64, i64)> {
        db.explore_artist_stats(user)
            .into_iter()
            .find(|(a, _, _)| a == artist)
            .map(|(_, offers, adopted)| (offers, adopted))
    }

    #[test]
    fn a_four_second_bail_is_neither_a_failure_nor_an_adoption() {
        let db = fresh("bail");
        let me = db.create_user("me", "x", true).unwrap();
        let id = track(&db, "new.flac", "stranger");
        db.record_dj_impressions(me, &[(id, "explore", 3)]);
        let offered_at = now_ms();
        sat(&db, me, id, "stranger", offered_at + 1_000, 4_000, false);

        let (offers, adopted) = stats_for(&db, me, "stranger").unwrap_or((0, 0));
        assert_eq!((offers, adopted), (0, 0), "a mis-tap is not an offer the artist failed");
    }

    #[test]
    fn staying_for_six_tenths_is_an_adoption_and_leaving_early_is_not() {
        let db = fresh("sixty");
        let me = db.create_user("me", "x", true).unwrap();
        let stayed = track(&db, "stayed.flac", "kept");
        let left = track(&db, "left.flac", "dropped");
        db.record_dj_impressions(me, &[(stayed, "explore", 3), (left, "rank", 4)]);
        let offered_at = now_ms();
        // 60% of a 200s track, never marked completed.
        sat(&db, me, stayed, "kept", offered_at + 1_000, 120_000, false);
        // A real skip: past the mis-tap line, nowhere near the end.
        sat(&db, me, left, "dropped", offered_at + 1_000, 25_000, false);

        assert_eq!(stats_for(&db, me, "kept"), Some((1, 1)), "most of the song heard is a yes");
        assert_eq!(stats_for(&db, me, "dropped"), Some((1, 0)), "a real skip is still a no");
    }

    /// The thumbs (reactions.rs) reach the sampler: an up after the offer is
    /// an adoption even with no listen behind it, and a down is a louder
    /// failure than a plain skip - the Beta's `b` moves by three where a skip
    /// moves it by one.
    #[test]
    fn a_thumb_up_adopts_and_a_thumb_down_is_louder_than_a_skip() {
        let db = fresh("thumbs");
        let me = db.create_user("me", "x", true).unwrap();
        let liked = track(&db, "liked.flac", "thumbed up");
        let refused = track(&db, "refused.flac", "thumbed down");
        let skipped = track(&db, "skipped.flac", "merely skipped");
        db.record_dj_impressions(me, &[(liked, "explore", 3), (refused, "explore", 10), (skipped, "rank", 4)]);
        let offered_at = now_ms();
        db.record_dj_reaction(me, liked, "up", 20_000, offered_at + 1_000);
        db.record_dj_reaction(me, refused, "down", 20_000, offered_at + 1_000);
        // The refused one was even heard past the mis-tap line first.
        sat(&db, me, refused, "thumbed down", offered_at + 500, 25_000, false);
        sat(&db, me, skipped, "merely skipped", offered_at + 500, 25_000, false);

        assert_eq!(stats_for(&db, me, "thumbed up"), Some((1, 1)), "an up is an adoption");
        let (down_offers, down_adopted) = stats_for(&db, me, "thumbed down").unwrap();
        let (skip_offers, skip_adopted) = stats_for(&db, me, "merely skipped").unwrap();
        assert_eq!((down_adopted, skip_adopted), (0, 0));
        assert!(
            down_offers - down_adopted > skip_offers - skip_adopted,
            "a thumb down fails the artist harder than a skip: {down_offers} vs {skip_offers}"
        );
        assert_eq!(down_offers, 3, "one for the offer, two on top");

        // A thumb given BEFORE the offer is about some other sitting.
        let earlier = track(&db, "earlier.flac", "thumbed earlier");
        db.record_dj_reaction(me, earlier, "up", 0, offered_at - 10_000);
        db.record_dj_impressions(me, &[(earlier, "explore", 3)]);
        assert_eq!(stats_for(&db, me, "thumbed earlier"), Some((1, 0)), "the offer stands unanswered");
    }

    #[test]
    fn a_mistap_does_not_retire_an_artist_from_exploration() {
        let db = fresh("retire");
        let me = db.create_user("me", "x", true).unwrap();
        let slipped = track(&db, "slip.flac", "Slipped On");
        let heard = track(&db, "heard.flac", "Actually Heard");
        let done = track(&db, "done.flac", "Finished Fast");
        sat(&db, me, slipped, "Slipped On", 1_000, 4_000, false);
        sat(&db, me, heard, "Actually Heard", 2_000, 12_000, false);
        // A completed sitting counts however short - a short track.
        sat(&db, me, done, "Finished Fast", 3_000, 6_000, true);

        let met = db.played_artist_keys(me);
        assert!(!met.contains("slipped on"), "a thumb slipping is not a meeting: {met:?}");
        assert!(met.contains("actually heard"), "twelve seconds is");
        assert!(met.contains("finished fast"), "and so is finishing");
    }
}

#[cfg(test)]
mod playlist_activity {
    //! Who is told what about a shared list. The rows are cheap; the feature
    //! is the visibility - a member hearing about a private list, or about
    //! their own add, or about history from before they joined, is the bug.

    use super::*;

    fn fresh(name: &str) -> Db {
        let d = std::env::temp_dir().join(format!("afm-plact-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Db::open(&d.join("t.sqlite")).unwrap()
    }

    fn track(db: &Db, rel: &str, title: &str) -> i64 {
        db.lock()
            .execute(
                "INSERT INTO tracks (rel_path,title,artist,album_artist,album,added_at,rev,kind)
                 VALUES (?1,?2,'Fleetwood Mac','Fleetwood Mac','Rumours',0,0,'music')",
                rusqlite::params![rel, title],
            )
            .unwrap();
        db.track_id_by_path(rel).unwrap()
    }

    /// The newest row's id - what the route never needs but a test does.
    fn last_id(db: &Db) -> i64 {
        db.lock()
            .query_row("SELECT MAX(id) FROM playlist_activity", [], |r| r.get(0))
            .unwrap()
    }

    /// Pin a row's clock, so ordering and "before they joined" are exact
    /// rather than a race against the millisecond.
    fn set_at(db: &Db, id: i64, at: i64) {
        db.lock()
            .execute("UPDATE playlist_activity SET at = ?2 WHERE id = ?1", params![id, at])
            .unwrap();
    }

    fn set_joined(db: &Db, playlist: i64, user: i64, at: i64) {
        db.lock()
            .execute(
                "UPDATE playlist_members SET added_at = ?3 WHERE playlist_id = ?1 AND user_id = ?2",
                params![playlist, user, at],
            )
            .unwrap();
    }

    fn kinds(rows: &[PlaylistActivityRow]) -> Vec<&str> {
        rows.iter().map(|r| r.kind.as_str()).collect()
    }

    /// Owner + a shared list + two friends let in as editors.
    struct Scene {
        db: Db,
        owner: i64,
        ana: i64,
        ben: i64,
        list: i64,
    }

    fn scene(name: &str) -> Scene {
        let db = fresh(name);
        let owner = db.create_user("matt", "x", true).unwrap();
        let ana = db.create_user("ana", "x", false).unwrap();
        let ben = db.create_user("ben", "x", false).unwrap();
        let list = db.create_playlist(owner, "Late shift").unwrap();
        Scene { db, owner, ana, ben, list }
    }

    fn share(s: &Scene, who: i64) {
        assert!(s.db.playlist_member_put(s.list, who, "editor").unwrap(), "first share is new");
        assert!(s.db.playlist_activity_record(s.list, s.owner, "shared", Some(who), None).unwrap());
    }

    fn add(s: &Scene, who: i64, track_id: i64) -> bool {
        assert!(s.db.playlist_append_track(s.list, track_id).unwrap());
        s.db.playlist_activity_record(s.list, who, "added", None, Some(track_id)).unwrap()
    }

    #[test]
    fn a_share_is_news_to_the_one_invited_and_nobody_else() {
        let s = scene("share");
        let stranger = s.db.create_user("cat", "x", false).unwrap();
        share(&s, s.ana);
        share(&s, s.ben);

        let ana = s.db.playlist_activity_for(s.ana, 0, 50);
        assert_eq!(kinds(&ana), vec!["shared"], "{ana:?}");
        assert_eq!(ana[0].playlist_name, "Late shift");
        assert_eq!(ana[0].owner_name, "matt");
        assert_eq!(ana[0].actor_name, "matt");
        assert_eq!(ana[0].actor_id, s.owner);
        // Ben hears about HIS invite only, not Ana's.
        let ben = s.db.playlist_activity_for(s.ben, 0, 50);
        assert_eq!(ben.len(), 1, "{ben:?}");
        // Someone on the hub but not on the list hears nothing.
        assert!(s.db.playlist_activity_for(stranger, 0, 50).is_empty());
        // The owner made both shares: their own doing is not their news.
        assert!(s.db.playlist_activity_for(s.owner, 0, 50).is_empty());
    }

    #[test]
    fn an_editors_add_reaches_the_owner_and_the_others_but_not_the_editor() {
        let s = scene("add");
        share(&s, s.ana);
        share(&s, s.ben);
        let dreams = track(&s.db, "dreams.flac", "Dreams");
        assert!(add(&s, s.ana, dreams));

        let owner = s.db.playlist_activity_for(s.owner, 0, 50);
        assert_eq!(kinds(&owner), vec!["added"], "{owner:?}");
        assert_eq!(owner[0].actor_name, "ana");
        assert_eq!(owner[0].track_id, Some(dreams));
        assert_eq!(
            s.db.track_caption(dreams),
            Some(("Dreams".to_string(), "Fleetwood Mac".to_string(), None))
        );
        let ben = s.db.playlist_activity_for(s.ben, 0, 50);
        assert_eq!(kinds(&ben), vec!["added", "shared"], "{ben:?}");
        // Ana added it: her own add is not news to her, only her invite is.
        let ana = s.db.playlist_activity_for(s.ana, 0, 50);
        assert_eq!(kinds(&ana), vec!["shared"], "{ana:?}");
    }

    #[test]
    fn a_newcomer_is_not_told_the_history_from_before_they_joined() {
        let s = scene("late");
        let now = now_ms();
        share(&s, s.ana);
        let early = track(&s.db, "early.flac", "Go Your Own Way");
        assert!(add(&s, s.ana, early));
        set_at(&s.db, last_id(&s.db), now - 10_000);

        // Ben arrives after that add, then Ana adds again.
        share(&s, s.ben);
        set_joined(&s.db, s.list, s.ben, now - 5_000);
        set_at(&s.db, last_id(&s.db), now - 5_000);
        let later = track(&s.db, "later.flac", "The Chain");
        assert!(add(&s, s.ana, later));
        set_at(&s.db, last_id(&s.db), now);

        let ben = s.db.playlist_activity_for(s.ben, 0, 50);
        assert_eq!(kinds(&ben), vec!["added", "shared"], "{ben:?}");
        assert_eq!(ben[0].track_id, Some(later), "only the add since he joined: {ben:?}");
        // The owner has always been there: both adds.
        let owner = s.db.playlist_activity_for(s.owner, 0, 50);
        let tracks: Vec<_> = owner.iter().filter_map(|r| r.track_id).collect();
        assert_eq!(tracks, vec![later, early], "{owner:?}");
    }

    #[test]
    fn your_own_adds_are_never_news_and_a_stranger_hears_nothing() {
        let s = scene("own");
        let stranger = s.db.create_user("cat", "x", false).unwrap();
        share(&s, s.ana);
        let mine = track(&s.db, "mine.flac", "Songbird");
        assert!(add(&s, s.owner, mine));
        let hers = track(&s.db, "hers.flac", "Gold Dust Woman");
        assert!(add(&s, s.ana, hers));

        let owner = s.db.playlist_activity_for(s.owner, 0, 50);
        assert_eq!(owner.iter().filter_map(|r| r.track_id).collect::<Vec<_>>(), vec![hers], "{owner:?}");
        let ana = s.db.playlist_activity_for(s.ana, 0, 50);
        assert_eq!(ana.iter().filter_map(|r| r.track_id).collect::<Vec<_>>(), vec![mine], "{ana:?}");
        // Rows exist; none of them are the stranger's to see.
        let n: i64 = s.db.lock().query_row("SELECT COUNT(*) FROM playlist_activity", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
        assert!(s.db.playlist_activity_for(stranger, 0, 50).is_empty());
    }

    #[test]
    fn a_private_lists_edits_are_nobodys_news_until_it_is_shared() {
        let s = scene("private");
        let one = track(&s.db, "one.flac", "Never Going Back Again");
        assert!(!add(&s, s.owner, one), "no members: no row");
        assert!(
            !s.db.playlist_activity_record(s.list, s.owner, "removed", None, Some(one)).unwrap(),
            "a remove on a private list is no row either"
        );
        let n: i64 = s.db.lock().query_row("SELECT COUNT(*) FROM playlist_activity", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);

        share(&s, s.ana);
        let two = track(&s.db, "two.flac", "You Make Loving Fun");
        assert!(add(&s, s.owner, two), "shared now: the add is news");
        let ana = s.db.playlist_activity_for(s.ana, 0, 50);
        assert_eq!(kinds(&ana), vec!["added", "shared"], "{ana:?}");
        assert_eq!(ana[0].track_id, Some(two));
    }

    #[test]
    fn since_and_limit_are_honoured_newest_first() {
        let s = scene("window");
        let now = now_ms();
        share(&s, s.ana);
        set_at(&s.db, last_id(&s.db), now - 40_000);
        let mut ids = Vec::new();
        for (i, rel) in ["a.flac", "b.flac", "c.flac"].iter().enumerate() {
            let t = track(&s.db, rel, rel);
            assert!(add(&s, s.ana, t));
            // Inserted in order a, b, c at 30s, 20s, 10s ago.
            set_at(&s.db, last_id(&s.db), now - (30_000 - 10_000 * i as i64));
            ids.push(t);
        }
        let all = s.db.playlist_activity_for(s.owner, 0, 50);
        let order: Vec<_> = all.iter().filter_map(|r| r.track_id).collect();
        assert_eq!(order, vec![ids[2], ids[1], ids[0]], "newest first: {all:?}");
        assert!(all.windows(2).all(|w| w[0].at >= w[1].at));

        let recent = s.db.playlist_activity_for(s.owner, now - 20_000, 50);
        let order: Vec<_> = recent.iter().filter_map(|r| r.track_id).collect();
        assert_eq!(order, vec![ids[2], ids[1]], "at or after since: {recent:?}");

        let one = s.db.playlist_activity_for(s.owner, 0, 1);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].track_id, Some(ids[2]), "limit keeps the newest: {one:?}");
    }

    #[test]
    fn a_leave_is_the_owners_news_and_being_shown_out_is_the_targets() {
        let s = scene("gone");
        share(&s, s.ana);
        share(&s, s.ben);
        // Ana lets herself out.
        assert!(s.db.playlist_member_remove(s.list, s.ana).unwrap());
        assert!(s.db.playlist_activity_record(s.list, s.ana, "left", Some(s.ana), None).unwrap());
        let owner = s.db.playlist_activity_for(s.owner, 0, 50);
        assert_eq!(kinds(&owner), vec!["left"], "{owner:?}");
        assert_eq!(owner[0].actor_name, "ana");
        // Ben is still on the list; somebody else leaving is not his news,
        // and it is not Ana's own news either.
        assert_eq!(kinds(&s.db.playlist_activity_for(s.ben, 0, 50)), vec!["shared"]);
        assert!(s.db.playlist_activity_for(s.ana, 0, 50).is_empty(), "her invite went with her");

        // The owner shows Ben out.
        assert!(s.db.playlist_member_remove(s.list, s.ben).unwrap());
        assert!(!s.db.playlist_member_remove(s.list, s.ben).unwrap(), "already gone");
        assert!(s.db.playlist_activity_record(s.list, s.owner, "unshared", Some(s.ben), None).unwrap());
        let ben = s.db.playlist_activity_for(s.ben, 0, 50);
        assert_eq!(kinds(&ben), vec!["unshared"], "no longer a member, but told so: {ben:?}");
        assert_eq!(ben[0].actor_name, "matt");
        // The owner did it: not their news.
        assert_eq!(kinds(&s.db.playlist_activity_for(s.owner, 0, 50)), vec!["left"]);
    }

    #[test]
    fn a_promotion_is_not_a_second_invite_and_old_rows_are_pruned() {
        let s = scene("prune");
        share(&s, s.ana);
        assert!(!s.db.playlist_member_put(s.list, s.ana, "viewer").unwrap(), "already in: a role change");
        assert_eq!(s.db.playlist_role(s.list, s.ana).as_deref(), Some("viewer"));
        // Push the invite past sixty days; the next write sweeps it.
        set_at(&s.db, last_id(&s.db), now_ms() - 61 * 86_400_000);
        let t = track(&s.db, "t.flac", "Second Hand News");
        assert!(add(&s, s.ana, t));
        let n: i64 = s.db.lock().query_row("SELECT COUNT(*) FROM playlist_activity", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the stale share is gone, the add remains");
    }
}
