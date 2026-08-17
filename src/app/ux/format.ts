/**
 * The house number-to-words rules, in one place.
 *
 * Before this file, seven surfaces each carried their own byte formatter -
 * split between decimal and binary units, so a full 15 GB cache could read
 * "16 GB of 15 GB" on one line, and the same collector ledger showed "54 GB"
 * in Settings and "50 GB" in the Booth. Same story for mm:ss clocks (five
 * copies, one of which could print "1:60") and list running-times (three).
 * One implementation each, so every surface agrees with every other.
 */

/**
 * Bytes as a short human size, in BINARY units - the base the cache budget
 * itself is set in (`LIMIT_CHOICES` is `gb * 1024 ** 3`), so a full cache
 * reads as exactly its limit.
 */
export function formatBytes(bytes: number): string {
  const g = bytes / 1024 ** 3;
  if (g >= 10) return `${Math.round(g)} GB`;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  const m = bytes / 1024 ** 2;
  if (m >= 1) return `${Math.max(1, Math.round(m))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Seconds as a mm:ss clock. Floors rather than rounds - a clock must never
 * show a second that has not happened, and rounding inside the seconds is how
 * one copy of this managed to print "1:60". The placeholder is what a missing
 * duration wears: the deck's running clock wants "0:00", a track row wants
 * "--:--".
 */
export function formatClock(
  seconds: number | null | undefined,
  placeholder = '0:00',
): string {
  // A deck reports Infinity (transcode stream) or NaN until metadata lands.
  if (seconds == null || !Number.isFinite(seconds)) return placeholder;
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** The running time of a whole list, in the units it deserves. */
export function formatTotal(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} hr ${mins % 60} min`;
}
