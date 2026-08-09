import { createContext, useContext } from 'react';

/**
 * The seam between the app (and any plugin) and WHATEVER provides the import
 * queue.
 *
 * This lives in the app rather than in the importer plugin because the two
 * sides of the seam ship separately now: the importer is distributed through a
 * plugin repository while core surfaces (Discover's get-this buttons, the home
 * page's suggestions) are compiled in. A context is an identity - both sides
 * must hold the SAME object for `useContext` to connect them - so the object
 * lives on the host, the remote plugin reaches it through the host-module
 * bridge, and the consumers keep importing it from here.
 *
 * Everything here is contract, no implementation: the shape of a job, the
 * shape of the queue, and the two hooks. The provider that fills it ships with
 * the importer plugin.
 */

/** A queued/running/finished music import, mirroring the Rust `MusicImportJob`. */
export type MusicImportState = 'queued' | 'downloading' | 'done' | 'error';

export interface MusicImportJob {
  id: string;
  url: string;
  /** playlist | album | artist | track | link */
  kind: string;
  title: string;
  service: string;
  quality: string;
  total: number | null;
  completed: number;
  /** How many finished tracks were dropped as already in the library, so a
   * done job can say "already yours" rather than looking like it lost songs.
   * Absent on jobs from before the backend counted them. */
  skipped?: number;
  state: MusicImportState;
  error: string | null;
  createdAt: number;
  artworkUrl: string | null;
  subtitle: string | null;
  currentTrack: string | null;
  /** Track titles for an album/playlist, in order. */
  tracks: string[];
  /** 0-based index of the track currently downloading, if any. */
  currentIndex: number | null;
  outputDir: string;
  /** Absolute paths of every file this job downloaded; empty until done, and
   * empty forever on jobs from before the backend recorded them. */
  files: string[];
  /** Server-library track ids of the indexed results, matching `files`. Only
   * the server transport sets it (a hub indexes what it downloads); absent on
   * the local desktop engine and on jobs from older servers. What lets a
   * surface play an import the moment the library syncs it in. */
  trackIds?: number[];
}

export interface DownloadsContextValue {
  /** Every import job, newest activity first. */
  jobs: MusicImportJob[];
  /** Jobs still queued or downloading. */
  active: MusicImportJob[];
  /** Whether the queue is paused (in-flight downloads still finish). */
  paused: boolean;
  /** Queue a link for download; returns the (new or existing) job. */
  enqueue: (url: string) => Promise<MusicImportJob>;
  remove: (id: string) => void;
  retry: (id: string) => void;
  cancel: (id: string) => void;
  /** Pause or resume pulling new downloads. */
  setPaused: (paused: boolean) => void;
  /** Drop all finished/failed cards. */
  clearFinished: () => void;
}

export const DownloadsContext = createContext<DownloadsContextValue | null>(null);

export function useDownloads(): DownloadsContextValue {
  const value = useContext(DownloadsContext);
  if (!value) throw new Error('useDownloads must be used within a DownloadsProvider');
  return value;
}

/**
 * The downloads context if the importer plugin is mounted, else null - for
 * core surfaces (the home page's suggested playlists) that want to enqueue an
 * import WHEN it is available but must not require the plugin. Never throws.
 */
export function useDownloadsOptional(): DownloadsContextValue | null {
  return useContext(DownloadsContext);
}
