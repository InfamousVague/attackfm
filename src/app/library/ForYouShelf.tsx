import { ScrollArea, Text } from '@glacier/react';
import { ListMusic, Sparkles } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useMyAuditions } from './myAuditions.ts';
import { useCardArt } from '../ux/artLoad.ts';
import { TrackMenu } from './TrackMenu.tsx';
import { useLibrary } from './library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { readFeedCache, writeFeedCache } from './feedCache.ts';
import { fetchCurator, trackIdFromPath, type CuratorFeed } from '../server.ts';
import { MosaicCover } from '../playlists/PlaylistShowcase.tsx';
import { openMix } from '../nav/openMix.ts';
import type { Track } from '../core/tauri.ts';

/** Blank line the skeleton holds so the card keeps its exact height. */
const NBSP = ' ';

/** One audition card: the house track card, skeleton, pop and all. Wrapped in
 *  the same menu as everywhere for queueing it behind whatever is on. */
function ForYouCard({ track, onOpen }: { track: Track; onOpen: () => void }) {
  const { src, loaded, onLoad, onError } = useCardArt(track.artwork);
  const idle = !loaded || undefined;
  return (
    <TrackMenu track={track}>
      <button type="button" className="trackCard" onClick={onOpen}>
        <img className="trackCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
        <span className="trackCardTitle" data-loading={idle}>{loaded ? track.title : NBSP}</span>
        <span className="trackCardArtist" data-loading={idle}>{loaded ? track.artist : NBSP}</span>
      </button>
    </TrackMenu>
  );
}

/**
 * The collector's audition shelf: music the curator downloaded FOR you that you
 * have not adopted yet.
 *
 * These tracks are deliberately absent from the rest of the app - the shelves,
 * the search, the table all show a library of things its people chose - and
 * this is the one place they appear. Adoption is not a button: play one through
 * and it is yours (the server flips it on the completed listen), heart it and
 * it is yours immediately. Ignore it long enough and the collector's budget
 * pressure is the signal that it guessed wrong.
 *
 * The shelf also carries the collector's one loud message: the budget filling
 * up. Pulls stop entirely at the cap - nothing is ever auto-deleted - so a full
 * budget with a quiet shelf means the machine is waiting on you.
 */
/**
 * The curator's own lists, resolved for this shelf - by notebook request: "For
 * you" held only single-track audition cards, while the playlists the same
 * machine BUILT for this listener lived a tab away on Home. They lead the
 * shelf now, faces first, each opening as the same mix page it opens from
 * Home. Cached-then-refreshed exactly like Home's copy, and through the same
 * cache key, so the two surfaces can never disagree about what exists.
 */
function useCuratedHere(): { title: string; blurb: string; tracks: Track[] }[] {
  const { session } = useServerSession();
  const { tracks, forYou } = useLibrary();
  const [feed, setFeed] = useState<CuratorFeed | null>(() =>
    readFeedCache<CuratorFeed>(session, 'curator'),
  );
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void fetchCurator(session, controller.signal)
      .then((fresh: CuratorFeed) => {
        setFeed(fresh);
        writeFeedCache(session, 'curator', fresh);
      })
      .catch(() => {});
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.url]);
  return useMemo(() => {
    const byId = new Map<number, Track>();
    for (const t of [...tracks, ...forYou]) {
      const id = trackIdFromPath(t.path);
      if (id !== null) byId.set(id, t);
    }
    return (feed?.lists ?? [])
      .map((l) => ({
        title: l.name,
        blurb: l.blurb,
        tracks: l.trackIds.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined),
      }))
      .filter((l) => l.tracks.length >= 4);
  }, [feed, tracks, forYou]);
}

export function ForYouShelf({
  onPlay,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
}) {
  // The owner filter and the ledger both live in useMyAuditions now, so the
  // Music Date chip cannot disagree with this shelf about the same number.
  const { mine, status } = useMyAuditions();
  const curated = useCuratedHere();

  const halted = status?.halted === 'cap';
  if (mine.length === 0 && curated.length === 0 && !halted) return null;

  const spentGb = status ? status.ledgerBytes / 1e9 : 0;
  const capGb = status ? status.capBytes / 1e9 : 0;

  return (
    <section className="homeShelf forYouShelf">
      <h2 className="homeShelfTitle">
        <Sparkles size={16} className="forYouGlyph" aria-hidden />
        For you
        {mine.length > 0 && <span className="artistDiscCount">{mine.length} auditioning</span>}
      </h2>
      {halted && (
        <Text size="sm" className="forYouHalted" role="status">
          The collector is out of room — {spentGb.toFixed(0)} of {capGb.toFixed(0)} GB is holding
          music nobody has adopted. Play through or heart what you want to keep; clearing the rest
          from Settings lets it hunt again.
        </Text>
      )}
      {(mine.length > 0 || curated.length > 0) && (
        <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
          <div className="homeShelfRow">
            {/* The built lists lead: a playlist is a bigger promise than one
                song, and the auditions keep their row right behind. */}
            {curated.map((l) => (
              <button
                key={l.title}
                type="button"
                className="trackCard forYouListCard"
                onClick={() => openMix(l.title, l.tracks)}
              >
                <span className="trackCardArt forYouListCard__face">
                  <MosaicCover tracks={l.tracks} fallback={<ListMusic size={18} />} tone="tileRecent" />
                </span>
                <span className="trackCardTitle">{l.title}</span>
                <span className="trackCardArtist">
                  {l.tracks.length} {l.tracks.length === 1 ? 'song' : 'songs'}
                </span>
              </button>
            ))}
            {mine.map((t) => (
              // Playing it through IS the adoption.
              <ForYouCard key={t.path} track={t} onOpen={() => onPlay(t, mine)} />
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
