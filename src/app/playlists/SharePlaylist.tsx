import { Button, IconButton, SegmentedControl, Text, useToast } from '@glacier/react';
import { Check, Copy, Crown, Download, ListMusic, LogOut, UserPlus, X } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { PlaylistMember } from '../api/playlists.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { publishPlaylistShare } from '../servers/registry.ts';
import { openFriendPicker } from '../nav/friendPickerDoor.ts';
import { useLibrary } from '../library/library.tsx';
import { artSized } from '../server.ts';
import type { Track } from '../core/tauri.ts';
import { GlassSheet } from '../ux/GlassSheet.tsx';
import { FriendAvatar } from '../profile/FriendAvatar.tsx';
import { shoot } from '../widget/shot.ts';
import { Trans, useSongCount, useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';
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
 * MEMBERS: who is in and the seat they hold - the owner, then everyone
 * seated, each with a pill; the owner can change a seat or show someone
 * out on the row. One button, "Add people…", opens the friend picker
 * (profile/FriendPicker.tsx, hoisted): anyone on this server may be
 * seated - being on the box is the hub's rule for a seat now - with
 * friends elsewhere dimmed and pointed at the link, which files a COPY of
 * the list onto their own server. Each person picked is added in turn and
 * gets a line: added, or the hub's own reason why not. A member (not the
 * owner) sees who else is in, and the door out.
 */

type Seat = 'viewer' | 'editor';
export type ShareFace = 'link' | 'members';

/** How one "Add people" went for one person, said under the list. */
interface Outcome {
  handle: string;
  ok: boolean;
  /** "added as an editor", or the hub's words. */
  words: string;
}

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
  const t = useT();
  const songCount = useSongCount();
  return (
    <div className="shareCard" ref={cardRef}>
      <div className="shareCard__head">
        <img className="shareCard__logo" src={logo} alt={t('common.appName')} />
        <span className="shareCard__kicker">{t('playlists.playlist')}</span>
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
        {/* The count keeps its own plural form and is dropped INTO the line,
            so the sharer's handle and the songs can swap places. */}
        {by ? t('playlists.cardSubSharedBy', { songs: songCount(count), by }) : songCount(count)}
      </p>
      <div className="shareCard__qrRow">
        {qr ? <img className="shareCard__qr" src={qr} alt={t('playlists.qrAlt')} /> : <span className="shareCard__qr" aria-hidden />}
        <div className="shareCard__linkWrap">
          <span className="shareCard__linkLabel">{t('playlists.scanOrOpen')}</span>
          <span className="shareCard__link">{link ? link.replace(/^https?:\/\//, '') : t('playlists.makingLink')}</span>
        </div>
      </div>
      <p className="shareCard__foot">{t('playlists.cardFoot')}</p>
    </div>
  );
}

export function SharePlaylistDrawer({
  playlist,
  open,
  onClose,
  initialFace = 'link',
}: {
  playlist: Playlist;
  open: boolean;
  onClose: () => void;
  /** Which face to open on. The New-playlist sheet lands on Members. */
  initialFace?: ShareFace;
}) {
  const t = useT();
  const { session } = useServerSession();
  const registry = useRegistryOptional();
  const { toast } = useToast();
  const { members, share, unshare, leave } = usePlaylists();
  const { tracks } = useLibrary();
  const isOwner = !playlist.role || playlist.role === 'owner';
  const [face, setFace] = useState<ShareFace>(initialFace);
  // The face asked for wins each time the sheet opens, not only the first.
  useEffect(() => {
    if (open) setFace(initialFace);
  }, [open, initialFace]);

  // ---- the members face --------------------------------------------------

  const [current, setCurrent] = useState<PlaylistMember[] | null>(null);
  const [busy, setBusy] = useState<number | 'leave' | 'adding' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // How the last "Add people" went, a line a person - cleared on reopen.
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);

  // Fetched fresh on every open: a member removed from another device should
  // not still be seated here.
  useEffect(() => {
    if (!open || !session) return;
    let live = true;
    setError(null);
    setOutcomes([]);
    const who = members ? members(playlist.id) : Promise.resolve([] as PlaylistMember[]);
    void who
      .then((seated) => {
        if (live) setCurrent(seated);
      })
      .catch(() => {
        if (live) setError(t('playlists.membersUnreachable'));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` only labels a failure inside the catch; listing it would refetch the seat list on a language change, which is a round trip nobody asked for.
  }, [open, session, members, playlist.id]);

  const seated = current ?? [];
  const nameOf = (userId: number) => seated.find((m) => m.userId === userId)?.username ?? '';
  const me = session?.username ?? '';
  const ownerName = isOwner ? me : (playlist.ownerName ?? t('playlists.theOwner'));

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
      setError(err instanceof Error ? err.message : t('playlists.seatChangeFailed'));
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
      setError(err instanceof Error ? err.message : t('playlists.leaveFailed'));
    } finally {
      setBusy(null);
    }
  };

  /**
   * "Add people…": the picker, then each person in turn - by username, the
   * name the hub seats by - and a line each for how it went. The hub's own
   * words ride a refusal ("nobody by that name on this server"), never a
   * paraphrase. The list is re-read behind it rather than trusted.
   */
  const addPeople = async () => {
    if (!share || !members || busy !== null) return;
    const pick = await openFriendPicker({
      title: t('playlists.addPeople'),
      hint: t('playlists.addPeopleHint', { name: playlist.name }),
      mode: 'playlist',
      roles: true,
      exclude: [me, ...seated.map((m) => m.username)],
      // Two strings, not one with a zero form: n === 0 is the DISABLED button
      // before anyone is ticked, which is a different sentence and not a count.
      action: (n) => (n ? t('playlists.addNToPlaylist', { count: n }) : t('playlists.addToThePlaylist')),
    });
    if (!pick || pick.people.length === 0) return;
    setBusy('adding');
    setError(null);
    const out: Outcome[] = [];
    for (const p of pick.people) {
      try {
        await share(playlist.id, { username: p.handle }, pick.role);
        out.push({
          handle: p.handle,
          ok: true,
          words: pick.role === 'editor' ? t('playlists.addedAsEditor') : t('playlists.addedAsViewer'),
        });
      } catch (err) {
        out.push({
          handle: p.handle,
          ok: false,
          words: err instanceof Error && err.message ? err.message : t('playlists.couldNotBeAdded'),
        });
      }
    }
    setOutcomes(out);
    try {
      setCurrent(await members(playlist.id));
    } catch {
      // The lines above already say what happened; the next open re-reads.
    } finally {
      setBusy(null);
    }
  };
  const loading = current === null && !error;

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
        if (live) setLinkError(err instanceof Error ? err.message : t('playlists.linkFailed'));
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
        toast({ message: t('playlists.cardDrawFailed') });
        return;
      }
      await saveCardImage({
        dataUrl,
        filename: `attackfm-${slug(playlist.name)}.png`,
        title: t('playlists.shareSheetTitle', { name: playlist.name }),
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
      toast({ message: t('playlists.copyFailed') });
    }
  };

  return (
    <GlassSheet open={open} onClose={onClose} label={t('playlists.sharePlaylist')} className="shareSheet">
      <h2 className="shareSheet__title">{t('playlists.shareNamed', { name: playlist.name })}</h2>
      <SegmentedControl
        className="shareSheet__faces"
        aria-label={t('playlists.howToShare')}
        fullWidth
        size="sm"
        value={face}
        onValueChange={(v) => setFace(v === 'members' ? 'members' : 'link')}
        options={[
          { value: 'link', label: t('playlists.faceLink') },
          { value: 'members', label: isOwner ? t('playlists.faceMembers') : t('playlists.faceWhoHasIt') },
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
              {t('playlists.linkNeedsAccount')}
            </Text>
          ) : rows.length === 0 ? (
            <Text tone="muted" size="sm" className="shareSheet__note">
              {t('playlists.linkNeedsSongs')}
            </Text>
          ) : linkError ? (
            <Text tone="danger" size="sm" className="shareSheet__note">
              {linkError}
            </Text>
          ) : null}
          <div className="shareSheet__actions">
            <Button variant="ghost" onClick={() => void copyLink()} disabled={!link}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? t('common.copied') : t('common.copyLink')}
            </Button>
            <Button variant="solid" onClick={() => void saveImage()} disabled={saving || !link}>
              <Download size={16} />
              {saving ? t('common.saving') : t('common.saveImage')}
            </Button>
          </div>
          <Text tone="muted" size="xs" className="shareSheet__hint">
            {t('playlists.linkHint')}
          </Text>
        </div>
      )}

      {face === 'members' && (
        <>
          <p className="shareSheet__desc">
            {/* The member's line is one sentence per seat rather than a name
                and a clause glued together: the owner's name has to be free to
                move, and "can edit" is not a phrase in every language. */}
            {isOwner
              ? t('playlists.membersOwnerBlurb')
              : playlist.role === 'editor'
                ? t('playlists.sharedByCanEdit', { name: ownerName })
                : t('playlists.sharedByCanPlay', { name: ownerName })}
          </p>
          {error && (
            <Text tone="danger" size="sm" className="shareSheet__note" role="status">
              {error}
            </Text>
          )}
          {loading && (
            <Text tone="muted" size="sm" className="shareSheet__note">
              {t('playlists.findingMembers')}
            </Text>
          )}

          {!loading && (
            <section className="shareSheet__room">
              <h3 className="shareSheet__h">
                {t('playlists.people')}
                <span className="shareSheet__count">{formatNumber(seated.length + 1)}</span>
              </h3>
              <ul className="shareSheet__list">
                {/* The owner leads: never among the members the hub lists,
                    always the first person on the list. */}
                <li className="shareSheet__row">
                  <FriendAvatar handle={ownerName} size="md" />
                  <span className="shareSheet__name">
                    {/* "Name · you" is one line, not a name with a suffix
                        stapled on: the marker goes on the other side of the
                        name in some languages. */}
                    {isOwner ? (
                      <Trans
                        i18nKey="playlists.nameIsYou"
                        values={{ name: ownerName }}
                        components={{ you: <span className="shareSheet__you" /> }}
                      />
                    ) : (
                      ownerName
                    )}
                  </span>
                  <span className="shareSheet__pill shareSheet__pill--owner">
                    <Crown size={11} aria-hidden />
                    {t('playlists.roleOwner')}
                  </span>
                </li>
                {seated.map((m) => (
                  <li key={m.userId} className="shareSheet__row">
                    <FriendAvatar handle={m.username} size="md" />
                    <span className="shareSheet__name">
                      {m.username.toLowerCase() === me.toLowerCase() ? (
                        <Trans
                          i18nKey="playlists.nameIsYou"
                          values={{ name: m.username }}
                          components={{ you: <span className="shareSheet__you" /> }}
                        />
                      ) : (
                        m.username
                      )}
                    </span>
                    {isOwner && share ? (
                      <span className="shareSheet__seats">
                        <SegmentedControl
                          size="sm"
                          aria-label={t('playlists.seatFor', { name: m.username })}
                          value={m.role}
                          disabled={busy !== null}
                          onValueChange={(v) => void setSeat(m.userId, v === 'viewer' ? 'viewer' : 'editor')}
                          options={[
                            { value: 'editor', label: t('playlists.roleEditor') },
                            { value: 'viewer', label: t('playlists.roleViewer') },
                          ]}
                        />
                        <IconButton
                          size="sm"
                          variant="ghost"
                          className="shareSheet__remove"
                          aria-label={t('playlists.removePerson', { name: m.username })}
                          disabled={busy !== null}
                          onClick={() => void setSeat(m.userId, null)}
                        >
                          <X size={15} />
                        </IconButton>
                      </span>
                    ) : (
                      <span className="shareSheet__pill" data-role={m.role}>
                        {m.role === 'editor' ? t('playlists.roleEditor') : t('playlists.roleViewer')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {seated.length === 0 && (
                <Text tone="muted" size="sm" className="shareSheet__empty">
                  {isOwner ? t('playlists.nobodyElseYet') : t('playlists.onlyYouAndOwner')}
                </Text>
              )}
            </section>
          )}

          {!loading && isOwner && share && (
            <button
              type="button"
              className="jamCard fpDoor shareSheet__add"
              onClick={() => void addPeople()}
              disabled={busy !== null}
              aria-busy={busy === 'adding' || undefined}
            >
              <span className="fpDoor__glyph" aria-hidden>
                <UserPlus size={16} />
              </span>
              <span className="fpDoor__text">
                <span className="fpDoor__title">{busy === 'adding' ? t('playlists.adding') : t('playlists.addPeopleAction')}</span>
                <span className="fpDoor__sub">{t('playlists.addPeopleSub')}</span>
              </span>
            </button>
          )}

          {outcomes.length > 0 && (
            <ul className="shareSheet__outcomes" aria-label={t('playlists.outcomesLabel')} role="status">
              {outcomes.map((o) => (
                <li key={o.handle} className="shareSheet__outcome" data-ok={o.ok || undefined}>
                  <FriendAvatar handle={o.handle} size="sm" />
                  <span className="shareSheet__outcomeName">{o.handle}</span>
                  <span className="shareSheet__outcomeWords">{o.words}</span>
                  {o.ok && <Check size={14} aria-hidden className="shareSheet__outcomeMark" />}
                </li>
              ))}
            </ul>
          )}

          {!loading && isOwner && share && (
            <div className="shareSheet__elsewhere">
              <Text tone="muted" size="xs" className="shareSheet__hint">
                {t('playlists.elsewhereHint')}
              </Text>
              <Button variant="ghost" size="sm" className="shareSheet__faceLink" onClick={() => setFace('link')}>
                <Copy size={15} />
                {t('playlists.getTheLink')}
              </Button>
            </div>
          )}

          {!isOwner && leave && (
            <div className="shareSheet__foot">
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void walkOut()}>
                <LogOut size={15} />
                <span>{busy === 'leave' ? t('playlists.leaving') : t('playlists.leaveThis')}</span>
              </Button>
            </div>
          )}
        </>
      )}
    </GlassSheet>
  );
}
