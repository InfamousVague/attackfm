import { Download } from '@glacier/icons';
import { isTauri } from '../../app/tauri.ts';
import type { PaletteContext, Plugin, PluginCommand } from '../types.ts';
import { useDownloads } from './downloadsContext.ts';
import { isMusicImportLink } from './musicImport.ts';
import { DownloadsProvider } from './DownloadsProvider.tsx';
import { DownloadsButton } from './DownloadsPopover.tsx';
import { DownloadsSettings } from './DownloadsSettings.tsx';

/**
 * The palette's import command: a pasted music-service link becomes a single
 * exclusive "Import to library" action, as SongSearch's inline branch once
 * did. useDownloads resolves because this hook runs below the plugin's own
 * DownloadsProvider in the PluginProviders chain.
 */
function useImportCommands({ query, close }: PaletteContext): readonly PluginCommand[] {
  // The hook is called first, unconditionally, so the early returns below can
  // never change this instance's hook order.
  const { enqueue } = useDownloads();
  // No engine, no command: offering an import the browser cannot perform
  // would be a button wired to nothing.
  if (!isTauri()) return [];
  const link = isMusicImportLink(query) ? query.trim() : null;
  if (!link) return [];
  // A pasted link is an action, not a search: exclusive drops the song rows.
  return [
    {
      id: 'import',
      label: 'Import to library',
      group: 'Import',
      keywords: link,
      exclusive: true,
      run: () => {
        void enqueue(link);
        close();
      },
    },
  ];
}

/**
 * The SpotiFLAC-backed importer, as a plugin: the download queue (provider),
 * the title-bar queue popover, the Downloads settings tab, and the palette's
 * paste-a-link import command. Off means none of it mounts - no queue
 * subscription, no button, no section, no link detection.
 */
export const spotifyImport: Plugin = {
  id: 'spotify-import',
  name: 'Music import',
  description:
    'Downloads pasted Spotify, Apple Music, Tidal, Deezer, YT Music, and Qobuz links into the library.',
  icon: <Download size={22} />,
  author: 'AttackFM',
  version: '1.0.0',
  tags: ['Importer', 'Downloads'],
  details:
    'Paste a link from Spotify, Apple Music, Tidal, Deezer, YT Music, or Qobuz ' +
    'anywhere in the command palette and this turns it into files in your ' +
    'library, fetched by the SpotiFLAC engine at the quality you choose in its ' +
    'Downloads tab. Whole playlists and albums queue track by track, the queue ' +
    'survives restarts, and everything it saves is tagged and picked up by the ' +
    'library scan automatically.',
  Provider: DownloadsProvider,
  slots: { 'titlebar-end': DownloadsButton },
  settingsSections: [
    { id: 'downloads', label: 'Downloads', icon: <Download size={16} />, Content: DownloadsSettings },
  ],
  usePaletteCommands: useImportCommands,
};
