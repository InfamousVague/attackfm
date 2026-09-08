import { mosaicArts } from '../ux/artLoad.ts';
import { newForYouLists, newMusicCovers } from '../library/newMusicLists.ts';
import type { DiscoverFeedValue } from '../home/DiscoverFeed.tsx';
import type { NewMusicList } from '../api/newMusic.ts';
import type { Track } from '../core/tauri.ts';
import type { useT } from '../i18n/LocaleShell.tsx';

/**
 * What the top of Discover leads with.
 *
 * The newest thing the machine has for you: the first "New for you" list, or
 * - on a hub with no model to build one - the daylist, the one card that
 * moves with the clock. Neither yet (a fresh account, a curator still
 * reading) and it leads with the library itself.
 */

/** What the hero leads with. Exported so the page can keep the shelves from
 *  showing the same list an inch below it. */
export interface HeroLead {
  kind: 'list' | 'daylist' | 'library';
  kicker: string;
  title: string;
  blurb: string;
  /** Sleeves for the mosaic and the wall's posters. */
  covers: string[];
  /** The song a single Canvas is asked for. */
  first: { title: string; artist: string } | null;
  list?: NewMusicList;
  tracks?: Track[];
}

/** Takes the translator rather than reaching for one: this is a plain
 *  function, and every string it settles on is prose that has to re-resolve
 *  when the language does - so the caller passes the `t` it already has and
 *  the memo around it lists `t` among its dependencies. */
export function heroLead(
  feed: DiscoverFeedValue,
  library: Track[],
  t: ReturnType<typeof useT>,
): HeroLead {
  const list = newForYouLists(feed.newMusic)[0];
  if (list) {
    const first = list.items[0];
    return {
      kind: 'list',
      kicker: t('discover.newForYou'),
      title: list.title,
      blurb: list.blurb || t('discover.notOwnedYetCount', { count: list.items.length }),
      covers: newMusicCovers(list, 4),
      first: first ? { title: first.title, artist: first.artist } : null,
      list,
    };
  }
  const daylist = feed.home.daylist;
  if (daylist) {
    const first = daylist.tracks[0];
    return {
      kind: 'daylist',
      kicker: daylist.title,
      title: daylist.subtitle,
      blurb: daylist.blurb,
      covers: mosaicArts(daylist.tracks.map((t) => t.artwork), 4, 640),
      first: first ? { title: first.title, artist: first.artist } : null,
      tracks: daylist.tracks,
    };
  }
  return {
    kind: 'library',
    kicker: t('nav.discover'),
    title: t('discover.libraryReadBack'),
    blurb:
      library.length > 0
        ? t('discover.learningBlurb')
        : t('discover.addMusicBlurb'),
    covers: mosaicArts(library.map((t) => t.artwork), 4, 640),
    first: null,
  };
}
