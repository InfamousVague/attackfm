import { type CSSProperties } from 'react';
import { Button } from '@glacier/react';
import { useLibrary } from './library.tsx';
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
  const { forYou } = useLibrary();

  // Nothing to open, so nothing to show. Same rule the banner had: a door onto
  // an empty room is worse than no door.
  if (!session || !musicDateDoorOpen()) return null;

  const covers = forYou.map((t) => t.artwork).filter((a): a is string => !!a);
  const waiting = forYou.length;

  return (
    <Button
      type="button"
      variant="gradient"
      className="libChip libChip--date"
      // Rose into coral. Liked is already the pink one (338 into 300, which
      // runs toward magenta); this leans the other way, toward warm, so the
      // two are not mistaken for each other at a glance.
      style={{ '--libChipHue': 352, '--libChipHue2': 18 } as CSSProperties}
      onClick={openMusicDate}
      aria-label="Open Music Date"
    >
      {/* The artwork slot the other chips fill with a painted face is
          deliberately empty until one is drawn for this card: a missing import
          fails the build, and a stretched placeholder looks worse than the
          gradient does on its own. Add it as
          `<img className="libChip__art" src={dateChip} alt="" loading="lazy" />`
          once src/assets/chip-music-date.webp exists. */}
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
