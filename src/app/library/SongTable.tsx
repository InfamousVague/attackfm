import {
  DataGrid,
  type DataGridColumn,
  type DataGridRow,
  type DataGridSort,
} from '@glacier/react';
import { Clock } from '@glacier/icons';
import { useMemo, useState, type ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { hasLocalLibrary } from '../core/platform.ts';
import { useNarrowViewport } from '../ux/useNarrowViewport.ts';
import { TrackMenu } from './TrackMenu.tsx';
import type { Track } from '../core/tauri.ts';
import { artSized, trackIdFromPath } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import placeholderArt from '../../assets/attack-wave.png';

// mm:ss, with the leading minutes never zero-padded (3:59, not 03:59).
function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// The order the table opens in: newest additions first.
const DEFAULT_SORT: DataGridSort = { columnKey: 'addedAt', direction: 'desc' };

/** The shared song menu, for a cell that only knows its row. A row whose
 *  track has just left the library (a sync delta mid-render) simply draws
 *  without a menu rather than vanishing. */
function SongTitleMenu({ track, children }: { track: Track | null; children: ReactNode }) {
  if (!track) return <>{children}</>;
  return (
    <TrackMenu track={track} className="songTitleMenuTarget">
      {children}
    </TrackMenu>
  );
}

// The grid's own comparator, verbatim, so the queue handed to the player is
// the rows exactly as the user sees them - same accessor, same direction,
// same stable sort.
function gridCompare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// The title cell's thumb, pulled into its own component because a DataGrid
// cell is a render callback where hooks cannot live. It owns the row's sizing
// too: a ~40px thumb wants the 160 variant, never the full embedded picture.
function SongArt({ artwork }: { artwork: string | null }) {
  const src = artSized(artwork, 160) || placeholderArt;
  const art = useArtLoad(src, 'songArt');
  return <img {...art} src={src} alt="" loading="lazy" />;
}

// The columns that come off on a narrow screen, in the order they would be
// missed least: an album name the title cell half-implies, and a date that is
// already the sort.
const NARROW_HIDDEN = new Set(['album', 'addedAt']);

// The columns mirror the classic library table: an index, the title block with
// artwork and artist, album, when it was added, and the running time.
const COLUMNS: DataGridColumn[] = [
  {
    key: 'index',
    header: '#',
    width: '3rem',
    align: 'end',
    render: (_row, rowIndex) => <span className="songIndex">{rowIndex + 1}</span>,
  },
  {
    key: 'title',
    header: 'Title',
    sortable: true,
    sortValue: (row) => String(row.title).toLowerCase(),
    render: (row) => (
      <div className="songTitleCell">
        <SongArt artwork={row.artwork as string | null} />
        <div className="songTitleText">
          <span className="songTitle">{row.title as string}</span>
          <span className="songArtist">{row.artist as string}</span>
        </div>
      </div>
    ),
  },
  {
    key: 'album',
    header: 'Album',
    sortable: true,
    sortValue: (row) => String(row.album).toLowerCase(),
    render: (row) => <span className="songMuted">{(row.album as string) || '\u2014'}</span>,
  },
  {
    key: 'addedAt',
    header: 'Date added',
    sortable: true,
    width: '10rem',
    sortValue: (row) => row.addedAt as number,
    render: (row) => <span className="songMuted">{DATE_FORMAT.format(new Date(row.addedAt as number))}</span>,
  },
  {
    key: 'duration',
    header: <Clock size={16} aria-label="Duration" />,
    align: 'end',
    sortable: true,
    width: '5rem',
    sortValue: (row) => (row.duration as number | null) ?? 0,
    render: (row) => <span className="songMuted">{formatDuration(row.duration as number | null)}</span>,
  },
];

/**
 * The whole library as one sortable, scrolling table. It reads the tracks the
 * LibraryProvider has scanned - or a caller-supplied subset, e.g. one artist's -
 * and hands them to the kit's DataGrid; sorting is the grid's own, and the body
 * scrolls under a sticky header.
 */
export function SongTable({
  onPlay,
  onOpenArtist,
  tracks: tracksProp,
  flow,
  loading,
  plays,
}: {
  /** Called with the opened track and the full list in its displayed order. */
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist?: (artist: string) => void;
  tracks?: Track[];
  /**
   * Let the PAGE scroll instead of the table.
   *
   * By default the grid keeps its own bounded viewport, which is right inside
   * a shelf. On a collection page it is not: it makes two nested scrollers,
   * and a finger on the list moves the inner one, so the page header can never
   * scroll away. With this the table grows to its full height and the page
   * above it does the scrolling - one scroller, and a header that can leave.
   */
  flow?: boolean;
  /** Set while the CALLER is still fetching the rows it will pass. The table
   *  already knows about a library scan; it cannot know about a list being
   *  assembled above it (On repeat waits on the play ledger), and without this
   *  such a list renders as an empty table for the length of the request. */
  loading?: boolean;
  /** Play counts by server track id. Given, the leading column shows how many
   *  times each song was played instead of its position - which is the whole
   *  point of a most-played list, where a row number says nothing. */
  plays?: Map<number, number>;
}) {
  const library = useLibrary();
  const tracks = tracksProp ?? library.tracks;

  // The sort is lifted out of the grid (controlled) for one reason: the play
  // queue has to be the rows as displayed, and only the sort says what that
  // order is.
  const [sort, setSort] = useState<DataGridSort | null>(DEFAULT_SORT);

  // The grid's rows carry the path as their id; the panel wants the track. One
  // index resolves the one back to the other.
  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t] as const)), [tracks]);

  // A phone has room for the song and its length, and nothing else. Album and
  // the date added are dropped rather than squeezed - the title cell already
  // carries the artist, and five columns at 390px overlap their own headers
  // instead of narrowing. The sort they provided stays reachable: the table
  // still opens newest-first, and search covers finding an album by name.
  const narrow = useNarrowViewport();

  // The artist is a link into its own page; its click must not also open the
  // row. The title cell also carries the row's context menu - right-click (or
  // long-press) to file the song into a playlist - because the title block is
  // most of the row's width and the one part every layout keeps.
  const columns = useMemo<DataGridColumn[]>(
    () =>
      COLUMNS.filter((col) => !narrow || !NARROW_HIDDEN.has(col.key)).map((col) =>
        col.key === 'index' && plays
          ? {
              ...col,
              header: 'Plays',
              width: '4.5rem',
              render: (row) => {
                const id = trackIdFromPath(row.id as string);
                const n = id === null ? undefined : plays.get(id);
                return <span className="songMuted">{n === undefined ? '' : n.toLocaleString()}</span>;
              },
            }
          : col.key === 'title'
          ? {
              ...col,
              render: (row) => (
                <SongTitleMenu track={byPath.get(row.id as string) ?? null}>
                  <div className="songTitleCell">
                    <SongArt artwork={row.artwork as string | null} />
                    <div className="songTitleText">
                      <span className="songTitle">{row.title as string}</span>
                      {onOpenArtist ? (
                        <button
                          type="button"
                          className="songArtist songArtistLink"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenArtist(row.artist as string);
                          }}
                        >
                          {row.artist as string}
                        </button>
                      ) : (
                        <span className="songArtist">{row.artist as string}</span>
                      )}
                    </div>
                  </div>
                </SongTitleMenu>
              ),
            }
          : col,
      ),
    [onOpenArtist, narrow, byPath, plays],
  );

  const rows: DataGridRow[] = tracks.map((track) => ({
    id: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    addedAt: track.addedAt,
    duration: track.duration,
    artwork: track.artwork,
  }));

  // The tracks in the order the grid is showing them, mirroring its sort so
  // "play through the list" means the list as it stands on screen. Row and
  // track share an index (rows is a straight map), so sorting tracks with the
  // grid's comparator lands on identical order.
  const displayed = useMemo(() => {
    if (!sort) return tracks;
    const col = COLUMNS.find((c) => c.key === sort.columnKey);
    if (!col) return tracks;
    const accessor = col.sortValue ?? ((row: DataGridRow) => row[sort.columnKey] as string | number);
    const dir = sort.direction === 'asc' ? 1 : -1;
    return tracks
      .map((track, index) => ({ track, row: rows[index]! }))
      .sort((a, b) => gridCompare(accessor(a.row), accessor(b.row)) * dir)
      .map((pair) => pair.track);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows derives from tracks
  }, [tracks, sort]);

  return (
    <>
    <DataGrid
      aria-label="Songs"
      className={flow ? 'songTable songTable--flow' : 'songTable'}
      columns={columns}
      data={rows}
      sort={sort}
      onSortChange={setSort}
      density="comfortable"
      // In flow mode the page is the scroller, so the grid's own sticky
      // header would pin to the page and collide with the collapsed page
      // header. The page bar carries that job instead.
      stickyHeader={!flow}
      maxHeight={flow ? undefined : '100%'}
      loading={loading || (library.scanning && rows.length === 0)}
      // The empty state has to name the thing to do next, and that differs by
      // where the music was meant to come from: a phone has no folder to fill,
      // so telling it one is empty would be a dead end.
      emptyState={
        library.source === 'server'
          ? library.error ?? 'Nothing on the server yet — upload some music from the desktop app.'
          : hasLocalLibrary
            ? 'No music found in your library folder yet.'
            : 'Connect to your music server in Settings to start listening.'
      }
      // The row id is the track's path; hand the matching track up to play it,
      // with the displayed order alongside as the queue it plays through.
      onRowActivate={(id) => {
        const track = tracks.find((t) => t.path === id);
        if (track) onPlay(track, displayed);
      }}
    />
    </>
  );
}
