import { Button, Input, Text } from '@glacier/react';
import { Radio } from '@glacier/icons';
import { useState } from 'react';
import { nearbySupported, useNearby } from './nearby.ts';
import { useJam } from './jam.tsx';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { FriendAvatar, RegistryFriends } from './RegistryFriends.tsx';
import { remotePath } from './server.ts';
import placeholderArt from '../assets/attack-wave.png';

/**
 * Friends.
 *
 * Two layers meet here. The friendship itself is central-identity - it lives in
 * the registry and spans whichever server either person is on - so the graph,
 * adding by handle, and inviting are all `RegistryFriends`, and they work
 * whether or not this device has joined a server.
 *
 * Jamming (listening together) sits on top and is server-shaped: a jam is a
 * room on a server's Connect hub, so the live section appears only with a
 * server connected. It leads the page because it is the page's one LIVE thing:
 * a friend's room you can walk into right now beats a directory of names.
 */
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

export function FriendsPage() {
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

  return (
    <div className="homePage friendsPage">
      {session && (jam.current || liveRooms.length > 0) && (
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
              whatever is on in there. A shelf row, so three jams do not become
              three full-width rows of chrome. */}
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
      {session && !jam.current && <JoinJamByCode onJoin={(code) => void jam.join(code)} />}

      {/* The same thing without the reading aloud, where the phones can find
          each other directly. Off until asked, and only in the app. */}
      {session && (
        <NearbyListeners
          handle={session.username ?? 'listener'}
          code={jam.hosting ? (jam.current?.id ?? null) : null}
          onJoin={(code) => void jam.join(code)}
        />
      )}

      <RegistryFriends />
    </div>
  );
}
