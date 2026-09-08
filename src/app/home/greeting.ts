/**
 * The hour of the day, as the four things a home page can say about it.
 *
 * A boundary rather than a range: the day is cut at 5, 12 and 18, and the
 * hours between two cuts all mean the same thing. Whoever draws it decides
 * the words - the greeting on Home picks a catalogue key from the same four
 * meanings, because the hour chooses a MEANING and not a string, and where a
 * name sits relative to the greeting is the sentence's business.
 */
export function greetingFor(hour: number): string {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
