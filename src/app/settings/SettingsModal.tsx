// The settings hub: the sections array with its live summary reads, and the
// TabbedModal vs MobileSettings switch. The panes moved out: AppearancePane /
// GeneralPane / PlaybackPane / PluginsPane (+ pluginRepos) / MobileSettings,
// shared bits in settingsShared.ts, useMediaQuery deduped into ux/.
import { SearchField, TabbedModal } from '@glacier/react';
import {
  Bell,
  Blocks,
  BookOpen,
  HardDrive,
  Info,
  MonitorSpeaker,
  Palette,
  Play,
  Server,
  Settings,
  Sparkles,
} from '@glacier/icons';
import { useEffect, useState } from 'react';
import { APP_VERSION } from '../core/version.ts';
import { noteSettingsPane } from './settingsRecency.ts';
import { useAppearance } from './appearance.tsx';
import { isTauri } from '../core/tauri.ts';
import { useLibrary } from '../library/library.tsx';
import { usePlayback } from '../player/playback.tsx';
import { usePlugins, usePluginSettingsSections } from '../../plugins/runtime.tsx';
import { AboutSettings } from './AboutSettings.tsx';
import { HandbookPane } from './handbook/HandbookPane.tsx';
import { HANDBOOK_PAGES } from './handbook/handbookPages.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';
import { DevicesSettings } from './DevicesSettings.tsx';
import { CuratorSettings } from './CuratorSettings.tsx';
import { useConnect } from '../player/playbackSync.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { DeviceStorageSettings } from '../downloads/DeviceStorageSettings.tsx';
import { ServersSettings } from '../servers/ServersSettings.tsx';
import { knownServers } from '../servers/servers.ts';
import { heldCount, offlineSpace, onOfflineChange } from '../downloads/offline.ts';
import { useMediaQuery } from '../ux/useMediaQuery.ts';
import { formatBytes } from '../ux/format.ts';
import { Appearance } from './AppearancePane.tsx';
import { General } from './GeneralPane.tsx';
import { PlaybackSettings } from './PlaybackPane.tsx';
import { PluginsSettings } from './PluginsPane.tsx';
import { MobileSettings } from './MobileSettings.tsx';
import {
  accentLabel,
  MOBILE_QUERY,
  paneMatches,
  THEME_COPY,
  type SettingsSection,
} from './settingsShared.ts';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Open straight onto one pane - what the header's network dot does. */
  pane?: string | null;
}

/**
 * The settings surface. TabbedModal is the kit's settings dialog - a section
 * rail beside a scrolling pane, on top of Modal - so this only supplies the
 * sections.
 */
export function SettingsModal({ open, onClose, pane }: SettingsModalProps) {
  // Static data only - no plugin hooks - so no scope is needed here, and the
  // modal survives a toggle without remounting out from under the user.
  const pluginSections = usePluginSettingsSections();

  // The one-line readings the touch list shows under each row - each section's
  // current state, read from the same stores the panes edit so they can never
  // disagree. Cheap enough to compute on every open.
  const { theme, accent } = useAppearance();
  const pb = usePlayback();
  const { session } = useServerSession();
  const { connected, devices } = useConnect();
  const { all: allPlugins, isEnabled } = usePlugins();
  const { source, tracks } = useLibrary();

  const playbackBits = [
    pb.crossfade > 0 ? `Crossfade ${pb.crossfade}s` : null,
    pb.smartShuffle ? 'Smart shuffle' : null,
    pb.autoDj ? 'Auto DJ' : null,
    pb.nightMode ? 'Night mode' : null,
  ].filter(Boolean);
  const online = devices.filter((d) => d.online).length;
  const enabledPlugins = allPlugins.filter((p) => isEnabled(p.id)).length;
  // The rail's one-line reading of the vault. Subscribed rather than read once:
  // pinning happens from song menus while Settings is open behind them.
  const [offlineHeld, setOfflineHeld] = useState(() => heldCount());
  const [heldBytes, setHeldBytes] = useState<number | null>(null);
  useEffect(() => {
    // Stamped per read: two pins in quick succession can resolve out of
    // order, and only the freshest answer may land.
    let stamp = 0;
    const read = () => {
      const mine = ++stamp;
      void offlineSpace()
        .then((sp) => sp && mine === stamp && setHeldBytes(sp.heldBytes))
        .catch(() => {});
    };
    read();
    return onOfflineChange(read);
  }, []);
  useEffect(() => onOfflineChange(() => setOfflineHeld(heldCount())), []);

  const sections: SettingsSection[] = [
    {
      id: 'appearance',
      label: 'Appearance',
      icon: <Palette size={16} />,
      content: <Appearance />,
      summary: `${THEME_COPY[theme].label} · ${accentLabel(accent)}`,
      tint: 'purple',
      group: 0,
    },
    {
      id: 'general',
      label: 'General',
      icon: <Settings size={16} />,
      content: <General />,
      summary:
        source === 'server'
          ? `${tracks.length.toLocaleString()} songs from your server`
          : `${tracks.length.toLocaleString()} songs in your folder`,
      tint: 'slate',
      group: 0,
    },
    {
      id: 'playback',
      label: 'Playback',
      icon: <Play size={16} />,
      content: <PlaybackSettings />,
      summary: playbackBits.length > 0 ? playbackBits.slice(0, 2).join(' · ') : 'Standard playback',
      tint: 'pink',
      group: 0,
    },
    // Where the music comes from, when it does not come from this machine -
    // and, beside it, the devices it goes out to.
    {
      id: 'server',
      label: 'Servers',
      icon: <Server size={16} />,
      content: <ServersSettings />,
      // The host you are on, and how many boxes the account can reach. Both
      // numbers come from cheap reads, so the row is honest before any pane
      // has mounted.
      summary: (() => {
        const here = session ? session.url.replace(/^https?:\/\//, '') : 'Not connected';
        const n = knownServers().length;
        return n > 1 ? `${here} · ${n} servers` : here;
      })(),
      tint: 'blue',
      group: 1,
    },
    // The machine that listens along: the collector's ledger and switch, the
    // recent pulls, and how far the enrichment has read the library.
    // The curator's preferences moved into the Booth - they are the taste
    // engine's own, opened from its room, not a pane about an abstraction.
    {
      id: 'storage',
      label: 'Downloads & space',
      icon: <HardDrive size={16} />,
      content: <DeviceStorageSettings />,
      // Both halves of the question in one line: how many songs are down here,
      // and what they cost. Either alone reads as half an answer.
      summary: (() => {
        const room = heldBytes != null && heldBytes > 0 ? formatBytes(heldBytes) : null;
        if (offlineHeld > 0 && room) return `${offlineHeld} songs · ${room}`;
        if (room) return `${room} on this device`;
        return 'Nothing kept yet';
      })(),
      tint: 'green',
      group: 1,
    },
    // Devices folded into the Servers pane: seats, mirrors and hosts are one
    // question, answered on one page (and glanced from the header's dot).
    {
      id: 'notifications',
      label: 'Notifications',
      icon: <Bell size={16} />,
      content: <NotificationSettings />,
      summary: session ? 'What the app may interrupt you for' : 'Needs a server',
      tint: 'pink',
      group: 1,
    },
    // The importer contributes Downloads here, exactly where it has always
    // sat; any plugin's tabs land in this run of the rail.
    ...pluginSections.map((s) => ({ ...s, tint: 'orange' as const, group: 2 })),
    {
      id: 'plugins',
      label: 'Plugins',
      icon: <Blocks size={16} />,
      content: <PluginsSettings />,
      summary: `${enabledPlugins} of ${allPlugins.length} enabled`,
      tint: 'orange',
      group: 2,
    },
    // The manual, one idea per page: the app the way a listener meets it,
    // then the plugin contract the way a developer needs it.
    {
      id: 'handbook',
      label: 'Handbook',
      icon: <BookOpen size={16} />,
      content: <HandbookPane />,
      summary: `How it all works, in ${HANDBOOK_PAGES.length} pages`,
      tint: 'blue',
      group: 3,
    },
    {
      id: 'about',
      label: 'About',
      icon: <Info size={16} />,
      content: <AboutSettings />,
      summary: `AttackFM v${APP_VERSION}`,
      tint: 'slate',
      group: 3,
    },
  ];

  // The tab is controlled so a section that leaves the rail - a plugin pulled
  // after a crash while its own tab is showing - cannot strand the modal on an
  // id that no longer exists (the kit renders no pane at all for one). The
  // reset lands on Plugins, where the crash notice explains what just left.
  const [tab, setTab] = useState('appearance');
  // Search over the panes: label, live summary, and each pane's own hand-kept
  // vocabulary. The RAIL narrows as you type; the structure never changes.
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  // Asked to open on a specific pane (the network dot's Manage): land there.
  useEffect(() => {
    if (open && pane) setTab(pane);
  }, [open, pane]);
  const shown = sections.filter((s) => paneMatches(s, query));
  const shownIds = shown.map((s) => s.id).join('\n');
  useEffect(() => {
    const ids = shownIds.split('\n');
    if (!ids.includes(tab)) setTab(ids[0] ?? 'plugins');
  }, [shownIds, tab]);
  // The chips are read once per open; opening a pane rewrites them.
  const noteTab = (id: string) => {
    const s = sections.find((x) => x.id === id);
    if (s) noteSettingsPane(id, s.label);
    setTab(id);
  };

  // On touch the rail-beside-a-pane collapses to a drill-in: a full-screen list
  // of sections that pushes into the chosen pane, a back arrow returning to it.
  const mobile = useMediaQuery(MOBILE_QUERY);
  if (mobile) {
    return <MobileSettings open={open} onClose={onClose} sections={sections} initialId={pane ?? null} />;
  }

  return (
    <TabbedModal
      open={open}
      onClose={onClose}
      title={
        <div className="settingsTitleRow">
          <span>Settings</span>
          <SearchField
            className="settingsTitleRow__search"
            value={query}
            onValueChange={setQuery}
            placeholder="Find a setting"
            aria-label="Find a setting"
          />
        </div>
      }
      value={tab}
      onValueChange={noteTab}
      // The rail and the pane read as one surface here, so the line between them
      // is dropped.
      divider={false}
      sections={shown}
    />
  );
}
