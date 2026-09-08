import { useEffect, useRef } from 'react';
import { scrolledFromStart, scrollRoom } from './inlineScroll.ts';

/**
 * A row that runs off the edge of a narrow screen scrolls sideways, and says
 * so by fading at whichever end still has something on it.
 *
 * The rows this is for - the collection header's verbs, the Now Playing action
 * strip - are a handful of buttons that fit every phone but the narrow ones.
 * The two ways they used to fail were both worse than scrolling: the header's
 * row WRAPPED, which turns three buttons into two rows of furniture above the
 * songs; and the library's ran off the side and took the whole page's
 * horizontal scroll with it, so the page could be dragged sideways off its own
 * layout.
 *
 * A plain overflow scroller fixes both and introduces the usual problem - a
 * row cut off at a hard edge looks like a row that has been clipped, not one
 * that continues. So the mask: the fade is only as wide as there is scroll
 * left in that direction, which means a row that fits has no fade at all, a
 * row scrolled to its end has one on the left only, and the fade grows in as
 * you push off from an edge rather than snapping on.
 *
 * An opacity mask rather than a painted gradient, because these rows sit over
 * the Now Playing artwork and a collection header's cover wall: any colour
 * picked for the fade would be right on one of those and a smear on the other.
 *
 * Measured from the element, never from the window - a `resize` listener is
 * the wrong signal (the row changes width when the page's chrome does, not
 * only when the window does) and one of the surfaces this rides on renders
 * where window resize events never arrive at all.
 *
 * A FADE IS A HINT, AND SOME ROWS WANT A CONTROL. The Now Playing action strip
 * hangs a tappable arrow off each end, and it appears and disappears on the
 * measurement below rather than on one of its own: two things measuring the
 * same row are two answers waiting to disagree, and the one that disagrees
 * would be the one offering a button to somewhere there is nothing.
 *
 * So the MEASUREMENT is shared and the BUTTON is not. The arrows are that one
 * row's markup and that one row's stylesheet, because the rows wearing this
 * hook are not all asking the same question - `.jamNext` is a list of queued
 * songs and `.npDjStations` a shelf of stations, and a chrome control pinned
 * over the end of either is furniture standing in front of content. What every
 * row can use is the FACT, so the fact is what goes out.
 *
 * It goes out twice, as a length and as a flag, because they are read by
 * different things. An overlay wants the length (it fades WITH the mask); a
 * control wants the flag, since no amount of opacity can stop a button being
 * pressed, and an arrow that is invisible and still tappable is worse than the
 * fade it replaced.
 */

/** How wide the fade grows to, and the scroll distance it takes to get there. */
const FADE_PX = 20;

export function useEdgeFade<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // `scrollWidth - clientWidth` is 0 to the pixel on a row that fits, and
      // sub-pixel layout puts it at a fraction rather than 0 on some widths -
      // hence the 1px floor rather than a `> 0` test, which would leave a
      // permanent hairline fade on a row with nothing to scroll.
      // Measured from the START edge. The properties are already named
      // start/end rather than left/right, and in RTL `el.scrollLeft` is
      // NEGATIVE - taking it raw made `--edge-start` negative and pinned
      // `--edge-end` to its maximum, so both fades were on the wrong side of
      // an Arabic shelf and neither ever cleared.
      const room = scrollRoom(el);
      const from = scrolledFromStart(el);
      const start = room <= 1 ? 0 : Math.min(FADE_PX, from);
      const end = room <= 1 ? 0 : Math.min(FADE_PX, room - from);
      /*
       * Published on the scroller AND on its wrapper.
       *
       * A mask can live on the scroller itself, but a BLUR cannot: an
       * absolutely positioned child of a scroll container is placed against
       * its padding box and scrolls with the content, so an overlay pinned
       * that way slides off with the very icons it is meant to soften. Such an
       * overlay has to be a SIBLING - and a sibling does not inherit what is
       * set here, hence the parent.
       *
       * A plain 0..1 goes out beside the length because an overlay wants an
       * opacity, and CSS cannot divide one length by another.
       *
       * And the same fact once more as a bare yes/no, for the arrows: a length
       * of zero and a length of a third of a pixel are the same answer to "is
       * there anything that way", and only one of them can be told apart in a
       * selector. Rounded up at a whole pixel rather than at zero, so a
       * scroller resting a sub-pixel off its start does not offer a button to
       * nowhere - the same floor, and for the same reason, as the `room <= 1`
       * above.
       *
       * Attributes rather than React state on purpose. This runs on every
       * scroll frame of the busiest surface in the app; setting a data
       * attribute is the same class of write as the four properties beside it,
       * where a `setState` would re-render the whole Now Playing sheet under a
       * moving thumb.
       */
      for (const node of [el, el.parentElement]) {
        if (!node) continue;
        node.style.setProperty('--edge-start', `${start}px`);
        node.style.setProperty('--edge-end', `${end}px`);
        node.style.setProperty('--edge-start-t', String(start / FADE_PX));
        node.style.setProperty('--edge-end-t', String(end / FADE_PX));
        node.toggleAttribute('data-edge-start', start >= 1);
        node.toggleAttribute('data-edge-end', end >= 1);
      }
    };

    measure();
    el.addEventListener('scroll', measure, { passive: true });
    // The row's own width AND its contents': a button whose label arrives late
    // (a count, a state word) changes whether the row overflows at all.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  });

  return ref;
}
