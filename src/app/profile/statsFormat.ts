import type { StatsRange } from './stats.ts';

/** Ranges, axis labels and little formatters for the stats page. */

export const RANGES: { id: StatsRange; label: string }[] = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
];

/** The hours the clock's axis names. Four is enough to orient by. */
export const AXIS_HOURS = new Set([0, 6, 12, 18]);

/** An hour as people say it: 0 → "12a", 14 → "2p". */
export function fmtHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return '12p';
  return `${hour - 12}p`;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08-11" → "Aug 11". Split by hand: `new Date` on a bare date string
 *  parses it as UTC midnight, which shifts the label a day west of Greenwich. */
export function fmtDay(day: string): string {
  const [, m, d] = day.split('-');
  const month = MONTHS[Number(m) - 1];
  return month ? `${month} ${Number(d)}` : day;
}

/** "2026-08-11" → local epoch ms, for the chart's time axis. Same hand-split,
 *  same reason: the constructor's string parse would land at UTC midnight. */
export function dayToLocalMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

/** Chart-axis minutes: whole hours once the numbers are big. */
export function fmtAxisMinutes(v: number): string {
  if (v >= 120) return `${Math.round(v / 60)}h`;
  return `${Math.round(v)}m`;
}
