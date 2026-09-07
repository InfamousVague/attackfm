import { Banner, Button, Field, Input, Text } from '@glacier/react';
import { ArrowLeft, Cloud, KeyRound, QrCode, User } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  enterServer,
  fetchServerInfo,
  normalizeServerUrl,
  pairClaim,
  register,
  type ServerInfo,
} from '../server.ts';
import { fetchSavedServers } from './serverSync.ts';
import type { Membership } from './registry.ts';
import { DEFAULT_SERVER } from './defaultServer.ts';
import { useServerSession } from './serverSession.tsx';
import { useRegistry } from './registrySession.tsx';
import { AccountForm } from './AccountForm.tsx';
import { JoinServer } from './JoinServer.tsx';
import { parsePairPayload } from './pairing.ts';
import { QrScanner } from './QrScanner.tsx';
import { hasLocalLibrary } from '../core/platform.ts';
import wordmark from '../../assets/attack-white.png';
import { ArtWall } from './ArtWall.tsx';
import { Trans, useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

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

  /*
   * Who needs the front door: anyone with no other way to have music.
   *
   * This asked `!isMobile` while the only two builds were a phone and a
   * desktop app, and for those two that was the right answer by accident -
   * the desktop app can be pointed at a local folder, so an empty library is
   * a state with a way out of it, and the phone cannot, so it needs a server
   * before it is anything at all.
   *
   * attack.fm/listen broke the coincidence: a browser is not mobile, and also
   * cannot walk a music folder. Under the old test a first-time visitor
   * landed in a fully-chromed app with an empty library, no session, and no
   * prompt - the only way forward being to guess at the settings gear.
   *
   * So the question is asked directly. `hasLocalLibrary` is exactly "is there
   * music here without a server": true for the desktop app, false for the
   * phone and false for the web.
   */
  if (hasLocalLibrary) return <>{children}</>;
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
  // Has an identity, no library yet → the account already knows which servers
  // this person belongs to, so ask IT before asking them.
  return <OnboardServer onConnectServer={() => setConnecting(true)} onSkip={skip} />;
}

/**
 * Step one: sign into (or create) a central AttackFM account. The first thing
 * the app asks, because everything else hangs off having an identity.
 *
 * SIGN IN is the default face, not sign up. A front door is opened far more
 * often by someone who already lives there - every reinstall, every new
 * phone, every returning listener - and only once, ever, by someone who does
 * not. Leading with the form that creates a SECOND account for a person who
 * already has one is how a returning listener ends up locked out of their own
 * servers with a handle they did not mean to register.
 */
function OnboardAccount({
  onConnectServer,
  onSkip,
}: {
  onConnectServer: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  const { apply } = useRegistry();

  return (
    <div className="loginGate">
      <ArtWall />
      <div className="loginGate__hero">
        <img className="loginGate__mark" src={wordmark} alt={t('common.appName')} />
        {/* The front door leads with what the app IS, the way attack.fm does -
            not with what to do next, which the fields and the button below
            already say. */}
        <Text className="loginGate__tag" tone="muted">
          {t('servers.gateTagline')}
        </Text>
      </div>
      {/* The one account form (AccountForm.tsx); this door only frames it. */}
      <AccountForm
        defaultMode="signin"
        onDone={apply}
        icons
        errorAs="banner"
        className="loginGate__form"
        submitClassName="loginGate__submit"
      />
      <div className="loginGate__alts">
        <Button variant="ghost" size="sm" onClick={onConnectServer}>
          {t('servers.gateSignInDirect')}
        </Button>
        {/* Honest about what it is: not a later, a without. */}
        <Button variant="ghost" size="sm" onClick={onSkip}>
          {t('servers.gateWithoutAccount')}
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
  const t = useT();
  const { session: registry } = useRegistry();
  const { applySession } = useServerSession();
  /*
   * The servers this ACCOUNT belongs to, from whichever device signed into
   * them. This is what makes a new phone not a fresh start: the account has
   * held the addresses all along (serverSync.ts), and membership is re-proved
   * through the registry rather than re-typed, so arriving here with a saved
   * server means one tap - or none.
   *
   * Only the addresses ever travelled; the token this mints is this device's
   * own. That is the security shape the whole design rests on, and it is also
   * why this can be automatic: entering is not replaying a stored credential,
   * it is proving membership again.
   */
  const [saved, setSaved] = useState<Membership[] | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the single-server auto-entry has had its go, so a failure lands
  // on the list instead of retrying forever.
  const tried = useRef(false);

  const enter = useCallback(
    async (url: string) => {
      if (!registry) return;
      setEntering(url);
      setError(null);
      try {
        applySession(await enterServer(url, registry.token));
      } catch (err) {
        setError(err instanceof Error ? err.message : t('servers.gateRefused'));
        setEntering(null);
      }
    },
    [registry, applySession, t],
  );

  useEffect(() => {
    let live = true;
    void fetchSavedServers().then((list) => {
      if (!live) return;
      setSaved(list);
      // Exactly one server on the account: there is nothing to choose between,
      // so choosing is just a tap in the way. Several, and the list stands.
      if (list.length === 1 && !tried.current) {
        tried.current = true;
        void enter(list[0]!.serverUrl);
      }
    });
    return () => {
      live = false;
    };
  }, [enter]);

  const only = saved?.length === 1;
  const looking = saved === null || (only && entering !== null);

  return (
    <div className="loginGate">
      <ArtWall />
      <div className="loginGate__hero">
        <img className="loginGate__mark" src={wordmark} alt={t('common.appName')} />
        <Text className="loginGate__tag" tone="muted">
          {looking
            ? t('servers.gateFindingServers')
            : saved && saved.length > 0
              ? t('servers.gatePickSaved')
              : t('servers.gateFindMusic')}
        </Text>
      </div>
      <div className="loginGate__form">
        {error && <Banner tone="danger">{error}</Banner>}
        {saved && saved.length > 0 && !looking && (
          <div className="loginGate__servers">
            {saved.map((m) => (
              <button
                key={m.serverUrl}
                type="button"
                className="loginGate__server"
                disabled={entering !== null}
                onClick={() => void enter(m.serverUrl)}
              >
                <span className="loginGate__serverIcon" aria-hidden>
                  <Cloud size={18} />
                </span>
                <span className="loginGate__serverBody">
                  <span className="loginGate__serverName">
                    {m.serverName || m.serverUrl.replace(/^https?:\/\//, '')}
                  </span>
                  <span className="loginGate__serverMeta">
                    {entering === m.serverUrl
                      ? t('servers.gateSigningIn')
                      : m.serverName
                        ? m.serverUrl.replace(/^https?:\/\//, '')
                        : m.role === 'owner'
                          ? t('servers.gateYourServer')
                          : t('servers.gateYouAreMember')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {!looking && (!saved || saved.length === 0) && (
          <>
            <JoinServer />
            <Text tone="subtle" size="sm">
              {t('servers.gateNoInviteYet')}
            </Text>
          </>
        )}
      </div>
      <div className="loginGate__alts">
        <Button variant="ghost" size="sm" onClick={onConnectServer}>
          {t('servers.gateSignInDirect')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onSkip}>
          {t('servers.gateWithoutServer')}
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
  const t = useT();
  const [step, setStep] = useState<Step>('server');
  const { connect, applySession } = useServerSession();

  // Pre-filled on the hosted player, empty in the installed apps. See
  // defaultServer.ts: arriving at attack.fm/listen and being asked for an
  // address with no hint of the one you just came from is a dead end for
  // anyone who does not already run a server.
  const [url, setUrl] = useState(DEFAULT_SERVER);
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
        .catch(() => setError(t('servers.gateNoServerThere')))
        .finally(() => setProbing(false));
    }, 600);
    return () => {
      window.clearTimeout(probeTimer.current);
      controller.abort();
    };
  }, [url, step, t]);

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
      setError(err instanceof Error ? err.message : t('servers.gateCouldNotConnect'));
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
          <span>{t('common.back')}</span>
        </button>
      )}
      <div className="loginGate__hero">
        <img className="loginGate__mark" src={wordmark} alt={t('common.appName')} />
        <Text className="loginGate__tag" tone="muted">
          {step === 'code' ? t('servers.gateCodeTagline') : t('servers.gateSignInTagline')}
        </Text>
      </div>

      {step === 'server' && (
        <div className="loginGate__form">
          <Field label={t('servers.address')} hint={t('servers.addressHint')}>
            <Input
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              placeholder={t('servers.addressPlaceholder')}
              aria-label={t('servers.address')}
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
              {t('servers.gateLooking')}
            </Text>
          )}
          {info && (
            <Banner tone={info.needsSetup ? 'warning' : 'success'}>
              {info.needsSetup
                ? t('servers.gateNeedsSetup', { name: info.name })
                : // `count` picks the plural form, `tracks` is the number a
                  // person reads - a library runs to six figures and wants its
                  // thousands grouped the way this locale groups them.
                  t('servers.gateFound', {
                    name: info.name,
                    count: info.tracks,
                    tracks: formatNumber(info.tracks),
                  })}
            </Banner>
          )}
          {error && <Banner tone="warning">{error}</Banner>}
          {/*
            The probe INFORMS this step; it does not gate it.

            This was `disabled={!info}`, which made a failed probe final: the
            button stayed dead and the only thing left to press was "Log in
            with a code" - so an owner who could not be probed could not use
            their own password on their own server. And the probe fails for
            reasons that have nothing to do with the credentials, the loudest
            being that a RELEASE Android build refuses cleartext entirely, so
            every http:// address answers "no server answered".

            An address that parses is enough to try. The credentials step is
            already written for a null probe - it falls back to the typed URL
            and to plain Sign in - and a real attempt returns a real error,
            which is worth more than a button that will not move.
          */}
          <Button
            variant="solid"
            size="lg"
            className="loginGate__submit"
            disabled={!normalizeServerUrl(url) || busy}
            onClick={() => setStep('credentials')}
          >
            {t('servers.gateContinue')}
          </Button>
          <Button variant="ghost" size="md" onClick={() => setStep('code')}>
            <QrCode size={16} />
            <span>{t('servers.gateUseCode')}</span>
          </Button>
        </div>
      )}

      {step === 'credentials' && (
        <div className="loginGate__form">
          <button type="button" className="loginGate__back" onClick={() => setStep('server')}>
            <ArrowLeft size={15} />
            <span>{info ? info.name : url}</span>
          </button>
          <Field label={info?.needsSetup ? t('servers.gateChooseUsername') : t('servers.username')}>
            <Input
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              aria-label={t('servers.username')}
              leadingIcon={<User size={16} />}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
            />
          </Field>
          <Field
            label={info?.needsSetup ? t('servers.gateChoosePassword') : t('servers.password')}
            hint={info?.needsSetup ? t('servers.gatePasswordRule') : undefined}
          >
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              aria-label={t('servers.password')}
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
            {busy
              ? t('servers.gateConnecting')
              : info?.needsSetup
                ? t('servers.gateCreateAndConnect')
                : t('servers.gateSignIn')}
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
  const t = useT();
  const [url, setUrl] = useState(initialUrl);
  const [code, setCode] = useState('');
  const [camera, setCamera] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = async (serverUrl: string, pairCode: string) => {
    const origin = normalizeServerUrl(serverUrl);
    if (!origin) {
      setError(t('servers.gateAddressFirst'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await pairClaim(origin, pairCode);
      onClaim(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('servers.gateCodeRefused'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginGate__form">
      <button type="button" className="loginGate__back" onClick={onBack}>
        <ArrowLeft size={15} />
        <span>{t('common.back')}</span>
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

      {/* One sentence per case rather than a shared opening and two tails:
          the tails are a clause each, and a language that puts the verb last
          cannot hang one off the end of a phrase written for English. */}
      <Text tone="muted" size="sm">
        {camera ? (
          <Trans i18nKey="servers.gateCodeWhereScan" components={{ b: <strong /> }} />
        ) : (
          <Trans i18nKey="servers.gateCodeWhereType" components={{ b: <strong /> }} />
        )}
      </Text>

      <Field label={t('servers.address')}>
        <Input
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          placeholder={t('servers.addressPlaceholder')}
          aria-label={t('servers.address')}
          leadingIcon={<Cloud size={16} />}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />
      </Field>
      <Field label={t('servers.pairingCode')}>
        <Input
          value={code}
          onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
          placeholder="123456"
          aria-label={t('servers.pairingCode')}
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
        {busy ? t('servers.gateLinking') : t('servers.gateConnect')}
      </Button>
    </div>
  );
}
