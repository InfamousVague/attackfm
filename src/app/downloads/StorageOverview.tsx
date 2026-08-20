import { Button, Label, SegmentedBar, Slider, Switch, Text } from '@glacier/react';
import { artSized } from '../server.ts';
import { useCallback, useEffect, useState } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  cacheLimitBytes,
  sweepManifest,
  cacheUsage,
  clearCache,
  dismissSweepReport,
  resetFailedManifest,
  lastSweep,
  LIMIT_CHOICES,
  onCacheChange,
  setCacheLimitBytes,
  sweepCache,
} from './autoCache.ts';
import { offlineSpace, onOfflineChange } from './offline.ts';
import { isTauri } from '../core/tauri.ts';
import { networkKindNow, onNetworkChange, type NetworkKind } from '../core/network.ts';
import { setWifiOnlyDownloads, wifiOnlyDownloads } from '../settings/behaviourPrefs.ts';
import { formatBytes } from '../ux/format.ts';

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

// Bytes render through the shared BINARY formatter: this line pairs a usage
// with the limit it counts against, and the limit is set in 1024-based GB -
// the old decimal copy here made a full 15 GB cache read "16 GB of 15 GB".
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

/**
 * The line under the Wi-Fi switch, which says what is happening rather than
 * what the setting is called.
 *
 * The `unknown` case is the one worth reading twice. Some devices cannot tell
 * Wi-Fi from cellular - a browser tab, a Windows desktop, an iPhone still on a
 * binary from before the check existed - and there the switch genuinely does
 * nothing. Saying so is unattractive and necessary: a switch that silently
 * fails to protect you is worse than one that admits it cannot, because you
 * would go on believing it worked.
 */
function wifiOnlyText(on: boolean, network: NetworkKind): string {
  if (!on) {
    return 'Automatic downloads use whatever connection is here, mobile data included. Downloads only happen while the app is open.';
  }
  if (network === 'cellular') {
    return 'Paused — this device is on mobile data. It picks up again on Wi-Fi. Playing music, pinned songs and Check now are unaffected.';
  }
  if (network === 'unknown') {
    return 'This device cannot tell Wi-Fi from mobile data, so downloads carry on regardless. Playing music, pinned songs and Check now are never held back.';
  }
  return 'Automatic downloads wait for Wi-Fi. Playing music, pinned songs and Check now are unaffected — those are you asking.';
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
  const [plan, setPlan] = useState(sweepManifest);
  const [wifiOnly, setWifiOnly] = useState(wifiOnlyDownloads);
  // What this device is on right now, so the row can say whether the switch is
  // currently holding anything back rather than only what it would do.
  const [network, setNetwork] = useState<NetworkKind>(networkKindNow);
  useEffect(() => onNetworkChange(setNetwork), []);

  const refresh = useCallback(() => {
    void cacheUsage().then(setUsage);
    void offlineSpace().then(setSpace);
    setReport(lastSweep());
    setPlan([...sweepManifest()]);
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

  // A sweep that dies before writing its report used to un-busy the button
  // and say nothing; the reason lands here instead, beside the button.
  const [sweepError, setSweepError] = useState<string | null>(null);
  const update = async () => {
    if (!session) return;
    setBusy(true);
    setSweepError(null);
    setProgress({ done: 0, total: 0 });
    try {
      await sweepCache(session, { onProgress: (done, total) => setProgress({ done, total }) });
    } catch (e) {
      setSweepError(e instanceof Error ? e.message : 'The check did not finish.');
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
          <span className="storageBreak__big">{formatBytes(total)}</span>
          <Text size="sm" tone="muted">
            {count.toLocaleString()} {count === 1 ? 'song' : 'songs'}
            {space?.freeBytes != null ? ` · ${formatBytes(space.freeBytes)} free on the phone` : ''}
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
                Automatic · {formatBytes(usage?.bytes ?? 0)} of {gbLabel(limit)}
              </span>
              <span className="storageBreak__key" data-tone="success">
                Kept by hand · {formatBytes(usage?.pinnedBytes ?? 0)}
              </span>
              {debris > 0 && (
                <span className="storageBreak__key" data-tone="neutral">
                  Still downloading · {formatBytes(debris)}
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
          <>
            <Text size="xs" tone={report.failed > 0 || report.liked === -1 ? 'danger' : 'subtle'}>
              Last check {sinceLabel(report.at)} — {report.note}
              {report.liked > 0 ? ` · ${report.liked} liked` : ''}
              {report.skippedUnknown > 0
                ? ` · ${report.skippedUnknown} not in this device's index yet`
                : ''}
            </Text>
            {/* Said on its own line rather than left to the note, because the
                note leads with failures when there are any - and a full budget
                is exactly the case where nothing failed and songs are missing
                anyway. Names the remedy: this is the one shortfall on this
                screen the slider directly below actually fixes. */}
            {(report.budgetShort ?? 0) > 0 && (
              <Text size="xs" tone="subtle">
                {report.budgetShort} more {report.budgetShort === 1 ? 'song is' : 'songs are'} wanted
                than this much space holds — raise the limit below to keep {report.budgetShort === 1 ? 'it' : 'them'} too.
              </Text>
            )}
            {/* The note leads with the commonest failure; when the sweep hit
                MORE than one kind, the rest are listed so a mirror failing
                differently from the primary is two lines, not a mystery. */}
            {(report.failReasons?.length ?? 0) > 1 &&
              report.failReasons!.slice(1).map((r) => (
                <Text key={r.reason} size="xs" tone="danger">
                  {r.n} × {r.reason}
                </Text>
              ))}
            {/* The two things a person standing in front of an error wants:
                run the red ones again, or put the message away. Retry rides
                the ordinary sweep - the same pass, the same reasons if it
                fails again - with the failed tiles wound back to waiting so
                the wall reads as a retry instead of flickering red. */}
            {(report.failed > 0 || report.liked === -1) && (
              <div className="cacheActions">
                {report.failed > 0 && (
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={busy || !session || limit === 0}
                    onClick={() => {
                      resetFailedManifest();
                      void update();
                    }}
                  >
                    Retry failed
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => dismissSweepReport()}>
                  Dismiss
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="prefsSection">
        <Label>Automatic downloads</Label>
        <Text size="sm" tone="muted">
          Liked songs, everything in your playlists, what you have on repeat, and what you played
          recently — kept on the phone so they play instantly and without the hub. Liked songs and
          playlists come first; the rest rotates out as it goes cold or as newer songs need the room.
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

        {/* This used to be a paragraph apologising for the absence of the
            switch below it. The apology was the honest thing to write at the
            time and the wrong thing to leave standing. */}
        <div data-setting="wifi-only">
          <Switch
            label="Only download on Wi-Fi"
            checked={wifiOnly}
            onCheckedChange={(on: boolean) => {
              setWifiOnlyDownloads(on);
              setWifiOnly(on);
            }}
          />
          <Text size="xs" tone="subtle">
            {wifiOnlyText(wifiOnly, network)}
          </Text>
        </div>

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
        {sweepError && (
          <Text size="xs" tone="danger">
            {sweepError}
          </Text>
        )}
      </div>

      {plan.length > 0 && (
        <div className="prefsSection">
          <Label>What the last check planned</Label>
          <Text size="sm" tone="muted">
            Every song the cache decided this phone should hold, and where each one got.
          </Text>
          {/* Mini scale on purpose: the point is the overall pattern - a wall
              of green with three red is a different sentence from a wall of
              red - with each tile's title in its tooltip. Failures sort first
              so the broken part is never below the fold of the cap. */}
          <div className="sweepGrid" role="list">
            {[...plan]
              .sort((a, b) => ORDER[a.state] - ORDER[b.state])
              .slice(0, 96)
              .map((e) => (
                <span
                  key={e.key}
                  role="listitem"
                  className="sweepGrid__tile"
                  data-state={e.state}
                  title={`${e.title} — ${e.artist}${e.reason ? ` · ${e.reason}` : e.state === 'done' ? '' : ` · ${e.state}`}`}
                >
                  {e.art ? <img src={artSized(e.art, 160) ?? undefined} alt="" loading="lazy" /> : null}
                </span>
              ))}
          </div>
          <Text size="xs" tone="subtle">
            {plan.filter((e) => e.state === 'done').length} of {plan.length} on the phone
            {plan.some((e) => e.state === 'downloading') ? ' · downloading now' : ''}
            {plan.length > 96 ? ` · showing 96` : ''}
          </Text>
        </div>
      )}
    </>
  );
}

/** Failures first, then live work, then the queue, then the settled. */
const ORDER = { failed: 0, downloading: 1, waiting: 2, done: 3 } as const;
