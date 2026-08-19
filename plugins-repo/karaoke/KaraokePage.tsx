import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, SearchField, Text } from '@glacier/react';
import { Loader, Mic2, Pause, Play, RotateCcw, Search, X } from '@glacier/icons';
import { useServerSession } from '@attackfm/app/serverSession';
import { useLibrary } from '@attackfm/app/library';
import { lineAt, parseLyrics, type Line } from './lyrics.ts';

/**
 * Karaoke Maker.
 *
 * Three states, and the page is really just moving between them: find a song,
 * wait for the server to take it apart, then sing. The last one takes the
 * whole screen - words that big are the entire point, and the app's own
 * chrome is not something anyone reads mid-chorus.
 *
 * The audio is one ordinary <audio> element pointed at the server's mix
 * endpoint, which adds the non-vocal stems back together. That choice buys
 * seeking, cheap memory and the same behaviour as every other song in the
 * app; three buffers in the page would have bought none of it.
 */

interface Session {
  url: string;
  token: string;
  streamToken: string;
}

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 'var(--glacier-space-4)',
  maxWidth: 720,
};
const stage: CSSProperties = {
  position: 'fixed',
  inset: 0,
  // Above the app's own chrome, which tops out at 70 (header 70, nav 60,
  // player strip 56) - a stage underneath the header is not a stage.
  zIndex: 90,
  background: 'var(--glacier-bg)',
  display: 'flex',
  flexDirection: 'column',
  padding: `calc(env(safe-area-inset-top, 0px) + 12px) 16px calc(env(safe-area-inset-bottom, 0px) + 12px)`,
};
const lyricScroll: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 'clamp(10px, 2.4vmin, 22px)',
  // Half a screen of room top and bottom, so the line being sung can sit in
  // the middle rather than at the edge.
  padding: '38vh 0',
  scrollbarWidth: 'none',
  textAlign: 'center',
};
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12 };

export function KaraokePage() {
  const { session } = useServerSession();
  const { tracks } = useLibrary();

  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [jobState, setJobState] = useState<'none' | 'queued' | 'running' | 'done' | 'failed'>('none');
  const [error, setError] = useState<string | null>(null);
  const [singing, setSinging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef(new Map<number, HTMLParagraphElement>());

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const music = tracks.filter((t) => t.path.startsWith('afm://'));
    if (!q) return music.slice(0, 40);
    return music
      .filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [query, tracks]);

  const track = useMemo(
    () => (picked === null ? null : tracks.find((t) => t.path === `afm://${picked}`) ?? null),
    [picked, tracks],
  );
  const lyrics = useMemo(() => parseLyrics(track?.lyrics ?? ''), [track]);
  const current = lyrics.timed ? lineAt(lyrics.lines, position) : -1;

  /* ── asking the server to take the song apart ────────────────────────── */

  const convert = async (trackId: number) => {
    if (!session) return;
    setError(null);
    setPicked(trackId);
    setJobState('queued');
    try {
      const res = await fetch(`${session.url}/api/stems/${trackId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${(session as Session).token}` },
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `${res.status}`));
      const body = (await res.json()) as { state: string };
      setJobState(body.state as typeof jobState);
    } catch (e) {
      setJobState('failed');
      setError(e instanceof Error && e.message ? e.message : 'Could not reach the server.');
    }
  };

  // Watch the separation, and stop watching the moment it settles - an open
  // page should not be a permanent request loop.
  useEffect(() => {
    if (!session || picked === null) return;
    if (jobState !== 'queued' && jobState !== 'running') return;
    let live = true;
    const check = async () => {
      try {
        const res = await fetch(`${session.url}/api/stems/${picked}`, {
          headers: { authorization: `Bearer ${(session as Session).token}` },
        });
        if (!res.ok || !live) return;
        const body = (await res.json()) as {
          state: string;
          error?: string;
          stems?: { stem: string }[];
        };
        if (!live) return;
        setJobState(body.state as typeof jobState);
        if (body.state === 'failed') setError(body.error || 'That song could not be separated.');
      } catch {
        // A blip is not a failure; the next tick asks again.
      }
    };
    void check();
    const timer = window.setInterval(check, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, picked, jobState]);

  /* ── the performance ─────────────────────────────────────────────────── */

  const mixUrl = useMemo(() => {
    if (!session || picked === null) return null;
    const s = session as Session;
    // The token rides in the query because an <audio> element sends no
    // headers of ours - the same door the rest of the audio uses.
    return `${s.url}/api/stems/${picked}/mix?drop=vocals&t=${encodeURIComponent(s.streamToken)}`;
  }, [session, picked]);

  const start = () => {
    setSinging(true);
    // The element is mounted by the stage below; play on the next frame, once
    // it exists and has its source.
    window.setTimeout(() => {
      const el = audioRef.current;
      if (!el) return;
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }, 60);
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

  const restart = () => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    setPosition(0);
    void el.play().then(() => setPlaying(true)).catch(() => {});
  };

  // Keep the sung line in the middle of the screen. Only when it CHANGES, so
  // a person scrolling back to read ahead is not dragged forward every frame.
  useEffect(() => {
    if (!singing || current < 0) return;
    const el = lineRefs.current.get(current);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [current, singing]);

  const seek = (to: number) => {
    const el = audioRef.current;
    if (!el) return;
    // A live encode has no addressable end, so the server takes the seek as a
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

  const time = (s: number) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  /* ── the stage ───────────────────────────────────────────────────────── */

  if (singing && mixUrl && track) {
    return (
      <div style={stage}>
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

        <div style={{ ...row, justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <Text weight="bold" size="sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {track.title}
            </Text>
            <Text tone="muted" size="xs">{track.artist} · no vocal</Text>
          </div>
          <Button size="sm" variant="ghost" aria-label="Leave karaoke" onClick={() => {
            audioRef.current?.pause();
            setSinging(false);
            setPlaying(false);
          }}>
            <X size={16} />
          </Button>
        </div>

        <div ref={scrollRef} style={lyricScroll}>
          {lyrics.lines.length === 0 ? (
            <Text tone="muted">
              This song has no lyrics saved, so it is just the instrumental — which is still
              the hard part.
            </Text>
          ) : (
            lyrics.lines.map((line: Line, i: number) => {
              const state = i === current ? 'now' : i < current ? 'past' : 'next';
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
                    // The sung line is the page; everything else is context.
                    fontSize: state === 'now' ? 'clamp(26px, 6.4vmin, 46px)' : 'clamp(17px, 3.6vmin, 26px)',
                    lineHeight: 1.22,
                    fontWeight: state === 'now' ? 700 : 500,
                    color:
                      state === 'now'
                        ? 'var(--glacier-text)'
                        : state === 'past'
                          ? 'var(--glacier-text-muted)'
                          : 'var(--glacier-text-subtle)',
                    opacity: state === 'next' ? 0.55 : 1,
                    transition: 'font-size 180ms ease, color 180ms ease, opacity 180ms ease',
                    textWrap: 'balance',
                  }}
                >
                  {line.text || ' '}
                </p>
              );
            })
          )}
        </div>

        {/* Transport */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="range"
            aria-label="Position"
            min={0}
            max={Math.max(1, duration || track.duration || 1)}
            step={0.5}
            value={Math.min(position, duration || track.duration || 1)}
            onChange={(e) => seek(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--glacier-accent-9)' }}
          />
          <div style={{ ...row, justifyContent: 'space-between' }}>
            <Text size="xs" tone="muted" mono>{time(position)}</Text>
            <div style={row}>
              <Button size="sm" variant="ghost" aria-label="Start again" onClick={restart}>
                <RotateCcw size={16} />
              </Button>
              <Button size="md" variant="solid" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </Button>
            </div>
            <Text size="xs" tone="muted" mono>{time(duration || track.duration || 0)}</Text>
          </div>
        </div>
      </div>
    );
  }

  /* ── finding a song ──────────────────────────────────────────────────── */

  return (
    <div className="homePage">
      <div style={wrap}>
        <header style={row}>
          <Mic2 size={22} aria-hidden />
          <div style={{ flex: 1 }}>
            <Text weight="bold" size="lg">Karaoke Maker</Text>
            <Text tone="muted" size="sm">
              Pick a song and your server lifts the singer out of it.
            </Text>
          </div>
        </header>

        {!session && (
          <Text tone="muted" size="sm">
            Separating a song happens on your server — sign in to one to make karaoke.
          </Text>
        )}

        <SearchField
          aria-label="Find a song"
          placeholder="Find a song to sing"
          value={query}
          onValueChange={setQuery}
        />

        {picked !== null && jobState !== 'done' && (
          <div style={{ ...row, gap: 8 }}>
            {jobState === 'failed' ? (
              <Text size="sm" tone="muted">{error ?? 'That one could not be separated.'}</Text>
            ) : (
              <>
                <Loader size={15} />
                <Text size="sm" tone="muted">
                  Taking {track?.title ?? 'the song'} apart — about half a minute, and only ever once.
                </Text>
              </>
            )}
          </div>
        )}

        {picked !== null && jobState === 'done' && track && (
          <div style={{ ...row, gap: 10, flexWrap: 'wrap' }}>
            <Button variant="solid" onClick={start}>
              <Mic2 size={15} /> Sing {track.title}
            </Button>
            <Text size="xs" tone="muted">
              {lyrics.timed
                ? `${lyrics.lines.length} lines, in time with the music`
                : lyrics.lines.length > 0
                  ? 'Lyrics found, but without timings — they will not follow along'
                  : 'No lyrics saved for this one; it plays as an instrumental'}
            </Text>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {results.length === 0 && (
            <Text tone="muted" size="sm">Nothing here matches that.</Text>
          )}
          {results.map((t) => {
            const id = Number(t.path.replace('afm://', ''));
            if (!Number.isFinite(id)) return null;
            const hasLyrics = Boolean(t.lyrics && t.lyrics.trim());
            return (
              <button
                key={t.path}
                type="button"
                onClick={() => void convert(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                  padding: '9px 10px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid transparent',
                  background: picked === id ? 'var(--glacier-bg-surface)' : 'transparent',
                  color: 'var(--glacier-text)',
                }}
              >
                <Search size={14} aria-hidden style={{ opacity: 0.5, flex: 'none' }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.title}
                  </Text>
                  <Text size="xs" tone="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.artist}
                  </Text>
                </span>
                {hasLyrics && <Text size="xs" tone="muted">words</Text>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
