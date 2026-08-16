import { useEffect, useRef, useState } from 'react';

/**
 * Swiping the paused strip away.
 *
 * The strip is the transport, so while the music plays it stays put whatever
 * the finger does - a bar you can lose mid-song is a bar that loses you the
 * song. Paused, it is no longer a control but a leftover: the last thing
 * played, sitting across the bottom of every page, taking a band of screen
 * from whatever you moved on to. That one is worth being able to push away.
 *
 * So: pull it down and it goes, the same way it arrived - the rise animation
 * played backwards, off the bottom edge and behind the nav. It comes back on
 * its own the moment there is sound again, from this device or from another
 * one over Connect, because at that point it is a control once more and the
 * app owes you the controls.
 *
 * Down only, and never from the seek bar. Sideways is the scrubber's axis and
 * a bottom-anchored plate has one obvious way out; taking both would mean
 * guessing between them on every diagonal.
 */

/** Travel that counts as "away" on a slow drag. About a third of the plate. */
const THRESHOLD = 56;
/** A flick this fast dismisses from anywhere, in px/ms - the gesture people
 *  make when they have already decided and are not waiting to be measured. */
const FLICK = 0.45;
/** Movement before the gesture is judged. Under this a press is still a
 *  press, and the tap that lifts Now Playing still lands. */
const SLOP = 8;

/**
 * The gesture on its own, off React: one element, two things it can report.
 * Split out the way installShelfPan is, so the touch handling can be mounted
 * on any element and driven by real touches without a tree around it.
 *
 * `onClaim` reports whether this gesture has been recognised as a swipe:
 * false as each touch begins, true the moment a downward drag is claimed. The
 * caller holds it to swallow the click that trails every drag - which is why
 * it clears on the NEXT touch rather than at the end of this one, since the
 * click lands in between. `onDismiss` fires when a gesture finished past the
 * mark.
 */
export function installPlayerDismiss(
  shell: HTMLElement,
  { onClaim, onDismiss }: { onClaim: (claimed: boolean) => void; onDismiss: () => void },
): () => void {
  let touchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let dy = 0;
  let claimed = false;
  let velocity = 0;
  let lastY = 0;
  let lastAt = 0;

  const release = () => {
    touchId = null;
    claimed = false;
    delete shell.dataset.dragging;
    shell.style.removeProperty('--player-drag');
  };

  const onStart = (event: TouchEvent) => {
    // The last gesture's verdict has had its click by now.
    onClaim(false);
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const target = touch.target as HTMLElement | null;
    // The seek bar drags for a living; a scrub that wanders downward is
    // still a scrub.
    if (target?.closest?.('[role="slider"]')) return;
    touchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    dy = 0;
    claimed = false;
    velocity = 0;
    lastY = touch.clientY;
    lastAt = event.timeStamp;
  };

  const onMove = (event: TouchEvent) => {
    if (touchId === null) return;
    const touch = Array.from(event.touches).find(
      (t) => t.identifier === touchId,
    );
    if (!touch) return;
    dy = touch.clientY - startY;
    const dx = touch.clientX - startX;

    if (!claimed) {
      if (Math.abs(dy) < SLOP && Math.abs(dx) < SLOP) return;
      // Downward, and more downward than sideways. Anything else belongs to
      // whatever it started on - let go of it entirely rather than half
      // tracking a gesture that is not ours.
      if (dy <= 0 || Math.abs(dy) <= Math.abs(dx)) {
        touchId = null;
        return;
      }
      claimed = true;
      onClaim(true);
      shell.dataset.dragging = 'true';
    }

    // Keeps the drag from also firing the tap that lifts Now Playing, and
    // from becoming a click on whichever control it started over.
    if (event.cancelable) event.preventDefault();
    // Down follows the finger; up stops at the resting place, because there
    // is nowhere above for the strip to go.
    shell.style.setProperty('--player-drag', `${Math.max(0, dy)}px`);

    const dt = event.timeStamp - lastAt;
    if (dt > 0) {
      // Blended with the last reading so one jittery sample cannot pass for
      // a flick, while a real change of speed still registers quickly.
      velocity = 0.7 * ((touch.clientY - lastY) / dt) + 0.3 * velocity;
      lastY = touch.clientY;
      lastAt = event.timeStamp;
    }
  };

  const onEnd = () => {
    const decided = claimed && (dy > THRESHOLD || velocity > FLICK);
    touchId = null;
    claimed = false;
    if (decided) {
      // Left exactly as the finger left it. The dismissed rule carries it
      // the rest of the way and outranks the dragging one, so it picks the
      // plate up from here; letting go of the offset now would snap it back
      // to rest for the frame before React commits the attribute, and the
      // swipe would end in a bounce.
      onDismiss();
      return;
    }
    // Short of the mark, and the transition owns the way back: dropping the
    // offset IS the spring.
    release();
  };

  shell.addEventListener('touchstart', onStart, { passive: true });
  shell.addEventListener('touchmove', onMove, { passive: false });
  shell.addEventListener('touchend', onEnd, { passive: true });
  shell.addEventListener('touchcancel', onEnd, { passive: true });
  return () => {
    release();
    shell.removeEventListener('touchstart', onStart);
    shell.removeEventListener('touchmove', onMove);
    shell.removeEventListener('touchend', onEnd);
    shell.removeEventListener('touchcancel', onEnd);
  };
}

/** The React half: holds whether the strip is away, and puts it back the
 *  moment there is sound again. */
export function usePlayerDismiss(playing: boolean) {
  const [dismissed, setDismissed] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  /** True from the moment a swipe is claimed until the next touch begins, so
   *  the click that trails a drag does not also lift the Now Playing sheet. */
  const draggedRef = useRef(false);

  // Sound again - here or on whichever device took the seat - and the strip is
  // a control again, so it returns whether or not it was pushed away.
  useEffect(() => {
    if (playing) setDismissed(false);
  }, [playing]);

  useEffect(() => {
    const shell = shellRef.current;
    // Nothing to grab while it plays, and nothing to grab once it is gone.
    if (!shell || playing || dismissed) return;
    return installPlayerDismiss(shell, {
      onClaim: (claimed) => {
        draggedRef.current = claimed;
      },
      onDismiss: () => setDismissed(true),
    });
  }, [playing, dismissed]);

  return { dismissed, shellRef, draggedRef };
}
