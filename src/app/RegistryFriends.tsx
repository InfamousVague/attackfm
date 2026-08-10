//! Friends, the central-identity way.
//!
//! A friend here is a person, not a row on one server: the friendship lives in
//! the registry, so it holds whichever server either of you is on. This is also
//! where an account is CREATED - the first thing the app asks of a listener who
//! has none, and (per the onboarding) the place they are sent to set one up so
//! a server owner can invite them.
//!
//! Two faces, chosen by whether an identity exists:
//!   - none: create an account (or sign in to an existing one).
//!   - signed in: the friends graph, adding by handle, and - if you run a
//!     server - minting an invite link to it.

import { Button, Field, IconButton, Input, Spinner, Text } from '@glacier/react';
import { Check, UserPlus, X, LogOut, Link2, Copy } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { EmptyArt } from './EmptyArt.tsx';
import { useRegistry } from './registrySession.tsx';
import { useServerSession } from './serverSession.tsx';
import { JoinServer } from './JoinServer.tsx';
import { linkAccount } from './server.ts';
import {
  acceptFriendRequest,
  announce,
  createInvite,
  declineFriendRequest,
  fetchFriends,
  inviteLink,
  login,
  removeFriend,
  sendFriendRequest,
  signup,
  type FriendsFeed,
} from './registry.ts';

/**
 * A person, as a mark: a deterministic two-tone gradient from their handle
 * with their initial on it. The hue is the handle's and nobody else's, so the
 * same friend wears the same colour on every device and every visit - the
 * grid reads as PEOPLE at a glance, not a column of grey monograms.
 */
export function FriendAvatar({
  handle,
  size = 'md',
  className,
}: {
  handle: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  let hue = 7;
  for (const ch of handle) hue = (hue * 31 + ch.codePointAt(0)!) % 360;
  return (
    <span
      className={`friendAvatar friendAvatar--${size}${className ? ` ${className}` : ''}`}
      style={{
        background: `linear-gradient(135deg, oklch(0.62 0.15 ${hue}), oklch(0.42 0.17 ${(hue + 55) % 360}))`,
      }}
      aria-hidden
    >
      {(handle[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** "now", "4h ago" - the coarse read a friend card wants, never a timestamp. */
function seenAgo(stamp: number): string | null {
  if (!stamp) return null;
  // The registry stamps in seconds; anything suspiciously small is treated as
  // such rather than reading as fifty-six years ago.
  const ms = stamp < 1e12 ? stamp * 1000 : stamp;
  const gone = Date.now() - ms;
  if (gone < 0) return null;
  if (gone < 90_000) return 'online now';
  const mins = gone / 60_000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

export function RegistryFriends() {
  const { session, account, apply, signOut } = useRegistry();
  if (!session || !account) return <AccountSetup onDone={apply} />;
  return <FriendsGraph token={session.token} me={account.handle} onSignOut={signOut} />;
}

// --- account setup ----------------------------------------------------------

function AccountSetup({ onDone }: { onDone: (s: import('./registry.ts').RegistrySession) => void }) {
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
      const s = mode === 'create' ? await signup(handle.trim(), password) : await login(handle.trim(), password);
      onDone(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="registrySetup">
      <div className="emptyState">
        <EmptyArt name="friends" />
        <p className="emptyState__text">
          {mode === 'create'
            ? 'Create your AttackFM account to add friends and be invited to their servers. One account works everywhere.'
            : 'Sign in to your AttackFM account.'}
        </p>
      </div>
      <form className="registrySetup__form" onSubmit={go}>
        <Field label="Handle" hint={mode === 'create' ? '3-24 letters, digits, . _ or -' : undefined}>
          <Input
            value={handle}
            onChange={(e) => setHandle(e.currentTarget.value)}
            placeholder="yourname"
            aria-label="Handle"
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
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          />
        </Field>
        {error && <Text tone="danger" size="sm">{error}</Text>}
        <Button type="submit" variant="solid" size="lg" disabled={!ready} className="registrySetup__submit">
          {busy ? 'Just a moment…' : mode === 'create' ? 'Create account' : 'Sign in'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setMode((m) => (m === 'create' ? 'signin' : 'create'));
            setError(null);
          }}
        >
          {mode === 'create' ? 'I already have an account' : 'Create an account instead'}
        </Button>
      </form>
    </div>
  );
}

// --- the friends graph ------------------------------------------------------

function FriendsGraph({ token, me, onSignOut }: { token: string; me: string; onSignOut: () => void }) {
  const { session: server } = useServerSession();
  const [feed, setFeed] = useState<FriendsFeed | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setFeed(await fetchFriends(token));
    } catch {
      // Unreachable right now; whatever is on screen stays.
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Let friends see where this account's library is and how big, once, when
  // both an identity and a server are in hand.
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current || !server) return;
    announced.current = true;
    void announce(token, { serverUrl: server.url }).catch(() => {
      announced.current = false;
    });
  }, [token, server]);

  const act = async (run: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await run();
      if (ok) setNote({ tone: 'ok', text: ok });
      await refresh();
    } catch (error) {
      setNote({ tone: 'bad', text: error instanceof Error ? error.message : 'That did not work.' });
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const wanted = handle.trim();
    if (!wanted || busy) return;
    void act(async () => {
      const { message } = await sendFriendRequest(token, wanted);
      setHandle('');
      setNote({ tone: 'ok', text: message });
    });
  };

  const makeInvite = async () => {
    if (!server) return;
    setBusy(true);
    setNote(null);
    try {
      const { code } = await createInvite(token, server.url, server.username ? `${server.username}'s AttackFM` : 'AttackFM');
      setInvite(inviteLink(code));
      setInviteCode(code);
      setCopied(false);
    } catch (error) {
      setNote({ tone: 'bad', text: error instanceof Error ? error.message : 'Could not make an invite.' });
    } finally {
      setBusy(false);
    }
  };

  const friends = feed?.friends ?? [];
  const incoming = feed?.incoming ?? [];
  const outgoing = feed?.outgoing ?? [];

  return (
    <div className="registryFriends">
      {/* Who you are, worn like the friend cards below wear their owners -
          the page opens on a person, not on a settings row. */}
      <div className="friendsMe">
        <FriendAvatar handle={me} size="lg" />
        <span className="friendsMe__body">
          <span className="friendsMe__handle">@{me}</span>
          <span className="friendsMe__caption">
            {friends.length === 0
              ? 'Your account, on every server'
              : `${friends.length} ${friends.length === 1 ? 'friend' : 'friends'}`}
          </span>
        </span>
        <IconButton variant="ghost" size="sm" aria-label="Sign out" onClick={onSignOut}>
          <LogOut size={15} />
        </IconButton>
      </div>

      <form className="friendsAdd" onSubmit={add}>
        <Input
          className="friendsAdd__field"
          value={handle}
          onChange={(e) => setHandle(e.currentTarget.value)}
          placeholder="Add a friend by handle"
          aria-label="Add a friend by handle"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button type="submit" variant="solid" size="sm" disabled={busy || handle.trim() === ''}>
          {busy ? <Spinner size="sm" aria-label="" /> : <UserPlus size={15} />}
          <span>Add</span>
        </Button>
      </form>

      {/* No server yet: the way in is an invite from someone who runs one. */}
      {!server && (
        <div className="registryFriends__join">
          <JoinServer />
        </div>
      )}

      {server && (
        <div className="registryFriends__invite">
          <Button variant="outline" size="sm" onClick={() => void makeInvite()} disabled={busy}>
            <Link2 size={15} /> Invite a friend to your server
          </Button>
          {/* One-time migration: claim the account you already have on this
              server for your central identity, so it stays yours. Idempotent. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await linkAccount(server.url, server.token, token);
              }, 'Linked this server to your account.')
            }
          >
            Link this server to your account
          </Button>
          {inviteCode && (
            <p className="registryFriends__inviteCode">
              Code to read out or type in:{' '}
              <strong>
                {inviteCode.slice(0, 4)} {inviteCode.slice(4)}
              </strong>
            </p>
          )}
          {invite && (
            <div className="registryFriends__inviteLink">
              <Input readOnly value={invite} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(invite).then(() => setCopied(true)).catch(() => {});
                }}
              >
                <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}
        </div>
      )}

      {note && (
        <p className={`friendsNote friendsNote--${note.tone}`} role="status">
          {note.text}
        </p>
      )}

      {incoming.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Wants to be friends</h2>
          <div className="requestCards">
            {incoming.map((r) => (
              <div key={r.id} className="requestCard">
                <FriendAvatar handle={r.handle} size="md" />
                <span className="requestCard__handle">{r.handle}</span>
                <span className="requestCard__actions">
                  <Button variant="solid" size="sm" disabled={busy} onClick={() => void act(() => acceptFriendRequest(token, r.id))}>
                    <Check size={15} /> <span>Accept</span>
                  </Button>
                  <IconButton variant="ghost" size="sm" disabled={busy} aria-label={`Decline ${r.handle}`} onClick={() => void act(() => declineFriendRequest(token, r.id))}>
                    <X size={15} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Asks still in the air: a quiet strip of chips. They deserve a
          glance, not a section of full-width rows each carrying one word. */}
      {outgoing.length > 0 && (
        <div className="friendChips" aria-label="Sent requests">
          {outgoing.map((r) => (
            <span key={r.id} className="friendChip">
              <FriendAvatar handle={r.handle} size="sm" />
              {r.handle}
              <span className="friendChip__state">waiting</span>
            </span>
          ))}
        </div>
      )}

      <section className="homeShelf">
        <h2 className="homeShelfTitle">Friends{friends.length > 0 ? ` · ${friends.length}` : ''}</h2>
        {friends.length === 0 ? (
          <div className="emptyState">
            <EmptyArt name="friends" />
            <p className="emptyState__text">
              Nobody yet. Add someone by their handle, and they show up here once they say yes.
            </p>
          </div>
        ) : (
          <div className="friendGrid">
            {friends.map((f) => {
              const seen = seenAgo(f.seenAt);
              const online = seen === 'online now';
              return (
                <div key={f.id} className="friendCard" data-online={online || undefined}>
                  <FriendAvatar handle={f.handle} size="lg" className="friendCard__face" />
                  <span className="friendCard__handle">{f.handle}</span>
                  <span className="friendCard__meta">
                    {[
                      f.songs > 0 ? `${f.songs.toLocaleString()} songs` : 'no library yet',
                      seen,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="friendCard__remove"
                    disabled={busy}
                    aria-label={`Remove ${f.handle}`}
                    onClick={() => void act(() => removeFriend(token, f.id))}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
