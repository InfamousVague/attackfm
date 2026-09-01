import { Button, Heading, Modal, Text, useToast } from '@glacier/react';
import { Copy, KeyRound } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { mintRecoveryCodes, REGISTRY_URL } from '../servers/registry.ts';

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
      toast({ message: e instanceof Error ? e.message : 'Could not make codes right now.' });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast({ message: 'Copied - keep them somewhere that is not this device.' });
    } catch {
      toast({ message: 'Could not copy; write them down.' });
    }
  };

  return (
    <section className="serversSettings__part">
      <header className="serversSettings__partHead">
        <Heading level={3} noMargin>
          Recovery codes
        </Heading>
        <Text size="sm" tone="muted">
          {left === null
            ? 'One-time codes that get you back into your account if the password is gone and no device is signed in.'
            : left === 0
              ? 'You have no recovery codes. Make a sheet and keep it somewhere that is not this device.'
              : `${left} unused ${left === 1 ? 'code' : 'codes'} on your sheet. Making a new sheet retires it.`}
        </Text>
      </header>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void mint()}>
        <KeyRound size={14} /> {left ? 'Make a new sheet' : 'Make recovery codes'}
      </Button>

      <Modal open={codes !== null} onClose={() => setCodes(null)} title="Your recovery codes" size="sm">
        <div className="recoveryCodes">
          <Text size="sm" tone="muted">
            Each works once, and this is the only time they are shown. Sign in with one from the
            front door under “Lost the password?”.
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
              <Copy size={14} /> Copy all
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCodes(null)}>
              I have saved them
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
