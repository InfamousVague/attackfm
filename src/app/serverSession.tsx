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
import {
  artUrl,
  isRemotePath,
  login as serverLogin,
  logout as serverLogout,
  normalizeServerUrl,
  refreshStreamToken,
  streamUrl,
  trackIdFromPath,
  transcodeUrl,
  type ServerSession,
} from './server.ts';
import { setRemoteAudioResolver } from './tauri.ts';

const SESSION_KEY = 'attackfm-server-session';
const QUALITY_KEY = 'attackfm-server-quality';

/**
 * How the listener wants their music delivered.
 *
 * `lossless` is a direct byte-range read of the original file - no server CPU
 * beyond a file read, and bit-identical to what is on the disk. `transcode`
 * re-encodes to AAC on the fly, for a metered connection that would rather
 * spend 256 kbps than 900. The choice is per-device, not per-account: the
 * desktop on a home network and the phone on a train want different answers.
 */
export type StreamQuality = 'lossless' | 'transcode';

export interface ServerSettings {
  quality: StreamQuality;
  /** Target bitrate for the transcode path, kbps. */
  bitrate: number;
}

const DEFAULT_SETTINGS: ServerSettings = { quality: 'lossless', bitrate: 256 };

interface ServerSessionValue {
  /** The connected server, or null when the app is on its local library. */
  session: ServerSession | null;
  /** True while a stored session is being restored at launch. */
  restoring: boolean;
  settings: ServerSettings;
  updateSettings: (next: Partial<ServerSettings>) => void;
  connect: (url: string, username: string, password: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Re-mints the stream token, e.g. after media URLs start returning 401. */
  renew: () => Promise<void>;
}

const ServerSessionContext = createContext<ServerSessionValue | null>(null);

function readSession(): ServerSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ServerSession>;
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.streamToken !== 'string'
    ) {
      return null;
    }
    return {
      url: parsed.url,
      token: parsed.token,
      streamToken: parsed.streamToken,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      isAdmin: parsed.isAdmin === true,
    };
  } catch {
    return null;
  }
}

function readSettings(): ServerSettings {
  try {
    const raw = localStorage.getItem(QUALITY_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ServerSettings>;
    return {
      quality: parsed.quality === 'transcode' ? 'transcode' : 'lossless',
      bitrate:
        typeof parsed.bitrate === 'number' && Number.isFinite(parsed.bitrate)
          ? Math.min(512, Math.max(64, Math.round(parsed.bitrate)))
          : DEFAULT_SETTINGS.bitrate,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Owns the connection to a streaming server: the credentials, the delivery
 * choice, and - the load-bearing part - the resolver that turns an `afm://`
 * track path into a URL a media element can fetch.
 *
 * Sits above the library provider, because which library the app is showing is
 * downstream of whether a server is connected.
 */
export function ServerSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ServerSession | null>(readSession);
  const [restoring, setRestoring] = useState(true);
  const [settings, setSettings] = useState<ServerSettings>(readSettings);

  // The resolver is rebuilt whenever the session or the quality choice changes,
  // and read through a ref so the function handed to `setRemoteAudioResolver`
  // stays stable while still seeing current state.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    setRemoteAudioResolver((path) => {
      const live = sessionRef.current;
      if (!live || !isRemotePath(path)) return null;
      const id = trackIdFromPath(path);
      if (id === null) return null;
      const { quality, bitrate } = settingsRef.current;
      // The transcode path deliberately starts from zero: it is a live encode,
      // so there is no range to resume into. Seeking on it is a fresh request,
      // which the player performs by reloading the source.
      return quality === 'transcode'
        ? transcodeUrl(live, id, bitrate)
        : streamUrl(live, id);
    });
    return () => setRemoteAudioResolver(null);
  }, []);

  // A stored session is trusted enough to render from at once, but its stream
  // token may have aged out while the app was closed - so one renewal is
  // attempted on launch. A failure here is not a sign-out: the box may simply
  // be unreachable from wherever the phone woke up, and the cached library is
  // still worth showing.
  useEffect(() => {
    const stored = readSession();
    if (!stored) {
      setRestoring(false);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const streamToken = await refreshStreamToken(stored);
        if (!live) return;
        const renewed = { ...stored, streamToken };
        setSession(renewed);
        localStorage.setItem(SESSION_KEY, JSON.stringify(renewed));
      } catch {
        // Offline, or the session is genuinely dead. Either way the stored
        // credentials stay put; the next deliberate action will find out which.
      } finally {
        if (live) setRestoring(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const persist = useCallback((next: ServerSession | null) => {
    setSession(next);
    try {
      if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      // The session still applies for this run; it just will not survive a
      // relaunch.
    }
  }, []);

  const connect = useCallback(
    async (url: string, username: string, password: string) => {
      const origin = normalizeServerUrl(url);
      if (!origin) throw new Error('Enter the server address');
      const next = await serverLogin(origin, username, password);
      persist(next);
    },
    [persist],
  );

  const disconnect = useCallback(async () => {
    const live = sessionRef.current;
    persist(null);
    if (live) await serverLogout(live);
  }, [persist]);

  const renew = useCallback(async () => {
    const live = sessionRef.current;
    if (!live) return;
    const streamToken = await refreshStreamToken(live);
    persist({ ...live, streamToken });
  }, [persist]);

  const updateSettings = useCallback((next: Partial<ServerSettings>) => {
    setSettings((prev) => {
      const merged = { ...prev, ...next };
      try {
        localStorage.setItem(QUALITY_KEY, JSON.stringify(merged));
      } catch {
        // Applies for this session regardless.
      }
      return merged;
    });
  }, []);

  const value = useMemo<ServerSessionValue>(
    () => ({ session, restoring, settings, updateSettings, connect, disconnect, renew }),
    [session, restoring, settings, updateSettings, connect, disconnect, renew],
  );

  return (
    <ServerSessionContext.Provider value={value}>{children}</ServerSessionContext.Provider>
  );
}

export function useServerSession(): ServerSessionValue {
  const value = useContext(ServerSessionContext);
  if (!value) throw new Error('useServerSession must be used within a ServerSessionProvider');
  return value;
}

/** The cover-art URL for a server track, for surfaces building their own. */
export function remoteArtUrl(session: ServerSession, artId: string): string {
  return artUrl(session, artId);
}
