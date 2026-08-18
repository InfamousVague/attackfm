import { Reveal } from '../components/Reveal.tsx';
import { SHOTS, type Shot } from '../shots.ts';

// The order is a tour of the app rather than the order they were captured in.
const TOUR: Shot[] = [
  SHOTS.home,
  SHOTS.booth,
  SHOTS.nowPlaying,
  SHOTS.library,
  SHOTS.stats,
  SHOTS.desktopAlbum,
];

/**
 * A drifting band of real screenshots.
 *
 * The track holds the sequence TWICE and translates by exactly -50%, so the
 * loop closes on a seam that lands where it started. One transform animates and
 * nothing repaints; hovering pauses it so a reader can actually look at one.
 */
export function Gallery() {
  return (
    <section className="section section--tight gallery" aria-labelledby="gallery-title">
      <div className="wrap">
        <Reveal className="stack center sectionHead">
          <p className="eyebrow">The app itself</p>
          <h2 className="h2" id="gallery-title">
            Real screens, real library.
          </h2>
          <p className="lead">
            Every screenshot on this page is the app running against a four-thousand-song library —
            no mockups, no placeholder artwork.
          </p>
        </Reveal>
      </div>

      <Reveal delay={80}>
        <div className="marquee">
          <div className="marquee__track">
            {[...TOUR, ...TOUR].map((item, index) => (
              <figure className="shot gallery__item" key={index}>
                {item.src ? (
                  <img
                    src={item.src}
                    // The second copy is the same pictures again; announcing them
                    // twice would just make a screen reader read the tour twice.
                    alt={index < TOUR.length ? item.alt : ''}
                    aria-hidden={index >= TOUR.length || undefined}
                    loading="lazy"
                    decoding="async"
                  />
                ) : null}
              </figure>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}
