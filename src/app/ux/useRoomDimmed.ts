import { useCallback, useLayoutEffect, useState } from 'react';

/**
 * Does this takeover's dimmer COVER THE ROOM?
 *
 * The one thing `aria-modal="true"` claims is that everything outside the
 * dialog is unavailable, and the only honest answer to that is the paint. So
 * this hook is handed the scrim element itself and measures its border box
 * against the window. Nothing else: no token, no media query, no platform
 * stamp, no knowledge of the dock.
 *
 * IT USED TO READ THE CONTRACT TOKEN, and the token answers a different
 * question - "does a dimmer paint AT ALL" - which is the same answer only
 * where the dimmer is the whole window. On a docked desktop the two diverge on
 * purpose, and that shape is the commonest desktop state there is: chapter 05
 * narrows every takeover to the app column so the player keeps its own, and
 * the focus ring keeps the docked card's controls for exactly the same reason
 * (ux/focusScope.ts, ux/popoverStand.ts). Measured at 1280x720 docked, token
 * `block`: scrim `0,0,793.602,720` at z 59 with the card uncovered at
 * `809.414,67.805,454.781x636.391`, `[inert]` 0, nothing `aria-hidden`, and
 * five real Tabs cycling through the card - under a panel whose markup said
 * the outside was unavailable. The box says `793.602 < 1280` and the claim is
 * dropped; the token said `block` and it stood.
 *
 * It also fails the safe way now, which the token read did not. That read was
 * `getPropertyValue('--app-sheet-scrim').trim() !== 'none'`, so an absent or
 * unreadable property answered TRUE - a hook whose whole purpose is not to
 * claim modality that is not painted, defaulting to claiming it. Measured:
 * real token `"none"` gave false, an absent property gave raw `""` and true.
 * There is no such thing to read here, and an element that has not been laid
 * out measures `0 x 0`, which is not a covered room.
 *
 * WHAT IT DOES NOT ANSWER, said plainly, because a comment that overstates
 * this is the failure it was written to end: a covered room is not the same as
 * an empty one. Two things still stand above a scrim that covers the window.
 * `.djToast` computes z 65, above the scrim's 59, so while it stands its own
 * button is reachable outside the sheet. And a SECOND takeover raised over the
 * palette brings its own controls with it - measured at 1280x720 with the real
 * Settings modal over an open palette, the focus ring is that modal's own five
 * stops and none of them is inside the palette. Neither is accounted for here:
 * the attribute answers for the palette's own dimmer and nothing else.
 *
 * And in RTL, docked, chapter 49 pins the card physically right while the
 * reserved gutter mirrors left, so the card lies INSIDE the dimmed rectangle
 * and the ring is genuinely closed - this hook still sees a narrowed box and
 * withholds the claim. That is the direction to be wrong in.
 *
 * A ResizeObserver rather than a media query, for the same reason: the box
 * changes when the window is resized, when the player docks or undocks (a
 * `:has()` rule, which fires no event of its own), and when the contract turns
 * the scrim to `display: none`, and one observer catches all three. The window
 * `resize` listener is the second half of the question - the box can stay the
 * same size while the ROOM changes around it.
 */
const coversRoom = (dimmer: HTMLElement): boolean => {
  const box = dimmer.getBoundingClientRect();
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.left <= 0 &&
    box.top <= 0 &&
    box.right >= window.innerWidth &&
    box.bottom >= window.innerHeight
  );
};

/**
 * Returns the ref to put on the dimmer, and whether it covers the room.
 *
 * The node arrives through STATE rather than a ref object, because the answer
 * has to change when the element mounts and a ref's assignment renders
 * nothing. Measured in a layout effect, so the attribute is right in the frame
 * the dialog is painted in rather than one render later.
 */
export function useRoomDimmed(): [(node: HTMLElement | null) => void, boolean] {
  const [dimmer, setDimmer] = useState<HTMLElement | null>(null);
  const [covered, setCovered] = useState(false);
  const ref = useCallback((node: HTMLElement | null) => setDimmer(node), []);
  useLayoutEffect(() => {
    if (!dimmer) {
      setCovered(false);
      return;
    }
    const read = () => setCovered(coversRoom(dimmer));
    read();
    const box = new ResizeObserver(read);
    box.observe(dimmer);
    window.addEventListener('resize', read);
    return () => {
      box.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [dimmer]);
  return [ref, covered];
}
