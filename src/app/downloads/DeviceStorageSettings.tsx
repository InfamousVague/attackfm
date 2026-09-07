import { useState } from 'react';
import { SegmentedControl } from '@glacier/react';
import { StorageOverview } from './StorageOverview.tsx';
import { FilesOnDevice } from './FilesOnDevice.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

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

// Keys, not words: this pair is built when the module is imported, before any
// language has been chosen, so a translated label here would be the one the
// app booted with for the rest of the session.
const CHUNKS: { value: Chunk; labelKey: string }[] = [
  { value: 'overview', labelKey: 'downloads.chunkOverview' },
  { value: 'files', labelKey: 'downloads.chunkFiles' },
];

export function DeviceStorageSettings() {
  const t = useT();
  const [chunk, setChunk] = useState<Chunk>('overview');

  return (
    <div className="prefsBody deviceStorage">
      <SegmentedControl
        aria-label={t('downloads.deviceStorage')}
        fullWidth
        value={chunk}
        options={CHUNKS.map((c) => ({ value: c.value, label: t(c.labelKey) }))}
        onValueChange={(next) => setChunk(next as Chunk)}
      />
      {chunk === 'overview' ? <StorageOverview /> : <FilesOnDevice />}
    </div>
  );
}
