import type { SleepTimer } from './playback.tsx';

/**
 * The one question every guard in the deck asks about the sleep timer.
 *
 * A crossfade, a prefetch and the chapter watcher all branch on "is this
 * timer waiting for something to END, or for a clock to run out" - and they
 * ask it from four files, none of which should have to know the shape of the
 * union to do it.
 */

/** Whether a timer is waiting on something ENDING rather than on the clock -
 *  the question every crossfade and prefetch guard is really asking. Written
 *  as a predicate so the clock's own code still narrows to the dated shape. */
export function sleepsAtAnEnd(
  sleep: SleepTimer,
): sleep is 'end-of-track' | 'end-of-chapter' {
  return sleep === 'end-of-track' || sleep === 'end-of-chapter';
}
