import { Button, Field, Label, SegmentedBar, SegmentedControl, Slider, Switch, Text } from '@glacier/react';
import { useLibrary } from '../library/library.tsx';
import { artCacheCount } from '../cache/artCache.ts';
import { keptTranscriptCount } from '../player/transcriptStore.ts';
import { artSized } from '../server.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { adoptVaultRoot, offlineSpace, onOfflineChange } from './offline.ts';
import { isTauri } from '../core/tauri.ts';
import { networkKindNow, onNetworkChange, type NetworkKind } from '../core/network.ts';
import { setWifiOnlyDownloads, wifiOnlyDownloads } from '../settings/behaviourPrefs.ts';
import { formatAgo, formatBytes, formatNumber } from '../ux/format.ts';
import { estimateSetBytes } from '../cache/cacheQuality.ts';
import { loadCachedIndex } from '../api/libraryCache.ts';
import { Trans, useSongCount, useT } from '../i18n/LocaleShell.tsx';

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

/** The app's translator, as the module-scope helpers below want it. They are
 *  called from render and handed `t` rather than calling a hook themselves. */
type T = ReturnType<typeof useT>;

// Bytes render through the shared BINARY formatter: this line pairs a usage
// with the limit it counts against, and the limit is set in 1024-based GB -
// the old decimal copy here made a full 15 GB cache read "16 GB of 15 GB".
// Whole gigabytes rather than formatBytes' one decimal, because every stop on
// the slider IS a whole number and "2.0 GB" under a detent reads as precision
// that is not there. The unit word still comes from Intl.
function gbLabel(bytes: number, t: T): string {
  if (bytes === 0) return t('downloads.limitOff');
  return formatNumber(Math.round(bytes / 1024 ** 3), {
    style: 'unit',
    unit: 'gigabyte',
    unitDisplay: 'short',
  });
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
 *
 * Three whole sentences joined, rather than one entry with a hole in the
 * middle: "roughly N hours" only appears when a budget is set, and a catalogue
 * entry cannot have a clause that sometimes is not there. It now CLOSES the
 * paragraph in both branches - it used to sit mid-paragraph in the AAC one -
 * so each sentence is a key a translator can move words around inside.
 */
function qualityHint(kbps: number, limitBytes: number, t: T): string {
  const perHourBytes = ((kbps === 0 ? 929 : kbps * 1.03) * 1000 * 3600) / 8;
  const hours = limitBytes > 0 ? Math.round(limitBytes / perHourBytes) : 0;
  const holds = limitBytes > 0 ? ` ${t('downloads.qualityHolds', { count: hours })}` : '';
  if (kbps === 0) return `${t('downloads.qualityLossless')}${holds}`;
  return `${t('downloads.qualityAac', { kbps })}${holds}`;
}

function wifiOnlyText(on: boolean, network: NetworkKind, t: T): string {
  if (!on) return t('downloads.wifiAnyConnection');
  if (network === 'cellular') return t('downloads.wifiPausedCellular');
  if (network === 'unknown') return t('downloads.wifiCannotTell');
  return t('downloads.wifiWaiting');
}

export function StorageOverview() {
  const t = useT();
  const songCount = useSongCount();
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
  }, [books]);
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
      setSweepError(e instanceof Error ? e.message : t('downloads.checkDidNotFinish'));
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
  /*
   * The grant lands on a SYSTEM screen and nothing about coming back re-renders
   * React - the pane sat on the "Allow" button after the person had already
   * allowed. Window focus is the one signal the return fires; a tick makes the
   * grant checks below re-run on it.
   */
  const [, setGrantTick] = useState(0);
  useEffect(() => {
    const poke = () => setGrantTick((n) => n + 1);
    window.addEventListener('focus', poke);
    document.addEventListener('visibilitychange', poke);
    return () => {
      window.removeEventListener('focus', poke);
      document.removeEventListener('visibilitychange', poke);
    };
  }, []);
  const browsable = native?.canBrowseVault ? native.canBrowseVault() : null;
  const vaultPath = browsable ? native?.vaultDir?.() : null;
  /*
   * ADOPT the folder the moment the grant exists - not on the next cold
   * start. Boot-only adoption is why "the folder got created but nothing
   * caches into it": the process that was already running never told the
   * vault about its new home. Idempotent (the command re-points and finds
   * nothing left to move), so re-running on every focus costs a stat.
   */
  /*
   * The whole-library estimate, off this device's copy of the library index -
   * no request, and no number when the index has not synced yet (a fresh
   * install), because a confident "0 GB" would be a lie about an empty phone
   * rather than an empty library.
   */
  const libraryEstimate = useMemo(() => {
    if (!session) return null;
    const tracks = loadCachedIndex(session.url).tracks;
    if (tracks.length === 0) return null;
    return { bytes: estimateSetBytes(tracks, kbps), count: tracks.length };
  }, [session, kbps]);

  const [migrated, setMigrated] = useState<number | null>(null);
  useEffect(() => {
    if (!vaultPath) return;
    void adoptVaultRoot().then((moved) => {
      if (moved !== null && moved > 0) setMigrated(moved);
    });
  }, [vaultPath]);

  if (!isTauri()) {
    return (
      <Text size="sm" tone="muted">
        {t('downloads.browserTabOnly')}
      </Text>
    );
  }

  const listed = (usage?.bytes ?? 0) + (usage?.pinnedBytes ?? 0);
  /*
   * Bytes on disk beyond what the cache tracks. NOT "still downloading" - that
   * label was wrong and it never cleared: an in-flight `.part` is a sliver and
   * transient, but this number is dominated by FINISHED files the cache ledger
   * no longer accounts for - a download from a server you have since left, a
   * vault from before a library moved, anything the index and the disk drifted
   * apart on. It is real (heldBytes is a filesystem sum), it is just not a
   * download in progress, so it reads as "Other files" and is reclaimed by
   * clearing downloads rather than by waiting for a download to finish.
   */
  const other = Math.max(0, (space?.heldBytes ?? listed) - listed);
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
  const total = listed + other;
  const capacity = Math.max(limit, total);
  const empty = Math.max(0, capacity - total);

  /* The three tallies under the big number, and the two under "Also held", are
     each a complete phrase; the ` · ` between them is punctuation rather than
     grammar, so they are joined here instead of living in the catalogue as one
     entry with two clauses that are usually absent. */
  const tallies = [songCount(musicCount)];
  if (bookCount > 0) tallies.push(t('downloads.bookFileCount', { count: bookCount }));
  if (space?.freeBytes != null) {
    tallies.push(t('downloads.freeOnPhone', { size: formatBytes(space.freeBytes) }));
  }

  const alsoHeld = [];
  if (coverCount > 0) alsoHeld.push(t('downloads.coverCount', { count: coverCount }));
  if (wordCount > 0) alsoHeld.push(t('downloads.transcriptCount', { count: wordCount }));

  const receipt = [];
  if (report) {
    receipt.push(t('downloads.lastCheck', { when: formatAgo(report.at), note: report.note }));
    if (report.liked > 0) receipt.push(t('downloads.likedCount', { count: report.liked }));
    if (report.skippedUnknown > 0) {
      receipt.push(t('downloads.notIndexedCount', { count: report.skippedUnknown }));
    }
  }

  const planned = plan.filter((e) => e.state === 'done').length;
  const planLine = [t('downloads.planOnPhone', { done: planned, total: plan.length })];
  if (plan.some((e) => e.state === 'downloading')) planLine.push(t('downloads.planDownloadingNow'));
  if (plan.length > 96) planLine.push(t('downloads.planShowingCap', { n: 96 }));

  return (
    <>
      <div className="prefsSection">
        <Label>{t('downloads.onThisDevice')}</Label>
        <div className="storageBreak__totals">
          <span className="storageBreak__big">{formatBytes(total)}</span>
          <Text size="sm" tone="muted">
            {/* Named separately for the same reason the bar is split: "1,204
                songs" over a shelf of audiobooks counts two unlike things as
                one. */}
            {tallies.join(' · ')}
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
                { value: musicBytes, tone: 'accent', label: t('downloads.kindMusic') },
                { value: bookBytes, tone: 'success', label: t('downloads.kindBooks') },
                /* Other files sit on `warning` so the gray stays with Free -
                   the kit has one gray, and the room left and the untracked
                   bytes have to stay tellable apart. Warning fits: files the
                   cache cannot manage are a state worth noticing, where empty
                   space is the absence of one. */
                { value: other, tone: 'warning', label: t('downloads.kindOther') },
                { value: empty, tone: 'neutral', label: t('downloads.kindFree') },
              ]}
              aria-label={t('downloads.spaceBarLabel')}
            />
            <div className="storageBreak__legend">
              {/* One entry per key rather than a label and a size sitting next
                  to each other, because the ` · ` between them is the sentence:
                  a translator needs to be able to put the size first. */}
              <span className="storageBreak__key" data-tone="accent">
                {kinds && kinds.music.pinnedBytes > 0
                  ? t('downloads.legendKept', {
                      label: t('downloads.kindMusic'),
                      size: formatBytes(musicBytes),
                      kept: formatBytes(kinds.music.pinnedBytes),
                    })
                  : t('downloads.legend', {
                      label: t('downloads.kindMusic'),
                      size: formatBytes(musicBytes),
                    })}
              </span>
              <span className="storageBreak__key" data-tone="success">
                {kinds && kinds.books.pinnedBytes > 0
                  ? t('downloads.legendKept', {
                      label: t('downloads.kindBooks'),
                      size: formatBytes(bookBytes),
                      kept: formatBytes(kinds.books.pinnedBytes),
                    })
                  : t('downloads.legend', {
                      label: t('downloads.kindBooks'),
                      size: formatBytes(bookBytes),
                    })}
              </span>
              {other > 0 && (
                <span className="storageBreak__key" data-tone="warning">
                  {t('downloads.legend', {
                    label: t('downloads.kindOther'),
                    size: formatBytes(other),
                  })}
                </span>
              )}
              {empty > 0 && (
                <span className="storageBreak__key" data-tone="neutral">
                  {t('downloads.legend', {
                    label: t('downloads.kindFree'),
                    size: formatBytes(empty),
                  })}
                </span>
              )}
            </div>
          </>
        ) : (
          <Text size="sm" tone="muted">
            {t('downloads.nothingStored')}
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
        {alsoHeld.length > 0 && (
          <Text size="xs" tone="subtle">
            {t('downloads.alsoHeld', { what: alsoHeld.join(' · ') })}
          </Text>
        )}
        {report && limit > 0 && (
          <>
            <Text size="xs" tone={report.failed > 0 || report.liked === -1 ? 'danger' : 'subtle'}>
              {/* `report.note` and the fail reasons below are written by
                  cacheSweep and arrive already-composed; they are the one part
                  of this receipt the catalogue does not own. */}
              {receipt.join(' · ')}
            </Text>
            {/* Said on its own line rather than left to the note, because the
                note leads with failures when there are any - and a full budget
                is exactly the case where nothing failed and songs are missing
                anyway. Names the remedy: this is the one shortfall on this
                screen the slider directly below actually fixes.

                One plural key, not a sentence assembled around a ternary: the
                "is/are" and the "it/them" are both the same grammatical number,
                so each plural form of the entry carries its own agreement. */}
            {(report.budgetShort ?? 0) > 0 && (
              <Text size="xs" tone="subtle">
                {t('downloads.budgetShort', { count: report.budgetShort })}
              </Text>
            )}
            {/* The note leads with the commonest failure; when the sweep hit
                MORE than one kind, the rest are listed so a mirror failing
                differently from the primary is two lines, not a mystery. */}
            {(report.failReasons?.length ?? 0) > 1 &&
              report.failReasons!.slice(1).map((r) => (
                <Text key={r.reason} size="xs" tone="danger">
                  {t('downloads.failReason', { n: r.n, reason: r.reason })}
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
                    {t('downloads.retryFailed')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => dismissSweepReport()}>
                  {t('common.dismiss')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="prefsSection">
        <Label>{t('downloads.automatic')}</Label>
        <Text size="sm" tone="muted">
          {t('downloads.automaticHint')}
        </Text>
        {/* Above the budget rather than below it, because this is what decides
            what a gigabyte holds: at 128k the same slider keeps about seven
            times the songs. Answering "how good" before "how much" means the
            number under the slider is already true when you read it. */}
        <Field label={t('downloads.quality')} hint={qualityHint(kbps, limit, t)}>
          <SegmentedControl
            aria-label={t('downloads.quality')}
            fullWidth
            value={String(kbps)}
            onValueChange={(next: string) => {
              const n = Number(next);
              setKbps(n);
              setCacheQualityKbps(n);
            }}
            /* `256k` and friends are a bitrate, not prose - the number IS the
               label, and the k is the unit every locale writes the same way. */
            options={QUALITY_CHOICES.map((q) => ({
              value: String(q),
              label: q === 0 ? t('downloads.lossless') : `${q}k`,
            }))}
          />
        </Field>

        {/* What the WHOLE library would cost at this quality, against the
            budget above it. The pane could say "15 GB" all day without ever
            answering the question people actually have - is that enough for
            everything, or am I choosing what to leave behind? */}
        {libraryEstimate && (
          <Text size="xs" tone="subtle">
            {t('downloads.libraryEstimate', {
              count: libraryEstimate.count,
              size: formatBytes(libraryEstimate.bytes),
            })}{' '}
            {limit === 0
              ? t('downloads.estimateOff')
              : libraryEstimate.bytes <= limit
                ? t('downloads.estimateFits')
                : t('downloads.estimatePartial', {
                    percent: formatNumber(limit / libraryEstimate.bytes, {
                      style: 'percent',
                      maximumFractionDigits: 0,
                    }),
                  })}
          </Text>
        )}

        {/* The slider runs over the curated stops, not raw gigabytes: a linear
            0-100 rail would cram the sizes people actually pick - 2 to 15 GB -
            into its first sixth. One detent per stop, Off at the left edge. */}
        <div className="cacheLimit">
          <Slider
            aria-label={t('downloads.budgetLabel')}
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
          <span className="cacheLimit__value">{gbLabel(limit, t)}</span>
        </div>

        {/* This used to be a paragraph apologising for the absence of the
            switch below it. The apology was the honest thing to write at the
            time and the wrong thing to leave standing. */}
        <div data-setting="wifi-only">
          <Switch
            label={t('downloads.wifiOnly')}
            checked={wifiOnly}
            onCheckedChange={(on: boolean) => {
              setWifiOnlyDownloads(on);
              setWifiOnly(on);
            }}
          />
          <Text size="xs" tone="subtle">
            {wifiOnlyText(wifiOnly, network, t)}
          </Text>
        </div>

        <div className="cacheActions">
          <Button size="sm" variant="soft" disabled={busy || !session || limit === 0} onClick={() => void update()}>
            {busy
              ? progress && progress.total > 0
                ? t('downloads.downloadingProgress', {
                    done: progress.done,
                    total: progress.total,
                  })
                : t('downloads.checking')
              : t('downloads.checkNow')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || (usage?.count ?? 0) === 0}
            onClick={() => {
              void clearCache().then(refresh);
            }}
          >
            {t('downloads.clearAutomatic')}
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
          <Label>{t('downloads.planTitle')}</Label>
          <Text size="sm" tone="muted">
            {t('downloads.planHint')}
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
                  title={tileTitle(e.title, e.artist, e.reason, e.state, t)}
                >
                  {e.art ? <img src={artSized(e.art, 160) ?? undefined} alt="" loading="lazy" /> : null}
                </span>
              ))}
          </div>
          <Text size="xs" tone="subtle">
            {planLine.join(' · ')}
          </Text>
        </div>
      )}
      {/* On an Android binary from before the bridge, the row still SHOWS -
          hiding it entirely read as the feature not existing at all. It says
          plainly that the app build is what is missing. */}
      {browsable === null && /Android/i.test(navigator.userAgent) && (
        <div className="storageBrowsable">
          <Text size="xs" tone="muted">
            {/* The folder name is a literal path segment inside the sentence,
                so it rides through as markup rather than as a hole a
                translator could helpfully translate. */}
            <Trans i18nKey="downloads.browsableSoon" components={{ b: <b /> }} />
          </Text>
        </div>
      )}
      {browsable !== null && (
        <div className="storageBrowsable">
          {vaultPath ? (
            <Text size="xs" tone="muted">
              <Trans i18nKey="downloads.browsablePath" components={{ b: <b /> }} />
              {migrated !== null ? ` ${t('downloads.filesMoved', { count: migrated })}` : ''}
            </Text>
          ) : (
            <>
              <Text size="xs" tone="muted">
                <Trans i18nKey="downloads.browsableAsk" components={{ b: <b /> }} />
              </Text>
              <Button
                variant="outline"
                size="sm"
                onClick={() => native?.requestVaultAccess?.()}
              >
                {t('downloads.allowFolder')}
              </Button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * A tile's tooltip: the song, then whatever the sweep has to say about it.
 *
 * The trailing clause is only sometimes there - a reason when the sweep wrote
 * one, otherwise the state, and nothing at all once the song has landed - so
 * it is a second entry wrapped around the first rather than an optional tail
 * inside one. The reason itself comes from cacheSweep already written.
 */
function tileTitle(
  title: string,
  artist: string,
  reason: string | undefined,
  state: keyof typeof ORDER,
  t: T,
): string {
  const main = t('downloads.planTile', { title, artist });
  const detail = reason ?? (state === 'done' ? null : t(STATE_KEYS[state]));
  return detail ? t('downloads.planTileDetail', { main, detail }) : main;
}

/** Failures first, then live work, then the queue, then the settled. */
const ORDER = { failed: 0, downloading: 1, waiting: 2, done: 3 } as const;

/** The manifest's states are storage values; these are how they read out loud.
 *  `done` has no entry - a landed song's tooltip says nothing extra. */
const STATE_KEYS: Record<Exclude<keyof typeof ORDER, 'done'>, string> = {
  failed: 'downloads.detailFailed',
  downloading: 'downloads.detailDownloading',
  waiting: 'downloads.detailWaiting',
};
