import {
  DataGrid,
  type DataGridColumn,
  type DataGridRow,
  type DataGridSort,
} from '@glacier/react';
import { ArrowDownToLine, CircleCheck, Clock } from '@glacier/icons';
import { useOnDevice } from '../downloads/useOnDevice.ts';
import { useMemo, useState, type ReactNode } from 'react';
import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { SelectionBar, SongSelectionContext } from './songSelection.tsx';
import { useLibrary } from './library.tsx';
import { hasLocalLibrary } from '../core/platform.ts';
import { useDockedSheet, useNarrowViewport } from '../ux/useNarrowViewport.ts';
import { TrackMenu } from './TrackMenu.tsx';
import { isTauri, type Track } from '../core/tauri.ts';
import { artSized, trackIdFromPath } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import placeholderArt from '../../assets/attack-wave.png';
import { formatClock } from '../ux/format.ts';

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// The order the table opens in: newest additions first.
const DEFAULT_SORT: DataGridSort = { columnKey: 'addedAt', direction: 'desc' };

/** From wherever a press lands in the grid, the title cell's menu wrapper on
 *  the same row - the one element per row that actually wears the menu. */
function rowMenuTarget(from: Element): Element | null {
  return from.closest('tr')?.querySelector('.songTitleMenuTarget') ?? null;
}

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
    // Half the table, explicitly. Under table-layout:fixed the columns that
    // declare a width take it first and the rest divide what is left, so a
    // title with no width of its own loses to a 10rem date and a 5rem clock
    // the moment the pane narrows - which is how it ended up one letter wide.
    width: '50%',
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
    /*
     * On this device.
     *
     * This was a 13px tick tucked beside the song title, which says the same
     * thing but cannot be SCANNED: you could not run your eye down a list and
     * see what would survive a tunnel, and you certainly could not sort by it.
     * As a column it does both, and sorting puts everything you already hold at
     * the top - which is the question people actually ask of a liked list
     * before going somewhere without signal.
     *
     * Both halves of "on the device" count, pinned and auto-cached alike: to a
     * listener in a tunnel a file is a file, and which store happens to own it
     * is the app's business rather than theirs. That is `useOnDevice`.
     *
     * The live set is not in scope up here, so render and sortValue are both
     * replaced below where it is.
     */
    key: 'onDevice',
    header: <ArrowDownToLine size={16} aria-label="On this device" />,
    align: 'center',
    width: '3.5rem',
    sortable: true,
    render: () => null,
  },
  {
    key: 'duration',
    header: <Clock size={16} aria-label="Duration" />,
    align: 'end',
    sortable: true,
    width: '5rem',
    sortValue: (row) => (row.duration as number | null) ?? 0,
    render: (row) => <span className="songMuted">{formatClock(row.duration as number | null, '--:--')}</span>,
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
  // Hold anywhere on a row - or right-click anywhere on it - and the row's
  // menu opens; the release does not also play the song.
  const hold = useHoldToMenu(rowMenuTarget);

  /*
   * Selection mode: the grid's own checkboxes, entered through the row menu's
   * "Select" item (which TrackMenu offers because this provider exists). In
   * the mode, activating a row TOGGLES it instead of playing - a tap that
   * started songs while you were gathering them would be the drag-select
   * papercut all over again. Leaving the mode (the bar's X, or acting) drops
   * the set.
   */
  const [selected, setSelected] = useState<string[] | null>(null);
  const selecting = selected !== null;
  const selectionEntry = useMemo(
    () => ({ start: (path: string) => setSelected([path]) }),
    [],
  );

  // The sort is lifted out of the grid (controlled) for one reason: the play
  // queue has to be the rows as displayed, and only the sort says what that
  // order is.
  const [sort, setSort] = useState<DataGridSort | null>(DEFAULT_SORT);

  // The grid's rows carry the path as their id; the panel wants the track. One
  // index resolves the one back to the other.
  const onDevice = useOnDevice();
  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t] as const)), [tracks]);

  // A narrow COLUMN has room for the song and its length, and nothing else.
  // Album and the date added are dropped rather than squeezed - the title cell
  // already carries the artist, and five columns in a phone's width overlap
  // their own headers instead of narrowing. The sort they provided stays
  // reachable: the table still opens newest-first, and search covers finding
  // an album by name.
  //
  // Two ways to be narrow, and both shed the same two columns. The window
  // being small is the phone. The other is the Now Playing sheet docking
  // beside the app on an unfolded screen: the window stays wide while this
  // table gets less room than a phone in portrait, which is how the title
  // came to be one letter wide with Album and Date added at full width.
  //
  // Shedding is done HERE rather than in CSS because a table with
  // `table-layout: fixed` re-derives its columns from the cells that remain -
  // hiding two with `display: none` leaves the survivors sharing the widths
  // of the departed and squeezes the title further, which is measurably worse
  // than doing nothing.
  // Both hooks called unconditionally, THEN combined: `a() || b()` would
  // short-circuit past the second one whenever the first is true, which is a
  // conditional hook call and breaks the order React counts on.
  const narrowWindow = useNarrowViewport();
  const docked = useDockedSheet();
  const narrow = narrowWindow || docked;

  // The artist is a link into its own page; its click must not also open the
  // row. The title cell also carries the row's context menu - right-click (or
  // long-press) to file the song into a playlist - because the title block is
  // most of the row's width and the one part every layout keeps.
  const columns = useMemo<DataGridColumn[]>(
    () =>
      COLUMNS.filter(
        (col) =>
          // A browser has no vault, so the column could only ever answer "no"
          // for every row - a whole column of dashes saying nothing.
          (col.key !== 'onDevice' || isTauri()) &&
          (!narrow || !NARROW_HIDDEN.has(col.key)),
      ).map((col) =>
        // Narrow, the title gives its 50% back and takes what is left instead.
        //
        // That 50% exists to stop a wide table's title being starved by a
        // 10rem date and a 5rem clock. Shed those two and it turns from a
        // floor into a ceiling: with EVERY remaining column carrying a
        // declared width, nothing absorbs the slack, and a percentage
        // resolved against the table's own width settles at
        // fixed / 0.5 - measured, 158px of #-and-clock became a 316px table
        // inside a 375px column, and the missing 59px read as dead space down
        // the right of every row. Album used to be the flexible column that
        // soaked that up; dropping it removed the only one there was.
        //
        // Auto here is not a fallback, it is the correct answer: with the two
        // wide columns gone there is nothing left to starve the title.
        //
        // (The width is handed over INSIDE the title branch below, not as a
        // branch of its own ahead of it - a first branch that returned the
        // bare column for "narrow" won the ternary, and the phone got a title
        // cell with no menu and no artist link. That was the bug: holding a
        // song on the phone did nothing, because there was nothing to hold.)
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
          : col.key === 'onDevice'
          ? {
              ...col,
              // Held first when sorted ascending: the useful end of this
              // question is "what do I already have", not "what am I missing".
              sortValue: (row) => (onDevice.has(row.id as string) ? 0 : 1),
              render: (row) =>
                onDevice.has(row.id as string) ? (
                  <CircleCheck size={15} className="songLocal" aria-label="On this device" />
                ) : (
                  // An em dash rather than an empty cell: a blank reads as "not
                  // loaded yet" where a dash reads as an answer.
                  <span className="songMuted" aria-label="Not on this device">
                    {'\u2014'}
                  </span>
                ),
            }
          : col.key === 'title'
          ? {
              ...col,
              width: narrow ? undefined : col.width,
              render: (row) => (
                <SongTitleMenu track={byPath.get(row.id as string) ?? null}>
                  <div className="songTitleCell">
                    <SongArt artwork={row.artwork as string | null} />
                    <div className="songTitleText">
                      {/* The on-device mark used to hang here, beside the
                          name. It has moved out into a column of its own, which
                          says the same thing and can also be scanned and sorted;
                          two copies of it on one row was just noise. */}
                      <span className="songTitle">
                        <span className="songTitle__name">{row.title as string}</span>
                      </span>
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
    // onDevice belongs here and was missing: the columns READ it, so without it
    // a download landing rebuilt nothing and the mark only appeared later, when
    // some unrelated dependency happened to change.
    [onOpenArtist, narrow, byPath, plays, onDevice],
  );

  // Memoized on the library, not rebuilt per render: the grid memoizes its
  // own O(n log n) sort on the data's IDENTITY, so a fresh array here made it
  // re-sort the whole library on every render - twice per track change, with
  // `displayed` below doing the other one.
  const rows: DataGridRow[] = useMemo(
    () =>
      tracks.map((track) => ({
        id: track.path,
        title: track.title,
        artist: track.artist,
        album: track.album,
        addedAt: track.addedAt,
        duration: track.duration,
        artwork: track.artwork,
      })),
    [tracks],
  );

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
    <SongSelectionContext.Provider value={selectionEntry}>
    <DataGrid
      aria-label="Songs"
      {...hold}
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
      selectable={selecting}
      selectedIds={selected ?? undefined}
      onSelectionChange={(ids) => setSelected(ids.map(String))}
      // The row id is the track's path; hand the matching track up to play it,
      // with the displayed order alongside as the queue it plays through. In
      // selection mode the same tap toggles membership instead.
      onRowActivate={(id) => {
        if (selecting) {
          const path = String(id);
          setSelected((prev) =>
            prev === null
              ? [path]
              : prev.includes(path)
                ? prev.filter((p) => p !== path)
                : [...prev, path],
          );
          return;
        }
        const track = tracks.find((t) => t.path === id);
        if (track) onPlay(track, displayed);
      }}
    />
    {selecting && (
      <SelectionBar
        tracks={displayed}
        selected={selected}
        onClear={() => setSelected(null)}
        onSelectAll={() => setSelected(displayed.map((t) => t.path))}
      />
    )}
    </SongSelectionContext.Provider>
  );
}
