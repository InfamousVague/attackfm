import { Button, Input, Modal, ScrollArea, Text } from '@glacier/react';
import { Heart, History, ListMusic, Plus } from '@glacier/icons';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { usePlaylists } from './playlists.tsx';
import { PluginFence, usePlugins } from '../plugins/runtime.tsx';
import type { PluginPlaylistTile } from '../plugins/types.ts';
import { PlaylistModal } from './PlaylistModal.tsx';
import type { Track } from './tauri.ts';

/**
 * A 2x2 mosaic of the collection's first four artworks; below four, the given
 * glyph on its own - there is no honest mosaic to make from a handful of
 * covers. Liked and every user playlist wear this same cover.
 */
function MosaicCover({ tracks, fallback, tone }: { tracks: Track[]; fallback: ReactNode; tone: string }) {
  const arts = tracks.map((t) => t.artwork).filter((a): a is string => a !== null).slice(0, 4);

  if (arts.length < 4) {
    return (
      <div className={`tileSquircle ${tone}`} aria-hidden>
        {fallback}
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
 * The playlist strip above the library table: Liked and Recent, then the
 * user's own playlists, then the New Playlist tile that creates one, then
 * whatever the plugins bring. Opening any tile shows its tracks in a modal;
 * a user playlist's modal can also shed tracks or delete the list whole.
 */
export function PlaylistShowcase({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { tracks, favoriteTracks } = useLibrary();
  const { playlists, create, remove, removeTrack } = usePlaylists();
  const { enabled } = usePlugins();
  // 'liked' | 'recent' | a user playlist's id.
  const [open, setOpen] = useState<string | null>(null);
  // The New Playlist dialog: null closed, otherwise the name being typed.
  const [draftName, setDraftName] = useState<string | null>(null);

  // Recent stands in as the most recently added until play history is tracked.
  const recent = useMemo(() => [...tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 50), [tracks]);

  // Tiles the plugins bring, trailing the app's own in registration order.
  const pluginTiles = enabled.flatMap((p) => (p.playlistTiles ?? []).map((tile) => ({ plugin: p, tile })));

  // Paths resolve against the live library, favourites-style: a row whose file
  // is gone simply does not render, and comes back if the file does.
  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t] as const)), [tracks]);
  const openPlaylist = open !== null ? playlists.find((p) => p.id === open) : undefined;

  // A playlist deleted from another device while its modal is open here: the
  // heartbeat removes it from the list, and the modal closes properly rather
  // than rendering against an id that no longer resolves.
  useEffect(() => {
    if (open !== null && open !== 'liked' && open !== 'recent' && !openPlaylist) setOpen(null);
  }, [open, openPlaylist]);

  const current =
    open === 'liked'
      ? { title: 'Liked', tracks: favoriteTracks, empty: 'No liked songs yet. Tap the heart while a song plays.' }
      : open === 'recent'
        ? { title: 'Recent', tracks: recent, empty: 'Nothing here yet.' }
        : openPlaylist
          ? {
              title: openPlaylist.name,
              tracks: openPlaylist.paths.map((p) => byPath.get(p)).filter((t): t is Track => t !== undefined),
              empty: 'Nothing here yet — right-click (or long-press) a song in the library and add it.',
            }
          : null;

  const createDraft = (event: FormEvent) => {
    event.preventDefault();
    if (draftName === null) return;
    const name = draftName;
    setDraftName(null);
    // Async because a server playlist's id is the server's to mint; the modal
    // opens the moment it exists. A refused create reopens the dialog with
    // the name still in it, which is also the retry.
    create(name).then(setOpen, () => setDraftName(name));
  };

  const playlistCount = 2 + playlists.length + pluginTiles.length;

  return (
    <>
      <header className="stripHeader">
        <div className="stripHeading">
          <span className="stripTitle">Playlists</span>
          <Text tone="muted" size="sm">
            {playlistCount} {playlistCount === 1 ? 'playlist' : 'playlists'} · {tracks.length.toLocaleString()}{' '}
            {tracks.length === 1 ? 'song' : 'songs'} · {favoriteTracks.length.toLocaleString()} liked
          </Text>
        </div>
        <ScrollArea orientation="horizontal" className="showcaseScroll" hideScrollbar>
          <div className="showcaseRow">
            <Tile
              name="Liked"
              cover={<MosaicCover tracks={favoriteTracks} fallback={<Heart size={24} fill="currentColor" />} tone="tileLiked" />}
              onOpen={() => setOpen('liked')}
            />
            <Tile
              name="Recent"
              cover={
                <div className="tileSquircle tileRecent" aria-hidden>
                  <History size={24} />
                </div>
              }
              onOpen={() => setOpen('recent')}
            />
            {playlists.map((playlist) => (
              <Tile
                key={playlist.id}
                name={playlist.name}
                cover={
                  <MosaicCover
                    tracks={playlist.paths.map((p) => byPath.get(p)).filter((t): t is Track => t !== undefined)}
                    fallback={<ListMusic size={24} />}
                    tone="tileRecent"
                  />
                }
                onOpen={() => setOpen(playlist.id)}
              />
            ))}
            <Tile
              name="New Playlist"
              cover={
                <div className="tileSquircle tileAdd" aria-hidden>
                  <Plus size={24} />
                </div>
              }
              onOpen={() => setDraftName('')}
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
          // Only the user's own lists can shed rows or be deleted; Liked and
          // Recent are the library's, and the heart already edits Liked.
          onRemoveTrack={openPlaylist ? (path) => removeTrack(openPlaylist.id, path) : undefined}
          onDelete={
            openPlaylist
              ? () => {
                  remove(openPlaylist.id);
                  setOpen(null);
                }
              : undefined
          }
        />
      )}
      {/* Naming a new playlist: one field, and the name is the commitment -
          an empty submit still creates, as "New Playlist". */}
      <Modal open={draftName !== null} onClose={() => setDraftName(null)} title="New Playlist" size="sm">
        <form className="playlistCreate" onSubmit={createDraft}>
          <Input
            autoFocus
            placeholder="Name your playlist"
            value={draftName ?? ''}
            onChange={(e) => setDraftName(e.currentTarget.value)}
            aria-label="Playlist name"
          />
          <Button type="submit" variant="solid">
            Create
          </Button>
        </form>
      </Modal>
    </>
  );
}
