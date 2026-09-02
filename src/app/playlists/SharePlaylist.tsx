import { Button, IconButton, Text, useToast } from '@glacier/react';
import { Check, Copy, Link2, LogOut, Share2, X } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { fetchFriends, mirrorFriendsToHub, type Friend } from '../api/friends.ts';
import type { PlaylistMember } from '../api/playlists.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { fetchFriends as fetchRegistryFriends, publishPlaylistShare } from '../servers/registry.ts';
import { useLibrary } from '../library/library.tsx';
import { artSized } from '../server.ts';
import type { Track } from '../core/tauri.ts';
import { GlassSheet } from '../ux/GlassSheet.tsx';
import { FriendAvatar } from '../profile/RegistryFriends.tsx';
import { usePlaylists, type Playlist } from './playlists.tsx';

/** A cover shrunk to a square thumbnail data URL for the link's mosaic - a
 *  few kilobytes, drawn from the hub's own art. Null where the picture will
 *  not draw (a cross-origin image the canvas may not read, a dead URL). */
function thumbnail(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 160;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        const m = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, (img.naturalWidth - m) / 2, (img.naturalHeight - m) / 2, m, m, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

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
  const { toast } = useToast();
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
    // A member may not be allowed to list the others; that is an empty
    // room, not a failure.
    const who = members ? members(playlist.id).catch(() => [] as PlaylistMember[]) : Promise.resolve([]);
    const token = registry?.session?.token ?? null;
    const account = token
      ? fetchRegistryFriends(token)
          .then((f) => f.friends.map((x) => x.handle))
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]);
    // The hub's friend list is a MIRROR of the registry's, and the mirror
    // bridge only passes every ten minutes - so the sheet mirrors first,
    // with the registry session so the hub verifies and settles at once,
    // and only then asks who is a friend here. A friend you invited an hour
    // ago is in this list on the first open, not the next.
    const hubFriends = account
      .then((handles) => (handles.length ? mirrorFriendsToHub(session, handles, token ?? undefined) : undefined))
      .then(() => fetchFriends(session))
      .then((f) => f.friends);
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

  /*
   * The link. Minted once per list and remembered on this device, so
   * opening the sheet twice does not mint twice; the songs it names are the
   * list's songs AT MINT TIME - a link is a snapshot, like a screenshot of a
   * list is. (A living link would need the registry to hold the playlist,
   * which is the hub's job.)
   */
  const { tracks } = useLibrary();
  const linkKey = `attackfm-playlist-link:${session?.url ?? 'local'}#${playlist.id}`;
  const [link, setLink] = useState<string | null>(() => {
    try {
      return localStorage.getItem(linkKey);
    } catch {
      return null;
    }
  });
  const [linking, setLinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const canShareLink = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const makeLink = async () => {
    const token = registry?.session?.token;
    if (!token || linking) return;
    setLinking(true);
    setError(null);
    try {
      const byPath = new Map(tracks.map((t) => [t.path, t] as const));
      const rows = playlist.paths.map((p) => byPath.get(p)).filter((t): t is Track => t !== undefined);
      const covers = (
        await Promise.all(
          [...new Set(rows.map((t) => t.artwork).filter((a): a is string => !!a))].slice(0, 4).map((a) => {
            const src = artSized(a, 160);
            return src ? thumbnail(src) : Promise.resolve<string | null>(null);
          }),
        )
      ).filter((c): c is string => c !== null);
      const made = await publishPlaylistShare(token, {
        name: playlist.name,
        description: playlist.description,
        tracks: rows.map((t) => ({
          artist: t.artist,
          title: t.title,
          album: t.album,
          durationMs: t.duration ? Math.round(t.duration * 1000) : null,
        })),
        covers,
      });
      setLink(made.url);
      try {
        localStorage.setItem(linkKey, made.url);
      } catch {
        // Minted again next time; the registry does not mind.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make a link just now.');
    } finally {
      setLinking(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ message: 'Could not copy - long-press the link to select it.' });
    }
  };

  const shareLink = async () => {
    if (!link) return;
    try {
      await navigator.share({ title: playlist.name, text: `${playlist.name} - a playlist on AttackFM`, url: link });
    } catch {
      // A closed sheet is a decision.
    }
  };

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

      {!loading && (
        <section className="shareSheet__room">
          <h3 className="shareSheet__h">Share a link</h3>
          <Text tone="muted" size="sm" className="shareSheet__empty">
            For anyone, on any server or none: the link carries the songs by name and unfurls
            like a Spotify embed. Opened in AttackFM, it files the playlist onto their own
            server, which fetches what they do not have.
          </Text>
          {link ? (
            <div className="shareSheet__link">
              <span className="shareSheet__url">{link.replace(/^https?:\/\//, '')}</span>
              <span className="shareSheet__seats">
                <Button size="sm" variant="solid" onClick={() => void copyLink()}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </Button>
                {canShareLink && (
                  <Button size="sm" variant="outline" onClick={() => void shareLink()}>
                    <Share2 size={15} />
                    <span>Send</span>
                  </Button>
                )}
              </span>
            </div>
          ) : (
            <div className="shareSheet__link">
              <Button size="sm" variant="outline" disabled={linking || !registry?.session || playlist.paths.length === 0} onClick={() => void makeLink()}>
                <Link2 size={15} />
                <span>{linking ? 'Making the link…' : 'Make a link'}</span>
              </Button>
              {!registry?.session && (
                <Text tone="muted" size="xs">
                  Links come from your AttackFM account - sign in under Profile first.
                </Text>
              )}
            </div>
          )}
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
