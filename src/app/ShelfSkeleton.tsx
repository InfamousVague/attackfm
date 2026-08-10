import { ScrollArea, Skeleton } from '@glacier/react';

/**
 * A shelf's stand-in while its feed is on the wire: the real heading over a
 * run of card-shaped skeletons, each the exact geometry of the card family it
 * holds the seat for - so when the content lands, nothing on the page moves.
 *
 * The heading is real text, not a bar: shelf titles are static strings the
 * page knows before any request, and a title that never changes is one more
 * thing pinned in place across the swap.
 */

/** The card families a shelf can hold, each measured off its CSS. */
const KINDS = {
  /** .trackCard - 9.5rem, square art, two text lines. */
  track: { width: '9.5rem', art: '9.5rem', radius: 'var(--glacier-radius-lg)', round: false, lines: 2 },
  /** .findCard - 9rem, square art, three lines (title, artist, the why). */
  find: { width: '9rem', art: '9rem', radius: 'var(--glacier-radius-md)', round: false, lines: 3 },
  /** .mixCard - 13rem, square mosaic, two lines. */
  mix: { width: '13rem', art: '13rem', radius: 'var(--glacier-radius-lg)', round: false, lines: 2 },
  /** .artistCard - 8rem, round portrait, centred name. */
  artist: { width: '8rem', art: '8rem', radius: '50%', round: true, lines: 1 },
  /** .playlistTile - 5rem squircle, one caption line. */
  tile: { width: '5rem', art: '5rem', radius: '34%', round: true, lines: 1 },
} as const;

export type ShelfSkeletonKind = keyof typeof KINDS;

export function ShelfSkeleton({
  title,
  kind,
  count = 8,
}: {
  title: string;
  kind: ShelfSkeletonKind;
  count?: number;
}) {
  const k = KINDS[kind];
  return (
    <section className="homeShelf" aria-busy="true">
      <h2 className="homeShelfTitle">{title}</h2>
      <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
        <div className="homeShelfRow">
          {Array.from({ length: count }, (_, i) => (
            <div
              key={i}
              className="shelfGhost"
              style={{ inlineSize: k.width }}
              data-center={k.round || undefined}
            >
              <Skeleton variant="rect" width={k.art} height={k.art} radius={k.radius} />
              <Skeleton variant="text" width={k.round ? '70%' : '85%'} />
              {k.lines >= 2 && <Skeleton variant="text" width="55%" />}
              {k.lines >= 3 && <Skeleton variant="text" width="70%" />}
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}
