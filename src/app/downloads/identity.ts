import { fold } from '../core/fold.ts';
import { titleKey } from '../library/owned.ts';

/**
 * The two names a song in flight answers to.
 *
 * Every current that feeds the incoming band - a liked-but-not-here-yet
 * promise, a collector find, an importer job - is keyed by the SAME folded
 * identity the server settles on, so a ghost dissolves the instant the real
 * row lands. That contract is `fold(artist) + '|' + titleKey(title)`, which is
 * the server's `key_of`, and it lives here rather than in the provider that
 * polls, because the surfaces that JOIN on it - the ghost rows in the song
 * table, the artist page's auditions - have no business loading a poller to
 * ask what a song is called.
 */

/** The one identity string, computed the client side of the server's key_of. */
export function identityKey(artist: string, title: string): string {
  return `${fold(artist)}|${titleKey(title)}`;
}

/**
 * The same identity, but keyed on the LEAD artist alone.
 *
 * A heart promised on Discover carries the artist that catalogue printed -
 * "Czarface" - and the file that lands carries the artist its tags print:
 * "CZARFACE, Frankie Pulitzer". Those fold to different keys, so the exact
 * match misses, and a song that is sitting right there in the library stays
 * on the "still downloading" band for the whole thirty-day life of the
 * promise. This was not a rare spelling accident: featured credits differ
 * between a catalogue and a file more often than they agree.
 *
 * So the lead credit is the fallback. Everything after the first separator is
 * a collaboration list, which is exactly the part the two sources disagree
 * about; the title still has to match on its own key, so this widens WHO by
 * one credit and never widens WHAT.
 */
export function leadKey(artist: string, title: string): string {
  const lead = artist.split(/\s*(?:,|;|&|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bx\b|\/)\s*/i)[0] ?? artist;
  return `${fold(lead.trim() || artist)}|${titleKey(title)}`;
}
