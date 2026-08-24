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
 * No server floor: a desktop with local book files shelves them too. Its page
 * rides the nav's ⋮ menu alongside the plugin pages.
 */
export const books: Plugin = {
  id: 'books',
  name: 'Books',
  description: 'Your audiobook shelf — read your books and pick up where you left off.',
  icon: <BookAudio size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  details:
    'The reading side of audiobooks, built in: your shelf of books, however they got into the ' +
    'library, played back with chapters and your place kept across devices. Turn it off and the ' +
    'shelf and its Library row simply go away. Getting books IN is a separate job — the Audible ' +
    'downloader does it for books you own, and anything dropped in the library\u2019s Audiobooks ' +
    'folder is shelved here too.',
  pages: [{ id: 'shelf', label: 'Books', icon: <BookAudio size={18} />, Content: BooksPage }],
};
