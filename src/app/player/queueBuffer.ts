/**
 * The next few songs, already on the device.
 *
 * The idle deck in Player.tsx warms exactly ONE track and only inside the last
 * twelve seconds of the one playing, which is the right shape for the end of a
 * song and no help at all for the two things people actually do: skipping
 * forward several tracks in a row, and walking into a lift. Both hit a cold
 * resolve-connect-buffer against a lossless file, and on a dropped connection
 * the second one does not recover - the queue was full of music the device had
 * never been given a reason to fetch.
 *
 * So: a rolling window of the queue, fetched whole, kept on disk, and offered
 * back to the player ahead of the network.
 *
 * ## Why the Cache API and not the offline vault
 *
 * The vault would look like the natural home - it already holds whole songs and
 * `loadLocalAudioUrl` already prefers it - but autoCache.ts governs that folder
 * with one rule this would break: anything on disk its ledger does not
 * recognise is treated as a MANUAL PIN, never evicted and never charged to the
 * budget. A rolling buffer writing into the vault would therefore look like a
 * pin per song and grow without bound, and teaching the sweep to tell the two
 * apart means editing the one invariant with a comment begging nobody to edit
 * it. A separate store owes that code nothing.
 *
 * ## Why the key is not the URL
 *
 * Same reason as artCache: a stream URL carries the rotating `?t=` token and
 * the server's own origin, so keying by it would orphan the entire buffer
 * roughly hourly. Entries are keyed by track path, under a synthetic origin
 * that never resolves.
 *
 * ## What it deliberately does not do
 *
 * It does not hold effect-rendered audio. Filters, the FX chain and stem drops
 * are rendered server-side (see effects.ts), so bytes fetched plain are simply
 * the wrong song while one of those is on, and `bufferedAudioUrl` declines -
 * with the one exception the vault also makes, that a silent server turns the
 * question from "with filters or without" into "without filters or not at all".
 */

import type { Track } from '../core/tauri.ts';
import { setQueueBufferResolver } from '../core/tauri.ts';
import { effectsOn } from './effects.ts';
import { fxChainOn } from './fxChain.ts';
import { stemDropParam } from './stemDrop.ts';
import { trackIdFromPath } from '../server.ts';
import { serverSeemsDown } from '../api/reachability.ts';

const CACHE = 'attackfm-queue-v1';
/** A host that cannot be reached on purpose - these keys are matched, never
 *  fetched. */
const KEY_ORIGIN = 'https://queue.attackfm.local';

/**
 * How far ahead to hold, and how much room it may take.
 *
 * Ten songs is what was asked for and roughly what a lift, a tunnel or a lost
 * cell handover costs you. The byte ceiling is the real governor though: ten
 * lossless tracks is around 350MB and ten long ones rather more, and a buffer
 * that can outgrow a phone's free space to hold music nobody has asked to keep
 * is a bug however good the intent.
 */
const AHEAD = 10;
/** A couple behind, because "skip around" includes going back. */
const BEHIND = 2;
const BUDGET_BYTES = 600 * 1024 * 1024;
/** Bigger than any plausible song: a body this large is a mistake, not music. */
const MAX_TRACK_BYTES = 200 * 1024 * 1024;

function store(): Promise<Cache> | null {
  if (typeof caches === 'undefined') return null;
  try {
    return caches.open(CACHE);
  } catch {
    return null;
  }
}

function keyFor(path: string): string {
  return `${KEY_ORIGIN}/${encodeURIComponent(path)}`;
}

/**
 * Whether the buffer may answer for this track at all.
 *
 * Deliberately the same shape as offline.ts's `offlineSource`, including the
 * order: the outage check comes FIRST, so a song that would otherwise be
 * refused for carrying an effect still plays when there is nothing to render it.
 */
function mayServe(path: string): boolean {
  if (serverSeemsDown()) return true;
  if (effectsOn() || fxChainOn()) return false;
  return stemDropParam(trackIdFromPath(path)) === null;
}

/** What is held right now, by track path. Mirrors the store so the resolver and
 *  the sweep can both answer without awaiting a cache open. */
const held = new Map<string, number>();
let indexed = false;

async function index(): Promise<void> {
  if (indexed) return;
  indexed = true;
  const cache = await store();
  if (!cache) return;
  try {
    for (const req of await cache.keys()) {
      const path = decodeURIComponent(req.url.slice(KEY_ORIGIN.length + 1));
      // Size is unknown until read; 0 means "held, cost not yet counted", which
      // only matters to the budget and is corrected on the next write.
      if (path) held.set(path, 0);
    }
  } catch {
    /* An unreadable store is an empty one. */
  }
}

/**
 * Blob URLs, kept to a strict two.
 *
 * A blob URL pins its Blob in memory for as long as it is alive, so holding one
 * per buffered song would put the whole window in RAM - which is the opposite
 * of the point, and on Android is how the vault OOMed. Two is the working set:
 * the song playing and the one being handed to the idle deck.
 */
const blobs = new Map<string, string>();

function rememberBlob(path: string, url: string): string {
  while (blobs.size >= 2) {
    const oldest = blobs.entries().next().value;
    if (!oldest) break;
    URL.revokeObjectURL(oldest[1]);
    blobs.delete(oldest[0]);
  }
  blobs.set(path, url);
  return url;
}

/**
 * The buffered bytes for a track, as something an `<audio>` can play.
 *
 * A blob URL rather than the cached Response itself: the media element cannot
 * be handed a Response, and a blob is a complete in-memory resource so seeking
 * inside it needs no range request and no network at all - which is the whole
 * reason this exists. The same trick the Android vault already plays.
 */
export async function bufferedAudioUrl(path: string): Promise<string | null> {
  if (!held.has(path) || !mayServe(path)) return null;
  const alive = blobs.get(path);
  if (alive) return alive;
  const cache = await store();
  if (!cache) return null;
  try {
    const hit = await cache.match(keyFor(path));
    if (!hit) {
      held.delete(path);
      return null;
    }
    const blob = await hit.blob();
    if (blob.size === 0) {
      held.delete(path);
      return null;
    }
    held.set(path, blob.size);
    return rememberBlob(path, URL.createObjectURL(blob));
  } catch {
    return null;
  }
}

/** Whether a track is already held - the cheap check, for callers deciding
 *  whether a fetch is worth starting. */
export function isBuffered(path: string): boolean {
  return held.has(path);
}

let filling = false;

/**
 * Fill the window around the current track, then drop everything outside it.
 *
 * ONE fetch in flight, always. The device is usually streaming a song while
 * this runs, and a handful of parallel whole-file downloads is exactly how you
 * turn a working stream into a stuttering one - the buffer would cause the
 * stall it exists to prevent. Sequential also means an outage costs one failed
 * request rather than ten.
 *
 * `resolve` hands back the URL playback itself would use, so a buffered song is
 * bit-identical to the streamed one and costs the hub exactly one ordinary read.
 */
export async function warmQueue(
  queue: Track[],
  currentPath: string | null,
  resolve: (path: string) => Promise<string | null>,
): Promise<void> {
  if (filling) return;
  const cache = await store();
  if (!cache) return;
  await index();

  if (!currentPath) return;
  const at = queue.findIndex((t) => t.path === currentPath);
  // Nothing to build a window around: the playing track is not in this queue
  // (opened from a page, or the DJ's own pick), so there is no "next" to hold.
  if (at === -1) return;
  // Forward first: the overwhelmingly likely direction, and the order the
  // fetches happen in below.
  const window = [
    ...queue.slice(at + 1, at + 1 + AHEAD),
    ...queue.slice(Math.max(0, at - BEHIND), at),
  ].filter((t) => t.path !== currentPath);

  filling = true;
  try {
    // Evict first, so the room a departing track frees is available to the
    // arrivals below rather than only on the next pass.
    const keep = new Set(window.map((t) => t.path));
    keep.add(currentPath);
    for (const path of [...held.keys()]) {
      if (keep.has(path)) continue;
      held.delete(path);
      blobs.delete(path);
      try {
        await cache.delete(keyFor(path));
      } catch {
        /* Already gone is the outcome we wanted. */
      }
    }

    let spent = [...held.values()].reduce((a, b) => a + b, 0);
    for (const t of window) {
      if (held.has(t.path)) continue;
      if (spent >= BUDGET_BYTES) break;
      // Only server tracks: a file already on this device plays without help,
      // and copying it into a second store would spend the room twice.
      if (!t.path.startsWith('afm://')) continue;
      const url = await resolve(t.path);
      if (!url || !/^https?:/i.test(url)) continue;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const body = await res.blob();
        if (body.size === 0 || body.size > MAX_TRACK_BYTES) continue;
        await cache.put(keyFor(t.path), new Response(body));
        held.set(t.path, body.size);
        spent += body.size;
      } catch {
        /*
         * A failed warm is not an error anybody needs to see. The network is
         * the thing this feature exists BECAUSE it is unreliable, and the
         * player has lost nothing - it streams exactly as it did before.
         * Stop the pass rather than grinding through nine more failures.
         */
        break;
      }
    }
  } finally {
    filling = false;
  }
}

/** Drop the whole buffer - sign-out, or a server swap, where every held byte
 *  belongs to a library this device is no longer looking at. */
export async function clearQueueBuffer(): Promise<void> {
  held.clear();
  for (const url of blobs.values()) URL.revokeObjectURL(url);
  blobs.clear();
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE);
  } catch {
    /* Nothing to clear. */
  }
  indexed = false;
}

// Registered rather than imported, for the same reason the vault is: tauri.ts
// is the bottom of the graph and must not reach up into the player.
setQueueBufferResolver(bufferedAudioUrl);
