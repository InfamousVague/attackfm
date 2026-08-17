import { useCallback, useEffect, useRef, useState } from 'react';
import { useSystemBack } from './systemBack.ts';
import { fireNativeHaptic } from '../core/haptics.ts';

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

/*
 * The thresholds are in FINGER TRAVEL, not in the damped distance the page
 * moves. That distinction is the whole fix.
 *
 * They used to be read off the damped number, where `sqrt(dy) * 11` compresses
 * everything: search was offered after 10px of travel and refresh armed after
 * 111px. Ten pixels is the slop - the bar arrived the instant the gesture was
 * recognised - and 111 is an ordinary pull-to-refresh flick, the one every
 * other app has trained into the thumb. So the first stage existed for a
 * hundred pixels of a gesture nobody performs slowly, and people sailed
 * through it into a refresh they did not ask for.
 *
 * Now the hand has to make a decision it can feel:
 */
/** Where the pull stops being a scroll. */
const SLOP = 10;
/** Where the bar is offered. Immediately after the gesture is recognised - it
 *  should be seen EARLY; being missed was never about arriving late. */
const SEARCH_AT = 18;
/** Where the bar has fully arrived, sitting exactly where it will settle. */
const REVEAL_END = 64;
/** ...and where it stops sitting there. Between these two the page barely
 *  moves: a detent, so a pull that would otherwise run straight through has
 *  something to arrive at, and a thumb that keeps going has to mean it. */
const HOLD_END = 156;
/** Where refreshing arms. Past the detent and then some - so it is now a
 *  deliberate act rather than the natural end of any downward flick. */
const REFRESH_AT = 268;
/** How far past the detent the gap will open, however hard it is pulled. */
const CEILING_EXTRA = 84;
/** How much of the finger's travel the page still spends past the detent.
 *  Under half, so the gap keeps growing without chasing the hand. */
const PAST_HOLD = 0.5;
/** The crawl through the detent. Not zero - a page frozen under a moving
 *  finger reads as a hang, not as resistance. */
const THROUGH_HOLD = 0.1;

/** Which answer the gesture is currently offering. */
export type PullStage = 'idle' | 'search' | 'refresh';

const stageFor = (travel: number): PullStage =>
  travel >= REFRESH_AT ? 'refresh' : travel >= SEARCH_AT ? 'search' : 'idle';

/**
 * Finger travel to the distance the page moves.
 *
 * `settled` is where the bar comes to rest (the measured gap), so the detent
 * is not an arbitrary plateau - it is the bar arriving at exactly the place it
 * will stay, and staying there while the finger decides. `already` is for a
 * pull that starts with the bar standing: there is nothing left to reveal, so
 * that pull only opens the gap the refresh mark needs.
 */
function distanceFor(travel: number, settled: number, already: boolean): number {
  if (travel <= SLOP) return 0;
  if (already) {
    return travel <= HOLD_END ? 0 : Math.min((travel - HOLD_END) * PAST_HOLD, CEILING_EXTRA);
  }
  if (travel < REVEAL_END) return (settled * (travel - SLOP)) / (REVEAL_END - SLOP);
  if (travel < HOLD_END) return settled + (travel - REVEAL_END) * THROUGH_HOLD;
  const held = settled + (HOLD_END - REVEAL_END) * THROUGH_HOLD;
  return held + Math.min((travel - HOLD_END) * PAST_HOLD, CEILING_EXTRA);
}

export function useSearchSummon(host: HTMLElement | null, onRefresh?: () => Promise<void> | void) {
  const [searchOpen, setSearchOpen] = useState(false);
  useSystemBack(searchOpen, () => setSearchOpen(false));

  /** The bar, left standing after a stage-one pull, until it is used or
   *  dismissed. This is the part a small pull is FOR. */
  const [barOpen, setBarOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stage, setStage] = useState<PullStage>('idle');
  const barOpenRef = useRef(barOpen);
  barOpenRef.current = barOpen;
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
    let travel = 0;
    let settled = 62;
    let standing = false;
    let lastStage: PullStage = 'idle';
    let landed = false;
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
      travel = 0;
      lastStage = 'idle';
      landed = false;
      // Read once per gesture rather than per frame: the detent should land
      // the bar exactly where it will come to rest, and that height is
      // measured from the bar itself.
      standing = barOpenRef.current;
      settled =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--app-pull-stand'),
        ) || 62;
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
        /*
         * The way back. A standing bar is dismissed by pushing it up again -
         * the same gesture that revealed it, run backwards - so it never
         * becomes a thing you have to go and find the way out of.
         */
        if (barOpenRef.current && dy < -SLOP && Math.abs(dy) > dx * 1.5) {
          fireNativeHaptic('selection');
          setBarOpen(false);
          armed = false;
          return;
        }
        if (dy > SLOP && dy > dx * 1.5) pulling = true;
        else return;
      }
      travel = dy;
      distance = distanceFor(dy, settled, standing);
      paint(distance, true);
      /*
       * The detent, felt - at the moment the bar ARRIVES, not when it first
       * peeks out. The tick is the whole point of the detent: it is what tells
       * a thumb already in motion that something has come to rest under it and
       * this is a place to stop. Fired at REVEAL_END rather than on the stage
       * change, which happens 46px earlier while the bar is still on its way.
       */
      if (!landed && travel >= REVEAL_END) {
        landed = true;
        fireNativeHaptic('selection');
      }
      const next = stageFor(travel);
      if (next !== lastStage) {
        // Arming a refresh is the heavier commitment, and says so.
        if (next === 'refresh') fireNativeHaptic('medium');
        lastStage = next;
        setStage(next);
      }
    };
    const onEnd = () => {
      const reached = travel;
      armed = false;
      pulling = false;
      distance = 0;
      travel = 0;
      paint(0, false);
      setStage('idle');
      if (reached >= REFRESH_AT) {
        // Past the far mark: refresh, and hold the gap open while it runs so
        // the gesture visibly did something.
        setRefreshing(true);
        void (async () => {
          try {
            await refreshRef.current?.();
            // The library is back. `success` is the one notification kind that
            // means "the thing you asked for happened", which is all this is.
            fireNativeHaptic('success');
          } catch {
            fireNativeHaptic('error');
          } finally {
            setRefreshing(false);
          }
        })();
      } else if (reached >= SEARCH_AT) {
        // Stage one: leave the bar standing. It is a door, not a flash - the
        // whole point is that it is there to be tapped after the finger lifts.
        setBarOpen(true);
      }
    };
    /*
     * And scrolling closes it. The bar sits above the page; the moment the
     * page moves out from under it the bar describes somewhere you no longer
     * are. Capture, because scroll does not bubble - the scrollers are the
     * pages inside, not the host.
     */
    const onScroll = (e: Event) => {
      if (!barOpenRef.current) return;
      const t = e.target;
      if (t instanceof Element && t.scrollTop > 2) setBarOpen(false);
    };
    host.addEventListener('scroll', onScroll, { capture: true, passive: true });
    host.addEventListener('touchstart', onStart, { passive: true });
    host.addEventListener('touchmove', onMove, { passive: true });
    host.addEventListener('touchend', onEnd, { passive: true });
    host.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      host.removeEventListener('touchstart', onStart);
      host.removeEventListener('touchmove', onMove);
      host.removeEventListener('touchend', onEnd);
      host.removeEventListener('touchcancel', onEnd);
      host.removeEventListener('scroll', onScroll, { capture: true });
      window.clearTimeout(settleTimer.current);
      document.documentElement.removeAttribute('data-pulling');
      document.documentElement.removeAttribute('data-pull-moving');
      document.documentElement.style.removeProperty('--app-pull');
    };
  }, [host, paint]);

  /*
   * Where the gap actually starts, measured off the content column.
   *
   * The deck used to compute its own top as `safe-area-inset-top +
   * --app-header-height` - a second, parallel derivation of a position the
   * layout had already worked out. The two agreed on a desktop, where the
   * safe-area inset is 0, and disagreed on a phone, where it is a status bar:
   * the deck sat lower than the gap the page had opened and the bar landed on
   * the music. Reading the column's own top instead means there is only one
   * answer to where the seam is, so there is nothing left to disagree with.
   *
   * Never read mid-drag: the rect includes the translate, which would feed
   * the page's own movement back into the deck's anchor.
   */
  useEffect(() => {
    if (!host) return;
    const write = () => {
      if (document.documentElement.hasAttribute('data-pull-moving')) return;
      const { top } = host.getBoundingClientRect();
      document.documentElement.style.setProperty('--app-content-top', `${top.toFixed(1)}px`);
    };
    write();
    const ro = new ResizeObserver(write);
    ro.observe(host);
    window.addEventListener('resize', write);
    window.addEventListener('orientationchange', write);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', write);
      window.removeEventListener('orientationchange', write);
    };
  }, [host]);

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
