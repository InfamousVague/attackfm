import { Spotlight } from '@glacier/react';
import { useEffect, useState } from 'react';
import { TOUR_STEPS } from './tourSteps.ts';
import {
  backTourStep,
  endTour,
  nextTourStep,
  startTour,
  tourSeen,
  useTourStep,
} from './tourControl.ts';

/**
 * The tour, on screen.
 *
 * Thin on purpose: the kit's `Spotlight` already is the dimmed backdrop, the
 * cutout, the anchored callout, the step counter, focus trapping, Escape, and
 * tracking the target through scroll and resize. What is left is the part the
 * kit cannot know - WHICH element, and whether it exists yet.
 *
 * That second half is the whole reason this component is not three lines. A
 * step can name a target on another tab, so the host switches tab and then has
 * to wait: React has not rendered the new page in the same tick, and pointing a
 * cutout at nothing draws a hole in the middle of the screen. So the element is
 * polled for, briefly, and the step only opens once it is really there.
 */

/**
 * How long to wait for a step's target before giving up and skipping the step.
 *
 * Two speeds, because there are two reasons a target can be missing and only
 * one of them is worth waiting out. If the step asked for a different tab, the
 * page genuinely has not rendered yet and a moment's patience is the whole
 * point. If it did not, the element either exists now or does not exist at all
 * - the player bar with nothing playing, a tab this build does not have - and
 * waiting a second and a bit just puts a blank hole in the middle of the tour.
 * Measured on a skip of the player step: 1200ms of nothing between step four
 * and step six, which reads as the tour having crashed.
 */
const FIND_TIMEOUT_AFTER_NAV_MS = 1200;
const FIND_TIMEOUT_SAME_PAGE_MS = 350;
const FIND_INTERVAL_MS = 60;

/**
 * The first-launch offer.
 *
 * Gated on the first step's target EXISTING rather than on a session or a
 * gate flag, and that is deliberate rather than lazy. "After logging in" is
 * really "once the app proper is on screen", and the sign-in gate renders
 * instead of the whole main tree - so the presence of the library shelf is a
 * more honest test of that than any boolean this component could be handed,
 * and it does not couple the tour to how signing in happens to work today.
 *
 * It gives up after a while. Somebody who lands on the sign-in screen and
 * leaves should not have a tour ambush them twenty minutes later when they
 * come back and log in - they get it on the next launch instead.
 */
const FIRST_LAUNCH_WAIT_MS = 30_000;

function useFirstLaunchTour(): void {
  useEffect(() => {
    if (tourSeen()) return;
    let stop = false;
    const started = Date.now();
    const look = () => {
      if (stop) return;
      if (document.querySelector('.libChips')) {
        startTour();
        return;
      }
      if (Date.now() - started > FIRST_LAUNCH_WAIT_MS) return;
      window.setTimeout(look, 250);
    };
    // One beat, so the shelf has a chance to paint before we decide it is
    // missing - and so a returning user never sees a flash of tour on boot.
    const first = window.setTimeout(look, 600);
    return () => {
      stop = true;
      window.clearTimeout(first);
    };
  }, []);
}

export function TourHost() {
  useFirstLaunchTour();
  const index = useTourStep();
  const step = index >= 0 ? TOUR_STEPS[index] : undefined;
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!step) {
      setTarget(null);
      return;
    }
    // Re-look on every step, and keep looking for a moment: the tab switch
    // that this step asked for has only just been dispatched.
    setTarget(null);
    let stop = false;
    const started = Date.now();
    const look = () => {
      if (stop) return;
      const found = document.querySelector<HTMLElement>(step.target);
      if (found) {
        // Bring it into view before the cutout is drawn around it, or the
        // spotlight opens on a target below the fold.
        found.scrollIntoView({ block: 'center', behavior: 'auto' });
        setTarget(found);
        return;
      }
      const budget = step.tab ? FIND_TIMEOUT_AFTER_NAV_MS : FIND_TIMEOUT_SAME_PAGE_MS;
      if (Date.now() - started > budget) {
        // The step points at something this build does not have - a tab hidden
        // behind a server, a plugin that is not installed. Skip it rather than
        // stall the tour on a hole in the screen.
        nextTourStep();
        return;
      }
      window.setTimeout(look, FIND_INTERVAL_MS);
    };
    look();
    return () => {
      stop = true;
    };
  }, [step]);

  if (!step || !target) return null;

  return (
    <Spotlight
      open
      targetRef={{ current: target }}
      title={step.title}
      description={step.body}
      placement={step.placement}
      step={index + 1}
      total={TOUR_STEPS.length}
      onNext={nextTourStep}
      onBack={index > 0 ? backTourStep : undefined}
      onClose={endTour}
    />
  );
}
