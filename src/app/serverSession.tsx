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
import { rememberProfile } from './household.ts';
import { rememberServer } from './servers.ts';
import { pickSource, startMirrorHeartbeat } from './mirrors.ts';
import { startServerSync } from './serverSync.ts';
import { startCacheSweeps } from './autoCache.ts';
import { checkForBundle, reclaimEmbeddedIfNewer, reportBootOk, stagedBundle } from './appUpdate.ts';
import {
  artUrl,
  isRemotePath,
  login as serverLogin,
  logout as serverLogout,
  normalizeServerUrl,
  refreshStreamToken,
  streamTokenExpiresAt,
  streamUrl,
  trackIdFromPath,
  transcodeUrl,
  type ServerSession,
} from './server.ts';
import { effectsParam } from './effects.ts';
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
  /** Adopts an already-minted session (the device-pairing / QR path), the same
   *  as a fresh sign-in but with the token pair already in hand. */
  applySession: (session: ServerSession) => void;
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
      //
      // An effect forces that path even on a fast connection, because the
      // encoder IS the effects rack - the untouched file has nowhere for a
      // filter to live. The bitrate stays whatever was chosen, so asking for
      // lofi does not quietly also cost quality.
      const fx = effectsParam();
      // Which BOX serves the bytes is a separate question from which library
      // this is. A mirror that holds the same song and answers faster from
      // wherever the phone woke up takes the fetch; everything else about the
      // session - the row id space, the playlists, the favourites - is still
      // the session server's. `pickSource` returns null when the session
      // server is already the best answer, which is the common case and the
      // one that behaves exactly as it did before mirrors existed.
      const via = pickSource(live, id);
      const from: ServerSession = via
        ? { ...live, url: via.url, streamToken: via.streamToken }
        : live;
      const rowId = via ? via.trackId : id;
      return quality === 'transcode' || fx
        ? transcodeUrl(from, rowId, bitrate, 0, fx)
        : streamUrl(from, rowId);
    });
    return () => setRemoteAudioResolver(null);
  }, []);

  // A stored session is trusted enough to render from at once, and its stream
  // token is KEPT unless it is close to aging out. Renewing eagerly here used
  // to be the app's single most expensive habit: the token rides every art
  // and stream URL's query string, so a fresh token on every launch changed
  // every URL and busted the browser's entire HTTP cache - the whole visible
  // library's covers re-downloaded each time the app opened (and repainted
  // mid-launch when the new token landed). The token lives seven days; only
  // when under two remain is it re-minted, so URLs stay byte-stable across
  // launches and `immutable` art actually gets to be immutable. A failure is
  // not a sign-out: the box may simply be unreachable from wherever the phone
  // woke up, and the cached library is still worth showing.
  useEffect(() => {
    const stored = readSession();
    if (!stored) {
      setRestoring(false);
      return;
    }
    const remaining = streamTokenExpiresAt(stored.streamToken) - Date.now();
    if (remaining > 48 * 60 * 60 * 1000) {
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

  // Mirrors are only worth timing while there is a session to compare them
  // against, and re-timed from scratch whenever that session changes.
  useEffect(() => {
    if (!session) return;
    return startMirrorHeartbeat(session);
  }, [session]);

  // And the account learns where this device listens, so the next device does
  // not have to be told again. Addresses only - see serverSync.ts.
  useEffect(() => startServerSync(session), [session]);

  // And the device quietly keeps hold of what this listener actually plays.
  useEffect(() => {
    if (!session) return;
    return startCacheSweeps(session);
  }, [session]);

  // The running frontend came up: settle the wager the boot loader staked, so
  // this version is not quarantined on the next launch. Mounted here rather
  // than at a module top level because "the app works" is the claim being
  // made, and a module body runs before React has rendered anything.
  useEffect(() => {
    reportBootOk();
    // And if a fresh install carries a NEWER frontend than the downloaded
    // bundle that just booted, hand the floor back to the binary - the one
    // case where the downloaded copy is the stale one.
    void reclaimEmbeddedIfNewer();
  }, []);

  // And ask attack.fm whether it is publishing a newer bundle. Never swapped
  // under a running app - whatever arrives is for the next launch. Updates
  // come from the central registry, not the music server, so this needs no
  // session at all: a device signed into nothing still stays current.
  //
  // Triggers, because a phone's clock barely runs: shortly after launch; every
  // couple of minutes WHILE THE APP IS ON SCREEN; and every return to the
  // foreground - the one moment a phone reliably gives an app.
  //
  // That middle trigger used to be six hours, which left a hole exactly where
  // somebody notices it: sit in the app and nothing between the 20-second
  // launch check and the next morning would ask, so a version published while
  // you were using the app went unseen until you happened to background and
  // come back. Two minutes closes it. The request is one small conditional GET
  // against a static VERSION file - cheaper than a single cover - and it stops
  // entirely once something is staged, because there is nothing further to
  // find until the app restarts.
  //
  // A hidden page never asks, so a backgrounded phone is not polling; the
  // return-to-foreground trigger is what covers that gap, debounced to twenty
  // seconds so an app-switch storm cannot turn into a request storm while
  // still answering the moment somebody comes back to look.
  //
  // Both `visibilitychange` and `focus` are listened for, because the two do
  // not agree across the platforms this runs on: an embedded WebView can be
  // brought forward without ever firing a visibility change, and `ask` is
  // idempotent, so hearing about the same return twice costs nothing.
  useEffect(() => {
    let live = true;
    let lastAsk = 0;
    const ask = () => {
      if (!live || document.hidden) return;
      // Something is already waiting for the next launch; asking again can
      // only learn the same thing.
      if (stagedBundle()) return;
      lastAsk = Date.now();
      void checkForBundle();
    };
    const first = window.setTimeout(ask, 20_000);
    const timer = window.setInterval(ask, 2 * 60 * 1000);
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastAsk < 20 * 1000) return;
      ask();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, []);

  const persist = useCallback((next: ServerSession | null) => {
    setSession(next);
    // A device that has been signed into an account remembers it, so handing
    // the phone to someone else in the house is a tap rather than a password.
    // See household.ts - the store is a convenience over this same session.
    if (next) rememberProfile(next);
    // And the SERVER is remembered separately (servers.ts): the household
    // store answers "who uses this device", this answers "where has it been" -
    // which is what lets the Profile page offer every past server as a one-tap
    // switch instead of an address to retype.
    if (next) rememberServer({ url: next.url, username: next.username, isAdmin: next.isAdmin });
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

  const applySession = useCallback((next: ServerSession) => persist(next), [persist]);

  const disconnect = useCallback(async () => {
    const live = sessionRef.current;
    persist(null);
    if (live) await serverLogout(live);
  }, [persist]);

  // Latched to once a minute: renewal is the answer to an EXPIRED token, and
  // a token minted seconds ago cannot be expired - so a wall of covers all
  // erroring at once (server down, wifi drop) collapses into one /api/me
  // instead of a stampede.
  const lastRenew = useRef(0);
  const renew = useCallback(async () => {
    const live = sessionRef.current;
    if (!live) return;
    if (Date.now() - lastRenew.current < 60_000) return;
    lastRenew.current = Date.now();
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
    () => ({ session, restoring, settings, updateSettings, connect, applySession, disconnect, renew }),
    [session, restoring, settings, updateSettings, connect, applySession, disconnect, renew],
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
