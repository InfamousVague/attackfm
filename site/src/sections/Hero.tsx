import { Apple, Download, Play, ServerCog } from '@glacier/icons';
import wordmark from '../../../src/assets/attack-white.png';
import { Frame } from '../components/Frame.tsx';
import { Reveal } from '../components/Reveal.tsx';
import { WALL } from '../shots.ts';

/**
 * The drifting wall of album art.
 *
 * Columns alternate direction and each holds its content twice, so the -50%
 * keyframe lands exactly on a seam and the loop is invisible. Only `transform`
 * animates; the blur is applied once at a fixed radius on the container, never
 * per frame.
 */
function Wall() {
  const columns = 6;

  return (
    <div className="wall" aria-hidden="true">
      <div className="wall__grid">
        {Array.from({ length: columns }, (_, col) => {
          // Each column gets its own offset slice so neighbours never show the
          // same cover side by side, and its own duration so the columns do not
          // visibly march in lockstep.
          const slice = Array.from({ length: 8 }, (_, i) => WALL[(col * 3 + i) % WALL.length]!);
          return (
            <div
              key={col}
              className={`wall__col${col % 2 ? ' wall__col--down' : ''}`}
              style={{ ['--wall-dur' as string]: `${72 + col * 9}s` }}
            >
              {[...slice, ...slice].map((src, i) => (
                <img key={i} src={src} alt="" loading={col > 2 ? 'lazy' : 'eager'} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="wall__veil" />
    </div>
  );
}

export function Hero() {
  return (
    <section className="hero" id="top">
      <Wall />

      <div className="wrap wrap--wide hero__inner">
        <div className="hero__copy">
          <Reveal>
            <span className="pill">
              <span className="pulse" />
              Self-hosted · iOS, Android &amp; desktop
            </span>
          </Reveal>

          <Reveal delay={80}>
            <h1 className="display hero__title">
              <img className="hero__mark" src={wordmark} alt="AttackFM" width={2116} height={385} />
              <span className="visually-hidden">AttackFM.</span>
              <span className="hero__line">Your music, on your machines.</span>
            </h1>
          </Reveal>

          <Reveal delay={160}>
            <p className="lead hero__lead">
              A player and a server you run yourself. The files stay on your hardware, and every
              device you own plays from them.
            </p>
          </Reveal>

          <Reveal delay={240}>
            <div className="cluster hero__cta">
              <a className="btn btn--primary" href="#download">
                <Download size={18} />
                Download
              </a>
              {/* The lowest-friction way in: no install, no store, no
                  waiting - the same app, running in the tab they are already
                  reading this in. It sits beside Download rather than under
                  it because for a first look it is the better offer. */}
              <a className="btn btn--ghost" href="/listen/">
                <Play size={17} />
                Open in your browser
              </a>
            </div>
          </Reveal>

          <Reveal delay={320}>
            <ul className="hero__facts">
              <li>
                <Apple size={15} /> iOS &amp; iPadOS
              </li>
              <li>
                <ServerCog size={15} /> Runs on hardware you own
              </li>
            </ul>
          </Reveal>
        </div>

        {/* Eager, and the only frame that is: it is above the fold, so waiting
            to be scrolled to would mean waiting forever. */}
        <Reveal delay={220} variant="scale" className="hero__device">
          <Frame
            eager
            screen="playing"
            description="AttackFM playing on a phone: the sleeve turning as a record, the song and artist beneath it, and a seek bar running."
          />
          <div className="deviceGlow" />
        </Reveal>
      </div>

      <div className="hero__scroll" aria-hidden="true">
        <span />
      </div>
    </section>
  );
}
