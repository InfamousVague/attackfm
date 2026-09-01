//! The device cache: the songs most likely to be wanted next, kept locally.
//!
//! The offline vault (offline.ts) is deliberate - you pin a song, it stays.
//! This is the other half: nobody chooses, the phone just quietly holds what
//! it can work out you will reach for. Liked songs first, then everything in a
//! playlist, then what is actually on repeat, then what was played recently. On
//! a hub that lives in a house rather than a datacentre, that turns "the wifi
//! is bad" and "I left" into non-events for the music that matters most.
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

import { clearArtCache, rememberArt } from './artCache.ts';
import { clearCanvasCache, ensureCanvas } from './canvasCache.ts';
import { artSized, artUrl, fetchCanvas, loadCachedIndex, remotePath, streamUrl, trackIdFromPath, transcodeUrl, type RemoteTrack, type ServerSession } from '../server.ts';
import { heldNameIsHex, heldPath, offlineEntries, offlineSpace, pinTrack, rebrandHeld, unpinTrack } from '../downloads/offline.ts';
import { pickSource } from '../servers/mirrors.ts';
import { isTauri, type Track } from '../core/tauri.ts';
import {
  DENY_KEY,
  appliedQualityKbps,
  cacheLimitBytes,
  cacheQualityKbps,
  deniedKeys,
  notifyCacheChange,
  pinnedKeys,
  readLedger,
  rememberAppliedQuality,
  writeLedger,
} from './cacheStore.ts';
import { estimateBytes, extFor, qualityOfPath, wantedQuality } from './cacheQuality.ts';
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
/* Six at once is right for six file reads. It is not right for six simultaneous
   real-time ffmpeg encodes on a Mac in somebody's house, which is what the
   transcode path actually asks for - and with no byte ranges to resume from,
   every retry pays for the whole encode a second time. */
const CONCURRENCY_TRANSCODE = 3;
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

  /*
   * ADOPT what nobody claims.
   *
   * Reconciling used to run one way: forget ledger entries whose file is gone.
   * The other direction was left undone, and it is the one that bites - a file
   * on disk that the ledger does not know about was silently treated as the
   * listener's own, because "kept by hand" was defined as "not ours" rather
   * than recorded. The ledger is localStorage and the files are disk, so one
   * cleared webview store re-labels the entire cache and, since the planner
   * only evicts what the ledger owns, stops it evicting anything ever again.
   *
   * Now the pins are recorded, so absence is answerable: not ours AND not
   * pinned means ours with the record lost. Take it back. The cache resumes
   * managing it, the pane stops reporting gigabytes nobody chose, and the
   * worst case - a genuine pin whose mark was lost along with the ledger -
   * costs a tap to re-pin, against a cache that otherwise wedges for good.
   */
  const pins = pinnedKeys();
  for (const e of onDisk) {
    if (!(e.key in ledger) && !pins.has(e.key)) ledger[e.key] = Date.now();
  }

  const pinnedBytes = onDisk.filter((e) => pins.has(e.key)).reduce((n, e) => n + e.bytes, 0);
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

  // Read once per sweep so every decision in this pass agrees about it, even
  // if somebody moves the slider while it runs.
  const kbps = cacheQualityKbps();
  const idleLanes = kbps === 0 ? CONCURRENCY_IDLE : CONCURRENCY_TRANSCODE;
  const { keys: ranked, liked = 0 } = await rankHotness(session);
  // A song deleted by hand stays deleted: denied keys never re-enter the plan.
  const denied = deniedKeys();
  const keys = ranked.filter((key) => !denied.has(key));
  const index = loadCachedIndex(session.url);
  const byId = new Map(index.tracks.map((t) => [t.id, t] as const));

  // Files cached before the readable-name era still sit on disk as hex; now
  // that the library index is in hand, hand the vault their real names. One
  // batched call per sweep, and only for files that are actually still hex.
  const rebrands = onDisk
    .filter((e) => heldNameIsHex(e.key))
    .map((e) => {
      const remote = byId.get(trackIdFromPath(e.key) ?? -1);
      if (!remote) return null;
      return { key: e.key, name: [remote.artist, remote.title].filter(Boolean).join(' - ') };
    })
    .filter((r): r is { key: string; name: string } => r !== null && r.name !== '');
  await rebrandHeld(rebrands);

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
    /*
     * What this song will actually take up on this disk, which is not the same
     * question as what it would take up if it were fetched fresh.
     *
     * A file already held is held at whatever quality it was fetched at, and
     * requalify converts only a few dozen per sweep - so budgeting the whole
     * library at the NEW estimate while thousands of lossless files sit on the
     * disk lets the cache overshoot its limit by a large multiple, for as long
     * as the conversion takes. The user sets 15GB and the folder keeps growing.
     *
     * So: a held file costs its real measured bytes, an unheld one costs the
     * estimate. As requalify works through them the real numbers fall and the
     * budget frees up on its own, with no separate reconciliation to get wrong.
     */
    const onDiskBytes = bytesOf.get(key);
    sizes.set(
      key,
      onDiskBytes !== undefined
        ? onDiskBytes
        : estimateBytes(remote, wantedQuality(remote, kbps), ASSUMED_BYTES),
    );
  }

  const plan = planCache({
    ranked: [...known.keys()],
    sizes,
    onDisk: diskKeys,
    owned: new Set(Object.keys(ledger)),
    limitBytes: limit,
  });
  const want = new Map(plan.keep.map((key) => [key, known.get(key)!] as const));
  // Everything the ranking asked for that the budget could not seat.
  const budgetShort = Math.max(0, known.size - plan.keep.length);

  // The plan, published before a byte moves: already-held songs are done on
  // arrival, the rest wait their turn.
  setManifest(plan.keep.map((key) => {
    const remote = known.get(key)!;
    return {
      key,
      title: remote.title,
      artist: remote.artist,
      art: remote.artId ? artUrl(session, remote.artId, remote.id) : null,
      bytes: estimateBytes(remote, wantedQuality(remote, kbps), ASSUMED_BYTES),
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

  /*
   * A stale fragment must not be resumed into a file of a different quality.
   *
   * `offline_pin` names its fragment `<hex>.part` with no extension in it, so an
   * abandoned 128k encode leaves a fragment indistinguishable from an abandoned
   * lossless download. The next attempt sees bytes already there and sends
   * `Range: bytes=N-`.
   *
   * Only ONE direction is dangerous, and it is worth being exact about which.
   * The transcode endpoint ignores Range and answers 200, which the Rust side
   * correctly reads as "not resumable" and truncates - so lossless-to-lossy and
   * lossy-to-lossy are safe by the server's own behaviour. But the ORIGINAL file
   * endpoint honours Range with a 206, so going BACK to lossless over a lossy
   * fragment appends FLAC bytes to an AAC head and produces a file that passes
   * every check this code can make and is garbage.
   *
   * Done lazily, inside the worker, rather than as a pass over `missing` up
   * front: `offline_unpin` reads the whole directory on every call, so clearing
   * a few thousand keys eagerly is quadratic and stalls the sweep before a
   * single byte moves. Here it costs one directory read per song actually
   * attempted, and no song is attempted without it.
   *
   * This narrows the window rather than closing it. The structural fix is to put
   * the extension in the fragment's name - two lines in offline.rs, needing a
   * native build - and until that ships this must not be leaned on for a
   * fragment left behind by a sweep killed mid-change.
   */
  const applied = appliedQualityKbps();
  /*
   * Has the setting moved since the last sweep? That is all this says; whether a
   * given song is at risk is decided per song, at the download.
   *
   * Keying the whole thing on `kbps === 0` was too narrow and missed a real
   * case: the up-convert guard means a track's wanted quality can be 0 while the
   * SETTING is 128 - a 128k MP3 under a 128k setting keeps its original file. If
   * that track had an AAC fragment left from an earlier 256k setting, it would
   * be fetched from the Range-honouring original endpoint with the guard
   * switched off, which is the exact corruption this exists to prevent.
   */
  const settingChanged = applied !== null && applied !== kbps;
  /*
   * Recorded HERE, before a single byte moves, and this placement is the whole
   * point of it.
   *
   * It used to be written at the end of a completed pass, which sounds careful
   * and is exactly backwards: the marker's job is to say what quality the
   * fragments ON DISK were written at, and fragments are left behind precisely
   * by passes that DID NOT finish. A sweep killed mid-encode - the app
   * backgrounded and reaped, the webview reloaded - left the marker still
   * reading lossless while lossy fragments sat on disk, so a later switch back
   * to lossless saw applied === 0, skipped the clear, resumed with a Range the
   * original endpoint honours, and appended FLAC onto an AAC head. That file
   * then passes every check this code can make: non-zero, renamed into place,
   * ledgered, and preferred over the network by `offlineSource` for good.
   *
   * The old `!options.signal?.aborted` condition was dead in any case - neither
   * caller passes a signal - so the interruption it guarded against was never
   * the kind that actually happens.
   */
  rememberAppliedQuality(kbps);

  /*
   * Songs already held at the wrong quality, a few dozen per sweep.
   *
   * Without this, changing the setting does nothing to the gigabytes already on
   * the phone - which is the whole reason somebody changed it. The sweep's
   * held-check is only "does a file exist for this key", so a lossless copy
   * satisfies a 128k setting forever.
   *
   * Rate-limited rather than done in one pass. Switching to a lossy setting
   * makes the same budget hold roughly seven times more songs, and every one of
   * them is a real-time encode on a machine in somebody's house. Forty a sweep
   * turns a thundering herd into something that finishes over a day of ordinary
   * check-ins.
   *
   * Coldest first: the tail is nearest eviction anyway, so re-fetching it is the
   * cheapest work available, and the songs most likely to be reached for keep
   * the copy they already have for longest.
   *
   * Hand-pinned songs cannot appear here: `planCache` skips anything on disk it
   * does not own, so `want` never contains one. A pin is a stated request for a
   * SONG, and rewriting it to satisfy a later setting is not this code's
   * business.
   *
   * Unpin BEFORE fetching, which costs a brief window where the song is not
   * offline. Fetching first is worse: `offline_pin` is keyed by extension, so it
   * would leave TWO files for one key, `offline_list` would return it twice, the
   * usage bar would double-count it, and directory order would decide which one
   * plays. The window is self-healing - the next sweep finds the song in
   * `missing` and fetches it.
   */
  const REQUALIFY_PER_SWEEP = 40;
  const requalify: [string, RemoteTrack][] = [];
  for (const [key, remote] of want) {
    const file = heldPath(key);
    if (!file) continue;
    if (qualityOfPath(file) !== wantedQuality(remote, kbps)) requalify.push([key, remote]);
  }
  const toRequalify = requalify.reverse().slice(0, REQUALIFY_PER_SWEEP);
  /*
   * Marked now, deleted one at a time in the worker - NOT deleted here.
   *
   * Deleting all forty up front assumes the replacements are obtainable, and
   * when that assumption is wrong it is catastrophic rather than merely wrong. A
   * hub with no ffmpeg answers 503 to every transcode; the forty songs are then
   * gone from the disk with nothing to put back, the next sweep takes forty
   * more, and the offline library drains at eighty songs an hour while the
   * receipt says only that some downloads failed. A mirror without the route,
   * or an older hub that 404s, does exactly the same.
   *
   * Unpinning inside the worker instead costs one song per failure rather than
   * forty, and `lossyRefused` below stops even that after the first refusal.
   */
  const requalifying = new Set(toRequalify.map(([key]) => key));
  missing.push(...toRequalify);

  /*
   * Set when the server proves it cannot re-encode at all - a 503 from a box
   * with no ffmpeg, or a 404 from one too old to have the route.
   *
   * Once that is known, converting anything further is not just futile, it is
   * destructive: every requalify would delete a good file to replace it with a
   * refusal. So the rest of the pass leaves held files alone and fetches what is
   * still missing at lossless, which is the quality that box can actually serve.
   */
  let lossyRefused = false;

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
      const rowId = via ? via.trackId : remote.id;
      // Lossless is the original file, byte-ranged and resumable. Anything else
      // is a live encode: no length, no ranges, and it costs the box a core for
      // the length of the song.
      //
      // fx/fx2/drop are passed as an explicit null rather than omitted, and that
      // is deliberate. The PLAYER's resolver folds the effects rack into this
      // same URL, and a cached file that had a rack baked into it would be a
      // file `offlineSource` then refuses to serve the moment the rack changes -
      // paid for, held, and unreachable. Naming them here says the omission is a
      // decision rather than something nobody thought about.
      // A box that has already refused one re-encode will refuse them all, so
      // the rest of the pass asks for what it can actually serve.
      const quality = lossyRefused ? 0 : wantedQuality(remote, kbps);
      const url =
        quality === 0
          ? streamUrl(from, rowId)
          : transcodeUrl(from, rowId, quality, 0, null, null, null);

      // A song being converted is deleted HERE, immediately before its own
      // replacement is fetched, so a refusal costs one file rather than forty.
      // Skipped once the server has refused: there is nothing to replace it
      // with, and the copy on disk is better than no copy at all.
      if (requalifying.has(key)) {
        if (lossyRefused) {
          setManifestState(key, 'done');
          continue;
        }
        // `pinnedKeys` is re-asked rather than taken from the snapshot at the
        // top of the sweep: keep a song by hand while the pass is running and it
        // becomes a stated request mid-flight. Converting it would delete the
        // file and, through `unmarkPinned`, the record that it was asked for.
        // Requalify is the cache tidying its own copies, and this one stopped
        // being one of those.
        if (pinnedKeys().has(key)) {
          setManifestState(key, 'done');
          continue;
        }
        await unpinTrack(key);
      }
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
      /*
       * See clearStaleFragment above: only when returning to lossless, and only
       * for songs this sweep is about to fetch.
       *
       * `heldPath` is re-asked HERE rather than trusted from when `missing` was
       * built. That list is a snapshot, and a sweep runs for minutes: keep a
       * song by hand while one is in flight and it is now held, complete, and
       * still sitting in this list. `unpinTrack` deletes every file matching the
       * key AND calls `unmarkPinned`, so acting on the stale answer would delete
       * the song somebody just asked to keep and erase the mark that says they
       * asked. Re-checking costs a map lookup.
       *
       * Skipping is also correct rather than merely safe: a complete file means
       * `offline_pin` would early-return anyway, so there is no download for a
       * fragment to corrupt.
       */
      // `quality === 0` is the whole risk: it is the only path that goes to the
      // original endpoint, and the original endpoint is the only one that
      // honours a Range. A transcode answers 200 and truncates, which is safe.
      if (settingChanged && quality === 0 && !heldPath(key)) await unpinTrack(key);

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
            pinTrack(toTrackish(remote), url, {
              ext: extFor(remote, quality),
              /*
               * The Rust side only rejects a ZERO-byte download, so an ffmpeg
               * that dies a minute in hands back a well-formed truncated file,
               * which is renamed into place and marked done for good. A
               * transcode carries no Content-Length, so the estimate is the
               * only yardstick there is.
               *
               * HALF, and the number is measured rather than picked. Encoding
               * 30s sources at 128k and comparing against this estimate:
               * dense stereo 99.1%, MONO 99.1%, speech-like 99.1% - the
               * encoder is effectively constant-rate for anything with real
               * content in it, so a floor anywhere below ~0.9 never fires on
               * ordinary music. What does come in under is pathological
               * material: a quiet pure tone landed at 26% and digital silence
               * at 3%.
               *
               * Which is the trade this makes, stated plainly: a track that is
               * mostly silence will fail this check and show as a failed tile
               * with a reason, three retries and then a red square. That is
               * the lesser harm. The alternative is a file cut off halfway
               * through, renamed into place, ledgered as done, and preferred
               * over the network forever - invisible, permanent, and
               * indistinguishable from the song just ending.
               *
               * Skipped entirely when the track has no duration, because then
               * the estimate is a guess about a guess.
               */
              minBytes:
                quality !== 0 && remote.duration
                  ? Math.floor(estimateBytes(remote, quality, ASSUMED_BYTES) * 0.5)
                  : 0,
            }),
            new Promise<never>((_, reject) =>
              window.setTimeout(() => reject(new Error('gave up after 6 minutes')), 6 * 60 * 1000),
            ),
          ]);
          if (!ok) lastReason = `${host}: download did not finish`;
        } catch (err: unknown) {
          const msg = String(err).replace(/^Error:\s*/, '').slice(0, 90);
          lastReason = `${host}: ${msg}`;
          // A refusal is not weather. 4xx is the existing case; 503 joins it
          // because that is precisely what a box with no ffmpeg answers to
          // every single transcode request, and retrying it twice more per
          // song turns one missing binary into three thousand pointless
          // round trips. 500 stays retryable - that one really can be weather.
          if (/server answered (4|503)/.test(msg)) {
            // 503 is a box with no ffmpeg; 404 is one with no such route. Either
            // way the re-encoder is not there, and every later song in this pass
            // would meet the same wall.
            if (quality !== 0 && /server answered (503|404)/.test(msg)) lossyRefused = true;
            break;
          }
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
      { length: playbackAudible ? CONCURRENCY_PLAYING : idleLanes },
      async (_, lane) => {
        // Staggered starts: six connects in the same instant through the same
        // relay is how "error sending request" happens on an otherwise fine
        // link. 300ms apart costs nothing against whole files.
        await new Promise((r) => window.setTimeout(r, lane * 300));
        return worker(lane);
      },
    ),
  );

  // The songs are on the disk; now the way they LOOK comes too. Never allowed
  // to fail the sweep - a receipt that says "download failed" because a
  // video clip did not arrive would be lying about the music.
  try {
    await sweepPresentation(session, byId, plan.keep, options.signal);
  } catch {
    // Presentation is best-effort by definition; the songs are what matter.
  }

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
      if (budgetShort > 0)
        return `${ours.length} kept — ${budgetShort} more would not fit in the space allowed`;
      return `${ours.length} kept on this device`;
    })(),
    kept: ours.length,
    failed,
    failReasons: [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([reason, n]) => ({ reason, n })),
    skippedUnknown,
    budgetShort,
    liked,
    limitBytes: limit,
  });
  notifyCacheChange();
  return {
    bytes: ours.reduce((n, e) => n + e.bytes, 0),
    downloaded,
    evicted,
    pinnedBytes: after.filter((e) => pinnedKeys().has(e.key)).reduce((n, e) => n + e.bytes, 0),
  };
}

// --- presentation: the covers and clips beside the songs -------------------

/*
 * A cached song used to be only half held. The FILE was on the device, but
 * its cover lived in the art cache only if that exact cover had already been
 * ON SCREEN, and its Canvas clip only if the song had already been PLAYED
 * since the clip cache existed. Offline, that drew as a library that plays
 * perfectly and looks broken: grey squares on the shelves, a blurred still
 * where the clip should move. So the sweep now finishes the job it started:
 * whatever it decides to hold, it holds the presentation for too.
 */

/**
 * What the canvas lookup answered per track, remembered across sweeps.
 *
 * The lookup is the expensive half - a track without a stored clip makes the
 * hub ask Spotify - so its ANSWER is what must not be re-asked hundreds of
 * times. A "none" is trusted for two weeks (clips do appear later; Spotify
 * adds them and so does the hub's own enrichment). A found clip is remembered
 * by its stable form: the server path WITHOUT the hourly stream token, or the
 * CDN URL as given.
 */
const CANVAS_KNOWN_KEY = 'attackfm-canvas-known';
const CANVAS_NONE_TTL = 14 * 24 * 60 * 60 * 1000;
/** How deep into the hot set clips are fetched. Must stay below the clip
 *  cache's CAP (canvasCache.ts) or the fill would evict its own head. */
const CANVAS_HOT_N = 120;
/** Fresh lookups per pass - the drip that keeps the hub's Spotify session
 *  from being flooded the first time this runs over a full cache. */
const CANVAS_LOOKUPS_PER_SWEEP = 25;
/** Network attempts (fetches, not match-hits) the art backfill may spend per
 *  pass. Two variants per track, so this seats roughly 150 tracks' covers;
 *  the rest catch up on later sweeps, match-hits costing nothing forever. */
const ART_FETCHES_PER_SWEEP = 300;

/**
 * What the sweep already learned about one track's clip, for surfaces that
 * need an answer WITHOUT the network. `undefined`: never looked up (the
 * caller may ask the server). `null`: looked up, no clip (the caller can skip
 * the ask). A string: the stable form - hand it to {@link playableCanvasUrl}
 * and the canvas cache can be consulted with the hub dark.
 */
export function knownCanvasForm(trackPath: string): string | null | undefined {
  const memo = readCanvasKnown()[trackPath];
  return memo === undefined ? undefined : memo.u;
}

function readCanvasKnown(): Record<string, { u: string | null; at: number }> {
  try {
    const raw = localStorage.getItem(CANVAS_KNOWN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, { u: string | null; at: number }>) : {};
  } catch {
    return {};
  }
}

function writeCanvasKnown(memo: Record<string, { u: string | null; at: number }>): void {
  try {
    localStorage.setItem(CANVAS_KNOWN_KEY, JSON.stringify(memo));
  } catch {
    // Storage full or unavailable: the memo just will not persist, and the
    // lookup drip re-earns it a few tracks a sweep.
  }
}

/** The remembered form of a clip URL: server clips keep only their path (the
 *  token beside it expires hourly), a CDN clip keeps its whole URL. */
function stableCanvasForm(url: string, session: ServerSession): string {
  if (url.startsWith(session.url)) {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }
  return url;
}

/** The remembered form, made fetchable again with the CURRENT token. */
export function playableCanvasUrl(form: string, session: ServerSession): string {
  return form.startsWith('/')
    ? `${session.url}${form}?t=${encodeURIComponent(session.streamToken)}`
    : form;
}

/**
 * Covers for everything held, clips for the hot end of it.
 *
 * Pins first: a song someone deliberately kept for a flight is the single
 * strongest statement of "I will be looking at this offline", so its cover
 * and clip are seated before any budget runs out. Then the sweep's own keeps
 * in rank order, so what the budgets cover is always the likeliest-reached.
 *
 * Serial on purpose. The audio workers just finished saturating the link six
 * lanes wide; this pass is the quiet epilogue, and clips are megabytes each.
 */
async function sweepPresentation(
  session: ServerSession,
  byId: Map<number, RemoteTrack>,
  keep: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  // Pins first, then keeps, each track once.
  const order: [string, RemoteTrack][] = [];
  const seen = new Set<string>();
  for (const key of [...pinnedKeys(), ...keep]) {
    if (seen.has(key)) continue;
    seen.add(key);
    const id = trackIdFromPath(key);
    const remote = id === null ? undefined : byId.get(id);
    // A pin this device's index has never heard of cannot be dressed - the
    // same stale-index case the download plan counts as skippedUnknown.
    if (remote) order.push([key, remote]);
  }

  let artFetches = 0;
  for (const [, remote] of order) {
    if (signal?.aborted) return;
    if (!remote.artId) continue;
    if (artFetches >= ART_FETCHES_PER_SWEEP) break;
    // Both sizes, same reason as the per-download hook: shelves ask for 640,
    // tables for 160, and a miss on either is the grey square again.
    for (const px of [160, 640] as const) {
      const cover = artSized(artUrl(session, remote.artId, remote.id), px);
      if (!cover) continue;
      if ((await rememberArt(cover)) !== 'held') artFetches += 1;
    }
  }

  const known = readCanvasKnown();
  let lookups = 0;
  let memoChanged = false;
  for (const [key, remote] of order.slice(0, CANVAS_HOT_N)) {
    if (signal?.aborted) break;
    const memo = known[key];
    let form = memo?.u ?? null;
    if (memo && form === null && Date.now() - memo.at < CANVAS_NONE_TTL) continue;
    if (!form) {
      if (lookups >= CANVAS_LOOKUPS_PER_SWEEP) continue;
      lookups += 1;
      const url = await fetchCanvas(session, remote.title, remote.artist, signal, remote.id);
      form = url ? stableCanvasForm(url, session) : null;
      known[key] = { u: form, at: Date.now() };
      memoChanged = true;
      if (!form) continue;
    }
    // A remembered clip whose fetch answers `no` is left remembered: offline
    // and quota look identical to "deleted on the server" from here, and the
    // retry a later sweep pays for that ambiguity is one cheap request.
    await ensureCanvas(playableCanvasUrl(form, session));
  }
  if (memoChanged) writeCanvasKnown(known);
}

/** What the cache is holding right now, without changing anything. */
export async function cacheUsage(): Promise<{ bytes: number; count: number; pinnedBytes: number; pinnedCount: number }> {
  const entries = await offlineEntries();
  const marked = pinnedKeys();
  // Everything not deliberately kept is this cache's, whether or not the
  // ledger still remembers it - see the adoption note in sweepCache.
  const ours = entries.filter((e) => !marked.has(e.key));
  const pins = entries.filter((e) => marked.has(e.key));
  return {
    bytes: ours.reduce((n, e) => n + e.bytes, 0),
    count: ours.length,
    pinnedBytes: pins.reduce((n, e) => n + e.bytes, 0),
    pinnedCount: pins.length,
  };
}

/** What one KIND of thing is using, split by how it got here. */
export interface KindUse {
  /** Brought by the cache itself, and therefore evictable. */
  bytes: number;
  count: number;
  /** Kept on purpose - outside the cache's ownership, never evicted. */
  pinnedBytes: number;
  pinnedCount: number;
}

/**
 * The same bytes as `cacheUsage`, split into music and audiobooks.
 *
 * Worth separating because they are not the same kind of object and do not
 * behave alike: a library of songs is thousands of four-minute files that come
 * and go on the cache's ranking, while one audiobook is a single twenty-hour
 * thing you deliberately keep. Read as one number they hide each other - a
 * shelf of books makes the music look small, and "12 GB of downloads" answers
 * neither "how much music have I got" nor "which book can I delete".
 *
 * `bookPaths` comes from the library, which is the only place that knows a key
 * is a book: the vault stores bytes against a path and nothing else.
 */
export async function cacheBreakdown(
  bookPaths: ReadonlySet<string>,
): Promise<{ music: KindUse; books: KindUse }> {
  return splitByKind(await offlineEntries(), pinnedKeys(), bookPaths);
}

/**
 * The sorting itself, apart from where the numbers come from.
 *
 * Separated so it can be exercised: everything interesting here is the
 * bookkeeping - which bucket a key lands in and whether it counts as kept - and
 * that is exactly what cannot be checked while it is welded to a native vault
 * and a localStorage ledger. The invariant worth protecting is that the two
 * buckets SUM to the whole vault, because the storage bar draws them as shares
 * of one total and a key falling through would quietly shrink the picture.
 */
export function splitByKind(
  entries: readonly { key: string; bytes: number }[],
  marked: ReadonlySet<string>,
  bookPaths: ReadonlySet<string>,
): { music: KindUse; books: KindUse } {
  const blank = (): KindUse => ({ bytes: 0, count: 0, pinnedBytes: 0, pinnedCount: 0 });
  const music = blank();
  const books = blank();
  for (const e of entries) {
    const into = bookPaths.has(e.key) ? books : music;
    if (marked.has(e.key)) {
      into.pinnedBytes += e.bytes;
      into.pinnedCount += 1;
    } else {
      into.bytes += e.bytes;
      into.count += 1;
    }
  }
  return { music, books };
}

/** Drop everything the cache owns, leaving pins alone - and the denials with
 *  it: clearing the cache is a fresh start, and a fresh start includes the
 *  songs you once told it to stop bringing back. The presentation goes too:
 *  covers, clips and the canvas-lookup memo all exist to dress the songs
 *  this is deleting, and clearArtCache/clearCanvasCache had sat unwired
 *  since they were written - "Clear cache" was quietly keeping megabytes of
 *  art for songs it had just thrown away. */
export async function clearCache(): Promise<void> {
  const ledger = readLedger();
  for (const key of Object.keys(ledger)) await unpinTrack(key);
  writeLedger({});
  try {
    localStorage.removeItem(DENY_KEY);
    localStorage.removeItem(CANVAS_KNOWN_KEY);
  } catch {
    // A denial that survives a clear is only a song that stays deleted.
  }
  await clearArtCache();
  await clearCanvasCache();
  notifyCacheChange();
}
