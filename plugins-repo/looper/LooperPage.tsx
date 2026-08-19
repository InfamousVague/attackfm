import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, SegmentedControl, Slider, Switch, Text } from '@glacier/react';
import { Disc3, Pencil, Play, Scissors, Square, Trash2, Wand2 } from '@glacier/icons';
import { useServerSession } from '@attackfm/app/serverSession';
import { useLibrary } from '@attackfm/app/library';
import { LANES, LoopEngine, PAD_COUNT, emptyLoopPad, laneOf, type LoopPad } from './engine.ts';
import { autoSlice } from './slicer.ts';

/**
 * The Looper.
 *
 * A record goes in and comes out as sixteen coloured pads that play in time
 * with each other. The grid's geometry is the instrument: a COLUMN is a lane
 * that loops on its own, the four pads down it are variations of that lane,
 * and only one of them sounds at a time - so four loops layer, and sixteen
 * things are available to put in them. Hue names the lane, lightness the row.
 *
 * Two modes, one grid. In PLAY a pad launches on the next bar line. In EDIT a
 * pad opens its slice in the whole song's waveform, where the region can be
 * dragged and its edges moved - which is the difference between a kit that is
 * nearly right and one that is right.
 */

const KIT_KEY = 'attackfm-looper-kit-v1';
/** One hue per lane. Four colours a person can name, spaced far enough apart
 *  to tell at a glance under stage-ish conditions. */
const LANE_HUES = [16, 140, 210, 288];

interface Session {
  url: string;
  token: string;
  streamToken: string;
}

/** Waveform resolution: a bucket every few pixels is plenty, and a
 *  four-minute track at this rate is a few hundred numbers, not millions. */
const PEAKS = 600;

function peaksOf(buffer: AudioBuffer, buckets = PEAKS): number[] {
  const data = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(data.length / buckets));
  const out: number[] = [];
  for (let i = 0; i < buckets; i += 1) {
    let peak = 0;
    const from = i * per;
    for (let j = from; j < from + per && j < data.length; j += 8) {
      const v = Math.abs(data[j] ?? 0);
      if (v > peak) peak = v;
    }
    out.push(peak);
  }
  return out;
}

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 'var(--glacier-space-4)',
  maxWidth: 760,
};
const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 10,
  touchAction: 'manipulation',
};
const padFace = (
  hue: number,
  loaded: boolean,
  live: boolean,
  waiting: boolean,
  editing: boolean,
  row = 0,
): CSSProperties => ({
  position: 'relative',
  aspectRatio: '1',
  borderRadius: 14,
  border: editing
    ? '2px solid var(--glacier-text)'
    : live
      ? `2px solid hsl(${hue} 85% 70%)`
      : '1px solid var(--glacier-border)',
  // Lightness steps down the column, so the four variations of a lane are
  // one family rather than four identical squares.
  background: loaded
    ? `radial-gradient(120% 120% at 30% 20%, hsl(${hue} 75% ${(live ? 62 : 44) - row * 5}%), hsl(${hue} 65% ${(live ? 40 : 24) - row * 4}%))`
    : 'var(--glacier-bg-surface)',
  boxShadow: live ? `0 0 20px -4px hsl(${hue} 85% 60% / 0.8)` : 'none',
  color: loaded ? '#fff' : 'var(--glacier-text-muted)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  padding: 10,
  cursor: 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
  opacity: waiting ? 0.65 : 1,
  transition: 'background 140ms ease, box-shadow 140ms ease, opacity 140ms ease',
});
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
const knob: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '70px 1fr 52px',
  gap: 10,
  alignItems: 'center',
};

export function LooperPage() {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const engineRef = useRef<LoopEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new LoopEngine();
  const engine = engineRef.current;

  const [pads, setPads] = useState<LoopPad[]>(() => {
    try {
      const raw = localStorage.getItem(KIT_KEY);
      const parsed = raw ? (JSON.parse(raw) as LoopPad[]) : null;
      if (Array.isArray(parsed) && parsed.length === PAD_COUNT) return parsed;
    } catch {
      // A kit that will not parse never existed.
    }
    return Array.from({ length: PAD_COUNT }, emptyLoopPad);
  });
  const [mode, setMode] = useState<'play' | 'edit'>('play');
  const [editing, setEditing] = useState<number | null>(null);
  const [live, setLive] = useState<Set<number>>(new Set());
  const [waiting, setWaiting] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickTrack, setPickTrack] = useState<number | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [tempoTable, setTempoTable] = useState<Map<number, number>>(new Map());
  /** Which pads have audio decoded in THIS session. */
  const [loaded, setLoaded] = useState<Set<number>>(new Set());

  const say = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote(null), 4000);
  };

  useEffect(() => {
    try {
      localStorage.setItem(KIT_KEY, JSON.stringify(pads));
    } catch {
      // Not worth failing over.
    }
    engine.pads = pads;
  }, [pads, engine]);

  useEffect(() => {
    engine.bpm = bpm;
  }, [bpm, engine]);

  useEffect(() => {
    engine.onChange((playing) => {
      setLive(new Set(playing));
      setWaiting(new Set(engine.waiting));
    });
    return () => engine.onChange(null);
  }, [engine]);

  useEffect(() => () => engine.dispose(), [engine]);

  // The server's tempo table, so a slice lands on the beat rather than near it.
  useEffect(() => {
    if (!session) return;
    let live2 = true;
    void (async () => {
      try {
        const res = await fetch(`${session.url}/api/tempo`, {
          headers: { authorization: `Bearer ${(session as Session).token}` },
        });
        if (!res.ok || !live2) return;
        const body = (await res.json()) as { tracks?: [number, number][] };
        const map = new Map<number, number>();
        for (const [id, value] of body.tracks ?? []) map.set(id, value);
        if (live2) setTempoTable(map);
      } catch {
        // No tempo table: the slicer falls back to raw transients.
      }
    })();
    return () => {
      live2 = false;
    };
  }, [session]);

  const patch = (index: number, next: Partial<LoopPad>) =>
    setPads((prev) => prev.map((p, i) => (i === index ? { ...p, ...next } : p)));

  /* ── sampling a song ─────────────────────────────────────────────────── */

  const fetchAudio = async (trackId: number): Promise<AudioBuffer | null> => {
    if (!session) return null;
    const s = session as Session;
    // The transcoded stream rather than the original: a phone decoding a
    // 40 MB FLAC to sample eight bars of it is a minute of waiting for
    // nothing. The token rides in the query because this is the same door
    // the media element uses.
    const url = `${s.url}/api/transcode/${trackId}?t=${encodeURIComponent(s.streamToken)}&bitrate=192`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return engine.decode(await res.arrayBuffer());
  };

  /** Cut a song into sixteen pads automatically. */
  const autoSample = async (trackId: number) => {
    setBusy('Fetching the song…');
    try {
      const buffer = await fetchAudio(trackId);
      if (!buffer) {
        say('That song would not decode here.');
        return;
      }
      setBusy('Finding the beats…');
      const trackBpm = tempoTable.get(trackId) ?? null;
      // Yield once so the "finding the beats" line actually paints before the
      // analysis takes the thread.
      await new Promise((r) => window.setTimeout(r, 30));
      const slices = autoSlice(buffer, trackBpm, PAD_COUNT);
      const track = tracks.find((t) => t.path === `afm://${trackId}`);
      const title = track?.title ?? 'Sample';
      setPads((prev) =>
        prev.map((p, i) => {
          const slice = slices[i];
          if (!slice) return p;
          return {
            ...p,
            name: `${title} ${i + 1}`,
            source: { trackId, title },
            start: slice.start,
            end: slice.end,
            loop: true,
            // Hue is the LANE, not the slice number: during a set the eye
            // learns "the amber column is the drums", and a colour that
            // meant slice-order would change meaning every time a pad was
            // re-sampled. Row is read from position instead.
            hue: LANE_HUES[laneOf(i)] ?? 210,
          };
        }),
      );
      for (let i = 0; i < PAD_COUNT && i < slices.length; i += 1) engine.setBuffer(i, buffer);
      setLoaded(new Set(slices.map((_, i) => i)));
      if (trackBpm) setBpm(Math.round(trackBpm));
      say(
        trackBpm
          ? `Sliced into ${slices.length} on the beat at ${Math.round(trackBpm)} BPM.`
          : `Sliced into ${slices.length}. No tempo known for this one, so these follow the sound.`,
      );
    } catch {
      say('Could not sample that song.');
    } finally {
      setBusy(null);
    }
  };

  /** Put one region of a song on the selected pad. */
  const sampleToPad = async (trackId: number, pad: number) => {
    setBusy('Fetching the song…');
    try {
      const buffer = await fetchAudio(trackId);
      if (!buffer) {
        say('That song would not decode here.');
        return;
      }
      const track = tracks.find((t) => t.path === `afm://${trackId}`);
      const bars = (60 / (tempoTable.get(trackId) ?? bpm)) * 4;
      engine.setBuffer(pad, buffer);
      patch(pad, {
        name: track?.title ?? 'Sample',
        source: { trackId, title: track?.title ?? 'Sample' },
        start: 0,
        end: Math.min(buffer.duration, bars * 2),
        hue: LANE_HUES[laneOf(pad)] ?? 210,
      });
      setLoaded((prev) => new Set(prev).add(pad));
      setEditing(pad);
      setMode('edit');
      say('On the pad — drag the region to where you want it.');
    } catch {
      say('Could not sample that song.');
    } finally {
      setBusy(null);
    }
  };

  /* ── the waveform editor ─────────────────────────────────────────────── */

  useEffect(() => {
    if (editing === null) {
      setPeaks([]);
      return;
    }
    const buffer = engine.buffer(editing);
    setPeaks(buffer ? peaksOf(buffer) : []);
  }, [editing, engine, loaded]);

  const waveRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ kind: 'start' | 'end' | 'move'; from: number; s: number; e: number } | null>(null);

  const secondsAt = (clientX: number): number => {
    const box = waveRef.current?.getBoundingClientRect();
    const buffer = editing === null ? null : engine.buffer(editing);
    if (!box || !buffer) return 0;
    const at = (clientX - box.left) / Math.max(1, box.width);
    return Math.max(0, Math.min(1, at)) * buffer.duration;
  };

  /** Beat-snap while dragging, because a loop that starts a hair off the beat
   *  is the one thing that makes a whole kit feel wrong. */
  const snap = (seconds: number): number => {
    const beat = 60 / Math.max(20, bpm);
    const nearest = Math.round(seconds / beat) * beat;
    return Math.abs(nearest - seconds) < beat * 0.2 ? nearest : seconds;
  };

  const onWavePointerDown = (e: React.PointerEvent) => {
    if (editing === null) return;
    const conf = pads[editing];
    const buffer = engine.buffer(editing);
    if (!conf || !buffer) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = secondsAt(e.clientX);
    const near = buffer.duration * 0.02;
    const kind =
      Math.abs(at - conf.start) < near ? 'start' : Math.abs(at - conf.end) < near ? 'end' : 'move';
    dragRef.current = { kind, from: at, s: conf.start, e: conf.end };
  };

  const onWavePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || editing === null) return;
    const buffer = engine.buffer(editing);
    if (!buffer) return;
    const at = secondsAt(e.clientX);
    if (drag.kind === 'start') {
      patch(editing, { start: Math.max(0, Math.min(snap(at), drag.e - 0.05)) });
    } else if (drag.kind === 'end') {
      patch(editing, { end: Math.min(buffer.duration, Math.max(snap(at), drag.s + 0.05)) });
    } else {
      // Slide the whole region, keeping its length - the usual way to hunt
      // for the right bar of a loop.
      const shift = at - drag.from;
      const span = drag.e - drag.s;
      const start = Math.max(0, Math.min(snap(drag.s + shift), buffer.duration - span));
      patch(editing, { start, end: start + span });
    }
  };

  const onWavePointerUp = () => {
    dragRef.current = null;
  };

  /* ── transport ───────────────────────────────────────────────────────── */

  const toggleTransport = async () => {
    if (engine.running) {
      engine.stopAll();
      setRunning(false);
    } else {
      await engine.start();
      setRunning(true);
    }
  };

  const hitPad = useCallback(
    (index: number) => {
      if (mode === 'edit') {
        setEditing(index);
        return;
      }
      // Synchronous: engine.launch builds the graph itself rather than
      // awaiting an unlock, so a press reaches the audio thread immediately.
      engine.launchNow(index, pads);
    },
    [engine, mode, pads],
  );

  const conf = editing === null ? null : (pads[editing] ?? null);
  const editBuffer = editing === null ? null : engine.buffer(editing);

  const musicTracks = useMemo(
    () => tracks.filter((t) => t.path.startsWith('afm://')).slice(0, 400),
    [tracks],
  );

  return (
    <div className="homePage">
      <div style={wrap}>
        <header style={rowStyle}>
          <Disc3 size={22} aria-hidden />
          <div style={{ flex: 1, minWidth: 180 }}>
            <Text weight="bold" size="lg">Looper</Text>
            <Text tone="muted" size="sm">
              Sample a song, cut it up, and play the pieces in time with each other.
            </Text>
          </div>
          <Button variant={running ? 'ghost' : 'solid'} size="sm" onClick={() => void toggleTransport()}>
            {running ? (<><Square size={14} /> Stop</>) : (<><Play size={14} /> Start</>)}
          </Button>
        </header>

        {!session && (
          <Text tone="muted" size="sm">
            Sampling pulls audio from your server — sign in to one to feed the pads.
          </Text>
        )}

        <div style={rowStyle}>
          <SegmentedControl
            aria-label="Mode"
            size="sm"
            value={mode}
            options={[
              { value: 'play', label: 'Play' },
              { value: 'edit', label: 'Edit' },
            ]}
            onValueChange={(v) => {
              setMode(v as 'play' | 'edit');
              if (v === 'play') setEditing(null);
            }}
          />
          <label style={{ ...rowStyle, gap: 8 }}>
            <Text size="xs" tone="muted">Tempo</Text>
            <Slider aria-label="Tempo" min={60} max={180} step={1} value={bpm}
              onValueChange={(v: number) => setBpm(v)} style={{ width: 130 }} />
            <Text size="xs" mono>{bpm} BPM</Text>
          </label>
        </div>

        {mode === 'play' && (
          <Text tone="muted" size="xs">
            {running
              ? 'Pads join on the next bar — and a pad replaces whatever else its lane was playing.'
              : 'The first pad you press sets the downbeat; everything after joins in time with it.'}
          </Text>
        )}
        {mode === 'edit' && (
          <Text tone="muted" size="xs">
            <Pencil size={12} /> Tap a pad to open its slice, then drag the region or its edges.
          </Text>
        )}

        {/* The grid. Columns are lanes that loop independently; the four pads
            down a column are variations of that lane, and only one of them
            sounds at a time. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }} aria-hidden>
          {Array.from({ length: LANES }, (_, lane) => (
            <Text key={lane} size="xs" tone="muted" style={{ textAlign: 'center' }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                background: `hsl(${LANE_HUES[lane]} 70% 55%)`, marginRight: 5,
              }} />
              Lane {lane + 1}
            </Text>
          ))}
        </div>
        <div style={gridStyle} role="group" aria-label="Loop pads">
          {pads.map((p, i) => {
            const isLoaded = loaded.has(i);
            return (
              <button
                key={i}
                type="button"
                aria-label={p.name || `Pad ${i + 1}`}
                style={padFace(p.hue, isLoaded, live.has(i), waiting.has(i), editing === i, Math.floor(i / LANES))}
                onPointerDown={(e) => {
                  e.preventDefault();
                  hitPad(i);
                }}
              >
                <Text size="xs" style={{ opacity: 0.8, color: 'inherit' }}>{i + 1}</Text>
                <Text size="xs" style={{ lineHeight: 1.15, color: 'inherit', opacity: isLoaded ? 1 : 0.55 }}>
                  {isLoaded ? `${(p.end - p.start).toFixed(1)}s` : 'empty'}
                </Text>
                {waiting.has(i) && (
                  <span aria-hidden style={{
                    position: 'absolute', inset: 0, borderRadius: 12,
                    border: '2px dashed rgba(255,255,255,0.7)',
                  }} />
                )}
              </button>
            );
          })}
        </div>

        {note && <Text size="sm" tone="muted">{note}</Text>}
        {busy && <Text size="sm" tone="muted">{busy}</Text>}

        {/* Edit mode: the slice inside the whole song */}
        {mode === 'edit' && editing !== null && conf && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Text weight="bold" size="sm">
              Pad {editing + 1}{conf.name ? ` — ${conf.name}` : ''}
            </Text>
            {editBuffer && peaks.length > 0 ? (
              <>
                <div
                  ref={waveRef}
                  onPointerDown={onWavePointerDown}
                  onPointerMove={onWavePointerMove}
                  onPointerUp={onWavePointerUp}
                  onPointerCancel={onWavePointerUp}
                  style={{
                    position: 'relative', height: 96, display: 'flex', alignItems: 'center',
                    gap: 1, padding: '0 4px', borderRadius: 8, cursor: 'ew-resize',
                    background: 'var(--glacier-bg-surface)', border: '1px solid var(--glacier-border)',
                    touchAction: 'none', overflow: 'hidden',
                  }}
                >
                  {peaks.map((v, i) => {
                    const at = (i / peaks.length) * editBuffer.duration;
                    const inside = at >= conf.start && at <= conf.end;
                    return (
                      <span key={i} style={{
                        flex: 1, height: `${Math.max(2, v * 92)}%`, borderRadius: 1,
                        background: inside ? `hsl(${conf.hue} 75% 62%)` : 'var(--glacier-border)',
                      }} />
                    );
                  })}
                  {/* Handles, drawn over the wave so they can be grabbed. */}
                  {(['start', 'end'] as const).map((edge) => (
                    <span key={edge} aria-hidden style={{
                      position: 'absolute', top: 0, bottom: 0, width: 3,
                      left: `${((edge === 'start' ? conf.start : conf.end) / editBuffer.duration) * 100}%`,
                      background: 'var(--glacier-text)', opacity: 0.85,
                    }} />
                  ))}
                </div>
                <div style={rowStyle}>
                  <Text size="xs" tone="muted" mono>
                    {conf.start.toFixed(2)}s → {conf.end.toFixed(2)}s ({(conf.end - conf.start).toFixed(2)}s,
                    {' '}{((conf.end - conf.start) / (60 / bpm)).toFixed(1)} beats)
                  </Text>
                  <Button size="sm" variant="ghost" onClick={() => void engine.launch(editing, pads)}>
                    <Play size={13} /> Preview
                  </Button>
                </div>
                <label style={knob}>
                  <Text size="xs" tone="muted">Level</Text>
                  <Slider aria-label="Level" min={0} max={2} step={0.05} value={conf.gain}
                    onValueChange={(v: number) => patch(editing, { gain: v })} />
                  <Text size="xs" style={{ textAlign: 'right' }}>{Math.round(conf.gain * 100)}%</Text>
                </label>
                <label style={knob}>
                  <Text size="xs" tone="muted">Pitch</Text>
                  <Slider aria-label="Pitch" min={-12} max={12} step={1} value={conf.pitch}
                    onValueChange={(v: number) => patch(editing, { pitch: v })} />
                  <Text size="xs" style={{ textAlign: 'right' }}>{conf.pitch > 0 ? '+' : ''}{conf.pitch}</Text>
                </label>
                <div style={rowStyle}>
                  <label style={{ ...rowStyle, gap: 6 }}>
                    <Switch aria-label="Loop" checked={conf.loop}
                      onCheckedChange={(v: boolean) => patch(editing, { loop: v })} />
                    <Text size="xs" tone="muted">Loop</Text>
                  </label>
                  <label style={{ ...rowStyle, gap: 6 }}>
                    <Text size="xs" tone="muted">Choke</Text>
                    <SegmentedControl aria-label="Choke group" size="sm" value={String(conf.choke)}
                      options={[
                        { value: '0', label: 'None' },
                        { value: '1', label: '1' },
                        { value: '2', label: '2' },
                      ]}
                      onValueChange={(v) => patch(editing, { choke: Number(v) })} />
                  </label>
                  <Button size="sm" variant="ghost" onClick={() => {
                    engine.clear(editing);
                    patch(editing, emptyLoopPad());
                    setLoaded((p) => { const n = new Set(p); n.delete(editing); return n; });
                  }}>
                    <Trash2 size={13} /> Clear
                  </Button>
                </div>
              </>
            ) : (
              <Text tone="muted" size="sm">
                {conf.source
                  ? 'This pad has a slice saved but its audio is not loaded — sample the song again.'
                  : 'Nothing on this pad yet. Sample a song below.'}
              </Text>
            )}
          </section>
        )}

        {/* Feeding it */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Text weight="bold" size="sm"><Scissors size={14} /> Sample a song</Text>
          <select
            aria-label="Song to sample"
            value={pickTrack ?? ''}
            onChange={(e) => {
              const id = Number(e.target.value);
              setPickTrack(Number.isFinite(id) && id > 0 ? id : null);
            }}
            style={{
              padding: '8px 10px', borderRadius: 8, background: 'var(--glacier-bg-surface)',
              color: 'var(--glacier-text)', border: '1px solid var(--glacier-border)',
            }}
          >
            <option value="">Choose a song…</option>
            {musicTracks.map((t) => {
              const id = Number(t.path.replace('afm://', ''));
              return Number.isFinite(id) ? (
                <option key={t.path} value={id}>
                  {t.title} — {t.artist}{tempoTable.has(id) ? ` · ${Math.round(tempoTable.get(id)!)} BPM` : ''}
                </option>
              ) : null;
            })}
          </select>
          <div style={rowStyle}>
            <Button size="sm" variant="solid" disabled={!session || pickTrack === null || busy !== null}
              onClick={() => pickTrack !== null && void autoSample(pickTrack)}>
              <Wand2 size={14} /> Auto-sample all 16
            </Button>
            <Button size="sm" variant="ghost"
              disabled={!session || pickTrack === null || busy !== null || editing === null}
              onClick={() => pickTrack !== null && editing !== null && void sampleToPad(pickTrack, editing)}>
              Sample onto pad {editing === null ? '—' : editing + 1}
            </Button>
          </div>
          <Text size="xs" tone="muted">
            Auto-sample finds the transients and snaps them to the song’s own beat, so the
            pieces start where the music does.
          </Text>
        </section>
      </div>
    </div>
  );
}
