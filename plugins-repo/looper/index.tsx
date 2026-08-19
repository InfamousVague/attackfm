import { Disc3 } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { LooperPage } from './LooperPage.tsx';

/**
 * Looper: a record, taken apart on its own beat and handed back as an
 * instrument you can play in time.
 *
 * Where Pads plays the parts a model separated, this plays the song itself -
 * sampled, sliced and looped. It is the older idea of the two and the one
 * hip-hop was built on: take eight bars of somebody's record and make
 * something with them.
 *
 * The auto-sampler is the piece worth knowing about. It finds the transients
 * with spectral flux, snaps them to the beat grid the server already measured
 * for the track, and keeps the strongest hit per beat - so the sixteen pieces
 * start where the music starts rather than on a stopwatch.
 */
export const looper: Plugin = {
  id: 'looper',
  name: 'Looper',
  description:
    'Sample any song into sixteen coloured pads, cut on its own beat, and play the pieces in time with each other.',
  icon: <Disc3 size={22} />,
  author: 'AttackFM',
  version: '0.2.0',
  tags: ['Sound', 'Instrument'],
  details:
    'Adds a Looper page: sixteen big colour-coded pads fed by your own ' +
    'library. Auto-sample cuts a song into sixteen pieces using its real ' +
    'transients snapped to the tempo your server measured, so the slices ' +
    'land on the beat. Everything launches quantised — press a pad mid-bar ' +
    'and it joins on the next one, which is what makes two loops played by ' +
    'hand sound deliberate. Switch to Edit and tap any pad to see its slice ' +
    'inside the whole song’s waveform, then drag the region or its edges, ' +
    'with snapping to the beat. Per-pad level, pitch, loop and choke groups. ' +
    'Kits save on the device; sampling needs a server connection.',
  pages: [{ id: 'board', label: 'Looper', icon: <Disc3 size={18} />, Content: LooperPage }],
};
