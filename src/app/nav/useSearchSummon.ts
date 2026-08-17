import { useCallback, useEffect, useRef, useState } from 'react';
import { useSystemBack } from './systemBack.ts';

/**
 * The pull from the top, in two stages - and it moves the PAGE.
 *
 * A downward drag at the top of a page means one of two things, and which one
 * depends on how far it goes. Every other app has taught the same lesson: a
 * SHORT pull reveals what is above the page - here, the search field - and a
 * LONG one refreshes.
 *
 *   0 → SEARCH_AT     nothing yet; a scroll that changed its mind costs
 *                     nothing and shows nothing.
 *   SEARCH_AT →       the search bar is uncovered as the page slides down,
 *   REFRESH_AT        and is left standing when the finger lifts.
 *   REFRESH_AT →      the refresh mark takes over the gap. Let go here and
 *                     the library re-reads itself.
 *
 * The chrome does not float over the content: the page itself is pushed down
 * and the bar is what was underneath it all along. That is the whole reason
 * the distance lives in a CSS custom property (`--app-pull`) on the document
 * element rather than in React state - one number, written once per frame,
 * read by both the page's translate and the deck's height, so the two can
 * never disagree about where the seam is.
 *
 * Writing it to the DOM is also the only way this is affordable. The page is
 * the whole app; re-rendering that tree sixty times a second to animate a
 * drag would cost far more than the drag is worth. React is told only when
 * the STAGE changes, which happens about twice per gesture.
 *
 * `host` is the content host the gesture listens on (the same element the
 * edge-swipe drags) - the node itself, not a ref object, so the listeners
 * re-attach when it mounts after onboarding.
 */

/** Where the search bar starts to show. Past a scroll's slop, under a
 *  deliberate pull. */
const SEARCH_AT = 34;
/** Where the pull stops being about search and starts being about refreshing.
 *  Far enough that the first stage is comfortably usable on its own. */
const REFRESH_AT = 116;
/** How far the finger may travel before the pull is judged a scroll instead. */
const SLOP = 10;
/** As far as the page will travel, however hard it is pulled. */
const CEILING = REFRESH_AT + 28;

/** Which answer the gesture is currently offering. */
export type PullStage = 'idle' | 'search' | 'refresh';

const stageFor = (d: number): PullStage =>
  d >= REFRESH_AT ? 'refresh' : d >= SEARCH_AT ? 'search' : 'idle';

export function useSearchSummon(host: HTMLElement | null, onRefresh?: () => Promise<void> | void) {
  const [searchOpen, setSearchOpen] = useState(false);
  useSystemBack(searchOpen, () => setSearchOpen(false));

  /** The bar, left standing after a stage-one pull, until it is used or
   *  dismissed. This is the part a small pull is FOR. */
  const [barOpen, setBarOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stage, setStage] = useState<PullStage>('idle');
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  /*
   * The seam, straight onto the document element.
   *
   * `data-pulling` rides along because a transition that is right for the
   * settle back is wrong under a finger: mid-drag the page must be exactly
   * where the hand is, and any easing at all reads as the app lagging.
   */
  const settleTimer = useRef<number | undefined>(undefined);
  const paint = useCallback((distance: number, live: boolean) => {
    const root = document.documentElement;
    root.style.setProperty('--app-pull', `${distance.toFixed(1)}px`);
    window.clearTimeout(settleTimer.current);
    if (live) {
      root.setAttribute('data-pulling', '');
      root.setAttribute('data-pull-moving', '');
    } else {
      root.removeAttribute('data-pulling');
      /*
       * The page keeps its translate for exactly as long as the settle back
       * takes, and then gives it up entirely.
       *
       * This is not tidiness. A `translate` of any value - `0px` included -
       * makes an element the containing block for every `position: fixed`
       * descendant it has, so leaving one on the content column permanently
       * would silently re-anchor any fixed thing a page ever puts inside
       * itself. There are none today; there is no reason to leave a trap for
       * the one that shows up next month. Off between gestures, it cannot
       * happen.
       */
      settleTimer.current = window.setTimeout(
        () => document.documentElement.removeAttribute('data-pull-moving'),
        320,
      );
    }
  }, []);

  useEffect(() => {
    if (!host) return;
    let startY = 0;
    let startX = 0;
    let armed = false;
    let pulling = false;
    let distance = 0;
    /*
     * The page a touch landed in.
     *
     * `Element`, not `HTMLElement`: half this app's tappable surfaces have an
     * icon in them, and a touch that lands on an <svg> or one of its <path>s
     * has an SVGElement as its target - which is not an HTMLElement, so the
     * old test returned null and the pull silently refused to arm. Starting
     * the drag on artwork or an icon is not an edge case, it is where thumbs
     * land.
     */
    const pageOf = (target: EventTarget | null): Element | null => {
      let el = target instanceof Element ? target : null;
      while (el && el.parentElement !== host) el = el.parentElement;
      return el;
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const page = pageOf(e.target);
      // Armed only at the very top of the page's own scroller, so ordinary
      // scrolling never fights this.
      armed = !!page && page.scrollTop <= 0;
      pulling = false;
      distance = 0;
      startY = t.clientY;
      startX = t.clientX;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - startY;
      const dx = Math.abs(t.clientX - startX);
      if (!pulling) {
        if (dy > SLOP && dy > dx * 1.5) pulling = true;
        else return;
      }
      /*
       * Damped, not linear. A pull that tracks the finger 1:1 hits the refresh
       * threshold while the hand still thinks it is scrolling; the square root
       * makes the first centimetre cheap and every one after it dearer, which
       * is the resistance every rubber-band scroll in the OS already has.
       */
      distance = dy <= 0 ? 0 : Math.min(Math.sqrt(dy) * 11, CEILING);
      paint(distance, true);
      setStage((s) => {
        const next = stageFor(distance);
        return s === next ? s : next;
      });
    };
    const onEnd = () => {
      const settled = distance;
      armed = false;
      pulling = false;
      distance = 0;
      paint(0, false);
      setStage('idle');
      if (settled >= REFRESH_AT) {
        // Past the far mark: refresh, and hold the gap open while it runs so
        // the gesture visibly did something.
        setRefreshing(true);
        void (async () => {
          try {
            await refreshRef.current?.();
          } finally {
            setRefreshing(false);
          }
        })();
      } else if (settled >= SEARCH_AT) {
        // Stage one: leave the bar standing. It is a door, not a flash - the
        // whole point is that it is there to be tapped after the finger lifts.
        setBarOpen(true);
      }
    };
    host.addEventListener('touchstart', onStart, { passive: true });
    host.addEventListener('touchmove', onMove, { passive: true });
    host.addEventListener('touchend', onEnd, { passive: true });
    host.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      host.removeEventListener('touchstart', onStart);
      host.removeEventListener('touchmove', onMove);
      host.removeEventListener('touchend', onEnd);
      host.removeEventListener('touchcancel', onEnd);
      window.clearTimeout(settleTimer.current);
      document.documentElement.removeAttribute('data-pulling');
      document.documentElement.removeAttribute('data-pull-moving');
      document.documentElement.style.removeProperty('--app-pull');
    };
  }, [host, paint]);

  /*
   * The settled gap: the bar's own height, held open by the page rather than
   * by a transform, so the page is SHORTER while the bar stands instead of
   * being pushed off the bottom of the screen. A translate here would put the
   * last few rows of a scrolled page out of reach - the exact complaint the
   * nav bar's chin was built to answer.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (barOpen || refreshing) root.setAttribute('data-pull-standing', '');
    else root.removeAttribute('data-pull-standing');
    return () => root.removeAttribute('data-pull-standing');
  }, [barOpen, refreshing]);

  // Until the pull has been used once, a small chip under the header says it
  // exists - the one cost of retiring the Search tab.
  const [summonHint, setSummonHint] = useState(() => {
    try {
      return localStorage.getItem('attackfm-summon-known') !== '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (searchOpen && summonHint) {
      setSummonHint(false);
      try {
        localStorage.setItem('attackfm-summon-known', '1');
      } catch {
        // Fine; it dismisses for this launch regardless.
      }
    }
  }, [searchOpen, summonHint]);

  // The chord the field advertises: Cmd/Ctrl+K summons search from anywhere,
  // and Escape sends it home (the overlay is not a kit Modal, so it minds its
  // own key).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((v) => !v);
      } else if (event.key === 'Escape') {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return {
    /** Which answer the live gesture is offering; 'idle' between gestures. */
    stage,
    /** The revealed search bar, standing after a stage-one pull. */
    barOpen,
    setBarOpen,
    refreshing,
    summonHint,
    searchOpen,
    setSearchOpen,
  };
}
