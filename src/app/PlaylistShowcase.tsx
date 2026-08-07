import { ScrollArea, Text } from '@glacier/react';
import { Heart, History, Plus } from '@glacier/icons';
import { useMemo, useState, type ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { PluginFence, usePlugins } from '../plugins/runtime.tsx';
import type { PluginPlaylistTile } from '../plugins/types.ts';
import { PlaylistModal } from './PlaylistModal.tsx';
import type { Track } from './tauri.ts';

/**
 * The cover for the Liked Songs tile: a 2x2 mosaic of the four newest
 * favourites that have art. Below four, it is the heart glyph on its own -
 * there is no honest mosaic to make from a handful of covers.
 */
function LikedCover() {
  const { favoriteTracks } = useLibrary();
  const arts = favoriteTracks.map((t) => t.artwork).filter((a): a is string => a !== null).slice(0, 4);

  if (arts.length < 4) {
    return (
      <div className="tileSquircle tileLiked" aria-hidden>
        <Heart size={24} fill="currentColor" />
      </div>
    );
  }

  return (
    <div className="tileSquircle tileLikedGrid" aria-hidden>
      {arts.map((art, i) => (
        <img key={i} src={art} alt="" />
      ))}
    </div>
  );
}

/** One tile: a squircle carrying the iconography, with a plain caption beneath. */
function Tile({ cover, name, onOpen }: { cover: ReactNode; name: string; onOpen: () => void }) {
  return (
    <button type="button" className="playlistTile" onClick={onOpen}>
      {cover}
      <span className="playlistTileName">{name}</span>
    </button>
  );
}

type PlaylistId = 'liked' | 'recent' | 'new';

// The tiles shown in the strip - Liked, Recent, New Playlist.
const PLAYLIST_COUNT = 3;

/**
 * One plugin tile: a dedicated component instance per contribution, so the
 * plugin's usePlaylist hook mounts and unmounts with the tile - never a hook
 * count change inside a shared component. Owns its own modal so nothing
 * threads through the showcase's open-state union.
 */
function PluginTile({ tile, onPlay }: { tile: PluginPlaylistTile; onPlay: (track: Track, queue: Track[]) => void }) {
  // Bound to a use-named local so the call reads as the hook it is.
  const usePlaylist = tile.usePlaylist;
  const { name, cover, tracks, emptyLabel } = usePlaylist();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tile name={name} cover={cover} onOpen={() => setOpen(true)} />
      {open && (
        <PlaylistModal
          open
          onClose={() => setOpen(false)}
          title={name}
          tracks={[...tracks]}
          emptyLabel={emptyLabel}
          // The tile's playlist is the queue: opening a row plays on through it.
          onPlay={(t) => onPlay(t, [...tracks])}
        />
      )}
    </>
  );
}

/**
 * The playlist strip above the library table: a horizontally scrolling row of
 * squircle tiles - Liked, Recent, and New Playlist. Opening one shows its
 * tracks in a modal.
 */
export function PlaylistShowcase({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { tracks, favoriteTracks } = useLibrary();
  const { enabled } = usePlugins();
  const [open, setOpen] = useState<PlaylistId | null>(null);

  // Recent stands in as the most recently added until play history is tracked.
  const recent = useMemo(() => [...tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 50), [tracks]);

  // Tiles the plugins bring, trailing the app's own in registration order.
  const pluginTiles = enabled.flatMap((p) => (p.playlistTiles ?? []).map((tile) => ({ plugin: p, tile })));

  const modal: Record<PlaylistId, { title: string; tracks: Track[]; empty: string }> = {
    liked: { title: 'Liked', tracks: favoriteTracks, empty: 'No liked songs yet. Tap the heart while a song plays.' },
    recent: { title: 'Recent', tracks: recent, empty: 'Nothing here yet.' },
    new: { title: 'New Playlist', tracks: [], empty: 'Playlist creation is coming soon.' },
  };
  const current = open ? modal[open] : null;

  return (
    <>
      <header className="stripHeader">
        <div className="stripHeading">
          <span className="stripTitle">Playlists</span>
          <Text tone="muted" size="sm">
            {PLAYLIST_COUNT + pluginTiles.length} playlists · {tracks.length.toLocaleString()}{' '}
            {tracks.length === 1 ? 'song' : 'songs'} · {favoriteTracks.length.toLocaleString()} liked
          </Text>
        </div>
        <ScrollArea orientation="horizontal" className="showcaseScroll" hideScrollbar>
          <div className="showcaseRow">
            <Tile name="Liked" cover={<LikedCover />} onOpen={() => setOpen('liked')} />
            <Tile
              name="Recent"
              cover={
                <div className="tileSquircle tileRecent" aria-hidden>
                  <History size={24} />
                </div>
              }
              onOpen={() => setOpen('recent')}
            />
            <Tile
              name="New Playlist"
              cover={
                <div className="tileSquircle tileAdd" aria-hidden>
                  <Plus size={24} />
                </div>
              }
              onOpen={() => setOpen('new')}
            />
            {/* Plugin tiles trail the app's own, rendered with the house Tile
                and modal so a plugin says what the playlist is, not what a
                tile looks like. */}
            {pluginTiles.map(({ plugin, tile }) => (
              <PluginFence key={`${plugin.id}:${tile.id}`} pluginId={plugin.id}>
                <PluginTile tile={tile} onPlay={onPlay} />
              </PluginFence>
            ))}
          </div>
        </ScrollArea>
      </header>
      {current && (
        <PlaylistModal
          open={open !== null}
          onClose={() => setOpen(null)}
          title={current.title}
          tracks={current.tracks}
          emptyLabel={current.empty}
          // The open playlist is the queue: a row plays on through the rest.
          onPlay={(t) => onPlay(t, current.tracks)}
        />
      )}
    </>
  );
}
