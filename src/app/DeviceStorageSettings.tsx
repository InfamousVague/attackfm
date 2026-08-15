import { useState } from 'react';
import { SegmentedControl } from '@glacier/react';
import { OfflineSettings } from './OfflineSettings.tsx';
import { StorageSettings } from './StorageSettings.tsx';

/**
 * What this device is holding, and what it costs.
 *
 * These were two panes sitting next to each other in the same group with the
 * same green tint, and they are two halves of one question. Offline is the
 * POLICY - how much room the cache may use, what it has kept, what you pinned
 * by hand. Storage is the ACCOUNTING - how much is on the disk, which artists
 * it went to, which files are the big ones. Anyone asking "why is this app
 * taking up so much space" needs both, and had to know which of two names to
 * open first.
 *
 * Together they are long, so the same treatment the Servers pane got: one
 * chunk at a time, in the order the question is actually asked - what is it
 * keeping, then where did the room go.
 */

type Chunk = 'kept' | 'space';

const CHUNKS: { value: Chunk; label: string }[] = [
  { value: 'kept', label: 'Downloads' },
  { value: 'space', label: 'Space' },
];

export function DeviceStorageSettings() {
  const [chunk, setChunk] = useState<Chunk>('kept');

  return (
    <div className="prefsBody deviceStorage">
      <SegmentedControl
        aria-label="Downloads and space"
        fullWidth
        value={chunk}
        options={CHUNKS}
        onValueChange={(next) => setChunk(next as Chunk)}
      />
      {chunk === 'kept' ? <OfflineSettings /> : <StorageSettings />}
    </div>
  );
}
