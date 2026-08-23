import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { LyricLine } from '@glacier/react';
import { fetchLyrics } from './lyrics.ts';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { usePlayback } from './playback.tsx';
import { usePrefersReducedMotion } from '../ux/useReducedMotion.ts';
import type { Track } from '../core/tauri.ts';

/**
 * How fast the follower falls once the music does. Attack is instant - a hit
 * should land on the frame it happens - and only the fall is eased, which is
 * what turns a jittery meter into something that reads as a pulse.
 */
const RELEASE = 0.12;
/**
 * How fast the reference the transient is measured against tracks the music.
 * Slow enough to sit at roughly the current passage's loudness, so a hit is
 * judged against what came just before it rather than against silence.
 */
const TRACKING = 0.012;
/** Turns "how far above the passage" into 0..1. */
const PUNCH = 6;
/** Turns the passage's own loudness into 0..1. */
const BODY = 1;
/**
 * The mix of the two. Each is held to 0..1 before this, which is what keeps a
 * loud master from spending the whole range on body and pinning everything
 * open - a pegged reading is a light left on, not a pulse.
 */
const TRANSIENT_SHARE = 0.45;
const BODY_SHARE = 0.3;

/**
 * How a track answers the music. Every mood keeps the same slow drift and the
 * same reading behind it; what changes is where that reading is spent, because
 * one response applied to everything reads as the same effect every time - a
 * scale on its own is just a zoom, however well it is timed.
 *
 * - `bloom`  swells toward you on the hit
 * - `sway`   is shoved sideways, along an axis of its own
 * - `tilt`   rocks about its centre
 * - `focus`  pulls into focus out of a softer copy of itself
 * - `flare`  lights from the top, the accent blooming through the art
 */
const MOODS = ['bloom', 'sway', 'tilt', 'focus', 'flare'] as const;
type Mood = (typeof MOODS)[number];

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** FNV-1a. Any stable spread of bits will do; this one is short. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** xorshift32 off that hash: the same track always draws the same numbers. */
function seeded(seed: string): () => number {
  let state = hash(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/**
 * The look a track is given: which mood answers the music, where the art
 * travels while it plays, how long that takes, and where in the journey it
 * starts. All of it seeded off the file path, so a song moves the same way
 * every time it is played and no two songs move alike.
 *
 * Nothing here touches colour. The cover is the one honest thing on screen, and
 * tinting it per track would make the album look like something it is not.
 */
function lookFor(seed: string): { mood: Mood; vars: CSSProperties } {
  const random = seeded(seed);
  const mood = MOODS[Math.floor(random() * MOODS.length)]!;
  const angle = random() * Math.PI * 2;
  // Wider than it is tall: the box is a short strip, so vertical travel shows
  // the mask's edge long before horizontal travel runs out of cover.
  const travel = 1.0 + random() * 1.2;
  const cycle = 17 + random() * 16;
  // The shove `sway` spends its reading on, along an axis of the track's own -
  // deliberately not the drift's, so the two read as separate movements rather
  // than one that occasionally speeds up.
  const kick = random() * Math.PI * 2;
  const shove = 0.3 + random() * 0.4;

  return {
    mood,
    vars: {
      '--np-drift-x': `${(Math.cos(angle) * travel).toFixed(2)}rem`,
      '--np-drift-y': `${(Math.sin(angle) * travel * 0.45).toFixed(2)}rem`,
      '--np-spin': `${((random() - 0.5) * 2).toFixed(2)}deg`,
      '--np-zoom': (1.1 + random() * 0.05).toFixed(3),
      '--np-cycle': `${cycle.toFixed(1)}s`,
      // A negative delay starts the track partway through its own drift, so two
      // songs in a row do not both begin by sliding the same way at once.
      '--np-delay': `${(-random() * cycle).toFixed(1)}s`,
      '--np-kick-x': `${(Math.cos(kick) * shove).toFixed(2)}rem`,
      '--np-kick-y': `${(Math.sin(kick) * shove * 0.5).toFixed(2)}rem`,
      '--np-kick-rot': `${((random() < 0.5 ? -1 : 1) * (0.4 + random() * 0.6)).toFixed(2)}deg`,
    } as CSSProperties,
  };
}

/**
 * A ceiling on words per line, high enough that no real lyric reaches it -
 * a line IS shown whole, the type shrinking to fit rather than the words
 * being dropped. This only guards against a malformed sheet handing over a
 * paragraph as one line.
 */
const WORDS_PER_LINE = 16;

/**
 * The share of its slot a stacked word actually takes. A font's ink is
 * taller than its em box - ascenders and descenders both overshoot - so a
 * column sized to exactly fill the band still clips at the ends. This is the
 * margin that makes "it fits" true of the glyphs, not just the boxes.
 */
const STACK_FILL = 0.82;

/**
 * How wide a capital is, as a share of the font size, in the stack's heavy
 * uppercase. Used to cap a long word by the stage's WIDTH as well as its
 * height: whichever bound bites first is the one that sizes the word, so
 * nothing runs off the side either.
 *
 * MEASURED, not guessed. This was 0.62, which is about right for an average
 * Latin lowercase and far too narrow for Inter's 800-weight caps with the
 * stack's letter-spacing on top - so words were sized to a width they then
 * overran, and `.npStackWord`'s overflow clipped their right-hand ends. Real
 * ratios at that weight: ILL 0.49, POLICE 0.63, EVERYTHING 0.68, KARMA 0.80,
 * WOMAN 0.88, MOM 0.91. Hence 0.95 - it covers every real word measured, and
 * the only things past it (MMM, WWW) are not words.
 *
 * It is a CEILING, so raising it does not shrink the type generally: the
 * height share still wins for everything that was already fitting, and only
 * the words that were overrunning come down.
 */
const CAP_ASPECT = 0.95;

/**
 * The four ways a line can take the air - COMPOSITIONS, not costumes: each
 * lays the text out differently, not merely animates the same scatter.
 *
 * Which one is used is the listener's, in Playback settings: a way by name,
 * `random` for a fresh draw on every skip (one spin per mount, and the
 * backdrop remounts per track), or `off` for a hero with no words at all.
 *
 * - `scatter`    words surface each in a place of their own and dissolve
 * - `typewriter` the line types itself out in the bottom-right corner,
 *                cursor and all
 * - `poster`     every line's words STAY, packing the header tighter -
 *                large against small - until the page is full, then it
 *                turns and the fill begins again
 * - `stack`      the words drop into a hard left column of tall capitals,
 *                one under another
 */
const WORD_WAYS = ['scatter', 'typewriter', 'poster', 'stack'] as const;
type WordWay = (typeof WORD_WAYS)[number];

/** Trailing and leading punctuation, shed so a word floats as a word. */
const TRIM = /^["'“”‘’(\[]+|["'“”‘’)\],.!?;:]+$/g;

/** A line's text as the words the ways render, trimmed and capped. */
function wordsOf(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(TRIM, ''))
    .filter(Boolean)
    .slice(0, WORDS_PER_LINE);
}

/** Scatter: each word surfaces in a seeded place of its own and dissolves. */
function ScatterLine({ path, active, words, life }: LineProps) {
  return (
    <>
      {words.map((word, index) => {
        const random = seeded(`${path}#${active}#${index}#${word}`);
        const count = words.length;
        const delay = (index / count) * life * 0.5;
        // Across the stage, which is already the right-hand band; the tail
        // margin keeps a long word from running off the window's edge.
        const x = 4 + random() * 52;
        const y = 6 + (index / Math.max(1, count - 1)) * 64 + random() * 14;
        const rotate = (random() - 0.5) * 14;
        // A share of the stage's height, so words scale with the band rather
        // than overflowing a short one. Long words shrink toward the whisper
        // end so nothing shouts.
        const size = (11 + random() * 11) * Math.min(1.15, Math.max(0.55, 6 / word.length));
        const peak = 0.45 + random() * 0.28;
        return (
          <span
            key={`${active}-${index}`}
            className="npWord"
            style={
              {
                left: `${x.toFixed(1)}%`,
                top: `${y.toFixed(1)}%`,
                fontSize: `${size.toFixed(2)}cqh`,
                animationDelay: `${delay.toFixed(2)}s`,
                animationDuration: `${(life - delay).toFixed(2)}s`,
                '--hw-rot': `${rotate.toFixed(1)}deg`,
                '--hw-peak': peak.toFixed(2),
              } as CSSProperties
            }
          >
            {word}
          </span>
        );
      })}
    </>
  );
}

/**
 * Typewriter: the whole line types itself out in the bottom-right corner,
 * character by character behind a blinking cursor - a margin note being
 * kept while the song plays.
 */
function TypewriterLine({ active, words, life }: LineProps) {
  // The whole line, never a slice: a long one sets smaller (the size cap
  // below scales with the character count) rather than stopping mid-word.
  const text = words.join(' ');
  const chars = [...text];
  // The whole line is typed by 45% of its life, evenly, but never slower
  // than a human hand or the short lines dawdle.
  const step = Math.min(0.07, (life * 0.45) / Math.max(1, chars.length));
  return (
    <div
      key={active}
      className="npTypeLine"
      style={
        {
          animationDuration: `${life.toFixed(2)}s`,
          // Mono, so width is simply the character count: this is the size at
          // which the line fills about two wrapped rows of the stage. The CSS
          // caps it against the stage's height as well.
          '--hw-type-size': `${(320 / Math.max(12, chars.length)).toFixed(2)}cqw`,
        } as CSSProperties
      }
    >
      {chars.map((char, index) => (
        <span
          key={index}
          className="npTypeChar"
          style={{ animationDelay: `${(index * step).toFixed(3)}s` }}
        >
          {char}
        </span>
      ))}
      <span className="npTypeCursor" />
    </div>
  );
}

/**
 * How many rows the poster sets, and the character budget each row holds.
 * The budget approximates what a banner-wide row of mixed type actually
 * fits (~60 characters at these sizes): too small and the page turns every
 * other line, and the poster never reads as filling.
 */
const POSTER_ROWS = 4;
const POSTER_ROW_BUDGET = 60;

interface PosterCell {
  word: string;
  line: number;
  size: number;
  weight: number;
  peak: number;
}

/**
 * Poster: the one way that KEEPS what the song has said. Every line's words
 * are added to the page, large against small, packing the rows tighter -
 * and only when a word no longer fits anywhere does the page turn and the
 * fill begin again from that line.
 *
 * Derived, not accumulated in state: the whole page is recomputed from the
 * line history on every render, walking from the top and turning pages
 * wherever they would have turned. Re-renders redraw the identical page,
 * and a seek lands on exactly the page that moment would always have shown.
 */
function PosterLine({ path, active, lines, life }: LineProps) {
  let pageStart = 0;
  let rows: PosterCell[][] = Array.from({ length: POSTER_ROWS }, () => []);
  let budgets = Array.from({ length: POSTER_ROWS }, () => POSTER_ROW_BUDGET);

  const freshPage = () => {
    rows = Array.from({ length: POSTER_ROWS }, () => []);
    budgets = Array.from({ length: POSTER_ROWS }, () => POSTER_ROW_BUDGET);
  };
  const place = (cell: PosterCell): boolean => {
    const cost = Math.max(3, cell.word.length) * (cell.size > 14 ? 1.5 : 1);
    for (let row = 0; row < POSTER_ROWS; row += 1) {
      if (budgets[row]! >= cost && rows[row]!.length < 10) {
        rows[row]!.push(cell);
        budgets[row]! -= cost;
        return true;
      }
    }
    return false;
  };

  /*
   * The walk starts a window back, not at the beginning of time.
   *
   * For a song this loop was the whole history - sixty lines, nothing. A book
   * transcript resumed hours in made it tens of thousands of lines times
   * every word, re-run on every position tick: measured at ~32ms a tick in
   * plain Node, several times that on a phone, forever. Only the CURRENT page
   * is ever displayed, so the composition only needs enough history to fill
   * a few pages. The start is quantised so it moves in steps rather than
   * sliding per line - a sliding start would recompose the whole page on
   * every advance.
   */
  const POSTER_WINDOW = 48;
  const start = Math.max(0, Math.floor((active - POSTER_WINDOW) / POSTER_WINDOW) * POSTER_WINDOW);
  pageStart = start;
  for (let index = start; index <= active; index += 1) {
    const lineWords = wordsOf(lines[index]!.text);
    for (const [wordIndex, word] of lineWords.entries()) {
      const random = seeded(`${path}#${index}#${wordIndex}#${word}`);
      const cell: PosterCell = {
        word,
        line: index,
        // A share of the stage's height, so four rows of these always fit
        // the band: the tallest cell is a fifth of it.
        size: 8 + random() * 12,
        weight: [550, 700, 800][Math.floor(random() * 3)]!,
        peak: 0.4 + random() * 0.26,
      };
      if (!place(cell)) {
        // The page is full: turn it, and this word opens the next one.
        pageStart = index;
        freshPage();
        place(cell);
      }
    }
  }

  return (
    <div key={`page-${pageStart}`} className="npPoster">
      {rows.map((cells, rowIndex) => (
        <div key={rowIndex} className="npPosterRow">
          {cells.map((cell, cellIndex) => {
            const random = seeded(`${path}#pop#${cell.line}#${cellIndex}`);
            return (
              <span
                // Keyed by line and slot: cells from earlier lines keep their
                // DOM (and their finished pop) as later lines join the page.
                key={`${cell.line}-${cellIndex}`}
                className="npPosterWord"
                style={
                  {
                    fontSize: `${cell.size.toFixed(2)}cqh`,
                    fontWeight: cell.weight,
                    // Only the newest line's words are still arriving; the
                    // rest sit as they landed.
                    animationDelay:
                      cell.line === active ? `${(random() * life * 0.4).toFixed(2)}s` : '0s',
                    '--hw-peak': cell.peak.toFixed(2),
                  } as CSSProperties
                }
              >
                {cell.word}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Stack: the words drop one under another into a column of tall capitals.
 *
 * Sized in `cqh` - a share of the stage's own height - and divided so the
 * whole column always fits: five words get a fifth of the band each, three
 * get a third, and the line-height allowance is taken off the top. A column
 * that cannot overflow needs no clamping after the fact.
 */
function StackLine({ path, active, words, life }: LineProps) {
  const random = seeded(`${path}#${active}#stack`);
  // Every word of the line, however many: the column divides the band by the
  // word count, so a long line simply sets smaller. Nothing is dropped.
  const share = (100 / words.length) * STACK_FILL;
  return (
    <div
      key={active}
      className="npStack"
      style={{ animationDuration: `${life.toFixed(2)}s` } as CSSProperties}
    >
      {words.map((word, index) => (
        <span
          key={index}
          className="npStackWord"
          style={
            {
              // Whichever bound bites first: the word's share of the height,
              // or the width a word of this length can have and still fit.
              // The floor guards against a container reporting no size yet
              // resolving this to literal zero - and is deliberately tiny,
              // because a generous one would OVERRIDE the fit on a short
              // stage and push the column past its end (which is how the
              // last word of a long line used to disappear).
              fontSize: `max(0.4rem, min(${(share * (0.82 + random() * 0.18)).toFixed(
                2,
              )}cqh, ${(96 / (word.length * CAP_ASPECT)).toFixed(2)}cqw))`,
              animationDelay: `${((index / words.length) * life * 0.35).toFixed(2)}s`,
              '--hw-peak': (0.5 + random() * 0.28).toFixed(2),
            } as CSSProperties
          }
        >
          {word}
        </span>
      ))}
    </div>
  );
}

interface LineProps {
  path: string;
  active: number;
  /** The active line's words, trimmed and capped. */
  words: string[];
  /** The full synced sheet, for the ways that read history (the poster). */
  lines: LyricLine[];
  life: number;
}

const WAY_RENDERERS: Record<WordWay, (props: LineProps) => ReactElement> = {
  scatter: (p) => <ScatterLine {...p} />,
  typewriter: (p) => <TypewriterLine {...p} />,
  poster: (p) => <PosterLine {...p} />,
  stack: (p) => <StackLine {...p} />,
};

/**
 * The song's own words, rendered over the wash while it plays, in whichever
 * of the five ways this skip drew.
 *
 * Pure decoration, and deliberately less than legible: low opacity, blended
 * into the art, gone before the next line takes over. Layouts are seeded off
 * the track and line, so re-renders (the position ticks every second) redraw
 * everything exactly where it already stands; and every way's container (or
 * each scatter word) animates to nothing by the line's own end, so the
 * handoff between lines needs no choreography.
 *
 * Synced lyrics only: without times there is nothing to spell along to.
 */
function HeroWords({
  track,
  position,
  audible,
  way,
}: {
  track: Track;
  position: number;
  audible: boolean;
  way: WordWay;
}) {
  const [lines, setLines] = useState<LyricLine[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLines(null);
    void fetchLyrics(track).then((found) => {
      if (!cancelled) setLines(found.synced);
    });
    return () => {
      cancelled = true;
    };
  }, [track]);

  const active = useMemo(() => {
    if (!lines) return -1;
    return lines.reduce((found, line, index) => (line.time <= position ? index : found), -1);
  }, [lines, position]);

  if (!lines || active < 0) return null;
  const line = lines[active]!;
  const next = lines[active + 1];
  // How long this line has the air: until the next one, within reason.
  const life = Math.min(7, Math.max(2.5, next ? next.time - line.time : 5));
  const words = wordsOf(line.text);
  if (words.length === 0) return null;

  return (
    <div className="npWords" data-way={way} data-quiet={!audible || undefined}>
      {WAY_RENDERERS[way]({ path: track.path, active, words, lines, life })}
    </div>
  );
}

/**
 * The playing track's cover, blurred into a wash behind the top of the window
 * and moving to what is playing: a slow drift the track is given for itself,
 * and a response on every hit the analyser reads.
 *
 * The reading is written as a custom property rather than a class or a keyframe
 * because it is continuous, not a state - there is no "beat on" to switch to,
 * just a number rising and falling sixty times a second, which the stylesheet
 * spends differently depending on the mood the track drew.
 */
export function NowPlayingBackdrop({
  artwork,
  seed,
  wordsOnly = false,
}: {
  artwork: string;
  seed: string;
  /** Render only the lyric words, no art wash - for a surface that already
   *  carries its own cover behind, like the Now Playing sheet. */
  wordsOnly?: boolean;
}) {
  const { meter, audible, track, position } = useNowPlayingMotion();
  // The reading lands on the container rather than on the art, so every layer
  // under it - art, the soft copy, the glow - reads the same number.
  const stageRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const { mood, vars } = useMemo(() => lookFor(seed), [seed]);
  // The way is the listener's, from Playback settings. Under `random` it is a
  // fresh draw per mount - and the backdrop mounts per track, so every skip
  // respins it; Math.random, not the seeded rng, on purpose: the moods belong
  // to the song, the way it speaks belongs to the moment. The draw is made
  // whatever the setting says, so switching to random and back mid-song does
  // not respin what is already on screen.
  const { lyricWay } = usePlayback();
  const drawnWay = useMemo<WordWay>(
    () => WORD_WAYS[Math.floor(Math.random() * WORD_WAYS.length)]!,
    [],
  );
  const wordWay: WordWay | null =
    lyricWay === 'off' ? null : lyricWay === 'random' ? drawnWay : lyricWay;

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const rest = () => node.style.setProperty('--np-pulse', '0');
    if (!meter || !audible || reduced) {
      rest();
      return;
    }

    let frame = 0;
    // The follower's fall, and the passage loudness a transient is measured
    // against.
    let envelope = 0;
    let reference = 0;
    const tick = () => {
      const level = meter();
      envelope = level > envelope ? level : envelope + (level - envelope) * RELEASE;
      reference += (level - reference) * TRACKING;
      const transient = clamp01((envelope - reference) * PUNCH);
      const body = clamp01(envelope * BODY);
      const pulse = clamp01(transient * TRANSIENT_SHARE + body * BODY_SHARE);
      // Three decimals: enough to be smooth, short enough that the string this
      // builds sixty times a second stays cheap.
      node.style.setProperty('--np-pulse', pulse.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      rest();
    };
  }, [meter, audible, reduced]);

  const cover = { backgroundImage: `url("${artwork}")` };

  return (
    <div
      className="nowPlayingBackdrop"
      ref={stageRef}
      data-mood={mood}
      data-still={reduced || undefined}
      data-words-only={wordsOnly || undefined}
      aria-hidden="true"
    >
      {/* The drift owns the slow travel, the art under it owns the answer to the
          music. Two layers because both want `translate` and `rotate`, and one
          element has only one of each to give. Skipped in words-only mode - the
          surface below already wears the cover. */}
      {!wordsOnly && (
        <>
          <div className="npDrift" style={vars}>
            <div className="npArt" style={cover} />
            {/* Only `focus` has a use for a second copy, and a blurred layer is
                not free, so nothing else pays for one. */}
            {mood === 'focus' && <div className="npArt npArtSoft" style={cover} />}
          </div>
          <div className="npGlow" />
        </>
      )}
      {/* The words ride inside the masked box, so they share its fade toward
          the list and can never stray over legible content. Motion-reduced
          windows skip them whole: they are nothing BUT motion. */}
      {track && wordWay && !reduced && (
        <HeroWords track={track} position={position} audible={audible} way={wordWay} />
      )}
    </div>
  );
}
