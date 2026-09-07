import { Button, Heading, Modal, Text, useToast } from '@glacier/react';
import { Copy, KeyRound } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { mintRecoveryCodes, REGISTRY_URL } from '../servers/registry.ts';
import { useT } from '../i18n/LocaleShell.tsx';

/**
 * Recovery codes, on the account pane.
 *
 * The account is the one key (Phase 5), and a key that lives on devices and
 * in a person's memory needs a way back when both are gone: a phone lost, a
 * password forgotten. Eight one-time codes, minted here, shown ONCE, and
 * good for a sign-in each - the registry keeps only hashes, so there is no
 * "show them again"; there is only "make a new sheet", which retires the old.
 */
export function RecoveryCodesSection() {
  const t = useT();
  const registry = useRegistryOptional();
  const token = registry?.session?.token ?? null;
  const { toast } = useToast();
  const [left, setLeft] = useState<number | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let live = true;
    fetch(`${REGISTRY_URL}/v1/recovery`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { left?: number } | null) => {
        if (live && j && typeof j.left === 'number') setLeft(j.left);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token, codes]);

  if (!token) return null;

  const mint = async () => {
    setBusy(true);
    try {
      setCodes(await mintRecoveryCodes(token));
    } catch (e) {
      // A registry error arrives as prose from the server and is shown as it
      // came; only our own fallback is ours to translate.
      toast({ message: e instanceof Error ? e.message : t('recovery.mintFailed') });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast({ message: t('recovery.copied') });
    } catch {
      toast({ message: t('recovery.copyFailed') });
    }
  };

  return (
    <section className="serversSettings__part">
      <header className="serversSettings__partHead">
        <Heading level={3} noMargin>
          {t('recovery.title')}
        </Heading>
        <Text size="sm" tone="muted">
          {/* Three different things to say, not one sentence with a number
              in it: not knowing yet, having none, and having some. Only the
              last counts, and it counts through the catalogue's plural forms
              rather than an English one-or-many test. */}
          {left === null
            ? t('recovery.explain')
            : left === 0
              ? t('recovery.none')
              : t('recovery.left', { count: left })}
        </Text>
      </header>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void mint()}>
        <KeyRound size={14} /> {left ? t('recovery.makeNew') : t('recovery.makeFirst')}
      </Button>

      <Modal
        open={codes !== null}
        onClose={() => setCodes(null)}
        title={t('recovery.sheetTitle')}
        size="sm"
      >
        <div className="recoveryCodes">
          <Text size="sm" tone="muted">
            {t('recovery.shownOnce')}
          </Text>
          <ol className="recoveryCodes__list">
            {(codes ?? []).map((c) => (
              <li key={c} className="recoveryCodes__code">
                {c}
              </li>
            ))}
          </ol>
          <div className="recoveryCodes__actions">
            <Button variant="solid" size="sm" onClick={() => void copy()}>
              <Copy size={14} /> {t('recovery.copyAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCodes(null)}>
              {t('recovery.saved')}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
