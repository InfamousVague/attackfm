/**
 * Which language the app starts in, and which way the page runs.
 *
 * `initialLocale` is the newest decision in this file and the one with a
 * user-visible switch behind it: `ADOPT_DEVICE_LANGUAGE` was `false` while the
 * catalogue was thin, "because adopting the device's language then would have
 * handed somebody an app that was English everywhere except the nav and one
 * shelf heading, which is not a translated app but a broken-looking one." It is
 * true now, so a phone set to Spanish gets a Spanish app without being asked.
 *
 * That makes the order load-bearing - saved choice, then device, then English -
 * and makes the near-match rule load-bearing too: `pt-BR` and `pt-PT` are both
 * Portuguese as far as this catalogue goes, "and refusing a near match to
 * insist on English helps nobody."
 *
 * `directionOf` is smaller and matters more: `dir="rtl"` on <html> is not a
 * hint to the kit, it IS the RTL implementation - the app has 230 logical
 * properties resolving against it against 13 physical ones.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALES, LOCALE_NAMES, directionOf, initialLocale, rememberLocale } from './index.ts';

const KEY = 'attackfm-locale';

/** jsdom's `navigator.languages` is read-only, so the device's preference is
 *  stated by definition rather than by assignment. */
function deviceSpeaks(...tags: string[]): void {
  Object.defineProperty(navigator, 'languages', { value: tags, configurable: true });
  Object.defineProperty(navigator, 'language', { value: tags[0] ?? 'en', configurable: true });
}

afterEach(() => {
  deviceSpeaks('en-US');
});

describe('the locale list', () => {
  it('names every language in the language itself', () => {
    // "A language picker that lists 'German' is only useful to somebody who
    // already reads English."
    for (const locale of LOCALES) {
      expect(LOCALE_NAMES[locale]).toBeTruthy();
    }
    expect(LOCALE_NAMES.de).toBe('Deutsch');
    expect(LOCALE_NAMES.ja).toBe('日本語');
    expect(LOCALE_NAMES.ar).toBe('العربية');
  });

  it('has a name for exactly the locales it ships, and no more', () => {
    // The names come from this file and the list comes from the kit; a
    // language added to one and not the other is a picker with a blank row.
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...LOCALES].sort());
  });
});

describe('directionOf', () => {
  it('runs Arabic right to left and everything else left to right', () => {
    expect(directionOf('ar')).toBe('rtl');
    for (const locale of LOCALES) {
      if (locale !== 'ar') expect(directionOf(locale)).toBe('ltr');
    }
  });

  it('answers for every shipped language, with no undefined', () => {
    for (const locale of LOCALES) expect(['ltr', 'rtl']).toContain(directionOf(locale));
  });
});

describe('initialLocale', () => {
  it('prefers what was chosen last, over anything the device says', () => {
    localStorage.setItem(KEY, 'ja');
    deviceSpeaks('es-ES');
    expect(initialLocale()).toBe('ja');
  });

  it('ADOPTS THE DEVICE LANGUAGE when nothing was chosen', () => {
    // The switch this file turned on: "a phone set to Spanish now gets a
    // Spanish app without being asked, which is what somebody who set their
    // phone to Spanish was asking for."
    deviceSpeaks('es-ES');
    expect(initialLocale()).toBe('es');
  });

  it('matches on the LANGUAGE, not the region', () => {
    for (const tag of ['pt-BR', 'pt-PT', 'PT-br']) {
      deviceSpeaks(tag);
      expect(initialLocale()).toBe('pt');
    }
  });

  it('walks the device list in order, taking the first it can speak', () => {
    // A phone set to Icelandic with Spanish second gets Spanish, not English.
    deviceSpeaks('is-IS', 'es-ES', 'fr-FR');
    expect(initialLocale()).toBe('es');
  });

  it('falls back to English when it speaks none of them', () => {
    deviceSpeaks('is-IS', 'cy-GB');
    expect(initialLocale()).toBe('en');
  });

  it('ignores a saved value that is not a language we ship', () => {
    // Hand-edited storage, or a language removed since it was chosen.
    localStorage.setItem(KEY, 'kl');
    deviceSpeaks('fr-FR');
    expect(initialLocale()).toBe('fr');
  });

  it('reaches every shipped language from a device tag', () => {
    for (const locale of LOCALES) {
      localStorage.clear();
      deviceSpeaks(`${locale}-XX`);
      expect(initialLocale()).toBe(locale);
    }
  });

  it('falls through to English when storage cannot be read at all', () => {
    // Private mode, or storage turned off.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    deviceSpeaks('is-IS');
    expect(initialLocale()).toBe('en');
    getItem.mockRestore();
  });

  it('survives a device that reports nothing useful', () => {
    Object.defineProperty(navigator, 'languages', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'language', { value: '', configurable: true });
    expect(initialLocale()).toBe('en');
  });
});

describe('rememberLocale', () => {
  it('round-trips through initialLocale', () => {
    deviceSpeaks('es-ES');
    rememberLocale('ar');
    expect(initialLocale()).toBe('ar');
    expect(directionOf(initialLocale())).toBe('rtl');
  });

  it('does not throw when storage refuses', () => {
    // "Not fatal: the choice holds for this run and is asked again next launch."
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => rememberLocale('de')).not.toThrow();
    setItem.mockRestore();
  });
});
