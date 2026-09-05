import { useState } from 'react';
import { Button, IconButton, Popover, Text } from '@glacier/react';
import { Music, Share2, Users } from '@glacier/icons';
import { useJamOptional } from './jam.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { ShareJamSheet } from './ShareJam.tsx';
import { FriendAvatar } from '../profile/RegistryFriends.tsx';

/**
 * Who else is hearing this, on the screen where you are hearing it.
 *
 * A groove was visible in exactly one place - the Live now shelf on your profile -
 * which is the page you are NOT on while a groove is happening. So the room existed
 * and the listening happened somewhere else, and the only way to check who was
 * in it, or to get out, was to leave the music and go and find the card.
 *
 * This is the same shape as DevicePicker beside it, deliberately: both answer
 * "where is this going" from the transport row, both are a glyph that carries
 * its state, and both open a small panel rather than navigating away. A groove and
 * a hand-off are the same kind of question asked about different things.
 *
 * THE GLYPH IS THE POINT. A groove has no artwork of its own - what is on the
 * screen belongs to the song, not to the room - so the room needs a mark that
 * says "several people" at a glance. `Users` is that mark, and it is the one
 * this feature wears everywhere now, so the badge here and the card on the
 * profile are recognisably the same thing.
 */
export function JamBadge() {
  const jam = useJamOptional();
  const { session } = useServerSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Mounted on first use: the sheet mints a link and draws a card, and this
  // component is in the transport row of every screen.
  const [sharing, setSharing] = useState(false);

  // No provider (a build without grooves) or nobody signed in: a groove is a
  // thing that happens on a server, so without one there is nothing to offer.
  if (!jam || !session) return null;

  const room = jam.current;
  const others = room ? Math.max(0, room.memberCount - 1) : 0;
  const joinable = jam.friendJams.filter((r) => r.id !== room?.id);

  /*
   * NOT in a groove, and the button is still here.
   *
   * This used to render nothing until you were already in a room, which meant
   * the only way to START one was the Live now shelf on your profile - and that
   * is the page you leave in order to listen to something. A groove is a thing you
   * decide to do while a song is playing, so the door belongs on the screen
   * where the song is.
   *
   * The panel does the two things you can do from outside a room: open one, or
   * walk into a friend's. Both were profile-only before.
   */
  if (!room) {
    const startJam = async () => {
      setBusy(true);
      setFailed(false);
      try {
        await jam.start();
      } catch {
        // An older server has no groove endpoint, and start() would otherwise
        // fail silently - a button that does nothing and says nothing is worse
        // than one that admits it.
        setFailed(true);
      } finally {
        setBusy(false);
      }
    };
    return (
      <Popover
        placement="top-end"
        aria-label="Start a groove"
        className="popoverSheet jamPanel"
        trigger={
          <IconButton variant="ghost" size="sm" className="jamTrigger" aria-label="Start a groove">
            <Users size={16} />
          </IconButton>
        }
      >
        <div className="jamPanel__body">
          <div className="jamPanel__head">
            <span className="jamPanel__glyph" aria-hidden>
              <Users size={18} />
            </span>
            <div className="jamPanel__heading">
              <span className="jamPanel__title">Groove</span>
              <Text tone="muted" size="xs" className="jamPanel__sub">
                Play the same thing at the same time. Whoever starts it sets the
                pace; everyone follows, and anyone can add to the queue.
              </Text>
            </div>
          </div>
          {failed && (
            <Text tone="danger" size="xs">
              This server could not start a groove. It may be running an older build.
            </Text>
          )}
          <div className="jamPanel__actions">
            <Button variant="solid" size="sm" fullWidth disabled={busy} onClick={() => void startJam()}>
              {busy ? 'Starting…' : 'Start a groove'}
            </Button>
          </div>

          {/* Friends already listening together. Reachable here for the same
              reason Start is: this is where you are when you would want it. */}
          {joinable.length > 0 && (
            <>
              <div className="jamPanel__section">
              <span className="jamPanel__label">Live now</span>
              <ul className="jamPanel__who">
                {joinable.map((r) => (
                  <li key={r.id} className="jamPanel__member">
                    <FriendAvatar handle={r.hostName} size="sm" />
                    <span className="jamPanel__memberText">
                      <span className="jamPanel__memberName">{r.hostName}</span>
                      <span className="jamPanel__memberMeta">
                        {r.memberCount > 1 ? `${r.memberCount} inside` : 'alone so far'}
                        {r.trackTitle ? ` · ${r.trackTitle}` : ''}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="jamPanel__join"
                      disabled={busy}
                      onClick={() => void jam.join(r.id)}
                    >
                      Join
                    </Button>
                  </li>
                ))}
              </ul>
              </div>
            </>
          )}
        </div>
      </Popover>
    );
  }

  return (
    <>
    <Popover
      placement="top-end"
      aria-label={
        jam.hosting
          ? `Your groove — ${room.memberCount} listening`
          : `In ${room.hostName}'s groove — ${room.memberCount} listening`
      }
      className="popoverSheet jamPanel"
      trigger={
        <IconButton
          variant="ghost"
          size="sm"
          className="jamTrigger"
          // Hosting reads differently from following: one is your room, the
          // other is somebody else's. Same glyph, different weight.
          data-hosting={jam.hosting || undefined}
          aria-label={
            jam.hosting
              ? `Your groove — ${room.memberCount} listening`
              : `In ${room.hostName}'s groove — ${room.memberCount} listening`
          }
        >
          <Users size={16} />
          {/* The count sits on the glyph rather than beside it, so the row's
              rhythm is unchanged whether or not a groove is on. */}
          {room.memberCount > 1 && (
            <span className="jamTrigger__count" aria-hidden>
              {room.memberCount}
            </span>
          )}
        </IconButton>
      }
    >
      <div className="jamPanel__body">
        <div className="jamPanel__head">
          <span className="jamPanel__glyph" data-live aria-hidden>
            <Users size={18} />
          </span>
          <div className="jamPanel__heading">
            <span className="jamPanel__title">
              {jam.hosting ? 'Your groove' : `${room.hostName}'s groove`}
            </span>
            <Text tone="muted" size="xs" className="jamPanel__sub">
              {room.memberCount === 1
                ? 'Just you so far'
                : `${room.memberCount} listening${others === 1 ? ' — one other' : ''}`}
              {jam.hosting ? ' · you set the pace' : ' · following along'}
              {room.hostQuiet && !jam.hosting ? ' · the host has gone quiet' : ''}
            </Text>
          </div>
        </div>

        {/* What the room is hearing, by name - the one line a member whose
            library lacks the song still gets, instead of silence. */}
        {room.trackTitle && (
          <div className="jamPanel__section">
            <span className="jamPanel__label">{room.playing ? 'Playing' : 'Paused'}</span>
            <span className="jamPanel__now">
              <Music size={14} aria-hidden />
              <span>
                {room.trackTitle}
                {room.trackArtist ? ` · ${room.trackArtist}` : ''}
              </span>
            </span>
          </div>
        )}

        {/* Named, not just counted. "3 listening" tells you the room is busy;
            the names tell you whose evening you are in - and who has been
            here longest, which is who the clock passes to. */}
        {(room.people?.length ?? room.members.length) > 0 && (
          <div className="jamPanel__section">
            <span className="jamPanel__label">In the groove</span>
            <ul className="jamPanel__who">
              {(room.people ?? room.members.map((name, i) => ({ id: i, name, host: name === room.hostName, joinedAt: 0, seenAt: 0 }))).map((p) => (
                <li key={p.id} className="jamPanel__member">
                  {/* One person per row, with their face: the group glyph stays
                      the ROOM's mark and never stands next to a single name. */}
                  <FriendAvatar handle={p.name} size="sm" />
                  <span className="jamPanel__memberText">
                    <span className="jamPanel__memberName">{p.name}</span>
                  </span>
                  {p.host && <span className="jamPanel__host">Host</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Two ways to hand the room over, and they are for different people.

            The CODE is for somebody already standing in the app on this
            server: it is short, and typing it is faster than anything. The
            LINK is for everybody else - it lands on a page that says whose
            room this is and offers the app, which a bare code cannot do.
            Anyone in the room can pass it on; being in it is the permission,
            and the hub still decides who gets through the door. */}
        <div className="jamPanel__pass">
          {jam.hosting && (
            <button
              type="button"
              className="jamLive__code"
              title="Copy the code"
              onClick={() => {
                void navigator.clipboard?.writeText(room.id.toUpperCase()).catch(() => {});
              }}
            >
              Code {room.id.toUpperCase()}
            </button>
          )}
          <Button variant="outline" size="sm" onClick={() => setSharing(true)}>
            <Share2 size={14} />
            Share link
          </Button>
        </div>

        <div className="jamPanel__actions">
          {/* A host has two exits: hand the room on, or close it. Leaving
              used to end it for everyone, which is the one thing a host
              stepping out for a moment never meant. */}
          <Button variant="outline" size="sm" onClick={() => void jam.leave()}>
            {jam.hosting && room.memberCount > 1 ? 'Leave, hand it on' : 'Leave'}
          </Button>
          {jam.hosting && room.memberCount > 1 && (
            <Button variant="ghost" size="sm" onClick={() => void jam.end()}>
              End for everyone
            </Button>
          )}
        </div>
      </div>
    </Popover>
    {/* HOISTED OUT of the popover, and that is the whole point. Tapping Share
        dismisses the panel that carries the button, and a sheet rendered
        inside that panel is unmounted by its own trigger closing - it appears
        and vanishes in the same frame. Rendered as the popover's SIBLING it
        outlives the dismissal, and the state that opens it lives out here
        too. */}
    {sharing && (
      <ShareJamSheet
        jamId={room.id}
        hostName={room.hostName}
        listening={room.memberCount}
        open={sharing}
        onClose={() => setSharing(false)}
      />
    )}
    </>
  );
}
