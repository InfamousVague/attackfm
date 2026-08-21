import { useEffect, useState, useSyncExternalStore } from 'react';
import { nodeSpec, type FxChainState, type FxNode } from './fxNodes.ts';

// The spec table lives next door now; everything it exported still leaves
// through this module, so the four consumers did not have to move.
export * from './fxNodes.ts';

/**
 * The hi-fi chain: ordered, parameterized nodes, compiled on the SERVER.
 *
 * Same physics as the effects rack (effects.ts): there is no seam for a
 * filter graph in the client - the kit's analyser owns the one
 * MediaElementSourceNode WebAudio allows, and the phone plays through the
 * native backend besides - so the encoder that already runs per stream is
 * the only place a chain can live. This module holds the CHOICE; the server's
 * fx.rs holds the sound. The wire (`fx2`) carries typed parameters that the
 * server clamps and compiles; a filter string never leaves the client because
 * the client never has one.
 *
 * Unlike the rack this state PERSISTS. The rack's purge-at-boot exists
 * because its UI vanished and an invisible switch must not keep re-encoding
 * playback forever. The chain earns persistence differently: a corrective
 * curve for your headphones is exactly the kind of thing that should survive
 * a relaunch - but the same trap waits whenever whatever BUILT the chain can
 * go away while the chain plays on. The console is core now, so the everyday
 * case is covered; the Pedals plugin can still put nodes in here and then be
 * uninstalled. So the CORE surfaces the state regardless: the player's
 * overflow shows a "HiFi chain" row with a kill switch whenever the chain is
 * live (PlayerStrip), and the console draws pedal nodes it cannot edit as
 * "N pedals here" rather than omitting them. The state is never invisible,
 * which is the actual rule the rack's purge was protecting.
 */

const KEY = 'attackfm-fxchain-v1';
/** The cap the sanitiser enforces. Exported so the editor can refuse an add
 *  out loud rather than letting the seventeenth box be dropped on the way to
 *  storage, which looks exactly like the add never happened. */
export const MAX_NODES = 16;

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sane(state: unknown): FxChainState {
  if (!state || typeof state !== 'object') return { nodes: [] };
  const s = state as Partial<FxChainState> & { on?: boolean };
  // A chain stored with its master DOWN was silent, and must stay silent: the
  // switch is gone, so the only way to keep that promise is to put the boxes
  // down instead. Without this, upgrading would start playing somebody's saved
  // rack at them out of nowhere.
  const migrating = s.on === false && Array.isArray(s.nodes) && s.nodes.length > 0;
  const nodes = Array.isArray(s.nodes) ? s.nodes : [];
  const kept: FxNode[] = [];
  for (const n of nodes.slice(0, MAX_NODES)) {
    if (!n || typeof n !== 'object') continue;
    const spec = nodeSpec((n as FxNode).t);
    if (!spec) continue; // a node type retired later must not haunt storage
    const params: Record<string, number> = {};
    for (const p of spec.params) {
      const v = (n as FxNode).params?.[p.key];
      params[p.key] = typeof v === 'number' && Number.isFinite(v)
        ? Math.min(p.max, Math.max(p.min, v))
        : p.default;
    }
    kept.push({
      t: spec.t,
      on: migrating ? false : (n as FxNode).on !== false,
      params,
      key: (n as FxNode).key || freshKey(),
    });
  }
  return { nodes: kept };
}

function read(): FxChainState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sane(JSON.parse(raw)) : { nodes: [] };
  } catch {
    return { nodes: [] };
  }
}

let state: FxChainState = read();
const listeners = new Set<() => void>();

function commit(next: FxChainState): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // The chain still applies for this run.
  }
  for (const l of listeners) l();
}

export function fxChain(): FxChainState {
  return state;
}

export function setFxChain(nodes: FxNode[]): void {
  commit(sane({ nodes }));
}

/** Every box down, nothing forgotten - what the master switch used to do,
 *  said in the only vocabulary left. */
export function silenceFxChain(): void {
  commit({ nodes: state.nodes.map((n) => ({ ...n, on: false })) });
}

export function fxChainOn(): boolean {
  return state.nodes.some((n) => n.on);
}

/**
 * The `fx2` query value: enabled nodes only, in chain order, as the compact
 * JSON the server parses. Null when the chain contributes nothing - which
 * keeps the URL byte-identical to a chainless one, and the direct-stream
 * path available.
 */
export function fxChainParam(): string | null {
  const live = state.nodes.filter((n) => n.on);
  if (live.length === 0) return null;
  return JSON.stringify(live.map((n) => ({ t: n.t, ...n.params })));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The chain, live everywhere it is shown. */
export function useFxChain(): FxChainState {
  return useSyncExternalStore(subscribe, fxChain, () => state);
}

// --- what the connected server actually implements -------------------------

/**
 * The node tags a given server compiles, from `GET /api/fx/nodes`.
 *
 * This exists because of a failure mode nastier than a crash: a node the
 * encoder does not know is DROPPED silently (chain_from_wire skips unknown
 * tags rather than failing the chain), so the pedal applies cleanly, changes
 * nothing, and reads as a weak effect rather than a broken one. The vocabulary
 * lives in the server binary, so a hub that has not been updated offers exactly
 * that experience for every pedal newer than it.
 *
 * "In the chain" and "in the audio" are therefore different claims, and this is
 * what lets the interface tell them apart. Unauthenticated on purpose - the
 * endpoint is public, and a listener who is signed out still deserves an honest
 * shelf.
 *
 * Null means "not known yet" (still loading, or the server could not be
 * reached) and MUST be read as "assume supported": greying out the whole shelf
 * because a fetch failed would be a worse lie than the one this prevents.
 */
const supportCache = new Map<string, Set<string>>();

export function serverFxNodes(url: string): Set<string> | null {
  return supportCache.get(url) ?? null;
}

export function useServerFxNodes(url: string | null | undefined): Set<string> | null {
  const [tags, setTags] = useState<Set<string> | null>(() =>
    url ? (supportCache.get(url) ?? null) : null,
  );

  useEffect(() => {
    if (!url) {
      setTags(null);
      return;
    }
    const cached = supportCache.get(url);
    if (cached) {
      setTags(cached);
      return;
    }
    const controller = new AbortController();
    fetch(`${url}/api/fx/nodes`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { nodes?: { t?: string }[] }) => {
        const set = new Set(
          (body.nodes ?? []).map((n) => n.t).filter((t): t is string => typeof t === 'string'),
        );
        // An empty answer is not evidence of an empty vocabulary; treat it as
        // unknown rather than marking every pedal dead.
        if (set.size === 0) return;
        supportCache.set(url, set);
        setTags(set);
      })
      .catch(() => {
        /* Unknown stays unknown, which reads as supported. */
      });
    return () => controller.abort();
  }, [url]);

  return tags;
}
