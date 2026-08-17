//! The device cache: the songs most likely to be wanted next, kept locally.
//!
//! The offline vault (offline.ts) is deliberate - you pin a song, it stays.
//! This is the other half: nobody chooses, the phone just quietly holds what
//! it can work out you will reach for. Liked songs first, then what is
//! actually on repeat, then what was played recently. On a hub that lives in a
//! house rather than a datacentre, that turns "the wifi is bad" and "I left"
//! into non-events for the music that matters most.
//!
//! TWO RULES SHAPE EVERYTHING HERE.
//!
//! First: **the budget governs this cache only, never a pin.** A song someone
//! deliberately kept for a flight must not be deleted to make room for one an
//! algorithm liked. So the ledger below records what the SWEEP put on disk;
//! anything held that this ledger does not know about is treated as a manual
//! pin and is never touched. Unknown means untouchable, which is the safe way
//! for that guess to be wrong.
//!
//! Second: **the disk stays the index.** offline.rs recovers what is held by
//! listing a folder, and that remains the authority on what exists. This
//! ledger holds only POLICY - which entries this cache is responsible for -
//! and is reconciled against the folder on every sweep, so a restore, a wipe
//! or an OS reclaim cannot leave it believing in files that are gone.

import { rememberArt } from './artCache.ts';
import { artSized, artUrl, loadCachedIndex, remotePath, streamUrl, trackIdFromPath, type RemoteTrack, type ServerSession } from '../server.ts';
import { heldPath, offlineEntries, offlineSpace, pinTrack, unpinTrack } from '../downloads/offline.ts';
import { pickSource } from '../servers/mirrors.ts';
import { isTauri, type Track } from '../core/tauri.ts';
import { DENY_KEY, cacheLimitBytes, deniedKeys, notifyCacheChange, readLedger, writeLedger } from './cacheStore.ts';
import { rankHotness } from './cacheHotness.ts';
import { persistManifest, setManifest, setManifestState, writeReport } from './cacheManifest.ts';

// --- the sweep -------------------------------------------------------------

export interface SweepResult {
  /** Bytes this cache is holding after the pass. */
  bytes: number;
  downloaded: number;
  evicted: number;
  /** Bytes held by manual pins, which sit outside the budget. */
  pinnedBytes: number;
}

/**
 * How many downloads run at once: six on an idle deck, two under a song.
 *
 * Two was sized when a download buffered its whole file through memory; now
 * they stream to disk, and the server end is plain file serving with no limit
 * of its own, so the client is the only throttle. Parallelism genuinely pays
 * here - the hub is usually far away (Tailscale, often relayed), and on a
 * high-latency path a couple of TCP streams cannot fill the pipe that six
 * can. The stall watchdog is per-stream and counts SILENCE, not slowness, so
 * six streams sharing a thin uplink do not trip it.
 *
 * Under a playing song the old caution stands: the deck shares that same
 * uplink, and a stutter on the music to fill the cache faster is the wrong
 * trade. Extra workers drain off live when a song starts mid-sweep.
 */
const CONCURRENCY_IDLE = 6;
const CONCURRENCY_PLAYING = 2;

let playbackAudible = false;

/** The player says whether sound is coming out; the sweep sizes itself by it. */
export function notePlaybackAudible(audible: boolean): void {
  playbackAudible = audible;
}

/** A track whose size the index does not know cannot be budgeted for, so it is
 *  assumed to be about an average lossless song rather than skipped. */
const ASSUMED_BYTES = 35 * 1024 ** 2;

function toTrackish(remote: RemoteTrack): Track {
  return {
    path: remotePath(remote.id),
    title: remote.title,
    artist: remote.artist,
    album: remote.album,
    duration: remote.duration,
    addedAt: remote.addedAt,
    codec: remote.codec,
  } as Track;
}

/**
 * Decide what the cache should hold and what it must let go.
 *
 * Pure on purpose: this is the half that can delete a file, and it should be
 * checkable without a phone, a server or a disk. Everything it needs is passed
 * in; everything it decides comes back as two lists.
 */
export function planCache(input: {
  /** Library keys, hottest first. */
  ranked: string[];
  /** Key -> size in bytes, for the ones the index knows. */
  sizes: Map<string, number>;
  /** Keys currently on disk, cache-owned or not. */
  onDisk: Set<string>;
  /** Keys this cache owns; everything else on disk is a manual pin. */
  owned: Set<string>;
  limitBytes: number;
}): { keep: string[]; evict: string[]; plannedBytes: number } {
  const { ranked, sizes, onDisk, owned, limitBytes } = input;
  const keep: string[] = [];
  let planned = 0;
  if (limitBytes > 0) {
    for (const key of ranked) {
      // Held by hand already: it plays offline either way, and charging the
      // budget for it would shrink the cache every time someone pinned a song.
      if (onDisk.has(key) && !owned.has(key)) continue;
      const size = sizes.get(key) || ASSUMED_BYTES;
      // `continue`, not `break`: a single huge file near the ceiling should not
      // stop every smaller song behind it from fitting.
      if (planned + size > limitBytes) continue;
      planned += size;
      keep.push(key);
    }
  }
  const wanted = new Set(keep);
  // Only ever cache-owned keys. A manual pin is never in this list, which is
  // the invariant the whole design rests on.
  const evict = [...owned].filter((key) => !wanted.has(key));
  return { keep, evict, plannedBytes: planned };
}

/**
 * Bring the device cache in line with what the listener actually wants.
 *
 * One pass: rank, fill to the budget, then drop whatever this cache is holding
 * that no longer makes the list. That single rule covers both halves of
 * rotation - a song goes when it goes cold, and equally when something hotter
 * needs the room - so there is no separate eviction policy to disagree with
 * the admission one.
 */
/** Room the cache must leave alone whatever its budget says. */
const SPACE_FLOOR = 2 * 1024 ** 3;

/**
 * The budget, clamped to what the disk can actually give.
 *
 * A limit is a ceiling, not a promise: someone can choose 15 GB on a phone
 * with 3 GB left, and then the cache is the reason there is no room for
 * photos. So the effective budget is never more than what is free beyond a
 * floor, plus what the cache is already holding (which it can reuse). Where
 * free space cannot be read the stored limit stands, which is how this
 * behaved before.
 */
async function affordable(limit: number): Promise<number> {
  if (limit === 0) return 0;
  const room = await offlineSpace();
  if (!room || room.freeBytes === null) return limit;
  const ceiling = Math.max(0, room.freeBytes - SPACE_FLOOR) + room.heldBytes;
  return Math.min(limit, ceiling);
}

export async function sweepCache(
  session: ServerSession,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<SweepResult> {
  const limit = await affordable(cacheLimitBytes());

  // The folder is the authority on what exists; the ledger only says which of
  // it is ours. Reconciling here is what survives a restore or a wipe.
  const onDisk = await offlineEntries();
  const diskKeys = new Set(onDisk.map((e) => e.key));
  let ledger = readLedger();
  for (const key of Object.keys(ledger)) {
    if (!diskKeys.has(key)) delete ledger[key];
  }

  const pinnedBytes = onDisk.filter((e) => !(e.key in ledger)).reduce((n, e) => n + e.bytes, 0);
  const bytesOf = new Map(onDisk.map((e) => [e.key, e.bytes] as const));

  // Turned off: give back everything this cache owns, and nothing else.
  if (limit === 0 || !isTauri()) {
    let evicted = 0;
    for (const key of Object.keys(ledger)) {
      await unpinTrack(key);
      evicted += 1;
    }
    writeLedger({});
    // Two very different reasons to hold nothing, and the pane should not
    // report them the same way. A clamped budget is the interesting one: the
    // setting says 15 GB and the phone says otherwise.
    const stored = cacheLimitBytes();
    writeReport({
      at: Date.now(),
      note:
        !isTauri()
          ? 'Only the app can keep songs on a device'
          : stored === 0
            ? 'Keeping songs is switched off'
            : 'No room on this device right now',
      kept: 0,
      failed: 0,
      skippedUnknown: 0,
      liked: 0,
      limitBytes: limit,
    });
    return { bytes: 0, downloaded: 0, evicted, pinnedBytes };
  }

  const { keys: ranked, liked = 0 } = await rankHotness(session);
  // A song deleted by hand stays deleted: denied keys never re-enter the plan.
  const denied = deniedKeys();
  const keys = ranked.filter((key) => !denied.has(key));
  const index = loadCachedIndex(session.url);
  const byId = new Map(index.tracks.map((t) => [t.id, t] as const));

  // Fill the budget in rank order. A song already pinned by hand is skipped
  // rather than counted: it is held either way, and charging the cache for it
  // would shrink the cache every time someone pinned something.
  // Only songs this server's index can size and name are candidates.
  const known = new Map<string, RemoteTrack>();
  const sizes = new Map<string, number>();
  let skippedUnknown = 0;
  for (const key of keys) {
    const id = trackIdFromPath(key);
    if (id === null) continue;
    const remote = byId.get(id);
    // Wanted, but this device's copy of the library index has never heard of
    // it - so it cannot be sized, named or fetched. Counted rather than
    // dropped in silence: a stale index is invisible otherwise, and it is the
    // likeliest reason a liked song never arrives.
    if (!remote) {
      skippedUnknown += 1;
      continue;
    }
    known.set(key, remote);
    sizes.set(key, remote.sizeBytes || ASSUMED_BYTES);
  }

  const plan = planCache({
    ranked: [...known.keys()],
    sizes,
    onDisk: diskKeys,
    owned: new Set(Object.keys(ledger)),
    limitBytes: limit,
  });
  const want = new Map(plan.keep.map((key) => [key, known.get(key)!] as const));

  // The plan, published before a byte moves: already-held songs are done on
  // arrival, the rest wait their turn.
  setManifest(plan.keep.map((key) => {
    const remote = known.get(key)!;
    return {
      key,
      title: remote.title,
      artist: remote.artist,
      art: remote.artId ? artUrl(session, remote.artId, remote.id) : null,
      bytes: remote.sizeBytes || 0,
      state: heldPath(key) ? ('done' as const) : ('waiting' as const),
    };
  }));
  persistManifest();
  notifyCacheChange();

  // Evict first, so the room exists before anything is fetched.
  let evicted = 0;
  for (const key of plan.evict) {
    await unpinTrack(key);
    delete ledger[key];
    evicted += 1;
  }
  writeLedger(ledger);

  const missing = [...want.entries()].filter(([key]) => !heldPath(key));
  let done = 0;
  let downloaded = 0;
  let failed = 0;
  const failReasons = new Map<string, number>();
  options.onProgress?.(0, missing.length);

  const worker = async (lane: number) => {
    for (;;) {
      // A song starting mid-sweep drains the extra lanes: each checks its own
      // number before pulling more work, so the pass narrows to two without
      // dropping anything mid-file.
      if (playbackAudible && lane >= CONCURRENCY_PLAYING) return;
      const next = missing.shift();
      if (!next || options.signal?.aborted) return;
      const [key, remote] = next;
      // Fetched from whichever server is nearest, exactly as playback would -
      // filling the cache is the one job where that choice matters most.
      const via = pickSource(session, remote.id);
      const from = via ? { ...session, url: via.url, streamToken: via.streamToken } : session;
      const url = streamUrl(from, via ? via.trackId : remote.id);
      setManifestState(key, 'downloading');
      let host = '';
      try {
        host = new URL(from.url).host;
      } catch {
        host = from.url;
      }
      /*
       * Up to three attempts per song, because the two failures that survive
       * everything else are transient by nature: "error sending request" is a
       * connect that never established (six TLS handshakes at once through a
       * Tailscale relay will drop a few), and "error decoding response body"
       * is a reset mid-file. Both deserve a second try more than they deserve
       * a red tile and a human pressing Retry. A "server answered 4xx" is a
       * REFUSAL, not weather - retrying it is asking the same question louder
       * - so it fails at once.
       *
       * The 6-minute race is per attempt: it is the belt over the Rust side's
       * 45-second stall watchdog, sized for the biggest lossless file on the
       * slowest honest link.
       */
      let ok = false;
      let lastReason = '';
      for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
        if (options.signal?.aborted) break;
        if (attempt > 0) {
          // 2s then 4s, with jitter so retrying lanes do not re-collide.
          await new Promise((r) => window.setTimeout(r, attempt * 2000 + Math.random() * 800));
        }
        try {
          ok = await Promise.race([
            pinTrack(toTrackish(remote), url),
            new Promise<never>((_, reject) =>
              window.setTimeout(() => reject(new Error('gave up after 6 minutes')), 6 * 60 * 1000),
            ),
          ]);
          if (!ok) lastReason = `${host}: download did not finish`;
        } catch (err: unknown) {
          const msg = String(err).replace(/^Error:\s*/, '').slice(0, 90);
          lastReason = `${host}: ${msg}`;
          if (/server answered 4/.test(msg)) break;
        }
      }
      if (ok) {
        setManifestState(key, 'done');
        downloaded += 1;
        ledger[key] = Date.now();
        writeLedger(ledger);
        // The cover travels with the song. A pinned track whose art still
        // lives on the server is only half held: it plays through a dark
        // home server and draws as a grey square. Both sizes, because the
        // shelves ask for 640 and the tables for 160, and a miss on either
        // is the placeholder again. Never awaited - a cover that does not
        // arrive must not fail, slow, or retry the download it rode in on.
        for (const px of [160, 640] as const) {
          const cover = artSized(artUrl(session, remote.artId ?? '', remote.id), px);
          if (remote.artId && cover) void rememberArt(cover);
        }
      } else {
        const reason = lastReason || `${host}: download did not finish`;
        failReasons.set(reason, (failReasons.get(reason) ?? 0) + 1);
        setManifestState(key, 'failed', reason);
        failed += 1;
      }
      done += 1;
      options.onProgress?.(done, done + missing.length);
    }
  };
  await Promise.all(
    Array.from(
      { length: playbackAudible ? CONCURRENCY_PLAYING : CONCURRENCY_IDLE },
      async (_, lane) => {
        // Staggered starts: six connects in the same instant through the same
        // relay is how "error sending request" happens on an otherwise fine
        // link. 300ms apart costs nothing against whole files.
        await new Promise((r) => window.setTimeout(r, lane * 300));
        return worker(lane);
      },
    ),
  );

  const after = await offlineEntries();
  const ours = after.filter((e) => e.key in readLedger());
  persistManifest();
  writeReport({
    at: Date.now(),
    note: (() => {
      if (liked === -1) return 'Could not ask the server which songs you like';
      if (failed > 0) {
        const top = [...failReasons.entries()].sort((a, b) => b[1] - a[1])[0];
        return `${failed} ${failed === 1 ? 'song' : 'songs'} would not download${top ? ` — ${top[0]}` : ''}`;
      }
      if (skippedUnknown > 0 && downloaded === 0)
        return 'Waiting for this device to finish syncing the library';
      return `${ours.length} kept on this device`;
    })(),
    kept: ours.length,
    failed,
    failReasons: [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([reason, n]) => ({ reason, n })),
    skippedUnknown,
    liked,
    limitBytes: limit,
  });
  notifyCacheChange();
  return {
    bytes: ours.reduce((n, e) => n + e.bytes, 0),
    downloaded,
    evicted,
    pinnedBytes: after.filter((e) => !(e.key in readLedger())).reduce((n, e) => n + e.bytes, 0),
  };
}

/** What the cache is holding right now, without changing anything. */
export async function cacheUsage(): Promise<{ bytes: number; count: number; pinnedBytes: number; pinnedCount: number }> {
  const entries = await offlineEntries();
  const ledger = readLedger();
  const ours = entries.filter((e) => e.key in ledger);
  const pins = entries.filter((e) => !(e.key in ledger));
  return {
    bytes: ours.reduce((n, e) => n + e.bytes, 0),
    count: ours.length,
    pinnedBytes: pins.reduce((n, e) => n + e.bytes, 0),
    pinnedCount: pins.length,
  };
}

/** Drop everything the cache owns, leaving pins alone - and the denials with
 *  it: clearing the cache is a fresh start, and a fresh start includes the
 *  songs you once told it to stop bringing back. */
export async function clearCache(): Promise<void> {
  const ledger = readLedger();
  for (const key of Object.keys(ledger)) await unpinTrack(key);
  writeLedger({});
  try {
    localStorage.removeItem(DENY_KEY);
  } catch {
    // A denial that survives a clear is only a song that stays deleted.
  }
  notifyCacheChange();
}
