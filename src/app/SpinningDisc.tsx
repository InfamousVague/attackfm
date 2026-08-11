import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import stationMark from '../assets/attack-wave.png';
import { BeatWave, type BeatWaveBeat } from './BeatWave.tsx';

/** One revolution every six seconds - the pace the old CSS keyframes set. */
const FULL_DEG_PER_SEC = 360 / 6;

/**
 * How fast the platter runs while the track is still loading, as a multiple of
 * playing speed. A real CD spins up long before the laser reads anything, and
 * that whirr is the machine telling you it is working - which is exactly what a
 * buffering strip has to say and usually says with a spinner nobody reads.
 *
 * Bounded at just under 3x: past that the printed art smears into a grey ring
 * and stops reading as a disc at all.
 */
const SPOOL_RATE = 2.8;

/** Milliseconds per unit of velocity while spooling up - so the run to
 *  SPOOL_RATE takes a bit over a second, long enough to read as a ramp. */
const SPOOL_UP_MS = 420;

/** And coming back down to playing speed, which is a drop rather than a ramp:
 *  the disc catches the track the moment there is one, the way a transport
 *  clamps to speed when the read head locks. */
const SPOOL_SETTLE_MS = 150;

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
 * Mostly presentational: the strip's TrackInfo square gives it its size, the
 * Player hands it the art, whether to turn, and how long the motor takes.
 *
 * The one thing it is not presentational about is SCRATCHING. Given
 * `onScratch`, the face becomes draggable and the song follows your hand -
 * forward, backward, at whatever speed you turn it. The mapping is the disc's
 * own: it free-runs at one revolution per six seconds, so a drag at that speed
 * moves the song at 1x, twice that at 2x, and the other way runs it backwards.
 * Nothing is scaled or eased - the platter's real rate IS the rate, which is
 * what makes it feel like a surface rather than a slider in disguise.
 *
 * Decorative to assistive tech - the title beside it already names what is
 * playing, and the scrubber below is the accessible way to move through it.
 */
export function SpinningDisc({
  art,
  spinning,
  spooling = false,
  beat = null,
  spinUpMs = 380,
  spinDownMs = 320,
  onScratchStart,
  onScratch,
  onScratchEnd,
}: {
  art: string | null;
  spinning: boolean;
  /**
   * The track is loading. The platter runs up to SPOOL_RATE while this is
   * true and drops back to playing speed the moment it clears - so the wait
   * looks like a machine working rather than a UI stalling.
   */
  spooling?: boolean;
  /**
   * The player's live beat. Only worn when there is no album art - the disc
   * then shows the station mark, and the mark's wave moves with the music.
   */
  beat?: BeatWaveBeat | null;
  /** How long the platter takes from standstill to full turn. 0 is a snap. */
  spinUpMs?: number;
  /** How long the brake takes to hold it still. 0 is a snap. */
  spinDownMs?: number;
  /**
   * Dragging the face moves the song by this many seconds - negative to run it
   * backwards. Called on every pointer move of a drag; absent means the disc
   * is not draggable at all (the mini strip, where a drag is the gesture that
   * lifts the full-screen player).
   */
  onScratch?: (deltaSeconds: number) => void;
  /**
   * The hand has landed - fired on the touch itself, before any movement.
   * This is what makes touching the disc a transport gesture in its own
   * right: the player freezes the music under the finger (a hand on a record
   * stops it), and a release without a turn simply lets it roll on.
   */
  onScratchStart?: () => void;
  /** The hand came off. */
  onScratchEnd?: () => void;
}) {
  const faceRef = useRef<HTMLDivElement>(null);
  // Where the disc is and how fast it turns (as a 0..1 share of full speed).
  // Refs, not state: this moves at frame rate and React has no reason to know.
  const angle = useRef(0);
  const velocity = useRef(0);
  const frame = useRef(0);
  const last = useRef(0);
  // A hand on the platter. While this is true the motor stops adding rotation:
  // the disc is where the drag put it, and letting the two drive it at once is
  // how a scratch turns into a fight.
  const scratching = useRef(false);
  const lastTouchAngle = useRef(0);

  // Read by the running loop through a ref, so a ramp-length change (the user
  // switching pause style mid-song) applies without restarting the loop.
  const params = useRef({ spinning, spooling, spinUpMs, spinDownMs });
  params.current = { spinning, spooling, spinUpMs, spinDownMs };

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
      const { spinning: on, spooling: spool, spinUpMs: up, spinDownMs: down } = params.current;
      // Loading outranks playing: the disc spins up while the bytes are still
      // coming, whether or not sound has started.
      const target = spool ? SPOOL_RATE : on ? 1 : 0;
      const rising = velocity.current < target;
      // Four different ramps, and which one applies is a question about the
      // direction AND the destination: spooling up is its own slow build,
      // coming DOWN to a still-turning speed is the fast catch, and coming
      // down to zero is the ordinary brake the pause style bought.
      const ms = rising ? (spool ? SPOOL_UP_MS : up) : target > 0 ? SPOOL_SETTLE_MS : down;
      const step = ms <= 0 ? SPOOL_RATE : (dt * 1000) / ms;
      velocity.current =
        velocity.current < target
          ? Math.min(target, velocity.current + step)
          : Math.max(target, velocity.current - step);
      if (scratching.current) {
        // Held. Bleed the motor to a stop so releasing does not fling it, and
        // leave the face exactly where the hand left it.
        velocity.current = 0;
        frame.current = requestAnimationFrame(tick);
        return;
      }
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
    // `spooling` restarts the loop as well as `spinning`: a disc parked at a
    // standstill has ended its loop, and a track that starts loading has to be
    // able to set it turning again.
  }, [spinning, spooling]);

  /** The pointer's angle around the disc's centre, in degrees. */
  const angleAt = (e: { clientX: number; clientY: number }): number | null => {
    const box = faceRef.current?.parentElement?.getBoundingClientRect();
    if (!box) return null;
    const dx = e.clientX - (box.left + box.width / 2);
    const dy = e.clientY - (box.top + box.height / 2);
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onScratch) return;
    const a = angleAt(e);
    if (a === null) return;
    scratching.current = true;
    lastTouchAngle.current = a;
    // Capture, so a finger that slides off the disc mid-drag keeps scratching
    // rather than handing the gesture to whatever it slid onto.
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    onScratchStart?.();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scratching.current || !onScratch) return;
    const a = angleAt(e);
    if (a === null) return;
    // Shortest way round: crossing the -180/180 seam is a small move, not a
    // full turn in the opposite direction.
    let delta = a - lastTouchAngle.current;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    lastTouchAngle.current = a;
    angle.current = (angle.current + delta) % 360;
    faceRef.current?.style.setProperty('transform', `rotate(${angle.current.toFixed(2)}deg)`);
    // The disc's own rate is the conversion: FULL_DEG_PER_SEC of turn is one
    // second of song, so turning it at its free-running speed plays at 1x.
    onScratch(delta / FULL_DEG_PER_SEC);
  };

  const endScratch = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scratching.current) return;
    scratching.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onScratchEnd?.();
  };

  return (
    <div
      className="spinningDisc"
      aria-hidden="true"
      data-scratchable={onScratch ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endScratch}
      onPointerCancel={endScratch}
    >
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
