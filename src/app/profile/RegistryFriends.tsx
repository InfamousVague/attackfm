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
//!   - `FriendsSection`: the friends graph - one grid holding friends and
//!     still-waiting invites alike, with the add-by-handle verb in the section
//!     head. Identity chrome (whose account this is, signing out) and the
//!     server-shaped verbs (inviting someone in, joining elsewhere) live on
//!     the Profile page around it - a section shows the people, the page owns
//!     the person.

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
import { ChartNoAxesColumn, Check, Clock, Flame, UserPlus, X } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { artistImageKnown, cachedArtistImage, resolveArtistImage } from '../albumArtist/artistImage.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  acceptFriendRequest,
  announce,
  declineFriendRequest,
  fetchFriends,
  login,
  removeFriend,
  sendFriendRequest,
  signup,
  type FriendsFeed,
  type RegistryFriend,
} from '../servers/registry.ts';
import { fmtMinutes } from './stats.ts';

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

/** The listening glance a friend chose to share: "6h this week · Jon Hopkins". */
function weekGlance(f: RegistryFriend): string | null {
  if (typeof f.weekMinutes !== 'number' || f.weekMinutes <= 0) return null;
  const time = f.weekMinutes >= 60 ? `${Math.round(f.weekMinutes / 60)}h this week` : `${Math.round(f.weekMinutes)}m this week`;
  return f.weekTopArtist ? `${time} · ${f.weekTopArtist}` : time;
}

// --- account setup ----------------------------------------------------------

export function AccountSetup({ onDone }: { onDone: (s: import('../servers/registry.ts').RegistrySession) => void }) {
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

/** How the friend-visit verb reports back to the page (see ProfilePage): the
 *  section stays about people, the page decides what a visit means. */
export type VisitServer = (friend: RegistryFriend) => void;

export function FriendsSection({
  token,
  me,
  onVisit,
}: {
  token: string;
  me: string;
  /** Offered on a friend's card when they answer from a server that is not
   *  the one this device is listening from. */
  onVisit?: VisitServer;
}) {
  const { session: server } = useServerSession();
  const [feed, setFeed] = useState<FriendsFeed | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [statsFor, setStatsFor] = useState<RegistryFriend | null>(null);

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

  const friends = feed?.friends ?? [];
  const incoming = feed?.incoming ?? [];
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

      <section className="homeShelf">
        <div className="friendsBar">
          <h2 className="homeShelfTitle">Friends{friends.length > 0 ? ` · ${friends.length}` : ''}</h2>
          <Button variant="outline" size="sm" onClick={openAdd}>
            <UserPlus size={15} /> <span>Add</span>
          </Button>
        </div>
        {feed === null ? (
          /* Loading is NOT emptiness. Falling through to the empty state here
             told people they had no friends before the answer had arrived -
             and on a slow link that claim sat on screen for seconds. Six
             card-shaped seats say "counting" instead, in the grid the real
             cards will use. */
          <div className="friendGrid" aria-busy>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="friendCard friendCard--pending">
                <Skeleton variant="circle" width="3rem" height="3rem" />
                <Skeleton variant="text" width="4.5rem" />
                <Skeleton variant="text" width="6rem" />
              </div>
            ))}
          </div>
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
          <div className="friendGrid">
            {friends.map((f) => {
              const seen = seenAgo(f.seenAt);
              const online = seen === 'online now';
              const glance = weekGlance(f);
              // `artTick` is read here so the memo-free grid re-renders when a
              // batch of pictures lands; the value itself is meaningless.
              void artTick;
              const backdrop = cachedArtistImage(f.weekTopArtist ?? '');
              return (
                <div key={f.id} className="friendCard" data-online={online || undefined}>
                  {backdrop && (
                    <img
                      className="friendCard__backdrop"
                      src={backdrop}
                      alt=""
                      aria-hidden
                      loading="lazy"
                    />
                  )}
                  <FriendAvatar handle={f.handle} size="lg" className="friendCard__face" />
                  <span className="friendCard__handle">{f.handle}</span>
                  <span className="friendCard__meta">
                    {[f.songs > 0 ? `${f.songs.toLocaleString()} songs` : 'no library yet', online ? null : seen]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {/* What they've been playing, if they share it - the line
                      that makes the grid about music rather than accounts. */}
                  {glance && <span className="friendCard__glance">{glance}</span>}
                  {/* Their library is somewhere this device is not listening
                      from - offer the walk over. The page decides what that
                      means (a one-tap switch, or the truth about invites). */}
                  <div className="friendCard__actions">
                    {/* Their numbers, from what the registry already holds -
                        no extra request, and nothing they have not chosen to
                        announce. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="friendCard__stats"
                      onClick={() => setStatsFor(f)}
                    >
                      <ChartNoAxesColumn size={14} />
                      Stats
                    </Button>
                    {onVisit && f.serverUrl && server?.url !== f.serverUrl.replace(/\/+$/, '') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="friendCard__visit"
                        onClick={() => onVisit(f)}
                      >
                        Visit their server
                      </Button>
                    )}
                  </div>
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
            {/* Asks still in the air share the grid as ghosts: an invited
                person is already a person, just not yet a yes - one grid of
                people beats a separate strip of chips. */}
            {outgoing.map((r) => (
              <div key={`out-${r.id}`} className="friendCard friendCard--waiting">
                <FriendAvatar handle={r.handle} size="lg" className="friendCard__face" />
                <span className="friendCard__handle">{r.handle}</span>
                <span className="friendCard__meta">invited · waiting</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={statsFor !== null}
        onClose={() => setStatsFor(null)}
        title={statsFor ? `@${statsFor.handle}` : ''}
        size="sm"
      >
        {statsFor && <FriendStats friend={statsFor} />}
      </Modal>

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
function FriendStats({ friend }: { friend: RegistryFriend }) {
  const sharing = typeof friend.weekMinutes === 'number';
  return (
    <div className="friendStats">
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
              <Clock size={14} aria-hidden /> On repeat: <strong>{friend.weekTopArtist}</strong>
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
          They don&rsquo;t share their listening (or haven&rsquo;t played anything this week).
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
