import { useEffect, useState } from 'react';
import { fetchCanvas, trackIdFromPath, type ServerSession } from '../server.ts';
import { useLoopArt } from '../ux/loopArt.ts';
import type { Track } from '../core/tauri.ts';

/** How many of the artist's songs to look a clip up for, and how many clips to
 *  keep once found. A handful is enough to read as "moving art of theirs" and
 *  bounds the lookups on a page you may only glance at. */
const PROBE = 6;
const KEEP = 5;
/** How long each clip holds before the next slides in. */
const HOLD_MS = 6000;

/**
 * A band of the artist's own Spotify Canvas clips, sliding behind the hero.
 *
 * A Canvas is the looping few seconds a lot of songs ship as their own moving
 * cover; the app already caches them for Music Date and Now Playing. Here they
 * become the artist's header - their own visual, in motion, instead of one flat
 * portrait. The clips are asked for a few songs at a time and only the ones the
 * catalogue actually has a Canvas for are kept, so a server with no Canvas
 * source (no Spotify cookie) simply shows nothing and the hero stays the
 * portrait it was. Muted and inert - it is wallpaper, not a player.
 */
export function ArtistCanvasStrip({
  artist,
  tracks,
  session,
}: {
  artist: string;
  tracks: Track[];
  session: ServerSession | null;
}) {
  const [clips, setClips] = useState<string[]>([]);
  const [shown, setShown] = useState(0);
  // Clips pause themselves whenever the page is hidden; this puts them back.
  useLoopArt();

  useEffect(() => {
    setClips([]);
    setShown(0);
    if (!session) return;
    const candidates = tracks.filter((t) => t.artwork).slice(0, PROBE);
    if (candidates.length === 0) return;
    let live = true;
    const ctrl = new AbortController();
    void Promise.all(
      candidates.map((t) =>
        fetchCanvas(session, t.title, t.artist, ctrl.signal, trackIdFromPath(t.path)).catch(
          () => null,
        ),
      ),
    ).then((urls) => {
      if (!live) return;
      const found: string[] = [];
      for (const u of urls) {
        if (u && !found.includes(u)) found.push(u);
        if (found.length >= KEEP) break;
      }
      setClips(found);
    });
    return () => {
      live = false;
      ctrl.abort();
    };
    // By artist: the same page re-renders as the library and catalogue fill in,
    // and re-probing on every one of those would restart the lookups. `tracks`
    // is the owned set, stable for a given artist within a visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.url, artist]);

  const clipCount = clips.length;
  useEffect(() => {
    if (clipCount < 2) return;
    const t = window.setInterval(() => setShown((i) => (i + 1) % clipCount), HOLD_MS);
    return () => window.clearInterval(t);
  }, [clipCount]);

  if (clipCount === 0) return null;

  return (
    <div className="artistCanvas" aria-hidden>
      {clips.map((c, i) => (
        <CanvasClip key={c} src={c} on={i === shown} />
      ))}
      <div className="artistCanvas__scrim" />
    </div>
  );
}

/** One clip. WebKit drops `loop` after an interruption, so restart on end the
 *  way the date cards do. */
function CanvasClip({ src, on }: { src: string; on: boolean }) {
  return (
    <video
      className="artistCanvas__clip"
      data-loop-art=""
      data-on={on || undefined}
      src={src}
      autoPlay
      loop
      muted
      playsInline
      disablePictureInPicture
      onEnded={(e) => {
        const v = e.currentTarget;
        v.currentTime = 0;
        void v.play().catch(() => {});
      }}
    />
  );
}
