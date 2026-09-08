import { translate } from '../i18n/translate.ts';
import { buildCommit, buildMatch, tallyReport, testReport, type TestReport } from '../diag/testReport.ts';
import { formatNumber } from '../ux/format.ts';
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

/** The curator. Its own pane since the Booth was taken out - the room that
 *  used to open it is gone, and the collector's off switch cannot live behind
 *  a door that no longer exists. */
export function curatorSummary(): string {
  return translate('settings.curatorSummary');
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

/**
 * Test results: the shortest true sentence about the report on this device.
 *
 * The order of the checks is the whole design. A report belonging to ANOTHER
 * COMMIT is reported first even when every test in it passed, because "1,789
 * passed" under a row somebody glances at is exactly the false comfort this
 * pane exists to prevent - and the rail row is the surface most likely to be
 * read without opening anything. A suite that never ran comes next, for the
 * same reason: no result is not a pass, and it is invisible in a count of
 * passes.
 *
 * Takes the report rather than reaching for the module's own, so a test can
 * hand it one; the caller passes nothing and gets the build's.
 */
export function testResultsSummary(
  t: Translate,
  report: TestReport = testReport,
  mine: string | null = buildCommit(),
): string {
  if (buildMatch(report, mine) === 'mismatch') return t('settings.testsSummaryOtherBuild');
  const tally = tallyReport(report);
  if (tally.suitesMissing > 0) {
    return t('settings.testsSuitesMissing', {
      count: tally.suitesMissing,
      n: formatNumber(tally.suitesMissing),
    });
  }
  // The same three entries the pane's own verdict line uses. Sharing them is
  // deliberate: the row and the headline are two places one sentence is read,
  // and a copy edit that moved only one of them would leave the rail claiming
  // something the pane no longer says.
  if (tally.failed > 0) {
    return t('settings.testsSomeFailed', {
      count: tally.failed,
      n: formatNumber(tally.failed),
    });
  }
  return t('settings.testsAllPassed', {
    count: tally.passed,
    n: formatNumber(tally.passed),
  });
}
