import { GitBranch } from '@glacier/icons';
import wordmark from '../../../src/assets/attack-white.png';

const REPO = 'https://github.com/InfamousVague/attackfm';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Library', href: '#library' },
      { label: 'The Booth', href: '#booth' },
      { label: 'Now playing', href: '#playing' },
      { label: 'Everywhere', href: '#everywhere' },
    ],
  },
  {
    title: 'Run it',
    links: [
      { label: 'Self-hosting', href: '#yours' },
      { label: 'Install the server', href: '#get' },
      { label: 'Source', href: REPO },
      { label: 'Releases', href: `${REPO}/releases` },
    ],
  },
  {
    title: 'Built with',
    links: [{ label: 'Glacier UI', href: 'https://github.com/InfamousVague/GlacierUI' }],
  },
];

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap wrap--wide">
        <div className="footer__grid">
          <div>
            <img
              className="nav__mark footer__mark"
              src={wordmark}
              alt="AttackFM"
              width={2116}
              height={385}
            />
            <p className="body footer__blurb">Your music, on your machines.</p>
            <a className="iconBtn" href={REPO} aria-label="AttackFM on GitHub">
              <GitBranch size={17} />
            </a>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h2 className="footer__title">{column.title}</h2>
              <ul className="footer__list">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="footer__fine">
          AttackFM plays the music you already own. It is not a store and it does not supply a
          catalogue.
        </p>
      </div>
    </footer>
  );
}
