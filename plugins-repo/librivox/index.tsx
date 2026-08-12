import { BookAudio } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { LibriVoxPage } from './LibriVoxPage.tsx';

/**
 * LibriVox, as its own downloader plugin: the free half of getting books. It
 * searches the public-domain catalogue and pulls a book into the library, where
 * the core Books shelf shows and plays it. No account, no DRM - volunteers
 * reading out-of-copyright books - so it ships public, and installs by default
 * beside the Audible downloader.
 */
export const librivox: Plugin = {
  id: 'librivox',
  name: 'LibriVox',
  description: 'Download free, public-domain audiobooks from the LibriVox catalogue.',
  icon: <BookAudio size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Audiobooks', 'Downloads'],
  requiresServer: true,
  details:
    'The free side of getting audiobooks: search the LibriVox catalogue of public-domain books ' +
    'read by volunteers, and pull any of them into your library with one tap. No account, no DRM. ' +
    'They land on the built-in Books shelf beside anything the Audible downloader brings in.',
  pages: [
    {
      id: 'catalogue',
      label: 'Free books',
      icon: <BookAudio size={18} />,
      Content: LibriVoxPage,
    },
  ],
};
