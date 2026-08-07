import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';

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

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
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
export function NowPlayingBackdrop({ artwork, seed }: { artwork: string; seed: string }) {
  const { meter, audible } = useNowPlayingMotion();
  // The reading lands on the container rather than on the art, so every layer
  // under it - art, the soft copy, the glow - reads the same number.
  const stageRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const { mood, vars } = useMemo(() => lookFor(seed), [seed]);

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
      aria-hidden="true"
    >
      {/* The drift owns the slow travel, the art under it owns the answer to the
          music. Two layers because both want `translate` and `rotate`, and one
          element has only one of each to give. */}
      <div className="npDrift" style={vars}>
        <div className="npArt" style={cover} />
        {/* Only `focus` has a use for a second copy, and a blurred layer is not
            free, so nothing else pays for one. */}
        {mood === 'focus' && <div className="npArt npArtSoft" style={cover} />}
      </div>
      <div className="npGlow" />
    </div>
  );
}
