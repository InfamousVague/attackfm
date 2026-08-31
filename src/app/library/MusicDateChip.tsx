import { type CSSProperties } from 'react';
import dateChip from '../../assets/chip-music-date.webp';
import { Button } from '@glacier/react';
import { useMyAuditions } from './myAuditions.ts';
import { useEffect, useState } from 'react';
import { fetchDateCandidates } from '../api/curator.ts';
import { LibChipMosaic, LibChipStat } from './LibChipFace.tsx';
import { musicDateDoorOpen, openMusicDate } from '../nav/musicDateDoor.ts';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * Music Date, as a door in the library's own row of doors.
 *
 * It was a full-width banner above the chips, which put the least certain
 * thing on the page above the four surest ones. As a chip it reads as what it
 * is: another way into the library, sitting beside Liked and All songs.
 *
 * The face is the deck itself. Every other chip wears the sleeves of what it
 * holds, and this one holds auditions, so the mosaic is drawn from the cards
 * actually waiting - which also means the chip is honest about being empty
 * when there is nothing to meet.
 */
export function MusicDateChip() {
  const { session } = useServerSession();
  const { mine } = useMyAuditions();
  // The pool's preview dates count too, or this chip promises six while the
  // deck deals hundreds - the mismatch got reported within a day.
  const [poolCount, setPoolCount] = useState(0);
  useEffect(() => {
    if (!session) return;
    let live = true;
    void fetchDateCandidates(session, 1)
      .then(({ total }) => {
        if (live) setPoolCount(total);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [session]);

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
