import type { Track } from '../core/tauri.ts';

/**
 * Whether the song on the Now Playing screen can be sent to a friend, and
 * when it cannot, whether that is worth a seat.
 *
 * Sending a song in this app is not a link. What travels through the registry
 * is the NAME - artist, title, album - and the friend's OWN hub then goes and
 * gets the song (SendToFriend.tsx). Everything below falls out of that one
 * fact, which is why the rules are here as a value rather than as five
 * conditions inlined in a 2,400-line component: the interesting cases are all
 * about whether there is a name to send and somebody to send it to, and none
 * of them are about this screen.
 *
 * Three answers, and the difference between the last two is the whole point:
 *
 *   'send'    - offer it.
 *   'unnamed' - offer it, greyed, saying why. There IS a song here and a
 *               listener looking at it; a seat that vanished for this one row
 *               and no other reads as a bug, and the reason is one sentence.
 *   'none'    - no seat at all. Reserved for the cases where the seat could
 *               not become live by anything the listener does ON this screen,
 *               so a greyed glyph would be permanent furniture explaining a
 *               feature they have not opted into.
 */
export type ShareSeat = 'send' | 'unnamed' | 'none';

export function shareSeat(
  track: Track | null,
  { account, following }: { account: boolean; following: boolean },
): ShareSeat {
  // NO CENTRAL ACCOUNT, NO SEAT. A share is between registry accounts, and
  // without one there is not only no token - there is no friends list to send
  // to, and no way to make one from here. This is also what the app's one
  // existing door does (TrackMenu hides the row on the same test); two answers
  // to one question is worse than either answer.
  if (!account) return 'none';
  // MIRRORING A GROOVE. The song on screen belongs to the room, and this
  // deck is holding either nothing or something else - so a send from here
  // could carry the wrong name. The heart stands down in a groove for the
  // same reason; this stands beside it and stands down with it.
  if (following) return 'none';
  if (!track) return 'none';
  // A BOOK IS NOT A SONG. The recipient's hub takes the name and goes looking
  // for a SONG - so "Chapter Nineteen" by the author either finds nothing or,
  // worse, finds something else. This screen already reshapes itself for a
  // book (the header trades filing for a bookmark, the actions row stands
  // down on a phone), so a seat that is not there is the shape it already has.
  if (track.kind === 'book') return 'none';
  // AND THE SONG HAS TO HAVE A NAME. This is the registry's own rule - "A song
  // needs an artist and a title", registry/main.rs - checked here so it is a
  // greyed button rather than a 400 read out of a drawer that had already
  // asked you to pick a friend.
  //
  // Note what is NOT on this list: where the file lives. A tagged song on this
  // laptop is exactly as sendable as one on a hub, because what crosses is the
  // name and not the bytes. What disqualifies a song is having no name, and a
  // hub-scanned row always has one (scan.rs fills "Unknown artist") - so in
  // practice this catches the blank stand-in the deck holds while nothing is
  // loaded, and untagged local files.
  if (!track.artist.trim() || !track.title.trim()) return 'unnamed';
  return 'send';
}
