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

import { artUrl, fetchHome, fetchRemoteFavorites, loadCachedIndex, remotePath, streamUrl, trackIdFromPath, type RemoteTrack, type ServerSession } from './server.ts';
import { heldPath, offlineEntries, offlineSpace, pinTrack, unpinTrack } from './offline.ts';
import { setNativeSyncing } from './androidAudio.ts';
import { pickSource } from './mirrors.ts';
import { isTauri, type Track } from './tauri.ts';

const LEDGER_KEY = 'attackfm-autocache';
const DENY_KEY = 'attackfm-cache-deny';

/**
 * Songs the listener deleted from the device by hand.
 *
 * Without this, deleting an auto-cached file is a promise the next sweep
 * quietly breaks: the song is still hot, so it is downloaded right back -
 * which is why the old Storage pane refused to offer delete on cache-owned
 * rows at all. The file browser offers it, so the refusal becomes a denial
 * the planner respects. Cleared by Clear-cache (a fresh start is a fresh
 * start), and counted in the sweep receipt so the exclusions are visible
 * rather than a mystery about why a liked song never arrives.
 */
export function deniedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(DENY_KEY);
    return raw ? new Set(Object.keys(JSON.parse(raw) as Record<string, number>)) : new Set();
  } catch {
    return new Set();
  }
}

export function denyKey(key: string): void {
  try {
    const raw = localStorage.getItem(DENY_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    all[key] = Date.now();
    localStorage.setItem(DENY_KEY, JSON.stringify(all));
  } catch {
    // The delete still happened; the song may just come back next sweep.
  }
  for (const fn of listeners) fn();
}

const LIMIT_KEY = 'attackfm-cache-limit';

/** The default ceiling. Fifteen gigabytes is a few thousand lossy songs or a
 *  few hundred lossless ones - enough to hold everything anyone plays in a
 *  normal month without being the largest thing on the phone. */
export const DEFAULT_LIMIT_BYTES = 15 * 1024 ** 3;

/** What the settings pane offers. Off is a real choice: someone always on
 *  their own wifi may simply not want the space used. */
export const LIMIT_CHOICES = [0, 2, 5, 10, 15, 25, 50, 100].map((gb) => gb * 1024 ** 3);

export function cacheLimitBytes(): number {
  try {
    const raw = localStorage.getItem(LIMIT_KEY);
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_LIMIT_BYTES;
}

export function setCacheLimitBytes(bytes: number): void {
  try {
    localStorage.setItem(LIMIT_KEY, String(Math.max(0, Math.round(bytes))));
  } catch {
    // Applies for this run regardless.
  }
  for (const fn of listeners) fn();
}

const listeners = new Set<() => void>();

export function onCacheChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- the ledger: which entries this cache owns -----------------------------

type Ledger = Record<string, number>;

function readLedger(): Ledger {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    const parsed = raw ? (JSON.parse(raw) as Ledger) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(ledger: Ledger): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // A lost ledger costs correctness in one direction only: entries become
    // indistinguishable from manual pins, so they stop being evicted rather
    // than starting to be. The cache stalls; it never eats someone's pins.
  }
}

/** Every key this cache owns, for callers separating the automatic half from
 *  the hand-kept one without re-reading storage per row. */
export function autoCachedKeys(): Set<string> {
  return new Set(Object.keys(readLedger()));
}

// --- what is worth holding -------------------------------------------------

/**
 * The next Dates, published by the deck itself.
 *
 * Everything else {@link rankHotness} weighs is a fact the SERVER holds -
 * likes, play counts, recency. The Date deck is not: it is computed on the
 * device from what has already been judged, passed and hearted this sitting,
 * so the only place that knows it is the page drawing it. It is left here as
 * a hint rather than fetched, and an empty hint simply means the deck has not
 * been opened yet.
 */
const DATE_DECK_KEY = 'attackfm-date-deck';

/** How many cards ahead to guarantee. */
export const DATE_CACHE_TARGET = 20;

// Persisted, because the page that publishes the deck is rarely open when the
// sweep that could act on it runs. The launch sweep fires ninety seconds in -
// long before anyone has navigated to Dates - and with an in-memory hint that
// pass would warm nothing, so "instant" would only ever start being true on
// the SECOND visit of a session. The stored deck is at worst a few days
// stale, and staleness here is cheap: these are library songs the listener
// was about to be shown anyway, and the next visit republishes the truth.
let dateDeck: string[] = (() => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DATE_DECK_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string').slice(0, DATE_CACHE_TARGET);
  } catch {
    return [];
  }
})();

/**
 * Tell the cache which cards are coming. Called by the Date page as its deck
 * changes; the next sweep acts on it, and the launch sweep of the NEXT run
 * acts on it too - see the note on `dateDeck`.
 */
export function setDateDeck(keys: string[]): void {
  dateDeck = keys.slice(0, DATE_CACHE_TARGET);
  try {
    localStorage.setItem(DATE_DECK_KEY, JSON.stringify(dateDeck));
  } catch {
    // Then the next launch warms nothing until the page opens - the old
    // behaviour, not an error.
  }
}

export interface Hotness {
  /** How many liked songs the server reported, or -1 if it could not be asked. */
  liked?: number;
  /** Library path (`afm://<id>`), most-wanted first. */
  keys: string[];
  /** Why, for the settings pane to explain itself. */
  reasons: Map<string, string>;
}

/**
 * Rank the library by how likely it is to be wanted next.
 *
 * The weights are ordinal rather than measured - what matters is the ORDER,
 * and that liked songs beat heavy rotation beats recent beats new. A song can
 * score on several counts and should: something both liked and on repeat is
 * the surest bet on the phone.
 *
 * This is also the ranking a "fast sync" server would need to decide what to
 * hold, which is why it returns keys and reasons rather than doing anything
 * with them.
 */
export async function rankHotness(session: ServerSession): Promise<Hotness> {
  const score = new Map<string, number>();
  const reasons = new Map<string, string>();
  const bump = (id: number, points: number, why: string) => {
    const key = remotePath(id);
    score.set(key, (score.get(key) ?? 0) + points);
    if (!reasons.has(key)) reasons.set(key, why);
  };

  // The next cards on the Date deck, ahead of everything - including likes.
  //
  // Not because a Date matters more than a song you love, but because of when
  // it is needed. A liked song is a permanent resident and will be cached on
  // any pass; a Date is judged in about four seconds and then gone, so the
  // round trip lands inside the swipe, which is exactly where it shows. It is
  // also a bounded set - twenty songs - so putting it first cannot crowd the
  // cache out the way an unbounded signal could.
  dateDeck.forEach((key, i) => {
    const id = trackIdFromPath(key);
    if (id !== null) bump(id, 2000 - i, 'up next on Dates');
  });

  // Liked songs are the one signal the listener stated out loud.
  let liked = 0;
  try {
    const favorites = await fetchRemoteFavorites(session);
    liked = favorites.length;
    for (const id of favorites) bump(id, 1000, 'liked');
  } catch {
    // A signal that will not load is one fewer input, not a failure - but it
    // IS the difference between "you have no liked songs" and "we could not
    // ask", so it leaves -1 behind rather than nothing.
    liked = -1;
  }

  try {
    const feed = await fetchHome(session);
    // Play count, but flattened: the 200-play song and the 40-play song are
    // both "yours", and letting raw counts run would let one obsession crowd
    // the whole cache out.
    for (const { id, plays } of feed.heavyPlays ?? []) {
      bump(id, 300 + Math.min(200, Math.sqrt(plays) * 40), 'on repeat');
    }
    for (const id of feed.heavy ?? []) bump(id, 300, 'on repeat');
    // Recency decays down the list, so the last thing played outranks the
    // fortieth.
    (feed.recent ?? []).forEach((id, i) => bump(id, Math.max(40, 250 - i * 5), 'played recently'));
    for (const album of feed.jumpBackIn ?? []) {
      for (const id of album) bump(id, 120, 'from an album you came back to');
    }
    for (const id of feed.fresh ?? []) bump(id, 60, 'newly added');
  } catch {
    // Same.
  }

  const keys = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  return { keys, reasons, liked };
}

/**
 * The sweep's manifest: every song the last pass planned, with where it got.
 *
 * The receipt (SweepReport) is the sentence; this is the ledger behind it -
 * song by song, art and all, so "132 would not download" is inspectable
 * instead of a number. States move live while a sweep runs (the pane
 * re-renders off the same listeners the counters use), and the finished
 * manifest is persisted so the pane still shows the last run after a
 * restart. Capped on write: a 15 GB plan can hold thousands of songs, and
 * the pane only ever shows the head.
 */
export interface ManifestEntry {
  key: string;
  title: string;
  artist: string;
  /** Full art URL, resolved at plan time while the session is in hand. */
  art: string | null;
  bytes: number;
  state: 'waiting' | 'downloading' | 'done' | 'failed';
  reason?: string;
}

const MANIFEST_KEY = 'attackfm-autocache-manifest';
const MANIFEST_CAP = 300;

let manifest: ManifestEntry[] = (() => {
  try {
    const raw = localStorage.getItem(MANIFEST_KEY);
    return raw ? (JSON.parse(raw) as ManifestEntry[]) : [];
  } catch {
    return [];
  }
})();

export function sweepManifest(): ManifestEntry[] {
  return manifest;
}

function persistManifest(): void {
  try {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest.slice(0, MANIFEST_CAP)));
  } catch {
    // The live view still works; only the restart memory is lost.
  }
}

function setManifestState(key: string, state: ManifestEntry['state'], reason?: string): void {
  const entry = manifest.find((e) => e.key === key);
  if (!entry) return;
  entry.state = state;
  if (reason) entry.reason = reason;
  for (const fn of listeners) fn();
}

// --- the sweep -------------------------------------------------------------

/**
 * What the last pass did, and why it did nothing when it did nothing.
 *
 * Every failure in this file is caught and shrugged off - a favourites call
 * that will not load is "one fewer input", a download that fails is `false` -
 * which is right for a background job that must never take the app down, and
 * wrong for anyone trying to work out why their liked songs are not on their
 * phone. The sweep was unobservable: no error, no log, no count, just an empty
 * folder. This is the receipt.
 */
export interface SweepReport {
  at: number;
  /** Plain-language outcome, for the Offline pane to show as-is. */
  note: string;
  kept: number;
  failed: number;
  /** The distinct download failures, commonest first, each tagged with the
   *  host it came from - "which server, and what it said" is the whole
   *  diagnosis for a sweep that planned 130 downloads and landed 2. */
  failReasons?: { reason: string; n: number }[];
  /** Ranked songs this server's index could not name or size, so they were
   *  never candidates - a stale index shows up here rather than nowhere. */
  skippedUnknown: number;
  liked: number;
  limitBytes: number;
}

const REPORT_KEY = 'attackfm-autocache-report';

function writeReport(next: SweepReport): void {
  try {
    localStorage.setItem(REPORT_KEY, JSON.stringify(next));
  } catch {
    // The pane simply shows nothing; the sweep itself is unaffected.
  }
  for (const fn of listeners) fn();
}

/** Put the last receipt away. The tiles keep their colours - they are the
 *  truth about the disk - this only silences the text until the next pass
 *  writes a new one. */
export function dismissSweepReport(): void {
  try {
    localStorage.removeItem(REPORT_KEY);
  } catch {
    // Then it stays; harmless.
  }
  for (const fn of listeners) fn();
}

/** Wind every failed tile back to waiting, so a retry reads as a retry rather
 *  than a wall of red that flickers. The next sweep re-attempts anything not
 *  on disk anyway - this is presentation, and the honest kind: the state IS
 *  waiting again the moment a new pass is asked for. */
export function resetFailedManifest(): void {
  let changed = false;
  for (const entry of manifest) {
    if (entry.state === 'failed') {
      entry.state = 'waiting';
      delete entry.reason;
      changed = true;
    }
  }
  if (changed) {
    persistManifest();
    for (const fn of listeners) fn();
  }
}

/** The last pass's receipt, or null if none has run on this device. */
export function lastSweep(): SweepReport | null {
  try {
    const raw = localStorage.getItem(REPORT_KEY);
    return raw ? (JSON.parse(raw) as SweepReport) : null;
  } catch {
    return null;
  }
}

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
  manifest = plan.keep.map((key) => {
    const remote = known.get(key)!;
    return {
      key,
      title: remote.title,
      artist: remote.artist,
      art: remote.artId ? artUrl(session, remote.artId) : null,
      bytes: remote.sizeBytes || 0,
      state: heldPath(key) ? ('done' as const) : ('waiting' as const),
    };
  });
  persistManifest();
  for (const fn of listeners) fn();

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
  for (const fn of listeners) fn();
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
  for (const fn of listeners) fn();
}

// --- when it runs ----------------------------------------------------------

/** How often to reconsider, once settled. Taste moves over days, not minutes,
 *  and every pass costs a `/api/home` and a favourites read. */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
/** A pause after launch, so the cache never competes with the first song
 *  someone opened the app to play. */
const FIRST_SWEEP_DELAY_MS = 90_000;

let sweeping = false;

/** Run a pass unless one is already going. Safe to call from anywhere. */
export async function sweepIfIdle(session: ServerSession): Promise<void> {
  if (sweeping || !isTauri()) return;
  sweeping = true;
  setNativeSyncing(true);
  try {
    await sweepCache(session);
    lastCompleteAt = Date.now();
  } catch {
    // A failed pass is a pass; the next one will find the same work to do.
  } finally {
    sweeping = false;
    setNativeSyncing(false);
  }
}

/** When a sweep last ran to the END. A phone locked mid-download freezes the
 *  webview and the pass dies where it stood; comparing this against the last
 *  START is how the schedule knows to go again instead of waiting six hours
 *  with half a plan on disk. */
let lastCompleteAt = 0;

// The session the sweeps are running for, so a nudge from elsewhere in the
// app (the heart, the Date deck) does not need one threaded to it.
let activeSession: ServerSession | null = null;
let nudgeTimer: number | undefined;

/**
 * Ask for a sweep soon, rather than at the next six-hour mark.
 *
 * The scheduled cadence is right for drift - taste moves slowly - but wrong
 * for a stated wish. Hearting a song is the listener saying "this one", and
 * six hours later is not when they expect it to be on the phone; they expect
 * it the way a message sends: now-ish, without being asked twice. Debounced a
 * few seconds so hearting a run of songs costs one pass, not one per press.
 */
export function nudgeSweep(): void {
  if (!isTauri() || !activeSession) return;
  window.clearTimeout(nudgeTimer);
  nudgeTimer = window.setTimeout(() => {
    const live = activeSession;
    if (live && !document.hidden) void sweepIfIdle(live);
  }, 4000);
}

/**
 * Keep the cache current for as long as a session is live.
 *
 * Foreground only, and never while the app is hidden: this downloads whole
 * songs, and a phone in a pocket is exactly where a background fetch turns
 * into a battery and data complaint nobody asked for.
 */
export function startCacheSweeps(session: ServerSession): () => void {
  if (!isTauri()) return () => {};
  activeSession = session;
  let stopped = false;
  let last = 0;

  const maybe = () => {
    if (stopped || document.hidden) return;
    // The full gap only applies to a pass that FINISHED; an interrupted one
    // re-runs on the next look, held to a minute so a flapping screen does
    // not turn into a download storm.
    const finished = lastCompleteAt >= last;
    if (Date.now() - last < (finished ? SWEEP_EVERY_MS : 60_000)) return;
    last = Date.now();
    void sweepIfIdle(session);
  };

  const first = window.setTimeout(() => {
    last = Date.now();
    void sweepIfIdle(session);
  }, FIRST_SWEEP_DELAY_MS);
  const timer = window.setInterval(maybe, 30 * 60 * 1000);
  document.addEventListener('visibilitychange', maybe);

  return () => {
    stopped = true;
    if (activeSession === session) activeSession = null;
    window.clearTimeout(first);
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', maybe);
  };
}
