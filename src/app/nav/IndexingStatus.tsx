import { useLibrary } from '../library/library.tsx';

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
  if (!indexing) return null;

  if (source === 'server') {
    return (
      <div className="indexingBar" role="status" aria-live="polite">
        <span className="indexingBar__dot" aria-hidden="true" />
        <span className="indexingBar__label">
          {indexed > 0 ? `Syncing · ${indexed.toLocaleString()} songs` : 'Syncing library…'}
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
        Indexing {indexed.toLocaleString()} of {indexTotal.toLocaleString()} songs
      </span>
      <span className="indexingBar__track" aria-hidden="true">
        <span className="indexingBar__fill" style={{ inlineSize: `${percent}%` }} />
      </span>
    </div>
  );
}
