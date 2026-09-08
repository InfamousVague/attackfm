import { translate } from '../i18n/LocaleShell.tsx';
import type { Translate } from './settingsShared.ts';

/**
 * The rail rows' second lines - a pane's current state in one phrase.
 *
 * These are read by the settings hub during ITS render, not by the panes they
 * describe, which is why they are plain functions rather than anything a pane
 * exports about itself. Gathered here so that reading a row's line does not
 * mean importing the whole pane it belongs to: `SettingsModal` builds every
 * row on open, and a summary that dragged its pane in behind it would pull
 * the Local-AI pane's thousand lines into the first paint of Settings.
 *
 * A summary that cannot fail is deliberately a summary that says nothing
 * interesting: two of these are a single catalogue key, because "what is in
 * this pane" is the honest line for a pane whose rows have no single state.
 * `privacySummary` is the one with an actual reading to make, and it is the
 * one that can be wrong.
 */

/** Developer: read at render by the rail rather than inside a component of
 *  ours, so it uses the non-reactive `translate()`; the rail re-renders on a
 *  language change and calls it again. */
export function developerSummary(): string {
  return translate('settings.devSummary');
}

/** Local AI. */
export function localAiSummary(t: Translate): string {
  return t('settings.summaryLocalAi');
}

/**
 * Privacy: how much is switched OFF.
 *
 * Counting the off ones rather than the on ones is the whole point - the line
 * exists to tell somebody at a glance that they have closed something, and
 * "all shared" is the state that needs saying out loud. Takes the translator
 * rather than reaching for `translate()`: it is read during the settings hub's
 * render, so it has to follow a language change.
 */
export function privacySummary(
  online: boolean,
  history: boolean,
  position: boolean,
  week: boolean,
  t: Translate,
): string {
  const switches = [online, history, position, week];
  const off = switches.filter((x) => !x).length;
  if (off === 0) return t('privacy.summaryAllShared');
  if (off === switches.length) return t('privacy.summaryNothingLeaves');
  // Both numbers are holes: "2 of 4" is not a fixed phrase, and the count
  // still selects a plural form in the languages that have one.
  return t('privacy.summarySomeOff', { count: off, total: switches.length });
}
