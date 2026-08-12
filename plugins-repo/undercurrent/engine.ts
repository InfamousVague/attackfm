/**
 * The ambience synthesizer. Four beds, no recordings: every layer is shaped
 * noise - buffers computed once at start, then looped through per-layer
 * filters and gains. One AudioContext for the lot, created lazily inside the
 * user's first toggle (autoplay policy), and MODULE-scoped on purpose: the
 * page that mixes it comes and goes, the weather stays.
 *
 * Sits entirely beside the player's graph - the music is not touched, this
 * is a second quiet instrument playing under it.
 */

export type LayerId = 'rain' | 'crackle' | 'fire' | 'wind';

export interface LayerState {
  on: boolean;
  /** 0..1 */
  volume: number;
}

export type Mix = Record<LayerId, LayerState>;

export const LAYERS: readonly LayerId[] = ['rain', 'crackle', 'fire', 'wind'];

const KEY = 'attackfm-undercurrent-mix';

export const DEFAULT_MIX: Mix = {
  rain: { on: false, volume: 0.5 },
  crackle: { on: false, volume: 0.4 },
  fire: { on: false, volume: 0.5 },
  wind: { on: false, volume: 0.35 },
};

export function readMix(): Mix {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Mix | null;
    if (!parsed) return { ...DEFAULT_MIX };
    const out = { ...DEFAULT_MIX };
    for (const id of LAYERS) {
      const l = parsed[id];
      if (l && typeof l.volume === 'number') out[id] = { on: !!l.on, volume: Math.min(1, Math.max(0, l.volume)) };
    }
    return out;
  } catch {
    return { ...DEFAULT_MIX };
  }
}

export function writeMix(mix: Mix): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mix));
  } catch {
    // Session-only, then.
  }
}

/** Seconds of loop per noise buffer - long enough that the ear stops finding
 *  the seam, short enough to compute in a blink. */
const LOOP_S = 6;

function whiteBuffer(ctx: AudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * LOOP_S, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Brown noise: integrated white, the low rumble fire and wind stand on. */
function brownBuffer(ctx: AudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * LOOP_S, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i += 1) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}

/** Sparse impulses: vinyl pops / fire snaps. `density` pops per second. */
function popBuffer(ctx: AudioContext, density: number, sharp: number): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * LOOP_S, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const pops = Math.floor(LOOP_S * density);
  for (let p = 0; p < pops; p += 1) {
    const at = Math.floor(Math.random() * (d.length - 200));
    const strength = 0.3 + Math.random() * 0.7;
    const decay = 20 + Math.random() * 60 * sharp;
    for (let i = 0; i < 200; i += 1) {
      d[at + i]! += (Math.random() * 2 - 1) * strength * Math.exp(-i / decay);
    }
  }
  return buf;
}

interface LayerNodes {
  gain: GainNode;
  stop: () => void;
}

interface EngineInner {
  ctx: AudioContext;
  layers: Partial<Record<LayerId, LayerNodes>>;
}

let inner: EngineInner | null = null;

function context(): EngineInner {
  if (inner) return inner;
  const Ctor =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
  const ctx = new Ctor();
  inner = { ctx, layers: {} };
  return inner;
}

function looped(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start();
  return src;
}

/** Builds one layer's little graph and returns its output gain. */
function buildLayer(id: LayerId, e: EngineInner): LayerNodes {
  const { ctx } = e;
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(ctx.destination);
  const stops: AudioBufferSourceNode[] = [];
  const add = (src: AudioBufferSourceNode, ...chain: AudioNode[]) => {
    let node: AudioNode = src;
    for (const next of chain) {
      node.connect(next);
      node = next;
    }
    node.connect(out);
    stops.push(src);
  };

  if (id === 'rain') {
    // A wide hiss band with the lowest floor rolled away: rain on a roof.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400;
    band.Q.value = 0.4;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    const soft = ctx.createGain();
    soft.gain.value = 0.5;
    add(looped(ctx, whiteBuffer(ctx)), band, hp, soft);
    // The occasional heavier drop.
    const dropLp = ctx.createBiquadFilter();
    dropLp.type = 'lowpass';
    dropLp.frequency.value = 1200;
    const dropGain = ctx.createGain();
    dropGain.gain.value = 0.5;
    add(looped(ctx, popBuffer(ctx, 6, 0.5)), dropLp, dropGain);
  } else if (id === 'crackle') {
    // Vinyl: sparse pops over the faintest warm hiss.
    const popLp = ctx.createBiquadFilter();
    popLp.type = 'lowpass';
    popLp.frequency.value = 5200;
    add(looped(ctx, popBuffer(ctx, 3, 1)), popLp);
    const hissLp = ctx.createBiquadFilter();
    hissLp.type = 'lowpass';
    hissLp.frequency.value = 3000;
    const hiss = ctx.createGain();
    hiss.gain.value = 0.02;
    add(looped(ctx, whiteBuffer(ctx)), hissLp, hiss);
  } else if (id === 'fire') {
    // A brown-noise bed with snappy pops riding it.
    const bedLp = ctx.createBiquadFilter();
    bedLp.type = 'lowpass';
    bedLp.frequency.value = 500;
    const bed = ctx.createGain();
    bed.gain.value = 0.6;
    add(looped(ctx, brownBuffer(ctx)), bedLp, bed);
    const snapHp = ctx.createBiquadFilter();
    snapHp.type = 'highpass';
    snapHp.frequency.value = 1400;
    const snap = ctx.createGain();
    snap.gain.value = 0.6;
    add(looped(ctx, popBuffer(ctx, 8, 1)), snapHp, snap);
  } else {
    // Wind: a low band whose centre the LFO leans on, slowly.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 300;
    band.Q.value = 1.1;
    add(looped(ctx, brownBuffer(ctx)), band);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const sway = ctx.createGain();
    sway.gain.value = 160;
    lfo.connect(sway);
    sway.connect(band.frequency);
    lfo.start();
    stops.push(lfo as unknown as AudioBufferSourceNode);
  }

  return {
    gain: out,
    stop: () => {
      for (const s of stops) {
        try {
          s.stop();
        } catch {
          // Already stopped.
        }
      }
      out.disconnect();
    },
  };
}

/** Applies a mix: builds/tears layers to match, sets gains. Call on every
 *  change; it converges rather than replays. */
export function applyMix(mix: Mix): void {
  const anyOn = LAYERS.some((id) => mix[id].on);
  if (!anyOn && !inner) return;
  const e = context();
  void e.ctx.resume();
  for (const id of LAYERS) {
    const want = mix[id];
    let nodes = e.layers[id];
    if (want.on && !nodes) {
      nodes = buildLayer(id, e);
      e.layers[id] = nodes;
    }
    if (nodes) {
      const target = want.on ? want.volume * 0.5 : 0;
      nodes.gain.gain.setTargetAtTime(target, e.ctx.currentTime, 0.15);
      if (!want.on) {
        const dying = nodes;
        e.layers[id] = undefined;
        window.setTimeout(() => dying.stop(), 700);
      }
    }
  }
}

/** Silences and drops everything. */
export function stopAll(): void {
  if (!inner) return;
  for (const id of LAYERS) {
    const nodes = inner.layers[id];
    if (nodes) {
      nodes.gain.gain.setTargetAtTime(0, inner.ctx.currentTime, 0.1);
      window.setTimeout(() => nodes.stop(), 500);
      inner.layers[id] = undefined;
    }
  }
}
