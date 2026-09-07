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
/**
 * Catalogue keys where the words would be. The object is built at import,
 * before a language exists, so prose written here could never follow the
 * picker; PluginsProvider resolves these at render for every surface that
 * shows them - the marketplace card, its detail dialog, the settings tab.
 * Named `…Key` because Plugin types the fields they fill as plain strings.
 */
const TEXT = {
  nameKey: 'settings.pluginVisualizersName',
  descriptionKey: 'settings.pluginVisualizersDescription',
  detailsKey: 'settings.pluginVisualizersDetails',
  settingsTabKey: 'visualizers.settingsTab',
};

export const visualizers: Plugin = {
  id: 'visualizers',
  name: TEXT.nameKey,
  description: TEXT.descriptionKey,
  icon: <Sparkles size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  details: TEXT.detailsKey,
  slots: { 'now-playing-art': VisualizerArt },
  settingsSections: [
    { id: 'pick', label: TEXT.settingsTabKey, icon: <Sparkles size={18} />, Content: VisualizersSettings },
  ],
};
