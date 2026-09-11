import { useMediaQuery } from './useMediaQuery.ts';

/**
 * Whether the viewport is WIDE ENOUGH TO SPLIT: to stand Now Playing in a
 * column of its own down the right while the app keeps the left, live.
 *
 * This is a question about WIDTH ALONE, and that is what separates it from
 * `useDesktopLayout`. The desktop shape asks "is there room AND a cursor?",
 * because the rail's targets are small and its hovers mean something - and
 * so a tablet or an unfolded foldable, all room and no cursor, is deliberately
 * kept on the phone shape with its bottom bar and compact header. That
 * decision is right and this file does not touch it. But the phone shape was
 * then the only thing those screens could wear, and a phone's Now Playing is
 * the whole screen: on a screen twice as wide as a phone, the library sat
 * behind an opaque sheet with nothing but a thumb to reach it with. Room is
 * room whatever is pointing at it, so this asks only about the room.
 *
 * 48rem, 768px at the default root size. The number has to clear every phone
 * held upright and catch every unfolded fold and every tablet, and there is a
 * wide gap to draw it in: the widest phones in portrait are around 430px, and
 * a fold opened sideways is about 840 (its inner screen upright is around
 * 700, but a screen held upright takes the other branch - see npBig in
 * Player). 768 is also the narrow side of the smallest tablets, which is why
 * every platform's own "not a phone" line is drawn at or under it; drawing
 * ours there means a screen that a tablet vendor calls a tablet gets two
 * rooms, and nothing a phone vendor calls a phone does. Phones in landscape
 * clear it too, and that is accepted rather than an oversight: the old
 * 700px floor let them through for the whole life of the dock, and a phone
 * on its side is a screen shaped like the split, not like a sheet.
 */
export const SPLIT_SHAPE = '(min-width: 48rem)';

export function useSplitViewport(): boolean {
  return useMediaQuery(SPLIT_SHAPE);
}
