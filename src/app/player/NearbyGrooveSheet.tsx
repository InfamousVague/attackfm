import { useEffect, useState } from 'react';
import { Drawer, Modal } from '@glacier/react';
import { Music, Users, Wifi } from '@glacier/icons';
import { useMediaQuery } from '../ux/useMediaQuery.ts';
import { fireFelt, fireNativeHaptic } from '../core/haptics.ts';
import { FriendAvatar } from '../profile/RegistryFriends.tsx';
import { MOBILE_PLAYER_QUERY } from './deckShared.ts';
import { useJamOptional } from './jam.tsx';
import { Trans, useT } from '../i18n/LocaleShell.tsx';

/**
 * "Leo started a groove nearby" - the offer to join a room on this network.
 *
 * The owner's words: "when someone starts a groove on the same network I'd
 * like an in-app drawer that pops up asking if you'd like to join XYZ's
 * groove". The hub knows who is on whose network (it compares the addresses
 * it saw them arrive from; the addresses never leave it) and puts those
 * rooms in the feed's `nearby` list; the provider raises ONE of them at a
 * time, once per room per device, never while this listener is in a room
 * and never for a room they host (jam.tsx, `attackfm-groove-nearby-seen`).
 * This renders the one on offer.
 *
 * Hoisted at app level beside the arrival sheet (GrooveHearSheet) and driven
 * by provider state for the same reason: the poll that raises it does not
 * care what page is up, and a sheet mounted inside the deck's popover would
 * live and die with it. Join takes the road every join takes - the listening
 * choice, then the landing (toast, player, deck); Not now puts the room down
 * for good on this device. Putting the sheet down any other way (the scrim,
 * escape) is Not now.
 *
 * A bottom sheet on a phone, a small dialog on a desktop: the host's face
 * with the network mark on it, the song by name when the room has one, how
 * many are listening, and two targets of at least 44px.
 */
export function NearbyGrooveSheet() {
  const t = useT();
  const jam = useJamOptional();
  const phone = useMediaQuery(MOBILE_PLAYER_QUERY);
  const room = jam?.nearbyOffer ?? null;
  const [busy, setBusy] = useState(false);

  // Felt as it arrives, like a landing is: this is the app tapping you on
  // the shoulder, not a page you opened.
  const roomId = room?.id ?? null;
  useEffect(() => {
    if (roomId) fireNativeHaptic('medium');
  }, [roomId]);

  if (!jam || !room) return null;

  const host = room.hostName;
  const count = room.memberCount;
  const walkIn = async () => {
    if (busy) return;
    setBusy(true);
    fireFelt('light');
    try {
      await jam.answerNearby(true);
    } finally {
      setBusy(false);
    }
  };
  const notNow = () => {
    if (busy) return;
    void jam.answerNearby(false);
  };

  const body = (
    <div className="nearSheet" data-room={room.id}>
      <div className="nearSheet__who">
        <span className="nearSheet__face" aria-hidden>
          <FriendAvatar handle={host} size="lg" />
          <span className="nearSheet__wifi">
            <Wifi size={12} />
          </span>
        </span>
        <span className="nearSheet__text">
          <span className="nearSheet__line">{t('player.grooveNearbyLine', { host })}</span>
          {room.trackTitle && (
            <span className="nearSheet__song">
              <Music size={12} aria-hidden />
              <span>
                {room.trackTitle}
                {room.trackArtist ? ` — ${room.trackArtist}` : ''}
              </span>
            </span>
          )}
          {/* One entry, dot and all: "two listening, on this network" is a
              single fact in most languages and they do not all put the two
              halves in this order. The separator rides in the string as a
              component so it keeps its own styling. */}
          <span className="nearSheet__meta">
            <Users size={12} aria-hidden />
            <Trans
              i18nKey="player.grooveNearbyMeta"
              count={count}
              components={{ dot: <span className="nearSheet__dot" aria-hidden /> }}
            />
          </span>
        </span>
      </div>
      <div className="jamActions nearSheet__actions">
        <button
          type="button"
          className="jamAction jamAction--yes"
          disabled={busy}
          onClick={() => void walkIn()}
          autoFocus
        >
          <Users size={16} aria-hidden />
          {t('player.joinHostGroove', { host })}
        </button>
        <button type="button" className="jamAction" disabled={busy} onClick={notNow}>
          {t('player.notNow')}
        </button>
      </div>
    </div>
  );

  const title = t('player.grooveNearby');
  return phone ? (
    <Drawer open onClose={notNow} side="bottom" size="sm" title={title} className="nearDrawer">
      {body}
    </Drawer>
  ) : (
    <Modal open onClose={notNow} title={title} size="sm">
      {body}
    </Modal>
  );
}
