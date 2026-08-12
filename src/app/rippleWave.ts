import { useEffect, type RefObject } from 'react';
import { fireMicroTick } from './haptics.ts';

/**
 * The scroll-driven wave: cards ripple into place as they ENTER THE VIEW -
 * at page open, while scrolling down, even sliding a shelf sideways - and
 * each landing is felt as a soft tick. This replaced a mount-time nth-child
 * wave that only ever played once (and mostly into a screen nobody had
 * scrolled to yet): the observer makes the entrance happen exactly when the
 * item and the eye actually meet.
 *
 * Mechanics: one IntersectionObserver per page. Items are hidden the moment
 * they are registered (data-ripple-seen, before first paint of the page's
 * animation frame) and revealed when they first intersect (data-rippled).
 * Everything intersecting in the same beat forms a BATCH: the batch gets
 * staggered delays - that is the wave - and its landings tick along the
 * stagger, floored so a flung scrollbar patters instead of buzzing. Each
 * item ripples once per page visit; the observer lets it go on arrival.
 *
 * Reduced motion: nothing is ever hidden and nothing moves - the ticks
 * still speak, since the Taptic Engine is that setting's substitute for
 * motion, not another source of it.
 */

/** The boxes that ride the wave - concrete card classes, because the menu
 *  wrappers around most of them are display:contents and cannot animate. */
const RIPPLE_SELECTOR =
  '.trackCard, .artistCard, .playlistTile, .mixCard, .shelfGhost';

/** Landing ticks never come closer than this, whatever the scroll does. */
const TICK_FLOOR_MS = 70;
/** The stagger between neighbours in one arriving batch. */
const STEP_MS = 35;
/** Delays cap out here: a huge first screenful still finishes its wave
 *  within half a second rather than trickling. */
const MAX_STEPS = 14;

let lastTick = 0;

function landingTick(): void {
  const now = performance.now();
  if (now - lastTick < TICK_FLOOR_MS) return;
  lastTick = now;
  fireMicroTick();
}

export function useRippleWave(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

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
        // The thud rides the same stagger the eye sees. Timeouts rather than
        // animation events: the wave must patter even under reduced motion,
        // where there is no animation to listen to.
        window.setTimeout(landingTick, step * STEP_MS);
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

    const register = (el: Element) => {
      if (!(el instanceof HTMLElement) || el.hasAttribute('data-ripple-seen')) return;
      el.setAttribute('data-ripple-seen', '');
      // Reduced motion never hides; the observer still runs for the ticks.
      if (still) el.setAttribute('data-rippled', '');
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
    // The settling beats: layout shifts as art and feeds land in the first
    // seconds, and these catch anything the mount-time pass missed.
    const settle = [400, 1200, 2600].map((ms) => window.setTimeout(sweep, ms));
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
      if (sweepArmed) cancelAnimationFrame(sweepArmed);
      for (const t of settle) window.clearTimeout(t);
      if (flush) cancelAnimationFrame(flush);
    };
  }, [root]);
}
