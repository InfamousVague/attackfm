import { Button, IconButton, Label, Text } from '@glacier/react';
import { Trash2 } from '@glacier/icons';
import { useCallback, useEffect, useState } from 'react';
import { useLibrary } from './library.tsx';
import { clearOffline, offlineEntries, onOfflineChange, unpinTrack, type OfflineEntry } from './offline.ts';
import { isTauri } from './tauri.ts';

/**
 * The offline vault, as a settings pane: what this device is holding, what it
 * costs, and the way to give the room back.
 *
 * Deliberately a reader. The vault lives on the disk (see offline.ts and its
 * Rust half), so this pane never keeps its own list - it asks the folder every
 * time it opens and whenever a pin changes underneath it. That is what keeps
 * it honest after an app update, a restore, or a file the OS reclaimed.
 */

/** Held songs are small in number but large in bytes; MB reads better than GB
 *  until there is a real library down here. */
function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** How many rows before the list stops being a list and starts being a wall. */
const SHOWN = 40;

export function OfflineSettings() {
  const [entries, setEntries] = useState<OfflineEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const { tracks } = useLibrary();

  const refresh = useCallback(() => {
    void offlineEntries().then(setEntries);
  }, []);
  useEffect(() => {
    refresh();
    return onOfflineChange(refresh);
  }, [refresh]);

  if (!isTauri()) {
    return (
      <div className="prefsBody">
        <Text size="sm" tone="muted">
          Downloads are kept by the app. A browser tab streams everything from the server.
        </Text>
      </div>
    );
  }

  const bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  // A held file is a song while the library still knows it. One the server has
  // since dropped keeps its space until it is cleared, and saying so plainly
  // beats hiding the row and leaving the space unexplained.
  const byPath = new Map(tracks.map((t) => [t.path, t]));

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Label>On this device</Label>
        <Text size="sm" tone="muted">
          {entries.length === 0
            ? 'Nothing downloaded yet. A song’s own menu keeps it here, and a kept song plays with no network at all — the hub can be off.'
            : `${entries.length} ${entries.length === 1 ? 'song' : 'songs'} · ${size(bytes)}`}
        </Text>

        {entries.length > 0 && (
          <>
            <div className="offlineList">
              {entries.slice(0, SHOWN).map((e) => {
                const track = byPath.get(e.key);
                return (
                  <div key={e.key} className="offlineRow">
                    <span className="offlineRow__text">
                      <span className="offlineRow__title">
                        {track?.title ?? 'No longer in the library'}
                      </span>
                      <span className="offlineRow__sub">
                        {track ? track.artist : e.key} · {size(e.bytes)}
                      </span>
                    </span>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${track?.title ?? 'this download'}`}
                      onClick={() => void unpinTrack(e.key)}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                );
              })}
            </div>
            {entries.length > SHOWN && (
              <Text size="xs" tone="subtle">
                …and {entries.length - SHOWN} more.
              </Text>
            )}
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void clearOffline().finally(() => setBusy(false));
              }}
            >
              Remove all downloads
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
