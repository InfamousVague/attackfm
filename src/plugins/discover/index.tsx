import { Compass } from '@glacier/icons';
import type { Plugin } from '../types.ts';
import { DiscoverPage } from './DiscoverPage.tsx';

/**
 * Discover, as a plugin: one navigable page of the server's curated chart and
 * staple playlists, each addable in a tap. It owns no chrome, no provider, and
 * no queue of its own - it contributes a single page to the primary navigation
 * and leans on two things already present when it can run at all: a server
 * session to fetch the catalogue from, and the Music import plugin's queue to
 * add through. Hence `requiresServer` rather than `serverBacked`: the feed has
 * no local equivalent to fall back to, so the card (and its nav item) appear
 * only with a hub connected and leave the moment it disconnects.
 */
export const discover: Plugin = {
  id: 'discover',
  name: 'Discover',
  description:
    'A browse page of chart-topping and staple playlists, each one tap to add to your library.',
  icon: <Compass size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  tags: ['Discover', 'Playlists'],
  requiresServer: true,
  details:
    'Adds a Discover page to the navigation, filled with the charts and genre ' +
    'and decade staples your server keeps fresh (Top 50, Today’s Top Hits, ' +
    'RapCaviar, the All Out decade lists, and more). Every card is a one-tap ' +
    'Add that hands the whole playlist to your import queue, so browsing and ' +
    'growing your library are the same gesture. Needs a server for the feed and ' +
    'the Music import plugin to do the adding.',
  pages: [{ id: 'discover', label: 'Discover', icon: <Compass size={18} />, Content: DiscoverPage }],
};
