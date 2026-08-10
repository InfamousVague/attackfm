//! Joining a server with an invite.
//!
//! The other half of the invite: someone pasted (or tapped) a link a member
//! sent them. This turns that into a place to listen from - it reads the invite
//! off the registry to show whose server it is, then signs in there with the
//! listener's central identity, which the server admits because the invite says
//! so. The result is an ordinary server session; the account is theirs.

import { Button, Field, Input, Text } from '@glacier/react';
import { LogIn } from '@glacier/icons';
import { useState } from 'react';
import { useRegistry } from './registrySession.tsx';
import { useServerSession } from './serverSession.tsx';
import { previewInvite, type InvitePreview } from './registry.ts';
import { enterServer } from './server.ts';

/** Pull the code out of a full invite link, or take a bare code as-is. */
function codeFrom(text: string): string {
  const t = text.trim();
  const m = t.match(/\/i\/([^/?#\s]+)/);
  return (m?.[1] ?? t).trim();
}

export function JoinServer() {
  const { session: registry } = useRegistry();
  const { applySession } = useServerSession();
  const [value, setValue] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const look = async () => {
    const code = codeFrom(value);
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

  const join = async () => {
    if (!registry || !preview) return;
    const code = codeFrom(value);
    setBusy(true);
    setError(null);
    try {
      const session = await enterServer(preview.serverUrl, registry.token, code);
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
      <Field label="Have an invite?" hint="Paste the invite link a friend sent you.">
        <Input
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder="registry.attack.fm/i/…"
          aria-label="Invite link"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void look();
          }}
        />
      </Field>

      {!preview ? (
        <Button variant="outline" size="sm" onClick={() => void look()} disabled={busy || value.trim() === ''}>
          {busy ? 'Checking…' : 'Check invite'}
        </Button>
      ) : (
        <div className="joinServer__preview">
          <Text size="sm">
            Join <strong>{preview.serverName || 'a server'}</strong>
            {preview.from ? ` — invited by ${preview.from}` : ''}?
          </Text>
          <Button variant="solid" size="sm" onClick={() => void join()} disabled={busy}>
            <LogIn size={15} /> {busy ? 'Joining…' : 'Join'}
          </Button>
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
