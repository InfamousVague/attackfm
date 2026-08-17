import {
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
import { usePlugins } from '../pluginsContext.ts';
import { HookScopeContext, PluginCrashError, PluginHookScope } from './pluginBoundaries.tsx';
import type { AcquireHandler, AcquireTarget } from '../types.ts';

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
