import { useEffect, useRef } from 'react';
import { fireNativeHaptic } from './haptics.ts';

/**
 * The phone's back gesture: a drag in from the left edge walks the nav stack
 * back, and the page comes with your thumb while you decide.
 *
 * The dragging is the point. A gesture that only fires on release is a gesture
 * you cannot cancel and cannot learn - you either guessed the threshold or you
 * did not. Following the finger makes the threshold visible: the page is
 * either coming or it is not, and letting go early puts it back.
 *
 * Only from the EDGE, and only on touch. Anywhere else on the screen a
 * horizontal drag already means something - a shelf scrolls, the disc
 * scratches, a slider seeks - and a back gesture that could be started over any
 * of them would take turns stealing from all three. Twenty-four points is the
 * strip the OS itself reserves.
 */

/** How far in from the edge a drag may start. */
const EDGE = 24;
/** How far it has to travel to count, and how far before the page follows at
 *  all - a few points of slop so a vertical scroll that begins near the edge is
 *  not read as a back. */
const COMMIT = 72;
const SLOP = 12;

export function useSwipeBack(
  /** The element that moves. */
  ref: React.RefObject<HTMLElement | null>,
  onBack: () => void,
  enabled: boolean,
): void {
  // Held in a ref so the listeners are installed once and still see the current
  // answer - `enabled` flips on every navigation.
  const live = useRef({ onBack, enabled });
  live.current = { onBack, enabled };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let id: number | null = null;
    let startX = 0;
    let startY = 0;
    // Null until the drag has proven itself horizontal; false once it has
    // proven itself vertical, and then we stay out of the way for good.
    let horizontal: boolean | null = null;
    // Whether the drag currently stands past the commit point. The crossing
    // is a mechanical click - the page latching into "will go back" - and it
    // re-arms if the thumb retreats, so easing back and forth over the
    // threshold feels like working a detent, which is exactly what it is.
    let committed = false;

    const move = (x: number) => Math.max(0, x - startX);

    const paint = (dx: number, animate: boolean) => {
      el.style.transition = animate ? 'transform 0.22s var(--glacier-ease-out, ease-out)' : 'none';
      // Resistance past the commit point: the page keeps moving so the gesture
      // stays alive, but slower, which is what tells the thumb it has arrived.
      const shown = dx <= COMMIT ? dx : COMMIT + (dx - COMMIT) * 0.35;
      el.style.transform = dx > 0 ? `translate3d(${shown.toFixed(1)}px,0,0)` : '';
    };

    const clear = () => {
      id = null;
      horizontal = null;
      committed = false;
      el.style.transition = '';
      el.style.transform = '';
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || id !== null) return;
      if (!live.current.enabled) return;
      if (e.clientX > EDGE) return;
      id = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      horizontal = null;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (horizontal === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Whichever axis won the first few points owns the gesture.
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (!horizontal) {
          id = null;
          return;
        }
      }
      if (!horizontal) return;
      // Ours now: stop the page scrolling under the drag.
      e.preventDefault();
      const pulled = move(e.clientX);
      const past = pulled >= COMMIT;
      if (past !== committed) {
        committed = past;
        // Firmer going in than backing out: the latch engages, the release
        // just lets go.
        fireNativeHaptic(past ? 'light' : 'selection');
      }
      paint(pulled, false);
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      const dx = horizontal ? move(e.clientX) : 0;
      const go = dx >= COMMIT;
      const back = live.current.onBack;
      if (go) {
        // Let the page finish leaving before the new one replaces it, so the
        // gesture reads as one movement rather than a jump at the end.
        paint(window.innerWidth, true);
        window.setTimeout(() => {
          clear();
          back();
        }, 140);
        id = null;
        horizontal = null;
        return;
      }
      paint(0, true);
      const t = window.setTimeout(clear, 240);
      id = null;
      horizontal = null;
      return () => window.clearTimeout(t);
    };

    // Non-passive because the horizontal case calls preventDefault to keep the
    // scroller still while the page slides.
    el.addEventListener('pointerdown', onDown, { passive: true });
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp, { passive: true });
    el.addEventListener('pointercancel', onUp, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      clear();
    };
  }, [ref]);
}
