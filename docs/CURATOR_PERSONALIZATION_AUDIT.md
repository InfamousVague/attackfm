# AttackFM AI Curator Personalization Audit

Audit basis: checked-out branch `feat/gemma-ai-dj` at commit `8d20b36`. The worktree was clean before the audit. No application code or data was modified.

## 1. Executive Summary

AttackFM is more personalized than it looks, but less personalized than its UI language implies.

There are several separate recommendation systems:

1. Home “Daily Mixes”
2. Background curator playlists
3. AI DJ and trait queues
4. External music discovery
5. Automatic downloading through the Collector
6. A global editorial Discover feed

They do not share one consistent taste model.

The central finding is that AttackFM has good user-specific behavioral data and a surprisingly capable AI DJ, but its automatic playlist systems still use older, thinner logic.

The background curator does not give the whole library to an LLM. Rust scores the server library first, and the LLM normally only names three lists. That part is structurally sound.

However:

- The core playlist score only considers lyric similarity, BPM, and the raw file genre.
- Automatic playlist curation ignores favorites, completions, skips, playlists, searches, playback context, albums, and most enriched metadata.
- The Home AI mix engine gives the LLM up to 240 candidates, including the 60 newest songs the user has never played, drawn from the shared server library without taste scoring.
- The system has no explicit long-term versus recent taste model.
- Several “Fresh Finds” paths are based on global server arrival order rather than personal relevance.
- New-user discovery falls back to whichever artists have the most files on the server, conflating server inventory with user taste.
- Rich enrichment data is used extensively by the AI DJ but barely used by automatic playlists or external acquisition scoring.

The current background curator is closer to:

```text
30-DAY PLAY COUNTS
  -> THIN TASTE CENTROID
  -> SCORE ENTIRE SHARED LIBRARY
  -> FIXED PLAYLIST RECIPES
  -> OPTIONAL LLM NAMING
```

The separate Home path is closer to:

```text
TOP ARTISTS + RECENT PLAYS + 60 NEWEST UNPLAYED SERVER TRACKS
  -> LLM SELECTS PLAYLISTS
```

That second path is the most likely source of the “willy-nilly” feeling.

## 2. Current Playlist Curator Architecture

### Background curator playlists

The server starts the curator during boot in `server/src/main.rs:437`.

The worker enriches tracks, runs semantic enrichment, calls `curate_cycle()`, runs external discovery, and then sleeps for 15 seconds when busy or five minutes when idle. The loop is defined in `server/src/curator.rs:334`.

Playlist rebuilding is globally gated to once every 30 minutes by `CURATE_EVERY_MS`. The timestamp lives in the single shared `CuratorState`, not per user (`curator.rs:239`, `curator.rs:998`).

It builds playlists only for users who have an entry in `plays` within the last 30 days (`db.rs:4115`). For each listener it:

- Reads their 60 most-played distinct tracks from the last 30 days.
- Requires at least four.
- Builds a taste representation.
- Loads `all_features()` for the entire live shared library.
- Excludes recently heard tracks and unadopted Collector auditions.
- Scores every remaining song.
- Builds fixed playlist recipes.

The main path is in `server/src/curator.rs:1015`.

The fixed playlist families are:

- `blend`: highest overall score
- `tempo-lane`: songs within 12 BPM of the user median
- `lyrical-echo`: lyric-vector similarity only
- `fresh-finds`: newest global server additions from the last week
- `mood-chill`
- `mood-workout`
- `mood-late-night`
- `mood-focus`
- Up to three genre-based daily mixes
- One decade station

These are written into the per-user `curated` table, replacing the previous version of each slug rather than creating unlimited playlists (`db.rs:566`, `db.rs:4127`).

### What the LLM does here

The LLM does not select songs for the first three background curator lists.

`name_lists()` receives six already-selected tracks from each list and asks the model only for titles and blurbs. Temperature is `0.7` (`curator.rs:1243`). Remaining playlist families have fixed names.

Background curator song selection is traditional code, not LLM selection.

### Home AI Daily Mixes

This is a separate system in `server/src/home.rs:309`.

It runs when `/api/home` is requested and the per-user daily cache is missing or older than 24 hours (`home.rs:34`, `home.rs:181`). Its candidates are:

- Up to 60 heavy-rotation tracks from the last 30 days
- Up to 24 songs from each of the user’s eight top artists
- The 60 newest tracks that user has never played
- Truncated to 240 total candidates

That selection is in `home.rs:314`.

The problematic source is `Db::unplayed()`: it returns the newest unplayed songs from the entire shared server library, ordered solely by `added_at` (`db.rs:2757`).

The LLM receives eight top artists and their play counts, fifteen recently played titles, and candidate `id | artist | title` lines. It receives no genre, enrichment, affinity score, skip rate, album, mood, sonic data, or reason for candidacy.

It selects and orders the songs itself at temperature `0.8` (`home.rs:350`). IDs are validated, but there is no post-LLM relevance ranking.

This is the path most vulnerable to unrelated server-library leakage.

### Heuristic Home mixes

When no AI is configured, Home creates On Repeat, a top-artist spotlight, a second-top-artist mix, a top raw-genre mix, and newest unplayed songs (`home.rs:223`). The first four are plainly personalized. The last is again server-wide newest-unplayed content.

## 3. Current User Personalization

AttackFM does not have a single persistent User Taste Profile.

It computes several temporary representations independently:

- `Taste` in `curator.rs`
- Richer station centroids inside `dj.rs`
- Top-artist and recent-title summaries in `home.rs`
- A Collector exploration value in `collector_state`
- Per-artist AI DJ exploration statistics in `dj_impressions`

The basic `Taste` contains only a lyric embedding centroid, median BPM, raw genre shares, and a set of recently heard track IDs (`curator.rs:766`).

### Signal inventory

| Signal | Storage | Auto playlists | AI DJ | Discovery/download | Value |
|---|---|---:|---:|---:|---|
| Qualifying play counts | Per-user `plays` | Yes, primary | Fallback | Artist seeds | High |
| Full listen events | Per-user `listen_events` | No in `curate_cycle()` | Yes | Yes | Very high |
| Milliseconds listened | `listen_events.ms_listened` | No | Indirect | Indirect | High |
| Completion | `listen_events.completed` | No | Yes | Yes | Very high |
| Early skip | `listen_events.skipped` | No | Yes | Yes | Very high |
| Favorites | Per-user `favorites` | No | Yes | Some paths | Very high |
| Unfavorite | Current state only | No negative meaning | Removes boost | No durable negative | Medium |
| Explicit dislikes | No durable model | No | No | Dismiss deletes row | High |
| Existing playlists | `playlists`, `playlist_tracks` | No | No | No | High |
| Playlist add/remove events | Not recorded | No | No | No | High |
| Search/open history | `search_recents` | No | No | No | Medium-high |
| Repeat listening | Plays and events | Yes, 30-day count | Capped weighting | Weighted | Very high |
| Album returns | Derivable | No curator feature | No | No | High |
| Playback context | `listen_events.context` | No | Separate impressions | No | High |
| AI queue adoption | `dj_impressions` plus events | No | Exploration only | No | High |
| Personal DJ notes | `track_dj_notes` | No | Used in analysis | No | Medium-high |
| Enriched metadata | Shared track profiles | Thin | Extensive | Almost none | Very high |

### Negative-signal mismatch

The code already contains `weighted_recent_listens()`:

- Completion: `1.0`
- Skip: `0.15`
- Neutral abandonment: `0.5`
- Favorite bonus: `0.5`
- Per-track cap: `3.0`

See `server/src/db.rs:2420`.

But `curate_cycle()` does not use it. It calls `top_plays()` and assigns every selected track equal weight (`curator.rs:1018`). The AI DJ and external discovery do use weighted verdicts.

Despite its name, `weighted_recent_listens()` has no date predicate. It aggregates all historical events for the 60 tracks whose last event is newest. This is neither a proper recent profile nor a proper long-term profile.

## 4. Current Candidate Selection

### Background curator

```text
ENTIRE LIVE SHARED LIBRARY
  -> remove recent tracks
  -> remove unadopted Collector auditions
  -> score every remaining track against thin user taste
  -> artist cap
  -> playlist
```

The score is:

```text
45% lyric-vector similarity
30% BPM proximity
25% exact raw-genre affinity
```

See `server/src/curator.rs:853`.

Limitations:

- Genre matching is an exact lookup against the raw genre string.
- An unseen genre gets `0.15`, not a musical adjacency score.
- Multi-value genre tags are treated inconsistently.
- Enriched genres and subgenres are loaded but ignored by `score()`.
- Sonic vectors are ignored.
- Energy, brightness, dynamic range, rhythmic activity, and audio fingerprint are ignored in the main score.
- ListenBrainz similarity and community vectors are ignored.
- Favorite status is ignored.
- Skip history is ignored.
- There is no minimum score threshold.
- Missing fields fall back to neutral `0.5`, allowing poorly measured tracks to rank deceptively well.

### Home AI mixes

The candidate list is partially personalized, but the global newest-unplayed slice is not scored before reaching the LLM. The model sees only artist and title. There is no deterministic reranker after its response.

### Playlist suggestions

Manual playlist suggestions are scored against the playlist’s members rather than the owner’s general taste. That is a sensible coherence decision (`curator.rs:1431`), but it uses the same thin lyric/BPM/raw-genre score and scans the full library.

## 5. Current Music Discovery and Download Architecture

### Candidate harvesting

Every six hours, per active user, discovery:

1. Finds the user’s top eight artists from the last 30 days.
2. Resolves each in Deezer.
3. Gets the seed plus up to eight related artists.
4. Takes up to six top tracks per artist.
5. Removes songs already present anywhere on the server.
6. Stores candidates in a per-user `discoveries` pool.

See `server/src/discovery.rs:321`.

Additional acquisition channels are ListenBrainz similar artists and MusicBrainz relationships around obscure hearted artists. They feed the same per-user pool (`listenbrainz.rs:223`).

### Cold-start fallback

If a user has no recent top artists, discovery seeds from the artists with the most files in the entire server library (`discovery.rs:232`). This is the clearest place where server contents are treated as personal taste. On a multi-user server, that fallback is unsafe.

### Candidate scoring

For four candidates per cycle, AttackFM fetches lyrics, embeds them, measures BPM from a preview, compares those to temporary taste, and adds a small inverse-popularity bonus (`discovery.rs:584`).

External candidates carry no genre into scoring, so the genre quarter of the score falls back to neutral. The effective ranking is primarily lyrics, BPM, and obscurity.

### New Music LLM playlists

The top 60 scored discoveries are sent to the LLM for grouping. It sees artist, title, and seed artist, but no enrichment or numerical explanation beyond list order (`discovery.rs:785`). It groups existing candidates and cannot invent arbitrary music.

### Automatic downloads

The Collector starts at boot and runs every five minutes (`collector.rs:88`). For each active enabled user it:

1. Rescores that user’s discovery pool.
2. Reads the best 24 candidates.
3. Requires a score over a per-user exploration threshold.
4. Requires BPM or lyrics to have been measured.
5. Excludes previously attempted candidates.
6. Searches Spotify for an exact artist/title match.
7. Enqueues one import globally.

See `collector.rs:135`.

The Collector’s LLM only writes a human-readable reason. It does not decide what to buy (`collector.rs:244`).

### User association and shared visibility

Downloaded tracks are stamped with `curator_user_id` and begin as unpromoted auditions (`db.rs:5414`). The client hides them from the main library and shows them only on the initiating user’s For You shelf.

A completed listen or favorite promotes the track into the global shared library (`listens.rs:121`, `api.rs:371`). Any user who completes or hearts the audition can promote it because promotion is track-global.

## 6. Problems Found

### Critical

1. **Home AI mixes can leak unrelated shared-library content into LLM-selected playlists.** The newest 60 unplayed tracks are global and unranked.
2. **There is no canonical taste and ranking service.** Home, Curator, AI DJ, stations, discovery, and Collector calculate taste differently.

### High

3. The background curator ignores completions, skips, and favorites despite already having the data and weighted query.
4. Long-term identity and current interest are not modeled separately.
5. Most enrichment is disconnected from automatic playlists and acquisition.
6. Cold-start discovery uses server inventory as personal taste.
7. Playlist intent is recipe-driven rather than behavior-driven.
8. No relevance floor exists for playlist membership.

### Medium

9. Existing playlists, searches, manual selection, albums, and playback context are unused.
10. Discovery dismissal is not durable. It deletes the row, allowing rediscovery (`discovery.rs:899`).
11. “Fresh Finds” is global server chronology, not personal freshness.
12. Exhaustively decoding and scoring every track for every listener will become expensive.
13. The global curator rebuild timestamp can delay an individual listener.
14. Exact raw-genre equality cannot represent musical adjacency.

### Low

15. LLM naming can make weakly related lists sound more intentional than their ranking is.
16. Playlist and new-music caches are memory-only, so restarts erase cached concepts.

## 7. Missing User Signals

The highest-value already-collected but underused signals are:

1. Completion and skip verdicts
2. Favorite state
3. Repeat-listen strength
4. Album-level returns
5. Search/open history
6. Playlist membership
7. Playback context
8. DJ impression adoption
9. Collector audition adoption or abandonment
10. Personal DJ notes

AttackFM should also record playlist add/remove events, explicit recommendation dismissal, queue abandonment and continuation, manual selection versus passive autoplay, artist/album engagement, and recommendation exposure.

A song should not be considered rejected merely because it was never played unless the system knows it was shown or queued.

## 8. Recommended User Taste Model

Use a hybrid model. Behavioral events remain the source of truth, with a materialized per-user profile for fast retrieval and inspection.

The profile should contain:

- Long-term and recent artist affinities
- Long-term and recent genre/subgenre affinities
- Album affinity
- Semantic and sonic centroids for multiple time horizons
- Favorite and completion boosts
- Skip and dismissal penalties
- Exploration tolerance
- Familiar artist and genre sets
- Current-interest deltas
- Data coverage and confidence
- Profile version and generation timestamp

Recommended horizons:

- Current session/day
- Recent: approximately 14 to 30 days with time decay
- Long-term: six to twelve months or all history with slower decay

An initial blend could be:

```text
55% long-term identity
35% recent interest
10% current session
```

Those are starting points, not fixed product requirements. An LLM may summarize the profile into readable concepts, but should not author the underlying affinities.

## 9. Recommended Retrieval and Ranking System

Create one shared recommendation module used by playlists, AI DJ, discovery, and Collector.

Retrieve through several lanes:

- Familiar tracks and artists
- Deep cuts from strong-affinity artists
- Sonic neighbors
- Enriched genre/subgenre neighbors
- Collaborative or scene neighbors
- Recent-interest matches
- Long-term identity matches
- Unfamiliar exploration candidates

Union those into a few hundred candidates rather than scanning or sending the entire library on every request.

Score using:

```text
personal affinity
recent-interest affinity
playlist/theme relevance
sonic similarity
semantic genre/subgenre similarity
artist/scene relationship
positive behavior
negative behavior
novelty
diversity
metadata confidence
```

Apply relevance floors, artist and album caps, recent-play suppression, duplicate-version suppression, personal quarantine rules, and diversity reranking. Return score explanations for auditability.

## 10. Recommended Curator Architecture

### Database and statistical logic

Own event aggregation, time decay, time horizons, affinities, completion/skip statistics, exposure/adoption data, profile materialization, and candidate eligibility.

### Recommendation and retrieval logic

Own candidate lanes, similarity search, personal relevance, exploration classification, diversity, thresholds, and final validated ordering.

### Enrichment system

Own canonical genres/subgenres, mood, energy, sonic vectors, audio fingerprints, instrumentation, production descriptors, scene/influence/community relationships, confidence, and provenance.

### LLM curator

Own concept generation from behavioral evidence, interpretation of current shifts, naming and explaining concepts, less-obvious musical connections, and arranging a small already-relevant candidate set for flow.

The LLM should not own first-pass library search or personal relevance.

## 11. Recommended Music Discovery Architecture

```text
USER TASTE PROFILE
  + recent-interest delta
  + exploration setting
  + owned server inventory
  + prior discovery outcomes
            ↓
IDENTIFY PERSONAL GAPS
            ↓
ARTIST / SCENE / SONIC / INFLUENCE RETRIEVAL
            ↓
CATALOG CANDIDATES
            ↓
ENRICH OR MEASURE
            ↓
PERSONAL FIT + NOVELTY + CONFIDENCE SCORE
            ↓
DISCOVERY FEED
            ↓
STRICTER COLLECTOR THRESHOLD
            ↓
USER-SPECIFIC AUDITION
```

Key rules:

- Remove the global library-size cold-start fallback.
- Use onboarding picks, favorites, imported playlists, or neutral onboarding until real history exists.
- Preserve per-user discovery provenance after global promotion.
- Add durable rejection memory.
- Track initiating-user adoption separately from global adoption.
- Require stronger evidence for automatic download than for a free recommendation.
- Use acquisition quotas per user as well as a global storage cap.

## 12. Exploration Strategy

The AI DJ already has the beginning of the right model: explicit exploration positions, unmet artists, per-artist impressions, Thompson sampling, and adoption through completion or favorite (`dj.rs:316`).

Generalize this so candidates are labeled:

- `familiar`
- `adjacent`
- `exploratory`
- `wildcard`

A practical initial playlist target:

```text
65% familiar/high-confidence
25% adjacent discovery
8% exploratory
2% wildcard
```

The allocation should vary by playlist intent. Wildcard candidates should still pass a basic compatibility floor. Wildcard should mean a longer musical bridge, not arbitrary server content.

## 13. Current and Proposed Architecture Diagrams

### Current background playlists

```text
QUALIFYING PLAYS, LAST 30 DAYS
            ↓
TOP 60 DISTINCT TRACKS
            ↓
LYRIC CENTROID + BPM MEDIAN + RAW GENRE SHARES
            ↓
ENTIRE SHARED SERVER LIBRARY
            ↓
THREE-FIELD SCORE
            ↓
FIXED PLAYLIST RECIPES
            ↓
OPTIONAL LLM NAMES THREE LISTS
            ↓
PER-USER CURATED TABLE
```

### Current Home AI mixes

```text
TOP ARTISTS + RECENT TRACKS
        + TOP-ARTIST CATALOGUES
        + 60 NEWEST UNPLAYED SERVER TRACKS
                    ↓
        UP TO 240 ID/ARTIST/TITLE ROWS
                    ↓
            LLM SELECTS + ORDERS
                    ↓
          DAILY IN-MEMORY MIX CACHE
```

### Current discovery and downloads

```text
USER'S TOP ARTISTS
  OR GLOBAL LIBRARY-SIZE FALLBACK
            ↓
DEEZER / LISTENBRAINZ / MUSICBRAINZ NEIGHBORS
            ↓
PER-USER DISCOVERY POOL
            ↓
LYRICS + BPM
            ↓
THIN USER-TASTE SCORE
            ↓
DISCOVERY FEED / LLM GROUPING
            ↓
COLLECTOR THRESHOLD
            ↓
USER-STAMPED QUARANTINED DOWNLOAD
            ↓
COMPLETION OR HEART
            ↓
GLOBAL SHARED LIBRARY
```

### Proposed architecture

```text
PLAYS + LISTEN EVENTS + FAVORITES + PLAYLISTS
SEARCHES + IMPRESSIONS + DISMISSALS + CONTEXT
                         ↓
              BEHAVIOR AGGREGATION
                 ↙               ↘
       LONG-TERM PROFILE     RECENT/SESSION DELTA
                 ↘               ↙
                USER TASTE CONTEXT
                         ↓
       SHARED LIBRARY + ENRICHED METADATA
                         ↓
          MULTI-LANE PERSONAL RETRIEVAL
                         ↓
        RELEVANCE + NOVELTY + DIVERSITY SCORE
                         ↓
          SMALL LABELED CANDIDATE SET
                         ↓
                 LLM CURATOR
                         ↓
        PLAYLIST / DJ SET / DISCOVERY PLAN
                         ↓
          EXPOSURE + ADOPTION FEEDBACK
```

## 14. Concrete Implementation Plan

| Step | Modules | Change | Dependencies | Risk | Migration |
|---|---|---|---|---|---|
| 1 | `curator.rs`, `home.rs`, `dj.rs`, `discovery.rs` | Define one shared `TasteContext` and scoring contract | None | Medium | No |
| 2 | `curator.rs`, `db.rs` | Make curation use completion, skip, and favorite-weighted signals | Step 1 | Low | No |
| 3 | `db.rs` | Split recent and long-term aggregation with explicit time windows and decay | Step 1 | Medium | No |
| 4 | New recommendation module, `db.rs` | Centralize retrieval, scoring, explanations, and diversity | Steps 1–3 | High | No initially |
| 5 | `home.rs` | Replace raw global `unplayed(60)` with ranked exploration candidates | Step 4 | Medium | No |
| 6 | `curator.rs`, `db.rs`, enrichment models | Add sonic, audio, enriched genre/subgenre, community, and confidence signals | Step 4 | Medium-high | No |
| 7 | `db.rs`, listener update hooks | Materialize recent and long-term profiles with versioning | Steps 1–6 | Medium | Yes |
| 8 | `db.rs`, playlist/search/client routes | Add playlist-action, dismissal, and recommendation-exposure events | Profile schema | Medium | Yes |
| 9 | Curator or new intent module | Generate playlist intents from affinities and recent deltas | Profile available | Medium | Possibly |
| 10 | `discovery.rs`, `listenbrainz.rs` | Replace server-size cold start and retrieve through profile lanes | Steps 4, 7 | Medium | No |
| 11 | `collector.rs`, `db.rs` | Separate initiating-user adoption from global promotion and remember rejection | Step 8 | Medium-high | Yes |
| 12 | `dj.rs`, `curator.rs`, `home.rs` | Generalize familiar/adjacent/explore/wildcard allocation | Shared scoring | Medium | Possibly |
| 13 | Tests and diagnostics | Add golden users, cross-user isolation tests, relevance audits, explanations | All | Low | No |
| 14 | Backfill job | Build profiles from existing history, favorites, and playlists | Profile schema | Low-medium | Data backfill |

The first implementation should consolidate existing logic rather than add another recommendation engine beside the current systems.

## 15. Quick Wins

1. Change `curate_cycle()` to use `weighted_recent_listens()` instead of equal-weight `top_plays()`.
2. Add a real 30-day predicate to recent weighted listening and create a separate all-time query.
3. Remove the newest 60 globally unplayed tracks from Home AI candidates.
4. Replace them with the top taste-scored unplayed tracks and include scores/reasons in the prompt.
5. Pass enriched genres, specific tags, mood, energy, and sonic descriptors into Home candidate descriptions.
6. Add favorite boosts and skip penalties to background playlist scoring.
7. Apply a minimum relevance threshold so weak results produce a shorter playlist or no playlist.
8. Exclude global fresh tracks unless they clear a personal affinity threshold.
9. Remove `library_seed_artists()` as the cold-start discovery fallback.
10. Persist discovery dismissals so rejected songs and artists do not immediately return.
11. Reuse the AI DJ’s richer station scoring in automatic playlists instead of maintaining the legacy score.
12. Add cross-user tests proving that User B’s imports do not affect User A without behavioral evidence.

The strongest immediate intervention is to fix Home AI candidate generation. The strongest architectural intervention is to promote the AI DJ’s richer scoring into one shared recommendation service used everywhere.
