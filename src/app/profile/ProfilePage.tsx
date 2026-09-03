import { ArtistLink } from '../ux/ArtistLink.tsx';
import { Button, Heading, IconButton, Input, Text } from '@glacier/react';
import { ChevronRight, Copy, LogOut, Radio, Users, UsersRound } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { nearbySupported, useNearby } from './nearby.ts';
import { useJam } from '../player/jam.tsx';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistry } from '../servers/registrySession.tsx';
import { AccountSetup, FriendAvatar, FriendsSection } from './RegistryFriends.tsx';
import { FriendProfilePage } from './FriendProfilePage.tsx';
import { useSharing, setSharing } from './listeningShare.tsx';
import { type RegistryFriend } from '../servers/registry.ts';
import { enterServer, remotePath } from '../server.ts';
import type { Track } from '../core/tauri.ts';

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
function JoinJamByCode({ onJoin }: { onJoin: (code: string) => Promise<boolean> }) {
  const [code, setCode] = useState('');
  const [tried, setTried] = useState<'joined' | 'failed' | null>(null);
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
        setTried(null);
        void onJoin(clean).then((ok) => {
          setTried(ok ? 'joined' : 'failed');
          if (ok) setCode('');
        });
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
      {tried === 'joined' && (
        <Text size="xs" tone="subtle">
          You are in. The room shows above, and on the player.
        </Text>
      )}
      {tried === 'failed' && (
        <Text size="xs" tone="danger">
          No live room has that code - it may have ended, or be on another server.
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
              {/* The song's cover when there is one; the Users glyph when there
                  is not. A room has no artwork of its own, and the station mark
                  said "AttackFM" where the honest answer is "several people" -
                  which is also the mark this feature wears on Now Playing, so
                  the two are recognisably the same thing. */}
              <span className="jamLive__art" aria-hidden>
                {currentTrack?.artwork ? (
                  <img src={currentTrack.artwork} alt="" />
                ) : (
                  <span className="jamArt__glyph">
                    <Users size={22} />
                  </span>
                )}
                <span className="jamLive__pulse" />
              </span>
              <span className="jamLive__body">
                <span className="jamLive__title">
                  {jam.hosting ? 'Your jam' : `${jam.current.hostName}'s jam`}
                </span>
                <span className="jamLive__song">
                  {currentTrack ? (
                    <>
                      {currentTrack.title} — <ArtistLink artist={currentTrack.artist} />
                    </>
                  ) : (
                    'Waiting for the first song'
                  )}
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
                      {playing?.artwork ? (
                        <img src={playing.artwork} alt="" />
                      ) : (
                        <span className="jamArt__glyph">
                          <Users size={20} />
                        </span>
                      )}
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
      {!jam.current && <JoinJamByCode onJoin={(code) => jam.join(code)} />}

      <NearbyListeners
        handle={session.username ?? 'listener'}
        code={jam.hosting ? (jam.current?.id ?? null) : null}
        onJoin={(code) => void jam.join(code)}
      />
    </>
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

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  return raw.trim() || 'That did not work.';
}

export function ProfilePage({
  onOpenRoom,
  onPlay,
  onOpenArtist,
}: {
  /** Opens one of Profile's rooms - the takeovers App hosts within this tab. */
  onOpenRoom?: (room: 'stats') => void;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
}) {
  const { session, applySession } = useServerSession();
  const { session: registry, account, apply, signOut } = useRegistry();
  const sharing = useSharing();
  // A friend opened into their own profile - a takeover of the whole tab, the
  // way the stats room is. Held HERE, at the page, rather than inside the
  // friends grid, so it replaces the page instead of sitting in a section of
  // it. Friends live on Profile now: the grid used to be a tab of its own, and
  // by request it is folded back in under you, where it began.
  const [profileFor, setProfileFor] = useState<RegistryFriend | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const visit = useCallback(
    async (url: string) => {
      if (!registry) return;
      setNote(null);
      try {
        const next = await enterServer(url.replace(/\/+$/, ''), registry.token);
        applySession(next);
        setNote({ tone: 'ok', text: `Listening from ${hostOf(url)} now.` });
      } catch (err) {
        setNote({ tone: 'bad', text: messageOf(err) });
      }
    },
    [registry, applySession],
  );

  if (profileFor) {
    return (
      <FriendProfilePage
        friend={profileFor}
        onBack={() => setProfileFor(null)}
        onPlay={onPlay}
        onOpenArtist={onOpenArtist}
        onVisit={(f) => {
          if (f.serverUrl) void visit(f.serverUrl);
        }}
      />
    );
  }

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

      {/* Stats are a DOOR now, not the page. The full "This week" - the tiles,
          the radar, the day clock - opens as a takeover within the tab; it used
          to also sit inline here, which made a page about who you are open on a
          wall of your own numbers. (Music Date's door lived here too; it is at
          the top of the Booth now.) */}
      {onOpenRoom && session && (
        <div className="profileDoors">
          <button type="button" className="profileDoor" onClick={() => onOpenRoom('stats')}>
            <span className="profileDoor__title">This week</span>
            <span className="profileDoor__caption">Your listening, added up</span>
            <ChevronRight size={16} className="profileDoor__chevron" />
          </button>
        </div>
      )}

      <LiveNow />

      {/* The people, folded back under you. Tapping a card opens that friend as
          a takeover (profileFor above); visiting their server is handled here
          so the answer lands next to the card that asked. */}
      {registry && account && (
        <section className="homeShelf profileFriends">
          <Heading level={2} noMargin className="homeShelfTitle">
            Friends
          </Heading>
          {note && (
            <Text size="sm" tone={note.tone === 'ok' ? 'success' : 'danger'}>
              {note.text}
            </Text>
          )}
          <FriendsSection
            token={registry.token}
            me={account.handle}
            onOpen={setProfileFor}
            onVisit={(friend) => {
              if (friend.serverUrl) void visit(friend.serverUrl);
            }}
          />
          <footer className="friendsPage__foot">
            <Text size="xs" tone="subtle">
              {sharing
                ? 'Friends on this server can open your full profile - your stats and your liked songs. Friends elsewhere see your minutes, top artist and streak for the week, nothing more.'
                : 'You are not sharing your listening, so your card is blank and your profile is a closed door.'}
            </Text>
            <button
              type="button"
              className="friendsPage__shareToggle"
              onClick={() => setSharing(!sharing)}
            >
              {sharing ? 'Stop sharing my listening' : 'Share my listening'}
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
