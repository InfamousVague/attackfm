import { useMemo } from 'react';
import { BookHeadphones } from '@glacier/icons';
import type { DownloadItem, DownloadState, Plugin } from '../../src/plugins/types.ts';
import { AudibleAccountSettings } from './AudibleAccountSettings.tsx';
import { DownloaderPage } from './DownloaderPage.tsx';
import { AudibleQueueProvider, useAudibleQueue } from './queue.tsx';
import type { AudibleJob } from './audibleAccount.ts';

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
 *
 * What is coming down shows on the app's Downloads page rather than here: a
 * book and a playlist arriving at once are one question, and the answer lives
 * in one place.
 */

/** An Audible book is ONE file that goes through stages rather than a run of
 *  parts, so the card carries no counts - it says what is being done to it,
 *  and the bar runs indeterminate until it lands. */
const STAGE: Record<AudibleJob['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  decrypting: 'Decrypting',
  filing: 'Adding to your library',
  done: 'Added',
  error: 'Failed',
};

/** The four states every queue shares. Audible's three middle ones are all
 *  'downloading' as far as the page's sections go; the difference survives as
 *  the stage line on the card. */
function state(job: AudibleJob): DownloadState {
  if (job.state === 'done' || job.state === 'error' || job.state === 'queued') return job.state;
  return 'downloading';
}

function toItem(job: AudibleJob, hide: (id: string) => void): DownloadItem {
  return {
    id: job.id,
    title: job.title,
    subtitle: job.author,
    kind: 'book',
    artworkUrl: job.cover,
    state: state(job),
    stage: STAGE[job.state],
    error: job.error,
    createdAt: job.createdAt,
    remove: () => hide(job.id),
  };
}
export const audible: Plugin = {
  id: 'audible',
  name: 'Audible',
  description: 'Download the audiobooks you own on Audible into your library.',
  icon: <BookHeadphones size={22} />,
  author: 'AttackFM',
  version: '0.3.2',
  tags: ['Audiobooks', 'Downloads'],
  requiresServer: true,
  details:
    'Links your own Audible account to your hub so the books you already own can be pulled into ' +
    'your library — decrypted to plain, chaptered files. You sign in on Amazon’s own page (in ' +
    'this plugin’s settings), so your password never touches the app or the server. Whatever it ' +
    'saves shows up on the built-in Books shelf. Free, public-domain books are a separate plugin ' +
    '(LibriVox).',
  // Mounted while the plugin is on, so a book keeps downloading (and the
  // library keeps getting rescanned as it lands) wherever you are.
  Provider: AudibleQueueProvider,
  pages: [
    {
      id: 'downloader',
      label: 'Audible',
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
  downloads: [
    {
      id: 'queue',
      label: 'Audible',
      icon: <BookHeadphones size={11} />,
      useDownloads: () => {
        const { jobs, hide, clearFinished } = useAudibleQueue();
        return useMemo(
          () => ({ items: jobs.map((job) => toItem(job, hide)), clearFinished }),
          [jobs, hide, clearFinished],
        );
      },
    },
  ],
};
