import { type CSSProperties } from 'react';
import dateChip from '../../assets/chip-music-date.webp';
import { Button } from '@glacier/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Track } from '../core/tauri.ts';
import { fetchDateCandidates } from '../api/curator.ts';
import { dateActivityVersion, subscribeDateActivity } from '../date/dateActivity.ts';
import { LibChipMosaic, LibChipStat } from './LibChipFace.tsx';
import { musicDateDoorOpen, openMusicDate } from '../nav/musicDateDoor.ts';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * Music Date, as a door: the card with the big number.
 *
 * It sat beside All songs in a row of chips at the top of Discover; the
 * art-first rework folded it into a pill in the hero's action row and a
 * card on the People shelf, and the owner's verdict was "too hidden now".
 * So it is back near the top, full width, under the hero - the one door
 * on the page that opens onto something new, wearing its number where the
 * eye lands first.
 *
 * The face is the deck itself. Every other chip wears the sleeves of what it
 * holds, and this one holds auditions, so the mosaic is drawn from the cards
 * actually waiting - which also means the chip is honest about being empty
 * when there is nothing to meet.
 */
export function MusicDateChip({ mine }: {
  /** This listener's own unadopted auditions - from whoever already holds
   *  them (Discover's feed provider), so the page asks the collector once. */
  mine: Track[];
}) {
  const { session } = useServerSession();
  // The pool's preview dates count too, or this chip promises six while the
  // deck deals hundreds - the mismatch got reported within a day.
  const [poolCount, setPoolCount] = useState(0);
  // Re-read the pool total whenever a date is judged. Owned auditions already
  // move in real time (the passed ledger drives `mine`), but the preview pool
  // is the server's number, and a preview verdict changes it there with
  // nothing local to subtract - so we just re-ask. `activity` bumps once per
  // swipe; a trailing debounce means a fast run of verdicts costs one fetch on
  // the way out, not one per card.
  const activity = useSyncExternalStore(subscribeDateActivity, dateActivityVersion, dateActivityVersion);
  useEffect(() => {
    if (!session) return;
    let live = true;
    const run = () =>
      void fetchDateCandidates(session, 1)
        .then(({ total }) => {
          if (live) setPoolCount(total);
        })
        .catch(() => {});
    // First read is immediate (chip just mounted); a read prompted by activity
    // waits a beat so a burst of swipes settles into one request.
    const t = activity === 0 ? (run(), 0) : window.setTimeout(run, 500);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [session, activity]);

  // Nothing to open, so nothing to show. Same rule the banner had: a door onto
  // an empty room is worse than no door.
  if (!session || !musicDateDoorOpen()) return null;

  // `mine`, never the whole `forYou` array: this chip showed 767 while the
  // shelf below it showed 220, because one filtered by owner and the other
  // counted every audition the client had ever been sent.
  const covers = mine.map((t) => t.artwork).filter((a): a is string => !!a);
  const waiting = mine.length + poolCount;

  return (
    <Button
      type="button"
      variant="gradient"
      className="libChip libChip--date"
      // Rose into coral. Liked is already the pink one (338 into 300, which
      // runs toward magenta); this leans the other way, toward warm, so the
      // two are not mistaken for each other at a glance.
      style={{ '--libChipHue': 352, '--libChipHue2': 18, '--art': `url("${dateChip}")` } as CSSProperties}
      onClick={openMusicDate}
      aria-label="Open Music Date"
    >
      <img className="libChip__art" src={dateChip} alt="" loading="lazy" />
      <LibChipMosaic covers={covers} />
      <LibChipStat value={waiting > 0 ? String(waiting) : undefined} />
      <span className="libChip__name">Music Date</span>
      <span className="libChip__count">
        {waiting > 0
          ? `${waiting} waiting, art and sound, no names`
          : 'Meet what the collector found'}
      </span>
    </Button>
  );
}
