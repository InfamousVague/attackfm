/**
 * The webview's half of the CarPlay seam.
 *
 * The native half (src-tauri/gen/apple/Sources/app/carplay.m) owns the car
 * screen and the system now-playing center; this half feeds it and obeys it.
 * Two pushes go out - the library after each sync, the now-playing state on
 * each discontinuity - and two event streams come back: `carplay:play` (a
 * song tapped on the car screen) and `carplay:remote` (transport commands
 * from the car, the lock screen, or the Control Center tile, which all share
 * the native command center).
 *
 * Everything degrades to a no-op off Tauri, and the commands themselves
 * no-op off iOS, so callers push unconditionally.
 */

import { isTauri, type Track } from './tauri.ts';
import { isRemotePath, trackIdFromPath } from './server.ts';

/** What the native list templates need to draw and act on one row. */
interface CarPlayTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  trackNo: number;
  artUrl: string;
  duration: number;
}

function compact(track: Track): CarPlayTrack | null {
  if (!isRemotePath(track.path)) return null;
  const id = trackIdFromPath(track.path);
  if (id === null) return null;
  return {
    id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    trackNo: track.trackNo ?? 0,
    // Remote artwork is already an absolute, token-carrying URL the native
    // side can fetch with a bare NSURLSession.
    artUrl: track.artwork?.startsWith('http') ? track.artwork : '',
    duration: track.duration ?? 0,
  };
}

async function invoke(command: string, payload: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const core = await import('@tauri-apps/api/core');
    await core.invoke(command, { payload });
  } catch {
    // A build without the command (an old binary) is a car screen that does
    // not update, not an error worth surfacing.
  }
}

/** Pushes the synced library to the car screen. Local-source tracks have no
 * server ids and cannot be addressed from the car, so they are filtered out -
 * on iOS the library is always the server's anyway. `liked` is the server's
 * favourite ids, newest first, exactly as the remote library holds them. */
export async function pushCarPlayLibrary(tracks: Track[], liked: number[]): Promise<void> {
  const rows = tracks.map(compact).filter((t): t is CarPlayTrack => t !== null);
  if (rows.length === 0 && tracks.length > 0) return;
  await invoke('carplay_set_library', JSON.stringify({ tracks: rows, liked }));
}

/** What the Now Playing screen shows. Pushed on discontinuities only; iOS
 * extrapolates the clock from position + playing on its own. */
export interface CarPlayNowPlaying {
  title: string;
  artist: string;
  album: string;
  artUrl: string;
  duration: number;
  position: number;
  playing: boolean;
}

export async function pushCarPlayNowPlaying(state: CarPlayNowPlaying): Promise<void> {
  await invoke('carplay_now_playing', JSON.stringify(state));
}

/** Parks the phone's auto-lock while the full-screen player is up - the
 * Spotify behavior. The webview draws its own dim veil; this only keeps the
 * OS lock away. No-op off Tauri, and off iOS inside the binary. */
export async function setIdleTimerDisabled(disabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const core = await import('@tauri-apps/api/core');
    await core.invoke('set_idle_timer_disabled', { disabled });
  } catch {
    // An old binary without the command: the screen locks as it always did.
  }
}

type Unlisten = () => void;

async function listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  try {
    const events = await import('@tauri-apps/api/event');
    return await events.listen(event, (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}

/** A song tapped on the car screen. `context` names the list it came from
 * ("liked", "songs", "artist:<name>"), which decides the queue. */
export function onCarPlayPlay(
  handler: (trackId: number, context: string) => void,
): Promise<Unlisten> {
  return listen('carplay:play', (payload) => {
    const p = payload as { trackId?: unknown; context?: unknown };
    if (typeof p?.trackId !== 'number') return;
    handler(p.trackId, typeof p.context === 'string' ? p.context : '');
  });
}

/** A transport command: play, pause, toggle, next, previous, or seek:<s>. */
export function onCarPlayRemote(handler: (command: string) => void): Promise<Unlisten> {
  return listen('carplay:remote', (payload) => {
    const p = payload as { command?: unknown };
    if (typeof p?.command === 'string') handler(p.command);
  });
}
