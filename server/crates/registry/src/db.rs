//! The registry's store: one SQLite file, opened once and guarded by a mutex.
//!
//! Small by design. The registry holds identity and the edges between people -
//! accounts, the devices that speak for them, the friendships, the invites in
//! flight, and a cached glance of each library's size. It never holds a note of
//! music: that lives on the servers. Keeping it lean is what lets it be the one
//! always-up thing every server leans on.

use rusqlite::{Connection, OptionalExtension};
use std::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
}

/// One account in the directory.
#[derive(Debug, Clone)]
pub struct Account {
    pub id: i64,
    pub handle: String,
    /// Argon2 hash, or empty for a passwordless (device-key only) account.
    pub pass_hash: String,
    pub created_at: i64,
}

/// A friend, with the glance of their library a friends list shows.
#[derive(Debug, Clone)]
pub struct Friend {
    pub id: i64,
    pub handle: String,
    pub server_url: String,
    pub seen_at: i64,
    pub songs: i64,
    pub playlists: i64,
    pub artists: i64,
    /// The listening glance - zeros/empty when never shared or gone stale.
    pub week_minutes: i64,
    pub week_top_artist: String,
    pub streak_days: i64,
    pub listened_at: i64,
}

/// A friend request in flight, from the answering side's point of view.
#[derive(Debug, Clone)]
pub struct PendingRequest {
    pub id: i64,
    pub account_id: i64,
    pub handle: String,
}

/// An invitation to join one server.
#[derive(Debug, Clone)]
pub struct Invite {
    pub code: String,
    pub server_url: String,
    pub server_name: String,
    pub created_by: i64,
    pub role: String,
    pub expires_at: i64,
    pub redeemed_by: Option<i64>,
    /// How many distinct accounts may redeem it (1 = one-time; ignored when
    /// standing, which is unlimited).
    pub max_uses: i64,
    /// How many distinct accounts already have - the live tally against
    /// max_uses, counted from invite_redemptions.
    pub uses_count: i64,
}

/// A server an account belongs to (or has asked to).
#[derive(Debug, Clone)]
pub struct Membership {
    pub server_url: String,
    /// The server's own name, as the device last saw it. Display only - it is
    /// whatever that box called itself, not a claim the registry vouches for.
    pub name: String,
    pub role: String,
    pub state: String,
    pub since: i64,
}

impl Db {
    pub fn open(path: &std::path::Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;

        // Columns that postdate the deployed registry.sqlite3 - CREATE IF NOT
        // EXISTS never retrofits a column, so each is checked and added here.
        {
            let have: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info('stats')")?
                .query_map([], |r| r.get(0))?
                .filter_map(Result::ok)
                .collect();
            for (name, decl) in [
                ("week_minutes", "week_minutes INTEGER NOT NULL DEFAULT 0"),
                ("week_top_artist", "week_top_artist TEXT NOT NULL DEFAULT ''"),
                ("streak_days", "streak_days INTEGER NOT NULL DEFAULT 0"),
                ("listened_at", "listened_at INTEGER NOT NULL DEFAULT 0"),
            ] {
                if !have.iter().any(|c| c == name) {
                    conn.execute(&format!("ALTER TABLE stats ADD COLUMN {decl}"), [])?;
                }
            }
        }
        // Same retrofit for memberships: `name` arrived with cloud-saved
        // server lists, and every registry predating that has rows without it.
        {
            let have: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info('memberships')")?
                .query_map([], |r| r.get(0))?
                .filter_map(Result::ok)
                .collect();
            if !have.iter().any(|c| c == "name") {
                conn.execute("ALTER TABLE memberships ADD COLUMN name TEXT NOT NULL DEFAULT ''", [])?;
            }
        }
        // And for invites: max_uses arrived with multi-use codes. A registry
        // that predates it has invite rows without the column; the new
        // invite_redemptions TABLE lands via execute_batch(SCHEMA) above, but a
        // new COLUMN does not, so it is retrofitted here. DEFAULT 1 keeps every
        // existing invite exactly as single-use as it was.
        {
            let have: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info('invites')")?
                .query_map([], |r| r.get(0))?
                .filter_map(Result::ok)
                .collect();
            if !have.iter().any(|c| c == "max_uses") {
                conn.execute("ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1", [])?;
                // Backfill the ledger from history. Every code already redeemed
                // before this upgrade has a redeemed_by but no ledger row, and
                // the cap is now counted FROM the ledger - so without this a
                // spent one-time code reads as uses_count 0 of 1 and would let a
                // second person in. One row per past redemption restores the
                // count. Runs once, in the same breath as the column it repairs.
                conn.execute(
                    "INSERT OR IGNORE INTO invite_redemptions (code, account_id, redeemed_at)
                     SELECT code, redeemed_by, COALESCE(redeemed_at, created_at)
                     FROM invites WHERE redeemed_by IS NOT NULL",
                    [],
                )?;
            }
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// The registry's own signing secret, persisted so tokens survive a restart.
    /// Stored here rather than in a config file so the key and the accounts it
    /// vouches for share one backup.
    pub fn meta_get(&self, key: &str) -> Option<String> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn meta_set(&self, key: &str, value: &str) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        );
    }

    // --- accounts ------------------------------------------------------------

    pub fn account_by_handle(&self, handle: &str) -> Option<Account> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT id, handle, pass_hash, created_at FROM accounts WHERE handle = ?1 COLLATE NOCASE",
            [handle],
            Self::row_account,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn account_by_id(&self, id: i64) -> Option<Account> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT id, handle, pass_hash, created_at FROM accounts WHERE id = ?1",
            [id],
            Self::row_account,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Create an account. `pass_hash` may be empty for a device-key-only account.
    /// Fails (Err) if the handle is already taken - the UNIQUE index is the
    /// authority, so two racing signups cannot both win.
    pub fn create_account(&self, handle: &str, pass_hash: &str, now: i64) -> rusqlite::Result<Account> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO accounts (handle, pass_hash, created_at, seen_at) VALUES (?1, ?2, ?3, ?3)",
            (handle, pass_hash, now),
        )?;
        let id = c.last_insert_rowid();
        Ok(Account { id, handle: handle.to_string(), pass_hash: pass_hash.to_string(), created_at: now })
    }

    pub fn touch_seen(&self, id: i64, now: i64) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute("UPDATE accounts SET seen_at = ?2 WHERE id = ?1", (id, now));
    }

    // --- device keys (passwordless) -----------------------------------------

    /// Register a device's public key for an account, so that device can log in
    /// by signing a challenge instead of typing a password.
    pub fn add_device_key(&self, account_id: i64, public_b64: &str, label: &str, now: i64) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT OR IGNORE INTO device_keys (account_id, public_key, label, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            (account_id, public_b64, label, now),
        )?;
        Ok(())
    }

    /// Every device public key registered to an account, to check a challenge
    /// signature against.
    pub fn device_keys(&self, account_id: i64) -> Vec<String> {
        let c = self.conn.lock().unwrap();
        let mut stmt = match c.prepare("SELECT public_key FROM device_keys WHERE account_id = ?1") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([account_id], |r| r.get::<_, String>(0));
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    // --- friends -------------------------------------------------------------

    /// The two ids in canonical order, so a friendship is one row not two.
    fn pair(a: i64, b: i64) -> (i64, i64) {
        if a < b { (a, b) } else { (b, a) }
    }

    pub fn are_friends(&self, a: i64, b: i64) -> bool {
        let (lo, hi) = Self::pair(a, b);
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT 1 FROM friendships WHERE a_id = ?1 AND b_id = ?2",
            [lo, hi],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
    }

    /// Record a friend request. Idempotent on (from, to); returns the row id.
    pub fn add_friend_request(&self, from: i64, to: i64, now: i64) -> rusqlite::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?1, ?2, ?3)",
            (from, to, now),
        )?;
        c.query_row(
            "SELECT id FROM friend_requests WHERE from_id = ?1 AND to_id = ?2",
            [from, to],
            |r| r.get(0),
        )
    }

    /// The (from, to) of a request, for checking who may answer it.
    pub fn friend_request(&self, id: i64) -> Option<(i64, i64)> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT from_id, to_id FROM friend_requests WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .ok()
        .flatten()
    }

    /// A pending request already aimed the OTHER way, if any - so two people who
    /// ask each other become friends rather than piling up two requests.
    pub fn reverse_request(&self, from: i64, to: i64) -> Option<i64> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT id FROM friend_requests WHERE from_id = ?1 AND to_id = ?2",
            [to, from],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn delete_friend_request(&self, id: i64) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute("DELETE FROM friend_requests WHERE id = ?1", [id]);
    }

    /// Make a friendship and clear any requests either way between the pair.
    pub fn add_friendship(&self, a: i64, b: i64, now: i64) -> rusqlite::Result<()> {
        let (lo, hi) = Self::pair(a, b);
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT OR IGNORE INTO friendships (a_id, b_id, since) VALUES (?1, ?2, ?3)",
            (lo, hi, now),
        )?;
        c.execute(
            "DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)",
            (a, b),
        )?;
        Ok(())
    }

    pub fn remove_friendship(&self, a: i64, b: i64) {
        let (lo, hi) = Self::pair(a, b);
        let c = self.conn.lock().unwrap();
        let _ = c.execute("DELETE FROM friendships WHERE a_id = ?1 AND b_id = ?2", [lo, hi]);
    }

    /// Everyone `id` is friends with, each with a glance of their library.
    pub fn friends_of(&self, id: i64) -> Vec<Friend> {
        let c = self.conn.lock().unwrap();
        let mut stmt = match c.prepare(
            "SELECT a.id, a.handle, a.server_url, a.seen_at,
                    COALESCE(s.songs,0), COALESCE(s.playlists,0), COALESCE(s.artists,0),
                    COALESCE(s.week_minutes,0), COALESCE(s.week_top_artist,''),
                    COALESCE(s.streak_days,0), COALESCE(s.listened_at,0)
               FROM friendships f
               JOIN accounts a ON a.id = CASE WHEN f.a_id = ?1 THEN f.b_id ELSE f.a_id END
               LEFT JOIN stats s ON s.account_id = a.id
              WHERE f.a_id = ?1 OR f.b_id = ?1
              ORDER BY a.handle COLLATE NOCASE",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([id], |r| {
            Ok(Friend {
                id: r.get(0)?,
                handle: r.get(1)?,
                server_url: r.get(2)?,
                seen_at: r.get(3)?,
                songs: r.get(4)?,
                playlists: r.get(5)?,
                artists: r.get(6)?,
                week_minutes: r.get(7)?,
                week_top_artist: r.get(8)?,
                streak_days: r.get(9)?,
                listened_at: r.get(10)?,
            })
        });
        rows.map(|it| it.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    /// Requests aimed at `id` (incoming) and sent by `id` (outgoing), each with
    /// the other person's handle.
    pub fn requests_for(&self, id: i64, incoming: bool) -> Vec<PendingRequest> {
        let (mine, theirs) = if incoming { ("to_id", "from_id") } else { ("from_id", "to_id") };
        let sql = format!(
            "SELECT r.id, a.id, a.handle
               FROM friend_requests r JOIN accounts a ON a.id = r.{theirs}
              WHERE r.{mine} = ?1 ORDER BY r.created_at DESC"
        );
        let c = self.conn.lock().unwrap();
        let mut stmt = match c.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([id], |r| {
            Ok(PendingRequest { id: r.get(0)?, account_id: r.get(1)?, handle: r.get(2)? })
        });
        rows.map(|it| it.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    // --- library announce (server_url + stats) ------------------------------

    /// Where an account's library answers, announced by their own app so a
    /// friend has an address to reach.
    pub fn set_server_url(&self, id: i64, url: &str) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute("UPDATE accounts SET server_url = ?2 WHERE id = ?1", (id, url));
    }

    /// Where this account was last listening, and when.
    pub fn resume(&self, id: i64) -> Option<(String, i64)> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT body, updated_at FROM resume WHERE account_id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok()
    }

    /// Record it. Most recent wins, and an older write is DROPPED rather than
    /// applied: a device that was offline for an hour must not, on reconnect,
    /// tell the account that an hour-old position is where you are now.
    pub fn set_resume(&self, id: i64, body: &str, at: i64) -> bool {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO resume (account_id, body, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id) DO UPDATE SET
               body = excluded.body, updated_at = excluded.updated_at
             WHERE excluded.updated_at >= resume.updated_at",
            (id, body, at),
        )
        .is_ok()
    }

    /// This account's synced settings, and the revision they were at.
    ///
    /// Absent is not an error and not an empty object: a device that has never
    /// synced must be able to tell "nothing has ever been stored" (keep what is
    /// on this device, then push it) apart from "stored, and it is empty"
    /// (someone cleared it, so clear here too).
    pub fn prefs(&self, id: i64) -> Option<(String, i64)> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT body, rev FROM prefs WHERE account_id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok()
    }

    /// Store settings, refusing a write built on a revision that has moved.
    ///
    /// Returns the new revision, or None when `expected` is stale. Last-write-
    /// wins would be wrong here for a real reason: two devices that both went
    /// offline and both came back would each believe they were current, and the
    /// slower one would silently erase the other's changes. Refusing lets the
    /// client re-read and merge, which it can do because it knows which keys it
    /// touched.
    ///
    /// `expected` of 0 means "I have never seen a revision", which is only
    /// allowed when nothing is stored yet.
    pub fn set_prefs(&self, id: i64, body: &str, expected: i64, now: i64) -> Option<i64> {
        let c = self.conn.lock().unwrap();
        let current: Option<i64> = c
            .query_row("SELECT rev FROM prefs WHERE account_id = ?1", [id], |r| r.get(0))
            .ok();
        match (current, expected) {
            // First write for this account.
            (None, 0) => {}
            // Ordinary update from whoever holds the current revision.
            (Some(rev), want) if rev == want => {}
            // Anything else is a write against a revision that has moved on.
            _ => return None,
        }
        let next = current.unwrap_or(0) + 1;
        c.execute(
            "INSERT INTO prefs (account_id, body, rev, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id) DO UPDATE SET
               body = excluded.body, rev = excluded.rev, updated_at = excluded.updated_at",
            (id, body, next, now),
        )
        .ok()?;
        Some(next)
    }

    pub fn set_stats(&self, id: i64, songs: i64, playlists: i64, artists: i64, now: i64) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "INSERT INTO stats (account_id, songs, playlists, artists, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_id) DO UPDATE SET
               songs = excluded.songs, playlists = excluded.playlists,
               artists = excluded.artists, updated_at = excluded.updated_at",
            (id, songs, playlists, artists, now),
        );
    }

    /// The listening glance, written only when the app announces one - which
    /// it does only while its owner shares. See the stats table comment for
    /// how sharing OFF works (silence, then staleness).
    pub fn set_listening(&self, id: i64, minutes: i64, top_artist: &str, streak: i64, now: i64) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "INSERT INTO stats (account_id, week_minutes, week_top_artist, streak_days, listened_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_id) DO UPDATE SET
               week_minutes = excluded.week_minutes,
               week_top_artist = excluded.week_top_artist,
               streak_days = excluded.streak_days,
               listened_at = excluded.listened_at",
            (id, minutes, top_artist, streak, now),
        );
    }

    // --- invites & memberships ----------------------------------------------

    pub fn create_invite(
        &self,
        code: &str,
        server_url: &str,
        server_name: &str,
        created_by: i64,
        role: &str,
        expires_at: i64,
        max_uses: i64,
        now: i64,
    ) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO invites (code, server_url, server_name, created_by, role, created_at, expires_at, max_uses)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (code, server_url, server_name, created_by, role, now, expires_at, max_uses),
        )?;
        Ok(())
    }

    /// Whether this account has already redeemed this code - so a re-redeem is
    /// idempotent rather than either burning another of the code's uses or
    /// being rejected as "fully used".
    pub fn has_redeemed(&self, code: &str, account_id: i64) -> bool {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT 1 FROM invite_redemptions WHERE code = ?1 AND account_id = ?2",
            (code, account_id),
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
    }

    pub fn invite(&self, code: &str) -> Option<Invite> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT code, server_url, server_name, created_by, role, expires_at, redeemed_by, max_uses,
                    (SELECT COUNT(*) FROM invite_redemptions WHERE code = invites.code)
               FROM invites WHERE code = ?1",
            [code],
            |r| {
                Ok(Invite {
                    code: r.get(0)?,
                    server_url: r.get(1)?,
                    server_name: r.get(2)?,
                    created_by: r.get(3)?,
                    role: r.get(4)?,
                    expires_at: r.get(5)?,
                    redeemed_by: r.get(6)?,
                    max_uses: r.get(7)?,
                    uses_count: r.get(8)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Mark an invite spent and attach the account to the server as a member.
    /// Spend an invite. `standing` invites are not spent: the membership is
    /// granted and the code stays live for the next person, which is what makes
    /// one code servable to a queue of reviewers rather than the first of them.
    pub fn redeem_invite(
        &self,
        code: &str,
        account_id: i64,
        server_url: &str,
        role: &str,
        now: i64,
        standing: bool,
    ) {
        let c = self.conn.lock().unwrap();
        if !standing {
            // The ledger row is the real tally against max_uses; INSERT OR
            // IGNORE makes a re-redeem by the same account a no-op.
            let _ = c.execute(
                "INSERT OR IGNORE INTO invite_redemptions (code, account_id, redeemed_at) VALUES (?1, ?2, ?3)",
                (code, account_id, now),
            );
            // redeemed_by keeps the FIRST redeemer, for display - `IS NULL`
            // guards it so a later redeemer of a multi-use code does not
            // overwrite who opened it.
            let _ = c.execute(
                "UPDATE invites SET redeemed_by = ?2, redeemed_at = ?3 WHERE code = ?1 AND redeemed_by IS NULL",
                (code, account_id, now),
            );
        }
        let _ = c.execute(
            "INSERT INTO memberships (account_id, server_url, role, state, since)
             VALUES (?1, ?2, ?3, 'active', ?4)
             ON CONFLICT(account_id, server_url) DO UPDATE SET role = excluded.role, state = 'active'",
            (account_id, server_url, role, now),
        );
    }

    /// Record that this account can reach a server, from the device's own
    /// report rather than from an invite.
    ///
    /// Servers someone OWNS never pass through invite redemption, so without
    /// this their own hub is the one server the registry never knew about -
    /// exactly the one a new device most needs handed back. A name that
    /// arrives empty leaves whatever was already stored alone.
    pub fn record_membership(&self, account_id: i64, server_url: &str, name: &str, role: &str, now: i64) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "INSERT INTO memberships (account_id, server_url, role, state, since, name)
             VALUES (?1, ?2, ?3, 'active', ?4, ?5)
             ON CONFLICT(account_id, server_url) DO UPDATE SET
               role = excluded.role,
               state = 'active',
               name = CASE WHEN excluded.name = '' THEN memberships.name ELSE excluded.name END",
            (account_id, server_url, role, now, name),
        );
    }

    /// Forget a server for this account - the device's "stop syncing this one".
    pub fn forget_membership(&self, account_id: i64, server_url: &str) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "DELETE FROM memberships WHERE account_id = ?1 AND server_url = ?2",
            (account_id, server_url),
        );
    }

    /// The servers an account belongs to (active or pending).
    pub fn memberships_of(&self, id: i64) -> Vec<Membership> {
        let c = self.conn.lock().unwrap();
        let mut stmt = match c.prepare(
            "SELECT server_url, role, state, since, name FROM memberships WHERE account_id = ?1 ORDER BY since",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([id], |r| {
            Ok(Membership {
                server_url: r.get(0)?,
                role: r.get(1)?,
                state: r.get(2)?,
                since: r.get(3)?,
                name: r.get(4)?,
            })
        });
        rows.map(|it| it.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    fn row_account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
        Ok(Account {
            id: r.get(0)?,
            handle: r.get(1)?,
            pass_hash: r.get(2)?,
            created_at: r.get(3)?,
        })
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The people. A handle is the public name and the login; the id is identity.
CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- Argon2, or empty for an account that only ever signs in from a paired
  -- device (passwordless). At least one of a password or a device key must
  -- exist, but that is the endpoint's rule to keep, not the table's.
  pass_hash  TEXT NOT NULL DEFAULT '',
  -- Where this person's own library answers, announced by their app. Empty
  -- until announced once; a friend with no address is known but not reachable.
  server_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL DEFAULT 0
);

-- A device that may speak for an account without a password: it holds a private
-- key, the registry holds the public half, and a login is a signed challenge.
CREATE TABLE IF NOT EXISTS device_keys (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, public_key)
);

-- An invitation to join ONE server, generated by that server's owner. Redeeming
-- it both creates (or attaches) an account and records the membership.
CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  server_url  TEXT NOT NULL,
  server_name TEXT NOT NULL DEFAULT '',
  created_by  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL DEFAULT 0,
  redeemed_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  redeemed_at INTEGER NOT NULL DEFAULT 0,
  -- How many DISTINCT accounts may redeem this code. 1 is the classic one-time
  -- invite, and the column's default, so every invite minted before this
  -- existed stays single-use. A 'standing' invite (expires_at = 0) is unlimited
  -- regardless of this. The count is kept in invite_redemptions, not a bare
  -- counter, so a re-redeem by the same account never burns a use.
  max_uses    INTEGER NOT NULL DEFAULT 1
);

-- One row per DISTINCT account that has redeemed an invite - the tally that
-- max_uses caps. Separate from redeemed_by (which stays the FIRST redeemer, for
-- display) so "how many people used it" cannot be gamed by one person entering
-- twice (a local delete then re-enter, a double-tap), and so a re-redeem is a
-- no-op rather than a spent use.
CREATE TABLE IF NOT EXISTS invite_redemptions (
  code        TEXT NOT NULL,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (code, account_id)
);

-- Which servers an account belongs to, and whether the join is settled. A
-- request-to-join a friend's server sits here as 'pending' until the owner
-- approves. The server keeps its own authoritative copy; this is the account's
-- view so its app knows where it can reach.
CREATE TABLE IF NOT EXISTS memberships (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  server_url TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  state      TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'pending'
  since      INTEGER NOT NULL,
  PRIMARY KEY (account_id, server_url)
);
CREATE INDEX IF NOT EXISTS memberships_server ON memberships(server_url);

-- A friend request in flight, one row until answered.
CREATE TABLE IF NOT EXISTS friend_requests (
  id         INTEGER PRIMARY KEY,
  from_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests(to_id);

-- A settled friendship, one row (a_id < b_id), not two.
CREATE TABLE IF NOT EXISTS friendships (
  a_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  b_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  since INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships(b_id);

-- A cached glance of a library's size, announced by the owner's app, so a
-- friends list shows everyone's numbers without waking everyone's server.
CREATE TABLE IF NOT EXISTS resume (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Where this person was, last time any of their devices was playing. Opaque
  -- like prefs, and for the same reason.
  --
  -- NO revision here, deliberately, and it is the one place that is right: the
  -- question "where was I" has exactly one correct answer, which is whatever
  -- happened MOST RECENTLY. Two devices cannot both be the last thing you
  -- listened on, so a merge would be inventing a conflict that does not exist.
  body        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prefs (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- One JSON object per account. Deliberately opaque to the registry: it stores
  -- and returns it, and only the app knows what is inside. That keeps a new
  -- synced setting from being a schema migration on a service that other
  -- people's servers depend on.
  body        TEXT NOT NULL,
  -- Bumped on every write. The client sends the revision it last saw, so a
  -- second device that has been offline cannot silently overwrite newer work -
  -- it is told to merge instead.
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  songs      INTEGER NOT NULL DEFAULT 0,
  playlists  INTEGER NOT NULL DEFAULT 0,
  liked      INTEGER NOT NULL DEFAULT 0,
  artists    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  -- The listening glance, announced by the app only while its owner has
  -- sharing switched ON. Sharing off simply stops the announcements: the
  -- numbers go stale and the friends view stops showing them past a week -
  -- revocation by silence, no delete round-trip required.
  week_minutes    INTEGER NOT NULL DEFAULT 0,
  week_top_artist TEXT NOT NULL DEFAULT '',
  streak_days     INTEGER NOT NULL DEFAULT 0,
  listened_at     INTEGER NOT NULL DEFAULT 0
);
"#;

#[cfg(test)]
mod prefs_tests {
    use super::Db;

    fn db() -> Db {
        // A file in a temp dir rather than :memory:, so this exercises the same
        // open() path (and the same schema) the service actually runs.
        let dir = std::env::temp_dir().join(format!("afm-prefs-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("{}.sqlite3", rand_suffix()));
        Db::open(&path).expect("opens")
    }

    /// prefs.account_id is a foreign key, so an account has to exist first -
    /// which is correct, and was the reason the first version of these tests
    /// failed. Returns the new account's id.
    fn account(db: &Db, handle: &str) -> i64 {
        db.create_account(handle, "x", 100).expect("account created").id
    }

    fn rand_suffix() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos().to_string()
    }

    /// Nothing stored is not the same as stored-and-empty, and the difference
    /// decides whether a fresh device pushes what it has or wipes itself.
    #[test]
    fn nothing_stored_reads_as_absent() {
        let db = db();
        let id = account(&db, "nobody");
        assert!(db.prefs(id).is_none());
    }

    #[test]
    fn the_first_write_needs_revision_zero_and_becomes_one() {
        let db = db();
        let id = account(&db, "one");
        assert_eq!(db.set_prefs(id, r#"{"theme":"dark"}"#, 0, 100), Some(1));
        let (body, rev) = db.prefs(id).expect("stored");
        assert_eq!(rev, 1);
        assert!(body.contains("dark"));
    }

    /// The whole reason for revisions: two devices that both went offline must
    /// not silently erase each other. The one holding the stale number is
    /// refused so it can re-read and merge.
    #[test]
    fn a_write_against_a_moved_revision_is_refused() {
        let db = db();
        let id = account(&db, "two");
        assert_eq!(db.set_prefs(id, r#"{"a":1}"#, 0, 100), Some(1));
        assert_eq!(db.set_prefs(id, r#"{"a":2}"#, 1, 101), Some(2));
        // A second device still thinks the world is at revision 1.
        assert_eq!(db.set_prefs(id, r#"{"a":3}"#, 1, 102), None);
        // ...and the winner's value is untouched.
        assert!(db.prefs(id).expect("stored").0.contains("\"a\":2"));
    }

    /// Writing "first write" against an account that already has settings is
    /// the same mistake wearing different clothes - a device that lost its
    /// memory of the revision must not therefore win.
    #[test]
    fn revision_zero_cannot_overwrite_existing_settings() {
        let db = db();
        let id = account(&db, "three");
        assert_eq!(db.set_prefs(id, r#"{"a":1}"#, 0, 100), Some(1));
        assert_eq!(db.set_prefs(id, r#"{"a":9}"#, 0, 101), None);
    }

    /// The rule that makes last-write-wins safe: a device that was offline
    /// must not, on reconnect, announce a stale position as current. Without
    /// the WHERE clause on the upsert, the straggler wins simply by arriving
    /// last, and you get sent back to where you were an hour ago.
    #[test]
    fn an_older_resume_write_is_dropped() {
        let db = db();
        let id = account(&db, "resumer");
        db.set_resume(id, r#"{"at":"now"}"#, 500);
        db.set_resume(id, r#"{"at":"stale"}"#, 400);
        assert!(db.resume(id).expect("stored").0.contains("now"));
    }

    /// Same instant is not older, and re-recording the same second must not be
    /// silently dropped - a position updates far faster than the clock ticks.
    #[test]
    fn a_write_in_the_same_second_still_lands() {
        let db = db();
        let id = account(&db, "sameinstant");
        db.set_resume(id, r#"{"p":1}"#, 500);
        db.set_resume(id, r#"{"p":2}"#, 500);
        assert!(db.resume(id).expect("stored").0.contains("\"p\":2"));
    }

    #[test]
    fn accounts_do_not_see_each_other() {
        let db = db();
        let a = account(&db, "alpha");
        let b = account(&db, "beta");
        db.set_prefs(a, r#"{"who":"one"}"#, 0, 100);
        db.set_prefs(b, r#"{"who":"two"}"#, 0, 100);
        assert!(db.prefs(a).unwrap().0.contains("one"));
        assert!(db.prefs(b).unwrap().0.contains("two"));
    }
}
