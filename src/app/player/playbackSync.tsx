import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { refreshSpeakers, setSpeakerHub } from './speakers.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  ConnectSocket,
  deviceId,
  setDeviceName,
  type ConnectCommand,
  type ConnectDevice,
  type ConnectSession,
  type ReportedState,
  type ServerMessage,
} from './connect.ts';

/**
 * The React layer over the Connect socket (connect.ts is the wire).
 *
 * It owns the one socket for the signed-in session, keeps the device list and
 * the shared playback session in state for any UI to read, and bridges the two
 * directions the Player cares about:
 *
 * - OUT: `reportState` (this device is active and just changed), `command` (a
 *   remote press to route to whoever is active), `transfer` (move playback).
 * - IN: the Player registers a PlaybackController; the provider drives it when
 *   the hub sends a targeted `command`, a `becomeActive`, or a `release`.
 *
 * The controller is held in a ref, not context state, so incoming transport
 * never re-renders the tree - it reaches straight into the running player.
 */

/** What the Player exposes so the hub can drive it. */
export interface PlaybackController {
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  seek(ms: number): void;
  setVolume(volume: number): void;
  /** A remote picked a new track/queue for the active device to play. */
  setQueue(trackIds: number[], index: number): void;
  /** Become the active device: load the session's track at its position. */
  becomeActive(state: ConnectSession): void;
  /** Stop playing here - another device took over. */
  release(): void;
}

interface PlaybackSyncValue {
  /** Null until the socket has said hello and heard back. */
  connected: boolean;
  thisDeviceId: string;
  devices: ConnectDevice[];
  activeDeviceId: string | null;
  /** True when THIS device owns audio (or no device does - we play locally). */
  isActiveHere: boolean;
  /**
   * True when ANOTHER device holds the seat: this one mirrors it and its
   * transport sends commands instead of driving audio.
   *
   * The one definition. There were three - Player derived it from
   * `activeDeviceId`, PlayerHost from `session.activeDeviceId`, and the pick
   * router from `activeDeviceId` AND `connected` - which is how the same
   * phone could believe it was a remote for the purpose of drawing the strip
   * and a local player for the purpose of playing a song. Not the same as
   * `!isActiveHere`, which is also true before any device has claimed the
   * seat; that case is LOCAL, and getting it wrong in either direction is
   * either a silent app or two devices playing at once.
   */
  activeElsewhere: boolean;
  /** The shared now-playing, for remote-control rendering. */
  session: ConnectSession | null;
  /** Hand playback to a device (its id). */
  transfer: (deviceId: string) => void;
  /** Route a transport command to the active device. */
  sendCommand: (command: ConnectCommand) => void;
  /** The active device publishes its state on every discontinuity. */
  reportState: (state: ReportedState) => void;
  /** The Player registers its executor once, on mount. */
  registerController: (controller: PlaybackController | null) => void;
  /** Renames this device and re-announces it, so every picker updates live. */
  renameDevice: (name: string) => void;
}

const PlaybackSyncContext = createContext<PlaybackSyncValue | null>(null);

/**
 * Present only when signed into a server - Connect is a hub feature. Off a
 * server it renders an inert provider so `useConnect` is always safe to call;
 * `connected` stays false and every method is a no-op, so the Player just runs
 * as a lone local device.
 */
export function PlaybackSyncProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();

  // Speakers on the hub's network are driven through the hub, so the module
  // that talks to them needs to know which hub and with what. Here because
  // this provider already holds the session and already owns "where can the
  // sound go" for this device. See player/speakers.ts.
  useEffect(() => {
    setSpeakerHub(session ? { url: session.url, token: session.token } : null);
    // Warmed here rather than when the panel opens: the hub answers from a
    // cache it refreshes itself, so this is one cheap request per session -
    // and it means the speakers are already in the list the first time
    // somebody opens the picker, instead of appearing a second later under
    // their thumb.
    if (session) void refreshSpeakers();
  }, [session?.url, session?.token]);
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<ConnectDevice[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [shared, setShared] = useState<ConnectSession | null>(null);

  const socketRef = useRef<ConnectSocket | null>(null);
  const controllerRef = useRef<PlaybackController | null>(null);
  const me = deviceId();

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'devices':
        setDevices(msg.devices);
        setActiveDeviceId(msg.activeDeviceId);
        break;
      case 'state':
        // The skew stamp: this device's clock minus the hub's, measured on
        // arrival. Remotes extrapolate the position from updatedAt, which is
        // hub-clock - subtracting a phone clock from it made the position
        // drift by the skew, or freeze when the clamp caught a negative.
        setShared(
          typeof msg.now === 'number'
            ? { ...msg.state, clockSkewMs: Date.now() - msg.now }
            : msg.state,
        );
        setActiveDeviceId(msg.state.activeDeviceId);
        break;
      case 'command': {
        const c = controllerRef.current;
        if (!c) break;
        switch (msg.command.action) {
          case 'play':
            c.play();
            break;
          case 'pause':
            c.pause();
            break;
          case 'toggle':
            c.toggle();
            break;
          case 'next':
            c.next();
            break;
          case 'prev':
            c.prev();
            break;
          case 'seek':
            if (typeof msg.command.positionMs === 'number') c.seek(msg.command.positionMs);
            break;
          case 'volume':
            if (typeof msg.command.volume === 'number') c.setVolume(msg.command.volume);
            break;
          case 'setQueue':
            if (msg.command.queue) c.setQueue(msg.command.queue, msg.command.index ?? 0);
            break;
        }
        break;
      }
      case 'becomeActive':
        setShared(msg.state);
        setActiveDeviceId(msg.state.activeDeviceId);
        controllerRef.current?.becomeActive(msg.state);
        break;
      case 'release':
        controllerRef.current?.release();
        break;
      case 'pong':
        break;
    }
  }, []);

  // One socket per session. Torn down and rebuilt when the server changes, so a
  // reconnect or a switch of servers never leaves a second socket talking.
  useEffect(() => {
    if (!session) {
      setConnected(false);
      setDevices([]);
      setActiveDeviceId(null);
      setShared(null);
      return;
    }
    const socket = new ConnectSocket(session, handleMessage, setConnected);
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [session, handleMessage]);

  const value = useMemo<PlaybackSyncValue>(
    () => ({
      connected,
      thisDeviceId: me,
      devices,
      activeDeviceId,
      // No active device means the seat is open: this device plays locally and
      // claims the seat when it reports. So "active here" is true both when we
      // hold the seat and when nobody does.
      isActiveHere: activeDeviceId === null || activeDeviceId === me,
      activeElsewhere: activeDeviceId !== null && activeDeviceId !== me,
      session: shared,
      transfer: (id: string) => socketRef.current?.transfer(id),
      sendCommand: (command: ConnectCommand) => socketRef.current?.command(command),
      reportState: (state: ReportedState) => socketRef.current?.reportState(state),
      registerController: (controller) => {
        controllerRef.current = controller;
      },
      renameDevice: (name: string) => {
        setDeviceName(name);
        socketRef.current?.announce();
      },
    }),
    [connected, me, devices, activeDeviceId, shared],
  );

  return <PlaybackSyncContext.Provider value={value}>{children}</PlaybackSyncContext.Provider>;
}

export function useConnect(): PlaybackSyncValue {
  const value = useContext(PlaybackSyncContext);
  if (!value) throw new Error('useConnect must be used within a PlaybackSyncProvider');
  return value;
}

/**
 * Connect, where there is no hub: a page that mounts the player strip
 * outside the app (the registry's playlist link page) with nothing to sync
 * to. Every reader sees "this device, alone, in charge" and every verb is a
 * no-op - so the strip's device picker and takeover hooks render their idle
 * faces rather than throwing for a provider that has nothing to provide.
 */
export function StaticConnectProvider({ children }: { children: ReactNode }) {
  const value = useMemo<PlaybackSyncValue>(
    () => ({
      connected: false,
      thisDeviceId: 'here',
      devices: [],
      activeDeviceId: null,
      isActiveHere: true,
      activeElsewhere: false,
      session: null,
      transfer: () => {},
      sendCommand: () => {},
      reportState: () => {},
      registerController: () => {},
      renameDevice: () => {},
    }),
    [],
  );
  return <PlaybackSyncContext.Provider value={value}>{children}</PlaybackSyncContext.Provider>;
}
