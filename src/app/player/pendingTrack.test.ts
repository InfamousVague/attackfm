import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPendingPath, pendingJobId, pendingPath, placeholderTrack } from './pendingTrack.ts';

/**
 * The `pending:` scheme.
 *
 * A song being downloaded rides through the whole player as an ordinary
 * Track whose PATH is a promise rather than a file. Everything downstream
 * branches on that one predicate: the deck refuses to load the file, the
 * sheet draws "Downloading" instead of a seek bar, and the strip declines to
 * report a listen.
 *
 * Which makes the failure mode of a loose predicate specific and bad. Say
 * `isPendingPath` accepted a real library path - the deck would stop loading
 * songs that are sitting on disk, and the app would look like it had lost
 * the library. So the cases below are mostly about what is NOT a pending
 * path.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('the pending path', () => {
  it('round-trips a job id', () => {
    expect(pendingJobId(pendingPath('job-42'))).toBe('job-42');
  });

  it('survives a job id with the scheme’s own punctuation in it', () => {
    // `slice` from a fixed offset, not a split on ':' - a server job id is
    // opaque and has carried colons before.
    expect(pendingJobId(pendingPath('deezer:12:34'))).toBe('deezer:12:34');
  });

  it('says yes to what it minted', () => {
    expect(isPendingPath(pendingPath('job-42'))).toBe(true);
  });
});

describe('isPendingPath', () => {
  it('says no to a real library path', () => {
    // The one that matters: a false yes here stops the deck loading a song
    // that is already on disk.
    expect(isPendingPath('/Music/Rumours/02 Dreams.flac')).toBe(false);
    expect(isPendingPath('afm://1234')).toBe(false);
    expect(isPendingPath('https://matt.attack.fm/api/stream/9')).toBe(false);
  });

  it('says no to a path that merely CONTAINS the scheme', () => {
    // `startsWith`, not `includes`. A folder called "pending" is a thing
    // people have, and a song inside one is a song, not a promise.
    expect(isPendingPath('/Music/pending:1/track.mp3')).toBe(false);
    expect(isPendingPath('/Music/pending/track.mp3')).toBe(false);
  });

  it('says no to an empty path rather than throwing', () => {
    expect(isPendingPath('')).toBe(false);
    expect(pendingJobId('')).toBe(null);
  });

  it('answers null - not an empty string - for a path it does not own', () => {
    // The caller branches on `!== null`; an empty string would read as a job
    // whose id is blank and arm a watcher on nothing.
    expect(pendingJobId('/Music/x.mp3')).toBe(null);
  });
});

describe('placeholderTrack', () => {
  const opts = { jobId: 'job-7', title: 'Dreams', artist: 'Fleetwood Mac', artwork: 'blob:art' };

  it('wears a path the player will refuse to load', () => {
    // The whole point of the placeholder. A track built with the job id
    // straight into `path` would look real and send the deck at a file that
    // does not exist.
    const track = placeholderTrack(opts);
    expect(isPendingPath(track.path)).toBe(true);
    expect(pendingJobId(track.path)).toBe('job-7');
  });

  it('carries everything the sheet draws', () => {
    expect(placeholderTrack(opts)).toMatchObject({
      title: 'Dreams',
      artist: 'Fleetwood Mac',
      artwork: 'blob:art',
    });
  });

  it('has no duration, because nothing knows one yet', () => {
    // Null rather than 0: a zero would draw a seek bar that is already at
    // the end of a song that has not started.
    expect(placeholderTrack(opts).duration).toBe(null);
  });

  it('fills the fields a Track cannot be without', () => {
    // `album`, `genre` and `lyrics` are not optional on a Track, and rows
    // read them with no guard - `.toLowerCase()` on a hole throws.
    const track = placeholderTrack(opts);
    expect(track.album).toBe('');
    expect(track.genre).toBe('');
    expect(track.lyrics).toBe('');
  });

  it('keeps a missing cover as null rather than inventing one', () => {
    expect(placeholderTrack({ ...opts, artwork: null }).artwork).toBe(null);
  });

  it('stamps addedAt now, so it sorts as the newest thing in the library', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
    expect(placeholderTrack(opts).addedAt).toBe(Date.parse('2026-09-07T12:00:00Z'));
  });
});
