import { Button, Label, SegmentedBar, Slider, Text } from '@glacier/react';
import { useCallback, useEffect, useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import {
  cacheLimitBytes,
  cacheUsage,
  clearCache,
  lastSweep,
  LIMIT_CHOICES,
  onCacheChange,
  setCacheLimitBytes,
  sweepCache,
} from './autoCache.ts';
import { offlineSpace, onOfflineChange } from './offline.ts';
import { isTauri } from './tauri.ts';

/**
 * The Overview chunk: one picture of the space, then the levers.
 *
 * This is the merge of what used to be two panes saying half a sentence each -
 * Offline's policy controls with their own little budget meter, and Storage's
 * "space used" bar a tab away describing the same bytes. One bar now: what is
 * held, split into the cache's share, the hand-kept share and half-finished
 * debris, with the budget in its legend. Under it, the receipt (what the last
 * pass actually did - the line that turns "nothing kept" from a mystery into a
 * reason), then the budget slider and the two actions.
 *
 * The file-by-file half lives in the Files chunk; this page never lists songs.
 */

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function gbLabel(bytes: number): string {
  if (bytes === 0) return 'Off';
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

/** "3 min ago" - the sweep is periodic, so WHEN it last ran is half the answer
 *  to why something has not arrived yet. */
function sinceLabel(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function StorageOverview() {
  const { session } = useServerSession();
  const [limit, setLimit] = useState(cacheLimitBytes);
  const [usage, setUsage] = useState<{
    bytes: number;
    count: number;
    pinnedBytes: number;
    pinnedCount: number;
  } | null>(null);
  const [space, setSpace] = useState<{ freeBytes: number | null; heldBytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState(lastSweep);

  const refresh = useCallback(() => {
    void cacheUsage().then(setUsage);
    void offlineSpace().then(setSpace);
    setReport(lastSweep());
  }, []);
  useEffect(() => {
    refresh();
    const offA = onCacheChange(refresh);
    const offB = onOfflineChange(refresh);
    return () => {
      offA();
      offB();
    };
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

  if (!isTauri()) {
    return (
      <Text size="sm" tone="muted">
        Downloads are kept by the app. A browser tab streams everything from the server.
      </Text>
    );
  }

  const listed = (usage?.bytes ?? 0) + (usage?.pinnedBytes ?? 0);
  // The folder can hold more than the listings say: a download's .part file is
  // deliberately not an entry, but its bytes are real.
  const debris = Math.max(0, (space?.heldBytes ?? listed) - listed);
  const total = listed + debris;
  const count = (usage?.count ?? 0) + (usage?.pinnedCount ?? 0);

  return (
    <>
      <div className="prefsSection">
        <Label>On this device</Label>
        <div className="storageBreak__totals">
          <span className="storageBreak__big">{size(total)}</span>
          <Text size="sm" tone="muted">
            {count.toLocaleString()} {count === 1 ? 'song' : 'songs'}
            {space?.freeBytes != null ? ` · ${size(space.freeBytes)} free on the phone` : ''}
          </Text>
        </div>
        {total > 0 ? (
          <>
            <SegmentedBar
              size="md"
              rounded
              data={[
                { value: usage?.bytes ?? 0, tone: 'accent', label: 'Downloaded automatically' },
                { value: usage?.pinnedBytes ?? 0, tone: 'success', label: 'Kept by hand' },
                { value: debris, tone: 'neutral', label: 'Still downloading' },
              ]}
              aria-label="What is using the space"
            />
            <div className="storageBreak__legend">
              <span className="storageBreak__key" data-tone="accent">
                {/* The limit is set in binary GB (15 * 1024³); rounding the same
                    way the slider labels do keeps this from reading as a second,
                    different setting. */}
                Automatic · {size(usage?.bytes ?? 0)} of {gbLabel(limit)}
              </span>
              <span className="storageBreak__key" data-tone="success">
                Kept by hand · {size(usage?.pinnedBytes ?? 0)}
              </span>
              {debris > 0 && (
                <span className="storageBreak__key" data-tone="neutral">
                  Still downloading · {size(debris)}
                </span>
              )}
            </div>
          </>
        ) : (
          <Text size="sm" tone="muted">
            Nothing stored yet. The cache fills in as you listen, and a song&rsquo;s own menu keeps
            it here for good.
          </Text>
        )}
        {report && limit > 0 && (
          <Text size="xs" tone={report.failed > 0 || report.liked === -1 ? 'danger' : 'subtle'}>
            Last check {sinceLabel(report.at)} — {report.note}
            {report.liked > 0 ? ` · ${report.liked} liked` : ''}
            {report.skippedUnknown > 0
              ? ` · ${report.skippedUnknown} not in this device's index yet`
              : ''}
          </Text>
        )}
      </div>

      <div className="prefsSection">
        <Label>Automatic downloads</Label>
        <Text size="sm" tone="muted">
          Liked songs, what you have on repeat, and what you played recently — kept on the phone so
          they play instantly and without the hub. Songs rotate out as they go cold or as newer ones
          need the room.
        </Text>
        {/* The slider runs over the curated stops, not raw gigabytes: a linear
            0-100 rail would cram the sizes people actually pick - 2 to 15 GB -
            into its first sixth. One detent per stop, Off at the left edge. */}
        <div className="cacheLimit">
          <Slider
            aria-label="How much space automatic downloads may use"
            min={0}
            max={LIMIT_CHOICES.length - 1}
            step={1}
            hapticStep={100 / (LIMIT_CHOICES.length - 1)}
            value={(() => {
              const i = LIMIT_CHOICES.indexOf(limit);
              if (i >= 0) return i;
              let best = 0;
              for (let k = 1; k < LIMIT_CHOICES.length; k += 1) {
                if (
                  Math.abs((LIMIT_CHOICES[k] ?? 0) - limit) <
                  Math.abs((LIMIT_CHOICES[best] ?? 0) - limit)
                )
                  best = k;
              }
              return best;
            })()}
            onValueChange={(i: number) => {
              const next = LIMIT_CHOICES[Math.max(0, Math.min(LIMIT_CHOICES.length - 1, Math.round(i)))];
              if (next === undefined) return;
              setLimit(next);
              setCacheLimitBytes(next);
            }}
          />
          <span className="cacheLimit__value">{gbLabel(limit)}</span>
        </div>

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
                ? `Downloading ${progress.done} of ${progress.total}…`
                : 'Checking…'
              : 'Check now'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || (usage?.count ?? 0) === 0}
            onClick={() => {
              void clearCache().then(refresh);
            }}
          >
            Clear automatic downloads
          </Button>
        </div>
      </div>
    </>
  );
}
