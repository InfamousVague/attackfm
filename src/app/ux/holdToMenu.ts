import { useMemo, useRef } from 'react';
import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from 'react';
import { fireNativeHaptic } from '../core/haptics.ts';

/**
 * Press-and-hold opens a context menu, and the finger that opened it does not
 * also play the song.
 *
 * The kit's ContextMenu already opens on a touch long-press, and at first
 * glance that is the whole job. It is not, for two reasons that only show up
 * on a real row in a real list:
 *
 * THE RELEASE STILL CLICKS. The kit opens the panel at 500ms and then does
 * nothing about the pointerup that follows - so the row underneath, whose job
 * is "tap to play", gets a click the moment the finger lifts, and the song
 * starts under the menu that was just summoned. Holding a song to file it in
 * a playlist should not start it playing; that is the one thing the hold was
 * supposed to be instead of. The click is swallowed here, in the capture phase
 * on the same element, so the row's own handler never sees it.
 *
 * THE TARGET IS NOT THE ROW. In the song table the menu wraps the title cell
 * alone, because the kit's grid renders the rows and cannot be told to wrap
 * them. A hold on the date, the album, the clock - most of a wide row - fell
 * through to nothing. The hook takes a `find` that maps wherever the press
 * landed to the element that actually wears the menu, and opens that one by
 * sending it the contextmenu event the kit already listens for, at the
 * pointer's own coordinates. The kit anchors its panel there as if the right
 * button had been pressed. Same panel, same dismissal, same focus rules -
 * nothing reimplemented.
 *
 * A mouse gets the hold too. The kit leaves the mouse out (it has a right
 * button), but "click and hold" is what people try first on every platform,
 * and answering it costs nothing: a click is over in a tenth of the time, so
 * a half-second press is never mistaken for one.
 *
 * Generous about movement on purpose - a thumb resting on glass drifts a few
 * pixels without meaning to. The kit's 8 is tight enough to lose holds on a
 * phone held in one hand; 12 is not.
 */
export const HOLD_MS = 450;
const SLOP_PX = 12;
/** How long after the menu opens a click is still the release of the hold. */
const SWALLOW_MS = 900;

type Handlers = Pick<
  HTMLAttributes<HTMLElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onClickCapture' | 'onContextMenu'
>;

/**
 * @param find From the element the press landed on (and the element wearing
 *   these handlers), the element that wears the ContextMenu - or null if the
 *   press was on nothing that has one, in which case it is left alone.
 */
export function useHoldToMenu(find: (from: Element, root: Element) => Element | null): Handlers {
  const pending = useRef<{ timer: number; x: number; y: number } | null>(null);
  // Until when a click is the tail end of a hold rather than a tap.
  const swallowUntil = useRef(0);
  const findRef = useRef(find);
  findRef.current = find;

  return useMemo<Handlers>(() => {
    const cancel = () => {
      if (pending.current !== null) {
        window.clearTimeout(pending.current.timer);
        pending.current = null;
      }
    };
    const summon = (from: Element, root: Element, x: number, y: number): boolean => {
      const target = findRef.current(from, root);
      if (!target) return false;
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }),
      );
      return true;
    };
    return {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        cancel();
        // A right button is the menu already; a middle one is never a hold.
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!(e.target instanceof Element)) return;
        const from = e.target;
        const root = e.currentTarget;
        if (!findRef.current(from, root)) return;
        const { clientX: x, clientY: y } = e;
        pending.current = {
          x,
          y,
          timer: window.setTimeout(() => {
            pending.current = null;
            if (summon(from, root, x, y)) {
              swallowUntil.current = Date.now() + SWALLOW_MS;
              fireNativeHaptic('medium');
            }
          }, HOLD_MS),
        };
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        const p = pending.current;
        if (p !== null && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onClickCapture: (e) => {
        if (Date.now() < swallowUntil.current) {
          swallowUntil.current = 0;
          e.preventDefault();
          e.stopPropagation();
        }
      },
      // A right-click anywhere the hold works, works too: forwarded to the
      // element that wears the menu, unless the click was already on it - the
      // forwarded event bubbles back through here, and that is how the loop
      // is closed.
      onContextMenu: (e) => {
        if (!(e.target instanceof Element)) return;
        const target = findRef.current(e.target, e.currentTarget);
        if (!target || target === e.target || target.contains(e.target)) return;
        e.preventDefault();
        target.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: e.clientX,
            clientY: e.clientY,
            view: window,
          }),
        );
      },
    };
  }, []);
}
