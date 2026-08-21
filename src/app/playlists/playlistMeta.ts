/**
 * What a playlist is, beyond its name and its songs.
 *
 * A description, the folder it files under, and which of its songs lends its
 * cover. Three things Spotify has had forever and this app has never had a
 * place to put.
 *
 * IT LIVES BESIDE THE PLAYLIST, NOT INSIDE IT, and that is a deliberate choice
 * rather than a convenience. The obvious home is the playlists table on the
 * music server - but that table is `id, user_id, name, created_at, updated_at`,
 * so all three would need a migration, and the hub that would have to run it is
 * a Mac in a house rather than a box this app can deploy to. Decoration would
 * then be blocked behind somebody being home.
 *
 * The registry's prefs blob has none of that problem. It is stored without
 * being read, so a new key is a change to SYNCED_KEYS and nothing else - and
 * what it carries is already exactly this kind of thing: facts about a person
 * rather than about a machine. Adding a playlist's description there syncs it
 * to every device with no schema anywhere.
 *
 * WHAT THAT COSTS, so it is chosen rather than discovered: this decoration
 * follows the ACCOUNT, not the library. A playlist somebody else in the
 * household can see keeps its name and its songs for them and loses its
 * description, because the description was never on the server the playlist
 * lives on. If shared decoration is ever wanted, that is the migration this
 * avoided, and it should be done then rather than guessed at now.
 */

const KEY = 'attackfm-playlist-meta';

export interface PlaylistMeta {
  /** Free text, shown under the name on the playlist's own page. */
  description?: string;
  /** The folder this playlist files under. Absent means loose at the top. */
  folder?: string;
  /**
   * The track whose artwork is the playlist's cover, by path.
   *
   * A REFERENCE, never an image. The temptation is to keep a data URI here and
   * let somebody upload a photograph - but this blob syncs on every change, and
   * a handful of covers at 20KB each turns a small settings payload into a
   * megabyte that moves whenever anything is edited. A path costs 60 bytes and
   * the artwork is already on the device.
   *
   * The cost is honest and worth naming: you can choose a cover from the songs
   * in the playlist, and you cannot yet use a picture from your camera roll.
   * That needs somewhere to PUT an image, which means the server work this
   * module was built to avoid.
   */
  coverPath?: string;
}

/**
 * A key that survives two servers holding a playlist with the same id.
 *
 * Local playlists carry a UUID and remote ones carry a number from their own
 * server's table, so `7` is not one playlist - it is one per library signed
 * into. Qualifying by origin keeps two libraries' seventh playlists apart.
 */
export function metaKey(origin: string | null | undefined, id: string): string {
  return `${origin ?? 'local'}#${id}`;
}

type Store = Record<string, PlaylistMeta>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let snapshot: Store = typeof localStorage === 'undefined' ? {} : read();

function commit(next: Store): void {
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Holds for this run. The alternative - refusing the edit - is worse.
  }
  for (const l of listeners) l();
}

export function metaSnapshot(): Store {
  return snapshot;
}

export function subscribeMeta(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * ONE object for "this playlist has no decoration", shared by every caller.
 *
 * Not a micro-optimisation - the absence of it crashed the playlist page. This
 * is read through useSyncExternalStore, which compares snapshots BY IDENTITY to
 * decide whether anything changed. Returning a fresh `{}` each call means the
 * snapshot never equals the last one, so React re-renders, reads again, gets
 * another new object, and loops until it gives up. And it fired on the common
 * case: a playlist nobody has described yet, which is all of them at first.
 *
 * Frozen so a caller cannot write into the shared empty and give every
 * undecorated playlist the same description.
 */
const NONE: PlaylistMeta = Object.freeze({});

export function metaFor(key: string): PlaylistMeta {
  return snapshot[key] ?? NONE;
}

/**
 * Change one field of one playlist's decoration.
 *
 * Empty is DELETION rather than an empty string. A description cleared back to
 * nothing should leave no trace - otherwise the blob accumulates a key per
 * playlist anyone ever opened the editor on, and a synced payload grows without
 * anything being added to it.
 */
export function setMeta(key: string, patch: Partial<PlaylistMeta>): void {
  const current = snapshot[key] ?? {};
  const next: PlaylistMeta = { ...current };
  for (const [k, v] of Object.entries(patch) as [keyof PlaylistMeta, string | undefined][]) {
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
  }
  const store = { ...snapshot };
  if (Object.keys(next).length === 0) delete store[key];
  else store[key] = next;
  commit(store);
}

/** Forget a playlist's decoration, for when the playlist itself is deleted. */
export function forgetMeta(key: string): void {
  if (!(key in snapshot)) return;
  const store = { ...snapshot };
  delete store[key];
  commit(store);
}

/** Every folder in use, in the order a person would expect to read them. */
export function foldersInUse(): string[] {
  const seen = new Set<string>();
  for (const m of Object.values(snapshot)) if (m.folder) seen.add(m.folder);
  return [...seen].sort((a, b) => a.localeCompare(b));
}
