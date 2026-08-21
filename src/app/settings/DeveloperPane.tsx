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

/** Bytes, in the shortest honest form. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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

  useEffect(() => () => { alive.current = false; }, []);

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
          ? `Installed ${result.version} — restart to run it`
          : result.state === 'current'
            ? `Already on ${result.version}`
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
      if (alive.current) setPing(res.ok ? `${ms}ms` : `${res.status} after ${ms}ms`);
    } catch {
      if (alive.current) setPing('unreachable');
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
      toast({ message: 'Report copied' });
    } catch {
      toast({ message: 'Could not reach the clipboard', tone: 'danger' });
    }
  };

  return (
    <div className="prefsBody devPane">
      <PaneSection
        title="Developer mode"
        description="Off again, and this page and Diagnostics disappear until the next seventeen taps."
      >
        <SettingRow
          id="dev-mode"
          label="Developer mode"
          icon={<Wrench size={16} />}
          hint="Shows this page and Diagnostics in Settings."
          control={<Switch checked={on} onCheckedChange={(v) => setDeveloperMode(v)} aria-label="Developer mode" />}
        />
      </PaneSection>

      <PaneSection
        title="Which frontend is running"
        description="The app updates itself over the air, so the code on screen is often not the code the installed binary shipped with. This is the first thing to check when a fix “did not land”."
        footer={
          <div className="devPane__actions">
            <Button size="sm" variant="soft" disabled={checking} onClick={() => void check()}>
              {checking ? <Spinner size="sm" /> : <><RefreshCw size={14} /> Check for updates</>}
            </Button>
            {running && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { void revertToEmbedded().then(() => window.location.reload()); }}
              >
                <RotateCcw size={14} /> Revert to embedded
              </Button>
            )}
          </div>
        }
      >
        <SettingRow
          id="dev-running"
          label="Running"
          hint={running ? 'A downloaded bundle.' : 'The frontend the installed app shipped with.'}
          value={<Pill size="sm" variant="soft" tone={running ? 'accent' : 'neutral'}>{running ?? `${embedded} (embedded)`}</Pill>}
        />
        <SettingRow id="dev-embedded" label="Embedded floor" hint="What a revert falls back to." value={embedded} />
        {asked && (
          <>
            <SettingRow id="dev-active" label="Active bundle" value={bundle?.active ?? 'none'} />
            <SettingRow
              id="dev-native-gen"
              label="Native generation"
              hint="A bundle needing a higher one is refused — that is the guard that keeps new JS off an old binary."
              value={String(bundle?.nativeGeneration ?? '—')}
            />
            <SettingRow
              id="dev-quarantined"
              label="Quarantined"
              hint="Versions that failed to boot here. They are refused for good, so a number listed here will never install again."
              value={
                bundle?.quarantined.length
                  ? <span className="devPane__quarantine">{bundle.quarantined.map((v) => <Pill key={v} size="sm" variant="soft" tone="danger">{v}</Pill>)}</span>
                  : 'none'
              }
            />
            {!!bundle?.quarantined.length && (
              <SettingsCallout tone="warning">
                Clearing this list needs a native command that does not exist yet, so a quarantined
                version stays refused until the app is rebuilt. Shipping a higher version number is
                the way past it.
              </SettingsCallout>
            )}
          </>
        )}
        {outcome && <Text tone="muted" size="sm">{outcome}</Text>}
      </PaneSection>

      <PaneSection title="This device" description="What the layout and the feature gates are actually seeing.">
        <SettingRow
          id="dev-platform"
          label="Platform"
          value={`${isAndroid ? 'Android' : isIOS ? 'iOS' : isMobile ? 'mobile' : 'desktop'}${isTauri() ? '' : ' · browser'}`}
        />
        <SettingRow id="dev-screen" label="Screen" value={`${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}×`} />
        <SettingRow id="dev-viewport" label="Viewport" value={`${window.innerWidth}×${window.innerHeight}`} />
        <SettingRow
          id="dev-safe"
          label="Safe insets"
          hint="Read off the live custom properties — the notch and the home indicator, as the stylesheet sees them."
          value={(() => {
            const cs = getComputedStyle(document.documentElement);
            const px = (name: string) => cs.getPropertyValue(name).trim() || '0px';
            return `${px('--app-safe-top')} / ${px('--app-safe-bottom')}`;
          })()}
        />
        <SettingRow
          id="dev-chrome"
          label="Header / player / nav"
          hint="The three heights every page's bottom padding is calculated from."
          value={(() => {
            const cs = getComputedStyle(document.documentElement);
            const px = (name: string) => cs.getPropertyValue(name).trim() || '—';
            return `${px('--app-header-height')} · ${px('--app-player-height')} · ${px('--app-nav-height')}`;
          })()}
        />
      </PaneSection>

      <PaneSection
        title="Server"
        description="Where this device is signed in, and how far away it is."
        footer={<Button size="sm" variant="soft" onClick={() => void pingServer()}>Ping</Button>}
      >
        <SettingRow id="dev-server-url" label="Server" value={session?.url ?? 'signed out'} />
        <SettingRow id="dev-server-admin" label="This account" value={session ? (session.isAdmin ? 'owner' : 'member') : '—'} />
        <SettingRow
          id="dev-server-token"
          label="Session token"
          hint="Never shown — only whether there is one."
          value={session?.token ? 'held' : 'none'}
        />
        {ping && <SettingRow id="dev-server-ping" label="Round trip" value={ping} />}
      </PaneSection>

      <PaneSection
        title="Storage"
        description="Nearly all of this app’s client state is in localStorage. A key that has grown enormous is usually the answer to “why is launch slow”."
        footer={
          <Button size="sm" variant="soft" onClick={() => setStorage(localStorageReport())}>
            <HardDrive size={14} /> Re-measure
          </Button>
        }
      >
        <SettingRow id="dev-ls" label="localStorage" value={`${storage.keys} keys · ${size(storage.bytes)}`} />
        {quota && (
          <SettingRow
            id="dev-quota"
            label="Origin usage"
            hint="Everything the web layer holds: caches, IndexedDB, the offline library."
            value={`${size(quota.usage)}${quota.quota ? ` of ${size(quota.quota)}` : ''}`}
          />
        )}
        {storage.top.map(([key, n]) => (
          <SettingRow key={key} id={`dev-ls-${key}`} label={key} value={size(n)} />
        ))}
      </PaneSection>

      <PaneSection
        title="Hammers"
        description="Each of these throws something away. None of them touch your music, which lives on the server."
        tone="danger"
      >
        <SettingRow
          id="dev-copy-report"
          label="Copy a diagnostic report"
          hint="Everything on this page as JSON, for pasting into a bug report."
          onPress={() => void copyReport()}
          control={<Copy size={16} />}
        />
        <SettingRow
          id="dev-reload"
          label="Reload the frontend"
          hint="Re-runs the boot loader without reinstalling anything."
          onPress={() => window.location.reload()}
          control={<RefreshCw size={16} />}
        />
        <SettingRow
          id="dev-clear-caches"
          label="Empty the web caches"
          hint="Artwork and offline responses. They rebuild as you use the app."
          danger
          onPress={() => {
            void caches
              .keys()
              .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
              .then(() => toast({ message: 'Caches emptied' }))
              .catch(() => toast({ message: 'Could not empty the caches', tone: 'danger' }));
          }}
          control={<Trash2 size={16} />}
        />
      </PaneSection>
    </div>
  );
}

/** The rail row's second line, for SettingsModal. */
export function developerSummary(): string {
  return 'Bundles, this device, storage and hammers';
}
