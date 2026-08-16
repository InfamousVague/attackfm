#!/usr/bin/env python3
"""Observe a hard-20 batch without restarting or writing through AttackFM.

The service owns enrichment and SQLite writes.  This process only snapshots
terminal profiles into an isolated evaluation directory.  It is safe to
restart: an existing artifact is never overwritten.
"""
import json
import os
import sqlite3
import time
from pathlib import Path

DB = Path(os.environ["AFM_EVAL_DB"])
OUT = Path(os.environ["AFM_EVAL_OUT"])
POLL_SECONDS = int(os.environ.get("AFM_EVAL_POLL_SECONDS", "5"))

TRACKS = [
    (64, "RAT BOY & IBDY", "Who's Ready for Tomorrow"),
    (57, "Le Tigre", "Deceptacon"),
    (825, "Rina Sawayama", "XS"),
    (826, "Poppy", "Concrete"),
    (827, "Lil Nas X", "Old Town Road"),
    (828, "Wet Leg", "Chaise Longue"),
    (829, "Grimes", "Genesis"),
    (830, "Flying Lotus feat. Kendrick Lamar", "Never Catch Me"),
    (831, "OutKast", "B.O.B. - Bombs Over Baghdad"),
    (832, "FKA twigs", "Cellophane"),
    (833, "Mitski", "Geyser"),
    (834, "black midi", "Sugar/Tzu"),
    (835, "100 gecs", "Hollywood Baby"),
    (836, "Justice", "D.A.N.C.E."),
    (837, "M.I.A.", "Paper Planes"),
    (801, "Azealia Banks feat. Lazy Jay", "212"),
    (838, "Death Grips", "Get Got"),
    (800, "The Avalanches", "Frontier Psychiatrist"),
    (799, "Radiohead", "Everything in Its Right Place"),
    (823, "Death Grips", "On GP"),
]

requested = {
    int(value.strip())
    for value in os.environ.get("AFM_EVAL_TRACK_IDS", "").split(",")
    if value.strip()
}
if requested:
    TRACKS = [track for track in TRACKS if track[0] in requested]


def folded(value):
    return "".join(c for c in value.casefold() if c.isalnum())


def connect():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)


def snapshot(track_id):
    with connect() as conn:
        conn.row_factory = sqlite3.Row
        metadata = dict(conn.execute(
            "SELECT id,artist,title,album,genre,year,duration_ms,rel_path,"
            "length(trim(lyrics))>0 AS lyrics_available FROM tracks WHERE id=?",
            (track_id,),
        ).fetchone())
        measured = conn.execute(
            "SELECT bpm,energy,brightness,loudness,dynamic_range,"
            "rhythmic_activity,analyzed_at FROM track_features WHERE track_id=?",
            (track_id,),
        ).fetchone()
        layer = conn.execute(
            "SELECT * FROM song_profile_layers WHERE track_id=?", (track_id,)
        ).fetchone()
        evidence = [dict(row) for row in conn.execute(
            "SELECT raw_tag,normalized_tag,canonical_tag,decision,candidate_tags,"
            "decided_by,created_at FROM track_specific_tag_evidence "
            "WHERE track_id=? ORDER BY created_at,raw_tag", (track_id,)
        )]
    keys = ["bpm", "energy", "brightness", "loudness", "dynamic_range",
            "rhythmic_activity", "analyzed_at"]
    return {
        "metadata": metadata,
        "measured": dict(zip(keys, measured or [])),
        "layer": dict(layer) if layer else None,
        "specific_tag_evidence": evidence,
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"observing {DB}", flush=True)
    while True:
        remaining = 0
        for index, (track_id, artist, title) in enumerate(TRACKS, 1):
            path = OUT / f"{index:02d}-{folded(title)[:40]}.json"
            if path.exists():
                continue
            after = snapshot(track_id)
            layer = after["layer"] or {}
            if int(layer.get("refined_at") or 0) <= 0:
                remaining += 1
                continue
            record = {
                "track": f"{artist} — {title}",
                "outcome": "complete",
                "after": after,
            }
            path.write_text(json.dumps(record, indent=2))
            print(f"[{index}/{len(TRACKS)}] captured: {artist} — {title}", flush=True)
        if remaining == 0:
            print("BATCH_RUN_COMPLETE", flush=True)
            return
        completed = len(list(OUT.glob("[0-9][0-9]-*.json")))
        print(f"progress {completed}/{len(TRACKS)}", flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
