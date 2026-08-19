/**
 * Somebody else needs the speakers.
 *
 * The deck assumes it is the only thing making sound, and for a long time it
 * was. It is not any more: karaoke plays its own vocal-less mix, and the pad
 * sampler runs a song's stems as a loop you play over. Both of those are the
 * whole output while they are up, and both of them used to start on top of
 * whatever the deck was already playing - two songs at once, and no way for
 * either surface to do anything about it, because the deck's transport is
 * closed over inside Player and nothing outside can reach it.
 *
 * So this is the smallest possible door: a count of how many surfaces currently
 * claim the output, and a subscription the deck listens on. A claim pauses the
 * deck. A release optionally says WHERE the song got to while it was away, and
 * that is the whole hand-off: tapping Stems on the Now Playing screen carries
 * the song across mid-phrase, and closing it carries the song back to the same
 * spot. A release with no position leaves the deck where it was, silent, which
 * is right when the surface was playing something else entirely.
 *
 * Note that a plain release never starts the deck on its own. Music resuming by
 * itself because a panel closed is startling; music continuing from the second
 * it reached is not, and the difference is entirely whether the surface says so.
 *
 * Counted rather than boolean because two claims can overlap (the sampler page
 * left open behind the karaoke stage), and the first release must not hand the
 * output back while the second holder is still using it.
 */

let holders = 0;
const listeners = new Set<(held: boolean, resumeAt?: number) => void>();

/**
 * Claim the output. Returns the release, which is safe to call twice - a React
 * cleanup running after an explicit release is normal, and a double decrement
 * would let the count go negative and strand the deck.
 *
 * Pass `resumeAt` (seconds into the same song) to hand playback back rather
 * than merely stopping: the deck seeks there and plays.
 */
export function holdDeck(): (resumeAt?: number) => void {
  holders += 1;
  if (holders === 1) for (const l of listeners) l(true);
  let released = false;
  return (resumeAt?: number) => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) for (const l of listeners) l(false, resumeAt);
  };
}

export function deckHeld(): boolean {
  return holders > 0;
}

export function subscribeDeckHold(
  cb: (held: boolean, resumeAt?: number) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
