import {
  Banner,
  Button,
  Field,
  Input,
  Label,
  ProgressBar,
  SegmentedControl,
  Slider,
  Spinner,
  Text,
} from '@glacier/react';
import { Check, Cloud, Copy, FolderOpen, RefreshCw, Server, Upload } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { fetchScanStatus, fetchServerInfo, register, uploadFile, type ScanStatus, type ServerInfo } from './server.ts';
import { normalizeServerUrl } from './server.ts';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { isTauri } from './tauri.ts';

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

/** The signed-in status board. */
function Connected() {
  const { session, settings, updateSettings, disconnect } = useServerSession();
  const { tracks, indexing, rescan, error } = useLibrary();
  const [status, setStatus] = useState<ScanStatus | null>(null);

  // The server's own indexing progress, polled only while it is working - a
  // status board that keeps a phone's radio awake to say "idle" is worse than
  // one that goes quiet.
  useEffect(() => {
    if (!session) return;
    let live = true;
    const poll = async () => {
      try {
        const next = await fetchScanStatus(session);
        if (live) setStatus(next);
        return next.running;
      } catch {
        return false;
      }
    };
    void poll();
    const interval = window.setInterval(() => {
      void poll().then((running) => {
        if (!running) window.clearInterval(interval);
      });
    }, 2000);
    return () => {
      live = false;
      window.clearInterval(interval);
    };
  }, [session]);

  if (!session) return null;

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Field label="Connected to">
          <Input readOnly value={session.url} aria-label="Server" leadingIcon={<Cloud size={16} />} />
        </Field>
        <Text tone="muted" size="sm">
          Signed in as {session.username}
          {session.isAdmin ? ' (owner)' : ''} · {tracks.length.toLocaleString()} tracks
          {status ? ` · ${status.bytesLabel}` : ''}
        </Text>
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
            onClick={() => void rescan()}
          >
            <RefreshCw size={14} /> {indexing ? 'Syncing…' : 'Rescan & sync'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
            Sign out
          </Button>
        </div>
      </div>

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
    </div>
  );
}

/** The icon the settings rail shows for this pane. */
export const serverSectionIcon = <FolderOpen size={16} />;
