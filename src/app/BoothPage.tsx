//! The Booth: the one room where the taste engine lives.
//!
//! The same intelligence used to wear five costumes - a DJ page in the
//! overflow menu, a DJ chip on the Library, a Curator settings pane, "Made for
//! you" mixes on home, Discover's picks - and a listener could never form a
//! model of WHO was doing all this. Now it has one body. The room holds the
//! conversation (the DJ transcript, which survives navigation because its
//! provider wraps the whole app), the mixes it built, one line about what it
//! is doing right now, and its own preferences. Everywhere else the brain
//! doesn't get a surface, it gets a sentence.

import { IconButton, Modal, Text } from '@glacier/react';
import { Settings2 } from '@glacier/icons';
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
}: {
  onPlay: (track: Track, queue?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
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
          {line ? (
            <Text tone="muted" size="sm">
              {line}
            </Text>
          ) : (
            <Text tone="muted" size="sm">
              Your taste, at the decks.
            </Text>
          )}
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

      {/* The mixes it built - the same shelves home used to carry, spoken from
          the room they come from. */}
      <div className="boothShelves">
        <CuratorShelves onPlay={onPlay} onOpenArtist={onOpenArtist} />
      </div>

      {/* The conversation fills the rest; its transcript lives app-wide. */}
      <div className="boothChat">
        <DjPage />
      </div>

      {/* Its preferences are ITS, opened from the room - not a pane in the
          app's settings about some abstract "curator". */}
      <Modal open={prefsOpen} onClose={() => setPrefsOpen(false)} title="Booth preferences" size="md">
        <CuratorSettings />
      </Modal>
    </div>
  );
}
