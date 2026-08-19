/**
 * The deck: a whole song, in parts, running.
 *
 * This used to be a sampler in the strict sense - pads that held a sound and
 * were silent until a thumb landed on one. Which made the default state of the
 * instrument silence, and playing it the act of assembling a song out of
 * nothing while it happened. That is a fine instrument and it is not what
 * anybody wanted from their own records.
 *
 * So the song plays, start to finish, and the pads decide which parts of it you
 * can hear. Dropping the drums for four bars and bringing them back on the one
 * is the thing this does.
 *
 * Two rules carry the whole file:
 *
 *   1. A part that is off is a part turned DOWN, never a part stopped. Stopping
 *      a source and starting it again is how parts drift out of phase: the
 *      restart begins wherever the clock is now, not where the music is. Only
 *      gain ever moves, so the six of them stay locked to the sample.
 *
 *   2. The song is STREAMED as blocks, not held. Decoded audio is float PCM at
 *      353KB a second per part - six parts of a three-minute song is most of
 *      half a gigabyte, which is not a thing to ask a phone for. So a block of
 *      every part is fetched, decoded and scheduled at an absolute time on the
 *      audio clock, and the next one is fetched while it plays. Two block-sets
 *      are ever resident: about forty megabytes.
 *
 * Rule 2 is what makes rule 1 survive a whole song. The blocks are scheduled
 * against `AudioContext.currentTime`, which is a sample counter, not a timer -
 * so a block that starts at t+10.0 starts at exactly the 480,000th sample after
 * t, on every lane, whatever the main thread was doing at the time. Nothing
 * here depends on a callback firing punctually; the callbacks only decide what
 * to fetch next.
 */

/** The parts, in the order a board wants them: voice, rhythm section, then
 *  what is played over the top. */
export const STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const;

export const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  guitar: 'Guitar',
  piano: 'Keys',
  other: 'Strings & horns',
};

export const STEM_HUES: Record<string, number> = {
  vocals: 320,
  drums: 28,
  bass: 265,
  guitar: 96,
  piano: 200,
  other: 190,
};

/**
 * Seconds of song fetched at a time.
 *
 * The trade is memory against how often the network has to answer. Ten seconds
 * of six parts is about twenty megabytes decoded, and two block-sets are live
 * at once, so the deck sits around forty - comfortable on a phone. Longer
 * blocks would mean fewer, larger stalls when a connection is slow, and a
 * seek would throw away more work.
 */
const BLOCK = 10;

/** How much runway to keep scheduled ahead of the playhead. Just over one
 *  block: enough that the next one is always fetched and decoded before it is
 *  needed, without a third block-set ever being resident. */
const AHEAD = BLOCK * 1.2;

/** Long enough not to click, short enough that a part drops on the beat you
 *  meant. Twenty milliseconds is about the shortest fade that reads as a cut
 *  rather than an edge. */
const RAMP = 0.02;

interface Lane {
  gain: GainNode;
  analyser: AnalyserNode;
  scratch: Uint8Array;
  on: boolean;
  live: Set<AudioBufferSourceNode>;
}

/** Fetches one part's bytes for one stretch of the song. */
export type BlockFetch = (stem: string, from: number, len: number, flac: boolean) => Promise<ArrayBuffer>;

export interface OpenSong {
  trackId: number;
  /** Seconds. Zero when the tags never said, which only costs looping. */
  duration: number;
  stems: string[];
  fetch: BlockFetch;
  /** Where in the song to start. */
  from?: number;
}

export class StemDeck {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private lanes = new Map<string, Lane>();
  private fetchBlock: BlockFetch | null = null;

  /**
   * The map from audio-clock time to timeline time.
   *
   * TIMELINE, not song position: it counts monotonically through repeats, so a
   * song that has looped twice is at timeline 2*duration + position. Everything
   * schedules on the timeline and only the display takes it modulo the song,
   * which is what keeps the arithmetic from having to special-case the wrap.
   *
   * Null until the first block of a run is scheduled, because until then there
   * is nothing to anchor to - the clock should not start before the audio does.
   */
  private origin: { ctx: number; tl: number } | null = null;
  private scheduledTl = 0;
  private parkedTl = 0;
  private running = false;
  private pumping = false;
  private ticker: number | undefined;
  /**
   * Whether this browser's decoder took FLAC.
   *
   * Both formats are lossless and sample-exact; FLAC is about half the bytes.
   * Every browser decodes WAV, and FLAC is a maybe on some WebKit builds - so
   * rather than sniff the engine, ask for the cheap one and fall back for good
   * the first time a decode refuses it.
   */
  private flac = true;

  trackId: number | null = null;
  duration = 0;
  /** Bumped whenever the deck is emptied, so slow work started under the
   *  previous song can tell that it has been superseded and stop. */
  generation = 0;
  /** True while the playhead has run past what has been fetched - the page
   *  shows it rather than looking frozen. */
  starved = false;

  /**
   * Builds the graph, synchronously, and asks for a resume in the background.
   *
   * Synchronous because it is called from the press that starts everything, and
   * constructing the context inside a real gesture is what makes it run. The
   * resume is fired but never awaited: iOS parks a long-idle context in its own
   * `interrupted` state, which is why the test is "anything but running".
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

  get stems(): string[] {
    return [...this.lanes.keys()];
  }

  isOn(stem: string): boolean {
    return this.lanes.get(stem)?.on ?? false;
  }

  get playing(): boolean {
    return this.running;
  }

  /** Timeline seconds: monotonic, counting through repeats. */
  private now(): number {
    if (!this.running || !this.ctx || !this.origin) return this.parkedTl;
    return this.origin.tl + (this.ctx.currentTime - this.origin.ctx);
  }

  /** Where in the SONG the playhead is, which is what a bar shows. */
  position(): number {
    const tl = this.now();
    return this.duration > 0 ? tl % this.duration : tl;
  }

  /** Put a song on the deck and start it. */
  open(song: OpenSong): void {
    this.ensure();
    this.clear();
    if (!this.ctx || !this.out) return;
    this.trackId = song.trackId;
    this.duration = song.duration;
    this.fetchBlock = song.fetch;
    for (const stem of song.stems) {
      const gain = this.ctx.createGain();
      gain.gain.value = 1;
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      // Before the gain, not after: a part that is muted should still show what
      // it is doing, so you can see the vocal coming and drop it back in on the
      // line rather than guessing.
      analyser.connect(gain);
      gain.connect(this.out);
      this.lanes.set(stem, {
        gain,
        analyser,
        scratch: new Uint8Array(analyser.frequencyBinCount),
        on: true,
        live: new Set(),
      });
    }
    this.parkedTl = Math.max(0, song.from ?? 0);
    this.play();
  }

  play(): void {
    this.ensure();
    if (this.running || this.lanes.size === 0) return;
    this.running = true;
    this.origin = null;
    this.scheduledTl = this.parkedTl;
    void this.pump();
    // Only decides what to fetch next; nothing about when a block SOUNDS
    // depends on this firing on time.
    this.ticker = window.setInterval(() => void this.pump(), 700);
  }

  pause(): void {
    if (!this.running) return;
    this.parkedTl = this.now();
    this.running = false;
    this.origin = null;
    this.starved = false;
    window.clearInterval(this.ticker);
    this.ticker = undefined;
    this.silence();
  }

  /** Move the playhead. Every part goes together, because they always do. */
  seek(songSeconds: number): void {
    const wasPlaying = this.running;
    this.pause();
    const to = this.duration > 0 ? Math.max(0, Math.min(songSeconds, this.duration - 0.5)) : Math.max(0, songSeconds);
    this.parkedTl = to;
    this.scheduledTl = to;
    if (wasPlaying) this.play();
  }

  /**
   * Bring a part in or take it out.
   *
   * Note what this does NOT do: it never touches a source node. See the file's
   * first rule - a stopped part cannot be restarted in phase, so a part that is
   * out is a part at zero, still running, still counting.
   */
  setOn(stem: string, on: boolean): void {
    const lane = this.lanes.get(stem);
    if (!lane || !this.ctx) return;
    lane.on = on;
    const now = this.ctx.currentTime;
    lane.gain.gain.cancelScheduledValues(now);
    lane.gain.gain.setValueAtTime(lane.gain.gain.value, now);
    lane.gain.gain.linearRampToValueAtTime(on ? 1 : 0, now + RAMP);
  }

  /** How loud each part is right this instant, 0..1, for the board's meters. */
  levels(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [stem, lane] of this.lanes) {
      if (!this.running) {
        out[stem] = 0;
        continue;
      }
      lane.analyser.getByteTimeDomainData(lane.scratch);
      let peak = 0;
      for (let i = 0; i < lane.scratch.length; i += 1) {
        const v = Math.abs((lane.scratch[i] ?? 128) - 128) / 128;
        if (v > peak) peak = v;
      }
      out[stem] = peak;
    }
    return out;
  }

  /**
   * Keep the schedule ahead of the playhead.
   *
   * One block-set at a time, and never two at once - `pumping` is the whole
   * concurrency control. The six parts of a single block ARE fetched together,
   * because a block-set is all-or-nothing: five parts scheduled and one still
   * on the wire is the one arrangement worse than waiting.
   */
  private async pump(): Promise<void> {
    if (this.pumping || !this.running || !this.ctx || !this.fetchBlock) return;
    this.pumping = true;
    const era = this.generation;
    try {
      while (this.running && this.generation === era && this.scheduledTl < this.now() + AHEAD) {
        const fromTl = this.scheduledTl;
        const songFrom = this.duration > 0 ? fromTl % this.duration : fromTl;
        const len = this.duration > 0 ? Math.min(BLOCK, this.duration - songFrom) : BLOCK;
        if (len < 0.25) {
          // Landed on the very end of the song; step over the seam.
          this.scheduledTl = fromTl + Math.max(0.25, len);
          continue;
        }

        const stems = [...this.lanes.keys()];
        let blocks: (AudioBuffer | null)[];
        try {
          blocks = await Promise.all(stems.map((stem) => this.decode(stem, songFrom, len)));
        } catch {
          this.starved = true;
          return;
        }
        if (this.generation !== era || !this.running || !this.ctx) return;

        /*
         * Where this block-set sounds.
         *
         * The first one of a run sets the origin - the clock does not start
         * before the audio does, or the playhead runs while nothing is coming
         * out. After that every block is placed by arithmetic on the origin
         * rather than by "now", which is what makes a hundred blocks land
         * end to end with no accumulated error.
         */
        if (!this.origin) this.origin = { ctx: this.ctx.currentTime + 0.08, tl: fromTl };
        let at = this.origin.ctx + (fromTl - this.origin.tl);
        if (at < this.ctx.currentTime) {
          // The network did not keep up and this block's moment has passed.
          // Re-anchor rather than schedule it in the past, which would drop it
          // silently: a short stall you can hear beats a gap you cannot explain.
          this.origin = { ctx: this.ctx.currentTime + 0.08, tl: fromTl };
          at = this.origin.ctx;
          this.starved = true;
        } else {
          this.starved = false;
        }

        stems.forEach((stem, i) => {
          const buffer = blocks[i];
          const lane = this.lanes.get(stem);
          if (!buffer || !lane || !this.ctx) return;
          const node = this.ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(lane.analyser);
          node.start(at);
          // Ends exactly where the next block begins. The decoder may hand back
          // a buffer a sample or two either side of the length asked for; the
          // SCHEDULE is what defines the seam, not the buffer.
          node.stop(at + len);
          lane.live.add(node);
          node.onended = () => {
            lane.live.delete(node);
          };
        });

        this.scheduledTl = fromTl + len;
      }
    } finally {
      this.pumping = false;
    }
  }

  /** One part of one block, decoded - falling back to WAV for good if this
   *  browser will not take FLAC. */
  private async decode(stem: string, from: number, len: number): Promise<AudioBuffer | null> {
    if (!this.fetchBlock || !this.ctx) return null;
    const bytes = await this.fetchBlock(stem, from, len, this.flac);
    try {
      return await this.ctx.decodeAudioData(bytes.slice(0));
    } catch {
      if (!this.flac) return null;
      this.flac = false;
      const plain = await this.fetchBlock(stem, from, len, false);
      return this.ctx.decodeAudioData(plain.slice(0)).catch(() => null);
    }
  }

  private silence(): void {
    for (const lane of this.lanes.values()) {
      for (const node of lane.live) {
        try {
          node.stop();
        } catch {
          // Already finished.
        }
      }
      lane.live.clear();
    }
  }

  /** Everything off and forgotten, ready for another song. */
  clear(): void {
    this.generation += 1;
    this.running = false;
    window.clearInterval(this.ticker);
    this.ticker = undefined;
    this.silence();
    for (const lane of this.lanes.values()) {
      try {
        lane.gain.disconnect();
        lane.analyser.disconnect();
      } catch {
        // Already detached.
      }
    }
    this.lanes.clear();
    this.origin = null;
    this.scheduledTl = 0;
    this.parkedTl = 0;
    this.duration = 0;
    this.trackId = null;
    this.starved = false;
    this.fetchBlock = null;
  }
}

/**
 * One deck for the app, not one per mount.
 *
 * The page is a tab like any other and people leave it - to find the next song,
 * to answer something - and a deck owned by the component would stop the music
 * on the way out. The whole premise is that the song keeps going, so the thing
 * playing it has to outlive the screen showing it.
 */
export const deck = new StemDeck();
