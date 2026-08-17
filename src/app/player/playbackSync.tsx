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
        setShared(msg.state);
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
