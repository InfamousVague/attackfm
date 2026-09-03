import { searchSpoken, type SpokenHit } from './spokenSearch.ts';
import { setPendingSeek } from '../player/pendingSeek.ts';
import { formatClock } from '../ux/format.ts';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { AlbumMenu } from '../albumArtist/AlbumMenu.tsx';
import { SearchField, SegmentedControl, Spinner, Text, useToast } from '@glacier/react';
import { Radio } from '@glacier/icons';
import { fetchDj } from '../api/dj.ts';
import { fireNativeHaptic } from '../core/haptics.ts';
import { trackIdFromPath } from '../api/library.ts';
import type { ServerSession } from '../api/http.ts';
import {
  BookAudio,
  BookOpenText,
  Compass,
  Disc3,
  ListMusic,
  Music,
  Plus,
  Quote,
  Search,
  Tag,
  User,
  Users,
} from '@glacier/icons';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useLibrary } from '../library/library.tsx';
import { shelve } from '../library/bookShelf.ts';
import { filterBooks } from '../library/bookSearch.ts';
import { useRippleWave } from '../ux/rippleWave.ts';
import { usePlaylists } from '../playlists/playlists.tsx';
import { useQueueControls } from '../player/queueControls.tsx';
import { useRegistry } from '../servers/registrySession.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { artworkUrl, genreArtwork, isCutoutArt } from '../ux/artwork.ts';
import { spotifyWebUrl } from '../servers/deepLink.ts';
import { openExternal } from '../core/openExternal.ts';
import { usePluginCommands, useAcquire } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { usePendingPlay } from '../player/pendingPlay.tsx';
import { parseQuery, searchLibrary, type LocalGenre } from './trackSearch.ts';
import { useOwned } from '../library/owned.ts';
import { useSearchRecents, type Recent } from './searchRecents.ts';
import { fetchFriends, type RegistryFriend } from '../servers/registry.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import {
  BESIDE,
  BROWSE,
  CHIPS,
  COLLAPSED,
  EXPANDED,
  FIELD_ID,
  SEP,
  albumKey,
  hueOf,
  isAbout,
  type Filter,
  type Item,
  type Section,
} from './searchModel.tsx';
import { GenreArt, Heading } from './SearchBits.tsx';
import { TopCard } from './TopCard.tsx';
import { RecentTile } from './RecentTile.tsx';
import { useCatalogSearch } from './useCatalogSearch.ts';
import { renderRow, type RowCtx } from './SearchRows.tsx';
import { IncomingRows } from '../downloads/IncomingRows.tsx';
import type { Track } from '../core/tauri.ts';

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
 *
 * Split for size: types/constants/pure helpers live in searchModel.tsx, the
 * small presentational bits in SearchBits.tsx, the hero card in TopCard.tsx,
 * the Recent tile in RecentTile.tsx, the row renderer in SearchRows.tsx, and
 * the remote catalogue half (debounced fetch + Add verb) in useCatalogSearch.ts;
 * the sections array, the keyboard walk and the JSX stay here, on purpose -
 * they must be built from the exact arrays that render.
 */

/* --------------------------------------------------------------------- page */

export function SearchPage({
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  initialFilter,
  placeholder,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Opens a record rather than starting it: a result you searched for is
   *  something to look at first. */
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  onOpenPlaylist: (id: string) => void;
  /** Which scope the page opens on. Library's bar sends 'mine' so its search
   *  answers only from what is already downloaded; unset means 'all'. */
  initialFilter?: Filter;
  /** The words the bar that opened this was wearing, so the two read as one
   *  bar rather than swapping text as the page arrives. */
  placeholder?: string;
}) {
  const { tracks, books, isFavorite, toggleFavorite } = useLibrary();
  const { playlists } = usePlaylists();
  // Results, genre tiles and recents wave in as they meet the view, landing
  // with the same soft ticks the Library's shelves ride - see rippleWave.ts.
  // Rows React reuses across keystrokes keep their landed state; only truly
  // NEW results ripple, so typing refines rather than re-parades.
  const [rippleRoot, setRippleRoot] = useState<HTMLDivElement | null>(null);
  useRippleWave(rippleRoot);
  const { session: registry } = useRegistry();
  const { session: server } = useServerSession();
  const owned = useOwned();
  const queue = useQueueControls();
  const acquire = useAcquire();
  const downloads = useDownloadsOptional();
  // Tapping a not-yet-owned track opens Now Playing on it, downloading, and
  // plays it when the import lands (see pendingPlay.tsx).
  const playPending = usePendingPlay();
  const recents = useSearchRecents();
  const [query, setQuery] = useState('');
  /*
   * A Spotify link the phone handed us now opens its own preview card
   * (<SpotifyPreview />), not this field - so a tapped song lands on the record
   * and its actions rather than in a search box. A link TYPED or PASTED here
   * still works: `spotifyWeb` below reads it straight off the query, which is a
   * different path from the deep-link arrival and stays.
   */
  const [filter, setFilter] = useState<Filter>('all');
  /*
   * Scope and kind are different questions, so they are different state. The
   * chips narrow WHAT ('Songs', 'Albums'); this says WHERE FROM. They shared
   * one value once, which meant picking a kind silently reset the scope - and
   * a toggle that moves when you did not touch it is worse than no toggle.
   *
   * Off by default: the bar sits on pages that are already yours, and a song
   * you own should not have to share a list with an offer to go and buy it.
   */
  const [discover, setDiscover] = useState(initialFilter === 'all');
  const [friends, setFriends] = useState<RegistryFriend[]>([]);
  // Which row the keyboard is on, as an index into the flat item list; -1 is
  // "none". The field keeps DOM focus throughout, so typing never stops.
  const [cursor, setCursor] = useState(-1);

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

  const plugin = usePluginCommands({ query, close: () => setQuery('') });

  const parsed = useMemo(() => parseQuery(query), [query]);
  const lib = useMemo(() => searchLibrary(tracks, query), [tracks, query]);

  /*
   * Books, matched as BOOKS.
   *
   * Not fed through `searchLibrary`: that engine ranks tracks, and a book is one
   * or fifty of them - "dungeon" would answer with fifty identical-looking rows
   * for a single title. They are grouped first and matched on what a person
   * would type at a shelf (title, author, a chapter name), which is what
   * `filterBooks` already does for the Books page.
   */
  const bookHits = useMemo(
    () => (query.trim() ? filterBooks(shelve(books), query) : []),
    [books, query],
  );

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

  const shown = useMemo(() => new Set(lib.songs.map((s) => s.track.path)), [lib.songs]);

  // The remote half: the debounced catalogue fetch, the dedupe against the
  // songs already shown, and the Add verb - see useCatalogSearch.ts.
  //
  // Scoped to 'mine' it is not merely hidden, it is never asked: the hook
  // treats an empty query as "nothing to fetch" and clears itself, so the
  // Library's bar makes no network call per keystroke. That matters on a hub
  // reached over the tailnet, where the catalogue fetch is the slowest thing
  // on the page and the one most likely to time out.
  const { catalog, outside, adding, acquireResult } = useCatalogSearch({
    query: discover ? query : '',
    parsedPhrase: parsed.phrase,
    shownPaths: shown,
    owned,
    acquire,
    downloads,
    playPending,
    server,
  });

  const searching = parsed.active;

  /*
   * The words INSIDE the audio - the one lane the client cannot answer.
   *
   * Asked a beat after typing stops rather than per keystroke: it is a real
   * request to a real server across a possibly-slow link, and the answer is
   * worth waiting a moment for. Every other lane stays instant and local.
   */
  const [spoken, setSpoken] = useState<SpokenHit[]>([]);
  useEffect(() => {
    if (!searching) {
      setSpoken([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void searchSpoken(parsed.raw, tracks, ctrl.signal).then(setSpoken).catch(() => {});
    }, 350);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [searching, parsed.raw, tracks]);
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

        case 'book': {
          const [first] = item.book.tracks;
          if (!first) break;
          touch({
            kind: 'track',
            key: first.path,
            title: item.book.title,
            subtitle: item.book.author,
            cover: null,
            url: '',
          });
          // The whole book as the queue, and the FIRST file as the entry: the
          // player's own restore puts the needle back where this book was left,
          // so opening one from search resumes it rather than restarting it.
          onPlay(first, item.book.tracks);
          break;
        }

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
          if (onOpenAlbum) onOpenAlbum(item.album.title, item.album.artist);
          else onPlay(first, item.album.tracks);
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
          // Already in your library: play it, do not re-fetch it.
          if (item.mine) {
            onPlay(item.mine, [item.mine]);
            break;
          }
          void acquireResult(item.result);
          break;
        }
      }
    },
    [acquire, onOpenArtist, onOpenPlaylist, onPlay, songQueue, touch],
  );

  /** The heart on a catalogue row: same pull as Add, plus the promised
   *  favourite - and no now-playing hijack, because a like is not a listen. */
  const like = useCallback(
    (item: Item) => {
      if (item.t !== 'catalog') return;
      void acquireResult(item.result, { like: true });
    },
    [acquireResult],
  );

  /* ----------------------------------------------------------- sections --- */

  /** True while the page is showing everything rather than one promoted kind. */
  const wide = filter === 'all';
  const cap = (key: Filter) => (filter === key ? EXPANDED : COLLAPSED);
  /** Whether a section shows at all under the current chip. */
  const on = (key: Filter): boolean => {
    // The catalogue is a scope, not a kind: it appears when Discover is on and
    // never otherwise, whatever the chips are set to.
    if (key === 'catalog') return discover;
    if (filter === 'all') return true;
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
    // Nothing of theirs is owned, but the catalogue knows who they are: the
    // artist you typed is still the answer, so their page leads the page
    // rather than three of their songs with Add buttons. Not in 'mine',
    // though - a scope that promises only what you have must not lead with
    // something you do not.
    const catalogArtist = discover
      ? outside.find((r) => r.kind === 'artist' && isAbout(r.title, phrase))
      : undefined;
    if (catalogArtist) {
      return { t: 'catalog', id: `catalog:${catalogArtist.id}`, result: catalogArtist, mine: null };
    }
    const anyArtist = lib.artists[0];
    if (anyArtist) return { t: 'artist', id: `artist:${anyArtist.name}`, artist: anyArtist };
    const anyAlbum = lib.albums[0];
    if (anyAlbum) return { t: 'album', id: `album:${albumKey(anyAlbum)}`, album: anyAlbum };
    return null;
  }, [discover, lib.albums, lib.artists, lib.songs, outside, parsed]);

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

  /*
   * The way back out to Spotify.
   *
   * Once the phone can be told to open Spotify links here, "open it in
   * Spotify" stops being something Android is reliably willing to offer -
   * pick AttackFM once with Always and the choice is gone, and clearing that
   * lives four screens deep in Settings. So the choice lives on the link
   * itself, where it cannot be lost: whichever app caught it, both doors are
   * on this row.
   *
   * Always the https form. The `spotify:` scheme is one this app now answers,
   * so handing that back to the system would just return here.
   */
  const spotifyWeb = spotifyWebUrl(query);
  if (spotifyWeb) {
    commandItems.push({
      t: 'action',
      id: 'open-in-spotify',
      label: 'Open in Spotify',
      group: 'Actions',
      run: () => void openExternal(spotifyWeb),
    });
  }

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
    // Beside the songs, because a book is the other thing in this library you
    // PLAY - and because somebody typing a title is usually looking for exactly
    // one of them, which puts it high or nowhere.
    if (on('books') && bookHits.length > 0) {
      out.push({
        key: 'books',
        title: 'Books',
        icon: <BookAudio size={15} />,
        total: bookHits.length,
        items: bookHits
          .slice(0, cap('books'))
          .map<Item>((b) => ({ t: 'book', id: `book:${b.key}`, book: b })),
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
  useEffect(() => setCursor(-1), [query, filter, discover]);

  const current = cursor >= 0 ? walk[cursor] : undefined;

  const available = useMemo(
    () =>
      CHIPS.filter(({ id }) => {
        // The three scope chips became a segmented toggle above: one control
        // that says what the page is answering from, rather than three chips
        // competing with six more about what to narrow to.
        if (id === 'all' || id === 'mine' || id === 'catalog') return false;
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

  // The seat every row draws from, built plain per render like the walk above,
  // so a row always reflects this render's cursor and adding state. The row
  // renderer itself lives in SearchRows.tsx - still a plain call, never a
  // component, for the reason documented there.
  const rowCtx: RowCtx = {
    position,
    cursor,
    setCursor,
    open,
    like,
    queue,
    adding,
    acquire,
    onPlay,
    onOpenArtist,
    query,
    tracks,
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
    <div className="homePage searchPage" ref={setRippleRoot}>
      <SearchField
        id={FIELD_ID}
        className="pageSearch"
        value={query}
        onValueChange={setQuery}
        onKeyDown={onFieldKey}
        placeholder={placeholder ?? 'Songs, artists, albums, lyrics — or artist: album: genre:'}
        aria-label="Search"
        role="combobox"
        aria-expanded={walk.length > 0}
        aria-controls="searchResults"
        aria-activedescendant={cursor >= 0 ? `searchHit-${cursor}` : undefined}
        autoComplete="off"
        /* Focused on open, phone included. This used to be desk-only: search
           arrived by a PULL from the top, which is a gesture you can make by
           accident, so throwing the keyboard over the page you just revealed
           was the wrong answer. Search now arrives by tapping a search bar -
           an act with exactly one meaning - and landing on a page whose field
           is not ready costs a second tap for no reason. */
        autoFocus
      />

      {/*
        * Where the answers come from. One search, library first: the page you
        * came from was always your own, and a song you already own should not
        * have to share a list with an offer to go and buy it. Turning Discover
        * on folds the catalogue back in - same rows, same shapes, just more of
        * them - which is also the answer when your own library genuinely does
        * not have the thing you typed.
        */}
      {searching && !claimed && (
        <SegmentedControl
          className="searchScope"
          aria-label="Where to search"
          size="sm"
          fullWidth
          value={discover ? 'discover' : 'mine'}
          options={[
            { value: 'mine', label: 'Your library' },
            { value: 'discover', label: 'Discover' },
          ]}
          onValueChange={(v) => setDiscover(v === 'discover')}
        />
      )}

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

      {/* An on-demand station off whatever was typed: the DJ's endless-set
          endpoint has embedded free text and ranked the library against it
          since the Booth was built - it just never had a door anyone could
          reach once the Booth went behind developer mode. This is the door. */}
      {searching && !claimed && server && tracks.length > 0 && (
        <StationFromQuery query={parsed.raw} session={server} tracks={tracks} onPlay={onPlay} />
      )}

      <div id="searchResults" role={searching ? 'listbox' : undefined} aria-label="Results">
        {/* Already on the wire: a song the query matches that is downloading
            right now, so it is never added twice. Self-hides otherwise. */}
        <IncomingRows scope="all" query={query} heading="Already downloading" />
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
                    const generated = genreArtwork(g.name);
                    return (
                    <button
                      key={g.name}
                      type="button"
                      className="searchGenre"
                      // Which of the two picture kinds this tile has. The
                      // halftone prints its object light, which only works on
                      // art shot as a cut-out - see isCutoutArt.
                      data-cutout={isCutoutArt(generated) || undefined}
                      style={hueOf(g.name)}
                      onClick={() => setQuery(`genre:"${g.name}"`)}
                    >
                      {generated ? (
                        <GenreArt src={artworkUrl(generated)} raw fallback={g.covers[0] ?? null} />
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
              {(() => {
                const card = (
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
                );
                // The hero is still a song or a record when it wins the top
                // spot, so it holds like one; the other kinds are doors.
                if (top.t === 'song') return <TrackMenu track={top.track}>{card}</TrackMenu>;
                if (top.t === 'album')
                  return (
                    <AlbumMenu
                      tracks={top.album.tracks}
                      onPlay={onPlay}
                      onOpenArtist={onOpenArtist}
                      artistName={top.album.artist}
                    >
                      {card}
                    </AlbumMenu>
                  );
                return card;
              })()}
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
                <div className="searchRows">{beside.map((i) => renderRow(i, rowCtx))}</div>
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
            <div className="searchRows">{s.items.map((i) => renderRow(i, rowCtx))}</div>
          </section>
        ))}

        {searching && spoken.length > 0 && (
          <section className="searchSection" role="group" aria-label="Heard in your library">
            <Heading icon={<Quote size={15} />} count={spoken.length}>
              Heard in your library
            </Heading>
            <div className="searchRows">
              {spoken.map((h, i) => (
                <button
                  key={`${h.trackId}-${h.startMs}-${i}`}
                  type="button"
                  className="searchRow spokenRow"
                  onClick={() => {
                    if (!h.track) return;
                    // The moment, not the track: leave word for the deck so the
                    // book's own resume cannot overrule the line just chosen.
                    setPendingSeek(h.track.path, h.startMs);
                    onPlay(h.track, [h.track]);
                  }}
                >
                  <span className="spokenRow__mark" aria-hidden>
                    {h.kind === 'book' ? <BookOpenText size={15} /> : <Music size={15} />}
                  </span>
                  <span className="searchRow__text">
                    <span className="spokenRow__line">“{h.text}”</span>
                    <span className="searchRow__sub">
                      {h.title}
                      {h.artist ? ` · ${h.artist}` : ''} · {formatClock(h.startMs / 1000)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

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

/**
 * One row: "Start a station" for the words in the box.
 *
 * Rides GET /api/dj?seed= - the seed is embedded server-side and steers the
 * ranking, so "rainy morning jazz" works as well as an artist's name. The set
 * comes back as track ids; they resolve against the library and the whole
 * flattened run becomes the queue, exactly the way the Booth's launcher does
 * it. Silence on failure would look like a dead button, so failure says so.
 */
function StationFromQuery({
  query,
  session,
  tracks,
  onPlay,
}: {
  query: string;
  session: ServerSession;
  tracks: Track[];
  onPlay: (track: Track, queue: Track[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { toast } = useToast();
  if (query.trim().length < 2) return null;

  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      const reply = await fetchDj(session, query.trim());
      const byId = new Map<number, Track>();
      for (const t of tracks) {
        const id = trackIdFromPath(t.path);
        if (id != null) byId.set(id, t);
      }
      const queue: Track[] = [];
      for (const block of reply.blocks) {
        for (const id of block.trackIds) {
          const t = byId.get(id);
          if (t) queue.push(t);
        }
      }
      const opener = queue[0];
      if (!opener) {
        setNote('Nothing in your library answers to that yet.');
        return;
      }
      fireNativeHaptic('light');
      toast({ message: `Station on: ${query.trim()}` });
      onPlay(opener, queue);
    } catch {
      setNote('The station could not start — the server did not answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="searchStation">
      <button type="button" className="searchStation__go" disabled={busy} onClick={() => void start()}>
        <span className="searchStation__icon" aria-hidden>
          {busy ? <Spinner size="sm" aria-label="" /> : <Radio size={16} />}
        </span>
        <span className="searchStation__text">
          <span className="searchStation__title">Start a station</span>
          <span className="searchStation__sub">Your library, tuned to “{query.trim()}”</span>
        </span>
      </button>
      {note && (
        <Text tone="muted" size="xs">
          {note}
        </Text>
      )}
    </div>
  );
}
