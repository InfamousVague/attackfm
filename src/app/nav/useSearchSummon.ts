import { useCallback, useEffect, useRef, useState } from 'react';
import { useSystemBack } from './systemBack.ts';
import { makeRatchet } from '../ux/ratchet.ts';

/**
 * The pull from the top: one gesture, one answer.
 *
 * Pull down at the top of a page and the search page itself fades in over the
 * blurring content - the real SearchPage, its field and its genre cards, not a
 * bar standing in for it. Let go past the commit point and it opens; let go
 * short of it and everything springs back to exactly where it was.
 *
 * This replaces a two-stage gesture (bar at one depth, refresh at another)
 * whose stages kept fighting each other for the same finger. Refresh left the
 * gesture entirely; the library still re-reads itself from Settings, and the
 * pull now means one thing.
 *
 * The live drag publishes two numbers to the document element, because the
 * layers that draw the reveal are spread across the tree and none of them is
 * a child of the page being dragged:
 *
 *   --app-pull    the damped distance the page itself slides - feedback that
 *                 the gesture has hold of something, capped low because the
 *                 page is the thing being LEFT.
 *   --app-travel  the raw finger travel - what the preview's fade and the
 *                 backdrop blur are keyed to, so they spend themselves across
 *                 the whole pull rather than the first damped inch.
 *
 * React is told only when the gesture starts and ends (the preview mounts per
 * gesture, not per frame); everything per-frame goes straight to the DOM.
 *
 * `host` is the content host the gesture listens on (the same element the
 * edge-swipe drags) - the node itself, not a ref object, so the listeners
 * re-attach when it mounts after onboarding.
 */

/** Where the pull stops being a scroll. */
const SLOP = 10;
/**
 * Where letting go opens search. Far enough that an idle downward flick
 * springs back and a meant pull commits - "takes longer" than the old bar
 * did on purpose, because the reveal IS the animation now and it deserves
 * the length of a real gesture.
 */
const OPEN_AT = 180;
/** How far the page itself will slide, however hard it is pulled. */
const PAGE_SLIDE_CAP = 84;

export function useSearchSummon(host: HTMLElement | null) {
  const [searchOpen, setSearchOpen] = useState(false);
  useSystemBack(searchOpen, () => setSearchOpen(false));

  /** A gesture is live: the preview and the blur layer mount off this. */
  const [pulling, setPulling] = useState(false);

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
    let isPulling = false;
    let travel = 0;
    const ratchet = makeRatchet();
    /*
     * The page a touch landed in. `Element`, not `HTMLElement`: a touch that
     * lands on an <svg> or one of its <path>s has an SVGElement target, and
     * on a screen made of album art and icons that is most of the screen.
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
      ratchet.feel(travel, SLOP, OPEN_AT, e.timeStamp);
      if (travel >= OPEN_AT) ratchet.arrive('medium');
    };
    const onEnd = () => {
      const open = isPulling && travel >= OPEN_AT;
      armed = false;
      isPulling = false;
      travel = 0;
      paint(0, false);
      setPulling(false);
      if (open) setSearchOpen(true);
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

  return { pulling, summonHint, searchOpen, setSearchOpen };
}
