import { useEffect, useRef, useState } from 'react';

/**
 * A device showing the REAL app.
 *
 * The page used to show screenshots, which is the arrangement where the
 * product moves and the pictures do not: the set this replaces was taken
 * before a redesign, still showed a player bar that no longer exists, and
 * could not be re-taken without a live session token that is not in the repo.
 *
 * So the frames run the app. `/demo/` is the same build the phone ships,
 * booted against a folder of fixture JSON and told which screen to reach - see
 * demo.html for the shim and scripts/make-demo-fixtures.mjs for the library it
 * plays. Nothing here can go stale: change the app and the page changes with
 * it, because it IS the app.
 *
 * Two things make that safe to embed. The iframe is laid out at a real device
 * size and then SCALED, so the app sees a 390pt phone rather than reflowing to
 * whatever width a marketing column happens to be. And it takes no pointer
 * events at all - these are moving portraits, not a product anyone is meant to
 * drive from here; the button for that is Download.
 */

const SIZES = {
  phone: { w: 390, h: 844 },
  desktop: { w: 1280, h: 800 },
} as const;

export type FrameDevice = keyof typeof SIZES;

export function Frame({
  screen,
  device = 'phone',
  description,
  className = '',
  eager = false,
}: {
  /** Which recipe demo.html should run - see RECIPES there. */
  screen: 'home' | 'songs' | 'artist' | 'playing' | 'dj';
  device?: FrameDevice;
  /** What a reader who cannot see the frame is missing. Written, not derived. */
  description: string;
  className?: string;
  /** The hero's frame, which must not wait to be scrolled to. */
  eager?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const glassRef = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState(eager);
  const [ready, setReady] = useState(false);
  const size = SIZES[device];

  /*
   * Mount on approach, and never unmount.
   *
   * Each frame is a whole copy of the app - one download, since they share a
   * URL, but a separate parse and a separate React tree - so booting five at
   * once would cost the first paint of a page that is mostly words. They start
   * a screenful early so the app is already running by the time it is looked
   * at, and they stay up afterwards: tearing one down to save memory would
   * restart its recipe from the top the moment the reader scrolled back.
   */
  useEffect(() => {
    if (live) return;
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === 'undefined') {
      setLive(true);
      return;
    }
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setLive(true);
          watch.disconnect();
        }
      },
      { rootMargin: '60% 0px' },
    );
    watch.observe(host);
    return () => watch.disconnect();
  }, [live]);

  /*
   * The scale, measured rather than declared.
   *
   * The frame's width is whatever the layout gives it - a column, a grid cell,
   * a phone-width page - and the iframe inside is always the device's own
   * pixels. A ResizeObserver is what keeps those two facts reconciled through
   * a window resize, a font swap, or the column changing at a breakpoint.
   */
  useEffect(() => {
    const glass = glassRef.current;
    if (!glass) return;
    const fit = () => {
      const width = glass.clientWidth;
      if (width > 0) glass.style.setProperty('--frame-scale', String(width / size.w));
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(glass);
    return () => watch.disconnect();
  }, [size.w]);

  return (
    <div
      ref={hostRef}
      className={`frame frame--${device} ${className}`.trim()}
      /* Unitless, because `aspect-ratio` takes a ratio of NUMBERS: written as
         `390px / 844px` the whole declaration is invalid, the glass has no
         height, and the frame renders as a hairline. The px are put back with
         calc() where an actual length is wanted. */
      style={{ ['--frame-w' as string]: String(size.w), ['--frame-h' as string]: String(size.h) }}
      data-ready={ready || undefined}
      role="img"
      aria-label={description}
    >
      <div ref={glassRef} className="frame__glass">
        {live && (
          <iframe
            className="frame__screen"
            src={`/demo/?screen=${screen}`}
            title={description}
            tabIndex={-1}
            scrolling="no"
            /* allow-same-origin is required (the app needs a real document to
               boot); the value of the sandbox here is everything it does NOT
               grant - no top-level navigation, no popups, no downloads. */
            sandbox="allow-scripts allow-same-origin"
            onLoad={() => setReady(true)}
          />
        )}
      </div>
    </div>
  );
}
