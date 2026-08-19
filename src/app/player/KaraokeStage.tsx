import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { createAnalyserMeter, IconButton, SeekBar, Text, useBeat, useLiveLevels } from '@glacier/react';
import type { LoudnessMeter } from '@glacier/react';
import { Loader, Pause, Play, RotateCcw, X } from '@glacier/icons';
import { useServerSession } from '@attackfm/app/serverSession';
import { lineAt, parseLyrics, type Line } from './lyrics.ts';

/**
 * The karaoke stage: one song, its words, and no app around it.
 *
 * Rendered through a PORTAL onto document.body rather than inside the Now
 * Playing sheet. Singing is a full-screen thing - the navigation bar, the
 * player strip and the sheet's own chrome are all noise when the point is a
 * room full of people reading one line at a time - and a portal is how this
 * escapes a stacking context it does not control rather than trying to out-
 * z-index it.
 */

interface Track {
  path: string;
  title: string;
  artist: string;
  duration: number | null;
  lyrics?: string | null;
}

interface Session {
  url: string;
  token: string;
  streamToken: string;
}

/** `afm://123` or `afm://123@origin` - the id is what the stems API wants. */
function trackId(path: string): number | null {
  if (!path.startsWith('afm://')) return null;
  const body = path.slice('afm://'.length);
  const at = body.indexOf('@');
  const id = Number(at === -1 ? body : body.slice(0, at));
  return Number.isFinite(id) ? id : null;
}

const stage: CSSProperties = {
  position: 'fixed',
  inset: 0,
  // Above the navigation bar and the player strip, both of which this replaces
  // for as long as it is up.
  zIndex: 3000,
  background: 'var(--glacier-bg)',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))',
};

const lyricScroll: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  justifyContent: 'center',
  textAlign: 'center',
  padding: '8px 4px',
};

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };

export function KaraokeStage({ track, onClose }: { track: Track; onClose: () => void }) {
  const { session } = useServerSession();
  const id = trackId(track.path);

  const [state, setState] = useState<'checking' | 'making' | 'ready' | 'failed'>('checking');
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(track.duration ?? 0);
  const audioRef = useRef<HTMLAudioElement>(null);
  /**
   * The stage's own loudness meter.
   *
   * The bar on Now Playing deforms because it is fed levels and a beat from the
   * deck's analyser. This audio is a DIFFERENT element - a separate mix, from a
   * separate request - so it needs its own, or the bar would be the right
   * component sitting perfectly still while a song plays through it.
   */
  const [meter, setMeter] = useState<LoudnessMeter | null>(null);
  const meterRef = useRef<LoudnessMeter | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef(new Map<number, HTMLParagraphElement>());

  const mixUrl = useMemo(() => {
    if (!session || id === null) return null;
    const s = session as Session;
    // The token rides in the query because an <audio> element sends none of our
    // headers - the same door the rest of the audio uses.
    return `${s.url}/api/stems/${id}/mix?drop=vocals&t=${encodeURIComponent(s.streamToken)}`;
  }, [session, id]);

  /** Ask the server to separate this song, and wait for it if it has not. */
  useEffect(() => {
    if (!session || id === null) return;
    const s = session as Session;
    let live = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const res = await fetch(`${s.url}/api/stems/${id}`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { state?: string; stems?: { stem: string }[] };
        if (!live) return;
        if (body.state === 'done' || (body.stems?.length ?? 0) > 0) {
          setState('ready');
          return;
        }
        if (body.state === 'failed') {
          setState('failed');
          return;
        }
        // Separation is minutes of work the first time and instant afterwards,
        // because the result is kept.
        setState('making');
        timer = window.setTimeout(() => void poll(), 2500);
      } catch {
        if (live) setState('failed');
      }
    };

    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [session, id]);

  /** Start as soon as the mix exists - you pressed a microphone, not "prepare". */
  useEffect(() => {
    if (state !== 'ready') return;
    const el = audioRef.current;
    if (!el) return;
    void el.play().then(() => setPlaying(true)).catch(() => {
      // Autoplay refused: the transport below is still there.
    });
  }, [state]);

  /** Build the analyser once the element exists, and let it out of suspend. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el || meterRef.current) return;
    try {
      meterRef.current = createAnalyserMeter(el);
      setMeter(meterRef.current);
      void meterRef.current.resume();
    } catch {
      // No audio graph available: the bar stays still, everything else works.
    }
  }, [state]);

  const lyrics = useMemo(() => parseLyrics(track.lyrics ?? ''), [track.lyrics]);
  const current = useMemo(() => lineAt(lyrics.lines, position), [lyrics.lines, position]);

  /** Keep the line being sung in the middle of the screen. */
  useEffect(() => {
    const el = lineRefs.current.get(current);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [current]);

  /** Escape leaves, the way it does everywhere else that fills the screen. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const seek = (to: number) => {
    const el = audioRef.current;
    if (!el) return;
    // A live encode has no addressable end, so the server takes a seek as a
    // fresh request rather than a range - which means reloading the source.
    if (!Number.isFinite(el.duration) || el.duration === 0) {
      if (mixUrl) {
        el.src = `${mixUrl}&seek=${to.toFixed(2)}`;
        void el.play().then(() => setPlaying(true)).catch(() => {});
      }
      setPosition(to);
      return;
    }
    el.currentTime = to;
    setPosition(to);
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().then(() => setPlaying(true)).catch(() => {});
    else {
      el.pause();
      setPlaying(false);
    }
  };

  const clock = (s: number) => {
    if (!Number.isFinite(s)) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  const total = Math.max(1, duration || track.duration || 1);
  // progress is the 0-1 fraction these hooks want, not seconds.
  const progress = total > 0 ? Math.min(position, total) / total : 0;
  const beat = useBeat({ meter, active: playing, at: progress });
  const levels = useLiveLevels({ meter, progress, active: playing });

  return createPortal(
    <div style={stage} role="dialog" aria-label="Karaoke" data-theme="dark">
      {mixUrl && (
        <audio
          ref={audioRef}
          src={mixUrl}
          preload="auto"
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
          onEnded={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      )}

      <div style={{ ...row, justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <Text weight="bold" size="sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {track.title}
          </Text>
          <Text tone="muted" size="xs">
            {track.artist} · no vocal
          </Text>
        </div>
        <IconButton variant="ghost" aria-label="Leave karaoke" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>

      <div ref={scrollRef} style={lyricScroll}>
        {state === 'making' && (
          <Text tone="muted">
            Taking the singer out. This happens once per song, and is instant every time after.
          </Text>
        )}
        {state === 'failed' && (
          <Text tone="muted">
            This song could not be separated. Your server needs the stems tools installed.
          </Text>
        )}
        {state === 'ready' && lyrics.lines.length === 0 && (
          <Text tone="muted">
            No words saved for this one, so it is just the instrumental — which is still the
            hard part.
          </Text>
        )}
        {state === 'ready' &&
          lyrics.lines.map((line: Line, i: number) => {
            const where = i === current ? 'now' : i < current ? 'past' : 'next';
            return (
              <p
                key={`${i}:${line.at}`}
                ref={(el) => {
                  if (el) lineRefs.current.set(i, el);
                  else lineRefs.current.delete(i);
                }}
                onClick={() => Number.isFinite(line.at) && seek(Math.max(0, line.at - 0.15))}
                style={{
                  margin: 0,
                  cursor: Number.isFinite(line.at) ? 'pointer' : 'default',
                  // The line being sung is the page; the rest is context.
                  fontSize: where === 'now' ? 'clamp(28px, 7vmin, 54px)' : 'clamp(17px, 3.6vmin, 26px)',
                  lineHeight: 1.2,
                  fontWeight: where === 'now' ? 700 : 500,
                  color:
                    where === 'now'
                      ? 'var(--glacier-text)'
                      : where === 'past'
                        ? 'var(--glacier-text-muted)'
                        : 'var(--glacier-text-subtle)',
                  opacity: where === 'next' ? 0.55 : 1,
                  transition: 'font-size 180ms ease, color 180ms ease, opacity 180ms ease',
                  textWrap: 'balance',
                }}
              >
                {line.text || ' '}
              </p>
            );
          })}
      </div>

      {/* The kit's live bar, the same one Now Playing wears, rather than a
          range input. It is the surface's focus here as much as there, so it
          gets the same swell and a high intensity - a karaoke room reads the
          bar from across it. */}
      <SeekBar
        duration={total}
        value={Math.min(position, total)}
        aria-label="Seek"
        shape="swell"
        tone="accent"
        fill="solid"
        rail="contrast"
        levels={levels}
        beat={beat}
        tracer
        intensity={2.4}
        onValueChange={(v: number) => setPosition(v)}
        onSeekEnd={(v: number) => seek(v)}
      />

      <div style={{ ...row, justifyContent: 'space-between' }}>
        <Text size="xs" tone="muted" mono>
          {clock(position)}
        </Text>
        <div style={row}>
          <IconButton variant="ghost" aria-label="Start again" onClick={() => seek(0)}>
            <RotateCcw size={18} />
          </IconButton>
          <IconButton
            variant="solid"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={toggle}
            disabled={state !== 'ready'}
          >
            {state === 'making' ? <Loader size={18} /> : playing ? <Pause size={18} /> : <Play size={18} />}
          </IconButton>
        </div>
        <Text size="xs" tone="muted" mono>
          -{clock(Math.max(0, total - position))}
        </Text>
      </div>
    </div>,
    document.body,
  );
}
