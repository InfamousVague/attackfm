import type { ReactNode } from 'react';

/**
 * The moment before the app.
 *
 * WHAT THIS DOES NOW: nothing, and that is the fix.
 *
 * It used to check the registry for a newer frontend, install it, and reload
 * into it before opening the app - so the ordinary way to meet a new version
 * was at launch rather than being interrupted mid-song. Good idea, and it cost
 * five versions of black screens, because of where it had to run to do it.
 *
 * THE WAGER, AND WHY THIS CANNOT LIVE HERE. Booting a downloaded bundle stakes
 * a wager natively (`bundle_begin_boot`) that only a mounted app settles
 * (`reportBootOk`, inside the providers). `bundle_state` is the judge: any
 * wager still outstanding when it is asked is read as a boot that never
 * finished, so the version is quarantined and its directory DELETED - out from
 * under the code currently executing.
 *
 * This gate runs before the providers, and `checkForUpdate`'s opening move is
 * `bundle_state`. Three attempts were made to sequence around that:
 *
 *   0.3.315  settle the wager first, re-stake on the way out. Correct as far
 *            as it went, and it stopped the app quarantining itself outright.
 *   0.3.321  move the re-stake after the check, because the six-second
 *            deadline could fire mid-download and hand `bundle_install`'s own
 *            trailing `bundle_state` a wager to eat.
 *   0.3.322  refuse to ask at all unless the settle provably landed.
 *
 * The device still quarantined the running bundle, at 1.3 seconds, with the
 * settle reporting success and no diagnostic recorded. Whatever the remaining
 * interleaving is, it is below what this side can see: the state file is a
 * read-modify-write shared by three commands with no lock, and the frontend
 * has no way to observe the order it lands in.
 *
 * So the gate stops playing. Nothing here calls `bundle_state` any more, which
 * means nothing can lose that race.
 *
 * WHAT IS NOT LOST. `bundle_install` sets `active` itself, and the boot loader
 * runs whatever is active - so a bundle the periodic check installs during a
 * session is ALREADY what starts at the next launch, with no help from here.
 * The behaviour people actually wanted, meeting a new version at launch rather
 * than mid-song, still happens. What is gone is only the launch-time NETWORK
 * check, so an update is picked up during the session that follows rather than
 * the one that discovers it - hours later at worst, and never at the cost of
 * the app failing to open.
 *
 * WHAT WOULD BRING IT BACK: a native `bundle_peek` that reports state without
 * consuming the wager. That is the actual bug, it has been the actual bug all
 * along, and it needs a new binary rather than an over-the-air fix. Until then
 * this file is deliberately empty of behaviour, and should stay that way.
 */
export function LaunchUpdate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
