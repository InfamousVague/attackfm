// The settings hub: the sections array with its live summary reads, and the
// TabbedModal vs MobileSettings switch. The panes moved out: AppearancePane /
// GeneralPane / PlaybackPane / PluginsPane (+ pluginRepos) / MobileSettings,
// shared bits in settingsShared.ts, useMediaQuery deduped into ux/.
import { SearchField, TabbedModal } from '@glacier/react';
import { Bell, Blocks, BookOpen, CircleUserRound, HardDrive, Info, Library, Palette, Play, Server, Shield, Stethoscope } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { APP_VERSION } from '../core/version.ts';
import { noteSettingsPane } from './settingsRecency.ts';
import { useAppearance } from './appearance.tsx';
import { useLibrary } from '../library/library.tsx';
import { usePlayback } from '../player/playback.tsx';
import { usePlugins, usePluginSettingsSections } from '../../plugins/runtime.tsx';
import { AboutSettings } from './AboutSettings.tsx';
import { DiagnosticsPane } from './DiagnosticsPane.tsx';
import { diagEntries } from '../diag/diagLog.ts';
import { HandbookPane } from './handbook/HandbookPane.tsx';
import { HANDBOOK_PAGES } from './handbook/handbookPages.tsx';
import {
  NotificationSettings,
  notificationsSummaryCached,
  primeNotificationsSummary,
} from './NotificationSettings.tsx';
import { useConnect } from '../player/playbackSync.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { DeviceStorageSettings } from '../downloads/DeviceStorageSettings.tsx';
import { ServersSettings } from '../servers/ServersSettings.tsx';
import { knownServers } from '../servers/servers.ts';
import { heldCount, offlineSpace, onOfflineChange } from '../downloads/offline.ts';
import { useMediaQuery } from '../ux/useMediaQuery.ts';
import { formatBytes } from '../ux/format.ts';
import { Appearance } from './AppearancePane.tsx';
import { AccountPane } from './AccountPane.tsx';
import { General } from './GeneralPane.tsx';
import { Privacy, privacySummary } from './PrivacyPane.tsx';
import { useSharing } from '../profile/listeningShare.tsx';
import { sharePositionEnabled } from './behaviourPrefs.ts';
import { onlineMetadataEnabled } from './netPrefs.ts';
import { PlaybackSettings } from './PlaybackPane.tsx';
import { PluginsSettings } from './PluginsPane.tsx';
import { MobileSettings } from './MobileSettings.tsx';
import {
  accentLabel,
  MOBILE_QUERY,
  useSettingsIsModal,
  paneMatches,
  settingsGroupLabel,
  SettingsNavContext,
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
  const sharingWeek = useSharing();
  const { session } = useServerSession();
  const { connected, devices } = useConnect();
  const { all: allPlugins, isEnabled } = usePlugins();
  const { source, tracks } = useLibrary();

  const playbackBits = [
    pb.crossfade > 0 ? `Crossfade ${pb.crossfade}s` : null,
    pb.smartShuffle ? 'Shuffle manners' : null,
    pb.autoDj ? 'Auto DJ' : null,
    pb.nightMode ? 'Night mode' : null,
  ].filter(Boolean);
  const online = devices.filter((d) => d.online).length;
  const enabledPlugins = allPlugins.filter((p) => isEnabled(p.id)).length;
  // The rail's one-line reading of the vault. Subscribed rather than read once:
  // pinning happens from song menus while Settings is open behind them.
  const [offlineHeld, setOfflineHeld] = useState(() => heldCount());
  // Read straight from the ring rather than subscribed to: the modal
  // remounts on open, which is the only moment this summary is looked at.
  const diagCount = diagEntries().length;
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

  // Notifications' one-line reading lives on the server; a light fetch on open
  // fills the module cache and this tick makes the row re-read it. Until the
  // first answer lands the row keeps its worded fallback.
  const [, bumpNotifySummary] = useState(0);
  useEffect(() => {
    if (!open || !session) return;
    void primeNotificationsSummary(session).then((t) => {
      if (t) bumpNotifySummary((x) => x + 1);
    });
  }, [open, session]);

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
      id: 'playback',
      label: 'Playback',
      icon: <Play size={16} />,
      content: <PlaybackSettings />,
      summary: playbackBits.length > 0 ? playbackBits.slice(0, 2).join(' · ') : 'Standard playback',
      tint: 'pink',
      group: 0,
    },
    // Who you are, and everything attached to that: the servers saved to the
    // account, device pairing, the household, and the seats playing through
    // it. Gathered from the bottom of General and the Servers pane's Access
    // chunk, where the identity had smeared itself.
    {
      id: 'account',
      label: 'Account & devices',
      icon: <CircleUserRound size={16} />,
      content: <AccountPane />,
      // A session restored from before usernames were stored has an empty
      // one; "Signed in" beats a line that starts with a dot.
      summary: session
        ? [session.username || 'Signed in', online > 0 ? `${online} online` : null]
            .filter(Boolean)
            .join(' · ')
        : 'Not signed in',
      tint: 'blue',
      group: 1,
    },
    // The id stays `general` - it is the contract recency chips and deep
    // links hold - but the pane's one job now is the library itself.
    {
      id: 'general',
      label: 'Library',
      icon: <Library size={16} />,
      content: <General />,
      summary:
        source === 'server'
          ? `${tracks.length.toLocaleString()} songs from your server`
          : `${tracks.length.toLocaleString()} songs in your folder`,
      tint: 'slate',
      group: 1,
    },
    // The machine that listens along: the collector's ledger and switch, the
    // recent pulls, and how far the enrichment has read the library.
    // The curator's preferences moved into the Booth - they are the taste
    // engine's own, opened from its room, not a pane about an abstraction.
    {
      id: 'privacy',
      label: 'Privacy',
      icon: <Shield size={16} />,
      content: <Privacy />,
      // Counts what is switched OFF, because that is the number somebody who
      // came here to turn something off wants to see.
      summary: privacySummary(
        onlineMetadataEnabled(),
        pb.saveHistory,
        sharePositionEnabled(),
        sharingWeek,
      ),
      tint: 'blue',
      group: 1,
    },
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
      summary: session
        ? (notificationsSummaryCached() ?? 'What the app may interrupt you for')
        : 'Needs a server',
      tint: 'pink',
      group: 1,
    },
    // The machinery starts here: the boxes serving bytes, then whatever the
    // plugins have bolted on. Servers moved down beside them because a
    // dashboard and a mirror network are machinery, not daily stuff - the
    // things a listener touches weekly all sit in the cluster above.
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
      group: 2,
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
    // What broke, in the listener's own hands. Lives beside the handbook and
    // About because it is the same kind of page - reference, reached when
    // something has already gone wrong, never part of the daily loop.
    {
      id: 'diagnostics',
      label: 'Diagnostics',
      icon: <Stethoscope size={16} />,
      content: <DiagnosticsPane />,
      summary: diagCount > 0 ? `${diagCount} recent ${diagCount === 1 ? 'problem' : 'problems'}` : 'Nothing to report',
      tint: 'slate',
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
  // reset lands on the first section still showing.
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
    // First shown section wins; 'appearance' only covers the empty list a
    // no-match search leaves (the moment the query changes, ids[0] takes over).
    if (!ids.includes(tab)) setTab(ids[0] ?? 'appearance');
  }, [shownIds, tab]);
  // The chips are read once per open; opening a pane rewrites them.
  const noteTab = (id: string) => {
    const s = sections.find((x) => x.id === id);
    if (s) noteSettingsPane(id, s.label);
    setTab(id);
  };

  /*
   * The rail wears the touch list's rows.
   *
   * The two surfaces were showing the same sections in two different languages:
   * a full-screen list of tinted chips over a live one-line reading of each
   * section, and a rail of small grey glyphs and a bare word. Same settings,
   * same order, same data - `summary` and `tint` have been on every section all
   * along and only one surface was reading them.
   *
   * Done by handing the kit a rich `label` rather than by building a rail of
   * our own: TabbedModalSection.label is a ReactNode, so the row can carry the
   * chip and the summary while the kit keeps the parts worth keeping - roving
   * focus, the active state, and the id matching that drives the pane.
   *
   * The classes are the touch list's own, not copies of them. A second set of
   * chip tints would be a second place to change a colour.
   */
  const railSections = shown.map((s, i) => {
    // The cluster's name, carried by its first row: the kit renders a flat
    // rail, so the caption rides inside the label node rather than between
    // items. Suppressed while searching - a narrowed rail is one flat list.
    const startsGroup =
      !query.trim() && (i === 0 || (shown[i - 1]!.group ?? 99) !== (s.group ?? 99));
    const groupLabel = startsGroup ? settingsGroupLabel(s.group) : null;
    return {
      ...s,
      // The chip carries the glyph now, so the kit's own icon slot stays empty -
      // handing it the icon as well would print it twice.
      icon: undefined,
      label: (
        <span className="settingsRail__item">
          {groupLabel && <span className="settingsRail__groupLabel">{groupLabel}</span>}
          <span className="settingsRail__row">
            {s.icon ? (
              <span className="settingsScreen__rowIcon" data-tint={s.tint ?? 'slate'}>
                {s.icon}
              </span>
            ) : null}
            <span className="settingsScreen__rowText">
              <span className="settingsScreen__rowLabel">{s.label}</span>
              {s.summary && <span className="settingsScreen__rowSummary">{s.summary}</span>}
            </span>
          </span>
        </span>
      ),
    };
  });

  /*
   * Which shell this render gets: the full-screen sheet or the rail-beside-
   * pane modal. The whole decision - the room measurement, why it reads the
   * .appWindow box rather than the viewport, why the floor sits at 700 - lives
   * with useSettingsIsModal in settingsShared.ts; MOBILE_QUERY stays consulted
   * so a coarse pointer on a small screen gets the sheet before any
   * measurement has landed, rather than a flash of modal.
   */
  const mobile = useMediaQuery(MOBILE_QUERY);
  const asModal = useSettingsIsModal(open);
  if (mobile || !asModal) {
    return <MobileSettings open={open} onClose={onClose} sections={sections} initialId={pane ?? null} />;
  }

  return (
    <SettingsNavContext.Provider value={noteTab}>
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
      sections={railSections}
    />
    </SettingsNavContext.Provider>
  );
}
