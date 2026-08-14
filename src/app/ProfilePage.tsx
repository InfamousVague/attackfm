import { Button, IconButton, Modal, Input, Spinner, Text } from '@glacier/react';
import { ChevronRight, Copy, Link2, LogOut, Plus, Radio, Server, UsersRound, X } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { nearbySupported, useNearby } from './nearby.ts';
import { useJam } from './jam.tsx';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { useRegistry } from './registrySession.tsx';
import { AccountSetup, FriendAvatar } from './RegistryFriends.tsx';
import { JoinServer } from './JoinServer.tsx';
import {
  createInvite,
  fetchFriends,
  inviteLink,
  type FriendsFeed,
  type RegistryFriend,
} from './registry.ts';
import { enterServer, fetchServerInfo, linkAccount, remotePath } from './server.ts';
import { forgetServer, knownServers, rememberServer, type KnownServer } from './servers.ts';
import { fetchStatsSummary, type StatsSummary } from './stats.ts';
import {
  DayClock,
  GenreBars,
  HabitBadge,
  ListeningRadar,
  StatTiles,
  profileAxes,
} from './ProfileCharts.tsx';
import placeholderArt from '../assets/attack-wave.png';

/**
 * The Profile page: you, and everything social that hangs off you.
 *
 * It stands where Friends stood, because the friends were never the whole
 * story - they are one section of a person. The page stacks in the order the
 * layers actually depend on each other:
 *
 *   who you are        - the registry identity (or creating one),
 *   what is live       - jams happening right now, joinable this second,
 *   where you listen   - every server this device has entered, one tap to
 *                        switch, plus the two doors: invite a friend IN, or
 *                        join somewhere new yourself,
 *   who you know       - the friends graph.
 *
 * The server section is the page's real work. Sharing a hub used to hide
 * behind an Invite button inside a modal inside the friends header; joining
 * one appeared only while you had no server at all - so the two most asked
 * questions ("how do I get into my friend's server?", "how do I add another
 * one?") had answers the page never showed. Here they are cards, always.
 */

// --- live layer (moved whole from the old Friends page) ---------------------

/**
 * Who else is in the room, over Bluetooth and peer-to-peer Wi-Fi - so it
 * works in a car, where nobody shares a network and the person beside you
 * may not be a friend yet.
 *
 * Deliberately a switch rather than a default: this broadcasts a handle to
 * anyone running the app within earshot, which is fine when you are trying
 * to start a jam and nobody's business the rest of the time.
 */
function NearbyListeners({
  handle,
  code,
  onJoin,
}: {
  handle: string;
  code: string | null;
  onJoin: (code: string) => void;
}) {
  const nearby = useNearby(handle, code);
  if (!nearbySupported()) return null;
  return (
    <section className="nearby">
      <div className="nearby__head">
        <span className="nearby__title">
          <Radio size={15} /> Nearby
        </span>
        <Button variant={nearby.on ? 'solid' : 'outline'} size="sm" onClick={nearby.on ? nearby.stop : nearby.start}>
          {nearby.on ? 'Stop looking' : 'Find people near me'}
        </Button>
      </div>
      {nearby.on && (
        nearby.peers.length === 0 ? (
          <Text size="sm" tone="muted">
            Looking… they need this switched on too. {code ? 'Your jam’s code is going out with it.' : 'Start a jam and its code goes out with it.'}
          </Text>
        ) : (
          <div className="nearbyList">
            {nearby.peers.map((peer) => (
              <div key={peer.handle} className="nearbyRow">
                <FriendAvatar handle={peer.handle} size="sm" />
                <span className="nearbyRow__text">
                  <span className="nearbyRow__handle">{peer.handle}</span>
                  <span className="nearbyRow__sub">
                    {peer.code ? 'Playing something you can join' : 'Nearby'}
                  </span>
                </span>
                {peer.code && (
                  <Button variant="solid" size="sm" onClick={() => onJoin(peer.code!)}>
                    Join
                  </Button>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </section>
  );
}

/** The code box: six characters, however they were typed. */
function JoinJamByCode({ onJoin }: { onJoin: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [tried, setTried] = useState(false);
  // The code is read aloud as often as it is pasted, so it arrives with
  // spaces, dashes and whatever case the reader felt like.
  const clean = code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const ready = clean.length >= 4;
  return (
    <form
      className="jamJoin"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setTried(true);
        onJoin(clean);
        setCode('');
      }}
    >
      <Input
        className="jamJoin__field"
        value={code}
        onChange={(e) => setCode(e.currentTarget.value)}
        placeholder="Join with a code"
        aria-label="Jam code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
      />
      <Button type="submit" variant="outline" size="sm" disabled={!ready}>
        <Radio size={15} /> <span>Join</span>
      </Button>
      {tried && (
        <Text size="xs" tone="subtle">
          If the room is live you are in it; if not, the code has expired.
        </Text>
      )}
    </form>
  );
}

function LiveNow() {
  const { session } = useServerSession();
  const jam = useJam();
  const { tracks } = useLibrary();

  // What a room is playing, resolved against this device's own library - the
  // whole point of friends being on your server is that their now-playing is
  // your catalogue too.
  const trackOf = (trackId: number | null) =>
    trackId != null ? (tracks.find((t) => t.path === remotePath(trackId)) ?? null) : null;

  const liveRooms = jam.friendJams.filter((room) => room.id !== jam.current?.id);
  const currentTrack = jam.current ? trackOf(jam.current.trackId) : null;
  if (!session) return null;

  return (
    <>
      {(jam.current || liveRooms.length > 0) && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Live now</h2>

          {/* The room this listener is in: the one card on the page that is
              happening to THEM right now, so it reads as a place - cover art,
              a pulse, who is inside - rather than a row. */}
          {jam.current && (
            <div className="jamLive">
              <span className="jamLive__art" aria-hidden>
                <img src={currentTrack?.artwork ?? placeholderArt} alt="" />
                <span className="jamLive__pulse" />
              </span>
              <span className="jamLive__body">
                <span className="jamLive__title">
                  {jam.hosting ? 'Your jam' : `${jam.current.hostName}'s jam`}
                </span>
                <span className="jamLive__song">
                  {currentTrack
                    ? `${currentTrack.title} — ${currentTrack.artist}`
                    : 'Waiting for the first song'}
                </span>
                <span className="jamLive__meta">
                  {jam.current.memberCount === 1
                    ? 'Just you so far'
                    : `${jam.current.memberCount} listening`}
                  {jam.hosting ? ' · you set the pace' : ' · following along'}
                  {/* The code IS the invitation: read it out in a car, where
                      nobody shares your wifi and the person beside you may
                      not be in your friends list yet. */}
                  {jam.hosting && (
                    <button
                      type="button"
                      className="jamLive__code"
                      title="Copy the code"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(jam.current!.id.toUpperCase())
                          .catch(() => {});
                      }}
                    >
                      Code {jam.current.id.toUpperCase()}
                    </button>
                  )}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => void jam.leave()}>
                Leave
              </Button>
            </div>
          )}

          {/* Friends' rooms: cards you can walk into, each wearing its host and
              whatever is on in there. */}
          {liveRooms.length > 0 && (
            <div className="jamRooms">
              {liveRooms.map((room) => {
                const playing = trackOf(room.trackId);
                return (
                  <div key={room.id} className="jamRoom">
                    <span className="jamRoom__art" aria-hidden>
                      <img src={playing?.artwork ?? placeholderArt} alt="" />
                      <FriendAvatar handle={room.hostName} size="sm" className="jamRoom__host" />
                    </span>
                    <span className="jamRoom__name">{room.hostName}</span>
                    <span className="jamRoom__meta">
                      {playing ? playing.title : 'Listening'}
                      {` · ${room.memberCount} inside`}
                    </span>
                    <Button variant="solid" size="sm" onClick={() => void jam.join(room.id)}>
                      Join
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Someone in the car reads out six characters and you are in their
          room. No shared wifi, no friend request first, nothing to scan. */}
      {!jam.current && <JoinJamByCode onJoin={(code) => void jam.join(code)} />}

      <NearbyListeners
        handle={session.username ?? 'listener'}
        code={jam.hosting ? (jam.current?.id ?? null) : null}
        onJoin={(code) => void jam.join(code)}
      />
    </>
  );
}

// --- the servers ------------------------------------------------------------

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
function ServersSection({ visiting }: { visiting: RegistryFriend | null }) {
  const { session, applySession } = useServerSession();
  const { session: registry, account } = useRegistry();

  const [saved, setSaved] = useState<KnownServer[]>(() => knownServers());
  const refresh = () => setSaved(knownServers());

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
        const next = await enterServer(url, registry.token);
        applySession(next);
        refresh();
        setNote({ tone: 'ok', text: `Listening from ${hostOf(url)} now.` });
      } catch (err) {
        setNote({ tone: 'bad', text: messageOf(err) });
      } finally {
        setBusyUrl(null);
      }
    },
    [registry, applySession],
  );

  // A friend's card said "visit": the page lands the attempt here, where the
  // outcome (in, or the invite-only truth) shows beside every other server.
  useEffect(() => {
    if (!visiting?.serverUrl) return;
    void switchTo(visiting.serverUrl.replace(/\/+$/, ''));
  }, [visiting, switchTo]);

  // The current session leads even if the ledger predates it.
  const cards = useMemo(() => {
    const current = session?.url ?? null;
    const list = [...saved];
    if (current && !list.some((s) => s.url === current)) {
      list.unshift({ url: current, username: session?.username, isAdmin: session?.isAdmin, lastUsed: Date.now() });
    }
    return list.sort((a, b) => Number(b.url === current) - Number(a.url === current) || b.lastUsed - a.lastUsed);
  }, [saved, session]);

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
    <section className="homeShelf serversSection">
      <h2 className="homeShelfTitle">Where you listen</h2>

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
    </section>
  );
}

/**
 * You, this week.
 *
 * The number that used to exist only on a friend's card, shown to its owner
 * first. It is the same glance the registry shares - minutes, top artist,
 * streak - so this doubles as the honest preview of what friends can see, and
 * the page never claims to share something it is not showing you.
 */
function YourWeek() {
  const { session } = useServerSession();
  const [week, setWeek] = useState<StatsSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!session) return;
    let live = true;
    void fetchStatsSummary(session, 'week')
      .then((s) => live && setWeek(s))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [session]);

  if (!session || failed) return null;

  const top = week?.topArtists[0]?.artist ?? null;
  const axes = week ? profileAxes(week) : [];
  // A week with nothing in it has no shape to draw, and an empty radar reads
  // as a broken one rather than an honest zero.
  const hasHistory = !!week && week.plays > 0;

  return (
    <section className="homeShelf profileWeek">
      <div className="profileWeek__head">
        <h2 className="homeShelfTitle">Your week</h2>
        {hasHistory && <HabitBadge axes={axes} />}
      </div>

      {week ? (
        <StatTiles week={week} />
      ) : (
        <Text size="sm" tone="muted">
          Counting…
        </Text>
      )}

      {hasHistory && week && (
        <>
          <ListeningRadar axes={axes} />

          <h3 className="profileWeek__sub">When you listen</h3>
          <DayClock clock={week.clock} />

          {week.topGenres.length > 0 && (
            <>
              <h3 className="profileWeek__sub">What you played</h3>
              <GenreBars genres={week.topGenres} />
            </>
          )}
        </>
      )}

      {top && (
        <Text size="sm" tone="muted">
          Most played: <strong>{top}</strong>
        </Text>
      )}
    </section>
  );
}

/**
 * The doorway to the people.
 *
 * A handful of faces and a count, because the point of the row is to say
 * "there is something through here" - the grid itself, with its artist
 * photographs, wants the whole screen and now has one.
 */
function FriendsDoor({ token, onOpen }: { token: string; onOpen: () => void }) {
  const [feed, setFeed] = useState<FriendsFeed | null>(null);

  useEffect(() => {
    let live = true;
    void fetchFriends(token)
      .then((f) => live && setFeed(f))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token]);

  const friends = feed?.friends ?? [];
  const waiting = feed?.incoming.length ?? 0;

  return (
    <button type="button" className="profileDoor" onClick={onOpen}>
      <span className="profileDoor__faces">
        {friends.slice(0, 4).map((f) => (
          <FriendAvatar key={f.id} handle={f.handle} size="sm" className="profileDoor__face" />
        ))}
        {friends.length === 0 && <UsersRound size={18} />}
      </span>
      <span className="profileDoor__text">
        <span className="profileDoor__title">Friends</span>
        <span className="profileDoor__sub">
          {friends.length === 0
            ? 'Nobody yet — add someone by their handle'
            : `${friends.length} ${friends.length === 1 ? 'friend' : 'friends'}${waiting > 0 ? ` · ${waiting} waiting on you` : ''}`}
        </span>
      </span>
      <ChevronRight size={18} className="profileDoor__chevron" />
    </button>
  );
}

// --- the page ---------------------------------------------------------------

export function ProfilePage({ onOpenFriends }: { onOpenFriends?: () => void }) {
  const { session } = useServerSession();
  const { session: registry, account, apply, signOut } = useRegistry();
  // A friend-card "visit" lands in the servers section, so its outcome shows
  // where the servers live rather than in the middle of the people.
  const [visiting, setVisiting] = useState<RegistryFriend | null>(null);

  return (
    <div className="homePage profilePage">
      {registry && account ? (
        <header className="profileHero">
          <FriendAvatar handle={account.handle} size="lg" className="profileHero__face" />
          <span className="profileHero__body">
            <h1 className="profileHero__handle">@{account.handle}</h1>
            <span className="profileHero__caption">
              {session
                ? `Listening from ${hostOf(session.url)}${session.username ? ` as ${session.username}` : ''}`
                : 'Your account, on every server'}
            </span>
          </span>
          <IconButton
            variant="ghost"
            size="sm"
            className="profileHero__signout"
            aria-label={`Sign out of @${account.handle}`}
            title="Sign out"
            onClick={signOut}
          >
            <LogOut size={16} />
          </IconButton>
        </header>
      ) : (
        <AccountSetup onDone={apply} />
      )}

      <YourWeek />

      {registry && account && onOpenFriends && (
        <FriendsDoor token={registry.token} onOpen={onOpenFriends} />
      )}

      <LiveNow />

      {(registry || session) && <ServersSection visiting={visiting} />}
    </div>
  );
}
