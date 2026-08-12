import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button, Modal } from '@glacier/react';
import { availablePlugins, filterAvailable, registeredIds } from './index.ts';
import {
  ensureDefaultPlugins,
  loadInstalledPlugins,
  pruneDeprecatedPlugins,
  readInstalled,
} from './remote.ts';
import { useServerSession } from '../app/serverSession.tsx';
import { useDownloadsOptional } from './importsBridge.ts';
import { PluginsContext, usePlugins, type PluginsContextValue } from './pluginsContext.ts';
import type {
  AcquireHandler,
  AcquireTarget,
  DownloadItem,
  PaletteContext,
  Plugin,
  PluginCommand,
  PluginPageProps,
  PluginSlotId,
} from './types.ts';

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
// plugins the namespacing exists to keep apart. Checked against the full
// registry (both connection states), so a validation cannot depend on whether
// a server happens to be connected.
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
    return () => {
      cancelled = true;
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

/** A palette row as the runtime hands it to the search page: id already namespaced. */
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

/** A plugin page resolved for the nav host: its route key, its nav item, and a
 *  render that seats the page behind the plugin's crash fence. */
export interface ResolvedPluginPage {
  /** `${plugin.id}:${page.id}` - what the nav's current-tab value matches on. */
  key: string;
  pluginId: string;
  label: string;
  icon: ReactNode;
  /** Renders the page's content, fenced, with the core play/navigation doors. */
  render: (props: PluginPageProps) => ReactNode;
}

/**
 * The enabled plugins' navigable pages, in registration order, shaped for the
 * nav host. Like usePluginSettingsSections this maps over static data and calls
 * no plugin hooks, so it is safe anywhere below PluginsProvider with no scope -
 * the nav bar and the content switch both read it and stay in agreement because
 * they see the same enabled set. A page whose plugin is switched off mid-view
 * simply drops out of this list, and the host falls back to Home.
 */
export function usePluginPages(): ResolvedPluginPage[] {
  const { enabled } = usePlugins();
  return enabled.flatMap((p) =>
    (p.pages ?? []).map((page) => ({
      key: `${p.id}:${page.id}`,
      pluginId: p.id,
      label: page.label,
      icon: page.icon,
      render: (props: PluginPageProps) => (
        <PluginFence pluginId={p.id}>
          <page.Content {...props} />
        </PluginFence>
      ),
    })),
  );
}

/**
 * Whether ANYTHING in this build can download - the one question the three
 * gates around the Downloads surface (the rail item, the ⋮ row, the content
 * switch) all used to answer for themselves by asking whether the music
 * importer was running. It is a plural page now, so a hub with only a book
 * downloader on has a queue worth showing and a tab worth offering.
 *
 * Reads declarations, not queues: it must be callable from a nav bar, and
 * asking a source what it holds means calling its hook, which is legal only
 * inside a PluginHookScope. Deliberately NOT folded into the `canDiscover`
 * test beside it - Discover is about acquiring MUSIC, and a books-only build
 * should not grow a music feed because it can pull an audiobook.
 */
export function useHasDownloadQueue(): boolean {
  const { enabled } = usePlugins();
  const bridge = useDownloadsOptional();
  return bridge !== null || enabled.some((p) => p.downloads?.length);
}

/** One plugin's queue, resolved for the Downloads page: the source's own
 *  identity, the items it is carrying, and whatever controls it offered. */
export interface ResolvedDownloadSource {
  /** `${plugin.id}:${source.id}` - stable across renders, unique across
   *  plugins, and the prefix every item's key is built from. */
  key: string;
  pluginId: string;
  label: string;
  icon?: ReactNode;
  items: readonly DownloadItem[];
  paused?: boolean;
  setPaused?: (paused: boolean) => void;
  clearFinished?: () => void;
}

/**
 * Every enabled plugin's download queue, for the one page that shows them.
 *
 * Hook order: like usePluginCommands this loops over `enabled` calling plugin
 * hooks, legal only because the caller sits under a PluginHookScope whose key
 * changes with the enabled set - so the sequence of hook calls is fixed for
 * the life of any instance. A source that throws has already spent hook slots,
 * so the render cannot continue past it: the error is tagged for the scope's
 * boundary, which pulls that plugin and remounts the scope clean. That is also
 * why one plugin's broken queue cannot take the page down with it.
 */
export function usePluginDownloadSources(): ResolvedDownloadSource[] {
  const { enabled } = usePlugins();
  const inScope = useContext(HookScopeContext);
  if (!inScope) throw new Error('usePluginDownloadSources must render under a PluginHookScope');

  const sources: ResolvedDownloadSource[] = [];
  for (const p of enabled) {
    for (const source of p.downloads ?? []) {
      let feed;
      try {
        // A fixed sequence per mount - the scope's key sees to it; see above.
        feed = source.useDownloads();
      } catch (error) {
        throw new PluginCrashError(p.id, error);
      }
      sources.push({
        key: `${p.id}:${source.id}`,
        pluginId: p.id,
        label: source.label,
        icon: source.icon,
        items: feed.items,
        paused: feed.paused,
        setPaused: feed.setPaused,
        clearFinished: feed.clearFinished,
      });
    }
  }
  return sources;
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

/** The music-import plugin: the one handler that acquires by downloading, and
 *  so the one the app prefers outright over asking. Surfaces that keep their
 *  own download flow (the optimistic tap, the queue's progress, autoplay when a
 *  song lands) check for it by id rather than handing off to the chooser. */
export const IMPORTER_PLUGIN_ID = 'spotify-import';

/** An acquire handler resolved for the chooser: its id namespaced, its run
 *  wrapped so a throw is logged rather than stranding the surface. */
export interface ResolvedAcquireHandler {
  /** `plugin:${pluginId}:${handlerId}`. */
  id: string;
  pluginId: string;
  label: string;
  icon?: ReactNode;
  canHandle?: (target: AcquireTarget) => boolean;
  run: (target: AcquireTarget) => void;
}

/**
 * Collects every enabled plugin's acquire handlers for the current app state.
 *
 * Same hook-order contract as usePluginCommands: it loops `enabled` calling
 * plugin hooks, which is legal only under a PluginHookScope, whose key changes
 * whenever `enabled` does. A handler hook that throws has spent hook slots, so
 * its error is tagged and rethrown for the scope's boundary to pull the plugin.
 */
function useCollectedAcquireHandlers(): ResolvedAcquireHandler[] {
  const { enabled } = usePlugins();
  const inScope = useContext(HookScopeContext);
  if (!inScope) throw new Error('acquire handlers must render under a PluginHookScope');

  const out: ResolvedAcquireHandler[] = [];
  for (const p of enabled) {
    if (!p.useAcquireHandlers) continue;
    let handlers: readonly AcquireHandler[];
    try {
      handlers = p.useAcquireHandlers();
    } catch (error) {
      throw new PluginCrashError(p.id, error);
    }
    for (const h of handlers) {
      const id = `plugin:${p.id}:${h.id}`;
      if (out.some((o) => o.id === id)) {
        console.warn(`[plugins] "${p.id}" repeated acquire handler id "${h.id}"`);
      }
      out.push({
        id,
        pluginId: p.id,
        label: h.label,
        icon: h.icon,
        canHandle: h.canHandle,
        run: (target) => {
          try {
            h.run(target);
          } catch (error) {
            // Boundaries never see handler throws; contain the dispatch so a
            // bad handler cannot strand the surface, and name the plugin.
            console.error(`[plugins] "${p.id}" acquire handler failed`, error);
          }
        },
      });
    }
  }
  return out;
}

/** What a surface reads to gate its Add control and fire the action. */
export interface AcquireValue {
  /** True when ANY acquire handler is enabled at all (importer, buy, …),
   *  regardless of a specific target. Surfaces like Discover gate their whole
   *  presence on this: with no way to acquire anything, there is nothing to
   *  discover toward. */
  hasAny: boolean;
  /** True when at least one enabled plugin can service this target. */
  hasHandlers: (target: AcquireTarget) => boolean;
  /** The handlers that can service this target, in registration order. */
  handlersFor: (target: AcquireTarget) => ResolvedAcquireHandler[];
  /**
   * Acquire the target: nothing when no handler can (the surface should have
   * gated its control on hasHandlers already), the downloader when it can, the
   * lone handler when exactly one can, and otherwise a chooser so the user
   * picks.
   */
  acquire: (target: AcquireTarget) => void;
}

const AcquireContext = createContext<AcquireValue | null>(null);

/** Headless: runs the plugin-hook loop under a scope and hands the live
 *  handlers up to the provider on every commit. */
function AcquireCollector({ sink }: { sink: (handlers: ResolvedAcquireHandler[]) => void }) {
  const handlers = useCollectedAcquireHandlers();
  useEffect(() => {
    sink(handlers);
    // Runs every commit so the provider's run closures stay fresh (an
    // importer's enqueue can change); the provider bails the state update when
    // the handler-id set is unchanged, so this cannot loop.
  });
  return null;
}

/**
 * Owns the acquire machinery: it keeps the live handler set (refreshed by a
 * headless collector that alone bears the plugin-hook loop and its remount
 * cost), gates and dispatches through context, and renders the chooser when
 * more than one handler can service a pick. Mount it inside PluginProviders so
 * a handler's hook can read its plugin's own provider, and above any surface
 * with an Add control.
 */
export function AcquireProvider({ children }: { children: ReactNode }) {
  const handlersRef = useRef<ResolvedAcquireHandler[]>([]);
  // Bumped only when the set of handler ids changes, so consumers re-gate on a
  // plugin toggle or a server connect without churning on every queue tick.
  const [signature, setSignature] = useState('');
  const [chooser, setChooser] = useState<{
    target: AcquireTarget;
    handlers: ResolvedAcquireHandler[];
  } | null>(null);

  const sink = useCallback((handlers: ResolvedAcquireHandler[]) => {
    handlersRef.current = handlers;
    const next = handlers.map((h) => h.id).join('|');
    setSignature((prev) => (prev === next ? prev : next));
  }, []);

  const handlersFor = useCallback(
    (target: AcquireTarget) =>
      handlersRef.current.filter((h) => !h.canHandle || h.canHandle(target)),
    [],
  );

  const acquire = useCallback(
    (target: AcquireTarget) => {
      const list = handlersRef.current.filter((h) => !h.canHandle || h.canHandle(target));
      const only = list[0];
      if (!only) return;
      // Turning the downloader on IS the answer to "how do you want this?" -
      // asking again every time is a tap the listener never wants. So when it
      // can service the target it just runs, and the chooser stays for the case
      // it cannot (an album on a store, a link it does not understand).
      const importer = list.find((h) => h.pluginId === IMPORTER_PLUGIN_ID);
      if (importer) {
        importer.run(target);
        return;
      }
      if (list.length === 1) {
        only.run(target);
        return;
      }
      setChooser({ target, handlers: list });
    },
    [],
  );

  const value = useMemo<AcquireValue>(
    () => ({
      hasAny: signature.length > 0,
      hasHandlers: (target) => handlersFor(target).length > 0,
      handlersFor,
      acquire,
    }),
    // signature is a dep so a changed handler set re-gates every consumer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handlersFor, acquire, signature],
  );

  return (
    <>
      <PluginHookScope>
        <AcquireCollector sink={sink} />
      </PluginHookScope>
      <AcquireContext.Provider value={value}>
        {children}
        {chooser && (
          <Modal
            open
            onClose={() => setChooser(null)}
            title={`Add “${chooser.target.title}”`}
            size="sm"
          >
            <div className="acquireChooser">
              <p className="acquireChooser__blurb">How would you like to get this?</p>
              {chooser.handlers.map((h) => (
                <Button
                  key={h.id}
                  variant="soft"
                  className="acquireChooser__option"
                  onClick={() => {
                    setChooser(null);
                    h.run(chooser.target);
                  }}
                >
                  {h.icon}
                  <span>{h.label}</span>
                </Button>
              ))}
            </div>
          </Modal>
        )}
      </AcquireContext.Provider>
    </>
  );
}

/**
 * The acquire surface for a component with an Add control. Safe to call
 * anywhere below AcquireProvider; outside it (no provider) it reports no
 * handlers and does nothing, so a surface degrades to an inert control rather
 * than throwing.
 */
export function useAcquire(): AcquireValue {
  return (
    useContext(AcquireContext) ?? {
      hasAny: false,
      hasHandlers: () => false,
      handlersFor: () => [],
      acquire: () => {},
    }
  );
}
