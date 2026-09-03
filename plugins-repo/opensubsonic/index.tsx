import { Radio } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { SubsonicPage } from './SubsonicPage.tsx';
import { SubsonicSettings } from './SubsonicSettings.tsx';

/**
 * OpenSubsonic, both ways.
 *
 * OUT: the hub answers the OpenSubsonic API at /rest, so the apps built for
 * Navidrome, Airsonic and Subsonic can play this library - a car head unit,
 * a watch, a Linux desktop client, anything this project will never write
 * itself. Off until the owner opens it, and each member signs those apps in
 * with a password of their own rather than their account's.
 *
 * IN: another such server is read for its playlists, albums and starred
 * songs, and they are brought here - files and all, matched against what
 * the library already holds so nothing arrives twice.
 *
 * `requiresServer`, not merely `serverBacked`: both halves are the hub's
 * doing. The door is the hub answering; the import is the hub fetching and
 * filing. A device with no server connected has nothing to show.
 */
export const openSubsonic: Plugin = {
  id: 'opensubsonic',
  name: 'OpenSubsonic',
  description:
    'Open this library to Subsonic apps, and bring playlists, albums and stars over from another one.',
  icon: <Radio size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Import', 'Playlists', 'Server'],
  requiresServer: true,
  details:
    'Two directions. Outward: your server answers the OpenSubsonic API, so any ' +
    'app built for Navidrome, Airsonic or Subsonic can browse and play your ' +
    'library - with its own app password, revocable, never your account one. ' +
    'The owner opens that door; it is shut until they do. Inward: point it at ' +
    'another such server you have an account on and bring its playlists, ' +
    'albums and starred songs across. Songs you already own are matched and ' +
    'linked rather than downloaded twice, and a playlist from here can be sent ' +
    'the other way.',
  pages: [{ id: 'main', label: 'OpenSubsonic', icon: <Radio size={18} />, Content: SubsonicPage }],
  settingsSections: [
    { id: 'server', label: 'OpenSubsonic', icon: <Radio size={16} />, Content: SubsonicSettings },
  ],
};
