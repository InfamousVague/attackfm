import { Drawer, Modal } from '@glacier/react';
import { Smartphone, Speaker, Users } from '@glacier/icons';
import { useMediaQuery } from '../ux/useMediaQuery.ts';
import { fireFelt } from '../core/haptics.ts';
import { MOBILE_PLAYER_QUERY, type HearMode } from './deckShared.ts';
import { useJamOptional } from './jam.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

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
  const t = useT();
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
        {t('player.hearJoining', { host: room.hostName })}
      </p>
      <div className="hearSheet__options" role="group" aria-label={t('player.hearWhere')}>
        <button
          type="button"
          className="hearCard"
          aria-label={t('player.hearDeviceAria')}
          onClick={() => pick('device')}
          autoFocus
        >
          <span className="hearCard__disc" aria-hidden>
            <Smartphone size={24} />
          </span>
          <span className="hearCard__text">
            <span className="hearCard__name">{t('player.onThisDevice')}</span>
            <span className="hearCard__sub">{t('player.hearDeviceSub')}</span>
          </span>
        </button>
        <button
          type="button"
          className="hearCard"
          aria-label={t('player.hearSpeakerAria', { host: room.hostName })}
          onClick={() => pick('speaker')}
        >
          <span className="hearCard__disc" aria-hidden>
            <Speaker size={24} />
          </span>
          <span className="hearCard__text">
            <span className="hearCard__name">{t('player.onHostSpeaker', { host: room.hostName })}</span>
            <span className="hearCard__sub">{t('player.hearSpeakerSub')}</span>
          </span>
        </button>
      </div>
    </div>
  );

  const title = t('player.hearTitle');
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
