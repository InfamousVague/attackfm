import type { Track } from './tauri.ts';

/**
 * What an album is, and whose it is.
 *
 * These three rules were written inline on the artist page and got one of them
 * wrong, which showed up as three unrelated-looking complaints: too few songs
 * in the artist's count, too few albums on the shelf, and each album's own
 * tally short of what was on the disk. One cause - a track only counted as an
 * artist's when the TRACK credit matched exactly - and one fix, but a fix that
 * has to be the same everywhere or the album page and the artist page will
 * disagree about the same record. Hence a module rather than a copy.
 */

/** Names fold before they are compared: two spellings of one name must never
 *  become two artists, or two half-empty albums. */
export function fold(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Whether a track belongs to an artist, by EITHER credit.
 *
 * The album artist is the one that holds a record together - a guest on two
 * songs gives those songs a different track artist, and reading only that
 * loses them, and often the whole record with them. The track artist still
 * counts on its own so a compilation appearance ("Various Artists" over the
 * album) is not lost the other way.
 */
export function isBy(track: Track, artist: string): boolean {
  const want = fold(artist);
  return fold(track.artist) === want || fold(track.albumArtist ?? '') === want;
}

/**
 * An album's running order: disc, then track number.
 *
 * Track number alone interleaves a two-disc set - disc two's track one lands
 * beside disc one's - and an untagged position sorts first rather than
 * scattering, since 0 is what a missing number reads as either way.
 */
export function byRunningOrder(a: Track, b: Track): number {
  const disc = (a.discNo ?? 0) - (b.discNo ?? 0);
  return disc !== 0 ? disc : (a.trackNo ?? 0) - (b.trackNo ?? 0);
}

/** One album, gathered. */
export interface AlbumGroup {
  /** The first spelling seen, which is what gets displayed. */
  name: string;
  artwork: string | null;
  /** In running order. */
  list: Track[];
}

/** Every album among these tracks, each in running order. Keyed on the folded
 *  name so casing differences do not split a record in two. */
export function groupAlbums(tracks: Track[]): AlbumGroup[] {
  const byAlbum = new Map<string, AlbumGroup>();
  for (const track of tracks) {
    const name = track.album || 'Unknown album';
    const key = fold(name);
    const existing = byAlbum.get(key);
    if (!existing) byAlbum.set(key, { name, artwork: track.artwork, list: [track] });
    else {
      existing.list.push(track);
      if (!existing.artwork && track.artwork) existing.artwork = track.artwork;
    }
  }
  for (const album of byAlbum.values()) album.list.sort(byRunningOrder);
  return [...byAlbum.values()];
}

/**
 * Who to credit a gathered album to: the album artist if its tracks agree on
 * one, otherwise the various-artists case said plainly rather than by picking
 * whichever song happened to sort first.
 */
export function albumCredit(list: Track[]): string {
  const names = new Set(list.map((t) => fold(t.albumArtist || t.artist)).filter(Boolean));
  if (names.size === 1) {
    const first = list[0];
    return (first?.albumArtist || first?.artist) ?? '';
  }
  return 'Various artists';
}
