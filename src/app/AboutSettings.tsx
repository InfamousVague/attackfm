import { Button, Pill, Text } from '@glacier/react';
import { Cloud, ExternalLink, Laptop, Music, RefreshCw, Smartphone } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { APP_VERSION, SHELL_VERSION } from './version.ts';
import wordmark from '../assets/attack-white.png';
import { openExternal } from './openExternal.ts';
import { isDesktopApp, isIOS } from './platform.ts';
import { fetchServerStats, type ServerStats } from './server.ts';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { isTauri } from './tauri.ts';
import {
  applyStagedBundle,
  checkForUpdate,
  stagedBundle,
  watchBundle,
  type UpdateCheckOutcome,
} from './appUpdate.ts';

const REPO_URL = 'https://github.com/InfamousVague/attackfm';

/** "2d 4h" / "3h 12m" / "45m" - the shape uptime is read at a glance. */
function uptimeLabel(secs: number): string {
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  const minutes = Math.floor((secs % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * About: what this build is, where it is running, and what it is connected
 * to - the once-a-month pane that answers "what version am I on?" without a
 * trip to the terminal.
 */
export function AboutSettings() {
  const { session } = useServerSession();
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
    if (!session || checking) return;
    setChecking(true);
    setOutcome(null);
    try {
      setOutcome(await checkForUpdate(session));
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
        <img className="aboutHero__mark" src={wordmark} alt="AttackFM" />
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

      <div className="prefsSection">
        <div className="aboutRows">
          {rows.map((row) => (
            <div key={row.id} className="aboutRow">
              <span className="aboutRow__icon" aria-hidden="true">
                {row.icon}
              </span>
              <span className="aboutRow__label">{row.label}</span>
              <span className="aboutRow__value">{row.value}</span>
            </div>
          ))}
        </div>
        <div className="prefsActions">
          <Button variant="outline" size="sm" onClick={() => void openExternal(REPO_URL)}>
            Source on GitHub <ExternalLink size={12} />
          </Button>
        </div>
      </div>

      {/* Updates, out loud. The automatic check still runs on its own clock;
          this is the hand on the handle - and the place a failure finally has
          to explain itself instead of leaving the device silently stale. */}
      {isTauri() && (
        <div className="prefsSection">
          <div className="aboutRows">
            <div className="aboutRow">
              <span className="aboutRow__icon" aria-hidden="true">
                <RefreshCw size={16} />
              </span>
              <span className="aboutRow__label">Updates</span>
              <span className="aboutRow__value">
                {staged
                  ? `v${staged} is ready — restart to apply`
                  : `from ${session ? session.url.replace(/^https?:\/\//, '') : 'your server'}`}
              </span>
            </div>
          </div>
          {outcome && !staged && (
            <Text tone={outcome.state === 'error' ? 'danger' : 'muted'} size="sm">
              {outcome.state === 'current'
                ? `You're on the latest (v${outcome.version}).`
                : outcome.state === 'staged'
                  ? `v${outcome.version} downloaded.`
                  : outcome.why}
            </Text>
          )}
          <div className="prefsActions">
            {staged ? (
              <Button variant="solid" size="sm" onClick={() => applyStagedBundle()}>
                Restart and update
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void check()}
                disabled={checking || !session}
              >
                <RefreshCw size={12} /> {checking ? 'Checking…' : 'Check for updates'}
              </Button>
            )}
          </div>
          {!session && (
            <Text tone="subtle" size="xs">
              Sign into a server to check for updates — it is where they come from.
            </Text>
          )}
        </div>
      )}

      <Text tone="subtle" size="xs">
        Lyrics from LRCLIB · album art lookups via the iTunes Search API · downloads
        by SpotiFLAC. All of it optional, all of it switchable in these settings.
      </Text>
    </div>
  );
}
