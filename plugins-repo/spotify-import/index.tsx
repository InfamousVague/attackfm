import { Download, ListMusic } from '@glacier/icons';
import { isTauri } from '@attackfm/app/tauri';
import { useServerSession } from '@attackfm/app/serverSession';
import type { AcquireHandler, PaletteContext, Plugin, PluginCommand } from '../../src/plugins/types.ts';
import { useDownloads } from '@attackfm/app/importsBridge';
import { isMusicImportLink } from './musicImport.ts';
import { DownloadsProvider } from './DownloadsProvider.tsx';
import { DownloadsButton } from './DownloadsPopover.tsx';
import { DownloadsSettings } from './DownloadsSettings.tsx';
import { SpotifyAccountSettings } from './SpotifyAccountSettings.tsx';

/**
 * The palette's import command: a pasted music-service link becomes a single
 * exclusive "Import to library" action, as SongSearch's inline branch once
 * did. useDownloads resolves because this hook runs below the plugin's own
 * DownloadsProvider in the PluginProviders chain.
 */
function useImportCommands({ query, close }: PaletteContext): readonly PluginCommand[] {
  // The hooks are called first, unconditionally, so the early returns below
  // can never change this instance's hook order.
  const { enqueue } = useDownloads();
  const { session } = useServerSession();
  // No engine, no command. The engine is EITHER local (a desktop with the
  // subprocess) OR the hub (any device signed into a server). A plain browser
  // with neither would be a button wired to nothing.
  if (!isTauri() && !session) return [];
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
 * The importer's acquire handler: "Download" for anything carrying a source URL
 * - a Discover playlist, a searched song, a record in an artist's catalogue.
 * It enqueues through the same queue the palette import uses. Present only where
 * the engine is (a desktop subprocess or a connected hub); a plain browser with
 * neither offers no download, so the surface falls back to Buy or nothing.
 */
function useDownloadHandlers(): readonly AcquireHandler[] {
  const { enqueue } = useDownloads();
  const { session } = useServerSession();
  if (!isTauri() && !session) return [];
  return [
    {
      id: 'download',
      label: 'Download',
      icon: <Download size={16} />,
      // Nothing to fetch without a link to fetch it from.
      canHandle: (target) => !!target.url,
      run: (target) => {
        if (target.url) void enqueue(target.url);
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
  version: '1.1.0',
  tags: ['Importer', 'Downloads'],
  // The engine runs where the music lives. On a desktop that is the local
  // SpotiFLAC subprocess; signed into a server it is the hub, which downloads
  // and indexes straight into the shared library - so a phone imports too, by
  // commanding the box rather than running anything itself. serverBacked is
  // what makes the card appear on a phone once a server is connected and
  // vanish when it is not; a plain browser with neither engine never sees it.
  requiresServer: true,
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
    { id: 'spotify', label: 'Spotify', icon: <ListMusic size={16} />, Content: SpotifyAccountSettings },
  ],
  usePaletteCommands: useImportCommands,
  useAcquireHandlers: useDownloadHandlers,
};
