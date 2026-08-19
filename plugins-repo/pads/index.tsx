import { Grid2x2 } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { PadsPage } from './PadsPage.tsx';
import { StemsButton } from './StemsButton.tsx';

/**
 * Pads: your own record, taken apart, still playing.
 *
 * The server can separate any track into its parts - a thing no licensed
 * streaming service is allowed to do, because pulling a master apart is a
 * derivative work and the labels do not clear it. Owning the file removes the
 * question.
 *
 * What arrives is not a sampler any more. The song RUNS, all six parts locked
 * to each other, and the controls decide which of them you can hear. It comes
 * in two sizes: a board with room to play, and a button on the Now Playing
 * screen for the far commoner case of being halfway through something and
 * wanting the vocal out of it.
 */
export const pads: Plugin = {
  id: 'pads',
  name: 'Pads',
  description:
    'Your own records, taken apart and handed back as an instrument: the song keeps playing and the pads decide which parts of it you hear.',
  icon: <Grid2x2 size={22} />,
  author: 'AttackFM',
  version: '0.3.1',
  tags: ['Sound', 'Instrument'],
  details:
    'Adds two things. On the Now Playing screen, a Stems button takes the song ' +
    'you are listening to apart where it stands: six buttons, one per part, ' +
    'and closing it hands the song back exactly where the stems got to. And a ' +
    'Pads page, which is the same instrument with room to play - search for any ' +
    'song, press Map, and your server pulls it into vocals, drums, bass, ' +
    'guitar, keys, and the strings and horns left over. Either way the whole ' +
    'song plays, start to finish, and a tap drops a part until you tap it back ' +
    'while a hold drops it only while you hold. Parts stay locked to each other ' +
    'down to the sample, so anything you bring back lands on the beat. ' +
    'Separation happens on your server and needs one to be connected.',
  slots: { 'now-playing-actions': StemsButton },
  pages: [{ id: 'board', label: 'Pads', icon: <Grid2x2 size={18} />, Content: PadsPage }],
};
