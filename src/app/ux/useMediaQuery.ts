import { useEffect, useState } from 'react';

/**
 * Tracks a media query as state: true while the query matches, re-answered
 * whenever it flips. One copy shared by the player's fold-the-rails question
 * and the settings drill-in, which ask with their own query strings.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    // Some embedded webviews resize without firing the mql change; the resize
    // listener re-asks the same question for those, and costs nothing elsewhere.
    window.addEventListener('resize', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, [query]);
  return matches;
}
