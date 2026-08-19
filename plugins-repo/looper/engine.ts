/**
 * The looper's clock and voices.
 *
 * The difference between a sampler and a looper is one idea: a looper has a
 * TIME, and everything joins it on the beat rather than the instant a finger
 * lands. Press a pad halfway through a bar and it waits for the bar line -
 * which is what makes two loops played by hand sound like they were meant to
 * go together, and is the single decision this whole file exists to serve.
 *
 * Scheduling is done with a lookahead loop, not with timers per note. A
 * setTimeout fires whenever the main thread gets round to it - tens of
 * milliseconds late under any load, and audibly wrong - while
 * AudioContext.currentTime is a sample clock. So a slow timer wakes often and
 * schedules everything due in the next fraction of a second AT an exact audio
 * time, and the audio thread starts it precisely whether or not the page is
 * busy. This is the standard "tale of two clocks" arrangement and there is no
 * good alternative in Web Audio.
 */

export const PAD_COUNT = 16;
/** The grid is four wide, and that geometry carries meaning rather than just
 *  fitting a phone: a COLUMN is a lane that loops on its own, and the four
 *  pads down it are variations of that lane - a verse and a chorus of the
 *  same part. Only one variation per lane sounds at a time, so the grid holds
 *  four simultaneous loops and sixteen things to put in them. Four is also
 *  about as many loops as stay music rather than mud. */
export const LANES = 4;
export const laneOf = (pad: number): number => pad % LANES;

export interface LoopPad {
  /** What is on it. Empty means nothing loaded. */
  name: string;
  /** Where the audio came from, so a kit survives a reload. */
  source: { trackId: number; title: string } | null;
  /** The slice, in seconds into the source buffer. */
  start: number;
  end: number;
  gain: number;
  /** Semitones. Moves length too, as a hardware sampler does. */
  pitch: number;
  /** Loop until stopped, versus one-shot. */
  loop: boolean;
  /** Pads in a group cut each other off. 0 = none. */
  choke: number;
  /** Colour, carried so the grid reads as the song it came from. */
  hue: number;
}

export function emptyLoopPad(): LoopPad {
  return {
    name: '',
    source: null,
    start: 0,
    end: 0,
    gain: 1,
    pitch: 0,
    loop: true,
    choke: 0,
    hue: 210,
  };
}

/** How far ahead the scheduler places events, and how often it wakes. The
 *  gap between them is the safety margin against a stalled main thread. */
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
/** Fade at slice edges: a buffer cut mid-waveform is a step, and a step is a
 *  click. Four milliseconds is inaudible as a fade and total as a declick. */
const EDGE_FADE = 0.004;

interface Voice {
  pad: number;
  node: AudioBufferSourceNode;
  gain: GainNode;
  /** When this voice's loop comes round again, in audio time. */
  nextAt: number;
  stopping: boolean;
}

type Listener = (playing: Set<number>, beat: number) => void;

export class LoopEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private voices: Voice[] = [];
  /** Pads asked for but waiting for the next bar line. */
  private pending = new Map<number, boolean>();
  private timer: number | null = null;
  private listener: Listener | null = null;

  /** Beats per minute of the session's grid. */
  bpm = 120;
  /** Beats in a bar - the unit a launch quantises to. */
  beatsPerBar = 4;
  /** When the transport started, in audio time. */
  private startedAt = 0;
  running = false;

  /** Builds the graph synchronously; a resume is asked for but never awaited.
   *  A press must reach the audio thread in the same task it happened in. */
  ensure(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  /** The same press, without the await - what the pads actually call. */
  launchNow(pad: number, pads: LoopPad[]): void {
    this.ensure();
    void this.launch(pad, pads);
  }

  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    // Anything short of running gets a resume: iOS parks a long-idle context
    // in its own 'interrupted' state, which 'suspended' alone does not catch.
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
  }

  onChange(fn: Listener | null): void {
    this.listener = fn;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  async decode(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
    await this.unlock();
    if (!this.ctx) return null;
    try {
      return await this.ctx.decodeAudioData(bytes.slice(0));
    } catch {
      return null;
    }
  }

  /** Every pad cut from one song shares its buffer - sixteen slices of a
   *  four-minute track would otherwise be sixteen copies of it in memory. */
  setBuffer(pad: number, buffer: AudioBuffer): void {
    this.buffers.set(pad, buffer);
  }

  buffer(pad: number): AudioBuffer | undefined {
    return this.buffers.get(pad);
  }

  clear(pad: number): void {
    this.buffers.delete(pad);
    this.stop(pad, true);
  }

  /** Seconds per bar at the current tempo. */
  get barLength(): number {
    return (60 / Math.max(20, this.bpm)) * this.beatsPerBar;
  }

  /** Starts the transport. Everything launched from here is measured against
   *  this instant, so the grid is stable for the session. */
  async start(): Promise<void> {
    await this.unlock();
    if (!this.ctx || this.running) return;
    this.startedAt = this.ctx.currentTime + 0.05;
    this.running = true;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stopAll(): void {
    for (const v of this.voices) {
      try {
        v.node.stop();
      } catch {
        // Already finished.
      }
    }
    this.voices = [];
    this.pending.clear();
    this.running = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.announce();
  }

  /** The next bar line at or after `from`. */
  private nextBar(from: number): number {
    const bar = this.barLength;
    const since = Math.max(0, from - this.startedAt);
    return this.startedAt + Math.ceil(since / bar) * bar;
  }

  /** Which beat the transport is on, for the display. */
  get beat(): number {
    if (!this.ctx || !this.running) return 0;
    const elapsed = Math.max(0, this.ctx.currentTime - this.startedAt);
    return Math.floor(elapsed / (60 / Math.max(20, this.bpm))) % this.beatsPerBar;
  }

  /**
   * Asks for a pad.
   *
   * The FIRST pad of a session defines where bar one is - there is nothing to
   * be in time with yet, so waiting for a grid that does not exist would just
   * be a delay. Every pad after that joins on the next bar line, which is the
   * whole feel of the instrument: press it whenever, it arrives in time.
   */
  async launch(pad: number, pads: LoopPad[]): Promise<void> {
    await this.unlock();
    if (!this.ctx) return;
    const conf = pads[pad];
    const buffer = this.buffers.get(pad);
    if (!conf || !buffer) return;

    // Toggle: a lit pad pressed again stops at the bar line rather than
    // stacking a second copy of itself.
    if (this.playing.has(pad) || this.pending.has(pad)) {
      this.stop(pad, false);
      return;
    }

    if (!this.running) {
      // This press IS the downbeat.
      this.startedAt = this.ctx.currentTime + 0.03;
      this.running = true;
      if (this.timer === null) this.timer = window.setInterval(() => this.tick(), TICK_MS);
      this.fire(pad, pads, this.startedAt, false);
      return;
    }
    this.pending.set(pad, true);
    this.announce();
  }

  /** Actually starts a voice at an exact audio time. */
  private fire(pad: number, pads: LoopPad[], at: number, quantised: boolean): void {
    const conf = pads[pad];
    const buffer = this.buffers.get(pad);
    if (!this.ctx || !this.master || !conf || !buffer) return;

    // A lane holds one variation: starting this one retires whatever else in
    // its column was sounding, exactly at the same instant so the swap is a
    // change rather than an overlap.
    this.swapLane(pad, at);
    this.chokeFor(pad, pads, at);

    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = 2 ** (conf.pitch / 12);
    const gain = this.ctx.createGain();
    const level = Math.max(0, Math.min(2, conf.gain));
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + EDGE_FADE);
    node.connect(gain);
    gain.connect(this.master);

    const from = Math.max(0, conf.start);
    const to = Math.max(from + 0.02, Math.min(conf.end || buffer.duration, buffer.duration));
    const span = (to - from) / node.playbackRate.value;

    if (conf.loop) {
      node.loop = true;
      node.loopStart = from;
      node.loopEnd = to;
      node.start(at, from);
    } else {
      node.start(at, from, to - from);
      gain.gain.setValueAtTime(level, at + Math.max(0, span - EDGE_FADE));
      gain.gain.linearRampToValueAtTime(0, at + span);
    }

    const voice: Voice = { pad, node, gain, nextAt: at + span, stopping: false };
    this.voices.push(voice);
    node.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
      this.announce();
    };
    void quantised;
    this.announce();
  }

  /** Silences a pad, at the bar line unless `now`. */
  stop(pad: number, now: boolean): void {
    if (!this.ctx) return;
    this.pending.delete(pad);
    const at = now ? this.ctx.currentTime : this.nextBar(this.ctx.currentTime);
    for (const v of this.voices) {
      if (v.pad !== pad || v.stopping) continue;
      v.stopping = true;
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setValueAtTime(v.gain.gain.value, at);
      v.gain.gain.linearRampToValueAtTime(0, at + EDGE_FADE);
      try {
        v.node.stop(at + EDGE_FADE + 0.005);
      } catch {
        // Already stopped.
      }
    }
    this.announce();
  }

  /** Retires the other pads in this pad's lane, at `at`. */
  private swapLane(pad: number, at: number): void {
    const lane = laneOf(pad);
    for (const v of this.voices) {
      if (v.pad === pad || laneOf(v.pad) !== lane || v.stopping) continue;
      v.stopping = true;
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setValueAtTime(v.gain.gain.value, at);
      v.gain.gain.linearRampToValueAtTime(0, at + EDGE_FADE);
      try {
        v.node.stop(at + EDGE_FADE + 0.005);
      } catch {
        // Already stopped.
      }
    }
    // A pending pad in the same lane is superseded rather than queued behind.
    for (const other of [...this.pending.keys()]) {
      if (other !== pad && laneOf(other) === lane) this.pending.delete(other);
    }
  }

  private chokeFor(pad: number, pads: LoopPad[], at: number): void {
    const group = pads[pad]?.choke ?? 0;
    if (group === 0) return;
    for (const v of this.voices) {
      if (v.pad === pad || (pads[v.pad]?.choke ?? 0) !== group || v.stopping) continue;
      v.stopping = true;
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setValueAtTime(v.gain.gain.value, at);
      v.gain.gain.linearRampToValueAtTime(0, at + EDGE_FADE);
      try {
        v.node.stop(at + EDGE_FADE + 0.005);
      } catch {
        // Already stopped.
      }
    }
  }

  /** The pads currently sounding. */
  get playing(): Set<number> {
    return new Set(this.voices.filter((v) => !v.stopping).map((v) => v.pad));
  }

  get waiting(): Set<number> {
    return new Set(this.pending.keys());
  }

  /** Holds the pad list for the scheduler, which runs on a timer and so
   *  cannot be handed fresh React state at call time. */
  pads: LoopPad[] = [];

  private tick(): void {
    if (!this.ctx || !this.running) return;
    const now = this.ctx.currentTime;
    const horizon = now + LOOKAHEAD_S;
    const bar = this.nextBar(now);
    if (bar <= horizon && this.pending.size > 0) {
      for (const pad of [...this.pending.keys()]) {
        this.pending.delete(pad);
        this.fire(pad, this.pads, bar, true);
      }
    }
    this.announce();
  }

  private announce(): void {
    this.listener?.(this.playing, this.beat);
  }

  dispose(): void {
    this.stopAll();
    this.buffers.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }
}
