import { mosaicArts, useTileArt } from '../ux/artLoad.ts';
import { Button, ContextMenu, Input, Modal, MenuItem, Text, useToast } from '@glacier/react';
import {
  AudioLines,
  Check,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  History,
  Image as ImageIcon,
  ListMusic,
  Pencil,
  Plus,
  Trash2,
  X,
} from '@glacier/icons';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useLibrary } from '../library/library.tsx';
import { DjLauncher } from '../booth/DjLauncher.tsx';
import { usePlaylists, type Playlist } from './playlists.tsx';
import { PluginFence, usePlugins } from '../../plugins/runtime.tsx';
import type { PluginPlaylistTile } from '../../plugins/types.ts';
import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { useLikedStems } from '../servers/likedStems.ts';
import { playlistPlayedAt, notePlaylistPlayed } from './playlistRecency.ts';
import { openMix } from '../nav/openMix.ts';
import { LibChipMosaic, LibChipStat } from '../library/LibChipFace.tsx';
// The objects made for these four tiles. Their own colours are not used: each
// is tinted to its card's hue in CSS, so the four read as one set rather than
// four photographs that happen to sit together.
import likedChip from '../../assets/chip-liked.webp';
import allSongsChip from '../../assets/chip-all-songs.webp';
import onRepeatChip from '../../assets/chip-on-repeat.webp';
import type { Track } from '../core/tauri.ts';

/**
 * The collection's cover, seeded from its own songs: a 2x2 split of the first
 * four DISTINCT artworks (deduped, so an album playlist is not the same cover
 * four times over). Fewer than four distinct covers, the first one fills the
 * whole square; none at all, the given glyph. Liked and every user playlist
 * wear this same cover, at the same size as every other card on the page.
 */
export function MosaicCover({ tracks, fallback, tone }: { tracks: Track[]; fallback: ReactNode; tone: string }) {
  const arts = mosaicArts(tracks.map((t) => t.artwork));
  // The tile skeletons until every cover it will actually draw has answered -
  // the whole 2x2, or just the first when fewer than four fill the square.
  const { loaded, hostRef } = useTileArt(arts.length >= 4 ? arts : arts.slice(0, 1));

  if (arts.length === 0) {
    return (
      <div className={`tileSquircle ${tone}`} aria-hidden>
        {fallback}
      </div>
    );
  }

  if (arts.length < 4) {
    return (
      <div ref={hostRef} className="tileSquircle tileCoverFull" aria-hidden data-tile-pop="" data-tile-loading={!loaded || undefined}>
        <img src={arts[0]} alt="" loading="lazy" />
      </div>
    );
  }

  return (
    <div ref={hostRef} className="tileSquircle tileLikedGrid" aria-hidden data-tile-pop="" data-tile-loading={!loaded || undefined}>
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
  menu,
}: {
  cover: ReactNode;
  name: string;
  onOpen: () => void;
  onDelete?: () => void;
  /** Extra items above Delete - the playlist options the page's own menu has. */
  menu?: ReactNode;
}) {
  const tile = (
    <button type="button" className="playlistTile" onClick={onOpen}>
      {cover}
      <span className="playlistTileName">{name}</span>
    </button>
  );
  if (!onDelete && !menu) return tile;
  return (
    <ContextMenu
      aria-label={`${name} actions`}
      className="playlistTileMenuTarget"
      content={
        <>
          {menu}
          {onDelete && (
            <MenuItem icon={<Trash2 size={15} />} onSelect={onDelete}>
              Delete playlist
            </MenuItem>
          )}
        </>
      }
    >
      {tile}
    </ContextMenu>
  );
}

/** A ContextMenu when there is something to show, and the bare child when
 *  there is not - so the caller does not have to duplicate its subtree. */
function MaybeMenu({
  when,
  content,
  children,
  ...rest
}: {
  when: boolean;
  content: ReactNode;
  children: ReactNode;
} & { 'aria-label': string }) {
  if (!when) return <>{children}</>;
  return (
    <ContextMenu {...rest} className="playlistTileMenuTarget" content={content}>
      {children}
    </ContextMenu>
  );
}

/** From wherever a press lands in a grid, the tile's menu wrapper - the one
 *  element per tile that actually wears the ContextMenu. */
function tileMenuTarget(from: Element): Element | null {
  return from.closest('.playlistTileMenuTarget');
}

/** The new-folder form, keyed per invocation so each opens empty. */
function NewFolderForm({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form
      className="playlistCreate"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(name.trim());
      }}
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        placeholder="Road trips"
        aria-label="Folder name"
      />
      <Button type="submit" variant="solid">
        Move here
      </Button>
    </form>
  );
}

/**
 * One plugin tile: a dedicated component instance per contribution, so the
 * plugin's usePlaylist hook mounts and unmounts with the tile - never a hook
 * count change inside a shared component. Owns its own modal so nothing
 * threads through the showcase's open-state union.
 */
function PluginTile({ tile }: { tile: PluginPlaylistTile }) {
  // Bound to a use-named local so the call reads as the hook it is.
  const usePlaylist = tile.usePlaylist;
  const { name, cover, tracks, emptyLabel } = usePlaylist();
  // Opens as a PAGE now, like every other list: the sheet that used to
  // preview it was a second way of drawing a playlist, and it could not show
  // a running order or sit in the back stack the way a page does.
  return <Tile name={name} cover={cover} onOpen={() => openMix(name, [...tracks], emptyLabel)} />;
}

/** "1 song" / "12 songs" - the line the Browse tiles use, so a chip built to
 *  look like one also counts like one. */
function songCount(n: number): string {
  return n === 1 ? '1 song' : `${n} songs`;
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
  onOpenSongs,
  onOpenArtist,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  /** Opens one of the user's own lists as a full page - where it can be
   *  reordered, renamed and deleted. That editing is what separates it from the
   *  library-wide views below, which have no order of their own to change. */
  onOpenPlaylist: (id: string) => void;
  /** Opens a library-wide song page - Liked, all songs, on repeat, or the
   *  newest arrivals - full rather than in a sheet. They are the collection's
   *  own big views: a fixed order, nothing to edit, and the same frame each. */
  onOpenSongs: (view: import('../library/SongPage.tsx').SongCollection) => void;
  /** Opens an artist's page from a modal row's artist line. */
  onOpenArtist?: (artist: string) => void;
}) {
  const { tracks, favoriteTracks } = useLibrary();
  // removeTrack went with the strip's modal - shedding a row was only ever
  // offered there, and Recent never offered it at all.
  const { playlists, create, remove, rename, setMeta, setCover, setAutoStem } = usePlaylists();
  /*
   * Hold a tile for its menu - and let go without opening the playlist.
   *
   * The kit's ContextMenu already opened on a long press, so this looked
   * done; it was not, for the reason song rows needed the same hook. The kit
   * shows the panel at 500ms and then leaves the pointerup alone, so the tile
   * underneath - whose whole job is "tap to open" - took the click the moment
   * the finger lifted: the menu appeared and the playlist opened over it, and
   * the items were unreachable by touch. The hook swallows that release.
   */
  const hold = useHoldToMenu(tileMenuTarget);
  /* Liked's own "separate ahead" answer. It is a server preference rather than
     a row on a playlist, so unlike every tile below it has to be asked for. */
  const { liked: likedStems, setLiked: setLikedStems } = useLikedStems();
  const { toast } = useToast();
  const { enabled } = usePlugins();
  // The New Playlist dialog: null closed, otherwise the name being typed.
  const [draftName, setDraftName] = useState<string | null>(null);
  /** The playlist being renamed from its tile, or null. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** The playlist a new folder is being made FOR, or null. */
  const [folderFor, setFolderFor] = useState<{ id: string; name: string } | null>(null);
  /** Which playlist the next picked file becomes the cover of. */
  const coverFor = useRef<string | null>(null);
  const coverInput = useRef<HTMLInputElement | null>(null);

  // Same rule the page's menu follows: a folder IS the playlists that name it.
  const folders = useMemo(
    () => [...new Set(playlists.map((p) => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [playlists],
  );

  /*
   * The playlist options, on the tile itself. The page's ⋮ menu has all of
   * this, but filing twelve playlists into folders through twelve page visits
   * is the N-journeys problem the gap audit keeps finding - press-and-hold on
   * the shelf is where organising actually happens.
   */
  const tileMenu = (p: Playlist) => (
    <>
      <MenuItem icon={<Pencil size={15} />} onSelect={() => setRenaming({ id: p.id, name: p.name })}>
        Rename
      </MenuItem>
      {folders.map((name) => (
        <MenuItem
          key={name}
          icon={p.folder === name ? <Check size={15} /> : <FolderClosed size={15} />}
          onSelect={() => setMeta(p.id, { folder: p.folder === name ? '' : name })}
        >
          {name}
        </MenuItem>
      ))}
      {p.folder && (
        <MenuItem icon={<FolderOpen size={15} />} onSelect={() => setMeta(p.id, { folder: '' })}>
          Take out of {p.folder}
        </MenuItem>
      )}
      <MenuItem icon={<FolderPlus size={15} />} onSelect={() => setFolderFor({ id: p.id, name: p.name })}>
        New folder…
      </MenuItem>
      {setCover && (
        <MenuItem
          icon={<ImageIcon size={15} />}
          onSelect={() => {
            coverFor.current = p.id;
            coverInput.current?.click();
          }}
        >
          {p.coverUrl ? 'Change cover…' : 'Choose cover…'}
        </MenuItem>
      )}
      {setCover && p.coverUrl && (
        <MenuItem icon={<X size={15} />} onSelect={() => void setCover(p.id, null)}>
          Remove cover
        </MenuItem>
      )}
      {/* Separating ahead is now per list and off until asked for. Shown only
          where the server understands the flag - p.autoStem is undefined on a
          local library and on a server from before it. */}
      {setAutoStem && p.autoStem !== undefined && (
        <MenuItem
          icon={<AudioLines size={15} />}
          onSelect={() => setAutoStem(p.id, !p.autoStem)}
        >
          {p.autoStem ? 'Stop separating ahead' : 'Separate these ahead'}
        </MenuItem>
      )}
    </>
  );
  // The playlist a delete is being confirmed for. Deleting a list is not
  // undoable, so the menu asks before the store hears about it.
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  // Tiles the plugins bring, trailing the app's own in registration order.
  const pluginTiles = enabled.flatMap((p) => (p.playlistTiles ?? []).map((tile) => ({ plugin: p, tile })));

  // Paths resolve against the live library, favourites-style: a row whose file
  // is gone simply does not render, and comes back if the file does.
  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t] as const)), [tracks]);

  /*
   * Freshest first: the last edit (the server's stamp) or the last listen (this
   * device's own memory), whichever is newer - so the list you had on last
   * night is at your thumb, not wherever creation order left it.
   *
   * Then split by folder. Loose playlists stay in the main grid with Recent and
   * New Playlist, because those are the ones somebody has not felt the need to
   * file and burying them under a heading would punish not tidying up. Each
   * folder gets its own labelled grid underneath, in alphabetical order - a
   * folder's position should not move when you play something inside it.
   */
  const { loose, foldered } = useMemo(() => {
    const sorted = [...playlists].sort(
      (a, b) =>
        Math.max(b.createdAt, playlistPlayedAt(b.id)) -
        Math.max(a.createdAt, playlistPlayedAt(a.id)),
    );
    const out: typeof sorted = [];
    const groups = new Map<string, typeof sorted>();
    for (const p of sorted) {
      if (!p.folder) {
        out.push(p);
        continue;
      }
      const bucket = groups.get(p.folder);
      if (bucket) bucket.push(p);
      else groups.set(p.folder, [p]);
    }
    return {
      loose: out,
      foldered: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    };
  }, [playlists]);

  // Real sleeves for the two whole-library doors, for the Real covers style.
  // On repeat has no list of its own here, so it wears the library's own
  // covers - a window on the whole shelf, which is what "most played" is a
  // slice of anyway.
  const likedCovers = useMemo(
    () => favoriteTracks.map((t) => t.artwork).filter((a): a is string => !!a),
    [favoriteTracks],
  );
  const allCovers = useMemo(
    () => tracks.map((t) => t.artwork).filter((a): a is string => !!a),
    [tracks],
  );

  // Nothing in this strip opens a modal any more. Recent was the last one, and
  // it opens as a full page like Liked and All songs - the three are the same
  // kind of thing (a window on the whole library, in a fixed order, with
  // nothing to edit), so they earn the same frame. A user's own list still
  // opens as a page it can reorder; that is a different job.

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
      {/* Liked and All songs are not playlists - they are the whole library,
          sliced two ways, and they never change, never reorder and cannot be
          deleted. Sitting them in the playlist grid made them look like two
          more lists among however many the user has made. They lead now, as a
          pair of half-width chips: a wide shape rather than a square, because
          what matters about them is the NAME, and a chip that is half the row
          says "there are exactly two of these" at a glance. */}
      <section className="homeShelf libShelf">
        <div className="libChips" {...hold}>
          {/* Built like the Browse tiles on search: a bold gradient face, the
              object bled across it, the name and its count sitting on top. The
              hue is fixed per chip rather than hashed from the name - there are
              two of these forever, and each one already has a colour of its own
              in the picture it wears. */}
          {/* The one chip with a menu, and the reason the whole row carries the
              hold handlers: separating Liked ahead of time is a thing you want
              to reach from where your liked songs ARE, not only from a settings
              pane three taps away. Nothing else here has an action worth
              holding for, so the others stay plain buttons inside the same
              press-and-hold surface. */}
          {/* No menu at all when there is nothing to put in it - a hold that
              opens a panel saying "nothing here" is worse than a hold that
              does nothing. */}
          <MaybeMenu
            when={likedStems !== undefined}
            aria-label="Liked actions"
            content={
              <MenuItem
                icon={<AudioLines size={15} />}
                onSelect={() => void setLikedStems(!likedStems)}
              >
                {likedStems ? 'Stop separating ahead' : 'Separate these ahead'}
              </MenuItem>
            }
          >
            <button
              type="button"
              className="libChip libChip--liked"
              style={{ '--libChipHue': 338, '--libChipHue2': 300, '--art': `url("${likedChip}")` } as CSSProperties}
              onClick={() => onOpenSongs('liked')}
            >
              <img className="libChip__art" src={likedChip} alt="" loading="lazy" />
              <LibChipMosaic covers={likedCovers} />
              <LibChipStat value={String(favoriteTracks.length)} />
              <span className="libChip__name">Liked</span>
              <span className="libChip__count">{songCount(favoriteTracks.length)}</span>
            </button>
          </MaybeMenu>
          <button
            type="button"
            className="libChip libChip--all"
            style={{ '--libChipHue': 214, '--libChipHue2': 262, '--art': `url("${allSongsChip}")` } as CSSProperties}
            onClick={() => onOpenSongs('all')}
          >
            <img className="libChip__art" src={allSongsChip} alt="" loading="lazy" />
            <LibChipMosaic covers={allCovers} />
            <LibChipStat value={String(tracks.length)} />
            <span className="libChip__name">All songs</span>
            <span className="libChip__count">{songCount(tracks.length)}</span>
          </button>
          {/* The songs you keep coming back to, as a door beside the other
              whole-library views. Green, wearing the repeat mark itself - the
              one chip whose face is a symbol, because the symbol IS the name. */}
          <button
            type="button"
            className="libChip libChip--repeat"
            style={{ '--libChipHue': 145, '--libChipHue2': 190, '--art': `url("${onRepeatChip}")` } as CSSProperties}
            onClick={() => onOpenSongs('onrepeat')}
          >
            <img className="libChip__art" src={onRepeatChip} alt="" loading="lazy" />
            <LibChipMosaic covers={allCovers} />
            <span className="libChip__name">On repeat</span>
            <span className="libChip__count">Your most played</span>
          </button>
          <DjLauncher onPlay={(track, queue) => onPlay(track, queue ?? [track])} />
        </div>
      </section>

      <section className="homeShelf">
        <h2 className="homeShelfTitle">Playlists</h2>
        {/* A grid, not a rail: every playlist on screen at once, wrapping
            into as many columns as the width holds. Only past five rows'
            worth does it scroll - the cap keeps a hundred playlists from
            burying the shelves below. */}
        <div className="showcaseGrid" {...hold}>
            <Tile
              name="Recent"
              cover={
                <div className="tileSquircle tileRecent" aria-hidden>
                  <History size={24} />
                </div>
              }
              onOpen={() => onOpenSongs('recent')}
            />
            {/* Freshest first: the last edit (the server's stamp) or the
                last listen (this device's own memory), whichever is newer -
                so the list you had on last night is at your thumb, not
                wherever creation order left it. */}
            {loose.map((playlist) => (
              <Tile
                key={playlist.id}
                name={playlist.name}
                cover={
                  playlist.coverUrl ? (
                    <div className="tileSquircle tileRecent" aria-hidden>
                      <img className="tileChosenCover" src={playlist.coverUrl} alt="" loading="lazy" />
                    </div>
                  ) : (
                    <MosaicCover
                      tracks={playlist.paths.map((p) => byPath.get(p)).filter((t): t is Track => t !== undefined)}
                      fallback={<ListMusic size={24} />}
                      tone="tileRecent"
                    />
                  )
                }
                onOpen={() => onOpenPlaylist(playlist.id)}
                onDelete={() => setDeleting({ id: playlist.id, name: playlist.name })}
                menu={tileMenu(playlist)}
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
                <PluginTile tile={tile} />
              </PluginFence>
            ))}
        </div>
      </section>

      {/* One shelf per folder, under the loose ones. Deliberately flat rather
          than a folder you open: on a phone, a tile that leads to another grid
          of tiles is a second journey for something that fits on this screen -
          and folders here are for grouping a wall of playlists, not for hiding
          them. */}
      {foldered.map(([folder, lists]) => (
        <section className="homeShelf" key={folder}>
          <h2 className="homeShelfTitle">
            <FolderClosed size={15} className="showcaseFolderGlyph" aria-hidden />
            {folder}
            <span className="showcaseFolderCount">{lists.length}</span>
          </h2>
          <div className="showcaseGrid" {...hold}>
            {lists.map((playlist) => (
              <Tile
                key={playlist.id}
                name={playlist.name}
                cover={
                  playlist.coverUrl ? (
                    <div className="tileSquircle tileRecent" aria-hidden>
                      <img className="tileChosenCover" src={playlist.coverUrl} alt="" loading="lazy" />
                    </div>
                  ) : (
                    <MosaicCover
                      tracks={playlist.paths.map((p) => byPath.get(p)).filter((t): t is Track => t !== undefined)}
                      fallback={<ListMusic size={24} />}
                      tone="tileRecent"
                    />
                  )
                }
                onOpen={() => onOpenPlaylist(playlist.id)}
                onDelete={() => setDeleting({ id: playlist.id, name: playlist.name })}
                menu={tileMenu(playlist)}
              />
            ))}
          </div>
        </section>
      ))}

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

      {/* Naming a new playlist: one field, and the name is the commitment -
          an empty submit still creates, as "New Playlist". */}
      {/* The cover chooser for whichever tile asked. One input for the whole
          shelf - coverFor remembers the tile, because the picker outlives the
          menu that opened it. */}
      <input
        ref={coverInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          const id = coverFor.current;
          coverFor.current = null;
          if (!file || !id || !setCover) return;
          void setCover(id, file).catch((err: unknown) => {
            toast({
              message:
                err instanceof Error && err.message
                  ? `That cover did not take: ${err.message}`
                  : 'That cover did not take.',
            });
          });
        }}
      />

      <Modal open={renaming !== null} onClose={() => setRenaming(null)} title="Rename playlist" size="sm">
        <form
          className="playlistCreate"
          onSubmit={(e) => {
            e.preventDefault();
            if (renaming && renaming.name.trim()) rename(renaming.id, renaming.name.trim());
            setRenaming(null);
          }}
        >
          <Input
            autoFocus
            value={renaming?.name ?? ''}
            onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.currentTarget.value } : r))}
            aria-label="Playlist name"
          />
          <Button type="submit" variant="solid">
            Save
          </Button>
        </form>
      </Modal>

      <Modal open={folderFor !== null} onClose={() => setFolderFor(null)} title="New folder" size="sm">
        <NewFolderForm
          key={folderFor?.id ?? ''}
          onDone={(name) => {
            // Naming the folder and filing this playlist are one act - an empty
            // folder would have nowhere to exist. Same rule as the page.
            if (folderFor && name) setMeta(folderFor.id, { folder: name });
            setFolderFor(null);
          }}
        />
      </Modal>

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
