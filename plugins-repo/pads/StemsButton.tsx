import { useState } from 'react';
import { IconButton } from '@glacier/react';
import { SlidersVertical } from '@glacier/icons';
import { useNowPlayingMotion } from '@attackfm/app/nowPlaying';
import { trackId } from './openSong.ts';
import { StemsPanel } from './StemsPanel.tsx';

/**
 * Stems, on the screen where the song already is.
 *
 * The board is where you go to play a song apart; this is for the far more
 * common thing, which is being halfway through something and wanting the vocal
 * out of it. It sits beside the queue and the equaliser and acts on whatever is
 * playing, so there is no second search and no second library.
 */
export function StemsButton() {
  const { track, position } = useNowPlayingMotion();
  const [open, setOpen] = useState(false);

  // Only songs on a server can be separated; a local file has no id to ask
  // about. The button hides rather than sitting there disabled - this row is
  // short, and a control that can never be pressed is worse than a gap.
  if (!track || trackId(track.path) === null) return null;

  return (
    <>
      <IconButton
        variant="ghost"
        aria-label="Stems"
        onClick={() => {
          // Handed over through the window because the panel mounts a frame
          // later, by which time the deck has been paused and the position it
          // reached is gone.
          window.__attackfmStemsAt = position;
          setOpen(true);
        }}
      >
        <SlidersVertical size={20} />
      </IconButton>
      {open && <StemsPanel track={track} onClose={() => setOpen(false)} />}
    </>
  );
}
