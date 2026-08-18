import { Sparkles } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { FiltersPage } from './FiltersPage.tsx';
import { FILTERS } from './filters.ts';

/**
 * Filters: the third face on the one signal path.
 *
 * HiFi Lab is the rack you dial, Pedals is the board you stack, and this is
 * the shelf you pick from - finished sounds chosen by what they sound like
 * rather than by what they are made of. Same fx-chain nodes underneath, so a
 * filter and a pedalboard cannot both be true at once; applying a filter
 * replaces the chain, and the page is explicit about that.
 *
 * Every recipe uses only node kinds the server actually renders. A recipe
 * naming a kind the encoder does not implement would apply silently and change
 * nothing, which reads as a weak filter rather than a broken one.
 */
export const filters: Plugin = {
  id: 'filters',
  name: 'Filters',
  description:
    'A shelf of finished sounds: lofi, vinyl, cassette, telephone, cathedral, night drive and two dozen more, each one tap away.',
  icon: <Sparkles size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Sound', 'Filters'],
  details:
    `Adds a Filters page: ${FILTERS.length} whole sounds you put on in one tap, ` +
    'grouped by what they do - tape and lofi, broadcast, rooms, colour, stereo ' +
    'and movement. Lofi, Tape, Vinyl, Cassette, 8-bit, AM radio, Telephone, ' +
    'Megaphone, Underwater, Cathedral, Stadium, Cave, Dream, Night drive, Bass ' +
    'boost, Sub, Crisp, Air, Warm, Vocal focus, Crunch, Fuzz, Wide, Headphones, ' +
    'Doubled, Leslie, Wobble, Jet and Sweep. Your server renders the sound in ' +
    'its encoder, so filters need a server connection and apply to streamed ' +
    'play, with a limiter always guarding the output. There is one signal path, ' +
    'shared with Pedals and HiFi Lab, so putting a filter on replaces whatever ' +
    'was on the board.',
  pages: [{ id: 'shelf', label: 'Filters', icon: <Sparkles size={18} />, Content: FiltersPage }],
};
