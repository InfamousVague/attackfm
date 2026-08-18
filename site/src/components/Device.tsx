import { ImageOff } from '@glacier/icons';
import type { Shot } from '../shots.ts';

/**
 * A screenshot that has not been taken yet.
 *
 * Rendering something deliberate here rather than a broken <img> means the
 * layout can be reviewed - and shipped by mistake - without ever looking like a
 * bug. It also names the capture that is missing.
 */
function Placeholder({ label }: { label: string }) {
  return (
    <div className="shotPending" role="img" aria-label={`${label} screenshot pending`}>
      <ImageOff size={20} />
      <span>{label}</span>
    </div>
  );
}

export function PhoneShot({ shot, className = '' }: { shot: Shot; className?: string }) {
  return (
    <div className={`phone ${className}`.trim()}>
      <div className="phone__screen">
        {shot.src ? (
          <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
        ) : (
          <Placeholder label={shot.label} />
        )}
      </div>
    </div>
  );
}

export function LaptopShot({ shot, className = '' }: { shot: Shot; className?: string }) {
  return (
    <div className={`laptop ${className}`.trim()}>
      <div className="laptop__screen">
        {shot.src ? (
          <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
        ) : (
          <Placeholder label={shot.label} />
        )}
      </div>
    </div>
  );
}
