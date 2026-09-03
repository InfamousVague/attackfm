import type { Track } from '../core/tauri.ts';
import { RowArt } from './RowArt.tsx';
import { useNowPlayingPath } from '../player/nowPlayingStore.ts';
import { NowPlayingBars } from '../player/NowPlayingBars.tsx';

/**
 * The pressable body of a playlist row: art, title, and - when the row is too
 * narrow for the artist to have a column of its own - the artist folded under
 * the title, AS A LINK.
 *
 * A div with the button role rather than a button, and that is the whole
 * reason this component exists. The artist under the title has to be its own
 * control, so a tap on the name opens the artist and a tap anywhere else
 * plays the song; the phone folds the artist column away, so the name under
 * the title is the only artist the phone ever shows, and a name you cannot tap
 * on a phone is an artist page you cannot reach from a playlist. But a button
 * inside a button is not a thing the browser will honour - it flattens the
 * nesting and the inner one stops being a button - so the row body becomes a
 * div that behaves like one, with Enter and Space doing what a button's would,
 * and the artist inside it is a real button that stops its tap at the edge.
 */
export function RowMain({
  track,
  onPlay,
  onOpenArtist,
}: {
  track: Track;
  onPlay: () => void;
  onOpenArtist?: (artist: string) => void;
}) {
  // Is this the song playing right now? The row lights in the accent and wears
  // the bars when it is - see nowPlayingStore for why this is a path compare.
  const current = useNowPlayingPath() === track.path;
  return (
    <div
      role="button"
      tabIndex={0}
      className="playlistRow__main"
      data-current={current || undefined}
      aria-current={current ? 'true' : undefined}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay();
        }
      }}
    >
      <span className="playlistRow__art">
        <RowArt artwork={track.artwork} />
        {current && (
          <span className="playlistRow__nowPlaying">
            <NowPlayingBars />
          </span>
        )}
      </span>
      <span className="playlistRow__text">
        <span className="songTitle">{track.title}</span>
        {onOpenArtist ? (
          <button
            type="button"
            className="songArtist songArtistLink"
            onClick={(e) => {
              e.stopPropagation();
              onOpenArtist(track.artist);
            }}
          >
            {track.artist}
          </button>
        ) : (
          <span className="songArtist">{track.artist}</span>
        )}
      </span>
    </div>
  );
}
