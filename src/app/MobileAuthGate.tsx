import { Banner, Button, Field, Input, Text } from '@glacier/react';
import { ArrowLeft, Cloud, KeyRound, QrCode, User } from '@glacier/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fetchServerInfo,
  normalizeServerUrl,
  pairClaim,
  register,
  type ServerInfo,
} from './server.ts';
import { useServerSession } from './serverSession.tsx';
import { parsePairPayload } from './pairing.ts';
import { QrScanner } from './QrScanner.tsx';
import { isMobile } from './platform.ts';
import wordmark from '../assets/attack-white.png';

/**
 * The phone's front door.
 *
 * A phone is the listening end of AttackFM - it has no local music folder of
 * its own (see `hasLocalLibrary`), so there is nothing to show until it is
 * pointed at a server. Rather than open on an empty library and bury the one
 * action that matters in Settings, the mobile build gates the whole app behind
 * a sign-in: connect to a server first, then everything else.
 *
 * Desktop is unaffected - it can run on its own library with no server at all,
 * so it never sees this. The gate only stands where a server is the point.
 */
export function MobileAuthGate({ children }: { children: ReactNode }) {
  const { session } = useServerSession();

  if (!isMobile) return <>{children}</>;
  // A stored session is read synchronously, so a returning listener goes
  // straight to the app. This used to wait on `restoring` and show a splash -
  // but `restoring` is only ever true when a session was found, so the splash
  // appeared exactly when the app already had everything it needed to draw,
  // and it held the launch for a NETWORK round trip (the stream-token
  // renewal). That renewal now finishes behind the app: the pages it feeds
  // carry skeletons of their own, so the wait happens shelf by shelf, at full
  // size, instead of as a blank screen with a spinner on it.
  if (session) return <>{children}</>;
  return <ConnectScreen />;
}

type Step = 'server' | 'credentials' | 'code';

/**
 * The sign-in wizard. Server first: the address is probed so a fresh server
 * offers to make its first account and an established one asks to be signed
 * into - and only once a server has actually answered does the second step ask
 * for a name and password. A third path, reachable from the first step, links
 * the phone with a one-time code (scanned or typed) so nobody types a password
 * on a phone keyboard at all.
 */
function ConnectScreen() {
  const [step, setStep] = useState<Step>('server');
  const { connect, applySession } = useServerSession();

  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Probe the address as it settles, but only while the server step is showing
  // - a probe firing behind the credentials step would be wasted work.
  const probeTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (step !== 'server') return;
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
  }, [url, step]);

  const credsReady = username.trim().length > 0 && password.length > 0 && !busy;

  const signIn = async () => {
    if (!credsReady) return;
    setBusy(true);
    setError(null);
    try {
      const origin = normalizeServerUrl(url);
      if (info?.needsSetup) await register(origin, username, password);
      await connect(origin, username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginGate">
      <div className="loginGate__hero">
        <img className="loginGate__mark" src={wordmark} alt="AttackFM" />
        <Text className="loginGate__tag" tone="muted">
          {step === 'code'
            ? 'Scan or enter a code from a device that’s already signed in.'
            : 'Sign in to your music server to start listening.'}
        </Text>
      </div>

      {step === 'server' && (
        <div className="loginGate__form">
          <Field
            label="Server address"
            hint="Where your server is reachable, e.g. music.example.com."
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' && info) setStep('credentials');
              }}
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
                ? `${info.name} has no accounts yet — you’ll create the owner account next.`
                : `Found ${info.name} · ${info.tracks.toLocaleString()} tracks`}
            </Banner>
          )}
          {error && <Banner tone="danger">{error}</Banner>}
          <Button
            variant="solid"
            size="lg"
            className="loginGate__submit"
            disabled={!info || busy}
            onClick={() => setStep('credentials')}
          >
            Continue
          </Button>
          <Button variant="ghost" size="md" onClick={() => setStep('code')}>
            <QrCode size={16} />
            <span>Log in with a code</span>
          </Button>
        </div>
      )}

      {step === 'credentials' && (
        <div className="loginGate__form">
          <button type="button" className="loginGate__back" onClick={() => setStep('server')}>
            <ArrowLeft size={15} />
            <span>{info ? info.name : url}</span>
          </button>
          <Field label={info?.needsSetup ? 'Choose a username' : 'Username'}>
            <Input
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              aria-label="Username"
              leadingIcon={<User size={16} />}
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
              leadingIcon={<KeyRound size={16} />}
              autoComplete={info?.needsSetup ? 'new-password' : 'current-password'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && credsReady) void signIn();
              }}
            />
          </Field>
          {error && <Banner tone="danger">{error}</Banner>}
          <Button
            variant="solid"
            size="lg"
            className="loginGate__submit"
            disabled={!credsReady}
            onClick={() => void signIn()}
          >
            {busy ? 'Connecting…' : info?.needsSetup ? 'Create account & connect' : 'Sign in'}
          </Button>
        </div>
      )}

      {step === 'code' && (
        <CodeStep
          initialUrl={url}
          onBack={() => setStep('server')}
          onClaim={(session) => applySession(session)}
        />
      )}
    </div>
  );
}

/**
 * The code path: a camera that reads a "link a device" QR when there is one,
 * and a typed server + code underneath for when there isn't. A scanned QR
 * carries both the server and the code, so a successful scan just connects; a
 * typed code needs the server address too, prefilled from the first step.
 */
function CodeStep({
  initialUrl,
  onBack,
  onClaim,
}: {
  initialUrl: string;
  onBack: () => void;
  onClaim: (session: Awaited<ReturnType<typeof pairClaim>>) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [code, setCode] = useState('');
  const [camera, setCamera] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = async (serverUrl: string, pairCode: string) => {
    const origin = normalizeServerUrl(serverUrl);
    if (!origin) {
      setError('Enter the server address first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await pairClaim(origin, pairCode);
      onClaim(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginGate__form">
      <button type="button" className="loginGate__back" onClick={onBack}>
        <ArrowLeft size={15} />
        <span>Back</span>
      </button>

      {camera && (
        <QrScanner
          onUnavailable={() => setCamera(false)}
          onResult={(text) => {
            const parsed = parsePairPayload(text);
            if (!parsed) return; // a stray, non-AttackFM QR - keep looking
            setUrl(parsed.url);
            setCode(parsed.code);
            void claim(parsed.url, parsed.code);
          }}
        />
      )}

      <Text tone="muted" size="sm">
        On a device that’s already signed in, open <strong>Settings → Link a device</strong>
        {camera ? ' and scan the code, or enter it here.' : ' and enter the code shown.'}
      </Text>

      <Field label="Server address">
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
      <Field label="Pairing code">
        <Input
          value={code}
          onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
          placeholder="ABCD1234"
          aria-label="Pairing code"
          leadingIcon={<QrCode size={16} />}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && code.trim() && !busy) void claim(url, code);
          }}
        />
      </Field>
      {error && <Banner tone="danger">{error}</Banner>}
      <Button
        variant="solid"
        size="lg"
        className="loginGate__submit"
        disabled={!code.trim() || busy}
        onClick={() => void claim(url, code)}
      >
        {busy ? 'Linking…' : 'Connect'}
      </Button>
    </div>
  );
}
