import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, Moon, Sun } from '@glacier/icons';
import wordmark from '../../../src/assets/attack-white.png';
import { useTheme } from '../theme.ts';

/*
 * Rooted rather than bare hashes.
 *
 * There are two documents now, and a bare `#yours` from /audiobooks/ points at
 * an anchor that is not on that page - it would do nothing at all. `/#yours`
 * reads as a same-document jump from the home page and as a navigation from
 * anywhere else, which is exactly the behaviour wanted in both places.
 */
const LINKS = [
  { href: '/#dj', label: 'The DJ' },
  { href: '/audiobooks/', label: 'Audiobooks' },
  { href: '/#everywhere', label: 'Every screen' },
  { href: '/#yours', label: 'Self-hosted' },
  { href: '/#download', label: 'Download' },
];

/** How long a click's choice outranks the scroll spy. Long enough to cover a
 *  smooth scroll across the page, short enough that a person who clicks and
 *  then immediately scrolls away is not argued with. */
const CLICK_HOLDS_MS = 700;

/** Which link a URL selects. `/audiobooks/` is its own document, so it wins on
 *  pathname; everything else is a section of the home page and wins on hash. */
function linkFor(pathname: string, hash: string): string | null {
  if (pathname.startsWith('/audiobooks')) return '/audiobooks/';
  const byHash = LINKS.find((l) => l.href === `/${hash}`);
  return byHash?.href ?? null;
}

export function Nav() {
  const { theme, toggle } = useTheme();
  const [stuck, setStuck] = useState(false);

  const listRef = useRef<HTMLElement | null>(null);
  const seats = useRef(new Map<string, HTMLAnchorElement>());
  const [active, setActive] = useState<string | null>(null);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  /** The first placement jumps; every one after it slides. Without this the
   *  marker flies in from the left edge on load, which reads as a bug. */
  const [armed, setArmed] = useState(false);
  const heldUntil = useRef(0);

  // The bar only gains a ground once the hero has scrolled under it. A scroll
  // listener is the right tool for a single boolean, but it must be passive so
  // it can never block the scroll it is watching.
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /*
   * WHERE THE MARKER SITS, measured rather than declared.
   *
   * The links are words of different lengths, so the marker has to take its
   * width from the seat it is under - there is no grid to snap to. Measuring
   * the live element also means it stays right through a font swap, a theme
   * change that alters weight, or a viewport that reflows the row, none of
   * which a hard-coded table of offsets would survive.
   *
   * Offsets are taken relative to the list, not the page, so the marker can be
   * positioned inside it and needs no correction when the header is sticky.
   */
  const measure = useCallback(() => {
    const wrap = listRef.current;
    const seat = active ? seats.current.get(active) : null;
    if (!wrap || !seat) return setBox(null);
    const a = seat.getBoundingClientRect();
    const b = wrap.getBoundingClientRect();
    // A zero width means the row is display:none at this breakpoint. Hiding the
    // marker is right; a zero-width marker parked at x=0 is not.
    if (a.width === 0) return setBox(null);
    setBox({ x: a.left - b.left, w: a.width });
  }, [active]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  /*
   * Arm the transition once the marker has been placed for real.
   *
   * A passive effect, deliberately, not requestAnimationFrame. rAF does not run
   * at all in a hidden tab, so a page opened in the background would sit with
   * the transition permanently disarmed until it was looked at - and it makes
   * the behaviour untestable in any headless or backgrounded viewport. React
   * runs passive effects after paint, which is the same guarantee rAF was being
   * used for here, without depending on the frame loop.
   */
  useEffect(() => {
    if (box && !armed) setArmed(true);
  }, [box, armed]);

  // Re-measure on anything that can move the seats under the marker.
  useEffect(() => {
    const again = () => measure();
    window.addEventListener('resize', again);
    const ro = 'ResizeObserver' in window ? new ResizeObserver(again) : null;
    if (ro && listRef.current) ro.observe(listRef.current);
    // Web fonts land after first paint and change every word's width.
    document.fonts?.ready.then(again).catch(() => {});
    return () => {
      window.removeEventListener('resize', again);
      ro?.disconnect();
    };
  }, [measure]);

  // The URL is the source of truth on load and on back/forward.
  useEffect(() => {
    const fromUrl = () => setActive(linkFor(location.pathname, location.hash));
    fromUrl();
    window.addEventListener('hashchange', fromUrl);
    window.addEventListener('popstate', fromUrl);
    return () => {
      window.removeEventListener('hashchange', fromUrl);
      window.removeEventListener('popstate', fromUrl);
    };
  }, []);

  /*
   * A SPY, because otherwise the marker lies.
   *
   * These are anchors into one long page, so the hash stops describing where
   * the reader is the moment they scroll. A marker still pointing at "Library"
   * while The Booth fills the screen is worse than no marker at all - it is
   * confidently wrong. So the section nearest the top of the viewport wins,
   * except for a beat after a click, when the person's stated intent outranks
   * whatever the page is doing mid-scroll.
   */
  useEffect(() => {
    if (location.pathname.startsWith('/audiobooks')) return;
    const ids = LINKS.map((l) => l.href.match(/^\/#(.+)$/)?.[1]).filter(Boolean) as string[];
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (!sections.length) return;

    const pick = () => {
      if (Date.now() < heldUntil.current) return;
      // Nearest to the top edge, ignoring anything already scrolled past it.
      let best: { href: string; d: number } | null = null;
      for (const el of sections) {
        const top = el.getBoundingClientRect().top;
        const d = Math.abs(top - 96); // just under the sticky bar
        if (top < window.innerHeight * 0.6 && (!best || d < best.d)) {
          best = { href: `/#${el.id}`, d };
        }
      }
      setActive(best?.href ?? null);
    };

    pick();
    window.addEventListener('scroll', pick, { passive: true });
    return () => window.removeEventListener('scroll', pick);
  }, []);

  const onSeatClick = (href: string) => {
    // Move on the click, not when the scroll finishes: the animation is the
    // acknowledgement, and waiting for the scroll makes the bar feel deaf.
    if (href.startsWith('/#')) {
      heldUntil.current = Date.now() + CLICK_HOLDS_MS;
      setActive(href);
    }
  };

  return (
    <header className="nav" data-stuck={stuck || undefined}>
      <div className="wrap wrap--wide nav__inner">
        <a href="/#top" aria-label="AttackFM home">
          <img className="nav__mark" src={wordmark} alt="AttackFM" width={2116} height={385} />
        </a>

        <nav className="nav__links" aria-label="Sections" ref={listRef}>
          {/* One marker for the whole row, so moving between links is a slide
              rather than one underline fading out while another fades in. */}
          <span
            className="nav__marker"
            data-armed={armed || undefined}
            aria-hidden
            style={
              box
                ? { transform: `translateX(${box.x}px)`, width: `${box.w}px`, opacity: 1 }
                : { opacity: 0 }
            }
          />
          {LINKS.map((link) => (
            <a
              key={link.href}
              className="nav__link"
              href={link.href}
              ref={(el) => {
                if (el) seats.current.set(link.href, el);
                else seats.current.delete(link.href);
              }}
              onClick={() => onSeatClick(link.href)}
              aria-current={active === link.href ? 'true' : undefined}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="nav__actions">
          <button
            type="button"
            className="iconBtn"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <a className="btn btn--primary" href="/#download" style={{ padding: '0.6rem 1.15rem', fontSize: '0.92rem' }}>
            <Download size={16} />
            Get the app
          </a>
        </div>
      </div>
    </header>
  );
}
