# AI DJ background enrichment

Last updated: 2026-08-13

## Purpose

AttackFM's background curator builds durable song profiles for similarity-based
AI DJ queues. Enrichment runs on the server, not in the Android APK. It pauses
while music is playing or an import is queued/downloading, then resumes without
losing its place.

The guiding rule is that different evidence answers different questions:

- Local audio measurements describe the recording's signal.
- Lyrics support themes and some mood judgments, but not instrumentation.
- Structured public catalogues support identity, genres, and community tags.
- The local language model synthesizes evidence; it is not treated as a source.

Album placement, soundtrack/franchise associations, popularity, biography, and
search-result trivia must not be converted into sonic similarity traits.

## Session baseline and audit

At the beginning of the 2026-08-13 review, the original background AI worker was
confirmed live against the test database:

- 667 library tracks
- 126 enriched tracks
- 126 stored 768-dimensional vectors
- Latest original enrichment observed at 2026-08-13 17:26 EDT

A sample and aggregate audit found real but uneven enrichment:

- 29 of 126 summaries only repeated the song title.
- 31 summaries were shorter than 40 characters.
- 57 began with the generic phrase `This recording...`.
- Some vibes repeated prompt headings such as `Instrumentation`, `Energy`,
  `Vocal Delivery`, or `Production Texture`.
- Some descriptions invented synths, acoustic instruments, reverb, trance, or
  other production details from metadata and lyrics rather than audio evidence.
- BPM, energy, brightness, and the stored embeddings were real local data; the
  prose descriptions were model inferences.

The original system was judged useful as a secondary signal, but not reliable
enough to dominate DJ ranking.

## Enrichment v2 implemented in this session

### Structured external evidence

`server/src/enrichment.rs` performs a conservative MusicBrainz recording search
using title and artist. A candidate must pass normalized title and artist
matching before its MBID is accepted. Ambiguous or failed matches contribute no
external evidence.

After identification, a recording-detail request asks MusicBrainz for tags and
genres. AttackFM supplies a meaningful user agent and leaves at least 1.1
seconds between MusicBrainz requests to respect the service's one-request-per-
second policy.

MusicBrainz is currently used for recording identity and any available community
tags. It often identifies a recording correctly while returning no descriptive
tags; an MBID alone therefore does not raise profile confidence to the same level
as a tagged match.

### Evidence-aware AI schema

The former `{summary, genres, vibes}` response has been replaced with:

- `summary`
- `genres`
- `sonic_traits`
- `moods`
- `lyrical_themes`
- `confidence`

The prompt now includes measured BPM, energy, brightness, and loudness; existing
genre/year metadata; MusicBrainz tags; and a bounded lyrics excerpt. It tells the
model that lyrics are theme evidence only and forbids using placement or
biographical context as sound.

The text embedded for similarity now keeps genres, sonic traits, moods, and
lyrical themes explicitly separated.

### Validation and rejection

Before a v2 profile becomes durable, AttackFM:

- trims and deduplicates terms case-insensitively;
- rejects generic category headings;
- caps term counts and lengths;
- rejects summaries shorter than 40 characters;
- rejects summaries that merely repeat the title;
- requires at least one genre, two sonic traits, and two moods;
- reduces confidence when MusicBrainz supplies no descriptive tags;
- rejects a final confidence below 0.45.

Rejected attempts are stamped as `rejected_v2`. This prevents one difficult
track from remaining at the front of the durable queue and repeatedly consuming
local-model and public-catalogue resources. Rejection does not manufacture a
similarity vector.

### Database additions

The migration adds these columns to `track_features` without deleting existing
data:

- `ai_sonic_traits`
- `ai_lyrical_themes`
- `ai_confidence`
- `ai_sources`
- `external_tags`
- `musicbrainz_id`

Existing `ai_vibes` stores the new normalized moods for backward compatibility.
`ai_sources` records provenance such as `measured_audio`, `lyrics`, and
`musicbrainz`.

The durable queue treats an older enriched row with an empty `ai_sources` field
as needing the one-time v2 upgrade. Valid v2 rows then return to the normal
90-day refresh interval.

## Live activation and verification

The debug server build was compiled and activated through the user service:

`attackfm-ai-dj-test.service`

The live test server remains at `http://192.168.1.195:8788`, with its data in:

`/home/kevin/.local/share/attackfm-ai-dj-test/attackfm.db`

Verification completed during this session:

- New validation unit tests: 2 passed, 0 failed.
- Full server `cargo check`: passed.
- Full debug server build: passed.
- Additive database migration: observed live.
- MusicBrainz MBID persistence: observed live.
- Structured v2 profile persistence: observed live.
- Service restart and health: service active; an HTTP 404 at `/` is expected
  because the server has no root route.
- Two early low-confidence live profiles were quarantined before they could
  remain in the recommendation vectors.

Pre-existing compiler warnings in unrelated modules remain; this change did not
introduce a build failure.

## Operational behavior

- Batch size: two AI tracks per enrichment cycle.
- Startup delay: 20 seconds, allowing scanning to begin first.
- Per-track pause: two seconds after model work.
- Busy cycle interval: 15 seconds.
- Idle cycle interval: five minutes.
- AI profile refresh: 90 days, except the one-time legacy-to-v2 upgrade.
- Playback and active imports preempt AI enrichment.

## Earlier gaps and decisions

### ListenBrainz (implemented)

ListenBrainz replaced the planned Last.fm dependency. Its public endpoints need
no API key and join cleanly through the recording MBID already verified by
MusicBrainz. AttackFM now fetches:

- recording, release-group, and artist community tags;
- credited instruments and vocals;
- total listens and unique listener counts;
- a bounded list of radio-related recording MBIDs.

Metadata is accepted only when the response is keyed by the exact recording
MBID and the returned title and artist still match the local track. Results are
stored durably with the profile, source-labelled, and refreshed by the existing
enrichment TTL. Listen counts remain context only. Radio relationships provide
a capped 4% positive-only queue corroborator and never count as proof that two
recordings sound alike.

### Targeted general web search

Unrestricted search is not part of v2. A future fallback may search for an exact
artist/title plus terms such as `genre`, `sound`, or `review` only when structured
sources cannot resolve a track. Web prose must remain attributed evidence, not a
direct sonic fact, and should require corroboration before affecting confidence.

### Deeper local audio analysis

The first follow-up pass now adds normalized dynamic range and rhythmic activity
from 50 ms RMS windows. Both are stored as measured evidence, passed into the
profile prompt, and compared during collection-seed ranking. Existing analyzed
rows are automatically backfilled when either new field is absent.

Future optional descriptors may add danceability, acoustic/electronic character,
instrumentalness, vocal intensity, and key. The required recording-to-recording
comparison gap is now closed by the versioned spectral/temporal fingerprint
described below.

### Ranking integration

The new fields initially improved the text embedded into the existing similarity
vector. The final phase below now scores sonic, lyrical, community, measured
audio, and listener-taste evidence separately and exposes match reasons.

The custom queue already includes an 8% positive-only liked-song tie-breaker.
An unliked song is neutral, not treated as disliked.

Validation for this follow-up passed all 17 runnable server tests (including
two new local-signal tests), with two existing network/build tests ignored by
design. `cargo check`, the debug build, additive live migration, service
restart, and expected root-path 404 were also verified.

Spotify audio features are not the planned foundation because API availability
and developer access have changed and remain a fragile dependency.

## Relevant implementation files

- `server/src/enrichment.rs`: MusicBrainz lookup and term validation
- `server/src/curator.rs`: background worker, evidence prompt, acceptance rules
- `server/src/db.rs`: migration, durable queue, persistence, rejection stamps
- `server/src/main.rs`: enrichment module registration

## Final-phase plan

1. Split the single profile embedding into independently stored sonic,
   lyrical, and community/catalogue evidence vectors. Rank each family
   explicitly and return a compact match explanation for debugging and UI.
2. Add a real local audio embedding model or a stronger fingerprint-derived
   representation. Keep the current lightweight DSP fields as explainable
   fallbacks and verify coverage/performance before changing their weight.
3. Calibrate weights against a fixed evaluation set of seed tracks/albums and
   inspect diversity, artist repetition, false soundtrack/cultural matches,
   and per-user taste separation. Only then expose match reasons in the client.

Targeted web search remains optional rather than a required final item. It
should be added only for unresolved recordings and only if the structured and
local sources leave a demonstrated quality gap.

## Final phase implemented

- Profiles now persist separate 768-dimensional sonic, lyrical, and community
  vectors while retaining the combined vector for compatibility. Accepted
  older profiles are queued once for family-vector backfill.
- Ranking scores those families independently. Sonic relevance owns the main
  share; lyrics and community evidence remain bounded supporting signals.
- Every sufficiently analyzed recording has a deterministic five-dimensional
  local audio embedding from normalized BPM, energy, brightness, dynamic range,
  and rhythmic activity. It remains private and model-free.
- Queue responses include per-track family scores and a compact strongest-match
  reason. The client displays the opening track's reason after playback begins.
- Executable calibration invariants cover normalized embedding bounds, nearby
  versus opposite audio profiles, and protection against taste/collaborative
  signals dominating relevance.
- Calibrated outer weights are 44% evidence-family similarity, 32% selected
  traits, 12% account history, 8% positive-only likes, and 4% positive-only
  ListenBrainz corroboration.

## Audio fingerprint and fixed evaluation completed

- The five-value DSP vector remains an explainable fallback, but ranking now
  prefers a versioned 48-dimensional fingerprint measured directly from each
  recording. It contains the mean, variation, and temporal change of 16
  logarithmic spectral bands and is L2-normalized for level-independent cosine
  comparison. It requires only the existing Rust FFT and ffmpeg decoder.
- The additive migration stores fingerprint bytes, dimensions, and version.
  Existing tracks are reanalysed gradually by the playback-aware worker; the
  feature status endpoint reports fingerprint coverage separately.
- `docs/AI_DJ_EVAL_SET.json` fixes five deliberately different library seeds:
  R&B, alternative, hip-hop, an instrumental score, and metal. The read-only
  `server/scripts/evaluate_ai_dj.py` benchmark checks album-mate retrieval,
  top-20 artist diversity, the production artist cap, soundtrack/cultural
  context leakage, and isolated per-account positive preference behavior.
- The 2026-08-13 baseline ran across all 697 analyzed tracks and passed. Each
  top 20 contained 15–19 unique artists, no artist exceeded two tracks, the
  instrumental-score seed had 20% soundtrack-labelled results (35% maximum),
  all nearest album mates ranked within the fixed top-100 bound, and the two
  hypothetical account preferences remained isolated. Fingerprint coverage was
  0/697 immediately after migration, so this recorded baseline used the DSP
  fallback; rerunning the same command measures the fingerprint rollout without
  changing the evaluation set or thresholds.

## Worktree note

This session intentionally preserved pre-existing, uncommitted Android/frontend
work for the album-page AI DJ feature. The enrichment implementation is confined
to the server files listed above plus this documentation. No git commit or remote
deployment was performed in this documentation pass.
