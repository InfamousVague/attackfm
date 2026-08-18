import { AudioLines } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { HiFiLabPage } from './HiFiLabPage.tsx';

/**
 * HiFi Lab: the signal chain as a place you build.
 *
 * The effects rack picks colours off a fixed menu; this is the other
 * instrument - individual boxes (EQ bands, shelves, filters, a compressor,
 * width, crossfeed, a leveler) wired in the order YOU put them, every knob
 * yours. The processing happens on the server, in the same encoder that
 * already re-streams for quality settings: the chain travels as typed
 * parameters, the server clamps them and builds the filter graph, and a
 * limiter always guards the end. The player picks changes up mid-song, in
 * place.
 */
export const hifiLab: Plugin = {
  id: 'hifi-lab',
  name: 'HiFi Lab',
  description:
    'Chain EQs, filters and dynamics into a signal path of your own — reorder the boxes, save the racks you build.',
  icon: <AudioLines size={22} />,
  author: 'AttackFM',
  version: '0.1.1',
  tags: ['Sound', 'HiFi'],
  details:
    'Adds a HiFi Lab page where the signal path is a chain of boxes: ' +
    'parametric EQ bands, bass and treble shelves, high- and low-pass ' +
    'filters, a compressor, stereo width, headphone crossfeed and a gentle ' +
    'leveler. Add what you need, drag the order the ear wants, bypass any ' +
    'box to hear what it was doing, and A/B two whole chains against each ' +
    'other. Racks save under a name to your server and follow your account. ' +
    'Rendering happens in the server’s encoder, so a chain needs a ' +
    'server connection and applies to streamed play; the limiter on the ' +
    'output is always on, because clipping is never one of the effects.',
  pages: [{ id: 'main', label: 'HiFi Lab', icon: <AudioLines size={18} />, Content: HiFiLabPage }],
};
