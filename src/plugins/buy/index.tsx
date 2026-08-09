import { ShoppingBag } from '@glacier/icons';
import type { AcquireHandler, Plugin } from '../types.ts';
import { BuyProvider, useBuy } from './BuyProvider.tsx';

/**
 * The Buy handler: for a song or an album, "Buy" opens the store sheet. It reads
 * the opener from the plugin's own provider - which resolves because the runtime
 * calls this hook below PluginProviders, where BuyProvider is mounted - and
 * offers nothing when the provider is somehow absent, so it degrades rather than
 * throws. Playlists are left out: a store sells a record, not a curated chart.
 */
function useBuyHandlers(): readonly AcquireHandler[] {
  const buy = useBuy();
  if (!buy) return [];
  return [
    {
      id: 'buy',
      label: 'Buy',
      icon: <ShoppingBag size={16} />,
      canHandle: (target) => target.kind === 'track' || target.kind === 'album',
      run: (target) => buy.open(target),
    },
  ];
}

/**
 * Buy, as a plugin: the store finder for a song or album. It contributes an
 * acquire handler (so it shows up wherever the app offers to "get" a track -
 * Discover cards, search results, an artist's catalogue) and the sheet that
 * handler opens. No server, no engine, no platform floor - buying is just a
 * link out to a store, so it ships on and works everywhere, the app's default
 * answer to "where do I get this" when nothing downloads it.
 */
export const buy: Plugin = {
  id: 'buy',
  name: 'Buy',
  description: 'Find where to buy a song or album as an MP3 or FLAC download.',
  icon: <ShoppingBag size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  tags: ['Buy', 'Stores'],
  details:
    'Adds a Buy option wherever the app offers to add music - Discover cards, ' +
    'search results, an artist’s catalogue. Choosing it opens a sheet of stores ' +
    '(Bandcamp, Qobuz, 7digital, HDtracks, the iTunes Store, Amazon Music), each ' +
    'searched for the song or album, so you can buy it as an MP3 or a lossless ' +
    'FLAC and own the file. Ships on: when no downloader is enabled, Buy is how ' +
    'you still get the track.',
  Provider: BuyProvider,
  useAcquireHandlers: useBuyHandlers,
};
