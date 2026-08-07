import { useEffect, useRef } from 'react';
import stationMark from '../assets/attack-wave.png';
import { BeatWave, type BeatWaveBeat } from './BeatWave.tsx';

/** One revolution every six seconds - the pace the old CSS keyframes set. */
const FULL_DEG_PER_SEC = 360 / 6;

/**
 * The player strip's artwork square, as a CD: the album art printed across
 * the whole disc face, a clear hub and spindle hole punched through it, and
 * an iridescent streak riding the surface. It turns while sound is actually
 * coming out - the same honesty rule as the rest of the strip's motion - and
 * holds where it stopped when the music does.
 *
 * The turn is driven by velocity rather than by a CSS animation, because a
 * platter does not stop on a frame: a pause brakes it to a standstill and a
 * play catches it back up to speed, over the same stretch the player's audio
 * ramp takes - press pause and the disc runs down exactly as the pitch does.
 * The ramp is linear in velocity, which is what constant friction does to a
 * real platter.
 *
 * Purely presentational: the strip's TrackInfo square gives it its size, the
 * Player hands it the art, whether to turn, and how long the motor takes.
 * Decorative to assistive tech - the title beside it already names what is
 * playing.
 */
export function SpinningDisc({
  art,
  spinning,
  beat = null,
  spinUpMs = 380,
  spinDownMs = 320,
}: {
  art: string | null;
  spinning: boolean;
  /**
   * The player's live beat. Only worn when there is no album art - the disc
   * then shows the station mark, and the mark's wave moves with the music.
   */
  beat?: BeatWaveBeat | null;
  /** How long the platter takes from standstill to full turn. 0 is a snap. */
  spinUpMs?: number;
  /** How long the brake takes to hold it still. 0 is a snap. */
  spinDownMs?: number;
}) {
  const faceRef = useRef<HTMLDivElement>(null);
  // Where the disc is and how fast it turns (as a 0..1 share of full speed).
  // Refs, not state: this moves at frame rate and React has no reason to know.
  const angle = useRef(0);
  const velocity = useRef(0);
  const frame = useRef(0);
  const last = useRef(0);

  // Read by the running loop through a ref, so a ramp-length change (the user
  // switching pause style mid-song) applies without restarting the loop.
  const params = useRef({ spinning, spinUpMs, spinDownMs });
  params.current = { spinning, spinUpMs, spinDownMs };

  useEffect(() => {
    // Stillness asked for is stillness given: the disc holds its face.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    cancelAnimationFrame(frame.current);
    last.current = performance.now();
    const tick = (now: number) => {
      // Clamped so a tab the OS stopped painting does not bank an hour of
      // rotation and release it as a spin-blur on the next frame.
      const dt = Math.min(0.1, (now - last.current) / 1000);
      last.current = now;
      const { spinning: on, spinUpMs: up, spinDownMs: down } = params.current;
      const target = on ? 1 : 0;
      const ms = on ? up : down;
      const step = ms <= 0 ? 1 : (dt * 1000) / ms;
      velocity.current =
        velocity.current < target
          ? Math.min(target, velocity.current + step)
          : Math.max(target, velocity.current - step);
      if (velocity.current > 0) {
        angle.current = (angle.current + velocity.current * FULL_DEG_PER_SEC * dt) % 360;
        faceRef.current?.style.setProperty('transform', `rotate(${angle.current.toFixed(2)}deg)`);
      }
      // Parked with nowhere to go: the loop ends rather than idling at 60fps
      // under a paused player. The next spin-up starts it again.
      if (velocity.current === 0 && target === 0) return;
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [spinning]);

  return (
    <div className="spinningDisc" aria-hidden="true">
      <div ref={faceRef} className="spinningDisc__face">
        {art ? (
          <img className="spinningDisc__art" src={art} alt="" />
        ) : (
          <BeatWave className="spinningDisc__art" beat={beat} />
        )}
      </div>
      {/* Everything the light does sits outside the turning face - the
          spectral hairlines and the glint on the hub plastic are reflections,
          and reflections hold still while the disc turns under them. */}
      <span className="spinningDisc__sheen" />
      <span className="spinningDisc__hub" />
    </div>
  );
}
