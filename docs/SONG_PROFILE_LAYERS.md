# Layered song enrichment (schema v3)

## Audit summary

- `features.rs` decodes a bounded audio window with ffmpeg and measures energy,
  brightness, loudness, dynamic range, rhythmic activity, and a fingerprint.
  `tempo.rs` measures BPM. Duration and source tags originate in the scanner.
- `curator.rs` is a durable background worker. Before v3 it made one structured
  chat request named `attackfm_song_profile_v2`, then stored the result directly
  in `track_features.ai_*` columns. `AFM_ENRICH_MODEL` could select a slower
  model, but there was no separate fast and refinement lifecycle.
- `db.rs`, `curator.rs`, and `dj.rs` consume the legacy columns and associated
  vectors. The React/Tauri desktop and mobile clients consume DJ results rather
  than the raw profile object, so preserving the legacy projection avoids a
  client protocol break.
- Work was already asynchronous after scan/import. Playback and active imports
  preempt model work. Schema-v2 output used JSON schema, defensive JSON parsing,
  term cleaning, deduplication, and a single clamped confidence number, but had
  no controlled category taxonomy or patch provenance.

## v3 storage and lifecycle

`song_profile_layers` is additive. It stores `fast_profile`,
`refinement_patch`, `canonical_profile`, whole-layer provenance, schema/model/
prompt versions, timestamps, and a legacy migration marker. Measured facts stay
in numeric `track_features` columns and are never writable by either model.

1. Qwen (`AFM_FAST_ENRICH_MODEL`, default `qwen3.5:9b`) creates the first
   semantic profile.
2. Canonical is immediately projected into the old `ai_*` columns. Existing DJ,
   search/library, desktop, and mobile behavior therefore remains usable.
3. Gemma (`AFM_REFINEMENT_MODEL`, default `gemma4:12b`) later returns explicit
   add/remove/replace operations. The server applies and normalizes the patch.
4. Legacy schema-v2 profiles are copied non-destructively into the layered
   table with `migrated_from=attackfm_song_profile_v2`; their old columns remain.

The administrator comparison endpoint is:

```text
GET /api/debug/song-profiles/{track_id}
```

It returns source metadata, measured facts, Qwen output, Gemma patch, canonical
output, and all version stamps.

## Representative structural before/after

Before (one object mixed interpretation and implementation artifacts):

```json
{
  "genres": ["Hip Hop", "Rap/Hip Hop"],
  "moods": ["low_dynamic_range", "Melancholy"],
  "sonic_traits": ["brightness=Some(0.427)", "rhythm-forward"],
  "lyrical_themes": ["Heroism"],
  "confidence": 85
}
```

After (illustrative endpoint shape; model quality must be evaluated on real
tracks rather than inferred from this fixture):

```json
{
  "measuredAudioFacts": {
    "brightness": 0.427,
    "dynamicRange": 0.5,
    "rhythmicActivity": 0.76
  },
  "fastProfile": {
    "genres": ["hip-hop"],
    "moods": ["melancholic"],
    "musical_traits": ["rhythm-forward"],
    "lyrical_themes": [],
    "specific_tags": [],
    "confidence": { "genres": 0.85, "moods": 0.7 }
  },
  "refinementPatch": {
    "add": { "specific_tags": ["alternative-hip-hop"] },
    "remove": {},
    "replace": {},
    "reasoning_summary": "Adds a supported narrower recommendation tag."
  },
  "canonicalProfile": {
    "genres": ["hip-hop"],
    "moods": ["melancholic"],
    "musical_traits": ["rhythm-forward"],
    "lyrical_themes": [],
    "specific_tags": ["alternative-hip-hop"]
  }
}
```

Broad genre, mood, vibe, and common trait values are allow-listed and aliased.
Niche knowledge remains available through normalized `specific_tags` and the
deep scene/movement/era/influence/cultural/production fields. Invalid types are
rejected during deserialization; empty values, duplicates, measurement syntax,
and unsupported lyrical themes are removed before persistence.
