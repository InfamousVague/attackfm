import { Banner, Button, Field, Input, Label, Text } from '@glacier/react';
import { Check, Cloud, Copy, Server } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import {
  fetchServerInfo,
  normalizeServerUrl,
  register,
  type ServerInfo,
} from '../server.ts';
import { useServerSession } from './serverSession.tsx';

/** The sign-in / first-run form. */
export function ConnectForm() {
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
