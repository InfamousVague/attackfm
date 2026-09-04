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
 * THE VIEW IS NOT THE VIEWPORT. On the phone the page scrolls behind glass:
 * the nav plate and the player strip cover the bottom of the scroller (77px
 * for the bar alone, the better part of 200 with a song up and the home
 * indicator), and the Library and Discover slide up under the header too.
 * Judged against the bare viewport - which is what this used to do - a card
 * landed the moment a sliver of it crossed the SCREEN's bottom edge, i.e.
 * while it was still entirely under the plates; measured on WebKit with the
 * bar alone, every landing during a scroll sat 15-80px below the visible
 * band and the card was first seen 130-210ms into its 0.43s entrance - with
 * the player up, the whole entrance plays out behind the frost before the
 * card ever emerges. So everything here judges arrival against the VISIBLE
 * BAND: the scroller's box, less the chrome the app lays over it (see `band`).
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
/** How far inside the band's edge an item must reach before it counts as
 *  arrived, in px: a sliver, so it lands as it truly appears rather than
 *  while still a pixel behind the plate - and the same sliver on both paths
 *  (observer margin and rect sweep), so the two never disagree. */
const SLIVER = 8;
/** How long the per-frame sweep keeps running after the last scroll event.
 *  Momentum scrolling reports a scroll every frame, so this only decides how
 *  many quiet frames are checked after a fling settles. */
const SETTLE_MS = 160;

type Band = { top: number; right: number; bottom: number; left: number };

/** The nearest scroll container from `el` up - the page div, or the pane an
 *  embedded feed sits in. Null when nothing between here and the body scrolls. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

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

    // Everything registered and not yet landed. A set rather than a query,
    // because the sweep below walks it every frame of a scroll.
    const held = new Set<HTMLElement>();

    // The batch under assembly: everything the observer reports in one beat
    // lands as one wave. Flushed on a frame so two callback bursts within
    // the same scroll tick still count as neighbours.
    let batch: HTMLElement[] = [];
    let flush = 0;

    const land = () => {
      if (flush) cancelAnimationFrame(flush);
      flush = 0;
      const wave = batch;
      batch = [];
      wave.forEach((el, i) => {
        const step = Math.min(i, MAX_STEPS);
        el.style.setProperty('--ripple-d', `${step * STEP_MS}ms`);
        el.setAttribute('data-rippled', '');
      });
    };

    /** Into the batch, once: the observer and the sweep both call this and
     *  may well agree about the same card in the same frame. */
    const arrive = (el: HTMLElement) => {
      if (!held.delete(el)) return;
      io.unobserve(el);
      batch.push(el);
    };

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

    /**
     * The part of the screen a card can actually be seen in.
     *
     * The scroller's box, clipped to the viewport, less the chrome laid over
     * it: at the bottom, the plates the page reserves room for - its own
     * padding-block-end is calc(--app-player-height + --app-nav-height) by
     * contract (every page pads for the band; the developer pane calls them
     * "the three heights every page's bottom padding is calculated from"),
     * and reading the padding is how those tokens come back as pixels. At the
     * top, the header: App publishes --app-header-height on the root as
     * measured pixels, and on the pages that slide up under the glass the
     * scroller's own top is above it. Null when the room cannot be measured
     * (a scroller with no box yet), in which case the caller falls back to
     * the bare viewport - a wrong edge is a blemish, a card that never lands
     * is a hole.
     */
    let scroller: HTMLElement | null = null;
    const band = (): Band | null => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (!scroller || !scroller.isConnected) scroller = scrollerOf(host);
      let top = 0;
      let left = 0;
      let right = vw;
      let bottom = vh;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const reserved = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
        top = Math.max(top, r.top);
        left = Math.max(left, r.left);
        right = Math.min(right, r.right);
        bottom = Math.min(bottom, r.bottom - reserved);
      }
      const header = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--app-header-height'),
      );
      if (Number.isFinite(header) && header > 0) top = Math.max(top, header);
      if (bottom - top <= SLIVER * 2 || right - left <= SLIVER * 2) return null;
      return { top, right, bottom, left };
    };
    const viewport = (): Band => ({ top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight });

    /** Whether a box has reached SLIVER px into the band. */
    const inside = (r: DOMRect, b: Band) =>
      r.width > 0 &&
      r.height > 0 &&
      r.top < b.bottom - SLIVER &&
      r.bottom > b.top + SLIVER &&
      r.left < b.right - SLIVER &&
      r.right > b.left + SLIVER;

    /**
     * The observer watches the band, not the viewport: its root margin pulls
     * the viewport's edges in to the band's, sliver included. Rebuilt whenever
     * the band changes shape (the player strip rising, a resize) - rare, and
     * only ever checked from a sweep.
     */
    let io: IntersectionObserver;
    let ioMargin = '';
    const marginFor = (b: Band) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const px = (n: number) => `${-Math.max(0, Math.round(n))}px`;
      return `${px(b.top + SLIVER)} ${px(vw - b.right + SLIVER)} ${px(vh - b.bottom + SLIVER)} ${px(b.left + SLIVER)}`;
    };
    const onIntersect: IntersectionObserverCallback = (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        arrive(entry.target as HTMLElement);
      }
      if (batch.length > 0 && flush === 0) flush = requestAnimationFrame(land);
    };
    const buildObserver = (margin: string) => {
      ioMargin = margin;
      io = new IntersectionObserver(onIntersect, { rootMargin: margin, threshold: 0 });
      held.forEach((el) => io.observe(el));
    };
    buildObserver(marginFor(band() ?? viewport()));

    const register = (el: Element) => {
      if (!(el instanceof HTMLElement) || el.hasAttribute('data-ripple-seen')) return;
      el.setAttribute('data-ripple-seen', '');
      // Reduced motion never hides; the observer still runs for the ticks.
      // Neither does an unmeasurable viewport - see above.
      if (still || !measurable()) el.setAttribute('data-rippled', '');
      held.add(el);
      io.observe(el);
    };

    host.querySelectorAll(RIPPLE_SELECTOR).forEach(register);

    // Belt and braces under the observer, and the hand on the wheel during a
    // scroll: some environments under-report intersections (throttled
    // webviews, clipped shelf viewports mid-layout), and a card that never
    // lands is a card that never EXISTS - opacity 0 is load-bearing. So on
    // every frame of a scroll (any scroller - the page div, a shelf) and a few
    // settling beats after mount, still-held items get a manual rect check
    // against the band and land through the same batch path. Per frame rather
    // than per event because that is when the eye meets the card: the
    // observer's notice arrives a task later, the sweep lands it in the frame
    // it crossed the edge.
    const clips = new WeakMap<Element, boolean>();
    const sweep = () => {
      // The room went unmeasurable after registration (the app was backgrounded,
      // the pane collapsed): reveal everything rather than leave the page blank.
      if (!measurable()) {
        held.forEach((el) => el.setAttribute('data-rippled', ''));
        held.clear();
        return;
      }
      const b = band() ?? viewport();
      const margin = marginFor(b);
      if (margin !== ioMargin) {
        io.disconnect();
        buildObserver(margin);
      }
      // Ancestors that clip - a shelf's own scrollport - cut a card's box
      // down before it is judged, as the observer would; measured once per
      // sweep, shared by every card on the shelf.
      const clipRects = new Map<Element, DOMRect>();
      for (const el of held) {
        if (!el.isConnected) {
          held.delete(el);
          continue;
        }
        let r = el.getBoundingClientRect();
        for (let p = el.parentElement; p && p !== scroller && p !== document.body; p = p.parentElement) {
          let clip = clips.get(p);
          if (clip === undefined) {
            const cs = getComputedStyle(p);
            clip = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
            clips.set(p, clip);
          }
          if (!clip) continue;
          let box = clipRects.get(p);
          if (!box) {
            box = p.getBoundingClientRect();
            clipRects.set(p, box);
          }
          r = new DOMRect(
            Math.max(r.left, box.left),
            Math.max(r.top, box.top),
            Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)),
            Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)),
          );
        }
        if (inside(r, b)) arrive(el);
      }
      // Landed here and now, in the frame the card crossed the edge: a frame
      // later is a frame of the entrance the eye has already missed.
      if (batch.length > 0) land();
    };
    let loop = 0;
    let lastScroll = 0;
    const tick = () => {
      loop = 0;
      sweep();
      if (performance.now() - lastScroll < SETTLE_MS) loop = requestAnimationFrame(tick);
    };
    const onScroll = () => {
      lastScroll = performance.now();
      if (!loop) loop = requestAnimationFrame(tick);
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
      if (loop) cancelAnimationFrame(loop);
      for (const t of settle) window.clearTimeout(t);
      if (flush) cancelAnimationFrame(flush);
    };
  }, [host]);
}
