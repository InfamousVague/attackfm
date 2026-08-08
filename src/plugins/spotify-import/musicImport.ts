/** A queued/running/finished music import, mirroring the Rust `MusicImportJob`. */
export type MusicImportState = 'queued' | 'downloading' | 'done' | 'error';

export interface MusicImportJob {
  id: string;
  url: string;
  /** playlist | album | artist | track | link */
  kind: string;
  title: string;
  service: string;
  quality: string;
  total: number | null;
  completed: number;
  state: MusicImportState;
  error: string | null;
  createdAt: number;
  artworkUrl: string | null;
  subtitle: string | null;
  currentTrack: string | null;
  /** Track titles for an album/playlist, in order. */
  tracks: string[];
  /** 0-based index of the track currently downloading, if any. */
  currentIndex: number | null;
  outputDir: string;
}

export interface SpotiFlacStatus {
  available: boolean;
  command: string | null;
  outputDir: string;
  hint: string | null;
}

/** Configurable download settings, mirroring the Rust `MusicSettings`. */
export interface MusicSettings {
  quality: string;
  services: string;
  retries: number;
  timeout: number;
  lyrics: boolean;
  enrich: boolean;
}

const MAGNET_RE = /^magnet:/i;

/**
 * Whether a pasted string is a music-service link AttackFM can import. Ported
 * from ghostwire: Spotify (URI + web), Apple Music, Tidal, Deezer, YT Music,
 * Qobuz. Magnets are explicitly excluded.
 */
export function isMusicImportLink(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v || MAGNET_RE.test(v)) return false;
  return (
    v.startsWith('spotify:') ||
    /\bopen\.spotify\.com\//.test(v) ||
    /\bmusic\.apple\.com\//.test(v) ||
    /\b(?:listen\.)?tidal\.com\//.test(v) ||
    /\bdeezer\.com\//.test(v) ||
    /\bmusic\.youtube\.com\//.test(v) ||
    /\b(?:open|play)\.qobuz\.com\//.test(v)
  );
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

export async function enqueueMusicImport(url: string, outputDir?: string): Promise<MusicImportJob> {
  // outputDir omitted -> the backend's own fallback (the OS music folder).
  // Callers pass a directory only when the library IS a local folder - a
  // server library's musicDir is a URL, and a URL handed to the downloader
  // becomes a literal "https:" directory on disk.
  return invoke<MusicImportJob>('music_import_enqueue', { url, outputDir });
}

export async function listMusicImports(): Promise<MusicImportJob[]> {
  return invoke<MusicImportJob[]>('music_imports_list');
}

export async function removeMusicImport(id: string): Promise<void> {
  await invoke('music_import_remove', { id });
}

export async function retryMusicImport(id: string): Promise<void> {
  await invoke('music_import_retry', { id });
}

export async function cancelMusicImport(id: string): Promise<void> {
  await invoke('music_import_cancel', { id });
}

export async function clearMusicImports(states: MusicImportState[]): Promise<void> {
  await invoke('music_imports_clear', { states });
}

export async function spotiflacStatus(outputDir?: string): Promise<SpotiFlacStatus> {
  return invoke<SpotiFlacStatus>('music_spotiflac_status', { outputDir });
}

export async function installSpotiflac(): Promise<{ resolvedCommand: string | null }> {
  return invoke('music_spotiflac_install');
}

export async function getMusicSettings(): Promise<MusicSettings> {
  return invoke<MusicSettings>('music_import_get_settings');
}

export async function setMusicSettings(settings: MusicSettings): Promise<void> {
  await invoke('music_import_set_settings', { settings });
}

export async function getDownloadsPaused(): Promise<boolean> {
  return invoke<boolean>('music_import_paused');
}

export async function setDownloadsPaused(paused: boolean): Promise<void> {
  await invoke('music_import_set_paused', { paused });
}
