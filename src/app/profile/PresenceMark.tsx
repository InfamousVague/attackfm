import { AudioLines, Lock, Pause, Radio } from '@glacier/icons';
import { FriendAvatar } from './FriendAvatar.tsx';
import { isOnline } from './friendPresence.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import type { Standing } from './friendStanding.ts';
import type { RegistryFriend } from '../servers/registry.ts';

/**
 * A friend's face, wearing what they are doing.
 *
 * The bug this exists to end: presence in this app was drawn in COLOUR ALONE,
 * three times, in the same hard-coded green - a ring on the mark meaning
 * "online", a pulsing dot on the live line meaning "playing", and green text
 * meaning a third thing. Two claims, one channel, and the pulse - the only
 * thing separating the dot from the ring - is correctly switched off under
 * `prefers-reduced-motion`, which leaves those users with nothing but hue.
 * Red-green deficiency, a greyscale screenshot, or a phone in sunlight all
 * land in the same place.
 *
 * So the mark answers two questions on two channels, neither of them hue:
 *
 *   the RING  - are they here?    solid / dashed / absent
 *   the BADGE - doing what?       a glyph, or nothing
 *
 * Colour rides along as a third, redundant channel. Take it away and the mark
 * still reads; that is the test.
 *
 * Not the kit's `StatusDot`: its whole API is `tone` plus `pulse` and it takes
 * no children, so it is a colour-only dot by construction - precisely the
 * thing being designed out. And not the kit's `Avatar` either: the
 * handle-derived gradient is the identity a person without a photo wears here,
 * and `FriendAvatar` already survives a picture URL that has gone dead.
 */
export function PresenceMark({
  f,
  standing,
  size = 'md',
  hosting = false,
  className,
}: {
  f: RegistryFriend;
  standing: Standing;
  size?: 'sm' | 'md' | 'lg';
  /** They have a groove open that can be walked into. */
  hosting?: boolean;
  /** The caller's placement class - the mark is the grid item now, not the
   *  avatar inside it. */
  className?: string;
}) {
  const t = useT();

  // The ring is about the HEARTBEAT, not the song. A friend whose app is
  // beating gets a solid ring; one we only know about because a song arrived
  // gets a dashed one, which is the honest drawing of a weaker claim; an away
  // friend gets no ring at all. Solid / dashed / absent survives greyscale at
  // 24px, which the three greens did not.
  const here = isOnline(f);
  const ring = here ? 'solid' : standing === 'away' ? 'none' : 'dashed';

  // Private is a state worth a glyph: it says the silence is a choice, not a
  // fault, and it stops a reader waiting for a song that is never coming.
  const badge = hosting
    ? { glyph: <Radio size={badgeGlyph(size)} />, label: t('profile.presenceHosting') }
    : standing === 'playing'
      ? { glyph: <AudioLines size={badgeGlyph(size)} />, label: t('profile.presencePlaying') }
      : standing === 'paused'
        ? { glyph: <Pause size={badgeGlyph(size)} />, label: t('profile.presencePaused') }
        : f.sharing === false
          ? { glyph: <Lock size={badgeGlyph(size)} />, label: t('profile.presencePrivate') }
          : null;

  return (
    <span
      className={`presence presence--${size}${className ? ` ${className}` : ''}`}
      data-ring={ring}
      data-standing={standing}
    >
      <FriendAvatar handle={f.handle} size={size} src={f.avatarUrl} />
      {badge && (
        /* The word, not the shape, is what a screen reader gets. The glyph is
           hidden from it: "audio lines" is not a thing anybody is doing. */
        <span className="presence__badge" data-standing={standing} role="img" aria-label={badge.label}>
          <span aria-hidden>{badge.glyph}</span>
        </span>
      )}
    </span>
  );
}

/** Never below 12px: the `AudioLines` bars merge into a smudge under it. */
function badgeGlyph(size: 'sm' | 'md' | 'lg'): number {
  return size === 'lg' ? 14 : 12;
}
