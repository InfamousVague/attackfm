import type { Shot } from '../shots.ts';

/**
 * A photograph in a phone.
 *
 * The home page shows the app running rather than pictures of it - see
 * components/Frame.tsx - and this is what is left over: the one screen the
 * demo cannot produce. Reading along needs a real book that a real hub has
 * really transcribed, and the fixture library is music.
 */
export function PhoneShot({ shot, className = '' }: { shot: Shot; className?: string }) {
  return (
    <div className={`phone ${className}`.trim()}>
      <div className="phone__screen">
        <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
      </div>
    </div>
  );
}
