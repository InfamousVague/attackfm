import { Zap } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { PedalsPage } from './PedalsPage.tsx';

/**
 * Pedals: the floor under the hi-fi rack.
 *
 * HiFi Lab is the studio instrument - corrective, careful, flattering. This
 * is the other tradition: boxes that make a sound rather than fix one.
 * Overdrive, fuzz, a bitcrusher, the modulation family, tape echo, a spring,
 * and a few voices ffmpeg happens to do beautifully (exciter, sub octave,
 * transient sparkle, a Haas doubler).
 *
 * Same machinery underneath, on purpose: pedals are fx-chain nodes like any
 * EQ band, compiled by the server into the encoder with the limiter always
 * last, and they share the ONE chain with HiFi Lab - a pedal in front of a
 * rack is a signal path, not a conflict. This plugin is a different face on
 * that chain: stompboxes on a board rather than boxes in a rack.
 */
export const pedals: Plugin = {
  id: 'pedals',
  name: 'Pedals',
  description:
    'A pedalboard for your music — overdrive, fuzz, chorus, echo, spring and ten more stompboxes, wired in the order you stack them.',
  icon: <Zap size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Sound', 'Pedals'],
  details:
    'Adds a Pedals page: a board you stack stompboxes onto, in the order the ' +
    'signal should meet them. Fifteen pedals - Overdrive, Fuzz, Bitcrusher, ' +
    'Chorus, Flanger, Phaser, Tremolo, Vibrato, Rotary, Echo, Spring, ' +
    'Exciter, Sub, Sparkle and Doubler - each with the two or three knobs ' +
    'that matter and a footswitch. Your server renders the sound in its ' +
    'encoder, so the board needs a server connection and applies to streamed ' +
    'play; a limiter always guards the output. The board shares one signal ' +
    'path with the player\u2019s own sound console - pedals first, rack after, ' +
    'or however you stack it - and anything you put on the board shows up ' +
    'there too, so a pedal is never stuck behind this page.',
  pages: [{ id: 'board', label: 'Pedals', icon: <Zap size={18} />, Content: PedalsPage }],
};
