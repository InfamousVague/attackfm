/**
 * The plugin's shared prettifiers. Every tool talks in bytes and seconds -
 * storage totals, duplicate rows, backup sizes - so the formatting lives here
 * once rather than five slightly different ways.
 */

/** 1536 -> "1.5 KB". Binary units, one decimal until the number gets wide. */
export function prettyBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 245.3 -> "4:05". Null-tolerant because tags do not always carry length. */
export function prettyDuration(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs)) return '–:––';
  const whole = Math.round(secs);
  const m = Math.floor(whole / 60);
  return `${m}:${String(whole % 60).padStart(2, '0')}`;
}

/** A kbps badge from a bytes-per-second-ish bitrate field, when known. */
export function prettyBitrate(bitrate: number | null | undefined): string | null {
  if (bitrate == null || !Number.isFinite(bitrate) || bitrate <= 0) return null;
  // The server reports kbps already; anything suspiciously large is bps.
  const kbps = bitrate > 10_000 ? Math.round(bitrate / 1000) : Math.round(bitrate);
  return `${kbps} kbps`;
}
