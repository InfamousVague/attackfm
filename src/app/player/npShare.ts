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
 * Two answers:
 *
 *   'send' - offer it.
 *   'none' - no seat at all, for the cases where the seat could not become
 *            live by anything the listener does ON this screen, so a greyed
 *            glyph would be permanent furniture explaining a feature they
 *            have not opted into.
 *
 * There WAS a third, 'unnamed' - a greyed seat saying a song needs a name
 * before it can be sent - and it was removed because a reviewer proved it
 * cannot happen. Both roads into a Track fill the two names before one
 * exists: the hub's scanner falls back to the filename for a title and to
 * "Unknown artist" for an artist (server/src/scan.rs), and the local parser
 * does the identical thing (src/app/core/tauri.ts). The only nameless Track
 * in the app is the deck's idle stand-in, and it never reaches this screen -
 * it is a `?? IDLE_TRACK` fallback for a plugin slot and nothing else. So the
 * greyed state was a branch nobody could reach, an eight-language string
 * nobody could read, and a disabled control that - being disabled - was not
 * in the tab order to explain itself to the sighted listener it was greyed
 * for. The GUARD stays, as `none`: a song with no name still has nothing to
 * send, and no seat is a better answer than a seat that cannot be pressed.
 */
export type ShareSeat = 'send' | 'none';

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
  // name and not the bytes. What disqualifies a song is having no NAME - and
  // no road into a Track leaves one nameless (see the note above), so this is
  // a guard against a shape the app does not currently make rather than a
  // state a listener will meet.
  if (!track.artist.trim() || !track.title.trim()) return 'none';
  return 'send';
}
