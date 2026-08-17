import { useEffect, useState } from 'react';

/**
 * The width below which the library table has to shed columns.
 *
 * A phone in portrait is around 390 CSS pixels. The table's five columns -
 * index, title, album, date added, running time - need roughly twice that
 * before any of them can be read, and below it the headers overlap each other
 * rather than shrinking gracefully.
 */
const NARROW = '(max-width: 34rem)';

/**
 * Whether the viewport is too narrow for a full-width layout, kept live so a
 * rotation settles the surfaces reading it without a reload.
 */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW);
    if (!query) return;
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
