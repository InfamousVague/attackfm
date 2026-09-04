import { Text } from '@glacier/react';
import { Sparkles } from '@glacier/icons';
import { Shelf, TrackCard } from '../home/homeCards.tsx';
import { ShelfSkeleton } from '../ux/ShelfSkeleton.tsx';
import { useDiscoverFeed } from '../home/DiscoverFeed.tsx';
import type { NewMusicList } from '../api/newMusic.ts';
import type { Track } from '../core/tauri.ts';

/**
 * New for you: what the machine has found and fetched that you have not met.
 *
 * Two things, one shelf, because they are the same idea a step apart. The
 * lists lead: the discovery pool - songs nobody owns yet, harvested near what
 * actually gets played, scored, and sorted into themed sets by the model. A
 * list here is not a playlist you can play; nothing in it is on the disk.
 * Tapping one opens what it holds, each song previewable where the catalogue
 * gave us a clip, and each one addable - the only verb that makes sense for
 * music you do not have. The first list is the feature card, two wide.
 *
 * Behind them, the collector's auditions: the songs it went and DOWNLOADED for
 * you that you have not adopted yet. They are deliberately absent from the
 * rest of the app - the shelves, the search, the table all show a library of
 * things its people chose - and this is the one place they appear. Adoption
 * is not a button: play one through and it is yours, heart it and it is yours
 * immediately. This shelf used to be two ("New music for you" and "For you"),
 * which was the same word twice on adjacent rails.
 *
 * Not on this shelf any more: the "popping off" chart list. That is the
 * global trending shelf now, under the label the server gives it, and it was
 * the one card here that was not new to the world - only to you.
 */

/** How many lists lead the rail, before the auditions. */
const LISTS = 4;
/** How many audition cards follow. */
const AUDITIONS = 6;

/** The chart lane's list: global, not new - it has its own shelf. */
const GLOBAL_LIST = 'nm-popping';

/** The lists as this shelf shows them: the chart lane removed, fresh first. */
export function newForYouLists(lists: NewMusicList[] | null): NewMusicList[] {
  return (lists ?? []).filter((l) => l.id !== GLOBAL_LIST);
}

export function NewMusicShelf({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { session, newMusic, auditions, openList } = useDiscoverFeed();
  const { mine, status } = auditions;

  if (!session) return null;
  // The lists are the slow half; the auditions are already in the library.
  // Hold the seat until the lists answer, unless there is nothing to wait for.
  if (newMusic === null && mine.length === 0) {
    return <ShelfSkeleton title="New for you" kind="mix" count={3} />;
  }

  const lists = newForYouLists(newMusic).slice(0, LISTS);
  const halted = status?.halted === 'cap';
  const count = lists.length + Math.min(mine.length, AUDITIONS);
  if (count === 0 && !halted) return null;

  const spentGb = status ? status.ledgerBytes / 1e9 : 0;
  const capGb = status ? status.capBytes / 1e9 : 0;

  return (
    <>
      <Shelf title="New for you" count={count}>
        {lists.map((list, i) => (
          <button
            key={list.id}
            type="button"
            className={i === 0 ? 'mixCard mixCard--feature' : 'mixCard'}
            onClick={() => openList(list)}
          >
            <span className="mixCardCoverWrap">
              <NewMusicCover list={list} />
            </span>
            <span className="mixCardText">
              <span className="mixCardTitle">{list.title}</span>
              <span className="mixCardBlurb">
                {list.blurb || `${list.items.length} songs you do not own`}
              </span>
            </span>
          </button>
        ))}
        {mine.slice(0, AUDITIONS).map((t) => (
          // Playing it through IS the adoption.
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, mine)} note="Fetched for you" />
        ))}
      </Shelf>
      {/* The collector's one loud message: its budget is full and it has
          stopped. Pulls stop entirely at the cap - nothing is ever
          auto-deleted - so a full budget with a quiet shelf means the machine
          is waiting on you. */}
      {halted && (
        <Text size="sm" className="forYouHalted" role="status">
          The collector is out of room — {spentGb.toFixed(0)} of {capGb.toFixed(0)} GB is holding
          music nobody has adopted. Play through or heart what you want to keep; clearing the rest
          from Settings lets it hunt again.
        </Text>
      )}
    </>
  );
}

/**
 * Four covers in a square, from the catalogue's own art.
 *
 * Borrows `.mixCardCover` - the same 2x2 mosaic the made-for-you mixes use, so
 * the two shelves read as siblings and this costs no new layout. It cannot use
 * the MixCover COMPONENT, though: that takes owned Tracks and resolves library
 * artwork ids, and nothing here is in the library to have one.
 */
export function NewMusicCover({ list }: { list: NewMusicList }) {
  const art = newMusicCovers(list, 4);
  if (art.length === 0) {
    return (
      <span className="mixCardCover newMixCover" aria-hidden>
        <Sparkles size={22} />
      </span>
    );
  }
  return (
    <span className="mixCardCover newMixCover" data-count={art.length} aria-hidden>
      {art.map((src, i) => (
        <img key={i} src={src} alt="" loading="lazy" />
      ))}
    </span>
  );
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
