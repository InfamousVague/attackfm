import { Modal, SearchField, Text } from '@glacier/react';
import { Check, ChevronRight, Compass, ListMusic, Music, Plus, User } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServerSession } from '../../app/serverSession.tsx';
import { useLibrary } from '../../app/library.tsx';
import {
  fetchDiscover,
  searchCatalog,
  trackIdFromPath,
  type SearchResult,
  type Suggestion,
} from '../../app/server.ts';
import type { AcquireTarget, PluginPageProps } from '../types.ts';
import { useAcquire } from '../runtime.tsx';
import { useDownloadsOptional } from '../importsBridge.ts';
import { CatalogArtistPage } from './CatalogArtistPage.tsx';
import type { MusicImportJob } from '../importsBridge.ts';

/** A curated playlist card, as an acquire target: a whole list, no single
 *  artist, carrying the URL an importer would pull. */
function suggestionTarget(item: Suggestion): AcquireTarget {
  return { kind: 'playlist', title: item.title, url: item.url };
}

/** A searched song, as an acquire target: title and artist for a store search,
 *  URL for a download. */
function resultTarget(r: SearchResult): AcquireTarget {
  return { kind: 'track', title: r.title, artist: r.subtitle, url: r.url };
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

/** The import job for a suggestion, if one exists: matched by the playlist id
 *  inside the job's URL, so a pasted-link import of the same chart counts. */
function jobFor(jobs: readonly MusicImportJob[] | undefined, item: Suggestion): MusicImportJob | null {
  return jobs?.find((j) => j.url.includes(item.id)) ?? null;
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
            <img src={item.cover} alt="" loading="lazy" />
          ) : (
            <div className="suggestCardCover--glyph" aria-hidden>
              <ListMusic size={26} />
            </div>
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

// The play/navigation doors are part of the page contract, but Discover adds to
// the library rather than starting playback, so it takes none of them today.
export function DiscoverPage({ onPlay }: PluginPageProps) {
  const { session } = useServerSession();
  const downloads = useDownloadsOptional();
  const acquire = useAcquire();
  const { tracks: libraryTracks } = useLibrary();
  // null while the first fetch is in flight; an array (possibly empty) after.
  const [items, setItems] = useState<Suggestion[] | null>(null);
  // Cards tapped this session, for the instant before the queue reports the
  // job; the queue's own word (stateFrom) always wins once it has one.
  const [tapped, setTapped] = useState<Record<string, AddState>>({});
  const [preview, setPreview] = useState<Suggestion | null>(null);
  // External search over Spotify + Deezer. `query` empty ⇒ the curated feed
  // shows; otherwise `results` holds the hits (null while the first fetch for a
  // query is in flight, [] when it came back empty). `searchTapped` mirrors the
  // Add optimism the curated cards use, keyed by result id.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchTapped, setSearchTapped] = useState<Record<string, AddState>>({});
  // The import job whose arrival should start playback: tapping a song is
  // "get me this and play it", so the tap remembers the job and an effect
  // below watches for its tracks to land in the synced library. One at a time,
  // last tap wins - two pending autoplays would fight over the deck.
  const [playWhenAdded, setPlayWhenAdded] = useState<string | null>(null);
  // The trail of catalogue artists being read: a search row pushes the first,
  // a "fans also like" card pushes the next, and Back pops one. A stack rather
  // than a single artist because reading Daft Punk → Justice and then going
  // back should land on Daft Punk, not all the way out to the search.
  const [artistTrail, setArtistTrail] = useState<{ id: string; name: string }[]>([]);
  const artist = artistTrail[artistTrail.length - 1] ?? null;
  const cameFrom = artistTrail[artistTrail.length - 2]?.name ?? 'Discover';
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Debounced search: a fresh keystroke cancels the pending fetch (and aborts
  // one already in flight), so only the last query in a burst hits the server.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const s = sessionRef.current;
    if (!s) return;
    setResults(null);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void searchCatalog(s, q, ctrl.signal)
        .then((r) => setResults(r))
        .catch(() => {
          if (!ctrl.signal.aborted) setResults([]);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

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
  const searching = query.trim().length > 0;

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

  /** Import a searched track through the same queue the curated cards use,
   *  matched back to any existing job by its URL. Tapping a song means "play
   *  it when it gets here", so the new job is armed for autoplay too. */
  const addResult = (r: SearchResult) => {
    if (!downloads || r.kind !== 'track' || !r.url) return;
    const job = downloads.jobs?.find((j) => j.url === r.url) ?? null;
    if (job && job.state !== 'error') return;
    setSearchTapped((prev) => ({ ...prev, [r.id]: 'adding' }));
    void Promise.resolve(downloads.enqueue(r.url))
      .then((queued) => {
        setSearchTapped((prev) => ({ ...prev, [r.id]: 'added' }));
        setPlayWhenAdded(queued.id);
      })
      .catch(() => {
        setSearchTapped((prev) => {
          const next = { ...prev };
          delete next[r.id];
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
  // button (canAdd = hasHandlers); this only picks the PATH. When the importer
  // is the one and only way to get this, keep Discover's own flow - the card
  // reflects the queue, and a tapped song autoplays once it lands. Otherwise
  // (Buy is also on, or the importer is off) hand to the chooser, which offers
  // every applicable handler and runs the picked one.
  const soleImporter = (target: AcquireTarget) => {
    const hs = acquire.handlersFor(target);
    return hs.length === 1 && hs[0]?.pluginId === 'spotify-import';
  };
  const onAddSuggestion = (item: Suggestion) => {
    if (soleImporter(suggestionTarget(item))) add(item);
    else acquire.acquire(suggestionTarget(item));
  };
  const onAddResult = (r: SearchResult) => {
    if (r.kind !== 'track') return;
    if (soleImporter(resultTarget(r))) addResult(r);
    else acquire.acquire(resultTarget(r));
  };

  /** The Add state of a searched track, the queue's word winning over the tap. */
  const resultState = (r: SearchResult): AddState => {
    const job = downloads?.jobs?.find((j) => j.url === r.url) ?? null;
    return stateFrom(job, searchTapped[r.id]);
  };

  /** Everything a card or the preview needs to render one suggestion. */
  const describe = (item: Suggestion) => {
    const job = jobFor(downloads?.jobs, item);
    const state = stateFrom(job, tapped[item.id]);
    const progress =
      job && job.state === 'downloading' && job.total ? `${job.completed}/${job.total}` : null;
    return { state, progress, canAdd: acquire.hasHandlers(suggestionTarget(item)) };
  };

  // An artist owns the whole page while one is open: the feed and the search
  // it was reached from are still in state, so Back returns to them intact.
  if (artist) {
    return (
      <CatalogArtistPage
        artistId={artist.id}
        artistName={artist.name}
        backLabel={cameFrom}
        onBack={() => setArtistTrail((t) => t.slice(0, -1))}
        onOpenArtist={(id, name) => setArtistTrail((t) => [...t, { id, name }])}
        onTrackQueued={setPlayWhenAdded}
      />
    );
  }

  return (
    <div className="discoverPage">
      <header className="discoverHead">
        <span className="discoverHead__glyph" aria-hidden>
          <Compass size={22} />
        </span>
        <div className="discoverHead__text">
          <h1 className="discoverHead__title">Discover</h1>
          <p className="discoverHead__blurb">
            Search Spotify and other public sources for new artists and songs, or
            browse the charts and staples your server keeps fresh. Everything adds
            through your import queue.
          </p>
        </div>
      </header>

      <SearchField
        className="pageSearch"
        value={query}
        onValueChange={setQuery}
        placeholder="Search new artists and songs"
        aria-label="Search new artists and songs"
      />

      {searching ? (
        results === null ? (
          <p className="discoverNote" role="status">
            Searching…
          </p>
        ) : results.length === 0 ? (
          <p className="discoverNote">Nothing found for “{query.trim()}”.</p>
        ) : (
          <div className="discoverGrid">
            {results.map((r) => {
              const isTrack = r.kind === 'track';
              const state = resultState(r);
              const canAdd = acquire.hasHandlers(resultTarget(r));
              return (
                <button
                  key={r.id}
                  type="button"
                  className="resultCard"
                  data-kind={r.kind}
                  disabled={isTrack && !canAdd}
                  // A track is a thing to hear; an artist is a place to go. A
                  // fresh tap imports AND arms autoplay; a tap mid-download
                  // re-arms it (play this one when it lands); a tap on an
                  // already-imported song just plays it from the library.
                  onClick={() => {
                    if (!isTrack) {
                      setArtistTrail([{ id: r.id, name: r.title }]);
                      return;
                    }
                    const job = downloads?.jobs?.find((j) => j.url === r.url) ?? null;
                    if (state === 'added') {
                      const track = importedTrack(job);
                      if (track) onPlay(track, [track]);
                    } else if (state === 'adding') {
                      if (job) setPlayWhenAdded(job.id);
                    } else {
                      onAddResult(r);
                    }
                  }}
                  title={
                    isTrack && !canAdd
                      ? 'No way to add this — enable Music import or Buy in Plugins'
                      : undefined
                  }
                >
                  <span className="resultCard__cover" data-kind={r.kind}>
                    {r.cover ? (
                      <img src={r.cover} alt="" loading="lazy" />
                    ) : isTrack ? (
                      <Music size={22} />
                    ) : (
                      <User size={22} />
                    )}
                  </span>
                  <span className="resultCard__title">{r.title}</span>
                  <span className="resultCard__sub">{r.subtitle}</span>
                  <span className="resultCard__badge" data-state={isTrack ? state : 'artist'}>
                    {!isTrack ? (
                      // The row opens the artist now rather than re-running the
                      // search, so it points onward instead of back at itself.
                      <ChevronRight size={14} />
                    ) : state === 'added' ? (
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
        )
      ) : items === null ? (
        <p className="discoverNote" role="status">
          Loading suggestions…
        </p>
      ) : items.length === 0 ? (
        <p className="discoverNote">
          No suggestions right now — check your server connection and try again.
        </p>
      ) : (
        sections.map(({ section, items: group }) => (
          <section key={section} className="discoverSection">
            <h2 className="discoverSection__title">{section}</h2>
            <div className="discoverGrid">
              {group.map((item) => {
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
        ))
      )}

      {preview && (
        <Modal open onClose={() => setPreview(null)} title={preview.title} size="md">
          <div className="discoverPreview">
            <div className="discoverPreview__head">
              <div className="suggestCardCover discoverPreview__cover">
                {preview.cover ? (
                  <img src={preview.cover} alt="" />
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
            ) : (
              <Text tone="muted" size="sm">
                No track list available for this playlist.
              </Text>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
