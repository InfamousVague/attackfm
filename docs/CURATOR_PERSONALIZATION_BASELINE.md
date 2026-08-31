# AttackFM Curator Personalization Baseline

Captured on 2026-08-20 from `feat/gemma-ai-dj` at `8d20b36`. This is a Stage 0/1 test artifact, not a recommendation redesign. All data below is synthetic and is loaded into a fresh temporary SQLite database. No real AttackFM database, library, network service, or LLM is used.

## Deterministic listeners and shared library

All five users see the same 18-track library.

| User | Identity | Recent lane | Positive evidence | Explicit negatives |
|---|---|---|---|---|
| `fixture-metal` | metal, industrial metal, hardcore, noise rock | industrial, EBM, synth punk | Ministry, HEALTH, Nine Inch Nails | early skips on K-pop |
| `fixture-kpop` | K-pop, dance pop, electropop | darker electronic pop | aespa and distinct K-pop tracks | early skips on metal/hardcore |
| `fixture-jazz` | bebop, modal jazz, fusion | spiritual jazz | Alice Coltrane and jazz tracks | none required for baseline |
| `fixture-mixed` | metal, K-pop, and jazz | deliberately broad | tracks from every main lane | none required for baseline |
| `fixture-no-history` | no inferred identity | none | none | none |

The shared inventory contains familiar tracks (IDs 1-12), adjacent bridges (13 EBM, 14 electropop, 15 jazz fusion), and unrelated globally newest K-pop imports (16-18). Insert order is never used to break test ties; queries under test have explicit secondary ordering or assertions avoid tied ordering.

## Surface snapshots

These surfaces remain separate because the current application does not have one shared taste model.

### Background curator

The executable snapshot builds the real legacy `Taste` from per-user `top_plays()`. For the Metal fixture it contains heard IDs 1-4, a 132 BPM weighted-median baseline, four equal raw-genre shares, and the mean fixture lyric vector. The real `score()` snapshot records its 45% lyric, 30% tempo, and 25% exact raw-genre behavior: an exact measured match scores `1.0`; the fixed unrelated example scores `0.3031006`. Enrichment is present on fixture tracks but has no score component or provenance in this legacy path.

| Fixture | Current deterministic curator input/output |
|---|---|
| Metal | heard 1-4; tempo 132; four equal raw genre shares |
| K-pop | heard 5-8; tempo 122; K-pop share 0.75, dance-pop share 0.25 |
| Jazz | heard 9-12; tempo 92; four equal raw genre shares |
| Mixed | heard 1, 3, 5, 7, 9, 11; tempo 124; six equal raw genre shares |
| No history | empty centroid, tempo, genres, and heard set; below the four-track curation gate |

Known bad: adding skip events and a favorite without adding qualifying plays leaves the background-curator taste byte-for-byte unchanged. Candidate provenance is `all_features -> not heard -> not quarantined -> legacy score`; listen verdict and favorite provenance are absent.

### Home candidate generation and saved AI response

For the Metal fixture, `Db::unplayed(metal, 3)` returns `[18, 17, 16]`: the three globally newest K-pop imports. Their only provenance is `global newest + unplayed by requesting user`; there is no personal score component.

The offline response at `server/tests/fixtures/home_ai_response.json` contains one reasonable industrial mix and one explicitly named known-bad mix selecting IDs 16-18. The automated test verifies every saved ID belongs to the supplied pool. This demonstrates why candidate validation alone cannot prevent unrelated content after the current Home retrieval step.

The globally newest slice is IDs 18, 17, 16 for Metal, K-pop, Jazz, Mixed, and No-history alike because none has qualifying plays on those rows. Their personalized heavy-rotation/top-artist portions differ, but this newest slice does not.

### Discovery

For the no-history fixture, the real fallback helper returns `Newest Idol Batch (3)` first because it has the most files in shared inventory. The second seed is `Alice Coltrane (1)` by the current deterministic alphabetical tie-break. Provenance is `server-wide artist file count`, not user behavior. This is an intentionally captured known-bad baseline.

Discovery rows themselves are correctly keyed by user: a `k-only` candidate inserted for the K-pop fixture is absent from the Metal fixture's pool.

Fixture seed provenance before any network harvest is Metal -> its played metal artists; K-pop -> its played K-pop artists; Jazz -> its played jazz artists; Mixed -> artists across all three lanes; No-history -> the known-bad shared-inventory count fallback. The harness stops before Deezer/ListenBrainz/MusicBrainz so the snapshot stays offline.

### Collector

The Collector's deterministic selection input is the requesting user's scored discovery pool. The fixture records a K-pop candidate at `0.95`, and only the K-pop user can retrieve it. A Collector track promoted by the K-pop user becomes visible inventory to Metal through `unplayed`, but it gives Metal no play, favorite, or legacy-taste boost. Candidate provenance remains the initiating user's discovery row; the test does not call Spotify or download a file.

### AI DJ

AI DJ is captured separately because it already consumes richer per-user behavior. The fixture preserves completed listens, early skips, favorites, enrichment, and shared inventory as distinct inputs. Cross-user mutations leave the Metal user's legacy base taste unchanged, while the database's verdict-aware query remains user-keyed. No stochastic DJ queue or live model output is treated as a golden snapshot in Stage 0; doing so would disguise randomness as determinism. Later queue work must preserve this separation and can add a seeded queue snapshot when the DJ sampler exposes a fixed RNG.

## Concrete baseline judgments

Good recommendations to preserve:

1. Metal -> Front 242, `Body Voltage` (adjacent EBM bridge).
2. K-pop -> Purity Ring, `Dark Bloom` (adjacent darker electropop bridge).
3. Jazz -> Sons of Kemet, `Burning Reeds` (adjacent jazz-fusion bridge).

Bad examples future stages must fix:

1. Metal Home candidates include IDs 16-18 only because they are newest globally.
2. A no-history user inherits `Newest Idol Batch` as the top discovery seed from file counts.
3. Background curation treats completed, skipped, and favorited evidence as irrelevant when qualifying play IDs are unchanged.

## Stage 0/1 interpretation

Known-bad tests are named `known_bad_baseline_*` and pass only while they accurately describe the audited implementation. They must be deliberately rewritten when the responsible later stage fixes the behavior.

Passing isolation guarantees now cover:

- User B's imports, plays, completions, skips, favorites, playlists, and recent trend do not change User A's legacy `Taste`.
- Promoted Collector inventory becomes globally available without adding personal affinity to an unrelated user.
- Discovery/Collector candidate rows remain keyed to their initiating user.
- All users share inventory while behavioral rows remain distinct.
- A reusable unrelated-genre ceiling assertion is available for later recommendation-output tests.

Stage 1 does not claim that shared inventory cannot enter a candidate pool. The Stage 0 known-bad tests prove that it currently can. The preserved contract is narrower and precise: inventory availability alone must not become personal affinity.

## Stage 2 shared context

Stage 2 moved the common lyric-centroid, weighted-median BPM, raw-genre shares, and heard IDs into `server/src/recommendation.rs` as `TasteContext`. Curator, discovery, AI DJ, and radio now consume that shared type/builder; Home can consume the same crate-level context without another taste implementation. Specialized DJ and playlist-theme scoring remains in its original modules.

The context also reports requested/matched tracks, per-signal coverage, and confidence. Missing or invalid features remain neutral and cannot produce invalid scores. Heard IDs remain a separate eligibility set rather than being encoded as affinity.

All Stage 0 score and fixture snapshots remain unchanged. One documented eligibility correction was made: unpromoted Collector auditions are filtered before they can seed the shared context. Book tracks were already excluded by the database aggregation and remain excluded. With no recorded history, the builder returns no behavioral context, matching the client's history-off behavior (the client writes no listening events when that switch is off).

## Stage 3 honest listening signals

Stage 3 replaces the background curator's equal-weight play-ID profile with the shared verdict-aware context. The aggregation rules are explicit:

- completed listen: `+1.0`
- neutral partial listen: `+0.35`
- early skip: `-0.35`
- favorite: `+1.5`, including a favorite with no listen event
- recoverable minimum per track: `0.05`
- breadth-preserving maximum per track: `3.0`

Neutral partial listens therefore count as mild positive exposure, not a completion and not a rejection. Repeated skips can lower a track to the recoverable floor but cannot create a permanent ban. Every recent exposure remains in `heard`, regardless of its affinity weight, so a skipped song is not immediately offered back.

Recent taste has an explicit 30-day predicate. Long-term taste uses the same verdict accounting over all history. The shared context exposes both input sets separately, then builds the curator's base profile from 65% long-term identity and 35% recent interest. Lifetime listening can shape affinity without excluding a song forever; only recent exposure populates `heard`. Play starts remain a compatibility fallback until a listener has four tracks with verdict/favorite evidence.

## Stage 4 enrichment-backed shared scoring

The shared automatic-playlist scorer now returns deterministic component scores for lyrics, sonic similarity, measured audio, enriched genres, specific tags/subgenres, and community evidence, plus total evidence coverage and the final score. Its weights are 12% lyrics, 18% sonic, 30% measured audio, 15% genre, 20% specific tags, and a capped 5% community contribution.

Canonical enriched genres and specific tags are preferred when their stored deterministic confidence and provenance are usable. Raw file genre remains a lower-confidence fallback. Enrichment with no source stamp, a rejection stamp, or low confidence is pulled toward neutral and cannot dominate measured audio. Profile-side semantic confidence is also retained, so normalizing a set of weak labels cannot accidentally turn it into a strong taste signal.

The measured-audio component prefers the versioned 48-part local fingerprint and uses cosine similarity there. Rows awaiting fingerprint backfill use normalized BPM, energy, brightness, dynamic range, and rhythmic activity when at least three values exist; those positive-only measurements use normalized distance rather than cosine. Missing evidence is neutral, but it also reduces how far a sparse candidate's total can move away from neutral, preventing incomplete rows from gaining a hidden ranking advantage.

Automated fixtures prove that an industrial/EBM bridge beats unrelated pop, a specific subgenre beats an otherwise equivalent broad genre, sonic opposites differ from missing sonic data, low-confidence semantics cannot defeat a strong measured-audio match, community similarity cannot outweigh a strong sonic mismatch, and repeated scoring is deterministic. The legacy three-component Stage 0 calculation remains separately snapshotted through `score_parts`; production library scoring intentionally uses the richer Stage 4 path.

## Stage 5 prequalified Home AI candidates

Home no longer appends `unplayed(user, 60)` to the local model's candidate pool. Candidate chronology is absent from AI retrieval. The deterministic pre-model layer now builds five labeled lanes: familiar monthly rotation, deep cuts from top artists, recent-interest matches, adjacent high-fit library tracks, and a maximum ten-track exploration tail. Normal personal-fit lanes require a shared Stage 4 relevance score of at least `0.52`; exploration requires at least `0.40` and is explicitly labeled rather than presented as affinity.

Every prompt row carries track ID, artist/title, lane, relevance, personal reason, and available enriched genres, specific tags, and sonic traits. The model can name, arrange, and describe prequalified material but cannot establish relevance.

Returned mixes pass a deterministic gate after the model: unknown and below-floor IDs are removed, duplicates are removed, each artist is capped at three tracks, exploration is capped at two tracks per mix, and playlist size is bounded to 4–20 tracks. Empty, malformed, unreachable, or otherwise weak model output falls back to mixes built from the same prequalified candidates; it does not fall through to the old raw-newest AI pool.

The shared fixture's globally newest K-pop batch no longer enters the Metal listener's familiar, deep-cut, recent-interest, or adjacent lanes. It may appear only through the bounded exploration lane when it independently clears that lane's floor. Metal and mixed-taste fixtures produce distinct candidate sequences. Offline tests also prove that an attractive title cannot rescue a below-floor candidate and that a model selecting every wildcard cannot exceed the post-model exploration cap.

## Stage 6 behavior-driven playlist intents

Background curation now derives deterministic playlist intents from separately inspectable long-term and 30-day taste contexts. A long-term genre needs at least a `0.12` weighted share. A recent-shift intent needs at least a `0.15` recent share and an increase of at least `0.08` over its long-term share. The standing On Repeat, mood, and decade recipes remain available as evergreen fallbacks.

Every generated intent has a stable key, kind (`long-term` or `recent-shift`), normalized genre lane, and concrete evidence text. The local model may supply a title and blurb only for those supported slots; extra valid-JSON concepts are discarded. Candidate sets with Jaccard overlap of `0.60` or more are deduplicated. Intent key/name/evidence mappings are persisted in `curator_intents`, so a still-supported concept keeps its identity across rebuilds.

Focused proof covers an industrial/EBM spike without erasing long-term metal/hardcore identity, stable concepts when no shift exists, rejection of an unsupported K-pop model concept, enriched/raw genre matching, and deduplication of differently named near-identical lanes. Tests use synthetic contexts and saved JSON only; no live model is called.

## Stage 7 personal discovery cold start and rejection memory

Discovery no longer uses server-wide artist file counts as a cold-start signal. Seeds now come, in order, from the requesting listener's recent top artists, long-term artists, favorites, and playlist membership. A user with no evidence receives an honest empty state. Existing ListenBrainz small-artist similarity and MusicBrainz scene/collaborator walks remain active.

Every discovery row stores its retrieval lane (`recent-artist`, `long-term-artist`, `favorites`, `playlist`, `date-verdict`, `listenbrainz-similar`, or `musicbrainz-scene`). A track dismissal hard-blocks that recording for 90 days. An artist dismissal hard-blocks the artist for 30 days and keeps it out of the seed seat for a 60-day soft window; the memory remains inspectable after those windows rather than disappearing immediately or becoming a permanent ban. Rejections are keyed by user, so one listener cannot suppress another's retrieval.

The migration adds `discoveries.lane`, `discovery_rejections`, and `curator_intents`. New tables use cascading user ownership. Catalog sources do not expose compatible enriched sonic vectors for unowned candidates, so external scoring still measures lyrics and preview BPM; genre/sonic external retrieval remains a known limitation while existing relationship walks supply adjacent and obscure artists.

## Stage 8 versioned materialized taste profiles

`user_taste_profiles` stores algorithm version `1`, generation time, dirty state, confidence, recent weights, long-term weights, and a human-readable JSON summary. Raw plays, listen events, favorites, and playlist membership remain the source of truth. A playlist membership contributes a mild `+0.25` long-term weight once per distinct track and remains subject to the existing `3.0` cap. The recommendation blend remains 65% long-term and 35% recent.

The shared `for_db()` reader now loads a clean matching profile and rebuilds only the requesting listener when the row is absent, dirty, older than 24 hours, malformed, or on another algorithm version. Plays, listens, favorites, and playlist-content changes dirty only their owner. A detached startup backfill builds eligible existing users without delaying the listening port. `GET /api/profile/taste` lets a listener inspect themselves; an administrator may specify another user, and a non-admin receives `403` for another listener. `rebuild=true` supplies the explicit full-rebuild/debug path.

Automated proof covers deterministic repeated rebuilds, playlist-aware backfill, dirty per-user refresh matching a full rebuild, version-triggered rebuilding, deletion cascade, private access policy, and migration from pre-Stage-7 `discoveries` and `curator_pulls` schemas.

## Stage 9 Collector ownership, confidence, and pacing

Collector still uses the shared discovery/profile score but applies a stricter threshold of `0.72 - 0.16 * exploration`, or `0.56` to `0.72`, versus the free discovery feed floor of `0.45`. A candidate must have a retrieval lane and measured preview BPM or lyric evidence; one measured family gives metadata confidence `0.65`, both give `1.0`, and unmeasured neutral candidates remain ineligible.

The global unadopted-audition cap remains 250 GB by default. Per listener, Collector now permits at most four pulls in a rolling seven days and at most 25 GB of unadopted auditions. Pull outcomes distinguish `adopted-initiator`, `adopted-other`, `skipped`, `dismissed`, `untouched`, and `deleted`. Completion or favorite records the acting listener before global promotion; only the initiating listener's adoption tunes their exploration dial. Settled outcomes move exploration in small bounded steps around a 35% hold rate.

The migration extends `curator_pulls` with `outcome`, `outcome_at`, and `adopted_by`. Tests prove that a free recommendation can fail the download bar, unmeasured or provenance-free rows cannot be bought, pacing limits hold, adoption/abandonment move reach gradually, and another user's global promotion does not count as the initiator's adoption.

## Stage 10 familiarity, allocation, and exploration learning

Library candidates are classified from explicit evidence as `familiar`, `adjacent`, `exploratory`, or `wildcard`. Familiar means a known track or artist. Adjacent requires score `>= 0.60` and evidence coverage `>= 0.25`; exploratory requires `>= 0.48` and coverage `>= 0.20`; wildcard requires the basic relevance floor `>= 0.40` and coverage `>= 0.15`. External discovery cannot be familiar because it is unowned; it requires both a seed bridge and retrieval lane, then uses `0.62`, `0.52`, and `0.45` for adjacent, exploratory, and wildcard.

General mixes target 65% familiar, 25% adjacent, 8% exploratory, and 2% wildcard with deterministic largest-remainder rounding. Recent-shift/discovery-oriented intents use 10%, 45%, 35%, and 10%. Shared reranking preserves relevance inside each class, caps one artist at two tracks, and rejects anything below wildcard compatibility. Home, background intent/mood lists, AI DJ, and Discovery now expose or record these classes.

`recommendation_exposures` records one exposure per candidate/surface/class/day and later completion/favorite adoption. Recently exposed exploratory/wildcard artists are suppressed from Home's exploration tail for seven days. Settled class outcomes adjust future relevance by at most `±0.03`, so success raises confidence gradually and failure fades without becoming a ban. Class learning and exposure rows remain per user.

## Stage 11 private recommendation diagnostics

`GET /api/debug/recommendations` is disabled unless `AFM_RECOMMENDATION_DIAGNOSTICS=1`. When enabled it still requires authentication; listeners may inspect only themselves and administrators may inspect another user. It reports profile version/age/confidence, persisted intent evidence, actual curated playlist order, retrieval lanes, familiarity class, available score components, pre/post-diversity rank, quarantine/recent/rejection filters, discovery bridges, and the exact limited role of the LLM on each surface.

Missing signals are serialized with `present: false` rather than receiving a claimed explanation. The response is built from fixed recommendation fields and does not include environment values, filesystem paths, model URLs, tokens, or credentials. Automated proof checks privacy policy, missing-signal honesty, safe serialization, and diagnostic order against the actual stored playlist order.

## Stage 12 final local validation

Final automated validation on 2026-08-20:

- `cd server && cargo test`: **passed**, 135 passed, 0 failed, 3 ignored network/integration tests.
- Fixture, cross-user, migration, profile consistency, deterministic allocation, Collector ownership, and diagnostics proofs are included in that suite and passed.
- `npm run typecheck`: **passed**.
- `npm run build`: **passed**.
- `git diff --check`: **passed**.
- Test databases use unique temporary directories. No test reads `AFM_DATA_DIR`, the real AttackFM database, or the real music library, and no automated test calls a live LLM.

The production build retains known pre-existing warnings: runtime resolution of `app.css`, an existing CSS parser warning at `@keyframes navMoreRise`, and the existing large `app.js` chunk warning. `cargo fmt --check` also reports broad pre-existing repository formatting drift across unrelated crates and modules; it was not applied because doing so would create the prohibited mass-format rewrite.

Manual listening against a copy of Kevin's real history/library was intentionally not performed because this overnight task explicitly prohibited using the real AttackFM database or music library for test fixtures. The deterministic synthetic review is complete; real-data listening review remains the one human acceptance step.
