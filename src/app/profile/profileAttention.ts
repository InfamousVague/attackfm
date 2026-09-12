import { useSyncExternalStore } from 'react';
import type { Share } from '../servers/registry.ts';

/**
 * What is waiting on the profile page for an answer, counted where the nav
 * seat can read it.
 *
 * The page has three kinds of card with an Accept on them - somebody wants
 * to be friends, somebody wants to groove with you (or listen along), and
 * somebody sent a song (the first from anyone arriving as a question about
 * THEM) - and each already rings the bell. But the bell is a list of news you
 * clear by reading it, and a request is not news you have read: it is a
 * question still standing. So the seat wears the number of questions, and
 * the number only falls when they are answered.
 *
 * NOTHING HERE POLLS. Every one of those cards is already read by something
 * that runs for the whole of a session - FriendNotices and ShareNotices on
 * the registry, the groove provider on the hub - and each publishes what it
 * saw into its own LANE. Lanes rather than one number because the readers
 * are separate and land at separate moments: a poll that only knows about
 * friend requests must not be able to overwrite what the groove poll said a
 * moment ago. The profile page itself publishes too, from its own reads and
 * from the handlers, which is what takes the count down the instant a card
 * is answered rather than a poll later.
 *
 * There is deliberately no "clear everything" verb. The lanes are fed by two
 * different sign-ins - friends and shares follow the registry session, the
 * groove invites follow the hub's - and neither sign-out is the other's. The
 * reader that owns a lane publishes zero when its session goes, exactly where
 * it already takes its bell rows away.
 *
 * A module store rather than a context, for the same reason friendsGlance
 * is: the publishers sit beside the bell in App's chrome and in the player's
 * provider, the reader is the nav, and a provider around all of them would be
 * most of App.tsx.
 */
export type AttentionLane = 'friendRequests' | 'shares' | 'grooveInvites';

const lanes: Record<AttentionLane, number> = { friendRequests: 0, shares: 0, grooveInvites: 0 };
let total = 0;
const listeners = new Set<() => void>();

/** One reader's word on its lane. A repeat of the same number is not a
 *  change and wakes nobody - the polls say the same thing most of the time. */
export function publishProfileAttention(lane: AttentionLane, count: number): void {
  const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (lanes[lane] === next) return;
  lanes[lane] = next;
  total = lanes.friendRequests + lanes.shares + lanes.grooveInvites;
  for (const l of listeners) l();
}

/**
 * How many answers the share inbox is waiting on, as the page draws it: one
 * per SENDER you have not yet said you take songs from at all (their songs
 * are held behind that one question, so they are not each a card), and one
 * per song from a sender you have. Songs from someone you refused are not on
 * the page and are not counted.
 *
 * Here, rather than in each publisher, so the notices poll and the page agree
 * on what a share is worth - two copies of this arithmetic is how a badge
 * comes to say 3 over a page that shows 2.
 */
export function shareAttentionOf(shares: readonly Share[]): number {
  const asking = new Set<string>();
  let songs = 0;
  for (const s of shares) {
    if (s.allowed === null) asking.add(s.from);
    else if (s.allowed === true) songs += 1;
  }
  return asking.size + songs;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Everything waiting, across every lane. */
export function profileAttention(): number {
  return total;
}

function getZero(): number {
  return 0;
}

export function useProfileAttention(): number {
  return useSyncExternalStore(subscribe, profileAttention, getZero);
}
