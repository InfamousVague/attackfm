//! Friends, the central-identity way.
//!
//! A friend here is a person, not a row on one server: the friendship lives in
//! the registry, so it holds whichever server either of you is on. This is also
//! where an account is CREATED - the first thing the app asks of a listener who
//! has none, and (per the onboarding) the place they are sent to set one up so
//! a server owner can invite them.
//!
//! Two exported faces, composed by the Profile page:
//!   - `AccountSetup`: create an account (or sign in to an existing one).
//!   - `FriendsSection`: the friends graph - one list holding friends and
//!     still-waiting invites alike, with the add-by-handle verb in the section
//!     head. Identity chrome (whose account this is, signing out) and the
//!     server-shaped verbs (inviting someone in, joining elsewhere) live on
//!     the Profile page around it - a section shows the people, the page owns
//!     the person.

import { ArtistLink } from '../ux/ArtistLink.tsx';
import { AccountForm } from '../servers/AccountForm.tsx';
import { fetchShares, setShareGrant, settleShare, type Share } from '../servers/registry.ts';
import { addPendingLike } from '../api/likes.ts';
import {
  Button,
  IconButton,
  Input,
  Modal,
  Skeleton,
  Spinner,
  StatTile,
  Text,
} from '@glacier/react';
import { ArrowUpRight, ChartNoAxesColumn, Check, Clock, Flame, Headphones, Music, UserPlus, Users, X } from '@glacier/icons';
import { useJamOptional } from '../player/jam.tsx';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { artistImageKnown, cachedArtistImage, resolveArtistImage } from '../albumArtist/artistImage.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { syncRegistryFriendsToHub } from './friendMirror.ts';
import {
  acceptFriendRequest,
  announce,
  declineFriendRequest,
  fetchFriends,
  removeFriend,
  sendFriendRequest,
  type FriendsFeed,
  type RegistryFriend,
} from '../servers/registry.ts';
import { openFriendPicker } from '../nav/friendPickerDoor.ts';
import { Trans, useSongCount, useT } from '../i18n/LocaleShell.tsx';
import { formatNumber, formatTotal } from '../ux/format.ts';
import { isOnline, listenedTime, seenAgo } from './friendPresence.ts';

/** The app's translator, as a value the plain helpers below can be handed. */
type T = ReturnType<typeof useT>;

/**
 * A person, as a mark: a deterministic two-tone gradient from their handle
 * with their initial on it. The hue is the handle's and nobody else's, so the
 * same friend wears the same colour on every device and every visit - the
 * list reads as PEOPLE at a glance, not a column of grey monograms.
 */
export function FriendAvatar({
  handle,
  size = 'md',
  className,
  src,
}: {
  handle: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** The face they chose. The generated mark below is what a person without
   *  one wears - and what everyone wore before there was a way to choose. */
  src?: string | null;
}) {
  let hue = 7;
  for (const ch of handle) hue = (hue * 31 + ch.codePointAt(0)!) % 360;
  // A picture that will not load falls back to the mark rather than leaving a
  // broken-image glyph in the row. It happens for real: the URL is cached
  // forever by design, and the picture behind it can be taken down.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const photo = src && !broken;
  return (
    <span
      className={`friendAvatar friendAvatar--${size}${className ? ` ${className}` : ''}`}
      style={{
        background: `linear-gradient(135deg, oklch(0.62 0.15 ${hue}), oklch(0.42 0.17 ${(hue + 55) % 360}))`,
      }}
      aria-hidden
    >
      {photo ? (
        <img className="friendAvatar__photo" src={src} alt="" onError={() => setBroken(true)} />
      ) : (
        (handle[0] ?? '?').toUpperCase()
      )}
    </span>
  );
}

/** The listening glance a friend chose to share: "6 hr 20 min this week · Jon Hopkins". */
function weekGlance(t: T, f: RegistryFriend): string | null {
  if (typeof f.weekMinutes !== 'number' || f.weekMinutes <= 0) return null;
  // Time only - the artist half renders separately, as a door rather than a
  // suffix baked into the string. Hours AND minutes: rounding to the hour
  // read 89 and 91 minutes as the same "1h".
  return t('profile.timeThisWeek', { time: listenedTime(f.weekMinutes) });
}

/** "for 12 min" - how long the song they are on has been on. Intl counts and
 *  names the unit; the sentence around it is one entry, so the duration can
 *  sit wherever the language puts it. */
function playingFor(t: T, sinceSecs: number): string {
  const elapsed = Math.max(0, Date.now() / 1000 - sinceSecs);
  return elapsed < 60
    ? t('profile.playingJustStarted')
    : t('profile.playingFor', { duration: formatTotal(elapsed) });
}

/** What they are hearing right now, as a line - or null when nothing is on. */
export function NowPlayingLine({ f, long = false }: { f: RegistryFriend; long?: boolean }) {
  const t = useT();
  const np = f.nowPlaying;
  if (!np) return null;
  return (
    <span className="friendRow__live" data-paused={!np.playing || undefined}>
      <Music size={12} aria-hidden />
      <span className="friendRow__liveDot" aria-hidden />
      <span className="friendRow__liveText">
        {/* Verb and title are one sentence - German puts the title before the
            verb - so the emphasis rides inside the entry rather than being a
            <strong> the translator cannot move. Two whole entries rather than
            one with the verb swapped: "paused on" is not "listening to" with
            a different word in it, and some languages change the case of what
            follows. */}
        {np.playing ? (
          <Trans i18nKey="profile.listeningTo" values={{ title: np.title }} components={{ b: <strong /> }} />
        ) : (
          <Trans i18nKey="profile.pausedOn" values={{ title: np.title }} components={{ b: <strong /> }} />
        )}
        {np.artist ? ` · ${np.artist}` : ''}
        {long && np.since ? ` · ${playingFor(t, np.since)}` : ''}
      </span>
    </span>
  );
}

/**
 * Friends in the order that matters right now: whoever is listening at this
 * moment first, then whoever is online, then by when they were last seen.
 * A list sorted by handle put the one friend who is here now under the
 * fold behind twelve who were last seen in July.
 */
function byLiveness(a: RegistryFriend, b: RegistryFriend): number {
  const rank = (f: RegistryFriend) => (f.nowPlaying?.playing ? 0 : f.nowPlaying ? 1 : isOnline(f) ? 2 : 3);
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  return (b.seenAt ?? 0) - (a.seenAt ?? 0) || a.handle.localeCompare(b.handle);
}

// --- account setup ----------------------------------------------------------

export function AccountSetup({ onDone }: { onDone: (s: import('../servers/registry.ts').RegistrySession) => void }) {
  const t = useT();
  return (
    <div className="registrySetup">
      <div className="emptyState">
        <EmptyArt name="friends" />
        <p className="emptyState__text">{t('profile.accountIsTheKey')}</p>
      </div>
      {/* The one account form (servers/AccountForm.tsx); this door only frames
          it. Sign-in first here too: a returning listener is the common case. */}
      <AccountForm
        defaultMode="signin"
        onDone={onDone}
        className="registrySetup__form"
        submitClassName="registrySetup__submit"
      />
    </div>
  );
}

// --- the friends graph ------------------------------------------------------

/** How the friend-visit verb reports back to the page (see ProfilePage): the
 *  section stays about people, the page decides what a visit means. */
export type VisitServer = (friend: RegistryFriend) => void;

export function FriendsSection({
  token,
  onVisit,
  onOpen,
}: {
  token: string;
  me: string;
  /** Offered on a friend's card when they answer from a server that is not
   *  the one this device is listening from. */
  onVisit?: VisitServer;
  /** A tap anywhere on the card that is not a control: their profile. */
  onOpen?: (friend: RegistryFriend) => void;
}) {
  const t = useT();
  const songCount = useSongCount();
  const { session: server } = useServerSession();
  // Listen-along lives here so the ask sits on the friend who is playing. Null
  // outside the player's provider, which is where a signed-out list renders.
  const jam = useJamOptional();
  const [feed, setFeed] = useState<FriendsFeed | null>(null);
  // Why the feed is what it is: a registry that cannot be reached says so on
  // the page instead of leaving four skeleton rows "loading" forever.
  const [feedError, setFeedError] = useState<string | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Songs friends have sent, by name, waiting for a yes.
  const [shares, setShares] = useState<Share[]>([]);

  const refresh = useCallback(async () => {
    try {
      setFeed(await fetchFriends(token));
      setFeedError(null);
    } catch (e) {
      // Unreachable right now; whatever is on screen stays, and the page
      // says the numbers may be old.
      setFeedError(e instanceof Error && e.message ? e.message : t('profile.registryNotAnswering'));
    }
    try {
      setShares(await fetchShares(token));
    } catch {
      // A registry from before songs could be sent has no inbox to show.
    }
  }, [token, t]);

  /**
   * Take a song a friend sent: ask YOUR OWN hub for it by name. The hub
   * favourites it at once if it already has a match, and otherwise remembers
   * the promise for its collector - the same door Discover's heart uses, and
   * the only way a song ever enters a library. The registry only ever knew
   * the title.
   */
  const takeShare = async (s: Share) => {
    if (!server) {
      setNote({ tone: 'bad', text: t('profile.connectServerFirst') });
      return;
    }
    setBusy(true);
    try {
      const { landed } = await addPendingLike(server, s.artist, s.title);
      await settleShare(token, s.id, true);
      setShares((prev) => prev.filter((x) => x.id !== s.id));
      setNote({
        tone: 'ok',
        text: landed
          ? t('profile.shareLanded', { title: s.title })
          : t('profile.shareOnItsWay', { title: s.title }),
      });
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : t('profile.didNotGoThrough') });
    } finally {
      setBusy(false);
    }
  };

  const putAway = async (s: Share) => {
    setBusy(true);
    try {
      await settleShare(token, s.id, false);
      setShares((prev) => prev.filter((x) => x.id !== s.id));
    } catch {
      // Stays on the list; the next tap tries again.
    } finally {
      setBusy(false);
    }
  };

  /** The once-per-friend answer: do you take songs from this person at all. */
  const decideSender = async (handle: string, allow: boolean) => {
    setBusy(true);
    try {
      await setShareGrant(token, handle, allow);
      setShares((prev) =>
        allow ? prev.map((x) => (x.from === handle ? { ...x, allowed: true } : x)) : prev.filter((x) => x.from !== handle),
      );
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : t('profile.didNotGoThrough') });
    } finally {
      setBusy(false);
    }
  };

  // The first song from anyone is a question about THEM, asked once.
  const senderAsks = [...new Set(shares.filter((s) => s.allowed === null).map((s) => s.from))];
  const songsSent = shares.filter((s) => s.allowed === true);

  useEffect(() => {
    void refresh();
    // Fifteen seconds: a friend pressing play shows up here inside the time
    // it takes to read the page, without the radio held warm.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
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

  // A picture for each friend's top artist, so the grid is made of music
  // rather than initials. Driven off what they already announce, so it costs
  // nothing extra of them and appears only for friends who share.
  const [artTick, setArtTick] = useState(0);
  const topArtists = useMemo(
    () =>
      [...new Set((feed?.friends ?? []).map((f) => (f.weekTopArtist ?? '').trim()).filter(Boolean))],
    [feed],
  );
  useEffect(() => {
    if (!server) return;
    const unknown = topArtists.filter((name) => !artistImageKnown(name));
    if (unknown.length === 0) return;
    let live = true;
    const control = new AbortController();
    void Promise.all(
      unknown.map((name) => resolveArtistImage(server, name, control.signal)),
    ).then(() => {
      // One redraw for the batch: the pictures live in a module cache, so the
      // grid has to be asked to look again rather than being handed them.
      if (live) setArtTick((n) => n + 1);
    });
    return () => {
      live = false;
      control.abort();
    };
  }, [server, topArtists]);

  const act = async (run: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await run();
      if (ok) setNote({ tone: 'ok', text: ok });
      // The list just changed: hand it to the hub now, not on the timer, so a
      // groove invite or a share a moment from now finds the friendship.
      if (server && token) await syncRegistryFriendsToHub(server, token).catch(() => false);
      await refresh();
    } catch (error) {
      setNote({ tone: 'bad', text: error instanceof Error ? error.message : t('profile.didNotWork') });
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
      // Close on success: the new "waiting" card appearing in the grid IS the
      // confirmation, and the registry's own words ride the page note.
      setAddOpen(false);
      setNote({ tone: 'ok', text: message });
    });
  };

  const friends = [...(feed?.friends ?? [])].sort(byLiveness);
  const incoming = feed?.incoming ?? [];
  // The bulk invite: the same picker the deck uses, with the room's people
  // left out; a room opens if there is none. Offered while you own the
  // room or have none - a follower does not hand out somebody else's keys.
  const canGather = !!jam && !!server && (!jam.current || jam.hosting);
  const gather = async () => {
    if (!jam) return;
    const pick = await openFriendPicker({
      title: t('profile.inviteToGroove'),
      hint: jam.current ? t('profile.grooveIntoYours') : t('profile.grooveOpensRoom'),
      mode: 'groove',
      exclude: jam.current?.members ?? [],
      // Zero is the button with no number on it at all, which is a different
      // label rather than a plural form of this one.
      action: (n) => (n ? t('profile.inviteCount', { count: n }) : t('profile.invite')),
    });
    if (!pick || pick.people.length === 0) return;
    await jam.jamWithAll(pick.people.map((p) => p.handle));
  };
  const listeningNow = friends.filter((f) => f.nowPlaying?.playing).length;
  const onlineNow = friends.filter(isOnline).length;
  const outgoing = feed?.outgoing ?? [];
  // Feedback lands where the eye is: inside the add modal while it is open,
  // on the section otherwise. Opening it clears the previous story.
  const openAdd = () => {
    setNote(null);
    setAddOpen(true);
  };

  const addForm = (
    <form className="friendsAdd" onSubmit={add}>
      <Input
        className="friendsAdd__field"
        value={handle}
        onChange={(e) => setHandle(e.currentTarget.value)}
        placeholder={t('profile.handlePlaceholder')}
        aria-label={t('profile.addFriendByHandle')}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <Button type="submit" variant="solid" size="sm" disabled={busy || handle.trim() === ''}>
        {busy ? <Spinner size="sm" aria-label="" /> : <UserPlus size={15} />}
        <span>{t('profile.add')}</span>
      </Button>
    </form>
  );

  return (
    <div className="registryFriends">
      {note && !addOpen && (
        <p className={`friendsNote friendsNote--${note.tone}`} role="status">
          {note.text}
        </p>
      )}
      {feedError && (
        <p className="friendsNote friendsNote--bad" role="status">
          {/* Two sentences, two entries: the second is only true when there
              is something stale still on screen. */}
          {t('profile.registryUnreachable', { reason: feedError })}
          {feed ? ` ${t('profile.showingLastRead')}` : ''}
        </p>
      )}

      {incoming.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">{t('profile.wantsToBeFriends')}</h2>
          <div className="requestCards">
            {incoming.map((r) => (
              <div key={r.id} className="requestCard">
                <FriendAvatar handle={r.handle} size="md" />
                <span className="requestCard__handle">{r.handle}</span>
                <span className="requestCard__actions">
                  <Button variant="solid" size="sm" disabled={busy} onClick={() => void act(() => acceptFriendRequest(token, r.id))}>
                    <Check size={15} /> <span>{t('profile.accept')}</span>
                  </Button>
                  <IconButton variant="ghost" size="sm" disabled={busy} aria-label={t('profile.declineWho', { handle: r.handle })} onClick={() => void act(() => declineFriendRequest(token, r.id))}>
                    <X size={15} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {senderAsks.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">{t('profile.wantsToSendSongs')}</h2>
          <div className="requestCards">
            {senderAsks.map((handle) => (
              <div key={handle} className="requestCard">
                <FriendAvatar handle={handle} size="md" />
                <span className="requestCard__handle">{handle}</span>
                <span className="requestCard__actions">
                  <Button variant="solid" size="sm" disabled={busy} onClick={() => void decideSender(handle, true)}>
                    <Check size={15} /> <span>{t('profile.takeThem')}</span>
                  </Button>
                  <IconButton variant="ghost" size="sm" disabled={busy} aria-label={t('profile.dontTakeSongsFrom', { handle })} onClick={() => void decideSender(handle, false)}>
                    <X size={15} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {songsSent.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">{t('profile.sentToYou')}</h2>
          <div className="requestCards">
            {songsSent.map((s) => (
              <div key={s.id} className="requestCard">
                <FriendAvatar handle={s.from} size="md" />
                <span className="requestCard__handle">
                  {s.title}
                  <Text as="span" tone="muted" size="xs" className="requestCard__sub">
                    {/* Whole line, one entry. A note is a different sentence
                        rather than a fragment glued on the end: the quotes it
                        wears are not the same characters in every language. */}
                    {s.note
                      ? t('profile.shareFromNoted', { artist: s.artist, who: s.from, note: s.note })
                      : t('profile.shareFrom', { artist: s.artist, who: s.from })}
                  </Text>
                </span>
                <span className="requestCard__actions">
                  <Button variant="solid" size="sm" disabled={busy} onClick={() => void takeShare(s)}>
                    <Check size={15} /> <span>{t('profile.getIt')}</span>
                  </Button>
                  <IconButton variant="ghost" size="sm" disabled={busy} aria-label={t('profile.putAwayWhat', { title: s.title })} onClick={() => void putAway(s)}>
                    <X size={15} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="homeShelf">
        <div className="friendsBar">
          <h2 className="homeShelfTitle">
            {t('profile.friendsHeading')}
            {friends.length > 0 ? ` · ${formatNumber(friends.length)}` : ''}
            {/* The live count beside the total: what the page is FOR. */}
            {(listeningNow > 0 || onlineNow > 0) && (
              <span className="friendsBar__live">
                {listeningNow > 0
                  ? t('profile.listeningNowCount', { count: listeningNow })
                  : t('profile.onlineCount', { count: onlineNow })}
              </span>
            )}
          </h2>
          <span className="friendsBar__actions">
            {canGather && friends.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => void gather()} aria-label={t('profile.inviteFriendsToGroove')}>
                <Users size={15} /> <span>{t('profile.inviteToGrooveMore')}</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={openAdd}>
              <UserPlus size={15} /> <span>{t('profile.add')}</span>
            </Button>
          </span>
        </div>
        {feed === null && !feedError ? (
          /* Loading is NOT emptiness. Falling through to the empty state here
             told people they had no friends before the answer had arrived -
             and on a slow link that claim sat on screen for seconds. Four
             row-shaped seats say "counting" instead, in the list the real
             rows will use. */
          <div className="friendRows" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="friendRow friendRow--pending">
                <span className="friendRow__face">
                  <Skeleton variant="circle" width="2.75rem" height="2.75rem" />
                </span>
                <span className="friendRow__who">
                  <Skeleton variant="text" width="6rem" />
                  <Skeleton variant="text" width="9rem" />
                </span>
              </div>
            ))}
          </div>
        ) : feed === null ? (
          <p className="statsNote">{t('profile.nothingUntilRegistry')}</p>
        ) : friends.length === 0 && outgoing.length === 0 ? (
          <div className="emptyState">
            <EmptyArt name="friends" />
            <p className="emptyState__text">{t('profile.noFriendsYet')}</p>
            {/* The one place the add form lives in the open: on an empty page
                it IS the next step, not chrome above the content. */}
            <div className="friendsEmptyAdd">{addForm}</div>
          </div>
        ) : (
          <div className="friendRows">
            {friends.map((f) => {
              const seen = seenAgo(f.seenAt);
              const online = isOnline(f);
              const glance = weekGlance(t, f);
              // The two ways to reach a same-server friend from here. Listen
              // along follows a friend who is PLAYING (they host); invite-to-groove
              // gathers an ONLINE friend into a room you host. A playing friend
              // when you are free gets the more specific of the two; anyone else
              // online gets the invite (which starts a room if you have none),
              // and a follower - who does not own the room - gets neither.
              const sameHub = !!f.serverUrl && server?.url === f.serverUrl.replace(/\/+$/, '');
              const playing = !!f.nowPlaying?.playing;
              const showAlong = !!jam && sameHub && playing && !jam.current;
              const showInvite =
                !!jam && sameHub && (online || playing) && !showAlong && (!jam.current || jam.hosting);
              // Sharing OFF is its own honest line; a quiet week is another.
              const quiet =
                f.sharing === false
                  ? t('profile.keepsListeningPrivate')
                  : glance === null && f.songs > 0
                    ? t('profile.quietThisWeek')
                    : null;
              // `artTick` is read here so the memo-free list re-renders when a
              // batch of pictures lands; the value itself is meaningless.
              void artTick;
              const backdrop = cachedArtistImage(f.weekTopArtist ?? '');
              return (
                <div
                  key={f.id}
                  className="friendRow"
                  data-online={online || undefined}
                  data-door={onOpen ? '' : undefined}
                  /* The card's dead space is the door to their profile; the
                     controls on it (visit, remove, the artist link) are their
                     own buttons and must not also ride the tap up. */
                  onClick={
                    onOpen
                      ? (event) => {
                          const el = event.target as HTMLElement;
                          if (el.closest('button, a')) return;
                          onOpen(f);
                        }
                      : undefined
                  }
                >
                  {backdrop && (
                    <img
                      className="friendRow__backdrop"
                      src={backdrop}
                      alt=""
                      aria-hidden
                      loading="lazy"
                    />
                  )}
                  <FriendAvatar handle={f.handle} size="md" className="friendRow__face" src={f.avatarUrl} />
                  <span className="friendRow__who">
                    <span className="friendRow__handle">{f.handle}</span>
                    <span className="friendRow__meta">
                      {[
                        f.songs > 0 ? songCount(f.songs) : t('profile.noLibraryYet'),
                        online ? t('profile.online') : seen,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {/* Right now, when there is a right now: what they are
                      hearing at this moment. It outranks the week's glance
                      for the same reason it sorts first. */}
                  {f.nowPlaying && (
                    <span className="friendRow__glance friendRow__glance--live">
                      <NowPlayingLine f={f} />
                    </span>
                  )}
                  {/* What they've been playing, if they share it - the line
                      that makes the list about music rather than accounts. On
                      a wide row it takes the middle, which is the room the
                      grid used to waste; on a narrow one it drops under the
                      handle. */}
                  {!f.nowPlaying && glance && (
                    <span className="friendRow__glance">
                      {glance}
                      {/* The row already paints this artist's photo behind
                          it; the name going somewhere is what that design
                          was implying all along. */}
                      {f.weekTopArtist && (
                        <>
                          {' · '}
                          <ArtistLink artist={f.weekTopArtist} />
                        </>
                      )}
                    </span>
                  )}
                  {!f.nowPlaying && !glance && quiet && (
                    <span className="friendRow__glance friendRow__glance--quiet">{quiet}</span>
                  )}
                  {/* Visit leads and Stats trails, which is the opposite of
                      the reading order you would guess - but visiting is the
                      conditional one, and with it last, `Stats` landed at a
                      different x on every row depending on whether the friend
                      happened to be elsewhere. The verb that EVERY row has
                      goes last, so on a wide screen it makes a column. */}
                  <div className="friendRow__actions">
                    {/* Same server, and playing: their music is reachable and
                        in motion, so the natural verb is to fall in behind it -
                        they get the ask, and their yes hosts the room. */}
                    {showAlong && (
                      <Button
                        variant="solid"
                        size="sm"
                        aria-label={t('profile.listenAlongWith', { handle: f.handle })}
                        onClick={() => void jam?.invite(f.handle, 'along')}
                      >
                        <Headphones size={15} />
                        {t('profile.listenAlong')}
                      </Button>
                    )}
                    {/* Same server and online: gather them into a room YOU host
                        (started on the spot if you have none). Soft when you are
                        already hosting - it is one more person, not a new room. */}
                    {showInvite && (
                      <Button
                        variant={jam?.current ? 'soft' : 'solid'}
                        size="sm"
                        aria-label={t('profile.inviteWhoToGroove', { handle: f.handle })}
                        onClick={() => void jam?.jamWith(f.handle)}
                      >
                        <Users size={15} />
                        {t('profile.inviteToGroove')}
                      </Button>
                    )}
                    {/* Their library is somewhere this device is not listening
                        from - offer the walk over. The page decides what that
                        means (a one-tap switch, or the truth about invites). */}
                    {onVisit && f.serverUrl && server?.url !== f.serverUrl.replace(/\/+$/, '') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('profile.visitTheirServerWho', { handle: f.handle })}
                        onClick={() => onVisit(f)}
                      >
                        <ArrowUpRight size={15} />
                        {t('profile.friendVisitServer')}
                      </Button>
                    )}
                    {/* The profile: the stats modal's grown-up replacement.
                        A whole page - their stats, and on a shared server
                        their liked songs too. */}
                    {onOpen && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('profile.profileForWho', { handle: f.handle })}
                        onClick={() => onOpen(f)}
                      >
                        <ChartNoAxesColumn size={15} />
                        {t('profile.profile')}
                      </Button>
                    )}
                  </div>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="friendRow__remove"
                    disabled={busy}
                    aria-label={t('profile.removeWho', { handle: f.handle })}
                    onClick={() => void act(() => removeFriend(token, f.id))}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              );
            })}
            {/* Asks still in the air share the list as ghosts: an invited
                person is already a person, just not yet a yes - one list of
                people beats a separate strip of chips. */}
            {outgoing.map((r) => (
              <div key={`out-${r.id}`} className="friendRow friendRow--waiting">
                <FriendAvatar handle={r.handle} size="md" className="friendRow__face" />
                <span className="friendRow__who">
                  <span className="friendRow__handle">{r.handle}</span>
                  <span className="friendRow__meta">{t('profile.invitedWaiting')}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('profile.addAFriend')} size="sm">
        <div className="friendsModal">
          <Text size="sm" tone="muted">
            {t('profile.addByHandleHint')}
          </Text>
          {addForm}
          {note && addOpen && (
            <p className={`friendsNote friendsNote--${note.tone}`} role="status">
              {note.text}
            </p>
          )}
        </div>
      </Modal>

    </div>
  );
}

/**
 * One friend's numbers, from what the registry already holds.
 *
 * Two registers, honestly separated: the listening glance (minutes, streak,
 * top artist) exists only while they share it and is labelled with its own
 * absence when they do not; the library trio (songs, playlists, artists)
 * rides every announce and is always there. Nothing here asks their server
 * anything - a friend's box is not this device's to query.
 */
export function FriendStats({ friend }: { friend: RegistryFriend }) {
  const t = useT();
  const sharing = typeof friend.weekMinutes === 'number';
  return (
    <div className="friendStats">
      {friend.nowPlaying && (
        <p className="friendStats__artist friendStats__now">
          <NowPlayingLine f={friend} long />
        </p>
      )}
      {sharing ? (
        <div className="friendStats__week">
          <div className="friendStats__hero">
            <span className="friendStats__minutes">{listenedTime(friend.weekMinutes ?? 0)}</span>
            <span className="friendStats__label">{t('profile.listenedThisWeek')}</span>
          </div>
          {/* Names do not belong in number tiles - a tile ellipsizes exactly
              the part that matters. The artist gets a sentence of their own,
              and the streak keeps a bare number a tile can always fit. */}
          {friend.weekTopArtist && (
            <p className="friendStats__artist">
              <Clock size={14} aria-hidden />{' '}
              {/* The name is a door, not a plain hole in the sentence, so it
                  rides in as the <name> component and the entry decides where
                  in the line it sits. */}
              <Trans
                i18nKey="profile.onRepeatArtist"
                values={{ artist: friend.weekTopArtist }}
                components={{ b: <strong />, name: <ArtistLink artist={friend.weekTopArtist} /> }}
              />
            </p>
          )}
          {(friend.streakDays ?? 0) > 0 && (
            <p className="friendStats__artist">
              <Flame size={14} aria-hidden /> {t('profile.dayStreakCount', { count: friend.streakDays ?? 0 })}
            </p>
          )}
        </div>
      ) : (
        <Text size="sm" tone="muted">
          {friend.sharing === false
            ? t('profile.theyKeepPrivate')
            : friend.listenedAt
              ? t('profile.nothingPlayedThisWeek')
              : t('profile.noListeningShared')}
        </Text>
      )}
      {/* The tile shows the number and the label apart, so the label still has
          to agree with a count it is not sitting beside. */}
      <div className="friendStats__tiles">
        <StatTile value={formatNumber(friend.songs)} label={t('profile.songsHeard', { count: friend.songs })} />
        <StatTile value={formatNumber(friend.playlists)} label={t('profile.playlistsHeard', { count: friend.playlists })} />
        <StatTile value={formatNumber(friend.artists)} label={t('profile.artistsHeard', { count: friend.artists })} />
      </div>
    </div>
  );
}
