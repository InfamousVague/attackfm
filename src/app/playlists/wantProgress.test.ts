/**
 * One arriving song's reading, off the import bringing it. The join is by
 * identity, the ordering is the listing's, and the want's own mark outranks
 * whatever the card says - those three are what a wrong row would get wrong.
 */
import { describe, expect, it } from 'vitest';
import type { MusicImportJob } from '../../plugins/importsBridge.ts';
import type { PlaylistWant } from '../api/playlists.ts';
import { identityKey } from '../downloads/identity.ts';
import { importJobFor, wantProgress } from './wantProgress.ts';

function job(over: Partial<MusicImportJob>): MusicImportJob {
  return {
    id: 'j1',
    url: 'https://open.spotify.com/playlist/x',
    kind: 'playlist',
    title: 'Peaceful Piano',
    service: 'server',
    quality: 'LOSSLESS',
    total: 3,
    completed: 1,
    state: 'downloading',
    error: null,
    createdAt: 1,
    artworkUrl: null,
    subtitle: null,
    currentTrack: null,
    tracks: ['Let It Happen', 'Bomb Thrown', 'Never Came'],
    items: [
      { title: 'Let It Happen', artist: 'Tame Impala' },
      { title: 'Bomb Thrown', artist: 'Czarface, Frankie Pulitzer' },
      { title: 'Never Came', artist: 'Nobody' },
    ],
    currentIndex: 0,
    outputDir: '',
    files: [],
    playlistId: 9,
    ...over,
  };
}

function want(artist: string, title: string, error: string | null = null): PlaylistWant {
  return { k: identityKey(artist, title), title, artist, url: '', createdAt: 1, error };
}

describe('wantProgress', () => {
  it('reads done / downloading / queued off the job, in the listing order', () => {
    const j = job({});
    expect(wantProgress(want('Tame Impala', 'Let It Happen'), j).state).toBe('downloaded');
    expect(wantProgress(want('Czarface, Frankie Pulitzer', 'Bomb Thrown'), j).state).toBe('downloading');
    expect(wantProgress(want('Nobody', 'Never Came'), j).state).toBe('queued');
  });

  it('finds a want filed under a longer credit than the listing printed', () => {
    // The listing says "Czarface"; the want was filed with the feature.
    const j = job({ items: [{ title: 'Bomb Thrown', artist: 'Czarface' }], completed: 0 });
    expect(wantProgress(want('Czarface, Frankie Pulitzer', 'Bomb Thrown'), j).state).toBe('downloading');
  });

  it('a song the listing never named is simply waiting', () => {
    expect(wantProgress(want('Someone', 'Else'), job({})).state).toBe('waiting');
    expect(wantProgress(want('Nobody', 'Never Came'), null).state).toBe('waiting');
  });

  it('a queued job has reached nothing yet', () => {
    const j = job({ state: 'queued', completed: 0 });
    expect(wantProgress(want('Tame Impala', 'Let It Happen'), j).state).toBe('queued');
  });

  it('a finished job means the file is down and the hub is filing it', () => {
    const j = job({ state: 'done', completed: 3 });
    expect(wantProgress(want('Nobody', 'Never Came'), j).state).toBe('downloaded');
  });

  it("the want's own mark wins over the card, and carries the reason", () => {
    const marked = want('Nobody', 'Never Came', 'not found');
    expect(wantProgress(marked, job({}))).toEqual({ state: 'failed', reason: 'not found' });
    expect(wantProgress(marked, null)).toEqual({ state: 'failed', reason: 'not found' });
  });

  it('a failed job fails every want it was bringing, in its own words', () => {
    const j = job({ state: 'error', error: 'All providers failed\nqobuz: nope' });
    expect(wantProgress(want('Nobody', 'Never Came'), j)).toEqual({
      state: 'failed',
      reason: 'All providers failed\nqobuz: nope',
    });
  });
});

describe('importJobFor', () => {
  it('finds the job carrying this list, preferring the one still running', () => {
    const dead = job({ id: 'old', state: 'error', error: 'x' });
    const live = job({ id: 'new', state: 'downloading' });
    const other = job({ id: 'other', playlistId: 10 });
    expect(importJobFor([dead, other, live], '9')?.id).toBe('new');
    expect(importJobFor([dead, other], '9')?.id).toBe('old');
    expect(importJobFor([other], '9')).toBeNull();
    expect(importJobFor(undefined, '9')).toBeNull();
  });
});
