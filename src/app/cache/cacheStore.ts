//! The cache's persistence and notification core: the ledger of entries the
//! cache owns, the hand-deleted denials, the size limit, and the listeners
//! every mutation notifies. Module-level state here has exactly one owner -
//! this module; everything else reaches it through these exports.

const LEDGER_KEY = 'attackfm-autocache';
export const DENY_KEY = 'attackfm-cache-deny';
const PIN_KEY = 'attackfm-cache-pins';

/**
 * Songs the listener kept on the device deliberately.
 *
 * Recorded, rather than deduced. "Kept by hand" used to mean "on the disk but
 * not in the ledger", which is not a fact about the song at all - it is a fact
 * about what this browser profile happens to remember. The ledger lives in
 * localStorage while the files live on disk, so the two can part company
 * wholesale: a webview that clears its site data under storage pressure, a
 * reinstall, a bundle booting from a different origin. When they part, every
 * automatically cached song is re-labelled as one the listener chose, the
 * pane reports gigabytes they never asked for, and - worse than the label -
 * the planner stops evicting any of it, because it only ever evicts what the
 * ledger owns. The cache stalls at whatever size it had reached.
 *
 * A positive record cannot make that mistake. Absence now means "this cache's,
 * record lost" rather than "the listener's", which is both the likelier truth
 * and the recoverable one: a wrongly-adopted file is re-pinned in a tap, where
 * a wrongly-protected one silently wedges the cache forever.
 */
export function pinnedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    return raw ? new Set(Object.keys(JSON.parse(raw) as Record<string, number>)) : new Set();
  } catch {
    return new Set();
  }
}

export function markPinned(key: string): void {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    all[key] = Date.now();
    localStorage.setItem(PIN_KEY, JSON.stringify(all));
  } catch {
    // The file is still held; it will simply be managed as an ordinary
    // cached song rather than protected - the safe direction to fail.
  }
  for (const fn of listeners) fn();
}

export function unmarkPinned(key: string): void {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as Record<string, number>;
    delete all[key];
    localStorage.setItem(PIN_KEY, JSON.stringify(all));
  } catch {
    // Nothing to do: a stale mark only protects a song from eviction.
  }
  for (const fn of listeners) fn();
}

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

/* ── Download quality ────────────────────────────────────────────────────────
   What this device WRITES TO DISK, as a kbps number, where 0 means "the
   original file, byte for byte".

   Separate from the streaming setting (`attackfm-server-quality`, in the
   Servers pane) because the two answer different questions. Streaming quality
   is about the minutes you are listening to right now on whatever connection
   you are on; this is about what a finite phone disk should be spent on. Wanting
   lossless through headphones at home and 128k for the eight hundred songs kept
   for the tube is not a contradiction.

   Device-scoped, deliberately: it is not in prefsSync's SYNCED_KEYS because the
   thing it manages is one phone's disk, and a laptop with a terabyte has no
   business inheriting a phone's answer.

   The choices stop at 256 because that is where the encoder does. `-c:a aac` is
   ffmpeg's native LC encoder; measured against 30s of pink noise it returns
   ~223kbps for a requested 256, ~225 for 320 and ~227 for 512 - so anything
   above 256 costs the same bytes as 256 while still being lossy. Offering 320
   would be selling a number the file does not contain. 96 is the floor rather
   than the server's 64 because this encoder has no HE-AAC/SBR, and 64k LC
   stereo is not music. */
const QUALITY_KEY = 'attackfm-cache-quality';

/** 0 is lossless - the original file. The rest are AAC bitrates in kbps. */
export const QUALITY_CHOICES = [0, 256, 128, 96] as const;

export function cacheQualityKbps(): number {
  try {
    const raw = localStorage.getItem(QUALITY_KEY);
    if (raw !== null) {
      const n = Number(raw);
      // Anything unrecognised degrades to lossless, which is what every
      // device did before this setting existed.
      if (QUALITY_CHOICES.includes(n as (typeof QUALITY_CHOICES)[number])) return n;
    }
  } catch {
    // Fall through to lossless.
  }
  return 0;
}

export function setCacheQualityKbps(kbps: number): void {
  try {
    localStorage.setItem(QUALITY_KEY, String(kbps));
  } catch {
    // Applies for this run regardless.
  }
  for (const fn of listeners) fn();
}

/* The quality the last completed sweep actually downloaded at. Compared against
   the current setting to know that a change has happened since, which is what
   makes the one-off fragment clear in cacheSweep possible: a half-finished
   `.part` from the old quality must not be resumed into a file of the new one. */
const APPLIED_KEY = 'attackfm-cache-quality-applied';

export function appliedQualityKbps(): number | null {
  try {
    const raw = localStorage.getItem(APPLIED_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function rememberAppliedQuality(kbps: number): void {
  try {
    localStorage.setItem(APPLIED_KEY, String(kbps));
  } catch {
    // Only costs a redundant fragment clear next sweep.
  }
}

const listeners = new Set<() => void>();

export function onCacheChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fire every onCacheChange subscriber. The one listener set lives here; the
 *  manifest, sweep and schedule modules call this rather than keeping a
 *  second set of their own. */
export function notifyCacheChange(): void {
  for (const fn of listeners) fn();
}

// --- the ledger: which entries this cache owns -----------------------------

type Ledger = Record<string, number>;

export function readLedger(): Ledger {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    const parsed = raw ? (JSON.parse(raw) as Ledger) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLedger(ledger: Ledger): void {
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
