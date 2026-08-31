//! Deterministic Stage 0/1 fixtures for curator personalization.
//!
//! These tests deliberately use a fresh SQLite database and synthetic track rows. They never
//! inspect AFM_DATA_DIR or a real music directory. Tests whose names contain `known_bad_baseline`
//! capture behaviour we intend to change later; they are passing assertions about today's bug,
//! not endorsements of it.

use crate::{
    curator,
    db::{Db, TrackFeatures},
};
use rusqlite::params;
use std::{collections::{HashMap, HashSet}, path::PathBuf};

const NOW: i64 = 2_000_000_000_000;

#[derive(Clone, Copy, Debug)]
struct Listeners {
    metal: i64,
    kpop: i64,
    jazz: i64,
    mixed: i64,
    new_user: i64,
}

#[derive(Clone, Debug)]
struct TrackSpec {
    id: i64,
    artist: &'static str,
    title: &'static str,
    genre: &'static str,
    bpm: f64,
    lyric: [f32; 4],
    added_at: i64,
}

struct Fixture {
    db: Db,
    dir: PathBuf,
    users: Listeners,
    tracks: Vec<TrackSpec>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    fn shared_library() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "attackfm-personalization-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("fixtures.sqlite")).unwrap();
        let users = Listeners {
            metal: db.create_user("fixture-metal", "x", false).unwrap(),
            kpop: db.create_user("fixture-kpop", "x", false).unwrap(),
            jazz: db.create_user("fixture-jazz", "x", false).unwrap(),
            mixed: db.create_user("fixture-mixed", "x", false).unwrap(),
            new_user: db.create_user("fixture-no-history", "x", false).unwrap(),
        };
        // Human-readable lanes: 1-4 metal/industrial, 5-8 K-pop/electropop,
        // 9-12 jazz/fusion. IDs 13-15 are adjacent bridges. 16-18 are unrelated
        // newest imports used to expose global chronology leakage.
        let tracks = vec![
            t(
                1,
                "Ministry",
                "Steel Psalm",
                "industrial metal",
                138.,
                [1., 0., 0., 0.],
                101,
            ),
            t(
                2,
                "HEALTH",
                "Machine Choir",
                "industrial",
                132.,
                [0.9, 0.1, 0., 0.],
                102,
            ),
            t(
                3,
                "Nine Inch Nails",
                "Static Teeth",
                "industrial rock",
                126.,
                [0.85, 0.15, 0., 0.],
                103,
            ),
            t(
                4,
                "Converge",
                "Fault Line",
                "hardcore",
                178.,
                [0.8, 0.2, 0., 0.],
                104,
            ),
            t(
                5,
                "aespa",
                "Night Circuit",
                "k-pop",
                124.,
                [0., 1., 0., 0.],
                105,
            ),
            t(
                6,
                "Red Velvet",
                "Velvet Signal",
                "k-pop",
                118.,
                [0.05, 0.95, 0., 0.],
                106,
            ),
            t(
                7,
                "Dreamcatcher",
                "Black Halo",
                "k-pop",
                130.,
                [0.1, 0.9, 0., 0.],
                107,
            ),
            t(
                8,
                "IVE",
                "Glass Current",
                "dance pop",
                122.,
                [0., 0.85, 0.15, 0.],
                108,
            ),
            t(
                9,
                "John Coltrane",
                "Open Sky",
                "modal jazz",
                92.,
                [0., 0., 1., 0.],
                109,
            ),
            t(
                10,
                "Alice Coltrane",
                "Astral River",
                "spiritual jazz",
                86.,
                [0., 0.05, 0.95, 0.],
                110,
            ),
            t(
                11,
                "Miles Davis",
                "Electric Blue",
                "fusion",
                104.,
                [0.05, 0., 0.95, 0.],
                111,
            ),
            t(
                12,
                "Charlie Parker",
                "Night Flight",
                "bebop",
                190.,
                [0., 0., 0.9, 0.1],
                112,
            ),
            t(
                13,
                "Front 242",
                "Body Voltage",
                "ebm",
                128.,
                [0.7, 0.3, 0., 0.],
                113,
            ),
            t(
                14,
                "Purity Ring",
                "Dark Bloom",
                "electropop",
                120.,
                [0.15, 0.75, 0.1, 0.],
                114,
            ),
            t(
                15,
                "Sons of Kemet",
                "Burning Reeds",
                "jazz fusion",
                116.,
                [0.1, 0., 0.8, 0.1],
                115,
            ),
            t(
                16,
                "Newest Idol Batch",
                "Server Arrival A",
                "k-pop",
                121.,
                [0., 1., 0., 0.],
                900,
            ),
            t(
                17,
                "Newest Idol Batch",
                "Server Arrival B",
                "k-pop",
                123.,
                [0., 1., 0., 0.],
                901,
            ),
            t(
                18,
                "Newest Idol Batch",
                "Server Arrival C",
                "k-pop",
                125.,
                [0., 1., 0., 0.],
                902,
            ),
        ];
        for track in &tracks {
            add_track(&db, track, None, false);
        }

        for id in 1..=4 {
            plays(&db, users.metal, id, 3);
            completed(&db, users.metal, id);
        }
        favorite(&db, users.metal, 1);
        for id in 5..=8 {
            plays(&db, users.kpop, id, 3);
            completed(&db, users.kpop, id);
        }
        favorite(&db, users.kpop, 5);
        for id in 9..=12 {
            plays(&db, users.jazz, id, 3);
            completed(&db, users.jazz, id);
        }
        favorite(&db, users.jazz, 10);
        for id in [1, 3, 5, 7, 9, 11] {
            plays(&db, users.mixed, id, 2);
            completed(&db, users.mixed, id);
        }
        // Explicit negative examples are listen events only because current background curation
        // ignores verdicts. They become useful unchanged fixtures in Stage 3.
        skipped(&db, users.metal, 5);
        skipped(&db, users.metal, 6);
        skipped(&db, users.kpop, 1);
        skipped(&db, users.kpop, 4);

        Self {
            db,
            dir,
            users,
            tracks,
        }
    }

    fn taste(&self, user: i64) -> curator::Taste {
        let all = self.db.all_features();
        let by_id: HashMap<i64, &TrackFeatures> = all.iter().map(|f| (f.track_id, f)).collect();
        let ids: Vec<i64> = self
            .db
            .top_plays(user, 0, 60)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        curator::taste_from(&ids, &by_id)
    }
}

fn t(
    id: i64,
    artist: &'static str,
    title: &'static str,
    genre: &'static str,
    bpm: f64,
    lyric: [f32; 4],
    added_at: i64,
) -> TrackSpec {
    TrackSpec {
        id,
        artist,
        title,
        genre,
        bpm,
        lyric,
        added_at,
    }
}

fn add_track(db: &Db, t: &TrackSpec, collector_user: Option<i64>, promoted: bool) {
    db.test_connection(|c| {
        c.execute("INSERT INTO tracks (id,rel_path,title,artist,album_artist,album,genre,added_at,rev,curator_user_id,curator_promoted) VALUES (?1,?2,?3,?4,?4,'Fixture',?5,?6,1,?7,?8)",
            params![t.id,format!("fixtures/{}.flac",t.id),t.title,t.artist,t.genre,t.added_at,collector_user,promoted as i64])?;
        Ok(())
    }).unwrap();
    db.save_features(t.id, Some(t.bpm), "fixture", Some(&t.lyric))
        .unwrap();
    // Reusable enrichment helper: rich metadata is present even though legacy score ignores it.
    db.save_ai_enrichment(
        t.id,
        "deterministic fixture",
        &[t.genre.into()],
        &[],
        &["deterministic".into()],
        &[],
        1.0,
        &["fixture".into()],
        &[format!("fixture:{}", t.genre)],
        "",
        &[],
        0,
        0,
        Some(&t.lyric),
        Some(&t.lyric),
        None,
        Some(&t.lyric),
    )
    .unwrap();
}
fn plays(db: &Db, user: i64, track: i64, n: usize) {
    for _ in 0..n {
        db.record_play(user, track).unwrap();
    }
}
fn listen(db: &Db, user: i64, track: i64, completed_v: bool, skipped_v: bool) {
    listen_at(db, user, track, completed_v, skipped_v, NOW);
}
fn listen_at(
    db: &Db,
    user: i64,
    track: i64,
    completed_v: bool,
    skipped_v: bool,
    started_at: i64,
) {
    let tags = db.track_tags(track).unwrap();
    db.insert_listen(
        user,
        track,
        &tags,
        started_at,
        if completed_v { 180_000 } else { 4_000 },
        Some(180_000),
        completed_v,
        skipped_v,
        "fixture",
    )
    .unwrap();
}
fn completed(db: &Db, user: i64, track: i64) {
    listen(db, user, track, true, false)
}
fn skipped(db: &Db, user: i64, track: i64) {
    listen(db, user, track, false, true)
}
fn favorite(db: &Db, user: i64, track: i64) {
    db.set_favorite(user, track, true).unwrap()
}
fn playlist(db: &Db, user: i64, name: &str, tracks: &[i64]) {
    let id = db.create_playlist(user, name).unwrap();
    db.set_playlist_tracks(id, tracks).unwrap()
}
fn discovery(db: &Db, user: i64, id: &str, artist: &str, score: f64) {
    db.add_discovery(
        user,
        id,
        id,
        artist,
        "",
        "",
        "",
        "fixture",
        1.,
        "fixture-lane",
    )
        .unwrap();
    db.save_discovery_features(user, id, Some(120.), Some(&[0., 1., 0., 0.]), score)
        .unwrap()
}

fn assert_same_taste(a: &curator::Taste, b: &curator::Taste) {
    assert_eq!(a.tempo, b.tempo);
    assert_eq!(a.genres, b.genres);
    assert_eq!(a.heard, b.heard);
    assert_eq!(a.centroid, b.centroid);
}

#[test]
fn fixture_exit_gate_five_users_share_one_library() {
    let f = Fixture::shared_library();
    for user in [
        f.users.metal,
        f.users.kpop,
        f.users.jazz,
        f.users.mixed,
        f.users.new_user,
    ] {
        assert_eq!(
            f.db.unplayed(user, 100).len() + f.db.recent_plays(user, 100).len(),
            f.tracks.len()
        );
    }
    assert!(f.db.recent_plays(f.users.new_user, 10).is_empty());
}

#[test]
fn background_curator_taste_baseline_for_every_fixture() {
    let f = Fixture::shared_library();
    let metal = f.taste(f.users.metal);
    let kpop = f.taste(f.users.kpop);
    let jazz = f.taste(f.users.jazz);
    let mixed = f.taste(f.users.mixed);
    let cold = f.taste(f.users.new_user);
    assert_eq!(metal.tempo, Some(132.0));
    assert_eq!(metal.heard, [1, 2, 3, 4].into_iter().collect());
    assert_eq!(kpop.tempo, Some(122.0));
    assert_eq!(kpop.genres.get("k-pop"), Some(&0.75));
    assert_eq!(jazz.tempo, Some(92.0));
    assert_eq!(jazz.heard, [9, 10, 11, 12].into_iter().collect());
    assert_eq!(mixed.tempo, Some(124.0));
    assert_eq!(mixed.heard.len(), 6);
    assert!(
        cold.centroid.is_none()
            && cold.tempo.is_none()
            && cold.genres.is_empty()
            && cold.heard.is_empty()
    );
}

#[test]
fn known_bad_baseline_home_unplayed_is_global_newest() {
    let f = Fixture::shared_library();
    assert_eq!(
        f.db.unplayed(f.users.metal, 3),
        vec![18, 17, 16],
        "KNOWN BAD: Home injects globally newest K-pop for the Metal listener"
    );
}

#[test]
fn stage5_home_candidates_require_personal_or_bounded_exploration_provenance() {
    let f = Fixture::shared_library();
    let metal = crate::home::home_candidates(&f.db, f.users.metal, NOW);
    assert!(metal.len() >= 4);
    assert!(metal.iter().all(|candidate| {
        !candidate.reason.is_empty()
            && matches!(candidate.lane, "familiar" | "deep-cut" | "recent-interest" | "adjacent" | "exploratory")
    }));
    let newest: Vec<_> = metal.iter().filter(|candidate| [16, 17, 18].contains(&candidate.id))
        .map(|candidate| (candidate.id, candidate.lane, candidate.relevance)).collect();
    assert!(newest.iter().all(|(_, lane, _)| *lane == "exploratory"),
        "globally newest unrelated K-pop entered a personal-fit lane: {newest:?}");
    assert!(metal.iter().filter(|candidate| candidate.lane == "exploratory").count() <= 10);

    let mixed = crate::home::home_candidates(&f.db, f.users.mixed, NOW);
    let metal_ids: Vec<i64> = metal.iter().map(|candidate| candidate.id).collect();
    let mixed_ids: Vec<i64> = mixed.iter().map(|candidate| candidate.id).collect();
    assert_ne!(metal_ids, mixed_ids, "distinct listeners received the same candidate lanes");
}

#[test]
fn stage7_cold_start_does_not_inherit_server_artist_counts() {
    let f = Fixture::shared_library();
    let seeds = crate::discovery::harvest_seeds(&f.db, f.users.new_user, NOW);
    assert!(
        seeds.is_empty(),
        "a brand-new listener inherited shared inventory as taste: {seeds:?}"
    );
}

#[test]
fn stage7_favorites_seed_discovery_without_recent_plays() {
    let f = Fixture::shared_library();
    favorite(&f.db, f.users.new_user, 1);
    let seeds = crate::discovery::harvest_seeds(&f.db, f.users.new_user, NOW);
    assert_eq!(seeds.len(), 1);
    assert_eq!(seeds[0].name, "Ministry");
    assert_eq!(seeds[0].lane, "favorites");
}

#[test]
fn stage7_recent_and_long_term_seed_lanes_both_contribute() {
    let f = Fixture::shared_library();
    let user = f.users.new_user;
    let recent = NOW - 1_000;
    let old = NOW - 45 * 24 * 60 * 60 * 1000;
    f.db.test_connection(|c| {
        c.execute(
            "INSERT INTO plays (user_id, track_id, played_at) VALUES (?1, 1, ?2)",
            params![user, old],
        )?;
        c.execute(
            "INSERT INTO plays (user_id, track_id, played_at) VALUES (?1, 5, ?2)",
            params![user, recent],
        )?;
        Ok(())
    })
    .unwrap();
    let seeds = crate::discovery::harvest_seeds(&f.db, user, NOW);
    assert!(seeds.iter().any(|s| s.name == "aespa" && s.lane == "recent-artist"));
    assert!(seeds.iter().any(|s| s.name == "Ministry" && s.lane == "long-term-artist"));
}

#[test]
fn stage7_rejection_is_durable_user_scoped_and_changes_future_retrieval() {
    let f = Fixture::shared_library();
    let user = f.users.metal;
    discovery(&f.db, user, "reject-me", "HEALTH", 0.95);
    let key = crate::discovery::candidate_track_key("HEALTH", "reject-me");
    f.db.reject_discovery(user, "track", &key);
    f.db.forget_discovery(user, "reject-me");
    assert!(crate::discovery::is_rejected(&f.db, user, "HEALTH", "reject-me"));
    assert!(!crate::discovery::is_rejected(
        &f.db,
        f.users.kpop,
        "HEALTH",
        "reject-me"
    ));
    assert!(f.db.top_discoveries(user, 10).is_empty());

    let artist_key = crate::discovery::artist_key_public("HEALTH");
    f.db.reject_discovery(user, "artist", &artist_key);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let seeds = crate::discovery::harvest_seeds(&f.db, user, now);
    assert!(!seeds.iter().any(|seed| seed.name.eq_ignore_ascii_case("HEALTH")));
}

#[test]
fn stage8_profile_rebuild_is_deterministic_and_playlist_aware() {
    let f = Fixture::shared_library();
    let user = f.users.new_user;
    playlist(&f.db, user, "Deliberate metal", &[1, 2, 3, 4]);
    let first = crate::recommendation::rebuild_profile(&f.db, user, NOW).unwrap();
    let first_row = f.db.taste_profile_row(user).unwrap();
    let second = crate::recommendation::rebuild_profile(&f.db, user, NOW).unwrap();
    let second_row = f.db.taste_profile_row(user).unwrap();
    assert_eq!(first.genres, second.genres);
    assert_eq!(first.recent_weights, second.recent_weights);
    assert_eq!(first.long_term_weights, second.long_term_weights);
    assert_eq!(first_row.4, second_row.4);
    assert_eq!(first_row.5, second_row.5);
    assert_eq!(first_row.6, second_row.6);
    assert!(first.long_term_weights.len() >= 4, "playlist membership was not backfilled");
}

#[test]
fn stage8_dirty_incremental_refresh_matches_full_rebuild_and_is_user_scoped() {
    let f = Fixture::shared_library();
    crate::recommendation::rebuild_profile(&f.db, f.users.metal, NOW).unwrap();
    crate::recommendation::rebuild_profile(&f.db, f.users.kpop, NOW).unwrap();
    completed(&f.db, f.users.metal, 13);
    assert!(f.db.taste_profile_row(f.users.metal).unwrap().2);
    assert!(!f.db.taste_profile_row(f.users.kpop).unwrap().2);

    let incremental = crate::recommendation::for_db(&f.db, f.users.metal, NOW).unwrap();
    assert!(!f.db.taste_profile_row(f.users.metal).unwrap().2);
    let full = crate::recommendation::rebuild_profile(&f.db, f.users.metal, NOW).unwrap();
    assert_eq!(incremental.genres, full.genres);
    assert_eq!(incremental.recent_weights, full.recent_weights);
    assert_eq!(incremental.long_term_weights, full.long_term_weights);
}

#[test]
fn stage8_version_change_rebuilds_and_user_delete_cascades_profile() {
    let f = Fixture::shared_library();
    let user = f.users.metal;
    crate::recommendation::rebuild_profile(&f.db, user, NOW).unwrap();
    f.db.test_connection(|c| {
        c.execute(
            "UPDATE user_taste_profiles SET version = 0, dirty = 0 WHERE user_id = ?1",
            params![user],
        )?;
        Ok(())
    })
    .unwrap();
    crate::recommendation::for_db(&f.db, user, NOW).unwrap();
    assert_eq!(
        f.db.taste_profile_row(user).unwrap().0,
        crate::recommendation::PROFILE_VERSION
    );
    f.db.delete_user(user).unwrap();
    assert!(f.db.taste_profile_row(user).is_none());
}

#[test]
fn stage9_other_user_promotion_does_not_count_as_initiator_adoption() {
    let f = Fixture::shared_library();
    let audition = t(
        30,
        "Collector Bridge",
        "Audition",
        "industrial",
        130.,
        [0.9, 0.1, 0., 0.],
        999,
    );
    add_track(&f.db, &audition, Some(f.users.metal), false);
    let pull = f
        .db
        .record_pull(
            f.users.metal,
            "collector-30",
            "track",
            "Audition",
            "Collector Bridge",
            "fixture",
            "personal evidence",
            0.9,
            "fixture-job",
        )
        .unwrap();
    f.db.test_connection(|c| {
        c.execute(
            "INSERT INTO curator_pull_tracks (pull_id, track_id) VALUES (?1, 30)",
            params![pull],
        )?;
        c.execute(
            "UPDATE curator_pulls SET state='landed', created_at=1 WHERE id=?1",
            params![pull],
        )?;
        Ok(())
    })
    .unwrap();
    f.db.settle_pull_adoption(30, f.users.kpop);
    f.db.promote_curator_track(30);
    assert_eq!(f.db.pull_adoption_initiator(f.users.metal, NOW), (0, 1));
    let outcome = f
        .db
        .test_connection(|c| {
            c.query_row(
                "SELECT outcome FROM curator_pulls WHERE id=?1",
                params![pull],
                |row| row.get::<_, String>(0),
            )
        })
        .unwrap();
    assert_eq!(outcome, "adopted-other");
}

#[test]
fn stage10_exposure_adoption_learning_is_classed_and_user_scoped() {
    let f = Fixture::shared_library();
    f.db.record_recommendation_exposure(
        f.users.metal,
        "fixture",
        "13",
        Some(13),
        "Front 242",
        "exploratory",
    );
    assert_eq!(
        f.db.recommendation_class_stats(f.users.metal, "exploratory", i64::MAX),
        (0, 1)
    );
    f.db.adopt_recommendation_exposures(f.users.metal, 13);
    assert_eq!(
        f.db.recommendation_class_stats(f.users.metal, "exploratory", i64::MAX),
        (1, 1)
    );
    assert_eq!(
        f.db.recommendation_class_stats(f.users.kpop, "exploratory", i64::MAX),
        (0, 0)
    );
    let recent = f
        .db
        .recently_exposed_artists(f.users.metal, "exploratory", 0);
    assert!(recent.contains("front 242"));
}

#[test]
fn stage10_external_classes_require_an_explainable_bridge() {
    assert_eq!(
        crate::discovery::discovery_class(0.8, "HEALTH", "recent-artist"),
        Some("adjacent")
    );
    assert_eq!(
        crate::discovery::discovery_class(0.55, "HEALTH", "listenbrainz-similar"),
        Some("exploratory")
    );
    assert_eq!(
        crate::discovery::discovery_class(0.46, "HEALTH", "musicbrainz-scene"),
        Some("wildcard")
    );
    assert_eq!(crate::discovery::discovery_class(0.9, "", "recent-artist"), None);
    assert_eq!(crate::discovery::discovery_class(0.9, "HEALTH", ""), None);
    assert_eq!(crate::discovery::discovery_class(0.44, "HEALTH", "recent-artist"), None);
}

#[test]
fn stage11_playlist_diagnostics_match_the_actual_final_order() {
    let f = Fixture::shared_library();
    let taste = crate::recommendation::for_db(&f.db, f.users.metal, NOW).unwrap();
    let ids = [4, 1, 3, 2];
    let rows = crate::recommendation::playlist_diagnostics(&f.db, &taste, &ids);
    let diagnosed: Vec<i64> = rows
        .iter()
        .map(|row| row["trackId"].as_i64().unwrap())
        .collect();
    let positions: Vec<i64> = rows
        .iter()
        .map(|row| row["position"].as_i64().unwrap())
        .collect();
    assert_eq!(diagnosed, ids);
    assert_eq!(positions, vec![0, 1, 2, 3]);
    assert!(rows.iter().all(|row| row["components"]["total"].is_number()));
}

#[test]
fn personalization_migrates_from_pre_stage7_columns() {
    let dir = std::env::temp_dir().join(format!(
        "attackfm-personalization-migration-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("old.sqlite");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE discoveries (
               user_id INTEGER NOT NULL, ext_id TEXT NOT NULL, title TEXT NOT NULL,
               artist TEXT NOT NULL, cover TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
               preview TEXT NOT NULL DEFAULT '', seed TEXT NOT NULL DEFAULT '',
               popularity REAL NOT NULL DEFAULT 0, bpm REAL, lyric_vec BLOB,
               vec_dims INTEGER NOT NULL DEFAULT 0, score REAL NOT NULL DEFAULT 0,
               checked_at INTEGER NOT NULL DEFAULT 0, found_at INTEGER NOT NULL,
               PRIMARY KEY (user_id, ext_id));
             CREATE TABLE curator_pulls (
               id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, ext_id TEXT NOT NULL,
               kind TEXT NOT NULL DEFAULT 'track', title TEXT NOT NULL, artist TEXT NOT NULL,
               url TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', score REAL NOT NULL DEFAULT 0,
               job_id TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'queued',
               bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
               UNIQUE (user_id, ext_id));",
        )
        .unwrap();
    }
    let db = Db::open(&path).unwrap();
    for (table, column) in [
        ("discoveries", "lane"),
        ("curator_pulls", "outcome"),
        ("curator_pulls", "outcome_at"),
        ("curator_pulls", "adopted_by"),
    ] {
        let found = db
            .test_connection(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                    params![table, column],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert_eq!(found, 1, "migration missed {table}.{column}");
    }
    for table in [
        "curator_intents",
        "discovery_rejections",
        "user_taste_profiles",
        "recommendation_exposures",
    ] {
        let found = db
            .test_connection(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert_eq!(found, 1, "migration missed table {table}");
    }
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stage3_curator_taste_responds_to_verdicts_and_favorites() {
    let f = Fixture::shared_library();
    let before = crate::recommendation::for_db(&f.db, f.users.metal, NOW).unwrap();
    for _ in 0..8 {
        skipped(&f.db, f.users.metal, 7);
    }
    favorite(&f.db, f.users.metal, 8);
    let after = crate::recommendation::for_db(&f.db, f.users.metal, NOW).unwrap();
    assert_ne!(before.genres, after.genres);
    assert!(after.heard.contains(&7) && after.heard.contains(&8));
}

#[test]
fn stage3_completion_favorite_skip_and_cap_weights_are_honest() {
    let f = Fixture::shared_library();
    let user = f.users.new_user;
    for _ in 0..3 { listen_at(&f.db, user, 1, true, false, NOW); }
    for _ in 0..3 { listen_at(&f.db, user, 5, false, true, NOW); }
    listen_at(&f.db, user, 9, false, false, NOW);
    listen_at(&f.db, user, 10, false, false, NOW);
    favorite(&f.db, user, 10);
    for _ in 0..10 { listen_at(&f.db, user, 2, true, false, NOW); }

    let weights: HashMap<i64, f32> = f.db.weighted_listens_since(user, NOW - 1, 60).into_iter().collect();
    assert!(weights[&1] > weights[&5], "three completions must beat three early skips");
    assert!(weights[&10] > weights[&9], "a heart must boost a one-listen track");
    assert_eq!(weights[&2], 3.0, "repeat listening must retain the breadth cap");
    assert!(weights[&5] > 0.0, "skips lower affinity but never create a permanent ban");
}

#[test]
fn stage3_recent_and_long_term_windows_are_distinct_and_inspectable() {
    let f = Fixture::shared_library();
    let user = f.users.new_user;
    let old = NOW - 31 * 24 * 60 * 60 * 1000;
    for id in 1..=4 { listen_at(&f.db, user, id, true, false, old); }
    for id in 5..=8 { listen_at(&f.db, user, id, true, false, NOW); }

    let context = crate::recommendation::for_db(&f.db, user, NOW).unwrap();
    let recent: HashSet<i64> = context.recent_weights.iter().map(|(id, _)| *id).collect();
    let long_term: HashSet<i64> = context.long_term_weights.iter().map(|(id, _)| *id).collect();
    assert!(recent.is_superset(&HashSet::from([5, 6, 7, 8])));
    assert!(recent.is_disjoint(&HashSet::from([1, 2, 3, 4])), "old listening leaked into recent taste");
    assert!(long_term.is_superset(&HashSet::from([1, 2, 3, 4, 5, 6, 7, 8])));
    let old_identity: f32 = ["industrial metal", "industrial", "industrial rock", "hardcore"]
        .iter()
        .filter_map(|genre| context.genres.get(*genre))
        .sum();
    assert!(old_identity > 0.35, "a short current trend overwrote long-term identity");
}

#[test]
fn user_b_activity_favorites_playlists_and_trends_do_not_change_user_a_taste() {
    let f = Fixture::shared_library();
    let before = f.taste(f.users.metal);
    for id in [5, 6, 7, 8, 16, 17, 18] {
        plays(&f.db, f.users.kpop, id, 5);
        completed(&f.db, f.users.kpop, id);
        favorite(&f.db, f.users.kpop, id);
    }
    playlist(
        &f.db,
        f.users.kpop,
        "K-pop obsession",
        &[5, 6, 7, 8, 16, 17, 18],
    );
    assert_same_taste(&before, &f.taste(f.users.metal));
}

#[test]
fn promoted_collector_inventory_has_no_unrelated_personal_boost() {
    let f = Fixture::shared_library();
    let before = f.taste(f.users.metal);
    let pulled = t(
        30,
        "Collector Idol",
        "Promoted Elsewhere",
        "k-pop",
        122.,
        [0., 1., 0., 0.],
        999,
    );
    add_track(&f.db, &pulled, Some(f.users.kpop), true);
    completed(&f.db, f.users.kpop, 30);
    favorite(&f.db, f.users.kpop, 30);
    assert!(
        f.db.unplayed(f.users.metal, 10).contains(&30),
        "shared inventory is available"
    );
    assert_same_taste(&before, &f.taste(f.users.metal));
}

#[test]
fn shared_context_excludes_quarantined_collector_and_book_tracks() {
    let f = Fixture::shared_library();
    let audition = t(
        30,
        "Collector Idol",
        "Still Quarantined",
        "k-pop",
        122.,
        [0., 1., 0., 0.],
        999,
    );
    add_track(&f.db, &audition, Some(f.users.metal), false);
    let book = t(
        31,
        "Narrator",
        "A Spoken Chapter",
        "spoken word",
        80.,
        [0., 0., 0., 1.],
        998,
    );
    add_track(&f.db, &book, None, false);
    f.db.test_connection(|c| {
        c.execute("UPDATE tracks SET kind='book' WHERE id=31", [])
            .map(|_| ())
    })
    .unwrap();
    plays(&f.db, f.users.metal, 30, 5);
    completed(&f.db, f.users.metal, 30);
    plays(&f.db, f.users.metal, 31, 5);
    completed(&f.db, f.users.metal, 31);
    let context = crate::recommendation::for_db(&f.db, f.users.metal, 0).unwrap();
    assert!(
        !context.heard.contains(&30),
        "unadopted Collector auditions cannot seed taste"
    );
    assert!(
        !context.heard.contains(&31),
        "book tracks cannot seed music taste"
    );
    assert!([1, 2, 3, 4]
        .into_iter()
        .all(|id| context.heard.contains(&id)));
}

#[test]
fn no_history_produces_no_behavioral_context() {
    let f = Fixture::shared_library();
    assert!(crate::recommendation::for_db(&f.db, f.users.new_user, 0).is_none());
}

#[test]
fn discovery_and_collector_candidates_remain_user_keyed() {
    let f = Fixture::shared_library();
    discovery(&f.db, f.users.kpop, "k-only", "Idol Candidate", 0.95);
    assert_eq!(
        f.db.top_discoveries(f.users.kpop, 10)
            .iter()
            .map(|x| x.ext_id.as_str())
            .collect::<Vec<_>>(),
        vec!["k-only"]
    );
    assert!(f.db.top_discoveries(f.users.metal, 10).is_empty());
}

#[test]
fn unrelated_genre_ceiling_assertion_is_reusable() {
    fn assert_ceiling(ids: &[i64], unrelated: &[i64], max: usize) {
        let n = ids.iter().filter(|id| unrelated.contains(id)).count();
        assert!(n <= max, "{n} unrelated tracks exceeds ceiling {max}");
    }
    assert_ceiling(&[1, 2, 13], &[5, 6, 7, 8, 16, 17, 18], 0);
}

#[test]
fn saved_home_model_response_is_offline_and_candidate_bounded() {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/home_ai_response.json")).unwrap();
    let allowed: std::collections::HashSet<i64> = (1..=18).collect();
    for id in value
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|mix| mix["ids"].as_array().unwrap())
        .map(|id| id.as_i64().unwrap())
    {
        assert!(
            allowed.contains(&id),
            "saved model response invented candidate {id}"
        );
    }
    assert!(
        value.to_string().contains("Known Bad Arrival"),
        "known-bad LLM selection must remain explicit"
    );
}
