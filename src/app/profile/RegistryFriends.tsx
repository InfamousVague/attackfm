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
  Field,
  IconButton,
  Input,
  Modal,
  Skeleton,
  Spinner,
  StatTile,
  Text,
} from '@glacier/react';
import { ArrowUpRight, ChartNoAxesColumn, Check, Clock, Flame, Music, UserPlus, X } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { artistImageKnown, cachedArtistImage, resolveArtistImage } from '../albumArtist/artistImage.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
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
import { fmtMinutes } from './stats.ts';

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

/** "now", "4h ago" - the coarse read a friend row wants, never a timestamp. */
export function seenAgo(stamp: number): string | null {
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

/** The listening glance a friend chose to share: "6h 20m this week · Jon Hopkins". */
function weekGlance(f: RegistryFriend): string | null {
  if (typeof f.weekMinutes !== 'number' || f.weekMinutes <= 0) return null;
  // Time only - the artist half renders separately, as a door rather than a
  // suffix baked into the string. Hours AND minutes: rounding to the hour
  // read 89 and 91 minutes as the same "1h".
  return `${fmtMinutes(f.weekMinutes)} this week`;
}

/** Online: the registry's word when it has one (a heartbeat within the last
 *  minute or two), else the old read off seenAt. */
export function isOnline(f: RegistryFriend): boolean {
  return f.online ?? seenAgo(f.seenAt) === 'online now';
}

/** "for 12m" - how long the song they are on has been on. */
function sinceAgo(sinceSecs: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - sinceSecs) / 60));
  return mins < 1 ? 'just started' : mins < 60 ? `for ${mins}m` : `for ${Math.round(mins / 60)}h`;
}

/** What they are hearing right now, as a line - or null when nothing is on. */
export function NowPlayingLine({ f, long = false }: { f: RegistryFriend; long?: boolean }) {
  const np = f.nowPlaying;
  if (!np) return null;
  return (
    <span className="friendRow__live" data-paused={!np.playing || undefined}>
      <Music size={12} aria-hidden />
      <span className="friendRow__liveDot" aria-hidden />
      <span className="friendRow__liveText">
        {np.playing ? 'Listening to ' : 'Paused on '}
        <strong>{np.title}</strong>
        {np.artist ? ` · ${np.artist}` : ''}
        {long && np.since ? ` · ${sinceAgo(np.since)}` : ''}
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
  return (
    <div className="registrySetup">
      <div className="emptyState">
        <EmptyArt name="friends" />
        <p className="emptyState__text">
          Your AttackFM account is the one key: friends, invitations to their servers, and every
          server you belong to, on every device.
        </p>
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
  me,
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
  const { session: server } = useServerSession();
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
      setFeedError(e instanceof Error && e.message ? e.message : 'attack.fm is not answering');
    }
    try {
      setShares(await fetchShares(token));
    } catch {
      // A registry from before songs could be sent has no inbox to show.
    }
  }, [token]);

  /**
   * Take a song a friend sent: ask YOUR OWN hub for it by name. The hub
   * favourites it at once if it already has a match, and otherwise remembers
   * the promise for its collector - the same door Discover's heart uses, and
   * the only way a song ever enters a library. The registry only ever knew
   * the title.
   */
  const takeShare = async (s: Share) => {
    if (!server) {
      setNote({ tone: 'bad', text: 'Connect to your server first - that is where the song goes.' });
      return;
    }
    setBusy(true);
    try {
      const { landed } = await addPendingLike(server, s.artist, s.title);
      await settleShare(token, s.id, true);
      setShares((prev) => prev.filter((x) => x.id !== s.id));
      setNote({
        tone: 'ok',
        text: landed ? `${s.title} is already here - it is in your Liked songs now.` : `${s.title} is on its way; it lands in Liked songs.`,
      });
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'That did not go through.' });
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
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'That did not go through.' });
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
      // Close on success: the new "waiting" card appearing in the grid IS the
      // confirmation, and the registry's own words ride the page note.
      setAddOpen(false);
      setNote({ tone: 'ok', text: message });
    });
  };

  const friends = [...(feed?.friends ?? [])].sort(byLiveness);
  const incoming = feed?.incoming ?? [];
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
        placeholder="their-handle"
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
          Could not reach attack.fm ({feedError}).{feed ? ' Showing what was last read.' : ''}
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

      {senderAsks.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Wants to send you songs</h2>
          <div className="requestCards">
            {senderAsks.map((handle) => (
              <div key={handle} className="requestCard">
                <FriendAvatar handle={handle} size="md" />
                <span className="requestCard__handle">{handle}</span>
                <span className="requestCard__actions">
                  <Button variant="solid" size="sm" disabled={busy} onClick={() => void decideSender(handle, true)}>
                    <Check size={15} /> <span>Take them</span>
                  </Button>
                  <IconButton variant="ghost" size="sm" disabled={busy} aria-label={`Do not take songs from ${handle}`} onClick={() => void decideSender(handle, false)}>
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
          <h2 className="homeShelfTitle">Sent to you</h2>
          <div className="requestCards">
            {songsSent.map((s) => (
              <div key={s.id} className="requestCard">
                <FriendAvatar handle={s.from} size="md" />
                <span className="requestCard__handle">
                  {s.title}
                  <Text as="span" tone="muted" size="xs" className="requestCard__sub">
                    {s.artist} · from {s.from}
                    {s.note ? ` · “${s.note}”` : ''}
                  </Text>
                </span>
                <span className="requestCard__actions">
                  <Button variant="solid" size="sm" disabled={busy} onClick={() => void takeShare(s)}>
                    <Check size={15} /> <span>Get it</span>
                  </Button>
                  <IconButton variant="ghost" size="sm" disabled={busy} aria-label={`Put away ${s.title}`} onClick={() => void putAway(s)}>
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
            Friends{friends.length > 0 ? ` · ${friends.length}` : ''}
            {/* The live count beside the total: what the page is FOR. */}
            {(listeningNow > 0 || onlineNow > 0) && (
              <span className="friendsBar__live">
                {listeningNow > 0
                  ? `${listeningNow} listening now`
                  : `${onlineNow} online`}
              </span>
            )}
          </h2>
          <Button variant="outline" size="sm" onClick={openAdd}>
            <UserPlus size={15} /> <span>Add</span>
          </Button>
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
          <p className="statsNote">Nothing to show until attack.fm answers.</p>
        ) : friends.length === 0 && outgoing.length === 0 ? (
          <div className="emptyState">
            <EmptyArt name="friends" />
            <p className="emptyState__text">
              Nobody yet. Add someone by their handle, and they show up here once they say yes.
            </p>
            {/* The one place the add form lives in the open: on an empty page
                it IS the next step, not chrome above the content. */}
            <div className="friendsEmptyAdd">{addForm}</div>
          </div>
        ) : (
          <div className="friendRows">
            {friends.map((f) => {
              const seen = seenAgo(f.seenAt);
              const online = isOnline(f);
              const glance = weekGlance(f);
              // Sharing OFF is its own honest line; a quiet week is another.
              const quiet =
                f.sharing === false
                  ? 'keeps their listening private'
                  : glance === null && f.songs > 0
                    ? 'quiet this week'
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
                      {[f.songs > 0 ? `${f.songs.toLocaleString()} songs` : 'no library yet', online ? 'online' : seen]
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
                    {/* Their library is somewhere this device is not listening
                        from - offer the walk over. The page decides what that
                        means (a one-tap switch, or the truth about invites). */}
                    {onVisit && f.serverUrl && server?.url !== f.serverUrl.replace(/\/+$/, '') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Visit their server, ${f.handle}`}
                        onClick={() => onVisit(f)}
                      >
                        <ArrowUpRight size={15} />
                        Visit their server
                      </Button>
                    )}
                    {/* The profile: the stats modal's grown-up replacement.
                        A whole page - their stats, and on a shared server
                        their liked songs too. */}
                    {onOpen && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Profile for ${f.handle}`}
                        onClick={() => onOpen(f)}
                      >
                        <ChartNoAxesColumn size={15} />
                        Profile
                      </Button>
                    )}
                  </div>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="friendRow__remove"
                    disabled={busy}
                    aria-label={`Remove ${f.handle}`}
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
                  <span className="friendRow__meta">invited · waiting</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add a friend" size="sm">
        <div className="friendsModal">
          <Text size="sm" tone="muted">
            Ask by handle. They appear in your grid once they say yes.
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
            <span className="friendStats__minutes">{fmtMinutes(friend.weekMinutes ?? 0)}</span>
            <span className="friendStats__label">listened this week</span>
          </div>
          {/* Names do not belong in number tiles - a tile ellipsizes exactly
              the part that matters. The artist gets a sentence of their own,
              and the streak keeps a bare number a tile can always fit. */}
          {friend.weekTopArtist && (
            <p className="friendStats__artist">
              <Clock size={14} aria-hidden /> On repeat:{' '}
              <strong>
                <ArtistLink artist={friend.weekTopArtist} />
              </strong>
            </p>
          )}
          {(friend.streakDays ?? 0) > 0 && (
            <p className="friendStats__artist">
              <Flame size={14} aria-hidden /> {friend.streakDays}-day streak
            </p>
          )}
        </div>
      ) : (
        <Text size="sm" tone="muted">
          {friend.sharing === false
            ? 'They keep their listening private.'
            : friend.listenedAt
              ? 'Nothing played this week yet.'
              : 'They have not shared any listening yet.'}
        </Text>
      )}
      <div className="friendStats__tiles">
        <StatTile value={friend.songs.toLocaleString()} label="songs" />
        <StatTile value={friend.playlists.toLocaleString()} label="playlists" />
        <StatTile value={friend.artists.toLocaleString()} label="artists" />
      </div>
    </div>
  );
}
