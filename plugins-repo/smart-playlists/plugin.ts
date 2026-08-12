import { smartPlaylists } from './index.tsx';

/** The bundle's public face - the host calls this once and gets the plugin. */
export function createPlugin(): typeof smartPlaylists {
  return smartPlaylists;
}
