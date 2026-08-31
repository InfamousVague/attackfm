import { useEffect, useRef, useState, type ReactNode } from 'react';
import { applyStagedBundle, checkForUpdate } from './appUpdate.ts';
import { isTauri } from '../core/tauri.ts';
import wordmark from '../../assets/attack-white.png';

/**
 * The moment before the app: look for a newer frontend, install it, and only
 * then let go.
 *
 * Launch is the one moment where swapping the frontend costs nothing, because
 * there is nothing on screen to tear out from under. The rest of appUpdate.ts
 * is built around avoiding a mid-session swap; this is the gap it leaves.
 *
 * THE RULE THIS FOLLOWS: a gate may never be the reason the app does not open.
 * Every path out of here ends in `done`, including the ones that fail.
 *
 * WHY IT ASKS THE BINARY FIRST. This gate runs before the providers, and the
 * providers are what settle the boot wager (`reportBootOk`). On a generation-1
 * binary `bundle_state` was destructive - it treated any outstanding wager as
 * a failed boot and DELETED the running bundle - and `checkForUpdate`'s opening
 * move is `bundle_state`. So on those binaries this gate could not run at all
 * without occasionally destroying the app, which is what it spent 0.3.315 to
 * 0.3.323 doing. Five attempts to sequence around it from here failed, because
 * the interleaving is not observable from JavaScript.
 *
 * Generation 2 fixed it where it actually lived: `bundle_state` is a pure read,
 * and the one destructive step is `bundle_claim_boot`, which the boot loader
 * makes once, atomically, under a lock. From there this gate is free to ask
 * whatever it likes - and it no longer touches the wager at all. The wager is
 * staked by the loader and settled by the providers, exactly as designed, and
 * nothing in between needs to know about it.
 *
 * On anything older the check is simply skipped and the app opens. Updates
 * still arrive: the periodic check installs them from inside the session, and
 * `bundle_install` sets `active` itself, so the next launch runs the new one
 * regardless. All that is lost is a few hours.
 */

/** How long the whole check may take before the app opens anyway. */
const DEADLINE_MS = 6000;

/**
 * Only one automatic apply per launch. `applyStagedBundle` reloads, and the
 * reload re-runs this gate inside the NEW bundle - which is how a chain of
 * versions applies in order. sessionStorage survives the reload and not the
 * app, which is exactly the lifetime of "this launch".
 */
const APPLIED_KEY = 'attackfm-launch-applied';

/** The generation from which `bundle_state` is safe to call before the app
 *  has mounted. Published by the boot loader in index.html. */
const SAFE_FROM = 2;

type Phase = 'checking' | 'installing' | 'done';

function nativeGeneration(): number {
  return typeof window.__afmNativeGeneration === 'number' ? window.__afmNativeGeneration : 0;
}

function alreadyApplied(): boolean {
  try {
    return sessionStorage.getItem(APPLIED_KEY) !== null;
  } catch {
    // No sessionStorage is no memory of having applied, and the safe reading of
    // that is "do not apply", because the failure it guards is an endless loop.
    return true;
  }
}

function markApplied(version: string): void {
  try {
    sessionStorage.setItem(APPLIED_KEY, version);
  } catch {
    /* Nothing to do: the guard above treats an unusable store as applied. */
  }
}

export function LaunchUpdate({ children }: { children: ReactNode }) {
  // Decided before the first render rather than in an effect, so neither a
  // browser tab nor an old binary ever flashes a gate it is not subject to.
  const [phase, setPhase] = useState<Phase>(() =>
    isTauri() && nativeGeneration() >= SAFE_FROM && !alreadyApplied() ? 'checking' : 'done',
  );
  const [version, setVersion] = useState<string | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    if (phase !== 'checking') return;
    let alive = true;
    const finish = () => {
      if (!alive || settled.current) return;
      settled.current = true;
      setPhase('done');
    };
    // The backstop, for the failure that has no error: a fetch that never
    // settles. A staged INSTALL is not cut off by it - once bytes are landing
    // the work is nearly done - only the asking is.
    const timer = setTimeout(finish, DEADLINE_MS);

    void checkForUpdate()
      .then((outcome) => {
        if (!alive || settled.current) return;
        if (outcome.state !== 'staged') {
          finish();
          return;
        }
        // Installed. Take the deadline off - the reload is imminent, and being
        // cut off between "installed" and "running it" is the one state worth
        // avoiding, since the next launch would have to do it again.
        clearTimeout(timer);
        settled.current = true;
        markApplied(outcome.version);
        setVersion(outcome.version);
        setPhase('installing');
        // A beat on screen before the reload, so the version that just arrived
        // is legible rather than a flash.
        setTimeout(applyStagedBundle, 900);
      })
      .catch(finish);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [phase]);

  if (phase === 'done') return <>{children}</>;

  return (
    <div className="launchGate" role="status" aria-live="polite" aria-label="AttackFM is starting">
      {/* The wordmark IS the loader: the wave sweeps through the letters'
          own negative space rather than along a bar beneath them. The PNG is
          white-on-transparent, so it doubles as the mask that clips the
          travelling gradient to the letterforms - the mask URL has to come
          from here because the asset's hashed path only exists in JS. */}
      <span className="launchGate__markWrap" aria-hidden>
        <img className="launchGate__mark" src={wordmark} alt="" draggable={false} />
        <span
          className="launchGate__wave"
          style={{
            WebkitMaskImage: `url(${wordmark})`,
            maskImage: `url(${wordmark})`,
          }}
        />
      </span>
      <p className="launchGate__say">
        {phase === 'installing' && version ? `Installing ${version}…` : 'Checking for updates…'}
      </p>
    </div>
  );
}
