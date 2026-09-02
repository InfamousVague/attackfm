/**
 * The artist page's "let me hear it" flow: a tap on a Popular song you do not
 * own fetches a TEMPORARY copy and plays it when it lands.
 *
 * Temporary is the collector's word for it. The server raises the pull through
 * the collector's own door, so the song arrives as an audition - in For You,
 * yours, unpromoted - and never in the library proper unless it earns its
 * place: a listen through or a heart adopts it, and a pass in Music Date
 * removes it. Nothing else touches it.
 *
 * Where a landed copy shows up is the subtle part. The stamp that makes it an
 * audition is written on the hub the moment the file lands - but a sync can
 * carry the row a beat before that, as a plain track in `tracks`, and only the
 * next delta moves it to `forYou`. So a copy is looked for in BOTH lists, by
 * the exact credit; and among the auditions by the lead artist alone as well
 * ("X feat. Y" files under X). Not the lead key over `tracks`: that would dress
 * an owned song of the same name as somebody's temporary copy.
 *
 * What the row shows, in order of what is true:
 *   ready    - a copy is here; the title plays it.
 *   fetching - asked for (this sitting) or on the wire (the incoming band's
 *              word, which is the hub's, so a copy another device asked for
 *              shows the same bar - it is on its way either way).
 *   a reason - why it will not be arriving, in the server's words: missing,
 *              unreachable, refused, held, budget, offline, or error. A tap on
 *              a row wearing a reason simply asks again.
 *   idle     - one tap from being fetched.
 *
 * Only what THIS page asked for auto-plays on landing; a copy the collector
 * fetched on its own schedule is offered, not started.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { useMyAuditions } from '../library/myAuditions.ts';
import { identityKey, leadKey, useIncoming } from '../downloads/incoming.tsx';
import { ServerError, fetchCollectorStatus, requestAudition, type AuditionReason } from '../server.ts';
import type { CatalogTrack, ServerSession } from '../server.ts';
import type { Track } from '../core/tauri.ts';

export type AuditionState = 'idle' | 'fetching' | 'ready' | AuditionReason | 'error';

export interface ArtistAudition {
  /** Somewhere can fetch: this box downloads, or it hands work to a peer -
   *  and the collector is not at its cap, and the server knows the door. */
  can: boolean;
  stateOf: (t: CatalogTrack) => AuditionState;
  /** The landed copy, when one is here - for the heart and the add button
   *  to act on it rather than raise a second download. */
  copyOf: (t: CatalogTrack) => Track | null;
  /** Play the copy if it is here, otherwise ask for one. */
  listen: (t: CatalogTrack) => void;
}

/** How long a vanished in-flight row gets to land before it reads as dropped:
 *  the band polls the hub on one clock and the library syncs on another, so a
 *  landing can leave the band a beat before it reaches the shelf. */
const LAND_GRACE_MS = 20_000;
/** How long a queued pull may stay unseen by the band before the ledger is
 *  asked about it directly: four polls of the band, which shows even an offer
 *  nobody has taken - so a pull still unseen after this has failed, or the
 *  hub has dropped it, before the band ever caught it. */
const UNSEEN_MS = 60_000;
/** How long a reason stays on the row before the tap is an offer again. */
const REASON_MS = 4000;

type Pending = 'fetching' | AuditionReason | 'error';

export function useArtistAudition(
  artist: string,
  session: ServerSession | null,
  onPlay: (track: Track, queue: Track[]) => void,
): ArtistAudition {
  const { forYou, tracks } = useLibrary();
  const { status } = useMyAuditions();
  const incoming = useIncoming();
  // Rows this page asked for, keyed by identity, and what they are doing.
  const [pending, setPending] = useState<Record<string, Pending>>({});
  // A server without the door at all (404): every row goes back to a label.
  const [unsupported, setUnsupported] = useState(false);
  // Keys whose landing should start playback - only the ones tapped here -
  // with the title, so the landing can also be looked for by the lead artist.
  const wanted = useRef(new Map<string, string>());
  // Keys the band has shown in flight, so a later absence means "gone".
  const seen = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());
  // The latest onPlay without re-running the landing effect for it.
  const play = useRef(onPlay);
  play.current = onPlay;

  const can =
    status !== null &&
    !unsupported &&
    status.halted !== 'cap' &&
    (status.downloadsHere || status.delegates);

  const inflight = useMemo(() => new Set(incoming.map((i) => i.key)), [incoming]);

  // Copies that are here. The exact credit over both lists, an audition first
  // (the same file, seen before and after its stamp); the lead credit over the
  // auditions only.
  const landed = useMemo(() => {
    const m = new Map<string, Track>();
    const put = (t: Track, key: string) => {
      if (!m.has(key)) m.set(key, t);
    };
    for (const t of forYou) put(t, identityKey(t.artist, t.title));
    for (const t of tracks) put(t, identityKey(t.artist, t.title));
    for (const t of forYou) put(t, leadKey(t.artist, t.title));
    return m;
  }, [forYou, tracks]);

  const keyOf = useCallback((t: CatalogTrack) => identityKey(artist, t.title), [artist]);
  const findByTitle = useCallback(
    (title: string): Track | undefined =>
      landed.get(identityKey(artist, title)) ?? landed.get(leadKey(artist, title)),
    [landed, artist],
  );
  const find = useCallback((t: CatalogTrack) => findByTitle(t.title), [findByTitle]);

  const forget = useCallback((key: string) => {
    setPending((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const clearTimer = useCallback((key: string) => {
    const t = timers.current.get(key);
    if (t) window.clearTimeout(t);
    timers.current.delete(key);
  }, []);

  const clearLater = useCallback(
    (key: string, ms: number) => {
      clearTimer(key);
      timers.current.set(
        key,
        window.setTimeout(() => {
          timers.current.delete(key);
          forget(key);
        }, ms),
      );
    },
    [clearTimer, forget],
  );

  const fail = useCallback(
    (key: string, why: AuditionReason | 'error') => {
      wanted.current.delete(key);
      seen.current.delete(key);
      setPending((prev) => ({ ...prev, [key]: why }));
      clearLater(key, REASON_MS);
    },
    [clearLater],
  );

  // Landing: play what was asked for, once, and let the row become "ready".
  useEffect(() => {
    for (const [key, title] of Array.from(wanted.current)) {
      const track = landed.get(key) ?? findByTitle(title);
      if (!track) continue;
      wanted.current.delete(key);
      seen.current.delete(key);
      clearTimer(key);
      forget(key);
      play.current(track, [track]);
    }
  }, [landed, findByTitle, clearTimer, forget]);

  // The wire: a row we asked for that the band showed and no longer shows has
  // either landed (the effect above catches that within the grace) or been
  // dropped by the hub - a failed pull, or a peer that gave up.
  useEffect(() => {
    for (const key of Object.keys(pending)) {
      if (pending[key] !== 'fetching') continue;
      if (inflight.has(key)) {
        seen.current.add(key);
        clearTimer(key);
      } else if (seen.current.has(key) && !timers.current.has(key)) {
        timers.current.set(
          key,
          window.setTimeout(() => {
            timers.current.delete(key);
            if (!wanted.current.has(key)) return;
            // The hub dropped it - not "the catalogue lacks it".
            fail(key, 'unreachable');
          }, LAND_GRACE_MS),
        );
      }
    }
  }, [inflight, pending, fail, clearTimer]);

  useEffect(
    () => () => {
      for (const t of timers.current.values()) window.clearTimeout(t);
      timers.current.clear();
    },
    [],
  );

  const stateOf = useCallback(
    (t: CatalogTrack): AuditionState => {
      if (find(t)) return 'ready';
      const key = keyOf(t);
      const p = pending[key];
      if (p && p !== 'fetching') return p;
      if (p === 'fetching' || inflight.has(key) || inflight.has(leadKey(artist, t.title))) {
        return 'fetching';
      }
      return 'idle';
    },
    [find, keyOf, pending, inflight, artist],
  );

  const copyOf = useCallback((t: CatalogTrack): Track | null => find(t) ?? null, [find]);

  /**
   * A pull the band has not shown after four of its polls: ask the ledger
   * directly. A pull that failed before the band ever caught it (a peer's
   * quick "no", a dropped offer) used to leave the row saying "fetching…"
   * until the page unmounted, because nothing was left that could clear it.
   */
  const askLedger = useCallback(
    (key: string, t: CatalogTrack) => {
      const s = session;
      if (!s || !wanted.current.has(key) || seen.current.has(key)) return;
      void fetchCollectorStatus(s)
        .then((st) => {
          if (!wanted.current.has(key) || seen.current.has(key)) return;
          const row = st.recent.find(
            (r) =>
              identityKey(r.artist, r.title) === key ||
              leadKey(r.artist, r.title) === leadKey(artist, t.title),
          );
          if (!row) {
            fail(key, 'unreachable');
          } else if (row.state === 'failed') {
            fail(key, 'unreachable');
          } else if (row.state === 'landed' || row.state === 'promoted') {
            // The band will not show it again; the shelf catches the landing.
            seen.current.add(key);
          } else {
            // Offered, fetching, queued: the band will have it next poll.
            seen.current.add(key);
          }
        })
        .catch(() => {});
    },
    [session, artist, fail],
  );

  const listen = useCallback(
    (t: CatalogTrack) => {
      const here = find(t);
      if (here) {
        play.current(here, [here]);
        return;
      }
      const key = keyOf(t);
      if (!session || !can) return;
      // On its way already: nothing to ask. A reason on the row is not a
      // lock - the tap is the retry.
      if (pending[key] === 'fetching' || inflight.has(key)) return;
      clearTimer(key);
      wanted.current.set(key, t.title);
      setPending((prev) => ({ ...prev, [key]: 'fetching' }));
      void requestAudition(session, {
        extId: t.id,
        title: t.title,
        artist,
        url: t.url,
        cover: t.cover ?? '',
      })
        .then((r) => {
          if (!r.queued) {
            fail(key, r.reason ?? 'missing');
            return;
          }
          // Queued: the band should show it within a poll or two. If it never
          // does, the ledger is asked before the row can stick on "fetching".
          timers.current.set(
            key,
            window.setTimeout(() => {
              timers.current.delete(key);
              askLedger(key, t);
            }, UNSEEN_MS),
          );
        })
        .catch((e: unknown) => {
          // An older hub has no such door: stop offering what it cannot do,
          // and take back every "fetching" this page was showing - nothing
          // asked of that hub is ever going to arrive.
          if (e instanceof ServerError && e.status === 404) {
            setUnsupported(true);
            setPending({});
            wanted.current.clear();
            seen.current.clear();
            for (const timer of timers.current.values()) window.clearTimeout(timer);
            timers.current.clear();
            return;
          }
          fail(key, 'error');
        });
    },
    [find, keyOf, session, can, pending, inflight, artist, fail, clearTimer, askLedger],
  );

  return { can, stateOf, copyOf, listen };
}
