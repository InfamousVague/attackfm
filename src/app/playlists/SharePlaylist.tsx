import { Button, IconButton, Text } from '@glacier/react';
import { LogOut, X } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { fetchFriends, type Friend } from '../api/friends.ts';
import type { PlaylistMember } from '../api/playlists.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { fetchFriends as fetchRegistryFriends } from '../servers/registry.ts';
import { GlassSheet } from '../ux/GlassSheet.tsx';
import { FriendAvatar } from '../profile/RegistryFriends.tsx';
import { usePlaylists, type Playlist } from './playlists.tsx';

/**
 * Sharing a playlist with other people on AttackFM - the glass sheet.
 *
 * Three rooms, top to bottom:
 *
 *   Shared with      who is in already, with the seat they hold. The owner
 *                    can move a seat (view ↔ edit) or show someone out.
 *   Friends here     friends on THIS server who are not in yet - one tap
 *                    seats them as a viewer or an editor.
 *   Friends elsewhere friends from your AttackFM account who are not members
 *                    of this server. A playlist is rows on one box, and so
 *                    is a collaborator, so they cannot be seated - the sheet
 *                    says so instead of hiding them, and points at the way
 *                    in (the invite card in Library).
 *
 * Friends, and only friends, because the friendship is the consent: the hub
 * refuses a share aimed at anyone else. An editor adds and removes songs; a
 * viewer sees and plays. Renaming, reordering, covers and deletion stay the
 * owner's, so the worst a collaborator can do to your list is put a song in
 * it.
 *
 * A member (not the owner) opens the same sheet and sees who else is in, and
 * the door out.
 */

type Seat = 'viewer' | 'editor';

export function SharePlaylistDrawer({
  playlist,
  open,
  onClose,
}: {
  playlist: Playlist;
  open: boolean;
  onClose: () => void;
}) {
  const { session } = useServerSession();
  const registry = useRegistryOptional();
  const { members, share, unshare, leave } = usePlaylists();
  const isOwner = !playlist.role || playlist.role === 'owner';

  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [current, setCurrent] = useState<PlaylistMember[] | null>(null);
  const [elsewhere, setElsewhere] = useState<string[]>([]);
  const [busy, setBusy] = useState<number | 'leave' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Everything fetched fresh on every open: a friend made a minute ago should
  // be here, and a member removed from another device should not.
  useEffect(() => {
    if (!open || !session) return;
    let live = true;
    setError(null);
    const hubFriends = fetchFriends(session).then((f) => f.friends);
    // A member may not be allowed to list the others; that is an empty
    // room, not a failure.
    const who = members ? members(playlist.id).catch(() => [] as PlaylistMember[]) : Promise.resolve([]);
    const account = registry?.session
      ? fetchRegistryFriends(registry.session.token)
          .then((f) => f.friends.map((x) => x.handle))
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]);
    void Promise.all([hubFriends, who, account])
      .then(([hub, seated, handles]) => {
        if (!live) return;
        setFriends(hub);
        setCurrent(seated);
        const here = new Set(hub.map((f) => f.username.toLowerCase()));
        const me = registry?.session?.account.handle.toLowerCase();
        setElsewhere(handles.filter((h) => h.toLowerCase() !== me && !here.has(h.toLowerCase())));
      })
      .catch(() => {
        if (live) setError('Could not reach the server just now.');
      });
    return () => {
      live = false;
    };
  }, [open, session, members, playlist.id, registry?.session]);

  const seated = current ?? [];
  const nameOf = (userId: number) =>
    seated.find((m) => m.userId === userId)?.username ??
    friends?.find((f) => f.userId === userId)?.username ??
    '';

  const setSeat = async (userId: number, seat: Seat | null) => {
    if (!share || !unshare || busy !== null) return;
    setBusy(userId);
    setError(null);
    // Optimistic, then the truth: a refused change is put back below.
    const before = current;
    setCurrent((cur) => {
      const list = cur ?? [];
      if (seat === null) return list.filter((m) => m.userId !== userId);
      return list.some((m) => m.userId === userId)
        ? list.map((m) => (m.userId === userId ? { ...m, role: seat } : m))
        : [...list, { userId, username: nameOf(userId), role: seat }];
    });
    try {
      if (seat === null) await unshare(playlist.id, userId);
      else await share(playlist.id, { userId }, seat);
    } catch (err) {
      setCurrent(before);
      setError(err instanceof Error ? err.message : 'That change did not take.');
    } finally {
      setBusy(null);
    }
  };

  const walkOut = async () => {
    if (!leave || busy !== null) return;
    setBusy('leave');
    try {
      await leave(playlist.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not leave just now.');
    } finally {
      setBusy(null);
    }
  };

  // Friends on this server who are not seated yet, by name.
  const candidates = useMemo(
    () =>
      (friends ?? [])
        .filter((f) => !seated.some((m) => m.userId === f.userId))
        .sort((a, b) => a.username.localeCompare(b.username)),
    [friends, seated],
  );

  const loading = friends === null && !error;

  return (
    <GlassSheet open={open} onClose={onClose} label="Share playlist" className="shareSheet">
      <h2 className="shareSheet__title">Share “{playlist.name}”</h2>
      <p className="shareSheet__desc">
        {isOwner
          ? 'Friends on this server can see it, or add to it. It stays yours.'
          : `Shared by ${playlist.ownerName ?? 'a friend'} · you can ${playlist.role === 'editor' ? 'add and remove songs' : 'see and play it'}.`}
      </p>

      {error && (
        <Text tone="danger" size="sm" className="shareSheet__note">
          {error}
        </Text>
      )}
      {loading && (
        <Text tone="muted" size="sm" className="shareSheet__note">
          Finding your friends…
        </Text>
      )}

      {!loading && (
        <section className="shareSheet__room">
          <h3 className="shareSheet__h">
            Shared with
            <span className="shareSheet__count">{seated.length}</span>
          </h3>
          {seated.length === 0 ? (
            <Text tone="muted" size="sm" className="shareSheet__empty">
              {isOwner ? 'Nobody yet.' : 'Only you and the owner.'}
            </Text>
          ) : (
            <ul className="shareSheet__list">
              {seated.map((m) => (
                <li key={m.userId} className="shareSheet__row">
                  <FriendAvatar handle={m.username} size="md" />
                  <span className="shareSheet__name">{m.username}</span>
                  {isOwner && share ? (
                    <span className="shareSheet__seats" role="radiogroup" aria-label={`${m.username}'s seat`}>
                      <Button
                        size="sm"
                        variant={m.role === 'viewer' ? 'solid' : 'ghost'}
                        aria-pressed={m.role === 'viewer'}
                        disabled={busy !== null}
                        onClick={() => void setSeat(m.userId, 'viewer')}
                      >
                        View
                      </Button>
                      <Button
                        size="sm"
                        variant={m.role === 'editor' ? 'solid' : 'ghost'}
                        aria-pressed={m.role === 'editor'}
                        disabled={busy !== null}
                        onClick={() => void setSeat(m.userId, 'editor')}
                      >
                        Edit
                      </Button>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${m.username}`}
                        disabled={busy !== null}
                        onClick={() => void setSeat(m.userId, null)}
                      >
                        <X size={15} />
                      </IconButton>
                    </span>
                  ) : (
                    <span className="shareSheet__pill">{m.role === 'editor' ? 'Can edit' : 'Can view'}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!loading && isOwner && share && (
        <section className="shareSheet__room">
          <h3 className="shareSheet__h">Friends on this server</h3>
          {candidates.length === 0 ? (
            <Text tone="muted" size="sm" className="shareSheet__empty">
              {(friends ?? []).length === 0
                ? 'No friends on this server yet. Add friends under Profile → Friends; once they are members here, they appear in this list.'
                : 'Everyone is in.'}
            </Text>
          ) : (
            <ul className="shareSheet__list">
              {candidates.map((f) => (
                <li key={f.userId} className="shareSheet__row">
                  <FriendAvatar handle={f.username} size="md" />
                  <span className="shareSheet__name">{f.username}</span>
                  <span className="shareSheet__seats">
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void setSeat(f.userId, 'viewer')}>
                      Can view
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void setSeat(f.userId, 'editor')}>
                      Can edit
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!loading && isOwner && elsewhere.length > 0 && (
        <section className="shareSheet__room shareSheet__room--away">
          <h3 className="shareSheet__h">Friends elsewhere</h3>
          <ul className="shareSheet__list">
            {elsewhere.map((h) => (
              <li key={h} className="shareSheet__row shareSheet__row--away">
                <FriendAvatar handle={h} size="md" />
                <span className="shareSheet__name">{h}</span>
                <span className="shareSheet__pill">Not on this server</span>
              </li>
            ))}
          </ul>
          <Text tone="muted" size="xs" className="shareSheet__hint">
            A playlist lives on one server, so only its members can be let in. Invite them with
            the share button in Library; once they join, they appear above.
          </Text>
        </section>
      )}

      {!isOwner && leave && (
        <div className="shareSheet__foot">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void walkOut()}>
            <LogOut size={15} />
            <span>{busy === 'leave' ? 'Leaving…' : 'Leave this playlist'}</span>
          </Button>
        </div>
      )}
    </GlassSheet>
  );
}
