import { Banner, Button, Field, Input, Text } from '@glacier/react';
import { KeyRound, User } from '@glacier/icons';
import { useState, type FormEvent } from 'react';
import { login, loginRecovery, signup, type RegistrySession } from './registry.ts';
import { enrolDevice } from './deviceKey.ts';
import { useT } from '../i18n/LocaleShell.tsx';

export type AccountMode = 'signin' | 'create' | 'recovery';

/**
 * THE account form - sign in, create, or come back with a recovery code.
 *
 * There used to be two of these, one on the phone's front door and one on the
 * Friends page, each with its own copy of the rules (handle length, the
 * 8-character floor that applies to CHOOSING a password and not to typing an
 * existing one) and each drifting from the other. One form, worn by both
 * doors; the doors keep their own framing.
 *
 * Whatever way in succeeds, this device's key is registered on the account
 * afterwards (deviceKey.ts), so the password is typed once here and never
 * again on this device.
 */
export function AccountForm({
  defaultMode = 'signin',
  onDone,
  icons = false,
  errorAs = 'text',
  className,
  submitClassName,
}: {
  defaultMode?: AccountMode;
  onDone: (session: RegistrySession) => void;
  /** Leading glyphs in the fields - the front door has the room for them. */
  icons?: boolean;
  errorAs?: 'banner' | 'text';
  className?: string;
  submitClassName?: string;
}) {
  const t = useT();
  const [mode, setMode] = useState<AccountMode>(defaultMode);
  const [handle, setHandle] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    handle.trim().length >= 3 &&
    secret.length >= (mode === 'create' ? 8 : 1) &&
    !busy;

  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const h = handle.trim();
      const s =
        mode === 'create'
          ? await signup(h, secret)
          : mode === 'recovery'
            ? await loginRecovery(h, secret.trim())
            : await login(h, secret);
      // Not awaited on the way through the door: the sign-in is already
      // good, and a slow or old registry must not hold it.
      void enrolDevice(s);
      onDone(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('servers.accountFormFailed'));
    } finally {
      setBusy(false);
    }
  };

  const swap = (next: AccountMode) => {
    setMode(next);
    setSecret('');
    setError(null);
  };

  return (
    <form className={className} onSubmit={go}>
      <Field
        label={t('servers.handle')}
        hint={mode === 'create' ? t('servers.handleHint') : undefined}
      >
        <Input
          value={handle}
          onChange={(e) => setHandle(e.currentTarget.value)}
          placeholder={t('servers.handlePlaceholder')}
          aria-label={t('servers.handle')}
          leadingIcon={icons ? <User size={16} /> : undefined}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
        />
      </Field>
      {mode === 'recovery' ? (
        <Field label={t('servers.recoveryCode')} hint={t('servers.recoveryCodeHint')}>
          <Input
            value={secret}
            onChange={(e) => setSecret(e.currentTarget.value.toUpperCase())}
            placeholder={t('servers.recoveryCodePlaceholder')}
            aria-label={t('servers.recoveryCode')}
            leadingIcon={icons ? <KeyRound size={16} /> : undefined}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="one-time-code"
          />
        </Field>
      ) : (
        <Field
          label={t('servers.password')}
          hint={mode === 'create' ? t('servers.passwordHint') : undefined}
        >
          <Input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.currentTarget.value)}
            aria-label={t('servers.password')}
            leadingIcon={icons ? <KeyRound size={16} /> : undefined}
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          />
        </Field>
      )}
      {error &&
        (errorAs === 'banner' ? (
          <Banner tone="danger">{error}</Banner>
        ) : (
          <Text tone="danger" size="sm">
            {error}
          </Text>
        ))}
      <Button type="submit" variant="solid" size="lg" className={submitClassName} disabled={!ready}>
        {/* Four different labels for four states, not one string with a hole:
            each is its own entry so a language can word them independently. */}
        {busy
          ? t('servers.accountFormWorking')
          : mode === 'create'
            ? t('servers.accountFormCreate')
            : mode === 'recovery'
              ? t('servers.accountFormSignInWithCode')
              : t('servers.accountFormSignIn')}
      </Button>
      <Button type="button" variant="ghost" size="md" onClick={() => swap(mode === 'create' ? 'signin' : 'create')}>
        {mode === 'create' ? t('servers.accountFormHaveOne') : t('servers.accountFormCreateInstead')}
      </Button>
      {mode === 'signin' && (
        <Button type="button" variant="ghost" size="sm" onClick={() => swap('recovery')}>
          {t('servers.accountFormLostPassword')}
        </Button>
      )}
    </form>
  );
}
