import { streamUrl, transcodeUrl, trackIdFromPath, type ServerSession } from '../server.ts';
import { loadAudioUrl, type Track } from '../core/tauri.ts';

/**
 * The whole song, fetched and folded down for the scratch engine's tape.
 *
 * The engine's ring only ever holds what has PLAYED, which makes scratching
 * work like vinyl - and reads as broken the moment a hand spins forward,
 * because a tape machine's reel holds the whole recording. This is the whole
 * recording: one mono channel at a scrub-grade rate, decoded once per track
 * and handed to the worklet, so the head can roam the entire file in both
 * directions.
 *
 * Mono at 22.05k on purpose. A scratch is heard through its motion - the
 * varispeed dominates everything - and half-rate mono costs a quarter of the
 * memory of the real thing: a four-minute song is ~21MB of tape instead of
 * ~84MB, and the decode's own transient cost is what keeps the length cap
 * below. For a remote track the bytes come from the server's transcode
 * endpoint when it has one (a ~4MB fetch instead of a ~50MB FLAC - this is a
 * scrub preview, not a listen); the original is the fallback.
 */

/** The rate the tape is folded to. */
const TAPE_RATE = 22050;

/**
 * The longest track that gets a tape. `decodeAudioData` holds the whole
 * decode in memory at the source's own rate before we fold it down - roughly
 * 21MB per minute for 44.1k stereo - and a WKWebView that balloons past a few
 * hundred MB is a WKWebView the OS shoots. Eight minutes covers music; a
 * two-hour DJ set scrubs on the ring alone.
 */
const MAX_TAPE_SECONDS = 8 * 60;

export interface ScrubTape {
  pcm: Float32Array;
  rate: number;
  duration: number;
}

/**
 * Fetch and fold one track's tape, or null where it cannot be had (no way to
 * reach the bytes, a track past the cap, a codec the decoder refuses). Quiet
 * by design: the scratch works without it, just shorter-armed.
 */
export async function loadScrubTape(
  track: Track,
  session: ServerSession | null,
  signal?: AbortSignal,
): Promise<ScrubTape | null> {
  try {
    // A book never gets a tape - nobody scratches an audiobook, and hours of
    // audio decode to more PCM than the phone has. An UNKNOWN duration counts
    // as over the cap for the same reason: the only tracks without one are
    // the ones nothing has probed, and betting the decoder on "probably
    // short" loses exactly when the file turns out to be a book.
    if (track.kind === 'book' || track.duration == null || track.duration > MAX_TAPE_SECONDS)
      return null;

    const id = trackIdFromPath(track.path);
    let bytes: ArrayBuffer | null = null;
    if (id != null && session) {
      // The transcode is preferred even on wifi: a scrub tape does not need
      // lossless bytes, and the fetch is a tenth the size. A server without
      // ffmpeg answers with an error and the original carries it instead.
      bytes = await fetchBytes(transcodeUrl(session, id, 128), signal);
      if (!bytes) bytes = await fetchBytes(streamUrl(session, id), signal);
    } else if (id == null) {
      // A local file: the same URL the element plays, served by the asset
      // protocol, free to read twice.
      const url = await loadAudioUrl(track.path);
      if (url) bytes = await fetchBytes(url, signal);
    }
    if (!bytes || signal?.aborted) return null;

    // Decoding in an OfflineAudioContext AT the tape rate makes the browser do
    // the resample; only the mono fold is ours.
    const ctx = new OfflineAudioContext(1, 1, TAPE_RATE);
    const decoded = await ctx.decodeAudioData(bytes);
    if (signal?.aborted) return null;
    if (decoded.duration > MAX_TAPE_SECONDS + 30) return null;

    const frames = decoded.length;
    const pcm = new Float32Array(frames);
    pcm.set(decoded.getChannelData(0));
    for (let ch = 1; ch < decoded.numberOfChannels; ch += 1) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < frames; i += 1) pcm[i]! += data[i]!;
    }
    if (decoded.numberOfChannels > 1) {
      const scale = 1 / decoded.numberOfChannels;
      for (let i = 0; i < frames; i += 1) pcm[i]! *= scale;
    }
    return { pcm, rate: decoded.sampleRate, duration: decoded.duration };
  } catch {
    return null;
  }
}

async function fetchBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  try {
    const reply = await fetch(url, { signal });
    if (!reply.ok) return null;
    return await reply.arrayBuffer();
  } catch {
    return null;
  }
}
