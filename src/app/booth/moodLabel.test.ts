import { describe, expect, it, vi } from 'vitest';
import { moodLabel } from './moodLabel.ts';
import type { Mood } from './DjLauncher.tsx';

/**
 * The word on a mood chip.
 *
 * A `Mood` carries one of two things and never both: a KEY, for a mood the
 * listener reads in their own language, or a LABEL, for one whose word is a
 * NAME - "Charts" and "New music" are the hub's own shelf and folder names,
 * matched on elsewhere as literals. Translate one of those and the chip
 * becomes a door onto nothing in every language but English.
 *
 * Two surfaces call this - the Booth's chip row and the Now Playing deck -
 * and a chip that says one thing in one and something else in the other is a
 * bug you would only ever see in German. That is the whole reason it is one
 * function rather than the same ternary written twice.
 */

const keyed = { labelKey: 'booth.moodChill' } as Mood;
const named = { label: 'Charts' } as Mood;

describe('moodLabel', () => {
  it('translates a mood whose word is a key', () => {
    const t = vi.fn((key: string) => `translated ${key}`);
    expect(moodLabel(keyed, t)).toBe('translated booth.moodChill');
    expect(t).toHaveBeenCalledWith('booth.moodChill');
  });

  it('leaves a mood whose word is a NAME exactly as written', () => {
    /*
     * The seed and the label of these two are the hub's own contract - the
     * server matches the shelf on the literal string. A round trip through
     * the catalogue would hand back "Diagramme" and open a shelf that does
     * not exist.
     */
    const t = vi.fn((key: string) => `translated ${key}`);
    expect(moodLabel(named, t)).toBe('Charts');
    expect(t).not.toHaveBeenCalled();
  });

  it('branches on the KEY being absent, not on the label being present', () => {
    /*
     * `labelKey === undefined` is the test, and it has to stay that way: a
     * truthiness check on `label` would send a mood carrying an empty-string
     * name down the translate arm and print the key itself on the chip.
     */
    const t = (key: string) => `translated ${key}`;
    expect(moodLabel({ label: '' } as Mood, t)).toBe('');
  });

  it('gives every mood in the real table a word', () => {
    // The table is the thing shipped; a mood added with neither half filled
    // in would draw a chip with nothing on it, and only this notices.
    return import('./DjLauncher.tsx').then(({ MOODS }) => {
      for (const mood of MOODS) {
        expect(moodLabel(mood, (key) => key)).toBeTruthy();
      }
      // Exactly the two named ones, and they are the hub's folder names -
      // the same two strings the playlist gate calls generated.
      const names = MOODS.filter((m) => m.labelKey === undefined).map((m) => m.label);
      expect(names.sort()).toEqual(['Charts', 'New music']);
    });
  });
});
