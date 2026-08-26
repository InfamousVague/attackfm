import { Car, CloudOff, Monitor, QrCode, Smartphone, Waves } from '@glacier/icons';
import { Frame } from '../components/Frame.tsx';
import { Reveal } from '../components/Reveal.tsx';

const PLATFORMS = [
  {
    icon: Smartphone,
    title: 'Phone',
    body: 'iOS and Android, with lock-screen artwork, media controls and haptics that follow the transport.',
  },
  {
    icon: Monitor,
    title: 'Desktop',
    body: 'A native window on macOS, Windows and Linux, with the library laid out across the width.',
  },
  {
    icon: Car,
    title: 'Car',
    body: 'Android Auto from the dashboard, with artwork and controls where you expect them.',
  },
  {
    icon: CloudOff,
    title: 'Offline',
    body: 'Each device keeps a rolling 15 GB cache. Pin a record and it is never evicted.',
  },
  {
    icon: Waves,
    title: 'Handoff',
    body: 'Start on one device and pick it up on another. The queue follows you across the house.',
  },
  {
    icon: QrCode,
    title: 'Pairing',
    body: 'Add a device by scanning a code. No password typed into a phone keyboard.',
  },
];

/**
 * Feed the pointer position to the card's sheen gradient.
 *
 * Written straight to custom properties: no state, no re-render, and the paint
 * is a single composited gradient. Doing this through React state would rerender
 * a card on every pointer sample.
 */
function trackPointer(event: React.PointerEvent<HTMLElement>) {
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  el.style.setProperty('--my', `${event.clientY - rect.top}px`);
}

export function Everywhere() {
  return (
    <section className="section section--ruled" id="everywhere">
      <div className="wrap wrap--wide">
        <Reveal className="stack center sectionHead">
          <p className="eyebrow">On every screen</p>
          <h2 className="h2">One library. Every screen you own.</h2>
          <p className="lead">
            The same app, laid out for the machine it is on — a shelf of records on a phone, the
            whole table across a desktop. Both are below, both are running.
          </p>
        </Reveal>

        {/* The two frames sit together on purpose: the claim of this section is
            that it is ONE app, and two shots of it side by side is the argument
            made rather than stated. */}
        <Reveal delay={120} className="stage">
          <Frame
            device="desktop"
            screen="songs"
            className="stage__desktop"
            description="AttackFM on a desktop: every song in the library as a table, with artwork, album, date added and running time."
          />
          <Frame
            screen="home"
            className="stage__phone"
            description="AttackFM on a phone: the library screen, with shelves of playlists, recently added records and liked songs."
          />
          <div className="deviceGlow" />
        </Reveal>

        <div className="grid everywhere__grid">
          {PLATFORMS.map((item, i) => (
            <Reveal key={item.title} delay={i * 70} as="article">
              <article className="card card--lit" onPointerMove={trackPointer}>
                <span className="card__icon">
                  <item.icon size={20} />
                </span>
                <h3 className="h3">{item.title}</h3>
                <p className="body">{item.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
