import { Button, IconButton, PlayerBar, Text } from '@glacier/react';
import { ListMusic, Pause, Play } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SpinningDisc } from '../app/player/SpinningDisc.tsx';
import { CoverWall } from '../app/playlists/CoverWall.tsx';

export interface SharedTrackDoc {
  artist: string;
  title: string;
  album?: string;
  durationMs?: number | null;
}

export interface SharedPlaylistDoc {
  code: string;
  name: string;
  description: string;
  by: string;
  tracks: SharedTrackDoc[];
  covers: string[];
  url: string;
}

/**
 * A shared playlist, as a page: the card in the middle, the songs scrolling
 * inside it, and the app's own player at the bottom - GlacierUI's PlayerBar
 * with the swell seek the app's strip uses, its transport, its buttons.
 *
 * Previews are the catalogue's thirty-second clips: the registry answers
 * `/p/{code}/preview/{i}` with a redirect to one, or 404 when the catalogue
 * has none, and `/p/{code}/art/{i}` with the catalogue's cover for the row.
 * Nothing from any hub is served here; full songs play in AttackFM.
 */
export function PlaylistLanding({ share }: { share: SharedPlaylistDoc }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [none, setNone] = useState<Set<number>>(() => new Set());
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(30);
  const [art, setArt] = useState<string | null>(null);
  const scrubbing = useRef(false);
  const total = share.tracks.length;

  const stop = useCallback(() => {
    const a = audio.current;
    if (a) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    setCurrent(null);
    setPlaying(false);
    setPosition(0);
    setArt(null);
  }, []);

  const play = useCallback(
    (i: number) => {
      const a = audio.current;
      if (!a || none.has(i) || i < 0 || i >= total) return;
      if (current === i) {
        if (a.paused) void a.play();
        else a.pause();
        return;
      }
      stop();
      setCurrent(i);
      setBusy(i);
      // The cover, when the catalogue has one; the row reads without it.
      const img = new Image();
      img.onload = () => setArt((cur) => cur ?? img.src);
      img.src = `/p/${share.code}/art/${i}`;
      fetch(`/p/${share.code}/preview/${i}`, { method: 'HEAD' })
        .then((res) => {
          if (!res.ok) {
            setNone((s) => new Set(s).add(i));
            setBusy(null);
            setCurrent(null);
            return;
          }
          a.src = res.url;
          return a.play().then(() => setBusy(null));
        })
        .catch(() => {
          setBusy(null);
          setCurrent(null);
        });
    },
    [current, none, share.code, stop, total],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const a = audio.current;
      if (current === null) {
        if (total) play(0);
        return;
      }
      if (dir < 0 && a && a.currentTime > 3) {
        a.currentTime = 0;
        return;
      }
      let k = current + dir;
      while (k >= 0 && k < total && none.has(k)) k += dir;
      if (k >= 0 && k < total) play(k);
    },
    [current, none, play, total],
  );

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onTime = () => {
      if (!scrubbing.current) setPosition(a.currentTime);
    };
    const onDuration = () => setDuration(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 30);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setCurrent((cur) => {
        const next = cur === null ? null : cur + 1;
        if (next !== null && next < total) {
          window.setTimeout(() => play(next), 0);
          return cur;
        }
        window.setTimeout(stop, 0);
        return cur;
      });
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('durationchange', onDuration);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('durationchange', onDuration);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
    };
  }, [play, stop, total]);

  const count = total;

  // The wall behind the header: the app's own CoverWall, fed the covers the
  // link carries plus the catalogue's cover for every song (which 404s
  // quietly where there is none - a missing tile, not a broken wall).
  const wallArt = useMemo(
    () => [...share.covers, ...share.tracks.map((_, i) => `/p/${share.code}/art/${i}`)],
    [share],
  );

  return (
    <div className="stage">
      {share.covers[0] && <div className="backdrop" style={{ backgroundImage: `url(${share.covers[0]})` }} />}
      <main className="card">
        <div className="head">
          <CoverWall artworks={wallArt} />
          {share.covers.length > 0 ? (
            <div className="mosaic" data-n={Math.min(share.covers.length, 4)} aria-hidden>
              {share.covers.slice(0, 4).map((c, i) => (
                <img key={i} src={c} alt="" />
              ))}
            </div>
          ) : (
            <div className="mosaic mosaic--empty" aria-hidden>
              <ListMusic size={40} />
            </div>
          )}
          <h1>{share.name}</h1>
          <Text tone="muted" size="sm">
            {count} {count === 1 ? 'song' : 'songs'} · shared by @{share.by} on AttackFM
          </Text>
          {share.description && (
            <Text tone="muted" size="sm" className="desc">
              {share.description}
            </Text>
          )}
          <div className="actions">
            <Button variant="solid" onClick={() => (window.location.href = `attackfm://p/${share.code}`)}>
              Open in AttackFM
            </Button>
            <Button variant="outline" onClick={() => (window.location.href = 'https://attack.fm')}>
              Get the app
            </Button>
          </div>
        </div>

        <div className="list">
          <ol>
            {share.tracks.map((t, i) => {
              const on = current === i;
              const dead = none.has(i);
              return (
                <li
                  key={`${t.artist}|${t.title}|${i}`}
                  className="row"
                  data-on={on || undefined}
                  data-none={dead || undefined}
                  onClick={() => play(i)}
                >
                  <IconButton
                    variant={on ? 'solid' : 'ghost'}
                    size="md"
                    className="row__play"
                    aria-label={on && playing ? `Pause ${t.title}` : `Preview ${t.title}`}
                    aria-disabled={dead || undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      play(i);
                    }}
                  >
                    <span className="row__n">{i + 1}</span>
                    {on && playing ? (
                      <Pause size={18} fill="currentColor" className="row__glyph" />
                    ) : (
                      <Play size={18} fill="currentColor" className="row__glyph" />
                    )}
                  </IconButton>
                  <span className="row__t">{t.title}</span>
                  <span className="row__a">
                    {t.artist}
                    {busy === i ? ' · finding a preview…' : dead ? ' · no preview' : ''}
                  </span>
                </li>
              );
            })}
          </ol>
          <Text tone="muted" size="xs" className="foot">
            Thirty-second previews · full songs play in AttackFM
          </Text>
        </div>

        {/* The app's mini player: the spinning disc at the left (the app's
            own SpinningDisc - turning only while sound is coming out, spooling
            up while a clip loads), the kit's PlayerBar with the swell beside
            it. The bar folds its title at a card's width, as the phone strip
            does; the highlighted row says what is playing. */}
        <div className="now" data-idle={current === null || undefined}>
          <div className="now__disc">
            <SpinningDisc art={art} spinning={playing} spooling={busy !== null} />
          </div>
          <PlayerBar
            className="now__bar"
            density="compact"
            shape="swell"
          tone="accent"
          fill="solid"
          rail="contrast"
          duration={duration}
          value={position}
          onValueChange={(s) => {
            scrubbing.current = true;
            setPosition(s);
          }}
          onSeekEnd={(s) => {
            scrubbing.current = false;
            if (audio.current && current !== null) audio.current.currentTime = s;
          }}
          playing={playing}
          onPlayingChange={(on) => {
            if (current === null) {
              if (total) play(0);
              return;
            }
            if (on) void audio.current?.play();
            else audio.current?.pause();
          }}
            onSkipBack={() => step(-1)}
            onSkipForward={() => step(1)}
          />
        </div>
        <audio ref={audio} preload="none" />
      </main>
    </div>
  );
}
