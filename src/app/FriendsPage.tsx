import { Button } from '@glacier/react';
import { Radio } from '@glacier/icons';
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

      {/* Not in a room and nobody live: the start affordance stands alone,
          quiet, above the graph - starting a jam is the page's verb even when
          nothing is happening yet. */}
      {session && !jam.current && liveRooms.length === 0 && (
        <div className="jamIdle">
          <Button variant="soft" size="sm" onClick={() => void jam.start()}>
            <Radio size={15} />
            <span>Start a jam</span>
          </Button>
          <span className="jamIdle__hint">Friends can join and hear what you hear.</span>
        </div>
      )}

      <RegistryFriends />
    </div>
  );
}
