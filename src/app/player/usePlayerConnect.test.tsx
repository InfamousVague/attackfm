import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef, type MutableRefObject } from 'react';
import type { Track } from '../core/tauri.ts';

/**
 * The host's fold: what a groove member's send does to the host's line.
 *
 * This is the highest-consequence logic in the app and the least visible - a
 * lost send looks like nothing happening, and nothing happening looks like a
 * slow network. Three rules are asserted here because all three have been
 * wrong in a shipped build:
 *
 *   1. POSITION. A member's "play next" lands right AFTER the song on, in ask
 *      order (the first asker's song plays first - one slice, not a run of
 *      front-inserts, which would play them backwards). A plain send appends.
 *   2. A "next" for a song ALREADY in the line MOVES it, rather than being
 *      dropped as "already queued" and doing nothing at all.
 *   3. An id the HOST's own library never listed is resolved against the hub
 *      rather than dropped on the floor - the listing is scoped per member,
 *      so a guest can send their own collector pull.
 *
 * The fold is not exported: it is closed over inside the beat effect. So the
 * hook is driven for real - the fake `jam.hostBeat` answers with the room's
 * additions and the assertion is on what `onQueueChange` was handed. That is
 * a heavier setup than a pure function would need, but it tests the code that
 * actually runs rather than a copy of it, and it exercises the beat's own
 * ordering (adds folded before the commands that ride behind them).
 */

/* The seams. Each is mocked because it reaches for something a test has no
   business standing up - a hub, a React context, the diag ring - and none of
   them carries any of the logic under test. */
vi.mock('../servers/serverSession.tsx', () => ({
  useServerSession: () => ({ session: { url: 'https://matt.attack.fm', token: 't' } }),
}));
vi.mock('../diag/diagLog.ts', () => ({ recordDiag: vi.fn() }));
vi.mock('../profile/presence.ts', () => ({ setNowPlayingBeat: vi.fn() }));
vi.mock('./connect.ts', () => ({ deviceId: () => 'this-device' }));
/* `resolveRoomTracks` has its own suite next door (roomTrack.test.ts). Here
   it stands in for "the library first, the hub second" so the fold's own
   arithmetic is what is being measured. */
vi.mock('./roomTrack.ts', () => ({
  resolveRoomTracks: vi.fn(),
  peekRoomTrack: vi.fn(() => undefined),
  roomTrack: vi.fn(() => Promise.resolve(null)),
}));

import { recordDiag } from '../diag/diagLog.ts';
import { peekRoomTrack, resolveRoomTracks, roomTrack } from './roomTrack.ts';
import { usePlayerConnect, type PlayerLiveState } from './usePlayerConnect.ts';

const resolved = vi.mocked(resolveRoomTracks);
const peeked = vi.mocked(peekRoomTrack);
const asked = vi.mocked(roomTrack);
const diag = vi.mocked(recordDiag);

/** A row, addressed as the hub addresses one so `trackIdFromPath` reads it. */
function song(id: number): Track {
  return { path: `afm://${id}`, title: `Song ${id}`, artist: 'A', album: 'B', duration: 1 } as Track;
}

/** The hub's own library, for the resolver: whatever the fold asks for. */
function fromLibrary(ids: number[]): (Track | null | undefined)[] {
  return ids.map((id) => song(id));
}

interface Bench {
  /** The queue as `onQueueChange` last left it, by id. */
  line: () => number[];
  onQueueChange: ReturnType<typeof vi.fn>;
  /** Settle the beat that fired on mount, and its fold. */
  beat: () => Promise<void>;
  /** Let the 2.5s interval fire another beat, and settle that one. */
  tick: () => Promise<void>;
  hostBeat: ReturnType<typeof vi.fn>;
  live: MutableRefObject<PlayerLiveState>;
}

/**
 * A host deck with `queue` on it and `track` playing, hosting a room whose
 * next beat replies with `additions` / `additionsNext`.
 *
 * `liveRef` is written back on every queue change, exactly as the Player's own
 * ref is - otherwise a second beat would fold against the queue from before
 * the first, which is not how the deck behaves.
 */
function bench(opts: {
  queue: number[];
  playing?: number | null;
  additions?: number[];
  additionsNext?: number[];
  commands?: { action: 'play' | 'pause' | 'next'; by: string; at: number }[];
  now?: number | null;
  /** Drive the 2.5s beat interval by hand, for the tests about repeats. */
  fakeTimers?: boolean;
}): Bench {
  if (opts.fakeTimers) vi.useFakeTimers();
  const onQueueChange = vi.fn((tracks: Track[]) => {
    live.current = { ...live.current, queue: tracks };
  });
  const cur = opts.playing === undefined ? opts.queue[0] : opts.playing;
  const live: MutableRefObject<PlayerLiveState> = {
    current: {
      playing: false,
      position: 0,
      duration: 100,
      track: cur == null ? null : song(cur),
      shuffle: false,
      repeat: 'off',
      volume: 100,
      queue: opts.queue.map(song),
      setPlayingState: vi.fn(),
      skipForward: vi.fn(),
      skipBack: vi.fn(),
      commitSeek: vi.fn(),
      setVolumeState: vi.fn(),
      allTracks: opts.queue.map(song),
      onTrackChange: vi.fn(),
      onQueueChange,
      deckOwned: true,
    } as unknown as PlayerLiveState,
  };

  const hostBeat = vi.fn(() =>
    Promise.resolve({
      additions: opts.additions ?? [],
      additionsNext: opts.additionsNext ?? [],
      commands: opts.commands ?? [],
    }),
  );

  const jam = {
    current: { id: 'room-1', now: opts.now ?? null, hostName: 'matt' },
    hosting: true,
    hostBeat,
  };
  const connect = {
    connected: false,
    thisDeviceId: 'this-device',
    activeDeviceId: null,
    session: null,
    registerController: vi.fn(),
    reportState: vi.fn(),
    transfer: vi.fn(),
  };

  renderHook(() =>
    usePlayerConnect({
      connect: connect as unknown as Parameters<typeof usePlayerConnect>[0]['connect'],
      jam: jam as unknown as Parameters<typeof usePlayerConnect>[0]['jam'],
      liveRef: live,
      positionRef: { current: 0 },
      playbackRef: { current: { volumeBoost: false } } as unknown as Parameters<
        typeof usePlayerConnect
      >[0]['playbackRef'],
      resumeRef: createRef() as MutableRefObject<null>,
      track: cur == null ? null : song(cur),
      playing: false,
      shuffle: false,
      repeat: 'off',
      volume: 100,
      queue: opts.queue.map(song),
      upNext: [],
      seekTick: 0,
      duration: 100,
      commitSeek: vi.fn(),
      setPlayingState: vi.fn(),
    }),
  );

  /* The beat fires on mount; the fold that follows is a few promise ticks
     deep (hostBeat, then resolveRoomTracks, then the apply behind it).
     Flushing the microtask queue is enough - no timers are involved until
     the 2.5s interval. */
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };

  return {
    onQueueChange,
    live,
    hostBeat,
    line: () => {
      const last = onQueueChange.mock.calls.at(-1);
      return last ? (last[0] as Track[]).map((t) => Number(t.path.slice('afm://'.length))) : [];
    },
    beat: settle,
    tick: async () => {
      vi.advanceTimersByTime(2500);
      await settle();
    },
  };
}

beforeEach(() => {
  // By default the resolver behaves like a host whose library has everything.
  resolved.mockImplementation((_s, ids) => Promise.resolve(fromLibrary([...ids])));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the fold: where a send lands', () => {
  it('puts a plain send at the END of the line', async () => {
    const b = bench({ queue: [1, 2, 3], playing: 1, additions: [9] });
    await b.beat();
    expect(b.line()).toEqual([1, 2, 3, 9]);
  });

  it('puts a "play next" send RIGHT AFTER the song on', async () => {
    const b = bench({ queue: [1, 2, 3], playing: 1, additionsNext: [9] });
    await b.beat();
    expect(b.line()).toEqual([1, 9, 2, 3]);
  });

  it('keeps a batch of "next" sends in ASK order - the first asker plays first', async () => {
    // One slice, not a run of front-inserts. A front-insert per ask would
    // give [1, 11, 10, 9, 2, 3] - the room's requests played backwards, which
    // is the local playNext trick applied where it does not belong.
    const b = bench({ queue: [1, 2, 3], playing: 1, additionsNext: [9, 10, 11] });
    await b.beat();
    expect(b.line()).toEqual([1, 9, 10, 11, 2, 3]);
  });

  it('lands "next" sends before plain ones in the same reply', async () => {
    const b = bench({ queue: [1, 2, 3], playing: 1, additions: [7, 8], additionsNext: [9] });
    await b.beat();
    expect(b.line()).toEqual([1, 9, 2, 3, 7, 8]);
  });

  it('appends a "next" when the song on is not in the line at all', async () => {
    // A song playing from the hand-queued lane is not in the context list, so
    // there is no "after" to insert at. The honest answer is the end.
    const b = bench({ queue: [1, 2, 3], playing: 99, additionsNext: [9] });
    await b.beat();
    expect(b.line()).toEqual([1, 2, 3, 9]);
  });

  it('puts a "next" at the FRONT when nothing is playing', async () => {
    // With the deck stopped, "next" means "first once the host presses play".
    const b = bench({ queue: [1, 2, 3], playing: null, additionsNext: [9] });
    await b.beat();
    expect(b.line()).toEqual([9, 1, 2, 3]);
  });

  it('does not touch the queue when the reply is empty', async () => {
    const b = bench({ queue: [1, 2, 3], playing: 1 });
    await b.beat();
    expect(b.onQueueChange).not.toHaveBeenCalled();
    // And it does not spend a resolve on nothing, either.
    expect(resolved).not.toHaveBeenCalled();
  });
});

describe('the fold: a "next" for a song already in the line MOVES it', () => {
  it('pulls a queued song up behind the song on', async () => {
    // The regression. Treating "already queued" as "nothing to do" made a
    // member's play-next for a song further down the list silently do
    // nothing - the guest watched their request sit where it was.
    const b = bench({ queue: [1, 2, 3, 4], playing: 1, additionsNext: [4] });
    await b.beat();
    expect(b.line()).toEqual([1, 4, 2, 3]);
    // Moved, not duplicated: the line is the same length it was.
    expect(b.line()).toHaveLength(4);
  });

  it('moves the ROW ALREADY IN THE LINE, not a freshly resolved copy of it', async () => {
    // The resolver answers with a different object for the same id. The queue
    // must end up holding the row it was already holding: re-resolving would
    // swap a row the deck may be part-way through for an equal-looking one,
    // and identity is what the queue panel's keys and the deck's own
    // `t.path === cur.path` checks run on.
    const impostor = { ...song(4), title: 'a fresh copy' } as Track;
    resolved.mockResolvedValueOnce([impostor]);
    const b = bench({ queue: [1, 2, 3, 4], playing: 1, additionsNext: [4] });
    await b.beat();
    const line = b.onQueueChange.mock.calls.at(-1)![0] as Track[];
    expect(line.map((t) => t.title)).toEqual(['Song 1', 'Song 4', 'Song 2', 'Song 3']);
  });

  it('leaves the song ON where it is - it has nowhere to go', async () => {
    const b = bench({ queue: [1, 2, 3], playing: 1, additionsNext: [1] });
    await b.beat();
    // A "next" for what is already playing is not a no-op that reorders
    // anything: nothing should move, and nothing should duplicate.
    expect(b.onQueueChange).not.toHaveBeenCalled();
  });

  it('moves one and adds another in the same reply, in ask order', async () => {
    const b = bench({ queue: [1, 2, 3, 4], playing: 1, additionsNext: [4, 9] });
    await b.beat();
    expect(b.line()).toEqual([1, 4, 9, 2, 3]);
  });

  it('leaves a PLAIN send for an already-queued song alone', async () => {
    // "Add to the groove" for something already in the line is genuinely a
    // no-op: the asker gets it, just not sooner.
    const b = bench({ queue: [1, 2, 3], playing: 1, additions: [3] });
    await b.beat();
    expect(b.onQueueChange).not.toHaveBeenCalled();
  });

  it('lets "next" win when one song is asked for both ways in one reply', async () => {
    const b = bench({ queue: [1, 2, 3], playing: 1, additions: [9], additionsNext: [9] });
    await b.beat();
    expect(b.line()).toEqual([1, 9, 2, 3]);
    expect(b.line().filter((n) => n === 9)).toHaveLength(1);
  });

  it('keeps one copy when the same song is asked for twice in one reply', async () => {
    const b = bench({ queue: [1, 2], playing: 1, additionsNext: [9, 9], additions: [8, 8] });
    await b.beat();
    expect(b.line()).toEqual([1, 9, 2, 8]);
  });
});

describe('the fold: an id the host’s own library lacks', () => {
  it('resolves it through the hub rather than dropping it', async () => {
    // The listing is scoped per member: a guest's own collector pull is on
    // the hub and streams to anyone, but was never on the host's shelf. It
    // used to be dropped here, and the row went silently missing from the
    // queue the guest was watching for.
    resolved.mockResolvedValueOnce([song(500)]);
    const b = bench({ queue: [1, 2], playing: 1, additions: [500] });
    await b.beat();
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved.mock.calls[0]![1]).toEqual([500]);
    expect(b.line()).toEqual([1, 2, 500]);
  });

  it('lets go only of what the hub has never heard of, and says so', async () => {
    // null is the hub's own 404 - the one answer that justifies dropping it.
    resolved.mockResolvedValueOnce([null, song(9)]);
    const b = bench({ queue: [1, 2], playing: 1, additions: [404, 9] });
    await b.beat();
    expect(b.line()).toEqual([1, 2, 9]);
    expect(diag).toHaveBeenCalledWith('jam', expect.stringContaining('#404'));
  });

  it('holds an id it could not ask about, without logging it as missing', async () => {
    // undefined is "could not be asked" (roomTrack holds it back and lets it
    // be asked again). Logging that as "the hub does not have it" would be a
    // network blip written down as a fact.
    resolved.mockResolvedValueOnce([undefined]);
    const b = bench({ queue: [1, 2], playing: 1, additions: [9] });
    await b.beat();
    expect(b.onQueueChange).not.toHaveBeenCalled();
    expect(diag).not.toHaveBeenCalled();
  });

  it('resolves the queue’s own row for an id the host DOES have', async () => {
    const b = bench({ queue: [1, 2], playing: 1, additions: [9] });
    await b.beat();
    expect(b.line()).toEqual([1, 2, 9]);
  });
});

describe('the beat: adds are folded before the presses that ride behind them', () => {
  it('applies a command after the fold, so a "next" can land on the new song', async () => {
    const b = bench({
      queue: [1, 2],
      playing: 1,
      additionsNext: [9],
      commands: [{ action: 'next', by: 'kim', at: Date.now() }],
    });
    await b.beat();
    expect(b.line()).toEqual([1, 9, 2]);
    expect(b.live.current.skipForward).toHaveBeenCalledTimes(1);
  });

  it('refuses a second delivery of the same press', async () => {
    // The beat runs on a 2.5s interval, and an interval that overlapped a
    // slow reply hands the same command back. Applied twice, a pause that
    // arrived either side of a play would undo the play.
    const at = Date.now();
    const b = bench({
      queue: [1],
      playing: 1,
      commands: [{ action: 'pause', by: 'kim', at }],
      fakeTimers: true,
    });
    await b.beat();
    expect(b.live.current.setPlayingState).toHaveBeenCalledTimes(1);

    await b.tick();
    // The second beat really did happen - otherwise this test would pass
    // against a hook that simply stopped beating.
    expect(b.hostBeat).toHaveBeenCalledTimes(2);
    expect(b.live.current.setPlayingState).toHaveBeenCalledTimes(1);
  });

  it('applies a DIFFERENT press on the next beat', async () => {
    // The third case: the ring must refuse a repeat without refusing
    // everything that follows it.
    const at = Date.now();
    const b = bench({
      queue: [1],
      playing: 1,
      commands: [{ action: 'pause', by: 'kim', at }],
      fakeTimers: true,
    });
    await b.beat();
    b.hostBeat.mockResolvedValue({
      additions: [],
      additionsNext: [],
      // A different stamp: the same person pressing the same button again.
      commands: [{ action: 'pause', by: 'kim', at: at + 1 }],
    });
    await b.tick();
    expect(b.live.current.setPlayingState).toHaveBeenCalledTimes(2);
  });

  it('lets go of a press older than the staleness window', async () => {
    const b = bench({
      queue: [1],
      playing: 1,
      commands: [{ action: 'pause', by: 'kim', at: Date.now() - 16_000 }],
    });
    await b.beat();
    expect(b.live.current.setPlayingState).not.toHaveBeenCalled();
  });

  it('ages a press by the HUB’s clock when the room carries one', async () => {
    // The device's own clock is the fallback, not a competitor: a phone
    // running fifteen seconds ahead used to drop every press as stale.
    const hubNow = 1_000_000;
    const b = bench({
      queue: [1],
      playing: 1,
      now: hubNow,
      // Fresh by the hub's clock; ancient by this device's (Date.now() is a
      // 2026 epoch millisecond, so `now - c.at` is decades).
      commands: [{ action: 'pause', by: 'kim', at: hubNow - 1_000 }],
    });
    await b.beat();
    expect(b.live.current.setPlayingState).toHaveBeenCalledWith(false);
  });
});

/**
 * The other half of the room: FOLLOWING.
 *
 * A follower's deck steers to the host's. The rule with a real cost in it is
 * the same one the fold has, seen from the other side: the room's song may
 * not be in this listener's library at all, and that used to be the end of it
 * - a disc by name, no sound. The listing is scoped per member while the
 * stream is not, so the hub is asked for the row and only "the hub does not
 * have it either" is the end.
 */

interface Follow {
  live: MutableRefObject<PlayerLiveState>;
  resume: MutableRefObject<unknown>;
  settle: () => Promise<void>;
}

/** A follower's deck, with the room playing `roomTrackId`. */
function following(opts: {
  library: number[];
  /** What this deck holds now, or null for a deck with nothing on it. */
  holding?: number | null;
  roomTrackId: number | null;
  playing?: boolean;
  positionMs?: number;
  silent?: boolean;
  deckOwned?: boolean;
  deckPlaying?: boolean;
}): Follow {
  const holding = opts.holding === undefined ? null : opts.holding;
  const live: MutableRefObject<PlayerLiveState> = {
    current: {
      playing: opts.deckPlaying ?? false,
      position: 0,
      duration: 100,
      track: holding == null ? null : song(holding),
      shuffle: false,
      repeat: 'off',
      volume: 100,
      queue: [],
      setPlayingState: vi.fn(),
      skipForward: vi.fn(),
      skipBack: vi.fn(),
      commitSeek: vi.fn(),
      setVolumeState: vi.fn(),
      allTracks: opts.library.map(song),
      onTrackChange: vi.fn(),
      onQueueChange: vi.fn(),
      deckOwned: opts.deckOwned ?? true,
    } as unknown as PlayerLiveState,
  };
  const resume: MutableRefObject<unknown> = { current: null };
  const jam = {
    current: {
      id: 'room-1',
      updatedAt: 1,
      trackId: opts.roomTrackId,
      trackTitle: 'Their song',
      trackArtist: 'Their act',
      positionMs: opts.positionMs ?? 30_000,
      playing: opts.playing ?? true,
      receivedAt: 0,
      hostName: 'kim',
    },
    hosting: false,
    hostBeat: vi.fn(),
  };
  const connect = {
    connected: false,
    thisDeviceId: 'this-device',
    activeDeviceId: null,
    session: null,
    registerController: vi.fn(),
    reportState: vi.fn(),
    transfer: vi.fn(),
  };
  renderHook(() =>
    usePlayerConnect({
      connect: connect as unknown as Parameters<typeof usePlayerConnect>[0]['connect'],
      jam: jam as unknown as Parameters<typeof usePlayerConnect>[0]['jam'],
      liveRef: live,
      positionRef: { current: 0 },
      playbackRef: { current: { volumeBoost: false } } as unknown as Parameters<
        typeof usePlayerConnect
      >[0]['playbackRef'],
      resumeRef: resume as MutableRefObject<null>,
      track: holding == null ? null : song(holding),
      playing: false,
      shuffle: false,
      repeat: 'off',
      volume: 100,
      queue: [],
      upNext: [],
      seekTick: 0,
      duration: 100,
      commitSeek: vi.fn(),
      setPlayingState: vi.fn(),
      silent: opts.silent ?? false,
    }),
  );
  return {
    live,
    resume,
    settle: async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    },
  };
}

describe('following: taking the room’s song over', () => {
  it('loads the library’s own row and resumes at the host’s position', () => {
    const f = following({ library: [1, 2], roomTrackId: 2, positionMs: 30_000 });
    expect(f.live.current.onTrackChange).toHaveBeenCalledWith(song(2));
    expect(f.resume.current).toMatchObject({ trackId: 2, play: true });
  });

  it('does not ask the hub about a song this library holds', () => {
    following({ library: [1, 2], roomTrackId: 2 });
    expect(asked).not.toHaveBeenCalled();
    expect(peeked).not.toHaveBeenCalled();
  });

  it('asks the hub for a song this library lacks, and plays the answer', async () => {
    // The listing is scoped per member; a song promoted for the host alone is
    // on this hub and plays for this member the moment its row is known.
    asked.mockResolvedValueOnce(song(500));
    const f = following({ library: [1], roomTrackId: 500 });
    await f.settle();
    expect(asked).toHaveBeenCalledWith(expect.anything(), 500);
    expect(f.live.current.onTrackChange).toHaveBeenCalledWith(song(500));
    expect(f.resume.current).toMatchObject({ trackId: 500 });
  });

  it('takes an answer the deck already had off the shared cache', () => {
    peeked.mockReturnValueOnce(song(500));
    const f = following({ library: [1], roomTrackId: 500 });
    // The strip and the deck share one answer: a row already fetched must
    // not cost a second request.
    expect(asked).not.toHaveBeenCalled();
    expect(f.live.current.onTrackChange).toHaveBeenCalledWith(song(500));
  });

  it('stops the deck, and says why, when neither this library nor the hub has it', () => {
    peeked.mockReturnValueOnce(null);
    const f = following({ library: [1], roomTrackId: 500, deckPlaying: true });
    // Carrying on would mean playing something the room is not hearing.
    expect(f.live.current.setPlayingState).toHaveBeenCalledWith(false);
    expect(f.live.current.onTrackChange).not.toHaveBeenCalled();
    expect(diag).toHaveBeenCalledWith('jam', expect.stringContaining('#500'));
  });

  it('stops the deck when the hub could not be asked, and says THAT instead', async () => {
    // The sibling of the 404 above, and it must not read the same: "the hub
    // does not have it" and "the hub did not answer" are different facts,
    // and the second one may come right the next time the room beats.
    asked.mockRejectedValueOnce(new Error('offline'));
    const f = following({ library: [1], roomTrackId: 500, deckPlaying: true });
    await f.settle();
    expect(diag).toHaveBeenCalledWith('jam', expect.stringContaining('could not be asked'));
    expect(f.live.current.setPlayingState).toHaveBeenCalledWith(false);
  });

  it('does nothing at all for a room that is playing nothing', () => {
    const f = following({ library: [1], roomTrackId: null });
    expect(f.live.current.onTrackChange).not.toHaveBeenCalled();
    expect(f.live.current.setPlayingState).not.toHaveBeenCalled();
  });
});

describe('following on the host’s SPEAKER', () => {
  it('stops this deck and takes nothing over', () => {
    // The deck is deliberately silent: the room's song is not its to load,
    // whatever the room moves to.
    const f = following({ library: [1, 2], roomTrackId: 2, silent: true, deckPlaying: true });
    expect(f.live.current.setPlayingState).toHaveBeenCalledWith(false);
    expect(f.live.current.onTrackChange).not.toHaveBeenCalled();
    expect(f.resume.current).toBeNull();
  });

  it('leaves a deck that is already quiet alone', () => {
    const f = following({ library: [1, 2], roomTrackId: 2, silent: true, deckPlaying: false });
    expect(f.live.current.setPlayingState).not.toHaveBeenCalled();
  });
});

describe('following: correcting a drift', () => {
  it('says nothing while the two decks are within a second and a half', () => {
    // Under the line a nudge is more audible than the slip.
    const f = following({ library: [1], holding: 1, roomTrackId: 1, positionMs: 1_000 });
    expect(f.live.current.commitSeek).not.toHaveBeenCalled();
  });

  it('pulls the playhead over once they are singing different bars', () => {
    const f = following({ library: [1], holding: 1, roomTrackId: 1, positionMs: 30_000 });
    expect(f.live.current.commitSeek).toHaveBeenCalledWith(30);
  });

  it('follows the room’s play state on the song it already holds', () => {
    const f = following({
      library: [1],
      holding: 1,
      roomTrackId: 1,
      positionMs: 0,
      playing: false,
      deckPlaying: true,
    });
    expect(f.live.current.setPlayingState).toHaveBeenCalledWith(false);
  });
});

/**
 * WHAT THIS DEVICE TELLS THE HUB WHERE THE SONG IS.
 *
 * Every other device draws its bar from this one number, carried forward on
 * its own clock, so a wrong number is not a wrong instant - it is a bar that
 * is wrong for the whole song. And the number was wrong in exactly one place:
 * a skip. The report effect runs in the same commit as the new track, while
 * the position ref still holds React state from the old one, and the load
 * effect that zeroes it has not run yet (it awaits its source first). Skip
 * four minutes into a track and every watcher drew the next song four minutes
 * in. Nothing corrected it: position is not a dep and no further
 * discontinuity was coming.
 */
function reporter(opts: { track: number; positionSec: number; resume?: unknown }) {
  const position = { current: opts.positionSec };
  const live: MutableRefObject<PlayerLiveState> = {
    current: {
      playing: true,
      position: opts.positionSec,
      duration: 200,
      track: song(opts.track),
      shuffle: false,
      repeat: 'off',
      volume: 100,
      queue: [],
      setPlayingState: vi.fn(),
      commitSeek: vi.fn(),
      allTracks: [song(1), song(2)],
      onTrackChange: vi.fn(),
      onQueueChange: vi.fn(),
      deckOwned: true,
    } as unknown as PlayerLiveState,
  };
  const resume: MutableRefObject<unknown> = { current: opts.resume ?? null };
  const connect = {
    connected: true,
    thisDeviceId: 'this-device',
    activeDeviceId: 'this-device',
    session: null,
    registerController: vi.fn(),
    reportState: vi.fn(),
    transfer: vi.fn(),
  };
  const props = (trackId: number, duration: number) => ({
    connect: connect as unknown as Parameters<typeof usePlayerConnect>[0]['connect'],
    jam: null as unknown as Parameters<typeof usePlayerConnect>[0]['jam'],
    liveRef: live,
    positionRef: position,
    playbackRef: { current: { volumeBoost: false } } as unknown as Parameters<
      typeof usePlayerConnect
    >[0]['playbackRef'],
    resumeRef: resume as MutableRefObject<null>,
    track: song(trackId),
    playing: true,
    shuffle: false,
    repeat: 'off' as const,
    volume: 100,
    queue: [],
    upNext: [],
    seekTick: 0,
    duration,
    commitSeek: vi.fn(),
    setPlayingState: vi.fn(),
    silent: false,
  });
  const view = renderHook(
    (p: { trackId: number; duration: number }) => usePlayerConnect(props(p.trackId, p.duration)),
    { initialProps: { trackId: opts.track, duration: 200 } },
  );
  return {
    connect,
    position,
    live,
    /* Skip to another song, the way the app does: the track changes first and
       the deck follows. Duration goes to 0 because that is what a deck with
       nothing loaded reports, and it is what makes this the moment the old
       position ref is still standing. */
    skipTo: (id: number) => {
      live.current = { ...live.current, track: song(id) } as PlayerLiveState;
      view.rerender({ trackId: id, duration: 0 });
    },
    /** The deck becoming real: metadata landed, the position ref is honest. */
    loaded: (id: number, sec: number) => {
      position.current = sec;
      view.rerender({ trackId: id, duration: 201 });
    },
    /** Every position this device has published, in order. */
    said: () => connect.reportState.mock.calls.map((c) => (c[0] as { positionMs: number }).positionMs),
  };
}

describe('reporting where the song is', () => {
  it('says the new song is at its BEGINNING when skipped to', () => {
    const r = reporter({ track: 1, positionSec: 240 });
    r.skipTo(2);
    expect(r.said().at(-1)).toBe(0);
  });

  it('does not carry the old song’s position onto the new one', () => {
    const r = reporter({ track: 1, positionSec: 240 });
    r.skipTo(2);
    expect(r.said()).not.toContain(240_000);
  });

  it('speaks again once the deck is real, with the position it actually has', () => {
    const r = reporter({ track: 1, positionSec: 240 });
    r.skipTo(2);
    r.loaded(2, 3);
    expect(r.said().at(-1)).toBe(3_000);
  });

  it('honours a resume asked for at a position - a bookmark, a hand-off', () => {
    const r = reporter({
      track: 1,
      positionSec: 240,
      resume: { trackId: 2, positionMs: 90_000, play: true },
    });
    r.skipTo(2);
    expect(r.said().at(-1)).toBe(90_000);
  });

  it('ignores a resume meant for a DIFFERENT song', () => {
    const r = reporter({
      track: 1,
      positionSec: 240,
      resume: { trackId: 7, positionMs: 90_000, play: true },
    });
    r.skipTo(2);
    expect(r.said().at(-1)).toBe(0);
  });
});

/**
 * THE CONSOLE, WHEN ANOTHER DEVICE IS THE ONE PLAYING.
 *
 * The rack and the hi-fi chain are compiled by the ENCODER, on the stream the
 * playing device asked for - `fx` and `fx2` in that device's URL. So a filter
 * tapped on a device that is only holding the remote reached nothing at all:
 * that device's own URL is never fetched, and the phone kept playing the record
 * dry for that song and every song after. The mix (`stems`) was given this wire
 * one release earlier; these two were not.
 *
 * Both ends are asserted here because both have to be right for anything to be
 * heard: the remote must SEND, and the seat holder must COMMIT to its own store
 * - which is what re-spells its URL and reloads the element in place.
 */
import { fxChain, setFxChain } from './fxChain.ts';
import { activeEffects } from './effects.ts';

interface Console {
  /** Every command this device put on the wire. */
  sent: () => { action: string; chain?: unknown; effects?: unknown }[];
  /** The controller the Player registered, as the hub reaches it. */
  controller: () => {
    setChain: (nodes: unknown) => void;
    setEffects: (ids: string[]) => void;
  };
  /** Take the seat back, the way a hand-off does. */
  seatReturns: () => void;
}

/** A deck with `where` holding the seat: 'elsewhere' is a remote, 'here' is the
 *  device actually making the sound. */
function console_(where: 'elsewhere' | 'here'): Console {
  const live: MutableRefObject<PlayerLiveState> = {
    current: {
      playing: false,
      position: 0,
      duration: 100,
      track: song(1),
      shuffle: false,
      repeat: 'off',
      volume: 100,
      queue: [],
      setPlayingState: vi.fn(),
      commitSeek: vi.fn(),
      allTracks: [song(1)],
      onTrackChange: vi.fn(),
      onQueueChange: vi.fn(),
      deckOwned: true,
    } as unknown as PlayerLiveState,
  };
  const sendCommand = vi.fn();
  const registerController = vi.fn();
  const connect = {
    connected: true,
    thisDeviceId: 'this-device',
    activeDeviceId: where === 'here' ? 'this-device' : 'other-device',
    activeElsewhere: where === 'elsewhere',
    session: null,
    registerController,
    reportState: vi.fn(),
    transfer: vi.fn(),
    sendCommand,
  };
  const props = () => ({
    connect: connect as unknown as Parameters<typeof usePlayerConnect>[0]['connect'],
    jam: null as unknown as Parameters<typeof usePlayerConnect>[0]['jam'],
    liveRef: live,
    positionRef: { current: 0 },
    playbackRef: { current: { volumeBoost: false } } as unknown as Parameters<
      typeof usePlayerConnect
    >[0]['playbackRef'],
    resumeRef: createRef() as MutableRefObject<null>,
    track: song(1),
    playing: false,
    shuffle: false,
    repeat: 'off' as const,
    volume: 100,
    queue: [],
    upNext: [],
    seekTick: 0,
    duration: 100,
    commitSeek: vi.fn(),
    setPlayingState: vi.fn(),
    silent: false,
  });
  const view = renderHook(() => usePlayerConnect(props()));
  return {
    sent: () => sendCommand.mock.calls.map((c) => c[0] as { action: string }),
    controller: () => {
      const last = registerController.mock.calls.map((c) => c[0]).filter(Boolean).at(-1);
      return last as ReturnType<Console['controller']>;
    },
    seatReturns: () => {
      connect.activeDeviceId = 'this-device';
      connect.activeElsewhere = false;
      view.rerender();
    },
  };
}

describe('the console on a device that is only the remote', () => {
  beforeEach(() => {
    setFxChain([]);
  });

  it('puts a filter on the wire, whole', () => {
    const c = console_('elsewhere');
    setFxChain([{ t: 'lp', on: true, params: { f: 4000 }, key: 'a' }]);
    expect(c.sent().at(-1)).toEqual({
      action: 'chain',
      chain: [{ t: 'lp', on: true, params: { f: 4000 } }],
    });
  });

  it('sends the clear as well - taking a filter off is a change too', () => {
    const c = console_('elsewhere');
    setFxChain([{ t: 'lp', on: true, params: { f: 4000 }, key: 'a' }]);
    setFxChain([]);
    expect(c.sent().at(-1)).toEqual({ action: 'chain', chain: [] });
  });

  it('keeps the chain here too, so the remote’s own console reads right', () => {
    console_('elsewhere');
    setFxChain([{ t: 'lp', on: true, params: { f: 4000 }, key: 'a' }]);
    expect(fxChain().nodes.map((n) => n.t)).toEqual(['lp']);
  });

  it('stops sending the moment the seat comes back', () => {
    // A device driving its own deck must never send its own sound to itself:
    // the command would be routed straight back and reload the stream twice.
    const c = console_('elsewhere');
    c.seatReturns();
    setFxChain([{ t: 'lp', on: true, params: { f: 4000 }, key: 'a' }]);
    expect(c.sent()).toEqual([]);
  });

  it('says nothing at all while this device is the one playing', () => {
    const c = console_('here');
    setFxChain([{ t: 'lp', on: true, params: { f: 4000 }, key: 'a' }]);
    expect(c.sent()).toEqual([]);
  });
});

describe('the console arriving at the device that IS playing', () => {
  beforeEach(() => {
    setFxChain([]);
  });

  it('commits the chain, which is what re-spells its stream URL', () => {
    const c = console_('here');
    c.controller().setChain([{ t: 'lp', on: true, params: { f: 4000 } }]);
    expect(fxChain().nodes.map((n) => n.t)).toEqual(['lp']);
  });

  it('commits the rack the same way', () => {
    const c = console_('here');
    c.controller().setEffects(['lofi']);
    expect(activeEffects()).toEqual(['lofi']);
    c.controller().setEffects([]);
    expect(activeEffects()).toEqual([]);
  });

  it('does not bounce what arrived back onto the wire', () => {
    // Belt and braces: the playing device holds no relay anyway, but a chain
    // echoed back would be a loop between the two devices.
    const c = console_('here');
    c.controller().setChain([{ t: 'lp', on: true, params: { f: 4000 } }]);
    expect(c.sent()).toEqual([]);
  });
});
