import { Button, Pill, StatusDot, Text } from '@glacier/react';
import { PaneSection, SettingRow, SettingsFootnote } from './kit/settingsKit.tsx';
import { Cloud, ExternalLink, Laptop, Music, RefreshCw, Smartphone } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { WhatsNew } from './WhatsNew.tsx';
import { APP_VERSION, SHELL_VERSION } from '../core/version.ts';
import wordmark from '../../assets/attack-white.png';
import { openExternal } from '../core/openExternal.ts';
import { isDesktopApp, isIOS } from '../core/platform.ts';
import { fetchServerStats, type ServerStats } from '../server.ts';
import { uptimeLabel } from '../servers/serverFormat.ts';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useNetworkHealth } from '../servers/NetworkDot.tsx';
import { isTauri } from '../core/tauri.ts';
import {
  applyStagedBundle,
  checkForUpdate,
  stagedBundle,
  watchBundle,
  type UpdateCheckOutcome,
} from './appUpdate.ts';

const REPO_URL = 'https://github.com/InfamousVague/attackfm';

/**
 * About: what this build is, where it is running, and what it is connected
 * to - the once-a-month pane that answers "what version am I on?" without a
 * trip to the terminal.
 */
export function AboutSettings() {
  const { session } = useServerSession();
  // The reading that used to be a light in the header on every page.
  const net = useNetworkHealth();
  const { tracks } = useLibrary();
  const [stats, setStats] = useState<ServerStats | null>(null);

  // The update controls: what is staged (kept live through watchBundle, so a
  // background check landing while this pane is open updates the row), whether
  // a manual check is in flight, and how the last one ended. The outcome is
  // ALWAYS shown - this pane exists because every failure in the update chain
  // used to be silent, and four releases went out that no device ever saw.
  const [staged, setStaged] = useState<string | null>(stagedBundle());
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<UpdateCheckOutcome | null>(null);
  useEffect(() => watchBundle(() => setStaged(stagedBundle())), []);
  const check = async () => {
    if (checking) return;
    setChecking(true);
    setOutcome(null);
    try {
      setOutcome(await checkForUpdate());
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (!session) {
      setStats(null);
      return;
    }
    let live = true;
    fetchServerStats(session)
      .then((s) => {
        if (live) setStats(s);
      })
      .catch(() => {
        // An older server without /api/stats: the pane just shows less.
      });
    return () => {
      live = false;
    };
  }, [session]);

  const platform = isIOS ? 'iOS' : isDesktopApp ? 'Desktop' : isTauri() ? 'Tauri' : 'Web';
  const PlatformGlyph = isIOS ? Smartphone : Laptop;
  const hours = Math.round(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0) / 3600);

  // Keyed by a stable id, not the label: a server named "AttackFM" (the
  // shipped default) would otherwise collide with the app row's key.
  const rows: { id: string; icon: React.ReactNode; label: string; value: string }[] = [
    { id: 'app', icon: <Music size={16} />, label: 'AttackFM', value: `v${APP_VERSION} · ${platform}` },
    // The shell is the installed binary - the number that only a store or a
    // sideload moves. Shown on device so "the app updated but this says the
    // old number" stops being a mystery: the frontend and the shell are
    // allowed to differ, and here are both.
    ...(isTauri() && SHELL_VERSION !== APP_VERSION
      ? [
          {
            id: 'shell',
            icon: <PlatformGlyph size={16} />,
            label: 'App shell',
            value: `v${SHELL_VERSION} · updates with an install`,
          },
        ]
      : []),
    ...(session
      ? [
          {
            id: 'server',
            icon: <Cloud size={16} />,
            // The shipped default server name is "AttackFM", so an
            // unnamed hub drew a SECOND row called AttackFM carrying the
            // server's own version - which reads as the app reporting the
            // wrong one. A named server keeps its name; the default one
            // says what it is.
            label: stats?.name && stats.name !== 'AttackFM' ? stats.name : 'Server',
            value: [
              stats ? `v${stats.version}` : null,
              stats ? `up ${uptimeLabel(stats.uptimeSecs)}` : null,
              session.url.replace(/^https?:\/\//, ''),
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ]
      : []),
    // Directly under the server it describes, because it is a fact ABOUT that
    // server rather than a separate subject. This is the whole of what the
    // header dot used to say, in the place somebody goes to ask.
    ...(net
      ? [
          {
            id: 'connection',
            icon: <StatusDot tone={net.tone} pulse={net.ok === true} size="sm" />,
            label: 'Connection',
            value: [
              net.label,
              net.mirrors > 0
                ? `${net.mirrors} ${net.mirrors === 1 ? 'mirror' : 'mirrors'} standing by`
                : null,
              net.otherDevices > 0
                ? `${net.otherDevices} other ${net.otherDevices === 1 ? 'device' : 'devices'}`
                : null,
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ]
      : []),
    {
      id: 'library',
      icon: <PlatformGlyph size={16} />,
      label: 'Library',
      value: `${tracks.length.toLocaleString()} songs · about ${hours.toLocaleString()} ${hours === 1 ? 'hour' : 'hours'} of music`,
    },
  ];

  return (
    <div className="prefsBody">
      <div className="aboutHero">
        <img
          className="aboutHero__mark"
          src={wordmark}
          alt="AttackFM"
          draggable={false}
        />
        <Text tone="muted" size="sm">
          Your music, on your machines. Nothing rented, nothing shared.
        </Text>
        <div className="aboutHero__pills">
          <Pill size="sm" tone="accent">
            v{APP_VERSION}
          </Pill>
          <Pill size="sm" tone="neutral">
            {platform}
          </Pill>
        </div>
      </div>

      <PaneSection title="This build">
        {rows.map((row) => (
          <SettingRow
            key={row.id}
            icon={<span className="aboutRow__icon" aria-hidden="true">{row.icon}</span>}
            label={row.label}
            value={row.value}
          />
        ))}
        <div className="setk-row">
          <div className="prefsActions">
            <Button variant="outline" size="sm" onClick={() => void openExternal(REPO_URL)}>
              Source on GitHub <ExternalLink size={12} />
            </Button>
          </div>
        </div>
      </PaneSection>

      {/* Updates, out loud. The automatic check still runs on its own clock;
          this is the hand on the handle - and the place a failure finally has
          to explain itself instead of leaving the device silently stale. */}
      {isTauri() && (
        <PaneSection
          title="Updates"
          footer={
            outcome && !staged ? (
              <Text tone={outcome.state === 'error' ? 'danger' : 'muted'} size="sm">
                {outcome.state === 'current'
                  ? `You're on the latest (v${outcome.version}).`
                  : outcome.state === 'staged'
                    ? `v${outcome.version} downloaded.`
                    : outcome.why}
              </Text>
            ) : undefined
          }
        >
          <SettingRow
            icon={<span className="aboutRow__icon" aria-hidden="true"><RefreshCw size={16} /></span>}
            label="Updates"
            hint={staged ? `v${staged} is ready — restart to apply` : 'from attack.fm'}
            control={
              staged ? (
                <Button variant="solid" size="sm" onClick={() => applyStagedBundle()}>
                  Restart and update
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void check()} disabled={checking}>
                  <RefreshCw size={12} /> {checking ? 'Checking…' : 'Check for updates'}
                </Button>
              )
            }
          />
        </PaneSection>
      )}

      {/* The release history the update banner only ever showed one page of. */}
      <WhatsNew />

      <SettingsFootnote>
        Lyrics from LRCLIB · album art lookups via the iTunes Search API. All of it optional, all
        of it switchable in these settings.
      </SettingsFootnote>
    </div>
  );
}
