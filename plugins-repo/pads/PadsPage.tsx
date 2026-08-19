import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Button, IconButton, Input, Text } from '@glacier/react';
import { AudioWaveform, Loader, Pause, Play, Search, Wand2, X } from '@glacier/icons';
import { useServerSession } from '@attackfm/app/serverSession';
import { useLibrary } from '@attackfm/app/library';
import { useNowPlayingMotion } from '@attackfm/app/nowPlaying';
import { deck, STEM_HUES, STEM_LABELS } from './engine.ts';
import { clock, putOnDeck, trackId, type Preparing, type Session, type Song } from './openSong.ts';
import { PreparingView } from './Preparing.tsx';
import { meterFill, padFace, seekRail, STEM_ICONS } from './padStyles.ts';
import { claimOutput, returnOutput, useBoard } from './usePads.ts';

/**
 * The board.
 *
 * One screen, and it does not move: somewhere to find a song, a button that
 * puts it on the pads, and the pads. The version before this was a page you
 * scrolled - a grid, then the selected pad's eight controls, then a song
 * picker, then the list of parts the separator had produced, then a note about
 * kits. Every one of those was a reasonable thing to show, and together they
 * made an instrument you had to read.
 *
 * What replaced them is the deck (see engine.ts): the song plays, and a pad
 * decides whether you hear that part of it. That removed most of the controls
 * rather than hiding them - trim, pitch, reverse and choke are things you do to
 * a sample you are firing, and nothing here is fired any more. The parts are
 * locked to each other and to the song.
 */

/** Nine, because six parts want a square and a square wants nine. The last
 *  three sit empty on today's separator and are where a richer one lands. */
const SLOT_COUNT = 9;

/**
 * The page fills its column and never scrolls.
 *
 * Deliberately NOT `.homePage`, which is the app's standard scroller: an
 * instrument that moves under your thumb while you are playing it is not an
 * instrument. The bottom inset is the player strip and the nav bar, which sit
 * over this column rather than beside it - without it the bottom row of pads
 * lives under the transport.
 */
const shell: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 'var(--glacier-space-4)',
  paddingBottom:
    'calc(var(--app-player-height, 0px) + var(--app-nav-height, 0px) + var(--glacier-space-3))',
  overflow: 'hidden',
  position: 'relative',
};

const topRow: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

/** Hung off the search row itself, so it lands under the box whatever height
 *  the control turns out to be. The page does not scroll; this does. */
const results: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  zIndex: 5,
  background: 'var(--glacier-surface)',
  border: '1px solid var(--glacier-border)',
  borderRadius: 10,
  boxShadow: 'var(--glacier-shadow-3, 0 18px 40px -18px rgb(0 0 0 / 0.55))',
  maxHeight: 300,
  overflowY: 'auto',
  padding: 4,
};

const hit: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 0,
  color: 'var(--glacier-text)',
  padding: '8px 10px',
  borderRadius: 7,
  cursor: 'pointer',
};

const boardWrap: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  justifyContent: 'center',
};

const board: CSSProperties = {
  flex: 1,
  minHeight: 0,
  maxWidth: 820,
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gridTemplateRows: 'repeat(3, 1fr)',
  gap: 8,
  touchAction: 'none',
};

/** What is on the deck, kept beside the deck rather than in the component: the
 *  deck outlives this page, so the labels describing it have to as well, or
 *  coming back shows a board playing a song it cannot name. */
let loadedSong: Song | null = null;

export function PadsPage() {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const { track: nowPlaying, position: nowAt } = useNowPlayingMotion();

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [song, setSong] = useState<Song | null>(loadedSong);
  const [progress, setProgress] = useState<Preparing | null>(null);
  const [note, setNote] = useState('');

  const total = song?.duration || deck.duration || 1;
  const cast = useBoard(total);

  const music = useMemo(
    () => tracks.filter((t) => t.kind !== 'book' && trackId(t.path) !== null),
    [tracks],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return music
      .filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q),
      )
      .slice(0, 40);
  }, [music, query]);

  /** The parts on the deck, in board order, padded out to a full grid. */
  const slots = useMemo(
    () => Array.from({ length: SLOT_COUNT }, (_, i) => cast.stems[i] ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the deck's list is not React state; revision is how it announces a change
    [cast.revision],
  );

  const say = useCallback((text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? '' : n)), 4000);
  }, []);

  const asSong = useCallback(
    (t: { path: string; title: string; artist: string; duration: number | null }): Song | null => {
      const id = trackId(t.path);
      if (id === null) return null;
      return { id, title: t.title, artist: t.artist, duration: t.duration ?? 0 };
    },
    [],
  );

  const load = useCallback(
    async (target: Song, from: number) => {
      if (!session) return;
      setProgress({ phase: 'asking', fraction: null, filed: 0, parts: 6 });
      setSong(target);
      loadedSong = target;
      claimOutput();
      cast.refresh();
      const outcome = await putOnDeck(session as Session, target, from, setProgress);
      if (outcome.superseded) return;
      setProgress(null);
      if (!outcome.ok) {
        say(outcome.problem ?? 'That did not work.');
        return;
      }
      cast.refresh();
    },
    [session, say, cast],
  );

  /** Where in the song to pick it up. */
  const startingPoint = useCallback(
    (target: Song): number => {
      // The song already playing, at the point you are listening to: you heard
      // the bit you want, and this hands it straight over mid-phrase - which is
      // the whole difference between taking over from the player and starting
      // the song again. Anything else opens at the top, like a song should.
      const playingId = nowPlaying ? trackId(nowPlaying.path) : null;
      return playingId === target.id && nowAt > 5 ? nowAt : 0;
    },
    [nowPlaying, nowAt],
  );

  /**
   * The Map button.
   *
   * Takes the top match when a search is running, and otherwise whatever is
   * playing - which is the case that matters most: you are listening to
   * something and want to take it apart, and typing its name back into a box to
   * do that is asking you to tell the app what it already knows.
   */
  const mapTarget = useMemo(() => {
    if (query.trim() && matches[0]) return asSong(matches[0]);
    return nowPlaying ? asSong(nowPlaying) : null;
  }, [query, matches, nowPlaying, asSong]);

  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!song || cast.stems.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    deck.seek(((e.clientX - box.left) / Math.max(1, box.width)) * total);
  };

  const clearBoard = () => {
    deck.clear();
    returnOutput();
    loadedSong = null;
    setSong(null);
    cast.refresh();
  };

  return (
    <div style={shell}>
      <div style={topRow}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input
            aria-label="Find a song"
            placeholder="Find a song"
            value={query}
            leadingIcon={<Search size={16} />}
            trailingIcon={
              query ? (
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="Clear"
                  onClick={() => {
                    setQuery('');
                    setOpen(false);
                  }}
                >
                  <X size={14} />
                </IconButton>
              ) : undefined
            }
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            style={{ width: '100%' }}
          />
        </div>
        <Button
          variant="solid"
          onClick={() => {
            if (!mapTarget) return;
            setOpen(false);
            setQuery('');
            void load(mapTarget, startingPoint(mapTarget));
          }}
          disabled={!session || !mapTarget || progress !== null}
        >
          {progress ? <Loader size={16} /> : <Wand2 size={16} />} Map
        </Button>

        {open && matches.length > 0 && (
          <div style={results} role="listbox" aria-label="Songs">
            {matches.map((t) => (
              <button
                key={t.path}
                type="button"
                role="option"
                aria-selected={false}
                style={hit}
                onClick={() => {
                  const target = asSong(t);
                  if (!target) return;
                  setOpen(false);
                  setQuery('');
                  void load(target, startingPoint(target));
                }}
              >
                <Text size="sm">{t.title}</Text>
                <Text size="xs" tone="muted">
                  {t.artist}
                </Text>
              </button>
            ))}
          </div>
        )}
      </div>

      {!session ? (
        <Text tone="muted" size="sm">
          Pulling a song apart happens on your server. Sign in to one to use the board.
        </Text>
      ) : song ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <IconButton
            variant="solid"
            aria-label={cast.playing ? 'Pause' : 'Play'}
            onClick={cast.toggleRun}
            disabled={cast.stems.length === 0}
          >
            {cast.playing ? <Pause size={18} /> : <Play size={18} />}
          </IconButton>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text
              size="sm"
              weight="bold"
              style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {song.title}
            </Text>
            <Text size="xs" tone="muted">
              {note || `${song.artist} · ${clock(total)}`}
            </Text>
            <div style={seekRail} onPointerDown={scrub} role="presentation" aria-label="Seek">
              <span
                ref={cast.headRef}
                style={{
                  position: 'absolute',
                  inset: '0 auto 0 0',
                  width: '0%',
                  background: 'var(--glacier-accent-solid)',
                  borderRadius: 3,
                }}
              />
            </div>
          </div>
          <IconButton variant="ghost" aria-label="Clear the board" onClick={clearBoard}>
            <X size={18} />
          </IconButton>
        </div>
      ) : (
        <Text tone="muted" size="sm">
          {note || 'Find a song, or press Map to take apart what is playing.'}
        </Text>
      )}

      {progress ? (
        <div style={{ ...boardWrap, alignItems: 'center' }}>
          <div style={{ width: '100%', maxWidth: 820 }}>
            <PreparingView progress={progress} />
          </div>
        </div>
      ) : (
      <div style={boardWrap}>
        <div style={board} role="group" aria-label="Parts">
          {slots.map((stem, i) => {
            if (!stem) return <div key={`empty-${i}`} style={padFace(null, false)} aria-hidden />;
            const Icon = STEM_ICONS[stem] ?? AudioWaveform;
            const live = cast.on[stem] ?? false;
            return (
              <button
                key={stem}
                type="button"
                aria-pressed={live}
                aria-label={STEM_LABELS[stem] ?? stem}
                style={padFace(STEM_HUES[stem] ?? 200, live)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  // Capture, so a finger that slides off still releases on the
                  // pad it pressed rather than on whatever is under the lift.
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    // Some engines refuse capture for a pointer already gone.
                  }
                  cast.press(stem, e.pointerId);
                }}
                onPointerUp={(e) => cast.lift(e.pointerId)}
                onPointerCancel={(e) => cast.lift(e.pointerId)}
              >
                <span ref={cast.meterRef(stem)} style={meterFill} aria-hidden />
                <Icon size={20} style={{ opacity: live ? 1 : 0.55, position: 'relative' }} />
                <Text
                  size="sm"
                  weight="bold"
                  style={{ position: 'relative', opacity: live ? 1 : 0.6, lineHeight: 1.1 }}
                >
                  {STEM_LABELS[stem] ?? stem}
                </Text>
              </button>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}
