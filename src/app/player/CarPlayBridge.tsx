import { useEffect, useRef } from 'react';
import { useLibrary } from '../library/library.tsx';
import { onCarPlayPlay } from './carplay.ts';
import { bindNativeTransport } from './androidAudio.ts';
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
export function CarPlayBridge({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { tracks, favoriteTracks } = useLibrary();
  const latest = useRef({ tracks, favoriteTracks, onPlay });
  latest.current = { tracks, favoriteTracks, onPlay };

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
      }),
    [],
  );
  return null;
}
