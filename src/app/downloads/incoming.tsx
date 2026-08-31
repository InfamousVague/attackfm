import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import {
  fetchPendingLikes,
  fetchCollectorStatus,
  removePendingLike,
  type PendingLike,
} from '../server.ts';
import { fold } from '../core/fold.ts';
import { titleKey } from '../library/owned.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Every song on its way onto this box, in one place - the spine of the
 * "invisible downloads" surface. A download used to be a page you went to;
 * now the song simply appears wherever it will live, wearing a spinner, and
 * settles into a real row the moment it lands.
 *
 * Three currents feed it, all keyed by the SAME folded identity the server
 * settles on (fold(artist) + '|' + titleKey(title) == the server's key_of):
 *   - liked-but-not-here-yet   (pending_likes, per-user, cross-device)
 *   - the collector's finds in flight (CollectorStatus.recent, offered/fetching/queued)
 *   - the importer's active jobs (queued/downloading), per song
 *
 * The provider is the one poller so a dozen surfaces do not each hammer the
 * hub, and it does two jobs beyond merging: it DROPS anything the library
 * already owns (so a ghost dissolves the instant the real row lands, in the
 * same render the table grows), and for a landed LIKE it promotes the real
 * track into favourites client-side - because favourite membership is not in
 * the sync delta, so without this a kept song would land in All Songs but
 * not in Liked until the session remounted.
 */

export type IncomingSource = 'like' | 'collector' | 'import';

export interface IncomingTrack {
  /** fold(artist)|titleKey(title) - equal to the server's key_of/pending key. */
  key: string;
  title: string;
  artist: string;
  artwork: string | null;
  /** 0..1 when a real fraction is known (multi-track imports); null = the
   *  honest indeterminate a delegated download can only ever be. */
  progress: number | null;
  source: IncomingSource;
  /** Call it off, when calling it off is possible (a promised like, an import
   *  job); collector offers just ride until they land or lapse. */
  onCancel?: () => void;
  /** A promised like whose download is NOT currently running (the hub retries
   *  it daily): shown as a resting ring and a word, not a spinner pretending
   *  motion over an empty queue. */
  stalled?: boolean;
}

const IncomingContext = createContext<IncomingTrack[]>([]);

/** The one identity string, computed the client side of the server's key_of. */
export function identityKey(artist: string, title: string): string {
  return `${fold(artist)}|${titleKey(title)}`;
}

const POLL_MS = 15_000;

export function IncomingProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const { tracks, isFavorite, toggleFavorite } = useLibrary();
  const refreshNonce = useRefreshNonce();
  const downloads = useDownloadsOptional();

  const [pending, setPending] = useState<PendingLike[]>([]);
  const [collectorRecent, setCollectorRecent] = useState<
    { title: string; artist: string; state: string }[]
  >([]);

  // One poll for the two server feeds. The importer bridge polls itself, so
  // its jobs come through the context below without a fetch here.
  useEffect(() => {
    if (!session) {
      setPending([]);
      setCollectorRecent([]);
      return undefined;
    }
    let alive = true;
    const fetchNow = () => {
      void fetchPendingLikes(session)
        .then((rows) => {
          if (alive) setPending(rows);
        })
        .catch(() => {});
      void fetchCollectorStatus(session)
        .then((s) => {
          if (!alive) return;
          const inflight = (s.recent ?? []).filter(
            (r) => r.state === 'offered' || r.state === 'fetching' || r.state === 'queued',
          );
          setCollectorRecent(inflight.map((r) => ({ title: r.title, artist: r.artist, state: r.state })));
        })
        .catch(() => {});
    };
    // On mount / session change we fetch straight away - the surface is in the
    // listener's hands right now. The interval only spends a request while the
    // app is on screen, and coming BACK to the foreground fetches at once
    // rather than waiting out the interval.
    fetchNow();
    const beat = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      fetchNow();
    };
    const t = window.setInterval(beat, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') fetchNow();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [session, refreshNonce]);

  // What the library already holds, by identity - the landed set.
  const landed = useMemo(() => {
    const s = new Set<string>();
    for (const t of tracks) s.add(identityKey(t.artist, t.title));
    return s;
  }, [tracks]);

  // A landed track by identity, for the favourite reconciliation below.
  const landedByKey = useMemo(() => {
    const m = new Map<string, Track>();
    for (const t of tracks) {
      const k = identityKey(t.artist, t.title);
      if (!m.has(k)) m.set(k, t);
    }
    return m;
  }, [tracks]);

  // A kept song that has arrived must become a real favourite here and now:
  // the sweep on the hub does it too, but minutes late and invisibly, so the
  // Liked list would sit a landed song in All Songs and nowhere else. Driven
  // off the match, idempotent (toggleFavorite/removePendingLike both are).
  useEffect(() => {
    if (!session) return;
    for (const p of pending) {
      const t = landedByKey.get(p.k);
      if (!t) continue;
      if (!isFavorite(t.path)) toggleFavorite(t.path);
      void removePendingLike(session, p.k).catch(() => {});
    }
  }, [pending, landedByKey, session, isFavorite, toggleFavorite]);

  const incoming = useMemo<IncomingTrack[]>(() => {
    const out: IncomingTrack[] = [];
    const seen = new Set<string>();
    const add = (t: IncomingTrack) => {
      if (landed.has(t.key) || seen.has(t.key)) return;
      seen.add(t.key);
      out.push(t);
    };

    // Likes lead: they are the listener's own deliberate wants.
    for (const p of pending) {
      add({
        key: p.k,
        title: p.title,
        artist: p.artist,
        artwork: null,
        progress: null,
        source: 'like',
        stalled: p.downloading === false,
        onCancel: session
          ? () => {
              void removePendingLike(session, p.k).catch(() => {});
              setPending((cur) => cur.filter((x) => x.k !== p.k));
            }
          : undefined,
      });
    }

    // The collector's finds, still on the wire.
    for (const r of collectorRecent) {
      add({
        key: identityKey(r.artist, r.title),
        title: r.title,
        artist: r.artist,
        artwork: null,
        progress: null,
        source: 'collector',
      });
    }

    // The importer's active jobs, expanded to songs. A multi-track job knows
    // its running track and a real fraction; a single import is one song and
    // an honest indeterminate.
    for (const job of downloads?.active ?? []) {
      const cancel = () => downloads?.cancel(job.id);
      const frac =
        job.total && job.total > 1 ? Math.max(0, Math.min(1, job.completed / job.total)) : null;
      if (job.items && job.items.length > 0) {
        for (const it of job.items) {
          if (!it.title) continue;
          add({
            key: identityKey(it.artist, it.title),
            title: it.title,
            artist: it.artist,
            artwork: job.artworkUrl,
            progress: frac,
            source: 'import',
            onCancel: cancel,
          });
        }
      } else {
        const title = job.currentTrack || job.title;
        const artist = job.subtitle ?? '';
        if (!title) continue;
        add({
          key: identityKey(artist, title),
          title,
          artist,
          artwork: job.artworkUrl,
          progress: frac,
          source: 'import',
          onCancel: cancel,
        });
      }
    }
    return out;
  }, [pending, collectorRecent, downloads, landed, session]);

  return <IncomingContext.Provider value={incoming}>{children}</IncomingContext.Provider>;
}

/** Every song on its way in. Empty off a server or with nothing downloading. */
export function useIncoming(): IncomingTrack[] {
  return useContext(IncomingContext);
}

/** The subset a given surface should show: 'like' for the Liked page (only
 *  the listener's own wants), everything for the library. */
export function useIncomingFor(scope: 'all' | 'like'): IncomingTrack[] {
  const all = useIncoming();
  return useMemo(
    () => (scope === 'like' ? all.filter((t) => t.source === 'like') : all),
    [all, scope],
  );
}
