import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Track } from '../core/tauri.ts';

/**
 * Which queue the two verbs land on.
 *
 * `playNext` and `addToQueue` mean the same thing everywhere in the app, but
 * they do not land in the same PLACE: on your own deck (or hosting a groove,
 * where your deck IS the room's) they edit locally; FOLLOWING somebody else's
 * groove, your own deck is silent and an add has to go to the room instead.
 * Getting that wrong is invisible - the menu closes either way - and the song
 * simply never appears for anyone.
 *
 * The provider reads its answer off the groove context, so that is what is
 * faked here; everything else is the real component and the real hook.
 */
const jamValue: { current: unknown } = { current: null };
vi.mock('./jam.tsx', () => ({ useJamOptional: () => jamValue.current }));

/**
 * Connect, the OTHER claim on these two verbs.
 *
 * A device that is watching another one play has `current === null` by
 * design, so the local verbs' "nothing is playing here, just play it"
 * shortcut would seize the seat from the deck that IS playing. The bridge
 * reads Connect to spot that and send the ask across instead - so the fake
 * below is the third input to every case here, and it defaults to a device
 * that is not connected to anything.
 */
type Connect = {
  connected: boolean;
  activeDeviceId: string | null;
  thisDeviceId: string | null;
  sendCommand: ReturnType<typeof vi.fn>;
};
const connectValue: { current: Connect } = { current: alone() };
vi.mock('./playbackSync.tsx', () => ({ useConnect: () => connectValue.current }));

/** This device, playing for itself: no seat anywhere else to defer to. */
function alone(): Connect {
  return { connected: false, activeDeviceId: null, thisDeviceId: 'this', sendCommand: vi.fn() };
}

/** This device, watching another one play - the seat is elsewhere. */
function watching(): Connect {
  return { connected: true, activeDeviceId: 'desktop', thisDeviceId: 'this', sendCommand: vi.fn() };
}

beforeEach(() => {
  connectValue.current = alone();
});

import { QueueControlsBridge, useQueueControls } from './queueControls.tsx';

const song = { path: 'afm://1', title: 'Song 1', artist: 'A' } as Track;

/** A room, from the point of view of this device. */
function room(opts: { hosting: boolean; hostName?: string; addToRoom?: unknown }) {
  return {
    current: { id: 'room-1', hostName: opts.hostName ?? 'kim' },
    hosting: opts.hosting,
    addToRoom: opts.addToRoom,
  };
}

/** Mount the bridge over the hook and hand back both, plus the local spies. */
function mount(jam: unknown) {
  jamValue.current = jam;
  const localPlayNext = vi.fn();
  const localAddToQueue = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueueControlsBridge localPlayNext={localPlayNext} localAddToQueue={localAddToQueue}>
      {children}
    </QueueControlsBridge>
  );
  const { result } = renderHook(() => useQueueControls(), { wrapper });
  return { controls: result.current, localPlayNext, localAddToQueue };
}

describe('outside a groove', () => {
  it('edits this deck, and says so', () => {
    const { controls, localPlayNext, localAddToQueue } = mount(null);
    controls.playNext(song);
    controls.addToQueue(song);
    expect(localPlayNext).toHaveBeenCalledWith(song);
    expect(localAddToQueue).toHaveBeenCalledWith(song);
    expect(controls).toMatchObject({ inJam: false, following: false, hostName: '' });
  });
});

describe('hosting a groove', () => {
  it('still edits this deck - the host’s deck IS the room’s', () => {
    const addToRoom = vi.fn();
    const { controls, localPlayNext, localAddToQueue } = mount(room({ hosting: true, addToRoom }));
    controls.playNext(song);
    controls.addToQueue(song);
    expect(localPlayNext).toHaveBeenCalledWith(song);
    expect(localAddToQueue).toHaveBeenCalledWith(song);
    // Sending to the room would be the host asking themselves.
    expect(addToRoom).not.toHaveBeenCalled();
  });

  it('says it is in a groove without saying it is following one', () => {
    const { controls } = mount(room({ hosting: true, addToRoom: vi.fn(), hostName: 'matt' }));
    // Surfaces read `following` to decide between "the queue" and "the
    // groove"; a host who saw "the groove" would be told their own deck is
    // somewhere else.
    expect(controls).toMatchObject({ inJam: true, following: false, hostName: 'matt' });
  });
});

describe('following a groove', () => {
  it('sends a play-next to the ROOM, marked next', () => {
    const addToRoom = vi.fn();
    const { controls, localPlayNext } = mount(room({ hosting: false, addToRoom }));
    controls.playNext(song);
    expect(addToRoom).toHaveBeenCalledWith(song, { next: true });
    // The follower's own deck is silent; editing it would put the song
    // somewhere nobody is listening.
    expect(localPlayNext).not.toHaveBeenCalled();
  });

  it('sends a plain add to the room with no marking at all', () => {
    const addToRoom = vi.fn();
    const { controls, localAddToQueue } = mount(room({ hosting: false, addToRoom }));
    controls.addToQueue(song);
    expect(addToRoom).toHaveBeenCalledWith(song);
    // Not `{ next: false }`: the host's fold reads the two lists the hub
    // sends, and an add marked at all would join the wrong one.
    expect(addToRoom.mock.calls[0]).toHaveLength(1);
    expect(localAddToQueue).not.toHaveBeenCalled();
  });

  it('names the host, so a surface can say whose groove it is', () => {
    const { controls } = mount(room({ hosting: false, addToRoom: vi.fn(), hostName: 'kim' }));
    expect(controls).toMatchObject({ inJam: true, following: true, hostName: 'kim' });
  });

  it('falls back to this deck when the room offers no way in', () => {
    // A room without `addToRoom` (an older provider, a room mid-teardown) is
    // still a room - but the verbs have to do SOMETHING, and doing nothing
    // is the failure this branch exists to avoid.
    const { controls, localPlayNext } = mount(room({ hosting: false, addToRoom: undefined }));
    controls.playNext(song);
    expect(localPlayNext).toHaveBeenCalledWith(song);
    expect(controls.following).toBe(false);
  });
});

describe('watching another device play', () => {
  it('asks the deck that is playing, rather than starting the song here', () => {
    connectValue.current = watching();
    const { controls, localPlayNext } = mount(null);
    controls.playNext(song);
    expect(connectValue.current.sendCommand).toHaveBeenCalledWith({
      action: 'enqueueNext',
      queue: [1],
    });
    // Editing this deck is what "it started playing right away" was: the
    // phone claimed the seat and stopped the desktop mid-song.
    expect(localPlayNext).not.toHaveBeenCalled();
  });

  it('sends a plain add to the end of that deck’s line', () => {
    connectValue.current = watching();
    const { controls, localAddToQueue } = mount(null);
    controls.addToQueue(song);
    expect(connectValue.current.sendCommand).toHaveBeenCalledWith({
      action: 'enqueueEnd',
      queue: [1],
    });
    expect(localAddToQueue).not.toHaveBeenCalled();
  });

  it('says nothing at all for a file only this device has', () => {
    connectValue.current = watching();
    const { controls } = mount(null);
    // A local path carries no id the other device could resolve, so there is
    // nothing to send - and sending its own path would name a file that
    // machine does not have.
    controls.playNext({ path: '/Users/me/Music/one.flac', title: 'One', artist: 'A' } as Track);
    expect(connectValue.current.sendCommand).not.toHaveBeenCalled();
  });

  it('holds the seat itself when it IS the active device', () => {
    connectValue.current = { ...watching(), activeDeviceId: 'this' };
    const { controls, localPlayNext } = mount(null);
    controls.playNext(song);
    expect(localPlayNext).toHaveBeenCalledWith(song);
    expect(connectValue.current.sendCommand).not.toHaveBeenCalled();
  });

  it('gives way to a groove: the room’s queue is the queue', () => {
    connectValue.current = watching();
    const addToRoom = vi.fn();
    const { controls } = mount(room({ hosting: false, addToRoom }));
    controls.playNext(song);
    // Inside a groove the room wins whichever device holds the Connect seat -
    // otherwise a follower's add would land on one listener's desktop.
    expect(addToRoom).toHaveBeenCalledWith(song, { next: true });
    expect(connectValue.current.sendCommand).not.toHaveBeenCalled();
  });
});

describe('outside the provider', () => {
  it('is inert rather than absent', () => {
    jamValue.current = null;
    const { result } = renderHook(() => useQueueControls());
    // The surface's control can still render; it just does nothing. A
    // component must never have to know whether a deck is mounted above it.
    expect(() => result.current.playNext(song)).not.toThrow();
    expect(() => result.current.addToQueue(song)).not.toThrow();
    expect(result.current).toMatchObject({ inJam: false, following: false, hostName: '' });
  });
});

describe('the value’s identity', () => {
  it('does not change on a poll that changed nothing', () => {
    // The room is a fresh object every poll and this value rides into the
    // menu on every row of the song table. Memoising on the room itself
    // would rebuild the menu a few times a second.
    jamValue.current = room({ hosting: false, addToRoom: vi.fn() });
    const localPlayNext = vi.fn();
    const localAddToQueue = vi.fn();
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useQueueControls());
      return null;
    }
    // A fresh element each time, or React bails out on identical children
    // and the second render never happens.
    const tree = () => (
      <QueueControlsBridge localPlayNext={localPlayNext} localAddToQueue={localAddToQueue}>
        <Probe />
      </QueueControlsBridge>
    );
    const { rerender } = render(tree());
    // A new room object, same id, same host, same hosting flag.
    const addToRoom = (jamValue.current as { addToRoom: unknown }).addToRoom;
    jamValue.current = { current: { id: 'room-1', hostName: 'kim' }, hosting: false, addToRoom };
    rerender(tree());
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});
