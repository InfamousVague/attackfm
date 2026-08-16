#!/usr/bin/env python3
"""Serial, bounded end-to-end evaluator for the layered enrichment pipeline."""
import json, os, shutil, sqlite3, subprocess, time
from pathlib import Path

DB = Path.home()/'.local/share/attackfm-ai-dj-test/attackfm.db'
ROOT = Path('/run/media/kevin/PlotDrive/AttackFM-Music/SpotiFLAC')
OUT = Path(os.environ.get(
    'AFM_EVAL_OUT',
    str(Path.home()/'.local/share/attackfm-ai-dj-test/enrichment-evals/layered-hard-20-v2'),
))
CAPTURE = OUT/'raw-responses.jsonl'
SF = Path.home()/'.local/pipx/venvs/spotiflac/bin/spotiflac'
SF_HOME = Path.home()/'.local/share/attackfm-ai-dj-test/spotiflac-home'
UNIT = 'attackfm-ai-dj-test.service'
TRACKS = [
 ('RAT BOY & IBDY',"Who's Ready for Tomorrow",None),
 ('Le Tigre','Deceptacon',None),
 ('Rina Sawayama','XS','https://open.spotify.com/track/1peAiBjdwKtWqlgp9y9GNN'),
 ('Poppy','Concrete','https://open.spotify.com/track/24KeHeSMQ3FHew3pBV2tm2'),
 ('Lil Nas X','Old Town Road','https://open.spotify.com/track/2pMl9Sx4glsuk5ikZtFBtX'),
 ('Wet Leg','Chaise Longue','https://open.spotify.com/track/0nys6GusuHnjSYLW0PYYb7'),
 ('Grimes','Genesis','https://open.spotify.com/track/3cjvqsvvU80g7WJPMVh8iq'),
 ('Flying Lotus feat. Kendrick Lamar','Never Catch Me','https://open.spotify.com/track/6CTG85NJI1Wm60pxTSRNwL'),
 ('OutKast','B.O.B. - Bombs Over Baghdad','https://open.spotify.com/track/3WibbMr6canxRJXhNtAvLU'),
 ('FKA twigs','Cellophane','https://open.spotify.com/track/3VwZqgfrM3xb1usuLprkTu'),
 ('Mitski','Geyser','https://open.spotify.com/track/2fCdOF4nBAeQaXW84WjoiU'),
 ('black midi','Sugar/Tzu','https://open.spotify.com/track/0DkazfLyVRaMvSkwycyyfT'),
 ('100 gecs','Hollywood Baby','https://open.spotify.com/track/0oigSejhoNen2EdNAIFcm5'),
 ('Justice','D.A.N.C.E.','https://open.spotify.com/track/33yAEqzKXexYM3WlOYtTfQ'),
 ('M.I.A.','Paper Planes','https://open.spotify.com/track/1ixbwbeBi5ufN4noUKmW5a'),
 ('Azealia Banks feat. Lazy Jay','212',None),
 ('Death Grips','Get Got','https://open.spotify.com/track/781V2Y5LPtcpgONEOadadE'),
 ('The Avalanches','Frontier Psychiatrist',None),
 ('Radiohead','Everything in Its Right Place',None),
 ('Death Grips','On GP',None),
]

def sh(*args, check=True, **kw):
    return subprocess.run(args, check=check, text=True, **kw)

def db(readonly=False):
    # Service restarts briefly rotate SQLite's WAL/SHM companions. On a busy
    # test host that can make one read-only open fail even though the database
    # itself is healthy; do not throw away an hours-long serial evaluation for
    # a transient filesystem race.
    error = None
    for attempt in range(8):
        try:
            return sqlite3.connect(
                f'file:{DB}?mode=ro' if readonly else DB,
                uri=readonly,
                timeout=30,
            )
        except sqlite3.OperationalError as exc:
            error = exc
            time.sleep(min(1 + attempt, 5))
    raise error

def folded(s): return ''.join(c for c in s.casefold() if c.isalnum())

def locate(artist, title):
    with db(True) as c:
        rows=c.execute("select id,artist,title,album,duration_ms,rel_path from tracks where deleted=0").fetchall()
    tf=folded(title); af=folded(artist.replace('feat.','').replace('&',','))
    matches=[]
    for row in rows:
        if folded(row[2]) == tf:
            score=sum(part and part in folded(row[1]) for part in [folded(x.strip()) for x in artist.replace('feat.',',').replace('&',',').split(',')])
            matches.append((score,row))
    return max(matches,default=(0,None))[1]

def acquire(artist,title,url):
    if not url: return False,'missing-no-url'
    env=os.environ.copy(); env['HOME']=str(SF_HOME)
    log=OUT/f'{len(list(OUT.glob("[0-9][0-9]-*.json")))+1:02d}-acquisition.log'
    args=[str(SF),url,str(ROOT),'--service','deezer','tidal','qobuz','youtube','--quality','LOSSLESS',
          '--use-album-track-numbers','--use-artist-subfolders','--use-album-subfolders',
          '--filename-format','{track}. {title}','--retries','2','--timeout','300']
    with log.open('w') as out:
        result=sh(*args,check=False,env=env,stdout=out,stderr=subprocess.STDOUT)
    return result.returncode==0,('imported' if result.returncode==0 else f'failed-exit-{result.returncode}')

def service(action): sh('systemctl','--user',action,UNIT,check=False)
def target(track_id):
    sh('systemctl','--user','set-environment',f'AFM_ENRICH_TRACK_IDS={track_id}')
    sh('systemctl','--user','daemon-reload')

def snapshot(row):
    tid=row[0]
    with db(True) as c:
        c.row_factory=sqlite3.Row
        meta=dict(c.execute("select id,artist,title,album,genre,year,duration_ms,rel_path,length(trim(lyrics))>0 as lyrics_available from tracks where id=?",(tid,)).fetchone())
        measured=c.execute("select bpm,energy,brightness,loudness,dynamic_range,rhythmic_activity,analyzed_at from track_features where track_id=?",(tid,)).fetchone()
        layer=c.execute("select * from song_profile_layers where track_id=?",(tid,)).fetchone()
        legacy=c.execute("select ai_summary,ai_genres,ai_vibes,ai_sonic_traits,ai_lyrical_themes,ai_confidence,ai_sources,ai_enriched_at from track_features where track_id=?",(tid,)).fetchone()
        tag_evidence=[dict(r) for r in c.execute("select raw_tag,normalized_tag,canonical_tag,decision,candidate_tags,decided_by,created_at from track_specific_tag_evidence where track_id=? order by created_at,raw_tag",(tid,))]
    return {'metadata':meta,'measured':dict(zip(['bpm','energy','brightness','loudness','dynamic_range','rhythmic_activity','analyzed_at'],measured or [])),
            'layer':dict(layer) if layer else None,'legacy':dict(zip(['summary','genres','moods','traits','themes','confidence','sources','enriched_at'],legacy or [])),
            'specific_tag_evidence':tag_evidence}

def clear_generated(tid):
    with db() as c:
        c.execute("delete from song_profile_layers where track_id=?",(tid,))
        c.execute("delete from track_specific_tag_evidence where track_id=?",(tid,))
        c.execute("""update track_features set ai_summary='',ai_genres='',ai_vibes='',ai_sonic_traits='',ai_lyrical_themes='',
          ai_confidence=0,ai_sources='',ai_enriched_at=0,sonic_vec=null,sonic_vec_dims=0,lyrical_vec=null,lyrical_vec_dims=0,
          community_vec=null,community_vec_dims=0 where track_id=?""",(tid,))

def capture_lines(start):
    if not CAPTURE.exists(): return []
    lines=CAPTURE.read_text().splitlines()
    return [json.loads(x) for x in lines[start:]]

def run_track(tid):
    start_lines=len(CAPTURE.read_text().splitlines()) if CAPTURE.exists() else 0
    started=int(time.time()*1000); target(tid); service('restart')
    qwen_deadline=time.time()+8*60; outcome='qwen-timeout'; fast_seen=False
    gemma_deadline=None
    while time.time() < (gemma_deadline or qwen_deadline):
        time.sleep(2)
        with db(True) as c:
            layer=c.execute("select fast_created_at,refined_at from song_profile_layers where track_id=?",(tid,)).fetchone()
            rejection=c.execute("select ai_sources,ai_enriched_at from track_features where track_id=?",(tid,)).fetchone()
        if layer and layer[0]>0 and not fast_seen:
            fast_seen=True
            # Gemma's configured HTTP timeout is five minutes. Give it a
            # separate seventeen-minute observation window; Qwen time must not
            # consume Gemma's allowance.
            gemma_deadline=time.time()+17*60
        if layer and layer[1]>0: outcome='complete'; break
        if not layer and rejection and rejection[0]=='rejected_v3' and rejection[1]>=started:
            outcome='qwen-rejected'; break
    if fast_seen and outcome == 'qwen-timeout': outcome='gemma-timeout'
    service('stop')
    return outcome,capture_lines(start_lines)

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    start_index=int(os.environ.get('AFM_EVAL_START_INDEX','1'))
    service('stop')
    for index,(artist,title,url) in enumerate(TRACKS,1):
        if index < start_index: continue
        result_path=OUT/f'{index:02d}-{folded(title)[:40]}.json'
        if result_path.exists():
            print(f'[{index}/20] already recorded: {artist} — {title}',flush=True); continue
        row=locate(artist,title); acquisition='already-in-library'
        if not row:
            print(f'[{index}/20] acquiring: {artist} — {title}',flush=True)
            ok,acquisition=acquire(artist,title,url)
            if not ok:
                result_path.write_text(json.dumps({'track':f'{artist} — {title}','acquisition':acquisition,'outcome':'acquisition-failed'},indent=2))
                continue
            target(0); service('start'); time.sleep(10); service('stop'); row=locate(artist,title)
            if not row:
                result_path.write_text(json.dumps({'track':f'{artist} — {title}','acquisition':acquisition,'outcome':'indexing-failed'},indent=2)); continue
        before=snapshot(row)
        # Exactness guard: reject obvious version substitutions.
        combined=(row[2]+' '+row[3]).casefold()
        if any(word in combined for word in [' remix',' live','instrumental','radio edit']) or folded(row[2]) != folded(title):
            result_path.write_text(json.dumps({'track':f'{artist} — {title}','acquisition':acquisition,'located':row,'outcome':'exactness-failed'},indent=2)); continue
        clear_generated(row[0])
        print(f'[{index}/20] enriching id={row[0]}: {row[1]} — {row[2]}',flush=True)
        outcome,captures=run_track(row[0]); after=snapshot(row)
        record={'track':f'{artist} — {title}','acquisition':acquisition,'located':row,'outcome':outcome,
                'before':before,'model_responses':captures,'after':after,
                'gemma_received':{'source_metadata':after['metadata'],'measured_audio':after['measured'],
                    'qwen_fast_profile':json.loads(after['layer']['fast_profile']) if after['layer'] and after['layer']['fast_profile'] else None,
                    'lyrics_available':after['metadata']['lyrics_available']}}
        result_path.write_text(json.dumps(record,indent=2))
        print(f'[{index}/20] {outcome}',flush=True)
    print('SERIAL_RUN_COMPLETE',flush=True)

if __name__=='__main__': main()
