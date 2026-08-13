import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useToast } from '@glacier/react';
import { useLibrary } from './library.tsx';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';
import { trackIdFromPath } from './server.ts';
import type { Track } from './tauri.ts';

/**
 * Opportunistic play: tapping a song you do not own yet in Discover or Search
 * should not be a silent no-op. It opens Now Playing on a PLACEHOLDER track -
 * the song's own art, title and artist, drawn from the search/discover result -
 * marked "Downloading", kicks off the import, and swaps in the real file and
 * starts playback the moment it lands in the library.
 *
 * A placeholder is an ordinary Track whose PATH names the import job it waits
 * on (`pending:<jobId>`). The player treats that scheme as "do not try to load
 * this, show it downloading" (see isPendingPath in Player); the watcher below
 * turns the finished job into the synced library Track and hands it to playFrom.
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

// --- the arm-and-play context --------------------------------------------

/** Called by Discover/Search on a tapped, not-yet-owned song: shows the
 *  placeholder in Now Playing and arms the watcher on the import job. */
export type PlayPending = (placeholder: Track, jobId: string) => void;

const PendingPlayContext = createContext<PlayPending | null>(null);

export function PendingPlayProvider({
  value,
  children,
}: {
  value: PlayPending;
  children: ReactNode;
}) {
  return <PendingPlayContext.Provider value={value}>{children}</PendingPlayContext.Provider>;
}

/** The arm-and-play verb, or null where no player hosts it. */
export function usePendingPlay(): PlayPending | null {
  return useContext(PendingPlayContext);
}

// --- the completion watcher ----------------------------------------------

/**
 * Watches ONE armed import job and, when it finishes, resolves it to the synced
 * library Track and hands it back. Mounted inside the downloads + library
 * providers by the app shell. Server imports carry `trackIds` (the direct
 * lookup); a local importer that does not is matched back by title + artist
 * once the rescan lands the file. Renders nothing.
 */
export function PendingPlayWatcher({
  jobId,
  expectTitle,
  expectArtist,
  onResolved,
  onFailed,
}: {
  jobId: string | null;
  expectTitle: string | null;
  expectArtist: string | null;
  onResolved: (track: Track) => void;
  onFailed: () => void;
}) {
  const downloads = useDownloadsOptional();
  const { tracks } = useLibrary();
  const { toast } = useToast();
  // Through refs so a fresh callback each render never re-runs the watch; only
  // the job state and the library actually landing a file should.
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  const jobs = downloads?.jobs;
  useEffect(() => {
    if (!jobId || !jobs) return;
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (job.state === 'error') {
      // Toasts here rather than in App, which sits above the ToastProvider.
      // The latest-wins toast means even a doubled fire shows once.
      toast({
        tone: 'danger',
        message: expectTitle ? `Couldn’t download “${expectTitle}”` : 'Couldn’t download that song.',
      });
      onFailedRef.current();
      return;
    }
    if (job.state !== 'done') return;
    // Resolve the finished job to a track the library has synced in.
    let track: Track | undefined;
    if (job.trackIds && job.trackIds.length > 0) {
      const byId = new Map(tracks.map((t) => [trackIdFromPath(t.path), t] as const));
      track = job.trackIds
        .map((id) => byId.get(id))
        .find((t): t is Track => t !== undefined);
    }
    if (!track) {
      // A local importer with no trackIds: match by title (and artist when we
      // have one) once the rescan lands the file.
      const wantTitle = (expectTitle ?? job.title ?? '').trim().toLowerCase();
      const wantArtist = (expectArtist ?? '').trim().toLowerCase();
      if (wantTitle) {
        track = tracks.find(
          (t) =>
            t.title.trim().toLowerCase() === wantTitle &&
            (!wantArtist || t.artist.trim().toLowerCase() === wantArtist),
        );
      }
    }
    if (track) onResolvedRef.current(track);
    // Done but not synced yet: this effect re-runs when `jobs` or `tracks` do.
  }, [jobId, jobs, tracks, expectTitle, expectArtist, toast]);

  return null;
}
