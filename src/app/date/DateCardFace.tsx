import { useEffect, useState } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { artSized, fetchCanvas, trackIdFromPath } from '../server.ts';
import { pendingDateCanvas, warmedDateCanvas } from './dateCanvas.ts';
import { type Track } from '../core/tauri.ts';

/**
 * A card's face: the song's Spotify Canvas when it has one, its cover when it
 * does not, and its name across the top either way.
 *
 * The clip is the whole reason this screen works as an introduction - a looping
 * few seconds of the artist's own visual says more about a song you have never
 * heard than a static square does. It is asked for only for the card actually
 * being looked at (`live`), because the deck holds several and a Canvas is a
 * video file; the one underneath keeps its cover until it is the one in hand.
 *
 * Everything degrades: no clip is the cover, no cover is the bare plate, and
 * the name sits over all three.
 */
export function CardFace({ track, live = false }: { track: Track; live?: boolean }) {
  const { session } = useServerSession();
  const art = artSized(track.artwork, 640);
  // Warmed a card ago, when the deck had the chance: the clip is then a local
  // blob and promotion is instant. Read only when LIVE - the under-card must
  // keep its still cover, or the deck would be running two videos at once.
  const [canvas, setCanvas] = useState<string | null>(
    () => (live ? warmedDateCanvas(track.path) : undefined) ?? null,
  );

  useEffect(() => {
    if (!live || !session) return;
    // Settled while this card waited underneath - including the settled
    // "this song has no clip", which spares asking again.
    const ready = warmedDateCanvas(track.path);
    if (ready !== undefined) {
      setCanvas(ready);
      return;
    }
    let gone = false;
    // Mid-warm: ride the fetch already running rather than starting a twin.
    const pending = pendingDateCanvas(track.path);
    if (pending) {
      void pending.then((url) => {
        if (!gone) setCanvas(url);
      });
      return () => {
        gone = true;
      };
    }
    // Never warmed (the first card of a visit): the original path.
    const ctrl = new AbortController();
    void fetchCanvas(session, track.title, track.artist, ctrl.signal, trackIdFromPath(track.path))
      .then((url) => {
        if (!ctrl.signal.aborted) setCanvas(url);
      });
    return () => {
      gone = true;
      ctrl.abort();
    };
  }, [live, session, track.title, track.artist, track.path]);

  return (
    <>
      {/* A pool candidate wears its honesty: this is the catalogue's thirty
          seconds, and the full song arrives only if it is kept. */}
      {track.path.startsWith('preview:') && (
        <span className="dateCard__preview" aria-label="Preview - thirty seconds">
          Preview
        </span>
      )}
      {canvas ? (
        // Muted and inline: the sound on this page is the snippet the card
        // plays, and a clip that fought it would be two songs at once.
        <video
          // A fresh element per clip. Without it React reuses the same <video>
          // and swaps its src, which WebKit does not reliably restart - the
          // deck recycles cards, so the same element serves several songs.
          key={canvas}
          className="dateCard__art dateCard__art--canvas"
          src={canvas}
          poster={art ?? undefined}
          autoPlay
          loop
          muted
          playsInline
          disablePictureInPicture
          // `loop` is advisory, and WebKit drops it - after a media
          // interruption, on a source it has decided is a stream, or when the
          // app comes back from the background. When it holds, `ended` never
          // fires and this costs nothing; when it does not, this is what makes
          // the clip loop. The card is a few seconds of silent video whose
          // entire job is to keep moving, so restarting is always right.
          onEnded={(e) => {
            const v = e.currentTarget;
            v.currentTime = 0;
            void v.play().catch(() => {});
          }}
          // Same reasoning for a stop that is not an end: nothing in the app
          // ever pauses this deliberately, so a pause is the system's doing.
          onPause={(e) => {
            const v = e.currentTarget;
            if (v.ended || !live) return;
            void v.play().catch(() => {});
          }}
          // Autoplay can be refused outright - Low Power Mode does - and a
          // refused video sits on its first frame wearing WebKit's play
          // overlay. Retrying here catches the refusals that were about
          // timing; the ones that stick are handled in CSS, where the
          // overlay is hidden so a stalled clip reads as a still cover
          // rather than a broken player.
          onCanPlay={(e) => {
            const v = e.currentTarget;
            if (live && v.paused) void v.play().catch(() => {});
          }}
        />
      ) : art ? (
        <img className="dateCard__art" src={art} alt="" draggable={false} />
      ) : (
        <div className="dateCard__art dateCard__art--bare" aria-hidden />
      )}
      {/* The name, over a gradient that blurs what is under it - legible over a
          moving clip, which a plain scrim is not. */}
      <div className="dateCard__id">
        <span className="dateCard__idTitle">{track.title}</span>
        <span className="dateCard__idArtist">{track.artist}</span>
      </div>
    </>
  );
}
