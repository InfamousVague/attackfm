/**
 * The decision about where a pasted playlist link takes you, as arithmetic
 * over the expectations and the queue. The watcher that performs it is a
 * dozen lines of effect; everything worth getting wrong is here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { MusicImportJob } from '../../plugins/importsBridge.ts';
import {
  FALLBACK_MS,
  STALE_MS,
  expectPlaylistLanding,
  expectedLandings,
  forgetLanding,
  planLandings,
  resetLandings,
} from './importLanding.ts';

const NOW = 1_800_000_000_000;
const LIST = 'https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO';

function job(over: Partial<MusicImportJob>): MusicImportJob {
  return {
    id: 'j1',
    url: LIST,
    kind: 'playlist',
    title: 'Peaceful Piano',
    service: 'server',
    quality: 'LOSSLESS',
    total: 40,
    completed: 0,
    state: 'queued',
    error: null,
    createdAt: NOW / 1000,
    artworkUrl: null,
    subtitle: null,
    currentTrack: null,
    tracks: [],
    currentIndex: null,
    outputDir: '',
    files: [],
    ...over,
  };
}

beforeEach(() => resetLandings());

describe('expectPlaylistLanding', () => {
  it('waits for a playlist link and ignores everything else', () => {
    expectPlaylistLanding(`  ${LIST}  `);
    expectPlaylistLanding('https://open.spotify.com/album/1');
    expectPlaylistLanding('https://open.spotify.com/track/1');
    expect(expectedLandings().map((e) => e.url)).toEqual([LIST]);
  });

  it('takes a YouTube Music list= link as a playlist too', () => {
    expectPlaylistLanding('https://music.youtube.com/playlist?list=PL123');
    expect(expectedLandings()).toHaveLength(1);
  });

  it('pasting the same link twice is one expectation, restarted', () => {
    expectPlaylistLanding(LIST);
    expectPlaylistLanding(LIST);
    expect(expectedLandings()).toHaveLength(1);
    forgetLanding(LIST);
    expect(expectedLandings()).toHaveLength(0);
  });
});

describe('planLandings', () => {
  const waiting = [{ url: LIST, at: NOW }];

  it('opens the playlist the hub named, the moment the job carries it', () => {
    const plan = planLandings(waiting, [job({ playlistId: 42 })], NOW + 100);
    expect(plan.open).toEqual([{ url: LIST, playlistId: 42 }]);
    expect(plan.fallback).toEqual([]);
  });

  it('waits while the job has no playlist yet and the paste is fresh', () => {
    const plan = planLandings(waiting, [job({})], NOW + FALLBACK_MS - 1);
    expect(plan).toEqual({ open: [], fallback: [], stale: [] });
  });

  it('falls back to the Downloads pane when the hub never names one', () => {
    // A server from before staged lists: the job runs, no id ever arrives.
    const late = planLandings(waiting, [job({ state: 'downloading' })], NOW + FALLBACK_MS + 1);
    expect(late.fallback).toEqual([LIST]);
    // Or the job is already over without one - a listing that could not be read.
    const ended = planLandings(waiting, [job({ state: 'error', error: 'no' })], NOW + 100);
    expect(ended.fallback).toEqual([LIST]);
  });

  it('a null id is a hub saying "no list for this", not one still reading', () => {
    const plan = planLandings(waiting, [job({ playlistId: null, state: 'done' })], NOW + 100);
    expect(plan.open).toEqual([]);
    expect(plan.fallback).toEqual([LIST]);
  });

  it('forgets a paste no queue ever answered for, and only after a long while', () => {
    expect(planLandings(waiting, [], NOW + STALE_MS - 1).stale).toEqual([]);
    expect(planLandings(waiting, [], NOW + STALE_MS + 1).stale).toEqual([LIST]);
  });

  it('matches the paste to its own job by url, not to whatever is running', () => {
    const other = job({ id: 'j2', url: 'https://open.spotify.com/playlist/other', playlistId: 7 });
    const plan = planLandings(waiting, [other], NOW + 100);
    expect(plan.open).toEqual([]);
  });
});
