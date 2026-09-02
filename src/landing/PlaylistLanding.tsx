import {
  Button,
  IconButton,
  Text,
  createAnalyserMeter,
  useBeat,
  type AnalyserMeter,
  type LoudnessMeter,
  type PlayerRepeat,
} from '@glacier/react';
import { ListMusic, Pause, Play } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoverWall } from '../app/playlists/CoverWall.tsx';
import { PlayerStrip } from '../app/player/PlayerStrip.tsx';
import { SpinningDisc } from '../app/player/SpinningDisc.tsx';
import { StaticConnectProvider } from '../app/player/playbackSync.tsx';
import { NowPlayingMotionProvider } from '../app/player/nowPlayingMotion.tsx';
import { PlaybackProvider } from '../app/player/playback.tsx';
import { EqualizerProvider } from '../app/player/equalizer.tsx';
import { useArtTint } from '../app/player/artTint.ts';
import { PluginsContext, type PluginsContextValue } from '../plugins/pluginsContext.ts';
import type { Track } from '../app/core/tauri.ts';

/** The strip's plugin slots, with no plugins: nothing to draw. */
const NO_PLUGINS: PluginsContextValue = {
  all: [],
  enabled: [],
  enabledKey: '',
  isEnabled: () => false,
  setEnabled: () => {},
  failures: new Map(),
  reportCrash: () => {},
  remoteInstalled: new Map(),
  reloadRemote: () => {},
};

const noop = () => {};

/** The sample rate the app's scrub engine folds a tape to (player/scrubTape). */
const TAPE_RATE = 22050;

/**
 * The clip as a tape for the scratch engine: the bytes, decoded at the tape
 * rate, folded to mono - the fold the app's loadScrubTape does for a whole
 * song, here for a thirty-second preview the catalogue serves with CORS open
 * (which is also what lets the element feed the audio graph at all).
 */
async function loadPreviewTape(
  url: string,
): Promise<{ pcm: Float32Array; rate: number; duration: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, TAPE_RATE);
    const decoded = await ctx.decodeAudioData(bytes);
    const frames = decoded.length;
    const pcm = new Float32Array(frames);
    pcm.set(decoded.getChannelData(0));
    for (let ch = 1; ch < decoded.numberOfChannels; ch += 1) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < frames; i += 1) pcm[i]! += data[i]!;
    }
    if (decoded.numberOfChannels > 1) {
      const scale = 1 / decoded.numberOfChannels;
      for (let i = 0; i < frames; i += 1) pcm[i]! *= scale;
    }
    return { pcm, rate: decoded.sampleRate, duration: decoded.duration };
  } catch {
    return null;
  }
}

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
 * inside it, and the app's own player strip at the bottom - the very
 * component the desktop and phone dock at their foot (player/PlayerStrip),
 * fed by this page's preview audio.
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

  // The audio graph the app builds on its own deck - the kit's analyser:
  // the loudness meter the strip's waveform and the disc's beat read, and
  // the scratch engine the platter plays. Built on the first play, which is
  // a gesture, which is what an AudioContext needs to start.
  const analyser = useRef<AnalyserMeter | null>(null);
  const [meter, setMeter] = useState<LoudnessMeter | null>(null);
  const tapeFor = useRef<number | null>(null);
  // A scratch in progress, in the Player's own terms (player/Player.tsx
  // onScratchBegin / onScratch / onScratchEnd), cut down to one element.
  const scratchLive = useRef(false);
  const scratchHeld = useRef(false);
  const scratchRolling = useRef(false);
  const scratchAnchor = useRef(0);
  const scratchTarget = useRef(0);
  const scratchPos = useRef(0);
  const lastScratchWrite = useRef(0);

  const ensureGraph = useCallback(() => {
    const a = audio.current;
    if (!a || analyser.current) return;
    try {
      const built = createAnalyserMeter(a);
      analyser.current = built;
      const read = built.meter;
      // The function itself: a bare setState(fn) reads as an updater.
      setMeter(() => read);
      void built.resume();
    } catch {
      analyser.current = null;
    }
  }, []);

  // The strip's own state that a page has to hold for it. The phone face,
  // always: the card is phone-sized whatever window it sits in, and the
  // phone strip is the one with the disc.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<PlayerRepeat>('off');
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const stop = useCallback(() => {
    const a = audio.current;
    if (a) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    analyser.current?.scrub.eject();
    tapeFor.current = null;
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
      ensureGraph();
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
          // The clip as the engine's tape, so a scratch runs the music under
          // the hand rather than only jogging the element. Fetched once per
          // clip; a change of song before it lands throws it away.
          tapeFor.current = i;
          void loadPreviewTape(res.url).then((tape) => {
            if (tape && tapeFor.current === i)
              analyser.current?.scrub.load(tape.pcm, tape.rate, tape.duration);
          });
          return a.play().then(() => setBusy(null));
        })
        .catch(() => {
          setBusy(null);
          setCurrent(null);
        });
    },
    [current, ensureGraph, none, share.code, stop, total],
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
    // A hand on the record pauses the element for the hold, and that stop is
    // the scratch's, not a person's: playing intent survives it.
    const onPause = () => {
      if (!scratchHeld.current) setPlaying(false);
    };
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
  const audible = playing && !muted && volume > 0;
  const progress = duration > 0 ? position / duration : 0;
  // The live beat, off the graph's meter: the disc wears it when there is no
  // cover, the strip's waveform always.
  const beat = useBeat({ meter, active: audible, at: progress });

  const clampPos = (p: number) => Math.max(0, duration > 0 ? Math.min(duration, p) : p);

  /** The hand lands on the platter: freeze the clip under it and hand the
   *  engine the spot, when the engine is up; else a plain jog. */
  const onScratchBegin = () => {
    const a = audio.current;
    if (!a || current === null || scrubbing.current) return;
    scrubbing.current = true;
    scratchPos.current = a.currentTime;
    const scrub = analyser.current?.scrub;
    const live = !!scrub && scrub.ready();
    scratchLive.current = live;
    if (!live || !scrub) return;
    scratchAnchor.current = scratchPos.current;
    scratchTarget.current = 0;
    scratchRolling.current = !a.paused;
    scrub.hold(scratchAnchor.current);
    if (!a.paused) {
      scratchHeld.current = true;
      a.pause();
    }
  };

  const onScratch = (deltaSeconds: number) => {
    const a = audio.current;
    if (!a || current === null) return;
    if (!scrubbing.current) {
      scratchPos.current = a.currentTime;
      scrubbing.current = true;
      scratchLive.current = false;
    }
    if (scratchLive.current) {
      const scrub = analyser.current?.scrub;
      scratchTarget.current = Math.max(
        -scratchAnchor.current,
        Math.min(
          duration > 0 ? duration - scratchAnchor.current : Number.POSITIVE_INFINITY,
          scratchTarget.current + deltaSeconds,
        ),
      );
      scrub?.move(scratchTarget.current);
      // The bar follows what is heard - the head, which lags the hand by the
      // engine's spring - except forward of the grab before the tape lands,
      // where the hand's own position carries a silent jog.
      const head = scrub ? scrub.offset() : scratchTarget.current;
      const shown = scratchTarget.current > 0 && !scrub?.loaded() ? scratchTarget.current : head;
      scratchPos.current = clampPos(scratchAnchor.current + shown);
      setPosition(scratchPos.current);
      return;
    }
    // No engine: the seek-preview jog, twelve writes a second at most.
    scratchPos.current = clampPos(scratchPos.current + deltaSeconds);
    setPosition(scratchPos.current);
    const now = performance.now();
    if (now - lastScratchWrite.current < 80) return;
    lastScratchWrite.current = now;
    try {
      a.currentTime = scratchPos.current;
    } catch {
      // A source mid-load refuses the write; the next move tries again.
    }
  };

  /** The hand comes off: land where the head settled, and put the music
   *  back the way the hand found it. */
  const onScratchEnd = () => {
    const a = audio.current;
    if (!a || !scrubbing.current) return;
    scrubbing.current = false;
    if (!scratchLive.current) {
      a.currentTime = scratchPos.current;
      setPosition(scratchPos.current);
      return;
    }
    scratchLive.current = false;
    const scrub = analyser.current?.scrub;
    const settled = scrub ? scrub.release() : 0;
    const offset = scratchTarget.current > 0 && !scrub?.loaded() ? scratchTarget.current : settled;
    const to = clampPos(scratchAnchor.current + offset);
    // The ring maps offsets onto the element's timeline and the jump breaks
    // that map: the engine forgets across a seek, as it does in the app.
    scrub?.clear();
    scratchHeld.current = false;
    if (Math.abs(to - scratchAnchor.current) > 0.15) a.currentTime = to;
    setPosition(to);
    if (scratchRolling.current) {
      scratchRolling.current = false;
      void a.play().catch(() => setPlaying(false));
    }
  };

  // The playing song as the strip understands one - a Track. The path is a
  // scheme of this page's own; nothing resolves it, the strip only labels
  // and keys by it.
  const nowTrack = useMemo<Track | null>(() => {
    if (current === null) return null;
    const t = share.tracks[current];
    if (!t) return null;
    return {
      path: `preview://${share.code}/${current}`,
      title: t.title,
      artist: t.artist,
      album: t.album ?? '',
      duration: duration,
      addedAt: 0,
      artwork: art,
      genre: '',
      lyrics: '',
    } as Track;
  }, [current, share, duration, art]);

  const setVolumeState = useCallback((next: number) => {
    setVolume(next);
    if (audio.current) audio.current.volume = Math.max(0, Math.min(1, next));
  }, []);
  const setMutedState = useCallback((next: boolean) => {
    setMuted(next);
    if (audio.current) audio.current.muted = next;
  }, []);

  // The wall behind the PAGE: the app's own CoverWall, fed the covers the
  // link carries plus the catalogue's cover for every song (which 404s
  // quietly where there is none - a missing tile, not a broken wall).
  const wallArt = useMemo(
    () => [...share.covers, ...share.tracks.map((_, i) => `/p/${share.code}/art/${i}`)],
    [share],
  );

  // The song's colour, the app's way: artTint reads the cover and hands back
  // the accent ramp as CSS variables, which the app sets on the document so
  // every accent - the seek, the buttons, the plate - takes the song's hue.
  // The card's header wears it as a steady band. Nothing playing: the kit's
  // own accent, as the app before its first song.
  const tint = useArtTint(art, true);
  useEffect(() => {
    if (!tint) return undefined;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(tint)) root.style.setProperty(k, v);
    root.setAttribute('data-song-tint', '');
    return () => {
      for (const k of Object.keys(tint)) root.style.removeProperty(k);
      root.removeAttribute('data-song-tint');
    };
  }, [tint]);

  return (
    <div className="stage">
      <div className="wallBackdrop" aria-hidden>
        <CoverWall artworks={wallArt} loading="eager" />
      </div>
      <main className="card">
        <div className="head" data-tinted={tint ? '' : undefined}>
          {/* The platter: the app's own turntable (player/SpinningDisc) - a
              hand on it holds the clip, a turn runs the engine's tape under
              it - crossfaded with the playlist's picture: the picture while
              nothing plays, the record while something does. */}
          <div className="platter" data-live={playing || undefined}>
            <div className="platter__cover" aria-hidden>
              {share.covers.length > 0 ? (
                <div className="mosaic" data-n={Math.min(share.covers.length, 4)}>
                  {share.covers.slice(0, 4).map((c, i) => (
                    <img key={i} src={c} alt="" />
                  ))}
                </div>
              ) : (
                <div className="mosaic mosaic--empty">
                  <ListMusic size={40} />
                </div>
              )}
            </div>
            <div className="platter__disc">
              <SpinningDisc
                art={art}
                spinning={audible}
                spooling={busy !== null}
                beat={beat}
                onScratchStart={onScratchBegin}
                onScratch={onScratch}
                onScratchEnd={onScratchEnd}
              />
            </div>
          </div>
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

        {/* The app's player strip - the very component the desktop and the
            phone dock at their foot (player/PlayerStrip), in the app's own
            .appPlayer plate, fed by this page's preview audio instead of the
            app's decks. Connect and plugins are stubbed: there is no hub to
            sync with and nothing to slot in. */}
        <StaticConnectProvider>
          <PluginsContext.Provider value={NO_PLUGINS}>
           <PlaybackProvider>
           <EqualizerProvider>
           <NowPlayingMotionProvider>
            <div className="appPlayer">
              <PlayerStrip
                shellRef={shellRef}
                dismissed={false}
                mobileControls
                openNowPlaying={noop}
                listLoading={false}
                npArtMenu={null}
                artView="cd"
                track={nowTrack}
                artwork={art}
                dispArtwork={art}
                activeElsewhere={false}
                activeDeviceName={null}
                dispTrack={nowTrack}
                dispDuration={duration}
                dispPosition={position}
                dispPlaying={playing}
                audible={audible}
                buffering={busy !== null}
                downloading={false}
                meter={meter}
                progress={progress}
                pauseStyle="instant"
                onScrubDisp={(to) => {
                  scrubbing.current = true;
                  setPosition(to);
                }}
                onSeekEndDisp={(s) => {
                  scrubbing.current = false;
                  analyser.current?.scrub.clear();
                  if (audio.current && current !== null) audio.current.currentTime = s;
                }}
                onPlayingChangeDisp={(on) => {
                  if (current === null) {
                    if (total) play(0);
                    return;
                  }
                  if (on) void audio.current?.play();
                  else audio.current?.pause();
                }}
                onSkipBackDisp={() => step(-1)}
                onSkipForwardDisp={() => step(1)}
                shuffle={shuffle}
                setShuffle={setShuffle}
                repeat={repeat}
                setRepeat={setRepeat}
                favorite={false}
                toggleFavoriteFelt={noop}
                position={position}
                commitSeek={(to) => {
                  analyser.current?.scrub.clear();
                  if (audio.current && current !== null) audio.current.currentTime = to;
                }}
                volume={volume}
                muted={muted}
                systemVolume={volume}
                setVolumeState={setVolumeState}
                setMutedState={setMutedState}
                setNpQueue={noop}
                setNpOpen={noop}
                setFiling={noop}
              />
            </div>
           </NowPlayingMotionProvider>
           </EqualizerProvider>
           </PlaybackProvider>
          </PluginsContext.Provider>
        </StaticConnectProvider>
        {/* crossOrigin: the catalogue's clips come with CORS open, and the
            audio graph (meter, scratch engine) can only listen to an
            element whose bytes it is allowed to see. */}
        <audio ref={audio} preload="none" crossOrigin="anonymous" />
      </main>
    </div>
  );
}
