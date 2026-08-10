import { Button } from '@glacier/react';
import { Radio } from '@glacier/icons';
import { useJam } from './jam.tsx';
import { useServerSession } from './serverSession.tsx';
import { RegistryFriends } from './RegistryFriends.tsx';

/**
 * Friends.
 *
 * Two layers meet here. The friendship itself is central-identity now - it
 * lives in the registry and spans whichever server either person is on - so the
 * graph, adding by handle, and inviting are all `RegistryFriends`, and they work
 * whether or not this device has joined a server.
 *
 * Jamming (listening together) sits on top and is still server-shaped: a jam is
 * a room on a server's Connect hub, so the jam strip appears only when a server
 * is connected. It is the one thing on this page that needs the library, not
 * just the identity.
 */
export function FriendsPage() {
  const { session } = useServerSession();
  const jam = useJam();

  return (
    <div className="homePage friendsPage">
      {/* Listening together, at the top - but only with a server to host it. */}
      {session && (
        <>
          <section className="jamStrip">
            {jam.current ? (
              <div className="jamCard jamCard--live">
                <span className="jamCard__pulse" aria-hidden />
                <span className="jamCard__body">
                  <span className="jamCard__title">
                    {jam.hosting ? 'Your jam' : `${jam.current.hostName}'s jam`}
                  </span>
                  <span className="jamCard__sub">
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
            ) : (
              <Button variant="soft" size="sm" onClick={() => void jam.start()}>
                <Radio size={15} />
                <span>Start a jam</span>
              </Button>
            )}
          </section>

          {jam.friendJams.length > 0 && (
            <section className="homeShelf">
              <h2 className="homeShelfTitle">Jams happening now</h2>
              <ul className="friendList">
                {jam.friendJams.map((room) => (
                  <li key={room.id} className="friendRow">
                    <span className="friendRow__avatar" aria-hidden>
                      {room.hostName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="friendRow__name">
                      {room.hostName}
                      <span className="jamRow__count">
                        {room.memberCount === 1 ? ' · alone' : ` · ${room.memberCount} listening`}
                      </span>
                    </span>
                    <span className="friendRow__actions">
                      <Button variant="solid" size="sm" onClick={() => void jam.join(room.id)}>
                        Join
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <RegistryFriends />
    </div>
  );
}
