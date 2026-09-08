//! Queue editing from anywhere in the app. Any surface with a track - a table
//! row, a card, a search hit - can drop it into what is playing next without
//! seizing the deck. The queue itself lives in App (the ordered list the player
//! walks); this is just the thin, stable handle onto it.
//!
//! Two verbs, matching how people talk about a queue:
//!   - playNext: jump it to right after the current track.
//!   - addToQueue: put it at the end of the line.
//! With nothing playing, either one just starts it.
//!
//! Following a groove both verbs land on the ROOM instead of this deck - the
//! host's line is the groove's queue - and keep their meaning: playNext asks
//! for right after the song on, addToQueue for the end of the line. Surfaces
//! read `following` to say "the groove" instead of "the queue".

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Track } from '../core/tauri.ts';
import { trackIdFromPath } from '../server.ts';
import { useJamOptional } from './jam.tsx';
import { useConnect } from './playbackSync.tsx';

export interface QueueControls {
  /** Slot the track in immediately after whatever is playing. */
  playNext: (track: Track) => void;
  /** Add the track to the end of the queue. */
  addToQueue: (track: Track) => void;
  /** True when in a groove at all - hosting or following. */
  inJam: boolean;
  /** True when the two verbs land on the ROOM rather than this device: in a
   *  groove, not hosting. A surface then offers "Play next in the groove" /
   *  "Add to the groove" and says "sent ... to the groove" when it lands.
   *  A batch sent "next" goes in ASK order there (the host keeps it; the
   *  first asked plays first) - the reverse of the local trick, where each
   *  playNext slots in front of the last. */
  following: boolean;
  /** Who sets the pace, while in a groove ('' outside one) - a string, not
   *  the room, so the value only changes on a hand-off. */
  hostName: string;
}

const QueueControlsContext = createContext<QueueControls | null>(null);

const QueueControlsProvider = QueueControlsContext.Provider;

/**
 * Points the two verbs at the right queue for the moment. On your own deck (or
 * hosting a groove, where your deck IS the room's) they edit locally through
 * the handlers App hands down. Following someone else's groove, your own deck
 * is silent - so an add goes to the ROOM instead (jam.tsx's addToRoom, which
 * shows it as pending at once), and the host folds it in on its next beat -
 * right after the song on for playNext, the end of the line for addToQueue.
 * Local-only files (no server id) cannot cross to the room and are quietly
 * skipped there.
 */
export function QueueControlsBridge({
  localPlayNext,
  localAddToQueue,
  children,
}: {
  localPlayNext: (track: Track) => void;
  localAddToQueue: (track: Track) => void;
  children: ReactNode;
}) {
  const connect = useConnect();
  const jam = useJamOptional();
  /*
   * WATCHING ANOTHER DEVICE PLAY.
   *
   * The local verbs open with "nothing is playing here, so just play it" - and
   * on a device that is mirroring, `current` is null by design (PlayerHost:
   * `mirroring = current === null && remoteTrack !== null`). So adding a song
   * to the queue from a phone while the desktop played fell straight into that
   * shortcut: the phone started the song, and the report that followed claimed
   * the seat and stopped the desktop. Reported as "it started playing right
   * away", and it was nothing to do with the menu that raised it.
   *
   * So the ask travels instead, exactly as it does for a groove: the song
   * lands on the deck that is actually playing, and nothing here starts.
   */
  const watching =
    connect.connected &&
    connect.activeDeviceId !== null &&
    connect.activeDeviceId !== connect.thisDeviceId;
  // Booleans, not the room itself: the room is a fresh object every poll,
  // and this value rides into the menu on every row of the song table.
  const inRoom = (jam?.current ?? null) !== null;
  const following = inRoom && !jam?.hosting;
  const addToRoom = jam?.addToRoom;
  const hostName = jam?.current?.hostName ?? '';

  const value = useMemo<QueueControls>(() => {
    // A groove is the stronger claim: inside one, the room's queue is the
    // queue, whichever device happens to hold the Connect seat.
    if (!following && watching) {
      const send = (track: Track, next: boolean) => {
        const id = trackIdFromPath(track.path);
        // A local-only file has no id the other device could resolve, so it
        // cannot cross - the same rule the room path already keeps.
        if (id === null) return;
        connect.sendCommand({ action: next ? 'enqueueNext' : 'enqueueEnd', queue: [id] });
      };
      return {
        playNext: (track: Track) => send(track, true),
        addToQueue: (track: Track) => send(track, false),
        inJam: inRoom,
        following: false,
        hostName: inRoom ? hostName : '',
      };
    }
    if (following && addToRoom) {
      return {
        playNext: (track: Track) => {
          void addToRoom(track, { next: true });
        },
        addToQueue: (track: Track) => {
          void addToRoom(track);
        },
        inJam: true,
        following: true,
        hostName,
      };
    }
    return {
      playNext: localPlayNext,
      addToQueue: localAddToQueue,
      inJam: inRoom,
      following: false,
      hostName: inRoom ? hostName : '',
    };
  }, [following, addToRoom, inRoom, hostName, localPlayNext, localAddToQueue, watching, connect]);

  return <QueueControlsProvider value={value}>{children}</QueueControlsProvider>;
}

/**
 * The queue handle. Safe anywhere; outside the provider it is inert (the
 * surface's control can still render, it just does nothing), so a component
 * never has to know whether a deck is mounted above it.
 */
export function useQueueControls(): QueueControls {
  return (
    useContext(QueueControlsContext) ?? {
      playNext: () => {},
      addToQueue: () => {},
      inJam: false,
      following: false,
      hostName: '',
    }
  );
}
