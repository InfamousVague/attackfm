/**
 * A thin, dependency-free bridge to the Tauri runtime.
 *
 * The app runs three ways: in a plain browser (dev), as a Tauri window (full
 * Rust backend), and as a static build with no backend. Every call here
 * degrades gracefully, so no page has to know which one it is in. The Tauri
 * modules are pulled in through literal dynamic imports so the bundler can
 * resolve and code-split them; each import is guarded by `isTauri()` and a
 * try/catch, so outside the webview the calls simply no-op.
 */

/** True when running inside a Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Whether the folder picker can be opened here (only under the Tauri runtime). */
export const canPickFolder = isTauri();

async function currentWindow() {
  if (!isTauri()) return null;
  try {
    const mod = await import('@tauri-apps/api/window');
    return mod?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
}

export async function minimizeWindow(): Promise<void> {
  await (await currentWindow())?.minimize().catch(() => {});
}

export async function toggleMaximizeWindow(): Promise<void> {
  await (await currentWindow())?.toggleMaximize().catch(() => {});
}

export async function closeWindow(): Promise<void> {
  await (await currentWindow())?.close().catch(() => {});
}

/**
 * Runs a Tauri event unlisten without ever surfacing an unhandled rejection,
 * and without leaking the listener it is trying to remove.
 *
 * Tauri resolves `listen()` over the IPC response channel while the script
 * that records the listener in the webview travels a separate eval queue, so
 * an unlisten issued immediately after `listen()` resolves (a StrictMode
 * ghost mount, a hot-reload remount) can run before its own registration
 * exists. The injected unregister script then throws - and, worse, throws
 * before the backend unlisten runs, leaving a zombie listener behind once the
 * registration lands. Both unlisten paths are idempotent, so the remedy is a
 * single retry after the eval queue has drained; only the retry's failure is
 * swallowed (logged in dev), because at that point the window is going away.
 */
export function safeUnlisten(unlisten: () => void | PromiseLike<void>): void {
  void (async () => {
    try {
      await unlisten();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        await unlisten();
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[tauri] unlisten failed after retry', err);
      }
    }
  })();
}

/** The subfolder AttackFM keeps its music in, under the OS audio directory. */
const LIBRARY_FOLDER = 'AttackFM';

/**
 * The default place music is stored: an AttackFM folder inside the OS audio
 * directory (~/Music on macOS). Null in the browser, where there is no
 * filesystem to name.
 */
export async function defaultMusicDir(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const path = await import('@tauri-apps/api/path');
    return await path.join(await path.audioDir(), LIBRARY_FOLDER);
  } catch {
    return null;
  }
}

/** Creates the directory (and parents) if it is not already there. */
export async function ensureDir(dir: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const fs = await import('@tauri-apps/plugin-fs');
    if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
  } catch {
    // A directory that cannot be made is reported when it is written to, not here.
  }
}

/**
 * Opens the native folder picker and returns the chosen directory, or null if
 * the user cancels or there is no runtime to ask.
 */
export async function pickMusicDir(current?: string | null): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const dialog = await import('@tauri-apps/plugin-dialog');
    const selected = await dialog.open({
      directory: true,
      multiple: false,
      defaultPath: current ?? undefined,
      title: 'Choose where AttackFM stores music',
    });
    return typeof selected === 'string' ? selected : null;
  } catch {
    return null;
  }
}

/** A single playable track, assembled from a file and its embedded tags. */
export interface Track {
  /**
   * The stable row id. For a local file that is its absolute path; for a track
   * on a server it is an `afm://<id>` URI. Everything downstream treats it as
   * an opaque key, which is what lets one library type serve both - only
   * `loadAudioUrl` has to know the difference.
   */
  path: string;
  title: string;
  artist: string;
  album: string;
  /** Length in seconds, or null when the tags do not carry it. */
  duration: number | null;
  /** When the file landed in the library, epoch milliseconds. */
  addedAt: number;
  /**
   * The cover art: an object URL for a local file, an HTTP URL for a remote
   * one, or null when there is none.
   */
  artwork: string | null;
  /** Genres from the tags, comma-joined, or '' when none. */
  genre: string;
  /** Embedded lyrics as plain text, or '' when the file carries none. */
  lyrics: string;
  /**
   * The stream's own qualities, where they are known. Optional because the
   * local scanner has always managed without them; the server sends them for
   * every track, which is what the lossless badge reads.
   */
  lossless?: boolean;
  codec?: string;
  sampleRate?: number | null;
  bitDepth?: number | null;
  sizeBytes?: number;
}

// The file extensions treated as audio when walking the library folder.
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'aiff', 'aif', 'ogg', 'oga', 'opus', 'wma',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

// The title falls back to the file name (sans extension) when tags are absent.
function nameWithoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

// music-metadata's lyrics tag has shifted shape across versions - plain strings,
// { text }, or synced { syncText: [{ text }] }. Flatten whatever is there to one
// searchable block, tolerating all three, and fold curly punctuation to straight
// so a typed apostrophe matches a lyric that stores a smart one.
function extractLyrics(raw: unknown): string {
  const parts = !Array.isArray(raw)
    ? [typeof raw === 'string' ? raw : '']
    : raw.map((entry) => {
        if (typeof entry === 'string') return entry;
        const e = entry as { text?: string; syncText?: Array<{ text?: string }> };
        if (typeof e.text === 'string') return e.text;
        if (Array.isArray(e.syncText)) return e.syncText.map((s) => s.text ?? '').join(' ');
        return '';
      });
  return parts
    .join('\n')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// The Tauri modules the scanner needs, imported once and reused. The module
// cache makes repeat calls free, so each function can ask for them without
// paying to re-resolve the imports per file.
async function audioRuntime() {
  const [fs, path, mm] = await Promise.all([
    import('@tauri-apps/plugin-fs'),
    import('@tauri-apps/api/path'),
    import('music-metadata'),
  ]);
  return { fs, path, mm };
}

/**
 * Walks the music folder and returns the path of every audio file under it,
 * descending into subfolders. This is the cheap half of a scan - no files are
 * read or parsed - so the indexer can learn the whole library instantly and
 * then read tags at its own pace.
 */
export async function listAudioFiles(dir: string): Promise<string[]> {
  if (!isTauri()) return [];
  let fs: Awaited<ReturnType<typeof audioRuntime>>['fs'];
  let path: Awaited<ReturnType<typeof audioRuntime>>['path'];
  try {
    ({ fs, path } = await audioRuntime());
  } catch {
    return [];
  }
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.readDir>>;
    try {
      entries = await fs.readDir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = await path.join(current, entry.name);
      if (entry.isDirectory) await walk(full);
      else if (AUDIO_EXTENSIONS.has(extensionOf(entry.name))) files.push(full);
    }
  }
  await walk(dir);
  return files;
}

/**
 * Reads one file's tags into a track - the expensive half of a scan, done a
 * file at a time so the indexer can spread the work out. Returns null off Tauri
 * or when the file cannot be read, so a single bad file never fails a batch.
 */
export async function parseTrack(file: string): Promise<Track | null> {
  if (!isTauri()) return null;
  let fs: Awaited<ReturnType<typeof audioRuntime>>['fs'];
  let mm: Awaited<ReturnType<typeof audioRuntime>>['mm'];
  try {
    ({ fs, mm } = await audioRuntime());
  } catch {
    return null;
  }
  try {
    const [bytes, info] = await Promise.all([fs.readFile(file), fs.stat(file)]);
    const parsed = await mm.parseBuffer(bytes, { path: file }, { duration: true });
    const name = file.split('/').pop() ?? file;
    const cover = parsed.common.picture?.[0];
    const artwork = cover
      ? URL.createObjectURL(new Blob([new Uint8Array(cover.data)], { type: cover.format }))
      : null;
    const added = info.birthtime ?? info.mtime;
    return {
      path: file,
      title: parsed.common.title?.trim() || nameWithoutExtension(name),
      artist: parsed.common.artist?.trim() || 'Unknown artist',
      album: parsed.common.album?.trim() || '',
      duration: parsed.format.duration ?? null,
      addedAt: added ? new Date(added).getTime() : Date.now(),
      artwork,
      genre: parsed.common.genre?.join(', ') ?? '',
      lyrics: extractLyrics(parsed.common.lyrics),
    };
  } catch {
    return null;
  }
}

/**
 * Walks the music folder and returns a track for every audio file found,
 * reading embedded tags (title, artist, album, cover) and the duration. Runs
 * only under Tauri; returns an empty list anywhere else. Individual files that
 * cannot be read are skipped rather than failing the whole scan.
 */
export async function scanMusicLibrary(dir: string): Promise<Track[]> {
  const files = await listAudioFiles(dir);
  const tracks = await Promise.all(files.map((file) => parseTrack(file)));
  return tracks.filter((t): t is Track => t !== null);
}

// The library index is cached beside the music as a plain JSON file, so a
// relaunch can show the list instantly instead of re-reading every tag first.
const INDEX_CACHE_FILE = '.attackfm-index.json';

/**
 * Reads the cached track index from the music folder, or an empty list when
 * there is none. Cover art is an in-memory object URL that cannot be persisted,
 * so cached rows come back without artwork until the indexer re-reads them.
 */
export async function loadIndexCache(dir: string): Promise<Track[]> {
  if (!isTauri()) return [];
  try {
    const { fs, path } = await audioRuntime();
    const file = await path.join(dir, INDEX_CACHE_FILE);
    if (!(await fs.exists(file))) return [];
    const parsed = JSON.parse(await fs.readTextFile(file)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is Track => !!t && typeof (t as Track).path === 'string')
      .map((t) => ({ ...t, artwork: null }));
  } catch {
    return [];
  }
}

/** Writes the track index beside the music, dropping the un-persistable art. */
export async function saveIndexCache(dir: string, tracks: Track[]): Promise<void> {
  if (!isTauri()) return;
  try {
    const { fs, path } = await audioRuntime();
    const file = await path.join(dir, INDEX_CACHE_FILE);
    const slim = tracks.map((t) => ({ ...t, artwork: null }));
    await fs.writeTextFile(file, JSON.stringify(slim));
  } catch {
    // The cache is an optimisation; a failed write just means a slower next run.
  }
}

/**
 * Returns a URL an `<audio>` element can play for a local file, or null off
 * Tauri. It uses the ASSET PROTOCOL, not a blob: URL: WebKit's
 * `createMediaElementSource` reads silence from a blob (the track plays, but the
 * analyser - and so the seek bar's beat and levels - stays flat), while the
 * asset protocol serves a real, range-capable response that carries an
 * `Access-Control-Allow-Origin` header matching the window origin, so with
 * `crossOrigin="anonymous"` on the element the graph is untainted and readable.
 * The asset scope in tauri.conf.json must cover the file (the audio + home trees).
 */
export async function loadAudioUrl(path: string): Promise<string | null> {
  // A server track resolves to an ordinary HTTPS URL, which the element plays
  // exactly the way it plays the asset protocol - and, being CORS-clean, reads
  // through the analyser the same way too. The whole remote-library feature
  // lands on this one branch.
  const remote = resolveRemoteAudioUrl(path);
  if (remote) return remote;

  if (!isTauri()) return null;
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

/**
 * How `loadAudioUrl` reaches the signed-in server without every caller having
 * to thread a session through.
 *
 * A module-level hook rather than a parameter, deliberately: the alternative
 * was changing `loadAudioUrl`'s signature and, with it, the Player's load
 * effect - the most delicate code in the app, and the thing this design set out
 * not to touch. There is at most one server connected at a time, so a single
 * slot is an honest model of the state rather than a shortcut around it. The
 * session provider owns the slot and clears it on sign-out.
 */
type RemoteResolver = (path: string) => string | null;

let remoteResolver: RemoteResolver | null = null;

export function setRemoteAudioResolver(resolver: RemoteResolver | null): void {
  remoteResolver = resolver;
}

function resolveRemoteAudioUrl(path: string): string | null {
  if (!path.startsWith('afm://')) return null;
  return remoteResolver?.(path) ?? null;
}
