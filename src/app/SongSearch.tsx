import { CommandPalette } from '@glacier/react';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { usePluginCommands } from '../plugins/runtime.tsx';
import { flatten, matches } from './trackSearch.ts';
import { isDesktopApp } from './platform.ts';
import { MobileSearch } from './MobileSearch.tsx';
import type { Track } from './tauri.ts';

interface SongSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the chosen track and the hit list it was chosen from. */
  onPlay: (track: Track, queue: Track[]) => void;
}

/**
 * The ⌘K search over the library. The palette shows title and artist; album,
 * genre, and lyrics ride along as keywords so the row highlights what matched.
 * The filtering is the app's own (see `matches`) rather than the palette's
 * default per-word substring, which over full lyrics matches nearly everything.
 *
 * Plugins see the raw query and may add commands - or claim the query outright
 * (a pasted import link is an action, not a search). Command ids come back
 * namespaced by the runtime, so they can never shadow a track path.
 */
export function SongSearch({ open, onOpenChange, onPlay }: SongSearchProps) {
  const { tracks } = useLibrary();
  const [query, setQuery] = useState('');

  // A fresh open starts empty rather than on the last search.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const plugin = usePluginCommands({ query, close: () => onOpenChange(false) });

  // Both readings of the results: rows for the palette, tracks for the play
  // queue - one filter pass so they cannot disagree.
  const { songs, hits } = useMemo(() => {
    const phrase = flatten(query);
    const words = phrase.split(' ').filter(Boolean);
    const found = words.length === 0 ? tracks : tracks.filter((t) => matches(t, phrase, words));
    return {
      hits: found,
      songs: found.map((track) => ({
        id: track.path,
        label: track.artist ? `${track.title} · ${track.artist}` : track.title,
        group: 'Songs',
        keywords: [track.artist, track.album, track.genre, track.lyrics].filter(Boolean).join(' '),
      })),
    };
  }, [tracks, query]);

  // An exclusive claim shows only the claiming plugins' commands - the song
  // rows stand aside. Otherwise plugin commands trail the songs, in
  // registration order.
  const commands = plugin.exclusive ? plugin.commands : [...songs, ...plugin.commands];

  // One set of state, two shells: a full-screen sheet on the phone, the centered
  // command palette on the desktop. An exclusive claim (a pasted link) drops the
  // song rows on both.
  if (!isDesktopApp) {
    return (
      <MobileSearch
        open={open}
        onClose={() => onOpenChange(false)}
        query={query}
        onQueryChange={setQuery}
        tracks={plugin.exclusive ? [] : hits}
        commands={plugin.commands}
        onRunCommand={(id) => plugin.run(id)}
        onPlayTrack={(track) => {
          onPlay(track, hits);
          onOpenChange(false);
        }}
      />
    );
  }

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      commands={commands}
      query={query}
      onQueryChange={setQuery}
      onRun={(id) => {
        if (plugin.run(id)) return;
        const track = tracks.find((t) => t.path === id);
        // The hit list rides along as the queue, so a search plays on through
        // what it found rather than stopping at the one row chosen.
        if (track) onPlay(track, hits);
      }}
      placeholder="Search songs, artists, albums, lyrics"
      emptyLabel="No songs match"
    />
  );
}
