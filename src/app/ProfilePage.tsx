import { Button, IconButton, Input, Text } from '@glacier/react';
import { ChevronRight, Copy, LogOut, Radio, UsersRound } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { nearbySupported, useNearby } from './nearby.ts';
import { useJam } from './jam.tsx';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { useRegistry } from './registrySession.tsx';
import { AccountSetup, FriendAvatar } from './RegistryFriends.tsx';
import { fetchFriends, type FriendsFeed } from './registry.ts';
import { remotePath } from './server.ts';
import { fetchStatsSummary, type StatsSummary } from './stats.ts';
import {
  DayClock,
  DayClockSkeleton,
  GenreBars,
  GenreBarsSkeleton,
  HabitBadge,
  ListeningRadar,
  ListeningRadarSkeleton,
  StatTiles,
  StatTilesSkeleton,
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

      {week ? <StatTiles week={week} /> : <StatTilesSkeleton />}

      {/* While the week is on the wire we cannot know whether there is a shape
          to draw, so the placeholders stand for the whole set. They hold the
          exact geometry of the figures they replace, which is what keeps the
          page from jumping when the numbers land. */}
      {!week && !failed && (
        <>
          <ListeningRadarSkeleton />
          <h3 className="profileWeek__sub">When you listen</h3>
          <DayClockSkeleton />
          <h3 className="profileWeek__sub">What you played</h3>
          <GenreBarsSkeleton />
        </>
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

/** The address as people say it - the host, no scheme. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

// --- the page ---------------------------------------------------------------

export function ProfilePage({
  onOpenFriends,
  onOpenRoom,
}: {
  onOpenFriends?: () => void;
  /** Opens one of Profile's rooms - the takeovers App hosts within this tab. */
  onOpenRoom?: (room: 'stats') => void;
}) {
  const { session } = useServerSession();
  const { session: registry, account, apply, signOut } = useRegistry();

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

      {/* The room door: This week opens the full stats as a takeover within
          the tab. (Music Date used to have a door here too; it lives at the
          top of the Booth now.) */}
      {onOpenRoom && session && (
        <div className="profileDoors">
          <button type="button" className="profileDoor" onClick={() => onOpenRoom('stats')}>
            <span className="profileDoor__title">This week</span>
            <span className="profileDoor__caption">Your listening, added up</span>
            <ChevronRight size={16} className="profileDoor__chevron" />
          </button>
        </div>
      )}

      <YourWeek />

      {registry && account && onOpenFriends && (
        <FriendsDoor token={registry.token} onOpen={onOpenFriends} />
      )}

      <LiveNow />

    </div>
  );
}
