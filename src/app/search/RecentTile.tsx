import { ListMusic, Music, Tag, User, X } from '@glacier/icons';
import { useMemo } from 'react';
import { artSized } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import type { Playlist } from '../playlists/playlists.tsx';
import type { Recent } from './searchRecents.ts';
import { SEP } from './searchModel.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * One tile in the Recent row. Its artwork is resolved live from the library
 * rather than remembered: a local file's cover is an object URL and a server's
 * carries a stream token, so either one stored a week ago would be a dead image
 * today. Only a catalogue result - a plain public URL - keeps its own.
 */
export function RecentTile({
  recent,
  tracks,
  playlists,
  onOpen,
  onForget,
}: {
  recent: Recent;
  tracks: readonly Track[];
  playlists: readonly Playlist[];
  onOpen: () => void;
  onForget: () => void;
}) {
  const cover = useMemo(() => {
    switch (recent.kind) {
      case 'track':
        return tracks.find((t) => t.path === recent.key)?.artwork ?? null;
      case 'artist':
        return tracks.find((t) => t.artist === recent.key && t.artwork)?.artwork ?? null;
      case 'album': {
        const [title, artist] = recent.key.split(SEP);
        return (
          tracks.find((t) => t.album === title && (!artist || t.artist === artist) && t.artwork)
            ?.artwork ?? null
        );
      }
      case 'playlist': {
        const list = playlists.find((p) => p.id === recent.key);
        if (!list) return null;
        const want = new Set(list.paths);
        return tracks.find((t) => want.has(t.path) && t.artwork)?.artwork ?? null;
      }
      default:
        return recent.cover;
    }
  }, [playlists, recent, tracks]);

  // Recents draw small tiles, so the 160 variant; a null cover (nothing in
  // the library to resolve it from anymore) keeps the kind's glyph below.
  const sized = artSized(cover, 160);
  const art = useArtLoad(sized, '');

  return (
    <div className="searchRecent">
      <button type="button" className="searchRecent__body" onClick={onOpen}>
        <span className="searchRecent__art" data-round={recent.kind === 'artist' || undefined}>
          {cover ? (
            <img {...art} src={sized ?? undefined} alt="" loading="lazy" />
          ) : recent.kind === 'artist' ? (
            <User size={22} />
          ) : recent.kind === 'playlist' ? (
            <ListMusic size={22} />
          ) : recent.kind === 'genre' ? (
            <Tag size={22} />
          ) : (
            <Music size={22} />
          )}
        </span>
        <span className="searchRecent__title">{recent.title}</span>
        <span className="searchRecent__sub">{recent.subtitle}</span>
      </button>
      <button
        type="button"
        className="searchRecent__forget"
        aria-label={`Forget ${recent.title}`}
        onClick={onForget}
      >
        <X size={13} />
      </button>
    </div>
  );
}
