import { Banner, Button, Field, Input, Text } from '@glacier/react';
import { ArrowLeft, Cloud, KeyRound, QrCode, User } from '@glacier/icons';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  fetchServerInfo,
  normalizeServerUrl,
  pairClaim,
  register,
  type ServerInfo,
} from '../server.ts';
import { useServerSession } from './serverSession.tsx';
import { useRegistry } from './registrySession.tsx';
import { login as registryLogin, signup as registrySignup } from './registry.ts';
import { JoinServer } from './JoinServer.tsx';
import { parsePairPayload } from './pairing.ts';
import { QrScanner } from './QrScanner.tsx';
import { isMobile } from '../core/platform.ts';
import wordmark from '../../assets/attack-white.png';
import { ArtWall } from './ArtWall.tsx';

/** Once the listener chose to skip onboarding, they enter in local mode and are
 *  not asked again; joining or signing in later lives on the Friends page. */
const SKIP_KEY = 'attackfm-onboard-skip';

/**
 * The phone's front door - identity first.
 *
 * The order is the point of the whole re-architecture: a listener makes a
 * central account BEFORE any server, because an account is who they are and a
 * server is only where some music happens to live. So a fresh phone opens on
 * "create your account", not "which server?". From there the paths fan out:
 * join a server with an invite, sign into one directly (the owner's way), or
 * skip and use the app locally for now.
 *
 * A returning listener with a server session, or one who already chose to skip,
 * goes straight through - the gate is a first-run step, not a wall that stands
 * every launch. Desktop, which has its own local library, never sees any of it.
 */
export function MobileAuthGate({ children }: { children: ReactNode }) {
  const { session: server } = useServerSession();
  const { session: registry } = useRegistry();
  const [skipped, setSkipped] = useState(() => {
    try {
      return localStorage.getItem(SKIP_KEY) === '1';
    } catch {
      return false;
    }
  });
  // Whether to show the direct server sign-in (address + password/QR), reached
  // from either onboarding step - the owner's way into their own server, and
  // the path an existing local account still uses.
  const [connecting, setConnecting] = useState(false);

  if (!isMobile) return <>{children}</>;
  // A stored server session is read synchronously, so a returning listener is
  // in at once, no splash and no onboarding.
  if (server) return <>{children}</>;
  // Chose local mode earlier: in, and onboarding never nags again.
  if (skipped) return <>{children}</>;

  const skip = () => {
    try {
      localStorage.setItem(SKIP_KEY, '1');
    } catch {
      // Applies for this run; they will just be asked again next launch.
    }
    setSkipped(true);
  };

  if (connecting) return <ConnectScreen onBack={() => setConnecting(false)} />;

  // Identity first: no account yet → make one (or sign in).
  if (!registry) {
    return <OnboardAccount onConnectServer={() => setConnecting(true)} onSkip={skip} />;
  }
  // Has an identity, no library yet → get one.
  return <OnboardServer onConnectServer={() => setConnecting(true)} onSkip={skip} />;
}

/**
 * Step one: create (or sign into) a central AttackFM account. The first thing
 * the app asks, because everything else hangs off having an identity.
 */
function OnboardAccount({
  onConnectServer,
  onSkip,
}: {
  onConnectServer: () => void;
  onSkip: () => void;
}) {
  const { apply } = useRegistry();
  const [mode, setMode] = useState<'create' | 'signin'>('create');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = handle.trim().length >= 3 && password.length >= 8 && !busy;

  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const s = mode === 'create'
        ? await registrySignup(handle.trim(), password)
        : await registryLogin(handle.trim(), password);
      apply(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginGate">
      <ArtWall />
      <div className="loginGate__hero">
        <img className="loginGate__mark" src={wordmark} alt="AttackFM" />
        {/* The front door leads with what the app IS, the way attack.fm does -
            not with what to do next, which the fields and the button below
            already say. */}
        <Text className="loginGate__tag" tone="muted">
          Lossless audio streaming
        </Text>
      </div>
      <form className="loginGate__form" onSubmit={go}>
        <Field label="Handle" hint={mode === 'create' ? '3-24 letters, digits, . _ or -' : undefined}>
          <Input
            value={handle}
            onChange={(e) => setHandle(e.currentTarget.value)}
            placeholder="yourname"
            aria-label="Handle"
            leadingIcon={<User size={16} />}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
          />
        </Field>
        <Field label="Password" hint={mode === 'create' ? 'At least 8 characters.' : undefined}>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            aria-label="Password"
            leadingIcon={<KeyRound size={16} />}
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          />
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="solid" size="lg" className="loginGate__submit" disabled={!ready}>
          {busy ? 'Just a moment…' : mode === 'create' ? 'Create account' : 'Sign in'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="md"
          onClick={() => {
            setMode((m) => (m === 'create' ? 'signin' : 'create'));
            setError(null);
          }}
        >
          {mode === 'create' ? 'I already have an account' : 'Create an account instead'}
        </Button>
      </form>
      <div className="loginGate__alts">
        <Button variant="ghost" size="sm" onClick={onConnectServer}>
          Sign into a server directly
        </Button>
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}

/**
 * Step two: with an identity in hand, get a library. Join a server with an
 * invite, sign into one directly, or skip. Held apart from the account step so
 * neither screen is a wall of options.
 */
function OnboardServer({
  onConnectServer,
  onSkip,
}: {
  onConnectServer: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="loginGate">
      <ArtWall />
      <div className="loginGate__hero">
        <img className="loginGate__mark" src={wordmark} alt="AttackFM" />
        <Text className="loginGate__tag" tone="muted">
          Now find some music. Join a server you were invited to, or run your own.
        </Text>
      </div>
      <div className="loginGate__form">
        <JoinServer />
        <Text tone="subtle" size="sm">
          No invite yet? Ask a friend who runs a server to send you one, then open their link here.
        </Text>
      </div>
      <div className="loginGate__alts">
        <Button variant="ghost" size="sm" onClick={onConnectServer}>
          Sign into a server directly
        </Button>
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </div>
  );
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
function ConnectScreen({ onBack }: { onBack?: () => void }) {
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
      <ArtWall />
      {onBack && step === 'server' && (
        <button type="button" className="loginGate__back" onClick={onBack}>
          <ArrowLeft size={15} />
          <span>Back</span>
        </button>
      )}
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
          placeholder="123456"
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
