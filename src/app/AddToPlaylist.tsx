import { Button, Input, Modal, Popover, ScrollArea, Text } from '@glacier/react';
import { Check, ListMusic, Plus, Search } from '@glacier/icons';
import { useMemo, useState, type ReactElement } from 'react';
import { useLibrary } from './library.tsx';
import { usePlaylists } from './playlists.tsx';
import type { Track } from './tauri.ts';

/**
 * "Add to playlist", the way a music app is expected to do it: one panel that
 * filters your lists, makes a new one, and toggles the song in and out of the
 * ones you have - each row saying plainly whether the song is already in it.
 *
 * The panel is the component; the shell around it is the caller's choice. A
 * control with a place on screen wears it as a popover
 * (AddToPlaylistButton); a context menu, which has no anchor to hang one
 * off, opens the dialog instead (AddToPlaylistDialog). Both render the same
 * body, so the interaction is one thing wherever it is reached from.
 */

function AddToPlaylistPanel({ track, onDone }: { track: Track; onDone: () => void }) {
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

  const createWithTrack = () => {
    if (draft === null || busy) return;
    setBusy(true);
    // Named after the song when the field is left empty: a list called "New
    // Playlist" tells you nothing, and this is the one name we can infer.
    const name = draft.trim() || track.title;
    create(name, [track.path])
      .then(onDone)
      .catch(() => setBusy(false));
  };

  return (
    <div className="addPlaylist">
      <div className="addPlaylist__head">
        <Text size="sm" className="addPlaylist__song">
          Add <strong>{track.title}</strong> to
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
              const has = playlist.paths.includes(track.path);
              const count = playlist.paths.filter((p) => known.has(p)).length;
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
                    if (has) removeTrack(playlist.id, track.path);
                    else addTrack(playlist.id, track.path);
                  }}
                >
                  <span className="addPlaylistRow__icon">
                    <ListMusic size={15} />
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

/** The panel hung off a control of the caller's choosing. */
export function AddToPlaylistButton({ track, trigger }: { track: Track; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      placement="top-end"
      aria-label="Add to playlist"
      className="addPlaylistPanel"
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
    >
      <AddToPlaylistPanel track={track} onDone={() => setOpen(false)} />
    </Popover>
  );
}

/**
 * The same panel as a dialog, for the callers with nothing to anchor to - a
 * context menu item, a long-press. Rendered only while open so the panel's
 * draft state starts fresh each time it is asked for.
 */
export function AddToPlaylistDialog({
  track,
  open,
  onClose,
}: {
  track: Track | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!track) return null;
  return (
    <Modal open={open} onClose={onClose} title="Add to playlist" size="sm">
      <AddToPlaylistPanel track={track} onDone={onClose} />
    </Modal>
  );
}
