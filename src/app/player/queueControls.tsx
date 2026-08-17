//! Queue editing from anywhere in the app. Any surface with a track - a table
//! row, a card, a search hit - can drop it into what is playing next without
//! seizing the deck. The queue itself lives in App (the ordered list the player
//! walks); this is just the thin, stable handle onto it.
//!
//! Two verbs, matching how people talk about a queue:
//!   - playNext: jump it to right after the current track.
//!   - addToQueue: put it at the end of the line.
//! With nothing playing, either one just starts it.

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Track } from '../core/tauri.ts';
import { useJamOptional } from './jam.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { addToJamQueue, trackIdFromPath } from '../server.ts';

export interface QueueControls {
  /** Slot the track in immediately after whatever is playing. */
  playNext: (track: Track) => void;
  /** Add the track to the end of the queue. */
  addToQueue: (track: Track) => void;
  /** True when the two verbs land on a shared jam queue rather than only this
   *  device's - so a surface can say "Add to jam" and mean it. */
  inJam: boolean;
}

const QueueControlsContext = createContext<QueueControls | null>(null);

const QueueControlsProvider = QueueControlsContext.Provider;

/**
 * Points the two verbs at the right queue for the moment. On your own deck (or
 * hosting a jam, where your deck IS the room's) they edit locally through the
 * handlers App hands down. Following someone else's jam, your own deck is
 * silent - so an add goes to the ROOM instead, and the host folds it in on its
 * next beat. Local-only files (no server id) cannot cross to the room and are
 * quietly skipped there.
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
  const { session } = useServerSession();
  const jam = useJamOptional();
  const room = jam?.current ?? null;
  const following = room !== null && !jam?.hosting;

  const value = useMemo<QueueControls>(() => {
    if (following && session && room) {
      const toRoom = (track: Track) => {
        const id = trackIdFromPath(track.path);
        if (id == null) return;
        void addToJamQueue(session, room.id, id).catch(() => {});
      };
      return { playNext: toRoom, addToQueue: toRoom, inJam: true };
    }
    return { playNext: localPlayNext, addToQueue: localAddToQueue, inJam: room !== null };
  }, [following, session, room, localPlayNext, localAddToQueue]);

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
    }
  );
}
