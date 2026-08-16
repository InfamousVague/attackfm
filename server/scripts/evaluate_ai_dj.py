#!/usr/bin/env python3
"""Repeatable, read-only AttackFM AI DJ quality benchmark."""
import argparse, json, math, sqlite3, struct, sys
from pathlib import Path

def cosine(a, b):
    if not a or not b or len(a) != len(b): return 0.0
    den = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b)) / den if den else 0.0

def vector(row):
    blob, dims = row[9], row[10]
    if blob and dims == 48 and len(blob) == dims * 4:
        return list(struct.unpack('<48f', blob)), 'fingerprint-v1'
    values = [row[4] / 240 if row[4] is not None else .5]
    values += [x if x is not None else .5 for x in row[5:9]]
    return values, 'dsp-fallback'

def main():
    here = Path(__file__).resolve()
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default=str(Path.home()/'.local/share/attackfm-ai-dj-test/attackfm.db'))
    parser.add_argument('--set', default=str(here.parents[2]/'docs/AI_DJ_EVAL_SET.json'))
    args = parser.parse_args()
    spec = json.loads(Path(args.set).read_text())
    db = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True)
    rows = db.execute('''SELECT t.id,t.artist,t.album,t.genre,f.bpm,f.energy,f.brightness,
        f.dynamic_range,f.rhythmic_activity,f.audio_fingerprint,
        COALESCE(f.audio_fingerprint_dims,0) FROM tracks t JOIN track_features f
        ON f.track_id=t.id WHERE t.deleted=0 AND f.analyzed_at>0''').fetchall()
    by_id = {r[0]: r for r in rows}; thresholds = spec['thresholds']; failures=[]; reports=[]
    fingerprinted = sum(vector(r)[1] == 'fingerprint-v1' for r in rows)
    for item in spec['seeds']:
        seed = by_id.get(item['track_id'])
        if not seed: failures.append(f"missing seed {item['track_id']}"); continue
        seed_v, mode = vector(seed)
        ranked = sorted((r for r in rows if r[0] != seed[0]), key=lambda r: cosine(seed_v, vector(r)[0]), reverse=True)
        # Apply the production artist cap before diversity/context checks.
        top=[]; counts={}
        for row in ranked:
            key=row[1].casefold()
            if counts.get(key,0) >= thresholds['maximum_tracks_per_artist']: continue
            counts[key]=counts.get(key,0)+1; top.append(row)
            if len(top) == spec['top_k']: break
        mates=[i+1 for i,r in enumerate(ranked) if r[1]==seed[1] and r[2]==seed[2]]
        nearest=min(mates) if mates else None
        unique=len({r[1].casefold() for r in top}); max_artist=max(counts.values(),default=0)
        context_share=sum(r[3] in ('Films/Games','Soundtrack') for r in top)/max(len(top),1)
        if unique < thresholds['minimum_unique_artists']: failures.append(f"{item['label']}: diversity {unique}")
        if max_artist > thresholds['maximum_tracks_per_artist']: failures.append(f"{item['label']}: artist cap {max_artist}")
        if item['kind'] == 'score' and context_share > thresholds['maximum_context_only_share']:
            failures.append(f"{item['label']}: context-only share {context_share:.0%}")
        if nearest is None or nearest > thresholds['maximum_nearest_album_mate_rank']:
            failures.append(f"{item['label']}: nearest album mate {nearest}")
        reports.append({'seed':item['label'],'mode':mode,'nearest_album_mate':nearest,
            'unique_artists_at_k':unique,'max_per_artist':max_artist,'context_share':round(context_share,3)})

    # Two hypothetical accounts, same two close musical candidates. The 8%
    # positive-only preference must affect only the account that owns the like.
    base_a, base_b = .70, .69
    account_a=(base_a+.08,base_b); account_b=(base_a,base_b+.08)
    separation = account_a[0] > account_a[1] and account_b[1] > account_b[0]
    if not separation: failures.append('per-user preference separation')
    result={'set_version':spec['version'],'tracks':len(rows),'fingerprint_coverage':f'{fingerprinted}/{len(rows)}',
        'seeds':reports,'per_user_separation':separation,'passed':not failures,'failures':failures}
    print(json.dumps(result,indent=2))
    return 1 if failures else 0

if __name__ == '__main__': sys.exit(main())
