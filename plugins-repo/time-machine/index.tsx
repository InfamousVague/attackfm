import { History } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { TimeMachinePage } from './TimeMachinePage.tsx';

/**
 * Time machine: the plays ledger read backwards. The hub answers "around
 * this date, k years ago" with the tracks this listener actually had on
 * repeat then (/api/rewind); the page resolves them against the synced
 * library and lays each year out as a shelf you can step into and play.
 * Beside the played years sits what ARRIVED around this date - the library's
 * own anniversaries, computed here from addedAt.
 */
export const timeMachine: Plugin = {
  id: 'time-machine',
  name: 'Time machine',
  description:
    'Around this date, years ago: what you had on repeat then, playable now - your own listening history as a place to visit.',
  icon: <History size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['History', 'Playlists'],
  requiresServer: true,
  details:
    'Adds a Time machine page built from your own listening ledger. For ' +
    'each past year with enough to say, a shelf: the songs you had on ' +
    'repeat around this date then, most-played first, playable as a set. ' +
    'Under them, the arrivals - what joined the library around this date in ' +
    'past years. Everything resolves against your synced library; nothing ' +
    'leaves your server.',
  pages: [{ id: 'main', label: 'Time machine', icon: <History size={18} />, Content: TimeMachinePage }],
};
