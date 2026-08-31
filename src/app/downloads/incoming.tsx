import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
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
  /** This row has LANDED and is on its way out: the library owns it now, and
   *  it is kept in the band a breath longer only so it can animate out while
   *  the real row animates in below. Set by the provider, read by the band to
   *  play the exit and hide the dismiss X. */
  leaving?: boolean;
}

const IncomingContext = createContext<IncomingTrack[]>([]);
/** Identity keys that crossed from incoming to owned in the last breath, so a
 *  list can animate the arriving row in and the ghost out in step. */
const JustLandedContext = createContext<ReadonlySet<string>>(new Set());

/** How long a just-landed key stays "arriving" - the entrance animation's
 *  own length, after which it is an ordinary row. */
const LANDING_MS = 1100;

/** How long a landed ghost lingers in the band to play its exit before it is
 *  dropped - the exit animation's own length. */
const LEAVE_MS = 700;

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

  // The moment a key crosses from incoming to owned: the ghost was here last
  // render and the library holds it now. This drives BOTH halves of the
  // hand-off, and it MUST live here, in the provider, not in the band: the
  // band is a descendant, and React runs a child's effects before its
  // parent's, so a band computing this itself would test "did it land?" one
  // render before the provider had published the landing - and the ghost
  // would simply blink out. Detected once, at the source, and handed down:
  //   - `justLanded` (keys) so the real row can play its entrance, and
  //   - `leaving` (the ghost itself) held a breath so it can play its exit
  //     WHILE that row arrives below, then pruned back to nothing.
  const [justLanded, setJustLanded] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<IncomingTrack[]>([]);
  const prevLive = useRef<Map<string, IncomingTrack>>(new Map());
  // Prune timers live in a ref, cleared only on unmount - NOT in the effect's
  // own cleanup. Tying them to the effect's lifecycle would cancel a leaving
  // ghost's timers the instant a SECOND song landed (the effect re-runs), and
  // that first ghost would then linger forever. The updates are functional and
  // touch only their own keys, so an orphaned timer firing is harmless.
  const pruneTimers = useRef<number[]>([]);
  // useLayoutEffect, not useEffect, and this is the whole reason: the live
  // merge drops a landed ghost one render before this could add it back as
  // `leaving`, so with a passive effect the ghost blinks out and back across a
  // painted frame. A layout effect re-commits BEFORE the browser paints, so
  // the first frame the eye sees already has the ghost leaving and the row
  // arriving - one motion, no flicker.
  useLayoutEffect(() => {
    const now = new Map(incoming.map((t) => [t.key, t]));
    const arrived: string[] = [];
    const departed: IncomingTrack[] = [];
    for (const [k, t] of prevLive.current) {
      if (!now.has(k) && landed.has(k)) {
        arrived.push(k);
        departed.push({ ...t, leaving: true, onCancel: undefined });
      }
    }
    prevLive.current = now;
    if (arrived.length === 0) return;
    setJustLanded((cur) => {
      const next = new Set(cur);
      for (const k of arrived) next.add(k);
      return next;
    });
    setLeaving((cur) => [...cur, ...departed.filter((d) => !cur.some((x) => x.key === d.key))]);
    pruneTimers.current.push(
      window.setTimeout(() => {
        setJustLanded((cur) => {
          const next = new Set(cur);
          for (const k of arrived) next.delete(k);
          return next;
        });
      }, LANDING_MS),
      window.setTimeout(() => {
        setLeaving((cur) => cur.filter((x) => !arrived.includes(x.key)));
      }, LEAVE_MS),
    );
  }, [incoming, landed]);
  useEffect(() => () => pruneTimers.current.forEach((t) => window.clearTimeout(t)), []);

  // What every surface actually shows: the songs still on the wire, plus any
  // just-landed ghosts still playing their exit. The ghosts are appended (and
  // only while the live list has not already re-added them) so the band keeps
  // drawing them for the length of the animation, even though the provider's
  // live merge above has correctly dropped them as owned.
  const published = useMemo<IncomingTrack[]>(() => {
    if (leaving.length === 0) return incoming;
    const extra = leaving.filter((l) => !incoming.some((t) => t.key === l.key));
    return extra.length === 0 ? incoming : [...incoming, ...extra];
  }, [incoming, leaving]);

  return (
    <IncomingContext.Provider value={published}>
      <JustLandedContext.Provider value={justLanded}>{children}</JustLandedContext.Provider>
    </IncomingContext.Provider>
  );
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

/** Identity keys that landed a breath ago - a row keyed by one of these
 *  should play its entrance animation. `identityKey(artist, title)` is the
 *  key to test a Track against. */
export function useJustLanded(): ReadonlySet<string> {
  return useContext(JustLandedContext);
}
