import {
  Button,
  IconButton,
  SeekBar,
  createAnalyserMeter,
  useBeat,
  useLiveLevels,
  type AnalyserMeter,
} from '@glacier/react';
import { Heart, Play, X } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  artSized,
  dateDone,
  fetchCanvas,
  fetchCollectorStatus,
  trackIdFromPath,
  type CollectorStatus,
} from '../server.ts';
import { DATE_CACHE_TARGET, setDateDeck, sweepIfIdle } from '../downloads/autoCache.ts';
import { pendingDateCanvas, warmArt, warmDateCanvas, warmedDateCanvas } from './dateCanvas.ts';
import { loadAudioUrl, type Track } from '../core/tauri.ts';
import { fireNativeHaptic } from '../core/haptics.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';

/**
 * Date mode: the collector's auditions, met one at a time.
 *
 * The AI fetches music it thinks you will keep, and that music sits quarantined
 * on a shelf until a listen or a heart adopts it - which in practice means it
 * sits. This page turns the pile into introductions: the cover fills the
 * screen, a snippet from the song's middle plays under the house squiggle bar,
 * and the verdict is the metaphor's own - swipe right to keep it (the heart,
 * which is exactly what adopts an audition), swipe left to pass. A pass deletes
 * nothing: the song stays in the library, it just stops being offered here.
 *
 * No headings, no captions, no names on the card - the whole point is meeting
 * the MUSIC, art and sound only, the way the metaphor's namesake shows a face
 * before a biography.
 *
 * Three structural rules, all learned the hard way:
 *
 * - The deck advances INSIDE the tap or swipe gesture, never from the fling
 *   timeout. Autoplay permission belongs to the gesture; a play() fired from a
 *   260ms timer is refused and the next song arrives silent. The outgoing card
 *   is pinned into its own state purely for the animation, so the deck can
 *   move on immediately underneath it.
 *
 * - Hearting recomputes the deck at once (favorites feed its filter), so the
 *   card being animated off must never be `deck[0]` - by the time the fling
 *   runs, deck[0] is already the NEXT song.
 *
 * - The next several introductions are WARM before they are needed: each
 *   upcoming song gets its own audio element, preloading and pre-seeked to its
 *   snippet, so a swipe lands on buffered sound instead of a spinner. The
 *   elements are recycled as cards are judged - the pool never grows past the
 *   lookahead - and every one of them feeds the same analyser (the kit meter's
 *   addSource, the same mechanism the player's crossfade decks share), so the
 *   squiggle always moves to whichever one is speaking.
 *
 * Snippets never touch the deck the Player owns: a date is not a play - it
 * must not touch the queue, the play history the curator learns from, or
 * whatever was on the player when you walked in.
 */

/** How long each introduction plays before looping back to its start. */
const SNIPPET_SECONDS = 25;
/** How many upcoming songs stay buffered ahead of the current one. */
const BUFFER_AHEAD = 8;

/** Where the snippet begins: past the intro, capped so a long track does not
 *  open on its bridge. Short tracks just play from the top. */
function snippetStart(duration: number): number {
  if (!Number.isFinite(duration) || duration < 45) return 0;
  return Math.min(duration * 0.3, 60);
}

/** How far a card must travel to count as a verdict rather than a wobble. */
const VERDICT_PX = 90;
/** How long the fling takes; the deck underneath has already moved on. */
const FLING_MS = 280;

// Passes are remembered across sessions so the deck moves forward. Ids, not
// paths: a re-synced library keeps ids stable, and the cap keeps a heavy
// swiper from growing the entry forever.
const PASSED_KEY = 'attackfm-date-passed';
const PASSED_CAP = 800;

function readPassed(): Set<number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PASSED_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((n): n is number => typeof n === 'number'));
  } catch {
    // A torn entry reads as no passes, which only means a rerun of old cards.
  }
  return new Set();
}

function writePassed(passed: Set<number>): void {
  try {
    localStorage.setItem(PASSED_KEY, JSON.stringify([...passed].slice(-PASSED_CAP)));
  } catch {
    // Storage refusing just means passes forget across launches.
  }
}

/** One pooled deck slot: an audio element warmed for one song. */
interface Slot {
  el: HTMLAudioElement;
  path: string;
  /** The resolved source, '' while loadAudioUrl is still answering. */
  url: string;
  /** Seconds into the file the snippet starts; null until metadata lands. */
  start: number | null;
  /** Play the moment the source arrives - set when a gesture picked a song
   *  whose URL had not resolved yet, so the intent survives the wait. */
  playWhenReady: boolean;
}

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
function CardFace({ track, live = false }: { track: Track; live?: boolean }) {
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

export function DatePage() {
  const { forYou, isFavorite, toggleFavorite } = useLibrary();
  const { session } = useServerSession();

  const [status, setStatus] = useState<CollectorStatus | null>(null);
  useEffect(() => {
    if (!session) return;
    let live = true;
    void fetchCollectorStatus(session)
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => {
        // An older server: the deck still works, it just cannot filter to this
        // listener's own pulls.
      });
    return () => {
      live = false;
    };
  }, [session]);

  // Passes survive relaunch; this visit's verdicts live in `gone` so the deck
  // moves the moment a card is judged, without waiting on any sync.
  const passedRef = useRef<Set<number>>(readPassed());
  // THIS sitting's verdicts, not the running set: what the next batch is shaped
  // by is what you just said, and a pass you made three weeks ago has already
  // been answered.
  const sessionKept = useRef<number[]>([]);
  const sessionPassed = useRef<number[]>([]);
  /** null before the deck has ever emptied, then how the ask went. */
  const [refill, setRefill] = useState<'asking' | 'asked' | 'failed' | null>(null);
  const askedFor = useRef<string>('');
  const [gone, setGone] = useState<Set<string>>(() => new Set());

  const deck = useMemo(() => {
    const passed = passedRef.current;
    return forYou
      .filter((t) => !status || t.curatorUserId === status.userId)
      .filter((t) => !isFavorite(t.path) && !gone.has(t.path))
      .filter((t) => {
        const id = trackIdFromPath(t.path);
        return id === null || !passed.has(id);
      })
      .sort((a, b) => b.addedAt - a.addedAt);
  }, [forYou, status, isFavorite, gone]);

  // The next stretch of cards, kept on the phone. Handed to the device cache
  // as a ranking signal rather than pinned here: that cache already owns the
  // budget, the ledger of what it holds, and the rule that it only ever
  // evicts its own pins. A second cacher beside it would fight it for the
  // same vault and show up as songs "kept by hand". See autoCache.ts.
  // The next cards' faces, fetched while the current one is being watched -
  // the same trick the audio slots play, applied to the visuals. Two clips
  // ahead and three covers ahead: a clip is megabytes and a swipe is seconds,
  // so two is as far as the network can usefully run ahead anyway.
  useEffect(() => {
    if (!session) return;
    for (const t of deck.slice(1, 3)) warmDateCanvas(session, t);
    for (const t of deck.slice(1, 4)) warmArt(artSized(t.artwork, 640));
  }, [deck, session]);

  useEffect(() => {
    if (!session) return;
    setDateDeck(deck.slice(0, DATE_CACHE_TARGET).map((t) => t.path));
    // Debounced: the deck recomputes on every swipe, and a fast run through
    // ten cards should cost one sweep rather than ten.
    const t = window.setTimeout(() => void sweepIfIdle(session), 1500);
    return () => window.clearTimeout(t);
  }, [deck, session]);

  const current = deck[0] ?? null;
  const upcoming = deck[1] ?? null;

  // The card mid-fling, pinned OUT of the deck so the animation owns it while
  // the introductions continue underneath.
  const [outgoing, setOutgoing] = useState<{ track: Track; dir: 'left' | 'right' } | null>(null);
  const flingTimer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(flingTimer.current), []);

  // --- the warm pool ---------------------------------------------------------

  const pool = useRef<Map<string, Slot>>(new Map());
  const spares = useRef<HTMLAudioElement[]>([]);
  const activeRef = useRef<Slot | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  // One analyser for the whole pool. Built on the first play (a context made
  // outside a gesture starts suspended and silences everything routed into
  // it) and resumed on every play after - WebKit parks contexts behind the
  // app's back and resume() is the cure.
  const [meter, setMeter] = useState<AnalyserMeter | null>(null);
  const meterRef = useRef<AnalyserMeter | null>(null);

  /** Retire a slot's element back to the spares, silent and sourceless. */
  const retire = useCallback((slot: Slot) => {
    slot.el.pause();
    if (slot.url.startsWith('blob:')) URL.revokeObjectURL(slot.url);
    slot.el.removeAttribute('src');
    slot.el.load();
    spares.current.push(slot.el);
  }, []);

  /** The slot for a song, warming one up if it has none yet. Synchronous - the
   *  element exists at once; its source arrives when loadAudioUrl answers. */
  const ensureSlot = useCallback((track: Track): Slot => {
    const have = pool.current.get(track.path);
    if (have) return have;
    const el = spares.current.pop() ?? new Audio();
    // Before any source ever loads, or the analyser reads silence forever.
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    const slot: Slot = { el, path: track.path, url: '', start: null, playWhenReady: false };
    pool.current.set(track.path, slot);
    void loadAudioUrl(track.path).then((url) => {
      // Judged (evicted) while the URL resolved: nothing to warm any more.
      if (pool.current.get(track.path) !== slot) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
        return;
      }
      if (!url) return;
      slot.url = url;
      el.src = url;
      el.addEventListener(
        'loadedmetadata',
        () => {
          if (pool.current.get(track.path) !== slot) return;
          slot.start = snippetStart(el.duration);
          // Parking the head at the snippet makes the browser buffer THAT
          // region, so the first audible moment is the one that plays.
          try {
            el.currentTime = slot.start;
          } catch {
            // A source that refuses the seek plays from the top instead.
          }
        },
        { once: true },
      );
      if (slot.playWhenReady && activeRef.current === slot) {
        slot.playWhenReady = false;
        void meterRef.current?.resume();
        void el.play().then(
          () => setNeedsTap(false),
          () => {
            if (activeRef.current === slot) setNeedsTap(true);
          },
        );
      }
    });
    return slot;
  }, []);

  /** Make a song the one speaking. Called inside the gesture, so its play()
   *  carries the tap's autoplay permission. */
  const speak = useCallback(
    (track: Track | null) => {
      const prev = activeRef.current;
      if (prev && prev.path === track?.path) return;
      if (prev) {
        prev.el.pause();
        prev.playWhenReady = false;
      }
      setProgress(0);
      if (!track) {
        activeRef.current = null;
        setPlaying(false);
        return;
      }
      const slot = ensureSlot(track);
      activeRef.current = slot;
      if (!meterRef.current) {
        meterRef.current = createAnalyserMeter(slot.el);
        setMeter(meterRef.current);
      } else {
        // Every element joins the one graph; the seat is memoised per element,
        // so re-adding a recycled one costs nothing.
        meterRef.current.addSource(slot.el);
      }
      void meterRef.current.resume();
      if (!slot.url) {
        // The source is still resolving; play the moment it lands.
        slot.playWhenReady = true;
        return;
      }
      // A warmed slot is already parked at its snippet; a recycled or drained
      // one gets put back.
      if (slot.start !== null && Math.abs(slot.el.currentTime - slot.start) > SNIPPET_SECONDS) {
        try {
          slot.el.currentTime = slot.start;
        } catch {
          // Plays from wherever it stands.
        }
      }
      void slot.el.play().then(
        () => setNeedsTap(false),
        () => {
          if (activeRef.current === slot) setNeedsTap(true);
        },
      );
    },
    [ensureSlot],
  );

  // Keep the next several songs warm, and only those: judged cards give their
  // elements back, fresh upcoming ones take them. Runs on every deck change,
  // which is also what re-fills the lookahead as the pile is worked through.
  useEffect(() => {
    const want = new Set(deck.slice(0, BUFFER_AHEAD).map((t) => t.path));
    for (const [path, slot] of pool.current) {
      if (!want.has(path) && activeRef.current !== slot) {
        pool.current.delete(path);
        retire(slot);
      }
    }
    for (const track of deck.slice(0, BUFFER_AHEAD)) ensureSlot(track);
  }, [deck, ensureSlot, retire]);

  // The first introduction, and any deck change that was NOT a swipe (the
  // library syncing an audition away, the reset button). Swipes speak their
  // own next song inside the gesture; this only acts when the active element
  // is not already on the right one.
  useEffect(() => {
    if ((activeRef.current?.path ?? null) !== (current?.path ?? null)) speak(current);
  }, [current, speak]);

  // The active element's clock, wired by hand because the element is not in
  // the JSX. The snippet loops: an undecided listener hears it again rather
  // than silence pressing them to decide.
  useEffect(() => {
    const id = window.setInterval(() => {
      const slot = activeRef.current;
      if (!slot) return;
      setPlaying(!slot.el.paused);
      if (slot.el.paused) return;
      const start = slot.start ?? 0;
      const elapsed = slot.el.currentTime - start;
      if (elapsed >= SNIPPET_SECONDS) {
        try {
          slot.el.currentTime = start;
        } catch {
          // A stream that refuses the loop seek just plays on.
        }
        setProgress(0);
        return;
      }
      setProgress(Math.max(0, Math.min(1, elapsed / SNIPPET_SECONDS)));
    }, 120);
    return () => window.clearInterval(id);
  }, []);

  // Walking into Date mode quiets whatever was playing: two songs at once is
  // not an introduction. Leaving retires the whole pool and the analyser.
  useEffect(() => {
    for (const el of Array.from(document.querySelectorAll('audio'))) el.pause();
    return () => {
      activeRef.current = null;
      for (const slot of pool.current.values()) retire(slot);
      pool.current.clear();
      spares.current = [];
      meterRef.current?.dispose();
      meterRef.current = null;
    };
  }, [retire]);

  const tapPlay = () => {
    setNeedsTap(false);
    const slot = activeRef.current;
    if (!slot) return;
    void meterRef.current?.resume();
    void slot.el.play().catch(() => setNeedsTap(true));
  };

  // The squiggle's food: live loudness and the beat, from the shared meter.
  const levels = useLiveLevels({ meter: meter?.meter ?? null, progress, active: playing });
  const beat = useBeat({ meter: meter?.meter ?? null, active: playing, at: progress });

  const seekWithin = (v: number) => {
    const slot = activeRef.current;
    if (!slot) return;
    const clamped = Math.max(0, Math.min(SNIPPET_SECONDS, v));
    try {
      slot.el.currentTime = (slot.start ?? 0) + clamped;
      setProgress(clamped / SNIPPET_SECONDS);
    } catch {
      // Seeking a stream that is not ready yet is a no-op, not a failure.
    }
  };

  // The end of a Date is the moment the app knows most about what you want and
  // has the least left to show you - so it goes and gets more THEN, seeded by
  // the verdicts you just gave, rather than waiting out the collector's own
  // six-hourly sweep. The page has always promised this in its empty state;
  // this is what makes the promise true.
  useEffect(() => {
    if (!session || deck.length > 0) return;
    // Once per emptying, not once per render - and again after you swipe
    // through a fresh batch, which is a different sitting with new verdicts.
    const signature = `${sessionKept.current.length}:${sessionPassed.current.length}`;
    if (askedFor.current === signature) return;
    askedFor.current = signature;
    let live = true;
    setRefill('asking');
    void dateDone(session, sessionKept.current, sessionPassed.current)
      .then(() => {
        if (!live) return;
        setRefill('asked');
        // The sitting is over; the next one starts from a clean slate.
        sessionKept.current = [];
        sessionPassed.current = [];
      })
      .catch(() => {
        if (live) setRefill('failed');
      });
    return () => {
      live = false;
    };
  }, [session, deck.length]);

  // --- the verdict -----------------------------------------------------------

  const verdict = useCallback(
    (track: Track, dir: 'left' | 'right') => {
      if (dir === 'right') {
        fireNativeHaptic('success');
        // The heart is the adoption - the same verb as everywhere else.
        if (!isFavorite(track.path)) toggleFavorite(track.path);
        const id = trackIdFromPath(track.path);
        if (id !== null) sessionKept.current.push(id);
      } else {
        fireNativeHaptic('light');
        const id = trackIdFromPath(track.path);
        if (id !== null) {
          passedRef.current.add(id);
          writePassed(passedRef.current);
          sessionPassed.current.push(id);
        }
      }
      // Everything advances NOW, inside the gesture: the deck (so the next
      // card is interactive at once) and the sound (so its play() carries the
      // gesture's autoplay permission). Only the fling animation waits.
      setGone((prev) => new Set(prev).add(track.path));
      setOutgoing({ track, dir });
      window.clearTimeout(flingTimer.current);
      flingTimer.current = window.setTimeout(() => setOutgoing(null), FLING_MS);
      speak(deck.find((t) => t.path !== track.path) ?? null);
      setDrag(null);
    },
    [deck, isFavorite, toggleFavorite, speak],
  );

  // --- the swipe -------------------------------------------------------------

  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const origin = useRef<{ x: number; y: number; id: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!current) return;
    // The squiggle is for seeking, not judging: a drag that starts on it must
    // not double as a swipe.
    if (e.target instanceof Element && e.target.closest('.dateCard__wave, button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const o = origin.current;
    if (!o || o.id !== e.pointerId) return;
    setDrag({ dx: e.clientX - o.x, dy: e.clientY - o.y });
  };
  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const o = origin.current;
    if (!o || o.id !== e.pointerId || !current) return;
    origin.current = null;
    const dx = e.clientX - o.x;
    if (dx > VERDICT_PX) verdict(current, 'right');
    else if (dx < -VERDICT_PX) verdict(current, 'left');
    else setDrag(null);
  };

  const dx = drag?.dx ?? 0;
  const dragStyle: React.CSSProperties | undefined = drag
    ? {
        transform: `translate(${dx}px, ${drag.dy * 0.2}px) rotate(${dx / 18}deg)`,
        transition: 'none',
      }
    : undefined;
  const likeHint = Math.max(0, Math.min(1, dx / VERDICT_PX));
  const passHint = Math.max(0, Math.min(1, -dx / VERDICT_PX));

  // --- faces of the page -------------------------------------------------------

  if (!session) {
    return (
      <div className="homePage datePage">
        <div className="emptyState emptyState--tall">
          <EmptyArt name="discovery" />
          <p className="emptyState__text">
            Date needs your server — it introduces you to the music your DJ fetched, and the DJ
            lives there.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="homePage datePage">
      {current || outgoing ? (
        <>
          <div className="dateStack">
            {upcoming && (
              <div key={upcoming.path} className="dateCard dateCard--under" aria-hidden>
                <CardFace track={upcoming} />
              </div>
            )}
            {current && (
              <div
                key={current.path}
                className="dateCard"
                style={dragStyle}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
              >
                <CardFace track={current} live />
                <span className="dateCard__stamp dateCard__stamp--like" style={{ opacity: likeHint }}>
                  KEEP
                </span>
                <span className="dateCard__stamp dateCard__stamp--pass" style={{ opacity: passHint }}>
                  PASS
                </span>
                {needsTap && (
                  <button type="button" className="dateCard__tapPlay" onClick={tapPlay} aria-label="Play snippet">
                    <Play size={30} fill="currentColor" />
                  </button>
                )}
                {/* The house squiggle: the snippet's clock, moving with the
                    music it is timing. Seekable within the snippet's window. */}
                <div className="dateCard__wave">
                  <SeekBar
                    duration={SNIPPET_SECONDS}
                    value={progress * SNIPPET_SECONDS}
                    aria-label="Snippet position"
                    shape="swell"
                    tone="accent"
                    fill="solid"
                    rail="contrast"
                    levels={levels}
                    beat={beat}
                    tracer
                    onValueChange={seekWithin}
                  />
                </div>
              </div>
            )}
            {/* The judged card, flying its verdict off over the live deck. */}
            {outgoing && (
              <div
                key={`out-${outgoing.track.path}`}
                className="dateCard dateCard--outgoing"
                data-leaving={outgoing.dir}
                aria-hidden
              >
                <CardFace track={outgoing.track} />
                <span
                  className={`dateCard__stamp dateCard__stamp--${outgoing.dir === 'right' ? 'like' : 'pass'}`}
                  style={{ opacity: 1 }}
                >
                  {outgoing.dir === 'right' ? 'KEEP' : 'PASS'}
                </span>
              </div>
            )}
          </div>

          <div className="dateActions">
            <IconButton
              variant="outline"
              className="dateActions__btn dateActions__btn--pass"
              aria-label={current ? `Pass on ${current.title}` : 'Pass'}
              disabled={!current}
              onClick={() => current && verdict(current, 'left')}
            >
              <X size={26} />
            </IconButton>
            <IconButton
              variant="outline"
              className="dateActions__btn dateActions__btn--like"
              aria-label={current ? `Keep ${current.title}` : 'Keep'}
              disabled={!current}
              onClick={() => current && verdict(current, 'right')}
            >
              <Heart size={24} fill="currentColor" />
            </IconButton>
          </div>
        </>
      ) : (
        <div className="emptyState emptyState--tall">
          <EmptyArt name="discovery" />
          <p className="emptyState__text">
            {refill === 'asking'
              ? 'That\u2019s everyone. Going to find more like the ones you kept\u2026'
              : refill === 'failed'
                ? 'That\u2019s everyone. I could not reach your server to look for more.'
                : refill === 'asked'
                  ? 'That\u2019s everyone. Your server is out looking now — new ones land as it finds them.'
                  : 'You\u2019re all caught up — the DJ fetches more as it learns what you keep.'}
          </p>
          {passedRef.current.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                passedRef.current = new Set();
                writePassed(passedRef.current);
                setGone(new Set());
              }}
            >
              Meet the passed ones again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
