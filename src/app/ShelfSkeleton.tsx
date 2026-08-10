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

/**
 * The card families a shelf can hold. The footprints are NOT written here -
 * they are the same `--card-*` variables the cards themselves use (app.css),
 * because a skeleton measured off a card by hand goes stale the first time the
 * card is resized, and a stand-in of the wrong size is worse than none: the
 * page visibly jumps when the real content lands. Every card's art is a square
 * filling the card's width, so one number is the whole geometry.
 */
const KINDS = {
  /** .trackCard - square art over a title and an artist. */
  track: {
    size: 'var(--card-track)',
    radius: 'var(--glacier-radius-lg)',
    center: false,
    lines: 2,
  },
  /** .mixCard - a square cover mosaic over a title and a blurb. */
  mix: { size: 'var(--card-mix)', radius: 'var(--glacier-radius-lg)', center: false, lines: 2 },
  /** .artistCard - a round portrait under a centred name. */
  artist: { size: 'var(--card-artist)', radius: '50%', center: true, lines: 1 },
  /** .playlistTile - a squircle and one caption, sized as a song card. */
  tile: { size: 'var(--card-track)', radius: 'var(--glacier-radius-lg)', center: false, lines: 1 },
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
              style={{ inlineSize: k.size }}
              data-center={k.center || undefined}
            >
              <Skeleton variant="rect" width={k.size} height={k.size} radius={k.radius} />
              <Skeleton variant="text" width={k.center ? '70%' : '85%'} />
              {k.lines >= 2 && <Skeleton variant="text" width="55%" />}
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}
