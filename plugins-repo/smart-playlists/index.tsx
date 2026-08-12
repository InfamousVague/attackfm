import { Wand2 } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { SmartPage } from './SmartPage.tsx';

/**
 * Smart playlists: saved queries over the library that materialize into
 * ordinary playlists and keep them current. The rule is the source of truth;
 * the playlist is its shadow - refreshing diffs the shadow against today's
 * answer rather than tearing it down, so the playlist keeps its identity
 * (and its place in any pins or shares) across refreshes.
 *
 * Everything runs on this device against the already-synced library, so the
 * plugin needs no server and works offline; with a server connected the
 * playlists it writes ride the ordinary playlist sync like hand-made ones.
 */
export const smartPlaylists: Plugin = {
  id: 'smart-playlists',
  name: 'Smart playlists',
  description:
    'Rule-built playlists that keep themselves current: genre, artist, freshness, duration - you write the rule, the list follows the library.',
  icon: <Wand2 size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Playlists', 'Automation'],
  details:
    'Adds a Smart lists page where you write rules - "genre has ambient and ' +
    'added in the last 90 days, newest 50" - preview what they catch, and ' +
    'turn them into real playlists. Open the page (or run the palette ' +
    'command) and every smart playlist re-checks its rule against the ' +
    'library: new matches join, departed ones leave, order follows the rule. ' +
    'The playlists it writes are ordinary playlists - they sync, share, and ' +
    'play like any other.',
  pages: [{ id: 'main', label: 'Smart lists', icon: <Wand2 size={18} />, Content: SmartPage }],
};
