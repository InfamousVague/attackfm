import { BookHeadphones } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { AudibleAccountSettings } from './AudibleAccountSettings.tsx';
import { DownloaderPage } from './DownloaderPage.tsx';

/**
 * The audiobook downloader, as a plugin: the ACQUIRING side of audiobooks,
 * where reading them is the core Books shelf's job. It fetches from two wells -
 * the books you own on Audible (once the account is connected) and the public
 * domain on LibriVox - and both land in the library as ordinary `kind = 'book'`
 * files the app plays like anything else.
 *
 * A page (reached from the nav bar's Plugins button) is the downloader itself;
 * a settings tab holds the Audible connection. requiresServer, because
 * everything here needs the hub: the tokens live there, the download and the
 * DRM-free conversion run there, and the files land in the shared library. A
 * plain browser with no server connected never sees the card.
 */
export const audible: Plugin = {
  id: 'audible',
  name: 'Audiobook downloader',
  description:
    'Download audiobooks into your library — the ones you own on Audible, and the public-domain LibriVox catalogue.',
  icon: <BookHeadphones size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Audiobooks', 'Downloads'],
  requiresServer: true,
  details:
    'Fetches audiobooks into your library from two places: your own Audible account (connect ' +
    'it in this plugin’s settings — you sign in on Amazon’s own page, so your password never ' +
    'touches the app or the server) and the free, public-domain LibriVox catalogue. Everything ' +
    'it saves is decrypted to plain, chaptered files and shows up on the core Books shelf.',
  pages: [
    {
      id: 'downloader',
      label: 'Get books',
      icon: <BookHeadphones size={18} />,
      Content: DownloaderPage,
    },
  ],
  settingsSections: [
    {
      id: 'account',
      label: 'Audible',
      icon: <BookHeadphones size={16} />,
      Content: AudibleAccountSettings,
    },
  ],
};
