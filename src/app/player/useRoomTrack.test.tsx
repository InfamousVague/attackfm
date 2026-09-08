import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Track } from '../core/tauri.ts';
import type { ServerSession } from '../api/http.ts';

/**
 * The room's song as the surfaces see it.
 *
 * `roomTrack.test.ts` next door covers the cache underneath. This file is
 * about the two hooks on top of it, and specifically the rule that is easy to
 * lose in a refactor and expensive to lose in the field: a library still
 * being READ FOR THE FIRST TIME lists nothing, and asking the hub then would
 * ask it about every song the library is about to list. So the hooks HOLD
 * while `scanning`, and pick the question back up when it clears.
 *
 * The other rule is the three states. `undefined` is "still being asked" and
 * `null` is "the hub says there is no such track" - and only the second one
 * earns a "not in your library" note. A hook that collapsed them would put
 * that note over every song for the second it took to fetch.
 */
const libraryValue = { allTracks: [] as Track[], scanning: false };
const sessionValue: { session: ServerSession | null } = { session: null };

vi.mock('../library/library.tsx', () => ({ useLibrary: () => libraryValue }));
vi.mock('../servers/serverSession.tsx', () => ({ useServerSession: () => sessionValue }));
vi.mock('../api/library.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/library.ts')>()),
  fetchTrack: vi.fn(),
}));

import { fetchTrack, remotePath } from '../api/library.ts';
import { forgetRoomTracks, useRoomTrack, useRoomTracks } from './roomTrack.ts';

const asked = vi.mocked(fetchTrack);
const hub = { url: 'https://matt.attack.fm', token: 't' } as unknown as ServerSession;

function row(id: number): Track {
  return { path: remotePath(id), title: `Song ${id}`, artist: 'A', album: 'B', duration: 1 } as Track;
}

/** Put the app in a given state: signed in or not, library read or scanning. */
function world(opts: { session?: ServerSession | null; tracks?: number[]; scanning?: boolean } = {}) {
  sessionValue.session = opts.session === undefined ? hub : opts.session;
  libraryValue.allTracks = (opts.tracks ?? []).map(row);
  libraryValue.scanning = opts.scanning ?? false;
}

beforeEach(() => {
  forgetRoomTracks();
  world();
  asked.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRoomTrack', () => {
  it('answers from this library without asking anything', () => {
    world({ tracks: [1, 2] });
    const { result } = renderHook(() => useRoomTrack(2));
    expect(result.current).toMatchObject({ title: 'Song 2' });
    expect(asked).not.toHaveBeenCalled();
  });

  it('is undefined while the hub is being asked, then the row', async () => {
    world({ tracks: [1] });
    asked.mockResolvedValue(row(500));
    const { result } = renderHook(() => useRoomTrack(500));
    // Undefined, not null: nothing has said the song is missing yet, so no
    // surface should be drawing the "not in your library" note.
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toMatchObject({ title: 'Song 500' }));
  });

  it('is null once the hub has said there is no such track', async () => {
    world({ tracks: [1] });
    asked.mockResolvedValue(null);
    const { result } = renderHook(() => useRoomTrack(500));
    await waitFor(() => expect(result.current).toBeNull());
  });

  it('asks nothing while the library is still being read for the first time', () => {
    // The expensive mistake: asking here would ask the hub about every song
    // the library is a moment away from listing.
    world({ tracks: [], scanning: true });
    renderHook(() => useRoomTrack(500));
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks once the first read has finished', async () => {
    // The third case, and the one that makes the hold mean "later" rather
    // than "never".
    world({ tracks: [], scanning: true });
    asked.mockResolvedValue(row(500));
    const { rerender } = renderHook(() => useRoomTrack(500));
    expect(asked).not.toHaveBeenCalled();
    world({ tracks: [1], scanning: false });
    rerender();
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
  });

  it('asks nothing with no hub, and nothing for no id', () => {
    world({ session: null, tracks: [1] });
    const { result } = renderHook(() => useRoomTrack(500));
    expect(result.current).toBeUndefined();
    world({ tracks: [1] });
    renderHook(() => useRoomTrack(null));
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks once for an id, however many surfaces mount on it', async () => {
    world({ tracks: [1] });
    asked.mockResolvedValue(row(500));
    // The follow seam, the strip and the deck's hero, all on the same song.
    const a = renderHook(() => useRoomTrack(500));
    const b = renderHook(() => useRoomTrack(500));
    const c = renderHook(() => useRoomTrack(500));
    await waitFor(() => expect(a.result.current).toMatchObject({ title: 'Song 500' }));
    expect(b.result.current).toMatchObject({ title: 'Song 500' });
    expect(c.result.current).toMatchObject({ title: 'Song 500' });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('asks again after the hold when the hub was away for a moment', async () => {
    vi.useFakeTimers();
    world({ tracks: [1] });
    asked.mockRejectedValueOnce(new Error('offline'));
    renderHook(() => useRoomTrack(500));
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked).toHaveBeenCalledTimes(1);
    asked.mockResolvedValueOnce(row(500));
    // A hub that was away for a moment must not leave the room's song
    // unnamed for the rest of the session.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    expect(asked).toHaveBeenCalledTimes(2);
  });
});

describe('useRoomTracks - the room’s whole line-up', () => {
  it('maps the library’s own rows with no request at all', () => {
    world({ tracks: [1, 2, 3] });
    const { result } = renderHook(() => useRoomTracks([3, 1]));
    expect(result.current.get(3)).toMatchObject({ title: 'Song 3' });
    expect(result.current.get(1)).toMatchObject({ title: 'Song 1' });
    expect(asked).not.toHaveBeenCalled();
  });

  it('leaves an id still being asked OUT of the map', async () => {
    world({ tracks: [1] });
    asked.mockResolvedValue(row(500));
    const { result } = renderHook(() => useRoomTracks([1, 500]));
    // Absent, not present-as-undefined: a sleeve reads "no entry" as "still
    // loading", and a null in the map as "no such song".
    expect(result.current.has(500)).toBe(false);
    expect(result.current.has(1)).toBe(true);
    await waitFor(() => expect(result.current.get(500)).toMatchObject({ title: 'Song 500' }));
  });

  it('holds a 404 as null in the map', async () => {
    world({ tracks: [] });
    asked.mockResolvedValue(null);
    const { result } = renderHook(() => useRoomTracks([500]));
    await waitFor(() => {
      expect(result.current.has(500)).toBe(true);
      expect(result.current.get(500)).toBeNull();
    });
  });

  it('asks for each missing id once, not once per row that mentions it', async () => {
    world({ tracks: [1] });
    asked.mockResolvedValue(row(500));
    renderHook(() => useRoomTracks([500, 500, 501]));
    await waitFor(() => expect(asked.mock.calls.length).toBeGreaterThan(0));
    const ids = asked.mock.calls.map((c) => c[1]);
    expect(new Set(ids)).toEqual(new Set([500, 501]));
  });

  it('holds the whole line-up while the library is still being read', () => {
    world({ tracks: [], scanning: true });
    renderHook(() => useRoomTracks([500, 501]));
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks nothing for an empty line-up', () => {
    world({ tracks: [1] });
    renderHook(() => useRoomTracks([]));
    expect(asked).not.toHaveBeenCalled();
  });
});
