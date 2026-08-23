import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PREFS_ADOPTED } from '../../app/servers/prefsSync.ts';
import { availablePlugins, filterAvailable, registeredIds } from '../index.ts';
import {
  ensureDefaultPlugins,
  loadInstalledPlugins,
  pruneDeprecatedPlugins,
  readInstalled,
  restoreWanted,
} from '../remote.ts';
import { useServerSession } from '../../app/servers/serverSession.tsx';
import { PluginsContext, type PluginsContextValue } from '../pluginsContext.ts';
import type { Plugin } from '../types.ts';

// The switched-off ids persist as a plain list, the way the favourites do.
const STORAGE_KEY = 'attackfm-plugins-disabled';

// A malformed registry is a programmer error; fail at boot, loudly, rather
// than at the first toggle when duplicate storage keys start colliding. The
// colon is reserved as the namespace separator in palette command and settings
// section ids, so an id carrying one would let contributions collide across
// plugins the namespacing exists to keep apart. Checked against the full
// registry (both connection states), so a validation cannot depend on whether
// a server happens to be connected.
// NOTE: this is a module-load side effect. It fires at app boot because the
// runtime barrel (runtime.tsx) re-exports PluginsProvider from this module,
// so importing the barrel evaluates this file.
{
  const ALL = availablePlugins(true);
  for (const [index, plugin] of ALL.entries()) {
    if (ALL.findIndex((p) => p.id === plugin.id) !== index) {
      throw new Error(`[plugins] duplicate plugin id "${plugin.id}"`);
    }
    if (plugin.id.includes(':')) {
      throw new Error(`[plugins] plugin id "${plugin.id}" may not contain ":"`);
    }
  }
}

function readDisabled(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Owns which plugins are running: the persisted switches plus a session-only
 * failure map. Sits above LibraryProvider - it needs nothing from the app,
 * and everything below it may ask what is enabled.
 */
export function PluginsProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const [disabled, setDisabled] = useState<string[]>(readDisabled);
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  // The remotely-installed plugins, evaluated from their stored bundles once
  // at boot and again whenever the marketplace changes the installed set. A
  // bundle that fails to evaluate lands in remoteState.failures instead of
  // taking the provider down.
  const [remoteState, setRemoteState] = useState(() => loadInstalledPlugins());
  const reloadRemote = useCallback(() => setRemoteState(loadInstalledPlugins()), []);

  // Bring the default plugins in on first run - and, for the ones only the hub
  // carries (the audiobook downloader), the moment a server connects. Each
  // install persists and the check skips what is already there or was removed,
  // so this settles to a no-op; when it does land something, reload to show it.
  const hubUrl = session?.url;
  useEffect(() => {
    let cancelled = false;
    // Drop anything a core feature has replaced (the old audiobooks plugin),
    // then bring the defaults in.
    const pruned = pruneDeprecatedPlugins();
    if (pruned) reloadRemote();
    const hub = hubUrl ? `${hubUrl.replace(/\/+$/, '')}/plugins` : undefined;
    void ensureDefaultPlugins(hub ? [hub] : []).then((installed) => {
      if (installed && !cancelled) reloadRemote();
    });

    /*
     * Plugins this ACCOUNT wants that this DEVICE has not got.
     *
     * Runs on mount for a device that already carries the list, and again when
     * a sync adopts it - which is the case that matters, because signing in on
     * a new phone brings the wanted list down some seconds AFTER this provider
     * first mounts, and a one-shot pass here would always be too early.
     */
    const restore = () => {
      void restoreWanted().then((landed) => {
        if (landed.length > 0 && !cancelled) reloadRemote();
      });
    };
    restore();
    window.addEventListener(PREFS_ADOPTED, restore);

    return () => {
      cancelled = true;
      window.removeEventListener(PREFS_ADOPTED, restore);
    };
  }, [hubUrl, reloadRemote]);

  // An evaluation failure surfaces exactly like a crash: on the plugin's card,
  // with the message. Re-merged on every reload so a fixed bundle clears.
  useEffect(() => {
    if (remoteState.failures.size === 0) return;
    setFailures((prev) => {
      const next = new Map(prev);
      for (const [id, message] of remoteState.failures) next.set(id, message);
      return next;
    });
  }, [remoteState]);

  // Re-derived on connect/disconnect: a server-backed plugin appears once a
  // hub can run it. Memoised on the boolean, not the session object, so a
  // token renewal does not churn the list. Remote plugins append after the
  // compiled-in set, in install order, and a remote id colliding with a
  // compiled-in one is dropped - the compiled-in plugin is authoritative.
  const plugins = useMemo<readonly Plugin[]>(() => {
    const compiled = availablePlugins(session !== null);
    const taken = registeredIds();
    const remote = filterAvailable(
      remoteState.plugins.filter((p) => !taken.has(p.id)),
      session !== null,
    );
    return [...compiled, ...remote];
  }, [session !== null, remoteState]);

  // What the marketplace shows against a card that came from a repository.
  const remoteInstalled = useMemo(() => {
    const meta = new Map<string, { version: string; source: string }>();
    for (const p of readInstalled()) meta.set(p.id, { version: p.version, source: p.source });
    return meta;
    // Re-read alongside the evaluated set - same store, same trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteState]);

  const setEnabled = useCallback((id: string, on: boolean) => {
    setDisabled((prev) => {
      const next = on ? prev.filter((p) => p !== id) : prev.includes(id) ? prev : [...prev, id];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable - the switch still applies for this session.
      }
      return next;
    });
    // Either flip of the switch clears the crash flag: toggling is the retry.
    setFailures((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const reportCrash = useCallback((id: string, error: unknown) => {
    console.error(`[plugins] "${id}" crashed and is off until toggled or relaunch`, error);
    setFailures((prev) => {
      if (prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, error instanceof Error ? error.message : String(error));
      return next;
    });
  }, []);

  const value = useMemo<PluginsContextValue>(() => {
    const enabled = plugins.filter((p) => !disabled.includes(p.id) && !failures.has(p.id));
    return {
      all: plugins,
      enabled,
      enabledKey: JSON.stringify(enabled.map((p) => p.id)),
      isEnabled: (id) => !disabled.includes(id),
      setEnabled,
      failures,
      reportCrash,
      remoteInstalled,
      reloadRemote,
    };
  }, [plugins, disabled, failures, setEnabled, reportCrash, remoteInstalled, reloadRemote]);

  return <PluginsContext.Provider value={value}>{children}</PluginsContext.Provider>;
}
