import { useMemo, type CSSProperties } from 'react';
import onRepeatChip from '../../assets/chip-on-repeat.webp';
import { useLibrary } from './library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { readFeedCache } from './feedCache.ts';
import { trackIdFromPath, tracksOfHub, type HomeFeed } from '../server.ts';
import { LibChipMosaic, LibChipStat } from './LibChipFace.tsx';
import type { SongCollection } from './SongPage.tsx';

function songCount(n: number): string {
  return `${n} ${n === 1 ? 'song' : 'songs'}`;
}

/**
 * The songs you keep coming back to, as a door. Green, wearing the repeat
 * mark itself - the one chip whose face is a symbol, because the symbol IS
 * the name.
 *
 * It used to sit in the Library's row beside Liked and All songs. It moved
 * to Discover with everything else the server works out FROM your listening:
 * the Library holds what you saved or made, and "most played" is neither -
 * it is the machine's reading of you, which is what Discover is for.
 */
export function OnRepeatChip({ onOpenSongs }: { onOpenSongs: (view: SongCollection) => void }) {
  const { tracks } = useLibrary();
  const { session } = useServerSession();

  /*
   * How many songs are actually on repeat.
   *
   * Read from the cached home feed's `heavy` ids, counted against the songs
   * this hub actually holds - the same figure the page it opens will show.
   * Null - and so no figure at all, LibChipStat draws nothing for it - before
   * the first home feed has ever landed. A door that says nothing is better
   * than one that says nought while the library is plainly full.
   */
  const onRepeatCount = useMemo(() => {
    const feed = readFeedCache<HomeFeed>(session, 'home');
    if (!feed?.heavy?.length) return null;
    const known = new Set<number>();
    for (const t of tracksOfHub(tracks, session)) {
      const id = trackIdFromPath(t.path);
      if (id !== null) known.add(id);
    }
    const n = feed.heavy.filter((id) => known.has(id)).length;
    return n > 0 ? n : null;
  }, [session, tracks]);

  const covers = useMemo(
    () => tracks.map((t) => t.artwork).filter((a): a is string => !!a),
    [tracks],
  );

  return (
    <button
      type="button"
      className="libChip libChip--repeat"
      style={{ '--libChipHue': 145, '--libChipHue2': 190, '--art': `url("${onRepeatChip}")` } as CSSProperties}
      onClick={() => onOpenSongs('onrepeat')}
    >
      <img className="libChip__art" src={onRepeatChip} alt="" loading="lazy" />
      <LibChipMosaic covers={covers} />
      <LibChipStat value={onRepeatCount === null ? undefined : String(onRepeatCount)} />
      <span className="libChip__name">On repeat</span>
      <span className="libChip__count">
        {onRepeatCount === null ? 'Your most played' : songCount(onRepeatCount)}
      </span>
    </button>
  );
}
