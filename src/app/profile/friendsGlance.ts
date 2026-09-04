import { useSyncExternalStore } from 'react';
import type { RegistryFriend } from '../servers/registry.ts';

/**
 * The last friends feed the app read, for any surface that wants a glance.
 *
 * FriendNotices polls `/v1/friends` on the registry for the whole life of a
 * signed-in session - it has to, to notice a request landing - and it used to
 * throw the answer away once the notices were raised. The Discover page's
 * People shelf wants exactly that answer (who is online, what they are
 * hearing) and would otherwise be a second poller asking the same host the
 * same question on its own clock. So the one poll publishes here, and the
 * shelf reads.
 *
 * A module store rather than a context: the poller lives beside the bell in
 * App's chrome and the reader is deep in a tab, and a provider wrapping both
 * would be most of App.tsx. Same shape as presence.ts.
 */
let friends: RegistryFriend[] = [];
let readAt = 0;
const listeners = new Set<() => void>();

export function publishFriendsGlance(next: RegistryFriend[]): void {
  friends = next;
  readAt = Date.now();
  for (const l of listeners) l();
}

/** Signed out: the glance belongs to nobody now. */
export function clearFriendsGlance(): void {
  if (friends.length === 0) return;
  friends = [];
  readAt = 0;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function read(): RegistryFriend[] {
  return friends;
}

/** The friends as last read - an empty array until the first poll lands. */
export function useFriendsGlance(): RegistryFriend[] {
  return useSyncExternalStore(subscribe, read, read);
}

/** When the glance was last read, 0 for never. */
export function friendsGlanceReadAt(): number {
  return readAt;
}
