import { resolveDirection } from '@glacier/react';

/**
 * HORIZONTAL SCROLLING WHEN "RIGHT" IS THE BEGINNING.
 *
 * `scrollLeft` is the one part of the DOM that logical CSS cannot paper over.
 * In a right-to-left element the content starts at the RIGHT edge, and every
 * current engine reports that as `scrollLeft === 0` counting DOWN into
 * negatives as you scroll toward the left - the range is `[-room, 0]`, not
 * `[0, room]`.
 *
 * So the ordinary shape
 *
 *     Math.max(0, Math.min(left, el.scrollWidth - el.clientWidth))
 *
 * is not merely inaccurate in Arabic, it is a hard stop: every legal scroll
 * position is negative, `Math.max(0, …)` returns 0 for all of them, and the
 * shelf cannot be moved at all. That was the state of the home shelves, and it
 * is the reason this file exists rather than three separate corrections.
 *
 * Everything below is expressed in DISTANCE FROM THE START EDGE, which is
 * always positive and always means the same thing in both directions. Callers
 * do their arithmetic in that space and hand it back through `clampScroll`.
 */

/** +1 when the inline axis runs left-to-right, -1 when it runs right-to-left. */
export function inlineSign(el: HTMLElement): 1 | -1 {
  return resolveDirection(el) === 'rtl' ? -1 : 1;
}

/** How much there is to scroll. Never negative, both directions. */
export function scrollRoom(el: HTMLElement): number {
  return Math.max(0, el.scrollWidth - el.clientWidth);
}

/** How far from the start edge, as a positive number. 0 means "at the top of
 *  the row", whichever side of the screen that is. */
export function scrolledFromStart(el: HTMLElement): number {
  return Math.abs(el.scrollLeft);
}

/** Turns a distance-from-start back into a `scrollLeft` this element accepts,
 *  clamped to what actually exists. */
export function scrollLeftFor(el: HTMLElement, fromStart: number): number {
  return inlineSign(el) * Math.max(0, Math.min(fromStart, scrollRoom(el)));
}
