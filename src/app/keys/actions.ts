/**
 * Everything a key can do, in one table.
 *
 * Each action has an id (the keymap's key, and what the settings pane anchors
 * on), a catalogue key for its name and one for the sentence under it, the
 * chord it ships with, and what it does. The chord is the only part a person
 * can change; the rest is the contract the pane, the listener and the tests
 * all read from, so a new action is one entry here and eight catalogue lines
 * and nothing else.
 *
 * THE DEFAULTS, and why each one:
 *
 *   Space        play/pause - the one key every media app agrees on.
 *   ← / →        five seconds back or on. The seek slider's own step is five
 *                seconds too, so a person who tabs to it and one who does not
 *                get the same nudge.
 *   ⇧← / ⇧→      previous / next song. Shift on the same arrows the seek
 *                uses: a bigger move on the same axis.
 *   ↑ / ↓        louder / quieter, five points on the fader.
 *   M            mute.
 *   S            shuffle - the sheet's three-way cycle, not the strip's toggle,
 *                so smart shuffle is reachable from the keyboard.
 *   R            repeat, off -> all -> one.
 *   L            like the song that is playing.
 *   N            now playing - lift the sheet, or put it down.
 *   Q            the queue.
 *   /            search. The field takes the caret, so a second `/` is typed
 *                rather than answered. ⌘K / Ctrl+K is the search field's own
 *                chord (nav/useSearchSummon.ts) and is not in this table on
 *                purpose: it is the kit's convention and stays fixed.
 *   Escape       close whatever sheet is on top - Now Playing, the queue,
 *                search. Kit modals and menus close themselves on Escape and
 *                this action stands down while one is up (keys/guard.ts).
 *
 * The keyboard's own media keys - play, pause, skip, the ones on the F row -
 * arrive through `navigator.mediaSession` (player/mediaSession.ts) and never
 * reach a keydown listener at all, so there is nothing here for them to fight.
 */
import { keyboardDeck } from './deckDoor.ts';

export type KeyActionId =
  | 'playPause'
  | 'seekBack'
  | 'seekForward'
  | 'previous'
  | 'next'
  | 'volumeDown'
  | 'volumeUp'
  | 'mute'
  | 'shuffle'
  | 'repeat'
  | 'like'
  | 'nowPlaying'
  | 'queue'
  | 'search'
  | 'close';

export type KeyActionGroup = 'transport' | 'sound' | 'navigate';

/** What an action may reach beyond the deck: the doors App holds. */
export interface KeyActionDeps {
  openSearch: () => void;
  /** Put down the top sheet; false when nothing was up. */
  closeTop: () => boolean;
}

export interface KeyAction {
  id: KeyActionId;
  group: KeyActionGroup;
  labelKey: string;
  hintKey: string;
  /** The chord it ships with, in `formatChord` spelling. */
  chord: string;
  /**
   * Whether holding the key keeps firing. On for the nudges (seek, volume),
   * where a held arrow is how you scrub; off for the toggles, where a held
   * Space would flutter the deck.
   */
  repeats?: boolean;
  /** Do it. True when something happened, which is when the press is spent. */
  run: (deps: KeyActionDeps) => boolean;
}

/** How far one press of the seek arrows moves, in seconds. */
export const SEEK_STEP = 5;
/** How far one press of the volume arrows moves the fader, in points. */
export const VOLUME_STEP = 5;

/** Reach the deck; nothing to do when no Player is standing. */
const deck = (fn: (d: NonNullable<ReturnType<typeof keyboardDeck>>) => void) => (): boolean => {
  const d = keyboardDeck();
  if (!d) return false;
  fn(d);
  return true;
};

export const KEY_ACTIONS: readonly KeyAction[] = [
  {
    id: 'playPause',
    group: 'transport',
    labelKey: 'keys.playPause',
    hintKey: 'keys.playPauseHint',
    chord: 'Space',
    run: deck((d) => d.togglePlay()),
  },
  {
    id: 'seekBack',
    group: 'transport',
    labelKey: 'keys.seekBack',
    hintKey: 'keys.seekBackHint',
    chord: 'ArrowLeft',
    repeats: true,
    run: deck((d) => d.seekBy(-SEEK_STEP)),
  },
  {
    id: 'seekForward',
    group: 'transport',
    labelKey: 'keys.seekForward',
    hintKey: 'keys.seekForwardHint',
    chord: 'ArrowRight',
    repeats: true,
    run: deck((d) => d.seekBy(SEEK_STEP)),
  },
  {
    id: 'previous',
    group: 'transport',
    labelKey: 'keys.previous',
    hintKey: 'keys.previousHint',
    chord: 'shift+ArrowLeft',
    run: deck((d) => d.previous()),
  },
  {
    id: 'next',
    group: 'transport',
    labelKey: 'keys.next',
    hintKey: 'keys.nextHint',
    chord: 'shift+ArrowRight',
    run: deck((d) => d.next()),
  },
  {
    id: 'volumeUp',
    group: 'sound',
    labelKey: 'keys.volumeUp',
    hintKey: 'keys.volumeUpHint',
    chord: 'ArrowUp',
    repeats: true,
    run: deck((d) => d.volumeBy(VOLUME_STEP)),
  },
  {
    id: 'volumeDown',
    group: 'sound',
    labelKey: 'keys.volumeDown',
    hintKey: 'keys.volumeDownHint',
    chord: 'ArrowDown',
    repeats: true,
    run: deck((d) => d.volumeBy(-VOLUME_STEP)),
  },
  {
    id: 'mute',
    group: 'sound',
    labelKey: 'keys.mute',
    hintKey: 'keys.muteHint',
    chord: 'M',
    run: deck((d) => d.toggleMute()),
  },
  {
    id: 'shuffle',
    group: 'sound',
    labelKey: 'keys.shuffle',
    hintKey: 'keys.shuffleHint',
    chord: 'S',
    run: deck((d) => d.cycleShuffle()),
  },
  {
    id: 'repeat',
    group: 'sound',
    labelKey: 'keys.repeat',
    hintKey: 'keys.repeatHint',
    chord: 'R',
    run: deck((d) => d.cycleRepeat()),
  },
  {
    id: 'like',
    group: 'sound',
    labelKey: 'keys.like',
    hintKey: 'keys.likeHint',
    chord: 'L',
    run: deck((d) => d.toggleFavourite()),
  },
  {
    id: 'nowPlaying',
    group: 'navigate',
    labelKey: 'keys.nowPlaying',
    hintKey: 'keys.nowPlayingHint',
    chord: 'N',
    run: deck((d) => d.toggleNowPlaying()),
  },
  {
    id: 'queue',
    group: 'navigate',
    labelKey: 'keys.queue',
    hintKey: 'keys.queueHint',
    chord: 'Q',
    run: deck((d) => d.toggleQueue()),
  },
  {
    id: 'search',
    group: 'navigate',
    labelKey: 'keys.search',
    hintKey: 'keys.searchHint',
    chord: '/',
    run: (deps) => {
      deps.openSearch();
      return true;
    },
  },
  {
    id: 'close',
    group: 'navigate',
    labelKey: 'keys.close',
    hintKey: 'keys.closeHint',
    chord: 'Escape',
    run: (deps) => deps.closeTop(),
  },
];

export const KEY_ACTION_GROUPS: readonly { id: KeyActionGroup; labelKey: string }[] = [
  { id: 'transport', labelKey: 'keys.groupTransport' },
  { id: 'sound', labelKey: 'keys.groupSound' },
  { id: 'navigate', labelKey: 'keys.groupNavigate' },
];

export function keyAction(id: KeyActionId): KeyAction {
  const found = KEY_ACTIONS.find((a) => a.id === id);
  if (!found) throw new Error(`no key action called ${id}`);
  return found;
}
