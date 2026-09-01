import { X } from '@glacier/icons';
import type { PlaylistWant } from '../server.ts';

/**
 * A playlist's arriving members: songs filed into it that the box does not own
 * yet, on their way in. They wear the same ghost the library-wide incoming band
 * wears (a spinner where the on-device check would sit, the name, a way to call
 * it off) so a song arriving into a playlist looks the same as one arriving
 * anywhere else - it simply becomes an ordinary row when it lands.
 *
 * Renders nothing when nothing is arriving, so the page can drop it in
 * unconditionally above the track list.
 */
export function PlaylistWantRows({
  wants,
  onDismiss,
}: {
  wants: PlaylistWant[];
  /** Withdraw a want before it lands (its `k`). */
  onDismiss: (k: string) => void;
}) {
  if (wants.length === 0) return null;
  return (
    <div className="incomingRows" role="status" aria-live="polite">
      <p className="incomingRows__head">Arriving in this playlist</p>
      {wants.map((w) => (
        <div key={w.k} className="incomingRow">
          <span className="incomingRow__mark" aria-hidden>
            <span className="artistAlbumSpin" />
          </span>
          <span className="incomingRow__art incomingRow__art--blank" aria-hidden />
          <span className="incomingRow__text">
            <span className="incomingRow__song">{w.title}</span>
            <span className="incomingRow__artist">{w.artist}</span>
          </span>
          <button
            type="button"
            className="incomingRow__drop"
            aria-label={`Stop waiting for ${w.title}`}
            onClick={() => onDismiss(w.k)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
