import { fetchDj, trackIdFromPath } from '../server.ts';
import type { ServerSession } from '../api/http.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The running DJ set, as app-level state.
 *
 * It used to live inside DjLauncher, which only exists while the Booth page
 * is on screen - walk to the library mid-set and the lines (and now the
 * voice) fell silent, and a launcher on any OTHER surface could not exist at
 * all. The set is a property of playback, not of a page, so it lives here: a
 * module store any launcher publishes into and one app-level bridge
 * (DjSetBridge) watches - toasting the lines, speaking the beats, and
 * declaring the set over the moment playback wanders somewhere the DJ did
 * not choose.
 */

export interface DjRun {
  /** Every path in the set - leaving them is how a set ends. */
  paths: Set<string>;
  /** The line each run opens with, keyed by its first track. */
  lineAt: Map<string, string>;
  /** The spoken beats for each run's first track (djVoice.ts clip ids). */
  voiceAt: Map<string, string[]>;
}

let current: DjRun | null = null;
const subs = new Set<() => void>();

export function publishDjRun(run: DjRun | null): void {
  current = run;
  for (const fn of subs) fn();
}

export function currentDjRun(): DjRun | null {
  return current;
}

export function subscribeDjRun(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/**
 * Ask the DJ for a set and publish it: the one start path every launcher
 * shares, so the Booth's hero and the Now Playing button cannot drift. The
 * caller gets the queue back and decides how to start playing it (they know
 * their own onPlay); the run itself is already live for the bridge.
 */
export async function startDjRun(
  session: ServerSession,
  library: Track[],
  seed = '',
): Promise<{ queue: Track[]; ai: boolean }> {
  const reply = await fetchDj(session, seed);
  const byId = new Map<number, Track>();
  for (const t of library) {
    const id = trackIdFromPath(t.path);
    if (id != null) byId.set(id, t);
  }
  const queue: Track[] = [];
  const paths = new Set<string>();
  const lineAt = new Map<string, string>();
  const voiceAt = new Map<string, string[]>();
  for (const block of reply.blocks) {
    let first = true;
    for (const id of block.trackIds) {
      const t = byId.get(id);
      if (!t) continue;
      queue.push(t);
      paths.add(t.path);
      if (first && block.say.trim()) lineAt.set(t.path, block.say.trim());
      if (first && block.voice && block.voice.length > 0) voiceAt.set(t.path, block.voice);
      first = false;
    }
  }
  publishDjRun(queue.length > 0 ? { paths, lineAt, voiceAt } : null);
  return { queue, ai: reply.ai };
}
