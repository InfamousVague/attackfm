import { useCallback, useEffect, useRef, useState } from 'react';
import { holdDeck } from '@attackfm/app/deckHold';
import { deck } from './engine.ts';

/**
 * The board's live state, for whichever surface is showing it.
 *
 * The deck is a module singleton that outlives every screen (the song keeps
 * going when you leave), so the React side of it is not state so much as a
 * VIEW: which parts exist, which are in, whether it is running. Both the Pads
 * page and the Stems panel need exactly this, and both need it to be right when
 * they mount onto a deck that has been playing for ten minutes.
 */

/** Past this, a press is a hold: the part comes back when the finger lifts.
 *  Under it, the press latches. Nobody has to be told this - it is how a mute
 *  button on a mixer has always behaved. */
const HOLD_MS = 260;

/**
 * The output claim, kept beside the deck rather than in a component.
 *
 * The deck plays on after the screen closes, so the claim has to outlive the
 * screen too, or leaving the page would hand the speakers back to the app's own
 * player while the stems were still running - two songs at once.
 */
let release: ((resumeAt?: number) => void) | null = null;

export function claimOutput(): void {
  if (!release) release = holdDeck();
}

/**
 * Give the output back.
 *
 * `resumeAt` hands the song over: the app's player picks it up at that second
 * rather than sitting where it was parked. Passing it is what makes closing the
 * Stems panel feel like stepping out of the way instead of stopping the music.
 */
export function returnOutput(resumeAt?: number): void {
  release?.(resumeAt);
  release = null;
}

export interface Board {
  /** The parts on the deck, in board order. */
  stems: string[];
  /** Which are in the mix. */
  on: Record<string, boolean>;
  playing: boolean;
  /** Bumped when the deck's contents change, for anything memoising on it. */
  revision: number;
  press: (stem: string, pointer: number) => void;
  lift: (pointer: number) => void;
  toggleRun: () => void;
  /** Re-read the deck after something outside changed it. */
  refresh: () => void;
  /** Attach a pad's meter element so the animation loop can drive it. */
  meterRef: (stem: string) => (el: HTMLElement | null) => void;
  /** Attach the progress element, filled 0-100% every frame. */
  headRef: (el: HTMLElement | null) => void;
}

export function useBoard(total: number): Board {
  const [revision, setRevision] = useState(0);
  const [on, setOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(deck.stems.map((s) => [s, deck.isOn(s)])),
  );
  const [playing, setPlaying] = useState(deck.playing);

  const meters = useRef(new Map<string, HTMLElement>());
  const head = useRef<HTMLElement | null>(null);
  /** Which press is on which pad, and when it started - a hold is measured from
   *  the press, and two thumbs must not measure each other's. */
  const held = useRef(new Map<number, { stem: string; at: number }>());

  const refresh = useCallback(() => {
    setOn(Object.fromEntries(deck.stems.map((s) => [s, deck.isOn(s)])));
    setPlaying(deck.playing);
    setRevision((n) => n + 1);
  }, []);

  /* The meters and the playhead, driven straight onto the DOM.
   *
   * Sixty times a second through React would be sixty renders a second of a
   * whole board, for values nothing else depends on. These write two style
   * properties per part and stop entirely when the deck is not running. */
  useEffect(() => {
    if (!playing) {
      for (const el of meters.current.values()) el.style.transform = 'scaleY(0)';
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const levels = deck.levels();
      for (const [stem, el] of meters.current) {
        el.style.transform = `scaleY(${(levels[stem] ?? 0).toFixed(3)})`;
      }
      if (head.current && total > 0) {
        head.current.style.width = `${Math.min(100, (deck.position() / total) * 100).toFixed(2)}%`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  const flip = useCallback((stem: string, next: boolean) => {
    deck.setOn(stem, next);
    setOn((prev) => ({ ...prev, [stem]: next }));
  }, []);

  const press = useCallback(
    (stem: string, pointer: number) => {
      held.current.set(pointer, { stem, at: performance.now() });
      flip(stem, !deck.isOn(stem));
    },
    [flip],
  );

  const lift = useCallback(
    (pointer: number) => {
      const h = held.current.get(pointer);
      if (!h) return;
      held.current.delete(pointer);
      // Held rather than tapped: put it back where it was. A tap latches.
      if (performance.now() - h.at >= HOLD_MS) flip(h.stem, !deck.isOn(h.stem));
    },
    [flip],
  );

  const toggleRun = useCallback(() => {
    if (deck.playing) {
      deck.pause();
      setPlaying(false);
      // Paused here, the app's own player can have the speakers back - but not
      // the song, which is still sitting on this deck where it was left.
      returnOutput();
    } else {
      claimOutput();
      deck.play();
      setPlaying(deck.playing);
    }
  }, []);

  return {
    stems: deck.stems,
    on,
    playing,
    revision,
    press,
    lift,
    toggleRun,
    refresh,
    meterRef: (stem: string) => (el: HTMLElement | null) => {
      if (el) meters.current.set(stem, el);
      else meters.current.delete(stem);
    },
    headRef: (el: HTMLElement | null) => {
      head.current = el;
    },
  };
}
