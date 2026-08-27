import { useEffect, useState } from 'react';
import { Button } from '@glacier/react';
import { CalendarHeart, ChevronRight } from '@glacier/icons';
import { fetchCollectorStatus } from '../server.ts';
import { musicDateDoorOpen, openMusicDate } from '../nav/musicDateDoor.ts';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * The way into Music Date.
 *
 * It lived inside DiscoverPage, which made it unreachable the moment Discover
 * stopped being a place - so it moved here rather than being deleted with the
 * page around it. Library is the better home anyway: the deck is auditions the
 * collector fetched FOR YOU, which is a fact about your library and not about
 * somebody else's charts.
 *
 * Renders nothing at all when there is no server or the door is shut. A card
 * that opens onto an empty deck is worse than no card, and `musicDateDoorOpen`
 * is the one thing that knows whether the collector is even running.
 */
export function MusicDateInvite() {
  const { session } = useServerSession();
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    if (!session) {
      setWaiting(0);
      return;
    }
    const ctrl = new AbortController();
    void fetchCollectorStatus(session, ctrl.signal)
      .then((st) => setWaiting(st?.recent?.filter((r) => r.state === 'landed').length ?? 0))
      .catch(() => {});
    return () => ctrl.abort();
  }, [session]);

  if (!session || !musicDateDoorOpen()) return null;

  return (
    <Button type="button" variant="glass" fullWidth className="boothDate" onClick={openMusicDate}>
      <span className="boothDate__mark" aria-hidden="true">
        <CalendarHeart size={18} />
      </span>
      <span className="boothDate__text">
        <span className="boothDate__title">Music Date</span>
        <span className="boothDate__caption">
          {waiting > 0
            ? `${waiting} new ${waiting === 1 ? 'find' : 'finds'} waiting — art and sound, no names`
            : 'Meet what the collector found — art and sound, no names'}
        </span>
      </span>
      <ChevronRight size={18} className="boothDate__chevron" aria-hidden="true" />
    </Button>
  );
}
