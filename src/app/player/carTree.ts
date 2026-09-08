/**
 * What the car sees, and what it means when somebody speaks to it.
 *
 * Both halves are pure functions of the library they are handed, and they sit
 * here rather than beside the bridge so they can be read - and tested -
 * without a car. `CarPlayBridge` is the effect that publishes what they
 * return; nothing in this file knows React exists.
 */

import { searchLibrary } from '../search/trackSearch.ts';
import type { CarNode } from './androidAudio.ts';
import type { Track } from '../core/tauri.ts';
import { translate } from '../i18n/translate.ts';
import { formatNumber } from '../ux/format.ts';

/**
 * The car's root id.
 *
 * MUST equal `BROWSE_ROOT` in PlaybackService.kt. There is no way to share a
 * constant across that bridge, and getting it wrong is silent in the worst
 * way: the tree publishes fine, the car asks for its real root, finds nothing
 * under this key, and falls back to the three built-in rows - which is exactly
 * the symptom this feature exists to remove. I typed `attackfm_root` here
 * first and the fallback hid it completely.
 */
const ROOT = 'attackfm.root';

/**
 * How many rows one branch may carry.
 *
 * Not a technical limit. A dashboard list is read at a glance by somebody who
 * should be watching the road, and Android Auto itself refuses to scroll far
 * while moving - so a branch longer than this is not more library, it is a
 * list nobody can use. Search and Assistant reach past it.
 */
const BRANCH_CAP = 200;

/**
 * What a spoken request means, as a queue.
 *
 * Answered with the SAME engine the search screen uses - aliases, typo rescue
 * and all - because a second matcher would be a worse one that disagrees with
 * the first about the same library.
 *
 * The order of preference is the order a person means it. An artist named
 * outright beats an album, which beats a single song: "play Rumours" wants the
 * record, not whichever of its tracks happens to rank highest inside it, and
 * "play Fleetwood Mac" wants the artist even though every one of their songs
 * also matches those words.
 *
 * A song match returns the whole result list behind it rather than the one
 * track, because a car that stops after three minutes has not really answered.
 */
export function resolveSpokenRequest(tracks: readonly Track[], query: string): Track[] {
  const hits = searchLibrary(tracks, query);
  const artist = hits.artists[0];
  if (artist) {
    const queue = tracks
      .filter((t) => t.artist === artist.name)
      .sort(
        (a, b) =>
          a.album.localeCompare(b.album, undefined, { sensitivity: 'base' }) ||
          (a.trackNo ?? 0) - (b.trackNo ?? 0),
      );
    if (queue.length) return queue;
  }
  const album = hits.albums[0];
  if (album) {
    const queue = tracks
      .filter((t) => t.album === album.title && t.artist === album.artist)
      .sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0));
    if (queue.length) return queue;
  }
  return hits.songs.map((h) => h.track);
}

/**
 * The whole tree the car walks, built from the library.
 *
 * A pure function of what it is given, deliberately: this is the part with the
 * real decisions in it - which branches exist at all, how an album that shares
 * its title with another is told apart, what order each list comes out in -
 * and none of that should only be reachable through a React effect and a
 * native bridge in order to be looked at.
 */
export function buildCarTree(
  tracks: readonly Track[],
  favoriteTracks: readonly Track[],
  playlists: readonly { id: string; name: string; paths: readonly string[] }[],
): Record<string, CarNode[]> {
  const nodes: Record<string, CarNode[]> = {};
  const byArtist = new Map<string, Track[]>();
  const byAlbum = new Map<string, Track[]>();
  const books: Track[] = [];
  for (const t of tracks) {
    if (t.kind === 'book') {
      books.push(t);
      continue;
    }
    if (t.artist) {
      const list = byArtist.get(t.artist);
      if (list) list.push(t);
      else byArtist.set(t.artist, [t]);
    }
    if (t.album) {
      // Album titles repeat across artists - "Greatest Hits" is nobody's in
      // particular - so the key carries both, and so does the id.
      const key = `${t.album}\u0000${t.artist}`;
      const list = byAlbum.get(key);
      if (list) list.push(t);
      else byAlbum.set(key, [t]);
    }
  }
  // translate(), not useT(): this tree is built outside React and handed
  // straight to the car, which caches it natively. Not reactive, and it does
  // not need to be - the effect that publishes it re-runs on every library
  // change, and a car re-reads the tree when it reconnects.
  const songs = (n: number) => translate('library.songCount', { count: n });
  const alpha = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

  nodes[ROOT] = [
    { id: 'collection:liked', name: translate('player.carLiked'), subtitle: songs(favoriteTracks.length) },
    { id: 'collection:all', name: translate('player.carAllSongs'), subtitle: songs(tracks.length) },
    {
      id: 'collection:shuffle',
      name: translate('player.carShuffleAll'),
      subtitle: translate('player.carShuffleBlurb'),
    },
  ];
  // A branch with nothing behind it is the dead end this feature removes, so
  // an empty one is not published at all.
  if (byArtist.size) {
    nodes[ROOT].push({
      id: 'branch:artists',
      name: translate('player.carArtists'),
      subtitle: formatNumber(byArtist.size),
      browsable: true,
    });
  }
  if (byAlbum.size) {
    nodes[ROOT].push({
      id: 'branch:albums',
      name: translate('player.carAlbums'),
      subtitle: formatNumber(byAlbum.size),
      browsable: true,
    });
  }
  if (books.length) {
    nodes[ROOT].push({
      id: 'branch:books',
      name: translate('player.carBooks'),
      subtitle: songs(books.length),
      browsable: true,
    });
  }
  if (playlists.length) {
    nodes[ROOT].push({
      id: 'branch:playlists',
      name: translate('player.carPlaylists'),
      subtitle: formatNumber(playlists.length),
      browsable: true,
    });
  }

  nodes['branch:artists'] = [...byArtist.keys()]
    .sort(alpha)
    .slice(0, BRANCH_CAP)
    .map((name) => ({ id: `artist:${name}`, name, subtitle: songs(byArtist.get(name)!.length) }));
  nodes['branch:albums'] = [...byAlbum.keys()]
    .sort((a, b) => alpha(a.split('\u0000')[0]!, b.split('\u0000')[0]!))
    .slice(0, BRANCH_CAP)
    .map((key) => {
      const [title, artist] = key.split('\u0000');
      return { id: `album:${key}`, name: title!, subtitle: artist || songs(byAlbum.get(key)!.length) };
    });
  nodes['branch:books'] = books
    .slice(0, BRANCH_CAP)
    .map((b) => ({ id: `book:${b.path}`, name: b.album || b.title, subtitle: b.artist }));
  nodes['branch:playlists'] = playlists
    .slice(0, BRANCH_CAP)
    .map((p) => ({ id: `playlist:${p.id}`, name: p.name, subtitle: songs(p.paths.length) }));
  return nodes;
}

