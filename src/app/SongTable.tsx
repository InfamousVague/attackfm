import { DataGrid, type DataGridColumn, type DataGridRow, type DataGridSort } from '@glacier/react';
import { Clock } from '@glacier/icons';
import { useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

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

// The grid's own comparator, verbatim, so the queue handed to the player is
// the rows exactly as the user sees them - same accessor, same direction,
// same stable sort.
function gridCompare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

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
        <img className="songArt" src={(row.artwork as string) || placeholderArt} alt="" loading="lazy" />
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
}: {
  /** Called with the opened track and the full list in its displayed order. */
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist?: (artist: string) => void;
  tracks?: Track[];
}) {
  const library = useLibrary();
  const tracks = tracksProp ?? library.tracks;

  // The sort is lifted out of the grid (controlled) for one reason: the play
  // queue has to be the rows as displayed, and only the sort says what that
  // order is.
  const [sort, setSort] = useState<DataGridSort | null>(DEFAULT_SORT);

  // The artist is a link into its own page; its click must not also open the row.
  const columns = useMemo<DataGridColumn[]>(
    () =>
      COLUMNS.map((col) =>
        col.key === 'title'
          ? {
              ...col,
              render: (row) => (
                <div className="songTitleCell">
                  <img className="songArt" src={(row.artwork as string) || placeholderArt} alt="" loading="lazy" />
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
              ),
            }
          : col,
      ),
    [onOpenArtist],
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
    <DataGrid
      aria-label="Songs"
      className="songTable"
      columns={columns}
      data={rows}
      sort={sort}
      onSortChange={setSort}
      density="comfortable"
      stickyHeader
      maxHeight="100%"
      loading={library.scanning && rows.length === 0}
      emptyState="No music found in your library folder yet."
      // The row id is the track's path; hand the matching track up to play it,
      // with the displayed order alongside as the queue it plays through.
      onRowActivate={(id) => {
        const track = tracks.find((t) => t.path === id);
        if (track) onPlay(track, displayed);
      }}
    />
  );
}
