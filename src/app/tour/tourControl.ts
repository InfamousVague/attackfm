import { useSyncExternalStore } from 'react';
import { TOUR_STEPS } from './tourSteps.ts';

/**
 * Who is running the tour, and what it is allowed to drive.
 *
 * A module singleton, for the same reason `headerActions` and `openMix` are
 * ones: the tour is started from inside the settings modal, walks across tabs
 * that live in App's state, and is drawn by a component mounted beside all of
 * it. There is exactly one tour for the app's whole life, and the alternative
 * is a context provider wrapping most of App to carry a boolean.
 *
 * The host is registered by App, which owns the two things a tour needs and
 * nothing else can reach: which tab is showing, and whether settings is open.
 */
export interface TourHost {
  goTab: (tab: string) => void;
  closeSettings: () => void;
}

let host: TourHost | null = null;

/** App registers the real one at mount. */
export function setTourHost(next: TourHost | null): void {
  host = next;
}

/** -1 when the tour is not running; otherwise the current step. */
let index = -1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function enter(next: number): void {
  index = next;
  const step = TOUR_STEPS[next];
  if (step?.tab) host?.goTab(step.tab);
  emit();
}

/**
 * Whether this device has been shown the tour.
 *
 * Marked on the way IN rather than on completion. Somebody who opens the app,
 * sees the first step and dismisses it has been offered the tour; showing it
 * again on the next launch would be the app not listening.
 */
const SEEN_KEY = 'attackfm-tour-seen';

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // No storage: treat it as seen, so a locked-down browser is never nagged
    // on every single launch.
    return true;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* it will offer once more next launch; better than throwing at boot */
  }
}

/** Begin, from settings or from a first launch. */
export function startTour(): void {
  markSeen();
  // Settings is a modal over everything; a spotlight under it would highlight
  // a page nobody can see.
  host?.closeSettings();
  enter(0);
}

export function nextTourStep(): void {
  if (index < 0) return;
  if (index + 1 >= TOUR_STEPS.length) endTour();
  else enter(index + 1);
}

export function backTourStep(): void {
  if (index > 0) enter(index - 1);
}

export function endTour(): void {
  index = -1;
  markSeen();
  emit();
}

export function tourStepIndex(): number {
  return index;
}

export function useTourStep(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    tourStepIndex,
    tourStepIndex,
  );
}
