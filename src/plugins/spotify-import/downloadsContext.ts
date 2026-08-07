import { createContext, useContext } from 'react';
import type { MusicImportJob } from './musicImport.ts';

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
