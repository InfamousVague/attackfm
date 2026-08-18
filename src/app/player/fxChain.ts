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
  group: 'tone' | 'dynamics' | 'space' | 'utility' | 'pedal';
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
  // ── The pedalboard (the Pedals plugin's shelf). Same wire, same server,
  //    same limiter - scrappier voices. Grouped 'pedal' so the hi-fi rack
  //    and the pedalboard each draw their own vocabulary.
  {
    t: 'od', label: 'Overdrive', blurb: 'Push the signal until it sings', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 24, step: 0.5, default: 10, unit: 'dB' },
      { key: 'tone', label: 'Tone', min: 1000, max: 12000, step: 100, default: 6000, unit: 'Hz' },
      { key: 'lvl', label: 'Level', min: -18, max: 6, step: 0.5, default: -3, unit: 'dB' },
    ],
  },
  {
    t: 'fuzz', label: 'Fuzz', blurb: 'Square it off; everything overdrive is too polite for', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'drive', label: 'Drive', min: 6, max: 30, step: 0.5, default: 16, unit: 'dB' },
      { key: 'tone', label: 'Tone', min: 1000, max: 10000, step: 100, default: 4500, unit: 'Hz' },
      { key: 'lvl', label: 'Level', min: -18, max: 6, step: 0.5, default: -6, unit: 'dB' },
    ],
  },
  {
    t: 'crush', label: 'Bitcrusher', blurb: 'Fewer bits, more grit', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'bits', label: 'Bits', min: 2, max: 16, step: 0.5, default: 8 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.05, default: 0.7 },
    ],
  },
  {
    t: 'chorus', label: 'Chorus', blurb: 'Two detuned copies shimmering against the dry', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 4, step: 0.1, default: 0.9, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 1, max: 8, step: 0.5, default: 4, unit: 'ms' },
    ],
  },
  {
    t: 'flanger', label: 'Flanger', blurb: 'The jet plane', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 5, step: 0.1, default: 0.5, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0.5, max: 10, step: 0.5, default: 4, unit: 'ms' },
      { key: 'regen', label: 'Regen', min: -90, max: 90, step: 5, default: 20 },
    ],
  },
  {
    t: 'phaser', label: 'Phaser', blurb: 'Notches sweeping the spectrum, softer than a flanger', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 4, step: 0.1, default: 0.6, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0.1, max: 0.9, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'trem', label: 'Tremolo', blurb: 'Loudness wobble', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.3, max: 15, step: 0.1, default: 5, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0.05, max: 1, step: 0.05, default: 0.6 },
    ],
  },
  {
    t: 'vib', label: 'Vibrato', blurb: 'Pitch wobble', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.3, max: 12, step: 0.1, default: 4, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0.05, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    t: 'rotary', label: 'Rotary', blurb: 'The poor honest cousin of a Leslie cabinet', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Speed', min: 0.05, max: 8, step: 0.05, default: 1.2, unit: 'Hz' },
      { key: 'width', label: 'Width', min: 0, max: 2, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'echo', label: 'Echo', blurb: 'Three tape taps, each quieter than the last', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'time', label: 'Time', min: 60, max: 1500, step: 10, default: 350, unit: 'ms' },
      { key: 'fb', label: 'Feedback', min: 0.05, max: 0.8, step: 0.05, default: 0.35 },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.7 },
    ],
  },
  {
    t: 'spring', label: 'Spring', blurb: 'A small room on a coil of wire', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'size', label: 'Size', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    t: 'exciter', label: 'Exciter', blurb: 'Harmonics the recording never had', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 0.5, max: 10, step: 0.25, default: 2.5 },
      { key: 'freq', label: 'From', min: 2000, max: 12000, step: 100, default: 7500, unit: 'Hz' },
    ],
  },
  {
    t: 'sub', label: 'Sub', blurb: 'An octave of synthesized weight under the lows', group: 'pedal',
    repeatable: false,
    params: [
      { key: 'wet', label: 'Amount', min: 0.1, max: 1, step: 0.05, default: 0.6 },
      { key: 'cutoff', label: 'Below', min: 50, max: 200, step: 5, default: 100, unit: 'Hz' },
    ],
  },
  {
    t: 'sparkle', label: 'Sparkle', blurb: 'Detail forward, haze back', group: 'pedal',
    repeatable: false,
    params: [{ key: 'amt', label: 'Amount', min: 0.5, max: 8, step: 0.25, default: 2 }],
  },
  {
    t: 'doubler', label: 'Doubler', blurb: 'A few milliseconds apart, heard as two takes', group: 'pedal',
    repeatable: false,
    params: [{ key: 'amt', label: 'Spread', min: 0.1, max: 2, step: 0.1, default: 1 }],
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
