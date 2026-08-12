import { Rabbit } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { RabbitHolePage } from './RabbitHolePage.tsx';

/**
 * Rabbit hole: the related-artist graph as a walk rather than a list. Every
 * hop asks the hub (/api/related, which asks the catalogue) for one artist's
 * neighbours; the trail remembers how you got here, and artists you already
 * own wear a mark - the map shows where your library ends and the woods
 * begin. requiresServer because the graph lives behind the hub.
 */
export const rabbitHole: Plugin = {
  id: 'rabbit-hole',
  name: 'Rabbit hole',
  description:
    "Follow the map: start at an artist you love and walk the catalogue's neighbours hop by hop, marking what you already own.",
  icon: <Rabbit size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Discovery', 'Graph'],
  requiresServer: true,
  details:
    'Adds a Rabbit hole page: pick any artist you own and see who the ' +
    'catalogue shelves beside them, each neighbour a card with their face ' +
    'and following. Tap one to hop again - the breadcrumb trail brings you ' +
    'back the way you came - and artists already in your library carry a ' +
    'mark, so every walk shows you exactly where your collection thins out. ' +
    'Each hop is answered live by your own server.',
  pages: [{ id: 'main', label: 'Rabbit hole', icon: <Rabbit size={18} />, Content: RabbitHolePage }],
};
