import { useMemo } from 'react';
import { BookAudio } from '@glacier/icons';
import type { DownloadItem, Plugin } from '../../src/plugins/types.ts';
import { LibriVoxPage } from './LibriVoxPage.tsx';
import { BookQueueProvider, useBookQueue } from './queue.tsx';
import type { BookJob } from './api.ts';

/**
 * LibriVox, as its own downloader plugin: the free half of getting books. It
 * searches the public-domain catalogue and pulls a book into the library, where
 * the core Books shelf shows and plays it. No account, no DRM - volunteers
 * reading out-of-copyright books - so it ships public, and installs by default
 * beside the Audible downloader.
 *
 * Its queue is not its own page's business: books in flight show up on the
 * app's Downloads page beside whatever else is coming down, which is where
 * someone watching a download will look for it.
 */

/** A book on its way in, in the shape the Downloads page renders. A section
 *  count is what a LibriVox book has instead of a track list - the server does
 *  not name the sections in the queue - so the card gets a real bar and no
 *  disclosure to open. */
function toItem(job: BookJob, hide: (id: string) => void): DownloadItem {
  return {
    id: job.id,
    title: job.title,
    subtitle: job.author,
    kind: 'book',
    artworkUrl: job.cover || null,
    state: job.state,
    error: job.error,
    completed: job.completed,
    total: job.total,
    current: job.currentSection,
    createdAt: job.createdAt,
    remove: () => hide(job.id),
  };
}

export const librivox: Plugin = {
  id: 'librivox',
  name: 'LibriVox',
  description: 'Download free, public-domain audiobooks from the LibriVox catalogue.',
  icon: <BookAudio size={22} />,
  author: 'AttackFM',
  version: '0.2.0',
  tags: ['Audiobooks', 'Downloads'],
  requiresServer: true,
  details:
    'The free side of getting audiobooks: search the LibriVox catalogue of public-domain books ' +
    'read by volunteers, and pull any of them into your library with one tap. No account, no DRM. ' +
    'They land on the built-in Books shelf beside anything the Audible downloader brings in, and ' +
    'you watch them arrive on the Downloads page.',
  // Mounted while the plugin is on, so the queue keeps advancing (and the
  // library keeps getting rescanned as books land) wherever you happen to be.
  Provider: BookQueueProvider,
  pages: [
    {
      id: 'catalogue',
      label: 'Free books',
      icon: <BookAudio size={18} />,
      Content: LibriVoxPage,
    },
  ],
  downloads: [
    {
      id: 'queue',
      label: 'Books',
      icon: <BookAudio size={11} />,
      useDownloads: () => {
        const { jobs, hide, clearFinished } = useBookQueue();
        return useMemo(
          () => ({ items: jobs.map((job) => toItem(job, hide)), clearFinished }),
          [jobs, hide, clearFinished],
        );
      },
    },
  ],
};
