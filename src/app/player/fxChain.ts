import { useSyncExternalStore } from 'react';

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
 * a relaunch - but the same trap waits if the HiFi Lab plugin is removed
 * while its chain plays on. So the CORE surfaces the state too: the player's
 * overflow shows a "HiFi chain" row with a kill switch whenever the chain is
 * live (PlayerStrip), plugin installed or not. The state is never invisible,
 * which is the actual rule the rack's purge was protecting.
 */

export interface FxParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export interface FxNodeSpec {
  /** The wire tag - the contract with server/src/fx.rs. */
  t: string;
  label: string;
  /** What it does, in the words someone would use to want it. */
  blurb: string;
  group: 'tone' | 'dynamics' | 'space' | 'utility';
  params: FxParamSpec[];
  /** More than one of these in a chain is normal (EQ bands); false for the
   *  ones where a second copy is only ever a mistake. */
  repeatable: boolean;
}

/**
 * The vocabulary, mirrored from the server's registry. The server is the
 * authority - it clamps to its own ranges regardless - so a drifted copy
 * here degrades to a knob that stops early, never to a wrong sound.
 */
export const FX_NODES: FxNodeSpec[] = [
  {
    t: 'pre', label: 'Preamp', blurb: 'Trim the level into the chain', group: 'utility',
    repeatable: false,
    params: [{ key: 'g', label: 'Gain', min: -12, max: 12, step: 0.5, default: 0, unit: 'dB' }],
  },
  {
    t: 'peq', label: 'EQ band', blurb: 'One bell: pick a frequency, lift or cut it', group: 'tone',
    repeatable: true,
    params: [
      { key: 'f', label: 'Frequency', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz' },
      { key: 'g', label: 'Gain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'q', label: 'Width (Q)', min: 0.1, max: 10, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'bass', label: 'Bass shelf', blurb: 'Everything below the corner, together', group: 'tone',
    repeatable: false,
    params: [
      { key: 'g', label: 'Gain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'f', label: 'Corner', min: 40, max: 500, step: 5, default: 100, unit: 'Hz' },
    ],
  },
  {
    t: 'treble', label: 'Treble shelf', blurb: 'Everything above the corner, together', group: 'tone',
    repeatable: false,
    params: [
      { key: 'g', label: 'Gain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'f', label: 'Corner', min: 1000, max: 16000, step: 100, default: 8000, unit: 'Hz' },
    ],
  },
  {
    t: 'hp', label: 'High-pass', blurb: 'Cut rumble below the corner', group: 'tone',
    repeatable: false,
    params: [{ key: 'f', label: 'Corner', min: 20, max: 2000, step: 5, default: 30, unit: 'Hz' }],
  },
  {
    t: 'lp', label: 'Low-pass', blurb: 'Roll off everything above the corner', group: 'tone',
    repeatable: false,
    params: [{ key: 'f', label: 'Corner', min: 1000, max: 20000, step: 100, default: 18000, unit: 'Hz' }],
  },
  {
    t: 'comp', label: 'Compressor', blurb: 'Even out loud and quiet', group: 'dynamics',
    repeatable: false,
    params: [
      { key: 'thr', label: 'Threshold', min: -60, max: 0, step: 1, default: -18, unit: 'dB' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, default: 3 },
      { key: 'att', label: 'Attack', min: 1, max: 500, step: 1, default: 20, unit: 'ms' },
      { key: 'rel', label: 'Release', min: 20, max: 2000, step: 10, default: 250, unit: 'ms' },
      { key: 'mk', label: 'Makeup', min: 0, max: 24, step: 0.5, default: 0, unit: 'dB' },
    ],
  },
  {
    t: 'width', label: 'Stereo width', blurb: 'Narrow it to mono or open it out', group: 'space',
    repeatable: false,
    params: [{ key: 'amt', label: 'Width', min: 0.05, max: 2.5, step: 0.05, default: 1 }],
  },
  {
    t: 'xfeed', label: 'Crossfeed', blurb: 'Headphones, but like speakers in a room', group: 'space',
    repeatable: false,
    params: [{ key: 'amt', label: 'Strength', min: 0, max: 1, step: 0.05, default: 0.5 }],
  },
  {
    t: 'level', label: 'Leveler', blurb: 'Quiet songs up, loud songs down', group: 'dynamics',
    repeatable: false,
    params: [],
  },
];

export function nodeSpec(t: string): FxNodeSpec | undefined {
  return FX_NODES.find((n) => n.t === t);
}

/** One node as the chain holds it: the wire tag, its params, and whether it
 *  is currently in the signal path (bypassed nodes stay in the list). */
export interface FxNode {
  t: string;
  on: boolean;
  params: Record<string, number>;
  /** Client-side identity for list edits; never sent to the server. */
  key: string;
}

export interface FxChainState {
  on: boolean;
  nodes: FxNode[];
}

const KEY = 'attackfm-fxchain-v1';
const MAX_NODES = 16;

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sane(state: unknown): FxChainState {
  if (!state || typeof state !== 'object') return { on: false, nodes: [] };
  const s = state as Partial<FxChainState>;
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
    kept.push({ t: spec.t, on: (n as FxNode).on !== false, params, key: (n as FxNode).key || freshKey() });
  }
  return { on: s.on === true && kept.length > 0, nodes: kept };
}

function read(): FxChainState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sane(JSON.parse(raw)) : { on: false, nodes: [] };
  } catch {
    return { on: false, nodes: [] };
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

export function setFxChain(nodes: FxNode[], on: boolean): void {
  commit(sane({ on, nodes }));
}

/** The core kill switch: everything off, nothing forgotten. */
export function setFxChainOn(on: boolean): void {
  commit({ ...state, on: on && state.nodes.length > 0 });
}

export function fxChainOn(): boolean {
  return state.on && state.nodes.some((n) => n.on);
}

/**
 * The `fx2` query value: enabled nodes only, in chain order, as the compact
 * JSON the server parses. Null when the chain contributes nothing - which
 * keeps the URL byte-identical to a chainless one, and the direct-stream
 * path available.
 */
export function fxChainParam(): string | null {
  if (!state.on) return null;
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
