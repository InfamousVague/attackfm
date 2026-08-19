import { SearchEntry } from '../../app/search/SearchEntry.tsx';
import { Button, Modal, ScrollArea, SearchField, Spinner, Text } from '@glacier/react';
import { Check, Compass, ListMusic, Music, Play, Plus, Sparkles } from '@glacier/icons';
import { searchPlaylists, type PlaylistResult } from '../../app/server.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRippleWave } from '../../app/ux/rippleWave.ts';
import { useServerSession } from '../../app/servers/serverSession.tsx';
import { useLibrary } from '../../app/library/library.tsx';
import { useOwned } from '../../app/library/owned.ts';
import type { Track } from '../../app/core/tauri.ts';
import {
  artSized,
  fetchDiscover,
  fetchDiscoveries,
  trackIdFromPath,
  type Discovery,
  type Suggestion,
} from '../../app/server.ts';
import { useArtLoad } from '../../app/ux/artLoad.ts';
import { EmptyArt } from '../../app/ux/EmptyArt.tsx';
import { TrackMenu } from '../../app/library/TrackMenu.tsx';
import type { AcquireTarget, PluginPageProps } from '../types.ts';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../runtime.tsx';
import { useDownloadsOptional } from '../importsBridge.ts';
import { usePendingPlay, placeholderTrack } from '../../app/player/pendingPlay.tsx';
import { CatalogArtistPage } from './CatalogArtistPage.tsx';
import { CuratorShelves } from '../../app/library/HomePage.tsx';
import discoverPlaceholder from '../../assets/attack-wave.png';
import { ForYouShelf } from '../../app/library/ForYouShelf.tsx';
import type { MusicImportJob } from '../importsBridge.ts';

/** A curated playlist card, as an acquire target: a whole list, no single
 *  artist, carrying the URL an importer would pull. */
function suggestionTarget(item: Suggestion): AcquireTarget {
  return { kind: 'playlist', title: item.title, url: item.url };
}

/** An AI pick, as an acquire target: title and artist for a store search, URL
 *  for a download. */
function discoveryTarget(d: Discovery): AcquireTarget {
  return { kind: 'track', title: d.title, artist: d.artist, url: d.url };
}

/**
 * The Discover page: the server's curated chart and staple playlists, grouped
 * by section, each a one-tap "Add" that pushes the whole list through the
 * import pipeline the app already runs. Where the old home shelf showed a
 * single scrollable rail, the page lays every section out as a browsable grid -
 * a place to go, not a strip to glance past.
 *
 * A card knows whether its playlist is already in the pipeline: the state is
 * read from the import queue itself (the job whose URL carries this playlist's
 * id), not from a memory of taps - so it survives restarts, follows the user
 * across devices (the queue lives on the hub), and tracks the truth if a job
 * fails. Tapping the card opens a preview - the track list the server read off
 * the public embed - so the user can see what fifty songs they are about to
 * commit to before the Add.
 *
 * The catalogue is a server feature (built and cached on the hub, no Spotify
 * key), so the plugin that owns this page is `requiresServer` and never mounts
 * without a session. Adding needs the Music import plugin's queue too; with it
 * switched off the cards and previews still show, their Add buttons quietly
 * disabled with the reason.
 */

const REFRESH_MS = 30 * 60 * 1000;

type AddState = 'idle' | 'adding' | 'added';

/** The import job for a suggestion, if one exists.
 *
 *  The card's own URL is the truth, so an exact match comes first. The id match
 *  is the fallback that lets a pasted-link import of the same chart count - but
 *  it has to strip the SOURCE PREFIX the server stamps on Deezer ids
 *  (`dz-album-123`, `dz-track-123`, see discover.rs) while the URL carries only
 *  the bare `123`. Matching the prefixed id against the URL never hit, so every
 *  Deezer card in the feed was structurally unable to say "Added". */
function jobFor(jobs: readonly MusicImportJob[] | undefined, item: Suggestion): MusicImportJob | null {
  if (!jobs) return null;
  const exact = jobs.find((j) => j.url === item.url);
  if (exact) return exact;
  const bare = item.id.replace(/^dz-(?:album|track)-/, '');
  if (!bare) return null;
  return jobs.find((j) => j.url.includes(bare)) ?? null;
}

/**
 * The one line under "Discover" that says where the picks stand.
 *
 * The machine asks for a SONG, never for patience: counts in songs, no
 * percentages, no talk of confidence, and no engine nouns (harvest, adoption,
 * embeddings all stay in Settings). It only ever states something true of this
 * moment, so it can be read at a glance and then ignored.
 */
function warmthLine(
  warmth: {
    progress: { pool: number; listened: number };
    taste: { heard: number; needed: number } | null;
  } | null,
  discoveries: Discovery[] | null,
): string {
  // Picks on screen: say what they were drawn from, not what is missing.
  if (discoveries && discoveries.length >= 3) {
    const measured = warmth?.progress.listened ?? 0;
    return measured > 0
      ? `Picked from ${measured} songs measured against what you play.`
      : 'Picked from your library and what you play.';
  }
  // An older server that does not report the gate: no ask to make honestly.
  if (!warmth?.taste) return 'Find music beyond your library and add it in a tap.';
  const { heard, needed } = warmth.taste;
  if (heard <= 0) {
    return `Nothing to go on yet. Play ${needed} songs and this page starts picking.`;
  }
  if (heard < needed) {
    const left = needed - heard;
    return `${heard} of ${needed} songs. ${left === 1 ? 'One more' : `${left} more`} and this page starts picking.`;
  }
  // Past the gate, still thin: the server is out looking.
  return warmth.progress.pool > 0
    ? `Your server is listening to ${warmth.progress.listened} of ${warmth.progress.pool} songs it found for you.`
    : 'Your server is out looking — the first picks land in a few minutes.';
}

/** What the queue says about this suggestion. An errored job reads as idle:
 *  the Add button doubles as the retry. */
function stateFrom(job: MusicImportJob | null, tapped: AddState | undefined): AddState {
  if (job?.state === 'done') return 'added';
  if (job?.state === 'queued' || job?.state === 'downloading') return 'adding';
  // The queue has no (live) job; a just-tapped card shows immediately rather
  // than waiting a poll cycle for the job to appear.
  return tapped ?? 'idle';
}

/** A bare cover <img> inside a card's cover frame, wearing the shared
 *  skeleton/pulse. Its own component because most of these covers render
 *  inside map callbacks, where a hook cannot live. External catalogue art,
 *  so the URL is used as-is - no server size variants to ask for. */
function CoverArt({ src, lazy }: { src: string; lazy?: boolean }) {
  const art = useArtLoad(src, '');
  return <img {...art} src={src} alt="" loading={lazy ? 'lazy' : undefined} />;
}

function AddButton({
  item,
  state,
  canAdd,
  progress,
  onAdd,
}: {
  item: Suggestion;
  state: AddState;
  canAdd: boolean;
  /** "12/50" while the queue is pulling the list down, when known. */
  progress: string | null;
  onAdd: () => void;
}) {
  return (
    <button
      type="button"
      className="suggestAddBtn"
      data-state={state}
      disabled={state !== 'idle' || !canAdd}
      onClick={onAdd}
      aria-label={`Add ${item.title} to your library`}
      title={canAdd ? undefined : 'No way to add this — enable Music import or Buy in Plugins'}
    >
      {state === 'added' ? (
        <>
          <Check size={15} /> Added
        </>
      ) : state === 'adding' ? (
        progress ? `Adding ${progress}` : 'Adding…'
      ) : (
        <>
          <Plus size={15} /> Add
        </>
      )}
    </button>
  );
}

function SuggestionCard({
  item,
  state,
  canAdd,
  progress,
  onAdd,
  onOpen,
}: {
  item: Suggestion;
  state: AddState;
  canAdd: boolean;
  progress: string | null;
  onAdd: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="suggestCard">
      {/* The cover and titles are one button into the preview; the Add stays
          its own control beside it - a sibling, not a nested button. */}
      <button type="button" className="suggestCardBody" onClick={onOpen}>
        <div className="suggestCardCover">
          {item.cover ? (
            <CoverArt src={item.cover} lazy />
          ) : (
            <div className="suggestCardCover--glyph" aria-hidden>
              <ListMusic size={26} />
            </div>
          )}
          {/* Which service this is from, so the page reads as many sources
              rather than one. Only when the server says (older ones do not). */}
          {item.source && (
            <span className={`suggestCardSource suggestCardSource--${item.source}`}>
              {item.source === 'deezer' ? 'Deezer' : 'Spotify'}
            </span>
          )}
        </div>
        <span className="suggestCardTitle">{item.title}</span>
        <span className="suggestCardBlurb">{item.blurb}</span>
      </button>
      <AddButton item={item} state={state} canAdd={canAdd} progress={progress} onAdd={onAdd} />
    </div>
  );
}

/** Groups the flat suggestion list by section, keeping the server's order -
 *  the section a chart first appears in is where its heading lands. */
function groupBySection(items: readonly Suggestion[]): { section: string; items: Suggestion[] }[] {
  const order: string[] = [];
  const bySection = new Map<string, Suggestion[]>();
  for (const item of items) {
    let bucket = bySection.get(item.section);
    if (!bucket) {
      bucket = [];
      bySection.set(item.section, bucket);
      order.push(item.section);
    }
    bucket.push(item);
  }
  return order.map((section) => ({ section, items: bySection.get(section)! }));
}

/**
 * A group of songs behaving like a playlist on this page: the AI's fresh
 * finds, one seed artist's trail, or what just landed in the library. Two
 * kinds because the two lives differ - owned rows play right now, discovery
 * rows are still out in the world and carry an Add.
 */
interface SongSet {
  key: string;
  title: string;
  blurb: string;
  kind: 'owned' | 'discoveries';
  tracks?: Track[];
  discoveries?: Discovery[];
  /** Up to four covers for the mosaic; empty means wear the glyph. */
  covers: string[];
}

/** The first four covers a set can actually show. */
function mosaicOf(urls: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (url && !out.includes(url)) out.push(url);
    if (out.length === 4) break;
  }
  return out;
}

/** A set's cover: a 2x2 mosaic of what is inside, or one cover writ large. */
function SetMosaic({ covers, size }: { covers: string[]; size?: 'hero' }) {
  const first = covers[0];
  if (!first) {
    return (
      <div className="suggestCardCover--glyph" aria-hidden>
        <Sparkles size={size === 'hero' ? 34 : 26} />
      </div>
    );
  }
  if (covers.length < 4) return <CoverArt src={first} lazy />;
  return (
    <span className="discoverMosaic" aria-hidden>
      {covers.map((c) => (
        <CoverArt key={c} src={c} lazy />
      ))}
    </span>
  );
}

// Only the play door is used. Artists deliberately do NOT go through
// onOpenArtist: that opens the LIBRARY's artist page, and on Discover an artist
// means their catalogue - the discography you can add from - so every artist row
// here stacks a CatalogArtistPage instead.
export function DiscoverPage({ onPlay, onOpenArtist }: PluginPageProps) {
  // The same entrance the Library wears: cards wave in as they meet the
  // view, each landing with a soft tick.
  // State-carried on purpose: this page swaps its whole content out for the
  // catalogue artist and back (see the `artist` return below), so the wave's
  // observers must follow the remounted root rather than the first one.
  const [rippleRoot, setRippleRoot] = useState<HTMLDivElement | null>(null);
  useRippleWave(rippleRoot);
  const { session } = useServerSession();
  const downloads = useDownloadsOptional();
  const acquire = useAcquire();
  const { tracks: libraryTracks, forYou } = useLibrary();
  const owned = useOwned();
  // Tapping a not-yet-owned song opens Now Playing on it, downloading, and plays
  // it when the import lands (see pendingPlay.tsx). The catalogue sub-page below
  // still uses playWhenAdded; the feed and open sets arm this instead.
  const playPending = usePendingPlay();
  // null while the first fetch is in flight; an array (possibly empty) after.
  const [items, setItems] = useState<Suggestion[] | null>(null);
  // The server's AI picks: songs you do NOT own, harvested from the artists you
  // play, each actually read (lyrics embedded, tempo measured) and scored
  // against your taste. Null until the first fetch answers.
  const [discoveries, setDiscoveries] = useState<Discovery[] | null>(null);
  const [discTapped, setDiscTapped] = useState<Record<string, AddState>>({});
  // Cards tapped this session, for the instant before the queue reports the
  // job; the queue's own word (stateFrom) always wins once it has one.
  const [tapped, setTapped] = useState<Record<string, AddState>>({});
  // How warm the AI is on this listener: the pool it has measured, and how far
  // along the taste gate they are. Null until the first answer.
  const [warmth, setWarmth] = useState<{
    progress: { pool: number; listened: number };
    taste: { heard: number; needed: number } | null;
  } | null>(null);
  const [preview, setPreview] = useState<Suggestion | null>(null);
  // The charts are the same for every account on the hub, so they sit under a
  // closed lid below everything personal - present for an empty library, out
  // of the way for a full one.
  const [chartsOpen, setChartsOpen] = useState(false);
  /*
   * Playlist lookup: a box for finding whole playlists to pull.
   *
   * Only mounted when the importer is actually available - the rows are
   * nothing but Add buttons, so a surface that cannot download is a surface
   * that lies. An empty query is not idle: the server answers it with what is
   * popular right now, so the section has something to show before anyone
   * types.
   */
  const [plQuery, setPlQuery] = useState('');
  const [plResults, setPlResults] = useState<PlaylistResult[] | null>(null);
  const [plBusy, setPlBusy] = useState(false);
  // The set whose track list is open - the page's own playlists read in full.
  const [openSet, setOpenSet] = useState<SongSet | null>(null);
  // The import job whose arrival should start playback: tapping a song is
  // "get me this and play it", so the tap remembers the job and an effect
  // below watches for its tracks to land in the synced library. One at a time,
  // last tap wins - two pending autoplays would fight over the deck.
  const [playWhenAdded, setPlayWhenAdded] = useState<string | null>(null);
  // The trail of catalogue artists being read: a "fans also like" card pushes
  // the next and Back pops one. A stack rather than a single artist because
  // reading Daft Punk → Justice and then going back should land on Daft Punk,
  // not all the way out to the feed.
  const [artistTrail, setArtistTrail] = useState<{ id: string; name: string }[]>([]);
  const artist = artistTrail[artistTrail.length - 1] ?? null;
  const cameFrom = artistTrail[artistTrail.length - 2]?.name ?? 'Discover';
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const refresh = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) {
      setItems([]);
      return;
    }
    try {
      setItems(await fetchDiscover(s));
    } catch {
      // Unreachable, or an old server without the endpoint: settle to empty so
      // the page shows its empty state rather than spinning forever.
      setItems((prev) => prev ?? []);
    }
    // The AI pool grows on the server's own slow clock; a thin answer early is
    // expected, so a failure just leaves what we had rather than blanking it.
    try {
      const feed = await fetchDiscoveries(s);
      setDiscoveries(feed.items);
      // Kept, not discarded: how far along the taste model is and how much of
      // the pool has been measured is what lets the page ASK for listening in
      // real numbers instead of showing an apology.
      setWarmth({ progress: feed.progress, taste: feed.taste ?? null });
    } catch {
      setDiscoveries((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    const wake = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [refresh]);

  const sections = useMemo(() => groupBySection(items ?? []), [items]);

  // The page's playlists: what just landed in the library, what the curator
  // already fetched, and the AI's finds grouped by the artist they hang off -
  // sets to open and move through, not a wall of single-song cards.
  const sets = useMemo<SongSet[]>(() => {
    const out: SongSet[] = [];
    const freshWindow = 30 * 24 * 60 * 60 * 1000;
    // libraryTracks arrive newest-first, so the slice IS the newest.
    const fresh = libraryTracks.filter((t) => Date.now() - t.addedAt < freshWindow).slice(0, 40);
    if (fresh.length >= 3) {
      out.push({
        key: 'new-in-library',
        title: 'New in your library',
        blurb: `${fresh.length} songs that just landed`,
        kind: 'owned',
        tracks: fresh,
        covers: mosaicOf(fresh.map((t) => t.artwork)),
      });
    }
    // "Fetched for you" used to be built here from the same array, as a set
    // tile. The real ForYouShelf renders below instead: it filters the pulls to
    // THIS listener's and carries the halted-budget warning, neither of which a
    // tile could say.
    const bySeed = new Map<string, Discovery[]>();
    for (const d of discoveries ?? []) {
      if (!d.seed) continue;
      const bucket = bySeed.get(d.seed) ?? [];
      bucket.push(d);
      bySeed.set(d.seed, bucket);
    }
    for (const [seed, list] of bySeed) {
      if (list.length < 3) continue;
      out.push({
        key: `seed-${seed}`,
        title: `Because you play ${seed}`,
        blurb: `${list.length} new songs down that road`,
        kind: 'discoveries',
        discoveries: list,
        covers: mosaicOf(list.map((d) => d.cover)),
      });
    }
    return out;
  }, [libraryTracks, forYou, discoveries]);

  // The hero: the AI's freshest finds as one big set leading the page. With
  // no discoveries yet, the newest of the other sets stands in - the page
  // still opens on a place to go.
  const hero = useMemo<SongSet | null>(() => {
    if (discoveries && discoveries.length >= 3) {
      return {
        key: 'fresh-finds',
        title: 'Fresh finds',
        blurb: `${Math.min(discoveries.length, 25)} new songs picked from what you play`,
        kind: 'discoveries',
        discoveries: discoveries.slice(0, 25),
        covers: mosaicOf(discoveries.map((d) => d.cover)),
      };
    }
    return sets[0] ?? null;
  }, [discoveries, sets]);
  const shelfSets = sets.filter((s) => s.key !== hero?.key);

  // The artists you own the most OF, as doors into their full catalogue. This
  // is the one shelf here that needs no server, no model and no listening
  // history - your library alone says who these are - so it is what Discover
  // can offer on day one while the taste model is still measuring.
  const ownedArtists = useMemo(() => {
    const counts = new Map<string, { name: string; cover: string | null; n: number }>();
    for (const t of libraryTracks) {
      const name = t.artist.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const at = counts.get(key);
      if (at) {
        at.n += 1;
        if (!at.cover) at.cover = t.artwork;
      } else {
        counts.set(key, { name, cover: t.artwork, n: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 20);
  }, [libraryTracks]);

  const add = (item: Suggestion) => {
    if (!downloads) return;
    const job = jobFor(downloads.jobs, item);
    if (job && job.state !== 'error') return;
    setTapped((prev) => ({ ...prev, [item.id]: 'adding' }));
    void Promise.resolve(downloads.enqueue(item.url))
      .then(() => setTapped((prev) => ({ ...prev, [item.id]: 'added' })))
      .catch(() => {
        // Let the user try again rather than stranding the button.
        setTapped((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      });
  };

  /*
   * The importer, present and running - not merely installed. `handlersFor`
   * asks the live handler set, so a plugin the listener switched off, or one
   * that crashed, or a session with no server, all read the same: no lookup
   * section rather than a section whose Add does nothing.
   */
  const canPullPlaylists =
    !!downloads &&
    acquire
      .handlersFor({ kind: 'playlist', title: '', url: 'https://open.spotify.com/playlist/x' })
      .some((h) => h.pluginId === IMPORTER_PLUGIN_ID);

  useEffect(() => {
    if (!session || !canPullPlaylists) return;
    const ctrl = new AbortController();
    // A beat of quiet before asking, so typing a name is one request and not
    // one per letter. The empty query rides the same path: it is the "what is
    // popular" ask, and it only fires once because the query does not change.
    const t = window.setTimeout(() => {
      setPlBusy(true);
      void searchPlaylists(session, plQuery, ctrl.signal)
        .then((rows) => setPlResults(rows))
        .catch(() => {
          // An older server has no such route, and a search that cannot be
          // made is an empty list rather than a broken page.
          if (!ctrl.signal.aborted) setPlResults([]);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setPlBusy(false);
        });
    }, plQuery ? 350 : 0);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [session, plQuery, canPullPlaylists]);

  /** Pull a whole playlist: the same enqueue every other Add on this page
   *  uses, so it lands in the one downloads queue with its own progress. */
  const addPlaylist = (row: PlaylistResult) => {
    if (!downloads) return;
    setTapped((prev) => ({ ...prev, [row.id]: 'adding' }));
    void Promise.resolve(downloads.enqueue(row.url))
      .then(() => setTapped((prev) => ({ ...prev, [row.id]: 'added' })))
      .catch(() => {
        setTapped((prev) => {
          const next = { ...prev };
          delete next[row.id];
          return next;
        });
      });
  };

  // The library tracks by server id, for turning a finished job's trackIds
  // into something the player takes.
  const libraryById = useMemo(() => {
    const map = new Map<number, (typeof libraryTracks)[number]>();
    for (const t of libraryTracks) {
      const id = trackIdFromPath(t.path);
      if (id !== null) map.set(id, t);
    }
    return map;
  }, [libraryTracks]);

  /** The first of a job's imported tracks that the library has synced in. */
  const importedTrack = useCallback(
    (job: MusicImportJob | null | undefined) => {
      for (const id of job?.trackIds ?? []) {
        const t = libraryById.get(id);
        if (t) return t;
      }
      return null;
    },
    [libraryById],
  );

  // Fires the armed autoplay: once the watched job is done AND its track has
  // arrived through the library sync, the deck takes it. A failed job disarms
  // instead of waiting forever; a done job with no ids (an older server, or a
  // dead link) disarms quietly rather than pinning a promise it cannot keep.
  useEffect(() => {
    if (!playWhenAdded) return;
    const job = downloads?.jobs?.find((j) => j.id === playWhenAdded);
    if (!job || job.state === 'error') {
      setPlayWhenAdded(null);
      return;
    }
    if (job.state !== 'done') return;
    if (!job.trackIds || job.trackIds.length === 0) {
      setPlayWhenAdded(null);
      return;
    }
    const track = importedTrack(job);
    if (!track) return; // done, but the sync has not landed it yet - wait.
    setPlayWhenAdded(null);
    onPlay(track, [track]);
  }, [playWhenAdded, downloads?.jobs, importedTrack, onPlay]);

  // Route a card's Add through the acquire hub. The gate itself lives on the
  // button (canAdd = hasHandlers); this only picks the PATH. Whenever the
  // importer can service the target, keep Discover's own flow - the card
  // reflects the queue, and a tapped song autoplays once it lands. Only with
  // the importer off does this hand to the chooser.
  const canImport = (target: AcquireTarget) =>
    acquire.handlersFor(target).some((h) => h.pluginId === IMPORTER_PLUGIN_ID);

  /** An AI pick's Add state: the library first (a song you already have reads
   *  as added however it got here), then the queue, then the optimistic tap. */
  const discoveryState = (d: Discovery): AddState => {
    if (owned.has(d.artist, d.title)) return 'added';
    const job = downloads?.jobs?.find((j) => j.url === d.url) ?? null;
    if (job?.state === 'done') return 'added';
    if (job?.state === 'queued' || job?.state === 'downloading') return 'adding';
    return discTapped[d.id] ?? 'idle';
  };
  /** Add an AI pick: straight to the queue (and armed for autoplay) when the
   *  importer can take it, else the chooser. */
  const addDiscovery = (d: Discovery) => {
    const target = discoveryTarget(d);
    if (!acquire.hasHandlers(target)) return;
    if (!canImport(target)) {
      acquire.acquire(target);
      return;
    }
    if (!downloads) return;
    const job = downloads.jobs?.find((j) => j.url === d.url) ?? null;
    if (job && job.state !== 'error') return;
    setDiscTapped((prev) => ({ ...prev, [d.id]: 'adding' }));
    void Promise.resolve(downloads.enqueue(d.url, true))
      .then((queued) => {
        setDiscTapped((prev) => ({ ...prev, [d.id]: 'added' }));
        playPending?.(
          placeholderTrack({ jobId: queued.id, title: d.title, artist: d.artist, artwork: d.cover }),
          queued.id,
        );
      })
      .catch(() => {
        setDiscTapped((prev) => {
          const next = { ...prev };
          delete next[d.id];
          return next;
        });
      });
  };
  const onAddSuggestion = (item: Suggestion) => {
    if (canImport(suggestionTarget(item))) add(item);
    else acquire.acquire(suggestionTarget(item));
  };

  /** Everything a card or the preview needs to render one suggestion. */
  const describe = (item: Suggestion) => {
    const job = jobFor(downloads?.jobs, item);
    const state = stateFrom(job, tapped[item.id]);
    const progress =
      job && job.state === 'downloading' && job.total ? `${job.completed}/${job.total}` : null;
    return { state, progress, canAdd: acquire.hasHandlers(suggestionTarget(item)) };
  };

  // An artist owns the whole page while one is open: the feed it was reached
  // from is still in state, so Back returns to it intact.
  if (artist) {
    return (
      <CatalogArtistPage
        artistId={artist.id}
        artistName={artist.name}
        backLabel={cameFrom}
        onBack={() => setArtistTrail((t) => t.slice(0, -1))}
        onOpenArtist={(id, name) => setArtistTrail((t) => [...t, { id, name }])}
        onTrackQueued={setPlayWhenAdded}
        onPlay={onPlay}
      />
    );
  }

  return (
    <div className="discoverPage" ref={setRippleRoot}>
      {/* Same bar as Library. Discover is where you look for what you do NOT
          have, so the prompt says so - the page it opens searches both. */}
      <SearchEntry placeholder="Search for music to add" />
      <header className="discoverHead">
        <span className="discoverHead__glyph" aria-hidden>
          <Compass size={22} />
        </span>
        <div className="discoverHead__text">
          <h1 className="discoverHead__title">Discover</h1>
          {/* One true sentence about where the picks stand, in songs rather
              than percentages - and never both an ask and a full page. */}
          <p className="discoverHead__blurb">{warmthLine(warmth, discoveries)}</p>
        </div>
      </header>

      {/* What the AI made FROM your library: mixes whose every track you
          already own, so they play the instant you tap them. They lead the
          personal half of the page because they are the only thing here that
          works on day one - a pool of unowned finds has to be measured first,
          but a mix of your own music does not. They used to sit on Library,
          which is what made Discover read as somebody else's charts. */}
      <CuratorShelves onPlay={onPlay} onOpenArtist={onOpenArtist} />

      {/* What the collector went and FETCHED on your behalf, awaiting a
          listen to earn its place in the library proper. It belongs beside
          the rest of the AI's work rather than on the page about music you
          already chose. */}
      <ForYouShelf onPlay={onPlay} />

      {/* Their whole catalogue, not just the tracks you happen to own - tapping
          one opens the artist page, where what you have is playable and what you
          do not is one tap from being yours. */}
      {ownedArtists.length >= 4 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">More from artists you own</h2>
          <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
            <div className="homeShelfRow">
              {ownedArtists.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  className="artistCard"
                  onClick={() => setArtistTrail([{ id: '', name: a.name }])}
                >
                  <img
                    className="artistCardArt artPop"
                    src={artSized(a.cover, 640) ?? discoverPlaceholder}
                    alt=""
                    loading="lazy"
                  />
                  <span className="artistCardName">{a.name}</span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </section>
      )}

      {/* The hero: the AI's freshest finds as one place to walk into, leading
          the page the way the live jam leads Friends - the newest thing, big. */}
      {hero && (
        <button type="button" className="discoverHero" onClick={() => setOpenSet(hero)}>
          <span className="discoverHero__art">
            <SetMosaic covers={hero.covers} size="hero" />
          </span>
          <span className="discoverHero__scrim" aria-hidden />
          <span className="discoverHero__text">
            <span className="discoverHero__kicker">
              <Sparkles size={13} /> {hero.kind === 'discoveries' ? 'Made by your AI' : 'From your library'}
            </span>
            <span className="discoverHero__title">{hero.title}</span>
            <span className="discoverHero__blurb">{hero.blurb}</span>
          </span>
        </button>
      )}

      {/* The page's playlists: new songs grouped into places to go - a seed
          artist's trail, the curator's own pulls, what just landed - instead
          of a wall of single-song suggestions. */}
      {shelfSets.length > 0 && (
        <section className="discoverSection">
          <h2 className="discoverSection__title">New for you</h2>
          <div className="discoverGrid discoverGrid--sets">
            {shelfSets.map((set) => (
              <button key={set.key} type="button" className="discoverSetCard" onClick={() => setOpenSet(set)}>
                <span className="suggestCardCover discoverSetCard__cover">
                  <SetMosaic covers={set.covers} />
                  <span className="discoverSetCard__count">
                    {(set.tracks ?? set.discoveries ?? []).length}
                  </span>
                </span>
                <span className="suggestCardTitle">{set.title}</span>
                <span className="suggestCardBlurb">{set.blurb}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Find a playlist and pull it whole. Above the charts lid because it
          is a verb rather than a browse, and gated on the importer actually
          running - see canPullPlaylists. */}
      {canPullPlaylists && (
        <section className="discoverPl">
          <div className="discoverPl__head">
            <span className="discoverPl__glyph" aria-hidden="true">
              <ListMusic size={15} />
            </span>
            <h2 className="discoverPl__title">Find a playlist</h2>
            {plBusy && <Spinner size="sm" aria-label="Searching" />}
          </div>
          <SearchField
            value={plQuery}
            onValueChange={setPlQuery}
            placeholder="Playlists by name — or leave empty for what's popular"
            aria-label="Search playlists"
          />
          {plResults && plResults.length === 0 && plQuery.trim() !== '' && !plBusy && (
            <Text tone="muted" size="sm">
              Nothing by that name.
            </Text>
          )}
          <div className="discoverPl__rows">
            {(plResults ?? []).map((row) => {
              const state = tapped[row.id];
              return (
                <div key={row.id} className="discoverPlRow">
                  {row.cover ? (
                    <img className="discoverPlRow__art" src={row.cover} alt="" loading="lazy" />
                  ) : (
                    <span className="discoverPlRow__art discoverPlRow__art--blank" aria-hidden="true">
                      <ListMusic size={16} />
                    </span>
                  )}
                  <span className="discoverPlRow__text">
                    <span className="discoverPlRow__name">{row.title}</span>
                    <span className="discoverPlRow__sub">{row.subtitle}</span>
                  </span>
                  <button
                    type="button"
                    className="discoverPlRow__add"
                    disabled={state === 'adding' || state === 'added'}
                    aria-label={`Download ${row.title}`}
                    onClick={() => addPlaylist(row)}
                  >
                    {state === 'added' ? (
                      <Check size={15} />
                    ) : state === 'adding' ? (
                      <Spinner size="sm" aria-label="Starting" />
                    ) : (
                      <Plus size={15} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Everything above this line is about YOU. Everything below is the same
          for every account on this server, which is why it is behind a lid and
          at the bottom rather than leading the page as it used to. */}
      {items && items.length > 0 && (
        <button
          type="button"
          className="discoverCharts__toggle"
          aria-expanded={chartsOpen}
          onClick={() => setChartsOpen((v) => !v)}
        >
          <Compass size={16} />
          <span>Browse the charts</span>
          <span className="discoverCharts__hint">{chartsOpen ? 'Hide' : 'Show'}</span>
        </button>
      )}

      {items === null && !(discoveries && discoveries.length > 0) ? null : chartsOpen &&
        items &&
        items.length > 0 ? (
        sections.map(({ section, items: group }) => {
          // Each section leads with its first chart writ large - a featured
          // card wearing its cover as a backdrop - and the rest keep the grid.
          const featured = group[0];
          const featuredCover = featured?.cover ?? null;
          // No per-section hero any more. A chart playlist rendered large,
          // above the grid, outranked the listener's own music visually - which
          // is backwards on a page that is supposed to be about their taste.
          const showHero = false;
          const gridItems = showHero ? group.slice(1) : group;
          const featuredState = showHero && featured ? describe(featured) : null;
          return (
            <section key={section} className="discoverSection">
              <h2 className="discoverSection__title">{section}</h2>
              {featured && featuredCover && featuredState && (
                <div className="discoverHero discoverHero--suggestion">
                  <button type="button" className="discoverHero__body" onClick={() => setPreview(featured)}>
                    <span className="discoverHero__art">
                      <CoverArt src={featuredCover} lazy />
                    </span>
                    <span className="discoverHero__scrim" aria-hidden />
                    <span className="discoverHero__text">
                      <span className="discoverHero__kicker">Featured</span>
                      <span className="discoverHero__title">{featured.title}</span>
                      <span className="discoverHero__blurb">{featured.blurb}</span>
                    </span>
                  </button>
                  <span className="discoverHero__action">
                    <AddButton
                      item={featured}
                      state={featuredState.state}
                      canAdd={featuredState.canAdd}
                      progress={featuredState.progress}
                      onAdd={() => onAddSuggestion(featured)}
                    />
                  </span>
                </div>
              )}
              <div className="discoverGrid">
                {gridItems.map((item) => {
                  const d = describe(item);
                  return (
                    <SuggestionCard
                      key={item.id}
                      item={item}
                      state={d.state}
                      canAdd={d.canAdd}
                      progress={d.progress}
                      onAdd={() => onAddSuggestion(item)}
                      onOpen={() => setPreview(item)}
                    />
                  );
                })}
              </div>
            </section>
          );
        })
      ) : hero || shelfSets.length > 0 ? null : (
        /* Nothing from the hub and nothing of our own to show. A bare header
           reads as a page that failed to load - and, since there is nothing
           below it, as one that will not even scroll. Say what is actually
           true instead, and offer the one thing that might change it. */
        <div className="emptyState emptyState--tall">
          <EmptyArt name="discovery" />
          <p className="emptyState__text">
            {session
              ? 'Nothing to suggest yet. Your server builds this from charts and from what you play, so it fills in once it has both — play a few things, or try again.'
              : 'Discover comes from your server. Sign in to one and this fills with charts and picks made from what you play.'}
          </p>
          {session && (
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          )}
        </div>
      )}

      {/* A set, read in full: owned rows play right now (the row IS the
          playlist entry), discovery rows carry the same add-then-play the
          old grid cards had - just with the company they came with. */}
      {openSet && (
        <Modal open onClose={() => setOpenSet(null)} title={openSet.title} size="md">
          <div className="discoverSetList">
            <Text tone="muted" size="sm">
              {openSet.blurb}
            </Text>
            {openSet.kind === 'owned'
              ? openSet.tracks!.map((t) => (
                  <TrackMenu key={t.path} track={t} className="discoverSetRowMenu">
                  <button
                    type="button"
                    className="discoverSetRow"
                    onClick={() => {
                      setOpenSet(null);
                      onPlay(t, openSet.tracks!);
                    }}
                  >
                    <span className="discoverSetRow__cover">
                      {t.artwork ? <CoverArt src={t.artwork} lazy /> : <Music size={16} />}
                    </span>
                    <span className="discoverSetRow__text">
                      <span className="discoverSetRow__title">{t.title}</span>
                      <span className="discoverSetRow__sub">{t.artist}</span>
                    </span>
                    <span className="discoverSetRow__go" aria-hidden>
                      <Play size={14} />
                    </span>
                  </button>
                  </TrackMenu>
                ))
              : openSet.discoveries!.map((d) => {
                  const state = discoveryState(d);
                  const canAdd = acquire.hasHandlers(discoveryTarget(d));
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className="discoverSetRow"
                      disabled={state === 'idle' && !canAdd}
                      title={
                        state === 'idle' && !canAdd
                          ? 'No way to add this — enable Music import in Plugins'
                          : undefined
                      }
                      onClick={() => {
                        const job = downloads?.jobs?.find((j) => j.url === d.url) ?? null;
                        if (state === 'added') {
                          const t = importedTrack(job) ?? owned.find(d.artist, d.title);
                          if (t) {
                            setOpenSet(null);
                            onPlay(t, [t]);
                          }
                        } else if (state === 'adding') {
                          if (job)
                            playPending?.(
                              placeholderTrack({
                                jobId: job.id,
                                title: d.title,
                                artist: d.artist,
                                artwork: d.cover,
                              }),
                              job.id,
                            );
                        } else {
                          addDiscovery(d);
                        }
                      }}
                    >
                      <span className="discoverSetRow__cover">
                        {d.cover ? <CoverArt src={d.cover} lazy /> : <Music size={16} />}
                      </span>
                      <span className="discoverSetRow__text">
                        <span className="discoverSetRow__title">{d.title}</span>
                        <span className="discoverSetRow__sub">
                          {d.artist}
                          {d.seed ? ` · because you play ${d.seed}` : ''}
                        </span>
                      </span>
                      <span className="discoverSetRow__badge" data-state={state}>
                        {state === 'added' ? (
                          <Check size={14} />
                        ) : state === 'adding' ? (
                          <span className="resultCard__spin" aria-label="Adding" />
                        ) : (
                          <Plus size={14} />
                        )}
                      </span>
                    </button>
                  );
                })}
          </div>
        </Modal>
      )}

      {preview && (
        <Modal open onClose={() => setPreview(null)} title={preview.title} size="md">
          <div className="discoverPreview">
            <div className="discoverPreview__head">
              <div className="suggestCardCover discoverPreview__cover">
                {preview.cover ? (
                  <CoverArt src={preview.cover} />
                ) : (
                  <div className="suggestCardCover--glyph" aria-hidden>
                    <ListMusic size={26} />
                  </div>
                )}
              </div>
              <div className="discoverPreview__meta">
                <Text tone="muted" size="sm">
                  {preview.blurb}
                </Text>
                {(() => {
                  const d = describe(preview);
                  return (
                    <AddButton
                      item={preview}
                      state={d.state}
                      canAdd={d.canAdd}
                      progress={d.progress}
                      onAdd={() => onAddSuggestion(preview)}
                    />
                  );
                })()}
              </div>
            </div>
            {preview.tracks && preview.tracks.length > 0 ? (
              <ol className="discoverPreview__tracks">
                {preview.tracks.map((t, i) => (
                  <li key={`${i}-${t}`}>{t}</li>
                ))}
              </ol>
            ) : preview.kind === 'track' ? null : (
              <Text tone="muted" size="sm">
                {preview.kind === 'album'
                  ? 'Add the album and it downloads track by track.'
                  : 'No track list available for this playlist.'}
              </Text>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
