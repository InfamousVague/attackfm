import { describe, expect, it, vi } from 'vitest';

/**
 * The translator for code that is not a component.
 *
 * One line of implementation and one thing worth pinning: it supplies the
 * `app` namespace. Every key in this repo lives there, so a call that forgets
 * it does not throw - i18next simply misses, and the KEY is what reaches the
 * screen. That is the failure this file exists to make loud, because it shows
 * up in a notification body or a share sheet, on somebody else's phone.
 */
const t = vi.fn((key: string, options?: Record<string, unknown>) => `${key}|${JSON.stringify(options)}`);
vi.mock('i18next', () => ({ default: { t: (...args: unknown[]) => t(...(args as [string, Record<string, unknown>])) } }));

const { translate } = await import('./translate.ts');

describe('translate', () => {
  it('asks the app catalogue, every time', () => {
    translate('library.songCount');
    expect(t).toHaveBeenCalledWith('library.songCount', { ns: 'app' });
  });

  it('keeps the caller options and the namespace together', () => {
    // A count is how i18next picks the plural form, so losing the options
    // here would spell "1 songs" in English and something worse in Arabic.
    translate('library.songCount', { count: 12 });
    expect(t).toHaveBeenLastCalledWith('library.songCount', { ns: 'app', count: 12 });
  });

  it('lets a caller name another namespace, since the merge is theirs to win', () => {
    translate('plugin.title', { ns: 'plugin' });
    expect(t).toHaveBeenLastCalledWith('plugin.title', { ns: 'plugin' });
  });

  it('hands back what i18next answered, unchanged', () => {
    expect(translate('a.key')).toBe('a.key|{"ns":"app"}');
  });
});
