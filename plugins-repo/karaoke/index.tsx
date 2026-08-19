import { Mic2 } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { KaraokePage } from './KaraokePage.tsx';

/**
 * Karaoke Maker: any song in the library, minus the singer.
 *
 * Apple ships something like this and has to switch off spatial audio to do
 * it; Spotify cannot ship it at all, because taking a master apart is a
 * derivative work nobody will clear. Owning the file removes the question,
 * and the separation this uses is the same one the Pads plugin plays with.
 *
 * The parts are added back together on the SERVER rather than in the browser:
 * three stems mixed by ffmpeg is one ordinary, seekable stream, where three
 * buffers in the page would be ninety megabytes of decoded audio that cannot
 * be scrubbed without rebuilding all of it.
 */
export const karaoke: Plugin = {
  id: 'karaoke',
  name: 'Karaoke Maker',
  description:
    'Turn any song in your library into karaoke — the vocal lifted out, the words full screen, in time.',
  icon: <Mic2 size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Sound', 'Karaoke'],
  details:
    'Adds a Karaoke Maker page. Search your library, pick a song, and your ' +
    'server separates it and hands back the track without its vocal — the ' +
    'band still playing, the singer gone. The words fill the screen and ' +
    'follow the music line by line when the song carries timed lyrics, with ' +
    'transport controls underneath. Separation happens once per song and is ' +
    'kept, so the second time is instant. Needs a server connection; a song ' +
    'with no lyrics still works as an instrumental.',
  pages: [{ id: 'room', label: 'Karaoke', icon: <Mic2 size={18} />, Content: KaraokePage }],
};
