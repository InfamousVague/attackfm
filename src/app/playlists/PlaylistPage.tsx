import {
  Button,
  IconButton,
  Input,
  Menu,
  MenuItem,
  Modal,
  SortableList,
  Text,
  SearchField,
  useToast,
} from '@glacier/react';
import {
  Check,
  EllipsisVertical,
  Image as ImageIcon,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  ListMusic,
  Pencil,
  Play,
  Shuffle,
  Plus,
  Trash2,
  X,
} from '@glacier/icons';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { mosaicArts, useArtLoad, useTileArt } from '../ux/artLoad.ts';
import { fetchPlaylistSuggestions, remotePath } from '../server.ts';
import { formatClock, formatTotal } from '../ux/format.ts';
import { shuffled } from '../ux/shuffle.ts';
import { RowArt } from './RowArt.tsx';
import { usePlaylists } from './playlists.tsx';
import { CoverWall } from './CoverWall.tsx';
import { notePlaylistPlayed } from './playlistRecency.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { setHeaderActions } from '../nav/headerActions.ts';
import type { Track } from '../core/tauri.ts';

interface PlaylistPageProps {
  id: string;
  /** Receives the opened track and the playlist in its running order. */
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Called when the list this page is showing no longer exists. */
  onGone: () => void;
}


/**
 * One playlist, opened as a page: everything you can do to a list lives here.
 *
 * It stacks inside whichever tab opened it, the way an artist page does, so
 * Back returns to where you came from. The rows are draggable - a playlist is
 * an ORDER, not a set, and the running order is the one thing the modal it
 * replaces could not express - and each row can play, shed itself, or walk to
 * its artist. The name, and the list itself, are editable from the header.
 */
export function PlaylistPage({ id, onPlay, onOpenArtist, onGone }: PlaylistPageProps) {
  const { tracks } = useLibrary();
  const { playlists, rename, remove, removeTrack, reorder, addTrack, setMeta, setCover } =
    usePlaylists();
  const { toast } = useToast();
  const { session } = useServerSession();
  // Pull-to-refresh re-runs the fetch below - see nav/pageRefresh.tsx.
  const refreshNonce = useRefreshNonce();
  // What else belongs here, from the server's own scoring of this list. Null
  // until asked; `ai` false means no model is reading lyrics, and the section
  // stays hidden rather than offer a weaker promise than its heading makes.
  const [suggested, setSuggested] = useState<{ trackIds: number[]; ai: boolean } | null>(null);
  const playlist = playlists.find((p) => p.id === id);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The description being edited, or null when it is only being read. */
  const [describing, setDescribing] = useState<string | null>(null);
  /** The name of a folder being created, or null when no dialog is open. */
  const [newFolder, setNewFolder] = useState<string | null>(null);
  /** True while a chosen cover is travelling to the server. */
  const [coverBusy, setCoverBusy] = useState(false);
  /** What the filter box holds. '' shows the whole list. */
  const [finding, setFinding] = useState('');
  const coverInput = useRef<HTMLInputElement | null>(null);

  const chooseCover = async (file: File) => {
    if (!setCover || !playlistId) return;
    setCoverBusy(true);
    try {
      await setCover(playlistId, file);
    } catch (err) {
      toast({
        message:
          err instanceof Error && err.message
            ? `That cover did not take: ${err.message}`
            : 'That cover did not take.',
      });
    } finally {
      setCoverBusy(false);
    }
  };


  // Deleted from another device while open here: the heartbeat drops it from
  // the list and the page steps back rather than rendering against nothing.
  useEffect(() => {
    if (!playlist) onGone();
  }, [playlist, onGone]);

  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t] as const)), [tracks]);

  // Re-asked whenever the list's contents change: adding a song changes what
  // belongs next, and a stale row offering what you just added reads as broken.
  //
  // Keyed on the id and the member list as STRINGS, never on the playlist
  // object: the store hands back a fresh object every render, so an object
  // dependency re-runs this effect constantly - and its cleanup would abort the
  // request it just made, forever, which is exactly what it did at first.
  const memberKey = playlist?.paths.join(',') ?? '';
  const playlistId = playlist?.id;

  // Decoration rides the playlist object now - the provider decides whether
  // that means the server's row, the device store, or the local object, and
  // this page neither knows nor cares.
  // Every folder that exists, which is every folder anything is filed in:
  // there is no separate list of folders to keep, because a folder IS the
  // playlists that name it.
  const folders = useMemo(
    () => [...new Set(playlists.map((p) => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [playlists],
  );
  useEffect(() => {
    if (!session || !playlistId) return;
    const ctrl = new AbortController();
    void fetchPlaylistSuggestions(session, playlistId, ctrl.signal)
      .then(setSuggested)
      .catch(() => {
        // An older server, one still reading the library, or a cancelled ask.
      });
    return () => ctrl.abort();
  }, [session, playlistId, memberKey, refreshNonce]);

  // Paths resolve against the live library, favourites-style: a row whose file
  // is gone simply does not render, and returns if the file does. The id is the
  // path, which is what makes a row draggable and removable by identity.
  const rows = useMemo(() => {
    if (!playlist) return [];
    return playlist.paths
      .map((path) => {
        const track = byPath.get(path);
        return track ? { id: path, track } : null;
      })
      .filter((r): r is { id: string; track: Track } => r !== null);
  }, [playlist, byPath]);

  // The header's artwork: the list's first distinct covers, sized and deduped
  // by mosaicArts. Four make the quadrant mosaic and load as ONE artwork -
  // the tile keeps its shimmer until every cover has answered - fewer fall
  // back to a single cover with the ordinary single-image reveal. Both hooks
  // sit above the early return, as hooks must.
  const covers = useMemo(() => mosaicArts(rows.map((r) => r.track.artwork)), [rows]);
  const { loaded: coversLoaded, hostRef: coversRef } = useTileArt(covers.length >= 4 ? covers : []);
  // The single-cover img wears no class of its own, so the hook contributes
  // only the pop and the skeleton attribute.
  const singleCover = useArtLoad(covers.length >= 4 ? null : (covers[0] ?? null), '');

  /*
   * The hero scrolls away, and the header picks up what it was carrying - the
   * same arrangement the song collections use.
   *
   * This page used to hold its head still and scroll only its rows, in an inner
   * ScrollArea. That is why it had nothing to hand over: the header never left,
   * so there was never a moment where the name and the buttons were off screen
   * and wanted somewhere to be. The page is the single scroller now, and the
   * sentinel under the hero is what says the hero has gone.
   *
   * Above the early return, like the artwork hooks over it - a playlist that
   * has just been deleted returns null on the very next render, and hooks
   * called below that line would be three fewer than the render before, which
   * React treats as a broken component and tears the whole app down.
   */
  const pageRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const root = pageRef.current;
    const mark = sentinelRef.current;
    if (!root || !mark) return;
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!entry?.isIntersecting),
      { root, threshold: 0 },
    );
    observer.observe(mark);
    return () => observer.disconnect();
    // Re-armed per playlist: opening another one replaces the header the
    // sentinel sits under.
  }, [playlist?.id]);

  /*
   * The handlers, reached through a ref so this publishes on the three things
   * that actually change what the header says or does. They are assigned
   * further down, where the track list they close over exists; the ref starts
   * inert so the hook order never depends on having got that far.
   */
  const handlers = useRef<{ playAll: () => void; shuffleAll: () => void }>({
    playAll: () => {},
    shuffleAll: () => {},
  });
  const lentName = playlist?.name ?? null;
  useEffect(() => {
    if (!stuck || !lentName) return;
    setHeaderActions({
      title: lentName,
      // The first of the covers the hero mosaics - one square is all this size
      // can carry, and it is the same record the tile leads with.
      art: covers[0] ?? null,
      play: () => handlers.current.playAll(),
      shuffle: () => handlers.current.shuffleAll(),
      disabled: rows.length === 0,
    });
    return () => setHeaderActions(null);
  }, [stuck, lentName, rows.length, covers]);

  // Derived above the early return so they can be memos (hooks must be), and
  // memoized because the whole page re-renders once a second while music
  // plays under it - the header clock alone should not re-resolve a
  // suggestion list against the library. Membership is a Set: the old
  // `paths.includes` scan was O(suggested × members) on every render.
  const listTracks = useMemo(() => rows.map((r) => r.track), [rows]);

  /*
   * The rows that match the filter box, or null when it is empty. Null rather
   * than the full list, because the two views are different components - the
   * sortable list only mounts when nothing is being searched for.
   */
  const found = useMemo(() => {
    const q = finding.trim().toLowerCase();
    if (!q) return null;
    return rows.filter(
      (r) =>
        r.track.title.toLowerCase().includes(q) ||
        r.track.artist.toLowerCase().includes(q) ||
        r.track.album.toLowerCase().includes(q),
    );
  }, [rows, finding]);
  const totalSeconds = useMemo(
    () => listTracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
    [listTracks],
  );
  // The suggestions, resolved against the synced library. Shown only where a
  // model is reading lyrics, and only once the list has a character to match.
  const suggestions: Track[] = useMemo(() => {
    const member = new Set(playlist?.paths ?? []);
    return (suggested?.ai ? (suggested?.trackIds ?? []) : [])
      .map((tid) => byPath.get(remotePath(tid)))
      .filter((t): t is Track => t !== undefined)
      .filter((t) => !member.has(t.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- memberKey stands in for the fresh-every-render playlist object
  }, [memberKey, suggested, byPath]);

  if (!playlist) return null;

  const playAll = () => {
    notePlaylistPlayed(id);
    const first = listTracks[0];
    if (first) onPlay(first, listTracks);
  };

  const shuffleAll = () => {
    if (listTracks.length === 0) return;
    notePlaylistPlayed(id);
    // Shuffled here rather than by flipping the player's shuffle switch: this
    // is "play these in a jumbled order", not a change to how the app plays.
    const order = shuffled(listTracks);
    const first = order[0];
    if (first) onPlay(first, order);
  };

  // Not a hook - just handing the published callbacks the current closures.
  handlers.current = { playAll, shuffleAll };

  const commitRename = (event: FormEvent) => {
    event.preventDefault();
    if (renaming === null) return;
    const next = renaming.trim();
    if (next) rename(playlist.id, next);
    setRenaming(null);
  };

  return (
    <div className="homePage libraryPage playlistPage" ref={pageRef}>
      {/* The cover chooser. A file input rather than anything cleverer: the
          OS picker already knows the camera roll, and its change event is the
          user gesture the upload rides on. Value cleared after each pick so
          choosing the same file twice still fires. */}
      <input
        ref={coverInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) void chooseCover(file);
        }}
      />
      <header className="playlistHead">
        <CoverWall artworks={rows.map((r) => r.track.artwork)} />
        <div className="playlistHead__cover" aria-hidden data-busy={coverBusy || undefined}>
          {playlist.coverUrl ? (
            <div className="tileSquircle tileRecent playlistHead__mosaic">
              <img className="playlistHead__chosen" src={playlist.coverUrl} alt="" />
            </div>
          ) : covers.length >= 4 ? (
            <div
              ref={coversRef}
              className="tileSquircle tileLikedGrid playlistHead__mosaic"
              data-tile-pop=""
              data-tile-loading={!coversLoaded || undefined}
            >
              {covers.map((art, i) => (
                <img key={i} src={art} alt="" />
              ))}
            </div>
          ) : (
            <div className="tileSquircle tileRecent playlistHead__mosaic">
              {covers[0] ? (
                <img {...singleCover} src={covers[0]} alt="" />
              ) : (
                <ListMusic size={28} />
              )}
            </div>
          )}
        </div>

        <div className="playlistHead__body">
          <Text tone="muted" size="xs" className="playlistHead__kicker">
            Playlist
          </Text>
          <h2 className="playlistHead__name">{playlist.name}</h2>
          <Text tone="muted" size="sm">
            {rows.length} {rows.length === 1 ? 'song' : 'songs'}
            {totalSeconds > 0 ? ` · ${formatTotal(totalSeconds)}` : ''}
          </Text>

          {/* The description, read in place and edited in place. A field that
              is only reachable through a menu is a field nobody fills in, so
              the empty state is itself the invitation - and it is quiet enough
              that a playlist which does not want one does not look unfinished. */}
          {describing === null ? (
            <button
              type="button"
              className="playlistHead__about"
              data-empty={!playlist.description || undefined}
              onClick={() => setDescribing(playlist.description ?? '')}
            >
              {playlist.description || 'Add a description'}
            </button>
          ) : (
            <form
              className="playlistHead__aboutEdit"
              onSubmit={(e) => {
                e.preventDefault();
                setMeta(playlist.id, { description: describing.trim() });
                setDescribing(null);
              }}
            >
              <textarea
                className="playlistHead__aboutField"
                value={describing}
                onChange={(e) => setDescribing(e.target.value)}
                onBlur={() => {
                  setMeta(playlist.id, { description: describing.trim() });
                  setDescribing(null);
                }}
                onKeyDown={(e) => {
                  // Enter commits, Escape abandons. Shift+Enter is a new line,
                  // because a description is prose and sometimes wants two.
                  if (e.key === 'Escape') setDescribing(null);
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                placeholder="What is this playlist for?"
                aria-label="Playlist description"
                rows={2}
                maxLength={300}
                autoFocus
              />
            </form>
          )}

          <div className="playlistHead__actions">
            <Button variant="solid" size="sm" onClick={playAll} disabled={rows.length === 0}>
              <Play size={15} fill="currentColor" />
              Play
            </Button>
            <Button variant="ghost" size="sm" onClick={shuffleAll} disabled={rows.length === 0}>
              <Shuffle size={15} />
              Shuffle
            </Button>
            <Menu
              aria-label="Playlist actions"
              trigger={
                <IconButton variant="ghost" size="sm" aria-label="Playlist actions">
                  <EllipsisVertical size={16} />
                </IconButton>
              }
            >
              <MenuItem icon={<Pencil size={15} />} onSelect={() => setRenaming(playlist.name)}>
                Rename
              </MenuItem>
              {/* Folders live in the menu rather than behind a dialog: there
                  are only ever a handful, and a list of five is faster to
                  choose from than a picker that has to be opened first. The
                  one you are already in is marked rather than hidden, so the
                  menu says where this playlist currently files. */}
              {folders.map((name) => (
                <MenuItem
                  key={name}
                  icon={playlist.folder === name ? <Check size={15} /> : <FolderClosed size={15} />}
                  onSelect={() =>
                    setMeta(playlist.id, { folder: playlist.folder === name ? '' : name })
                  }
                >
                  {name}
                </MenuItem>
              ))}
              {playlist.folder && (
                <MenuItem icon={<FolderOpen size={15} />} onSelect={() => setMeta(playlist.id, { folder: '' })}>
                  Take out of {playlist.folder}
                </MenuItem>
              )}
              <MenuItem icon={<FolderPlus size={15} />} onSelect={() => setNewFolder('')}>
                New folder…
              </MenuItem>
              {/* Only where a cover can actually be kept - the provider leaves
                  setCover out for a local library and an old server, and a
                  menu item that cannot work is worse than none. */}
              {setCover && (
                <MenuItem icon={<ImageIcon size={15} />} onSelect={() => coverInput.current?.click()}>
                  {playlist.coverUrl ? 'Change cover…' : 'Choose cover…'}
                </MenuItem>
              )}
              {setCover && playlist.coverUrl && (
                <MenuItem icon={<X size={15} />} onSelect={() => void setCover(playlist.id, null)}>
                  Remove cover
                </MenuItem>
              )}
              <MenuItem icon={<Trash2 size={15} />} onSelect={() => setConfirmDelete(true)}>
                Delete playlist
              </MenuItem>
            </Menu>
          </div>
        </div>
      </header>
      {/* Sits just under the hero: once this leaves the top of the page, the
          hero has gone with it. */}
      <div ref={sentinelRef} className="songPageHead__sentinel" aria-hidden />

      {rows.length === 0 ? (
        <div className="playlistEmpty emptyState emptyState--tall">
          <EmptyArt name="playlist" />
          <Text tone="muted">
            Nothing here yet. Right-click a song in the library — long-press on a phone — and
            choose “Add to playlist”. The song that is playing can be filed from the player too.
          </Text>
        </div>
      ) : (
        <div className="playlistPageScroll">
          {/* Finding one song in four hundred. Only where it could ever be
              needed: a list short enough to see whole has nothing to find. */}
          {rows.length > 15 && (
            <SearchField
              className="playlistFind"
              value={finding}
              onValueChange={setFinding}
              placeholder="Find in this playlist"
              aria-label="Find in this playlist"
            />
          )}
          {found !== null ? (
            /*
             * A plain list while filtering, not the sortable one. Dragging row
             * four of a FILTERED view would have to mean something about the
             * full order, and every answer to what is a surprise - so the
             * handles go away with the rows they would have moved.
             */
            <div className="playlistRows playlistRows--found">
              {found.length === 0 ? (
                <Text tone="muted" size="sm" className="playlistFind__none">
                  Nothing here matches “{finding.trim()}”.
                </Text>
              ) : (
                found.map((row) => (
                  <TrackMenu key={row.id} track={row.track} className="playlistRowMenu">
                    <div className="playlistRow">
                      <button
                        type="button"
                        className="playlistRow__main"
                        onClick={() => onPlay(row.track, listTracks)}
                      >
                        <RowArt artwork={row.track.artwork} />
                        <span className="playlistRow__text">
                          <span className="songTitle">{row.track.title}</span>
                          <span className="songArtist">{row.track.artist}</span>
                        </span>
                      </button>
                    </div>
                  </TrackMenu>
                ))
              )}
            </div>
          ) : (
          <SortableList
            className="playlistRows"
            items={rows}
            getLabel={(row) => row.track.title}
            onReorder={(next) => reorder(playlist.id, next.map((r) => r.id))}
            renderItem={(row) => (
              /* Every song wears the same menu wherever it is drawn: queue it,
                 file it, keep it on this device. A song is the same song in a
                 playlist as it is on a shelf. */
              <TrackMenu track={row.track} className="playlistRowMenu">
              <div className="playlistRow">
                <button
                  type="button"
                  className="playlistRow__main"
                  onClick={() => onPlay(row.track, listTracks)}
                >
                  <RowArt artwork={row.track.artwork} />
                  <span className="playlistRow__text">
                    <span className="songTitle">{row.track.title}</span>
                    <span className="songArtist">{row.track.artist}</span>
                  </span>
                </button>
                {/* Siblings of the row button, not nested inside it: a button
                    within a button is not a thing the browser will honour. */}
                <button
                  type="button"
                  className="songArtist songArtistLink playlistRow__artist"
                  onClick={() => onOpenArtist(row.track.artist)}
                >
                  {row.track.artist}
                </button>
                <span className="songMuted playlistRow__time">
                  {formatClock(row.track.duration, '--:--')}
                </span>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${row.track.title}`}
                  onClick={() => {
                    // The whole order, captured before the cut: undo restores
                    // through reorder, so the song lands back in ITS seat
                    // rather than at the end like a re-add would put it.
                    const before = [...playlist.paths];
                    removeTrack(playlist.id, row.id);
                    toast({
                      message: `Removed “${row.track.title}” from ${playlist.name}`,
                      action: { label: 'Undo', onPress: () => reorder(playlist.id, before) },
                    });
                  }}
                >
                  <X size={15} />
                </IconButton>
              </div>
              </TrackMenu>
            )}
          />
          )}

        {suggestions.length > 0 && (
          <section className="playlistSuggest">
            <h3 className="playlistSuggest__title">Suggested for this playlist</h3>
            <Text tone="muted" size="sm" className="playlistSuggest__blurb">
              From your library, matched to what is already here.
            </Text>
            <ul className="playlistSuggest__list">
              {suggestions.map((t) => (
                <li key={t.path} className="playlistRow playlistSuggest__row">
                  <button
                    type="button"
                    className="playlistRow__main"
                    onClick={() => onPlay(t, [t, ...listTracks])}
                  >
                    <RowArt artwork={t.artwork} />
                    <span className="playlistRow__text">
                      <span className="songTitle">{t.title}</span>
                      <span className="songArtist">{t.artist}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="songArtist songArtistLink playlistRow__artist"
                    onClick={() => onOpenArtist(t.artist)}
                  >
                    {t.artist}
                  </button>
                  <span className="songMuted playlistRow__time">{formatClock(t.duration, '--:--')}</span>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={`Add ${t.title} to this playlist`}
                    onClick={() => addTrack(playlist.id, t.path)}
                  >
                    <Plus size={15} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </section>
        )}
        </div>
      )}

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename playlist"
        size="sm"
      >
        <form className="playlistCreate" onSubmit={commitRename}>
          <Input
            autoFocus
            value={renaming ?? ''}
            onChange={(e) => setRenaming(e.currentTarget.value)}
            aria-label="Playlist name"
          />
          <Button type="submit" variant="solid">
            Save
          </Button>
        </form>
      </Modal>

      <Modal
        open={newFolder !== null}
        onClose={() => setNewFolder(null)}
        title="New folder"
        size="sm"
      >
        <form
          className="playlistCreate"
          onSubmit={(e) => {
            e.preventDefault();
            const name = (newFolder ?? '').trim();
            // A folder is only a label on the playlists in it, so an empty one
            // would have nowhere to exist - naming it and filing this playlist
            // are the same act.
            if (name) setMeta(playlist.id, { folder: name });
            setNewFolder(null);
          }}
        >
          <Input
            autoFocus
            value={newFolder ?? ''}
            onChange={(e) => setNewFolder(e.currentTarget.value)}
            placeholder="Road trips"
            aria-label="Folder name"
          />
          <Button type="submit" variant="solid">
            Move here
          </Button>
        </form>
      </Modal>

      {/* Deleting a list is the one action here with nothing behind it, so it
          asks. Everything else - a removed row, a reorder - is visibly undoable
          by hand. */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete "${playlist.name}"?`}
        size="sm"
      >
        <div className="playlistConfirm">
          <Text tone="muted" size="sm">
            The songs stay in your library. The list itself is gone
            {rows.length > 0 ? `, along with its ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}` : ''}.
          </Text>
          <div className="playlistConfirm__actions">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="solid"
              onClick={() => {
                setConfirmDelete(false);
                remove(playlist.id);
                onGone();
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
