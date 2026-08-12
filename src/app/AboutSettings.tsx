import { Button, Pill, Text } from '@glacier/react';
import { Cloud, ExternalLink, Laptop, Music, Smartphone } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { APP_VERSION } from './version.ts';
import wordmark from '../assets/attack-white.png';
import { openExternal } from './openExternal.ts';
import { isDesktopApp, isIOS } from './platform.ts';
import { fetchServerStats, type ServerStats } from './server.ts';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { isTauri } from './tauri.ts';

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

      <Text tone="subtle" size="xs">
        Lyrics from LRCLIB · album art lookups via the iTunes Search API · downloads
        by SpotiFLAC. All of it optional, all of it switchable in these settings.
      </Text>
    </div>
  );
}
