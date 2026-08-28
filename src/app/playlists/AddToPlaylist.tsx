import { Button, Input, Modal, ScrollArea, Text, useToast } from '@glacier/react';
import { fireNativeHaptic } from '../core/haptics.ts';
import { Check, ListMusic, Plus, Search } from '@glacier/icons';
import { useMemo, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { MosaicCover } from './PlaylistShowcase.tsx';
import { usePlaylists } from './playlists.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * "Add to playlist", the way a music app is expected to do it: one panel that
 * filters your lists, makes a new one, and toggles the song in and out of the
 * ones you have - each row saying plainly whether the song is already in it.
 *
 * The panel is the component; the shell around it is the caller's choice.
 * Today that shell is a dialog (AddToPlaylistDialog), for callers with
 * nothing to anchor a popover to - a context menu, a long-press.
 */

function AddToPlaylistPanel({ list, onDone }: { list: Track[]; onDone: () => void }) {
  const { toast } = useToast();
  // One song is still the common case; the plural paths only change the words
  // and the row semantics ("in this list" means ALL of them are).
  const track = list[0]!;
  const paths = list.map((t) => t.path);
  const { playlists, create, addTrack, removeTrack } = usePlaylists();
  const { tracks } = useLibrary();
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

  const createWithTrack = () => {
    if (draft === null || busy) return;
    setBusy(true);
    // Named after the song when the field is left empty: a list called "New
    // Playlist" tells you nothing, and this is the one name we can infer.
    const name = draft.trim() || track.title;
    create(name, paths)
      .then(onDone)
      .catch(() => setBusy(false));
  };

  return (
    <div className="addPlaylist">
      <div className="addPlaylist__head">
        <Text size="sm" className="addPlaylist__song">
          Add{' '}
          <strong>
            {list.length === 1 ? track.title : `${list.length} songs`}
          </strong>{' '}
          to
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
            placeholder={track.title}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            aria-label="New playlist name"
          />
          <Button type="submit" variant="solid" size="sm" disabled={busy}>
            Create
          </Button>
        </form>
      )}

      <ScrollArea className="addPlaylist__scroll">
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
              const has = paths.every((p) => playlist.paths.includes(p));
              const count = playlist.paths.filter((p) => known.has(p)).length;
              const covers = playlist.paths
                .map((p) => byPath.get(p))
                .filter((t): t is Track => t !== undefined);
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
      </ScrollArea>
    </div>
  );
}

/**
 * The same panel as a dialog, for the callers with nothing to anchor to - a
 * context menu item, a long-press. Rendered only while open so the panel's
 * draft state starts fresh each time it is asked for.
 */
export function AddToPlaylistDialog({
  track,
  tracks,
  open,
  onClose,
}: {
  track?: Track | null;
  /** Several at once - the multi-select path. Takes precedence over `track`. */
  tracks?: Track[] | null;
  open: boolean;
  onClose: () => void;
}) {
  const list = tracks && tracks.length > 0 ? tracks : track ? [track] : [];
  if (list.length === 0) return null;
  return (
    <Modal open={open} onClose={onClose} title="Add to playlist" size="sm">
      <AddToPlaylistPanel list={list} onDone={onClose} />
    </Modal>
  );
}
