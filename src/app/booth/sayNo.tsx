import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ContextMenu, IconButton, MenuItem, MenuLabel, useToast } from '@glacier/react';
import { Ban, ThumbsDown, ThumbsUp, UserX } from '@glacier/icons';
import { fireNativeHaptic } from '../core/haptics.ts';
import { MenuStop } from '../ux/MenuStop.tsx';
import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { reactDj, type DjReaction } from '../api/dj.ts';
import { trackIdFromPath } from '../api/library.ts';
import { artistKey, noteNo, trackKey } from './saidNo.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Saying no, every way the listener asked for it.
 *
 * Three surfaces share one verb: thumbs beside a song the machine chose
 * while it plays, a hold on a dealt row that opens "why this?" and the two
 * refusals, and the Date deck's pass with "less like this" on it. They all
 * come through here so a no means the same thing wherever it is said - the
 * card leaves at once, a toast confirms it, the sitting's ledger keeps it
 * from coming straight back, and the hub is told with the deck position.
 *
 * The order is deliberate: LOCAL FIRST. The ledger is written and the row
 * removed before the request is even built, and the request's failure is
 * swallowed. A hub from before this endpoint, or a moment offline, must not
 * turn a refusal into an error strip - the listener said no, the screen
 * agreed, and whether the hub remembers is a second, quieter question.
 *
 * An up is a toast and a record. It is NOT a heart: hearts stay explicit,
 * and nothing here touches favourites.
 */

/** Saying "less of that" on the same song twice is one opinion; a minute
 *  later on another song is a new one. The thumbs remember per song. */
export function useSayNo() {
  const { session } = useServerSession();
  const { toast } = useToast();

  const down = useCallback(
    (
      track: Track,
      opts: { scope?: 'artist'; positionMs?: number; onLeave?: () => void } = {},
    ) => {
      const id = trackIdFromPath(track.path);
      fireNativeHaptic('medium');
      // Heard, before anything else: the ledger, the card, the toast.
      if (opts.scope === 'artist' && track.artist.trim()) noteNo(artistKey(track.artist));
      if (id !== null) noteNo(trackKey(id));
      opts.onLeave?.();
      toast({
        message: opts.scope === 'artist' && track.artist.trim() ? `Less like ${track.artist}.` : 'Less of that.',
      });
      if (session && id !== null) {
        void reactDj(session, id, 'down', opts.positionMs ?? 0, opts.scope).catch(() => {
          // An older hub, or no hub just now: the no stands on this device
          // for the sitting, which is the promise the toast made.
        });
      }
    },
    [session, toast],
  );

  const up = useCallback(
    (track: Track, positionMs = 0) => {
      const id = trackIdFromPath(track.path);
      fireNativeHaptic('light');
      toast({ message: 'Noted. More like this.' });
      if (session && id !== null) {
        void reactDj(session, id, 'up', positionMs).catch(() => {});
      }
    },
    [session, toast],
  );

  return { down, up };
}

/**
 * The thumbs: an up/down pair beside a song the DJ or the station chose.
 *
 * Renders nothing for a song with no library id (a local file, a preview)
 * because the hub could not record it. Each face is a full-size kit
 * IconButton - the CSS holds them at 44px, since these are pressed while
 * the music is on and the hand is not looking.
 */
export function Thumbs({
  track,
  positionMs = 0,
  onDown,
  className,
}: {
  track: Track;
  /** How far into the song the listener is, for the record. */
  positionMs?: number;
  /** What a down does to the music - skip it, drop it from the queue. */
  onDown?: () => void;
  className?: string;
}) {
  const { down, up } = useSayNo();
  const [said, setSaid] = useState<DjReaction | null>(null);
  // A new song is a fresh question.
  useEffect(() => setSaid(null), [track.path]);
  if (trackIdFromPath(track.path) === null) return null;
  return (
    <span className={`sayNoThumbs${className ? ` ${className}` : ''}`} role="group" aria-label="Your word on this pick">
      <IconButton
        type="button"
        variant="ghost"
        className="sayNoThumbs__btn sayNoThumbs__btn--up"
        aria-label={`More like ${track.title}`}
        aria-pressed={said === 'up'}
        data-on={said === 'up' || undefined}
        onClick={() => {
          setSaid('up');
          up(track, positionMs);
        }}
      >
        <ThumbsUp size={20} fill={said === 'up' ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton
        type="button"
        variant="ghost"
        className="sayNoThumbs__btn sayNoThumbs__btn--down"
        aria-label={`Less like ${track.title}`}
        aria-pressed={said === 'down'}
        data-on={said === 'down' || undefined}
        onClick={() => {
          setSaid('down');
          down(track, { positionMs, onLeave: onDown });
        }}
      >
        <ThumbsDown size={20} fill={said === 'down' ? 'currentColor' : 'none'} />
      </IconButton>
    </span>
  );
}

export interface SayNoItemsProps {
  /** Why this was dealt - the hub's line when it gave one, else the seed
   *  or lane line the card already wears. Nothing when there is nothing
   *  honest to say; the menu then opens straight on the refusals. */
  why?: string | null;
  artist: string;
  /** Refuse the song. */
  onTrack: () => void;
  /** Refuse the act. */
  onArtist: () => void;
  trackLabel?: string;
  artistLabel?: string;
}

/**
 * The rows a hold reveals: the reason (as a label, not an action - it is
 * information), then "not this song" and "less like {artist}". Rendered
 * inside a menu that already exists (TrackMenu's `lead` slot) or the
 * standalone SayNoMenu below.
 */
export function SayNoItems({
  why,
  artist,
  onTrack,
  onArtist,
  trackLabel = 'Not this song',
  artistLabel,
}: SayNoItemsProps) {
  const act = artist.trim();
  return (
    <>
      {why && <MenuLabel className="sayNoWhy">{why}</MenuLabel>}
      <MenuItem icon={<Ban size={15} />} onSelect={onTrack}>
        {trackLabel}
      </MenuItem>
      {act !== '' && (
        <MenuItem icon={<UserX size={15} />} onSelect={onArtist}>
          {artistLabel ?? `Less like ${act}`}
        </MenuItem>
      )}
    </>
  );
}

/**
 * The hold, on a surface that has no TrackMenu of its own (the Date card,
 * the Date pass button). Same contract as every row in the app: the kit's
 * ContextMenu, summoned by useHoldToMenu so a mouse gets the hold too and
 * the release that opened it never falls through as a tap.
 */
export function SayNoMenu({
  label,
  className,
  menuClassName,
  children,
  ...items
}: SayNoItemsProps & {
  label: string;
  className?: string;
  menuClassName?: string;
  children: ReactNode;
}) {
  const hold = useHoldToMenu((_from, root) => root);
  return (
    <ContextMenu
      {...hold}
      aria-label={label}
      className={className}
      menuClassName={menuClassName}
      content={
        <MenuStop>
          <SayNoItems {...items} />
        </MenuStop>
      }
    >
      {children}
    </ContextMenu>
  );
}
