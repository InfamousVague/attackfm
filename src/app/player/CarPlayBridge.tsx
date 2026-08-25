import { useEffect, useRef } from 'react';
import { useLibrary } from '../library/library.tsx';
import { usePlaylists } from '../playlists/playlists.tsx';
import { onCarPlayPlay } from './carplay.ts';
import {
  bindNativeTransport,
  publishNativeBrowseTree,
  publishNativeCollections,
  type CarNode,
} from './androidAudio.ts';
import { searchLibrary } from '../search/trackSearch.ts';
import { remotePath } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Turns a tap on the car screen into playback here, where the audio lives.
 *
 * The car names the track and the list it was tapped in; the queue is rebuilt
 * from that context in the same order the car displayed - liked order for
 * Liked, album-then-track-number within an artist, alphabetical for Songs -
 * so the drive hears what the screen promised. Headless, and a separate
 * component below the LibraryProvider because App itself renders that provider
 * and so cannot read the library.
 */
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
  const songs = (n: number) => (n === 1 ? '1 song' : `${n} songs`);
  const alpha = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

  nodes[ROOT] = [
    { id: 'collection:liked', name: 'Liked', subtitle: songs(favoriteTracks.length) },
    { id: 'collection:all', name: 'All songs', subtitle: songs(tracks.length) },
    { id: 'collection:shuffle', name: 'Shuffle all', subtitle: 'Everything, surprised' },
  ];
  // A branch with nothing behind it is the dead end this feature removes, so
  // an empty one is not published at all.
  if (byArtist.size) {
    nodes[ROOT].push({ id: 'branch:artists', name: 'Artists', subtitle: String(byArtist.size), browsable: true });
  }
  if (byAlbum.size) {
    nodes[ROOT].push({ id: 'branch:albums', name: 'Albums', subtitle: String(byAlbum.size), browsable: true });
  }
  if (books.length) {
    nodes[ROOT].push({ id: 'branch:books', name: 'Books', subtitle: songs(books.length), browsable: true });
  }
  if (playlists.length) {
    nodes[ROOT].push({ id: 'branch:playlists', name: 'Playlists', subtitle: String(playlists.length), browsable: true });
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

export function CarPlayBridge({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { tracks, favoriteTracks } = useLibrary();
  const { playlists } = usePlaylists();
  const latest = useRef({ tracks, favoriteTracks, playlists, onPlay });
  latest.current = { tracks, favoriteTracks, playlists, onPlay };

  /*
   * The car's browse list learns the playlists. Published on every change and
   * cached natively, so a car plugged in before this WebView exists still
   * draws the real list - Android Auto asks faster than a page stands up.
   * The count rides as the subtitle because a dashboard row with no second
   * line looks unfinished next to the three built-ins above it.
   */
  useEffect(() => {
    publishNativeCollections(
      playlists.map((p) => ({
        id: `playlist:${p.id}`,
        name: p.name,
        subtitle: p.paths.length === 1 ? '1 song' : `${p.paths.length} songs`,
      })),
    );
  }, [playlists]);

  /*
   * And the tree the car can actually walk.
   *
   * Every node the old list published was a leaf, so the dashboard showed four
   * rows and nothing opened. This publishes branches: Artists, Albums, Books
   * and Playlists, each expanding into its own members, each of those playing.
   *
   * CAPPED, and the cap is the point rather than a shortcut. A dashboard list
   * is read at a glance by somebody who should be watching the road; a
   * thousand artists is not a feature there, it is a scroll nobody can safely
   * make. The car's search - and Assistant - reach past the cap, which is what
   * they are for.
   */
  useEffect(() => {
    publishNativeBrowseTree(buildCarTree(tracks, favoriteTracks, playlists));
  }, [tracks, favoriteTracks, playlists]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;
    void onCarPlayPlay((trackId, context) => {
      const { tracks, favoriteTracks, onPlay } = latest.current;
      const path = remotePath(trackId);
      const track = tracks.find((t) => t.path === path);
      if (!track) return;

      let queue: Track[];
      if (context === 'liked') {
        queue = favoriteTracks;
      } else if (context.startsWith('artist:')) {
        const artist = context.slice('artist:'.length);
        queue = tracks
          .filter((t) => t.artist === artist)
          .sort(
            (a, b) =>
              a.album.localeCompare(b.album, undefined, { sensitivity: 'base' }) ||
              (a.trackNo ?? 0) - (b.trackNo ?? 0),
          );
      } else {
        queue = [...tracks].sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
        );
      }
      onPlay(track, queue.length > 0 ? queue : [track]);
    }).then((stop) => {
      if (dead) stop();
      else unlisten = stop;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);

  // Android Auto's browse list, relayed from the Player's transport bridge:
  // three collections the car can start without a screen in hand. Built here
  // beside the CarPlay handler above because this component is where the
  // library lives - the two cars share one queue-building brain.
  useEffect(() => {
    const onCollection = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const { tracks, favoriteTracks, onPlay } = latest.current;
      let queue: Track[];
      if (id === 'liked') {
        queue = favoriteTracks;
      } else if (id === 'shuffle') {
        queue = [...tracks];
        for (let i = queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const a = queue[i]!;
          queue[i] = queue[j]!;
          queue[j] = a;
        }
      } else {
        queue = [...tracks].sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
        );
      }
      const first = queue[0];
      if (first) onPlay(first, queue);
    };
    window.addEventListener('afm-car-collection', onCollection);
    return () => window.removeEventListener('afm-car-collection', onCollection);
  }, []);

  /*
   * And the car's own hand on that lever.
   *
   * Bound HERE rather than in the Player, because this component is mounted
   * for the whole life of the app and the Player is not - PlayerHost renders
   * nothing until a track is playing, so a dashboard tapped from cold used to
   * find no handler at all. A car that can only start music once music is
   * already started is not much of a car.
   */
  useEffect(
    () =>
      bindNativeTransport({
        playCollection: (id) =>
          window.dispatchEvent(new CustomEvent('afm-car-collection', { detail: id })),
        /*
         * A branch's leaf, tapped. The id says which kind, and the queue is
         * rebuilt here in the order the car DISPLAYED - the same contract the
         * CarPlay side keeps, so a drive hears what the screen promised.
         */
        playNode: (mediaId) => {
          const { tracks, onPlay } = latest.current;
          const at = mediaId.indexOf(':');
          const kind = mediaId.slice(0, at);
          const rest = mediaId.slice(at + 1);
          if (kind === 'artist') {
            const queue = tracks
              .filter((t) => t.artist === rest && t.kind !== 'book')
              .sort(
                (a, b) =>
                  a.album.localeCompare(b.album, undefined, { sensitivity: 'base' }) ||
                  (a.trackNo ?? 0) - (b.trackNo ?? 0),
              );
            if (queue[0]) onPlay(queue[0], queue);
          } else if (kind === 'album') {
            const [title, artist] = rest.split('\u0000');
            const queue = tracks
              .filter((t) => t.album === title && t.artist === artist)
              .sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0));
            if (queue[0]) onPlay(queue[0], queue);
          } else if (kind === 'book') {
            // A book is its own queue, in reading order - the shelf's rule.
            const one = tracks.find((t) => t.path === rest);
            if (!one) return;
            const queue = tracks
              .filter((t) => t.kind === 'book' && t.album === one.album && t.artist === one.artist)
              .sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0) || a.title.localeCompare(b.title, undefined, { numeric: true }));
            onPlay(queue[0] ?? one, queue.length ? queue : [one]);
          }
        },
        /*
         * "Play Fleetwood Mac on AttackFM."
         *
         * Answered with the SAME engine the search screen uses, aliases, typo
         * rescue and all - a second matcher would be a worse one that
         * disagrees with the first. The order of preference is the order a
         * person means it: an artist named outright beats an album, which
         * beats a single song, because "play Rumours" wants the record and not
         * whichever track happens to rank highest inside it.
         */
        playSearch: (query) => {
          const { tracks, onPlay } = latest.current;
          const queue = resolveSpokenRequest(tracks, query);
          if (queue[0]) onPlay(queue[0], queue);
        },
        playPlaylist: (id) => {
          const { tracks, playlists, onPlay } = latest.current;
          const list = playlists.find((p) => p.id === id);
          if (!list) return;
          // The playlist's own running order, resolved to live tracks the way
          // its page resolves them - a path whose song has gone simply drops.
          const byPath = new Map(tracks.map((t) => [t.path, t] as const));
          const queue = list.paths
            .map((path) => byPath.get(path))
            .filter((t): t is Track => t !== undefined);
          const first = queue[0];
          if (first) onPlay(first, queue);
        },
      }),
    [],
  );
  return null;
}
