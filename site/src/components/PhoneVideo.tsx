import { useEffect, useRef } from 'react';

/**
 * The Now Playing screen, playing, inside a phone frame.
 *
 * The clip runs the length of a whole song so the seek bar is seen crossing the
 * track and the disc keeps turning. It carries no audio at all: the recording
 * is a sequence of stills, so there is no soundtrack to mute or to license.
 *
 * It only plays while it is on screen. A three-minute video decoding behind the
 * fold is bandwidth and battery spent on something nobody is looking at, and
 * `preload="none"` means the bytes are not even fetched until then.
 */
export function PhoneVideo({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    // Reduced motion: leave the poster frame up and never start.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          // A muted, inline video is allowed to autoplay; a rejected promise
          // here just means the poster stays, which is a fine outcome.
          void video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: 0.35 },
    );

    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`phone ${className}`.trim()}>
      <div className="phone__screen">
        <video
          ref={ref}
          className="phone__video"
          poster="/video/now-playing-poster.jpg"
          preload="none"
          muted
          loop
          playsInline
          // No controls: it is a demonstration, not a player. It is also
          // decorative, so it is hidden from assistive tech and described by
          // the copy beside it instead.
          aria-hidden="true"
          tabIndex={-1}
        >
          <source src="/video/now-playing.webm" type="video/webm" />
          <source src="/video/now-playing.mp4" type="video/mp4" />
        </video>
      </div>
    </div>
  );
}
