import { Button, Drawer, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import { fetchFriends, type Friend } from '../api/friends.ts';
import type { PlaylistMember } from '../api/playlists.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { usePlaylists, type Playlist } from './playlists.tsx';

/**
 * Who a playlist is open to - a drawer of your friends on this server, each
 * with a role you can set or clear.
 *
 * Friends, and only friends, because the friendship is the consent: the hub
 * refuses a share aimed at anyone else, so the list here is exactly the set
 * of people a share can reach. That list is the hub's own (`/api/friends`,
 * user ids on THIS box), not the registry's cross-server graph - a playlist
 * is rows on one server, and so is a collaborator.
 *
 * Three states per friend, one tap each: off, can view, can edit. An editor
 * adds and removes songs; a viewer sees and plays. Renaming, reordering,
 * covers and deletion stay the owner's, so the worst a collaborator can do
 * to your list is put a song in it.
 */

type Role = 'off' | 'viewer' | 'editor';

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
  const { members, share, unshare } = usePlaylists();
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [current, setCurrent] = useState<PlaylistMember[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Both lists fetched fresh on every open: a friend made a minute ago should
  // be here, and a member removed from another device should not.
  useEffect(() => {
    if (!open || !session || !members) return;
    let live = true;
    setError(null);
    void Promise.all([fetchFriends(session), members(playlist.id)])
      .then(([feed, who]) => {
        if (!live) return;
        setFriends(feed.friends);
        setCurrent(who);
      })
      .catch(() => {
        if (live) setError('Could not reach the server just now.');
      });
    return () => {
      live = false;
    };
  }, [open, session, members, playlist.id]);

  const roleOf = (userId: number): Role =>
    current.find((m) => m.userId === userId)?.role ?? 'off';

  const setRole = async (userId: number, role: Role) => {
    if (!share || !unshare || busy !== null) return;
    setBusy(userId);
    setError(null);
    // Optimistic, then the truth: a refused change is put back below.
    const before = current;
    setCurrent((cur) =>
      role === 'off'
        ? cur.filter((m) => m.userId !== userId)
        : cur.some((m) => m.userId === userId)
          ? cur.map((m) => (m.userId === userId ? { ...m, role } : m))
          : [
              ...cur,
              { userId, username: friends?.find((f) => f.userId === userId)?.username ?? '', role },
            ],
    );
    try {
      if (role === 'off') await unshare(playlist.id, userId);
      else await share(playlist.id, { userId }, role);
    } catch (err) {
      setCurrent(before);
      setError(err instanceof Error ? err.message : 'That change did not take.');
    } finally {
      setBusy(null);
    }
  };

  // Members who are no longer friends still hold their seat until the owner
  // shows them out - listed after the friends so that stays possible.
  const strangers = current.filter((m) => !(friends ?? []).some((f) => f.userId === m.userId));
  const rows: Friend[] = [
    ...(friends ?? []),
    ...strangers.map((m) => ({ userId: m.userId, username: m.username })),
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="bottom"
      size="lg"
      title="Share with friends"
      description={`Who can see “${playlist.name}”.`}
      className="sharePlaylist"
    >
      {error && (
        <Text tone="danger" size="sm" className="sharePlaylist__note">
          {error}
        </Text>
      )}
      {friends === null && !error ? (
        <Text tone="muted" size="sm" className="sharePlaylist__note">
          Loading your friends…
        </Text>
      ) : rows.length === 0 ? (
        <Text tone="muted" size="sm" className="sharePlaylist__note">
          You can share with friends on this server. Add some under Profile → Friends, then
          come back here.
        </Text>
      ) : (
        <ul className="sharePlaylist__list">
          {rows.map((f) => {
            const role = roleOf(f.userId);
            const seat = (r: Role, label: string) => (
              <Button
                size="sm"
                variant={role === r ? 'solid' : 'ghost'}
                aria-pressed={role === r}
                disabled={busy === f.userId}
                onClick={() => void setRole(f.userId, r)}
              >
                {label}
              </Button>
            );
            return (
              <li key={f.userId} className="sharePlaylist__row">
                <span className="sharePlaylist__name">{f.username}</span>
                <span className="sharePlaylist__seats">
                  {seat('off', 'Off')}
                  {seat('viewer', 'Can view')}
                  {seat('editor', 'Can edit')}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
