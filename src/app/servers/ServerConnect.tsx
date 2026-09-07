import { Banner, Button, Field, Input, Label, Text } from '@glacier/react';
import { Check, Cloud, Copy, Server } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import {
  fetchServerInfo,
  normalizeServerUrl,
  register,
  type ServerInfo,
} from '../server.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';
import { useServerSession } from './serverSession.tsx';

/** The sign-in / first-run form. */
export function ConnectForm() {
  const t = useT();
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
        .catch(() => setError(t('servers.noServerAtAddress')))
        .finally(() => setProbing(false));
    }, 600);
    return () => {
      window.clearTimeout(probeTimer.current);
      controller.abort();
    };
  }, [url, t]);

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
      setError(err instanceof Error ? err.message : t('servers.couldNotConnect'));
    } finally {
      setBusy(false);
    }
  };

  const ready = !!info && username.trim().length > 0 && password.length > 0 && !busy;

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Field
          label={t('servers.addressLabel')}
          hint={t('servers.addressHint')}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            placeholder={t('servers.addressPlaceholder')}
            aria-label={t('servers.addressLabel')}
            leadingIcon={<Cloud size={16} />}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
        </Field>
        {probing && (
          <Text tone="muted" size="sm">
            {t('servers.lookingForServer')}
          </Text>
        )}
        {info && (
          <Banner tone={info.needsSetup ? 'warning' : 'success'}>
            {info.needsSetup
              ? t('servers.noAccountsYet', { name: info.name })
              : /* `count` picks the plural form; `n` is the number as it is
                   printed, grouped the way this locale groups. */
                t('servers.foundServer', {
                  count: info.tracks,
                  name: info.name,
                  n: formatNumber(info.tracks),
                })}
          </Banner>
        )}
      </div>

      <div className="prefsSection">
        <Field label={info?.needsSetup ? t('servers.chooseUsername') : t('servers.username')}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            aria-label={t('servers.username')}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
          />
        </Field>
        <Field
          label={info?.needsSetup ? t('servers.choosePassword') : t('servers.password')}
          hint={info?.needsSetup ? t('servers.passwordMinLength') : undefined}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            aria-label={t('servers.password')}
            autoComplete={info?.needsSetup ? 'new-password' : 'current-password'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) void submit();
            }}
          />
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="prefsActions">
          <Button variant="solid" size="sm" disabled={!ready} onClick={() => void submit()}>
            {busy ? t('servers.connecting') : info?.needsSetup ? t('servers.createAccountConnect') : t('servers.connect')}
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
  const t = useT();
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
        <Server size={14} /> {open ? t('servers.hideSetup') : t('servers.noServerYet')}
      </Button>

      {open && (
        <div className="serverSetup">
          <Text tone="muted" size="sm">
            {t('servers.setupBlurb')}
          </Text>

          <Label>{t('servers.setupStepRun')}</Label>
          <div className="serverSetupCommand">
            <code>{INSTALL_COMMAND}</code>
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
          <Text tone="muted" size="sm">
            {t('servers.setupRunBody')}
          </Text>

          <Label>{t('servers.setupStepAddress')}</Label>
          <Text tone="muted" size="sm">
            {t('servers.setupAddressBody')}
          </Text>

          <Label>{t('servers.setupStepMusic')}</Label>
          <Text tone="muted" size="sm">
            {t('servers.setupMusicBody')}
          </Text>
        </div>
      )}
    </div>
  );
}
