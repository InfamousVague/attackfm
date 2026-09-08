import type { Track } from '../core/tauri.ts';

/**
 * A placeholder is an ordinary Track whose PATH names the import job it waits
 * on (`pending:<jobId>`). The player treats that scheme as "do not try to load
 * this, show it downloading" (see isPendingPath in Player); the watcher in
 * `pendingPlay.tsx` turns the finished job into the synced library Track and
 * hands it to playFrom.
 */

const PENDING_SCHEME = 'pending:';

export function pendingPath(jobId: string): string {
  return `${PENDING_SCHEME}${jobId}`;
}

export function isPendingPath(path: string): boolean {
  return path.startsWith(PENDING_SCHEME);
}

export function pendingJobId(path: string): string | null {
  return isPendingPath(path) ? path.slice(PENDING_SCHEME.length) : null;
}

/** The placeholder Now Playing shows while a tapped remote song downloads: it
 *  carries everything the sheet draws (art, title, artist) but no duration and
 *  a path the player will not try to load. */
export function placeholderTrack(opts: {
  jobId: string;
  title: string;
  artist: string;
  artwork: string | null;
}): Track {
  return {
    path: pendingPath(opts.jobId),
    title: opts.title,
    artist: opts.artist,
    album: '',
    duration: null,
    addedAt: Date.now(),
    artwork: opts.artwork,
    genre: '',
    lyrics: '',
  };
}
