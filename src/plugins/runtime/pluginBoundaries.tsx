import { Component, createContext, type ReactNode } from 'react';
import { usePlugins } from '../pluginsContext.ts';
import type { PluginSlotId } from '../types.ts';

/**
 * An error rethrown out of a plugin's hook, tagged with the plugin that threw
 * so the boundary above knows exactly which plugin to pull.
 */
export class PluginCrashError extends Error {
  constructor(
    readonly pluginId: string,
    cause: unknown,
  ) {
    super(`Plugin "${pluginId}" crashed`, { cause });
  }
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
export const HookScopeContext = createContext(false);

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
