import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, locales, rtlLocales, type Locale } from '@glacier/react';
import en from './locales/en.json';

/**
 * Translations, and which way the page runs.
 *
 * WHY i18next RATHER THAN THE KIT'S OWN CATALOG. Glacier ships a real i18n
 * layer - LocaleProvider, useT, defineMessages, and a `Message` type that
 * makes omitting a locale a compile error, which is a genuinely good property.
 * It is the right shape for the fifty-odd strings the kit itself owns. It is
 * the wrong shape for an app with thousands, for two reasons that are not
 * matters of taste:
 *
 * PLURALS. `format('{n} songs', { n: 1 })` returns "1 songs" - the kit
 * interpolates and does not select. This app counts things constantly (113
 * sites at last count, most of them `n === 1 ? 'song' : 'songs'`), and that
 * ternary is English grammar written in TypeScript. Arabic has SIX plural
 * forms; Japanese has none. `Record<Locale, string>` cannot express either,
 * and no amount of care at the call site fixes it. i18next selects through
 * Intl.PluralRules, which knows all of them.
 *
 * WHO WRITES THE TRANSLATIONS. The kit's model puts all eight locales inline
 * at the definition. That is fine when you write them yourself and there are
 * fifty. For thousands it means a translator either edits TypeScript or does
 * not participate, and adding a ninth locale is a diff across every file that
 * has a string in it. JSON catalogs are a file per language, which is the
 * thing translation tooling and translators both already understand.
 *
 * The kit is not replaced - it is DRIVEN. The locale chosen here is handed to
 * the kit's LocaleProvider (see LocaleShell), so the kit's own strings and its
 * RTL awareness follow the app's choice, and there is one answer to "what
 * language is this" rather than two that can disagree.
 */

/** The languages, taken from the kit so the two lists cannot drift. */
export const LOCALES = locales;
export type { Locale };

/** What each language calls itself. A language picker that lists "German"
 *  is only useful to somebody who already reads English. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ja: '日本語',
  pt: 'Português',
  zh: '中文',
  ar: 'العربية',
};

const STORE_KEY = 'attackfm-locale';

/** The writing direction, from the kit's own list - `ar` is the RTL one. */
export function directionOf(locale: Locale): 'ltr' | 'rtl' {
  return rtlLocales.has(locale) ? 'rtl' : 'ltr';
}

/**
 * SHOULD A SPANISH PHONE GET A SPANISH APP WITHOUT BEING ASKED?
 *
 * Eventually yes, and right now no, and the difference is coverage. The
 * catalogue holds a few dozen of the app's strings; the rest are still English
 * literals in the JSX (`node scripts/i18n-scan.mjs` prints the score). Adopting
 * the device's language today would hand somebody an app that is English
 * everywhere except the nav and one shelf heading - which is not a translated
 * app, it is a broken-looking one, and worse than the honest English it
 * replaced. Somebody who goes to Settings and CHOOSES a language has said they
 * want the half that exists; a phone's regional setting has not said that.
 *
 * Flip this to `true` when the scanner is reporting somewhere north of 95%.
 * Nothing else needs to change: the matching below is already written.
 */
const ADOPT_DEVICE_LANGUAGE = false;

/**
 * The locale to start in: what was chosen last, else (see above) what the
 * device asks for, else English. The device's preference is matched on the
 * LANGUAGE only - `pt-BR` and `pt-PT` are both Portuguese as far as this
 * catalogue goes, and refusing a near match to insist on English helps nobody.
 */
export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  } catch {
    // Private mode, or storage turned off: fall through.
  }
  if (ADOPT_DEVICE_LANGUAGE) {
    for (const tag of navigator.languages ?? [navigator.language]) {
      const base = tag?.split('-')[0]?.toLowerCase();
      if (base && (LOCALES as readonly string[]).includes(base)) return base as Locale;
    }
  }
  return DEFAULT_LOCALE;
}

export function rememberLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORE_KEY, locale);
  } catch {
    // Not fatal: the choice holds for this run and is asked again next launch.
  }
}

/**
 * English is bundled; every other language is imported when it is first chosen.
 *
 * WHAT THIS ACTUALLY BUYS, WHICH IS LESS THAN IT LOOKS. The obvious reading is
 * "seven languages nobody on this device reads stay off the wire". That is
 * true of the web and native builds and FALSE of the OTA bundle, which is the
 * one that matters most - `AFM_OTA=1` sets rollup's `inlineDynamicImports`
 * (vite.config.ts), so every catalogue below is inlined into app.js. Verified,
 * not assumed: an OTA build emits app.js + app.css and nothing else, and all
 * eight catalogues grep out of app.js. It has to work that way - ship-update
 * refuses to publish a build that emitted any third file, because a chunk has
 * no way of reaching a device.
 *
 * So this is kept for two smaller reasons rather than the big one:
 *
 *   - the non-OTA builds DO split, and pay only for the language in use;
 *   - the seam is where it belongs. At 32KB for eight catalogues the inlining
 *     costs nothing worth discussing, but these grow with every string that
 *     gets translated, and the day eight of them is real weight the fix is to
 *     serve them from the hub (`/api/i18n/{locale}.json`) - which is an edit
 *     to loadLocale and nothing else, because every caller already awaits it.
 *
 * What must NOT happen is somebody "simplifying" these into eight static
 * imports at the top of the file. That is the same bytes today and forecloses
 * the fix.
 */
const CATALOGS: Partial<Record<Locale, () => Promise<{ default: Record<string, unknown> }>>> = {
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  ja: () => import('./locales/ja.json'),
  pt: () => import('./locales/pt.json'),
  zh: () => import('./locales/zh.json'),
  ar: () => import('./locales/ar.json'),
};

export async function loadLocale(locale: Locale): Promise<void> {
  if (locale === 'en' || i18next.hasResourceBundle(locale, 'app')) return;
  const load = CATALOGS[locale];
  if (!load) return;
  try {
    const mod = await load();
    i18next.addResourceBundle(locale, 'app', mod.default, true, true);
  } catch {
    // A catalogue that will not load leaves the language on English rather
    // than on a screen of raw keys.
  }
}

let started = false;

/** Starts i18next. Idempotent: the app may mount more than once in dev. */
export function startI18n(locale: Locale): void {
  if (started) return;
  started = true;
  void i18next.use(initReactI18next).init({
    lng: locale,
    fallbackLng: 'en',
    defaultNS: 'app',
    ns: ['app'],
    resources: { en: { app: en } },
    interpolation: {
      // React escapes for us; doing it twice turns an apostrophe into
      // `&#39;` on screen.
      escapeValue: false,
    },
    // A missing key shows the key in dev, where it is a bug to fix, and the
    // English string in production, where it is a string somebody can read.
    parseMissingKeyHandler: (key) => (import.meta.env?.DEV ? `⟦${key}⟧` : key.split('.').pop() ?? key),
  });
}

export { i18next };
