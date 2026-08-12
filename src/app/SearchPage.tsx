import { SearchField, Text } from '@glacier/react';
import {
  Check,
  ChevronRight,
  Compass,
  Disc3,
  ListEnd,
  ListMusic,
  ListStart,
  Music,
  Play,
  Plus,
  Quote,
  Search,
  Tag,
  User,
  Users,
  X,
} from '@glacier/icons';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useLibrary } from './library.tsx';
import { useRippleWave } from './rippleWave.ts';
import { usePlaylists, type Playlist } from './playlists.tsx';
import { useQueueControls } from './queueControls.tsx';
import { useRegistry } from './registrySession.tsx';
import { useServerSession } from './serverSession.tsx';
import { artworkUrl, genreArtwork } from './artwork.ts';
import { IMPORTER_PLUGIN_ID, usePluginCommands, useAcquire } from '../plugins/runtime.tsx';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';
import { PROBE_URL, importable, resolveImportable } from './resolveImport.ts';
import type { AcquireTarget } from '../plugins/types.ts';
import {
  lyricExcerpt,
  parseQuery,
  searchLibrary,
  type LocalAlbum,
  type LocalArtist,
  type LocalGenre,
  type Why,
} from './trackSearch.ts';
import { useOwned } from './owned.ts';
import { useSearchRecents, type Recent } from './searchRecents.ts';
import { fetchFriends, type RegistryFriend } from './registry.ts';
import { artSized, searchCatalog, type SearchResult } from './server.ts';
import { mosaicArts, useArtLoad, useTileArt } from './artLoad.ts';
import { TrackMenu } from './TrackMenu.tsx';
import { EmptyArt } from './EmptyArt.tsx';
import type { Track } from './tauri.ts';

/**
 * Search, as a place you go rather than a sheet over where you were.
 *
 * It was a modal, which is the right shape for a command palette - open it,
 * pick one thing, it closes - and the wrong shape for what this had become.
 * Once search answered from seven sources at once, people wanted to READ the
 * results: scroll them, narrow them, come back to them.
 *
 * The page wears three faces:
 *
 *   - Nothing typed: what you opened last time, and the genres your own
 *     library is made of. A search box that answers before you ask it is the
 *     difference between a tool and a chore.
 *   - Typing: a Top result beside the songs it beat, then a section per kind -
 *     artists, albums, playlists, genres, friends, and the catalogue you could
 *     add from. Each section shows a handful behind a See all that promotes it
 *     to the whole page.
 *   - Claimed: a plugin recognised the query outright (a pasted link is an
 *     action, not a search), and only its commands show.
 *
 * Everything local is answered from memory by `searchLibrary` - the whole
 * library index is already resident, so a keystroke never waits on a disk or a
 * wire, and the server's own FTS index exists for clients that do not hold one.
 * Only the catalogue is remote here, debounced behind everything else, so the
 * page is useful long before it lands.
 *
 * Keyboard: the field never gives up focus. Arrowing moves a cursor through the
 * results while you keep typing (this is a combobox, not a listbox you fall
 * into), Enter takes the row's main door, and Q/N/A are the verbs of whatever
 * row the cursor is on.
 */

/** The id ⌘K and the arrow keys work against. */
const FIELD_ID = 'searchPageField';

/** How much of a section shows before it needs a See all. */
const COLLAPSED = 4;
/** And how much a promoted section shows. */
const EXPANDED = 60;
/** Songs shown beside the Top result. */
const BESIDE = 4;
/** Genre tiles the empty page offers to browse. */
const BROWSE = 12;

/** Joins the two halves of an album's identity. A control character, because
 *  any printable separator is something a real album title contains. */
const SEP = '\u001f';

type Filter =
  | 'all'
  | 'mine'
  | 'songs'
  | 'artists'
  | 'albums'
  | 'playlists'
  | 'genres'
  | 'friends'
  | 'catalog';

/** Scopes answer "where from"; kinds answer "what". They share one row with a
 *  rule between them, so it reads as two questions rather than nine chips.
 *  The group travels with the chip because chips drop out when a query has
 *  nothing for them - the rule has to follow the last surviving scope, not a
 *  fixed index into a list that no longer looks like this one. */
const CHIPS: { id: Filter; label: string; icon: ReactNode; group: 'scope' | 'kind' }[] = [
  { id: 'all', label: 'All', icon: <Search size={13} />, group: 'scope' },
  { id: 'mine', label: 'Yours', icon: <Check size={13} />, group: 'scope' },
  { id: 'catalog', label: 'To add', icon: <Compass size={13} />, group: 'scope' },
  { id: 'songs', label: 'Songs', icon: <Music size={13} />, group: 'kind' },
  { id: 'artists', label: 'Artists', icon: <User size={13} />, group: 'kind' },
  { id: 'albums', label: 'Albums', icon: <Disc3 size={13} />, group: 'kind' },
  { id: 'playlists', label: 'Playlists', icon: <ListMusic size={13} />, group: 'kind' },
  { id: 'genres', label: 'Genres', icon: <Tag size={13} />, group: 'kind' },
  { id: 'friends', label: 'Friends', icon: <Users size={13} />, group: 'kind' },
];

/* -------------------------------------------------------------------- items */

/**
 * One thing on the page, whatever kind it is. Sections hold these and the
 * keyboard layer walks them flat, so the order you arrow through is the order
 * you read - by construction, rather than by two lists agreeing.
 */
type Item =
  | { t: 'action'; id: string; label: string; group?: string; run: () => void }
  | { t: 'song'; id: string; track: Track; why: Why }
  | { t: 'artist'; id: string; artist: LocalArtist }
  | { t: 'album'; id: string; album: LocalAlbum }
  | { t: 'playlist'; id: string; playlist: Playlist }
  | { t: 'genre'; id: string; genre: LocalGenre }
  | { t: 'friend'; id: string; friend: RegistryFriend }
  | { t: 'catalog'; id: string; result: SearchResult; mine: Track | null };

interface Section {
  /** The chip its See all turns on. */
  key: Filter;
  title: string;
  icon: ReactNode;
  /** How many exist, which is what the count beside the heading says. */
  total: number;
  items: Item[];
}

/** What an importer would be handed for a catalogue row. */
function targetOf(result: SearchResult): AcquireTarget {
  return {
    kind: result.kind === 'album' ? 'album' : 'track',
    title: result.title,
    artist: result.subtitle,
    url: result.url,
  };
}

/** The key an album is filed under: title AND artist, so two records called
 *  "Greatest Hits" stay two records. */
const albumKey = (album: { title: string; artist: string }): string =>
  `${album.title}${SEP}${album.artist}`;

function kindWord(kind: SearchResult['kind']): string {
  return kind === 'artist' ? 'Artist' : kind === 'album' ? 'Album' : 'Song';
}

/** A stable hue per name, so "Shoegaze" is the same colour every time it is
 *  drawn without anybody keeping a table of genres. */
function hueOf(name: string): CSSProperties {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return { '--searchTileHue': `${h}` } as CSSProperties;
}

/** Up to four covers from a playlist's tracks, for its mosaic. */
function coversOf(playlist: Playlist, tracks: readonly Track[]): string[] {
  const want = new Set(playlist.paths);
  const out: string[] = [];
  for (const t of tracks) {
    if (out.length === 4) break;
    if (want.has(t.path) && t.artwork) out.push(t.artwork);
  }
  return out;
}

/* --------------------------------------------------------------------- bits */

/** A section's heading: its glyph, its name, how many it found, and - when it
 *  is showing fewer than it has - the way to see the rest. */
function Heading({
  icon,
  children,
  count,
  onSeeAll,
}: {
  icon: ReactNode;
  children: ReactNode;
  count?: number;
  onSeeAll?: () => void;
}) {
  return (
    <h2 className="searchSection__title">
      <span className="searchSection__glyph" aria-hidden>
        {icon}
      </span>
      {children}
      {count !== undefined && <span className="searchSection__count">{count}</span>}
      {onSeeAll && (
        <button type="button" className="searchSeeAll" onClick={onSeeAll}>
          See all
          <ChevronRight size={14} />
        </button>
      )}
    </h2>
  );
}

/**
 * The artwork square, in the shape its kind wears everywhere else in the app:
 * people are round, songs and albums are squares, a playlist is a soft-cornered
 * mosaic of what is in it, and a genre is a tinted tile. Shape is how you tell
 * what a row IS before you have read a word of it, which is the entire point of
 * putting eight kinds of thing on one page.
 */
function Glyph({
  shape,
  cover,
  covers,
  fallback,
  tint,
}: {
  shape: 'circle' | 'square' | 'mosaic' | 'tile';
  cover?: string | null;
  /** Up to four, for the mosaic. */
  covers?: readonly string[];
  fallback: ReactNode;
  /** Seeds the tile's gradient, so one genre keeps one colour. */
  tint?: string;
}) {
  // Both loaders run for every shape - a glyph can change face as results
  // refine, and the hook order has to survive that. A mosaic skeletons and
  // reveals as one artwork; a single cover is a row thumb, so the 160 variant.
  const four = shape === 'mosaic' ? mosaicArts(covers ?? []) : [];
  const { loaded: tiled, hostRef: tileRef } = useTileArt(four);
  const sized = shape === 'mosaic' || shape === 'tile' ? null : artSized(cover ?? null, 160);
  const art = useArtLoad(sized, '');
  // A genre with a generated object wears it over the gradient; the tint
  // stays beneath as the loading face and the fallback for unmapped genres -
  // and for a served object that fails to arrive.
  const { session: glyphServer } = useServerSession();
  const [tileDead, setTileDead] = useState(false);
  const tileSlug = shape === 'tile' && tint ? genreArtwork(tint) : null;
  const tileSrc = tileSlug && glyphServer && !tileDead ? artworkUrl(glyphServer, tileSlug) : null;
  const tileLoad = useArtLoad(tileSrc, '');
  if (shape === 'mosaic') {
    return (
      <span className="searchRow__glyph" data-shape="mosaic">
        {four.length > 0 ? (
          <span
            ref={tileRef}
            className="searchMosaic"
            data-n={four.length}
            data-tile-pop=""
            data-tile-loading={!tiled || undefined}
          >
            {four.map((c, i) => (
              <img key={`${c}:${i}`} src={c} alt="" loading="lazy" />
            ))}
          </span>
        ) : (
          fallback
        )}
      </span>
    );
  }
  if (shape === 'tile') {
    return (
      <span className="searchRow__glyph" data-shape="tile" style={hueOf(tint ?? '')}>
        {tileSrc ? (
          <img
            {...tileLoad}
            src={tileSrc}
            alt=""
            loading="lazy"
            onError={() => {
              tileLoad.onError();
              setTileDead(true);
            }}
          />
        ) : (
          fallback
        )}
      </span>
    );
  }
  return (
    <span className="searchRow__glyph" data-shape={shape}>
      {sized ? <img {...art} src={sized} alt="" loading="lazy" /> : fallback}
    </span>
  );
}

/** A Browse tile's cover, split out of the map so each tile owns its own
 *  skeleton hook. Tiles are grid-sized, so the 640 variant. `raw` is a served
 *  generated object: no size variants, and it IS the tile face rather than
 *  the corner card the library cover plays. A served object that fails (an
 *  old server, a missing piece) steps down to the library cover rather than
 *  leaving a broken image on the tile. */
function GenreArt({ src, raw, fallback }: { src: string; raw?: boolean; fallback?: string | null }) {
  const [dead, setDead] = useState(false);
  const object = raw && !dead;
  const active = raw && dead ? (fallback ?? null) : src;
  const sized = active === null ? null : object ? active : artSized(active, 640);
  const art = useArtLoad(sized, object ? 'searchGenre__objectArt' : 'searchGenre__art');
  if (sized === null) return null;
  return (
    <img
      {...art}
      src={sized}
      alt=""
      loading="lazy"
      onError={() => {
        art.onError();
        if (object) setDead(true);
      }}
    />
  );
}

/** What a song row says under its title: normally the artist, but when the
 *  match came from the lyrics, the line that matched - because "why is this
 *  here" is the question a lyric hit always raises. */
function SongSub({ track, why, query }: { track: Track; why: Why; query: string }) {
  const line = why === 'lyrics' ? lyricExcerpt(track, query) : null;
  if (line) {
    return (
      <span className="searchRow__sub" data-lyric>
        <Quote size={11} aria-hidden />
        <span className="searchRow__lyric">{line}</span>
      </span>
    );
  }
  return (
    <span className="searchRow__sub">
      Song · {track.artist}
      {track.lossless && <span className="searchQuality">Lossless</span>}
    </span>
  );
}

/* --------------------------------------------------------------------- page */

export function SearchPage({
  onPlay,
  onOpenArtist,
  onOpenPlaylist,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenPlaylist: (id: string) => void;
}) {
  const { tracks } = useLibrary();
  const { playlists } = usePlaylists();
  // Results, genre tiles and recents wave in as they meet the view, landing
  // with the same soft ticks the Library's shelves ride - see rippleWave.ts.
  // Rows React reuses across keystrokes keep their landed state; only truly
  // NEW results ripple, so typing refines rather than re-parades.
  const rippleRoot = useRef<HTMLDivElement>(null);
  useRippleWave(rippleRoot);
  const { session: registry } = useRegistry();
  const { session: server } = useServerSession();
  const owned = useOwned();
  const queue = useQueueControls();
  const acquire = useAcquire();
  const downloads = useDownloadsOptional();
  const recents = useSearchRecents();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [friends, setFriends] = useState<RegistryFriend[]>([]);
  // null while the catalogue fetch for a query is in flight, [] when it came
  // back empty.
  const [catalog, setCatalog] = useState<SearchResult[] | null>(null);
  // Which row the keyboard is on, as an index into the flat item list; -1 is
  // "none". The field keeps DOM focus throughout, so typing never stops.
  const [cursor, setCursor] = useState(-1);
  // What a tapped catalogue row is doing. An album usually reaches us as a
  // Deezer link the importer will not take, so the tap looks for its Spotify
  // twin first - a beat of network that has to be visible on the row.
  const [adding, setAdding] = useState<Record<string, 'finding' | 'added' | 'missing'>>({});

  // ⌘K from anywhere reaches this tab (App handles that); pressed while already
  // here it should put the caret back in the field and select what is there, so
  // the chord always means "search for something else".
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      const field = document.getElementById(FIELD_ID);
      if (field instanceof HTMLInputElement) {
        event.preventDefault();
        field.focus();
        field.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The friends list once, on arrival: it is small, and a search that waited on
  // the network for a local answer would be a slower search for no gain.
  useEffect(() => {
    if (!registry) return;
    let live = true;
    void fetchFriends(registry.token)
      .then((feed) => live && setFriends(feed.friends))
      .catch(() => live && setFriends([]));
    return () => {
      live = false;
    };
  }, [registry]);

  // The catalogue, debounced - a fresh keystroke cancels the pending fetch and
  // aborts one already in flight, so only the last query in a burst is sent.
  const serverRef = useRef(server);
  serverRef.current = server;
  useEffect(() => {
    const q = query.trim();
    const s = serverRef.current;
    if (!q || !s) {
      setCatalog(null);
      return;
    }
    setCatalog(null);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void searchCatalog(s, q, ctrl.signal)
        .then(setCatalog)
        .catch(() => {
          if (!ctrl.signal.aborted) setCatalog([]);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const plugin = usePluginCommands({ query, close: () => setQuery('') });

  const parsed = useMemo(() => parseQuery(query), [query]);
  const lib = useMemo(() => searchLibrary(tracks, query), [tracks, query]);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    if (!q) return [];
    return friends.filter((f) => f.handle.toLowerCase().includes(q));
  }, [friends, query]);

  const lists = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return playlists.filter((p) => p.name.toLowerCase().includes(q));
  }, [playlists, query]);

  // A catalogue row whose copy is already listed above would be the same song
  // twice; it stands aside. Matched through the library index, so a row goes
  // only when the very track it resolves to is one of the ones shown.
  const shown = useMemo(() => new Set(lib.songs.map((s) => s.track.path)), [lib.songs]);
  const outside = useMemo(
    () =>
      (catalog ?? []).filter((r) => {
        if (r.kind !== 'track') return true;
        const mine = owned.find(r.subtitle, r.title);
        return !mine || !shown.has(mine.path);
      }),
    [catalog, owned, shown],
  );

  const searching = parsed.active;
  const claimed = plugin.exclusive;

  /* -------------------------------------------------------------- verbs --- */

  const touch = recents.touch;
  const songQueue = useMemo(() => lib.songs.map((s) => s.track), [lib.songs]);

  const open = useCallback(
    (item: Item) => {
      switch (item.t) {
        case 'action':
          item.run();
          break;

        case 'song':
          touch({
            kind: 'track',
            key: item.track.path,
            title: item.track.title,
            subtitle: item.track.artist,
            cover: null,
            url: '',
          });
          onPlay(item.track, songQueue);
          break;

        case 'artist':
          touch({
            kind: 'artist',
            key: item.artist.name,
            title: item.artist.name,
            subtitle: 'Artist',
            cover: null,
            url: '',
          });
          onOpenArtist(item.artist.name);
          break;

        case 'album': {
          const [first] = item.album.tracks;
          if (!first) break;
          touch({
            kind: 'album',
            key: albumKey(item.album),
            title: item.album.title,
            subtitle: item.album.artist,
            cover: null,
            url: '',
          });
          onPlay(first, item.album.tracks);
          break;
        }

        case 'playlist':
          touch({
            kind: 'playlist',
            key: item.playlist.id,
            title: item.playlist.name,
            subtitle: 'Playlist',
            cover: null,
            url: '',
          });
          onOpenPlaylist(item.playlist.id);
          break;

        case 'genre':
          touch({
            kind: 'genre',
            key: item.genre.name,
            title: item.genre.name,
            subtitle: 'Genre',
            cover: null,
            url: '',
          });
          // Drilling into a genre is only a narrower search, so it becomes one:
          // the operator lands in the field where it can be read and edited.
          setQuery(`genre:"${item.genre.name}"`);
          setFilter('all');
          break;

        case 'friend':
          break;

        case 'catalog': {
          // An artist is a place to go, not a thing to fetch: the artist page
          // loads their whole catalogue profile by name, so it reads properly
          // even for someone you own nothing by.
          if (item.result.kind === 'artist') {
            touch({
              kind: 'artist',
              key: item.result.title,
              title: item.result.title,
              subtitle: 'Artist',
              cover: null,
              url: '',
            });
            onOpenArtist(item.result.title);
            break;
          }
          touch({
            kind: 'catalog',
            key: item.result.id,
            title: item.result.title,
            subtitle: item.result.subtitle,
            cover: item.result.cover,
            url: item.result.url,
          });
          void acquireResult(item.result);
          break;
        }
      }
    },
    [acquire, onOpenArtist, onOpenPlaylist, onPlay, songQueue, touch],
  );

  /**
   * Pull a catalogue row.
   *
   * A track from `/api/search` already carries a Spotify link (the server drops
   * the ones that do not), but an ALBUM usually arrives from Deezer, which the
   * importer refuses as primary input - so those are looked up by name first.
   * Either way the link goes down the importer's own queue when it is running:
   * a tap on Add should start a download, not open a chooser.
   */
  const acquireResult = async (r: SearchResult) => {
    if (adding[r.id]) return;
    const kind = r.kind === 'album' ? 'album' : 'track';
    const hand = (title: string, url: string) => {
      const target: AcquireTarget = { kind, title, artist: r.subtitle, url };
      const viaImporter = acquire.handlersFor(target).some((h) => h.pluginId === IMPORTER_PLUGIN_ID);
      if (viaImporter && downloads) void downloads.enqueue(url).catch(() => {});
      else acquire.acquire(target);
    };

    if (importable(r)) {
      hand(r.title, r.url);
      setAdding((prev) => ({ ...prev, [r.id]: 'added' }));
      return;
    }
    if (!server) return;
    setAdding((prev) => ({ ...prev, [r.id]: 'finding' }));
    let found = null;
    try {
      found = await resolveImportable(server, kind, r.subtitle, r.title);
    } catch {
      // Offline or refused; the row cannot tell the difference from absent.
    }
    if (!found) {
      setAdding((prev) => ({ ...prev, [r.id]: 'missing' }));
      window.setTimeout(
        () =>
          setAdding((prev) => {
            const next = { ...prev };
            delete next[r.id];
            return next;
          }),
        4000,
      );
      return;
    }
    hand(found.title, found.url);
    setAdding((prev) => ({ ...prev, [r.id]: 'added' }));
  };

  /* ----------------------------------------------------------- sections --- */

  /** True while the page is showing everything rather than one promoted kind. */
  const wide = filter === 'all' || filter === 'mine';
  const cap = (key: Filter) => (filter === key ? EXPANDED : COLLAPSED);
  /** Whether a section shows at all under the current chip. */
  const on = (key: Filter): boolean => {
    if (filter === 'all') return true;
    if (filter === 'mine') return key !== 'catalog';
    return filter === key;
  };

  // The one thing the query most likely meant. An artist or album whose NAME is
  // what was typed beats any song, because somebody typing "in rainbows" wants
  // the record, not its fourth track; failing that, the best song wins.
  const top = useMemo<Item | null>(() => {
    const { phrase } = parsed;
    if (!phrase) return null;
    const named = <T,>(list: readonly T[], name: (v: T) => string): T | undefined =>
      list.find((v) => {
        const n = name(v).toLowerCase();
        return n === phrase || n.startsWith(phrase);
      });
    const artist = named(lib.artists, (a) => a.name);
    if (artist) return { t: 'artist', id: `artist:${artist.name}`, artist };
    const album = named(lib.albums, (a) => a.title);
    if (album) return { t: 'album', id: `album:${albumKey(album)}`, album };
    const song = lib.songs[0];
    if (song) return { t: 'song', id: `song:${song.track.path}`, track: song.track, why: song.why };
    const anyArtist = lib.artists[0];
    if (anyArtist) return { t: 'artist', id: `artist:${anyArtist.name}`, artist: anyArtist };
    const anyAlbum = lib.albums[0];
    if (anyAlbum) return { t: 'album', id: `album:${albumKey(anyAlbum)}`, album: anyAlbum };
    return null;
  }, [lib.albums, lib.artists, lib.songs, parsed]);

  // Whether the page is wearing its hero. A query of nothing but operators
  // (`genre:"shoegaze"`) has no free text to be most-likely-about, so there is
  // no Top result and the songs take the page on their own terms instead.
  const heroed = wide && top !== null;

  // Songs beside the hero: the best few that are not already the hero.
  const beside = useMemo<Item[]>(() => {
    if (!heroed) return [];
    return lib.songs
      .filter((s) => !(top?.t === 'song' && top.track.path === s.track.path))
      .slice(0, BESIDE)
      .map<Item>((s) => ({ t: 'song', id: `song:${s.track.path}`, track: s.track, why: s.why }));
  }, [heroed, lib.songs, top]);

  // Deliberately not memoised. A plugin's palette command is rebuilt on every
  // render because it reads the live query - a pasted-link importer's label
  // carries the link and its handler closes over it - so caching these by id
  // would pin both to whatever the query was when the id set last changed.
  const commandItems: Item[] = plugin.commands.map((c) => ({
    t: 'action',
    id: c.id,
    label: c.label,
    group: c.group,
    run: () => plugin.run(c.id),
  }));

  // Likewise plain: these are slices of arrays that are already ranked and
  // memoised, so rebuilding them costs nothing next to what it buys - the
  // command rows above stay current, and the flat walk below cannot fall out of
  // step with what was rendered.
  const sections: Section[] = (() => {
    const out: Section[] = [];
    if (commandItems.length > 0) {
      out.push({
        key: 'all',
        title: 'Actions',
        icon: <Plus size={15} />,
        total: commandItems.length,
        items: commandItems,
      });
    }
    if (claimed) return out;

    // Songs get their own section whenever they are not already living beside
    // the hero - promoted by the Songs chip, or because this query never had a
    // Top result to sit next to.
    if (!heroed && on('songs') && lib.songs.length > 0) {
      out.push({
        key: 'songs',
        title: 'Songs',
        icon: <Music size={15} />,
        total: lib.songs.length,
        items: lib.songs
          .slice(0, filter === 'songs' ? EXPANDED : COLLAPSED + 2)
          .map<Item>((s) => ({ t: 'song', id: `song:${s.track.path}`, track: s.track, why: s.why })),
      });
    }
    if (on('artists') && lib.artists.length > 0) {
      out.push({
        key: 'artists',
        title: 'Artists',
        icon: <User size={15} />,
        total: lib.artists.length,
        items: lib.artists
          .slice(0, cap('artists'))
          .map<Item>((a) => ({ t: 'artist', id: `artist:${a.name}`, artist: a })),
      });
    }
    if (on('albums') && lib.albums.length > 0) {
      out.push({
        key: 'albums',
        title: 'Albums',
        icon: <Disc3 size={15} />,
        total: lib.albums.length,
        items: lib.albums
          .slice(0, cap('albums'))
          .map<Item>((a) => ({ t: 'album', id: `album:${albumKey(a)}`, album: a })),
      });
    }
    if (on('playlists') && lists.length > 0) {
      out.push({
        key: 'playlists',
        title: 'Playlists',
        icon: <ListMusic size={15} />,
        total: lists.length,
        items: lists
          .slice(0, cap('playlists'))
          .map<Item>((p) => ({ t: 'playlist', id: `playlist:${p.id}`, playlist: p })),
      });
    }
    if (on('genres') && lib.genres.length > 0) {
      out.push({
        key: 'genres',
        title: 'Genres',
        icon: <Tag size={15} />,
        total: lib.genres.length,
        items: lib.genres
          .slice(0, cap('genres'))
          .map<Item>((g) => ({ t: 'genre', id: `genre:${g.name}`, genre: g })),
      });
    }
    if (on('friends') && people.length > 0) {
      out.push({
        key: 'friends',
        title: 'Friends',
        icon: <Users size={15} />,
        total: people.length,
        items: people
          .slice(0, cap('friends'))
          .map<Item>((f) => ({ t: 'friend', id: `friend:${f.id}`, friend: f })),
      });
    }
    if (on('catalog') && outside.length > 0) {
      out.push({
        key: 'catalog',
        title: 'To add',
        icon: <Compass size={15} />,
        total: outside.length,
        items: outside.slice(0, filter === 'catalog' ? EXPANDED : COLLAPSED + 2).map<Item>((r) => ({
          t: 'catalog',
          id: `catalog:${r.id}`,
          result: r,
          mine: r.kind === 'track' ? owned.find(r.subtitle, r.title) : null,
        })),
      });
    }
    // The hero already IS one of these, and printing it twice would give the
    // page two rows with one identity - which reads as a stutter and, since the
    // keyboard walk is keyed by that identity, would put one cursor position on
    // two elements at once.
    if (!heroed || !top) return out;
    return out
      .map((s) => {
        const items = s.items.filter((i) => i.id !== top.id);
        return items.length === s.items.length
          ? s
          : { ...s, items, total: Math.max(0, s.total - 1) };
      })
      .filter((s) => s.items.length > 0);
  })();

  /* ----------------------------------------------------------- keyboard --- */

  // A friend row is context rather than a door - there is no per-friend page to
  // open - so it is the only thing the walk skips. A catalogue artist used to
  // be skipped too, back when the artist page could only show what you owned;
  // it now loads a full catalogue profile by name, so it is a real destination
  // whether or not you have a single song of theirs.
  const stepped = (item: Item): boolean => item.t !== 'friend';

  // The flat walk: the hero, the songs beside it, then every section in the
  // order they render. Built from the same arrays the JSX reads, so the two
  // cannot drift apart.
  const walk: Item[] = (() => {
    const flat: Item[] = [];
    if (searching && !claimed && heroed && top) flat.push(top, ...beside);
    for (const s of sections) for (const i of s.items) if (stepped(i)) flat.push(i);
    return flat;
  })();

  const position = new Map<string, number>();
  walk.forEach((item, n) => position.set(item.id, n));

  // A new query is a new set of rows; the cursor cannot survive it.
  useEffect(() => setCursor(-1), [query, filter]);

  const current = cursor >= 0 ? walk[cursor] : undefined;

  const available = useMemo(
    () =>
      CHIPS.filter(({ id }) => {
        if (id === 'all' || id === 'mine') return true;
        if (id === 'songs') return lib.songs.length > 0;
        if (id === 'artists') return lib.artists.length > 0;
        if (id === 'albums') return lib.albums.length > 0;
        if (id === 'playlists') return lists.length > 0;
        if (id === 'genres') return lib.genres.length > 0;
        if (id === 'friends') return people.length > 0;
        return outside.length > 0;
      }),
    [lib, lists, outside, people],
  );

  // A chip the current query has nothing for is not offered - and if it was the
  // one you were standing on, the page falls back rather than showing you an
  // empty section you cannot leave by pressing anything.
  const filterOk = available.some((f) => f.id === filter);
  useEffect(() => {
    if (!filterOk) setFilter('all');
  }, [filterOk]);

  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (walk.length === 0) return;
      event.preventDefault();
      const next = cursor + (event.key === 'ArrowDown' ? 1 : -1);
      // Up from the first row leaves the list rather than wrapping to the
      // bottom: up is where the field is.
      setCursor(next < -1 ? -1 : next >= walk.length ? walk.length - 1 : next);
      return;
    }
    if (event.key === 'Escape') {
      if (cursor >= 0) {
        event.preventDefault();
        setCursor(-1);
      } else if (query) {
        event.preventDefault();
        setQuery('');
      }
      return;
    }
    if (!current || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      open(current);
      return;
    }
    // The row verbs. Bare letters are only safe because they are read solely
    // while the cursor is on a row; with no row they fall through and type.
    const key = event.key.toLowerCase();
    if (current.t === 'song' && (key === 'q' || key === 'n')) {
      event.preventDefault();
      if (key === 'q') queue.addToQueue(current.track);
      else queue.playNext(current.track);
      return;
    }
    if (key === 'a' && current.t === 'catalog') {
      event.preventDefault();
      open(current);
    }
  };

  // The cursor is driven from the field, so the row it lands on has to be
  // scrolled to by hand - nothing focused it.
  useEffect(() => {
    if (cursor < 0) return;
    document.getElementById(`searchHit-${cursor}`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  /* ---------------------------------------------------------------- rows --- */

  /** Rendered as a plain call rather than a component, so a keystroke does not
   *  replace every row's element type - which would drop the open context menu
   *  and reset each row on every letter. */
  const renderRow = (item: Item): ReactNode => {
    const n = position.get(item.id);
    const active = n !== undefined && n === cursor;
    const seat = {
      id: n === undefined ? undefined : `searchHit-${n}`,
      className: 'searchRow',
      role: 'option' as const,
      'aria-selected': active,
      'data-active': active || undefined,
      // The pointer drives the same cursor, so the highlight is never in two
      // places at once.
      onMouseEnter: () => n !== undefined && setCursor(n),
    };

    switch (item.t) {
      case 'action':
        return (
          <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
            <Glyph shape="square" fallback={<Plus size={18} />} />
            <span className="searchRow__text">
              <span className="searchRow__title">{item.label}</span>
              {item.group && <span className="searchRow__sub">{item.group}</span>}
            </span>
            <ChevronRight size={16} className="searchRow__end" />
          </button>
        );

      case 'song':
        return (
          // Long-press or right-click for the same menu every song in the app
          // carries; the two verbs are also spelled out on hover, and on Q/N.
          <TrackMenu key={item.id} track={item.track}>
            <div className="searchRowSeat">
              <button type="button" {...seat} onClick={() => open(item)}>
                <Glyph shape="square" cover={item.track.artwork} fallback={<Music size={18} />} />
                <span className="searchRow__text">
                  <span className="searchRow__title">{item.track.title}</span>
                  <SongSub track={item.track} why={item.why} query={query} />
                </span>
              </button>
              <span className="searchRow__verbs">
                <button
                  type="button"
                  className="searchVerb"
                  title="Play next (N)"
                  aria-label={`Play ${item.track.title} next`}
                  onClick={() => queue.playNext(item.track)}
                >
                  <ListStart size={15} />
                </button>
                <button
                  type="button"
                  className="searchVerb"
                  title="Add to queue (Q)"
                  aria-label={`Add ${item.track.title} to the queue`}
                  onClick={() => queue.addToQueue(item.track)}
                >
                  <ListEnd size={15} />
                </button>
              </span>
            </div>
          </TrackMenu>
        );

      case 'artist':
        return (
          <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
            <Glyph shape="circle" cover={item.artist.cover} fallback={<User size={18} />} />
            <span className="searchRow__text">
              <span className="searchRow__title">{item.artist.name}</span>
              <span className="searchRow__sub">
                Artist · {item.artist.count === 1 ? '1 song' : `${item.artist.count} songs`}
              </span>
            </span>
            <ChevronRight size={16} className="searchRow__end" />
          </button>
        );

      case 'album':
        return (
          <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
            <Glyph shape="square" cover={item.album.cover} fallback={<Disc3 size={18} />} />
            <span className="searchRow__text">
              <span className="searchRow__title">{item.album.title}</span>
              <span className="searchRow__sub">
                Album · {item.album.artist} ·{' '}
                {item.album.count === 1 ? '1 song' : `${item.album.count} songs`}
              </span>
            </span>
            <Play size={16} className="searchRow__end" />
          </button>
        );

      case 'playlist':
        return (
          <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
            <Glyph
              shape="mosaic"
              covers={coversOf(item.playlist, tracks)}
              fallback={<ListMusic size={18} />}
            />
            <span className="searchRow__text">
              <span className="searchRow__title">{item.playlist.name}</span>
              <span className="searchRow__sub">
                Playlist ·{' '}
                {item.playlist.paths.length === 1
                  ? '1 song'
                  : `${item.playlist.paths.length} songs`}
              </span>
            </span>
            <ChevronRight size={16} className="searchRow__end" />
          </button>
        );

      case 'genre':
        return (
          <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
            <Glyph shape="tile" tint={item.genre.name} fallback={<Tag size={18} />} />
            <span className="searchRow__text">
              <span className="searchRow__title">{item.genre.name}</span>
              <span className="searchRow__sub">
                Genre · {item.genre.count === 1 ? '1 song' : `${item.genre.count} songs`}
              </span>
            </span>
            <ChevronRight size={16} className="searchRow__end" />
          </button>
        );

      case 'friend':
        return (
          <div key={item.id} className="searchRow" data-static>
            <Glyph shape="circle" fallback={<Users size={18} />} />
            <span className="searchRow__text">
              <span className="searchRow__title">@{item.friend.handle}</span>
              <span className="searchRow__sub">
                Friend
                {item.friend.songs > 0 ? ` · ${item.friend.songs.toLocaleString()} songs` : ''}
              </span>
            </span>
          </div>
        );

      case 'catalog': {
        const state = adding[item.result.id];
        // An artist row is a door; a track or album is an Add, live whenever
        // anything could take a link - the tap finds a usable one if this row's
        // own link is not (a Deezer album, say).
        const isArtist = item.result.kind === 'artist';
        const can =
          !isArtist &&
          acquire.hasHandlers({ ...targetOf(item.result), url: PROBE_URL }) &&
          state !== 'missing';
        const have = item.mine !== null;
        const inside = (
          <>
            <Glyph
              shape={item.result.kind === 'artist' ? 'circle' : 'square'}
              cover={item.result.cover}
              fallback={
                item.result.kind === 'artist' ? (
                  <User size={18} />
                ) : item.result.kind === 'album' ? (
                  <Disc3 size={18} />
                ) : (
                  <Music size={18} />
                )
              }
            />
            <span className="searchRow__text">
              <span className="searchRow__title">{item.result.title}</span>
              <span className="searchRow__sub">
                {kindWord(item.result.kind)} · {item.result.subtitle}
                {item.result.source && (
                  <span className={`searchSource searchSource--${item.result.source}`}>
                    {item.result.source === 'deezer' ? 'Deezer' : 'Spotify'}
                  </span>
                )}
              </span>
            </span>
          </>
        );
        if (!isArtist && !can && state === undefined) {
          return (
            <div key={item.id} className="searchRow" data-static>
              {inside}
              {have && <Check size={16} className="searchRow__end" data-ok />}
            </div>
          );
        }
        return (
          <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
            {inside}
            {isArtist ? (
              <ChevronRight size={16} className="searchRow__end" />
            ) : have || state === 'added' ? (
              <Check size={16} className="searchRow__end" data-ok />
            ) : state === 'finding' ? (
              <span className="searchAdd" data-busy>
                <span className="artistAlbumSpin" aria-hidden /> Finding
              </span>
            ) : state === 'missing' ? (
              <span className="searchAdd" data-missing>
                <X size={14} /> Not on Spotify
              </span>
            ) : (
              <span className="searchAdd">
                <Plus size={14} /> Add
              </span>
            )}
          </button>
        );
      }
    }
  };

  /* -------------------------------------------------------------- browse --- */

  // The genres the library is actually made of, biggest first - the "what do I
  // even have" answer for somebody who opened search with nothing in mind.
  const browse = useMemo<LocalGenre[]>(() => {
    if (searching) return [];
    const tally = new Map<string, { name: string; count: number; covers: string[] }>();
    for (const t of tracks) {
      for (const raw of t.genre.split(',')) {
        const name = raw.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        let g = tally.get(key);
        if (!g) {
          g = { name, count: 0, covers: [] };
          tally.set(key, g);
        }
        g.count += 1;
        if (t.artwork && g.covers.length < 4) g.covers.push(t.artwork);
      }
    }
    return [...tally.values()].sort((a, b) => b.count - a.count).slice(0, BROWSE);
  }, [searching, tracks]);

  /** Re-open something from the Recent row, resolved against the library as it
   *  stands NOW: a remembered song that has since been deleted is gone, and the
   *  tile says so by doing nothing rather than by playing silence. */
  const openRecent = (r: Recent) => {
    switch (r.kind) {
      case 'track': {
        const track = tracks.find((t) => t.path === r.key);
        if (track) onPlay(track, [track]);
        break;
      }
      case 'artist':
        onOpenArtist(r.key);
        break;
      case 'album': {
        const [title, artist] = r.key.split(SEP);
        const theirs = tracks.filter((t) => t.album === title && (!artist || t.artist === artist));
        if (theirs[0]) onPlay(theirs[0], theirs);
        break;
      }
      case 'playlist':
        onOpenPlaylist(r.key);
        break;
      case 'genre':
        setQuery(`genre:"${r.key}"`);
        break;
      case 'catalog':
        setQuery(r.title);
        break;
    }
  };

  const nothing =
    searching &&
    !claimed &&
    sections.length === 0 &&
    !top &&
    // Still waiting on the catalogue is not the same as having nothing.
    (catalog !== null || !server);

  return (
    <div className="homePage searchPage" ref={rippleRoot}>
      <SearchField
        id={FIELD_ID}
        className="pageSearch"
        value={query}
        onValueChange={setQuery}
        onKeyDown={onFieldKey}
        placeholder="Songs, artists, albums, lyrics — or artist: album: genre:"
        aria-label="Search"
        role="combobox"
        aria-expanded={walk.length > 0}
        aria-controls="searchResults"
        aria-activedescendant={cursor >= 0 ? `searchHit-${cursor}` : undefined}
        autoComplete="off"
        autoFocus
      />

      {searching && !claimed && available.some((f) => f.group === 'kind') && (
        <div className="searchFilters" role="tablist" aria-label="Narrow these results">
          {available.map((f, i) => (
            <span key={f.id} className="searchChipWrap">
              {i > 0 && available[i - 1]!.group !== f.group && (
                <span className="searchChipRule" aria-hidden />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                className="searchChip"
                data-on={filter === f.id || undefined}
                onClick={() => setFilter(f.id)}
              >
                <span className="searchChip__glyph" aria-hidden>
                  {f.icon}
                </span>
                {f.label}
              </button>
            </span>
          ))}
        </div>
      )}

      {searching && lib.approximate && (
        <Text tone="muted" size="sm" className="searchNote">
          Nothing matches “{parsed.raw}” exactly — this is the closest your library has.
        </Text>
      )}

      <div id="searchResults" role={searching ? 'listbox' : undefined} aria-label="Results">
        {!searching && (
          <>
            {recents.items.length > 0 && (
              <section className="searchSection">
                <h2 className="searchSection__title">
                  <span className="searchSection__glyph" aria-hidden>
                    <Search size={15} />
                  </span>
                  Recent
                  <button type="button" className="searchSeeAll" onClick={recents.clear}>
                    Clear
                  </button>
                </h2>
                <div className="searchRecents">
                  {recents.items.map((r) => (
                    <RecentTile
                      key={`${r.kind}:${r.key}`}
                      recent={r}
                      tracks={tracks}
                      playlists={playlists}
                      onOpen={() => openRecent(r)}
                      onForget={() => recents.remove(r.kind, r.key)}
                    />
                  ))}
                </div>
              </section>
            )}

            {browse.length > 0 && (
              <section className="searchSection searchSection--browse">
                <Heading icon={<Tag size={15} />} count={browse.length}>
                  Browse
                </Heading>
                <div className="searchBrowse">
                  {browse.map((g) => {
                    // The generated genre object leads; a genre the set does
                    // not cover keeps its own library cover over the tint.
                    const generated = server ? genreArtwork(g.name) : null;
                    return (
                    <button
                      key={g.name}
                      type="button"
                      className="searchGenre"
                      style={hueOf(g.name)}
                      onClick={() => setQuery(`genre:"${g.name}"`)}
                    >
                      {generated ? (
                        <GenreArt src={artworkUrl(server!, generated)} raw fallback={g.covers[0] ?? null} />
                      ) : (
                        g.covers[0] && <GenreArt src={g.covers[0]} />
                      )}
                      <span className="searchGenre__name">{g.name}</span>
                      <span className="searchGenre__count">
                        {g.count === 1 ? '1 song' : `${g.count} songs`}
                      </span>
                    </button>
                    );
                  })}
                </div>
              </section>
            )}

            {recents.items.length === 0 && browse.length === 0 && (
              <div className="emptyState">
                <EmptyArt name="search" />
                <p className="emptyState__text">
                  Search your songs, your artists, your albums, your friends and the wider
                  catalogue — all at once.
                </p>
              </div>
            )}
          </>
        )}

        {searching && !claimed && heroed && top && (
          <section className="searchTop">
            <div className="searchTop__hero">
              <Heading icon={<Search size={15} />}>Top result</Heading>
              <TopCard
                item={top}
                tracks={tracks}
                id={position.get(top.id) !== undefined ? `searchHit-${position.get(top.id)}` : undefined}
                active={current?.id === top.id}
                onOpen={() => open(top)}
                onHover={() => {
                  const n = position.get(top.id);
                  if (n !== undefined) setCursor(n);
                }}
              />
            </div>
            {beside.length > 0 && (
              <div className="searchTop__songs">
                <Heading
                  icon={<Music size={15} />}
                  count={lib.songs.length}
                  onSeeAll={lib.songs.length > beside.length ? () => setFilter('songs') : undefined}
                >
                  Songs
                </Heading>
                <div className="searchRows">{beside.map(renderRow)}</div>
              </div>
            )}
          </section>
        )}

        {sections.map((s) => (
          <section key={`${s.key}:${s.title}`} className="searchSection" role="group" aria-label={s.title}>
            <Heading
              icon={s.icon}
              count={s.total}
              onSeeAll={
                s.total > s.items.length && s.key !== 'all' ? () => setFilter(s.key) : undefined
              }
            >
              {s.title}
            </Heading>
            <div className="searchRows">{s.items.map(renderRow)}</div>
          </section>
        ))}

        {searching && !claimed && on('catalog') && catalog === null && server && (
          <p className="searchNote" role="status">
            Searching Spotify and Deezer…
          </p>
        )}

        {nothing && (
          <div className="emptyState">
            <EmptyArt name="search" />
            <p className="emptyState__text">Nothing found for “{parsed.raw}”.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * The Top result, as a card rather than a row: big art, what it is, and the one
 * verb that matters for its kind. It is the answer the page is most confident
 * about, so it gets the room to look like one.
 */
function TopCard({
  item,
  tracks,
  id,
  active,
  onOpen,
  onHover,
}: {
  item: Item;
  tracks: readonly Track[];
  id?: string;
  active: boolean;
  onOpen: () => void;
  onHover: () => void;
}) {
  const face = (() => {
    switch (item.t) {
      case 'artist':
        return {
          shape: 'circle' as const,
          cover: item.artist.cover,
          fallback: <User size={34} />,
          title: item.artist.name,
          sub: `Artist · ${item.artist.count === 1 ? '1 song' : `${item.artist.count} songs`}`,
          play: false,
        };
      case 'album':
        return {
          shape: 'square' as const,
          cover: item.album.cover,
          fallback: <Disc3 size={34} />,
          title: item.album.title,
          sub: `Album · ${item.album.artist}`,
          play: true,
        };
      case 'song':
        return {
          shape: 'square' as const,
          cover: item.track.artwork,
          fallback: <Music size={34} />,
          title: item.track.title,
          sub: `Song · ${item.track.artist}`,
          play: true,
        };
      case 'playlist':
        return {
          shape: 'mosaic' as const,
          cover: null,
          fallback: <ListMusic size={34} />,
          title: item.playlist.name,
          sub: `Playlist · ${item.playlist.paths.length} songs`,
          play: false,
        };
      default:
        return null;
    }
  })();
  // Hooks sit before the null gate: React needs them called on every render,
  // whatever kind this card resolves to. The hero cover is big, so 640.
  const mosaic = item.t === 'playlist' ? mosaicArts(coversOf(item.playlist, tracks)) : [];
  const { loaded: tiled, hostRef: tileRef } = useTileArt(mosaic);
  const sized = artSized(face?.cover ?? null, 640);
  const art = useArtLoad(sized, '');
  if (!face) return null;

  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      className="searchTopCard"
      data-active={active || undefined}
      onMouseEnter={onHover}
      onClick={onOpen}
    >
      <span className="searchTopCard__art" data-shape={face.shape}>
        {mosaic.length > 0 ? (
          <span
            ref={tileRef}
            className="searchMosaic"
            data-n={mosaic.length}
            data-tile-pop=""
            data-tile-loading={!tiled || undefined}
          >
            {mosaic.map((c, i) => (
              <img key={`${c}:${i}`} src={c} alt="" loading="lazy" />
            ))}
          </span>
        ) : sized ? (
          <img {...art} src={sized} alt="" loading="lazy" />
        ) : (
          face.fallback
        )}
      </span>
      <span className="searchTopCard__title">{face.title}</span>
      <span className="searchTopCard__sub">{face.sub}</span>
      <span className="searchTopCard__verb">
        {face.play ? <Play size={15} /> : <ChevronRight size={15} />}
        {face.play ? 'Play' : 'Open'}
      </span>
    </button>
  );
}

/**
 * One tile in the Recent row. Its artwork is resolved live from the library
 * rather than remembered: a local file's cover is an object URL and a server's
 * carries a stream token, so either one stored a week ago would be a dead image
 * today. Only a catalogue result - a plain public URL - keeps its own.
 */
function RecentTile({
  recent,
  tracks,
  playlists,
  onOpen,
  onForget,
}: {
  recent: Recent;
  tracks: readonly Track[];
  playlists: readonly Playlist[];
  onOpen: () => void;
  onForget: () => void;
}) {
  const cover = useMemo(() => {
    switch (recent.kind) {
      case 'track':
        return tracks.find((t) => t.path === recent.key)?.artwork ?? null;
      case 'artist':
        return tracks.find((t) => t.artist === recent.key && t.artwork)?.artwork ?? null;
      case 'album': {
        const [title, artist] = recent.key.split(SEP);
        return (
          tracks.find((t) => t.album === title && (!artist || t.artist === artist) && t.artwork)
            ?.artwork ?? null
        );
      }
      case 'playlist': {
        const list = playlists.find((p) => p.id === recent.key);
        if (!list) return null;
        const want = new Set(list.paths);
        return tracks.find((t) => want.has(t.path) && t.artwork)?.artwork ?? null;
      }
      default:
        return recent.cover;
    }
  }, [playlists, recent, tracks]);

  // Recents draw small tiles, so the 160 variant; a null cover (nothing in
  // the library to resolve it from anymore) keeps the kind's glyph below.
  const sized = artSized(cover, 160);
  const art = useArtLoad(sized, '');

  return (
    <div className="searchRecent">
      <button type="button" className="searchRecent__body" onClick={onOpen}>
        <span className="searchRecent__art" data-round={recent.kind === 'artist' || undefined}>
          {cover ? (
            <img {...art} src={sized ?? undefined} alt="" loading="lazy" />
          ) : recent.kind === 'artist' ? (
            <User size={22} />
          ) : recent.kind === 'playlist' ? (
            <ListMusic size={22} />
          ) : recent.kind === 'genre' ? (
            <Tag size={22} />
          ) : (
            <Music size={22} />
          )}
        </span>
        <span className="searchRecent__title">{recent.title}</span>
        <span className="searchRecent__sub">{recent.subtitle}</span>
      </button>
      <button
        type="button"
        className="searchRecent__forget"
        aria-label={`Forget ${recent.title}`}
        onClick={onForget}
      >
        <X size={13} />
      </button>
    </div>
  );
}
