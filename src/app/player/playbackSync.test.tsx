import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createRef, type MutableRefObject } from 'react';
import type { Track } from '../core/tauri.ts';

/**
 * A SOUND COMMAND OFF THE WIRE, END TO END - the half of the console's wire
 * that nothing was watching.
 *
 * `shared/sound-commands.json` ties the two languages together at the SENDING
 * end: `soundCommands.ts` builds every frame from it and `connect.rs`'s suite
 * reads the same file, so renaming the hub's field, the fixture's action or
 * the fixture's field name turns one of the two suites red. The receiving end
 * had no such tie. `handleMessage` in playbackSync.tsx reads
 * `msg.command.chain` by hand, `ConnectCommand` spells the same three payload
 * names by hand next door in connect.ts, and no test had ever put a
 * `{type:'command'}` frame through either of them - the existing console tests
 * call `controller().setChain(...)`, which is one layer BELOW the field name
 * and therefore cannot see it change.
 *
 * So the fourth rename stayed green. Renaming `ConnectCommand.chain` and its
 * reader together to `filters` passed `cargo test`, `tsc` and `vitest`: the
 * app still SENDS `{"action":"chain","chain":[...]}` (built from the fixture),
 * the hub still carries it whole, and the playing device reads
 * `msg.command.filters`, which is undefined - so `setChain` is never called
 * and the filter does nothing on the only device where it could be heard.
 * That is the same silence `gains` shipped with, arrived at from the other
 * direction.
 *
 * This file closes it at the level where it is heard. A real frame, with the
 * action and the field spelled by the fixture and a payload the fixture calls
 * a sample, goes in through the socket's own `onmessage`; the assertion is on
 * the STORE that re-spells this device's stream URL. Nothing in between is
 * stubbed - the same `ConnectSocket`, the same `handleMessage`, the same
 * controller `usePlayerConnect` registers, the same `apply*` on the way in -
 * so a rename anywhere along that path lands here.
 */

/* The seams. Each reaches for something a unit test has no business standing
   up, and none of them carries any of what is under test here. `connect.ts` is
   deliberately NOT among them: the socket and the frame's own type are the
   subject. */
/* ONE session object for the life of the file, not a fresh one per render: the
   provider keys its socket effect on the session's identity, so a hook that
   answers with a new object every time tears the socket down and stands it up
   again on every render - which, since standing one up sets `connected`, is a
   render loop and an out-of-memory rather than a test failure. */
vi.mock('../servers/serverSession.tsx', () => {
  const session = { url: 'https://hub.example', token: 't', streamToken: 's' };
  return { useServerSession: () => ({ session }) };
});
vi.mock('./speakers.ts', () => ({ refreshSpeakers: vi.fn(), setSpeakerHub: vi.fn() }));
vi.mock('../diag/diagLog.ts', () => ({ recordDiag: vi.fn() }));
vi.mock('../profile/presence.ts', () => ({ setNowPlayingBeat: vi.fn() }));
vi.mock('./roomTrack.ts', () => ({
  resolveRoomTracks: vi.fn(),
  peekRoomTrack: vi.fn(() => undefined),
  roomTrack: vi.fn(() => Promise.resolve(null)),
}));

import fixture from '../../../shared/sound-commands.json';
import { PlaybackSyncProvider, useConnect } from './playbackSync.tsx';
import { usePlayerConnect, type PlayerLiveState } from './usePlayerConnect.ts';
import { SOUND_ACTIONS, soundFrame, type SoundAction } from './soundCommands.ts';
import { activeEffects, applyEffects } from './effects.ts';
import { fxChain, setFxChain } from './fxChain.ts';
import { clearStemDrop, stemDrop } from './stemDrop.ts';

/** A payload the fixture calls real, read rather than retyped. */
const sampleOf = (action: SoundAction): unknown => fixture.commands[action].sample;

/**
 * Where each command has to have landed, as the listener's own device holds
 * it - these three stores are what spell `drop`, `fx` and `fx2` into the
 * stream URL, so this is the difference between a filter that is heard and one
 * that is not.
 *
 * A `Record<SoundAction, ...>`, so a fourth sound store added to the fixture
 * cannot be added without a wire test: it stops compiling here.
 */
const LANDED: Record<SoundAction, () => unknown> = {
  stems: () => stemDrop().gains,
  effects: () => [...activeEffects()],
  // Without `key`, which is this device's own list identity and never travels.
  chain: () => fxChain().nodes.map(({ t, on, params }) => ({ t, on, params })),
};

/**
 * The hub's socket, faked at the last possible seam.
 *
 * `ConnectSocket` is otherwise the real one - the same JSON.parse, the same
 * "am I still the current socket" guards, the same handler wiring - because
 * the point here is that a frame the hub could actually send arrives where the
 * client actually reads it.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** The socket the provider is holding, for the test to speak through. */
  static live: FakeSocket | null = null;

  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.live = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
}

function song(id: number): Track {
  return { path: `afm://${id}`, title: `Song ${id}`, artist: 'A', album: 'B', duration: 1 } as Track;
}

/* The Player's own refs, stood up once: they are refs in the app too, and a
   fresh object per render would re-run every effect that reads one. */
const LIVE: MutableRefObject<PlayerLiveState> = {
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
const POSITION = { current: 0 };
const PLAYBACK = { current: { volumeBoost: false } } as unknown as Parameters<
  typeof usePlayerConnect
>[0]['playbackRef'];
const RESUME = createRef() as MutableRefObject<null>;

/**
 * The device that is PLAYING, wired the way the Player wires it: the provider
 * owns the socket, and `usePlayerConnect` registers the controller the hub
 * reaches through.
 */
function Deck(): null {
  usePlayerConnect({
    connect: useConnect(),
    jam: null as unknown as Parameters<typeof usePlayerConnect>[0]['jam'],
    liveRef: LIVE,
    positionRef: POSITION,
    playbackRef: PLAYBACK,
    resumeRef: RESUME,
    track: song(1),
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
  });
  return null;
}

/** Stand the device up and open its socket. */
function device(): FakeSocket {
  render(
    <PlaybackSyncProvider>
      <Deck />
    </PlaybackSyncProvider>,
  );
  const socket = FakeSocket.live;
  if (!socket) throw new Error('the provider never opened a socket');
  act(() => socket.onopen?.());
  return socket;
}

/** What the hub pushes down when a remote moves the console. */
function deliver(socket: FakeSocket, frame: unknown): void {
  act(() => {
    socket.onmessage?.({ data: JSON.stringify({ type: 'command', command: frame }) });
  });
}

describe('a sound command arriving from the hub', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.live = null;
    setFxChain([]);
    applyEffects([]);
    clearStemDrop();
  });

  for (const action of SOUND_ACTIONS) {
    it(`applies a \`${action}\` frame built from the fixture`, () => {
      const socket = device();
      const sample = sampleOf(action);

      deliver(socket, soundFrame(action, sample));

      expect(LANDED[action]()).toEqual(sample);
    });
  }

  it('reads the payload off the frame, not off some other field', () => {
    /*
     * The failure this whole file is about, stated directly: a frame whose
     * action is right and whose payload is under a name the reader does not
     * ask for changes NOTHING. That is what a rename on one side of the wire
     * produces - no error at either end, nothing in any log, and a listener
     * whose only evidence is a filter that does not do anything.
     */
    const socket = device();
    deliver(socket, { action: 'chain', filters: sampleOf('chain') });
    expect(fxChain().nodes).toEqual([]);
  });

  it('does not send the sound back where it came from', () => {
    // The playing device holds no relay, so this is belt and braces - but an
    // echo would be a loop between the two devices, and the loop would be
    // audible.
    const socket = device();
    deliver(socket, soundFrame('chain', sampleOf('chain')));
    expect(socket.sent.filter((line) => line.includes('"command"'))).toEqual([]);
  });
});
