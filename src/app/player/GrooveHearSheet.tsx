import { Drawer, Modal } from '@glacier/react';
import { Smartphone, Speaker, Users } from '@glacier/icons';
import { useMediaQuery } from '../ux/useMediaQuery.ts';
import { fireFelt } from '../core/haptics.ts';
import { MOBILE_PLAYER_QUERY, type HearMode } from './deckShared.ts';
import { useJamOptional } from './jam.tsx';

/**
 * "Where should the music play?" - a follower's first moment in a room.
 *
 * Two installs of the app on one phone trade the system's audio focus: a
 * follower whose deck plays the song pauses the host's, whose next beat
 * pauses the follower's, and so on around. The follower has to be able to
 * say "not here - on their speaker", and the moment to say it is on
 * arrival, before the landing says where they are. Once per room: the
 * provider remembers the answer (jam.tsx, `attackfm-groove-hear`) and never
 * asks about that room again; the deck's own "Hearing it on" card is where
 * it is changed later. A host is never asked.
 *
 * Hoisted at app level the way the groove link's card is (JamLinkBridge),
 * and driven by provider state: the join that raises this can come from a
 * link, a profile row, the bell or the deck itself, and a sheet mounted in
 * any one of those would live and die with its trigger. The provider holds
 * the room waiting on its answer; this renders it. Putting the sheet down
 * without choosing is today's behaviour - the song plays here - and lands
 * the room all the same.
 *
 * A bottom sheet on a phone, a small dialog on a desktop: same words, same
 * two cards, and every target at least 44px.
 */
export function GrooveHearSheet() {
  const jam = useJamOptional();
  const phone = useMediaQuery(MOBILE_PLAYER_QUERY);
  const room = jam?.choosing ?? null;
  if (!jam || !room) return null;

  const pick = (mode: HearMode) => {
    fireFelt('light');
    jam.choose(mode);
  };
  const dismiss = () => jam.choose(null);

  const body = (
    <div className="hearSheet">
      <p className="hearSheet__lead">
        <Users size={14} aria-hidden />
        You&rsquo;re joining {room.hostName}&rsquo;s groove. Pick where it plays - you can change
        this in the groove deck any time.
      </p>
      <div className="hearSheet__options" role="group" aria-label="Where the music plays">
        <button
          type="button"
          className="hearCard"
          aria-label="On this device. Plays here, in time with the room."
          onClick={() => pick('device')}
          autoFocus
        >
          <span className="hearCard__disc" aria-hidden>
            <Smartphone size={24} />
          </span>
          <span className="hearCard__text">
            <span className="hearCard__name">On this device</span>
            <span className="hearCard__sub">Plays here, in time with the room</span>
          </span>
        </button>
        <button
          type="button"
          className="hearCard"
          aria-label={`On ${room.hostName}'s speaker. This phone stays quiet and shows what's on; your controls steer the room.`}
          onClick={() => pick('speaker')}
        >
          <span className="hearCard__disc" aria-hidden>
            <Speaker size={24} />
          </span>
          <span className="hearCard__text">
            <span className="hearCard__name">On {room.hostName}&rsquo;s speaker</span>
            <span className="hearCard__sub">
              This phone stays quiet and shows what&rsquo;s on. Your controls steer the room.
            </span>
          </span>
        </button>
      </div>
    </div>
  );

  const title = 'Where should the music play?';
  return phone ? (
    <Drawer open onClose={dismiss} side="bottom" size="md" title={title} className="hearDrawer">
      {body}
    </Drawer>
  ) : (
    <Modal open onClose={dismiss} title={title} size="sm">
      {body}
    </Modal>
  );
}
