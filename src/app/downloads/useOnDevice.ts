import { useEffect, useState } from 'react';
import { offlineEntries } from './offline.ts';
import { onOfflineChange } from './offline.ts';
import { onCacheChange } from '../cache/cacheStore.ts';

/**
 * The set of track paths that are ON THIS DEVICE right now - pinned or
 * auto-cached, it does not matter: a file is a file. Refreshes itself when
 * either store reports movement, so a row's badge appears as the download
 * lands and leaves when the sweep lets the file go.
 */
export function useOnDevice(): Set<string> {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let stamp = 0;
    const refresh = () => {
      const mine = ++stamp;
      void offlineEntries().then((entries) => {
        if (mine === stamp) setKeys(new Set(entries.map((e) => e.key)));
      });
    };
    refresh();
    const offA = onOfflineChange(refresh);
    const offB = onCacheChange(refresh);
    return () => {
      stamp += 1;
      offA();
      offB();
    };
  }, []);
  return keys;
}
