import { useMemo } from 'react';
import { usePrefersReducedMotion } from '../ux/useReducedMotion.ts';

/**
 * The attack wave, alive: the station mark's squiggle redrawn as an inline
 * SVG that moves with the music. At rest it is the brand mark - the white
 * wave over its grey shadow on black - and while sound is coming out it
 * breathes with the beat the player already tracks for the seek bar: the
 * whole wave swells on the pulse, each hit travels outward along it as a
 * crest, and the shadow copy swings wider and lets go later, the same
 * tracer grammar the kit's SeekBar uses.
 *
 * Purely presentational and cheap on purpose: the Player re-renders every
 * frame while music is audible anyway (that is how the seek bar moves), so
 * this only samples ~70 points off the beat it is handed - no timers, no
 * loops of its own. Reduced motion, or no beat at all, is simply the static
 * mark.
 */

/** The beat as the player's useBeat hands it over (structural, kit-compatible). */
export interface BeatWaveBeat {
  /** A steady swell of the whole wave, 0..1: jumps on a hit, falls between them. */
  pulse: number;
  /** The hits still travelling, each rippling out from where it landed. */
  ripples: readonly { at: number; age: number; strength: number }[];
}

/**
 * The mark's silhouette as (u, dy) control points: u across the wave 0..1,
 * dy the offset from the midline in viewBox units (negative is up). Traced
 * off the 1024px asset - flat lead-in, the small hump, the big peak, the
 * deep dip, and the little upward hook the tail ends on.
 */
const SHAPE: readonly (readonly [number, number])[] = [
  // Doubled flat points pin the lead-in level before the first hump rises.
  [0, 0.5],
  [0.045, 0.5],
  [0.09, 0.5],
  [0.165, -3.5],
  [0.245, -11.5],
  [0.34, -1.5],
  [0.435, 9.5],
  [0.53, -5.5],
  [0.625, -26],
  [0.725, -9.5],
  [0.81, 15],
  [0.885, 8.5],
  [0.95, -1],
  [1, -2.5],
];

/** How many segments each run is drawn as; at icon sizes the corners vanish. */
const SAMPLES = 72;

/** How much taller the wave stands at full pulse - breathing, not bouncing. */
const PULSE_DEPTH = 0.3;

/** Peak deflection a travelling crest adds, in viewBox units. */
const RIPPLE_LIFT = 7;

/** How far along the wave a crest travels over its life. */
const RIPPLE_REACH = 0.4;

/** Half-width of a crest - narrow, so a beat reads as a passing bump. */
const RIPPLE_WIDTH = 0.09;

/** How much harder the beat drives the shadow than the wave (the kit's tracer gain). */
const TRACER_GAIN = 2.1;

/** How far behind the wave the shadow's crests run, as a fraction of a ripple's life. */
const TRACER_LAG = 0.45;

/** Where the midline sits and how the static shadow hangs off the mark. */
const MID_Y = 54;
const SHADOW_DROP = 3;

const clamp01 = (n: number): number => (Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0);

/** The control point at a clamped index - the ends repeat, which is what
 * Catmull-Rom wants at a curve's edges anyway. */
function point(i: number): readonly [number, number] {
  return SHAPE[Math.min(SHAPE.length - 1, Math.max(0, i))] ?? [0, 0];
}

/** Catmull-Rom through the control points, sampled at u. */
function baseOffset(u: number): number {
  const t = clamp01(u);
  let i = SHAPE.length - 2;
  for (let k = 1; k < SHAPE.length; k += 1) {
    if (t <= point(k)[0]) {
      i = k - 1;
      break;
    }
  }
  const p0 = point(i - 1);
  const p1 = point(i);
  const p2 = point(i + 1);
  const p3 = point(i + 2);
  const span = p2[0] - p1[0] || 1;
  const s = (t - p1[0]) / span;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    0.5 *
    (2 * p1[1] +
      (p2[1] - p0[1]) * s +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s2 +
      (p3[1] - p0[1] + 3 * (p1[1] - p2[1])) * s3)
  );
}

/** The crests' extra deflection at a point - the kit SeekBar's ripple, verbatim in spirit. */
function rippleLift(
  u: number,
  ripples: BeatWaveBeat['ripples'],
  ageShift: number,
): number {
  let lift = 0;
  for (const ripple of ripples) {
    if (ripple.age - ageShift < 0) continue;
    // The lagged pass lives in the ripple's remaining life, compressed to a
    // whole one - so a shadow crest completes its travel and fade instead of
    // being cut off at the fraction the lag left it - and eases in over its
    // first moments rather than popping in at full weight half a beat late.
    const age =
      ageShift > 0
        ? clamp01((ripple.age - ageShift) / (1 - ageShift))
        : clamp01(ripple.age);
    const fadeIn = ageShift > 0 ? clamp01((ripple.age - ageShift) / 0.06) : 1;
    const front = age * RIPPLE_REACH;
    const offset = (Math.abs(u - clamp01(ripple.at)) - front) / RIPPLE_WIDTH;
    lift += Math.exp(-offset * offset) * (1 - age) * fadeIn * clamp01(ripple.strength);
  }
  return lift;
}

/**
 * The beat's drive on the shadow a moment ago: hits land at full weight the
 * same frame as on the wave, but decay across the ripple's whole life rather
 * than with the short pulse - so the wave drops out from under a shadow still
 * holding the last beat.
 */
function laggedEnergy(beat: BeatWaveBeat): number {
  if (beat.ripples.length === 0) return clamp01(beat.pulse);
  let energy = 0;
  for (const ripple of beat.ripples) {
    energy = Math.max(energy, clamp01(ripple.strength) * (1 - clamp01(ripple.age)));
  }
  return energy;
}

/**
 * The mark's silhouette at a given swell, sampled as (x, dy) pairs in the
 * 0..100 viewBox: x across the wave, dy the offset from the midline. The dock
 * icon's frame renderer draws from this so the icon and the in-app mark are
 * the same wave at every energy level.
 */
export function sampleWave(swell: number, samples = SAMPLES): Array<readonly [number, number]> {
  const points: Array<readonly [number, number]> = [];
  for (let k = 0; k <= samples; k += 1) {
    const u = k / samples;
    points.push([8 + u * 84, baseOffset(u) * swell]);
  }
  return points;
}

/** Where the midline sits and how far the shadow hangs, in viewBox units. */
export const WAVE_MID_Y = MID_Y;
export const WAVE_SHADOW_DROP = SHADOW_DROP;

/** One run of the wave as an SVG path, deformed by swell + crests. */
function wavePath(swell: number, beat: BeatWaveBeat | null, agesBack: number, drop: number): string {
  const parts: string[] = [];
  for (let k = 0; k <= SAMPLES; k += 1) {
    const u = k / SAMPLES;
    const dy = baseOffset(u) * swell;
    const lift = beat ? rippleLift(u, beat.ripples, agesBack) * RIPPLE_LIFT : 0;
    // Crests lift the wave upward, everywhere: a signed push flips direction
    // at every midline crossing, which draws as a vertical tear when a
    // travelling crest passes one.
    const signed = dy - lift;
    const x = 8 + u * 84;
    const y = MID_Y + drop + signed;
    parts.push(`${k === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(' ');
}

/** The mark at rest, computed once - it depends on nothing. */
const STATIC_PATHS = {
  shadow: wavePath(1, null, 0, SHADOW_DROP),
  wave: wavePath(1, null, 0, 0),
};

export function BeatWave({
  beat,
  className,
  background = '#000',
}: {
  /** The player's live beat; null or at rest renders the static mark. */
  beat: BeatWaveBeat | null;
  className?: string;
  /** The plate behind the wave; the asset's is black. */
  background?: string;
}) {
  // Stillness asked for is stillness given - live, so flipping the OS setting
  // mid-session settles the mark without a reload.
  const still = usePrefersReducedMotion();

  const live = !still && beat !== null && (beat.pulse > 0.001 || beat.ripples.length > 0);

  const paths = useMemo(() => {
    if (!live || !beat) return STATIC_PATHS;
    const swell = 1 + clamp01(beat.pulse) * PULSE_DEPTH;
    const shadowSwell = 1 + clamp01(laggedEnergy(beat)) * PULSE_DEPTH * TRACER_GAIN;
    return {
      shadow: wavePath(shadowSwell, beat, TRACER_LAG, SHADOW_DROP),
      wave: wavePath(swell, beat, 0, 0),
    };
    // The beat object is a fresh identity every animated frame, so memoising on
    // it is exactly per-frame work - and a paused player hands the shared
    // at-rest beat, where this collapses to the static constant.
  }, [beat, live]);

  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <rect width="100" height="100" fill={background} />
      <path
        d={paths.shadow}
        fill="none"
        stroke="#8a8a8a"
        strokeWidth={4.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={paths.wave}
        fill="none"
        stroke="#fff"
        strokeWidth={4.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
