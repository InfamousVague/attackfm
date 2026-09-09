import { useEffect, useState } from 'react';

/*! A person, as a mark.
 *!
 *! Its own module because it is a LEAF: eleven files draw a friend's face,
 *! and while it lived in `RegistryFriends.tsx` every one of them pulled in
 *! the whole friends section - the registry calls, the invite modal, the
 *! share settings - to render a coloured circle. The presence mark made that
 *! structural rather than merely wasteful: it wraps the avatar and the
 *! friends section wears it, so the two files imported each other and the
 *! build refused the cycle.
 */

/**
 * A person, as a mark: a deterministic two-tone gradient from their handle
 * with their initial on it. The hue is the handle's and nobody else's, so the
 * same friend wears the same colour on every device and every visit - the
 * list reads as PEOPLE at a glance, not a column of grey monograms.
 */
export function FriendAvatar({
  handle,
  size = 'md',
  className,
  src,
}: {
  handle: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** The face they chose. The generated mark below is what a person without
   *  one wears - and what everyone wore before there was a way to choose. */
  src?: string | null;
}) {
  let hue = 7;
  for (const ch of handle) hue = (hue * 31 + ch.codePointAt(0)!) % 360;
  // A picture that will not load falls back to the mark rather than leaving a
  // broken-image glyph in the row. It happens for real: the URL is cached
  // forever by design, and the picture behind it can be taken down.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const photo = src && !broken;
  return (
    <span
      className={`friendAvatar friendAvatar--${size}${className ? ` ${className}` : ''}`}
      style={{
        background: `linear-gradient(135deg, oklch(0.62 0.15 ${hue}), oklch(0.42 0.17 ${(hue + 55) % 360}))`,
      }}
      aria-hidden
    >
      {photo ? (
        <img className="friendAvatar__photo" src={src} alt="" onError={() => setBroken(true)} />
      ) : (
        (handle[0] ?? '?').toUpperCase()
      )}
    </span>
  );
}
