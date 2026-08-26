import { Clapperboard } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { CanvasSettings } from './CanvasSettings.tsx';

/**
 * SpotifyCanvas: the short looping clip a song wears behind the full player.
 *
 * WHY A PLUGIN. This was a core settings section for a while, and it was the
 * wrong shape twice over. It put a second tab called "Spotify" in the rail
 * beside the importer's own - two tabs, one name, different jobs - and it
 * showed that tab to every owner whether or not they had any interest in
 * asking Spotify for anything. Canvas is the same kind of thing the importer
 * is: an optional errand the box runs against somebody else's service, using
 * the owner's own credential. It belongs where that lives, behind a switch,
 * off until asked for.
 *
 * `requiresServer`, and not merely `serverBacked`: the cookie is kept on the
 * hub and the clips are collected there. There is no local equivalent to fall
 * back to, so a device with no server connected should not see the tab at all.
 *
 * NOT in the public repository - plugin.json declares no `"public": true` - for
 * the same reason nothing that touches Spotify is: it configures a private
 * credential against a service whose terms are not this project's to speak for.
 * See scripts/build-plugins.mjs, which copies only the declared-public set.
 *
 * The switch in Settings → Appearance ("Video clips on Now Playing") is a
 * different control and stays where it is: that one is each listener's choice
 * about their own screen and their own data allowance. This is the owner's
 * choice about whether the server can fetch the clips in the first place.
 */
export const spotifyCanvas: Plugin = {
  id: 'spotify-canvas',
  name: 'SpotifyCanvas',
  description: 'Plays the short looping clip Spotify carries for a song behind the full player.',
  icon: <Clapperboard size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  tags: ['Now Playing', 'Artwork'],
  requiresServer: true,
  details:
    'Some songs carry a Canvas: a few seconds of video the artist chose, looping ' +
    'behind the player instead of a still cover. Spotify only serves one to a ' +
    'signed-in session, so this adds a tab where the owner pastes a session ' +
    'cookie from their own account; the server then collects clips in the ' +
    'background, most recently played first, and keeps each one beside its song ' +
    'so it survives a restart and keeps working after the cookie expires. Off ' +
    'means the server never asks, and every song shows its cover.',
  settingsSections: [
    { id: 'canvas', label: 'Canvas', icon: <Clapperboard size={16} />, Content: CanvasSettings },
  ],
};
