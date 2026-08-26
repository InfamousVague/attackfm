import { Ear, ListMusic, Radio, Sparkles } from '@glacier/icons';
import { Frame } from '../components/Frame.tsx';
import { Reveal } from '../components/Reveal.tsx';

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

function Point({ icon: Icon, children }: { icon: typeof Ear; children: React.ReactNode }) {
  return (
    <li className="point">
      <span className="point__icon">
        <Icon size={16} />
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * The DJ.
 *
 * Named for what ships. There is a Booth page behind developer mode where this
 * was built, and the old version of this section sold it - but the thing an
 * ordinary listener touches is the tile on their own library screen, and a
 * marketing page should describe the door people can actually open.
 */
export function Booth() {
  return (
    <section className="section" id="dj">
      <div className="aurora" aria-hidden="true">
        <div className="aurora__blob aurora__blob--a" />
        <div className="aurora__blob aurora__blob--b" />
      </div>

      <div className="wrap wrap--wide row row--flip">
        <Reveal variant="right" className="stack">
          <p className="eyebrow">
            The DJ <Eq />
          </p>
          <h2 className="h2">
            A set that <span className="accent">listens</span> to the music.
          </h2>
          <p className="body">
            Most shuffles read tags. This one reads the audio. The server measures a fingerprint off
            every recording (its texture, its energy, how it sits in a room), then weighs that
            against the words and against what you have played before, and builds a set out of your
            own library.
          </p>
          <ul className="points">
            <Point icon={Ear}>Runs are ordered by how the recordings sound, not by genre</Point>
            <Point icon={Sparkles}>
              The DJ says why, in its own words, as each run comes up
            </Point>
            <Point icon={Radio}>Auto DJ keeps going when the queue runs out, picking what fits</Point>
            <Point icon={ListMusic}>Every pick is a file you already own; nothing is streamed in</Point>
          </ul>
        </Reveal>

        <Reveal variant="left" className="row__media">
          <Frame
            screen="dj"
            className="tilt"
            description="A DJ set playing on a phone: Blue in Green by Miles Davis on the deck, and the rest of the set queued behind it."
          />
          <div className="deviceGlow" />
        </Reveal>
      </div>
    </section>
  );
}
