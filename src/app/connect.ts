/**
 * The client half of AttackFM Connect (playbackSync.tsx is the React layer).
 *
 * This module is the wire: the device's own identity, the message shapes shared
 * with the server's connect.rs, and a small reconnecting WebSocket that speaks
 * them. It knows nothing about React or about audio - it opens a socket, sends
 * what it is told, and hands every server message to one callback.
 */

import { isDesktopApp, isIOS, isMobile } from './platform.ts';
import { isTauri } from './tauri.ts';
import type { ServerSession } from './server.ts';

const DEVICE_ID_KEY = 'attackfm-device-id';
const DEVICE_NAME_KEY = 'attackfm-device-name';

/** A device on the account, as the hub reports it. */
export interface ConnectDevice {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  lastSeen: number;
}

/** The authoritative now-playing, shared across devices. Positions are true as
 * of `updatedAt`; a remote extrapolates from there while `playing`. */
export interface ConnectSession {
  activeDeviceId: string | null;
  trackId: number | null;
  positionMs: number;
  playing: boolean;
  shuffle: boolean;
  repeat: string;
  volume: number;
  queue: number[];
  queueIndex: number;
  updatedAt: number;
  epoch: number;
}

/** A transport command a remote asks the active device to perform. */
export interface ConnectCommand {
  action: 'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'seek' | 'volume' | 'setQueue';
  positionMs?: number;
  volume?: number;
  queue?: number[];
  index?: number;
}

/** What this device tells the hub about its playback (the active device only). */
export interface ReportedState {
  trackId: number | null;
  positionMs: number;
  playing: boolean;
  shuffle: boolean;
  repeat: string;
  volume: number;
  queue: number[];
  queueIndex: number;
}

/** Everything the server pushes down, as a discriminated union. */
export type ServerMessage =
  | { type: 'devices'; devices: ConnectDevice[]; activeDeviceId: string | null }
  | { type: 'state'; state: ConnectSession }
  | { type: 'command'; command: ConnectCommand }
  | { type: 'becomeActive'; state: ConnectSession }
  | { type: 'release' }
  | { type: 'pong' };

/** A stable per-install id. Minted once and kept, so a device keeps its
 * identity (and its place in the picker) across launches and reconnects. */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // Storage unavailable - a per-session id still works, it just will not
    // survive a reload.
    return `eph-${Math.random().toString(36).slice(2)}`;
  }
}

export function deviceKind(): string {
  if (isDesktopApp) return 'desktop';
  // A phone is a phone whether the app or the browser is running it - the
  // handset is what the picker is naming, not the shell around the page.
  if (isMobile || isIOS) return 'phone';
  return 'web';
}

/** The machine, as the user would name it: the OS, not the engine. */
function platformName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (isIOS) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux|X11/i.test(ua)) return 'Linux PC';
  return 'Device';
}

/** Which browser is running the page, for the tab's half of the name. */
function browserName(): string | null {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  // Order matters: the impostors all carry the names they impersonate. Edge
  // and Opera say "Chrome", and Chrome says "Safari".
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return null;
}

/**
 * The name shown in the picker. User-renamable; otherwise derived.
 *
 * Two clients on one machine - the app and a browser tab - are two devices to
 * the hub, and rightly so: either can hold playback. So the default name says
 * WHICH client on WHICH machine ("Safari on Mac", not "This browser"), or the
 * bare machine when this IS the app. A picker listing "iPhone" beside "Safari
 * on iPhone" reads as what it is; one listing "iPhone" beside "This browser"
 * reads as one device shown twice.
 */
export function deviceName(): string {
  try {
    const saved = localStorage.getItem(DEVICE_NAME_KEY);
    if (saved) return saved;
  } catch {
    // fall through to the default
  }
  const platform = platformName();
  // The app speaks for the machine itself, so it wears the machine's name.
  if (isTauri()) return platform;
  const browser = browserName();
  return browser ? `${browser} on ${platform}` : `Browser on ${platform}`;
}

export function setDeviceName(name: string): void {
  try {
    const trimmed = name.trim();
    // Clearing the field is a reset: removing the key lets deviceName() fall
    // through to the derived platform default again. (Re-saving deviceName()
    // here would read the OLD custom name back and make the default
    // unreachable forever.)
    if (trimmed) localStorage.setItem(DEVICE_NAME_KEY, trimmed);
    else localStorage.removeItem(DEVICE_NAME_KEY);
  } catch {
    // Non-fatal: the name just will not persist.
  }
}

/** The wss:// URL for this session's Connect socket. */
function socketUrl(session: ServerSession): string {
  const base = session.url.replace(/^http/i, 'ws');
  return `${base}/api/connect?t=${encodeURIComponent(session.streamToken)}`;
}

/**
 * A reconnecting Connect socket. Construct it with a session and a message
 * handler; it dials, re-sends `hello` on every (re)open, and reconnects with
 * capped backoff until `close()`. `send*` methods no-op while the socket is
 * down - a command sent mid-reconnect is simply dropped, which for transport
 * is the right call (the state resyncs on reopen).
 */
export class ConnectSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 1000;
  private reconnectTimer: number | null = null;

  constructor(
    private readonly session: ServerSession,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onOpenChange?: (open: boolean) => void,
  ) {
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl(this.session));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.onOpenChange?.(true);
      this.hello();
    };
    ws.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        // A frame we cannot parse is not worth tearing the socket down over.
      }
    };
    ws.onclose = () => {
      this.onOpenChange?.(false);
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and drives the reconnect; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15000);
  }

  private raw(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private hello(): void {
    this.raw({ type: 'hello', id: deviceId(), name: deviceName(), kind: deviceKind() });
  }

  /** Re-introduces this device - after a rename, so the hub (and every other
   * device's picker) shows the new name without waiting for a reconnect. */
  announce(): void {
    this.hello();
  }

  reportState(state: ReportedState): void {
    this.raw({ type: 'state', ...state });
  }

  command(command: ConnectCommand): void {
    this.raw({ type: 'command', command });
  }

  transfer(target: string): void {
    this.raw({ type: 'transfer', target });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
