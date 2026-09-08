import { formatAgo, formatTotal } from '../ux/format.ts';
import type { RegistryFriend } from '../servers/registry.ts';

/**
 * Is a friend here, and when were they last - the plain arithmetic behind a
 * friend row.
 *
 * Lifted out of `RegistryFriends.tsx` so it can be reasoned about on its own:
 * every one of these is a claim about a person made from a number, and the
 * failures are all silent ones - a friend who left an hour ago shown as
 * present, a week's listening losing its hours, a stamp read as 1970. None of
 * that is visible in a component test that renders a row and looks for words.
 */

/** The registry stamps in seconds; anything suspiciously small is treated as
 *  such rather than reading as fifty-six years ago. */
function stampMs(stamp: number): number {
  return stamp < 1e12 ? stamp * 1000 : stamp;
}

/**
 * Seen inside the heartbeat window.
 *
 * This used to be `seenAgo(f) === 'online now'` - a FACT about a friend
 * decided by comparing a display string, which is exactly the sort of thing
 * that quietly stops being true the day the string is translated. The window
 * is the fact; the words are a separate question.
 */
function seenJustNow(stamp: number): boolean {
  if (!stamp) return false;
  const gone = Date.now() - stampMs(stamp);
  return gone >= 0 && gone < 90_000;
}

/** "4 hours ago" - the coarse read a friend row wants, never a timestamp.
 *  Intl does the counting and names the unit (ux/format.ts); the hand-rolled
 *  ladder this replaced said "4h ago" in English in every branch. */
export function seenAgo(stamp: number): string | null {
  if (!stamp) return null;
  const ms = stampMs(stamp);
  if (Date.now() - ms < 0) return null;
  return formatAgo(ms);
}

/**
 * Minutes as a readout, in whatever language the app is in.
 *
 * NOT `fmtMinutes` from ./stats.ts, which builds `${n.toLocaleString()} min`:
 * that spells the unit in English on every screen and asks the BROWSER's
 * locale for the digits, so a Japanese app got Japanese grouping under an
 * English "min". `formatTotal` asks Intl for both, and gives the hour and the
 * minute rather than a decimal hour - which is the distinction the week glance
 * was already reaching for when it refused to round 89 and 91 minutes to the
 * same "1h".
 */
export function listenedTime(minutes: number): string {
  return formatTotal(Math.max(0, Math.round(minutes)) * 60);
}

/** Online: the registry's word when it has one (a heartbeat within the last
 *  minute or two), else the old read off seenAt. */
export function isOnline(f: RegistryFriend): boolean {
  return f.online ?? seenJustNow(f.seenAt);
}
