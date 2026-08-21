import { useEffect } from 'react';
import { REGISTRY_SESSION_KEY } from './registryKeys.ts';

/**
 * The signed-in identity, read straight from storage.
 *
 * Not the React hook: this runs from a storage listener and from app start,
 * outside any component, and the provider's value is not reachable there.
 * Reading the same key the provider persists keeps one source of truth.
 */
function readSession(): { token?: string } | null {
  try {
    const raw = localStorage.getItem(REGISTRY_SESSION_KEY);
    return raw ? (JSON.parse(raw) as { token?: string }) : null;
  } catch {
    return null;
  }
}

/**
 * Settings that follow the account instead of the device.
 *
 * Everything the app remembers has lived in localStorage, which is per-device
 * by definition: a new phone, or the player at attack.fm/listen, starts blank,
 * and someone with three devices maintains three different-looking apps by
 * hand. These are not device facts - what the app looks like, which plugins you
 * run, which servers you are on - they are facts about a person, so they belong
 * with the identity that is already central.
 *
 * WHAT IS NOT HERE, and why: anything genuinely local. The device cache budget,
 * which songs are pinned for offline, the current audio output - those describe
 * a machine, and syncing them would make one device's storage decision another
 * device's problem.
 *
 * The registry stores the blob without reading it, so adding a synced key is a
 * change to SYNCED_KEYS and nothing else.
 */

/** localStorage keys whose value belongs to the person, not the device. */
export const SYNCED_KEYS = [
  // Look and feel.
  'attackfm-appearance-v2',
  'attackfm-plugins-disabled',
  // Sound. NOTE: the fx chain is rendered per-server and servers implement
  // different node vocabularies, so a chain can arrive somewhere that cannot
  // play all of it. That is survivable - the UI already greys what the server
  // cannot render - and losing your pedalboard when you pick up another device
  // is worse than a filter that says it needs a newer server.
  'attackfm-fxchain-v1',
  'attackfm-eq',
  // Servers and identity: which libraries you belong to, and their order.
  'attackfm-known-servers',
  // The rest of the person-level settings. Each of these answers "how do I like
  // my music", never "what is this machine".
  'attackfm-playback',        // crossfade, shuffle manners, what a pause means
  'attackfm-effects',         // the named effects rack
  'attackfm-loudness-mode',   // how levels are evened out
  'attackfm-haptics',         // a taste, on the devices that have them
  'attackfm-art-view',        // how artwork is shown
  'attackfm-online-metadata', // whether to look things up on the internet
  'attackfm-share-listening', // a privacy choice, and the one most worth carrying
  'attackfm-search-recents',  // what you have been looking for
  // What a playlist IS beyond its songs - its description, its folder, the song
  // whose art it borrows. Decoration follows the person for the same reason the
  // rest of this list does; see playlists/playlistMeta.ts for why it is not on
  // the music server with the playlist itself.
  'attackfm-playlist-meta',
] as const;

/**
 * Deliberately NOT synced, with the reason, because the temptation is to add
 * everything and each of these would be a bug:
 *
 * - `attackfm-server-quality`: lossless or transcoded is a NETWORK decision. A
 *   phone on cellular and a desktop on ethernet want different answers, and
 *   syncing it means one of them is always wrong.
 * - `attackfm-cache-limit`, `attackfm-autocache*`, `attackfm-cache-deny`: how
 *   much of a particular disk to spend. One device's storage decision must not
 *   become another's.
 * - `attackfm-cache-quality`: same reason, and more sharply. It answers "what
 *   should this device's disk be spent on", and a laptop with a terabyte has no
 *   business inheriting the answer a phone gave. Absence from SYNCED_KEYS is the
 *   whole mechanism - there is nothing to switch off.
 * - `attackfm-device-id`, `attackfm-device-name`: the things that tell devices
 *   APART. Syncing them would merge every device into one.
 * - `attackfm-server-session`, `attackfm-registry-session`: credentials.
 * - `attackfm-music-dir`, `attackfm-mirror-*`: paths and network topology that
 *   only mean anything on the machine that wrote them.
 * - art, canvas and warm caches: derived data, larger than the settings and
 *   rebuildable from nothing.
 */

const REV_KEY = 'attackfm-prefs-rev';
const REGISTRY = 'https://registry.attack.fm';

interface Remote {
  rev: number;
  body: Record<string, string> | null;
}

function registryUrl(): string {
  return (
    (import.meta.env?.VITE_REGISTRY_URL as string | undefined)?.replace(/\/+$/, '') || REGISTRY
  );
}

/** Everything worth syncing, as it stands on this device right now. */
function localSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SYNCED_KEYS) {
    const value = localStorage.getItem(key);
    if (value != null) out[key] = value;
  }
  return out;
}

function readRev(): number {
  const raw = Number(localStorage.getItem(REV_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Adopt remote values, then tell the app the world changed.
 *
 * Storage events do not fire in the tab that performed the write, so a plain
 * setItem would update localStorage and leave every hook in this tab showing
 * the old value until a reload. The app's stores already listen for `storage`
 * to stay in step across tabs, so dispatching one is how a sync becomes visible
 * without a special case in each of them.
 */
function adopt(body: Record<string, string>): boolean {
  let changed = false;
  for (const key of SYNCED_KEYS) {
    const incoming = body[key];
    const current = localStorage.getItem(key);
    if (incoming == null || incoming === current) continue;
    localStorage.setItem(key, incoming);
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue: incoming, oldValue: current }),
    );
    changed = true;
  }
  return changed;
}

async function fetchRemote(token: string, signal?: AbortSignal): Promise<Remote | null> {
  const response = await fetch(`${registryUrl()}/v1/prefs`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) return null;
  return (await response.json()) as Remote;
}

/**
 * Push, merging on top of whatever is there rather than replacing it.
 *
 * A device only ever knows about the keys IT syncs. Replacing the whole object
 * would mean an older build - one that predates a newly synced key - deleting
 * that key for every other device the moment it saved anything.
 */
async function push(token: string, rev: number, body: Record<string, string>): Promise<number | null> {
  const response = await fetch(`${registryUrl()}/v1/prefs`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rev, body }),
  });
  if (response.ok) {
    const { rev: next } = (await response.json()) as { rev: number };
    return next;
  }
  // 409: someone else wrote first. The response carries the winning state, so
  // merge onto it and try once more rather than clobbering their work.
  if (response.status === 409) {
    const winner = (await response.json().catch(() => null)) as Remote | null;
    if (winner) {
      adopt(winner.body ?? {});
      const merged = { ...(winner.body ?? {}), ...body };
      const retry = await fetch(`${registryUrl()}/v1/prefs`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rev: winner.rev, body: merged }),
      });
      if (retry.ok) {
        const { rev: next } = (await retry.json()) as { rev: number };
        return next;
      }
    }
  }
  return null;
}

/**
 * Bring this device and the account into agreement.
 *
 * First sync on a fresh device pulls; after that this device's values win for
 * the keys it changed, because it is the one being used. Returns true when
 * anything on this device changed, so a caller can decide whether to re-render.
 */
export async function syncPrefs(signal?: AbortSignal): Promise<boolean> {
  const session = readSession();
  if (!session?.token) return false;

  const remote = await fetchRemote(session.token, signal).catch(() => null);
  if (!remote) return false;

  // Never synced: this device is the first word on the subject.
  if (remote.body == null) {
    const rev = await push(session.token, 0, localSnapshot());
    if (rev) localStorage.setItem(REV_KEY, String(rev));
    return false;
  }

  const changed = adopt(remote.body);
  localStorage.setItem(REV_KEY, String(remote.rev));

  // Anything this device holds that the account does not know about yet - a key
  // this build syncs and the last device did not, or a setting changed offline.
  const local = localSnapshot();
  const missing = Object.keys(local).some((k) => local[k] !== remote.body?.[k]);
  if (missing) {
    const rev = await push(session.token, remote.rev, { ...remote.body, ...local });
    if (rev) localStorage.setItem(REV_KEY, String(rev));
  }
  return changed;
}

/**
 * Save this device's settings up, after something changed here.
 *
 * Debounced by the caller: this is called from a storage listener, and dragging
 * a slider writes on every frame.
 */
export async function pushPrefs(): Promise<void> {
  const session = readSession();
  if (!session?.token) return;
  const rev = await push(session.token, readRev(), localSnapshot());
  if (rev) localStorage.setItem(REV_KEY, String(rev));
}

/** Forget the sync marker, so the next sign-in pulls fresh rather than pushing. */
export function forgetPrefsRevision(): void {
  localStorage.removeItem(REV_KEY);
}

/**
 * Keep this device and the account in step for as long as the app is open.
 *
 * Mounted once, beside the identity it belongs to.
 *
 * Local changes are noticed by POLLING a signature of the synced keys, which
 * deserves its defence: `storage` events do not fire in the tab that made the
 * write, so the obvious listener would never see this device's own edits. The
 * alternatives are worse - monkey-patching localStorage.setItem, or making
 * every settings module in the app remember to call a sync function, which is a
 * rule that gets forgotten the first time someone adds a setting. Reading five
 * localStorage keys every few seconds costs nothing measurable and cannot be
 * forgotten.
 */
export function usePrefsSync(token: string | undefined): void {
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void syncPrefs(controller.signal);

    let last = JSON.stringify(localSnapshot());
    let timer: number | undefined;

    const tick = () => {
      const now = JSON.stringify(localSnapshot());
      if (now === last) return;
      last = now;
      // Coalesce: dragging a slider writes on every frame, and each write would
      // otherwise be its own round trip and its own revision bump.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void pushPrefs(), 1200);
    };

    const poll = window.setInterval(tick, 3000);
    // Another tab's write DOES arrive as an event, and is worth adopting at once
    // rather than at the next poll.
    const onStorage = (e: StorageEvent) => {
      if (e.key && (SYNCED_KEYS as readonly string[]).includes(e.key)) {
        last = JSON.stringify(localSnapshot());
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      controller.abort();
      window.clearInterval(poll);
      window.clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, [token]);
}
