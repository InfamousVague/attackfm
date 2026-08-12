import { BookAudio } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { BooksPage } from './BooksPage.tsx';

/**
 * Audiobooks, as a plugin: one Books page that is both the shelf and the
 * store. The shelf is whatever the library holds with `kind: 'book'` - the
 * server marks everything under its Audiobooks/ folder that way, however it
 * got there - and the store is LibriVox, the public-domain catalogue the
 * server searches and downloads from on this listener's behalf.
 *
 * `requiresServer` because both halves live on the hub: the files, the
 * downloads, and the bookmark that lets a phone put a book down and a desktop
 * pick it up. The bookmark itself is the app's own play-state ledger - the
 * Player reports and restores it for book sections without this plugin's
 * help, so books resume even if the plugin is later switched off.
 */
export const audiobooks: Plugin = {
  id: 'audiobooks',
  name: 'Audiobooks',
  description:
    'Public-domain audiobooks from LibriVox: search the catalogue, pull a book into your library, and pick up where you left off.',
  icon: <BookAudio size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Books', 'Spoken word'],
  requiresServer: true,
  details:
    'Adds a Books page: your audiobook shelf on top, the LibriVox catalogue ' +
    'beneath it. LibriVox records public-domain literature - the classics, ' +
    'read by volunteers, free to keep - and the server downloads a book as ' +
    'ordinary files in your library, one per chapter, tagged and covered. ' +
    'Playback remembers where you stopped in every chapter, on every device. ' +
    'Books stay off your music shelves entirely: no mix, shuffle, or chart ' +
    'ever deals a chapter.',
  pages: [{ id: 'main', label: 'Books', icon: <BookAudio size={18} />, Content: BooksPage }],
};
