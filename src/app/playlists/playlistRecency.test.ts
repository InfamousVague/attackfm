import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notePlaylistPlayed, playlistPlayedAt } from './playlistRecency.ts';

/** "The playlist I had on yesterday" - a fact about THIS device, so it lives
 *  in storage rather than on the server. */
const KEY = 'attackfm-playlist-played';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('notePlaylistPlayed', () => {
  it('stamps a playlist with the moment it was started', () => {
    notePlaylistPlayed('42');
    expect(playlistPlayedAt('42')).toBe(Date.parse('2026-01-01T12:00:00Z'));
  });

  it('moves the stamp forward when the same list is played again', () => {
    notePlaylistPlayed('42');
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    notePlaylistPlayed('42');
    expect(playlistPlayedAt('42')).toBe(Date.parse('2026-01-02T12:00:00Z'));
  });

  it('keeps only the 200 most recent, dropping the oldest', () => {
    // Past the cap this is a history rather than a sort key, and it lives in
    // a storage budget shared with everything else the app remembers.
    for (let i = 0; i < 210; i += 1) {
      vi.setSystemTime(new Date(Date.parse('2026-01-01T12:00:00Z') + i * 1000));
      notePlaylistPlayed(`list-${i}`);
    }
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
    expect(Object.keys(stored)).toHaveLength(200);
    // The newest survived and the oldest did not.
    expect(playlistPlayedAt('list-209')).toBeGreaterThan(0);
    expect(playlistPlayedAt('list-0')).toBe(0);
  });
});

describe('playlistPlayedAt', () => {
  it('is 0 for a playlist that has never been played', () => {
    // Zero rather than undefined: the caller sorts on max(updatedAt, this).
    expect(playlistPlayedAt('never')).toBe(0);
  });

  it('reads a torn entry as "never played anything" rather than throwing', () => {
    localStorage.setItem(KEY, '{not json');
    expect(playlistPlayedAt('42')).toBe(0);
  });

  it('ignores a stored value of the wrong SHAPE', () => {
    // An array parses fine and would then be indexed by playlist id.
    localStorage.setItem(KEY, '[1,2,3]');
    expect(playlistPlayedAt('42')).toBe(0);
  });

  it('still records a new play after a torn entry, rather than staying broken', () => {
    localStorage.setItem(KEY, '{not json');
    notePlaylistPlayed('42');
    expect(playlistPlayedAt('42')).toBe(Date.parse('2026-01-01T12:00:00Z'));
  });
});
