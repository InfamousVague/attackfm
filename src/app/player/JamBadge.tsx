import { Button, IconButton, Popover, Text } from '@glacier/react';
import { User, Users } from '@glacier/icons';
import { useJamOptional } from './jam.tsx';

/**
 * Who else is hearing this, on the screen where you are hearing it.
 *
 * A jam was visible in exactly one place - the Live now shelf on your profile -
 * which is the page you are NOT on while a jam is happening. So the room existed
 * and the listening happened somewhere else, and the only way to check who was
 * in it, or to get out, was to leave the music and go and find the card.
 *
 * This is the same shape as DevicePicker beside it, deliberately: both answer
 * "where is this going" from the transport row, both are a glyph that carries
 * its state, and both open a small panel rather than navigating away. A jam and
 * a hand-off are the same kind of question asked about different things.
 *
 * THE GLYPH IS THE POINT. A jam has no artwork of its own - what is on the
 * screen belongs to the song, not to the room - so the room needs a mark that
 * says "several people" at a glance. `Users` is that mark, and it is the one
 * this feature wears everywhere now, so the badge here and the card on the
 * profile are recognisably the same thing.
 */
export function JamBadge() {
  const jam = useJamOptional();
  // No provider (a build without jams), or not in a room. Nothing to say.
  if (!jam?.current) return null;

  const room = jam.current;
  const others = Math.max(0, room.memberCount - 1);

  return (
    <Popover
      placement="top-end"
      aria-label={
        jam.hosting
          ? `Your jam — ${room.memberCount} listening`
          : `In ${room.hostName}'s jam — ${room.memberCount} listening`
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
              ? `Your jam — ${room.memberCount} listening`
              : `In ${room.hostName}'s jam — ${room.memberCount} listening`
          }
        >
          <Users size={16} />
          {/* The count sits on the glyph rather than beside it, so the row's
              rhythm is unchanged whether or not a jam is on. */}
          {room.memberCount > 1 && (
            <span className="jamTrigger__count" aria-hidden>
              {room.memberCount}
            </span>
          )}
        </IconButton>
      }
    >
      <div className="jamPanel__body">
        <span className="jamPanel__title">
          {jam.hosting ? 'Your jam' : `${room.hostName}'s jam`}
        </span>
        <Text tone="muted" size="xs">
          {room.memberCount === 1
            ? 'Just you so far'
            : `${room.memberCount} listening${others === 1 ? ' — one other' : ''}`}
          {jam.hosting ? ' · you set the pace' : ' · following along'}
        </Text>

        {/* Named, not just counted. "3 listening" tells you the room is busy;
            the names tell you whose evening you are in. */}
        {room.members.length > 0 && (
          <ul className="jamPanel__who">
            {room.members.map((name) => (
              <li key={name} className="jamPanel__member">
                {/* One person per row, so the group glyph stays the ROOM's mark
                    and never stands next to a single name. */}
                <User size={13} aria-hidden />
                <span>{name}</span>
                {name === room.hostName && <span className="jamPanel__host">host</span>}
              </li>
            ))}
          </ul>
        )}

        {/* The code IS the invitation, and it is wanted at the moment somebody
            asks - which is here, mid-song, not on a settings page. Same
            clipboard write as the profile card. */}
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

        <div className="jamPanel__actions">
          <Button variant="ghost" size="sm" onClick={() => void jam.leave()}>
            {jam.hosting ? 'End the jam' : 'Leave'}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
