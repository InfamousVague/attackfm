import { Button, Drawer, Input, Text, useToast } from '@glacier/react';
import { fireNativeHaptic } from '../core/haptics.ts';
import { Check, ListMusic, Plus, Search } from '@glacier/icons';
import { useMemo, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { fold, titleKey } from '../library/owned.ts';
import { MosaicCover } from './PlaylistShowcase.tsx';
import { usePlaylists } from './playlists.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * "Add to playlist", the way a music app is expected to do it: one panel that
 * filters your lists, makes a new one, and toggles the song in and out of the
 * ones you have - each row saying plainly whether the song is already in it.
 *
 * It files two kinds of song into a list with the same gesture: ones you OWN
 * (by path, `list`), and ones you do NOT own yet (`want` - a catalogue song
 * you plan to acquire). A want is recorded as the list's arriving member and
 * its download is started; it becomes an ordinary row when it lands. The row
 * semantics fold both in: "in this list" is true when the owned songs are all
 * present, or when the want is already filed here.
 *
 * The panel is the component; the shell around it is the caller's choice.
 * Today that shell is a bottom sheet (AddToPlaylistDialog) - by request,
 * the card treatment the search drawer wears, in place of the floating
 * modal whose inner scroll region kept eating the drag on touch.
 */

/** A not-owned song being filed into a list to acquire. */
export interface PlaylistWantTarget {
  artist: string;
  title: string;
  /** The catalogue link, when the surface has one - handed to the importer so
   *  the download starts without a second name search. */
  url?: string;
}

function AddToPlaylistPanel({
  list,
  want,
  onDone,
}: {
  /** Owned songs to file, by path. Empty in the not-owned (`want`) mode. */
  list: Track[];
  /** A not-owned song to file instead. Mutually exclusive with a non-empty
   *  `list`; when set, the panel writes wants rather than track ids. */
  want?: PlaylistWantTarget | null;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const { playlists, create, addTrack, removeTrack, addWant, removeWant } = usePlaylists();
  const { tracks } = useLibrary();
  // One owned song is still the common case; the plural paths only change the
  // words and the row semantics ("in this list" means ALL of them are).
  const track = list[0] ?? null;
  const paths = list.map((t) => t.path);
  // The folded key the server files a want under - byte-equal to its key_of,
  // so the ghost this writes and the row it later becomes share one identity.
  const wantKey = want ? `${fold(want.artist)}|${titleKey(want.title)}` : null;
  const songName = want ? want.title : (track?.title ?? '');
  const [query, setQuery] = useState('');
  // Set while a new list is being named. Empty string is a live, empty field -
  // distinct from null, which is "not naming one".
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? playlists.filter((p) => p.name.toLowerCase().includes(q)) : playlists;
  }, [playlists, query]);

  // Only the songs the library still resolves count toward a list's length, so
  // the number here matches what opening the playlist actually shows.
  const known = useMemo(() => new Set(tracks.map((t) => t.path)), [tracks]);
  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t])), [tracks]);

  // Whether the target song(s) are already in a given list.
  const isIn = (playlist: (typeof playlists)[number]) =>
    wantKey
      ? (playlist.wants ?? []).some((w) => w.k === wantKey)
      : paths.length > 0 && paths.every((p) => playlist.paths.includes(p));

  const createWithTrack = () => {
    if (draft === null || busy) return;
    setBusy(true);
    // Named after the song when the field is left empty: a list called "New
    // Playlist" tells you nothing, and this is the one name we can infer.
    const name = draft.trim() || songName || 'New Playlist';
    // A not-owned song is born into a fresh, empty list as a want; an owned one
    // rides create()'s paths argument straight in.
    const born = want && addWant ? create(name).then((id) => addWant(id, want)) : create(name, paths);
    born.then(onDone).catch(() => setBusy(false));
  };

  return (
    <div className="addPlaylist">
      <div className="addPlaylist__head">
        <Text size="sm" className="addPlaylist__song">
          Add{' '}
          <strong>{want || list.length === 1 ? songName : `${list.length} songs`}</strong> to
        </Text>
      </div>

      {playlists.length > 3 && (
        <div className="addPlaylist__search">
          <Search size={14} />
          <Input
            size="sm"
            placeholder="Find a playlist"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            aria-label="Find a playlist"
          />
        </div>
      )}

      {draft === null ? (
        <button type="button" className="addPlaylist__new" onClick={() => setDraft('')}>
          <span className="addPlaylist__newIcon">
            <Plus size={16} />
          </span>
          New playlist
        </button>
      ) : (
        <form
          className="addPlaylist__draft"
          onSubmit={(e) => {
            e.preventDefault();
            createWithTrack();
          }}
        >
          <Input
            autoFocus
            size="sm"
            placeholder={songName}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            aria-label="New playlist name"
          />
          <Button type="submit" variant="solid" size="sm" disabled={busy}>
            Create
          </Button>
        </form>
      )}

      {/* One scroller, the sheet's own: the old nested ScrollArea inside a
          modal capped itself at 16rem and swallowed touch drags (the
          cross-axis-contain trap) - the list now runs free and the Drawer
          body scrolls it. */}
      <div className="addPlaylist__list">
          {filtered.length === 0 ? (
            <Text tone="muted" size="sm" className="addPlaylist__empty">
              {playlists.length === 0 ? 'No playlists yet.' : 'No playlist by that name.'}
            </Text>
          ) : (
            filtered.map((playlist) => {
              // "In this list" means every selected song is - a half-in state
              // acts as add-the-rest, which is what a person filing nine songs
              // actually wants when two were already there.
              const has = isIn(playlist);
              const count = playlist.paths.filter((p) => known.has(p)).length;
              const covers = playlist.paths
                .map((p) => byPath.get(p))
                .filter((t): t is Track => t !== undefined);
              // A not-owned list may be all-ghosts (no owned covers yet); show
              // its arriving count so a fresh "to acquire" list is not blank.
              const waiting = playlist.wants?.length ?? 0;
              return (
                <button
                  key={playlist.id}
                  type="button"
                  className="addPlaylistRow"
                  data-in={has || undefined}
                  // Aria-pressed, not a checkbox: the row is a toggle whose
                  // pressed state IS "the song is in this list".
                  aria-pressed={has}
                  onClick={() => {
                    /*
                     * One tap adds, a second tap on the same row REMOVES - and
                     * the only thing separating the two outcomes was a check
                     * mark. It follows the rule toggleFavoriteFelt already set
                     * for the heart: the motor celebrates the way IN, and the
                     * way out gets words and a way back instead. Fired once
                     * per tap, outside the loop, so a multi-select add is one
                     * event and not one per song.
                     */
                    if (want && wantKey) {
                      // Not-owned: toggle the want. Nothing to undo on the way
                      // in beyond the same tap again, so it keeps the words on
                      // the way out like the owned path does.
                      if (has) {
                        removeWant?.(playlist.id, wantKey);
                        toast({ message: `Removed from “${playlist.name}”` });
                      } else {
                        void addWant?.(playlist.id, want);
                        fireNativeHaptic('success');
                        toast({ message: `Added to “${playlist.name}” — downloading` });
                      }
                      onDone();
                      return;
                    }
                    if (has) {
                      for (const p of paths) removeTrack(playlist.id, p);
                      toast({
                        message: `Removed from “${playlist.name}”`,
                        action: {
                          label: 'Undo',
                          onPress: () => {
                            for (const p of paths) addTrack(playlist.id, p);
                          },
                        },
                      });
                    } else {
                      for (const p of paths) {
                        if (!playlist.paths.includes(p)) addTrack(playlist.id, p);
                      }
                      fireNativeHaptic('success');
                    }
                  }}
                >
                  {/* The playlist's own face - the same four-cover mosaic
                      its Library tile wears - instead of a generic glyph. */}
                  <span className="addPlaylistRow__icon addPlaylistRow__icon--art">
                    <MosaicCover tracks={covers} fallback={<ListMusic size={15} />} tone="tileRecent" />
                  </span>
                  <span className="addPlaylistRow__body">
                    <span className="addPlaylistRow__name">{playlist.name}</span>
                    <span className="addPlaylistRow__meta">
                      {count} {count === 1 ? 'song' : 'songs'}
                      {waiting > 0 ? ` · ${waiting} arriving` : ''}
                    </span>
                  </span>
                  {has && (
                    <span className="addPlaylistRow__check" aria-hidden>
                      <Check size={16} />
                    </span>
                  )}
                </button>
              );
            })
          )}
      </div>
    </div>
  );
}

/**
 * The same panel as a bottom sheet, for the callers with nothing to anchor
 * to - a context menu item, a long-press. Rendered only while open so the
 * panel's draft state starts fresh each time it is asked for.
 *
 * Give it owned songs (`track`/`tracks`) OR a not-owned `want`; the want path
 * is how a song you do not have yet is filed into a list to acquire.
 */
export function AddToPlaylistDialog({
  track,
  tracks,
  want,
  open,
  onClose,
}: {
  track?: Track | null;
  /** Several at once - the multi-select path. Takes precedence over `track`. */
  tracks?: Track[] | null;
  /** A not-owned song to file. Takes precedence over the owned inputs. */
  want?: PlaylistWantTarget | null;
  open: boolean;
  onClose: () => void;
}) {
  const list = tracks && tracks.length > 0 ? tracks : track ? [track] : [];
  if (!want && list.length === 0) return null;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="bottom"
      size="lg"
      title="Add to playlist"
      className="addPlaylistSheet"
    >
      <AddToPlaylistPanel list={want ? [] : list} want={want ?? null} onDone={onClose} />
    </Drawer>
  );
}
