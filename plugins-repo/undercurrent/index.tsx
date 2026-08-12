import { CloudRain } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { UndercurrentPage } from './UndercurrentPage.tsx';

/**
 * Undercurrent: a second, quieter instrument under the music. Four ambience
 * beds - rain, vinyl crackle, fireplace, wind - synthesized from shaped
 * noise the moment you turn them on. Nothing is downloaded and nothing
 * touches the player's own audio graph; the beds keep playing while you
 * browse, and the mix survives a relaunch.
 */
export const undercurrent: Plugin = {
  id: 'undercurrent',
  name: 'Undercurrent',
  description:
    'Ambience under the music: rain, vinyl crackle, fireplace, and wind, synthesized on the spot - no recordings, just a mixer.',
  icon: <CloudRain size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Sound', 'Ambience'],
  details:
    'Adds an Undercurrent page with four ambience layers you mix under ' +
    'whatever is playing: rain on a roof, vinyl crackle, a low fire, and ' +
    'wind leaning on a window. Every bed is synthesized locally from shaped ' +
    'noise - no files, no network - and keeps playing while you move around ' +
    'the app. The mix persists; the audio starts only when you toggle a ' +
    'layer on.',
  pages: [{ id: 'main', label: 'Undercurrent', icon: <CloudRain size={18} />, Content: UndercurrentPage }],
};
