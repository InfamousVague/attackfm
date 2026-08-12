import { SlidersHorizontal } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { EqRackPage } from './EqRackPage.tsx';

/**
 * EQ rack: a preset library over the app's own equalizer. The equalizer
 * state is the host's (useEqualizer - the same gains the Player pushes onto
 * the audio graph), so applying a preset here is exactly a hand moving the
 * app's own sliders: no second EQ, no fighting over the signal.
 */
export const eqRack: Plugin = {
  id: 'eq-rack',
  name: 'EQ rack',
  description:
    'A preset rack for the equalizer: save your own curves, flip between A and B, and land any of them in one tap.',
  icon: <SlidersHorizontal size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Sound', 'Equalizer'],
  details:
    'Adds an EQ rack page that works the equalizer you already have. Save ' +
    'the current curve under a name, build a shelf of your own presets ' +
    'beside the built-in ones, and apply any of them in a tap. The A/B ' +
    'switch holds two curves and flips between them so you can hear a ' +
    'change honestly instead of remembering it.',
  pages: [{ id: 'main', label: 'EQ rack', icon: <SlidersHorizontal size={18} />, Content: EqRackPage }],
};
