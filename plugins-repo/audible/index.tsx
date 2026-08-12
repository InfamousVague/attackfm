import { BookHeadphones } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { AudibleAccountSettings } from './AudibleAccountSettings.tsx';

/**
 * Audible, as a plugin: connect the owner's account to the hub so the server
 * can download the books they already own and file them into the library as
 * ordinary `kind = 'book'` audiobooks - chapters, cover and all - which then
 * appear on the Books shelf beside the public-domain ones.
 *
 * requiresServer, because everything here needs the hub: the tokens live there,
 * the download and the DRM-free conversion run there, and the files land in the
 * shared library. A plain browser with no server connected never sees the card.
 *
 * For now the plugin's whole surface is the account tab - the connect flow the
 * downloads are built on. Browsing the library and queueing downloads land next,
 * against a real connected account.
 */
export const audible: Plugin = {
  id: 'audible',
  name: 'Audible',
  description:
    'Connect your Audible account so your server can download the audiobooks you own into your library.',
  icon: <BookHeadphones size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Audiobooks', 'Downloads'],
  requiresServer: true,
  details:
    'Links your own Audible account to your hub, so the books you already own can be ' +
    'downloaded straight into your library — decrypted to plain, chaptered files the app ' +
    'plays like anything else. You sign in on Amazon’s own page; your password never touches ' +
    'the app or the server, only the device tokens Amazon hands back. Downloaded books share ' +
    'the Books shelf with the public-domain LibriVox catalogue.',
  settingsSections: [
    {
      id: 'account',
      label: 'Audible',
      icon: <BookHeadphones size={16} />,
      Content: AudibleAccountSettings,
    },
  ],
};
