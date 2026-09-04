import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import { useHomeFeed, type HomeFeedValue } from './useHomeFeed.ts';
import { useMyAuditions } from '../library/myAuditions.ts';
import { useWallClipsState } from '../library/wallClips.ts';
import { fetchNewMusic, type NewMusicList } from '../api/newMusic.ts';
import { fetchTrending, type TrendingFeed } from '../api/trending.ts';
import { NewMusicListModal } from '../library/NewMusicListModal.tsx';
import type { CollectorStatus, ServerSession } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Everything the Discover page reads, fetched once.
 *
 * The page used to be a frame around shelves that each owned their own feed,
 * and the arithmetic of that was ten requests on one mount: the home and
 * curator feeds twice (two wrappers around one component), the curator feed a
 * third time (For you), the collector's status twice (For you and the Music
 * Date chip), the pool count, new music, the catalogue suggestions. Same
 * server, same answers, asked for over and over because no two shelves could
 * see each other.
 *
 * This is the one place that asks. One home feed (`/api/home` + `/api/curator`,
 * cached-then-refreshed as before), one collector status, one new-music read,
 * one trending read, one wall of clips - and every shelf below reads from
 * here. The catalogue suggestions are the one feed NOT in this list: they are
 * the last shelf on a long page and they wait until that shelf is near the
 * viewport (see SuggestedLists), which is not "on mount" at all.
 *
 * A shelf that also renders outside this page (the Booth mounts the curator
 * shelves) keeps a fallback that fetches for itself - see `CuratorShelves`.
 */
export interface DiscoverFeedValue {
  session: ServerSession | null;
  /** The home and curator feeds, resolved into shelves. */
  home: HomeFeedValue;
  /** The collector's unadopted auditions that are THIS listener's, and its
   *  ledger - one definition for every surface, see myAuditions.ts. */
  auditions: { mine: Track[]; status: CollectorStatus | null };
  /** New-music lists; null until the first answer, [] for "nothing yet". */
  newMusic: NewMusicList[] | null;
  /** The three trending shelves; undefined until the first answer, null for a
   *  hub that has no such route. */
  trending: TrendingFeed | null | undefined;
  /** Canvas clips from this listener's own wall, for the hero. */
  clips: string[];
  /** Whether the wall has answered - an empty `clips` before the answer is
   *  "not yet", after it is "none", and the hero falls back only on "none". */
  wallSettled: boolean;
  /** Open one new-music list as a modal - from the shelf or from the hero. */
  openList: (list: NewMusicList) => void;
}

const Ctx = createContext<DiscoverFeedValue | null>(null);

export function DiscoverFeedProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const { tracks, forYou } = useLibrary();
  const refreshNonce = useRefreshNonce();

  const home = useHomeFeed(tracks, session, forYou);
  const auditions = useMyAuditions();
  const { clips, settled: wallSettled } = useWallClipsState(session, 'mine');

  const [newMusic, setNewMusic] = useState<NewMusicList[] | null>(null);
  useEffect(() => {
    if (!session) {
      setNewMusic(null);
      return;
    }
    const ctrl = new AbortController();
    fetchNewMusic(session, ctrl.signal)
      .then((next) => {
        if (!ctrl.signal.aborted) setNewMusic(next);
      })
      // Kept quiet, like every other feed on this page: a shelf that cannot
      // load is a shelf that is not there, not a page with an error on it.
      .catch(() => {
        if (!ctrl.signal.aborted) setNewMusic([]);
      });
    return () => ctrl.abort();
  }, [session, refreshNonce]);

  const [trending, setTrending] = useState<TrendingFeed | null | undefined>(undefined);
  useEffect(() => {
    if (!session) {
      setTrending(undefined);
      return;
    }
    const ctrl = new AbortController();
    fetchTrending(session, ctrl.signal)
      .then((next) => {
        if (!ctrl.signal.aborted) setTrending(next);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setTrending(null);
      });
    return () => ctrl.abort();
  }, [session, refreshNonce]);

  const [open, setOpen] = useState<NewMusicList | null>(null);
  const openList = useCallback((list: NewMusicList) => setOpen(list), []);

  return (
    <Ctx.Provider
      value={{ session, home, auditions, newMusic, trending, clips, wallSettled, openList }}
    >
      {children}
      {open && <NewMusicListModal list={open} onClose={() => setOpen(null)} />}
    </Ctx.Provider>
  );
}

export function useDiscoverFeed(): DiscoverFeedValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDiscoverFeed outside DiscoverFeedProvider');
  return v;
}

/** The shared feed when there is one, and nothing when a shelf is mounted
 *  somewhere else - for shelves that render on more than one page. */
export function useDiscoverFeedOptional(): DiscoverFeedValue | null {
  return useContext(Ctx);
}
