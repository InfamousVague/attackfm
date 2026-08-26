import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * The lit plate that SLIDES between tabs on the phone bar.
 *
 * The kit's own NavBar has this - one indicator element that moves behind the
 * items - and the desktop rail gets it for free because the rail still is a
 * kit NavBar. The phone bar is hand-rolled markup (the kit's labelled item is
 * a desktop row: fixed height, glyph beside label, desktop padding), and when
 * it stopped being a NavBar the sliding plate went with it. What replaced it
 * was a background that cross-faded out on the tab you left and in on the one
 * you arrived at, which reads as two lights blinking rather than one object
 * moving.
 *
 * So: one absolutely-positioned plate, parked over whichever tab is current.
 * The tabs keep their own accent INK; only the fill moved out of them.
 *
 * MEASURED, not computed. The bar distributes its tabs with space-between over
 * its own padding, and the trailing button is a menu trigger rather than a
 * destination - so tab n is not at n * width, and any arithmetic that assumed
 * it would drift the moment a plugin appeared or a seat folded into the menu.
 * offsetLeft against the bar is the truth, and it costs one read per change.
 */

/** Where the plate is, in the bar's own coordinates. */
interface Spot {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SAME = (a: Spot | null, b: Spot | null): boolean =>
  a != null &&
  b != null &&
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.w - b.w) < 0.5 &&
  Math.abs(a.h - b.h) < 0.5;

export function useNavPill(barRef: React.RefObject<HTMLElement | null>): void {
  const at = useRef<Spot | null>(null);

  const place = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const tab = bar.querySelector<HTMLElement>('.appNavBarTab[data-active]');

    /*
     * Nothing lit: a plugin page, or a destination that has folded into the
     * menu. The plate goes away rather than sitting on a tab that is not the
     * page you are on - and `parked` is cleared with it, so when it comes back
     * it appears where it belongs instead of gliding in from the last tab
     * anyone happened to visit.
     */
    if (!tab) {
      bar.removeAttribute('data-pill');
      bar.removeAttribute('data-pill-moving');
      at.current = null;
      return;
    }

    const spot: Spot = {
      x: tab.offsetLeft,
      y: tab.offsetTop,
      w: tab.offsetWidth,
      h: tab.offsetHeight,
    };
    // A resize observer fires for changes that move nothing (a repaint, a
    // scrollbar); rewriting identical values would restart the transition and
    // make the plate stutter in place.
    if (SAME(at.current, spot)) return;

    /*
     * The FIRST placement is a jump, every later one is a glide.
     *
     * A plate that animated from 0,0 on mount would fly across the bar every
     * cold start - and the same on every rotation, because the observer's
     * first call arrives before anything has moved. `data-pill-moving` is what
     * the transition is keyed on, and it is only set once the plate already
     * has somewhere to move FROM.
     */
    if (at.current) bar.setAttribute('data-pill-moving', '');
    else bar.removeAttribute('data-pill-moving');

    bar.style.setProperty('--app-nav-pill-x', `${spot.x}px`);
    bar.style.setProperty('--app-nav-pill-y', `${spot.y}px`);
    bar.style.setProperty('--app-nav-pill-w', `${spot.w}px`);
    bar.style.setProperty('--app-nav-pill-h', `${spot.h}px`);
    bar.setAttribute('data-pill', '');
    at.current = spot;
  }, [barRef]);

  // Before paint, so a tab change never shows the plate on the old seat for a
  // frame. React has committed the new [data-active] by now.
  useLayoutEffect(place);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    /*
     * The bar's own box, and every tab in it.
     *
     * Watching only the bar misses the case that actually moves the plate
     * without resizing anything outside it: a seat folding into the ⋮ menu
     * re-spaces the survivors inside a bar whose width never changed. The tabs
     * are re-observed on every run because the run happens after any change to
     * the set of them.
     */
    const watch = new ResizeObserver(() => place());
    watch.observe(bar);
    for (const tab of bar.querySelectorAll('.appNavBarTab')) watch.observe(tab);

    // A late webfont re-measures the labels under the plate; the tab is a fixed
    // square so this rarely moves anything, but it costs one call to be right
    // on the platform where it does.
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) place();
    });

    return () => {
      live = false;
      watch.disconnect();
    };
  });
}
