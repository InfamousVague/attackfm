import {
  Button,
  IconButton,
  SeekBar,
  SegmentedBar,
  createAnalyserMeter,
  useBeat,
  useLiveLevels,
  type AnalyserMeter,
} from '@glacier/react';
import { Heart, Play, Undo2, X } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { useMyAuditions } from '../library/myAuditions.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  artSized,
  dateDone,
  dateVerdict,
  trackIdFromPath,
} from '../server.ts';
import { DATE_CACHE_TARGET, setDateDeck, sweepIfIdle } from '../downloads/autoCache.ts';
import { warmArt, warmDateCanvas } from './dateCanvas.ts';
import {
  BUFFER_AHEAD,
  FLING_MS,
  SNIPPET_SECONDS,
  VERDICT_PX,
  readPassed,
  snippetStart,
  writePassed,
} from './datePassed.ts';
import { CardFace } from './DateCardFace.tsx';
import { loadAudioUrl, type Track } from '../core/tauri.ts';
import { fireNativeHaptic } from '../core/haptics.ts';
import { createPortal } from 'react-dom';
import { hushBeats, speakBeats } from '../booth/djVoice.ts';
import { dateVoiceEnabled } from './dateVoice.ts';
import {
  dateCandidateVerdict,
  fetchDateBriefing,
  fetchDateCandidates,
  fetchDatePreview,
  type DateBriefingSong,
  type PreviewDateCard,
} from '../api/curator.ts';
import { makeRatchet } from '../ux/ratchet.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';

/** A preview date's path: not a file, a promise - the ext id rides it. */
const PREVIEW_SCHEME = 'preview:';

/** How many verdicts can be walked back. */
const UNDO_DEPTH = 10;

/** A decision, and what it actually changed - see the note on `undos`. */
interface Verdict {
  track: Track;
  dir: 'left' | 'right';
  /** Whether THIS swipe is what favourited the song, rather than finding it so. */
  favorited: boolean;
}

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
 * No captions and no names on the CARD - the whole point is meeting the MUSIC,
 * art and sound only, the way the metaphor's namesake shows a face before a
 * biography. The page around it does speak: a count of who is still waiting,
 * ticking down, over a bar that leans whichever way this sitting is leaning.
 * That is chrome about the SITTING, not about the song in front of you, which
 * is why it may sit above a card that still says nothing about itself.
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
 *
 * Split out: the snippet/verdict constants and the persisted pass ledger live
 * in ./datePassed.ts, and the card face (Canvas video / cover / scrim) in
 * ./DateCardFace.tsx; the warm audio pool and the deck-advances-inside-the-
 * gesture machinery stay HERE, together, on the rules above.
 */

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

export function DatePage() {
  const { isFavorite, toggleFavorite } = useLibrary();
  const { session } = useServerSession();

  // The deck, and the collector ledger behind it. Shared with the chip and the
  // For You shelf so all three count one thing - see library/myAuditions.ts.
  const { mine } = useMyAuditions();

  // Passes survive relaunch; this visit's verdicts live in `gone` so the deck
  // moves the moment a card is judged, without waiting on any sync.
  const passedRef = useRef<Set<number>>(readPassed());
  // THIS sitting's verdicts, not the running set: what the next batch is shaped
  // by is what you just said, and a pass you made three weeks ago has already
  // been answered.
  const sessionKept = useRef<number[]>([]);
  const sessionPassed = useRef<number[]>([]);
  /*
   * The same two numbers again, as STATE, purely so the tally at the top can
   * re-render when they change.
   *
   * The refs above stay the source of truth for what is SENT: they are read
   * inside the deck-emptied effect and inside callbacks that must never see a
   * stale closure, which is exactly what a ref is for. A ref cannot drive a
   * paint, though, so the bar reads this instead. The two move together at
   * four sites - a keep, a pass, an undo, and the end of a sitting - and that
   * is the whole contract between them.
   */
  const [tally, setTally] = useState({ kept: 0, passed: 0 });
  /** null before the deck has ever emptied, then how the ask went. */
  const [refill, setRefill] = useState<'asking' | 'asked' | 'failed' | null>(null);
  const askedFor = useRef<string>('');
  const [gone, setGone] = useState<Set<string>>(() => new Set());

  /*
   * The last few verdicts, so one can be taken back.
   *
   * `favorited` is the field that matters and the one a naive undo gets wrong.
   * A right swipe only calls toggleFavorite when the song was NOT already a
   * favourite - so undoing by toggling again would un-favourite a song that was
   * yours before this deck ever showed it to you. Recording what the swipe
   * actually CHANGED, rather than what it was, is the difference between
   * reversing a decision and destroying one.
   *
   * A stack rather than one slot, because misreading two cards in a row is not
   * rarer than misreading one. Capped because the deck is finite and a session
   * that walked back forty cards has stopped being an undo.
   */
  const [undos, setUndos] = useState<Verdict[]>([]);

  /*
   * The deck is the shared definition minus this sitting's in-flight verdicts.
   *
   * `mine` already applies every durable filter - owner, hearted, and the
   * persisted pass ledger - and it is the SAME list the Music Date chip counts
   * (see library/myAuditions.ts). `gone` is the only thing this page knows
   * that the chip does not: the cards judged since it opened, held locally so
   * the deck advances the instant a verdict lands rather than waiting on the
   * ledger write and the re-render behind it.
   *
   * This page used to re-derive all four filters itself. Two copies of one
   * rule is how the chip came to promise 172 songs over an empty deck.
   */
  /*
   * Preview dates: the pool's best measured candidates, dealt straight into
   * the deck on their thirty-second previews. This is what unchained Music
   * Date from the download queue - the peer that fetches full files can
   * sleep all afternoon and the deck still runs hundreds deep. A pass costs
   * nothing anywhere; a keep queues the real download and walks into the
   * library (and Liked) when it lands.
   */
  const [candidates, setCandidates] = useState<PreviewDateCard[]>([]);
  // How deep the pool runs past the dealt hand - the tally and the library
  // chip both add it, so the two numbers finally agree.
  const [poolBeyond, setPoolBeyond] = useState(0);
  const candidateFetchAt = useRef(0);
  useEffect(() => {
    if (!session) return;
    const waiting = candidates.filter((c) => !gone.has(PREVIEW_SCHEME + c.extId)).length;
    if (waiting >= 5) return;
    const now = Date.now();
    if (now - candidateFetchAt.current < 20_000) return;
    candidateFetchAt.current = now;
    void fetchDateCandidates(session, 25)
      .then(({ cards, total }) => {
        setCandidates(cards);
        setPoolBeyond(Math.max(0, total - cards.length));
      })
      .catch(() => {});
  }, [session, gone, candidates]);
  const previewByPath = useMemo(
    () => new Map(candidates.map((c) => [PREVIEW_SCHEME + c.extId, c] as const)),
    [candidates],
  );
  const previewDeck = useMemo<Track[]>(
    () =>
      candidates.map((c) => ({
        path: PREVIEW_SCHEME + c.extId,
        title: c.title,
        artist: c.artist,
        album: c.seed ? `Because you play ${c.seed}` : 'New to you',
        duration: null,
        addedAt: Date.now(),
        artwork: c.cover || null,
        genre: '',
        lyrics: '',
      })),
    [candidates],
  );

  const deck = useMemo(
    () => [...mine, ...previewDeck].filter((t) => !gone.has(t.path)),
    [mine, previewDeck, gone],
  );

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
    setDateDeck(
      deck
        .filter((t) => !t.path.startsWith(PREVIEW_SCHEME))
        .slice(0, DATE_CACHE_TARGET)
        .map((t) => t.path),
    );
    // Debounced: the deck recomputes on every swipe, and a fast run through
    // ten cards should cost one sweep rather than ten.
    const t = window.setTimeout(() => void sweepIfIdle(session), 1500);
    return () => window.clearTimeout(t);
  }, [deck, session]);

  const current = deck[0] ?? null;
  const upcoming = deck[1] ?? null;

  /*
   * The intro: walking in, the deck HOLDS - no snippet plays - while a full
   * blur overlay (the read-along's dress) shows the DJ's word on the next
   * three cards, each line lighting as its clip is spoken. Skip intro, or
   * the last word, lifts the overlay and the first card starts. Once per
   * visit, on its own switch (Settings > AI > Music Date briefing).
   */
  type Intro = { phase: 'loading' } | { phase: 'talking'; songs: DateBriefingSong[]; live: number };
  const [intro, setIntro] = useState<Intro | null>(() =>
    dateVoiceEnabled() ? { phase: 'loading' } : null,
  );
  const briefed = useRef(false);
  const introRef = useRef<Intro | null>(intro);
  useEffect(() => {
    introRef.current = intro;
  }, [intro]);
  // A door that cannot open must not hold the room: an empty deck never
  // fetches, and a hub that answers slowly answers a page that moved on.
  useEffect(() => {
    if (intro?.phase !== 'loading') return;
    const t = window.setTimeout(() => {
      setIntro((cur) => (cur && cur.phase === 'loading' ? null : cur));
    }, 6000);
    return () => window.clearTimeout(t);
  }, [intro]);
  // Unmount-only: the page leaving mid-sentence must not leave the voice
  // talking to the library, and the async intro below must stop moving state.
  const aliveForIntro = useRef(true);
  useEffect(() => {
    // Re-armed in the body, not only initialised: StrictMode's dev
    // double-mount runs the cleanup once against the surviving instance,
    // and a ref poisoned false made the intro refuse to open forever.
    aliveForIntro.current = true;
    return () => {
      aliveForIntro.current = false;
      hushBeats();
    };
  }, []);
  useEffect(() => {
    if (briefed.current || !session || deck.length === 0) return;
    if (!dateVoiceEnabled()) return;
    briefed.current = true;
    const ids = deck
      .slice(0, 3)
      .map((t) => trackIdFromPath(t.path))
      .filter((n): n is number => n != null);
    void (async () => {
      const songs = await fetchDateBriefing(session, ids).catch(() => [] as DateBriefingSong[]);
      if (!aliveForIntro.current) return;
      // Skipped, or timed out, while the hub was thinking: the room moved on.
      if (introRef.current?.phase !== 'loading') return;
      if (songs.length === 0) {
        setIntro(null);
        return;
      }
      setIntro({ phase: 'talking', songs, live: 0 });
      const clips = songs.flatMap((song, seat) => song.voice.map((id) => ({ id, seat })));
      if (clips.length > 0) {
        await speakBeats(
          session,
          clips.map((c) => c.id),
          (index) => {
            if (!aliveForIntro.current) return;
            const seat = clips[index]?.seat;
            if (seat === undefined) return;
            setIntro((cur) => (cur && cur.phase === 'talking' ? { ...cur, live: seat } : cur));
          },
        );
      } else {
        // A hub with no voice still owes her the synopsis: pace the lines
        // by reading time instead of by clip.
        for (let seat = 0; seat < songs.length; seat += 1) {
          if (!aliveForIntro.current) return;
          setIntro((cur) => (cur && cur.phase === 'talking' ? { ...cur, live: seat } : cur));
          await new Promise((r) => setTimeout(r, 3500));
        }
      }
      if (aliveForIntro.current) setIntro(null);
    })();
  }, [session, deck]);

  const skipIntro = useCallback(() => {
    hushBeats();
    setIntro(null);
  }, []);

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
    // A preview date's sound is its catalogue clip - asked for FRESH every
    // time, because the stored URL carries an expiring signature and a
    // days-old one is a dead card that froze the whole deck. The stored
    // copy is only the fallback; a card with no playable clip at all folds
    // itself out of the deck, silently and verdict-free.
    const source = track.path.startsWith(PREVIEW_SCHEME)
      ? (session
          ? fetchDatePreview(session, track.path.slice(PREVIEW_SCHEME.length)).then(
              (fresh) => fresh ?? previewByPath.get(track.path)?.preview ?? null,
            )
          : Promise.resolve(previewByPath.get(track.path)?.preview ?? null)
        ).then((url) => {
          if (!url) setGone((prev) => new Set(prev).add(track.path));
          return url;
        })
      : loadAudioUrl(track.path);
    void source.then((url) => {
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
  }, [previewByPath, session]);

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
    // The intro holds the decks: nothing plays under the briefing, and the
    // overlay lifting is itself the cue that starts the first card.
    if (intro !== null) return;
    if ((activeRef.current?.path ?? null) !== (current?.path ?? null)) speak(current);
  }, [current, speak, intro]);

  /*
   * The stalled-introduction watchdog.
   *
   * A snippet's source can black-hole: the route it resolved to died
   * mid-connect and the media stack sits on loadstart forever - and a slot
   * never asks for directions twice. Ten seconds without metadata on the
   * ACTIVE card re-resolves the URL; by then the health probes know which
   * server is actually answering, so the second ask usually comes back
   * routed somewhere alive (the mirror, typically). One retry per card: a
   * second stall is the network's answer, and the skip is the listener's.
   * The play() here comes from a timer, not a gesture, so a refusal simply
   * raises the existing tap-to-play affordance instead of silence.
   */
  useEffect(() => {
    const path = current?.path ?? null;
    if (!path) return;
    const timer = window.setTimeout(() => {
      const slot = activeRef.current;
      if (!slot || slot.path !== path) return;
      if (slot.url && slot.el.readyState >= 1) return;
      if (path.startsWith(PREVIEW_SCHEME)) {
        // The catalogue's clip never came: this card cannot be met today.
        // It folds without a verdict - the pool keeps the candidate.
        setGone((prev) => new Set(prev).add(path));
        return;
      }
      void loadAudioUrl(path).then((url) => {
        const live = activeRef.current;
        if (!url || !live || live.path !== path) return;
        live.url = url;
        live.el.src = url;
        live.el.load();
        void live.el.play().catch(() => {
          if (activeRef.current === live) setNeedsTap(true);
        });
      });
    }, 10_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the card alone
  }, [current?.path]);

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
        setTally({ kept: 0, passed: 0 });
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
      let favorited = false;
      const isPreview = track.path.startsWith(PREVIEW_SCHEME);
      if (isPreview) {
        /*
         * A preview date's verdict goes through its own door: a keep buys
         * the real file (and the pending like makes it a favourite the
         * moment it lands), a pass forgets the candidate. No local
         * favourite (there is no path to hang one on yet) and no undo -
         * the pool has already moved.
         */
        fireNativeHaptic(dir === 'right' ? 'success' : 'light');
        setTally((t) =>
          dir === 'right' ? { ...t, kept: t.kept + 1 } : { ...t, passed: t.passed + 1 },
        );
        if (session) {
          const extId = track.path.slice(PREVIEW_SCHEME.length);
          void dateCandidateVerdict(session, extId, dir === 'right').catch(() => {});
        }
      } else if (dir === 'right') {
        fireNativeHaptic('success');
        // The heart is the adoption - the same verb as everywhere else.
        if (!isFavorite(track.path)) {
          toggleFavorite(track.path);
          favorited = true;
        }
        const id = trackIdFromPath(track.path);
        if (id !== null) {
          sessionKept.current.push(id);
          setTally((t) => ({ ...t, kept: t.kept + 1 }));
          // Told now, not at the end of the deck. Fire and forget: a swipe must
          // never wait on the network, and anything that fails to send is
          // re-sent by dateDone when the deck empties.
          if (session) void dateVerdict(session, [id], []).catch(() => {});
        }
      } else {
        fireNativeHaptic('light');
        const id = trackIdFromPath(track.path);
        if (id !== null) {
          passedRef.current.add(id);
          writePassed(passedRef.current);
          sessionPassed.current.push(id);
          setTally((t) => ({ ...t, passed: t.passed + 1 }));
          /*
           * A pass now COSTS the server something and frees something: it
           * writes the verdict down, tombstones the audition and deletes the
           * file it fetched. Until this call existed a pass was remembered
           * only in this browser's localStorage, so the same card came back on
           * every other device and the disk never came back at all.
           */
          if (session) void dateVerdict(session, [], [id]).catch(() => {});
        }
      }
      // Everything advances NOW, inside the gesture: the deck (so the next
      // card is interactive at once) and the sound (so its play() carries the
      // gesture's autoplay permission). Only the fling animation waits.
      setGone((prev) => new Set(prev).add(track.path));
      if (!isPreview) {
        setUndos((prev) => [...prev, { track, dir, favorited }].slice(-UNDO_DEPTH));
      }
      setOutgoing({ track, dir });
      window.clearTimeout(flingTimer.current);
      flingTimer.current = window.setTimeout(() => setOutgoing(null), FLING_MS);
      speak(deck.find((t) => t.path !== track.path) ?? null);
      setDrag(null);
    },
    [deck, isFavorite, toggleFavorite, speak, session],
  );

  /**
   * Take back the last verdict.
   *
   * Every filter the deck applies has to be reversed or the card stays hidden,
   * which is the whole difficulty: `gone` is only one of three. A kept song is
   * excluded by `isFavorite`, a passed one by the PERSISTED pass list, and both
   * outlive this component - the pass list is written to storage and survives a
   * relaunch. Removing it from `gone` alone would look like undo doing nothing.
   *
   * The session logs are trimmed too. They are what dateDone reports at the end,
   * and a verdict that was taken back should not reach the server as one that
   * stood - the point of the undo is that it never happened.
   */
  const undo = useCallback(() => {
    const last = undos[undos.length - 1];
    if (!last) return;
    fireNativeHaptic('light');
    setUndos((prev) => prev.slice(0, -1));

    const id = trackIdFromPath(last.track.path);
    if (last.dir === 'right') {
      // Only if this swipe is what set it. A song that was already a favourite
      // stays one - undoing a decision must not undo an older, different one.
      if (last.favorited && isFavorite(last.track.path)) toggleFavorite(last.track.path);
      if (id !== null) {
        const at = sessionKept.current.lastIndexOf(id);
        if (at !== -1) sessionKept.current.splice(at, 1);
        setTally((t) => ({ ...t, kept: Math.max(0, t.kept - 1) }));
      }
    } else if (id !== null) {
      passedRef.current.delete(id);
      writePassed(passedRef.current);
      const at = sessionPassed.current.lastIndexOf(id);
      if (at !== -1) sessionPassed.current.splice(at, 1);
      setTally((t) => ({ ...t, passed: Math.max(0, t.passed - 1) }));
    }

    setGone((prev) => {
      const next = new Set(prev);
      next.delete(last.track.path);
      return next;
    });
    // The fling is mid-flight if this lands quickly; cancel it rather than let
    // it clear a card that has come back.
    window.clearTimeout(flingTimer.current);
    setOutgoing(null);
    setDrag(null);
    speak(last.track);
  }, [undos, isFavorite, toggleFavorite, speak]);

  // --- the swipe -------------------------------------------------------------

  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const origin = useRef<{ x: number; y: number; id: number } | null>(null);
  const ratchet = useRef(makeRatchet());

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!current) return;
    // The squiggle is for seeking, not judging: a drag that starts on it must
    // not double as a swipe.
    if (e.target instanceof Element && e.target.closest('.dateCard__wave, button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    ratchet.current.reset();
    origin.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const o = origin.current;
    if (!o || o.id !== e.pointerId) return;
    const dx = e.clientX - o.x;
    /*
     * The run-up, not just the arrival.
     *
     * The most gestural surface in the app had the crudest model: silence for
     * the whole drag, then one buzz once the verdict was already decided. The
     * ratchet is the app's own primitive for exactly this - notches that
     * tighten as the threshold nears, floored so a fast flick cannot mush -
     * and it is what pull-to-refresh already uses. Now the card tells the
     * thumb how close it is BEFORE it commits, which is the only moment that
     * information is worth anything.
     */
    ratchet.current.feel(Math.abs(dx), 0, VERDICT_PX, e.timeStamp);
    setDrag({ dx, dy: e.clientY - o.y });
  };
  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const o = origin.current;
    if (!o || o.id !== e.pointerId || !current) return;
    origin.current = null;
    const dx = e.clientX - o.x;
    ratchet.current.reset();
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

  /*
   * The tug-of-war, and where it starts.
   *
   * At rest the bar is dead centre: one unit each side, so the first verdict
   * pulls it off centre rather than filling it up from nothing. That is a
   * deliberate fiction about proportion and it is safe because the counts
   * printed under it say 0 and 0 - the bar shows which way this sitting is
   * GOING, the numbers say how far it has got.
   *
   * Pass is the left slice and Keep the right, because that is which way you
   * swipe for each, and the tones are the ones the two buttons already wear.
   */
  const judged = tally.kept + tally.passed;
  const split: { value: number; tone: 'danger' | 'success'; label: string }[] = [
    { value: judged === 0 ? 1 : tally.passed, tone: 'danger', label: 'Passed' },
    { value: judged === 0 ? 1 : tally.kept, tone: 'success', label: 'Kept' },
  ];

  return (
    <div className="homePage datePage">
      {intro !== null &&
        createPortal(
          <div className="dateIntro" role="dialog" aria-label="Your date briefing">
            <p className="dateIntro__eyebrow">Tonight&rsquo;s dates</p>
            <div className="dateIntro__lines">
              {intro.phase === 'loading' ? (
                <p className="dateIntro__line is-live">Reading the matchbook&hellip;</p>
              ) : (
                intro.songs.map((song, seat) => (
                  <p
                    key={song.trackId}
                    className={`dateIntro__line${seat === intro.live ? ' is-live' : ''}`}
                  >
                    {song.say}
                  </p>
                ))
              )}
            </div>
            <Button variant="ghost" className="dateIntro__skip" onClick={skipIntro}>
              Skip intro
            </Button>
          </div>,
          document.body,
        )}
      {current || outgoing ? (
        <>
          {/* How many are still waiting, and how this sitting is going. The
              card itself stays wordless; this is the page around it. */}
          <header className="dateTally">
            <p className="dateTally__count">
              <span className="dateTally__n">{deck.length + poolBeyond}</span> left to meet
            </p>
            <SegmentedBar
              className="dateTally__bar"
              size="sm"
              rounded
              data={split}
              aria-label={
                judged === 0
                  ? 'Nothing judged yet this sitting'
                  : `${tally.kept} kept, ${tally.passed} passed this sitting`
              }
            />
            <p className="dateTally__split" aria-hidden>
              <span className="dateTally__passed">{tally.passed} passed</span>
              <span className="dateTally__kept">{tally.kept} kept</span>
            </p>
          </header>

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
            {/* Between the two verdicts, because it undoes either and belongs
                to neither. A peer of them now rather than a smaller, quieter
                thing off to one side: it is the third thing you press in here,
                and it read as a footnote to the row it is actually part of. */}
            <IconButton
              variant="outline"
              className="dateActions__btn dateActions__btn--undo"
              aria-label={
                undos.length > 0
                  ? `Undo ${undos[undos.length - 1]!.dir === 'right' ? 'keeping' : 'passing on'} ${undos[undos.length - 1]!.track.title}`
                  : 'Nothing to undo'
              }
              disabled={undos.length === 0}
              onClick={undo}
            >
              <Undo2 size={24} />
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
