import { Button, IconButton, SegmentedControl, Text, useToast } from '@glacier/react';
import { Check, Copy, Download, ListMusic, LogOut, X } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { fetchFriends, fetchMembers, mirrorFriendsToHub, type Friend, type Member } from '../api/friends.ts';
import type { PlaylistMember } from '../api/playlists.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { fetchFriends as fetchRegistryFriends, publishPlaylistShare } from '../servers/registry.ts';
import { useLibrary } from '../library/library.tsx';
import { artSized } from '../server.ts';
import type { Track } from '../core/tauri.ts';
import { GlassSheet } from '../ux/GlassSheet.tsx';
import { FriendAvatar } from '../profile/RegistryFriends.tsx';
import { shoot } from '../widget/shot.ts';
import { saveCardImage } from '../widget/saveCard.ts';
import logo from '../../assets/attack-white.png';
import { usePlaylists, type Playlist } from './playlists.tsx';

/**
 * Sharing a playlist - the glass sheet, two faces behind one toggle.
 *
 * LINK (the default): a card, the way the invite is a card - the list's
 * picture (its cover, or a mosaic of its songs' covers), its name, who is
 * sharing it, and a QR of its link - with Save image and Copy link under
 * it. The link carries the songs by name and unfurls like a Spotify embed;
 * opened in AttackFM by anyone, on any server or none, it files the list
 * onto their own server, which fetches what they do not have. The card is
 * the same picture the PNG is: widget/shot.ts rasterises this DOM, so
 * everything on it sits on solid paint and every image is a data URL (a
 * hub's art URL would not draw inside the shot).
 *
 * FRIENDS: who on THIS server is in and the seat they hold; friends here one
 * tap from a seat; friends elsewhere named as out of reach. A hub playlist
 * is rows on one box, and so is a collaborator - that is what the link is
 * for. Friends, and only friends, because the friendship is the consent.
 * A member (not the owner) sees who else is in, and the door out.
 */

type Seat = 'viewer' | 'editor';
type Face = 'link' | 'friends';

/** A cover shrunk to a square thumbnail data URL - a few kilobytes, drawn
 *  from the hub's own art, and the only form of picture the card's shot can
 *  carry. Null where it will not draw (a dead URL, an image the canvas may
 *  not read). */
function thumbnail(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 320;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        const m = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, (img.naturalWidth - m) / 2, (img.naturalHeight - m) / 2, m, m, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'playlist';
}

function PlaylistCard({
  cardRef,
  playlist,
  covers,
  by,
  link,
  qr,
  count,
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  playlist: Playlist;
  covers: string[];
  by: string;
  link: string | null;
  qr: string | null;
  count: number;
}) {
  return (
    <div className="shareCard" ref={cardRef}>
      <div className="shareCard__head">
        <img className="shareCard__logo" src={logo} alt="AttackFM" />
        <span className="shareCard__kicker">Playlist</span>
      </div>
      <div className="shareCard__art" data-n={Math.min(covers.length, 4)}>
        {covers.length > 0 ? (
          covers.slice(0, 4).map((c, i) => <img key={i} src={c} alt="" />)
        ) : (
          <span className="shareCard__artEmpty" aria-hidden>
            <ListMusic size={40} />
          </span>
        )}
      </div>
      <p className="shareCard__name">{playlist.name}</p>
      <p className="shareCard__sub">
        {count} {count === 1 ? 'song' : 'songs'}
        {by ? ` · shared by @${by}` : ''}
      </p>
      <div className="shareCard__qrRow">
        {qr ? <img className="shareCard__qr" src={qr} alt="Link as a QR code" /> : <span className="shareCard__qr" aria-hidden />}
        <div className="shareCard__linkWrap">
          <span className="shareCard__linkLabel">Scan, or open</span>
          <span className="shareCard__link">{link ? link.replace(/^https?:\/\//, '') : 'making the link…'}</span>
        </div>
      </div>
      <p className="shareCard__foot">attack.fm · opens in the app, or in any browser</p>
    </div>
  );
}

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
  const { tracks } = useLibrary();
  const isOwner = !playlist.role || playlist.role === 'owner';
  const [face, setFace] = useState<Face>('link');

  // ---- the friends face --------------------------------------------------

  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [current, setCurrent] = useState<PlaylistMember[] | null>(null);
  const [elsewhere, setElsewhere] = useState<string[]>([]);
  // Everyone on this server, when the hub can say (null on an older hub, and
  // the sheet falls back to friends only). Being here is the consent now -
  // see the server's playlist_member_add.
  const [roster, setRoster] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState<number | 'leave' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Everything fetched fresh on every open: a friend made a minute ago should
  // be here, and a member removed from another device should not.
  useEffect(() => {
    if (!open || !session) return;
    let live = true;
    setError(null);
    const who = members ? members(playlist.id).catch(() => [] as PlaylistMember[]) : Promise.resolve([]);
    const token = registry?.session?.token ?? null;
    const account = token
      ? fetchRegistryFriends(token)
          .then((f) => f.friends.map((x) => x.handle))
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]);
    // The hub's friend list is a MIRROR of the registry's; mirror first, with
    // the registry session so the hub verifies and settles at once, then ask
    // who is a friend here. A friend you invited an hour ago is in this list
    // on the first open, not the next.
    const hubFriends = account
      .then((handles) => (handles.length ? mirrorFriendsToHub(session, handles, token ?? undefined) : undefined))
      .then(() => fetchFriends(session))
      .then((f) => f.friends);
    const everyone = fetchMembers(session).catch(() => null);
    void Promise.all([hubFriends, who, account, everyone])
      .then(([hub, seated, handles, all]) => {
        if (!live) return;
        setFriends(hub);
        setCurrent(seated);
        setRoster(all);
        // "Here" is anyone on this server, not only the friends the registry
        // could match: a handle that IS a member under another username was
        // being filed as "not on this server", and the link that pill offers
        // makes a copy on their side, never a seat at this list.
        const here = new Set([...hub, ...(all ?? [])].map((f) => f.username.toLowerCase()));
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
    roster?.find((f) => f.userId === userId)?.username ??
    '';

  const setSeat = async (userId: number, seat: Seat | null) => {
    if (!share || !unshare || busy !== null) return;
    setBusy(userId);
    setError(null);
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

  // Everyone on the server who is not yet seated, friends first; on an
  // older hub with no roster, the friends alone, as before.
  const candidates = useMemo(() => {
    const me = (session?.username ?? '').toLowerCase();
    const isFriend = new Set((friends ?? []).map((f) => f.userId));
    const pool: Member[] = roster
      ? roster.filter((m) => m.username.toLowerCase() !== me)
      : (friends ?? []).map((f) => ({ userId: f.userId, username: f.username }));
    return pool
      .filter((f) => !seated.some((m) => m.userId === f.userId))
      .sort(
        (a, b) =>
          Number(isFriend.has(b.userId)) - Number(isFriend.has(a.userId)) ||
          a.username.localeCompare(b.username),
      );
  }, [friends, roster, seated, session?.username]);
  const loading = friends === null && !error;

  // ---- the link face ------------------------------------------------------

  /*
   * The link is minted once per list and remembered on this device: a link
   * is a snapshot of the list at mint time, like a screenshot of it is, and
   * opening the sheet twice must not mint twice. The card's pictures are
   * thumbnails drawn from the hub's art into data URLs - the only form the
   * shot can carry - and they ride the link too, for its landing page.
   */
  const linkKey = `attackfm-playlist-link:${session?.url ?? 'local'}#${playlist.id}`;
  const [link, setLink] = useState<string | null>(() => {
    try {
      return localStorage.getItem(linkKey);
    } catch {
      return null;
    }
  });
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [covers, setCovers] = useState<string[] | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const token = registry?.session?.token ?? null;
  const by = registry?.session?.account.handle ?? '';

  const rows = useMemo(() => {
    const byPath = new Map(tracks.map((t) => [t.path, t] as const));
    return playlist.paths.map((p) => byPath.get(p)).filter((t): t is Track => t !== undefined);
  }, [tracks, playlist.paths]);

  // The pictures: the list's own cover first, else up to four song covers.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const sources = playlist.coverUrl
      ? [playlist.coverUrl]
      : [...new Set(rows.map((t) => t.artwork).filter((a): a is string => !!a))].slice(0, 4).map((a) => artSized(a, 160) ?? a);
    void Promise.all(sources.map(thumbnail)).then((made) => {
      if (live) setCovers(made.filter((c): c is string => c !== null));
    });
    return () => {
      live = false;
    };
  }, [open, playlist.coverUrl, rows]);

  // Mint when the link face shows and there is no link yet - once.
  useEffect(() => {
    if (!open || face !== 'link' || link || linking || !token || covers === null || rows.length === 0) return;
    let live = true;
    setLinking(true);
    setLinkError(null);
    publishPlaylistShare(token, {
      name: playlist.name,
      description: playlist.description,
      tracks: rows.map((t) => ({
        artist: t.artist,
        title: t.title,
        album: t.album,
        durationMs: t.duration ? Math.round(t.duration * 1000) : null,
      })),
      covers,
    })
      .then((made) => {
        if (!live) return;
        setLink(made.url);
        try {
          localStorage.setItem(linkKey, made.url);
        } catch {
          // Minted again next time; the registry does not mind.
        }
      })
      .catch((err: unknown) => {
        if (live) setLinkError(err instanceof Error ? err.message : 'Could not make a link just now.');
      })
      .finally(() => {
        if (live) setLinking(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mint once per open; the inputs are read at that moment
  }, [open, face, link, token, covers, rows.length]);

  // The QR is the link itself.
  useEffect(() => {
    if (!link) {
      setQr(null);
      return;
    }
    let live = true;
    void QRCode.toDataURL(link, { margin: 0, width: 600, color: { dark: '#101014ff', light: '#ffffffff' } })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [link]);

  // The picture, drawn ahead of the tap - the share sheet may only be asked
  // for inside a tap, and rasterising takes longer than a tap lasts.
  useEffect(() => {
    setPng(null);
    if (!open || face !== 'link' || !link || !qr || covers === null) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const node = cardRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      void shoot(node, Math.round(box.width), Math.round(box.height), 4).then((url) => {
        if (live && url) setPng(url);
      });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, face, link, qr, covers]);

  const saveImage = async () => {
    const node = cardRef.current;
    if (!node || saving) return;
    setSaving(true);
    try {
      const box = node.getBoundingClientRect();
      const dataUrl = png ?? (await shoot(node, Math.round(box.width), Math.round(box.height), 4));
      if (!dataUrl) {
        toast({ message: 'Could not draw the card. Try again in a moment.' });
        return;
      }
      await saveCardImage({
        dataUrl,
        filename: `attackfm-${slug(playlist.name)}.png`,
        title: `${playlist.name} - a playlist on AttackFM`,
        say: (message) => toast({ message }),
      });
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ message: 'Could not copy - long-press the link on the card to select it.' });
    }
  };

  return (
    <GlassSheet open={open} onClose={onClose} label="Share playlist" className="shareSheet">
      <h2 className="shareSheet__title">Share “{playlist.name}”</h2>
      <SegmentedControl
        className="shareSheet__faces"
        aria-label="How to share"
        fullWidth
        size="sm"
        value={face}
        onValueChange={(v) => setFace(v === 'friends' ? 'friends' : 'link')}
        options={[
          { value: 'link', label: 'Link' },
          { value: 'friends', label: isOwner ? 'Friends' : 'Who has it' },
        ]}
      />

      {face === 'link' && (
        <div className="shareSheet__linkFace">
          <PlaylistCard
            cardRef={cardRef}
            playlist={playlist}
            covers={covers ?? []}
            by={by}
            link={link}
            qr={qr}
            count={rows.length}
          />
          {!token ? (
            <Text tone="muted" size="sm" className="shareSheet__note">
              Links come from your AttackFM account, and this device is not signed into one yet.
              Sign in under Profile, then come back here.
            </Text>
          ) : rows.length === 0 ? (
            <Text tone="muted" size="sm" className="shareSheet__note">
              An empty playlist has nothing to put on a link yet.
            </Text>
          ) : linkError ? (
            <Text tone="danger" size="sm" className="shareSheet__note">
              {linkError}
            </Text>
          ) : null}
          <div className="shareSheet__actions">
            <Button variant="ghost" onClick={() => void copyLink()} disabled={!link}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button variant="solid" onClick={() => void saveImage()} disabled={saving || !link}>
              <Download size={16} />
              {saving ? 'Saving…' : 'Save image'}
            </Button>
          </div>
          <Text tone="muted" size="xs" className="shareSheet__hint">
            Anyone can open the link, on any server or none. In AttackFM it files the playlist onto
            their own server, which fetches the songs they do not have.
          </Text>
        </div>
      )}

      {face === 'friends' && (
        <>
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
                          <Button size="sm" variant={m.role === 'viewer' ? 'solid' : 'ghost'} aria-pressed={m.role === 'viewer'} disabled={busy !== null} onClick={() => void setSeat(m.userId, 'viewer')}>
                            View
                          </Button>
                          <Button size="sm" variant={m.role === 'editor' ? 'solid' : 'ghost'} aria-pressed={m.role === 'editor'} disabled={busy !== null} onClick={() => void setSeat(m.userId, 'editor')}>
                            Edit
                          </Button>
                          <IconButton size="sm" variant="ghost" aria-label={`Remove ${m.username}`} disabled={busy !== null} onClick={() => void setSeat(m.userId, null)}>
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
              <h3 className="shareSheet__h">{roster ? 'On this server' : 'Friends on this server'}</h3>
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
                A playlist lives on one server, so only its members can be seated. Send them the link
                instead - it files the list onto their own server.
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
        </>
      )}
    </GlassSheet>
  );
}
