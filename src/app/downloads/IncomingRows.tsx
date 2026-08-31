import { type CSSProperties } from 'react';
import { X } from '@glacier/icons';
import { artSized } from '../server.ts';
import { fold } from '../core/fold.ts';
import { useIncomingFor } from './incoming.tsx';

/**
 * The songs on their way in, drawn at the head of a list surface: a spinner
 * where the on-device check would sit, the name, and - when the download can
 * be called off - an X. This is the whole of "invisible downloads" the
 * listener sees: no page to visit, the song is simply here, arriving.
 *
 * When a ghost LANDS it does not just vanish - it animates out of the band
 * while the real row animates IN in the list below, in the same beat, so the
 * hand-off reads as one motion rather than a pop. The provider decides when a
 * ghost is `leaving` (see incoming.tsx - it has to, being the common ancestor
 * of both halves); this band just draws it and plays the exit. A row dismissed
 * by the X leaves at once, with no `leaving` mark and so no animation.
 *
 * `scope` is 'like' on the Liked page (only the listener's own wants) and
 * 'all' in the library. Renders nothing when nothing is incoming, so a caller
 * can drop it in unconditionally.
 */
export function IncomingRows({
  scope,
  heading,
  query,
}: {
  scope: 'all' | 'like';
  heading?: string;
  /** When set (a search box's text), show only incoming songs the query
   *  matches - so a listener cannot re-add something already on the wire. */
  query?: string;
}) {
  const all = useIncomingFor(scope);
  let rows = all;
  if (query != null) {
    const q = fold(query).trim();
    // A search surface with an empty box shows nothing; a typed query filters.
    rows = q === '' ? [] : all.filter((t) => fold(`${t.title} ${t.artist}`).includes(q));
  }

  if (rows.length === 0) return null;
  return (
    <div className="incomingRows" role="status" aria-live="polite">
      <p className="incomingRows__head">
        {heading ?? (scope === 'like' ? 'On the way — liked, still downloading' : 'Arriving in your library')}
      </p>
      {rows.map((t) => {
        const cover = artSized(t.artwork, 160);
        return (
          <div key={t.key} className="incomingRow" data-leaving={t.leaving || undefined}>
            <span className="incomingRow__mark" aria-hidden>
              {t.progress != null ? (
                <span
                  className="incomingRow__ring"
                  style={{ '--p': `${Math.round(t.progress * 100)}%` } as CSSProperties}
                />
              ) : (
                <span className="artistAlbumSpin" data-still={t.stalled || undefined} />
              )}
            </span>
            {cover ? (
              <img className="incomingRow__art" src={cover} alt="" loading="lazy" />
            ) : (
              <span className="incomingRow__art incomingRow__art--blank" aria-hidden />
            )}
            <span className="incomingRow__text">
              <span className="incomingRow__song">{t.title}</span>
              <span className="incomingRow__artist">
                {t.artist}
                {t.stalled ? ' — not downloading, will retry' : ''}
              </span>
            </span>
            {t.onCancel && !t.leaving && (
              <button
                type="button"
                className="incomingRow__drop"
                aria-label={`Stop waiting for ${t.title}`}
                onClick={t.onCancel}
              >
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
