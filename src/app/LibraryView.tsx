import { SearchField } from '@glacier/react';
import { useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { filterTracks } from './trackSearch.ts';
import { PlaylistShowcase } from './PlaylistShowcase.tsx';
import { PluginSlot } from '../plugins/runtime.tsx';
import { SongTable } from './SongTable.tsx';
import type { Track } from './tauri.ts';

/**
 * The Library tab: the playlist showcase over the full song table, with a
 * search field that filters the table against the same local-library matcher
 * the ⌘K palette uses. While a query is present the showcase steps aside so the
 * results own the page; clearing the field brings the whole library back.
 */
export function LibraryView({
  onPlay,
  onOpenArtist,
  onOpenPlaylist,
}: {
  onPlay: (track: Track, context?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenPlaylist: (id: string) => void;
}) {
  const { tracks } = useLibrary();
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const filtered = useMemo(
    () => (searching ? filterTracks(tracks, query) : tracks),
    [searching, tracks, query],
  );

  return (
    <>
      {/* The page's own actions, top-right. Its own row rather than a corner of
          the showcase's header: the showcase steps aside while a search is
          running, and the downloads button must not vanish with it. */}
      <div className="pageActions pageActions--library">
        <PluginSlot id="titlebar-end" />
      </div>
      {!searching && <PlaylistShowcase onPlay={onPlay} onOpenPlaylist={onOpenPlaylist} />}
      <div className="libraryBody">
        <SearchField
          className="pageSearch"
          value={query}
          onValueChange={setQuery}
          placeholder="Search your library"
          aria-label="Search your library"
        />
        <SongTable onPlay={onPlay} onOpenArtist={onOpenArtist} tracks={filtered} />
      </div>
    </>
  );
}
