# AttackFM Curator Personalization Checklist

This is the working checklist for turning the current curator into something that genuinely understands each listener. The goal is to make progress in small pieces, test each piece locally, and avoid replacing one mysterious recommendation system with another mysterious recommendation system.

The audit behind this plan lives in `docs/CURATOR_PERSONALIZATION_AUDIT.md`.

## How We Will Use This Checklist

Each stage has four parts:

1. **Build:** The code or data change.
2. **Automated proof:** Tests that should fail before the change and pass after it.
3. **Local listening test:** What we should actually inspect or listen to.
4. **Exit gate:** The condition that must be true before moving forward.

We should commit after every completed stage. If a stage makes recommendations worse, we stop there and fix it instead of stacking more logic on top.

## Local Test Commands

Run the Rust checks from `server/`, then run the frontend checks from the AttackFM repository root.

```bash
cd server
cargo test
cd ..
npm run typecheck
npm run build
```

Useful focused checks while working:

```bash
cd server
cargo test curator
cargo test discovery
cargo test dj
cargo test db
```

## Test Listener Fixtures

Before changing ranking, create deterministic local fixtures representing clearly different listeners. These do not need full real libraries. A few dozen carefully tagged and enriched tracks per lane will tell us much more than thousands of noisy files.

- [ ] Create a Metal listener fixture.
  - Strong taste: metal, industrial metal, hardcore, noise rock
  - Recent interest: industrial, EBM, synth punk
  - Explicit likes: Ministry, HEALTH, Nine Inch Nails
  - Negative examples: repeated early skips on unrelated pop and K-pop
- [ ] Create a K-pop listener fixture.
  - Strong taste: K-pop, dance pop, electropop
  - Recent interest: darker electronic pop
  - Explicit likes and skips distinct from the Metal fixture
- [ ] Create a Jazz listener fixture.
  - Strong taste: bebop, modal jazz, fusion
  - Recent interest: spiritual jazz
- [ ] Create a new-listener fixture with no history.
- [ ] Create a mixed-taste listener fixture so we do not accidentally build a single-genre machine.
- [ ] Give all fixtures access to the same shared server library.
- [ ] Document the expected familiar, adjacent, exploratory, and unrelated candidates for each fixture.
- [ ] Keep fixture data separate from the real local AttackFM database.

### Fixture exit gate

- [ ] A test can load the same shared library under at least four distinct user IDs.
- [ ] Expected positive and negative examples are human-readable in the test source.
- [ ] No test depends on the order SQLite happens to return tied rows.

## Stage 0: Capture the Current Baseline

Before improving anything, capture what the existing system does. This gives us a real before-and-after comparison and keeps us honest.

### Build

- [ ] Add a local recommendation evaluation harness.
- [ ] Record the background curator results for every fixture.
- [ ] Record Home AI candidate pools before the LLM call.
- [ ] Record Home AI playlist responses with a fixed saved model response where possible.
- [ ] Record discovery seeds, scored candidates, and Collector picks.
- [ ] Record AI DJ results separately so we preserve the parts that already work well.
- [ ] Store score components and candidate provenance in evaluation output.

### Automated proof

- [ ] Add a deterministic snapshot test for the current basic `Taste` calculation.
- [ ] Add a snapshot test for `score()` using known lyric, BPM, and genre values.
- [ ] Add a test showing that `Db::unplayed()` returns globally newest unplayed tracks.
- [ ] Add a test showing that the current cold-start discovery fallback uses server-wide artist counts.
- [ ] Add a test proving that the existing `curate_cycle()` ignores completion, skip, and favorite weights.

### Local listening test

- [ ] Generate the current playlists for all fixtures.
- [ ] Mark each result as strong match, adjacent, questionable, or unrelated.
- [ ] Save at least three concrete bad examples that future stages must fix.
- [ ] Save at least three current recommendations that are good and must not regress.

### Exit gate

- [ ] We have a reproducible baseline report.
- [ ] The baseline clearly reproduces the cross-user contamination risk.
- [ ] The AI DJ baseline is recorded separately from automatic playlists.

**Migration required:** No.

## Stage 1: Add Cross-User Isolation Tests

This is the first real safety rail. A shared library should never become shared taste.

### Build

- [ ] Add reusable test helpers for creating users, tracks, plays, listens, favorites, and enriched features.
- [ ] Add a recommendation assertion that compares each result against the requesting user ID.
- [ ] Add an unrelated-genre ceiling so a fixture cannot receive a large block of unsupported music.

### Automated proof

- [ ] User B importing or playing K-pop does not change User A's Metal taste profile.
- [ ] User B's favorites do not affect User A's scores.
- [ ] User B's playlists do not affect User A.
- [ ] User B's recent listening does not become User A's current trend.
- [ ] Globally promoted Collector tracks remain available to the shared library but receive no personal boost for unrelated users.
- [ ] A user's discovery pool remains keyed to that user.

### Local listening test

- [ ] Add a large K-pop batch to the shared fixture library.
- [ ] Regenerate the Metal user's playlists.
- [ ] Confirm that K-pop does not appear unless it independently clears a defined exploration rule.
- [ ] Repeat in the opposite direction for the K-pop user.

### Exit gate

- [ ] All cross-user tests pass.
- [ ] Shared inventory changes candidate availability, but never personal affinity by itself.

**Migration required:** No.

## Stage 2: Create One Shared Taste Context

The curator, Home, AI DJ, discovery, and Collector need to ask the same system who the listener is.

### Build

- [ ] Introduce a shared `TasteContext` or equivalent recommendation-domain type.
- [ ] Move common taste construction out of `curator.rs`.
- [ ] Keep the first version behaviorally compatible with existing logic.
- [ ] Include data coverage and confidence so missing information is explicit.
- [ ] Include recent heard tracks separately from affinity values.
- [ ] Make Home, background curation, AI DJ, and discovery able to consume the same type.
- [ ] Do not remove specialized playlist or DJ theme scoring.

### Automated proof

- [ ] The same fixture produces the same base taste context from every caller.
- [ ] Missing features do not panic or silently produce invalid vectors.
- [ ] Quarantined Collector tracks do not seed the profile.
- [ ] Book tracks remain excluded.
- [ ] Turning listening history off produces no new behavioral inputs.

### Local listening test

- [ ] Compare pre-refactor and post-refactor recommendations.
- [ ] Confirm this stage changes architecture, not recommendation behavior.

### Exit gate

- [ ] One shared taste builder exists.
- [ ] Existing recommendation snapshots remain stable unless a documented bug was corrected.

**Migration required:** No.

## Stage 3: Use Honest Positive and Negative Listening Signals

This stage fixes the largest mismatch in the background curator. Finishing a track, skipping it, and hearting it should not all look identical.

### Build

- [ ] Replace equal-weight `top_plays()` taste construction in `curate_cycle()` with verdict-aware weighting.
- [ ] Add an explicit time predicate to recent listen aggregation.
- [ ] Add a separate long-term aggregation query.
- [ ] Treat favorites as a positive signal even when the track has little play history.
- [ ] Treat repeated early skips as a negative signal.
- [ ] Keep one accidental skip from permanently poisoning an artist.
- [ ] Preserve the per-track cap so one repeated song cannot own the whole profile.
- [ ] Decide and document how neutral partial listens should count.

### Automated proof

- [ ] Three completions score above three early skips.
- [ ] A favorite with one listen contributes more than an unliked one-listen track.
- [ ] Ten repeated plays do not erase all breadth from the taste profile.
- [ ] Old listening contributes to long-term taste but not recent taste.
- [ ] Recent listening contributes strongly to recent taste.
- [ ] A skipped track remains in the heard set and is not immediately recommended back.
- [ ] Repeated skips lower affinity without creating a permanent ban.

### Local listening test

- [ ] Give the Metal fixture a week of heavy industrial and EBM listening.
- [ ] Confirm those sounds rise in current-interest recommendations.
- [ ] Confirm the listener's long-term punk and metal identity remains visible.
- [ ] Skip several unrelated tracks and confirm they stop resurfacing near the top.

### Exit gate

- [ ] Background curator playlists respond to completion, skip, and favorite signals.
- [ ] Recent and long-term taste can be inspected separately.
- [ ] A short trend does not overwrite long-term identity.

**Migration required:** No for computed profiles. Yes later if profiles are materialized.

## Stage 4: Use the Enrichment AttackFM Already Has

The enrichment pipeline has done the expensive work. Automatic playlists need to start benefiting from it.

### Build

- [ ] Add enriched genres to shared scoring.
- [ ] Add specific tags and subgenres.
- [ ] Add sonic-vector similarity.
- [ ] Add measured audio similarity using BPM, energy, brightness, dynamic range, and rhythmic activity.
- [ ] Add community and ListenBrainz relationships as a small corroborating signal.
- [ ] Respect enrichment confidence and provenance.
- [ ] Keep raw file genre as a fallback rather than the primary semantic truth.
- [ ] Define neutral behavior for missing signals without giving incomplete tracks a hidden advantage.
- [ ] Return component scores for inspection.

### Automated proof

- [ ] Industrial metal ranks closer to industrial and EBM than unrelated pop when the user's profile supports that bridge.
- [ ] A specific subgenre match beats a broad genre-only match when other signals are close.
- [ ] Sonic opposites do not tie merely because metadata is missing.
- [ ] Low-confidence enrichment cannot dominate measured audio.
- [ ] Community similarity cannot outweigh strong sonic mismatch.
- [ ] Ranking remains deterministic when random exploration is disabled.

### Local listening test

- [ ] Inspect the top 30 candidates for each fixture with score explanations.
- [ ] Confirm the musical bridge is understandable for adjacent picks.
- [ ] Spot-check tracks with wrong file tags but good enriched profiles.
- [ ] Spot-check tracks with sparse enrichment and make sure they are not unfairly promoted.

### Exit gate

- [ ] Automatic playlist ranking uses the same major evidence families as the AI DJ.
- [ ] Every top candidate has a readable reason for ranking.
- [ ] The baseline's good recommendations remain competitive.

**Migration required:** No.

## Stage 5: Fix Home AI Candidate Retrieval

This is the most important user-visible quick win. The LLM should not receive 60 globally fresh songs simply because the user has not played them.

### Build

- [ ] Remove raw `unplayed(user, 60)` from Home AI candidate construction.
- [ ] Replace it with personalized retrieval lanes.
- [ ] Include familiar tracks, deep cuts, recent-interest matches, adjacent discoveries, and a small exploration lane.
- [ ] Score candidates before they reach the LLM.
- [ ] Apply a minimum relevance floor.
- [ ] Pass enriched descriptions and candidate provenance to the LLM.
- [ ] Tell the LLM which candidates are familiar, adjacent, or exploratory.
- [ ] Validate returned IDs as before.
- [ ] Apply deterministic post-LLM checks for relevance, duplicates, artist caps, and playlist size.
- [ ] Fall back to deterministic mixes if the LLM response fails validation.

### Automated proof

- [ ] Globally newest tracks do not enter the candidate set solely because they are new.
- [ ] Every candidate has a personal or intentional exploration reason.
- [ ] The LLM cannot exceed exploration limits by selecting every wildcard.
- [ ] Invalid and duplicate IDs are removed.
- [ ] A weak LLM response falls back cleanly.
- [ ] A candidate under the relevance floor cannot be rescued by an attractive LLM playlist title.

### Local listening test

- [ ] Generate Home mixes for all fixtures using the configured local model.
- [ ] Run each fixture at least three times to expose temperature-related drift.
- [ ] Inspect candidate pools before inspecting final playlists.
- [ ] Confirm unrelated shared-library batches do not change the Metal user's lanes.
- [ ] Confirm mixed-taste users still receive genuinely different lanes.

### Exit gate

- [ ] Home AI mixes contain only prequalified candidates.
- [ ] No playlist has an unexplained unrelated cluster.
- [ ] Model randomness affects arrangement and concept, not fundamental relevance.

**Migration required:** No.

## Stage 6: Make Playlist Intent Follow the Listener

Fixed recipes are useful fallbacks, but the curator should notice what the listener has actually been into lately.

### Build

- [ ] Calculate dominant long-term affinities.
- [ ] Calculate recent-interest deltas against long-term taste.
- [ ] Identify repeated album, artist, scene, mood, and sonic clusters.
- [ ] Generate a small deterministic set of supported playlist intent candidates.
- [ ] Let the LLM name, explain, and refine those supported intents.
- [ ] Require every intent to cite the evidence that caused it to exist.
- [ ] Keep useful evergreen recipes such as On Repeat and recent albums.
- [ ] Suppress duplicate concepts that target the same musical lane.
- [ ] Persist intent identity long enough that playlists feel stable between rebuilds.

### Automated proof

- [ ] A recent industrial and EBM spike creates an industrial-adjacent intent.
- [ ] The same spike does not erase long-term metal and punk intents.
- [ ] A listener with no recent shift receives stable long-term concepts.
- [ ] Unsupported concepts are rejected even if the LLM returns valid JSON.
- [ ] Two differently named concepts with nearly identical candidates are deduplicated.

### Local listening test

- [ ] Confirm the Metal fixture produces concepts similar to Industrial Heavy Rotation, Mechanical Aggression, or Artists Adjacent to HEALTH.
- [ ] Confirm the exact names can vary while the evidence remains consistent.
- [ ] Confirm no unsupported K-pop theme appears for the Metal fixture.
- [ ] Confirm the mixed fixture can legitimately produce lanes from different parts of its taste.

### Exit gate

- [ ] Playlist concepts can be traced to long-term or recent behavior.
- [ ] Regeneration feels responsive without looking completely different every day.

**Migration required:** Possibly. Persisted intent history may need a new table.

## Stage 7: Fix Discovery Cold Start and Retrieval

The discovery pool is already per user. This stage makes its inputs and scoring live up to that architecture.

### Build

- [ ] Remove `library_seed_artists()` as a personal cold-start fallback.
- [ ] Define cold-start behavior using onboarding picks, favorites, imported playlists, or a neutral empty state.
- [ ] Seed discovery from both long-term and recent affinities.
- [ ] Add enriched genre and sonic-neighbor retrieval where catalog data allows it.
- [ ] Keep ListenBrainz small-artist similarity.
- [ ] Keep MusicBrainz scene and collaborator walks.
- [ ] Record which retrieval lane produced each candidate.
- [ ] Add durable rejected candidate and rejected artist memory.
- [ ] Add expiry rules so an old rejection can soften without disappearing immediately.

### Automated proof

- [ ] A brand-new user does not inherit the server owner's largest artists.
- [ ] A user with favorites but no recent plays can seed discovery from those favorites.
- [ ] A dismissed song does not return on the next harvest.
- [ ] A dismissed artist is reduced or excluded according to the selected scope.
- [ ] Long-term and recent seed lanes both contribute.
- [ ] Owned tracks are still pruned globally.

### Local listening test

- [ ] Start from the no-history fixture and inspect the empty or onboarding state.
- [ ] Add three explicit favorite artists and rerun discovery.
- [ ] Dismiss several candidates, harvest again, and confirm the pool moves elsewhere.
- [ ] Confirm small and obscure adjacent artists still appear.

### Exit gate

- [ ] No discovery seed is inferred from server inventory alone.
- [ ] Rejection changes future retrieval.
- [ ] Discovery still reaches beyond obvious mainstream neighbors.

**Migration required:** Yes for durable rejection and retrieval provenance.

## Stage 8: Materialize the User Taste Profile

Once the calculations are stable, persist them so every feature can use the same inspectable snapshot without rebuilding the world on every request.

### Build

- [ ] Add a versioned per-user taste profile schema.
- [ ] Store recent and long-term sections separately.
- [ ] Store profile confidence and input coverage.
- [ ] Store generation time and algorithm version.
- [ ] Keep raw behavioral events as the source of truth.
- [ ] Add an incremental refresh path after meaningful events.
- [ ] Add a full rebuild path for migrations and debugging.
- [ ] Add a profile inspection endpoint available only to the current user or an administrator.
- [ ] Backfill profiles from existing plays, listens, favorites, and playlists.

### Automated proof

- [ ] Rebuilding the same profile twice is deterministic.
- [ ] Incremental refresh matches a full rebuild.
- [ ] A profile-version change triggers a rebuild.
- [ ] One user's event cannot update another user's profile.
- [ ] Deleting a user removes the profile.
- [ ] Existing databases migrate safely.

### Local listening test

- [ ] Inspect the human-readable profile for every fixture.
- [ ] Confirm recent interests and long-term identity tell a believable story.
- [ ] Confirm profile changes after controlled listening events.
- [ ] Confirm unrelated server imports do not change it.

### Exit gate

- [ ] All recommendation surfaces can read one versioned profile.
- [ ] Profile output is understandable enough to debug without guessing.

**Migration required:** Yes.

## Stage 9: Improve Collector Decisions and Ownership

Automatic downloading spends storage and changes the shared library, so it should use the strictest evidence in the system.

### Build

- [ ] Make Collector selection consume the shared profile and ranking service.
- [ ] Require a stronger fit threshold than the normal discovery feed.
- [ ] Require minimum metadata confidence.
- [ ] Keep the global storage cap.
- [ ] Add per-user acquisition pacing or quotas.
- [ ] Track initiating-user adoption separately from global promotion.
- [ ] Track completed, skipped, dismissed, untouched, and deleted auditions.
- [ ] Tune exploration from initiating-user outcomes rather than any global adoption.
- [ ] Keep quarantined tracks from seeding unrelated users.
- [ ] Preserve global deduplication when another user already owns the song.

### Automated proof

- [ ] A candidate can qualify for the discovery feed but fail the stricter download threshold.
- [ ] User B promoting a song does not falsely count as User A adopting their Collector recommendation.
- [ ] Repeated abandoned auditions reduce future acquisition reach.
- [ ] Strong adoption can cautiously increase reach.
- [ ] The Collector never downloads an unmeasured neutral candidate.
- [ ] The global cap still stops all automatic downloads safely.

### Local listening test

- [ ] Run Collector in a tiny temporary music directory and database.
- [ ] Inspect every attempted pull and its explanation.
- [ ] Adopt, skip, ignore, and dismiss different auditions.
- [ ] Run tuning and verify the exploration adjustment is understandable.

### Exit gate

- [ ] Every automatic download has a personal evidence trail.
- [ ] Collector learning is based on the initiating listener.
- [ ] Shared storage does not become shared taste.

**Migration required:** Yes for per-user outcomes and acquisition history extensions.

## Stage 10: Generalize Familiarity and Exploration

The AI DJ already has explicit exploration slots. This stage applies the same idea across playlists and discovery.

### Build

- [ ] Label every candidate as familiar, adjacent, exploratory, or wildcard.
- [ ] Define the evidence required for each label.
- [ ] Add configurable allocation targets by playlist intent.
- [ ] Start with approximately 65% familiar, 25% adjacent, 8% exploratory, and 2% wildcard for general mixes.
- [ ] Let discovery-focused intents use a more adventurous allocation.
- [ ] Require every wildcard to clear a basic relevance floor.
- [ ] Add diversity reranking after relevance scoring.
- [ ] Record exposure and adoption by exploration class.
- [ ] Keep randomness seeded in tests and bounded in production.

### Automated proof

- [ ] General mixes stay within their configured allocation tolerance.
- [ ] A wildcard cannot bypass the relevance floor.
- [ ] Adjacent candidates have an explainable bridge.
- [ ] Exploration does not repeatedly select the same unmet artist.
- [ ] Successful exploration increases future confidence gradually.
- [ ] Failed exploration fades without becoming a permanent ban.

### Local listening test

- [ ] Blind-review playlists without looking at the class labels first.
- [ ] Mark where recommendations feel fresh versus random.
- [ ] Reveal the labels and compare them to the listening impression.
- [ ] Adjust allocation only after reviewing several playlists per fixture.

### Exit gate

- [ ] Exploration feels intentional.
- [ ] The system can explain the bridge from known taste to unfamiliar music.
- [ ] Users are not trapped inside a tiny bubble.

**Migration required:** Possibly for exposure and class-level outcome history.

## Stage 11: Add Recommendation Diagnostics

If we cannot see why a song ranked, we will eventually be back here trying to infer behavior from playlist names.

### Build

- [ ] Add a local diagnostics endpoint or developer panel.
- [ ] Show taste profile version and age.
- [ ] Show playlist intent evidence.
- [ ] Show retrieval lane for every candidate.
- [ ] Show score components before and after diversity reranking.
- [ ] Show familiarity class.
- [ ] Show rejection, quarantine, and recent-play filters.
- [ ] Show whether the LLM selected, named, reordered, or merely explained the result.
- [ ] Keep diagnostics private and disabled in normal production UI.

### Automated proof

- [ ] Diagnostics match the actual final ordering.
- [ ] Explanations do not claim signals that were missing.
- [ ] User A cannot inspect User B's profile without administrator access.
- [ ] Diagnostic serialization does not expose private tokens, paths, or credentials.

### Local listening test

- [ ] Pick ten recommendations and explain each one using diagnostics alone.
- [ ] Confirm a human can identify why a bad result slipped through.
- [ ] Confirm LLM wording never hides a weak deterministic score.

### Exit gate

- [ ] Every recommendation can be traced from user evidence to final placement.
- [ ] We can diagnose a bad playlist without adding temporary print statements.

**Migration required:** No.

## Stage 12: Final Local Validation

### Automated release checks

- [ ] Run the full Rust workspace test suite.
- [ ] Run TypeScript type checking.
- [ ] Run the production frontend build.
- [ ] Run all fixture evaluations.
- [ ] Run cross-user isolation tests.
- [ ] Run database migration tests from a copy of an older schema.
- [ ] Run profile rebuild and incremental-update consistency tests.
- [ ] Run deterministic ranking tests with fixed random seeds.
- [ ] Confirm no test writes to the real library or real database.

### Manual product checks

- [ ] Use a copy of real local listening data with personal details kept local.
- [ ] Review Home mixes.
- [ ] Review background curator playlists.
- [ ] Review AI DJ sets.
- [ ] Review playlist suggestions.
- [ ] Review the discovery feed.
- [ ] Review New Music groupings.
- [ ] Review Collector choices with automatic downloading pointed at a temporary directory.
- [ ] Confirm favorites have a visible effect.
- [ ] Confirm repeated skips have a visible but recoverable effect.
- [ ] Confirm a recent listening phase changes current-interest playlists.
- [ ] Confirm long-term taste remains stable.
- [ ] Confirm unrelated shared-library additions do not distort another user.
- [ ] Confirm discovery still introduces genuinely unfamiliar music.

### Final acceptance criteria

- [ ] Recommendations can be connected to actual user behavior.
- [ ] Recent taste and long-term taste are both visible.
- [ ] Negative signals matter without becoming permanent punishment.
- [ ] The server library is treated as inventory, not identity.
- [ ] The LLM receives a small, high-quality candidate set.
- [ ] The LLM handles concepts, relationships, names, flow, and explanations.
- [ ] Traditional code handles behavioral statistics, retrieval, ranking, filtering, and validation.
- [ ] Exploration is intentional and measurable.
- [ ] Automatic downloads have stricter evidence than normal recommendations.
- [ ] Every important decision can be inspected locally.
- [ ] Existing good AI DJ behavior has not regressed.

## Suggested Work Order

The safest order is:

1. Baseline and cross-user tests
2. Shared taste context
3. Honest positive and negative signals
4. Enrichment-backed ranking
5. Home AI candidate retrieval
6. Behavior-driven playlist intent
7. Discovery cold start and durable rejection
8. Persistent taste profiles
9. Collector ownership and learning
10. Exploration classes
11. Diagnostics and final validation

The first big visible payoff should arrive after Stage 5. At that point, Home mixes should stop feeling like the model wandered into the newest corner of the server and started grabbing records. The later stages make that improvement durable across the rest of AttackFM.
