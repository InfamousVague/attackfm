import { REGISTRY_SESSION_KEY } from './registryKeys.ts';

/**
 * Where you were, so another device can pick it up.
 *
 * The durable half of what Connect does live. Connect hands a song between two
 * devices that are both awake and both listening; this answers the question
 * that survives everything being closed - "what was I in the middle of?" - so a
 * phone opened on the bus lands where the desktop left off last night.
 *
 * Kept apart from the settings sync on purpose. Settings are MERGED when two
 * devices disagree, because both can hold a real answer. A position cannot: two
 * devices cannot both be the last thing you listened on, so most-recent simply
 * wins and a merge would be inventing a conflict. It also changes every few
 * seconds, and folding that into the settings blob would bump its revision
 * constantly and turn every genuine settings edit into a collision.
 */

const REGISTRY = 'https://registry.attack.fm';

/** How often a position may be sent while a song plays. */
const THROTTLE_MS = 20_000;

/** Below this, there is nothing worth returning to - it is the start. */
const MIN_POSITION = 20;

export interface ResumePoint {
  /** The track's key, origin and all, so any server's track can be named. */
  path: string;
  /** Seconds in. */
  position: number;
  /** For showing the offer without loading a library first. */
  title: string;
  artist: string;
}

function registryUrl(): string {
  return (
    (import.meta.env?.VITE_REGISTRY_URL as string | undefined)?.replace(/\/+$/, '') || REGISTRY
  );
}

function token(): string | null {
  try {
    const raw = localStorage.getItem(REGISTRY_SESSION_KEY);
    const parsed = raw ? (JSON.parse(raw) as { token?: string }) : null;
    return parsed?.token ?? null;
  } catch {
    return null;
  }
}

let lastSentAt = 0;
let lastPath = '';

/**
 * Record where you are, at most every THROTTLE_MS.
 *
 * A track CHANGE always sends immediately, throttle or not: that is the moment
 * the answer to "what was I listening to" actually changed, and losing it means
 * another device offers the song before last.
 */
export async function recordResume(point: ResumePoint, force = false): Promise<void> {
  const auth = token();
  if (!auth) return;
  if (point.position < MIN_POSITION && !force) return;

  const now = Date.now();
  const changedTrack = point.path !== lastPath;
  if (!force && !changedTrack && now - lastSentAt < THROTTLE_MS) return;
  lastSentAt = now;
  lastPath = point.path;

  try {
    await fetch(`${registryUrl()}/v1/resume`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: point }),
      // Survives the page going away mid-flight, which is exactly when the most
      // valuable write happens - closing the app IS the end of a listening
      // session, and a normal fetch would be cancelled by the navigation.
      keepalive: true,
    });
  } catch {
    // Nothing here is worth interrupting playback for.
  }
}

/** What the account was last listening to, or null. */
export async function fetchResume(signal?: AbortSignal): Promise<ResumePoint | null> {
  const auth = token();
  if (!auth) return null;
  try {
    const response = await fetch(`${registryUrl()}/v1/resume`, {
      headers: { Authorization: `Bearer ${auth}` },
      signal,
    });
    if (!response.ok) return null;
    const { body } = (await response.json()) as { body: ResumePoint | null };
    if (!body || typeof body.path !== 'string') return null;
    return body;
  } catch {
    return null;
  }
}
