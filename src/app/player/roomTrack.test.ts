import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../core/tauri.ts';
import type { ServerSession } from '../api/http.ts';

/**
 * The room's song, when this library does not list it.
 *
 * Everything worth asserting here is about ASKING: how many times, for which
 * ids, and what is remembered afterwards. The module's own header states the
 * four rules, and each one below is a rule with a cost behind it - a room
 * whose song this library lists must cost NOTHING (no request, no state), and
 * a missing id must be asked once rather than once per surface, because the
 * seam, the strip and the deck all resolve the same song at the same moment.
 *
 * `fetchTrack` is the seam. It is mocked rather than the transport under it,
 * because the contract this module is written against is fetchTrack's own:
 * it RESOLVES null for a hub 404 and REJECTS for a transport failure, and the
 * whole difference between "remembered forever" and "held back ten seconds"
 * hangs off that distinction.
 */
vi.mock('../api/library.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/library.ts')>()),
  fetchTrack: vi.fn(),
}));

import { fetchTrack, remotePath } from '../api/library.ts';
import { forgetRoomTracks, peekRoomTrack, resolveRoomTracks, roomTrack } from './roomTrack.ts';

const asked = vi.mocked(fetchTrack);

const hub = { url: 'https://matt.attack.fm', token: 't', streamToken: 's' } as unknown as ServerSession;
const other = { url: 'https://kim.attack.fm', token: 't', streamToken: 's' } as unknown as ServerSession;

/** A library row, addressed the way the hub addresses one. */
function row(id: number, over: Partial<Track> = {}): Track {
  return {
    path: remotePath(id),
    title: `Song ${id}`,
    artist: 'Somebody',
    album: 'A record',
    duration: 180,
    ...over,
  } as Track;
}

beforeEach(() => {
  forgetRoomTracks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('roomTrack - one ask per id', () => {
  it('asks the hub once, however many surfaces ask at the same moment', async () => {
    asked.mockResolvedValue(row(42));
    // The seam, the strip and the deck, all in one frame, before any answer.
    const three = await Promise.all([roomTrack(hub, 42), roomTrack(hub, 42), roomTrack(hub, 42)]);
    expect(asked).toHaveBeenCalledTimes(1);
    // And all three got the same row, not three rows that happen to match.
    expect(three[0]).toBe(three[1]);
    expect(three[1]).toBe(three[2]);
  });

  it('does not ask again once the answer is in', async () => {
    asked.mockResolvedValue(row(42));
    await roomTrack(hub, 42);
    await roomTrack(hub, 42);
    await roomTrack(hub, 42);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('remembers a 404 for the session - the "not in your library" note stands on a fact', async () => {
    asked.mockResolvedValue(null);
    await expect(roomTrack(hub, 7)).resolves.toBeNull();
    await expect(roomTrack(hub, 7)).resolves.toBeNull();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('keys per hub - a second hub’s #42 is a different song', async () => {
    asked.mockResolvedValueOnce(row(42, { title: "Matt's 42" }));
    asked.mockResolvedValueOnce(row(42, { title: "Kim's 42" }));
    const mine = await roomTrack(hub, 42);
    const theirs = await roomTrack(other, 42);
    expect(asked).toHaveBeenCalledTimes(2);
    expect(mine?.title).toBe("Matt's 42");
    expect(theirs?.title).toBe("Kim's 42");
  });
});

describe('roomTrack - a failure is not an answer', () => {
  it('does not remember a transport failure as a row', async () => {
    asked.mockRejectedValueOnce(new Error('offline'));
    await expect(roomTrack(hub, 42)).rejects.toThrow('offline');
    // Nothing learned: the id is still unknown rather than known-absent.
    expect(peekRoomTrack(hub, 42)).toBeUndefined();
  });

  it('holds the id back for ten seconds, then lets it be asked again', async () => {
    vi.useFakeTimers();
    asked.mockRejectedValueOnce(new Error('offline'));
    await expect(roomTrack(hub, 42)).rejects.toThrow('offline');
    expect(asked).toHaveBeenCalledTimes(1);

    // Inside the hold: refused without spending a request. A hub that is down
    // must not be asked once per surface per beat.
    await expect(roomTrack(hub, 42)).rejects.toThrow(/waiting before asking again/);
    expect(asked).toHaveBeenCalledTimes(1);

    // Still inside it a moment before the line.
    vi.setSystemTime(Date.now() + 9_999);
    await expect(roomTrack(hub, 42)).rejects.toThrow(/waiting before asking again/);
    expect(asked).toHaveBeenCalledTimes(1);

    // Past it: asked again, and this time it answers. This is the third case
    // - without it, "refuses inside the hold" would be satisfied by a module
    // that simply never asks again.
    vi.setSystemTime(Date.now() + 2);
    asked.mockResolvedValueOnce(row(42));
    await expect(roomTrack(hub, 42)).resolves.toMatchObject({ title: 'Song 42' });
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('clears the hold once an ask succeeds', async () => {
    vi.useFakeTimers();
    asked.mockRejectedValueOnce(new Error('offline'));
    await expect(roomTrack(hub, 42)).rejects.toThrow('offline');
    vi.setSystemTime(Date.now() + 10_001);
    asked.mockResolvedValueOnce(row(42));
    await roomTrack(hub, 42);
    // The answer is now cached, so this is served without a request - and
    // WITHOUT tripping the stale failure stamp.
    await expect(roomTrack(hub, 42)).resolves.toMatchObject({ title: 'Song 42' });
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('lets the id be asked again immediately after a rejection, per hub', async () => {
    asked.mockRejectedValueOnce(new Error('offline'));
    await expect(roomTrack(hub, 42)).rejects.toThrow('offline');
    // The other hub was never asked, so its hold is its own.
    asked.mockResolvedValueOnce(row(42));
    await expect(roomTrack(other, 42)).resolves.toMatchObject({ title: 'Song 42' });
  });
});

describe('peekRoomTrack - three states, not two', () => {
  it('is undefined for an id nobody has asked about', () => {
    expect(peekRoomTrack(hub, 42)).toBeUndefined();
  });

  it('is null once the hub has said there is no such track', async () => {
    asked.mockResolvedValue(null);
    await roomTrack(hub, 7);
    // Null, not undefined: only this state earns the "not in your library"
    // note. Conflating it with "not asked yet" is what the note must not do.
    expect(peekRoomTrack(hub, 7)).toBeNull();
  });

  it('is the row once the hub has given one', async () => {
    asked.mockResolvedValue(row(42));
    await roomTrack(hub, 42);
    expect(peekRoomTrack(hub, 42)).toMatchObject({ title: 'Song 42' });
  });

  it('is still undefined while the ask is in flight', () => {
    let settle: (t: Track | null) => void = () => {};
    asked.mockReturnValueOnce(new Promise<Track | null>((res) => (settle = res)));
    void roomTrack(hub, 42).catch(() => {});
    expect(peekRoomTrack(hub, 42)).toBeUndefined();
    settle(row(42));
  });
});

describe('resolveRoomTracks - the host’s fold', () => {
  it('never asks for an id the library already lists', async () => {
    const mine = [row(1), row(2), row(3)];
    const out = await resolveRoomTracks(hub, [1, 3], mine);
    expect(asked).not.toHaveBeenCalled();
    expect(out).toEqual([mine[0], mine[2]]);
  });

  it('asks the hub for the ids the library lacks, and only those', async () => {
    const mine = [row(1)];
    asked.mockResolvedValue(row(9));
    const out = await resolveRoomTracks(hub, [1, 9], mine);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith(hub, 9);
    expect(out[0]).toBe(mine[0]);
    expect(out[1]).toMatchObject({ title: 'Song 9' });
  });

  it('answers in the ids’ order, whatever order the asks settle in', async () => {
    // The fold pairs `rows[i]` with `wanted[i]`, so an out-of-order answer
    // would file a member's song under a different id entirely.
    asked.mockImplementation((_s, id) =>
      id === 9
        ? new Promise<Track | null>((res) => setTimeout(() => res(row(9)), 20))
        : Promise.resolve(row(id as number)),
    );
    const out = await resolveRoomTracks(hub, [9, 8, 7], []);
    expect(out.map((t) => t?.title)).toEqual(['Song 9', 'Song 8', 'Song 7']);
  });

  it('gives null for a hub 404 and undefined for an ask that failed', async () => {
    // The fold reads these differently: null is written to the diag log as
    // "neither this library nor the hub has it"; undefined is simply skipped
    // and may be asked for again on the next beat.
    asked.mockImplementation((_s, id) =>
      id === 404 ? Promise.resolve(null) : Promise.reject(new Error('offline')),
    );
    const out = await resolveRoomTracks(hub, [404, 500], []);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeUndefined();
  });

  it('gives undefined for every id off a hub - no session, nothing to ask', async () => {
    const out = await resolveRoomTracks(null, [1, 2], []);
    expect(asked).not.toHaveBeenCalled();
    expect(out).toEqual([undefined, undefined]);
  });

  it('still resolves the library’s own rows with no session at all', async () => {
    const mine = [row(1)];
    const out = await resolveRoomTracks(null, [1, 2], mine);
    expect(out).toEqual([mine[0], undefined]);
  });

  it('shares its asks with the deck’s own', async () => {
    asked.mockResolvedValue(row(9));
    await Promise.all([roomTrack(hub, 9), resolveRoomTracks(hub, [9], [])]);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('indexes the library by hub id, ignoring rows with no id', async () => {
    // A local file has no `afm://` id at all; it must not shadow id 1 by
    // sitting first in the list.
    const local = { ...row(1), path: '/Users/matt/Music/a.mp3' } as Track;
    asked.mockResolvedValue(row(1, { title: 'the hub one' }));
    const out = await resolveRoomTracks(hub, [1], [local]);
    expect(out[0]).toMatchObject({ title: 'the hub one' });
  });

  it('keeps the FIRST row for a duplicated id', async () => {
    const first = row(1, { title: 'first' });
    const second = row(1, { title: 'second' });
    const out = await resolveRoomTracks(hub, [1], [first, second]);
    expect(out[0]).toBe(first);
  });
});

describe('forgetRoomTracks', () => {
  it('forgets rows, 404s and holds alike', async () => {
    asked.mockResolvedValueOnce(row(1));
    asked.mockResolvedValueOnce(null);
    await roomTrack(hub, 1);
    await roomTrack(hub, 2);
    expect(peekRoomTrack(hub, 1)).not.toBeUndefined();
    expect(peekRoomTrack(hub, 2)).toBeNull();

    forgetRoomTracks();

    expect(peekRoomTrack(hub, 1)).toBeUndefined();
    expect(peekRoomTrack(hub, 2)).toBeUndefined();
    asked.mockResolvedValue(row(1));
    await roomTrack(hub, 1);
    expect(asked).toHaveBeenCalledTimes(3);
  });
});
