import type { ServerSession } from '../api/http.ts';
import { fetchFriends as fetchRegistryFriends } from '../servers/registry.ts';
import { mirrorFriendsToHub } from '../api/friends.ts';

/**
 * Hand the hub this account's registry friends, now.
 *
 * The bridge does this on a ten-minute timer, which was the whole of it - so
 * befriending someone and inviting them to a groove a minute later found a
 * hub that could see the member but not the friendship. The moments that
 * change the list (a request sent or accepted) and the moment a refusal says
 * the hub has not caught up both call this instead of waiting for the timer.
 * Resolves true when a list was handed over; the hub keeps the ones who are
 * members here.
 */
export async function syncRegistryFriendsToHub(session: ServerSession, registryToken: string): Promise<boolean> {
  const feed = await fetchRegistryFriends(registryToken);
  const handles = feed.friends.map((f) => f.handle).filter(Boolean);
  if (!handles.length) return false;
  await mirrorFriendsToHub(session, handles, registryToken);
  return true;
}
