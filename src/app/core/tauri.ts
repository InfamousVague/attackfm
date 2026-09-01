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

/**
 * One guarded invoke: null off Tauri, null when the binary lacks the command
 * (an older shell), null when the platform has no layer beneath it. Updates,
 * nearby and offline each carried this verbatim before it lived here - and
 * the shared contract is the comment they all reached for: on a null, the
 * app behaves exactly as it did before the feature existed.
 */
export async function tauriCall<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke(cmd, args)) as T;
  } catch {
    return null;
  }
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
  /**
   * The server this row came from - its normalised URL - or absent for a
   * local file. Derived, never authoritative: the path still carries the
   * origin (tagged, or untagged meaning the primary hub), and anything that
   * routes a request must read THAT via `originFromPath`. This is for faces:
   * an "on Kevin's server" line under a title should not have to base64-decode
   * every row it draws.
   */
  origin?: string;
  title: string;
  artist: string;
  /**
   * Who the ALBUM is by, which is not always who the track is by: a record
   * with a guest on two songs has three different `artist` values and one
   * album artist, and a compilation has one per track and "Various Artists"
   * over all of them. Anything gathering an artist's work has to read this or
   * it loses the records that are least uniform - which are usually the ones
   * somebody cares most about.
   *
   * Absent for a local scan (the scanner has never read the tag) and from
   * older servers, so every reader falls back to `artist`.
   */
  albumArtist?: string | null;
  album: string;
  /** Length in seconds, or null when the tags do not carry it. */
  duration: number | null;
  /**
   * Position within its album, or null/absent when untagged. The server sends
   * it for every track; the local scanner has never read it. CarPlay's artist
   * lists are the consumer: an album played from the car should run in album
   * order, not alphabetical.
   */
  trackNo?: number | null;
  /** The release year off the tags, where they carry one. */
  year?: number | null;
  /** Which disc, on a set that has more than one. Null/absent when untagged
   *  or single-disc; an album's running order is (disc, track), never track
   *  alone, or the second disc interleaves with the first. */
  discNo?: number | null;
  /** When the file landed in the library, epoch milliseconds. */
  addedAt: number;
  /**
   * What the row IS: 'music' (or absent - local scans and old servers never
   * say) or 'book', an audiobook section. Books live on their own shelf and
   * stay out of every music surface; library.tsx makes the split once.
   */
  kind?: 'music' | 'book';
  /**
   * Chapter markers for a single-file audiobook: title + start offset (ms), in
   * order. Absent or empty for everything else. A book that is one m4b (Audible)
   * carries these; a book that is many files (LibriVox) uses its tracks instead.
   */
  chapters?: { title: string; startMs: number }[];
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
  /**
   * Set when the CURATOR downloaded this track rather than a person: the id of
   * the account it was fetched for. Such a track sits on that account's
   * "For you" shelf until `curatorPromoted` - a full listen-through or a heart
   * - moves it into the library proper. Absent for everything a person added,
   * and from servers that predate the collector.
   */
  curatorUserId?: number | null;
  curatorPromoted?: boolean;
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
 * The identity of one local file, for the folder-sync precheck: tags and
 * size, no artwork and no object URLs - this runs over whole folders, and a
 * cover per file would be a leak with a scroll wheel. Null when the file
 * cannot be read (it then simply is not offered to the sync).
 */
export async function parseTrackMeta(
  file: string,
): Promise<{ title: string; artist: string; album: string; duration: number | null; size: number } | null> {
  if (!isTauri()) return null;
  try {
    const { fs, mm } = await audioRuntime();
    const bytes = await fs.readFile(file);
    const parsed = await mm.parseBuffer(bytes, { path: file }, { duration: true, skipCovers: true });
    // Both separators: the fallback title must match the name the uploader
    // sends, or an untagged file's sync identity diverges from itself.
    const name = file.split(/[\\/]/).pop() ?? file;
    return {
      title: parsed.common.title?.trim() || nameWithoutExtension(name),
      artist: parsed.common.artist?.trim() || 'Unknown artist',
      album: parsed.common.album?.trim() || '',
      duration: parsed.format.duration ?? null,
      size: bytes.byteLength,
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
 * Re-claims the iOS audio session. iOS releases it on interruptions (calls,
 * Siri, an exclusive session elsewhere), after which play() is refused or
 * silent - the player fires this before recovery attempts and on returning to
 * the foreground. Fire-and-forget: a no-op on desktop and Android, and a
 * failure only means the next attempt claims it instead.
 */
export function reactivateAudioSession(): void {
  if (!isTauri()) return;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('ios_reactivate_audio'))
    .catch(() => {});
}

/**
 * Where the phone's own volume buttons sit, 0-1 - the level applied AFTER
 * everything the app does, so it is the only reading of how loud the music
 * actually is. 1 everywhere there is no separate system fader to ask (desktop,
 * the browser, an older binary without the command), which leaves anything
 * reading it behaving exactly as it did before.
 */
export async function systemOutputVolume(): Promise<number> {
  if (!isTauri()) return 1;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const volume = await invoke<number>('ios_output_volume');
    return typeof volume === 'number' && volume >= 0 && volume <= 1 ? volume : 1;
  } catch {
    return 1;
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
/**
 * The audio source for a path, asking to START at `from` seconds.
 *
 * Only a live encode can honour that, and only the server can do it: `-ss`
 * before `-i` seeks by keyframe index, which measured at 110ms to first byte
 * against 116ms unseeked - free, in other words. It matters because the
 * alternative is what the app used to do, which was ask for the stream from
 * zero and then set `currentTime`: on a length-less ADTS body the element
 * cannot seek past what it has, so every change of sound made the server
 * re-encode the song from the top and the listener wait for all of it to
 * arrive. Three minutes in, that is about 2.4 seconds of encode and 3.8MB of
 * audio nobody hears, and it grows the deeper into the track you are.
 *
 * Anything the element can seek itself - a file on this device, a range-capable
 * stream - comes back with `offset: 0` and is seeked the ordinary way.
 */
export async function loadAudioSource(
  path: string,
  from = 0,
): Promise<AudioSource | null> {
  const url = await loadLocalAudioUrl(path);
  // A file on this device is an ordinary seekable source, whatever was asked.
  if (url) return { url, offset: 0, seekable: true };
  /*
   * Then the queue buffer: bytes already pulled down for a song we expected to
   * be wanted soon. Below the vault because a kept file is the better answer
   * when both have it - the vault's copy is permanent and this one is about to
   * roll out of the window - and above the wire because not needing the network
   * is the entire point.
   *
   * A whole file in hand seeks itself, so `from` is honoured by the ordinary
   * currentTime path rather than by asking the server to start partway in.
   */
  if (queueBufferResolver) {
    try {
      const buffered = await queueBufferResolver(path);
      if (buffered) return { url: buffered, offset: 0, seekable: true };
    } catch {
      // A buffer that cannot answer is not a reason to fail the load.
    }
  }
  const remote = resolveRemoteAudioSource(path, from);
  if (remote) return remote;
  return null;
}

/** The plain URL, from the top. Every caller that is not resuming in place. */
export async function loadAudioUrl(path: string): Promise<string | null> {
  return (await loadAudioSource(path, 0))?.url ?? null;
}

async function loadLocalAudioUrl(path: string): Promise<string | null> {
  // A copy on this device wins over the wire, always: it plays with no
  // network at all, costs the hub nothing, and starts instantly. The asset
  // protocol serves it range-capable and CORS-clean, so the analyser - and
  // with it the seek bar's beat and levels - reads exactly as it does from
  // the server. See offline.ts; the map is a cache of the folder, so a file
  // deleted underneath us simply falls through to the stream below.
  const local = offlineResolver?.(path) ?? null;
  if (local && isTauri()) {
    try {
      // Android's WebView plays media OUTSIDE the intercepted asset protocol:
      // an <audio> pointed at http://asset.localhost/... fires loadstart and
      // then hangs forever, while fetch() of the same URL answers 200 - the
      // media stack simply never consults the interceptor. So on Android the
      // held file is pulled through the fetch path that does work and played
      // as a blob URL, which the renderer serves itself. iOS's WKWebView
      // routes media through the protocol handler and keeps the direct URL,
      // range requests and all.
      if (/Android/i.test(navigator.userAgent)) {
        const blob = await androidVaultUrl(local);
        if (blob) return blob;
        // A vault file that will not read falls through to the stream.
      } else {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        return convertFileSrc(local);
      }
    } catch {
      // Fall through to the network rather than failing the load.
    }
  }

  // A server track is not this function's business - `loadAudioSource` above
  // asks the remote resolver, which is the one that knows how to start a
  // stream partway in.
  if (isRemotePathLike(path)) return null;

  if (!isTauri()) return null;
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

/** Vault path -> object URL, so replaying a held song does not re-read the
 *  whole file. Two entries: the playing song and the next one - a FLAC is
 *  tens of megabytes and blobs live until revoked. */
const vaultBlobCache = new Map<string, string>();

/** Exactly the asset protocol's per-answer cap (its MAX_LEN). Asking for
 *  precisely this much is the difference between "every slice comes back
 *  full" and "every slice comes back short and the offsets drift". */
const VAULT_SLICE = 1000 * 1024;

/** Past this, a blob stops being the right shape for the file - stream it
 *  from the hub instead. (An eighteen-hour book at the phone's cache bitrate
 *  sits well under this; the guard is for the pathological.) */
const VAULT_BLOB_CEILING = 1600 * 1024 * 1024;

/**
 * A vault file, pulled through the asset protocol in RANGED slices and stood
 * back up as one Blob.
 *
 * Why not one fetch: on Android every response body crosses the JNI bridge as
 * a SINGLE Java byte array, and the Java heap's growth limit is 512MB. A
 * whole-file fetch of a cached audiobook was a half-gigabyte allocation in
 * `Rust.handleRequest` - OutOfMemoryError, process gone. That is why opening
 * a cached book killed the app while a fresh install (nothing cached, served
 * by the hub over HTTP ranges) played the same book fine. Songs never showed
 * it only because tens of megabytes fit.
 *
 * A Range request keeps every crossing small: the protocol answers 206 and
 * caps each slice at ~1MB. The slices are fetched a few at a time at fixed
 * offsets - safe because the handler only ever shortens the LAST slice - and
 * every slice is verified for size, so a surprise short answer degrades to
 * the network stream rather than corrupt audio. The assembled Blob lives in
 * the renderer's blob storage, which pages big blobs to disk.
 */
export async function fetchVaultBlob(
  src: string,
  fetchLike: typeof fetch = fetch,
): Promise<Blob | null> {
  const slice = (start: number, end: number) =>
    fetchLike(src, { cache: 'no-store', headers: { Range: `bytes=${start}-${end}` } });

  const first = await slice(0, VAULT_SLICE - 1);
  if (first.status === 200) {
    // A shell whose protocol ignores Range sends the whole body - it has
    // already crossed the bridge, so keeping it costs nothing extra.
    const whole = await first.blob();
    return whole.size > 0 ? whole : null;
  }
  if (first.status !== 206) return null;

  const type = first.headers.get('content-type') ?? '';
  const total = Number(first.headers.get('content-range')?.split('/')[1]);
  if (!Number.isFinite(total) || total <= 0 || total > VAULT_BLOB_CEILING) return null;

  const parts: Blob[] = [await first.blob()];
  let at = parts[0]!.size;
  if (at === 0) return null;

  while (at < total) {
    const wave: { want: number; res: Promise<Response> }[] = [];
    for (let i = 0; i < 4 && at + i * VAULT_SLICE < total; i++) {
      const start = at + i * VAULT_SLICE;
      const end = Math.min(start + VAULT_SLICE, total) - 1;
      wave.push({ want: end - start + 1, res: slice(start, end) });
    }
    for (const { want, res } of wave) {
      const r = await res;
      if (r.status !== 206) return null;
      const b = await r.blob();
      if (b.size !== want) return null;
      parts.push(b);
      at += b.size;
    }
  }
  return new Blob(parts, { type });
}

async function androidVaultUrl(local: string): Promise<string | null> {
  const cached = vaultBlobCache.get(local);
  if (cached) return cached;
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const blob = await fetchVaultBlob(convertFileSrc(local));
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    while (vaultBlobCache.size >= 2) {
      const oldest = vaultBlobCache.entries().next().value;
      if (!oldest) break;
      URL.revokeObjectURL(oldest[1]);
      vaultBlobCache.delete(oldest[0]);
    }
    vaultBlobCache.set(local, url);
    return url;
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

/**
 * A remote answer, and where in the song it actually begins.
 *
 * `offset` is 0 for anything the element can seek on its own - a range-capable
 * stream, a file on this device. It is non-zero only when the answer is a LIVE
 * ENCODE that the server started partway in, because that stream's clock reads
 * zero at `offset` seconds into the song and every reader of `currentTime` has
 * to know it.
 */
export interface AudioSource {
  url: string;
  offset: number;
  /**
   * Whether the element can seek this source by itself.
   *
   * False for a live encode: the body is chunked, has no length and no byte
   * ranges, so `currentTime` can only reach what is already buffered and
   * silently clamps to the window otherwise. Those sources are seeked by
   * ASKING THE SERVER AGAIN from the new position, which is the whole reason
   * `/api/transcode` takes a `seek`.
   */
  seekable: boolean;
}

type SeekingResolver = (path: string, seek: number) => AudioSource | null;

let remoteResolver: SeekingResolver | null = null;

/**
 * The same seam for the offline vault, and for the same reason: this module
 * sits at the bottom of the import graph (nothing here imports the app), so
 * the vault registers itself rather than being imported. See offline.ts.
 */
let offlineResolver: RemoteResolver | null = null;

export function setOfflineAudioResolver(resolver: RemoteResolver | null): void {
  offlineResolver = resolver;
}

/**
 * The rolling queue buffer (player/queueBuffer.ts), which answers with a blob
 * URL for a song it has already pulled down, or null for one it has not.
 *
 * Async where the vault's resolver is synchronous, because this one reads bytes
 * off disk to mint the URL rather than pointing at a file the OS will open.
 */
type BufferResolver = (path: string) => Promise<string | null>;
let queueBufferResolver: BufferResolver | null = null;

export function setQueueBufferResolver(resolver: BufferResolver | null): void {
  queueBufferResolver = resolver;
}

export function setRemoteAudioResolver(resolver: SeekingResolver | null): void {
  remoteResolver = resolver;
}

function isRemotePathLike(path: string): boolean {
  return path.startsWith('afm://');
}

function resolveRemoteAudioSource(path: string, seek: number): AudioSource | null {
  if (!path.startsWith('afm://')) return null;
  return remoteResolver?.(path, seek) ?? null;
}
