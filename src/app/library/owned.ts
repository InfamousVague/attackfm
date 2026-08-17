import { useCallback, useMemo } from 'react';
import { useLibrary } from './library.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * "Do I already have this?" - the one answer four surfaces need and none of
 * them can get from a download queue: Worth adding, catalogue search, an
 * artist's top songs, and the AI picks. A queue only knows what was fetched
 * this session, so a song added last week (or on another device) still wore an
 * Add button; this reads the synced library instead, which is the truth.
 *
 * The hard part is that a catalogue string and a file's tags rarely agree
 * character for character. Deezer says "Beyoncé", the tag says "Beyonce";
 * Spotify says "Blinding Lights - Radio Edit", the file says "Blinding Lights";
 * one carries "(feat. Doja Cat)" and the other does not. So both sides fold to
 * the same key, and only the parts that do NOT change which recording this is
 * get dropped: a remaster note goes, a remix does not - those really are
 * different songs and claiming otherwise would hide music the listener wants.
 */

/** Lowercase, unaccented, punctuation folded to single spaces. Apostrophes are
 *  dropped rather than spaced - "Don't" and "Dont" are the same song, and one
 *  tagger in three leaves it out. Kept in step with `fold` in
 *  server/src/discovery.rs, which filters the same feed at the source. */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/['\u2019\u02bc]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Asides that say nothing about WHICH recording this is. Deliberately short:
 *  "remix", "live", "acoustic" and "version" are all absent, because a track
 *  wearing one of those is a different performance, not the same file. A bare
 *  year is absent too - "Alive (2007)" is a record, while "Alive - 2007
 *  Remaster" is caught by the word rather than the number. */
const NOISE =
  /\b(feat|ft|featuring|remaster|remastered|explicit|clean|radio edit|single version|album version|bonus|deluxe|expanded|edition|anniversary|mono|stereo|original mix)\b/;

function isNoise(segment: string): boolean {
  const s = fold(segment);
  return !s || NOISE.test(s);
}

/**
 * A title reduced to the recording it names. Bracketed asides and a trailing
 * " - ..." are dropped only when they are noise, so "Alive (2007)" keeps its
 * year but "Alive - 2007 Remaster" loses its tail.
 */
export function titleKey(title: string): string {
  let out = title.replace(/[([]([^)\]]*)[)\]]/g, (whole, inner: string) =>
    isNoise(inner) ? ' ' : whole,
  );
  const parts = out.split(/\s+-\s+/);
  if (parts.length > 1 && isNoise(parts[parts.length - 1]!)) {
    parts.pop();
    out = parts.join(' - ');
  }
  return fold(out);
}

/** Whether two artist strings name the same act, allowing one to carry extra
 *  billed names ("Drake" vs "Drake, Future"). Whole words only, so "Q" never
 *  matches "Queen". Both sides must already be through `fold`. */
export function sameArtist(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

export interface OwnedIndex {
  /** The library's copy of this song, or null. */
  find: (artist: string | null | undefined, title: string | null | undefined) => Track | null;
  /** Whether the synced library already holds this artist's song. */
  has: (artist: string | null | undefined, title: string | null | undefined) => boolean;
}

/** The library, indexed for "do I own this?" lookups by name. */
export function useOwned(): OwnedIndex {
  const { tracks } = useLibrary();
  const index = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const t of tracks) {
      const key = titleKey(t.title);
      if (!key || !fold(t.artist)) continue;
      const seen = map.get(key);
      if (seen) seen.push(t);
      else map.set(key, [t]);
    }
    return map;
  }, [tracks]);

  const find = useCallback(
    (artist: string | null | undefined, title: string | null | undefined) => {
      const key = titleKey(title ?? '');
      if (!key) return null;
      const mine = index.get(key);
      if (!mine) return null;
      const wanted = fold(artist ?? '');
      return mine.find((t) => sameArtist(fold(t.artist), wanted)) ?? null;
    },
    [index],
  );

  return useMemo(() => ({ find, has: (a, t) => find(a, t) !== null }), [find]);
}
