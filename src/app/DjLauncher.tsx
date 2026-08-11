//! The DJ, on the client: one button, no brief. The server hands back a
//! continuous set drawn from what the listener actually plays, with a spoken
//! line opening each run; this turns that into playback - the whole set becomes
//! the queue, and the opening line is shown while it spins.
//!
//! There was a vibe field here. It asked the listener to have an idea before
//! they could hear anything, which is the opposite of what a DJ button is for:
//! the point is to press it and be played to. The server's own taste model is a
//! better answer than most people's first typed word, and it already mixes the
//! less-played corners of a library in rather than looping the same favourites.
//!
//! Draws on the server library and the listener's play history, so it only
//! offers itself when signed into a server with something to play.

import {
  Button, IconButton, Spinner, Text } from '@glacier/react';
import { Radio } from '@glacier/icons';
import { useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import { useLibrary } from './library.tsx';
import { fetchDj, trackIdFromPath } from './server.ts';
import type { Track } from './tauri.ts';

export function DjLauncher({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The DJ reads a server library and a listening history; without either there
  // is nothing for it to spin.
  if (!session || tracks.length === 0) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const set = await fetchDj(session);
      // The set comes back as track ids; resolve them against the library and
      // flatten every run into one queue, in the order the DJ chose.
      const byId = new Map<number, Track>();
      for (const t of tracks) {
        const id = trackIdFromPath(t.path);
        if (id != null) byId.set(id, t);
      }
      const queue: Track[] = [];
      for (const block of set.blocks) {
        for (const id of block.trackIds) {
          const t = byId.get(id);
          if (t) queue.push(t);
        }
      }
      const first = queue[0];
      if (!first) {
        setError('The DJ came up empty. Play a few things first so it learns your taste.');
        return;
      }
      setLine(set.blocks.find((b) => b.say.trim())?.say ?? null);
      onPlay(first, queue);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The DJ could not start.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="djLauncher">
      {/* Named, not just an icon: a radio glyph alone read as anything from
          broadcast to bluetooth. Short, because it shares a header. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void start()}
        disabled={busy}
        title={busy ? 'Cueing…' : 'Start the DJ'}
      >
        {busy ? <Spinner size="sm" aria-label="Cueing the DJ" /> : <Radio size={16} />}
        <span>DJ</span>
      </Button>
      {line && (
        <Text tone="muted" size="sm" className="djLauncher__line">
          🎙 {line}
        </Text>
      )}
      {error && (
        <Text tone="danger" size="sm">
          {error}
        </Text>
      )}
    </div>
  );
}
