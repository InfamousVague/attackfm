import { useCallback, useEffect, useRef, useState } from 'react';
import { useSystemBack } from './systemBack.ts';
import { makeRatchet } from '../ux/ratchet.ts';
import { fireNativeHaptic } from '../core/haptics.ts';

/**
 * The pull from the top: a refresh, felt on the way down.
 *
 * Search went back to being a station - an icon in the nav bar that opens the
 * full-screen page - so the gesture is free to mean the one thing a pull from
 * the top of a list has always meant. Pull, feel the detents tighten, let go
 * past the mark and the library re-reads itself.
 *
 * This is the shape the app had before search borrowed the gesture, restored
 * deliberately: a pull that opened search was a surprise, and a search you had
 * to know a gesture to reach was hidden. One affordance each.
 *
 * The live drag publishes two numbers to the document element, because the
 * layers that draw the mark are spread across the tree and none of them is a
 * child of the page being dragged:
 *
 *   --app-pull    the damped distance the page itself slides - feedback that
 *                 the gesture has hold of something, capped low.
 *   --app-travel  the raw finger travel - what the mark's fade and turn are
 *                 keyed to, so they spend themselves across the whole pull.
 *
 * React is told only when the gesture starts, arms and ends; everything
 * per-frame goes straight to the DOM.
 *
 * `host` is the content host the gesture listens on (the same element the
 * edge-swipe drags) - the node itself, not a ref object, so the listeners
 * re-attach when it mounts after onboarding.
 */

/** Where the pull stops being a scroll. */
const SLOP = 10;
/**
 * Where letting go refreshes.
 *
 * An ordinary pull-to-refresh flick measures a bit over a hundred pixels, so
 * this sits just past one: far enough that a lazy overscroll springs back,
 * close enough that a deliberate pull does not feel like a haul. The old
 * two-stage gesture needed 352px because refresh was the SECOND stop behind a
 * search bar; with the stage gone, that distance is just work.
 */
const REFRESH_AT = 150;
/** How far the page itself will slide, however hard it is pulled. */
const PAGE_SLIDE_CAP = 84;

export function useSearchSummon(host: HTMLElement | null, onRefresh?: () => Promise<void> | void) {
  const [searchOpen, setSearchOpen] = useState(false);
  useSystemBack(searchOpen, () => setSearchOpen(false));

  /** A gesture is live: the mark mounts off this. */
  const [pulling, setPulling] = useState(false);
  /** The refresh is running: the mark spins and the gap stays open. */
  const [refreshing, setRefreshing] = useState(false);
  /** Read through a ref so a changing callback never re-binds the listeners. */
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

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
      root.style.removeProperty('--app-travel');
      /*
       * The page keeps its translate for exactly as long as the settle back
       * takes, and then gives it up entirely. A `translate` of any value -
       * `0px` included - makes the content column the containing block for
       * every `position: fixed` descendant, so it must not persist between
       * gestures.
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
    /** The scroller this gesture is judged against, resolved on touchdown. */
    let page: Element | null = null;
    let isPulling = false;
    let travel = 0;
    const ratchet = makeRatchet();
    /*
     * The page a touch landed in. `Element`, not `HTMLElement`: a touch that
     * lands on an <svg> or one of its <path>s has an SVGElement target, and
     * on a screen made of album art and icons that is most of the screen.
     */
    const scrolls = (el: Element) => el.scrollHeight > el.clientHeight + 1;
    const pageOf = (target: EventTarget | null): Element | null => {
      let el = target instanceof Element ? target : null;
      while (el && el.parentElement !== host) el = el.parentElement;
      // A direct child that does not scroll - the top scrim, any decorative
      // layer - reports scrollTop 0 forever, which would arm the pull from
      // anywhere on a page that IS scrolled down. Fall back to the child that
      // actually scrolls.
      if (el && !scrolls(el)) {
        const real = Array.from(host.children).find(scrolls);
        if (real) return real;
      }
      return el;
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      page = pageOf(e.target);
      // Armed only at the very top of the page's own scroller, so ordinary
      // scrolling never fights this. Re-checked on every move below: this
      // reading is only true for the instant the finger lands.
      armed = !!page && page.scrollTop <= 0;
      isPulling = false;
      travel = 0;
      ratchet.reset();
      startY = t.clientY;
      startX = t.clientX;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - startY;
      const dx = Math.abs(t.clientX - startX);
      if (!isPulling) {
        // The page can scroll out from under a finger that landed at the top.
        // One touch that scrolls DOWN and then reverses used to arrive back
        // with a large positive dy - measured from a start point the page had
        // long since left - and open search from the middle of the list. What
        // matters is where the scroller is NOW, not where it was on touchdown.
        if (page && page.scrollTop > 0) {
          // Re-baseline while it is scrolled, so returning to the top starts
          // the pull from zero rather than arriving with a stale distance
          // already banked.
          startY = t.clientY;
          startX = t.clientX;
          return;
        }
        if (dy > SLOP && dy > dx * 1.5) {
          isPulling = true;
          setPulling(true);
        } else return;
      }
      travel = Math.max(0, dy);
      // The page's own slide: damped hard, because it is what you are leaving.
      const distance = Math.min(Math.sqrt(travel) * 7, PAGE_SLIDE_CAP);
      document.documentElement.style.setProperty('--app-travel', `${travel.toFixed(1)}px`);
      paint(distance, true);
      // Felt as it builds: soft ticks tightening toward the commit point,
      // and the point itself landing properly.
      ratchet.feel(travel, SLOP, REFRESH_AT, e.timeStamp);
      if (travel >= REFRESH_AT) ratchet.arrive('medium');
    };
    const onEnd = () => {
      const commit = isPulling && travel >= REFRESH_AT;
      armed = false;
      isPulling = false;
      travel = 0;
      paint(0, false);
      setPulling(false);
      if (!commit) return;
      // The mark keeps turning until the rescan actually answers - a spinner
      // on a fixed timer lies about whichever of the two is slower, and this
      // one can be either.
      setRefreshing(true);
      void (async () => {
        try {
          await refreshRef.current?.();
          // The gesture's ending. Its run-up is the best-built in the app -
          // a full ratchet into `arrive('medium')` - and then the thing you
          // pulled FOR completed in silence. In the try, not the finally: the
          // catch below states the policy that a failed refresh is not worth
          // an interruption, and a success buzz on a failure would say the
          // opposite.
          fireNativeHaptic('success');
        } catch {
          // A refresh that fails is not worth an interruption: the library
          // that is already on screen stays, and the next pull tries again.
        } finally {
          setRefreshing(false);
        }
      })();
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
      document.documentElement.style.removeProperty('--app-travel');
    };
  }, [host, paint]);

  /*
   * Where the content column starts, published for the layers that align to
   * it: the pull preview and the open search sheet both begin exactly where
   * the page does - under the header, under the status bar - and neither is a
   * child of the page, so the position has to travel by custom property.
   *
   * Dropped once in a rewrite, which put the preview and the sheet at the top
   * of the SCREEN, over the logo. Never read mid-drag: the rect includes the
   * page's own translate, which would feed the drag back into the anchor.
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
      document.documentElement.style.removeProperty('--app-content-top');
    };
  }, [host]);

  /*
   * The teaching chip is gone with the gesture it taught. Search is an icon in
   * the nav bar again, which needs no chip, and a pull that refreshes is the
   * convention every list app already taught. The stored flag is left alone -
   * harmless, and it costs a write to clear.
   */

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

  return { pulling, refreshing, searchOpen, setSearchOpen };
}
