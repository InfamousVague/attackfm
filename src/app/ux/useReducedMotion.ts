import { useEffect, useState } from 'react';

/** The one spelling of the query: the imperative animation code (the ripple
 *  wave, the disc, the player) reads it too, and a typo in a fifth copy would
 *  silently drop the accessibility respect on that path. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the OS is asking for reduced motion, kept live: flipping the system
 * setting mid-session settles every surface reading this, with no reload.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
