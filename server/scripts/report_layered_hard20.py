#!/usr/bin/env python3
import json, os, statistics
from pathlib import Path

OUT=Path(os.environ.get(
    'AFM_EVAL_OUT',
    str(Path.home()/'.local/share/attackfm-ai-dj-test/enrichment-evals/layered-hard-20'),
))
tracks=[
('RAT BOY & IBDY',"Who's Ready for Tomorrow",64,'Already in library','Synthwave/electronic/cyberpunk framing dominated by soundtrack context; incorrect genre and scene assumptions.','Album/game context overwhelmed track evidence.'),
('Le Tigre','Deceptacon',57,'Already in library','Electroclash, dance-punk, post-punk, riot-grrrl and punk-rock ambiguity was represented.','Strong genres, but invented consumerism/political/disco lyrical themes.'),
('Rina Sawayama','XS',825,'Imported using configured SpotiFLAC workflow','Electropop/art-pop/alternative-R&B with luxury, excess and Y2K framing.','Captured the subject but missed the track’s central metal/guitar contrast.'),
('Poppy','Concrete',826,'Imported using configured SpotiFLAC workflow','Alternative/nu-metal/electropop/art-pop/industrial fusion with manic dark playfulness.','Good ambiguity; over-literal and occasionally dubious lyrical interpretation.'),
('Lil Nas X','Old Town Road',827,'Imported using configured SpotiFLAC workflow','Country/trap/hip-hop hybrid, cowboy imagery and viral genre-fusion context.','One of the best ambiguity cases; useful output was wholly rejected.'),
('Wet Leg','Chaise Longue',828,'Imported using configured SpotiFLAC workflow','Indie/post-punk with dry, playful, detached vocal character and UK scene context.','Good track-level description; “Windmill scene” may be artist-scene overreach.'),
('Grimes','Genesis',829,'Imported using configured SpotiFLAC workflow','Art-pop, synth-pop, indietronica, dream-pop, darkwave and witch-house blend.','Nuanced but tag-heavy and partly artist-template-driven.'),
('Flying Lotus feat. Kendrick Lamar','Never Catch Me',830,'Imported using configured SpotiFLAC workflow','Electronic/jazz/hip-hop/future-jazz blend with complex rhythm and existential lyricism.','Strong hybrid recognition, but incorrectly called the vocal track instrumental hip-hop.'),
('OutKast','B.O.B.',831,'Imported using configured SpotiFLAC workflow','Southern/conscious hip-hop with tense atmospheric production.','Missed drum-and-bass/gospel/electronic intensity and hallucinated post-9/11 context for a 2000 song.'),
('FKA twigs','Cellophane',832,'Imported using configured SpotiFLAC workflow','Electronic/art-pop with melancholic, intimate relationship anxiety.','Mood good; production/instrumentation almost empty and specific metaphor reading overconfident.'),
('Mitski','Geyser',833,'Imported using configured SpotiFLAC workflow','Alternative/indie, folk-punk, punk, J-pop with anxious intensity.','Several unsupported genres and artist-level indie-rock contamination.'),
('black midi','Sugar/Tzu',834,'Imported using configured SpotiFLAC workflow','Experimental/math/noise rock, avant-prog, post-punk and jazz-fusion complexity.','Excellent ambiguity and structure; mild tag explosion.'),
('100 gecs','Hollywood Baby',835,'Imported using configured SpotiFLAC workflow','Hyperpop/electronic-pop with deconstructed production and power-pop melody.','Useful core classification, but missed pop-punk/ska-adjacent texture and overread lyrics.'),
('Justice','D.A.N.C.E.',836,'Imported using configured SpotiFLAC workflow','Electro-house/French-electro/disco-punk with nu-disco and French-house context.','Strong concise categorization; schema normalization still discarded it.'),
('M.I.A.','Paper Planes',837,'Imported using configured SpotiFLAC workflow','Electronic/hip-hop/experimental-hip-hop with dancehall influence and immigration themes.','Reasonable ambiguity; production missed sample/collage character and some claims were generic.'),
('Azealia Banks feat. Lazy Jay','212',801,'Already in library','Rap/trap framing with club culture and aggressive flow.','Misclassified the house/electro-rap production as trap and invented materialistic/high-fashion emphasis.'),
('Death Grips','Get Got',838,'Imported using configured SpotiFLAC workflow','Industrial/experimental/glitch-hop/noise-rap with distorted vocals and punk influence.','Good track-level fit, though partly susceptible to artist-template labeling.'),
('The Avalanches','Frontier Psychiatrist',800,'Already in library','Plunderphonics/sampledelia, experimental hip-hop, alternative dance and collage production.','Best response: specific, structured, restrained and recommendation-useful.'),
('Radiohead','Everything in Its Right Place',799,'Already in library','Art-pop/electronic/experimental-rock with hypnotic minimalist texture.','Avoided generic alternative rock; good production reading, weaker scene/context depth.'),
('Death Grips','On GP',823,'Already in library','Experimental hip-hop/industrial-rock/noise-rap/digital-hardcore with desperate melancholic aggression.','Distinct from Get Got emotionally, but one unsupported named-person tag and artist influence leakage.'),
]
scores=[
[2,2,3,1,2,2,1],[7,8,6,8,6,8,1],[6,5,5,4,5,5,1],[8,8,7,4,7,8,1],[8,8,7,7,7,9,1],
[8,8,8,8,7,8,1],[8,8,8,7,7,8,1],[8,8,7,7,8,8,1],[5,5,5,3,4,4,1],[6,5,8,2,2,4,1],
[4,4,6,3,4,4,1],[9,9,8,6,8,9,1],[7,7,6,6,7,7,1],[9,8,8,7,8,8,1],[7,7,7,7,6,7,1],
[4,4,5,4,4,3,1],[9,8,8,7,8,8,1],[9,9,8,9,9,9,1],[8,8,8,6,8,8,1],[8,8,8,4,8,8,1],
]
cats=['Genre accuracy','Nuance','Mood/vibe accuracy','Scene/context understanding','Production understanding','Preservation of ambiguity','AI DJ usefulness']
neighbors=json.loads((OUT/'neighbors.json').read_text())
raw=[json.loads(x) for x in (OUT/'raw-responses.jsonl').read_text().splitlines()]
# First natural response for tracks 1–3; artifact responses cover 4–20.
first={1:raw[0],2:raw[3],3:raw[4]}
for i in range(4,21):
    files=list(OUT.glob(f'{i:02d}-*.json'))
    d=json.loads(files[0].read_text()) if files else {}
    if d.get('model_responses'): first[i]=d['model_responses'][0]

lines=['# AttackFM layered hard-20 end-to-end stress test','',
'## Executive result','',
'All 20 exact Qwen calls returned parseable schema-shaped JSON. **0/20 passed server semantic acceptance, 0/20 reached Gemma, and 0/20 produced a canonical layered profile.** The database correctly stored `rejected_v2` markers and did not persist malformed canonical JSON. This is a fail-closed result, but it means the staged architecture could not perform its primary job on this set.','',
'The central defect is a mismatch between the prompt and validator: Qwen is invited to return nuanced terms such as `dance-punk`, `hyperpop`, `plunderphonics`, `jazz fusion`, `complex rhythms`, and `driving rhythm`, while the broad controlled lists silently discard most of them before enforcing non-empty genre/mood/trait minimums. Useful model output is therefore rejected along with genuinely bad output.','',
'## Infrastructure changes required for the test','',
'1. Applied the existing `AFM_ENRICH_TRACK_IDS` allowlist to Gemma refinement as well as Qwen.','2. Corrected allowlist selection to filter before the SQL-limit equivalent, so the requested song—not an unrelated global candidate—can be selected.','3. Added only serial evaluation scripts and a manager-passed per-track test environment. Prompts, schemas, temperatures, model tags, normalization rules, scoring weights, and generated metadata were not changed.','',
'## Per-track reports','']
for i,((artist,title,tid,acq,qsum,interesting),sc) in enumerate(zip(tracks,scores),1):
    response=first.get(i,{}); content={}
    try: content=json.loads(response.get('content','{}'))
    except Exception: pass
    ns=neighbors.get(str(tid),{}).get('neighbors',[])
    lines += [f'### {i}. {artist} — {title}','',f'- **Acquisition:** {acq}. Exact artist/title/version and duration verified.',
      f'- **Qwen result:** {qsum}',
      '- **Gemma refinement:** Not run. The backend rejected Qwen before a fast layer was created; therefore there were no retained/removed/added/modified fields or confidence adjustments.',
      '- **Final categorization:** None. Persisted state is `ai_sources=rejected_v2`; `song_profile_layers` has no accepted canonical row.',
      '- **Pipeline issues:** Raw JSON parsed and matched field types, but normalization removed unsupported controlled terms and the post-normalization minimum-field check rejected it. Useful rejected information is shown above.',
      '- **Scores:** '+', '.join(f'{k} {v}/10' for k,v in zip(cats,sc))+f'. **Overall {statistics.mean(sc):.1f}/10.**',
      f'- **Interesting behavior:** {interesting}',
      '- **Top-5 current AI-DJ fallback neighbors:** '+('; '.join(f"{x['artist']} — {x['title']} ({x['why']}, {x['score']:.3f})" for x in ns) if ns else 'Unavailable')+'.','']

averages=[statistics.mean(row[i] for row in scores) for i in range(7)]
overall=statistics.mean(statistics.mean(x) for x in scores)
lines += ['## Combined findings','',
'### Scores','',*['- **%s:** %.1f/10'%(c,a) for c,a in zip(cats,averages)],f'- **Average overall:** {overall:.1f}/10','',
'### Best five raw classifications','',
'1. Frontier Psychiatrist','2. Sugar/Tzu','3. D.A.N.C.E.','4. Get Got','5. Old Town Road','',
'### Worst five raw classifications','',
"1. Who's Ready for Tomorrow",'2. 212','3. Geyser','4. B.O.B.','5. Cellophane','',
'### Qwen mistake patterns','',
'- Album/soundtrack context overwhelmed track evidence, most severely on `Who’s Ready for Tomorrow`.','- Artist-template labels appeared for Grimes, Mitski, and both Death Grips songs.','- Lyrics were often over-literal or hallucinated: Deceptacon consumerism themes, Concrete burial/cannibalism certainty, and anachronistic post-9/11 context for B.O.B.','- Production descriptions were uneven: excellent for Frontier Psychiatrist/Sugar-Tzu, almost absent for Cellophane, and generic for Paper Planes.','- Confidence was consistently high despite unsupported claims and did not predict validator survival.','',
'### Gemma findings','',
'Gemma had no evaluable successes or mistakes because all 20 profiles were rejected at the fast-profile gate. There are therefore no cases where Gemma improved or worsened Qwen. This is itself the most serious lifecycle finding.','',
'### Schema/backend findings','',
'- 20/20 raw responses were valid JSON with expected arrays/objects and numeric category confidence.','- 20/20 were rejected after normalization; no malformed canonical data was written.','- Empty strings were removed and confidence remained bounded, but valid niche concepts were discarded rather than routed into `specific_tags`.','- Rejected v3 profiles are eligible for immediate retry because the layered fast queue does not honor the legacy rejection stamp. The serial allowlist prevented runaway retries during this test.','',
'### Acquisition/indexing','',
'- 6 tracks were already present and 14 were imported successfully through configured SpotiFLAC providers/fallbacks.','- No cover, remix, live version, instrumental, or DRM bypass was used.','- B.O.B. initially failed strict shorthand matching; it was rerun against the verified full title and succeeded operationally.','',
'### Ambiguity, generic labels, and tag explosion','',
'- Ambiguity was represented especially well in Old Town Road, Concrete, Never Catch Me, Sugar/Tzu, D.A.N.C.E., Frontier Psychiatrist, and On GP.','- Over-normalization—not excessive genericization—was the dominant final-stage failure. The stored result collapsed to nothing rather than generic tags.','- Tag explosion appeared in Genesis and Sugar/Tzu, but most outputs were reasonably bounded.','',
'### Neighbor sanity','',
'Because no semantic profile survived, all neighbor results fell back to measured fingerprints/DSP. Good pairs included Concrete↔Sugar/Tzu, XS↔Hollywood Baby, and Get Got↔some Death Grips/industrial-adjacent material. Weak results included D.A.N.C.E.→J. Cole/SZA, On GP→Olivia Rodrigo/Good Charlotte, Frontier Psychiatrist→Lana Del Rey/Miley Cyrus, and Never Catch Me→Billie Eilish. Near-uniform cosine values around 0.99 show that the fingerprint space is insufficiently discriminative by itself.','',
'## Generalized recommendations','',
'1. **Separate broad controlled categories from recognized subgenres.** Normalize known subgenres into a maintained subgenre/secondary field and preserve their broad parent, rather than dropping them. Route unknown-but-valid terms to `specific_tags` with provenance.','2. **Validate field semantics without requiring every output to match a tiny allowlist.** Accept `driving-rhythm` as an alias for `rhythm-forward`, `synthesizer-driven` as `synth-driven`, and preserve useful production descriptors separately. Return explicit validator errors and permit one bounded repair pass.','3. **Do not gate all refinement on a perfect fast profile.** Gemma should be able to review a partially valid Qwen profile plus rejected terms and validation errors. A fail-closed canonical record can still preserve a quarantined fast result for evaluation.','4. **Derive confidence server-side.** Use evidence availability, normalization loss, cross-model agreement, and unsupported-claim checks rather than accepting model confidence at face value.','5. **Strengthen track evidence.** Album/artist context should be explicitly low-priority. Lyrics availability, recording identity, measured audio, and track-specific community tags should dominate; flag anachronistic scene claims against release year.','6. **Improve semantic neighbor fallback.** The 48-D fingerprint cosine is too compressed near 1.0. Calibrate/whiten bands, add tempo/rhythm weighting outside cosine, and use surviving semantic families independently.','',
'## Grade','',
'**F** for the current end-to-end enrichment pipeline on this stress set. Qwen itself showed promising musical knowledge, but the deployed pipeline produced zero usable canonical profiles.','',
'The three biggest blockers to an A are:','',
'1. Prompt/taxonomy/normalizer mismatch causing 100% rejection.','2. Gemma is unreachable whenever the fast layer is rejected, eliminating the intended repair/refinement benefit.','3. Semantic failure leaves the AI DJ on a weak, overly homogeneous audio-fingerprint neighbor space.','']
(OUT/'report.md').write_text('\n'.join(lines))
(OUT/'summary.json').write_text(json.dumps({'attempted':20,'raw_json_valid':20,'qwen_accepted':0,'gemma_completed':0,'canonical_written':0,
 'category_averages':dict(zip(cats,[round(x,2) for x in averages])),'overall_average':round(overall,2),'grade':'F'},indent=2))
print(OUT/'report.md')
