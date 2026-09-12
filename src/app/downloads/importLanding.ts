import { looksLikePlaylist } from '../nav/downloadsDoor.ts';
import type { MusicImportJob } from '../../plugins/importsBridge.ts';

/**
 * Where a pasted PLAYLIST link takes you.
 *
 * The hub stages a playlist the moment it reads a playlist link's listing -
 * the source's name and picture, one want per song - and the job it hands
 * back carries that list's id. The surface that pasted the link is the wrong
 * place to act on it: the search field is a leaf with no route to the nav
 * stack, the palette command lives in a plugin, and neither is still mounted
 * by the time a slow listing finally answers. So the paste site only says
 * "I am expecting this link to land somewhere", here, and one headless
 * watcher (ImportLanding) reads the queue and does the taking.
 *
 * The decision is a pure function over the expectations and the queue, so it
 * can be tested without a provider. Singles and albums are never expected:
 * they finish before anyone would look up, and moving the page for them was
 * always the wrong answer.
 */

/** A paste this device is waiting to be taken somewhere for. */
export interface Landing {
  url: string;
  /** Epoch ms of the paste. */
  at: number;
}

/**
 * How long a link may wait for the hub to name its playlist before the old
 * answer stands in: the Downloads pane, which is where a queue on a server
 * from before staged lists (or a listing the hub could not read) can still be
 * watched. The response itself waits eight seconds for the listing, and the
 * queue is polled every five while something runs, so this is the second
 * look and not the first.
 */
export const FALLBACK_MS = 20_000;

/** A paste nobody's queue ever answered for is forgotten rather than acted
 *  on at some later, unrelated moment. */
export const STALE_MS = 10 * 60_000;

let expected: Landing[] = [];

/** Say a link was just handed to the queue. A no-op for anything that is not
 *  a playlist by its shape, so every paste site can call it unconditionally. */
export function expectPlaylistLanding(url: string): void {
  const link = url.trim();
  if (!link || !looksLikePlaylist(link)) return;
  expected = [...expected.filter((e) => e.url !== link), { url: link, at: Date.now() }];
}

export function forgetLanding(url: string): void {
  expected = expected.filter((e) => e.url !== url);
}

/** What is being waited for right now. */
export function expectedLandings(): readonly Landing[] {
  return expected;
}

/** Test seam. */
export function resetLandings(): void {
  expected = [];
}

export interface LandingPlan {
  /** Pastes whose playlist the hub has named: go there. */
  open: { url: string; playlistId: number }[];
  /** Pastes the hub will not be naming a playlist for: the Downloads pane. */
  fallback: string[];
  /** Pastes nothing ever answered for, to be dropped. */
  stale: string[];
}

/**
 * The decision, over the queue as it reads right now.
 *
 * A job that carries `playlistId` is the whole answer. A job without one is
 * either a server still reading the listing (wait) or one that never will -
 * a hub from before staged lists, or a link whose listing could not be read.
 * Those cannot be told apart from here, so time tells them apart: past
 * FALLBACK_MS, or once the job has already ended without ever naming a list,
 * the Downloads pane is where the queue can be watched, exactly as before.
 */
export function planLandings(
  waiting: readonly Landing[],
  jobs: readonly MusicImportJob[],
  now: number,
): LandingPlan {
  const plan: LandingPlan = { open: [], fallback: [], stale: [] };
  for (const w of waiting) {
    const job = jobs.find((j) => j.url === w.url);
    if (!job) {
      if (now - w.at > STALE_MS) plan.stale.push(w.url);
      continue;
    }
    if (typeof job.playlistId === 'number') {
      plan.open.push({ url: w.url, playlistId: job.playlistId });
      continue;
    }
    const ended = job.state === 'done' || job.state === 'error';
    if (ended || now - w.at > FALLBACK_MS) plan.fallback.push(w.url);
  }
  return plan;
}
