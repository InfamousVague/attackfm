/**
 * Where a song being downloaded is supposed to end up.
 *
 * Adding from Discover used to mean one thing - "into the library" - and then
 * you went and found it. Filing it at the same time is the whole point of this:
 * you already know it is for the run playlist when you tap add, and being made
 * to remember that ten minutes later, after a download you were not watching,
 * is the app forgetting on your behalf.
 *
 * PERSISTED, because the gap between asking and arriving is real. A big
 * playlist import can outlast the page: an app reload, a tab crash, a phone
 * that slept. A plan held only in memory is a promise that quietly expires, and
 * the failure is invisible - the song lands in the library and simply is not in
 * the list, which reads as the app losing it rather than as a lost intent.
 *
 * The plan is keyed by JOB id rather than by URL. Two jobs can carry the same
 * URL over a session (add, remove, add again) and only the current one is owed
 * anything.
 */

const KEY = 'attackfm-file-plan';

/** A day. Long enough for any real import, short enough that a plan for a job
 *  that died in some way nobody recorded does not sit here forever. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type FileDestination =
  | { kind: 'liked' }
  | { kind: 'playlist'; id: string; name: string };

export interface FilePlan {
  jobId: string;
  dest: FileDestination;
  /** What was asked for, so a toast can name it without the library. */
  title: string;
  madeAt: number;
  /** Set once the tracks have been filed, so the navigation happens once. */
  filed?: boolean;
}

function read(): FilePlan[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as FilePlan[];
    if (!Array.isArray(all)) return [];
    const fresh = all.filter((p) => p && typeof p.jobId === 'string' && Date.now() - p.madeAt < MAX_AGE_MS);
    return fresh;
  } catch {
    return [];
  }
}

function write(plans: FilePlan[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(plans));
  } catch {
    // Holds for this run only, which is still better than dropping it now.
  }
}

const listeners = new Set<() => void>();
let snapshot: FilePlan[] = typeof localStorage === 'undefined' ? [] : read();

function commit(next: FilePlan[]): void {
  snapshot = next;
  write(next);
  for (const l of listeners) l();
}

export function plansSnapshot(): FilePlan[] {
  return snapshot;
}

export function subscribePlans(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function planFiling(jobId: string, dest: FileDestination, title: string): void {
  // One plan per job: asking twice replaces rather than files twice.
  const rest = snapshot.filter((p) => p.jobId !== jobId);
  commit([...rest, { jobId, dest, title, madeAt: Date.now() }]);
}

export function markFiled(jobId: string): void {
  commit(snapshot.map((p) => (p.jobId === jobId ? { ...p, filed: true } : p)));
}

export function forgetPlan(jobId: string): void {
  commit(snapshot.filter((p) => p.jobId !== jobId));
}

/** The plan owed for a job, or null. */
export function planFor(jobId: string): FilePlan | null {
  return snapshot.find((p) => p.jobId === jobId) ?? null;
}
