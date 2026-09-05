import { useEffect } from 'react';
import { useToast } from '@glacier/react';
import { fireNativeHaptic } from '../core/haptics.ts';
import { trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';
import { useJamOptional } from './jam.tsx';

/**
 * A follower's tap ADDS.
 *
 * In a groove you are not hosting, your deck is silent - it steers to the
 * host's clock - so "play this" has no local meaning, and the tap that used to
 * start a song here started one over the top of the room and then got yanked
 * back by the next beat. What a guest means by tapping a song is "put this on
 * for everyone", which is the add.
 *
 * ONE seam, not one per surface: every surface that starts playback reaches
 * App's `playFrom`, which already asks a ref whether AttackFM Connect wants
 * the pick (ConnectPlayRouter). This is the same shape, asked first - a
 * person in a groove tapping a song means the groove, whichever of their own
 * devices holds audio. Renders nothing; lives inside the groove provider
 * because only a child of it can read the room.
 *
 * Now Playing's own controls (the queue panel's rows, skip) do not come
 * through here - they call the deck directly - so explicit local playback
 * stays possible from the one place it is clearly meant.
 */
export function GroovePlayRouter({
  routeRef,
}: {
  routeRef: { current: ((track: Track, context?: Track[]) => boolean) | null };
}) {
  const jam = useJamOptional();
  const { toast } = useToast();
  const room = jam?.current ?? null;
  const following = room !== null && !jam?.hosting;
  const hostName = room?.hostName ?? '';
  const addToRoom = jam?.addToRoom;

  useEffect(() => {
    if (!following || !addToRoom) {
      routeRef.current = null;
      return;
    }
    routeRef.current = (track) => {
      // A song only on this device cannot cross to the room, and playing it
      // here would fight the follow. Said, and swallowed.
      if (trackIdFromPath(track.path) == null) {
        toast({ message: `“${track.title}” is only on this device, so it can’t go to the groove` });
        return true;
      }
      fireNativeHaptic('light');
      toast({ message: `Sent to the groove - ${hostName} plays it next` });
      void addToRoom(track);
      return true;
    };
    return () => {
      routeRef.current = null;
    };
  }, [following, addToRoom, hostName, toast, routeRef]);

  return null;
}
