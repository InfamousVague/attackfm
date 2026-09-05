/**
 * The clock, in words - the eyebrow over the deck's "for right now" card.
 *
 * "Saturday night" says more about what to play than "22:40" does, and it is
 * the same wording the home feed's daylist heading already uses for its
 * quarter-days, tightened at the ends of the day where a weekday stops
 * meaning much: past midnight nobody thinks of it as Saturday any more.
 */
export function clockInWords(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 4) return 'Late, late';
  if (h < 6) return 'Early, early';
  const day = now.toLocaleDateString(undefined, { weekday: 'long' });
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  return `${day} ${part}`;
}
