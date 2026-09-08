//! The test report, as a type and as a verdict.
//!
//! `scripts/` runs the suites and writes `testReport.generated.json` beside
//! this file; nothing here runs a test. This module is the DOOR: the shape of
//! that file, an import of it, and the two questions the pane must not get
//! wrong - is this report about the build I am holding, and did everything
//! actually pass.
//!
//! WHY THE VERDICT IS COMPUTED HERE AND NOT READ OFF `ok`.
//!
//! The generated file carries its own `ok`, and the pane deliberately does not
//! trust it. `ok` is one boolean written by the wrapper at the end of a run
//! that may itself have died: a suite that never started, a runner that
//! crashed before it could report, a report half-written by a killed process.
//! Every one of those is a state in which "all green" is the most dangerous
//! sentence the pane could say, so the verdict is re-derived from the suites
//! each time, and a suite that did not RUN counts against it exactly as hard
//! as a suite that failed. `ok` is still shown - as a fact the generator
//! asserted, next to the one this file worked out - because the two
//! disagreeing is itself worth seeing.

import generated from './testReport.generated.json';

/** passed | failed | error | notRun - four, not two. `error` is the runner
 *  falling over; `notRun` is a suite that was never reached at all. */
export type SuiteStatus = 'passed' | 'failed' | 'error' | 'notRun';

/** A single case's outcome. `skipped` and `todo` are not failures and are not
 *  passes either - they are cases nobody has an answer for. */
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'todo';

export interface TestCase {
  /** Repo-relative, always. */
  file: string;
  /** Null when the runner cannot say - cargo does not, for one. */
  line: number | null;
  name: string;
  status: TestStatus;
  /** Null for skipped and todo: they took no time because they did not run. */
  ms: number | null;
  /** First failure message, ANSI-stripped, <= 2KB. */
  failure: string | null;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}

export interface TestSuite {
  /** vitest | playwright:fast | playwright:slow | cargo:<target> */
  id: string;
  /** An English label. The pane translates by ID, never by this. */
  title: string;
  runner: string;
  runnerVersion: string;
  /** The exact command, so a failure can be reproduced by copying a line. */
  command: string;
  status: SuiteStatus;
  /** Why it errored or never ran, ANSI-stripped. */
  reason: string | null;
  exitCode: number | null;
  /** The wrapper's own clock, not the runner's self-report. */
  durationMs: number;
  counts: TestCounts;
  tests: TestCase[];
}

export interface TestReport {
  schemaVersion: number;
  /** ISO, when the run finished. */
  generatedAt: string;
  /** package.json at generation time. */
  version: string;
  /** Short HEAD. */
  commit: string;
  /** Was the tree dirty when it ran - i.e. is `commit` even the whole truth. */
  dirty: boolean;
  host: { os: string; arch: string; node: string };
  tools: Record<string, string>;
  /** The generator's own verdict. Shown, never trusted - see the header. */
  ok: boolean;
  /** How many test names the generator had to rewrite before printing them. */
  namesSanitised: number;
  totals: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    todo: number;
    notRun: number;
  };
  suites: TestSuite[];
}

/**
 * The report this build shipped with.
 *
 * A static import, so it is a compile-time constant and the pane cannot be
 * looking at a file from a different run than the code around it. The cast is
 * the seam between JSON (which TypeScript widens every string to `string`) and
 * the union types above; the generator owns the file and the schema is fixed,
 * so the alternative - a parser that validates 1,700 rows on the way in - buys
 * nothing a wrong report would not already have shown on screen.
 */
export const testReport = generated as unknown as TestReport;

/**
 * The commit Vite stamped into THIS build.
 *
 * Declared the way `__AFM_VERSION__` is in `core/version.ts`, and read through
 * `typeof` for the same reason: the constant only exists once the build's
 * `define` supplies it, and a bare mention of an undefined one is a
 * ReferenceError that takes the whole pane down rather than degrading. Vitest
 * merges the app's `define`, so a test sees whatever the app build would.
 */
declare const __AFM_COMMIT__: string;

/** The build's own commit, or null when this build carries no stamp - a dev
 *  server, a browser tab, a bundle built before the stamp existed. */
export function buildCommit(): string | null {
  try {
    return typeof __AFM_COMMIT__ === 'string' && __AFM_COMMIT__ ? __AFM_COMMIT__ : null;
  } catch {
    return null;
  }
}

/**
 * Three answers, not two.
 *
 * `mismatch` is the dangerous one and gets the red banner. `unknown` is an
 * unstamped build, where the honest thing to say is that the match cannot be
 * checked - claiming a mismatch there would cry wolf on every `npm run dev`
 * until people stopped reading the banner, which is how the real mismatch gets
 * through.
 */
export type BuildMatch = 'match' | 'mismatch' | 'unknown';

/**
 * Both commits are ARGUMENTS, with the build's defaulted at the call.
 *
 * The build's stamp is a compile-time constant, which is exactly the kind of
 * thing that cannot be varied from a test - and "does the pane shout when the
 * report belongs to somebody else's commit" is the single most important
 * behaviour in this feature. A default parameter keeps every caller writing
 * `buildMatch(report)` while leaving the comparison itself something a suite
 * can drive both ways.
 */
export function buildMatch(
  report: TestReport = testReport,
  mine: string | null = buildCommit(),
): BuildMatch {
  if (!mine || !report.commit) return 'unknown';
  // Compared on the shorter of the two, so a full 40-character SHA from one
  // side and an eight-character short one from the other still line up.
  const n = Math.min(mine.length, report.commit.length);
  return mine.slice(0, n) === report.commit.slice(0, n) ? 'match' : 'mismatch';
}

/** Is this report about the build running it? False for a mismatch AND for a
 *  build that cannot say - "not known to be mine" is the safe reading. */
export function reportIsForThisBuild(
  report: TestReport = testReport,
  mine: string | null = buildCommit(),
): boolean {
  return buildMatch(report, mine) === 'match';
}

/** A suite that produced no verdict at all: the runner fell over, or nothing
 *  ever invoked it. Neither is a pass, and neither is a normal failure - the
 *  tests in it have no result, rather than a bad one. */
export function suiteDidNotRun(suite: TestSuite): boolean {
  return suite.status === 'error' || suite.status === 'notRun';
}

export interface ReportTally {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  /** Suites that reported something, pass or fail. */
  suitesRun: number;
  /** Suites that errored or were never reached. */
  suitesMissing: number;
  /**
   * Everything passed AND everything ran. A report with no suites in it at
   * all is not ok either: an empty run is the shape a generator crash leaves
   * behind, and it would otherwise satisfy "no failures" perfectly.
   */
  ok: boolean;
}

/** The verdict, summed from the suites themselves. */
export function tallyReport(report: TestReport = testReport): ReportTally {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  let suitesRun = 0;
  let suitesMissing = 0;
  for (const suite of report.suites) {
    if (suiteDidNotRun(suite)) suitesMissing += 1;
    else suitesRun += 1;
    passed += suite.counts.passed;
    failed += suite.counts.failed;
    skipped += suite.counts.skipped;
    todo += suite.counts.todo;
  }
  return {
    passed,
    failed,
    skipped,
    todo,
    suitesRun,
    suitesMissing,
    ok: failed === 0 && suitesMissing === 0 && suitesRun > 0,
  };
}

/** Every failing case in the report, suite order preserved. */
export function failingTests(report: TestReport = testReport): TestCase[] {
  return report.suites.flatMap((s) => s.tests.filter((c) => c.status === 'failed'));
}
