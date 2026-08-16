//! The Booth: the one room where the taste engine lives.
//!
//! The same intelligence used to wear five costumes - a DJ page in the
//! overflow menu, a DJ chip on the Library, a Curator settings pane, "Made for
//! you" mixes on home, Discover's picks - and a listener could never form a
//! model of WHO was doing all this. Now it has one body, and the room reads
//! top to bottom like a room: the date invitation, the decks, the crates.
//!
//! The first cut of this page tried to be two apps in one column - a shelf
//! band pinned over a full-height messenger - and at any real viewport that
//! rendered as one orphaned card floating over a void of chat chrome. Now the
//! page is a single scroller of three sections: Music Date as a compact card
//! on top (its real face is a fullscreen layer App hosts), the DJ as a
//! bounded chat card that ends where it ends, and the mixes at their natural
//! shelf height below.

import { IconButton, Modal, Text } from '@glacier/react';
import { ChevronRight, Heart, Settings2 } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { DjPage } from './DjPage.tsx';
import { CuratorShelves } from './HomePage.tsx';
import { CuratorSettings } from './CuratorSettings.tsx';
import { useServerSession } from './serverSession.tsx';
import { fetchCurator, type CuratorFeed } from './server.ts';
import type { Track } from './tauri.ts';

/** One line about what the engine is doing, in its own voice. */
function statusLine(feed: CuratorFeed | null): string | null {
  if (!feed) return null;
  const { status, progress } = feed;
  if (status.phase === 'enriching' && progress.total > 0) {
    return `Reading your library — ${progress.checked} of ${progress.total} songs so far.`;
  }
  if (status.phase === 'curating') return 'Building your next mixes right now.';
  if (status.lastCurated > 0) {
    const hours = Math.max(1, Math.round((Date.now() / 1000 - status.lastCurated) / 3600));
    return hours < 24
      ? `Mixes freshened ${hours === 1 ? 'an hour' : `${hours} hours`} ago.`
      : 'Mixes are ready; new ones brew as you listen.';
  }
  return null;
}

export function BoothPage({
  onPlay,
  onOpenArtist,
  onOpenDate,
}: {
  onPlay: (track: Track, queue?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Opens Music Date's fullscreen layer; App hosts it above all chrome. */
  onOpenDate: () => void;
}) {
  const { session } = useServerSession();
  const [feed, setFeed] = useState<CuratorFeed | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);

  useEffect(() => {
    if (!session) {
      setFeed(null);
      return;
    }
    let live = true;
    fetchCurator(session)
      .then((f) => {
        if (live) setFeed(f);
      })
      .catch(() => {
        // An older server, or a beat of downtime: the strip just stays quiet.
      });
    return () => {
      live = false;
    };
  }, [session]);

  const line = statusLine(feed);

  return (
    <div className="boothPage">
      <header className="boothHead">
        <div className="boothHead__text">
          <h1 className="boothHead__title">The Booth</h1>
          <Text tone="muted" size="sm">
            {line ?? 'Your taste, at the decks.'}
          </Text>
        </div>
        {session && (
          <IconButton
            variant="ghost"
            aria-label="Booth preferences"
            title="Booth preferences"
            onClick={() => setPrefsOpen(true)}
          >
            <Settings2 size={18} />
          </IconButton>
        )}
      </header>

      {/* Music Date: a compact invitation, not the experience itself - that
          is a fullscreen layer with the chrome gone. */}
      {session && (
        <button type="button" className="boothDate" onClick={onOpenDate}>
          <span className="boothDate__mark" aria-hidden="true">
            <Heart size={18} />
          </span>
          <span className="boothDate__text">
            <span className="boothDate__title">Music Date</span>
            <span className="boothDate__caption">Meet what the collector found — art and sound, no names</span>
          </span>
          <ChevronRight size={18} className="boothDate__chevron" aria-hidden="true" />
        </button>
      )}

      {/* The decks: the conversation, in a card that ends where it ends. Its
          transcript lives app-wide, so leaving the room forgets nothing. */}
      <section className="boothDj" aria-label="Ask the DJ">
        <DjPage />
      </section>

      {/* The crates: the mixes it built, at their natural height. */}
      <div className="boothShelves">
        <CuratorShelves onPlay={onPlay} onOpenArtist={onOpenArtist} />
      </div>

      {/* Its preferences are ITS, opened from the room - not a pane in the
          app's settings about some abstract "curator". */}
      <Modal open={prefsOpen} onClose={() => setPrefsOpen(false)} title="Booth preferences" size="md">
        <CuratorSettings />
      </Modal>
    </div>
  );
}
