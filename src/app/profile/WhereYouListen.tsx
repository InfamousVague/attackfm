import { Button, IconButton, Modal, Input, Spinner, Text } from '@glacier/react';
import { Copy, Link2, Plus, Server, X } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistry } from '../servers/registrySession.tsx';
import { JoinServer } from '../servers/JoinServer.tsx';
import { createInvite, inviteLink } from '../servers/registry.ts';
import { enterServer, fetchServerInfo, linkAccount } from '../server.ts';
import { forgetServer, knownServers, rememberServer, type KnownServer } from '../servers/servers.ts';
import { fetchSavedServers, forgetServerEverywhere } from '../servers/serverSync.ts';

//! Where you listen - every server this device has entered, as cards.
//!
//! Lifted whole from the Profile page: which box the music comes from is
//! plumbing, not personality, so it lives in Settings now with the rest of
//! the machinery. The section is unchanged in behaviour - the one you are on
//! wears a live badge, any other is a one-tap switch (membership re-proved by
//! the registry each time), and the two doors stay: invite a friend into the
//! server you host, join another with an invite code.

/** A registry-shaped failure, told the way the server said it - its 403 line
 *  ("This server is invite-only…") is already the honest instruction. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'That did not work.';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

/**
 * Where you listen: every server this device has entered, as cards. The one
 * you are on wears a live badge; any other is a one-tap switch (membership is
 * re-proved by the registry each time - no invite needed where you already
 * belong). Then the two doors, always visible: share the server you host,
 * and join another with an invite.
 */
export function WhereYouListen() {
  const { session, applySession, pivot } = useServerSession();
  const { session: registry, account } = useRegistry();

  const [saved, setSaved] = useState<KnownServer[]>(() => knownServers());
  const refresh = () => setSaved(knownServers());
  // The account's list, fetched fresh: what the OTHER devices saved. This is
  // the half that makes a new phone arrive already knowing its servers.
  const [accountServers, setAccountServers] = useState<{ url: string; name: string; isAdmin: boolean }[]>([]);
  useEffect(() => {
    if (!registry) return;
    let live = true;
    void fetchSavedServers().then((list) => {
      if (!live) return;
      setAccountServers(
        list.map((m) => ({
          url: m.serverUrl.replace(/\/+$/, ''),
          name: m.serverName,
          isAdmin: m.role === 'owner',
        })),
      );
    });
    return () => {
      live = false;
    };
  }, [registry]);

  // Names arrive lazily: /api/server answers without auth, and the answer is
  // written back to the ledger so the next visit paints it immediately.
  useEffect(() => {
    let live = true;
    for (const s of saved) {
      if (s.name) continue;
      void fetchServerInfo(s.url)
        .then((info) => {
          if (!live) return;
          rememberServer({ url: s.url, name: info.name, lastUsed: s.lastUsed });
          refresh();
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- backfill pass per mount
  }, []);

  const [busyUrl, setBusyUrl] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const switchTo = useCallback(
    async (url: string) => {
      if (!registry) {
        setNote({
          tone: 'bad',
          text: 'Switching needs your AttackFM account signed in — or sign in from Settings → Server.',
        });
        return;
      }
      setBusyUrl(url);
      setNote(null);
      try {
        // A server this device already holds is a local pivot - no round
        // trip, no fresh token, nothing torn down that need not be.
        if (!pivot(url)) {
          const next = await enterServer(url, registry.token);
          applySession(next);
        }
        refresh();
        setNote({ tone: 'ok', text: `Listening from ${hostOf(url)} now.` });
      } catch (err) {
        setNote({ tone: 'bad', text: messageOf(err) });
      } finally {
        setBusyUrl(null);
      }
    },
    [registry, applySession, pivot],
  );

  // A friend's card said "visit": the page lands the attempt here, where the
  // outcome (in, or the invite-only truth) shows beside every other server.

  // The current session leads even if the ledger predates it.
  const cards = useMemo(() => {
    const current = session?.url ?? null;
    const list = [...saved];
    if (current && !list.some((s) => s.url === current)) {
      list.unshift({ url: current, username: session?.username, isAdmin: session?.isAdmin, lastUsed: Date.now() });
    }
    // Servers the ACCOUNT knows that this device does not: merged in as
    // ordinary cards, because to the person they are the same thing - a place
    // they belong. The switch re-proves membership through the registry, so a
    // card from another device works here without any credential having
    // travelled. lastUsed 0 files them under everything this device has
    // actually touched.
    for (const a of accountServers) {
      if (list.some((s) => s.url === a.url)) continue;
      list.push({ url: a.url, name: a.name || undefined, isAdmin: a.isAdmin, lastUsed: 0 });
    }
    return list.sort((a, b) => Number(b.url === current) - Number(a.url === current) || b.lastUsed - a.lastUsed);
  }, [saved, session, accountServers]);

  // Sharing: mint an invite for the CURRENT server. Any member may mint - the
  // server checks the invite with the registry when it is spent.
  const [shareOpen, setShareOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [minting, setMinting] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const mint = async () => {
    if (!registry || !session) return;
    setMinting(true);
    setShareNote(null);
    try {
      const made = await createInvite(
        registry.token,
        session.url,
        session.username ? `${session.username}'s AttackFM` : 'AttackFM',
      );
      setLink(inviteLink(made.code));
      setCode(made.code);
      setCopied(false);
    } catch (err) {
      setShareNote(messageOf(err));
    } finally {
      setMinting(false);
    }
  };

  return (
    <div className="prefsBody serversSection">

      {note && (
        <p className={`friendsNote friendsNote--${note.tone}`} role="status">
          {note.text}
        </p>
      )}

      <div className="serverCards">
        {cards.map((s) => {
          const current = session?.url === s.url;
          return (
            <div key={s.url} className="serverCard" data-current={current || undefined}>
              <span className="serverCard__glyph" aria-hidden>
                <Server size={18} />
              </span>
              <span className="serverCard__body">
                <span className="serverCard__name">{s.name ?? hostOf(s.url)}</span>
                <span className="serverCard__meta">
                  {[
                    s.name ? hostOf(s.url) : null,
                    s.isAdmin ? 'you host this' : s.username ? `as ${s.username}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || ' '}
                </span>
              </span>
              {current ? (
                <span className="serverCard__live">
                  <span className="serverCard__dot" aria-hidden /> Listening
                </span>
              ) : (
                <span className="serverCard__actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyUrl !== null}
                    onClick={() => void switchTo(s.url)}
                  >
                    {busyUrl === s.url ? <Spinner size="sm" aria-label="" /> : 'Switch'}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={`Forget ${s.name ?? hostOf(s.url)}`}
                    title="Forget this server"
                    onClick={() => {
                      forgetServer(s.url);
                      void forgetServerEverywhere(s.url);
                      setAccountServers((list) => list.filter((a) => a.url !== s.url));
                      refresh();
                    }}
                  >
                    <X size={14} />
                  </IconButton>
                </span>
              )}
            </div>
          );
        })}

        {/* The two doors - present whether or not any card is, because "how do
            I share mine" and "how do I get into theirs" are the questions this
            section exists to answer. */}
        {session && registry && (
          <button type="button" className="serverCard serverCard--verb" onClick={() => { setShareNote(null); setShareOpen(true); }}>
            <span className="serverCard__glyph serverCard__glyph--accent" aria-hidden>
              <Link2 size={18} />
            </span>
            <span className="serverCard__body">
              <span className="serverCard__name">Invite a friend here</span>
              <span className="serverCard__meta">A link that signs them in — no password to share</span>
            </span>
          </button>
        )}
        <button type="button" className="serverCard serverCard--verb" onClick={() => setJoinOpen(true)}>
          <span className="serverCard__glyph serverCard__glyph--accent" aria-hidden>
            <Plus size={18} />
          </span>
          <span className="serverCard__body">
            <span className="serverCard__name">Join another server</span>
            <span className="serverCard__meta">Enter the invite code a friend sent you</span>
          </span>
        </button>
      </div>

      <Modal open={shareOpen} onClose={() => setShareOpen(false)} title="Invite a friend to this server" size="sm">
        <div className="friendsModal">
          {!link ? (
            <>
              <Text size="sm" tone="muted">
                Mint a one-time link that signs a friend into{' '}
                <strong>{session ? (cards.find((c) => c.url === session.url)?.name ?? hostOf(session.url)) : 'this server'}</strong>{' '}
                as themselves. Send it however you like; it works once.
              </Text>
              <Button variant="solid" onClick={() => void mint()} disabled={minting}>
                {minting ? 'Making…' : 'Create invite link'}
              </Button>
            </>
          ) : (
            <>
              <div className="registryFriends__inviteLink">
                <Input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => {});
                  }}
                >
                  <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              {code && (
                <p className="registryFriends__inviteCode">
                  Or read the code out:{' '}
                  <strong>
                    {code.slice(0, Math.ceil(code.length / 2))} {code.slice(Math.ceil(code.length / 2))}
                  </strong>
                </p>
              )}
              <Button variant="outline" size="sm" onClick={() => void mint()} disabled={minting}>
                {minting ? 'Making…' : 'New link'}
              </Button>
            </>
          )}
          {shareNote && (
            <p className="friendsNote friendsNote--bad" role="status">
              {shareNote}
            </p>
          )}
          {session && registry && account && (
            <div className="friendsModal__aside">
              {/* One-time migration: claim the account you already have on this
                  server for your central identity, so it stays yours. Idempotent. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void linkAccount(session.url, session.token, registry.token)
                    .then(() => setShareNote('Linked this server to your account.'))
                    .catch((err) => setShareNote(messageOf(err)));
                }}
              >
                Link this server to your account
              </Button>
              <Text size="sm" tone="muted">
                Already had an account here before @{account.handle}? Claim it once and it follows you.
              </Text>
            </div>
          )}
        </div>
      </Modal>

      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title="Join another server" size="sm">
        <div className="friendsModal">
          <JoinServer />
          <Text size="sm" tone="muted">
            Joining switches you there; this page keeps every server you have
            joined, so coming back is one tap. A server signed into with a
            password instead lives in Settings → Server.
          </Text>
        </div>
      </Modal>
    </div>
  );
}
