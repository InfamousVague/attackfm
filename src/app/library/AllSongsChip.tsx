import { useMemo, type CSSProperties } from 'react';
import allSongsChip from '../../assets/chip-all-songs.webp';
import { useLibrary } from './library.tsx';
import { LibChipMosaic, LibChipStat } from './LibChipFace.tsx';
import type { SongCollection } from './SongPage.tsx';

function songCount(n: number): string {
  return `${n} ${n === 1 ? 'song' : 'songs'}`;
}

/**
 * Every song, as a door. Blue, wearing the whole library's sleeves.
 *
 * It sat in the Library's row beside Liked; by request it lives on Discover
 * now - the Library is the things you chose, and "everything" is the pile
 * you browse when you are looking for something, which is what Discover is
 * for.
 */
export function AllSongsChip({ onOpenSongs }: { onOpenSongs: (view: SongCollection) => void }) {
  const { tracks } = useLibrary();
  const covers = useMemo(
    () => tracks.map((t) => t.artwork).filter((a): a is string => !!a),
    [tracks],
  );
  return (
    <button
      type="button"
      className="libChip libChip--all"
      style={{ '--libChipHue': 214, '--libChipHue2': 262, '--art': `url("${allSongsChip}")` } as CSSProperties}
      onClick={() => onOpenSongs('all')}
    >
      <img className="libChip__art" src={allSongsChip} alt="" loading="lazy" />
      <LibChipMosaic covers={covers} />
      <LibChipStat value={String(tracks.length)} />
      <span className="libChip__name">All songs</span>
      <span className="libChip__count">{songCount(tracks.length)}</span>
    </button>
  );
}
