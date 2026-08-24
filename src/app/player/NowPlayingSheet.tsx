import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { installSheetDismiss } from './playerDismiss.ts';
import { fireNativeHaptic } from '../core/haptics.ts';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenu, CounterBadge, IconButton, MenuItem, Popover, SeekBar, useBeat, useLiveLevels } from '@glacier/react';
import type { LoudnessMeter, PlayerRepeat } from '@glacier/react';
import { Airplay, AudioLines, BookOpenText, Check, ChevronDown, Disc3, EyeOff, Heart, Image as ImageIcon, ListMusic, ListPlus, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, TableOfContents } from '@glacier/icons';
import { isMobile } from '../core/platform.ts';
import { PluginSlot } from '../../plugins/runtime.tsx';
import { SoundConsole } from './SoundConsole.tsx';
import { MarqueeText } from './MarqueeText.tsx';
import { SpinningDisc } from './SpinningDisc.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { DevicePicker } from './DevicePicker.tsx';
import { JamBadge } from './JamBadge.tsx';
import { VolumeRow } from './VolumeControl.tsx';
import { LyricsPanel } from './LyricsPanel.tsx';
import type { PauseStyle } from './playback.tsx';
import {
  FADE_DOWN_MS,
  FADE_UP_MS,
  IDLE_TRACK,
  SPIN_DOWN_MS,
  SPIN_UP_MS,
  beatIntensity,
  formatClock,
  chapterIndexAt,
  type ArtView,
} from './deckShared.ts';
import { formatTotal } from '../ux/format.ts';
import { soundChangesLabel, useSoundChanges } from './soundChanges.ts';
import { subscribeGestures } from './deviceMotion.ts';
import { isTauri, tauriCall } from '../core/tauri.ts';
import { trackIdFromPath } from '../server.ts';
import { motionGesturesEnabled } from '../settings/behaviourPrefs.ts';
import { fetchChapterNotes, type BookNotes } from './chapterNotes.ts';
import { fetchTranscript, type BookLine } from './transcript.ts';
import npPlaceholderArt from '../../assets/attack-wave.png';
import type { Track } from '../core/tauri.ts';

/**
 * One menu, three doorways: the strip's square, the sheet's art, and the
 * Canvas clip itself all open this same chooser, so the setting stays one
 * setting no matter where the press lands.
 */
export function npArtMenuItems(
  artView: ArtView,
  chooseArtView: (next: ArtView) => void,
  book = false,
) {
  return (
    <>
      <MenuItem
        icon={<Disc3 size={15} />}
        shortcut={artView === 'cd' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('cd')}
      >
        Spinning CD
      </MenuItem>
      <MenuItem
        icon={<ImageIcon size={15} />}
        shortcut={artView === 'cover' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('cover')}
      >
        Album cover
      </MenuItem>
      {book && (
        <MenuItem
          icon={<BookOpenText size={15} />}
          shortcut={artView === 'chapters' ? <Check size={14} /> : undefined}
          onSelect={() => chooseArtView('chapters')}
        >
          Chapters
        </MenuItem>
      )}
      <MenuItem
        icon={<EyeOff size={15} />}
        shortcut={artView === 'hidden' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('hidden')}
      >
        Hidden
      </MenuItem>
    </>
  );
}

/**
 * The full-screen Now Playing surface, on touch only. Portalled to the
 * body so its stacking is the viewport's, not the mini-strip's plate
 * (which sits below the nav bar) - otherwise the nav would paint over
 * it. It reuses every handler the strip does, so the two never diverge.
 * Pure presentation, extracted from Player.tsx: every value and handler
 * arrives through props from the deck core.
 */
/** One item of the reading flow: a spoken line, or a chapter's own title
 *  standing in the text the way a book sets one. */
interface ReadingItem {
  kind: 'line' | 'title';
  time: number;
  text: string;
  /** Each word's own clock, where the recogniser gave one. */
  words?: { t: number; w: string }[];
}

/**
 * The book, reading itself - and readable by hand.
 *
 * Two states, one surface. FOLLOWING, the default: the line under the
 * narrator's voice keeps itself centred, its words lighting as they are
 * spoken. BROWSING: the moment a hand touches the scroll it belongs to the
 * hand - skim ahead, skim back, tap any line and the book plays from there.
 * Four quiet seconds after the last touch, the reading takes the scroll
 * back. Full parity with the lyrics popover this face replaces: everything
 * it could do happens ON the page now.
 *
 * A whole transcript renders whole up to 1500 items; past that a window of
 * 600 either side of the reading rides along - half an hour of narration
 * each way, the popover's own limit. The window holds still while a hand is
 * on the page, so lines never re-slice under a thumb.
 */
function BookWords({
  items,
  positionSec,
  playing,
  onJump,
}: {
  items: ReadingItem[];
  positionSec: number;
  playing: boolean;
  onJump: (timeSec: number) => void;
}) {
  const [fineNow, setFineNow] = useState(positionSec);
  const anchor = useRef({ pos: positionSec, at: performance.now() });
  useEffect(() => {
    anchor.current = { pos: positionSec, at: performance.now() };
    setFineNow(positionSec);
  }, [positionSec]);
  useEffect(() => {
    if (!playing) return;
    const tick = window.setInterval(() => {
      setFineNow(anchor.current.pos + (performance.now() - anchor.current.at) / 1000);
    }, 200);
    return () => window.clearInterval(tick);
  }, [playing]);

  let at = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.time <= fineNow) at = i;
    else break;
  }

  /* Browsing: the hand owns the scroll until it has been still for a while. */
  const [browsing, setBrowsing] = useState(false);
  const quiet = useRef<number | null>(null);
  const touched = () => {
    setBrowsing(true);
    if (quiet.current) window.clearTimeout(quiet.current);
    quiet.current = window.setTimeout(() => setBrowsing(false), 4000);
  };
  useEffect(
    () => () => {
      if (quiet.current) window.clearTimeout(quiet.current);
    },
    [],
  );

  /* The window: still while browsing, riding the reading otherwise. */
  const [winAt, setWinAt] = useState(at);
  useEffect(() => {
    if (!browsing) setWinAt(at);
  }, [at, browsing]);
  const whole = items.length <= 1500;
  const from = whole ? 0 : Math.max(0, winAt - 600);
  const shown = whole ? items : items.slice(from, winAt + 600);

  const nowWords = useMemo(() => {
    const item = items[at];
    if (!item || item.kind !== 'line') return null;
    if (item.words && item.words.length > 0) return item.words;
    const until = items[at + 1]?.time ?? item.time + 10;
    const span = Math.max(1, until - item.time);
    const words = item.text.split(/\s+/).filter(Boolean);
    const total = words.reduce((n, w) => n + w.length + 1, 0);
    let acc = 0;
    return words.map((w) => {
      const t = item.time + (acc / total) * span;
      acc += w.length + 1;
      return { t, w };
    });
  }, [items, at]);
  let lit = -1;
  if (nowWords) {
    for (let i = 0; i < nowWords.length; i++) {
      if (nowWords[i]!.t <= fineNow) lit = i;
      else break;
    }
  }

  /* Following: keep the lit line on the slot's middle, by real scrolling now
     - which is exactly what hands the same gesture to the reader. */
  const slotRef = useRef<HTMLDivElement | null>(null);
  const nowRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (browsing) return;
    const slot = slotRef.current;
    const now = nowRef.current;
    if (!slot || !now) return;
    const top = now.offsetTop - slot.clientHeight / 2 + now.offsetHeight / 2;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    slot.scrollTo({ top, behavior: still ? 'auto' : 'smooth' });
  }, [at, browsing, items]);

  return (
    <div
      ref={slotRef}
      className="npBookWords"
      data-browsing={browsing || undefined}
      onPointerDown={touched}
      onWheel={touched}
      onTouchMove={touched}
    >
      <div className="npBookWords__roll">
        {shown.map((l, j) => {
          const i = from + j;
          const state = i < at ? 'past' : i === at ? 'now' : 'next';
          const Tag = l.kind === 'title' ? 'h2' : 'p';
          return (
            <Tag
              key={i}
              ref={i === at ? (nowRef as never) : undefined}
              className={l.kind === 'title' ? 'npBookWords__title' : 'npBookWords__line'}
              data-state={state}
              role="button"
              tabIndex={0}
              onClick={() => {
                // A tapped line plays from its top - and the reading resumes
                // following immediately at the new place, because the tap IS
                // the hand choosing where the reading should be.
                onJump(l.time);
                if (quiet.current) window.clearTimeout(quiet.current);
                setBrowsing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onJump(l.time);
              }}
            >
              {i === at && l.kind === 'line' && nowWords ? (
                nowWords.map((w, k) => (
                  // THE SPACE LIVES OUTSIDE THE SPAN. It used to sit inside it,
                  // and `[data-lit]` underlines the whole span - so the accent
                  // ran one space past the end of every word, reading as an
                  // underline that overshoots to the right.
                  <Fragment key={k}>
                    <span
                      className="npBookWords__w"
                      data-said={k < lit || undefined}
                      data-lit={k === lit || undefined}
                    >
                      {w.w}
                    </span>{' '}
                  </Fragment>
                ))
              ) : (
                l.text
              )}
            </Tag>
          );
        })}
      </div>
    </div>
  );
}


/** One row of the chapter panel, whatever form the book arrived in. */
interface ChapterFace {
  title: string;
  /** The hub's one non-spoiler line, where its AI has written one. */
  blurb: string | null;
  /** Right-hand figure: a start offset (single file) or a length (sections). */
  at: string | null;
  here: boolean;
  jump: () => void;
}

/**
 * The chapters, ON the cover - the book's face for the art slot.
 *
 * A record's face is its art; a book's face is its art AND its table of
 * contents, because "where am I, what is left" is the question a book keeps
 * open the whole way through. So this face keeps the cover as the ground,
 * raises a scrim over its lower half, and lets the chapters live there -
 * the reading one lit, with a hairline showing how deep into it the
 * narrator is. Tap a chapter and the book goes there.
 *
 * The list re-centres itself as reading crosses a chapter mark, but never
 * while a finger is on it - stealing the scroll from under a browsing thumb
 * is how a list teaches people not to touch it.
 */
function ChapterArt({
  art,
  items,
  runFraction,
}: {
  art: string | null;
  items: ChapterFace[];
  runFraction: number;
}) {
  const hereAt = items.findIndex((c) => c.here);
  const hereRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const browsing = useRef(false);
  useEffect(() => {
    if (!browsing.current) hereRef.current?.scrollIntoView({ block: 'center' });
  }, [hereAt]);

  return (
    <div className="npChapterArt">
      {art ? (
        <img className="npChapterArt__cover" src={art} alt="" />
      ) : (
        <img className="npChapterArt__cover" src={npPlaceholderArt} alt="" />
      )}
      <div className="npChapterArt__scrim" aria-hidden />
      <div
        ref={listRef}
        className="npChapterArt__list"
        role="list"
        aria-label="Chapters"
        onPointerDown={() => {
          browsing.current = true;
        }}
        onPointerUp={() => {
          // Let the tap settle, then hand the scroll back to the reader.
          setTimeout(() => {
            browsing.current = false;
          }, 4000);
        }}
      >
        {items.map((c, i) => (
          <button
            key={i}
            ref={c.here ? hereRef : undefined}
            type="button"
            role="listitem"
            className="npChapterArt__row"
            data-here={c.here || undefined}
            onClick={c.jump}
          >
            <span className="npChapterArt__n">{i + 1}</span>
            <span className="npChapterArt__title">{c.title}</span>
            {c.at && <span className="npChapterArt__at">{c.at}</span>}
            {c.blurb && <span className="npChapterArt__blurb">{c.blurb}</span>}
            {c.here && (
              <span className="npChapterArt__run" aria-hidden>
                <span style={{ width: `${Math.round(runFraction * 100)}%` }} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}


export function NowPlayingSheet({
  npOpen,
  npDocked,
  onUndock,
  npDimmed,
  setNpDimmed,
  pokeNpDim,
  npCanvas,
  npLyrics,
  setNpLyrics,
  npQueue,
  setNpQueue,
  setNpOpen,
  npArtMenu,
  artView,
  chooseArtView,
  track,
  artwork,
  dispArtwork,
  activeElsewhere,
  dispPlaying,
  playing,
  audible,
  buffering,
  downloading,
  meter,
  progress,
  pauseStyle,
  onScratchBegin,
  onScratch,
  onScratchEnd,
  onOpenArtist,
  chapterLabel,
  chapters,
  bookRemaining,
  onSeekChapter,
  favorite,
  toggleFavoriteFelt,
  duration,
  position,
  volume,
  muted,
  systemVolume,
  onScrub,
  commitSeek,
  shuffle,
  cycleShuffle,
  canSkip,
  skipBack,
  skipForward,
  setPlayingState,
  repeat,
  cycleRepeat,
  narrowEq,
  setVolumeState,
  setMutedState,
  queue,
  onQueueChange,
  onTrackChange,
  setFiling,
}: {
  npOpen: boolean;
  npDocked: boolean;
  /**
   * Fold the split back into one room. Present only while the dock is showing
   * and nothing is playing - see the note on the drag below.
   */
  onUndock?: (() => void) | undefined;
  npDimmed: boolean;
  setNpDimmed: (next: boolean) => void;
  pokeNpDim: () => void;
  npCanvas: string | null;
  npLyrics: boolean;
  setNpLyrics: (next: boolean) => void;
  npQueue: boolean;
  setNpQueue: (next: boolean) => void;
  setNpOpen: (next: boolean) => void;
  npArtMenu: ReactNode;
  artView: ArtView;
  /** The chooser's own setter, for the Read-along seat to summon the face. */
  chooseArtView: (next: ArtView) => void;
  track: Track | null;
  artwork: string | null;
  dispArtwork: string | null;
  activeElsewhere: boolean;
  dispPlaying: boolean;
  playing: boolean;
  audible: boolean;
  buffering: boolean;
  downloading: boolean;
  /** The deck's loudness meter; the sheet runs its own beat/levels off it so
   *  the 60fps pulse re-renders this surface, never the whole Player. */
  meter: LoudnessMeter | null;
  /** Playhead as a 0-1 fraction, so ripples leave the playhead. */
  progress: number;
  pauseStyle: PauseStyle;
  onScratchBegin: () => void;
  onScratch: (deltaSeconds: number) => void;
  onScratchEnd: () => void;
  onOpenArtist?: (artist: string) => void;
  chapterLabel: string | null;
  /** The book's own chapter marks, so the label can open onto them. */
  chapters: { title: string; startMs: number }[];
  /** Seconds left in the whole book, or null when it cannot be said honestly. */
  bookRemaining: number | null;
  onSeekChapter: (startMs: number) => void;
  favorite: boolean;
  toggleFavoriteFelt: () => void;
  duration: number;
  position: number;
  volume: number;
  muted: boolean;
  systemVolume: number;
  onScrub: (to: number) => void;
  commitSeek: (to: number) => void;
  shuffle: boolean;
  /** off -> shuffle -> off. */
  cycleShuffle: () => void;
  canSkip: boolean;
  skipBack: () => void;
  skipForward: () => void;
  setPlayingState: (next: boolean) => void;
  repeat: PlayerRepeat;
  cycleRepeat: () => void;
  narrowEq: boolean;
  setVolumeState: (next: number) => void;
  setMutedState: (next: boolean) => void;
  queue: Track[];
  onQueueChange?: (tracks: Track[]) => void;
  onTrackChange?: (track: Track) => void;
  setFiling: (track: Track | null) => void;
}) {
  /*
   * The phone's own movement, on the one screen where it means anything.
   *
   * Bound HERE rather than app-wide so the sensor is only open while this sheet
   * is: a gesture that works from the library page is a gesture that fires in a
   * pocket, and a listener that never unbinds is a reading nobody reads.
   */
  /*
   * The artwork used to lean with the phone, off `deviceorientation`. Gone:
   * a 60Hz sensor writing two custom properties per reading, into a rule that
   * restarted a 220ms transition each time, on the busiest screen in the app.
   * See the note where that rule was, in 06-the-dock-contract-b.
   *
   * Motion as a CONTROL stays, below. That is the distinction Matt drew and it
   * is the right one: a discrete, thresholded gesture that does something you
   * asked for costs nothing per frame, and decorative continuous motion costs
   * every frame whether or not anyone is looking at it.
   */
  /*
   * The book's chapters as ONE list, whatever form the book arrived in: a
   * single m4b brings its own marks (jump = a seek), a sectioned book IS its
   * queue (jump = play that section). Everything needed is already in this
   * sheet's props - the queue is the reading order BooksPage queued.
   */
  /*
   * The hub's word on what each chapter IS - a truthful name (a preamble
   * mislabelled "Chapter 1" gets called a preamble) and one non-spoiler
   * line. Fetched once per opened book; null until it lands or when the hub
   * has none, and every face below falls back to the embedded labels.
   */
  const [bookNotes, setBookNotes] = useState<BookNotes | null>(null);
  const [bookWords, setBookWords] = useState<BookLine[] | null>(null);
  const bookPath = track?.kind === 'book' ? track.path : null;
  useEffect(() => {
    if (!bookPath || !track) {
      setBookNotes(null);
      setBookWords(null);
      return;
    }
    let stale = false;
    fetchChapterNotes(track).then((notes) => {
      if (!stale) setBookNotes(notes);
    });
    fetchTranscript(track).then((lines) => {
      if (!stale) setBookWords(lines);
    });
    return () => {
      stale = true;
    };
    // The track OBJECT changes identity every library refresh; the path is
    // the book's identity, and the notes only depend on that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookPath]);

  /** The hub's note for one chapter slot, looked up by server track id. */
  const noteFor = (path: string, idx: number) => {
    const id = trackIdFromPath(path);
    const list = (id != null && bookNotes?.[String(id)]) || null;
    return list?.find((n) => n.idx === idx) ?? null;
  };

  /*
   * The reading flow: transcript lines with each chapter's start folded in
   * as a heading item. Memoised on the stable inputs - lines, notes, marks -
   * so the once-a-second position tick reuses it untouched.
   */
  const readingFlow = useMemo<ReadingItem[]>(() => {
    if (!bookWords || bookWords.length === 0 || !track) return [];
    const id = trackIdFromPath(track.path);
    const notes = (id != null && bookNotes?.[String(id)]) || null;
    const nameAt = (i: number, fallback: string) => {
      const said = notes?.find((n) => n.idx === i)?.name?.trim();
      if (said) return said;
      const bare = fallback
        .replace(new RegExp(`^chapter\\s*0*${i + 1}\\b[\\s—–:.-]*`, 'i'), '')
        .trim();
      return bare ? `Chapter ${i + 1} — ${bare}` : `Chapter ${i + 1}`;
    };
    const heads: ReadingItem[] =
      chapters.length > 0
        ? chapters.map((c, i) => ({
            kind: 'title' as const,
            time: c.startMs / 1000,
            text: nameAt(i, c.title ?? ''),
          }))
        : [{ kind: 'title' as const, time: 0, text: nameAt(0, track.title) }];
    const flow: ReadingItem[] = [
      ...heads,
      ...bookWords.map((l) => ({
        kind: 'line' as const,
        time: l.time,
        text: l.text,
        ...(l.words ? { words: l.words } : {}),
      })),
    ];
    // A heading sorts ahead of the first line spoken at the same moment.
    flow.sort((a, b) => a.time - b.time || (a.kind === 'title' ? -1 : 1));
    return flow;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookWords, bookNotes, chapters, bookPath]);

  const bookFaces: ChapterFace[] = (() => {
    if (track?.kind !== 'book') return [];
    if (chapters.length > 0) {
      const here = chapterIndexAt(chapters, position * 1000);
      return chapters.map((c, i) => {
        // The row already numbers itself, so a title that opens with its own
        // "Chapter N" (most m4b tags do) sheds the prefix: "4 · Chapter 4 —
        // A Cartographer's Debt" says the number twice and clips the words.
        const note = noteFor(track.path, i);
        const raw = (note?.name ?? c.title ?? '').trim();
        const bare = raw
          .replace(new RegExp(`^chapter\\s*0*${i + 1}\\b[\\s—–:.-]*`, 'i'), '')
          .trim();
        return {
          title: bare || `Chapter ${i + 1}`,
          blurb: note?.blurb?.trim() || null,
          at: formatClock(c.startMs / 1000),
          here: i === here,
          jump: () => onSeekChapter(c.startMs),
        };
      });
    }
    const sections = queue.filter(
      (t) => t.kind === 'book' && t.album === track.album && t.artist === track.artist,
    );
    if (sections.length < 2) return [];
    return sections.map((t) => {
      const note = noteFor(t.path, 0);
      return {
        title: note?.name?.trim() || t.title,
        blurb: note?.blurb?.trim() || null,
        at: t.duration != null ? formatClock(t.duration) : null,
        here: t.path === track.path,
        jump: () => onTrackChange?.(t),
      };
    });
  })();

  /*
   * The seek bar reads in CHAPTERS for a marked book: the bar spans the
   * chapter being read, not the whole file - full right is "end of this
   * chapter", the same promise the bar makes for every song and for every
   * section of a many-file book. Held FROZEN while a finger is down, or a
   * drag to the bar's end would cross the mark, re-window to the next
   * chapter, and snap the handle out from under the thumb.
   */
  /*
   * The door's own label, from the faces - so a sectioned book gets a door
   * too (its chapters are its queue), and a renamed chapter shows its real
   * name here. "Chapter N of M" stays positional: it is the row you are on.
   */
  const doorLabel = (() => {
    if (bookFaces.length === 0) return chapterLabel;
    const here = Math.max(
      0,
      bookFaces.findIndex((f) => f.here),
    );
    const ord = `Chapter ${here + 1} of ${bookFaces.length}`;
    const title = bookFaces[here]?.title ?? '';
    return title && title.toLowerCase() !== `chapter ${here + 1}` ? `${ord} · ${title}` : ord;
  })();

  const chapterWin = (() => {
    if (chapters.length === 0) return null;
    const i = chapterIndexAt(chapters, position * 1000);
    const start = chapters[i]!.startMs / 1000;
    const end = i + 1 < chapters.length ? chapters[i + 1]!.startMs / 1000 : Math.max(1, duration);
    return { start, len: Math.max(1, end - start) };
  })();
  const scrubWin = useRef<{ start: number; len: number } | null>(null);
  const barWin = scrubWin.current ?? chapterWin;
  const barDuration = barWin ? barWin.len : Math.max(1, duration);
  const barValue = barWin
    ? Math.min(barWin.len, Math.max(0, position - barWin.start))
    : position;
  const barScrub = (to: number) => {
    if (chapterWin && !scrubWin.current) scrubWin.current = chapterWin;
    onScrub(to + (scrubWin.current?.start ?? 0));
  };
  const barSeekEnd = (to: number) => {
    const start = scrubWin.current?.start ?? chapterWin?.start ?? 0;
    scrubWin.current = null;
    commitSeek(chapters.length > 0 ? to + start : to);
  };

  const bookPlaying = track?.kind === 'book';
  useEffect(() => {
    if (!motionGesturesEnabled()) return;
    return subscribeGestures((g) => {
      // A shake toggles shuffle - except for a book, whose sheet no longer
      // shows the control, so a pocket shake would flip invisible state.
      if (g === 'shake' && !bookPlaying) cycleShuffle();
      else if (g === 'flick-right') skipForward();
      else if (g === 'flick-left') skipBack();
    });
  }, [cycleShuffle, skipForward, skipBack, bookPlaying]);

  // Whether this shell can put the AirPlay sheet up. Asked once, because the
  // answer cannot change inside a session - and asked rather than platform-
  // sniffed, so a shell from before the command simply answers no.
  const [airplay, setAirplay] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    void tauriCall<boolean>('airplay_supported')
      .then((ok) => setAirplay(ok === true))
      .catch(() => setAirplay(false));
  }, []);

  // How far the sound has been moved from the record, for the badge on the
  // console's button. Read here rather than inside the console because the
  // whole point is that it shows while the console is SHUT.
  const changes = useSoundChanges();
  // Subscribed HERE rather than handed down - same reasoning as the strip:
  // whichever component calls useBeat re-renders per animation frame, and it
  // should be the surface drawing the pulse, not the whole deck core.
  /*
   * Whether the clip on screen is actually showing frames.
   *
   * Keyed off the clip's own URL so a track change puts it straight back to
   * false - otherwise the next song's video would inherit the last one's
   * "ready" and flash its empty box at full opacity, which is the bug this
   * gate exists to remove, only faster.
   */
  /*
   * The sheet's own way out.
   *
   * It rose from the strip and the only way back was a chevron in the top-LEFT
   * corner - the one corner a thumb holding a phone cannot reach. Pushing it
   * back where it came from is how every full-screen player on the platform
   * closes, and it was the one gesture this one did not have.
   */
  const sheetRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      return installSheetDismiss(node, {
        onDismiss: () => {
          fireNativeHaptic('light');
          /*
           * Docked, the same drag folds the split back into one room.
           *
           * It already existed here and landed nowhere: setNpOpen(false) closes
           * a sheet that was OPENED, and a docked one is mounted by the dock
           * rather than by npOpen, so pushing it down did nothing at all.
           *
           * Only while nothing is playing, and that gate is the whole design
           * rather than caution. The dock is deliberately sticky - see
           * deckEngaged in App - because a split that collapsed every time the
           * music stopped would move the layout under someone's hands. What was
           * missing was a way to ASK, and a drag on the thing you want gone is
           * that ask. With music playing the pane is doing its job and the
           * gesture stays inert.
           */
          if (npDocked) {
            onUndock?.();
            return;
          }
          setNpOpen(false);
          setNpLyrics(false);
        },
      });
    },
    [setNpOpen, setNpLyrics, npDocked, onUndock],
  );

  const [readyCanvas, setReadyCanvas] = useState<string | null>(null);
  const canvasReady = readyCanvas !== null && readyCanvas === npCanvas;
  const setCanvasReady = (on: boolean) => setReadyCanvas(on ? npCanvas : null);

  const beat = useBeat({ meter, active: audible, at: progress });
  const levels = useLiveLevels({ meter, progress, active: audible });
  return createPortal(
    <>
      {/* What is behind the sheet, while the sheet is being pushed off it.

          A sibling rather than a child: the sheet paints its own opaque
          background, and nothing inside it can sit behind that. Mounted only
          while a drag is live, because a full-screen backdrop-filter is not
          something to leave running under an opaque surface for the hours a
          player is open. */}
      <div className="npScreen__behind" aria-hidden="true" />
      <div
        ref={sheetRef}
        className="npScreen"
      data-reading={
        (track?.kind === 'book' && artView === 'chapters' && readingFlow.length > 0) || undefined
      }
      role="dialog"
      aria-label="Now playing"
      // Always the dark palette, whatever the app wears: this surface lives
      // over album art and its own backdrop, where light-theme ink is
      // unreadable and the lyric layers (white + screen-blend) vanish.
      // The token layer scopes [data-theme] on any element, so one
      // attribute re-themes the whole subtree.
      data-theme="dark"
      data-open={npOpen || undefined}
      data-docked={npDocked || undefined}
      // Capture phase, so ANY touch on the sheet - a control, the art, the
      // veil itself - counts as activity: the dim lifts and its clock
      // restarts. The veil below swallows its own tap so a wake-up touch
      // never also presses whatever sat under it.
      onPointerDownCapture={() => {
        setNpDimmed(false);
        if (playing) pokeNpDim();
      }}
    >
      {/* The song's own cover, blown up and blurred, as the surface behind
          the controls - the same move the mini-strip's backdrop makes,
          scoped to this sheet. */}
      <div
        className="npScreen__bg"
        aria-hidden="true"
        style={artwork ? { backgroundImage: `url(${JSON.stringify(artwork)})` } : undefined}
      />
      {/* The Spotify Canvas, when the track has one: a muted loop over this
          sheet's blurred cover, keyed on its URL so a new clip restarts
          cleanly. Absent - the common case - it is simply not rendered and
          the cover shows instead. Wrapped in the same artwork-style
          chooser the art carries, so a press-and-hold on the clip itself
          offers the switch - the one that matters most here, since
          'hidden' leaves the clip as the only thing to press. */}
      {npCanvas ? (
        <ContextMenu
          aria-label="Artwork style"
          className="npScreen__canvasWrap"
          content={npArtMenu}
        >
          {/* Hidden until it is genuinely running.

              The fade used to start when the ELEMENT mounted, which is a
              promise about the network the network had not made: for the
              second or so the clip spent arriving, a transparent video box
              faded up over the sheet and whatever sat behind it - the cover
              still loading, the app's own mark blown up to fill a phone -
              showed through, warped by the backdrop's motion. Waiting for
              `playing` means the first thing anyone sees of a Canvas is the
              Canvas. Until then the blurred cover holds, which is what the
              no-clip case looks like anyway. */}
          <video
            key={npCanvas}
            className="npScreen__canvas"
            data-ready={canvasReady || undefined}
            src={npCanvas}
            autoPlay
            loop
            muted
            playsInline
            aria-hidden="true"
            onPlaying={() => setCanvasReady(true)}
          />
        </ContextMenu>
      ) : artView === 'hidden' ? (
        // No clip and no art: the sheet's open middle still answers the
        // press-and-hold, so 'hidden' is never a state you need the mini
        // strip to climb back out of.
        <ContextMenu
          aria-label="Artwork style"
          className="npScreen__canvasWrap"
          content={npArtMenu}
        />
      ) : null}
      {/* The lyric words that used to run the full height of the sheet are
          gone. They sat over the artwork and the disc, and on a screen whose
          whole job is the record in front of you they were reading material
          competing with the thing being played. The Lyrics panel is still
          here, one tap away, where lyrics are what you actually came for.
          The backdrop itself still draws behind the app (see App.tsx). */}
      {/* A blur that rises through the bottom third, so the transport, the
          times and the title read against something settled instead of
          against whatever frame the clip happens to be on. Sits over the
          canvas and the words, under every control. */}
      <div className="npScreen__veil" aria-hidden="true" />
      <header className="npScreen__head">
        <IconButton
          variant="ghost"
          aria-label="Close now playing"
          onClick={() => {
            setNpOpen(false);
            setNpLyrics(false);
          }}
        >
          <ChevronDown size={22} />
        </IconButton>
        <span className="npScreen__source">{track?.album || 'Now playing'}</span>
        {/* Where the close button's counterweight was: filing the song is
            the one action worth a permanent seat up here, and this sheet
            has the room the mini-strip's rail does not. */}
        {track ? (
          <IconButton
            variant="ghost"
            aria-label="Add to playlist"
            onClick={() => setFiling(track)}
          >
            <ListPlus size={20} />
          </IconButton>
        ) : (
          <span className="npScreen__headSpacer" aria-hidden="true" />
        )}
      </header>

      {/* The artwork, per the chosen face - and no longer standing down
          for a Canvas: the disc turns OVER the clip now, because the
          platter is an instrument (scratch, flick) and an instrument that
          vanishes when a video shows up is a broken promise. Anyone who
          prefers the clip unobstructed picks Hidden - the third face. */}
      {artView !== 'hidden' && (
      <div className="npScreen__art">
        {/* The hero art follows the same artView the mini-strip does, so the
            choice is one setting in two places. A press (long-press on
            touch) opens the chooser. */}
        <ContextMenu
          aria-label="Artwork style"
          className={`npScreen__coverTarget${
            artView === 'chapters' && readingFlow.length > 0
              ? ' npScreen__coverTarget--reading'
              : artView === 'chapters' && bookFaces.length > 0
                ? ' npScreen__coverTarget--chapters'
                : ''
          }`}
          content={npArtMenu}
        >
          {artView === 'chapters' && readingFlow.length > 0 ? (
            <BookWords
              items={readingFlow}
              positionSec={position}
              playing={playing}
              onJump={commitSeek}
            />
          ) : artView === 'chapters' && bookFaces.length > 0 ? (
            <ChapterArt
              art={artwork}
              items={bookFaces}
              runFraction={Math.min(1, Math.max(0, barValue / barDuration))}
            />
          ) : artView === 'cd' ? (
            <SpinningDisc
              art={dispArtwork}
              spinning={activeElsewhere ? dispPlaying : audible}
              spooling={buffering || downloading}
              beat={beat}
              onScratchStart={onScratchBegin}
              onScratch={onScratch}
              onScratchEnd={onScratchEnd}

              spinUpMs={
                pauseStyle === 'turntable'
                  ? SPIN_UP_MS
                  : pauseStyle === 'fade'
                    ? FADE_UP_MS
                    : 0
              }
              spinDownMs={
                pauseStyle === 'turntable'
                  ? SPIN_DOWN_MS
                  : pauseStyle === 'fade'
                    ? FADE_DOWN_MS
                    : 0
              }
            />
          ) : (
            <img
              className="npScreen__cover"
              src={artwork ?? npPlaceholderArt}
              alt=""
            />
          )}
        </ContextMenu>
      </div>
      )}

      <div className="npScreen__meta">
        <div className="npScreen__lines">
          {/* A single-file book's title IS its album, and the head already
              wears the album - saying it twice on one screen is noise. */}
          {!(track?.kind === 'book' && track.title === track.album) && (
            <MarqueeText className="npScreen__title" text={track?.title ?? ''} />
          )}
          {onOpenArtist && track ? (
            <button
              type="button"
              className="npScreen__artist npScreen__artistLink"
              onClick={() => {
                // The page opens under the sheet, so the sheet steps aside.
                setNpOpen(false);
                onOpenArtist(track.artist);
              }}
            >
              {track.artist}
            </button>
          ) : (
            <span className="npScreen__artist">{track?.artist ?? ''}</span>
          )}
          {/* The chapter line is a DOOR, not a caption.
              Knowing you are in chapter three of twelve immediately raises
              "so where is chapter seven", and the only answer used to be
              tapping skip six times and watching the label. It opens the list;
              the list jumps. Still a plain span when the book has no marks,
              because a control that opens onto nothing is worse than a
              label. */}
          {/* A caption now, not a door: chapter select moved into the
              transport, where the thumb already is. */}
          {(doorLabel || chapterLabel) && (
            <span className="npScreen__chapter">
              <BookOpenText size={13} aria-hidden />
              <span className="npScreen__chapterText">{doorLabel ?? chapterLabel}</span>
            </span>
          )}
          {/* Its own line, because it is its own fact and because a phone has
              no room to hang it off the end of a chapter title - which clipped
              the title and then the number with it. */}
          {(chapterLabel || bookFaces.length > 0) && bookRemaining != null && (
            <span className="npScreen__left">{formatTotal(bookRemaining)} left in the book</span>
          )}
          {/* A downloading placeholder says so; otherwise only while the
              buffer is actually dry - silence with the transport still
              showing play is the mystery this whole path exists to end. */}
          {(downloading || buffering) && (
            <span className="npScreen__buffering" role="status">
              {downloading ? 'Downloading…' : 'Buffering…'}
            </span>
          )}
        </div>
        <IconButton
          variant="ghost"
          aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
          aria-pressed={favorite}
          className="npScreen__heart"
          onClick={toggleFavoriteFelt}
        >
          <Heart size={22} fill={favorite ? 'currentColor' : 'none'} />
        </IconButton>
      </div>

      {/* No scrubber while downloading - there is no timeline yet. */}
      {!downloading && (
      <div className="npScreen__scrub">
        {/* The kit's live bar, not a plain slider: the same waveform the
            mini strip wears, driven by the same levels and beat, so the
            now-playing screen deforms in time with the music. Pushed toward
            the hero end of the intensity range (max 3) since this bar IS
            the surface's focus, and set on a raised-card rail so the run
            ahead stays legible over the blurred cover behind it. */}
        <SeekBar
          duration={barDuration}
          value={barValue}
          aria-label="Seek"
          shape="swell"
          tone="accent"
          fill="solid"
          rail="contrast"
          levels={levels}
          beat={beat}
          tracer
          intensity={Math.min(3, beatIntensity(volume, muted, systemVolume) * 1.6)}
          onValueChange={barScrub}
          onSeekEnd={barSeekEnd}
        />
        <div className="npScreen__times">
          <span>{formatClock(barValue)}</span>
          <span>-{formatClock(Math.max(0, barDuration - barValue))}</span>
        </div>
      </div>
      )}

      <div className="npScreen__transport">
        {/* A book's transport is not a song's. Shuffling a book is vandalism
            and repeating one is a niche of a niche - so their two seats go
            to what a listener mid-book actually reaches for: where it plays,
            and the words. Everything else on the actions row below is song
            furniture, and the row itself stands down for books. */}
        {track?.kind === 'book' ? (
          <DevicePicker always size="md" />
        ) : (
        <IconButton
          variant="ghost"
          aria-label="Shuffle"
          aria-pressed={shuffle}
          data-on={shuffle || undefined}
          onClick={cycleShuffle}
        >
          <span className="shuffleGlyph">
            <Shuffle size={20} />
          </span>
        </IconButton>
        )}
        <IconButton variant="ghost" aria-label="Previous" disabled={!canSkip} onClick={skipBack}>
          <SkipBack size={26} fill="currentColor" />
        </IconButton>
        <button
          type="button"
          className="npScreen__play"
          aria-label={downloading ? 'Downloading' : playing ? 'Pause' : 'Play'}
          disabled={downloading}
          onClick={() => setPlayingState(!playing)}
        >
          {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
        </button>
        <IconButton variant="ghost" aria-label="Next" disabled={!canSkip} onClick={skipForward}>
          <SkipForward size={26} fill="currentColor" />
        </IconButton>
        {track?.kind === 'book' ? (
          /* Chapter select, in the hand's own row - by request: the door
             under the title was a small target a thumb's length from where
             thumbs live. The list is the same faces the door offered:
             truthful names, blurbs, jump on tap. */
          <Popover
            placement="top"
            aria-label="Chapters"
            className="npChapters"
            trigger={
              <IconButton variant="ghost" aria-label="Chapters" disabled={bookFaces.length === 0}>
                <TableOfContents size={20} />
              </IconButton>
            }
          >
            <div className="npChapters__list" role="list">
              {bookFaces.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  role="listitem"
                  className="npChapters__row"
                  data-here={c.here || undefined}
                  onClick={c.jump}
                >
                  <span className="npChapters__n">{i + 1}</span>
                  <span className="npChapters__title">{c.title}</span>
                  {c.at && <span className="npChapters__at">{c.at}</span>}
                  {c.blurb && <span className="npChapters__blurb">{c.blurb}</span>}
                </button>
              ))}
            </div>
          </Popover>
        ) : (
        <IconButton
          variant="ghost"
          aria-label={`Repeat: ${repeat}`}
          data-on={repeat !== 'off' || undefined}
          onClick={cycleRepeat}
        >
          {repeat === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
        </IconButton>
        )}
      </div>

      {/* The secondary controls the strip has no room for: lyrics, the
          device hand-off (only when there is somewhere to send it), the
          equalizer, and the volume fader. The transport above already
          carries shuffle/repeat/skip, and favourite and filing sit on the
          meta and header rows. */}
      {/* Books clear the actions row on TOUCH - it is song furniture and
          the transport now seats the two book verbs. Desktop keeps the row:
          the docked split hides the strip, so this row's volume popover is
          the only fader a desktop book listener has. */}
      {(track?.kind !== 'book' || !isMobile) && (
      <div className="npScreen__actions">
        <IconButton variant="ghost" aria-label="Queue" onClick={() => setNpQueue(true)}>
          <ListMusic size={20} />
        </IconButton>
        {/* Words, not a microphone. The mic used to open this, which left
            nothing obvious for singing along to - and a microphone is a strange
            glyph for "show me the words" once something else on the row
            genuinely is a microphone. */}
        <IconButton variant="ghost" aria-label="Lyrics" onClick={() => setNpLyrics(true)}>
          <BookOpenText size={20} />
        </IconButton>
        {/* Whatever wants to act on the song playing right now. */}
        <PluginSlot id="now-playing-actions" />
        {/* Who else is hearing this. Renders nothing outside a jam, so the row
            is unchanged for anyone listening alone. */}
        <JamBadge />
        {/* Always here, unlike in the strip's overflow: on this screen "where is
            this playing" is part of the question the screen answers. */}
        <DevicePicker always />
        {/* AirPlay sits beside Connect rather than inside it because they are
            different kinds of elsewhere: Connect moves the DECK to another
            AttackFM device, AirPlay moves this device's SOUND to a speaker.
            Only when the shell can actually present the sheet - the probe
            rejects on an old shell and on everything that is not an iPhone,
            and a dead button is worse than none. */}
        {airplay && (
          <IconButton
            variant="ghost"
            aria-label="AirPlay"
            onClick={() => void tauriCall('airplay_show').catch(() => {})}
          >
            <Airplay size={20} />
          </IconButton>
        )}
        <Popover
          placement="top"
          aria-label="Equalizer"
          className="popoverSheet eqPopoverPanel"
          /* The badge is the only thing outside the console that says the sound
             has been moved. Everything the rooms count is behind this one
             button, so with it shut a dropped vocal or a filter left on
             yesterday was silent in both senses. */
          trigger={
            <IconButton
              className="soundTrigger"
              variant="ghost"
              aria-label={soundChangesLabel(changes)}
            >
              <AudioLines size={20} />
              {changes.total > 0 && (
                <CounterBadge
                  className="soundTrigger__badge"
                  count={changes.total}
                  max={99}
                  size="sm"
                  tone="accent"
                />
              )}
            </IconButton>
          }
        >
          <div className="eqPopover">
            <SoundConsole narrow={narrowEq} />
          </div>
        </Popover>
        {/* No fader on a phone: volume is pinned at unity there and the
            handset's own buttons are the control, so a slider that cannot
            move would be a lie. Desktop, which has no hardware keys of its
            own, keeps it. */}
        {!isMobile && (
          <Popover
            placement="top"
            aria-label="Volume"
            className="morePopoverPanel"
            trigger={
              <IconButton variant="ghost" aria-label="Volume">
                <Volume2 size={20} />
              </IconButton>
            }
          >
            <VolumeRow
              value={volume}
              muted={muted}
              onValueChange={setVolumeState}
              onMutedChange={setMutedState}
            />
          </Popover>
        )}
      </div>
      )}

      {/* Lyrics fill the whole sheet rather than a low popover: a header to
          step back to the art, and the words scrolling below it. */}
      {npLyrics && (
        <div
          className="npScreen__lyricsScrim"
          aria-hidden="true"
          onPointerDown={() => setNpLyrics(false)}
        />
      )}
      {npLyrics && (
        <div className="npScreen__lyricsView" role="dialog" aria-label="Lyrics">
          <header className="npScreen__lyricsHead">
            <span className="npScreen__lyricsTitle">{track?.title ?? 'Lyrics'}</span>
            <IconButton variant="ghost" aria-label="Close lyrics" onClick={() => setNpLyrics(false)}>
              <ChevronDown size={22} />
            </IconButton>
          </header>
          <div className="npScreen__lyricsBody">
            <LyricsPanel
              key={(track ?? IDLE_TRACK).path}
              track={track ?? IDLE_TRACK}
              position={position}
              onSeek={commitSeek}
            />
          </div>
        </div>
      )}
      {/* The queue, over the same sheet the same way: what plays next, drag-
          reorderable, each row a jump. */}
      {npQueue && (
        <div
          className="npScreen__lyricsScrim"
          aria-hidden="true"
          onPointerDown={() => setNpQueue(false)}
        />
      )}
      {npQueue && (
        <div className="npScreen__queueView">
          <QueuePanel
            queue={queue}
            current={track}
            onQueueChange={(next) => onQueueChange?.(next)}
            onPlayTrack={(t) => onTrackChange?.(t)}
            onClose={() => setNpQueue(false)}
          />
        </div>
      )}
      {/* The inactivity veil: near-black, fading in over everything on
          this sheet. It takes pointer events only while dimmed, so the
          waking tap lands here and nowhere else. */}
      <div
        className="npScreen__dim"
        data-dim={npDimmed || undefined}
        aria-hidden="true"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      </div>
    </>,
    document.body,
  );
}
