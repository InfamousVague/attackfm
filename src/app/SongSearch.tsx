import { CommandPalette } from '@glacier/react';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { usePluginCommands } from '../plugins/runtime.tsx';
import type { Track } from './tauri.ts';

interface SongSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the chosen track and the hit list it was chosen from. */
  onPlay: (track: Track, queue: Track[]) => void;
}

// Fold to lowercase words separated by single spaces, dropping punctuation, so a
// typed phrase matches a lyric across the commas and line breaks it really has.
const flatten = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether a track answers the query. Metadata (title, artist, album, genre) is
 * word-ANDed - every typed word must appear somewhere in it - while lyrics are
 * matched as a contiguous phrase. Splitting them is the point: a lyric is long
 * prose where the short words of any query turn up scattered everywhere, so only
 * the phrase typed verbatim should count there.
 */
function matches(track: Track, phrase: string, words: string[]): boolean {
  const meta = flatten(`${track.title} ${track.artist} ${track.album} ${track.genre}`);
  if (words.every((w) => meta.includes(w))) return true;
  return track.lyrics.length > 0 && flatten(track.lyrics).includes(phrase);
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
