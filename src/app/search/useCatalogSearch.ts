import { useEffect, useMemo, useRef, useState } from 'react';
import { searchCatalog, type SearchResult, type ServerSession } from '../server.ts';
import type { OwnedIndex } from '../library/owned.ts';
import { IMPORTER_PLUGIN_ID, type AcquireValue } from '../../plugins/runtime.tsx';
import type { DownloadsContextValue } from '../../plugins/importsBridge.ts';
import { placeholderTrack, type PlayPending } from '../player/pendingPlay.tsx';
import { importable, resolveImportable } from './resolveImport.ts';
import type { AcquireTarget } from '../../plugins/types.ts';
import { isAbout } from './searchModel.tsx';

/** What a tapped catalogue row is doing. */
export type AddingState = Record<string, 'finding' | 'added' | 'missing'>;

/**
 * The remote half of the search page: the debounced catalogue fetch, the
 * dedupe against what the library already shows, and the Add verb that pulls
 * a row down. Split from SearchPage.tsx so the page keeps only what it renders.
 */
export function useCatalogSearch({
  query,
  parsedPhrase,
  shownPaths,
  owned,
  acquire,
  downloads,
  playPending,
  server,
}: {
  query: string;
  /** The free-text phrase of the parsed query, for the artist-lead promotion. */
  parsedPhrase: string;
  /** Paths of the library songs already on the page, so a catalogue twin stands aside. */
  shownPaths: ReadonlySet<string>;
  owned: OwnedIndex;
  acquire: AcquireValue;
  downloads: DownloadsContextValue | null;
  playPending: PlayPending | null;
  server: ServerSession | null;
}): {
  catalog: SearchResult[] | null;
  outside: SearchResult[];
  adding: AddingState;
  acquireResult: (r: SearchResult) => Promise<void>;
} {
  // null while the catalogue fetch for a query is in flight, [] when it came
  // back empty.
  const [catalog, setCatalog] = useState<SearchResult[] | null>(null);
  // What a tapped catalogue row is doing. An album usually reaches us as a
  // Deezer link the importer will not take, so the tap looks for its Spotify
  // twin first - a beat of network that has to be visible on the row.
  const [adding, setAdding] = useState<AddingState>({});

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

  // A catalogue row whose copy is already listed above would be the same song
  // twice; it stands aside. Matched through the library index, so a row goes
  // only when the very track it resolves to is one of the ones shown.
  const outside = useMemo(() => {
    const rows = (catalog ?? []).filter((r) => {
      if (r.kind !== 'track') return true;
      const mine = owned.find(r.subtitle, r.title);
      return !mine || !shownPaths.has(mine.path);
    });
    // The server sends artists LAST - tracks are the rows you can add in a
    // tap, so they lead - but the collapsed section only shows a handful, and
    // an artist sitting nineteenth may as well not exist. Typing a name is
    // asking for the PERSON, so whoever's name is the query comes first: the
    // door to their catalogue is the answer, and the tracks are still right
    // behind it.
    const lead = rows.filter((r) => r.kind === 'artist' && isAbout(r.title, parsedPhrase));
    return lead.length > 0 ? [...lead, ...rows.filter((r) => !lead.includes(r))] : rows;
  }, [catalog, owned, shownPaths, parsedPhrase]);

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
    const hand = async (title: string, url: string) => {
      const target: AcquireTarget = { kind, title, artist: r.subtitle, url };
      const viaImporter = acquire.handlersFor(target).some((h) => h.pluginId === IMPORTER_PLUGIN_ID);
      if (viaImporter && downloads) {
        try {
          // A single tapped track is now-playing (reserved slot); an album is a
          // background set.
          const job = await downloads.enqueue(url, kind === 'track');
          // A single tapped track opens Now Playing on it, downloading, and
          // plays when it lands; an album is a set, so it just queues. The
          // placeholder wears the ROW's own art/name, even if the download URL
          // came from a resolved twin.
          if (kind === 'track') {
            playPending?.(
              placeholderTrack({ jobId: job.id, title: r.title, artist: r.subtitle, artwork: r.cover }),
              job.id,
            );
          }
        } catch {
          // Enqueue refused; the row's 'added' state is the only feedback.
        }
      } else acquire.acquire(target);
    };

    if (importable(r)) {
      await hand(r.title, r.url);
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
    await hand(found.title, found.url);
    setAdding((prev) => ({ ...prev, [r.id]: 'added' }));
  };

  return { catalog, outside, adding, acquireResult };
}
