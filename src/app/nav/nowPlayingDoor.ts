/**
 * The door into Now Playing, from anywhere.
 *
 * The full-screen sheet is state inside the Player (`npOpen`), and the only
 * thing that lifted it was a tap on the strip - which is fine for a song you
 * picked yourself and useless for a room you just walked into: the join lands
 * in the provider, three trees away from the strip, and a person who tapped
 * Join on a friend's groove expects the player to come up and say so.
 *
 * Same seam as djDoor: the Player registers the opener, anyone knocks. One
 * difference, and it is the whole reason this is not a bare callback: the
 * knock can arrive BEFORE there is a Player at all. A guest with an idle deck
 * has no strip until the room stands one up, and that happens on the render
 * after the join - so a knock with nobody home is held for a few seconds and
 * answered by the next registration. Held, not queued: a stale knock from a
 * join that fell through must never lift the sheet a minute later.
 */
let opener: (() => void) | null = null;
let knockedAt = 0;
/** How long an unanswered knock waits for a Player to mount. */
const KNOCK_MS = 5000;

export function setNowPlayingDoor(fn: (() => void) | null): void {
  opener = fn;
  if (!fn) return;
  const fresh = knockedAt > 0 && Date.now() - knockedAt < KNOCK_MS;
  knockedAt = 0;
  if (fresh) fn();
}

/** Whether a Player is standing with a sheet to lift. */
export function nowPlayingDoorOpen(): boolean {
  return opener !== null;
}

/** Lift Now Playing now, or as soon as a Player mounts. Resolves true when
 *  the sheet went up on the spot. */
export function openNowPlaying(): boolean {
  if (opener) {
    knockedAt = 0;
    opener();
    return true;
  }
  knockedAt = Date.now();
  return false;
}
