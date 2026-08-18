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

/**
 * Whether the Now Playing sheet is docked beside the app.
 *
 * Docked, the app keeps about half an unfolded screen - a column narrower
 * than a phone in portrait while the WINDOW is still wide - so every surface
 * that sheds detail for a narrow viewport has to shed it here too.
 *
 * Watched with a MutationObserver rather than measured with a ResizeObserver,
 * deliberately. The dock's arrival is a DOM fact (an element gains
 * data-docked), and DOM facts can be observed anywhere; widths cannot - the
 * browser surface these changes are verified on never fires a resize
 * observation at all, so a measurement-based version would be code nobody
 * could prove worked. This asks the same question the stylesheet asks in
 * `body:has(.npScreen[data-docked])`.
 */
export function useDockedSheet(): boolean {
  const [docked, setDocked] = useState(
    () => typeof document !== 'undefined' && !!document.querySelector('.npScreen[data-docked]'),
  );
  useEffect(() => {
    const read = () => setDocked(!!document.querySelector('.npScreen[data-docked]'));
    read();
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(read);
    mo.observe(document.body, { childList: true, subtree: true, attributeFilter: ['data-docked'] });
    return () => mo.disconnect();
  }, []);
  return docked;
}
