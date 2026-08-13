import { LibraryBig } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { AlbumFillerPage } from './AlbumFillerPage.tsx';

/**
 * Album filler: the opposite question to everything else in this app.
 *
 * Every other surface here asks what you should get NEXT. This asks what is
 * already half here - the records you own eleven of twelve of, the single
 * everybody ripped with nothing around it. Those holes are invisible in a
 * library view, because a library view shows what you have.
 *
 * One artist at a time, on purpose. Checking everything means a catalogue
 * lookup per album, which is hundreds of calls and a rate limit at the end of
 * it; picking who to check keeps an answer inside a few seconds.
 */
export const albumFiller: Plugin = {
  id: 'album-filler',
  name: 'Album filler',
  description: 'Finds the records you own most of and offers you the songs that are missing.',
  icon: <LibraryBig size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Library', 'Downloads'],
  requiresServer: true,
  details:
    'Pick an artist you own and it compares each of their records against the ' +
    'catalogue, then lists what is missing - nearly-complete albums first, so ' +
    'the one song standing between you and a finished record is the first thing ' +
    'you see. Tick the ones you want and they go down the same download queue ' +
    'as everything else. It never fetches anything on its own.',
  pages: [
    { id: 'main', label: 'Album filler', icon: <LibraryBig size={18} />, Content: AlbumFillerPage },
  ],
};
