import { useState } from 'react';
import { IconButton } from '@glacier/react';
import { Mic } from '@glacier/icons';
import { useNowPlayingMotion } from '@attackfm/app/nowPlaying';
import { KaraokeStage } from './KaraokeStage.tsx';

/**
 * Karaoke, from the song you are already listening to.
 *
 * This used to be a destination: a page in the More menu with its own search,
 * where you found a song a second time in order to sing it. That is the wrong
 * shape for something that only ever applies to one particular song - you are
 * already listening to it, and the app already knows which one.
 *
 * So it lives on the Now Playing screen instead, beside the queue and the
 * equaliser, and acts on whatever is playing. No search, no second library, no
 * menu of places to go.
 */
export function KaraokeButton() {
  const { track } = useNowPlayingMotion();
  const [open, setOpen] = useState(false);

  // Nothing playing means nothing to sing. The button hides rather than sitting
  // there disabled: this row is short, and a control that can never be pressed
  // is worse than a gap.
  const playable = track && track.path;
  if (!playable) return null;

  return (
    <>
      <IconButton variant="ghost" aria-label="Karaoke" onClick={() => setOpen(true)}>
        <Mic size={20} />
      </IconButton>
      {open && <KaraokeStage track={track} onClose={() => setOpen(false)} />}
    </>
  );
}
