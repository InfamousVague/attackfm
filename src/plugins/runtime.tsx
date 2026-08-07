import {
  Component,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { PLUGINS } from './index.ts';
import { PluginsContext, usePlugins, type PluginsContextValue } from './pluginsContext.ts';
import type { PaletteContext, PluginCommand, PluginSlotId } from './types.ts';

export { usePlugins } from './pluginsContext.ts';

/**
 * The plugin runtime: who is running, where their pieces mount, and what
 * happens when one of them breaks. Core imports this; plugins never do (they
 * import types.ts), so the dependency arrow only points one way.
 */

// The switched-off ids persist as a plain list, the way the favourites do.
const STORAGE_KEY = 'attackfm-plugins-disabled';

// A malformed registry is a programmer error; fail at boot, loudly, rather
// than at the first toggle when duplicate storage keys start colliding. The
// colon is reserved as the namespace separator in palette command and settings
// section ids, so an id carrying one would let contributions collide across
// plugins the namespacing exists to keep apart.
for (const [index, plugin] of PLUGINS.entries()) {
  if (PLUGINS.findIndex((p) => p.id === plugin.id) !== index) {
    throw new Error(`[plugins] duplicate plugin id "${plugin.id}"`);
  }
  if (plugin.id.includes(':')) {
    throw new Error(`[plugins] plugin id "${plugin.id}" may not contain ":"`);
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
 * An error rethrown out of a plugin's hook, tagged with the plugin that threw
 * so the boundary above knows exactly which plugin to pull.
 */
class PluginCrashError extends Error {
  constructor(
    readonly pluginId: string,
    cause: unknown,
  ) {
    super(`Plugin "${pluginId}" crashed`, { cause });
  }
}

/**
 * Owns which plugins are running: the persisted switches plus a session-only
 * failure map. Sits above LibraryProvider - it needs nothing from the app,
 * and everything below it may ask what is enabled.
 */
export function PluginsProvider({ children }: { children: ReactNode }) {
  const [disabled, setDisabled] = useState<string[]>(readDisabled);
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());

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
    const enabled = PLUGINS.filter((p) => !disabled.includes(p.id) && !failures.has(p.id));
    return {
      all: PLUGINS,
      enabled,
      enabledKey: JSON.stringify(enabled.map((p) => p.id)),
      isEnabled: (id) => !disabled.includes(id),
      setEnabled,
      failures,
      reportCrash,
    };
  }, [disabled, failures, setEnabled, reportCrash]);

  return <PluginsContext.Provider value={value}>{children}</PluginsContext.Provider>;
}

interface PluginBoundaryProps {
  /** Attribute untagged errors to this plugin; tagged errors name their own. */
  pluginId?: string;
  /** Rendered in place of the crashed subtree. Nothing, by default. */
  fallback?: ReactNode;
  onCrash: (id: string, error: unknown) => void;
  children: ReactNode;
}

interface PluginBoundaryState {
  failed: boolean;
  error: unknown;
}

/**
 * The one error boundary in the system. It reports the crash - which removes
 * the plugin from `enabled` - and shows the fallback until the tree it sits
 * in re-renders without the plugin, which the state change it just caused
 * takes care of.
 */
class PluginBoundary extends Component<PluginBoundaryProps, PluginBoundaryState> {
  override state: PluginBoundaryState = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): PluginBoundaryState {
    return { failed: true, error };
  }

  override componentDidCatch(error: Error): void {
    const id = error instanceof PluginCrashError ? error.pluginId : this.props.pluginId;
    if (id) this.props.onCrash(id, error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    // An error naming no plugin is not ours to eat: rethrow during render so
    // it unwinds to the root exactly as it would without this boundary.
    if (!(this.state.error instanceof PluginCrashError) && this.props.pluginId === undefined) {
      throw this.state.error;
    }
    return this.props.fallback ?? null;
  }
}

/** A crash fence wired to the registry, so call sites do not re-plumb onCrash. */
export function PluginFence({
  pluginId,
  fallback,
  children,
}: {
  pluginId: string;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { reportCrash } = usePlugins();
  return (
    <PluginBoundary pluginId={pluginId} onCrash={reportCrash} fallback={fallback}>
      {children}
    </PluginBoundary>
  );
}

// True only under a PluginHookScope. usePluginCommands refuses to run outside
// one, so the mistake fails on the first render, not on the first toggle.
const HookScopeContext = createContext(false);

/**
 * Remounts its subtree whenever the set of running plugins changes. Anything
 * that calls plugin hooks inline (usePluginCommands) must live under one of
 * these: React only requires hook order to be stable per component instance,
 * so replacing the instance is what makes a variable-length run of plugin
 * hooks legal. It also catches tagged crashes thrown out of those hooks.
 * Keep it as low in the tree as possible - everything under it loses state
 * on toggle.
 */
export function PluginHookScope({ children }: { children: ReactNode }) {
  const { enabledKey, reportCrash } = usePlugins();
  return (
    <PluginBoundary key={enabledKey} onCrash={reportCrash}>
      <HookScopeContext.Provider value={true}>{children}</HookScopeContext.Provider>
    </PluginBoundary>
  );
}

interface CoreBoundaryState {
  failed: boolean;
}

/**
 * Catches the app's own render crashes before they can climb into a plugin's
 * fence. A boundary only sees throws from below it, so seating this between
 * the provider chain and the app content means a core crash - the player
 * choking on a track, say - is reported as the app's rather than pinned on
 * whichever plugin's provider happens to wrap it, while a throw from a
 * plugin's own Provider still originates above this and hits that plugin's
 * fence. It renders nothing rather than rethrowing: a render-phase rethrow
 * would climb back into the fences this exists to shield.
 */
class CoreBoundary extends Component<{ children: ReactNode }, CoreBoundaryState> {
  override state: CoreBoundaryState = { failed: false };

  static getDerivedStateFromError(): CoreBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    console.error('[app] render crash (not a plugin)', error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The enabled plugins' Providers, nested in registration order (first
 * registered outermost). Sits inside LibraryProvider so a plugin's provider
 * may call useLibrary. A crashed provider falls back to its children, so the
 * app carries on minus that plugin - whose own UI leaves with it on the next
 * commit. Toggling a provider-bearing plugin changes the wrapper structure,
 * which remounts the subtree below: playback stops and the current track
 * reloads. App state (nav, current, open modals) lives above and survives;
 * the Plugins settings copy owns the cost.
 */
export function PluginProviders({ children }: { children: ReactNode }) {
  const { enabled } = usePlugins();
  // The core's own boundary seeds the fold, so app content crashes stop here
  // instead of being blamed on the innermost provider-bearing plugin.
  const guarded = <CoreBoundary>{children}</CoreBoundary>;
  return (
    <>
      {enabled.reduceRight<ReactNode>((inner, p) => {
        if (!p.Provider) return inner;
        return (
          <PluginFence key={p.id} pluginId={p.id} fallback={inner}>
            <p.Provider>{inner}</p.Provider>
          </PluginFence>
        );
      }, guarded)}
    </>
  );
}

/**
 * One of the chrome's fixed mount points: every enabled plugin's component
 * for the slot, in registration order, each behind its own fence so one
 * crashing removes only itself (and flags its plugin).
 */
export function PluginSlot({ id }: { id: PluginSlotId }) {
  const { enabled } = usePlugins();
  return (
    <>
      {enabled.map((p) => {
        const Item = p.slots?.[id];
        if (!Item) return null;
        return (
          <PluginFence key={p.id} pluginId={p.id}>
            <Item />
          </PluginFence>
        );
      })}
    </>
  );
}

/** A palette row as the runtime hands it to SongSearch: id already namespaced. */
export interface PaletteCommandRow {
  id: string;
  label: string;
  group?: string;
  keywords?: string;
}

export interface PalettePluginCommands {
  commands: PaletteCommandRow[];
  /** True when some plugin claimed the query outright (a pasted link, say). */
  exclusive: boolean;
  /** Runs a plugin command by palette id; false when the id is not a plugin's. */
  run: (id: string) => boolean;
}

/**
 * Collects every enabled plugin's palette commands for the current query.
 *
 * Hook order: this loops over `enabled` calling plugin hooks, which is only
 * legal because the caller sits under a PluginHookScope - `enabled` cannot
 * change without changing the scope's key, so the sequence of hook calls is
 * fixed for the life of any instance. The scope check below turns a call
 * site that forgot the scope into an immediate render error instead of a
 * latent hook-corruption bug. A plugin hook that throws has already spent
 * hook slots, so the render is not salvageable past it: the error is tagged
 * and rethrown for the scope's boundary, which pulls the plugin and remounts
 * the scope with a clean slate.
 */
export function usePluginCommands(ctx: PaletteContext): PalettePluginCommands {
  const { enabled } = usePlugins();
  const inScope = useContext(HookScopeContext);
  if (!inScope) throw new Error('usePluginCommands must render under a PluginHookScope');

  const commands: PaletteCommandRow[] = [];
  const runs = new Map<string, { pluginId: string; fn: () => void }>();
  let exclusive = false;
  for (const p of enabled) {
    if (!p.usePaletteCommands) continue;
    let cmds: readonly PluginCommand[];
    try {
      // A fixed sequence per mount - the scope's key sees to it; see above.
      cmds = p.usePaletteCommands(ctx);
    } catch (error) {
      throw new PluginCrashError(p.id, error);
    }
    for (const c of cmds) {
      const id = `plugin:${p.id}:${c.id}`;
      // A repeated id would show two rows and run one handler; name the
      // plugin now rather than letting the collision pass as flakiness.
      if (runs.has(id)) console.warn(`[plugins] "${p.id}" repeated palette command id "${c.id}"`);
      commands.push({ id, label: c.label, group: c.group, keywords: c.keywords });
      runs.set(id, { pluginId: p.id, fn: c.run });
      if (c.exclusive) exclusive = true;
    }
  }
  return {
    commands,
    exclusive,
    run: (id) => {
      const entry = runs.get(id);
      if (!entry) return false;
      try {
        entry.fn();
      } catch (error) {
        // Boundaries never see handler throws; contain the dispatch so a bad
        // command cannot strand the palette, and name the plugin in the log.
        console.error(`[plugins] "${entry.pluginId}" palette command failed`, error);
      }
      return true;
    },
  };
}

/** What SettingsModal spreads into TabbedModal's sections. */
export interface ResolvedSettingsSection {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
}

/**
 * The enabled plugins' settings tabs, shaped for TabbedModal. This maps over
 * static data - it calls no plugin hooks - so it is safe anywhere below the
 * PluginsProvider with no scope needed, and the modal survives a toggle
 * without remounting out from under the user.
 */
export function usePluginSettingsSections(): ResolvedSettingsSection[] {
  const { enabled } = usePlugins();
  return enabled.flatMap((p) =>
    (p.settingsSections ?? []).map((s) => ({
      id: `${p.id}:${s.id}`,
      label: s.label,
      icon: s.icon,
      content: (
        <PluginFence pluginId={p.id}>
          <s.Content />
        </PluginFence>
      ),
    })),
  );
}
