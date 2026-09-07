import { type CSSProperties } from 'react';
import { X } from '@glacier/icons';
import { artSized } from '../server.ts';
import { fold } from '../core/fold.ts';
import { useIncomingFor } from './incoming.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

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
/**
 * The failed job's reason, trimmed to the half a person acts on. The server
 * sends a sentence and then the provider's own transcript under it; the first
 * line is the part that says whether trying again is worth anything.
 */
function shortFailure(error: string | null | undefined, fallback: string): string {
  const first = (error ?? '').split('\n')[0]?.trim() ?? '';
  if (!first) return fallback;
  const cut = first.replace(/\s*Retry to resume\.?$/i, '').trim();
  return cut.length > 60 ? `${cut.slice(0, 57)}…` : cut || fallback;
}

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
  const t = useT();
  const all = useIncomingFor(scope);
  let rows = all;
  if (query != null) {
    const q = fold(query).trim();
    // A search surface with an empty box shows nothing; a typed query filters.
    rows = q === '' ? [] : all.filter((r) => fold(`${r.title} ${r.artist}`).includes(q));
  }

  if (rows.length === 0) return null;
  return (
    <div className="incomingRows" role="status" aria-live="polite">
      <p className="incomingRows__head">
        {/* Not "still downloading": some of these are waiting on a queue and
            some are waiting on a retry, and each row says which it is. The
            heading only has to say why they are here. */}
        {heading ??
          (scope === 'like' ? t('downloads.incomingLiked') : t('downloads.incomingLibrary'))}
      </p>
      {rows.map((row) => {
        const cover = artSized(row.artwork, 160);
        return (
          <div key={row.key} className="incomingRow" data-leaving={row.leaving || undefined}>
            <span className="incomingRow__mark" aria-hidden>
              {row.progress != null ? (
                <span
                  className="incomingRow__ring"
                  style={{ '--p': `${Math.round(row.progress * 100)}%` } as CSSProperties}
                />
              ) : (
                <span className="artistAlbumSpin" data-still={row.stalled || undefined} />
              )}
            </span>
            {cover ? (
              <img className="incomingRow__art" src={cover} alt="" loading="lazy" />
            ) : (
              <span className="incomingRow__art incomingRow__art--blank" aria-hidden />
            )}
            <span className="incomingRow__text">
              <span className="incomingRow__song">{row.title}</span>
              <span className="incomingRow__artist">
                {/* Say which kind of waiting this is. A failed job is not the
                    same as a queue that has not reached this song yet, and
                    "will retry" over a download that already died - with
                    nothing scheduled to touch it - is the sentence that made
                    these rows look stuck for days.

                    Artist and status are ONE entry rather than two fragments
                    with a dash between them: the dash is the join, and which
                    side of it each half belongs on is the translator's call. */}
                {row.stalled
                  ? t('downloads.statusWithArtist', {
                      artist: row.artist,
                      status: row.onRetry
                        ? shortFailure(row.failure, t('downloads.failed'))
                        : t('downloads.waitingTurn'),
                    })
                  : row.artist}
              </span>
            </span>
            {row.onRetry && !row.leaving && (
              <button
                type="button"
                className="incomingRow__retry"
                onClick={row.onRetry}
              >
                {t('common.tryAgain')}
              </button>
            )}
            {row.onCancel && !row.leaving && (
              <button
                type="button"
                className="incomingRow__drop"
                aria-label={t('downloads.cancelTrack', { title: row.title })}
                onClick={row.onCancel}
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
