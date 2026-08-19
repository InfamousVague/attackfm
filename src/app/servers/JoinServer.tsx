//! Joining a server with an invite.
//!
//! The other half of the invite: someone pasted (or tapped) a link a member
//! sent them. This turns that into a place to listen from - it reads the invite
//! off the registry to show whose server it is, then signs in there with the
//! listener's central identity, which the server admits because the invite says
//! so. The result is an ordinary server session; the account is theirs.

import { Button, Field, Input, OtpField, Text } from '@glacier/react';
import { LogIn, Link2 } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useRegistry } from './registrySession.tsx';
import { AccountSetup } from '../profile/RegistryFriends.tsx';
import { useServerSession } from './serverSession.tsx';
import { previewInvite, type InvitePreview } from './registry.ts';
import { enterServer } from '../server.ts';
import { onInvite } from './deepLink.ts';

/** Pull the code out of a full invite link, or take a bare code as-is. */
function codeFrom(text: string): string {
  const t = text.trim();
  const m = t.match(/\/i\/([^/?#\s]+)/);
  return (m?.[1] ?? t).trim();
}

export function JoinServer() {
  const { session: registry, apply: applyRegistry } = useRegistry();
  const { applySession } = useServerSession();
  const [value, setValue] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const look = async (explicit?: string) => {
    const code = codeFrom(explicit ?? value).toUpperCase();
    if (!code) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const p = await previewInvite(code);
      if (p.spent) setError('That invite has already been used.');
      else if (p.expired) setError('That invite has expired.');
      else setPreview(p);
    } catch {
      setError('That invite could not be found.');
    } finally {
      setBusy(false);
    }
  };

  // An invite that arrived by link (the "Open in AttackFM" button) fills the
  // field and checks itself, so the listener lands on the ready-to-join card
  // rather than an empty box they have to paste into.
  useEffect(() => {
    return onInvite((code) => {
      setValue(code.toUpperCase());
      void look(code);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once; look reads the code it is handed
  }, []);

  /**
   * Join, using whichever identity we have.
   *
   * Takes the session as an argument rather than reading `registry` from scope
   * because the account may have been made a moment ago, in the card below: the
   * provider's state has not necessarily re-rendered this closure yet, and
   * joining with the stale null is the bug this whole path is about.
   */
  const join = async (identity = registry) => {
    if (!identity || !preview) return;
    const code = codeFrom(value).toUpperCase();
    setBusy(true);
    setError(null);
    try {
      const session = await enterServer(preview.serverUrl, identity.token, code);
      // Adopting the session drops us into that server's library at once.
      applySession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="joinServer">
      <Field label="Have an invite?" hint="Enter the 6-character code a friend sent you.">
        <OtpField
          length={6}
          groupSize={3}
          // sm, because this renders inside a small modal on a phone now: the
          // md cells ran the sixth one off the sheet's edge.
          size="sm"
          type="alphanumeric"
          value={value}
          aria-label="Invite code"
          onValueChange={(v) => {
            // Uppercase so the cells and the redeemed code match what the
            // registry mints; a fresh edit clears a stale preview/error.
            setValue(v.toUpperCase());
            if (preview) setPreview(null);
            if (error) setError(null);
          }}
          onComplete={(v) => void look(v)}
        />
      </Field>

      <Field label="Or paste an invite link">
        <Input
          size="sm"
          placeholder="https://registry.attack.fm/i/ABC123"
          leadingIcon={<Link2 size={14} />}
          aria-label="Invite link"
          onChange={(e) => {
            // The moment the pasted text carries a code, it checks itself -
            // the six cells above fill in so what happened stays visible.
            const code = codeFrom(e.target.value);
            if (code && code.length === 6 && code !== e.target.value.trim()) {
              setValue(code.toUpperCase());
              void look(code);
              e.target.value = '';
            }
          }}
        />
      </Field>

      {!preview ? (
        <Button variant="outline" size="sm" onClick={() => void look()} disabled={busy || value.length !== 6}>
          {busy ? 'Checking…' : 'Check invite'}
        </Button>
      ) : (
        <div className="joinServer__preview">
          <Text size="sm">
            Join <strong>{preview.serverName || 'a server'}</strong>
            {preview.from ? ` — invited by ${preview.from}` : ''}?
          </Text>
          {registry ? (
            <Button variant="solid" size="sm" onClick={() => void join()} disabled={busy}>
              <LogIn size={15} /> {busy ? 'Joining…' : 'Join'}
            </Button>
          ) : (
            <>
              {/* Someone arriving on an invite link usually has no account yet -
                  the invite IS their first contact with AttackFM. This used to
                  render a Join button that returned immediately and silently
                  when there was no identity to join WITH, so the invite looked
                  broken. Make the account here and carry straight on into the
                  server, rather than sending them away to find a settings page
                  and then find this screen again. */}
              <Text size="sm" tone="muted">
                You need an AttackFM account to join. It works on every server, and it is free.
              </Text>
              <AccountSetup
                onDone={(made) => {
                  applyRegistry(made);
                  // Straight through with the identity just created; waiting for
                  // the provider to re-render would make them press Join twice.
                  void join(made);
                }}
              />
            </>
          )}
        </div>
      )}

      {error && (
        <Text tone="danger" size="sm">
          {error}
        </Text>
      )}
    </div>
  );
}
