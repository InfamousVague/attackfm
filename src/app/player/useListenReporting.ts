import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  fetchPlayStates,
  reportPlay,
  reportPosition,
  trackIdFromPath,
  type ServerSession,
} from '../server.ts';
import { createListenReporter, type ListenSnapshot } from './listens.ts';
import { takePendingSeek } from './pendingSeek.ts';
import { fetchBookShapes, type BookShape } from '../api/books.ts';
import { skipsCard } from './bookSkips.ts';
import { usePlayback } from './playback.tsx';
import type { Track } from '../core/tauri.ts';

type Playback = ReturnType<typeof usePlayback>;

/**
 * The listening log. One report per listen-through, once the track has
 * genuinely been HEARD - thirty seconds of actual playback, or half its
 * length for anything shorter, the shape of threshold streaming services
 * count by. Measured as accumulated listened time, not a position reached:
 * a scrub or a jump forward to 0:45 moves the clock without playing those
 * seconds, and must not count as a listen. A new track resets the tally;
 * repeat-one restarts it, so every spin is logged. Server only - local
 * listening has no account to write history against.
 *
 * Extracted from Player.tsx; the shared refs (scrubbing, playbackRef,
 * positionRef, playSessionRef) are the Player's own objects, passed in so
 * this reads exactly what the deck writes.
 */
export function useListenReporting({
  track,
  playing,
  audible,
  duration,
  coarsePosition,
  playSession,
  playSessionRef,
  scrubbing,
  playbackRef,
  positionRef,
  commitSeek,
}: {
  track: Track | null;
  playing: boolean;
  audible: boolean;
  duration: number;
  coarsePosition: number;
  playSession: ServerSession | null;
  playSessionRef: MutableRefObject<ServerSession | null>;
  scrubbing: MutableRefObject<boolean>;
  playbackRef: MutableRefObject<Playback>;
  positionRef: MutableRefObject<number>;
  commitSeek: (to: number) => void;
}): void {
  // The EVENT log rides beside the play counter below: the counter keeps the
  // legacy shelves (artist top songs) fed, while events - with their length,
  // completion and skip verdicts - feed the stats page and the curator's
  // self-tuning. Same honesty rules, same privacy switch. The reporter samples
  // this snapshot once a second and owns all the bookkeeping.
  const listenSnapRef = useRef<ListenSnapshot>({
    track: null,
    audible: false,
    duration: 0,
    session: null,
    record: false,
  });
  listenSnapRef.current = {
    track,
    audible: audible && !scrubbing.current,
    duration,
    session: playSession,
    record: playbackRef.current.saveHistory,
  };
  useEffect(() => {
    const reporter = createListenReporter(() => listenSnapRef.current);
    return reporter.dispose;
  }, []);

  const listened = useRef({ path: '' as string, seconds: 0, prev: 0, reported: false });
  useEffect(() => {
    if (!track) return;
    const l = listened.current;
    if (l.path !== track.path) {
      listened.current = { path: track.path, seconds: 0, prev: coarsePosition, reported: false };
      return;
    }
    const delta = coarsePosition - l.prev;
    l.prev = coarsePosition;
    // Only forward, only a natural tick's worth (<=2s), only while genuinely
    // playing and not scrubbing - anything larger is a seek and buys no
    // credit. A backward jump (rewind) re-arms the report for the next spin.
    // The rearm also restarts the tally: without the reset, seconds already
    // past the threshold would log a duplicate play the instant a rewind
    // lands, rather than after another genuine listen-through.
    if (delta < 0) {
      l.reported = false;
      l.seconds = 0;
    }
    if (playing && !scrubbing.current && delta > 0 && delta <= 2) {
      l.seconds += delta;
    }
    if (l.reported) return;
    const threshold = Math.min(30, Math.max(5, (duration || 60) / 2));
    if (l.seconds < threshold) return;
    l.reported = true;
    // The privacy switch: with history off the listen is simply never written.
    // Marked reported all the same, so flipping the switch mid-song does not
    // retroactively log a listen that began under "off".
    if (!playbackRef.current.saveHistory) return;
    const id = trackIdFromPath(track.path);
    if (id !== null && playSessionRef.current) reportPlay(playSessionRef.current, id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the clock drives it; the rest ride refs or are stable per tick
  }, [coarsePosition, playing, track, duration]);

  /*
   * Whether the DECK is holding this very book, rather than still holding
   * the last one.
   *
   * `duration` is one number for whatever the deck has loaded, and a track
   * change moves `track` a beat before it moves that. Both halves of the
   * bookmark need this proof and for the same reason: a position read in
   * that beat belongs to the PREVIOUS book. Reading it as this book's mark
   * is how starting a new series jumped straight to the timestamp of the one
   * you were already listening to; reading it as this book's readiness is
   * how coming back to a book measured its place against the wrong length.
   *
   * The library's own duration for the track is the check. A book nobody has
   * measured falls back to the bare "the deck knows some length" test, which
   * is what both halves did before.
   */
  const deckHolds = (t: Track, deckDuration: number) => {
    if (!(deckDuration > 0)) return false;
    const known = t.duration ?? 0;
    return known <= 0 || Math.abs(deckDuration - known) <= 2;
  };

  /*
   * Where each book got to, kept PER BOOK.
   *
   * The parting write below used to send `positionRef.current` - a live ref
   * the deck shares with everything - and on a track change React runs that
   * cleanup after the new track has already rendered, so the ref had moved on
   * and the OLD book's bookmark was overwritten with the new one's opening
   * seconds. Switching between two books wiped both places, which is exactly
   * how it was reported.
   *
   * A mark keyed by path cannot be confused about whose place it is. Nothing
   * under five seconds is ever recorded: the opening of a book is not a place
   * anybody needs returned to, and it is precisely the value a track that has
   * only just loaded would otherwise write over a good bookmark.
   */
  const marks = useRef(new Map<string, number>());
  useEffect(() => {
    if (!track || track.kind !== 'book' || !deckHolds(track, duration)) return;
    const ms = positionRef.current * 1000;
    if (ms > 5_000) marks.current.set(track.path, ms);
  }, [coarsePosition, track, duration, positionRef]);

  // ── The audiobook bookmark ───────────────────────────────────────────────
  //
  // A book is a place you return to, so the server learns where the listener
  // got to: every twenty seconds while a book section plays, and once more the
  // moment it pauses or the track changes. Music never reports - resuming a
  // song mid-verse is nobody's habit, and the chatter would buy nothing. The
  // position rides a ref so the interval never re-arms on every tick.
  useEffect(() => {
    if (!track || track.kind !== 'book') return;
    const id = trackIdFromPath(track.path);
    if (id === null) return;
    const send = () => {
      const s = playSessionRef.current;
      // THIS book's own mark - never the live ref, which by cleanup time may
      // already belong to whatever is playing now.
      const ms = marks.current.get(track.path);
      if (s && ms !== undefined) void reportPosition(s, id, ms).catch(() => {});
    };
    let timer: number | undefined;
    if (playing) {
      timer = window.setInterval(send, 20_000);
    }
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      // The parting word: pause, track change, or the sheet closing all land
      // the latest position before the interval dies.
      send();
    };
  }, [track, playing]);

  // The other half of the bookmark: a book section OPENS where the listener
  // left it. Runs once per track, only after the deck has learned a real
  // duration (seeking before the source is ready gets clobbered by the load),
  // and only for a spot worth returning to - past the first few seconds,
  // short of the end. commitSeek is the same door the scrubber uses, so every
  // clock, crossfade guard and republish rides along.
  const resumedPath = useRef<string | null>(null);
  /** This track's card and credits, once known - read by the stop below. */
  const shapeRef = useRef<BookShape | null>(null);
  useEffect(() => {
    /*
     * The deck's duration must belong to THIS book.
     *
     * `duration` is one number for whichever track the deck holds, and on a
     * switch it still reads the PREVIOUS book's length for a beat. That was
     * enough to pass this gate, spend the once-per-track guard, and measure
     * the bookmark against the wrong record: coming back to a twelve-hour
     * book while the deck still said thirty seconds, a mark at 1:09 failed
     * the "inside the track" test and was dropped - and the retry never came,
     * because the guard had already been spent. Both books forgot their
     * place, which is exactly how it was reported.
     *
     * The library's own duration for the track is the check: when the deck
     * agrees with it, the deck is holding this book. A book whose length
     * nobody has measured falls back to the old bare test.
     */
    if (!track || !deckHolds(track, duration)) return;
    if (resumedPath.current === track.path) return;
    resumedPath.current = track.path;
    /*
     * Somebody asked for a SPECIFIC spot in this track - a bookmark two chapters
     * back, or the place another device left off. It outranks the automatic
     * mark, which would otherwise pull them to wherever they last stopped here.
     *
     * Checked before the book gate below, and for ANY kind of track. It used to
     * sit inside that gate because bookmarks were the only thing leaving word,
     * which meant a request to open a SONG at a position was written and then
     * silently ignored - the one seek nobody could make work.
     */
    const asked = takePendingSeek(track.path);
    if (asked !== null) {
      commitSeek(asked / 1000);
      return;
    }
    // Everything below is the audiobook bookmark, which music has no use for:
    // resuming a song mid-verse is nobody's habit.
    if (track.kind !== 'book') return;
    // A new track: forget the last one's card and credits until this one's
    // are known, or the stop below would arm against the wrong numbers.
    shapeRef.current = null;
    const id = trackIdFromPath(track.path);
    const s = playSessionRef.current;
    if (id === null || !s) return;
    let live = true;
    const settle = (serverMs: number | null, shape: BookShape | null) => {
      if (!live) return;
      shapeRef.current = shape;
      const local = marks.current.get(track.path);
      const to = (local ?? serverMs ?? 0) / 1000;
      if (to > 15 && to < duration - 15) {
        commitSeek(to);
        return;
      }
      /*
       * Nothing to return to, so this reading is starting rather than
       * resuming - the only moment the publisher's card matters. A bookmark
       * always outranks it: somebody forty minutes in wants those forty
       * minutes, not the top of the book with the preamble trimmed.
       *
       * The server's own bounds are re-checked rather than trusted, because a
       * client should not seek somewhere absurd if a future server sends a
       * number this one did not expect.
       */
      const card = (shape?.openingMs ?? 0) / 1000;
      if (card > 1 && card < duration / 2) commitSeek(card);
    };
    void Promise.all([
      fetchPlayStates(s, { kind: 'book', limit: 2_000 }).catch(() => []),
      // Only asked for when this listener actually wants the skip - otherwise
      // opening a book costs a request nobody reads the answer to.
      skipsCard(id)
        ? fetchBookShapes(s, [id]).catch((): Record<string, BookShape> => ({}))
        : Promise.resolve({} as Record<string, BookShape>),
    ])
      .then(([states, shapes]) =>
        settle(
          states.find((st) => st.trackId === id)?.positionMs ?? null,
          shapes[String(id)] ?? null,
        ),
      )
      .catch(() => settle(null, null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commitSeek is rebuilt every render; the guard ref keeps this once-per-track
  }, [track, duration]);

  /**
   * And the other end: stop before the credits.
   *
   * Seeking to the end rather than pausing, so the book finishes through the
   * ordinary end-of-track path - the listen is logged, the bookmark settles
   * where it should, and a book made of sections advances to the next one.
   * Pausing on the spot would leave every one of those unfinished and the
   * shelf would show the book as still in progress forever.
   *
   * Guarded by a ref rather than state: this fires from a position tick, and
   * re-arming on every render would seek repeatedly while the last second
   * played out.
   */
  const cutPath = useRef<string | null>(null);
  useEffect(() => {
    const shape = shapeRef.current;
    if (!track || track.kind !== 'book' || !shape || !(duration > 0)) return;
    if (cutPath.current === track.path) return;
    const credits = shape.creditsMs / 1000;
    if (!(credits > 0) || credits >= duration - 1) return;
    // A scrub INTO the credits is the listener asking to hear them; only an
    // arrival there under the deck's own power is the one to cut.
    if (scrubbing.current) return;
    if (coarsePosition < credits) return;
    cutPath.current = track.path;
    commitSeek(duration);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the position tick; the ref keeps it once per track
  }, [track, duration, coarsePosition]);
}
