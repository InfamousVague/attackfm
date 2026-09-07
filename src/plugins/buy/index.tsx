import { ShoppingBag } from '@glacier/icons';
import type { AcquireHandler, Plugin } from '../types.ts';
import { BuyProvider, useBuy } from './BuyProvider.tsx';
import { useT } from '../../app/i18n/LocaleShell.tsx';

/**
 * The Buy handler: for a song or an album, "Buy" opens the store sheet. It reads
 * the opener from the plugin's own provider - which resolves because the runtime
 * calls this hook below PluginProviders, where BuyProvider is mounted - and
 * offers nothing when the provider is somehow absent, so it degrades rather than
 * throws. Playlists are left out: a store sells a record, not a curated chart.
 */
function useBuyHandlers(): readonly AcquireHandler[] {
  const buy = useBuy();
  const t = useT();
  if (!buy) return [];
  return [
    {
      id: 'buy',
      label: t('common.buy'),
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
/**
 * The listing is catalogue keys, not words: the object is built when this
 * module is imported, long before a language has been chosen, so anything
 * written here in English would stay English however often the picker is
 * used. PluginsProvider resolves the compiled-in plugins' text at render.
 * Kept in a named table because Plugin types those fields as plain strings.
 */
const TEXT = {
  nameKey: 'settings.pluginBuyName',
  descriptionKey: 'settings.pluginBuyDescription',
  detailsKey: 'settings.pluginBuyDetails',
  tagKeys: ['settings.pluginBuyTagBuy', 'settings.pluginBuyTagStores'],
};

export const buy: Plugin = {
  id: 'buy',
  name: TEXT.nameKey,
  description: TEXT.descriptionKey,
  icon: <ShoppingBag size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  tags: TEXT.tagKeys,
  details: TEXT.detailsKey,
  Provider: BuyProvider,
  useAcquireHandlers: useBuyHandlers,
};
