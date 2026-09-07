import { useLibrary } from '../library/library.tsx';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

/**
 * A slim strip along the bottom that reports background library work, shown
 * only while it runs. It sits above the floating player and disappears the
 * moment the library is settled.
 *
 * Two wordings for the two sources, one pill. A local scan knows its total up
 * front (the folder walk came first), so it earns a real percent; a server
 * sync is a delta whose size is only known when it is over, so it wears the
 * count it has and an indeterminate sweep instead of a percentage that would
 * be a guess.
 */
export function IndexingStatus() {
  const { source, indexing, indexed, indexTotal } = useLibrary();
  const t = useT();
  if (!indexing) return null;

  if (source === 'server') {
    return (
      <div className="indexingBar" role="status" aria-live="polite">
        <span className="indexingBar__dot" aria-hidden="true" />
        <span className="indexingBar__label">
          {/* `count` is only there to pick the plural form; what is PRINTED is
              `n`, already grouped by Intl - a library of 40,000 songs should
              not read as "40000" in any language. */}
          {indexed > 0
            ? t('library.syncingCount', { count: indexed, n: formatNumber(indexed) })
            : t('library.syncing')}
        </span>
        <span className="indexingBar__track" aria-hidden="true">
          <span className="indexingBar__fill indexingBar__fill--sweep" />
        </span>
      </div>
    );
  }

  if (indexTotal === 0) return null;
  const percent = Math.min(100, Math.round((indexed / indexTotal) * 100));
  return (
    <div className="indexingBar" role="status" aria-live="polite">
      <span className="indexingBar__dot" aria-hidden="true" />
      <span className="indexingBar__label">
        {t('library.indexingCount', {
          count: indexTotal,
          n: formatNumber(indexed),
          total: formatNumber(indexTotal),
        })}
      </span>
      <span className="indexingBar__track" aria-hidden="true">
        <span className="indexingBar__fill" style={{ inlineSize: `${percent}%` }} />
      </span>
    </div>
  );
}
