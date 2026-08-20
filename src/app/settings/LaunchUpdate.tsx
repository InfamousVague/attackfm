import { useEffect, useRef, useState, type ReactNode } from 'react';
import { applyStagedBundle, checkForUpdate } from './appUpdate.ts';
import { isTauri } from '../core/tauri.ts';
import wordmark from '../../assets/attack-white.png';

/**
 * The moment before the app: look for a newer frontend, install it, and only
 * then let go.
 *
 * The update mechanism has always been able to do this - checkForUpdate
 * installs, applyStagedBundle reloads into what it installed - but it ran
 * twenty seconds AFTER launch and offered the result as a banner. So the
 * ordinary way to meet a new version was to be interrupted by one partway
 * through a song. Launch is the one moment where a swap costs nothing, because
 * there is nothing on screen to tear out from under; the rest of appUpdate.ts
 * is built around avoiding exactly that, and this is the gap it leaves.
 *
 * THE RULE THIS FOLLOWS: a gate may never be the reason the app does not open.
 * Every path out of here ends in `done`, including the ones that fail. Offline,
 * a registry that hangs, a broken response, a build that cannot swap its own
 * frontend - all of them fall through to the app rather than stranding somebody
 * at a spinner over a thing they did not ask for. The deadline below is the
 * backstop for the failure that has no error: a fetch that never settles.
 */

/**
 * How long the whole check may take before the app opens anyway.
 *
 * Deliberately shorter than it takes to be annoying and longer than a healthy
 * check needs. A staged INSTALL is not cut off by this - once bytes are landing
 * the work is nearly done and abandoning it wastes what was already spent -
 * only the asking is.
 */
const DEADLINE_MS = 6000;

/**
 * Only one automatic apply per launch.
 *
 * applyStagedBundle reloads, and the reload re-runs this gate inside the NEW
 * bundle - which is how a chain of versions applies in order without any of
 * this having to understand a queue. It is also how a bundle that installs but
 * reports the wrong version would spin forever: check, install, reload, check,
 * install. sessionStorage survives the reload and not the app, which is exactly
 * the lifetime of "this launch".
 */
const APPLIED_KEY = 'attackfm-launch-applied';

type Phase = 'checking' | 'installing' | 'done';

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
  // A browser tab has no bundle to swap, so there is nothing to wait for and no
  // screen worth showing. Decided before the first render rather than in an
  // effect, so the web app never flashes a gate it was never subject to.
  const [phase, setPhase] = useState<Phase>(() =>
    isTauri() && !alreadyApplied() ? 'checking' : 'done',
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
    // The backstop. Runs whatever the check is doing, because the failure worth
    // guarding is the one that never returns at all.
    const timer = setTimeout(finish, DEADLINE_MS);

    void checkForUpdate()
      .then((outcome) => {
        if (!alive || settled.current) return;
        if (outcome.state !== 'staged') {
          finish();
          return;
        }
        // Installed. Take the deadline off - the reload is imminent and being
        // cut off between "installed" and "running it" is the one state worth
        // avoiding, since the next launch would have to do it again.
        clearTimeout(timer);
        settled.current = true;
        markApplied(outcome.version);
        setVersion(outcome.version);
        setPhase('installing');
        // A beat on screen before the reload, so the version that just arrived
        // is legible rather than a flash. This is the only deliberate delay in
        // here and it is for reading, not for work.
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
    <div className="launchGate" role="status" aria-live="polite">
      <img className="launchGate__mark" src={wordmark} alt="AttackFM" draggable={false} />
      <div className="launchGate__bar" aria-hidden>
        <span className="launchGate__barFill" />
      </div>
      <p className="launchGate__say">
        {phase === 'installing' && version
          ? `Installing ${version}…`
          : 'Checking for updates…'}
      </p>
    </div>
  );
}
