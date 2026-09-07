import { Button, Text } from '@glacier/react';
import { Check, Disc3, LogIn, ListMusic, Music, User, Users } from '@glacier/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRegistry } from './registrySession.tsx';
import { useServerSession } from './serverSession.tsx';
import { AccountForm } from './AccountForm.tsx';
import { previewInvite, type InvitePreview } from './registry.ts';
import { enterServer, fetchServerInfo, type ServerInfo } from '../server.ts';
import { rememberSession, sessionForOrigin } from './sessions.ts';
import { normalizeServerUrl } from '../server.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

/**
 * An invite LINK, tapped: one card, one button.
 *
 * The link already carries the code, so nobody should be handed six empty
 * cells to type it into (that is JoinServer, for a code read off a picture).
 * This reads the invite off the registry and the server's own glance off
 * the server - how much music, how many people, whose it is - and offers
 * Join. Without an AttackFM account yet, the account form sits in the same
 * card and joining follows the sign-in straight through.
 *
 * Joining ADDS the server to the ones this account listens from and makes
 * it the one on screen; nothing else is signed out.
 */
export function JoinCard({
  code,
  onDone,
  auto = false,
}: {
  code: string;
  onDone: () => void;
  /**
   * Join without waiting for the button. For a link that was tapped: the
   * tap was the decision, and asking again is what made "open the link
   * again after signing up" a two-step. A card opened any other way (a code
   * typed in) still waits for Join.
   */
  auto?: boolean;
}) {
  const t = useT();
  const { session: registry, apply: applyRegistry } = useRegistry();
  const { applySession, pivot } = useServerSession();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One automatic attempt per card: a failure lands on the button, not a loop.
  const autoFired = useRef(false);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setInfo(null);
    setError(null);
    previewInvite(code.toUpperCase())
      .then((p) => {
        if (!live) return;
        if (p.spent) setError(t('servers.inviteSpent'));
        else if (p.expired) setError(t('servers.inviteExpired'));
        else setPreview(p);
        // The server's glance, from the server: a box that is asleep or
        // unreachable from here still leaves a joinable card, just a quieter one.
        if (!p.spent && !p.expired && p.serverUrl) {
          fetchServerInfo(p.serverUrl)
            .then((i) => {
              if (live) setInfo(i);
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (live) setError(t('servers.inviteNotFound'));
      });
    return () => {
      live = false;
    };
  }, [code, t]);

  const join = async (identity = registry) => {
    if (!identity || !preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await enterServer(preview.serverUrl, identity.token, code.toUpperCase());
      // Kept alongside the servers this account already listens from, and
      // made the one on screen.
      rememberSession(session, true);
      applySession(session);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('servers.couldNotJoin'));
    } finally {
      setBusy(false);
    }
  };

  // Already signed into the server the invite names - the owner following
  // their own link, a member tapping it twice. There is nothing to join and
  // nothing to sign up for: the card says so and opens the server.
  const held = preview?.serverUrl ? sessionForOrigin(normalizeServerUrl(preview.serverUrl)) : null;

  // The automatic join, once the invite has been read and an identity is in
  // hand. Signed out, the account form below hands its identity to join()
  // itself, so nothing fires here until then.
  useEffect(() => {
    if (!auto || !registry || !preview || held || autoFired.current) return;
    autoFired.current = true;
    void join();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per card, on the first render that has both
  }, [auto, registry, preview, held]);

  const name = preview?.serverName || info?.name || t('servers.aServer');
  // The owner is what the SERVER says; the inviter is who sent the link.
  // They are usually the same person, but any member may mint an invite,
  // and a card that called the inviter the owner would be lying.
  const owner = info?.owner || '';
  /*
   * The glance. The count sits in its own cell, so the label is the noun ALONE
   * and `count` only picks which form of it - which is also why every row is
   * plural-aware now: "1 artists" was reachable before and is not a thing a
   * translator could have fixed from the catalogue.
   *
   * `id` rather than the label as the React key: a translated label is not a
   * stable identity, and it would change under React on every language switch.
   */
  const stats: { id: string; icon: ReactNode; value: number; label: string }[] = info
    ? [
        { id: 'songs', icon: <Music size={14} />, value: info.tracks, label: t('servers.glanceSongs', { count: info.tracks }) },
        ...(typeof info.artists === 'number' ? [{ id: 'artists', icon: <User size={14} />, value: info.artists, label: t('servers.glanceArtists', { count: info.artists }) }] : []),
        ...(typeof info.albums === 'number' ? [{ id: 'albums', icon: <Disc3 size={14} />, value: info.albums, label: t('servers.glanceAlbums', { count: info.albums }) }] : []),
        ...(typeof info.playlists === 'number' ? [{ id: 'playlists', icon: <ListMusic size={14} />, value: info.playlists, label: t('servers.glancePlaylists', { count: info.playlists }) }] : []),
        ...(typeof info.members === 'number' ? [{ id: 'members', icon: <Users size={14} />, value: info.members, label: t('servers.glanceMembers', { count: info.members }) }] : []),
      ]
    : [];

  return (
    <div className="joinCard">
      {error ? (
        <Text tone="danger" size="sm">
          {error}
        </Text>
      ) : !preview ? (
        <Text tone="muted" size="sm">
          {t('servers.readingInvite')}
        </Text>
      ) : (
        <>
          <div className="joinCard__head">
            <span className="joinCard__mark" aria-hidden>
              {name.slice(0, 1).toUpperCase()}
            </span>
            <div className="joinCard__who">
              <h3 className="joinCard__name">{name}</h3>
              <Text tone="muted" size="sm">
                {/* Whose it is, and who sent it - two readings on one line,
                    each its own entry, joined rather than concatenated. */}
                {[
                  owner ? t('servers.ownersServer', { owner }) : t('servers.aServerOnAttackFm'),
                  ...(preview.from ? [t('servers.invitedBy', { from: preview.from })] : []),
                ].join(' · ')}
              </Text>
            </div>
          </div>
          {stats.length > 0 ? (
            <ul className="joinCard__stats">
              {stats.map((s) => (
                <li key={s.id} className="joinCard__stat">
                  <span className="joinCard__statIcon" aria-hidden>
                    {s.icon}
                  </span>
                  <span className="joinCard__statValue">{formatNumber(s.value)}</span>
                  <span className="joinCard__statLabel">{s.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Text tone="muted" size="xs">
              {t('servers.notAnsweringYet')}
            </Text>
          )}
          {held ? (
            <>
              <Text size="sm" tone="muted">
                <Check size={14} /> {held.isAdmin ? t('servers.thisIsYourServer') : t('servers.alreadyMember', { name })}
              </Text>
              <Button
                variant="solid"
                size="lg"
                className="joinCard__join"
                onClick={() => {
                  pivot(held.url);
                  onDone();
                }}
              >
                <LogIn size={16} /> {t('servers.openNamed', { name })}
              </Button>
            </>
          ) : registry ? (
            <Button variant="solid" size="lg" className="joinCard__join" disabled={busy} onClick={() => void join()}>
              <LogIn size={16} /> {busy ? t('servers.joining') : t('servers.joinNamed', { name })}
            </Button>
          ) : (
            <>
              <Text size="sm" tone="muted">
                {t('servers.joinNeedsAccount')}
              </Text>
              <AccountForm
                defaultMode="create"
                className="joinCard__account"
                onDone={(made) => {
                  applyRegistry(made);
                  void join(made);
                }}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
