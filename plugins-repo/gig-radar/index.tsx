import { Radar } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { GigsPage } from './GigsPage.tsx';

/**
 * Gig radar: the library's artists, checked against Bandsintown's public
 * events feed. The library defines who matters (your most-collected artists
 * are the ones scanned), the filter narrows to your corner of the world, and
 * tickets open in the system browser. Everything is best-effort: an artist
 * the feed does not know simply contributes nothing.
 */
export const gigRadar: Plugin = {
  id: 'gig-radar',
  name: 'Gig radar',
  description:
    'Upcoming shows from the artists in your library, with a filter for your corner of the world and tickets one tap away.',
  icon: <Radar size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Live', 'Discovery'],
  details:
    'Adds a Gigs page that sweeps your most-collected artists through ' +
    'Bandsintown’s public events feed and lines up what’s coming, soonest ' +
    'first. Type a city or country to keep only shows near you; every row ' +
    'opens the ticket page in your browser. The sweep runs when you open ' +
    'the page and caches for an hour - no accounts, no keys, and artists ' +
    'the feed doesn’t know just stay quiet.',
  pages: [{ id: 'main', label: 'Gigs', icon: <Radar size={18} />, Content: GigsPage }],
};
