import { useEffect } from 'react';
import { REDUCED_MOTION_QUERY } from './useReducedMotion.ts';

/**
 * The scroll-driven wave: cards ripple into place as they ENTER THE VIEW -
 * at page open, while scrolling down, even sliding a shelf sideways. This
 * replaced a mount-time nth-child wave that only ever played once (and mostly
 * into a screen nobody had scrolled to yet): the observer makes the entrance
 * happen exactly when the item and the eye actually meet. Purely visual - no
 * haptic rides it (a tick as each card scrolled in felt like force feedback).
 *
 * Mechanics: one IntersectionObserver per page. Items are hidden the moment
 * they are registered (data-ripple-seen, before first paint of the page's
 * animation frame) and revealed when they first intersect (data-rippled).
 * Everything intersecting in the same beat forms a BATCH: the batch gets
 * staggered delays - that is the wave. Each item ripples once per page visit;
 * the observer lets it go on arrival.
 *
 * Reduced motion: nothing is ever hidden and nothing moves.
 */

/** The boxes that ride the wave - concrete card classes, because the menu
 *  wrappers around most of them are display:contents and cannot animate. */
const RIPPLE_SELECTOR = [
  '.trackCard',
  '.artistCard',
  '.playlistTile',
  '.mixCard',
  '.shelfGhost',
  // Search: result rows, genre tiles, the hero card, the recents strip.
  '.searchRow',
  '.searchGenre',
  '.searchTopCard',
  '.searchRecent',
  // Discover and its artist catalogue: suggestion cards, releases, tracks.
  '.suggestCard',
  '.resultCard',
  '.catalogTrack',
].join(', ');

/** The stagger between neighbours in one arriving batch. */
const STEP_MS = 35;
/** Delays cap out here: a huge first screenful still finishes its wave
 *  within half a second rather than trickling. */
const MAX_STEPS = 14;

/**
 * Takes the host NODE (state-carried via a callback ref), not a ref object:
 * a ref object never changes identity, so an effect keyed on one runs exactly
 * once and stays bound to whatever element existed at first mount - which is
 * a detached node the moment a page like Discover swaps its content out and
 * back (its catalogue-artist round trip does exactly that). Keyed on the
 * element itself, the observers follow the DOM they are meant to watch.
 */
export function useRippleWave(host: HTMLElement | null): void {
  useEffect(() => {
    if (!host) return;
    const still = window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;

    // The batch under assembly: everything the observer reports in one beat
    // lands as one wave. Flushed on a frame so two callback bursts within
    // the same scroll tick still count as neighbours.
    let batch: HTMLElement[] = [];
    let flush = 0;

    const land = () => {
      flush = 0;
      const wave = batch;
      batch = [];
      wave.forEach((el, i) => {
        const step = Math.min(i, MAX_STEPS);
        el.style.setProperty('--ripple-d', `${step * STEP_MS}ms`);
        el.setAttribute('data-rippled', '');
      });
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          batch.push(entry.target as HTMLElement);
        }
        if (batch.length > 0 && flush === 0) {
          flush = requestAnimationFrame(land);
        }
      },
      // A sliver inside the edge, so items land as they truly arrive rather
      // than while still a pixel offscreen.
      { threshold: 0.1 },
    );

    /**
     * Whether this environment can be trusted to say what is on screen.
     *
     * Hiding is load-bearing here - an item that never lands never appears -
     * so it may only be done where the answer can actually come back. A
     * webview mid-layout, a backgrounded tab, an embedded pane: these report
     * a zero viewport or a hidden document, no intersection ever fires, and
     * every registered card is invisible for the life of the page. That is
     * the whole library gone below the first screenful. When the room cannot
     * be measured, nothing hides and the wave simply does not play.
     */
    const measurable = () =>
      window.innerHeight > 0 && window.innerWidth > 0 && document.visibilityState !== 'hidden';

    const register = (el: Element) => {
      if (!(el instanceof HTMLElement) || el.hasAttribute('data-ripple-seen')) return;
      el.setAttribute('data-ripple-seen', '');
      // Reduced motion never hides; the observer still runs for the ticks.
      // Neither does an unmeasurable viewport - see above.
      if (still || !measurable()) el.setAttribute('data-rippled', '');
      io.observe(el);
    };

    host.querySelectorAll(RIPPLE_SELECTOR).forEach(register);

    // Belt and braces under the observer: some environments under-report
    // intersections (throttled webviews, clipped shelf viewports mid-layout),
    // and a card that never lands is a card that never EXISTS - opacity 0 is
    // load-bearing. So every scroll (any scroller - the page div, a shelf)
    // and a few settling beats after mount, still-held items get a manual
    // rect check and land through the same batch path.
    const sweep = () => {
      // The room went unmeasurable after registration (the app was backgrounded,
      // the pane collapsed): reveal everything rather than leave the page blank.
      if (!measurable()) {
        for (const el of host.querySelectorAll('[data-ripple-seen]:not([data-rippled])')) {
          el.setAttribute('data-rippled', '');
        }
        return;
      }
      for (const el of host.querySelectorAll('[data-ripple-seen]:not([data-rippled])')) {
        const r = el.getBoundingClientRect();
        const visible =
          r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth &&
          r.width > 0 && r.height > 0;
        if (visible) {
          io.unobserve(el);
          batch.push(el as HTMLElement);
        }
      }
      if (batch.length > 0 && flush === 0) flush = requestAnimationFrame(land);
    };
    let sweepArmed = 0;
    const onScroll = () => {
      if (sweepArmed) return;
      sweepArmed = requestAnimationFrame(() => {
        sweepArmed = 0;
        sweep();
      });
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // Coming back from the background is exactly when the observer is stale and
    // the viewport has just become measurable again, so re-ask then. Same for a
    // resize, which is how a webview reports that it finally has a size.
    document.addEventListener('visibilitychange', onScroll);
    window.addEventListener('resize', onScroll, { passive: true });
    // The settling beats: layout shifts as art and feeds land in the first
    // seconds, and these catch anything the mount-time pass missed.
    // The last beat is deliberately late: a slow first sync, cold art, or a
    // webview that only settles its layout after a second or two all land
    // inside it, and a page that has gone quiet by then is a page whose cards
    // are either on screen or genuinely below it.
    const settle = [400, 1200, 2600, 6000].map((ms) => window.setTimeout(sweep, ms));
    // Cards mount as data lands (sync, art, playlists arriving) - new ones
    // join the watch the moment they exist.
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches?.(RIPPLE_SELECTOR)) register(node);
          node.querySelectorAll?.(RIPPLE_SELECTOR).forEach(register);
        }
      }
    });
    mo.observe(host, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      io.disconnect();
      document.removeEventListener('scroll', onScroll, { capture: true });
      document.removeEventListener('visibilitychange', onScroll);
      window.removeEventListener('resize', onScroll);
      if (sweepArmed) cancelAnimationFrame(sweepArmed);
      for (const t of settle) window.clearTimeout(t);
      if (flush) cancelAnimationFrame(flush);
    };
  }, [host]);
}
