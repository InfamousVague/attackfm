import { Button, IconButton, Label, Select, Text } from '@glacier/react';
import { Trash2 } from '@glacier/icons';
import { useCallback, useEffect, useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import {
  cacheLimitBytes,
  cacheUsage,
  clearCache,
  LIMIT_CHOICES,
  onCacheChange,
  setCacheLimitBytes,
  sweepCache,
} from './autoCache.ts';
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
      <AutoCacheSection />
      <div className="prefsSection">
        <Label>Kept by hand</Label>
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

/** GB, said the way the picker says it. */
function gbLabel(bytes: number): string {
  if (bytes === 0) return 'Off';
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

/**
 * The automatic half: how much room the phone may use, and what it did with it.
 *
 * Worth being explicit in the copy about the two things people get wrong about
 * a cache. It is not a second copy of the library (it holds what you play, and
 * rotates), and it does not touch songs kept by hand (those are yours, and sit
 * outside this budget entirely).
 */
function AutoCacheSection() {
  const { session } = useServerSession();
  const [limit, setLimit] = useState(cacheLimitBytes);
  const [usage, setUsage] = useState<{ bytes: number; count: number; pinnedBytes: number; pinnedCount: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const refresh = useCallback(() => {
    void cacheUsage().then(setUsage);
  }, []);
  useEffect(() => {
    refresh();
    return onCacheChange(refresh);
  }, [refresh]);

  const update = async () => {
    if (!session) return;
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      await sweepCache(session, { onProgress: (done, total) => setProgress({ done, total }) });
    } finally {
      setBusy(false);
      setProgress(null);
      refresh();
    }
  };

  const pct = limit > 0 && usage ? Math.min(100, Math.round((usage.bytes / limit) * 100)) : 0;

  return (
    <div className="prefsSection">
      <Label>Downloaded automatically</Label>
      <Text size="sm" tone="muted">
        Your liked songs, what you have on repeat, and what you played recently — kept on the phone so
        they play instantly and without the hub. Songs rotate out as they go cold or as newer ones need
        the room.
      </Text>

      <Select
        aria-label="How much space the cache may use"
        fullWidth
        value={String(limit)}
        options={LIMIT_CHOICES.map((b) => ({ value: String(b), label: gbLabel(b) }))}
        onValueChange={(v) => {
          const next = Number(v);
          setCacheLimitBytes(next);
          setLimit(next);
        }}
      />

      {limit > 0 && (
        <div className="cacheMeter">
          <div className="cacheMeter__bar">
            <span className="cacheMeter__fill" style={{ inlineSize: `${pct}%` }} />
          </div>
          <Text size="xs" tone="subtle">
            {usage
              ? `${usage.count.toLocaleString()} ${usage.count === 1 ? 'song' : 'songs'} · ${size(usage.bytes)} of ${gbLabel(limit)}`
              : 'Checking…'}
          </Text>
        </div>
      )}

      {usage && usage.pinnedCount > 0 && (
        <Text size="xs" tone="subtle">
          Plus {usage.pinnedCount.toLocaleString()} kept by hand ({size(usage.pinnedBytes)}), which this
          budget never touches.
        </Text>
      )}

      {/* Said plainly rather than buried: this is the one setting on the page
          that can spend somebody's mobile data without being asked. */}
      <Text size="xs" tone="subtle">
        Downloads happen while the app is open. There is no wi-fi-only switch yet, so this can use
        mobile data.
      </Text>

      <div className="cacheActions">
        <Button size="sm" variant="soft" disabled={busy || !session || limit === 0} onClick={() => void update()}>
          {busy
            ? progress && progress.total > 0
              ? `Downloading ${progress.done}/${progress.total}…`
              : 'Working…'
            : 'Update now'}
        </Button>
        {usage && usage.count > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void clearCache().finally(() => {
                setBusy(false);
                refresh();
              });
            }}
          >
            Empty cache
          </Button>
        )}
      </div>
    </div>
  );
}
