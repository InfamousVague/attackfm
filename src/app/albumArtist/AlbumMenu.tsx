import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { MenuStop } from '../ux/MenuStop.tsx';
import { ContextMenu, MenuItem, useToast } from '@glacier/react';
import { ListEnd, ListStart, Play, Shuffle, User, Users } from '@glacier/icons';
import type { ReactNode } from 'react';
import { fireNativeHaptic } from '../core/haptics.ts';
import { useQueueControls } from '../player/queueControls.tsx';
import { useJamOptional } from '../player/jam.tsx';
import { shuffled } from '../ux/shuffle.ts';
import { useT } from '../i18n/LocaleShell.tsx';
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
  const { playNext, addToQueue, following } = useQueueControls();
  const inJam = !!useJamOptional()?.current;
  const { toast } = useToast();
  const t = useT();
  /*
   * The same hold TrackMenu carries, for the same two reasons: the kit only
   * answers a touch long-press and does nothing about the release - so on a
   * phone the click that follows the hold fired the card underneath, and the
   * album page opened on top of the menu the hold had just summoned. And a
   * mouse held down should open it too. This was the one menu of the pair
   * without the wiring; every album card, search album row and discography
   * tile inherits the fix from here.
   */
  const hold = useHoldToMenu((_from, root) => root);
  const first = tracks[0];
  if (!first) return <>{children}</>;

  const shuffle = () => {
    const order = shuffled(tracks);
    onPlay(order[0]!, order);
  };
  /** The whole record into the line, front of it or back, and a sentence
   *  for it - the same one the selection bar says for a batch, since a
   *  menu that closes on a silent verb reads as a verb that did nothing. */
  const queued = (next: boolean) => {
    if (next) {
      // Reversed so the record lands in running order: each local playNext
      // slots in front of the last. A groove keeps ask order, so there the
      // record is sent front to back.
      for (const track of following ? tracks : [...tracks].reverse()) playNext(track);
    } else {
      for (const track of tracks) addToQueue(track);
    }
    fireNativeHaptic('light');
    /*
     * Six whole sentences rather than a count glued to a phrase. The count and
     * the verb are one clause - a language that inflects the verb for number,
     * or puts it before the count, cannot be served by assembling the two - so
     * the state picks the KEY and the plural picks the form inside it.
     *
     * These are the SELECTION BAR'S six keys, not a second set of the same
     * sentences: this menu queues a record where the bar queues a batch, and
     * both say the identical thing. Two key sets would be the one sentence
     * translated twice, free to drift apart in seven languages at once.
     */
    const said = (key: string) => t(key, { count: tracks.length });
    toast({
      message: following
        ? next
          ? said('library.selectionSentNextGroove')
          : said('library.selectionSentGroove')
        : inJam
          ? next
            ? said('library.selectionPlayingNextGroove')
            : said('library.selectionAddedGroove')
          : next
            ? said('library.selectionPlayingNext')
            : said('library.selectionAddedQueue'),
    });
  };

  return (
    <ContextMenu
      {...hold}
      aria-label={t('library.albumActions', { name: first.album || first.title })}
      className={className}
      content={
        <MenuStop>
          <MenuItem icon={<Play size={15} />} onSelect={() => onPlay(first, tracks)}>
            {t('player.play')}
          </MenuItem>
          <MenuItem icon={<Shuffle size={15} />} onSelect={shuffle}>
            {t('player.shuffle')}
          </MenuItem>
          {/* The whole record into the line, in order - front of it or back.
              In a groove, hosting or following, the line is the groove's. */}
          <MenuItem icon={<ListStart size={15} />} onSelect={() => queued(true)}>
            {inJam ? t('player.playNextGroove') : t('player.playNext')}
          </MenuItem>
          <MenuItem icon={following ? <Users size={15} /> : <ListEnd size={15} />} onSelect={() => queued(false)}>
            {following ? t('player.addToGroove') : inJam ? t('player.addToGrooveQueue') : t('player.addToQueue')}
          </MenuItem>
          {onOpenArtist && artistName && (
            <MenuItem icon={<User size={15} />} onSelect={() => onOpenArtist(artistName)}>
              {t('library.goToArtist')}
            </MenuItem>
          )}
        </MenuStop>
      }
    >
      {children}
    </ContextMenu>
  );
}
