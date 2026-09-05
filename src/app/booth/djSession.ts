import { useSyncExternalStore } from 'react';
import { fetchDj, trackIdFromPath } from '../server.ts';
import { saidNoTo } from './saidNo.ts';
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
  /** A bit of lore for any track that has one: the line, and its clip. */
  loreAt: Map<string, { line: string; voice: string[] }>;
  /** Why each song was dealt, keyed by path - the hub's own plain line from
   *  the dossier's real fields. Only songs the hub explained appear. */
  whyAt: Map<string, string>;
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

/** The live set, as a hook: re-renders when a set starts or ends. */
export function useDjRun(): DjRun | null {
  return useSyncExternalStore(subscribeDjRun, currentDjRun, currentDjRun);
}

/** Whether the DJ chose this song - the test every thumb is gated on. */
export function inDjRun(path: string): boolean {
  return current?.paths.has(path) ?? false;
}

/** The hub's reason for a song in the live set, if it gave one. */
export function djWhy(path: string): string | undefined {
  return current?.whyAt.get(path);
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
  /** A station's literal constraint (`unplayed`, `genre:{g}`, `artist:{a}`)
   *  - the pool the set is dealt from, where the seed is only a steer. */
  opts: { filter?: string } = {},
): Promise<{ queue: Track[]; ai: boolean }> {
  const reply = await fetchDj(session, seed, undefined, opts);
  const byId = new Map<number, Track>();
  for (const t of library) {
    const id = trackIdFromPath(t.path);
    if (id != null) byId.set(id, t);
  }
  const queue: Track[] = [];
  const paths = new Set<string>();
  const lineAt = new Map<string, string>();
  const voiceAt = new Map<string, string[]>();
  const loreAt = new Map<string, { line: string; voice: string[] }>();
  const whyAt = new Map<string, string>();
  for (const block of reply.blocks) {
    let first = true;
    for (const id of block.trackIds) {
      const t = byId.get(id);
      if (!t) continue;
      // A song or an act refused this sitting never opens a set, even from
      // a hub that has not caught up with the no yet.
      if (saidNoTo(t)) continue;
      queue.push(t);
      paths.add(t.path);
      if (first && block.say.trim()) lineAt.set(t.path, block.say.trim());
      if (first && block.voice && block.voice.length > 0) voiceAt.set(t.path, block.voice);
      const lore = block.lore?.[String(id)];
      if (lore?.say.trim()) loreAt.set(t.path, { line: lore.say.trim(), voice: lore.voice ?? [] });
      const why = reply.why?.[String(id)];
      if (why) whyAt.set(t.path, why);
      first = false;
    }
  }
  publishDjRun(queue.length > 0 ? { paths, lineAt, voiceAt, loreAt, whyAt } : null);
  return { queue, ai: reply.ai };
}
