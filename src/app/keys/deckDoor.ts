/**
 * The keyboard's handle on the deck.
 *
 * Same seam as nowPlayingDoor and djDoor: the Player registers, the listener
 * knocks. The Player is the only thing that knows which of its three
 * transports a press should land on - its own deck, the device it is
 * mirroring over Connect, or the groove it is following - and it already
 * resolves that once per render for the strip, the sheet and the lock
 * screen. The keyboard reads the SAME resolved handlers rather than a fourth
 * set, so Space and the strip's Pause can never disagree about what "pause"
 * means on a phone that is only holding the remote.
 *
 * Registered as a GETTER, not a snapshot: the handlers are rebuilt every
 * render and the listener is installed once, so it asks for the current set
 * at the moment of the press - the carPlayControls pattern, read from the
 * other side.
 */

export interface KeyboardDeck {
  /** Play if paused, pause if playing - whichever deck is on screen. */
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  /** Move the clock by so many seconds, either way, clamped to the song. */
  seekBy: (seconds: number) => void;
  /** Move the fader by so many points (unity is 100). */
  volumeBy: (delta: number) => void;
  toggleMute: () => void;
  /** Off -> shuffle -> smart shuffle -> off: the sheet's own cycle. */
  cycleShuffle: () => void;
  /** Off -> all -> one -> off. */
  cycleRepeat: () => void;
  toggleFavourite: () => void;
  /** Show or hide what plays next. */
  toggleQueue: () => void;
  /** Lift or put down the full-screen player; on a docked shape, fold the
   *  pane away while idle or bring a folded one back. */
  toggleNowPlaying: () => void;
}

let getter: (() => KeyboardDeck) | null = null;

export function setKeyboardDeck(next: (() => KeyboardDeck) | null): void {
  getter = next;
}

/** The deck as it stands right now, or null while no Player is mounted. */
export function keyboardDeck(): KeyboardDeck | null {
  return getter ? getter() : null;
}
