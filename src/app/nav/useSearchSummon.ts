import { useEffect, useRef, useState } from 'react';
import { useSystemBack } from './systemBack.ts';

/**
 * The pull from the top, in two stages.
 *
 * A downward drag at the top of a page means one of two things, and which one
 * depends on how far it goes. Every other app has taught the same lesson: a
 * SHORT pull reveals what is above the page - here, the search field - and a
 * LONG one refreshes. This used to be a single threshold that summoned search
 * whole at 72px, which meant the muscle memory for "refresh" landed in a
 * search overlay instead, and nothing refreshed anything.
 *
 * So the drag is tracked as a distance rather than a flag:
 *
 *   0 → SEARCH_AT     nothing yet; a scroll that changed its mind costs
 *                     nothing and shows nothing.
 *   SEARCH_AT →       the search bar rides down with the finger, real and
 *   REFRESH_AT        tappable when let go. This is the stage a small pull
 *                     lands in, and it does not steal the page: the bar sits
 *                     ABOVE the content, the way a mail app's does.
 *   REFRESH_AT →      the refresh mark fades in over the bar. Let go here and
 *                     the library re-reads itself.
 *
 * The two stages share one gesture, so a finger can travel between them and
 * see the answer change under it before committing.
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

export function useSearchSummon(host: HTMLElement | null, onRefresh?: () => Promise<void> | void) {
  const [searchOpen, setSearchOpen] = useState(false);
  useSystemBack(searchOpen, () => setSearchOpen(false));

  /*
   * The live drag. `pull` is the distance the finger has travelled past the
   * top, already damped; the bar and the refresh mark both read it, so what
   * is on screen is always exactly where the finger is.
   *
   * Kept in state rather than on a ref because two pieces of chrome render
   * from it. It only updates while a finger is down, which is the one moment
   * a render per frame is what the user is asking for.
   */
  const [pull, setPull] = useState(0);
  /*
   * The same distance, readable without re-subscribing.
   *
   * `pull` cannot be in the effect's deps: the listeners would be torn down
   * and rebuilt on every frame of the drag, and `armed`/`pulling` live inside
   * the effect - so each rebuild forgot the gesture was in progress and the
   * distance froze one move in. It reached the search threshold and could
   * never reach the refresh one, which is exactly what a 340px pull did.
   */
  const pullRef = useRef(0);
  /** The bar, left standing after a stage-one pull, until it is used or
   *  dismissed. This is the part a small pull is FOR. */
  const [barOpen, setBarOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!host) return;
    let startY = 0;
    let startX = 0;
    let armed = false;
    let pulling = false;
    const pageOf = (target: EventTarget | null): HTMLElement | null => {
      let el = target instanceof HTMLElement ? target : null;
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
      const damped = dy <= 0 ? 0 : Math.sqrt(dy) * 11;
      pullRef.current = damped;
      setPull(damped);
    };
    const onEnd = () => {
      const settled = pullRef.current;
      armed = false;
      pulling = false;
      pullRef.current = 0;
      setPull(0);
      if (settled >= REFRESH_AT) {
        // Past the far mark: refresh, and hold the mark up while it runs so
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
    };
  }, [host]);

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
    /** 0 while idle; the damped distance of a live pull. */
    pull,
    /** Thresholds, so the chrome and the gesture cannot disagree. */
    searchAt: SEARCH_AT,
    refreshAt: REFRESH_AT,
    /** The revealed search bar, standing after a stage-one pull. */
    barOpen,
    setBarOpen,
    refreshing,
    summonHint,
    searchOpen,
    setSearchOpen,
  };
}
