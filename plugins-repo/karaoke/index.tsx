import { Mic2 } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { KaraokeButton } from './KaraokeButton.tsx';

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
  version: '0.2.0',
  tags: ['Sound', 'Karaoke'],
  details:
    'Puts a microphone on the Now Playing screen. Press it while a song is ' +
    'playing and your server separates that track and hands it back without ' +
    'its vocal — the band still playing, the singer gone — with the words ' +
    'full screen, following the music line by line when the song carries ' +
    'timed lyrics. Tap a line to jump to it. Separation happens once per song ' +
    'and is kept, so every time after is instant. Needs a server connection; a ' +
    'song with no lyrics still works as an instrumental.',
  // A microphone on the Now Playing screen, NOT a page in the More menu.
  // Karaoke only ever applies to one particular song, and when you want it you
  // are already listening to that song - so making it a destination meant
  // finding the same track a second time in a second search. The button acts on
  // what is playing, and the stage it opens fills the screen: no navigation
  // bar, no player strip, nothing but the words.
  slots: { 'now-playing-actions': KaraokeButton },
};
