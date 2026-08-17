import { onlineMetadataEnabled } from '../settings/netPrefs.ts';
import { isTauri } from '../core/tauri.ts';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

/**
 * A crisp album cover URL from the iTunes Search API, or null. Art lookup is
 * core UI (the artist page's album covers), not part of the import feature -
 * which is why it lives here rather than in the spotify-import plugin: core
 * must never import from something that can be switched off.
 */
export async function fetchAlbumArt(artist: string, album: string): Promise<string | null> {
  if (!isTauri() || !artist || !album) return null;
  // The privacy switch: no artist/album names leave for Apple when online
  // metadata lookups are off - the page falls back to library artwork.
  if (!onlineMetadataEnabled()) return null;
  try {
    return await invoke<string | null>('music_album_art', { artist, album });
  } catch {
    return null;
  }
}
