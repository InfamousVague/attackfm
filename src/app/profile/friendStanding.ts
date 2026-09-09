import { isOnline } from './friendPresence.ts';
import type { RegistryFriend } from '../servers/registry.ts';

/**
 * Where a friend is standing right now, and which of them the page should put
 * at the front.
 *
 * This is a separate module from `friendPresence.ts` because it answers a
 * different question. That one asks "is this person here?" - one friend, one
 * boolean. This one asks "of all these people, whose evening is worth drawing
 * big?", which is a ranking, and rankings are where the silent failures live:
 * a hero titled after whoever happens to sort first, a card that names a
 * friend who stopped listening an hour ago, an order that flickers between two
 * equal friends on every poll. All of that is arithmetic, so all of it belongs
 * somewhere it can be tested without rendering anything.
 *
 * The distinction the app did not previously make: ONLINE and PLAYING are two
 * different claims. `PeopleShelf` filtered on `online || nowPlaying?.playing`
 * and then titled the card with the first match, so on a quiet evening the
 * headline was a friend who had merely opened the app. Being awake is not
 * news. Standing keeps the two apart and lets the caller decide how far down
 * the ladder it is willing to go.
 */

/** Playing, paused, here at all, or gone. */
export type Standing = 'playing' | 'paused' | 'here' | 'away';

/**
 * How long a `nowPlaying` is believed after the registry last heard it.
 *
 * The registry keeps the last glance it was told about; it does not expire it
 * on the friend's behalf. A phone that goes into a tunnel mid-song leaves a
 * `playing: true` sitting there forever, and without a bound the hero would
 * announce a song somebody finished before dinner. Five minutes is longer than
 * the announce interval and shorter than most albums.
 */
export const SONG_FRESH_MS = 5 * 60_000;

/** The registry stamps in seconds; a small number is one of those. */
function stampMs(stamp: number): number {
  return stamp < 1e12 ? stamp * 1000 : stamp;
}

/** Is their song recent enough to be worth repeating out loud? */
export function songIsFresh(f: RegistryFriend, now: number): boolean {
  const np = f.nowPlaying;
  if (!np) return false;
  const heard = stampMs(np.at);
  const age = now - heard;
  // A stamp from the future is a clock disagreement, not a fresh song; treat
  // anything ahead of us as unusable rather than eternally fresh.
  return age >= 0 && age <= SONG_FRESH_MS;
}

/**
 * What we can honestly say about them this second.
 *
 * `playing` and `paused` both require a FRESH song - a stale one tells us
 * nothing about now, so a friend behind one falls back to whether they are
 * online, which is a claim with its own heartbeat behind it.
 */
export function standingOf(f: RegistryFriend, now: number): Standing {
  const np = f.nowPlaying;
  if (np && songIsFresh(f, now)) return np.playing ? 'playing' : 'paused';
  return isOnline(f) ? 'here' : 'away';
}

/** Everything the ranking needs to know about the viewer's side of it. */
export interface StandingContext {
  /** Their library answers on the server this device is listening from. */
  sameHub: (f: RegistryFriend) => boolean;
  /** They are hosting a groove that can be walked into. */
  hosting?: (f: RegistryFriend) => boolean;
}

/**
 * The score, highest first.
 *
 * Ordered by what there is to DO about them, not by how loud they are: a room
 * you can walk into beats a song you can follow beats a song you can only
 * watch. Same-hub outranks cross-hub at every tier because same-hub is where
 * the verbs are - listen along and invite both need the music to be reachable.
 */
export function rankOf(f: RegistryFriend, standing: Standing, ctx: StandingContext): number {
  if (standing === 'away') return 0;
  const near = ctx.sameHub(f);
  if (ctx.hosting?.(f) && near) return 100;
  if (standing === 'playing') return near ? 80 : 55;
  if (standing === 'paused') return near ? 45 : 30;
  return near ? 40 : 25;
}

/** A friend, with the reading that put them in the running. */
export interface ActiveFriend {
  friend: RegistryFriend;
  standing: Standing;
  rank: number;
}

/**
 * The friends worth drawing, best first.
 *
 * The order is TOTAL - rank, then the most recently started song, then when
 * they were last seen, then the handle. Every tie is broken by something that
 * does not change between two renders a second apart, because a list that
 * reorders under a finger is how a tap lands on the wrong person.
 *
 * Away friends are not in it. There is no "seen an hour ago" tier: the hero
 * this feeds is about a room with someone in it, and a card that has to reach
 * back an hour to find a face is a card about an empty room.
 */
export function activeFriends(
  friends: readonly RegistryFriend[],
  ctx: StandingContext,
  now: number,
): ActiveFriend[] {
  const live: ActiveFriend[] = [];
  for (const friend of friends) {
    const standing = standingOf(friend, now);
    if (standing === 'away') continue;
    live.push({ friend, standing, rank: rankOf(friend, standing, ctx) });
  }
  live.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    // "She just put something on" is a better thing to show than a song forty
    // minutes in, and it makes the top of the list turn over as an evening
    // moves rather than freezing on whoever got there first.
    const sa = a.friend.nowPlaying ? stampMs(a.friend.nowPlaying.since) : 0;
    const sb = b.friend.nowPlaying ? stampMs(b.friend.nowPlaying.since) : 0;
    if (sa !== sb) return sb - sa;
    if (a.friend.seenAt !== b.friend.seenAt) return b.friend.seenAt - a.friend.seenAt;
    return a.friend.handle.localeCompare(b.friend.handle);
  });
  return live;
}

/**
 * How many faces the hero will take turns between.
 *
 * Not a display cap - a FAIRNESS one. The rotation walks the list in order, so
 * an uncapped list means the tail is reached only on an evening nobody spends
 * looking at Discover. Five is about ninety seconds of turns, which is longer
 * than anyone reads a shelf.
 */
export const HERO_CAST = 5;
