/**
 * The door onto the friend picker - the one multi-select for "who?".
 *
 * Playlists ("Add people…"), the New-playlist sheet ("Choose people"), the
 * groove deck ("Invite friends…", "Start with friends…") and the Friends
 * page's bulk invite all ask the same question, and a sheet that answers it
 * cannot live inside any of them: three of those seats are popovers, and a
 * sheet rendered inside a popover is unmounted by the tap that opens it.
 * So the picker is hoisted to app level (profile/FriendPicker.tsx, mounted
 * in App.tsx beside JoinGrooveSheet) and asked through this: a tiny store,
 * replayed on subscribe so an ask fired before the sheet has mounted is not
 * lost - the same shape as grooveEntry's door.
 *
 * `openFriendPicker` resolves with the chosen people, or null when the
 * sheet is put down without choosing. The CALLER does the work (adds the
 * members, sends the invites) and says how it went in its own words; the
 * picker only ever answers "these ones".
 */

export type FriendPickerMode =
  /** Anyone on this hub - the hub's own rule for a playlist seat. Friends
   *  elsewhere are shown, dimmed, with the reason. */
  | 'playlist'
  /** Registry friends on this hub - the only people a groove invite can
   *  reach. Online first; people already in the room are excluded. */
  | 'groove';

export interface PickedPerson {
  /** Their name on this hub (a registry handle, or the hub username for a
   *  member who is not a registry friend). */
  handle: string;
  /** The hub's numeric id, when the roster knew it. */
  userId?: number;
}

export interface FriendPick {
  people: PickedPerson[];
  /** The seat chosen on the confirm step. 'editor' unless the ask offered
   *  the choice and the person picked otherwise. */
  role: 'editor' | 'viewer';
}

export interface FriendPickerRequest {
  /** "Add people", "Invite friends". */
  title: string;
  /** A line under the title: what they are being added to. */
  hint?: string;
  /** The primary button's words for a count - `n => \`Add ${n} to the
   *  playlist\``. Asked with 0 too, for the disabled button's label. */
  action: (count: number) => string;
  mode: FriendPickerMode;
  /** Names already in (the members, the room, yourself) - hidden. */
  exclude?: string[];
  /** Offer "as editors / as viewers" on the confirm step. */
  roles?: boolean;
  /** Told the same thing the promise resolves with, for callers that
   *  would rather not hold a promise across a popover closing. */
  onPick?: (pick: FriendPick) => void;
}

/** One ask, as the sheet holds it: the request and the way to answer it. */
export interface FriendPickerAsk {
  id: number;
  request: FriendPickerRequest;
  settle: (pick: FriendPick | null) => void;
}

let held: FriendPickerAsk | null = null;
let seq = 0;
const listeners = new Set<(ask: FriendPickerAsk) => void>();

/** Raise the picker. Resolves with the choice, or null for "not now". */
export function openFriendPicker(request: FriendPickerRequest): Promise<FriendPick | null> {
  return new Promise((resolve) => {
    // A second ask while one is up answers the first with nothing: the
    // sheet can only hold one question, and the newer one is the live one.
    held?.settle(null);
    let done = false;
    const ask: FriendPickerAsk = {
      id: ++seq,
      request,
      settle: (pick) => {
        if (done) return;
        done = true;
        if (held === ask) held = null;
        if (pick) request.onPick?.(pick);
        resolve(pick);
      },
    };
    held = ask;
    for (const fn of listeners) fn(ask);
  });
}

/** Be told when the picker is asked for - now, or the moment it is. */
export function onFriendPicker(fn: (ask: FriendPickerAsk) => void): () => void {
  listeners.add(fn);
  if (held) fn(held);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Names in a sentence: "Kayla", "Kayla and Sam", "Kayla, Sam and Ana".
 * The toasts and the results lines all say a list of people this way.
 */
export function sayNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
