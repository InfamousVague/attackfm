import { ScrollArea, Text } from '@glacier/react';
import { Sparkles } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { useCardArt } from '../ux/artLoad.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchCollectorStatus, type CollectorStatus } from '../server.ts';
import { TrackMenu } from './TrackMenu.tsx';
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
export function ForYouShelf({
  onPlay,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
}) {
  const { forYou } = useLibrary();
  const { session } = useServerSession();
  const [status, setStatus] = useState<CollectorStatus | null>(null);

  // Refreshed when the quarantine changes size - a landing or an adoption is
  // exactly when the ledger moved.
  useEffect(() => {
    if (!session) {
      setStatus(null);
      return;
    }
    const ctrl = new AbortController();
    void fetchCollectorStatus(session, ctrl.signal)
      .then(setStatus)
      .catch(() => {
        // An older server has no collector; the shelf simply never shows.
      });
    return () => ctrl.abort();
  }, [session, forYou.length]);

  const mine = useMemo(() => {
    if (!status) return [];
    return forYou
      .filter((t) => t.curatorUserId === status.userId)
      .sort((a, b) => b.addedAt - a.addedAt);
  }, [forYou, status]);

  const halted = status?.halted === 'cap';
  if (mine.length === 0 && !halted) return null;

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
      {mine.length > 0 && (
        <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
          <div className="homeShelfRow">
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
