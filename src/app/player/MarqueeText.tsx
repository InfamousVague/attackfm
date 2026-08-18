import { useEffect, useRef } from 'react';

/** How long the text rests at each end before setting off again. */
const DWELL_MS = 1000;

/**
 * Travel speed. Constant rather than a fixed duration, so a title that is
 * barely too long creeps a short way and a very long one does not have to
 * sprint to cover the distance in the same time.
 */
const PIXELS_PER_SECOND = 55;

/** Below this there is nothing worth moving for; the ellipsis is tidier. */
const MIN_OVERFLOW_PX = 4;

interface MarqueeTextProps {
  text: string;
  className?: string;
  /** Rendered as a <span> by default. */
  as?: 'span' | 'div';
}

/**
 * Text that bounces back and forth when it does not fit.
 *
 * It reads to the end, waits a beat, comes back, and waits again, rather than
 * looping around from the right. A wrap-around marquee re-reads the title from
 * a running start and you never see the whole thing settled; a bounce always
 * returns to the beginning, which is where a song title wants to rest.
 *
 * Only overflowing text moves. Anything that fits keeps its ellipsis and is
 * left completely alone, so this is safe to use everywhere a title might be long.
 *
 * Driven by the Web Animations API rather than a CSS animation because the dwell
 * has to be a fixed one second at each end while the travel time varies with the
 * distance. CSS keyframe offsets are static, so expressing "1s, then however
 * long the trip takes" would mean generating a stylesheet per title.
 */
export function MarqueeText({ text, className = '', as: Tag = 'span' }: MarqueeTextProps) {
  const outer = useRef<HTMLElement>(null);
  const inner = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const track = outer.current;
    const content = inner.current;
    if (!track || !content) return;

    let animation: Animation | null = null;

    const stop = () => {
      animation?.cancel();
      animation = null;
      track.removeAttribute('data-scrolling');
    };

    const measure = () => {
      stop();

      // Someone who asked for less motion gets the ellipsis, not a moving line.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      // scrollWidth is the full text width even while it is clipped.
      const overflow = content.scrollWidth - track.clientWidth;
      if (overflow <= MIN_OVERFLOW_PX) return;

      // The attribute drops the ellipsis: an animated line must not also end
      // in "..." halfway through its own text.
      track.setAttribute('data-scrolling', 'true');

      const travel = Math.max((overflow / PIXELS_PER_SECOND) * 1000, 600);
      const total = travel * 2 + DWELL_MS * 2;
      const at = (ms: number) => ms / total;

      animation = content.animate(
        [
          { transform: 'translateX(0)', offset: 0, easing: 'ease-in-out' },
          { transform: 'translateX(0)', offset: at(DWELL_MS), easing: 'ease-in-out' },
          { transform: `translateX(${-overflow}px)`, offset: at(DWELL_MS + travel) },
          {
            transform: `translateX(${-overflow}px)`,
            offset: at(DWELL_MS * 2 + travel),
            easing: 'ease-in-out',
          },
          { transform: 'translateX(0)', offset: 1 },
        ],
        { duration: total, iterations: Infinity },
      );
    };

    measure();

    // The box changes width when the sheet docks, the window resizes, or the UI
    // scale setting moves, and the overflow has to be measured again each time.
    const observer = new ResizeObserver(measure);
    observer.observe(track);

    // A late webfont re-lays the text out after the first measurement, which can
    // turn a title that fit into one that does not.
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });

    return () => {
      cancelled = true;
      observer.disconnect();
      stop();
    };
    // Re-measures on every new title, which is also what restarts the bounce
    // from the beginning when the song changes.
  }, [text]);

  return (
    <Tag ref={outer as never} className={`marquee ${className}`.trim()}>
      <span ref={inner} className="marquee__inner">
        {text}
      </span>
    </Tag>
  );
}
