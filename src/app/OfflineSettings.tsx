import { Button, IconButton, Label, Slider, Text } from '@glacier/react';
import { Trash2 } from '@glacier/icons';
import { useCallback, useEffect, useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import {
  autoCachedKeys,
  cacheLimitBytes,
  cacheUsage,
  clearCache,
  LIMIT_CHOICES,
  onCacheChange,
  lastSweep,
  setCacheLimitBytes,
  sweepCache,
} from './autoCache.ts';
import { useLibrary } from './library.tsx';
import { offlineEntries, onOfflineChange, unpinTrack, type OfflineEntry } from './offline.ts';
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

  const owned = autoCachedKeys();
  const manual = entries.filter((e) => !owned.has(e.key));
  const bytes = manual.reduce((sum, e) => sum + e.bytes, 0);
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
          {manual.length === 0
            ? 'Nothing kept by hand. A song’s own menu keeps it here for good — outside the budget above, and never rotated out.'
            : `${manual.length} ${manual.length === 1 ? 'song' : 'songs'} · ${size(bytes)}`}
        </Text>

        {manual.length > 0 && (
          <>
            <div className="offlineList">
              {manual.slice(0, SHOWN).map((e) => {
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
            {manual.length > SHOWN && (
              <Text size="xs" tone="subtle">
                …and {manual.length - SHOWN} more.
              </Text>
            )}
            {/* Only the hand-kept half: the cache above has its own button,
                and one control that silently emptied both would make the
                split this page just drew a lie. */}
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void Promise.all(manual.map((e) => unpinTrack(e.key))).finally(() => setBusy(false));
              }}
            >
              Remove these
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
/** "3 minutes ago" - the sweep is periodic, so WHEN it last ran is half the
 *  answer to why nothing has arrived. */
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

function AutoCacheSection() {
  const { session } = useServerSession();
  const [limit, setLimit] = useState(cacheLimitBytes);
  const [usage, setUsage] = useState<{ bytes: number; count: number; pinnedBytes: number; pinnedCount: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState(lastSweep);

  const refresh = useCallback(() => {
    void cacheUsage().then(setUsage);
    setReport(lastSweep());
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

      {/* The slider runs over the curated stops, not raw gigabytes: a linear
          0-100 rail would cram the sizes people actually pick - 2 to 15 GB -
          into its first sixth, and the thumb would be all cliff. One detent
          per stop instead, each with its own haptic tick, Off at the left
          edge where a phone's brightness slider taught everyone zero lives. */}
      <div className="cacheLimit">
        <Slider
          aria-label="How much space the cache may use"
          min={0}
          max={LIMIT_CHOICES.length - 1}
          step={1}
          hapticStep={100 / (LIMIT_CHOICES.length - 1)}
          value={(() => {
            const i = LIMIT_CHOICES.indexOf(limit);
            if (i !== -1) return i;
            // A stored value between stops (possible only if set outside this
            // UI) snaps DISPLAY to the nearest stop; the true limit stands
            // until the thumb actually moves.
            let best = 0;
            for (let k = 1; k < LIMIT_CHOICES.length; k += 1) {
              if (Math.abs((LIMIT_CHOICES[k] ?? 0) - limit) < Math.abs((LIMIT_CHOICES[best] ?? 0) - limit)) best = k;
            }
            return best;
          })()}
          onValueChange={(i) => {
            const next = LIMIT_CHOICES[Math.max(0, Math.min(LIMIT_CHOICES.length - 1, Math.round(i)))];
            if (next === undefined || next === limit) return;
            setCacheLimitBytes(next);
            setLimit(next);
          }}
        />
        <span className="cacheLimit__value">{gbLabel(limit)}</span>
      </div>

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

      {/*
        What the last pass actually did.
        
        Every failure in the sweep is caught and shrugged off, which is right
        for a background job and useless for anyone wondering why their liked
        songs are not here. Without this line the only report is an empty
        folder, which cannot tell "switched off" from "no room" from "the
        server would not say what you like".
      */}
      {limit > 0 && report && (
        <Text size="xs" tone={report.failed > 0 || report.liked === -1 ? 'danger' : 'subtle'}>
          Last check {sinceLabel(report.at)} — {report.note}
          {report.liked > 0 ? ` · ${report.liked} liked` : ''}
          {report.skippedUnknown > 0 ? ` · ${report.skippedUnknown} not in this device's index yet` : ''}
        </Text>
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
