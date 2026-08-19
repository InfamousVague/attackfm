/**
 * Auto-sampling: cutting a song into pieces worth putting on a pad.
 *
 * Two ways to cut a record, and both are wrong on their own. A pure beat grid
 * (BPM in, sixteen equal pieces out) lands on the beat but not on the SOUND -
 * it happily slices a quarter-note before the snare that actually starts the
 * bar. Pure onset detection lands on every sound including the ones nobody
 * meant, and a song hands you three hundred of them.
 *
 * So this is the hybrid: find the transients, then snap each one to the
 * nearest beat the server's BPM predicts, and keep the strongest one per beat.
 * The grid says where a slice is ALLOWED to start; the transients say which of
 * those places is worth starting at.
 *
 * Everything runs over the decoded buffer on one pass of spectral flux -
 * cheap enough for a phone on the main thread for a four-minute track, which
 * is why there is no worker here to go wrong.
 */

/**
 * Analysis runs at a quarter rate. Onsets are a question about the shape of
 * the envelope, not about the top octave, and 11 kHz keeps every band that
 * carries a transient while quartering the work. The first cut of this
 * analysed at full rate with a naive DFT and took 2.5 seconds per 16 seconds
 * of audio - a four-minute track would have frozen the page for half a
 * minute. Downsampling plus a real FFT is what makes it interactive.
 */
const DOWN = 4;
const WINDOW = 512;
const HOP = 256;
/** Nothing can be a slice within this of the previous one - a drum roll is
 *  not sixteen samples, it is one. */
const MIN_GAP_S = 0.12;

export interface Slice {
  /** Seconds into the source. */
  start: number;
  end: number;
  /** How strongly this began, 0..1 - the pads use it to colour by impact. */
  strength: number;
}

/**
 * In-place iterative radix-2 FFT.
 *
 * Written out rather than pulled in because a plugin bundles everything it
 * imports, and this is forty lines against a dependency.
 */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]!;
        const bi = im[i + k + len / 2]!;
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[i + k] = ar + tr;
        im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr;
        im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * A novelty curve: how much the spectrum CHANGED at each hop.
 *
 * Spectral flux rather than raw energy, because energy misses a bright sound
 * arriving over a loud one - a hi-hat over a sustained bass note is a
 * transient the ear hears and an energy meter does not. Only rises count
 * (half-wave rectified): a sound stopping is not a sound starting.
 */
function noveltyCurve(buffer: AudioBuffer): { flux: Float32Array; rate: number } {
  const source = buffer.getChannelData(0);
  // Downmix is unnecessary - one channel carries every transient that matters
  // - but the decimation is not, so take every DOWNth sample.
  const n = Math.floor(source.length / DOWN);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i += 1) mono[i] = source[i * DOWN] ?? 0;
  const rate = buffer.sampleRate / DOWN;

  const win = new Float32Array(WINDOW);
  for (let i = 0; i < WINDOW; i += 1) {
    // Hann, so the edges of each window do not read as transients themselves.
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));
  }

  const frames = Math.max(1, Math.floor((n - WINDOW) / HOP));
  const flux = new Float32Array(frames);
  const re = new Float32Array(WINDOW);
  const im = new Float32Array(WINDOW);
  const prev = new Float32Array(WINDOW / 2);

  for (let f = 0; f < frames; f += 1) {
    const at = f * HOP;
    for (let i = 0; i < WINDOW; i += 1) {
      re[i] = (mono[at + i] ?? 0) * (win[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let b = 0; b < WINDOW / 2; b += 1) {
      const mag = Math.sqrt((re[b] ?? 0) ** 2 + (im[b] ?? 0) ** 2);
      const rise = mag - (prev[b] ?? 0);
      if (rise > 0) sum += rise;
      prev[b] = mag;
    }
    flux[f] = sum;
  }
  return { flux, rate: rate / HOP };
}

/** Peaks that stand above their own neighbourhood, so a quiet passage's
 *  transients count as much as a loud one's. */
function pickPeaks(flux: Float32Array, rate: number): { at: number; strength: number }[] {
  const n = flux.length;
  if (n === 0) return [];
  // Median-ish local threshold over ~1s either side.
  const half = Math.max(4, Math.round(rate * 0.5));
  const out: { at: number; strength: number }[] = [];
  let max = 0;
  for (let i = 0; i < n; i += 1) max = Math.max(max, flux[i] ?? 0);
  if (max <= 0) return [];

  for (let i = 1; i < n - 1; i += 1) {
    const v = flux[i] ?? 0;
    if (v <= (flux[i - 1] ?? 0) || v < (flux[i + 1] ?? 0)) continue;
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j < Math.min(n, i + half); j += 1) {
      sum += flux[j] ?? 0;
      count += 1;
    }
    const local = count > 0 ? sum / count : 0;
    // 1.4x the local average, and above a floor, so silence yields nothing.
    if (v > local * 1.4 && v > max * 0.06) {
      out.push({ at: i / rate, strength: v / max });
    }
  }
  return out;
}

/**
 * Where beat one is.
 *
 * A BPM says how far apart the beats are, not where they start. This tries
 * every offset within one beat and keeps the one that puts the most transient
 * energy on the grid - which is the definition of being in time with it.
 */
function findPhase(onsets: { at: number; strength: number }[], beat: number): number {
  if (onsets.length === 0) return 0;
  let best = 0;
  let bestScore = -1;
  const steps = 48;
  for (let s = 0; s < steps; s += 1) {
    const phase = (s / steps) * beat;
    let score = 0;
    for (const o of onsets) {
      const rel = (o.at - phase) / beat;
      const off = Math.abs(rel - Math.round(rel));
      // Within an eighth of a beat counts, weighted by how close and how hard.
      if (off < 0.125) score += o.strength * (1 - off * 8);
    }
    if (score > bestScore) {
      bestScore = score;
      best = phase;
    }
  }
  return best;
}

/**
 * Cuts a buffer into up to `want` slices.
 *
 * `bpm` comes from the server when it has one. Without it the beat grid is
 * skipped and the transients are used raw - a worse cut, but a cut.
 */
export function autoSlice(buffer: AudioBuffer, bpm: number | null, want = 16): Slice[] {
  const duration = buffer.duration;
  const { flux, rate } = noveltyCurve(buffer);
  const onsets = pickPeaks(flux, rate);

  let candidates = onsets;
  if (bpm && bpm > 40 && bpm < 220) {
    const beat = 60 / bpm;
    const phase = findPhase(onsets, beat);
    // Snap each onset to its nearest beat, then keep the strongest onset that
    // landed on each beat. Two hits on one beat is one slice.
    const byBeat = new Map<number, { at: number; strength: number }>();
    for (const o of onsets) {
      const index = Math.round((o.at - phase) / beat);
      const snapped = phase + index * beat;
      if (snapped < 0 || snapped > duration) continue;
      if (Math.abs(o.at - snapped) > beat * 0.25) continue;
      const held = byBeat.get(index);
      if (!held || o.strength > held.strength) {
        byBeat.set(index, { at: snapped, strength: o.strength });
      }
    }
    candidates = [...byBeat.values()].sort((a, b) => a.at - b.at);
  }

  if (candidates.length === 0) {
    // Nothing detectable: fall back to equal pieces, which at least gives the
    // pads something to hold.
    const step = duration / want;
    return Array.from({ length: want }, (_, i) => ({
      start: i * step,
      end: Math.min(duration, (i + 1) * step),
      strength: 0.5,
    }));
  }

  // Thin out anything too close together, keeping the stronger of a pair.
  const spaced: { at: number; strength: number }[] = [];
  for (const c of candidates) {
    const last = spaced[spaced.length - 1];
    if (last && c.at - last.at < MIN_GAP_S) {
      if (c.strength > last.strength) spaced[spaced.length - 1] = c;
      continue;
    }
    spaced.push(c);
  }

  // More candidates than pads: keep the strongest, but spread across the song
  // rather than clustered in its loudest minute - sixteen slices of one chorus
  // is not a kit. Each third of the track keeps its own best.
  let chosen = spaced;
  if (spaced.length > want) {
    const bands = 4;
    const perBand = Math.ceil(want / bands);
    const picked: typeof spaced = [];
    for (let b = 0; b < bands; b += 1) {
      const from = (duration / bands) * b;
      const to = (duration / bands) * (b + 1);
      const inBand = spaced
        .filter((c) => c.at >= from && c.at < to)
        .sort((a, b2) => b2.strength - a.strength)
        .slice(0, perBand);
      picked.push(...inBand);
    }
    chosen = picked.sort((a, b) => a.at - b.at).slice(0, want);
  }

  return chosen.map((c, i) => {
    const next = chosen[i + 1];
    // A slice runs to the next one, capped: a pad holding ninety seconds of
    // outro is not a sample, and the trim handles can always open it up.
    const end = Math.min(next ? next.at : duration, c.at + 8);
    return {
      // A few milliseconds of pre-roll: starting exactly ON a transient
      // clips its attack, which is the difference between a kick and a click.
      start: Math.max(0, c.at - 0.008),
      end: Math.max(c.at + 0.05, end),
      strength: c.strength,
    };
  });
}
