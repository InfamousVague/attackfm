import { Grid2x2 } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { PadsPage } from './PadsPage.tsx';

/**
 * Pads: your library, taken apart and handed back as an instrument.
 *
 * The server can separate any track into vocals, drums, bass and everything
 * else - a thing no licensed streaming service is allowed to do, because
 * pulling a master apart is a derivative work and the labels do not clear it.
 * Owning the file removes the question entirely.
 *
 * What arrives here is sixteen pads. Load a stem onto one, or chop a slice out
 * of it, and play. Everything sounds in the browser through Web Audio - a pad
 * has to answer a thumb in a few milliseconds, and a round trip to the encoder
 * is a hundred times too slow for that.
 */
export const pads: Plugin = {
  id: 'pads',
  name: 'Pads',
  description:
    'A sampler you play with your thumbs — pull any song into vocals, drums, bass and everything else, chop them, and hit them.',
  icon: <Grid2x2 size={22} />,
  author: 'AttackFM',
  version: '0.1.2',
  tags: ['Sound', 'Instrument'],
  details:
    'Adds a Pads page: a 4x4 sampler fed by your own library. Ask the server ' +
    'to separate any song and it comes back as four stems — vocals, drums, ' +
    'bass and everything else — each of which can go straight onto a pad or ' +
    'be chopped into slices first. Pads play instantly in the app rather than ' +
    'through the server, so they answer a thumb the way an instrument should. ' +
    'Each pad has its own level, pitch, trim and loop, and pads can be put in ' +
    'a choke group so one cuts another off, the way a real hi-hat does. Kits ' +
    'save on the device. Separation happens on your server and needs one to ' +
    'be connected.',
  pages: [{ id: 'board', label: 'Pads', icon: <Grid2x2 size={18} />, Content: PadsPage }],
};
