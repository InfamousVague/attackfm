import { Button, ContextMenu, Input, Modal, MenuItem, ScrollArea, Text } from '@glacier/react';
import { Heart, History, ListMusic, Plus, Trash2 } from '@glacier/icons';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { usePlaylists } from './playlists.tsx';
import { PluginFence, usePlugins } from '../plugins/runtime.tsx';
import type { PluginPlaylistTile } from '../plugins/types.ts';
import { PlaylistModal } from './PlaylistModal.tsx';
import type { EmptyArtName } from './EmptyArt.tsx';
import type { Track } from './tauri.ts';

/**
 * The collection's cover, seeded from its own songs: a 2x2 split of the first
 * four DISTINCT artworks (deduped, so an album playlist is not the same cover
 * four times over). Fewer than four distinct covers, the first one fills the
 * whole square; none at all, the given glyph. Liked and every user playlist
 * wear this same cover, at the same size as every other card on the page.
 */
function MosaicCover({ tracks, fallback, tone }: { tracks: Track[]; fallback: ReactNode; tone: string }) {
  const arts: string[] = [];
  for (const t of tracks) {
    if (t.artwork && !arts.includes(t.artwork)) arts.push(t.artwork);
    if (arts.length === 4) break;
  }

  if (arts.length === 0) {
    return (
      <div className={`tileSquircle ${tone}`} aria-hidden>
        {fallback}
      </div>
    );
  }

  if (arts.length < 4) {
    return (
      <div className="tileSquircle tileCoverFull" aria-hidden>
        <img src={arts[0]} alt="" loading="lazy" />
      </div>
    );
  }

  return (
    <div className="tileSquircle tileLikedGrid" aria-hidden>
      {arts.map((art, i) => (
        <img key={i} src={art} alt="" loading="lazy" />
      ))}
    </div>
  );
}

/** One tile: a squircle carrying the iconography, with a plain caption beneath.
 *  A tile that can be deleted wears a context menu - right-click on a desktop,
 *  long-press on a phone - rather than a delete affordance sitting on the face
 *  of every playlist waiting to be hit by mistake. The library's own views
 *  (Liked, Recent) pass no handler and so carry no menu: there is nothing
 *  there to delete. */
function Tile({
  cover,
  name,
  onOpen,
  onDelete,
}: {
  cover: ReactNode;
  name: string;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const tile = (
    <button type="button" className="playlistTile" onClick={onOpen}>
      {cover}
      <span className="playlistTileName">{name}</span>
    </button>
  );
  if (!onDelete) return tile;
  return (
    <ContextMenu
      aria-label={`${name} actions`}
      content={
        <MenuItem icon={<Trash2 size={15} />} onSelect={onDelete}>
          Delete playlist
        </MenuItem>
      }
    >
      {tile}
    </ContextMenu>
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
export function PlaylistShowcase({
  onPlay,
  onOpenPlaylist,
  onOpenArtist,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  /** Opens one of the user's own lists as a full page - where it can be
   *  reordered, renamed and deleted. Liked and Recent stay modals: they are
   *  the library's own views, with no order of their own to edit. */
  onOpenPlaylist: (id: string) => void;
  /** Opens an artist's page from a modal row's artist line. */
  onOpenArtist?: (artist: string) => void;
}) {
  const { tracks, favoriteTracks } = useLibrary();
  const { playlists, create, remove, removeTrack } = usePlaylists();
  const { enabled } = usePlugins();
  // 'liked' | 'recent' | a user playlist's id.
  const [open, setOpen] = useState<string | null>(null);
  // The New Playlist dialog: null closed, otherwise the name being typed.
  const [draftName, setDraftName] = useState<string | null>(null);
  // The playlist a delete is being confirmed for. Deleting a list is not
  // undoable, so the menu asks before the store hears about it.
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  // Recent stands in as the most recently added until play history is tracked.
  const recent = useMemo(() => [...tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 50), [tracks]);

  // Tiles the plugins bring, trailing the app's own in registration order.
  const pluginTiles = enabled.flatMap((p) => (p.playlistTiles ?? []).map((tile) => ({ plugin: p, tile })));

  // Paths resolve against the live library, favourites-style: a row whose file
  // is gone simply does not render, and comes back if the file does.
  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t] as const)), [tracks]);

  // The strip's own modal now serves only the two library views. A user's list
  // opens as a page instead - it has a running order to edit, which a
  // read-through sheet has nowhere to put.
  const current: { title: string; tracks: Track[]; empty: string; art?: EmptyArtName } | null =
    open === 'liked'
      ? { title: 'Liked', tracks: favoriteTracks, empty: 'No liked songs yet. Tap the heart while a song plays.', art: 'liked' }
      : open === 'recent'
        ? { title: 'Recent', tracks: recent, empty: 'Nothing here yet.' }
        : null;

  const createDraft = (event: FormEvent) => {
    event.preventDefault();
    if (draftName === null) return;
    const name = draftName;
    setDraftName(null);
    // Async because a server playlist's id is the server's to mint; the modal
    // opens the moment it exists. A refused create reopens the dialog with
    // the name still in it, which is also the retry.
    create(name).then(onOpenPlaylist, () => setDraftName(name));
  };

  return (
    <>
      {/* A shelf like every other on the page: the same heading, the same
          horizontal row - the tiles are just squircles instead of squares.
          The counts that used to crowd this header live in the stats card. */}
      <section className="homeShelf">
        <h2 className="homeShelfTitle">Playlists</h2>
        <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
          <div className="homeShelfRow showcaseRow">
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
                onOpen={() => onOpenPlaylist(playlist.id)}
                onDelete={() => setDeleting({ id: playlist.id, name: playlist.name })}
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
      </section>
      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={`Delete ${deleting.name}?`}
          size="sm"
        >
          <Text tone="muted" size="sm">
            The songs stay in your library. Only the list goes.
          </Text>
          <div className="playlistDeleteActions">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                remove(deleting.id);
                setDeleting(null);
              }}
            >
              <Trash2 size={15} />
              <span>Delete</span>
            </Button>
          </div>
        </Modal>
      )}

      {current && (
        <PlaylistModal
          open={open !== null}
          onClose={() => setOpen(null)}
          title={current.title}
          tracks={current.tracks}
          emptyLabel={current.empty}
          emptyArt={current.art}
          onOpenArtist={
            onOpenArtist &&
            ((artist) => {
              // Close the sheet first so the artist page is not buried under it.
              setOpen(null);
              onOpenArtist(artist);
            })
          }
          // The open view is the queue: a row plays on through the rest. Neither
          // Liked nor Recent sheds rows here - the heart already edits Liked,
          // and Recent is a window on the library rather than a list.
          onPlay={(t) => onPlay(t, current.tracks)}
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
