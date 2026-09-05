import { createContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCheck, Heart, ListEnd, ListPlus, ListStart, X } from '@glacier/icons';
import { Button, IconButton, Text, useToast } from '@glacier/react';
import type { Track } from '../core/tauri.ts';
import { useLibrary } from './library.tsx';
import { useQueueControls } from '../player/queueControls.tsx';
import { AddToPlaylistDialog } from '../playlists/AddToPlaylist.tsx';

/**
 * Selecting more than one song.
 *
 * Every action in the app used to be per-track: "add these nine to that
 * playlist" was nine separate journeys through nine menus. This is the
 * selection model - a mode a table enters, checkboxes the kit's DataGrid
 * already knew how to draw, and one floating bar carrying the verbs that
 * make sense in bulk.
 *
 * The context is how a row's menu offers the way IN without every surface
 * threading a prop to it: a table that supports selection provides `start`,
 * and TrackMenu shows its "Select" item only where the context exists.
 */

export const SongSelectionContext = createContext<{
  /** Enter selection mode with this song already selected. */
  start: (path: string) => void;
} | null>(null);

/**
 * The verbs, over whatever is selected.
 *
 * Liking is a SET, not a toggle: `toggleFavorite` on an already-liked song
 * would un-like it, and "like these nine" must never subtract (the
 * importable() lesson, in miniature). Play next walks the list in reverse so
 * the songs land in the order they were selected, not inverted.
 *
 * "Keep on device" is deliberately NOT here: the single-track keep in
 * TrackMenu carries corruption guards (the stale-fragment Range trap, per-
 * quality extensions, minBytes) that would have to be duplicated exactly,
 * and a bulk copy that drifts from them corrupts pinned files forever. Bulk
 * keep belongs to a shared keepTrack() extraction first.
 */
export function SelectionBar({
  tracks,
  selected,
  onClear,
  onSelectAll,
}: {
  /** Every track the hosting surface shows, in display order. */
  tracks: Track[];
  selected: string[];
  onClear: () => void;
  onSelectAll: () => void;
}) {
  const { isFavorite, toggleFavorite } = useLibrary();
  const { playNext, addToQueue, following } = useQueueControls();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);

  const chosen = tracks.filter((t) => selected.includes(t.path));
  if (selected.length === 0) return null;

  const likeAll = () => {
    let added = 0;
    for (const t of chosen) {
      if (!isFavorite(t.path)) {
        toggleFavorite(t.path);
        added += 1;
      }
    }
    toast({
      message:
        added === 0
          ? 'Already all in Liked'
          : `Added ${added} ${added === 1 ? 'song' : 'songs'} to Liked`,
    });
    onClear();
  };

  const queueAll = (next: boolean) => {
    if (next) {
      // Reversed, so the first selected song plays first.
      for (const t of [...chosen].reverse()) playNext(t);
    } else {
      for (const t of chosen) addToQueue(t);
    }
    toast({
      message: `${chosen.length} ${chosen.length === 1 ? 'song' : 'songs'} ${
        following ? 'sent to the groove' : next ? 'playing next' : 'added to the queue'
      }`,
    });
    onClear();
  };

  return createPortal(
    <div className="selectBar" role="toolbar" aria-label="Selected songs">
      <span className="selectBar__count">
        <Check size={15} aria-hidden />
        <Text size="sm" weight="semibold">
          {selected.length}
        </Text>
      </span>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Select all"
        onClick={onSelectAll}
        disabled={selected.length === tracks.length}
      >
        <CheckCheck size={16} />
      </IconButton>
      <span className="selectBar__spring" />
      <IconButton variant="ghost" size="sm" aria-label="Play next" onClick={() => queueAll(true)}>
        <ListStart size={16} />
      </IconButton>
      <IconButton variant="ghost" size="sm" aria-label="Add to queue" onClick={() => queueAll(false)}>
        <ListEnd size={16} />
      </IconButton>
      <IconButton variant="ghost" size="sm" aria-label="Add to Liked" onClick={likeAll}>
        <Heart size={16} />
      </IconButton>
      <Button variant="soft" size="sm" onClick={() => setAdding(true)}>
        <ListPlus size={15} /> Playlist
      </Button>
      <IconButton variant="ghost" size="sm" aria-label="Done selecting" onClick={onClear}>
        <X size={16} />
      </IconButton>

      <AddToPlaylistDialog
        tracks={chosen}
        open={adding}
        onClose={() => {
          setAdding(false);
          onClear();
        }}
      />
    </div>,
    document.body,
  );
}
