import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, SegmentedControl, Slider, Switch, Text } from '@glacier/react';
import { Grid2x2, Loader, Music, Scissors, Trash2, Volume2 } from '@glacier/icons';
import { useServerSession } from '@attackfm/app/serverSession';
import { useLibrary } from '@attackfm/app/library';
import { PAD_COUNT, PadEngine, emptyPad, type PadSettings } from './engine.ts';

/**
 * The Pads page.
 *
 * Three things happen here and they are deliberately kept apart: asking the
 * server to separate a track (slow, remote, polled), loading the result onto
 * pads (once, up front), and playing (immediate, local, outside React).
 *
 * The page never routes audio through the server. A pad has to answer a thumb
 * in a handful of milliseconds and the encoder is a hundred times too far
 * away for that, so stems are fetched once, decoded to buffers, and played
 * with Web Audio - see engine.ts.
 */

const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Everything else',
};
const STEM_HUES: Record<string, number> = { vocals: 320, drums: 28, bass: 265, other: 190 };
const KIT_KEY = 'attackfm-pads-kit-v1';

interface Session {
  url: string;
  token: string;
}

async function api<T>(session: Session, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${session.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error(await res.text().catch(() => `${res.status}`));
  return (await res.json()) as T;
}

async function fetchStem(session: Session, trackId: number, stem: string): Promise<ArrayBuffer> {
  const res = await fetch(`${session.url}/api/stems/${trackId}/${stem}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.arrayBuffer();
}

/* ── styles: a dark instrument face, because that is what these are ──────── */
const page: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 'var(--glacier-space-4)',
  maxWidth: 760,
};
const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 8,
  touchAction: 'manipulation',
};
const padFace = (hue: number | null, lit: boolean, selected: boolean): CSSProperties => ({
  aspectRatio: '1',
  borderRadius: 10,
  border: selected ? '2px solid var(--glacier-accent-9)' : '1px solid var(--glacier-border)',
  background: hue === null
    ? 'var(--glacier-bg-surface)'
    : `linear-gradient(150deg, hsl(${hue} 55% ${lit ? 52 : 30}% / ${lit ? 0.95 : 0.5}), var(--glacier-bg-surface))`,
  color: 'var(--glacier-text)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'flex-end',
  gap: 2,
  padding: 8,
  cursor: 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
  // `none`, not `manipulation`: manipulation still lets the browser own pan
  // and pinch, and on a grid of sixteen small targets that is exactly how a
  // second finger gets swallowed by a scroll gesture instead of playing.
  touchAction: 'none',
  transform: lit ? 'scale(0.97)' : 'none',
  transition: lit ? 'none' : 'transform 120ms ease, background 160ms ease',
  overflow: 'hidden',
});
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const knob: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '74px 1fr 52px',
  gap: 10,
  alignItems: 'center',
};

export function PadsPage() {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const engineRef = useRef<PadEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new PadEngine();
  const engine = engineRef.current;

  const [pads, setPads] = useState<PadSettings[]>(() => {
    try {
      const raw = localStorage.getItem(KIT_KEY);
      const parsed = raw ? (JSON.parse(raw) as PadSettings[]) : null;
      if (Array.isArray(parsed) && parsed.length === PAD_COUNT) return parsed;
    } catch {
      // A kit that will not parse is a kit that never existed.
    }
    return Array.from({ length: PAD_COUNT }, emptyPad);
  });
  const [selected, setSelected] = useState(0);
  /* Multitouch is the default assumption, not a special case: a Set of lit
   * pads and a voice per POINTER. The first cut kept one `lit` number and one
   * release function, which meant a second finger stole the first one's
   * release - so lifting either finger stopped the wrong sound, or none. */
  const [lit, setLit] = useState<Set<number>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which track the stem picker is looking at. */
  const [pickTrack, setPickTrack] = useState<number | null>(null);
  const [jobState, setJobState] = useState<string>('none');
  const [ready, setReady] = useState<string[]>([]);
  /** Pads whose audio is actually decoded in this session - a kit restored
   *  from storage has settings but no sound until it is reloaded. */
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
  }, [pads]);

  useEffect(() => () => engine.dispose(), [engine]);

  const patch = (index: number, next: Partial<PadSettings>) =>
    setPads((prev) => prev.map((p, i) => (i === index ? { ...p, ...next } : p)));

  /* ── playing ─────────────────────────────────────────────────────────── */

  /** One entry per live pointer (or key), so fingers cannot take each other's
   *  sound away. */
  const heldRef = useRef(new Map<number, { pad: number; release: (() => void) | null }>());

  const strike = useCallback(
    (index: number, velocity: number, pointer: number) => {
      // Synchronous. The whole reason this is not awaited is that a promise
      // costs a microtask at best, and an instrument that answers a microtask
      // late is an instrument that feels broken.
      const release = engine.hit(index, pads, velocity);
      heldRef.current.set(pointer, { pad: index, release: pads[index]?.gate ? release : null });
      setLit((prev) => {
        const next = new Set(prev);
        next.add(index);
        return next;
      });
    },
    [engine, pads],
  );

  /** Lifts one pointer, releasing only the sound that pointer started. */
  const letGo = useCallback((pointer: number) => {
    const held = heldRef.current.get(pointer);
    if (!held) return;
    heldRef.current.delete(pointer);
    held.release?.();
    setLit((prev) => {
      // Only unlight if no OTHER pointer is still holding this pad.
      for (const other of heldRef.current.values()) if (other.pad === held.pad) return prev;
      const next = new Set(prev);
      next.delete(held.pad);
      return next;
    });
  }, []);

  // The desktop keyboard, laid out like the grid it plays: 1234 / qwer /
  // asdf / zxcv, so the keys sit where the pads do.
  useEffect(() => {
    const keys = '1234qwerasdfzxcv';
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const index = keys.indexOf(e.key.toLowerCase());
      if (index === -1) return;
      e.preventDefault();
      // Negative ids so a key and a finger can never collide.
      strike(index, 1, -1 - index);
    };
    const up = (e: KeyboardEvent) => {
      const index = keys.indexOf(e.key.toLowerCase());
      if (index !== -1) letGo(-1 - index);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [strike, letGo]);

  /* ── separating ──────────────────────────────────────────────────────── */

  const askForStems = async (trackId: number) => {
    if (!session) return;
    setBusy(true);
    try {
      const res = await api<{ state: string }>(session as Session, `/api/stems/${trackId}`, {
        method: 'POST',
      });
      setJobState(res.state);
      say(
        res.state === 'done'
          ? 'Already separated — pick a part.'
          : 'Separating. This takes about half a minute a song.',
      );
    } catch (e) {
      say(e instanceof Error && e.message ? e.message : 'Could not ask the server.');
    } finally {
      setBusy(false);
    }
  };

  // Poll while a separation runs. Stops the moment it is done or fails, so an
  // open page is not a permanent request loop.
  useEffect(() => {
    if (!session || pickTrack === null) return;
    let live = true;
    const check = async () => {
      try {
        const res = await api<{ state: string; stems: { stem: string }[] }>(
          session as Session,
          `/api/stems/${pickTrack}`,
        );
        if (!live) return;
        setJobState(res.state);
        setReady(res.stems.map((s) => s.stem));
      } catch {
        if (live) setJobState('none');
      }
    };
    void check();
    const timer = window.setInterval(() => {
      if (jobState === 'queued' || jobState === 'running') void check();
    }, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, pickTrack, jobState]);

  const assign = async (index: number, trackId: number, stem: string) => {
    if (!session) return;
    setBusy(true);
    try {
      const bytes = await fetchStem(session as Session, trackId, stem);
      await engine.load(index, bytes);
      const track = tracks.find((t) => t.path.endsWith(`${trackId}`) || false);
      patch(index, {
        name: `${STEM_LABELS[stem] ?? stem}${track ? ` · ${track.title}` : ''}`,
        source: { trackId, stem },
        start: 0,
        end: 1,
        // Hold, not one-shot. A stem is a WHOLE track - three minutes of
        // vocal - and a one-shot pad plays it to the end no matter when the
        // thumb lifts, which reads as "letting go does nothing". Hold is what
        // anyone expects from a pad carrying something this long; trim it
        // down to a stab and turn hold off if you want it to fire and forget.
        gate: true,
      });
      setLoaded((prev) => new Set(prev).add(index));
      say('On the pad. Hit it.');
    } catch {
      say('That part is not ready yet.');
    } finally {
      setBusy(false);
    }
  };

  /** Re-decode a kit restored from storage. */
  const reloadKit = async () => {
    if (!session) return;
    setBusy(true);
    let ok = 0;
    for (let i = 0; i < pads.length; i += 1) {
      const src = pads[i]?.source;
      if (!src) continue;
      try {
        const bytes = await fetchStem(session as Session, src.trackId, src.stem);
        await engine.load(i, bytes);
        setLoaded((prev) => new Set(prev).add(i));
        ok += 1;
      } catch {
        // A stem that has been evicted since: the pad keeps its settings and
        // simply has no sound until it is separated again.
      }
    }
    setBusy(false);
    say(ok > 0 ? `Reloaded ${ok} pad${ok === 1 ? '' : 's'}.` : 'Nothing to reload.');
  };

  const conf = pads[selected] ?? emptyPad();
  const peaks = useMemo(
    () => (loaded.has(selected) ? engine.peaks(selected, 120) : []),
    [engine, selected, loaded],
  );

  const musicTracks = useMemo(
    () => tracks.filter((t) => t.path.startsWith('afm://')).slice(0, 400),
    [tracks],
  );

  return (
    <div className="homePage">
      <div style={page}>
        <header style={row}>
          <Grid2x2 size={22} aria-hidden />
          <div style={{ flex: 1 }}>
            <Text weight="bold" size="lg">Pads</Text>
            <Text tone="muted" size="sm">
              Sixteen pads, fed by your own records. Keys 1234 / qwer / asdf / zxcv play them.
            </Text>
          </div>
          <Button variant="ghost" size="sm" onClick={() => engine.panic()}>Stop all</Button>
        </header>

        {!session && (
          <Text tone="muted" size="sm">
            Separating a song happens on your server — sign in to one to pull tracks apart.
          </Text>
        )}

        {/* The instrument */}
        <div style={grid} role="group" aria-label="Pads">
          {pads.map((p, i) => {
            const hue = p.source ? (STEM_HUES[p.source.stem] ?? 200) : null;
            const live = loaded.has(i);
            return (
              <button
                key={i}
                type="button"
                aria-label={p.name || `Pad ${i + 1}`}
                style={padFace(hue, lit.has(i), selected === i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setSelected(i);
                  if (!live) return;
                  // Capture, so this pad keeps the pointer even if the finger
                  // slides off it. Without this a drum roll across the grid
                  // loses every pad the finger leaves, and pointerup lands on
                  // whatever element happens to be under the lift.
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    // Some engines refuse capture for a pointer already gone.
                  }
                  // Velocity from where the pad was struck: the lower the
                  // thumb lands, the harder it reads - the same convention
                  // hardware pads use for their own strike zones.
                  const box = e.currentTarget.getBoundingClientRect();
                  const y = (e.clientY - box.top) / Math.max(1, box.height);
                  strike(i, 0.55 + Math.max(0, Math.min(1, y)) * 0.45, e.pointerId);
                }}
                onPointerUp={(e) => letGo(e.pointerId)}
                onPointerCancel={(e) => letGo(e.pointerId)}
              >
                <Text size="xs" tone="muted" style={{ opacity: 0.75 }}>{i + 1}</Text>
                <Text size="xs" style={{ lineHeight: 1.15, opacity: live ? 1 : 0.5 }}>
                  {p.name ? p.name.split(' · ')[0] : 'empty'}
                </Text>
              </button>
            );
          })}
        </div>

        {note && <Text size="sm" tone="muted">{note}</Text>}

        {/* The selected pad */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Text weight="bold" size="sm">Pad {selected + 1}{conf.name ? ` — ${conf.name}` : ''}</Text>

          {peaks.length > 0 && (
            <div
              aria-hidden
              style={{
                display: 'flex', alignItems: 'center', gap: 1, height: 44,
                background: 'var(--glacier-bg-surface)', borderRadius: 6, padding: '0 6px',
                border: '1px solid var(--glacier-border)',
              }}
            >
              {peaks.map((v, i) => {
                const at = i / peaks.length;
                const inside = at >= conf.start && at <= conf.end;
                return (
                  <span
                    key={i}
                    style={{
                      flex: 1,
                      height: `${Math.max(2, v * 100)}%`,
                      background: inside ? 'var(--glacier-accent-9)' : 'var(--glacier-border)',
                      borderRadius: 1,
                    }}
                  />
                );
              })}
            </div>
          )}

          {loaded.has(selected) ? (
            <>
              <label style={knob}>
                <Text size="xs" tone="muted">Level</Text>
                <Slider aria-label="Level" min={0} max={1.5} step={0.05} value={conf.gain}
                  onValueChange={(v: number) => patch(selected, { gain: v })} />
                <Text size="xs" style={{ textAlign: 'right' }}>{Math.round(conf.gain * 100)}%</Text>
              </label>
              <label style={knob}>
                <Text size="xs" tone="muted">Pitch</Text>
                <Slider aria-label="Pitch" min={-12} max={12} step={1} value={conf.pitch}
                  onValueChange={(v: number) => patch(selected, { pitch: v })} />
                <Text size="xs" style={{ textAlign: 'right' }}>{conf.pitch > 0 ? '+' : ''}{conf.pitch}</Text>
              </label>
              <label style={knob}>
                <Text size="xs" tone="muted">Start</Text>
                <Slider aria-label="Start" min={0} max={0.98} step={0.01} value={conf.start}
                  onValueChange={(v: number) => patch(selected, { start: Math.min(v, conf.end - 0.01) })} />
                <Text size="xs" style={{ textAlign: 'right' }}>{Math.round(conf.start * 100)}%</Text>
              </label>
              <label style={knob}>
                <Text size="xs" tone="muted">End</Text>
                <Slider aria-label="End" min={0.02} max={1} step={0.01} value={conf.end}
                  onValueChange={(v: number) => patch(selected, { end: Math.max(v, conf.start + 0.01) })} />
                <Text size="xs" style={{ textAlign: 'right' }}>{Math.round(conf.end * 100)}%</Text>
              </label>
              <div style={{ ...row, flexWrap: 'wrap', gap: 16 }}>
                <label style={row} title="On: the pad sounds while you hold it. Off: one hit plays the whole slice.">
                  <Switch aria-label="Hold" checked={conf.gate}
                    onCheckedChange={(v: boolean) => patch(selected, { gate: v })} />
                  <Text size="xs" tone="muted">Hold</Text>
                </label>
                <label style={row}>
                  <Switch aria-label="Loop" checked={conf.loop}
                    onCheckedChange={(v: boolean) => patch(selected, { loop: v })} />
                  <Text size="xs" tone="muted">Loop</Text>
                </label>
                <label style={row}>
                  <Switch aria-label="Reverse" checked={conf.reverse}
                    onCheckedChange={(v: boolean) => patch(selected, { reverse: v })} />
                  <Text size="xs" tone="muted">Reverse</Text>
                </label>
                <label style={row}>
                  <Text size="xs" tone="muted">Choke</Text>
                  <SegmentedControl aria-label="Choke group" size="sm"
                    value={String(conf.choke)}
                    options={[
                      { value: '0', label: 'None' },
                      { value: '1', label: '1' },
                      { value: '2', label: '2' },
                    ]}
                    onValueChange={(v) => patch(selected, { choke: Number(v) })} />
                </label>
              </div>
              <div style={row}>
                <Button variant="ghost" size="sm"
                  onClick={() => { patch(selected, emptyPad()); setLoaded((p) => { const n = new Set(p); n.delete(selected); return n; }); }}>
                  <Trash2 size={14} /> Clear pad
                </Button>
              </div>
            </>
          ) : (
            <Text tone="muted" size="sm">
              {conf.source
                ? 'This pad has a sound saved but not loaded yet — use Reload kit below.'
                : 'Nothing on this pad. Pick a song below, separate it, and choose a part.'}
            </Text>
          )}
        </section>

        {/* Feeding the pads */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Text weight="bold" size="sm"><Scissors size={14} /> Pull a song apart</Text>
          <select
            aria-label="Song to separate"
            value={pickTrack ?? ''}
            onChange={(e) => {
              const id = Number(e.target.value);
              setPickTrack(Number.isFinite(id) && id > 0 ? id : null);
              setReady([]);
              setJobState('none');
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
                <option key={t.path} value={id}>{t.title} — {t.artist}</option>
              ) : null;
            })}
          </select>

          {pickTrack !== null && (
            <div style={{ ...row, flexWrap: 'wrap' }}>
              <Button size="sm" variant="solid" disabled={busy || jobState === 'running' || jobState === 'queued'}
                onClick={() => void askForStems(pickTrack)}>
                {jobState === 'running' || jobState === 'queued'
                  ? (<><Loader size={14} /> Separating…</>)
                  : (<><Music size={14} /> Separate this song</>)}
              </Button>
              {jobState === 'failed' && <Text size="sm" tone="muted">That one failed — try another.</Text>}
            </div>
          )}

          {ready.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ready.map((stem) => (
                <Button key={stem} size="sm" variant="ghost" disabled={busy}
                  onClick={() => pickTrack !== null && void assign(selected, pickTrack, stem)}>
                  <Volume2 size={14} /> {STEM_LABELS[stem] ?? stem} → pad {selected + 1}
                </Button>
              ))}
            </div>
          )}

          <div style={row}>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reloadKit()}>
              Reload kit
            </Button>
            <Text size="xs" tone="muted">
              Kits are saved on this device; the sounds are fetched again when you come back.
            </Text>
          </div>
        </section>
      </div>
    </div>
  );
}
