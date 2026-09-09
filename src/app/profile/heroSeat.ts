import { useEffect, useRef, useState } from 'react';
import type { ActiveFriend } from './friendStanding.ts';

/**
 * Which friend is in the hero's one seat, and when the seat changes hands.
 *
 * "One at a time" is the whole design: several friends can be listening, and
 * the page shows one of them big rather than a grid of thumbnails, then takes
 * turns. The turn-taking is the part that can go wrong, and it goes wrong in
 * one specific way - the card swaps the name out from under a finger already
 * on its way to a button, and a song gets sent to the wrong person. Every rule
 * below exists to make that impossible rather than unlikely.
 *
 * The seat is held BY HANDLE, not by index. A poll landing between two frames
 * reorders the cast (somebody paused, somebody new arrived); an index would
 * quietly become a different person while the same pixels stayed on screen.
 */

/** How long one friend holds the seat, when nothing is holding the rotation. */
export const DWELL_MS = 20_000;

/**
 * How long a touch keeps the card still.
 *
 * A pointer that has left the card has genuinely left it on a mouse; on a
 * touchscreen there is no hover to notice, so the tap itself has to buy the
 * stillness. Eight seconds is long enough to read what the tap revealed.
 */
export const TOUCH_HOLD_MS = 8_000;

/**
 * The friend who should hold the seat now, given who held it last.
 *
 * Still in the cast - even at a completely different rank - they keep it. Rank
 * decides who gets a turn, never who loses one mid-turn: a friend who pauses
 * while you are reading about them does not yank the card away, the card just
 * says something that is now true about them instead.
 *
 * Gone from the cast, and the seat goes to whoever now stands where they
 * stood, rather than jumping back to the top. Losing your place in a list is
 * not the same failure as losing the person, and it should not look like one.
 */
export function keepSeat(cast: readonly ActiveFriend[], held: string | null, heldAt: number): string | null {
  if (cast.length === 0) return null;
  if (held !== null && cast.some((c) => c.friend.handle === held)) return held;
  const at = Math.min(Math.max(heldAt, 0), cast.length - 1);
  return cast[at]!.friend.handle;
}

/** The next turn: the following friend in cast order, wrapping.
 *
 *  Round-robin rather than "whoever has been shown least recently", which
 *  would need a ledger on disk to survive a reload and would answer the same
 *  question. Walking the ranked list in order is already fair - everybody in
 *  the cast gets a turn inside one lap - and it is fair without remembering
 *  anything, which means it cannot be fair-on-one-device-only. */
export function seatAfter(cast: readonly ActiveFriend[], held: string | null): string | null {
  if (cast.length === 0) return null;
  const at = cast.findIndex((c) => c.friend.handle === held);
  if (at < 0) return cast[0]!.friend.handle;
  return cast[(at + 1) % cast.length]!.friend.handle;
}

/**
 * The seat, as a hook.
 *
 * `held` is the caller's word for "a person is busy with this card" - pointer
 * inside, focus inside, a recent tap, a pinned seat. While it is true the
 * timer is CLEARED, not paused, and when it goes false the dwell starts again
 * from full. A rotation that resumes with two seconds left on the clock is the
 * same rug-pull, just rarer and therefore harder to believe when reported.
 */
export function useHeroSeat(cast: ActiveFriend[], held: boolean): {
  seat: ActiveFriend | null;
  show: (handle: string) => void;
} {
  const [handle, setHandle] = useState<string | null>(null);
  // Where the seated friend stood last time we looked, so that if they leave
  // the cast the seat can stay where it was rather than snapping to the top.
  const at = useRef(0);

  const seated = keepSeat(cast, handle, at.current);
  if (seated !== handle) {
    // Derived during render on purpose: the alternative is an effect, which
    // would paint one frame naming a friend who is no longer in the cast.
    setHandle(seated);
  }
  const index = cast.findIndex((c) => c.friend.handle === seated);
  if (index >= 0) at.current = index;

  // The cast is rebuilt on every poll and every re-render, so the timer must
  // NOT depend on its identity - a new array each render would clear and
  // restart the countdown before it ever reached zero, and the seat would
  // never change hands. The effect watches WHO is in the cast, in order, and
  // reads the objects themselves off a ref.
  const latest = useRef(cast);
  latest.current = cast;
  const roster = cast.map((c) => c.friend.handle).join('\u0000');

  // A tab in the background must not burn through the cast unwatched, so the
  // rotation stops with the page and starts again - from full - when it comes
  // back. Tracked as state rather than read inside the timer, because the
  // event is the only thing that can restart a cleared countdown.
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  useEffect(() => {
    if (held || !visible) return;
    if (latest.current.length < 2) return;
    const timer = setTimeout(() => setHandle((h) => seatAfter(latest.current, h)), DWELL_MS);
    return () => clearTimeout(timer);
  }, [roster, held, handle, visible]);

  return {
    seat: cast.find((c) => c.friend.handle === seated) ?? null,
    show: setHandle,
  };
}
