import type { Track } from './tauri.ts';

/**
 * The app's own local-library search, shared by the ⌘K palette and the
 * page-level search bars (Home, Library) so they all agree on what "matches"
 * means. Lives apart from any component because three surfaces call it.
 */

// Fold to lowercase words separated by single spaces, dropping punctuation, so a
// typed phrase matches a lyric across the commas and line breaks it really has.
export const flatten = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether a track answers the query. Metadata (title, artist, album, genre) is
 * word-ANDed - every typed word must appear somewhere in it - while lyrics are
 * matched as a contiguous phrase. Splitting them is the point: a lyric is long
 * prose where the short words of any query turn up scattered everywhere, so only
 * the phrase typed verbatim should count there.
 */
export function matches(track: Track, phrase: string, words: string[]): boolean {
  const meta = flatten(`${track.title} ${track.artist} ${track.album} ${track.genre}`);
  if (words.every((w) => meta.includes(w))) return true;
  return track.lyrics.length > 0 && flatten(track.lyrics).includes(phrase);
}

/**
 * Filter a track list by a raw query string. An empty (or whitespace) query
 * returns the list unchanged, so callers can bind it straight to an input and
 * fall back to the full library when the field is cleared.
 */
export function filterTracks(tracks: readonly Track[], query: string): Track[] {
  const phrase = flatten(query);
  const words = phrase.split(' ').filter(Boolean);
  if (words.length === 0) return tracks as Track[];
  return tracks.filter((t) => matches(t, phrase, words));
}
