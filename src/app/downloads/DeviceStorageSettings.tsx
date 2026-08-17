import { useState } from 'react';
import { SegmentedControl } from '@glacier/react';
import { StorageOverview } from './StorageOverview.tsx';
import { FilesOnDevice } from './FilesOnDevice.tsx';

/**
 * What this device is holding, and what it costs.
 *
 * Two chunks. Overview is the picture and the levers - one bar splitting
 * everything held into the cache's share, the hand-kept share and download
 * debris, the last sweep's receipt, the budget slider, the actions. Files is
 * the browser - every held file by artist and album or by size, with delete
 * on each row.
 *
 * This replaced two flat panes (Offline, Storage) that each told half the
 * story and three of whose lists were lenses on the same folder. The browser
 * holds all three lenses now: by-artist IS its top level, largest-files is
 * its Biggest view, and kept-by-hand is every row wearing "kept".
 */

type Chunk = 'overview' | 'files';

const CHUNKS: { value: Chunk; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'files', label: 'Files' },
];

export function DeviceStorageSettings() {
  const [chunk, setChunk] = useState<Chunk>('overview');

  return (
    <div className="prefsBody deviceStorage">
      <SegmentedControl
        aria-label="Downloads and space"
        fullWidth
        value={chunk}
        options={CHUNKS}
        onValueChange={(next) => setChunk(next as Chunk)}
      />
      {chunk === 'overview' ? <StorageOverview /> : <FilesOnDevice />}
    </div>
  );
}
