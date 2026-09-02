import { Sparkles } from '@glacier/icons';
import type { Plugin } from '../types.ts';
import { VisualizerArt } from './VisualizerArt.tsx';
import { VisualizersSettings } from './VisualizersSettings.tsx';

/**
 * Visualizers: thirteen audio-reactive pictures - vector scopes, particles,
 * fractals and attractors - drawn in the Now Playing art square, the spot the
 * CD spins in. Compiled in and on by default, toggleable in Settings like any
 * plugin; turning it off takes the Visualizer face out of the Artwork style
 * menu and drops any square showing it back to the disc.
 *
 * It contributes exactly two things: the art-square slot, and a settings pane
 * to pick which visualizer shows. Everything it draws is computed on the
 * device from the live audio graph; nothing is fetched and nothing leaves.
 */
export const visualizers: Plugin = {
  id: 'visualizers',
  name: 'Visualizers',
  description:
    'Thirteen audio-reactive visualizers - vector scopes, fractals, particles - where the CD spins.',
  icon: <Sparkles size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  details:
    'Pick Visualizer under Now Playing’s Artwork style menu and the art square becomes a ' +
    'picture of the sound: a spectrum halo, a vector scope, Lissajous curves, a particle nebula, ' +
    'a Julia set, the demoscene plasma, a noise flow field, a kaleidoscope, a starfield warp, a ' +
    'spiral galaxy, the Lorenz butterfly, beat-dropped ripples and a rose curve. Every one is ' +
    'painted in the record’s own accent colour and moves to the live audio. Tap the picture ' +
    'to cycle through them, or choose one here.',
  slots: { 'now-playing-art': VisualizerArt },
  settingsSections: [
    { id: 'pick', label: 'Visualizers', icon: <Sparkles size={18} />, Content: VisualizersSettings },
  ],
};
