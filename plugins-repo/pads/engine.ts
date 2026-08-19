/**
 * The instrument itself: sixteen pads, and the Web Audio behind them.
 *
 * The one rule that decides this whole file is that a pad must sound within a
 * few milliseconds of the thumb landing. That rules out fetching, decoding, or
 * building anything at hit time - all of it happens when the kit loads, and a
 * hit does the only thing that is genuinely cheap: make a source node, point
 * it at an already-decoded buffer, and start it. An AudioBufferSourceNode is
 * single-use by design, so one per hit is correct rather than wasteful.
 *
 * Everything here is deliberately outside React. A drum pattern played by hand
 * produces events far faster than a component tree can re-render, and a hit
 * that waited for a render would arrive late and unevenly - which on an
 * instrument is the whole difference between playable and not.
 */

export const PAD_COUNT = 16;

export interface PadSettings {
  /** What is on it, for the label. Empty means the pad is unassigned. */
  name: string;
  /** Where the sample came from, so a kit can be reloaded later. */
  source: { trackId: number; stem: string } | null;
  /** Level, 0..1.5 - a little above unity, because a bass stem often needs it. */
  gain: number;
  /** Semitones, -12..12. Playback rate, so it moves the length too, which is
   *  what a hardware sampler does and what people expect. */
  pitch: number;
  /** Fractions of the buffer, 0..1. */
  start: number;
  end: number;
  /** Hold to sustain (gate) rather than one-shot. */
  gate: boolean;
  loop: boolean;
  reverse: boolean;
  /** Pads sharing a choke group cut each other off - a closed hi-hat
   *  silencing an open one is the canonical case. 0 means no group. */
  choke: number;
}

export function emptyPad(): PadSettings {
  return {
    name: '',
    source: null,
    gain: 1,
    pitch: 0,
    start: 0,
    end: 1,
    gate: false,
    loop: false,
    reverse: false,
    choke: 0,
  };
}

interface Voice {
  node: AudioBufferSourceNode;
  gain: GainNode;
  pad: number;
}

/** How quickly a choked or released voice falls silent. Short enough to read
 *  as a cut, long enough not to click - a hard stop on a running buffer is an
 *  edge, and an edge is a click. */
const RELEASE = 0.012;

export class PadEngine {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private voices: Voice[] = [];
  /** Reversed copies, made once on assignment rather than per hit. */
  private reversed = new Map<number, AudioBuffer>();

  /**
   * Builds the graph, synchronously, and asks for a resume in the background.
   *
   * Synchronous is the whole point. Constructing an AudioContext inside a real
   * user gesture is what makes it start running, and a hit that waits on a
   * PROMISE before touching the graph has already lost the argument: the
   * earliest a `.then()` can run is the next microtask, and on a busy page
   * that is milliseconds an instrument does not have. So this returns
   * immediately and `hit` can be called straight from a pointer handler.
   *
   * `resume()` is still fired for the case that matters - iOS parks a
   * long-idle context in its own 'interrupted' state, which is why the check
   * is "anything but running" rather than "suspended" - but nothing waits for
   * it. A node started against a suspended context simply sounds when the
   * context comes back, which is the right behaviour anyway.
   */
  ensure(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.out = this.ctx.createGain();
      this.out.gain.value = 1;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  /** Kept for the loading path, which genuinely is async. */
  async unlock(): Promise<void> {
    this.ensure();
    if (this.ctx && this.ctx.state !== 'running') {
      await this.ctx.resume().catch(() => {});
    }
  }

  get ready(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Decodes and holds a sample for a pad. Called on load, never on a hit. */
  async load(pad: number, bytes: ArrayBuffer): Promise<void> {
    await this.unlock();
    if (!this.ctx) return;
    const buffer = await this.ctx.decodeAudioData(bytes.slice(0));
    this.buffers.set(pad, buffer);
    this.reversed.delete(pad);
  }

  has(pad: number): boolean {
    return this.buffers.has(pad);
  }

  duration(pad: number): number {
    return this.buffers.get(pad)?.duration ?? 0;
  }

  /** Peaks for drawing a waveform, computed once per assignment. */
  peaks(pad: number, buckets = 160): number[] {
    const buffer = this.buffers.get(pad);
    if (!buffer) return [];
    const data = buffer.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / buckets));
    const out: number[] = [];
    for (let i = 0; i < buckets; i += 1) {
      let peak = 0;
      const from = i * per;
      for (let j = from; j < from + per && j < data.length; j += 1) {
        const v = Math.abs(data[j]!);
        if (v > peak) peak = v;
      }
      out.push(peak);
    }
    return out;
  }

  private reversedBuffer(pad: number): AudioBuffer | undefined {
    const original = this.buffers.get(pad);
    if (!original || !this.ctx) return undefined;
    const cached = this.reversed.get(pad);
    if (cached) return cached;
    const copy = this.ctx.createBuffer(
      original.numberOfChannels,
      original.length,
      original.sampleRate,
    );
    for (let c = 0; c < original.numberOfChannels; c += 1) {
      const src = original.getChannelData(c);
      const dst = copy.getChannelData(c);
      for (let i = 0, j = src.length - 1; i < src.length; i += 1, j -= 1) dst[i] = src[j]!;
    }
    this.reversed.set(pad, copy);
    return copy;
  }

  /** Silences a pad's voices, and anything sharing its choke group. */
  private choke(pad: number, settings: PadSettings[]): void {
    if (!this.ctx) return;
    const group = settings[pad]?.choke ?? 0;
    const now = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => {
      const sameGroup = group !== 0 && (settings[v.pad]?.choke ?? 0) === group;
      if (!sameGroup && v.pad !== pad) return true;
      // Retriggering the same pad also cuts its previous voice: two copies of
      // one sample a few milliseconds apart is flamming, not layering.
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0, now + RELEASE);
      try {
        v.node.stop(now + RELEASE + 0.005);
      } catch {
        // Already finished; nothing to stop.
      }
      return false;
    });
  }

  /**
   * Plays a pad. Returns a function that releases it, for gate mode.
   *
   * `velocity` scales the level: 0..1, from how hard or where the pad was hit.
   */
  hit(pad: number, settings: PadSettings[], velocity = 1): (() => void) | null {
    // Never awaits: see ensure(). Called straight from the pointer handler.
    this.ensure();
    const conf = settings[pad];
    if (!this.ctx || !this.out || !conf) return null;
    const buffer = conf.reverse ? this.reversedBuffer(pad) : this.buffers.get(pad);
    if (!buffer) return null;

    this.choke(pad, settings);

    const now = this.ctx.currentTime;
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = 2 ** (conf.pitch / 12);
    const gain = this.ctx.createGain();
    // A tiny attack rather than an instant one: starting a buffer at full
    // level mid-waveform is a step, and a step is a click.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(
      Math.max(0, Math.min(1.5, conf.gain)) * Math.max(0, Math.min(1, velocity)),
      now + 0.004,
    );
    node.connect(gain);
    gain.connect(this.out);

    const from = Math.max(0, Math.min(1, conf.start)) * buffer.duration;
    const to = Math.max(0, Math.min(1, conf.end)) * buffer.duration;
    const span = Math.max(0.01, to - from);
    if (conf.loop) {
      node.loop = true;
      node.loopStart = from;
      node.loopEnd = Math.max(from + 0.01, to);
      node.start(now, from);
    } else {
      node.start(now, from, span);
    }

    const voice: Voice = { node, gain, pad };
    this.voices.push(voice);
    node.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
    };

    return () => {
      if (!this.ctx) return;
      const at = this.ctx.currentTime;
      gain.gain.cancelScheduledValues(at);
      gain.gain.setValueAtTime(gain.gain.value, at);
      gain.gain.linearRampToValueAtTime(0, at + RELEASE);
      try {
        node.stop(at + RELEASE + 0.005);
      } catch {
        // Already done.
      }
    };
  }

  /** Everything off, now. */
  panic(): void {
    if (!this.ctx) return;
    for (const v of this.voices) {
      try {
        v.node.stop();
      } catch {
        // Already stopped.
      }
    }
    this.voices = [];
  }

  dispose(): void {
    this.panic();
    this.buffers.clear();
    this.reversed.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.out = null;
  }
}
