import { Button, Field, Label, SegmentedBar, SegmentedControl, Slider, Switch, Text } from '@glacier/react';
import { useLibrary } from '../library/library.tsx';
import { artCacheCount } from '../cache/artCache.ts';
import { keptTranscriptCount } from '../player/transcriptStore.ts';
import { artSized } from '../server.ts';
import { useCallback, useEffect, useState } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  cacheLimitBytes,
  sweepManifest,
  cacheBreakdown,
  cacheUsage,
  type KindUse,
  clearCache,
  dismissSweepReport,
  resetFailedManifest,
  lastSweep,
  LIMIT_CHOICES,
  QUALITY_CHOICES,
  cacheQualityKbps,
  onCacheChange,
  setCacheLimitBytes,
  setCacheQualityKbps,
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
/**
 * What this quality actually buys, in hours rather than in kilobits.
 *
 * A bitrate means nothing to most people and the size of a disk means little
 * more, but "about 37 hours" and "about 260 hours" is a choice anybody can make.
 * Both halves are said: what changes now, and what happens to the songs already
 * on the phone, because a setting that silently leaves fifteen gigabytes alone
 * is one somebody will think is broken.
 *
 * 929 kbps is a measured FLAC average rather than a guess - it is what 44.1kHz
 * stereo lossless comes out at across ordinary music. The AAC figures are the
 * requested rate plus ADTS framing.
 */
function qualityHint(kbps: number, limitBytes: number): string {
  const perHourBytes = ((kbps === 0 ? 929 : kbps * 1.03) * 1000 * 3600) / 8;
  const hours = limitBytes > 0 ? Math.round(limitBytes / perHourBytes) : 0;
  const holds = limitBytes > 0 ? ` At this size that is roughly ${hours} hours of music.` : '';
  if (kbps === 0) {
    return `The original file, byte for byte — the same bits the server holds.${holds}`;
  }
  return (
    `Re-encoded to ${kbps}k AAC as it downloads, which is a fraction of the size and costs the ` +
    `server a moment's work per song.${holds} Songs already on this device are brought over a few ` +
    `dozen at a time as the cache checks in; songs you kept by hand are left as they are.`
  );
}

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
  // The library is the only thing that knows a key is a book: the vault stores
  // bytes against a path and nothing else.
  const { books } = useLibrary();
  const [kinds, setKinds] = useState<{ music: KindUse; books: KindUse } | null>(null);
  // The two stores that are NOT audio and not budgeted against the allowance
  // below - counted rather than weighed, because measuring a Cache API store
  // means reading every entry back, and a phone holds hundreds of covers.
  const [wordCount, setWordCount] = useState(0);
  const [coverCount, setCoverCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState(lastSweep);
  const [plan, setPlan] = useState(sweepManifest);
  const [wifiOnly, setWifiOnly] = useState(wifiOnlyDownloads);
  const [kbps, setKbps] = useState(cacheQualityKbps);
  // What this device is on right now, so the row can say whether the switch is
  // currently holding anything back rather than only what it would do.
  const [network, setNetwork] = useState<NetworkKind>(networkKindNow);
  useEffect(() => onNetworkChange(setNetwork), []);

  const refresh = useCallback(() => {
    void cacheUsage().then(setUsage);
    void cacheBreakdown(new Set(books.map((b) => b.path))).then(setKinds);
    void keptTranscriptCount().then(setWordCount);
    void artCacheCount().then(setCoverCount);
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

  /*
   * The browsable folder, Android only. Three states: not Android (row absent),
   * grant missing (a button that walks to the system's all-files screen - it
   * is a settings page, not a dialog, so the copy says where it leads), and
   * granted (the path, stated, so a file manager can be pointed at it).
   * The grant is read fresh per render - returning from the settings screen
   * re-renders this pane, which is when the answer changes.
   */
  const native = (window as unknown as {
    AFMNative?: { canBrowseVault?: () => boolean; vaultDir?: () => string | null; requestVaultAccess?: () => void };
  }).AFMNative;
  const browsable = native?.canBrowseVault ? native.canBrowseVault() : null;
  const vaultPath = browsable ? native?.vaultDir?.() : null;

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
  /*
   * The empty share of the bar - what the cache could still take before it
   * starts evicting.
   *
   * Measured against the BUDGET, not against the phone's disk, and the choice
   * matters. The phone's free space is already stated in words above ("N free
   * on the phone"), and drawn as a bar it would be almost all of it - a few
   * gigabytes of music against a couple of hundred reads as a sliver and says
   * nothing. The budget is the number this pane is actually about: it is the
   * legend's own denominator ("Automatic - X of 15 GB"), it is what the slider
   * underneath sets, and it is the thing that decides when a song gets thrown
   * away. So the bar answers "how full is the allowance", and the gray is the
   * room left in it.
   *
   * `max(limit, total)` rather than `limit`, because songs kept by hand are
   * deliberately NOT budgeted (see cacheSweep - budgeting pins would shrink
   * the cache every time you kept something). Enough pins can therefore put
   * the total past the limit, and the denominator has to follow or the
   * segments would sum past 100%. When that happens the gray is simply zero,
   * which is the honest picture: nothing spare.
   */
  /* The two type totals, each counting what the cache brought AND what was kept
     on purpose - the bar is about what the space holds, not how it arrived. */
  const musicBytes = (kinds?.music.bytes ?? 0) + (kinds?.music.pinnedBytes ?? 0);
  const bookBytes = (kinds?.books.bytes ?? 0) + (kinds?.books.pinnedBytes ?? 0);
  const musicCount = (kinds?.music.count ?? 0) + (kinds?.music.pinnedCount ?? 0);
  const bookCount = (kinds?.books.count ?? 0) + (kinds?.books.pinnedCount ?? 0);
  const capacity = Math.max(limit, total);
  const empty = Math.max(0, capacity - total);

  return (
    <>
      <div className="prefsSection">
        <Label>On this device</Label>
        <div className="storageBreak__totals">
          <span className="storageBreak__big">{formatBytes(total)}</span>
          <Text size="sm" tone="muted">
            {/* Named separately for the same reason the bar is split: "1,204
                songs" over a shelf of audiobooks counts two unlike things as
                one. */}
            {musicCount.toLocaleString()} {musicCount === 1 ? 'song' : 'songs'}
            {bookCount > 0
              ? ` · ${bookCount.toLocaleString()} ${bookCount === 1 ? 'book file' : 'book files'}`
              : ''}
            {space?.freeBytes != null ? ` · ${formatBytes(space.freeBytes)} free on the phone` : ''}
          </Text>
        </div>
        {total > 0 ? (
          <>
            <SegmentedBar
              className="storageBreak__bar"
              size="md"
              rounded
              /* BY WHAT IT IS, not by how it got here. Automatic-versus-kept
                 was the right split while everything on the device was songs;
                 with books on it too the first question is which of the two is
                 using the gigabytes - they behave nothing alike, and read as one
                 number each hides the other. How it got here is still said, per
                 type, in the legend below. */
              data={[
                { value: musicBytes, tone: 'accent', label: 'Music' },
                { value: bookBytes, tone: 'success', label: 'Audiobooks' },
                /* Debris moves off `neutral` so the gray can have it. The kit
                   offers five tones and only one of them is a gray, so the
                   empty share and the unfinished downloads cannot both wear
                   it and stay tellable apart. Warning is the better fit for
                   debris anyway - a part-downloaded file is a state worth
                   noticing, where empty space is the absence of one. */
                { value: debris, tone: 'warning', label: 'Still downloading' },
                { value: empty, tone: 'neutral', label: 'Free' },
              ]}
              aria-label="What is using the space"
            />
            <div className="storageBreak__legend">
              <span className="storageBreak__key" data-tone="accent">
                Music · {formatBytes(musicBytes)}
                {kinds && kinds.music.pinnedBytes > 0
                  ? ` (${formatBytes(kinds.music.pinnedBytes)} kept)`
                  : ''}
              </span>
              <span className="storageBreak__key" data-tone="success">
                Audiobooks · {formatBytes(bookBytes)}
                {kinds && kinds.books.pinnedBytes > 0
                  ? ` (${formatBytes(kinds.books.pinnedBytes)} kept)`
                  : ''}
              </span>
              {debris > 0 && (
                <span className="storageBreak__key" data-tone="warning">
                  Still downloading · {formatBytes(debris)}
                </span>
              )}
              {empty > 0 && (
                <span className="storageBreak__key" data-tone="neutral">
                  Free · {formatBytes(empty)}
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
        {/* The rest of what is on the device.

            Deliberately COUNTED, not weighed, and deliberately outside the bar
            above: both live in the browser's own store rather than the vault,
            neither is charged against the allowance the slider sets, and
            measuring either means reading every entry back out - which for a
            phone holding hundreds of covers costs more than the answer is
            worth. Saying how many there are is honest and cheap; drawing them as
            a slice of a budget they are not part of would not be. */}
        {(coverCount > 0 || wordCount > 0) && (
          <Text size="xs" tone="subtle">
            Also held: {coverCount.toLocaleString()} {coverCount === 1 ? 'cover' : 'covers'}
            {wordCount > 0
              ? ` · words for ${wordCount.toLocaleString()} ${wordCount === 1 ? 'book' : 'books'}`
              : ''}
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
        {/* Above the budget rather than below it, because this is what decides
            what a gigabyte holds: at 128k the same slider keeps about seven
            times the songs. Answering "how good" before "how much" means the
            number under the slider is already true when you read it. */}
        <Field label="Download quality" hint={qualityHint(kbps, limit)}>
          <SegmentedControl
            aria-label="Download quality"
            fullWidth
            value={String(kbps)}
            onValueChange={(next: string) => {
              const n = Number(next);
              setKbps(n);
              setCacheQualityKbps(n);
            }}
            options={QUALITY_CHOICES.map((q) => ({
              value: String(q),
              label: q === 0 ? 'Lossless' : `${q}k`,
            }))}
          />
        </Field>

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
      {browsable !== null && (
        <div className="storageBrowsable">
          {vaultPath ? (
            <Text size="xs" tone="muted">
              Cached music lives in <b>AttackFM/Music</b> on this phone's storage — open any file
              manager to browse or prune it by hand.
            </Text>
          ) : (
            <>
              <Text size="xs" tone="muted">
                Keep cached music in an <b>AttackFM</b> folder a file manager can browse. Android
                grants this on a settings screen, not a pop-up — the button below opens it; flip
                the switch for AttackFM and come back.
              </Text>
              <Button
                variant="outline"
                size="sm"
                onClick={() => native?.requestVaultAccess?.()}
              >
                Allow the AttackFM folder
              </Button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Failures first, then live work, then the queue, then the settled. */
const ORDER = { failed: 0, downloading: 1, waiting: 2, done: 3 } as const;
