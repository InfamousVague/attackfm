import { useEffect, useState } from 'react';
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
  { href: '/#library', label: 'Library' },
  { href: '/#booth', label: 'The Booth' },
  { href: '/audiobooks/', label: 'Audiobooks' },
  { href: '/#everywhere', label: 'Everywhere' },
  { href: '/#yours', label: 'Self-hosted' },
  { href: '/#download', label: 'Download' },
];

export function Nav() {
  const { theme, toggle } = useTheme();
  const [stuck, setStuck] = useState(false);

  // The bar only gains a ground once the hero has scrolled under it. A scroll
  // listener is the right tool for a single boolean, but it must be passive so
  // it can never block the scroll it is watching.
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className="nav" data-stuck={stuck || undefined}>
      <div className="wrap wrap--wide nav__inner">
        <a href="/#top" aria-label="AttackFM home">
          <img className="nav__mark" src={wordmark} alt="AttackFM" width={2116} height={385} />
        </a>

        <nav className="nav__links" aria-label="Sections">
          {LINKS.map((link) => (
            <a key={link.href} className="nav__link" href={link.href}>
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
