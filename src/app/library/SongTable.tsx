import {
  DataGrid,
  type DataGridColumn,
  type DataGridRow,
  type DataGridSort,
} from '@glacier/react';
import { ArrowDownToLine, CircleCheck, Clock, RotateCcw, X } from '@glacier/icons';
import { useOnDevice } from '../downloads/useOnDevice.ts';
import { identityKey, useJustLanded, type IncomingTrack } from '../downloads/incoming.tsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFollowNowPlaying, useNowPlayingPath } from '../player/nowPlayingStore.ts';
import { NowPlayingBars } from '../player/NowPlayingBars.tsx';
import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { SelectionBar, SongSelectionContext } from './songSelection.tsx';
import { useLibrary } from './library.tsx';
import { hasLocalLibrary } from '../core/platform.ts';
import { useDockedSheet, useNarrowViewport } from '../ux/useNarrowViewport.ts';
import { TrackMenu } from './TrackMenu.tsx';
import { isTauri, type Track } from '../core/tauri.ts';
import { artSized, originFromPath, trackIdFromPath } from '../server.ts';
import { useOriginLabeler } from '../servers/serverNames.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import placeholderArt from '../../assets/attack-wave.png';
import { usePrefetchArt } from '../ux/artPrefetch.ts';
import { formatClock } from '../ux/format.ts';

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** How many rows a flow-mode table draws before it has been scrolled, and how
 *  many more each time the foot comes near. A screenful with room to spare, so
 *  opening All songs builds eighty rows rather than six thousand. */
const FLOW_INITIAL = 80;
const FLOW_STEP = 80;

/** The nearest ancestor that actually scrolls - the IntersectionObserver root
 *  the "load more" sentinel is watched against. Null (the viewport) when there
 *  is none, which is the right default for a page that scrolls the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/*
 * The order the table opens in.
 *
 * It used to be newest-added first, which quietly made the library a feed.
 * Anything that arrived today outranked everything ever collected, so a run of
 * collector downloads sat as a slab across the top of All songs and pushed the
 * library proper below the fold - the songs were IN the list, they were simply
 * all at the front of it.
 *
 * Alphabetical is the honest default for a shelf: a new song lands where its
 * name puts it, next to the rest of the library, and finding something you
 * already own does not depend on remembering when it arrived. Recency is still
 * one click away on the Date added column, and still has its own shelf and its
 * own page for the times that is the question being asked.
 */
const DEFAULT_SORT: DataGridSort = { columnKey: 'title', direction: 'asc' };

/**
 * What a title sorts as.
 *
 * Sorting on the raw string opens the library on punctuation: `?`, `.`,
 * `"Slut!"`, `(It Goes Like) Nanana`, `→unfinished→` were the actual first
 * five rows. Every one is correctly placed and the whole screenful is useless,
 * because leading punctuation says nothing about where a person expects to
 * find a song.
 *
 * So the key is the title with the noise taken off the front: leading
 * punctuation and brackets, then a leading article. `The National` files under
 * N the way it does on a shelf. Accents fold too, so `Ámbar` sits with the A's
 * rather than after Z.
 *
 * The original string is what gets DRAWN - this only decides order. A title
 * that is nothing but punctuation keeps it and still sorts first, which is
 * the honest answer for a song actually called `?`.
 */
function sortKey(title: string): string {
  const folded = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  const bare = folded.replace(/^[^\p{L}\p{N}]+/u, '');
  const noArticle = bare.replace(/^(the|a|an)\s+/, '');
  // Never return empty: a title of pure punctuation must still order stably.
  return noArticle || bare || folded;
}

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

/**
 * The failed job's reason, trimmed to the half a person acts on - the server
 * appends its own transcript under the first line, and the first line is the
 * part that says whether trying again is worth anything.
 */
export function shortFailure(error: string | null | undefined): string {
  const first = (error ?? '').split('\n')[0]?.trim() ?? '';
  if (!first) return 'download failed';
  const cut = first.replace(/\s*Retry to resume\.?$/i, '').trim();
  return cut.length > 48 ? `${cut.slice(0, 45)}\u2026` : cut || 'download failed';
}

/** The one line under an arriving song's name: what it is waiting on. */
export function incomingStatus(t: IncomingTrack): string {
  if (!t.stalled) return t.artist ? `${t.artist} \u2014 downloading` : 'downloading';
  const why = t.onRetry ? shortFailure(t.failure) : 'waiting for its turn';
  return t.artist ? `${t.artist} \u2014 ${why}` : why;
}

/**
 * A row in the grid that is not a song in this library.
 *
 * The table grew this for arriving downloads, and the shape turned out to be
 * general: a name, maybe a credit, a line saying why it is here, something in
 * the leading cell and something to press in the trailing one. That is also a
 * track on an album you do not own yet, a song filed into a playlist that has
 * not landed, a row of a chart nobody here has, and - with `kind: 'heading'` -
 * a disc break.
 *
 * They are rows of the SAME grid, in its columns and between its hairlines,
 * because that is the point: a song you have and a song you don't belong to
 * one list. The alternative, a second surface stacked under the first, makes
 * the reader do the joining.
 */
export interface GhostRow {
  /** Unique within one table. The grid row's id becomes `ghost:<key>`. */
  key: string;
  /** 'heading' draws its title across the row and nothing else - a disc break,
   *  a section. Anything else draws as a song. */
  kind?: 'song' | 'heading';
  title: string;
  artist?: string | null;
  artwork?: string | null;
  /** The second line, where a real row shows the artist: a status, a reason,
   *  a credit. */
  note?: string;
  /** The leading cell - a sleeve position, a rank, a spinner. Blank if absent. */
  lead?: ReactNode;
  /** The trailing cell, in the duration column's slot: add, cancel, retry. */
  action?: ReactNode;
  /**
   * Where it sits, as an index into the handed order.
   *
   * Omitted means pinned above the songs, which is what an arriving download
   * wants. Given, it takes that seat in the list - which is what an album's
   * missing track 3 wants, so it sits between 2 and 4. Honoured only when the
   * table is in its handed order: under a sort there is no seat to take, since
   * a row with no album and no date cannot be sorted among rows that have
   * them, so those go to the top band instead.
   */
  at?: number;
}

/**
 * How one page wants this table cut, in a single object.
 *
 * Every surface that shows songs should look like the same surface - that is
 * the whole reason these pages moved onto this table. What differs between an
 * album, a playlist and the library is small and predictable: which columns
 * are worth showing when the page's own title already answers them, whether
 * the order handed in IS the content, what the leading number means, and
 * whether a row has a verb of its own.
 *
 * One object rather than six flags because they are never chosen
 * independently - a ported page sets three or four at once, and this keeps
 * that to one line at the call site. Every field is optional and absent means
 * exactly what the library does today, so the callers that were here first
 * are untouched.
 */
export interface SongTableShape {
  /** Columns this page has no use for, dropped on top of the narrow shed.
   *  An album hides `album`; a playlist hides `addedAt`, which would be the
   *  library's scan date rather than when it was filed - a real lie, not a
   *  blank. */
  hide?: readonly SongColumnKey[];
  /**
   * The order handed in is the content, so the headers stop being sort
   * controls.
   *
   * A record has a running order and a playlist has the order somebody put it
   * in; offering to alphabetise either is offering to destroy the only thing
   * the list was. Pair with `defaultSort={null}`, which is what makes the
   * queue the list as filed.
   */
  fixedOrder?: boolean;
  /** What the leading cell says, when a row's position in the list is not the
   *  useful number. An album prints the sleeve's own track number. */
  lead?: (track: Track, rowIndex: number) => ReactNode;
  /** A verb of the row's own, in a column appended at the end: remove from
   *  this playlist, add this one to the library. */
  action?: { header?: ReactNode; width?: string; render: (track: Track) => ReactNode };
  /** What an empty page says. The default is about a library folder, which is
   *  the wrong sentence inside an empty playlist. */
  empty?: ReactNode;
  /** Drop the artist sub-line where the page's own credit already says it -
   *  an album by one artist repeating that artist down every row. */
  hideArtistWhen?: (track: Track) => boolean;
}

/** An arriving download, as a ghost. Keeps `incoming` the prop it always was
 *  while the mechanism underneath serves everybody. */
function ghostOfIncoming(t: IncomingTrack): GhostRow {
  return {
    key: t.key,
    title: t.title,
    artwork: t.artwork,
    note: incomingStatus(t),
    lead: (
      <span className="incomingCell__mark" aria-hidden>
        {t.progress != null ? (
          <span
            className="incomingCell__ring"
            style={{ ['--p' as string]: `${Math.round(t.progress * 100)}%` }}
          />
        ) : (
          <span className="artistAlbumSpin" data-still={t.stalled || undefined} />
        )}
      </span>
    ),
    action: (
      <>
        {t.onRetry && (
          <button
            type="button"
            className="incomingCell__act"
            aria-label={`Try downloading ${t.title} again`}
            onClick={(e) => {
              e.stopPropagation();
              t.onRetry?.();
            }}
          >
            <RotateCcw size={15} />
          </button>
        )}
        {t.onCancel && (
          <button
            type="button"
            className="incomingCell__act"
            aria-label={`Stop waiting for ${t.title}`}
            onClick={(e) => {
              e.stopPropagation();
              t.onCancel?.();
            }}
          >
            <X size={15} />
          </button>
        )}
      </>
    ),
  };
}

/**
 * Give a resolved column a second life for rows that are not songs here.
 *
 * A real row falls straight through to the column's own renderer; a ghost (id
 * `ghost:<key>`) gets the cell that fits its column. Everything a ghost cannot
 * answer - album, date, on-device - draws nothing, exactly as a blank should.
 *
 * Wrapped here, once, so no column definition above has to know ghosts exist.
 */
export function wrapGhostCell(
  col: DataGridColumn,
  ghostById: Map<string, GhostRow>,
): DataGridColumn {
  const base = col.render;
  return {
    ...col,
    render: (row, rowIndex) => {
      const g = ghostById.get(row.id as string);
      if (!g) return base ? base(row, rowIndex) : (row[col.key] as ReactNode);
      // A heading owns the row. It draws in the TITLE cell rather than a
      // spanning one because the grid has no concept of a spanning cell -
      // and the title is the widest column, so the label lands where the eye
      // already is. Every other cell stays empty.
      if (g.kind === 'heading') {
        return col.key === 'title' ? (
          <span className="songSection">{g.title}</span>
        ) : null;
      }
      switch (col.key) {
        case 'index':
          return g.lead ?? null;
        case 'title':
          return (
            <div className="songTitleCell" data-incoming data-ghost>
              <SongArt artwork={g.artwork ?? null} />
              <div className="songTitleText">
                <span className="songTitle">
                  <span className="songTitle__name">{g.title}</span>
                </span>
                {(g.note || g.artist) && (
                  <span className="songArtist songArtist--status">{g.note ?? g.artist}</span>
                )}
              </div>
            </div>
          );
        case 'duration':
          return g.action ? <span className="incomingCell__actions">{g.action}</span> : null;
        default:
          return null;
      }
    },
  };
}

/** The name this was born with, kept so nothing outside has to change. */
export const wrapIncomingCell = wrapGhostCell;

/** The columns this table has, so `hide` is checked rather than guessed. */
export type SongColumnKey = 'index' | 'title' | 'album' | 'addedAt' | 'onDevice' | 'duration';

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
    sortValue: (row) => sortKey(String(row.title)),
    // Overridden in the component's `columns` memo, which is where the row
    // context (the menu, the artist link, the now-playing mark) is in scope.
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
  defaultSort,
  incoming,
  ghosts,
  shape,
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
  /**
   * Songs on their way in, pinned to the TOP of this same grid.
   *
   * Not a separate card above the table - rows of the table, in its columns,
   * with its hairlines. A song downloading and a song downloaded belong to one
   * list, and when the download lands the ghost simply drops while the real
   * row (already in `tracks` by then) is right there under it: the list flows,
   * nothing hands off between two surfaces. Live rows only - a landed ghost's
   * exit is the arriving real row's own highlight, not a duplicate row.
   */
  incoming?: IncomingTrack[];
  /** Rows that are not songs in this library - see GhostRow. `incoming` is the
   *  same mechanism with a download's clothes on, and the two merge. */
  ghosts?: GhostRow[];
  /** How this page wants the table cut - see SongTableShape. */
  shape?: SongTableShape;
  /**
   * What the table opens sorted by. `null` means "the order I was handed" -
   * which is the right answer whenever the CALLER's order is itself the
   * information: Liked songs arrive newest-heart-first from the server, and
   * an alphabetical default threw that away on arrival. Columns stay sortable
   * either way; this only decides where the table starts.
   */
  defaultSort?: DataGridSort | null;
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
  const [sort, setSort] = useState<DataGridSort | null>(
    defaultSort === undefined ? DEFAULT_SORT : defaultSort,
  );
  /*
   * Adopt a NEW opening order when the caller changes its mind.
   *
   * State initialisers run once per mounted instance, and these pages
   * reconcile rather than remount - AppMain renders one <SongPage> for Liked
   * and All songs with no key between them. So walking Liked (handed order,
   * newest heart first) into All songs kept Liked's `null` and All songs
   * opened unsorted; walking back kept alphabetical. Every page ported onto
   * this table passes `defaultSort={null}` to hold its own running order, so
   * this has to be right or an album inherits whatever the last page chose.
   *
   * Keyed on the VALUE, not the object, so a caller passing a fresh literal
   * each render does not reset a sort the reader chose by clicking a header.
   */
  const wanted = defaultSort === undefined ? DEFAULT_SORT : defaultSort;
  const wantedKey = wanted ? `${wanted.columnKey}:${wanted.direction}` : 'none';
  const lastWanted = useRef(wantedKey);
  useEffect(() => {
    if (lastWanted.current === wantedKey) return;
    lastWanted.current = wantedKey;
    setSort(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key IS the value
  }, [wantedKey]);

  // The grid's rows carry the path as their id; the panel wants the track. One
  // index resolves the one back to the other.
  const onDevice = useOnDevice();
  const justLanded = useJustLanded();
  // The song playing right now, so the row that IS it can light up. Subscribed
  // here (the columns memo below reads it) as well as followed for scroll.
  const nowPlaying = useNowPlayingPath();
  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t] as const)), [tracks]);
  // "on Kevin's server" under the artist, only when more than one server is
  // live - the row's id IS the path, so the origin is free here.
  const originLabel = useOriginLabeler();

  /*
   * The arriving songs, pinned to the top of THIS grid rather than a card
   * above it. Only the LIVE ones - a leaving ghost's exit is the real row's
   * own arrival highlight, so drawing it here too would be the same song
   * twice for a beat. Selection mode drops them: you cannot select a song
   * that is not here yet. Keyed `ghost:<key>` so a render can tell a ghost
   * from a track, and looked up by that id.
   */
  /*
   * Every non-song row this table is drawing, from both doors.
   *
   * `incoming` is downloads, adapted; `ghosts` is whatever the page has -
   * an album's missing tracks, a playlist's wants, a disc break. They merge
   * because from the grid's side they are one thing, and keeping them apart
   * would mean two placement rules and two wrappers.
   *
   * Selecting hides the downloads, as it always did: a ghost cannot be part
   * of a selection, so offering it a checkbox is a lie. Page ghosts are kept -
   * an album's holes are the page, not a transient.
   */
  const ghostList = useMemo<GhostRow[]>(
    () => [
      ...(selecting ? [] : (incoming ?? []).filter((t) => !t.leaving).map(ghostOfIncoming)),
      ...(ghosts ?? []),
    ],
    [incoming, selecting, ghosts],
  );
  const ghostById = useMemo(
    () => new Map(ghostList.map((g) => [`ghost:${g.key}`, g] as const)),
    [ghostList],
  );

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
          (!narrow || !NARROW_HIDDEN.has(col.key)) &&
          // ...and whatever this page has no use for. Same rule as the narrow
          // shed, applied for a different reason: not "no room" but "the page
          // already said it".
          !(shape?.hide ?? []).includes(col.key as SongColumnKey),
      ).map((col): DataGridColumn =>
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
        col.key === 'index' && shape?.lead
          ? {
              ...col,
              // No header: the number means something page-specific (a sleeve
              // position), and "#" over it would invite a sort that
              // `fixedOrder` has already taken away.
              render: (row, rowIndex) => {
                const t = byPath.get(row.id as string);
                return t ? <span className="songMuted">{shape.lead!(t, rowIndex)}</span> : null;
              },
            }
          : col.key === 'index' && plays
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
                  // 20, not the 15 it launched at: in its own 3.5rem column
                  // the mark is the cell's entire content, and at 15px it
                  // read as a speck rather than an answer.
                  <CircleCheck size={20} className="songLocal" aria-label="On this device" />
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
              render: (row) => {
                const current = (row.id as string) === nowPlaying;
                return (
                <SongTitleMenu track={byPath.get(row.id as string) ?? null}>
                  <div
                    className="songTitleCell"
                    data-nowplaying={current || undefined}
                    // Announces the playing row to assistive tech - the bars are
                    // aria-hidden decoration and lean on this, the same contract
                    // RowMain holds for playlist rows.
                    aria-current={current ? 'true' : undefined}
                    data-arriving={
                      justLanded.has(identityKey(row.artist as string, row.title as string)) || undefined
                    }
                  >
                    <span className="songTitleCell__art">
                      <SongArt artwork={row.artwork as string | null} />
                      {current && (
                        <span className="songTitleCell__nowPlaying">
                          <NowPlayingBars />
                        </span>
                      )}
                    </span>
                    <div className="songTitleText">
                      {/* The on-device mark used to hang here, beside the
                          name. It has moved out into a column of its own, which
                          says the same thing and can also be scanned and sorted;
                          two copies of it on one row was just noise. */}
                      <span className="songTitle">
                        <span className="songTitle__name">{row.title as string}</span>
                      </span>
                      {/* The credit, unless the page IS the credit. An album
                          by one artist repeating that artist down every row is
                          the same word twelve times under a heading that
                          already said it; a guest track still shows, which is
                          the one time the line carries news. */}
                      {shape?.hideArtistWhen?.(byPath.get(row.id as string)!) ? null : onOpenArtist ? (
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
                      {originLabel(originFromPath(row.id as string)) && (
                        <span className="songOrigin">{originLabel(originFromPath(row.id as string))}</span>
                      )}
                    </div>
                  </div>
                </SongTitleMenu>
                );
              },
            }
          : col,
      )
        // The arriving rows share these columns, so each cell learns to draw
        // a ghost: the leading column carries its progress ring in place of a
        // number, the title carries its name and a line saying why it waits,
        // the length column carries its actions (cancel, or retry when the
        // job failed), and the rest stay blank. Wrapped here, once, so no
        // column definition above has to know incoming rows exist.
        // A page whose order IS its content takes the sort controls away. Done
        // here rather than per-column so no column can be missed.
        .map((col): DataGridColumn => (shape?.fixedOrder ? { ...col, sortable: false } : col))
        // The row's own verb, last. Appended before the ghost wrap below so it
        // learns to draw a ghost's action too - which is how an album's
        // missing track gets its Add button in the same slot.
        .concat(
          shape?.action
            ? [
                {
                  key: 'rowAction',
                  header: shape.action.header ?? '',
                  width: shape.action.width ?? '3rem',
                  sortable: false,
                  render: (row) => {
                    const t = byPath.get(row.id as string);
                    return t ? shape.action!.render(t) : null;
                  },
                },
              ]
            : [],
        )
        /*
         * Leave exactly one column without a declared width.
         *
         * The kit only reaches for `width: calc(...)` when EVERY column
         * declares one, and then the table stops filling its pane and every
         * row ends in dead space. Normally the title's 50% is a floor and
         * `album` is the flexible one - but a page that hides `album` (an
         * album page: the column would be its own name, over and over) takes
         * the last width-less column away without meaning to.
         *
         * So this is checked rather than remembered. If nothing is flexible,
         * the title gives its width up, which is the same escape narrow mode
         * already uses.
         */
        .map((col, _i, all): DataGridColumn =>
          col.key === 'title' && all.every((c) => c.width !== undefined)
            ? { ...col, width: undefined }
            : col,
        )
        .map((col) => wrapGhostCell(col, ghostById)),
    // onDevice belongs here and was missing: the columns READ it, so without it
    // a download landing rebuilt nothing and the mark only appeared later, when
    // some unrelated dependency happened to change.
    [onOpenArtist, narrow, byPath, plays, onDevice, justLanded, ghostById, originLabel, nowPlaying, shape],
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
    /*
     * `columns`, not the static COLUMNS.
     *
     * The memo above is where a column's real behaviour lives - the static
     * list is a skeleton whose renderers and comparators are rewritten there.
     * Resolving here against the skeleton meant reading a `sortValue` that
     * only the memo defines: the on-device column has one there (:sortValue,
     * "what do I already have" first) and none in the static list, so
     * clicking that header re-sorted the GRID and left `displayed` - and
     * therefore the play queue - in the previous order. The two disagreed
     * silently, which is the worst way for a queue to be wrong.
     */
    const col = columns.find((c) => c.key === sort.columnKey);
    if (!col) return tracks;
    const accessor = col.sortValue ?? ((row: DataGridRow) => row[sort.columnKey] as string | number);
    const dir = sort.direction === 'asc' ? 1 : -1;
    return tracks
      .map((track, index) => ({ track, row: rows[index]! }))
      .sort((a, b) => gridCompare(accessor(a.row), accessor(b.row)) * dir)
      .map((pair) => pair.track);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows derives from tracks
  }, [tracks, sort, columns]);

  // Warm the thumbs for the top of the list as it stands, so the first
  // screenful is already held rather than each row fetching as it scrolls in.
  // Re-runs on a re-sort, which is exactly when the top of the list changes.
  usePrefetchArt(displayed.map((t) => artSized(t.artwork, 160)));

  /*
   * The grid's data, in the exact order it is shown: arriving songs pinned to
   * the top, then the library in the sorted order computed above. The grid is
   * told `manualSort` so it renders this order verbatim and never re-sorts the
   * ghosts down into the list - it still reports header clicks, which drive the
   * `sort` that `displayed` reads. One list, one set of hairlines, the arriving
   * rows part of it rather than a card floating over it.
   */
  const ghostGridRows = useMemo<DataGridRow[]>(
    () =>
      ghostList.map((g) => ({
        id: `ghost:${g.key}`,
        title: g.title,
        artist: g.artist ?? '',
        album: '',
        addedAt: 0,
        duration: null,
        artwork: g.artwork ?? null,
      })),
    [ghostList],
  );
  const displayedRows = useMemo<DataGridRow[]>(
    () =>
      displayed.map((track) => ({
        id: track.path,
        title: track.title,
        artist: track.artist,
        album: track.album,
        addedAt: track.addedAt,
        duration: track.duration,
        artwork: track.artwork,
      })),
    [displayed],
  );
  const gridData = useMemo(
    () => {
      if (!ghostGridRows.length) return displayedRows;
      /*
       * Where each ghost sits.
       *
       * A ghost with `at` has asked for a seat in the list - an album's
       * missing track 3 belongs between 2 and 4, or the running order it is
       * standing in stops being a running order. A ghost without one is a
       * transient (a download on its way) and belongs at the top where it can
       * be watched.
       *
       * The seat is only honourable while the table is in its handed order.
       * Under a sort there is nothing to take a seat in: a row with no album
       * and no date cannot be placed among rows that have them, and guessing
       * would put it somewhere that looks deliberate and is not. Those go to
       * the top band with the transients, which is at least honest about
       * being outside the ordering.
       */
      const byIndex = new Map<string, number>(ghostList.map((g, i) => [`ghost:${g.key}`, i]));
      const pinned: DataGridRow[] = [];
      const seated: { at: number; row: DataGridRow }[] = [];
      for (const row of ghostGridRows) {
        const at = sort === null ? ghostList[byIndex.get(row.id as string) ?? 0]?.at : undefined;
        if (typeof at === 'number') seated.push({ at, row });
        else pinned.push(row);
      }
      if (!seated.length) return [...pinned, ...displayedRows];
      // Descending, so each splice leaves the earlier seats where they were.
      seated.sort((a, b) => b.at - a.at);
      const out = [...displayedRows];
      for (const { at, row } of seated) out.splice(Math.max(0, Math.min(at, out.length)), 0, row);
      return [...pinned, ...out];
    },
    [ghostGridRows, ghostList, displayedRows, sort],
  );

  // Follow the playing song into view when it changes - see the hook.
  const rootRef = useRef<HTMLDivElement>(null);
  useFollowNowPlaying(rootRef, '.songTitleCell[data-nowplaying]');

  /*
   * Draw a screenful, then more as the foot comes near.
   *
   * The kit's grid renders every row it is handed, and All songs is thousands -
   * so opening it built the whole library at once and the page locked up for a
   * beat before a finger could touch it. Only FLOW mode is virtualised: there
   * the page itself is the scroller, so the grid is fed just the rows scrolled
   * to so far and a sentinel at the foot pulls the next block in as it nears the
   * bottom. A non-flow table is a bounded shelf inside its own small viewport -
   * short by construction, nothing to window - so it is left whole.
   *
   * `limit` only ever climbs, so a row once drawn stays drawn: scrolling back up
   * never blanks, and a re-sort keeps whatever was on screen rendered.
   */
  const [limit, setLimit] = useState(FLOW_INITIAL);
  const windowed = flow && gridData.length > limit;
  const shown = useMemo(
    () => (windowed ? gridData.slice(0, limit) : gridData),
    [windowed, gridData, limit],
  );
  const moreRef = useRef<HTMLDivElement>(null);
  // Read inside the listeners without re-binding them per growth.
  const gridLenRef = useRef(gridData.length);
  gridLenRef.current = gridData.length;
  useEffect(() => {
    if (!windowed) return;
    const el = moreRef.current;
    if (!el) return;
    const root = scrollParent(el);
    const grow = () => setLimit((l) => (l < gridLenRef.current ? l + FLOW_STEP : l));

    // Two triggers on purpose. The observer is the clean one - it fires as the
    // foot nears the viewport with a screenful of lead time. But some webviews
    // throttle IntersectionObserver hard when the page is not frontmost (this
    // app keeps running there for playback), and being stranded at eighty rows
    // with no way to scroll further is a far worse bug than the lag this fixes.
    // So a plain scroll listener with a near-bottom check backs it up; the
    // growing scroll height makes each one fire about once per screenful, so
    // the pair never runs away.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) grow();
      },
      { root, rootMargin: '800px 0px' },
    );
    io.observe(el);

    const scroller: Element | null = root ?? document.scrollingElement;
    const onScroll = () => {
      if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 800) {
        grow();
      }
    };
    const target: EventTarget = root ?? window;
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      io.disconnect();
      target.removeEventListener('scroll', onScroll);
    };
  }, [windowed]);
  // Keep the playing song drawn as autoplay walks INTO the next block, so its
  // highlight does not wink out the moment the queue crosses the foot of what
  // has been drawn. Bounded to one block past the edge on purpose: a skip to a
  // song a thousand rows down must NOT drag every row up to it into the DOM -
  // that is the very lag this windowing exists to prevent. Such a far jump just
  // has no highlight until it is scrolled to, which is where it draws anyway.
  useEffect(() => {
    if (!flow || !nowPlaying) return;
    const i = gridData.findIndex((r) => r.id === nowPlaying);
    if (i >= limit && i < limit + FLOW_STEP) setLimit((l) => l + FLOW_STEP);
  }, [flow, nowPlaying, gridData, limit]);

  return (
    <SongSelectionContext.Provider value={selectionEntry}>
    {/* display:contents: the wrapper is only a ref to scope the now-playing
        query to THIS table, and generates no box, so the grid stays the flex
        child its layout expects. */}
    <div ref={rootRef} style={{ display: 'contents' }}>
    <DataGrid
      aria-label="Songs"
      {...hold}
      className={flow ? 'songTable songTable--flow' : 'songTable'}
      columns={columns}
      data={shown}
      sort={sort}
      onSortChange={setSort}
      // The data is handed over already in sort order (displayed), with the
      // arriving rows pinned ahead of it - so the grid renders it verbatim and
      // its own sorter never pulls a ghost down among the songs.
      manualSort
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
      // A page that is not the library says its own sentence: "nothing in this
      // playlist yet" rather than something about a music folder.
      emptyState={
        shape?.empty ??
        (library.source === 'server'
          ? library.error ?? 'Nothing on the server yet — upload some music from the desktop app.'
          : hasLocalLibrary
            ? 'No music found in your library folder yet.'
            : 'Connect to your music server in Settings to start listening.')
      }
      selectable={selecting}
      selectedIds={selected ?? undefined}
      onSelectionChange={(ids) => setSelected(ids.map(String))}
      // The row id is the track's path; hand the matching track up to play it,
      // with the displayed order alongside as the queue it plays through. In
      // selection mode the same tap toggles membership instead.
      onRowActivate={(id) => {
        // A ghost is not a track: tapping one does nothing but wait with you.
        if (typeof id === 'string' && id.startsWith('ghost:')) return;
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
    {/* The foot the observer watches: when it nears the viewport, the next
        block of rows is drawn. Present only while there is more to draw. */}
    {windowed && <div ref={moreRef} aria-hidden style={{ height: 1 }} />}
    </div>
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
