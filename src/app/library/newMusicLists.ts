import type { NewMusicList } from '../api/newMusic.ts';

/**
 * What "New for you" is made of, before anything draws it.
 *
 * The discovery pool arrives from the hub as themed lists, and one of them is
 * not new to the WORLD - only to you. The chart lane is the global trending
 * shelf now, under the label the server gives it, so a shelf or a hero that
 * led with it would be showing everyone's chart under a heading that promised
 * something the machine found for this listener.
 *
 * Both the shelf and Discover's hero read the same lists, and the hero exists
 * partly to keep the shelf from repeating itself an inch below - so they have
 * to agree on which lists there are and which covers each one wears.
 */

/** The chart lane's list: global, not new - it has its own shelf. */
const GLOBAL_LIST = 'nm-popping';

/** The lists as this shelf shows them: the chart lane removed, fresh first. */
export function newForYouLists(lists: NewMusicList[] | null): NewMusicList[] {
  return (lists ?? []).filter((l) => l.id !== GLOBAL_LIST);
}

/** The first `take` distinct covers a list holds. */
export function newMusicCovers(list: NewMusicList, take: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of list.items) {
    if (!t.cover || seen.has(t.cover)) continue;
    seen.add(t.cover);
    out.push(t.cover);
    if (out.length >= take) break;
  }
  return out;
}
