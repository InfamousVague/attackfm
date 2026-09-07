import { BookAudio } from '@glacier/icons';
import type { Plugin } from '../types.ts';
import { BooksPage } from './BooksPage.tsx';

/**
 * Books, as a compiled-in feature: the audiobook shelf is CORE, not a
 * marketplace install - baked into the app, on by default, and toggleable in
 * Settings like any plugin, but never fetched from anywhere. It only READS the
 * library (the reading half of audiobooks); acquiring books is the job of
 * separate downloader plugins (Audible today), whose saves
 * land in the library as `kind = 'book'` and appear here automatically.
 *
 * No server floor: a desktop with local book files shelves them too. Its shelf
 * is a Music/Books toggle at the top of the Library page - turn the plugin off
 * and the toggle goes with it.
 */
/**
 * The listing's words, as catalogue keys.
 *
 * A plugin object is evaluated the moment this module is imported, which is
 * before anybody has chosen a language: a sentence written into it would be
 * the sentence the app booted with, whatever the picker says afterwards. So
 * the object carries keys, and PluginsProvider resolves them at render - one
 * call covering the marketplace card, its detail dialog and the nav item.
 *
 * They are gathered here rather than written inline because Plugin types those
 * fields `string`, and a key sitting in `description:` reads as prose to
 * anybody skimming. Named for what they are, they cannot be mistaken.
 */
const TEXT = {
  nameKey: 'settings.pluginBooksName',
  descriptionKey: 'settings.pluginBooksDescription',
  detailsKey: 'settings.pluginBooksDetails',
  navLabelKey: 'books.navLabel',
};

export const books: Plugin = {
  id: 'books',
  name: TEXT.nameKey,
  description: TEXT.descriptionKey,
  icon: <BookAudio size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  details: TEXT.detailsKey,
  pages: [{ id: 'shelf', label: TEXT.navLabelKey, icon: <BookAudio size={18} />, Content: BooksPage }],
};
