import { Button, Pill, StatusDot, Text, useToast } from '@glacier/react';
import { PaneSection, SettingRow, SettingsFootnote } from './kit/settingsKit.tsx';
import { Cloud, ExternalLink, Laptop, Music, RefreshCw, Smartphone } from '@glacier/icons';
import { useContext, useEffect, useState } from 'react';
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
import { developerModeEnabled, setDeveloperMode } from './developerMode.ts';
import { SettingsNavContext } from './settingsShared.ts';
import { fireNativeHaptic } from '../core/haptics.ts';
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
/*
 * The knock counter, at module scope rather than in a ref.
 *
 * Seventeen presses on the wordmark turn developer mode on. The count lives
 * here and not in a ref or state because the original (seven presses, for the
 * card lab - 9e0840f) was first written with a useRef and the door never
 * opened: both shells can mount AboutSettings, the sections array is rebuilt
 * every render so `content: <AboutSettings/>` is a fresh element each time,
 * and a ref identity was not the one the handler closed over. Module scope is
 * the only identity that survives.
 *
 * The run resets when the gap since the previous press exceeds KNOCK_GAP_MS,
 * so an idle finger cannot arrive at seventeen by accident across a week; and
 * the mark gives no sign of it - no cursor, no hint - because the point of a
 * knock is that you have to know.
 */
const KNOCKS_WANTED = 17;
const KNOCK_GAP_MS = 900;
/** From this many presses in, the toast counts down - the same tell Android's
 *  own developer options give, so somebody who knows the gesture knows it is
 *  working, and somebody who does not gets a puzzle rather than nothing. */
const KNOCK_HINT_FROM = 10;
let knocks = 0;
let lastKnock = 0;

/** Counts a press; returns how many remain, 0 on the press that completes the run. */
function countKnock(): number {
  const now = Date.now();
  knocks = now - lastKnock > KNOCK_GAP_MS ? 1 : knocks + 1;
  lastKnock = now;
  if (knocks < KNOCKS_WANTED) return KNOCKS_WANTED - knocks;
  knocks = 0;
  return 0;
}

export function AboutSettings() {
  const { toast } = useToast();
  const goTo = useContext(SettingsNavContext);
  const knock = () => {
    const left = countKnock();
    if (left === 0) {
      const already = developerModeEnabled();
      setDeveloperMode(true);
      fireNativeHaptic('success');
      toast({ message: already ? 'Developer mode is already on' : 'Developer mode on', duration: 1800 });
      // Land on the page that just appeared, rather than leaving the person
      // to find a new row under About. A no-op if no shell provided the nav.
      goTo?.('developer');
      return;
    }
    if (left <= KNOCKS_WANTED - KNOCK_HINT_FROM) {
      // The toast replaces itself on each press (latest wins), which is exactly
      // the behaviour a countdown wants.
      toast({ message: `${left} more ${left === 1 ? 'tap' : 'taps'} to developer mode`, duration: 1200 });
    }
  };
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
          onClick={knock}
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
