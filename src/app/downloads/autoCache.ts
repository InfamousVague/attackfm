//! The device cache: the songs most likely to be wanted next, kept locally.
//! Split into src/app/cache/ - cacheStore (ledger/denials/limit/listeners),
//! cacheHotness (Date deck + rankHotness), cacheManifest (manifest + receipt),
//! cacheSweep (planner + worker pool, and the two-rules design header), and
//! cacheSchedule (cadence + nudge). This path stays as the one import surface
//! so the module-level singletons behind it keep a single owner each.

export {
  deniedKeys,
  denyKey,
  DEFAULT_LIMIT_BYTES,
  LIMIT_CHOICES,
  cacheLimitBytes,
  setCacheLimitBytes,
  onCacheChange,
  autoCachedKeys,
} from '../cache/cacheStore.ts';
export { DATE_CACHE_TARGET, setDateDeck, rankHotness } from '../cache/cacheHotness.ts';
export type { Hotness } from '../cache/cacheHotness.ts';
export { sweepManifest, dismissSweepReport, resetFailedManifest, lastSweep } from '../cache/cacheManifest.ts';
export type { ManifestEntry, SweepReport } from '../cache/cacheManifest.ts';
export { notePlaybackAudible, planCache, sweepCache, cacheUsage, clearCache } from '../cache/cacheSweep.ts';
export type { SweepResult } from '../cache/cacheSweep.ts';
export { sweepIfIdle, nudgeSweep, startCacheSweeps } from '../cache/cacheSchedule.ts';
