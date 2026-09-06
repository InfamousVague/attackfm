import { CircleUserRound } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useRegistryOptional } from '../servers/registrySession.tsx';

/**
 * The Profile seat's mark: your own face once you have chosen one.
 *
 * Every other seat in the bar is a glyph for a PLACE - a library, a compass, a
 * magnifier - and stays one. This seat is a person, and the app already knows
 * which person: the picture is on the registry session that drew it onto the
 * profile page's hero. A row of five identical outline glyphs makes finding
 * "me" a matter of counting; a face is the one thing in that row that is not
 * a symbol of a category.
 *
 * Falls back to the glyph in every case that is not "a picture that loaded":
 * signed out, no picture chosen, or a URL that will not load - the last is
 * real rather than theoretical, because these URLs are cached hard by design
 * and the picture behind one can be replaced or taken down. A broken-image box
 * in the nav bar would be worse than the glyph it replaced.
 *
 * The size is not passed in. Both seats that use this - the phone's bar and
 * the desktop's rail - draw their glyphs at 24, and the stylesheet sizes the
 * svg rather than trusting the prop; the photo matches by taking the same
 * number from the same place.
 */
export function NavProfileIcon() {
  const registry = useRegistryOptional();
  const src = registry?.session?.avatarUrl ?? null;
  const [broken, setBroken] = useState(false);
  // A new picture deserves a fresh attempt: without this, one failure would
  // pin the glyph for the rest of the session even after choosing another.
  useEffect(() => setBroken(false), [src]);

  if (!src || broken) return <CircleUserRound size={24} />;
  return (
    <img
      className="appNavBarTab__face"
      src={src}
      alt=""
      /* Decorative: the seat already carries its own label. */
      aria-hidden
      onError={() => setBroken(true)}
    />
  );
}
