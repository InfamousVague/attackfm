import {
  AlertDialog,
  Avatar,
  Banner,
  Button,
  IconButton,
  Field,
  Input,
  Label,
  Meter,
  Pill,
  ProgressBar,
  SegmentedControl,
  Slider,
  Spinner,
  StatTile,
  StatusDot,
  Text,
  Switch,
} from '@glacier/react';
import {
  Activity,
  Check,
  Cloud,
  Copy,
  Database,
  HardDrive,
  KeyRound,
  Music,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from '@glacier/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteUser,
  fetchScanStatus,
  fetchServerInfo,
  fetchServerStats,
  fetchUsers,
  register,
  pairStart,
  revokeUserStreams,
  uploadFile,
  type ScanStatus,
  type ServerInfo,
  type ServerStats,
  type ServerUser,
} from '../server.ts';
import { forgetProfile, otherProfiles, type Profile } from './household.ts';
import {
  fetchMirrorStatus,
  normalizeServerUrl,
  fetchHotSummary,
  startMirror,
  type HotBar,
  type MirrorStatus,
} from '../server.ts';
import { pairPayload } from './pairing.ts';
import { useLibrary } from '../library/library.tsx';
import { useLibrarySync } from '../library/librarySync.tsx';
import { useServerSession } from './serverSession.tsx';
import {
  authorizeMirrorSource,
  readMirrorSource,
  revokeMirrorSource,
} from './mirrorSource.ts';
import { isTauri } from '../core/tauri.ts';
import QRCode from 'qrcode';
import { Smartphone } from '@glacier/icons';

/**
 * The Server pane: point the app at a music server, sign in, and choose how
 * the music should arrive.
 *
 * Signed out, this is a connect form that probes the address first - so a
 * fresh server offers to make its first account, and a set-up one asks to be
 * signed into. Signed in, it is a status board: what the library holds, how the
 * last sync went, and the one control that actually changes what is heard -
 * lossless bytes or a re-encode.
 */
export function ServerSettings() {
  const { session, restoring } = useServerSession();
  if (restoring) {
    return (
      <div className="prefsBody">
        <div className="prefsSection">
          <Spinner size="sm" /> <Text tone="muted">Reconnecting…</Text>
        </div>
      </div>
    );
  }
  return session ? <Connected /> : <ConnectForm />;
}

/** The sign-in / first-run form. */
function ConnectForm() {
  const { connect } = useServerSession();
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The address is probed as it settles, so the form can say what it found
  // before anything is typed into the credential fields - a fresh server needs
  // its first account made, an established one needs a sign-in, and a
  // mistyped address should say so here rather than after a password.
  const probeTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(probeTimer.current);
    setInfo(null);
    setError(null);
    const origin = normalizeServerUrl(url);
    if (!origin) return;
    const controller = new AbortController();
    probeTimer.current = window.setTimeout(() => {
      setProbing(true);
      void fetchServerInfo(origin, controller.signal)
        .then((found) => setInfo(found))
        .catch(() => setError('No AttackFM server answered at that address.'))
        .finally(() => setProbing(false));
    }, 600);
    return () => {
      window.clearTimeout(probeTimer.current);
      controller.abort();
    };
  }, [url]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const origin = normalizeServerUrl(url);
      // A server with no accounts makes the first visitor its admin; that is
      // the one moment registration is open, so the form does it inline rather
      // than sending somebody to a separate setup screen.
      if (info?.needsSetup) await register(origin, username, password);
      await connect(origin, username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect');
    } finally {
      setBusy(false);
    }
  };

  const ready = !!info && username.trim().length > 0 && password.length > 0 && !busy;

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Field
          label="Server address"
          hint="Where your music server is reachable, e.g. music.example.com."
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            placeholder="music.example.com"
            aria-label="Server address"
            leadingIcon={<Cloud size={16} />}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
        </Field>
        {probing && (
          <Text tone="muted" size="sm">
            Looking for a server…
          </Text>
        )}
        {info && (
          <Banner tone={info.needsSetup ? 'warning' : 'success'}>
            {info.needsSetup
              ? `${info.name} has no accounts yet — the details below will create the owner account.`
              : `Found ${info.name} · ${info.tracks.toLocaleString()} tracks`}
          </Banner>
        )}
      </div>

      <div className="prefsSection">
        <Field label={info?.needsSetup ? 'Choose a username' : 'Username'}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            aria-label="Username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
          />
        </Field>
        <Field
          label={info?.needsSetup ? 'Choose a password' : 'Password'}
          hint={info?.needsSetup ? 'At least 8 characters.' : undefined}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            aria-label="Password"
            autoComplete={info?.needsSetup ? 'new-password' : 'current-password'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) void submit();
            }}
          />
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="prefsActions">
          <Button variant="solid" size="sm" disabled={!ready} onClick={() => void submit()}>
            {busy ? 'Connecting…' : info?.needsSetup ? 'Create account & connect' : 'Connect'}
          </Button>
        </div>
      </div>

      <NoServerYet />
    </div>
  );
}

/** The one-liner that stands a server up. */
const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/InfamousVague/attackfm/main/server/install.sh | sudo sh';

/**
 * What to do when you have no server at all.
 *
 * Everyone who uses AttackFM runs their own — the library is your own files on
 * your own machine, not a service anyone else is on — so "where do I get one"
 * is the first question a new listener has, and the connect form above assumes
 * it is already answered. This answers it, in place, rather than sending
 * somebody to a README they would have to go find.
 *
 * Collapsed by default: it is the wrong thing to lead with for the far more
 * common case of somebody adding their second device.
 */
function NoServerYet() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard the platform will not give up is not worth an error: the
      // command is on screen and can be typed.
    }
  };

  return (
    <div className="prefsSection">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Server size={14} /> {open ? "Hide setup" : "I don't have a server yet"}
      </Button>

      {open && (
        <div className="serverSetup">
          <Text tone="muted" size="sm">
            AttackFM plays music you own, from a machine you own. The server is a
            single program you run on a spare computer, a NAS, or a cheap VPS — it
            indexes a folder of music and streams it to your devices. Nobody else
            is on it and nothing leaves your machine.
          </Text>

          <Label>1 · Run this on that machine</Label>
          <div className="serverSetupCommand">
            <code>{INSTALL_COMMAND}</code>
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <Text tone="muted" size="sm">
            It asks where your music lives and whether you have a domain, then sets
            everything up. With a domain it gets an HTTPS certificate automatically
            so you can listen anywhere; without one it works on your home network.
          </Text>

          <Label>2 · Enter the address it prints</Label>
          <Text tone="muted" size="sm">
            The installer finishes by showing the address to type into the field
            above. The first account you create becomes the owner.
          </Text>

          <Label>3 · Add your music</Label>
          <Text tone="muted" size="sm">
            Point the installer at a folder you already have, or upload from the
            desktop app once you are connected — files are filed by their own tags
            and indexed as they arrive.
          </Text>
        </div>
      )}
    </div>
  );
}

/** "2d 4h" / "3h 12m" / "45m" - uptime at a glance. */
function uptimeLabel(secs: number): string {
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  const minutes = Math.floor((secs % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function gbLabel(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** The signed-in status board: who and where, the numbers, the disk, and the
 * controls - a dashboard, not a form. */
/**
 * Link a device: mints a one-time code on the server this device is signed into
 * and shows it as a QR (and as text). A phone reads it - camera or typed - and
 * gets its own session with no password, the whole point being that nobody taps
 * a password into a phone. The code is short-lived; a countdown says so, and a
 * button mints a fresh one when it lapses.
 */
export function LinkDeviceSection() {
  const { session } = useServerSession();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { code, expiresIn } = await pairStart(session);
      const dataUrl = await QRCode.toDataURL(pairPayload(session.url, code), {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
        color: { dark: '#000000ff', light: '#ffffffff' },
      });
      setCode(code);
      setQr(dataUrl);
      setLeft(expiresIn);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a code');
    } finally {
      setBusy(false);
    }
  }, [session]);

  // Count the code down to its expiry; a lapsed code stays on screen but greys
  // out, so the QR never silently becomes one that will be refused.
  useEffect(() => {
    if (left <= 0) return;
    const id = window.setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [left]);

  const expired = code !== null && left <= 0;

  return (
    <div className="prefsSection">
      <Field
        label="Link a device"
        hint="Sign a phone in without typing a password: show a one-time code here and scan or enter it on the phone."
      >
        {!open ? (
          <div className="prefsActions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(true);
                void mint();
              }}
            >
              <Smartphone size={14} /> Link a device
            </Button>
          </div>
        ) : (
          <div className="linkDevice">
            {qr && (
              <img
                className="linkDevice__qr"
                src={qr}
                alt="Pairing QR code"
                data-expired={expired || undefined}
              />
            )}
            {code && (
              <div className="linkDevice__code" aria-label="Pairing code">
                {code.length === 6 ? code.replace(/(.{3})(.{3})/, '$1 $2') : code}
              </div>
            )}
            {error && <Banner tone="danger">{error}</Banner>}
            <Text tone="muted" size="sm">
              {expired
                ? 'This code has expired.'
                : busy
                  ? 'Making a code…'
                  : `On the phone, open the sign-in screen → “Log in with a code”. Expires in ${left}s.`}
            </Text>
            <div className="prefsActions">
              <Button variant={expired ? 'solid' : 'ghost'} size="sm" disabled={busy} onClick={() => void mint()}>
                <RefreshCw size={14} /> New code
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Field>
    </div>
  );
}

function Connected() {
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

/**
 * Account management, owner only - the client half of `/api/users`, which
 * until now existed with no UI at all.
 *
 * Three verbs, matching the server exactly: add a listener (registration is
 * admin-only past the first account), sign a listener's devices out
 * everywhere (revoke), and delete the account. Deletion confirms through an
 * AlertDialog because it is the one irreversible thing on this pane.
 */
/**
 * Copying one library into another.
 *
 * Two steps, because the app signs into one server at a time and a copy needs
 * both. While you are on the library you want to COPY FROM you authorize it,
 * which keeps its address and tokens on this device; then you sign into the
 * library you want to FILL and start the copy there. The destination does the
 * pulling, so the source needs nothing done to it - no new port, no visit.
 */
export function MirrorSection() {
  const { session } = useServerSession();
  const [source, setSource] = useState(() => readMirrorSource());
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);

  // Carrying only the listened-to set. Default ON: a server you are filling
  // from somewhere else is nearly always the smaller box, and offering to
  // copy a library that will not fit is offering a job that ends badly.
  const [hotOnly, setHotOnly] = useState(true);
  const [hotSummary, setHotSummary] = useState<{
    bars: HotBar[];
    liked: number;
    libraryTracks: number;
  } | null>(null);
  const hotSize = hotSummary?.bars.find((b) => b.minPlays === 2) ?? null;



  // Only while something is running: a poll that never stops is a poll that
  // wakes a sleeping phone for nothing.
  useEffect(() => {
    if (!session) return;
    let live = true;
    const tick = () => {
      void fetchMirrorStatus(session)
        .then((s) => {
          if (live) setStatus(s);
        })
        .catch(() => {
          // An older server with no mirror endpoint: the section simply offers
          // nothing rather than showing an error nobody can act on.
          if (live) setStatus(null);
        });
    };
    tick();
    const id = window.setInterval(tick, 4000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [session]);

  if (!session) return null;
  const here = source?.url === session.url;

  // Ask the SOURCE how big its listened-to set is, so the size is visible
  // before the copy rather than discovered during it. Best-effort: an older
  // source has no such endpoint and the switch simply describes itself.
  useEffect(() => {
    if (!source || here || !hotOnly) return;
    let live = true;
    void fetchHotSummary(source)
      .then((s) => {
        if (live) setHotSummary(s);
      })
      .catch(() => {
        if (live) setHotSummary(null);
      });
    return () => {
      live = false;
    };
  }, [source, here, hotOnly]);
  const running = status?.running === true;

  return (
    <div className="prefsSection">
      <Label>Copy a library</Label>

      {/* Half one: authorize the library you are standing in as a source. */}
      <Text tone="muted" size="sm">
        {here
          ? 'This library is authorized to be copied. Sign into the server you want to fill, and start the copy there.'
          : 'Authorize this library so another server can copy from it. The other server does the work — nothing has to change here.'}
      </Text>
      <div className="prefsActions">
        <Button
          variant={here ? 'ghost' : 'soft'}
          size="sm"
          onClick={() => setSource(authorizeMirrorSource(session, session.url))}
        >
          {here ? 'Re-authorize this library' : 'Authorize this library'}
        </Button>
        {source && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              revokeMirrorSource();
              setSource(null);
              setShowKeys(false);
            }}
          >
            Revoke
          </Button>
        )}
      </div>

      {/* Half two: on a DIFFERENT server, offer to pull the authorized one in. */}
      {source && !here && (
        <>
          <Text size="sm">
            Ready to copy from <strong>{source.name}</strong> ({source.username}).
          </Text>
          {!session.isAdmin && (
            <Text tone="muted" size="xs">
              Only the owner of this server can fill it.
            </Text>
          )}
          {/* Everything, or only what gets listened to.

              The second is what a server on the internet is usually for: it
              has a fraction of the disk a hub at home does, and the songs you
              actually play are a fraction of the library. The set sizes
              itself against this box's free space, so the choice here is
              about WHAT to carry, not how much. */}
          <div className="mirrorScope">
            <Switch
              label="Only songs I actually listen to"
              checked={hotOnly}
              onCheckedChange={setHotOnly}
            />
            {hotOnly && (
              <Text tone="muted" size="xs">
                {hotSize
                  ? `About ${hotSize.tracks.toLocaleString()} songs (${gbLabel(hotSize.bytes)}) of ${(
                      hotSummary?.libraryTracks ?? 0
                    ).toLocaleString()} — played twice or more, plus anything liked. Whatever will not fit is left behind, coldest first, and songs that go cold later are let go so this stays a working set rather than filling up again.`
                  : 'Played twice or more, plus anything liked. Songs that go cold are let go.'}
              </Text>
            )}
          </div>
          <div className="prefsActions">
            <Button
              variant="solid"
              size="sm"
              disabled={busy || running || !session.isAdmin}
              onClick={() => {
                setBusy(true);
                setNote(null);
                void startMirror(session, source, hotOnly ? { minPlays: 2 } : undefined)
                  .then(() => setNote('Started. It will keep going with the app closed.'))
                  .catch((e: unknown) =>
                    setNote(e instanceof Error ? e.message : 'Could not start the copy.'),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {running
                ? 'Copying…'
                : hotOnly
                  ? `Copy what I listen to from ${source.name}`
                  : `Copy ${source.name} into this server`}
            </Button>
          </div>
        </>
      )}

      {status && (status.running || status.copied > 0 || status.failed > 0) && (
        <>
          <ProgressBar
            value={status.total > 0 ? (status.copied / status.total) * 100 : 0}
            aria-label="Copy progress"
          />
          <Text tone="muted" size="xs">
            {status.copied} copied · {status.skipped} already here
            {status.failed > 0 ? ` · ${status.failed} failed` : ''}
            {status.note ? ` — ${status.note}` : ''}
          </Text>
        </>
      )}

      {note && (
        <Text tone={note.startsWith('Started') ? 'muted' : 'danger'} size="sm">
          {note}
        </Text>
      )}

      {/* The keys themselves, for wiring a copy by hand. Behind a deliberate
          tap and never printed until asked: these read your whole library. */}
      {source && (
        <>
          <Button variant="ghost" size="sm" onClick={() => setShowKeys((v) => !v)}>
            {showKeys ? 'Hide keys' : 'Show keys'}
          </Button>
          {showKeys && (
            <div className="prefsSection">
              <Text tone="danger" size="xs">
                These read your library. Treat them like a password, and Revoke when done.
              </Text>
              <Input readOnly aria-label="Source URL" value={source.url} />
              <Input readOnly aria-label="Source token" value={source.token} />
              <Input readOnly aria-label="Source stream token" value={source.streamToken} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UsersSection() {
  const { session } = useServerSession();
  const [users, setUsers] = useState<ServerUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The add-a-listener drawer.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // The account a delete is pending on; the dialog is the second look.
  const [condemned, setCondemned] = useState<ServerUser | null>(null);

  const refresh = useCallback(() => {
    if (!session) return;
    fetchUsers(session)
      .then((list) => {
        setUsers(list);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load accounts'));
  }, [session]);
  useEffect(() => refresh(), [refresh]);

  if (!session) return null;

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await register(session.url, newName.trim(), newPassword, session.token);
      setNotice(`Added ${newName.trim()}.`);
      setAdding(false);
      setNewName('');
      setNewPassword('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the account');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (user: ServerUser) => {
    setError(null);
    try {
      await revokeUserStreams(session, user.id);
      setNotice(`${user.username}'s devices were signed out everywhere.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke');
    }
  };

  const remove = async (user: ServerUser) => {
    setCondemned(null);
    setError(null);
    try {
      await deleteUser(session, user.id);
      setNotice(`Deleted ${user.username}.`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the account');
    }
  };

  return (
    <div className="prefsSection">
      <Label>Accounts</Label>
      <Text tone="muted" size="sm">
        Everyone with a sign-in on this server. Listeners share the library and keep
        their own favourites, playlists, and history.
      </Text>

      {users === null && !error ? (
        <Text tone="muted" size="sm">
          Loading accounts…
        </Text>
      ) : (
        <div className="userRows">
          {(users ?? []).map((u) => (
            <div key={u.id} className="userRow">
              <Avatar name={u.username} size="sm" />
              <span className="userRow__name">
                <Text size="sm" weight="medium">
                  {u.username}
                  {u.username === session.username ? ' (you)' : ''}
                </Text>
                {u.isAdmin && (
                  <Pill size="sm" tone="accent">
                    Owner
                  </Pill>
                )}
              </span>
              <span className="userRow__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  title="Sign this account's devices out everywhere"
                  onClick={() => void revoke(u)}
                >
                  <KeyRound size={14} /> Revoke
                </Button>
                {u.username !== session.username && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Delete this account"
                    onClick={() => setCondemned(u)}
                  >
                    <Trash2 size={14} /> Delete
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {error && <Banner tone="danger">{error}</Banner>}
      {notice && !error && (
        <Banner tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {adding ? (
        <div className="userAdd">
          <Field label="Username">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              aria-label="New username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Password" hint="At least 8 characters. They can change nothing about the server - just listen.">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.currentTarget.value)}
              aria-label="New password"
              autoComplete="new-password"
            />
          </Field>
          <div className="prefsActions">
            <Button
              variant="solid"
              size="sm"
              disabled={busy || newName.trim().length === 0 || newPassword.length < 8}
              onClick={() => void add()}
            >
              {busy ? 'Adding…' : 'Add listener'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="prefsActions">
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <UserPlus size={14} /> Add listener…
          </Button>
        </div>
      )}

      <AlertDialog
        open={condemned !== null}
        onClose={() => setCondemned(null)}
        tone="danger"
        title={`Delete ${condemned?.username ?? ''}?`}
        description="Their favourites, playlists, and listening history go with the account. The music stays - the library belongs to the server."
        actionLabel="Delete account"
        cancelLabel="Keep it"
        onAction={() => {
          if (condemned) void remove(condemned);
        }}
      />
    </div>
  );
}

/**
 * Sending music up to the server.
 *
 * Desktop only, and deliberately: it reaches for the native file picker and
 * reads files off the disk, neither of which a phone has in the way this needs.
 * The phone is the thing you listen on; the desktop is where the library
 * already lives and where a bulk upload is worth starting.
 */
function UploadSection() {
  const { session } = useServerSession();
  const { rescan } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [fraction, setFraction] = useState(0);
  const [current, setCurrent] = useState('');
  const [report, setReport] = useState<string | null>(null);

  if (!isTauri() || !session) return null;

  const pickAndUpload = async () => {
    const dialog = await import('@tauri-apps/plugin-dialog');
    const picked = await dialog.open({
      multiple: true,
      title: 'Choose music to upload',
      filters: [
        {
          name: 'Audio',
          extensions: ['flac', 'mp3', 'm4a', 'wav', 'aiff', 'aif', 'ogg', 'opus', 'wv', 'ape'],
        },
      ],
    });
    const files = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (files.length === 0) return;

    const fs = await import('@tauri-apps/plugin-fs');
    setBusy(true);
    setTotal(files.length);
    setDone(0);
    setReport(null);
    let failed = 0;

    for (const [index, path] of files.entries()) {
      const name = path.split(/[\\/]/).pop() ?? 'track';
      setCurrent(name);
      setFraction(0);
      try {
        // Read once, slice in memory: these are single tracks, and the chunking
        // that matters is the network's, not the disk's.
        const bytes = await fs.readFile(path);
        await uploadFile(
          session,
          {
            name,
            size: bytes.byteLength,
            slice: async (start, end) => bytes.slice(start, end),
          },
          { onProgress: setFraction },
        );
      } catch {
        failed += 1;
      }
      setDone(index + 1);
    }

    setBusy(false);
    setCurrent('');
    setReport(
      failed === 0
        ? `Uploaded ${files.length} ${files.length === 1 ? 'track' : 'tracks'}.`
        : `Uploaded ${files.length - failed} of ${files.length}; ${failed} failed.`,
    );
    // The server indexes each upload as it lands, so this only pulls the new
    // rows down rather than asking for a fresh walk.
    await rescan();
  };

  return (
    <div className="prefsSection">
      <Label>Add music</Label>
      <Text tone="muted" size="sm">
        Sends files from this machine to the server. They are filed by their own tags and
        indexed as they arrive.
      </Text>
      {busy && (
        <>
          <Text tone="muted" size="sm">
            {current} — {done} of {total}
          </Text>
          <ProgressBar value={fraction * 100} />
        </>
      )}
      {report && !busy && <Banner tone="success">{report}</Banner>}
      <div className="prefsActions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void pickAndUpload()}>
          <Upload size={14} /> {busy ? 'Uploading…' : 'Upload files…'}
        </Button>
      </div>
      <FolderSyncRow />
    </div>
  );
}

/**
 * The standing arrangement, beside the one-off picker above: this machine's
 * music folder reconciles with the server on its own - on connect and after
 * every finished download - and this row shows where that stands and offers
 * a push. Everything in the folder that the server lacks goes up; nothing is
 * ever sent twice.
 */
function FolderSyncRow() {
  const { status, syncNow } = useLibrarySync();
  const running = status.state === 'checking' || status.state === 'uploading';

  const line =
    status.state === 'checking'
      ? 'Comparing the music folder with the server…'
      : status.state === 'uploading'
        ? `Uploading ${status.current ?? '…'} — ${status.done} of ${status.total}`
        : status.state === 'unsupported'
          ? 'This server predates folder sync; update it to sync automatically.'
          : status.state === 'error'
            ? status.error ?? 'Sync hit a problem; it will retry.'
            : status.lastSyncedAt
              ? `Folder is in sync (checked ${new Date(status.lastSyncedAt).toLocaleTimeString()}).`
              : 'The music folder syncs to the server automatically.';

  return (
    <>
      <Text tone={status.state === 'error' ? 'danger' : 'muted'} size="sm">
        {line}
      </Text>
      {status.state === 'uploading' && status.total > 0 && (
        <ProgressBar value={(status.done / status.total) * 100} />
      )}
      <div className="prefsActions">
        <Button
          variant="outline"
          size="sm"
          disabled={running || status.state === 'unsupported'}
          onClick={syncNow}
        >
          {running ? 'Syncing…' : 'Sync folder now'}
        </Button>
      </div>
    </>
  );
}

/**
 * The household: the other accounts this device has been signed into, one tap
 * away.
 *
 * A hub in a house holds several people, and the phone on the kitchen counter
 * gets handed around. Everything that makes an account worth having - your
 * plays, your resume positions, your mixes, your stats - is already kept apart
 * server-side, so the only thing standing between two listeners was a password
 * prompt. This is that prompt, removed for accounts this device already knows
 * (household.ts), and nothing more: a profile here was minted by someone who
 * had the credentials, and forgetting one takes it off this device.
 */
export function HouseholdSection() {
  const { session, applySession } = useServerSession();
  const [known, setKnown] = useState<Profile[]>(() => otherProfiles(session));

  // Re-read on every switch: `persist` remembers the account being left, so
  // the list is different the moment one is taken.
  useEffect(() => {
    setKnown(otherProfiles(session));
  }, [session]);

  if (known.length === 0) return null;

  return (
    <div className="prefsSection">
      <Label>Household</Label>
      <Text size="sm" tone="muted">
        Other accounts this device knows. Switching keeps each person&rsquo;s own plays, mixes
        and resume points.
      </Text>
      <div className="householdRow">
        {known.map((p) => (
          <div key={`${p.session.url}:${p.session.username}`} className="householdCard">
            <Avatar name={p.session.username} size="sm" />
            <span className="householdCard__name">{p.session.username}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                applySession(p.session);
                setKnown(otherProfiles(p.session));
              }}
            >
              Switch
            </Button>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={`Forget ${p.session.username} on this device`}
              onClick={() => {
                forgetProfile(p.session);
                setKnown(otherProfiles(session));
              }}
            >
              <X size={14} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}
