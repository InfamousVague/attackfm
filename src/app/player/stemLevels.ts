import { transcodeUrl, trackIdFromPath, type ServerSession } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * How loud each PART of a song is, moment to moment.
 *
 * The stems room used to move every row off one meter, because the device only
 * ever hears the mix: the parts you keep are summed by the server before the
 * stream leaves it, so nothing on this side can tell the drums from the bass by
 * listening. That was honest but it was not the point - a rack of six identical
 * bars tells you nothing you did not already know, and what a mixer is FOR is
 * seeing the drums hit while the strings sit still.
 *
 * The parts do exist separately, on the server, so the answer is to measure
 * them there rather than to guess here. There is no endpoint that returns a
 * waveform - and there cannot be one today, since the box is not deployable -
 * but the transcode endpoint already takes `drop`, and dropping the OTHER five
 * parts leaves exactly one. Six of those, measured once, is a real envelope per
 * part rather than one signal wearing six hats.
 *
 * What it costs, stated plainly because it is not free: about 1.5MB per part
 * per three minutes, so nine for a whole song, fetched once when the room is
 * opened on a track and cached until the track changes. That is why the caller
 * gates it - the room being open, on a connection nobody has called metered.
 */

/** Envelope resolution. Fine enough for a kick to read as a hit, coarse enough
 *  that a whole song is a few tens of kilobytes. */
export const ENV_HZ = 40;

/**
 * The rate the parts are decoded at.
 *
 * An envelope needs a hundred samples per bucket, not a thousand, and the
 * decode is the expensive half: `decodeAudioData` holds the whole thing in
 * memory at the source's rate first (scrubTape.ts learned this the hard way -
 * roughly 21MB per minute for 44.1k stereo, and a WKWebView that balloons is
 * one the OS shoots). Asking an OfflineAudioContext for 8k makes the browser
 * resample as it decodes, which is what keeps six parts from being six times
 * a problem. 8000 rather than lower because that is the floor the Web Audio
 * spec obliges every implementation to accept.
 */
const DECODE_RATE = 8000;

/** The same cap the scratch tape uses, for the same reason. */
const MAX_ENV_SECONDS = 8 * 60;

/** Bitrate for the measuring copy. This is never listened to. */
const MEASURE_KBPS = 64;

export type StemEnvelopes = Map<string, Float32Array>;

/**
 * One part's loudness over time, as RMS in 0..1 at `ENV_HZ`.
 *
 * Normalised against the part's OWN peak, deliberately. A separated bass line
 * is quieter than the mix it came out of, and against an absolute scale every
 * row but the drums would sit flat - which is the same uninformative picture
 * this replaced, only dimmer. Each row answers "is this part busy right now",
 * and busy is relative to what that part does at its loudest.
 */
function envelopeOf(pcm: Float32Array, rate: number): Float32Array {
  const per = Math.max(1, Math.round(rate / ENV_HZ));
  const out = new Float32Array(Math.ceil(pcm.length / per));
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const start = i * per;
    const end = Math.min(pcm.length, start + per);
    let sum = 0;
    for (let j = start; j < end; j++) sum += pcm[j]! * pcm[j]!;
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    out[i] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / peak;
  return out;
}

/**
 * Measure every part of one track.
 *
 * Fetched together (the network is idle while a decode runs) and decoded one
 * after another (memory is not). Anything that fails is simply left out: a row
 * with no envelope falls back to the mix's beat, which is what every row did
 * before this existed.
 */
export async function loadStemEnvelopes(
  track: Track,
  session: ServerSession | null,
  stems: readonly string[],
  signal?: AbortSignal,
): Promise<StemEnvelopes> {
  const out: StemEnvelopes = new Map();
  const id = trackIdFromPath(track.path);
  if (!session || id === null || stems.length === 0) return out;
  if (track.duration != null && track.duration > MAX_ENV_SECONDS) return out;

  const pending = stems.map((stem) => {
    // Everything BUT this part, which is how one part is asked for through a
    // door built to leave parts out.
    const others = stems.filter((s) => s !== stem).join(',');
    const url = transcodeUrl(session, id, MEASURE_KBPS, 0, null, null, others);
    return { stem, bytes: fetch(url, { signal }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) };
  });

  for (const { stem, bytes } of pending) {
    if (signal?.aborted) return out;
    const buf = await bytes;
    if (!buf) continue;
    const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
    const decoded = await ctx.decodeAudioData(buf).catch(() => null);
    if (!decoded) continue;
    if (signal?.aborted) return out;
    out.set(stem, envelopeOf(decoded.getChannelData(0), decoded.sampleRate));
  }
  return out;
}

/**
 * A part's envelope, read as a loudness meter at whatever second the song is
 * on - the shape `useBeat` wants.
 *
 * `at` is asked for in the FILE's seconds, not the bar's. The two are the same
 * number until a speed pedal is on, and the envelope was measured from the file
 * - the same trap the scratch tape fell into, so the conversion belongs at the
 * caller where the chain rate is known.
 */
export function envelopeMeter(
  env: Float32Array | undefined,
  at: () => number,
): (() => number) | null {
  if (!env || env.length === 0) return null;
  return () => {
    const i = Math.floor(at() * ENV_HZ);
    if (i < 0 || i >= env.length) return 0;
    return env[i]!;
  };
}
