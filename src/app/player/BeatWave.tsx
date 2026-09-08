import { useMemo } from 'react';
import { usePrefersReducedMotion } from '../ux/useReducedMotion.ts';
import {
  SAMPLES,
  WAVE_MID_Y,
  WAVE_SHADOW_DROP,
  baseOffset,
  clamp01,
} from './beatWave.ts';

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
    const y = WAVE_MID_Y + drop + signed;
    parts.push(`${k === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(' ');
}

/** The mark at rest, computed once - it depends on nothing. */
const STATIC_PATHS = {
  shadow: wavePath(1, null, 0, WAVE_SHADOW_DROP),
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
      shadow: wavePath(shadowSwell, beat, TRACER_LAG, WAVE_SHADOW_DROP),
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
