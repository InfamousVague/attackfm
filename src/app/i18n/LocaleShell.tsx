import { LocaleProvider, type Locale } from '@glacier/react';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { directionOf, i18next, initialLocale, loadLocale, rememberLocale, startI18n } from './index.ts';
import { setFormatLocale } from '../ux/format.ts';

/**
 * ONE ANSWER TO "WHAT LANGUAGE IS THIS".
 *
 * Three things need to agree, and they are three different systems:
 *
 *   - i18next, which resolves the app's own strings;
 *   - the kit's LocaleProvider, which resolves the kit's (a Select's "Clear",
 *     a DataGrid's sort announcement) and drives its RTL awareness;
 *   - the DOCUMENT, whose `dir` attribute is what actually mirrors the layout.
 *
 * That last one is the one worth being careful about. Every logical property
 * in the stylesheet - `inset-inline-start`, `padding-inline`, `margin-inline` -
 * resolves against the direction of the ELEMENT, and the app has 230 of them
 * against 13 physical ones. So `dir="rtl"` on <html> is not a hint to the kit:
 * it IS the RTL implementation. Set it and the layout flips; leave it and no
 * amount of correct translation produces an Arabic app.
 *
 * It is set here rather than in an effect because an effect runs after paint,
 * and the frame in between is the whole app laid out left-to-right with Arabic
 * text in it. On first render this component writes the attribute before it
 * returns, so that frame does not exist.
 */

interface LocaleValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  /** Awaits the catalogue before switching, so the language never changes
   *  into a screen of untranslated keys and then back. */
  setLocale: (next: Locale) => Promise<void>;
}

const Ctx = createContext<LocaleValue | null>(null);

/** Stamps the document. Also the only place that knows `dir` and `lang` are
 *  two attributes: `lang` is what a screen reader picks a voice from, and it
 *  is wrong far more often than `dir` because nothing looks broken when it is. */
function stampDocument(locale: Locale): void {
  const html = document.documentElement;
  html.lang = locale;
  html.dir = directionOf(locale);
  // Numbers, dates, byte sizes and "3 days ago" come from Intl rather than
  // the catalogue, so ux/format.ts needs telling too. Same breath as the
  // document, so there is no window where the two disagree.
  setFormatLocale(locale);
}

export function LocaleShell({ children }: { children: ReactNode }) {
  // Lazy initialiser: runs once, before this component's first return, which
  // is before any child renders or anything paints.
  const [locale, setLocaleState] = useState<Locale>(() => {
    const first = initialLocale();
    startI18n(first);
    stampDocument(first);
    return first;
  });

  // The catalogue for a non-English start language is not in the bundle, so
  // the first paint is English and this swaps it in a moment later. Only the
  // start language needs this; every later change goes through setLocale,
  // which awaits.
  useEffect(() => {
    if (locale === 'en') return;
    void loadLocale(locale).then(() => i18next.changeLanguage(locale));
    // Deliberately once, for the STARTING locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Deliberately once, for the STARTING locale
  }, []);

  const setLocale = useCallback(async (next: Locale) => {
    await loadLocale(next);
    await i18next.changeLanguage(next);
    rememberLocale(next);
    stampDocument(next);
    setLocaleState(next);
  }, []);

  return (
    <Ctx.Provider value={{ locale, dir: directionOf(locale), setLocale }}>
      {/* The kit is handed the same locale, so its strings and ours cannot
          disagree, and its RTL-aware components read the direction the
          document is already in. */}
      <LocaleProvider locale={locale}>{children}</LocaleProvider>
    </Ctx.Provider>
  );
}

/** The current language and how to change it. For the picker in Settings and
 *  for the handful of places that format a date or a number themselves. */
export function useAppLocale(): LocaleValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAppLocale must be used within a LocaleShell');
  return value;
}

/**
 * The app's translator. `t('library.likedSongs')`.
 *
 * A one-line wrapper over react-i18next's own hook, worth having because it is
 * imported by every file that shows a string: the app's 700-odd call sites name
 * something the app owns, so the library underneath can be changed by editing
 * this file rather than all of them.
 */
export function useT() {
  return useTranslation('app').t;
}

/**
 * "1 song" / "12 songs" / "أغنيتان".
 *
 * This replaces three identical copies of
 *
 *     n === 1 ? '1 song' : `${n} songs`
 *
 * which had been written out separately in PlaylistShowcase, OnRepeatChip and
 * PlaylistNotices. That expression is not a formatting choice, it is English
 * grammar: it says a language has exactly two number forms and the boundary is
 * at one. Arabic has six forms and boundaries at 0, 1, 2, 3-10 and 11-99;
 * Japanese has one and no boundary at all. i18next picks the right form
 * through Intl.PluralRules, which is the same table the browser uses.
 */
export function useSongCount() {
  const t = useT();
  return (n: number) => t('library.songCount', { count: n });
}

/**
 * The translator for code that is NOT a component - a notification body, a
 * share sheet's text, anything built in a plain function.
 *
 * NOT REACTIVE, deliberately: it reads whatever language i18next is in at the
 * moment it is called, and nothing re-runs when that changes. That is right
 * for a string handed to the OS and wrong for one on screen, so anything
 * inside a render should use useT() instead and will re-render properly.
 */
export function translate(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, { ns: 'app', ...options });
}

/**
 * A sentence with something LIVE in the middle of it.
 *
 *     <Trans i18nKey="library.stillReading" values={{ n }} components={{ b: <strong /> }} />
 *
 * The app builds 172 sentences by putting text and `{expressions}` next to
 * each other as JSX siblings:
 *
 *     Still reading your library — {count} songs.
 *
 * Wrapping each fragment in its own t() would hand a translator three pieces
 * with no way to reorder them, and word order is the first thing that changes
 * between languages - German puts the verb last, Arabic runs the other way
 * entirely. So the whole sentence becomes ONE catalogue entry with the hole
 * named inside it, and the translator moves the hole where their language
 * wants it.
 */
export { Trans } from 'react-i18next';
