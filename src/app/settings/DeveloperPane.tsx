import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Pill, Spinner, Switch, Text, useToast } from '@glacier/react';
import { Copy, HardDrive, RefreshCw, RotateCcw, Trash2, Wrench } from 'lucide-react';
import { PaneSection, SettingRow, SettingsCallout } from './kit/settingsKit.tsx';
import { setDeveloperMode, useDeveloperMode } from './developerMode.ts';
import {
  bundleState,
  checkForUpdate,
  currentVersion,
  revertToEmbedded,
  runningBundle,
} from './appUpdate.ts';
import type { BundleState } from './appUpdate.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { isAndroid, isIOS, isMobile } from '../core/platform.ts';
import { isTauri } from '../core/tauri.ts';
import { translate, useT } from '../i18n/LocaleShell.tsx';
import { formatBytes, formatNumber } from '../ux/format.ts';

/**
 * The Developer page. Unlocked by seventeen presses on the wordmark in About,
 * then a Settings section of its own under About for as long as the switch at
 * the top stays on.
 *
 * WHAT BELONGS HERE. The questions you cannot answer from the outside of a
 * phone you cannot attach a debugger to: which frontend is actually running,
 * what the native side thinks about it, what this device is, how much it has
 * stored and where. Every one of these has been guessed at in a chat message
 * at some point, and a guess about which bundle is running is how an hour goes
 * into a CSS bug that was really a half-applied update.
 *
 * WHAT DOES NOT. Anything that is a real setting for a real person - those
 * belong in their own pane, visible, not behind a knock. This page is a window
 * and, in one section at the bottom, a hammer.
 */

/** What localStorage is holding, which is where nearly all of this app's
 *  client state lives - so "the app is behaving strangely" is often here. */
function localStorageReport(): { keys: number; bytes: number; top: [string, number][] } {
  try {
    const entries: [string, number][] = [];
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      // The value's own length plus the key's: close enough, and the exact
      // figure is never the point - the shape of it is.
      const n = (localStorage.getItem(key)?.length ?? 0) + key.length;
      bytes += n;
      entries.push([key, n]);
    }
    entries.sort((a, b) => b[1] - a[1]);
    return { keys: entries.length, bytes, top: entries.slice(0, 6) };
  } catch {
    return { keys: 0, bytes: 0, top: [] };
  }
}

export function DeveloperPane() {
  const t = useT();
  const on = useDeveloperMode();
  const { session } = useServerSession();
  const { toast } = useToast();
  const [bundle, setBundle] = useState<BundleState | null>(null);
  const [asked, setAsked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [ping, setPing] = useState<string | null>(null);
  const [storage, setStorage] = useState(() => localStorageReport());
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    // Set on the way in as well as cleared on the way out - see the note in
    // LocalAiPane. A ref that is only ever cleared stays cleared across
    // development's double mount, and every guarded setState is then dropped.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const readBundle = useCallback(async () => {
    // NOTE: bundle_state is not a passive read on the native side - it settles
    // the boot wager and can quarantine an unsettled one. By the time this pane
    // can be opened the app is long since up and the wager is settled, so it is
    // safe HERE and would not be from anywhere that runs at launch.
    const next = await bundleState();
    if (!alive.current) return;
    setBundle(next);
    setAsked(true);
  }, []);

  useEffect(() => {
    void readBundle();
    if (navigator.storage?.estimate) {
      void navigator.storage.estimate().then((e) => {
        if (alive.current) setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
      });
    }
  }, [readBundle]);

  const running = runningBundle();
  const embedded = currentVersion();

  const check = async () => {
    setChecking(true);
    setOutcome(null);
    try {
      const result = await checkForUpdate();
      if (!alive.current) return;
      setOutcome(
        result.state === 'staged'
          ? t('settings.devUpdateStaged', { version: result.version })
          : result.state === 'current'
            ? t('settings.devUpdateCurrent', { version: result.version })
            : result.why,
      );
      void readBundle();
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const pingServer = async () => {
    if (!session) return;
    setPing('…');
    const started = performance.now();
    try {
      const res = await fetch(`${session.url}/api/server`, { cache: 'no-store' });
      const ms = Math.round(performance.now() - started);
      // The number goes through Intl and the sentence through the catalogue:
      // the digits, the grouping and the word order are three different
      // decisions and only the last one is ours.
      if (alive.current) {
        setPing(
          res.ok
            ? t('settings.devPingOk', { ms: formatNumber(ms) })
            : t('settings.devPingStatus', { status: res.status, ms: formatNumber(ms) }),
        );
      }
    } catch {
      if (alive.current) setPing(t('settings.devPingUnreachable'));
    }
  };

  const copyReport = async () => {
    const report = {
      app: { embedded, running: running ?? '(embedded)', tauri: isTauri() },
      bundle,
      device: {
        platform: isAndroid ? 'android' : isIOS ? 'ios' : isMobile ? 'mobile' : 'desktop',
        screen: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}`,
        viewport: `${window.innerWidth}×${window.innerHeight}`,
        ua: navigator.userAgent,
        lang: navigator.language,
      },
      server: session ? { url: session.url, admin: session.isAdmin } : null,
      storage: { keys: storage.keys, bytes: storage.bytes, quota },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast({ message: t('settings.devReportCopied') });
    } catch {
      toast({ message: t('settings.devReportFailed'), tone: 'danger' });
    }
  };

  return (
    <div className="prefsBody devPane">
      <PaneSection
        title={t('settings.developerMode')}
        description={t('settings.devModeOffAgain')}
      >
        <SettingRow
          id="dev-mode"
          label={t('settings.developerMode')}
          icon={<Wrench size={16} />}
          hint={t('settings.devModeHint')}
          control={
            <Switch
              checked={on}
              onCheckedChange={(v) => setDeveloperMode(v)}
              aria-label={t('settings.developerMode')}
            />
          }
        />
      </PaneSection>

      <PaneSection
        title={t('settings.devFrontendTitle')}
        description={t('settings.devFrontendBody')}
        footer={
          <div className="devPane__actions">
            <Button size="sm" variant="soft" disabled={checking} onClick={() => void check()}>
              {checking ? <Spinner size="sm" /> : <><RefreshCw size={14} /> {t('settings.devCheckForUpdates')}</>}
            </Button>
            {running && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { void revertToEmbedded().then(() => window.location.reload()); }}
              >
                <RotateCcw size={14} /> {t('settings.devRevertToEmbedded')}
              </Button>
            )}
          </div>
        }
      >
        <SettingRow
          id="dev-running"
          label={t('settings.devRunning')}
          hint={running ? t('settings.devRunningDownloaded') : t('settings.devRunningEmbedded')}
          value={
            <Pill size="sm" variant="soft" tone={running ? 'accent' : 'neutral'}>
              {running ?? t('settings.devEmbeddedVersion', { version: embedded })}
            </Pill>
          }
        />
        <SettingRow
          id="dev-embedded"
          label={t('settings.devEmbeddedFloor')}
          hint={t('settings.devEmbeddedFloorHint')}
          value={embedded}
        />
        {asked && (
          <>
            <SettingRow
              id="dev-active"
              label={t('settings.devActiveBundle')}
              value={bundle?.active ?? t('settings.devNone')}
            />
            <SettingRow
              id="dev-native-gen"
              label={t('settings.devNativeGeneration')}
              hint={t('settings.devNativeGenerationHint')}
              value={String(bundle?.nativeGeneration ?? '—')}
            />
            <SettingRow
              id="dev-quarantined"
              label={t('settings.devQuarantined')}
              hint={t('settings.devQuarantinedHint')}
              value={
                bundle?.quarantined.length
                  ? <span className="devPane__quarantine">{bundle.quarantined.map((v) => <Pill key={v} size="sm" variant="soft" tone="danger">{v}</Pill>)}</span>
                  : t('settings.devNone')
              }
            />
            {!!bundle?.quarantined.length && (
              <SettingsCallout tone="warning">{t('settings.devQuarantineStuck')}</SettingsCallout>
            )}
          </>
        )}
        {outcome && <Text tone="muted" size="sm">{outcome}</Text>}
      </PaneSection>

      <PaneSection title={t('settings.devDevice')} description={t('settings.devDeviceBody')}>
        <SettingRow
          id="dev-platform"
          label={t('settings.devPlatform')}
          value={(() => {
            // Two decisions, not one: which shell this is, and whether it is
            // running inside a browser tab rather than the native wrapper.
            // Joined by the catalogue so a language that words the aside
            // differently - or puts it first - can.
            const shell = isAndroid
              ? t('settings.devPlatformAndroid')
              : isIOS
                ? t('settings.devPlatformIos')
                : isMobile
                  ? t('settings.devPlatformMobile')
                  : t('settings.devPlatformDesktop');
            return isTauri() ? shell : t('settings.devPlatformInBrowser', { shell });
          })()}
        />
        {/* Pixel dimensions, left as digits and symbols: there is no prose in
            "390×844 @3×" for a translator to move. */}
        <SettingRow id="dev-screen" label={t('settings.devScreen')} value={`${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}×`} />
        <SettingRow id="dev-viewport" label={t('settings.devViewport')} value={`${window.innerWidth}×${window.innerHeight}`} />
        <SettingRow
          id="dev-safe"
          label={t('settings.devSafeInsets')}
          hint={t('settings.devSafeInsetsHint')}
          value={(() => {
            const cs = getComputedStyle(document.documentElement);
            const px = (name: string) => cs.getPropertyValue(name).trim() || '0px';
            return `${px('--app-safe-top')} / ${px('--app-safe-bottom')}`;
          })()}
        />
        <SettingRow
          id="dev-chrome"
          label={t('settings.devChromeHeights')}
          hint={t('settings.devChromeHeightsHint')}
          value={(() => {
            const cs = getComputedStyle(document.documentElement);
            const px = (name: string) => cs.getPropertyValue(name).trim() || '—';
            return `${px('--app-header-height')} · ${px('--app-player-height')} · ${px('--app-nav-height')}`;
          })()}
        />
      </PaneSection>

      <PaneSection
        title={t('settings.devServer')}
        description={t('settings.devServerBody')}
        footer={<Button size="sm" variant="soft" onClick={() => void pingServer()}>{t('settings.devPing')}</Button>}
      >
        <SettingRow id="dev-server-url" label={t('settings.devServer')} value={session?.url ?? t('settings.devSignedOut')} />
        <SettingRow
          id="dev-server-admin"
          label={t('settings.devThisAccount')}
          value={session ? (session.isAdmin ? t('settings.devRoleOwner') : t('settings.devRoleMember')) : '—'}
        />
        <SettingRow
          id="dev-server-token"
          label={t('settings.devSessionToken')}
          hint={t('settings.devSessionTokenHint')}
          value={session?.token ? t('settings.devTokenHeld') : t('settings.devNone')}
        />
        {ping && <SettingRow id="dev-server-ping" label={t('settings.devRoundTrip')} value={ping} />}
      </PaneSection>

      <PaneSection
        title={t('settings.devStorage')}
        description={t('settings.devStorageBody')}
        footer={
          <Button size="sm" variant="soft" onClick={() => setStorage(localStorageReport())}>
            <HardDrive size={14} /> {t('settings.devRemeasure')}
          </Button>
        }
      >
        {/* Counted rather than concatenated: "1 key" and "2 keys" is a plural
            form, and the languages this ships in do not all have two of them. */}
        <SettingRow
          id="dev-ls"
          label="localStorage"
          value={t('settings.devKeysAndSize', { count: storage.keys, size: formatBytes(storage.bytes) })}
        />
        {quota && (
          <SettingRow
            id="dev-quota"
            label={t('settings.devOriginUsage')}
            hint={t('settings.devOriginUsageHint')}
            value={
              quota.quota
                ? t('settings.devUsedOf', { used: formatBytes(quota.usage), total: formatBytes(quota.quota) })
                : formatBytes(quota.usage)
            }
          />
        )}
        {storage.top.map(([key, n]) => (
          <SettingRow key={key} id={`dev-ls-${key}`} label={key} value={formatBytes(n)} />
        ))}
      </PaneSection>

      <PaneSection
        title={t('settings.devHammers')}
        description={t('settings.devHammersBody')}
        tone="danger"
      >
        <SettingRow
          id="dev-copy-report"
          label={t('settings.devCopyReport')}
          hint={t('settings.devCopyReportHint')}
          onPress={() => void copyReport()}
          control={<Copy size={16} />}
        />
        <SettingRow
          id="dev-reload"
          label={t('settings.devReloadFrontend')}
          hint={t('settings.devReloadFrontendHint')}
          onPress={() => window.location.reload()}
          control={<RefreshCw size={16} />}
        />
        <SettingRow
          id="dev-clear-caches"
          label={t('settings.devEmptyCaches')}
          hint={t('settings.devEmptyCachesHint')}
          danger
          onPress={() => {
            void caches
              .keys()
              .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
              .then(() => toast({ message: t('settings.devCachesEmptied') }))
              .catch(() => toast({ message: t('settings.devCachesFailed'), tone: 'danger' }));
          }}
          control={<Trash2 size={16} />}
        />
      </PaneSection>
    </div>
  );
}

/** The rail row's second line, for SettingsModal. Read at render by the rail
 *  rather than inside a component of ours, so it uses the non-reactive
 *  translate(); the rail re-renders on a language change and calls it again. */
export function developerSummary(): string {
  return translate('settings.devSummary');
}
