import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  applyStagedBundle,
  checkForUpdate,
  restakeBootWager,
  settleBootWager,
} from './appUpdate.ts';
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
 * THE WAGER, AND WHY THIS FILE HAS TO KNOW ABOUT IT. Booting a downloaded
 * bundle stakes a wager natively (`bundle_begin_boot`) that only a working app
 * settles (`reportBootOk`, deep inside the providers). `bundle_state` is the
 * judge: any wager still outstanding when it is asked is read as a boot that
 * never finished, and the version is quarantined and its directory deleted.
 *
 * This gate runs BEFORE those providers and its first act is to ask - so as
 * written it handed the judge an unsettled wager on its own running bundle,
 * every cold start, and the app deleted the code it was executing. So: settle
 * on the way in, stake again on the way out. The wager still ends where it
 * always did, and the window in which nobody is holding it is the one the
 * gate itself occupies.
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
    /**
     * Open the app. Only ever this - never the wager.
     *
     * The deadline calls this too, and that is exactly why re-staking cannot
     * live here: opening the app does not mean the CHECK has finished, and the
     * check is what calls `bundle_state`. See the note on the re-stake below.
     */
    const openApp = () => {
      if (!alive || settled.current) return;
      settled.current = true;
      setPhase('done');
    };
    // The backstop. Runs whatever the check is doing, because the failure worth
    // guarding is the one that never returns at all.
    const timer = setTimeout(openApp, DEADLINE_MS);

    // Settle first, and WAIT, and CHECK THAT IT LANDED: the check's opening
    // move is `bundle_state`, which reads an unsettled wager as a boot that
    // never finished and deletes the bundle it is asked from. So the settle is
    // not a courtesy before the check - it is the precondition for being
    // allowed to ask at all.
    //
    // If it did not land, this launch simply does not check for updates. That
    // costs a few hours: the periodic check runs later, from inside the app,
    // long after the providers have settled the wager the ordinary way. The
    // alternative costs the bundle.
    void settleBootWager()
      .then((ok) => {
        if (!ok) throw new Error('boot wager unsettled; not asking bundle_state');
        return checkForUpdate();
      })
      .then((outcome) => {
        if (!alive || settled.current) {
          // The deadline got here first. The check still finished, and if it
          // installed something the reload will happen at the next launch
          // rather than now - which is the honest outcome for a check that
          // outran its own deadline.
          return false;
        }
        if (outcome.state !== 'staged') return false;
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
        return true; // leaving: this document is about to be replaced
      })
      .catch(() => false)
      .then(async (leaving) => {
        /*
         * Re-stake HERE, and only here: after the check has completely
         * finished, and never when a reload is coming.
         *
         * This cost three versions to learn. Re-staking when the app OPENED
         * looked equivalent and is not, because the deadline can open the app
         * while the check is still downloading - and `bundle_install` ends,
         * in native code, with a `bundle_state` call of its own. That call
         * then found the wager this had just re-staked, read it as a boot that
         * never finished, and quarantined the running bundle mid-flight,
         * deleting the directory underneath it. On a phone the download
         * routinely outruns six seconds, so every update quarantined the
         * version it was updating FROM and restarted to a black screen.
         *
         * Nothing calls `bundle_state` after this point until the next launch,
         * so the wager is safe to hold from here to `reportBootOk` in the
         * providers - which is the whole span it is meant to cover.
         *
         * AWAITED, AND BEFORE THE HANDOVER. Opening the app is what mounts the
         * providers, and their `reportBootOk` is what settles this. Staking
         * afterwards races that effect, and the order is not decided by
         * anything here - lose it and the wager is left standing with nobody
         * ever going to settle it, which the next launch reads as a bundle
         * that failed to boot. Stake, land, THEN hand over: then the settle
         * can only come second.
         */
        if (leaving || !alive || settled.current) return;
        await restakeBootWager();
        openApp();
      });

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
