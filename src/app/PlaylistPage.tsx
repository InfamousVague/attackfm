import {
  Button,
  IconButton,
  Input,
  Menu,
  MenuItem,
  Modal,
  ScrollArea,
  SortableList,
  Text,
} from '@glacier/react';
import {
  EllipsisVertical,
  ListMusic,
  Pencil,
  Play,
  Shuffle,
  Plus,
  Trash2,
  X,
} from '@glacier/icons';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { mosaicArts, useArtLoad, useTileArt } from './artLoad.ts';
import { artSized, fetchPlaylistSuggestions, remotePath } from './server.ts';
import { usePlaylists } from './playlists.tsx';
import { EmptyArt } from './EmptyArt.tsx';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

interface PlaylistPageProps {
  id: string;
  /** Receives the opened track and the playlist in its running order. */
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Called when the list this page is showing no longer exists. */
  onGone: () => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/** The running time of the whole list, in the units it deserves. */
function formatTotal(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} hr ${mins % 60} min`;
}

/** One row's cover thumb: skeleton while the bytes come, pop on arrival. A
 *  component of its own so the hook lives outside the render callbacks that
 *  draw the rows. */
function RowArt({ artwork }: { artwork: string | null }) {
  const src = artSized(artwork, 160) ?? placeholderArt;
  const art = useArtLoad(src, 'songArt');
  return <img {...art} src={src} alt="" loading="lazy" />;
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
  const { playlists, rename, remove, removeTrack, reorder, addTrack } = usePlaylists();
  const { session } = useServerSession();
  // What else belongs here, from the server's own scoring of this list. Null
  // until asked; `ai` false means no model is reading lyrics, and the section
  // stays hidden rather than offer a weaker promise than its heading makes.
  const [suggested, setSuggested] = useState<{ trackIds: number[]; ai: boolean } | null>(null);
  const playlist = playlists.find((p) => p.id === id);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
  useEffect(() => {
    if (!session || !playlistId) return;
    const ctrl = new AbortController();
    void fetchPlaylistSuggestions(session, playlistId, ctrl.signal)
      .then(setSuggested)
      .catch(() => {
        // An older server, one still reading the library, or a cancelled ask.
      });
    return () => ctrl.abort();
  }, [session, playlistId, memberKey]);

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
  const coversLoaded = useTileArt(covers.length >= 4 ? covers : []);
  // The single-cover img wears no class of its own, so the hook contributes
  // only the pop and the skeleton attribute.
  const singleCover = useArtLoad(covers.length >= 4 ? null : (covers[0] ?? null), '');

  if (!playlist) return null;

  const listTracks = rows.map((r) => r.track);
  const totalSeconds = listTracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);

  // The suggestions, resolved against the synced library. Shown only where a
  // model is reading lyrics, and only once the list has a character to match.
  const suggestions: Track[] = (suggested?.ai ? (suggested?.trackIds ?? []) : [])
    .map((tid) => byPath.get(remotePath(tid)))
    .filter((t): t is Track => t !== undefined)
    .filter((t) => !playlist.paths.includes(t.path));

  const playAll = () => {
    const first = listTracks[0];
    if (first) onPlay(first, listTracks);
  };

  const shuffleAll = () => {
    if (listTracks.length === 0) return;
    // Shuffled here rather than by flipping the player's shuffle switch: this
    // is "play these in a jumbled order", not a change to how the app plays.
    const shuffled = [...listTracks];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = shuffled[i];
      const b = shuffled[j];
      if (a && b) {
        shuffled[i] = b;
        shuffled[j] = a;
      }
    }
    const first = shuffled[0];
    if (first) onPlay(first, shuffled);
  };

  const commitRename = (event: FormEvent) => {
    event.preventDefault();
    if (renaming === null) return;
    const next = renaming.trim();
    if (next) rename(playlist.id, next);
    setRenaming(null);
  };

  return (
    <>
      <header className="playlistHead">
        <div className="playlistHead__cover" aria-hidden>
          {covers.length >= 4 ? (
            <div
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
              <MenuItem icon={<Trash2 size={15} />} onSelect={() => setConfirmDelete(true)}>
                Delete playlist
              </MenuItem>
            </Menu>
          </div>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="playlistEmpty emptyState emptyState--tall">
          <EmptyArt name="playlist" />
          <Text tone="muted">
            Nothing here yet. Right-click a song in the library — long-press on a phone — and
            choose “Add to playlist”. The song that is playing can be filed from the player too.
          </Text>
        </div>
      ) : (
        <ScrollArea className="playlistPageScroll">
          {/* Controlled: the list proposes an order, the store commits it - and
              on a server playlist that write is what every other device sees. */}
          <SortableList
            className="playlistRows"
            items={rows}
            getLabel={(row) => row.track.title}
            onReorder={(next) => reorder(playlist.id, next.map((r) => r.id))}
            renderItem={(row) => (
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
                  {formatDuration(row.track.duration)}
                </span>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${row.track.title}`}
                  onClick={() => removeTrack(playlist.id, row.id)}
                >
                  <X size={15} />
                </IconButton>
              </div>
            )}
          />

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
                  <span className="songMuted playlistRow__time">{formatDuration(t.duration)}</span>
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
        </ScrollArea>
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
    </>
  );
}
