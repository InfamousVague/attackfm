//! The DJ, on the client: set a vibe (or don't), and the server hands back a
//! continuous set of the listener's OWN tracks with a spoken line opening each
//! run. This turns that into playback - the whole set becomes the queue, and the
//! opening line is shown while it spins.
//!
//! Draws on the server library and the listener's play history, so it only
//! offers itself when signed into a server with something to play.

import { Button, Input, Spinner, Text } from '@glacier/react';
import { Radio } from '@glacier/icons';
import { useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import { useLibrary } from './library.tsx';
import { fetchDj, trackIdFromPath } from './server.ts';
import type { Track } from './tauri.ts';

export function DjLauncher({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const [seed, setSeed] = useState('');
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
      const set = await fetchDj(session, seed);
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
      <div className="djLauncher__row">
        <Input
          className="djLauncher__field"
          value={seed}
          onChange={(e) => setSeed(e.currentTarget.value)}
          placeholder="Start the DJ — set a vibe, or just hit play"
          aria-label="DJ vibe"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void start();
          }}
        />
        <Button variant="solid" size="sm" onClick={() => void start()} disabled={busy}>
          {busy ? <Spinner size="sm" aria-label="" /> : <Radio size={15} />}
          <span>{busy ? 'Cueing…' : 'DJ'}</span>
        </Button>
      </div>
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
