import { Grid2x2 } from '@glacier/icons';
import type { Plugin } from '../types.ts';
import { PadsPage } from './PadsPage.tsx';

/**
 * Pads: your own record, taken apart, still playing.
 *
 * The server can separate any track into its parts - a thing no licensed
 * streaming service is allowed to do, because pulling a master apart is a
 * derivative work and the labels do not clear it. Owning the file removes the
 * question.
 *
 * What arrives is not a sampler any more. The song RUNS, all six parts locked
 * to each other, and the pads decide which of them you can hear.
 *
 * This is the INSTRUMENT half of stems, and only that. Taking a part out of the
 * song you are listening to is a change to playback, not a performance, and it
 * belongs to the transport that is already on the screen - so it lives in the
 * app's sound console beside the EQ, and this plugin no longer puts a button on
 * the Now Playing screen. What is left here is the thing the console cannot be:
 * a board that answers a thumb.
 */
export const pads: Plugin = {
  id: 'pads',
  name: 'Pads',
  description:
    'Your own records, taken apart and handed back as an instrument: the song keeps playing and the pads decide which parts of it you hear.',
  icon: <Grid2x2 size={22} />,
  author: 'AttackFM',
  version: '0.4.0',
  tags: ['Sound', 'Instrument'],
  details:
    'Adds a Pads page: a board fed by your own library. Search for a song, ' +
    'press Map, and your server pulls it into six parts — vocals, drums, bass, ' +
    'guitar, keys, and the strings and horns left over — which land on the ' +
    'board by themselves. The whole song plays, start to finish, and a tap ' +
    'drops a part until you tap it back while a hold drops it only while you ' +
    'hold. Parts stay locked to each other down to the sample, so anything you ' +
    'bring back lands on the beat. To take a part out of whatever you happen to ' +
    'be listening to, use Stems in the sound console instead — that is playback, ' +
    'and it keeps your place. Separation happens on your server.',
  pages: [{ id: 'board', label: 'Pads', icon: <Grid2x2 size={18} />, Content: PadsPage }],
};
