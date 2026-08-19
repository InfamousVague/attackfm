import {
  Avatar,
  Banner,
  Button,
  Field,
  Meter,
  Pill,
  ProgressBar,
  SegmentedControl,
  Slider,
  StatTile,
  StatusDot,
  Text,
} from '@glacier/react';
import {
  Activity,
  Database,
  HardDrive,
  Music,
  RefreshCw,
  Server,
  Users,
} from '@glacier/icons';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchScanStatus,
  fetchServerStats,
  type ScanStatus,
  type ServerStats,
} from '../server.ts';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from './serverSession.tsx';
import { gbLabel, uptimeLabel } from './serverFormat.ts';
import { UsersSection } from './ServerUsers.tsx';
import { BackgroundWork } from './BackgroundWork.tsx';
import { UploadSection } from './ServerUpload.tsx';

/** The signed-in status board: who and where, the numbers, the disk, and the
 * controls - a dashboard, not a form. */
export function Connected() {
  const { session, settings, updateSettings, disconnect } = useServerSession();
  const { tracks, indexing, rescan, error } = useLibrary();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [stats, setStats] = useState<ServerStats | null>(null);

  // The dashboard numbers: one call on arrival, refreshed when a scan lands
  // (that is the moment the totals change). An older server without the
  // endpoint just shows the scan-status numbers instead.
  const refreshStats = useCallback(() => {
    if (!session) return;
    fetchServerStats(session)
      .then(setStats)
      .catch(() => {});
  }, [session]);
  useEffect(() => refreshStats(), [refreshStats]);

  // The server's own indexing progress, polled only while it is working - a
  // status board that keeps a phone's radio awake to say "idle" is worse than
  // one that goes quiet. The poll self-clears once the server reports idle, so
  // "Rescan & sync" bumps `scanNonce` to arm a fresh one - without it, a scan
  // started after the first idle reading would run invisibly. When a watched
  // walk ends, the dashboard numbers are re-fetched: that is the moment the
  // totals actually change.
  const [scanNonce, setScanNonce] = useState(0);
  useEffect(() => {
    if (!session) return;
    let live = true;
    let sawRunning = false;
    const poll = async () => {
      try {
        const next = await fetchScanStatus(session);
        if (live) setStatus(next);
        if (next.running) sawRunning = true;
        else if (sawRunning) {
          // The walk this poll watched has finished; the tiles are stale.
          sawRunning = false;
          refreshStats();
        }
        return next.running;
      } catch {
        return false;
      }
    };
    // A freshly-kicked walk may not report running on the first tick or two,
    // so the poll holds on through a short idle grace before going quiet.
    let idleTicks = 0;
    void poll();
    const interval = window.setInterval(() => {
      void poll().then((running) => {
        idleTicks = running ? 0 : idleTicks + 1;
        if (!running && idleTicks >= 3) window.clearInterval(interval);
      });
    }, 2000);
    return () => {
      live = false;
      window.clearInterval(interval);
    };
  }, [session, scanNonce, refreshStats]);

  if (!session) return null;

  const trackCount = stats?.tracks ?? status?.tracks ?? tracks.length;
  const sizeLabel = stats?.bytesLabel ?? status?.bytesLabel ?? null;
  const scanning = status?.running ?? false;

  // Disk: used fraction of the volume the music lives on. High is the bad
  // direction here, so the tone is graded by hand rather than Meter's
  // health-bar 'auto' (which reads LOW as the danger).
  const disk =
    stats?.diskTotalBytes != null && stats.diskFreeBytes != null && stats.diskTotalBytes > 0
      ? {
          total: stats.diskTotalBytes,
          free: stats.diskFreeBytes,
          usedFraction: (stats.diskTotalBytes - stats.diskFreeBytes) / stats.diskTotalBytes,
        }
      : null;
  const diskTone = disk === null ? 'accent' : disk.usedFraction > 0.9 ? 'danger' : disk.usedFraction > 0.7 ? 'warning' : 'accent';

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <div className="serverHero">
          <span className="serverHero__glyph" aria-hidden="true">
            <Server size={22} />
          </span>
          <div className="serverHero__meta">
            <span className="serverHero__name">
              <Text weight="semibold">{stats?.name ?? 'Connected'}</Text>
              {stats && (
                <Pill size="sm" tone="neutral">
                  v{stats.version}
                </Pill>
              )}
            </span>
            <span className="serverHero__status">
              <StatusDot tone={scanning ? 'warning' : 'success'} pulse size="sm" />
              <Text size="sm" tone="muted">
                {session.url.replace(/^https?:\/\//, '')}
                {stats ? ` · up ${uptimeLabel(stats.uptimeSecs)}` : ''}
              </Text>
            </span>
          </div>
          <span className="serverHero__who">
            <Avatar name={session.username} size="sm" />
            <span className="serverHero__whoText">
              <Text size="sm" weight="medium">
                {session.username}
              </Text>
              {session.isAdmin && (
                <Pill size="sm" tone="accent">
                  Owner
                </Pill>
              )}
            </span>
          </span>
        </div>

        <div className="serverStats">
          <StatTile icon={<Music size={16} />} value={trackCount.toLocaleString()} label="Songs" />
          <StatTile icon={<Database size={16} />} value={sizeLabel ?? '—'} label="Library size" />
          <StatTile
            icon={<Users size={16} />}
            value={stats ? String(stats.users) : '—'}
            label={stats?.users === 1 ? 'Listener' : 'Listeners'}
          />
          <StatTile
            icon={<Activity size={16} />}
            value={
              stats
                ? stats.importsActive + stats.importsQueued > 0
                  ? `${stats.importsActive + stats.importsQueued}`
                  : 'Idle'
                : '—'
            }
            label="Import queue"
          />
        </div>

        {disk && (
          <div className="serverDisk">
            <span className="serverDisk__head">
              <HardDrive size={14} aria-hidden="true" />
              <Text size="sm" weight="medium">
                Disk
              </Text>
              <Text size="sm" tone="muted" className="serverDisk__free">
                {gbLabel(disk.free)} free of {gbLabel(disk.total)}
              </Text>
            </span>
            <Meter
              aria-label="Disk used"
              value={Math.round(disk.usedFraction * 100)}
              max={100}
              segments={20}
              size="sm"
              tone={diskTone}
            />
            {sizeLabel && (
              <Text size="xs" tone="subtle">
                The library itself is {sizeLabel}
                {stats && stats.quotaBytes > 0 ? ` of a ${gbLabel(stats.quotaBytes)} quota` : ''}.
              </Text>
            )}
          </div>
        )}

        {error && <Banner tone="danger">{error}</Banner>}
        {status?.running && (
          <>
            <Text tone="muted" size="sm">
              Server is indexing {status.seen.toLocaleString()} of {status.total.toLocaleString()}…
            </Text>
            <ProgressBar value={status.total > 0 ? (status.seen / status.total) * 100 : 0} />
          </>
        )}
        <div className="prefsActions">
          <Button
            variant="outline"
            size="sm"
            disabled={indexing}
            onClick={() => {
              // Re-arm the scan poll (it goes quiet on an idle server) so the
              // progress bar appears; the poll refreshes the tiles when the
              // walk it watched actually finishes.
              setScanNonce((n) => n + 1);
              void rescan();
            }}
          >
            <RefreshCw size={14} /> {indexing ? 'Syncing…' : 'Rescan & sync'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
            Sign out
          </Button>
        </div>
      </div>

      {/* Household, Link a device and Mirrors moved out to their own chunks of
          the Servers pane (ServersSettings) - this section is now only the box
          you are signed into. */}
      {session.isAdmin && <BackgroundWork />}
      {session.isAdmin && <UsersSection />}

      <div className="prefsSection">
        <Field
          label="Streaming quality"
          hint={
            settings.quality === 'lossless'
              ? 'Sends the original file, byte for byte. No re-encoding, and no work for the server.'
              : 'Re-encodes on the fly to save data. Costs the server a CPU core per listener.'
          }
        >
          <SegmentedControl
            aria-label="Streaming quality"
            value={settings.quality}
            onValueChange={(next) => updateSettings({ quality: next as 'lossless' | 'transcode' })}
            options={[
              { value: 'lossless', label: 'Lossless' },
              { value: 'transcode', label: 'Data saver' },
            ]}
          />
        </Field>
        {settings.quality === 'transcode' && (
          <div className="prefsSliderRow">
            <Slider
              aria-label="Bitrate"
              min={96}
              max={320}
              step={32}
              value={settings.bitrate}
              onValueChange={(next) => updateSettings({ bitrate: next })}
            />
            <Text size="sm" tone="muted" mono className="prefsSliderValue">
              {settings.bitrate}k
            </Text>
          </div>
        )}
      </div>

      <UploadSection />
    </div>
  );
}
