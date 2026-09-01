import { useEffect } from 'react';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchFriends as fetchRegistryFriends } from '../servers/registry.ts';
import { mirrorFriendsToHub } from '../api/friends.ts';

/**
 * Friends live on the registry; a hub needs its own copy to gate what is
 * shared inside its walls (playlist members, profiles).
 *
 * Nothing ever filled the hub's friend table - the Friends tab is entirely
 * attack.fm - so every hub-side friendship check failed for everyone. This
 * hands the hub the registry friends' handles; the hub keeps only the ones who
 * are members here and files a friend request from this account to each. When
 * the other person's app does the same, the crossed requests settle into a
 * friendship. Symmetric on purpose: neither client's word alone makes two
 * people friends on a hub.
 */
const EVERY_MS = 10 * 60 * 1000;

export function FriendMirrorBridge() {
  const registry = useRegistryOptional();
  const { session } = useServerSession();
  const token = registry?.session?.token ?? null;

  useEffect(() => {
    if (!token || !session) return;
    let live = true;
    const pass = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const feed = await fetchRegistryFriends(token);
        if (!live) return;
        const handles = feed.friends.map((f) => f.handle).filter(Boolean);
        if (handles.length) await mirrorFriendsToHub(session, handles);
      } catch {
        // Either side unreachable: the next pass tries again.
      }
    };
    const first = window.setTimeout(() => void pass(), 3000);
    const timer = window.setInterval(() => void pass(), EVERY_MS);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [token, session]);

  return null;
}
