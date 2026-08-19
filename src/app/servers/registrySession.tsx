//! The signed-in central identity, held for the whole app.
//!
//! This is the account that comes FIRST - before any music server. It persists
//! to local storage so a returning listener is known at once (read
//! synchronously, no launch splash), and a token renewal runs quietly behind
//! the app the way the server session's does.
//!
//! Kept separate from `serverSession` on purpose: one is WHO you are (this), the
//! other is WHICH library you are playing from. An account can exist with no
//! server joined, and a server is reached by an account - so identity is the
//! outer of the two.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { refresh as apiRefresh, type RegistryAccount, type RegistrySession } from './registry.ts';

/** Where the registry session lives. Exported because serverSync reads the
 *  token straight from storage (it runs outside React) - a second literal of
 *  this key was one rename away from a sync that silently stopped. */
import { usePrefsSync } from './prefsSync.ts';
import { REGISTRY_SESSION_KEY } from './registryKeys.ts';

export { REGISTRY_SESSION_KEY };
const KEY = REGISTRY_SESSION_KEY;

interface RegistrySessionValue {
  /** The signed-in identity, or null before an account is created/restored. */
  session: RegistrySession | null;
  account: RegistryAccount | null;
  /** Adopt a session from a signup/login/redeem call. */
  apply: (session: RegistrySession) => void;
  /** Sign the account out of this device (identity only; server sessions are
   *  their own thing). */
  signOut: () => void;
}

const Ctx = createContext<RegistrySessionValue | null>(null);

function read(): RegistrySession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RegistrySession;
    return parsed?.token && parsed.account?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function RegistrySessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<RegistrySession | null>(read);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Settings that belong to the person ride with the identity, so they are kept
  // in step here rather than anywhere that has to remember to ask. Does nothing
  // at all until there is an account to sync to.
  usePrefsSync(session?.token);

  const persist = useCallback((next: RegistrySession | null) => {
    setSession(next);
    try {
      if (next) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } catch {
      // Applies for this run regardless; it just will not survive a relaunch.
    }
  }, []);

  // One quiet renewal on launch: a stored token is trusted enough to render
  // from at once, but it may have aged out while the app was closed. A failure
  // is not a sign-out - the registry may just be unreachable from here - so the
  // stored identity stays put and the next action finds out for real.
  useEffect(() => {
    const stored = read();
    if (!stored) return;
    let live = true;
    void (async () => {
      try {
        const renewed = await apiRefresh(stored.token);
        if (live) persist(renewed);
      } catch {
        // Offline, or genuinely expired; leave the stored session in place.
      }
    })();
    return () => {
      live = false;
    };
  }, [persist]);

  const value = useMemo<RegistrySessionValue>(
    () => ({
      session,
      account: session?.account ?? null,
      apply: persist,
      signOut: () => persist(null),
    }),
    [session, persist],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRegistry(): RegistrySessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRegistry must be used within a RegistrySessionProvider');
  return v;
}
