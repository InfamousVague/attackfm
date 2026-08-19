import {
  AudioLines,
  Car,
  CloudOff,
  Disc3,
  Ear,
  Gauge,
  LibraryBig,
  ListMusic,
  Monitor,
  QrCode,
  Radio,
  ScanSearch,
  Smartphone,
  Sparkles,
  Waves,
} from '@glacier/icons';
import { LaptopShot, PhoneShot } from '../components/Device.tsx';
import { PhoneVideo } from '../components/PhoneVideo.tsx';
import { Reveal } from '../components/Reveal.tsx';
import { SHOTS } from '../shots.ts';

/** The animated equaliser used as a small "this is audio" mark. */
function Eq({ bars = 5 }: { bars?: number }) {
  return (
    <span className="eq" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className="eq__bar"
          // Prime-ish offsets so the bars never sync into a single pulse.
          style={{ animationDelay: `${(i * 137) % 700}ms`, animationDuration: `${900 + i * 90}ms` }}
        />
      ))}
    </span>
  );
}

function Point({ icon: Icon, children }: { icon: typeof Disc3; children: React.ReactNode }) {
  return (
    <li className="point">
      <span className="point__icon">
        <Icon size={16} />
      </span>
      <span>{children}</span>
    </li>
  );
}

export function Library() {
  return (
    <section className="section section--ruled" id="library">
      <div className="wrap wrap--wide row">
        <Reveal variant="left" className="stack">
          <p className="eyebrow">The library</p>
          <h2 className="h2">
            Every record you own, <span className="accent">whole</span>.
          </h2>
          <p className="body">
            Point it at your music folder and it reads everything there: FLAC, ALAC, MP3, AAC,
            OGG, Opus, AIFF and WAV. Artists, albums and artwork come out of the tags. Multi-disc
            releases keep their discs, and the tracks are numbered the way the sleeve numbers them.
          </p>
          <ul className="points">
            <Point icon={LibraryBig}>Albums, artists and playlists stay in step as the files change</Point>
            <Point icon={ScanSearch}>
              Search forgives a typo and takes operators like <code>artist:</code> and{' '}
              <code>year:</code>
            </Point>
            <Point icon={Disc3}>Cover art is cached at the sizes each screen asks for</Point>
          </ul>
        </Reveal>

        <Reveal variant="right" className="row__media">
          <div className="stackShots">
            <LaptopShot shot={SHOTS.desktopAlbum} className="stackShots__back" />
            <PhoneShot shot={SHOTS.library} className="stackShots__front" />
          </div>
          <div className="deviceGlow" />
        </Reveal>
      </div>
    </section>
  );
}

export function Booth() {
  return (
    <section className="section" id="booth">
      <div className="aurora" aria-hidden="true">
        <div className="aurora__blob aurora__blob--a" />
        <div className="aurora__blob aurora__blob--b" />
      </div>

      <div className="wrap wrap--wide row row--flip">
        <Reveal variant="right" className="stack">
          <p className="eyebrow">
            The Booth <Eq />
          </p>
          <h2 className="h2">
            A DJ that <span className="accent">listens</span> to the music.
          </h2>
          <p className="body">
            Most shuffles read tags. This one reads the audio. It measures a fingerprint off every
            recording, its texture and its energy and how it sits in a room, then weighs that against
            the words and against what you have played before. Every pick carries the reason it was
            chosen, printed under the artist.
          </p>
          <ul className="points">
            <Point icon={Ear}>Sets are ordered by how the recordings sound</Point>
            <Point icon={Sparkles}>
              Two slots in every set are a gamble. Finish one and it comes back; skip it and it
              fades
            </Point>
            <Point icon={Radio}>Smart shuffle slips in songs the server thinks belong in your queue</Point>
          </ul>
        </Reveal>

        <Reveal variant="left" className="row__media">
          <PhoneShot shot={SHOTS.booth} className="tilt" />
          <div className="deviceGlow" />
        </Reveal>
      </div>
    </section>
  );
}

export function Playing() {
  return (
    <section className="section section--ruled" id="playing">
      <div className="wrap wrap--wide row">
        <Reveal variant="left" className="stack">
          <p className="eyebrow">Now playing</p>
          <h2 className="h2">
            The whole screen goes to the <span className="accent">song</span>.
          </h2>
          <p className="body">
            Artwork fills the screen. Lyrics scroll to the line being sung, and a track with a
            looping visual plays it behind the controls. Hold the waveform and it scrubs like tape.
          </p>
          <ul className="points">
            <Point icon={AudioLines}>Hold the waveform and drag to scrub by hand</Point>
            <Point icon={Gauge}>A graphic equaliser and a rack of effects</Point>
            <Point icon={ListMusic}>Up Next: queue a song from anywhere, then drag it into order</Point>
          </ul>
        </Reveal>

        <Reveal variant="right" className="row__media">
          <div className="pairShots">
            <PhoneVideo />
            <PhoneShot shot={SHOTS.stats} className="pairShots__offset" />
          </div>
          <div className="deviceGlow" />
        </Reveal>
      </div>
    </section>
  );
}

export function Everywhere() {
  return (
    <section className="section" id="everywhere">
      <div className="wrap wrap--wide">
        <Reveal className="stack center sectionHead">
          <p className="eyebrow">Everywhere</p>
          <h2 className="h2">One library. Every screen you own.</h2>
          <p className="lead">
            One server behind your phone, your desktop and your dashboard. The cache on each device
            keeps the music going when the network drops.
          </p>
        </Reveal>

        <div className="grid everywhere__grid">
          {[
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
          ].map((item, i) => (
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

        <Reveal delay={120} className="everywhere__stage">
          <LaptopShot shot={SHOTS.desktop} />
          <PhoneShot shot={SHOTS.home} className="everywhere__phone" />
          <div className="deviceGlow" />
        </Reveal>
      </div>
    </section>
  );
}

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
