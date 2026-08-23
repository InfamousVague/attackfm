import type { MouseEvent, ReactNode } from 'react';
import { artistDoorOpen, openArtist } from '../nav/artistDoor.ts';

/**
 * An artist's name that goes somewhere.
 *
 * Most of the names this replaces sat INSIDE something already pressable - a
 * card that plays, a row that opens - so this cannot be a <button>: a button
 * inside a button is invalid markup and an ambiguous press. A span with the
 * role does the job, and stopPropagation is what keeps a tap on the name from
 * ALSO firing the card under it.
 *
 * Renders as plain text when navigation is not mounted or the name is empty,
 * so no caller has to guard - the degenerate cases look exactly like the dead
 * text this replaces, which was already the accepted look for them.
 *
 * `beforeOpen` is for surfaces stacked over the page - a panel or modal that
 * must step aside before the artist page can be seen.
 */
export function ArtistLink({
  artist,
  className,
  beforeOpen,
  children,
}: {
  artist: string | null | undefined;
  className?: string;
  /** Close whatever this name lives in, before the page opens under it. */
  beforeOpen?: () => void;
  /** Custom text - defaults to the artist's name. */
  children?: ReactNode;
}) {
  const name = artist?.trim() ?? '';
  if (!name || !artistDoorOpen()) {
    return <span className={className}>{children ?? artist}</span>;
  }
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    beforeOpen?.();
    openArtist(name);
  };
  return (
    <span
      role="link"
      tabIndex={0}
      className={`artistLink${className ? ` ${className}` : ''}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(e as unknown as MouseEvent);
      }}
    >
      {children ?? artist}
    </span>
  );
}
