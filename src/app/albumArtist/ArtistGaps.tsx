import { Check, Disc3, Plus, X } from '@glacier/icons';
import type { AlbumGap } from '../server.ts';
import type { AddingState } from './artistAcquire.ts';
import { CatalogTrackMenu } from '../library/CatalogTrackMenu.tsx';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

interface ArtistGapsProps {
  gaps: AlbumGap[] | 'old' | null;
  adding: AddingState;
  addMissing: (gap: AlbumGap, row: { position: number; title: string; url: string }) => Promise<void>;
}

/*
  Records you own PART of, and the songs that would finish them.

  Everywhere else on this page a missing thing is a whole record or a
  top-ten single; this is the gap inside a record you already have -
  the case where "I own this album" and "most of it is missing" are both
  true. The rows are dimmed because they are absences, and each carries
  the plus that turns it into a download.
*/
export function ArtistGaps({ gaps, adding, addMissing }: ArtistGapsProps) {
  const t = useT();
  if (gaps === 'old' || !gaps || gaps.length === 0) return null;
  return (
    <section className="homeShelf">
      <h2 className="homeShelfTitle">
        {t('library.missingFromYourAlbums')}
        <span className="artistDiscCount">
          {t('library.songCount', { count: gaps.reduce((n, g) => n + g.missing.length, 0) })}
        </span>
      </h2>
      <div className="albumGaps">
        {gaps.map((gap) => (
          <div key={`${gap.album}:${gap.artist}`} className="albumGap">
            <header className="albumGap__head">
              {gap.cover ? (
                <img className="albumGap__art" src={gap.cover} alt="" loading="lazy" />
              ) : (
                <span className="albumGap__art albumGap__art--glyph" aria-hidden>
                  <Disc3 size={18} />
                </span>
              )}
              <span className="albumGap__meta">
                <span className="albumGap__title">{gap.album}</span>
                <span className="albumGap__count">
                  {/* One line, three numbers, one key: the two counts and the
                      word "missing" are a single phrase, and which of them
                      comes first is the translator's call. The plural is on
                      the absences, since that is the number being described. */}
                  {t('library.gapCount', {
                    count: gap.missing.length,
                    owned: gap.owned,
                    total: gap.total,
                  })}
                </span>
              </span>
              {/* One tap for the whole gap, because "finish this record" is
                  the thing somebody actually wants when nine of twelve are
                  absent. Each row still has its own plus. */}
              <button
                type="button"
                className="albumGap__all"
                onClick={() => {
                  for (const row of gap.missing) void addMissing(gap, row);
                }}
              >
                {t('player.addAll')}
              </button>
            </header>
            <ol className="albumGap__list">
              {gap.missing.map((row) => {
                const key = `gap:${gap.album}:${row.position}`;
                const state = adding[key];
                return (
                  <CatalogTrackMenu
                    key={key}
                    target={{ artist: gap.artist, title: row.title, url: row.url }}
                    onAdd={() => void addMissing(gap, row)}
                  >
                  <li className="albumGap__row" data-state={state}>
                    {/* The track's own number on the sleeve, in the locale's
                        digits rather than always-Latin ones. */}
                    <span className="albumGap__no">{formatNumber(row.position)}</span>
                    <span className="albumGap__name">{row.title}</span>
                    <button
                      type="button"
                      className="catalogTrack__add"
                      data-state={
                        state === 'added'
                          ? 'added'
                          : state === 'missing'
                            ? 'missing'
                            : state === 'finding'
                              ? 'adding'
                              : 'idle'
                      }
                      disabled={!!state}
                      aria-label={
                        state === 'added'
                          ? t('library.gapAdded', { title: row.title })
                          : state === 'missing'
                            ? t('library.gapNotFound', { title: row.title })
                            : t('library.addTrack', { title: row.title })
                      }
                      onClick={() => void addMissing(gap, row)}
                    >
                      {state === 'added' ? (
                        <Check size={14} />
                      ) : state === 'missing' ? (
                        <X size={14} />
                      ) : state === 'finding' ? (
                        <span className="artistAlbumSpin" aria-hidden />
                      ) : (
                        <Plus size={14} />
                      )}
                    </button>
                  </li>
                  </CatalogTrackMenu>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}
