import { ContextMenu, MenuItem } from '@glacier/react';
import { ListEnd, ListStart, Play, Shuffle, User } from '@glacier/icons';
import type { ReactNode } from 'react';
import { useQueueControls } from '../player/queueControls.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * The long-press menu an ALBUM'S art carries, everywhere album art appears.
 *
 * One rule across the app: art answers a hold with a menu of what the thing
 * under it can do. Songs have carried TrackMenu for a while; album cards
 * either had nothing (the artist page's records) or, worse, a song's menu
 * wearing an album's face - "Play next" on a record cover that queued one
 * track. This is the record's own set of verbs, and every card shares it.
 *
 * "Open" is deliberately absent: the tap already opens, and a menu that
 * repeats the tap teaches people the menu is where taps live.
 */
export function AlbumMenu({
  tracks,
  onPlay,
  onOpenArtist,
  artistName,
  className,
  children,
}: {
  /** The record's songs, in running order - the queue every verb builds. */
  tracks: Track[];
  onPlay: (track: Track, queue: Track[]) => void;
  /** The credit as a door, offered only where the page is not already theirs. */
  onOpenArtist?: (artist: string) => void;
  artistName?: string;
  className?: string;
  children: ReactNode;
}) {
  const { playNext, addToQueue, inJam } = useQueueControls();
  const first = tracks[0];
  if (!first) return <>{children}</>;

  const shuffle = () => {
    const shuffled = [...tracks];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    onPlay(shuffled[0]!, shuffled);
  };

  return (
    <ContextMenu
      aria-label={`${first.album || first.title} actions`}
      className={className}
      content={
        <>
          <MenuItem icon={<Play size={15} />} onSelect={() => onPlay(first, tracks)}>
            Play
          </MenuItem>
          <MenuItem icon={<Shuffle size={15} />} onSelect={shuffle}>
            Shuffle
          </MenuItem>
          {/* The whole record into the line, in order - front of it or back. */}
          <MenuItem
            icon={<ListStart size={15} />}
            onSelect={() => {
              // Reversed so the record lands in running order: each playNext
              // slots in front of the last.
              for (const track of [...tracks].reverse()) playNext(track);
            }}
          >
            Play next
          </MenuItem>
          <MenuItem
            icon={<ListEnd size={15} />}
            onSelect={() => {
              for (const track of tracks) addToQueue(track);
            }}
          >
            {inJam ? 'Add to jam queue' : 'Add to queue'}
          </MenuItem>
          {onOpenArtist && artistName && (
            <MenuItem icon={<User size={15} />} onSelect={() => onOpenArtist(artistName)}>
              Go to artist
            </MenuItem>
          )}
        </>
      }
    >
      {children}
    </ContextMenu>
  );
}
