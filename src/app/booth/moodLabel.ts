import type { Mood } from './DjLauncher.tsx';

/** Both doors onto the moods - the Booth's chip row and the Now Playing deck -
 *  need the same fallback, and a chip that says one thing in the Booth and
 *  another on the deck is a bug you would only ever see in German. */
export function moodLabel(mood: Mood, t: (key: string) => string): string {
  return mood.labelKey === undefined ? mood.label : t(mood.labelKey);
}
