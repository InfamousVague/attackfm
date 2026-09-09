import { useEffect, useId, useRef } from 'react';
import { underNothing } from './focusScope.ts';

/**
 * The pointer sibling of focusScope's rule: A POPOVER MAY STAND ONLY WHERE A
 * FINGER COULD REACH THE CONTROL IT HANGS OFF.
 *
 * The kit's Popover portals its panel to the body at an INLINE `z-index: 200`
 * (written in a layout effect and again in the React style object), which is
 * above every takeover this app raises: the shared scrim at 59, the sheets at
 * 60, the kit's own overlays at 100, and chapter 05's band over the docked
 * card. So the notifications panel - the one popover reachable from every page
 * - stood lit and clickable over an open, dimmed search palette. Measured at
 * 1280x720: panel 901,56,317.5 x 132.8 at z 200, `.searchSummon.contains(it)`
 * false, and a real click on its "Clear all" ran `clearNotices()` (1 notice ->
 * 0) with the palette still open and focus dropped to BODY.
 *
 * MOST OF THAT WAS ALREADY CLOSED, and by the kit. Its Popover registers a
 * `document` pointerdown while open and shuts on any press outside its panel
 * and trigger - the behaviour core/overlayGuard.ts exists to hold back from
 * portalled listboxes - so a takeover raised BY A PRESS closes it on the way
 * up. Measured: bell popover open, a real press on the nav rail's Settings,
 * `popoverOpen: false` before the overlay paints. What is left is the routes
 * with no press in them: the ⌘K chord (nav/useSearchSummon.ts), the
 * `onOpenSearchPage` seam, `openSearch()` from the nav stack, and a
 * system-back restore. This file covers exactly those.
 *
 * WHY BEING THE `open` PROP, rather than any of the three shorter answers:
 *   - a synthetic `pointerdown` at the document does close the kit, and it
 *     also consumes `player/Player.tsx:2181`'s `{ once: true }` primer, which
 *     builds the AudioContext on the first real gesture. A context built
 *     outside a gesture is suspended on WebKit and the meter reads silence -
 *     the exact failure that comment describes. `core/haptics.ts:211` arms its
 *     tap detector on a capture-phase window pointerdown too, so a synthetic
 *     press also leaves a bogus start point for the next real pointerup.
 *   - a synthetic Escape hits the same primer (`keydown` is the other
 *     once-listener) and is a far broader hammer: it would close kit Modals,
 *     Selects and menus as well.
 *   - `trigger.click()` goes through the kit's own toggle and touches neither
 *     of those - but `player/VolumeControl.tsx:131` gives its trigger an
 *     `onClick` that toggles MUTE, so it would silence the player. An
 *     exception list for one trigger is a landmine, not a rule.
 * What is left is the seam the kit actually offers: hold `open` ourselves.
 * That is what ux/Popover.tsx is for, and it is why every popover in this app
 * imports `Popover` from there rather than from `@glacier/react`.
 *
 * NOT A CSS ANSWER, and the two obvious ones were measured before this was
 * written; the numbers are in 05-the-dock-contract-a.css beside the absence
 * they explain. Narrowing the positioner the way that chapter narrows the kit
 * overlays ERASES it (337.734px wide -> 9.883px at 1024x768 docked, because
 * the kit writes `left` inline and the panel has no author width, so the extra
 * inset over-constrains the box). Ducking it below the scrim leaves it
 * half-dead over the docked card and hides it entirely behind the palette on a
 * PHONE, where the scrim computes `display: none` and the bell is deliberately
 * live. Its anchoring is the one thing that must not be disturbed, and this
 * file disturbs none of it: no z-index, no inset, no style written anywhere.
 */

/** The attribute a registered popover's trigger wears, so the sweep can find
 *  it. Not a ref: the kit clones the trigger with its OWN ref, so a ref put on
 *  that element is replaced. `aria-controls` would serve for a single open
 *  popover but cannot say which registered closer owns which portalled panel;
 *  a cloned-in attribute can, so two open at once are judged one at a time. */
export const STAND_MARK = 'data-popover-stand';

/** Every open popover, by the mark its trigger wears. */
const stands = new Map<string, () => void>();

/**
 * Registers a popover's own close while it is open, and returns the mark to
 * put on its trigger.
 */
export function usePopoverStand(open: boolean, close: () => void): string {
  const mark = useId();
  /* Held in a ref so re-registering is not a consequence of a new callback
     identity every render: the entry must be stable for as long as the panel
     is open, and what it closes must be the LATEST handler. */
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const fire = () => closeRef.current();
    stands.set(mark, fire);
    return () => {
      stands.delete(mark);
    };
  }, [open, mark]);
  return mark;
}

/**
 * Close every open popover whose trigger a layer has just covered. Call it
 * from the commit that MOUNTS a takeover, so the hit test sees the new scrim.
 *
 * The gate is the whole of the rule, and it is why this is not "close every
 * popover when anything opens". A popover whose trigger the finger can still
 * press is not covered by anything and has no business closing: the phone's
 * header bell is deliberately live above the palette's top edge, and the
 * docked Now Playing card is deliberately live beside a takeover, with seven
 * popovers of its own (equalizer, chapters, reading speed, volume, devices,
 * the DJ, groove). Both keep theirs. The desktop title bar's bell, which the
 * scrim and chapter 05's band cover, loses its.
 *
 * `underNothing` is focusScope's, deliberately shared rather than copied: the
 * keyboard rule and the pointer rule must not be able to disagree about what
 * is reachable.
 *
 * A trigger the DOM cannot produce - unmounted while its panel was still on
 * screen - leaves that popover alone, which is today's behaviour rather than a
 * break.
 */
export function standDownCoveredPopovers(): void {
  for (const [mark, close] of stands) {
    const trigger = document.querySelector<HTMLElement>(`[${STAND_MARK}="${mark}"]`);
    if (!trigger) continue;
    if (underNothing(trigger)) continue;
    close();
  }
}
