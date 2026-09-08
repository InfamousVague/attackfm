/**
 * The pane that says whether the tests passed - and, far more importantly,
 * whether it is entitled to say so.
 *
 * A test report is a FILE. It outlives the code it describes, it can be
 * committed, copied, restored from a stash or left behind by a run that died
 * halfway; and every one of those leaves a perfectly well-formed document full
 * of green ticks that has nothing to do with the app somebody is holding. The
 * failure this file exists to prevent is not a wrong number on screen. It is a
 * reassuring screen: a tick over somebody else's commit, or over a run in
 * which a whole suite never started, read by a person who then ships.
 *
 * So the cases below are not about rendering. Each one is about the pane
 * REFUSING to be reassuring when it has no right to be:
 *
 *   - a report from another commit is called out, in the pane's own words;
 *   - a failure is on screen before anybody touches anything;
 *   - a suite that errored is not silently absorbed into "all passed";
 *   - and the filter narrows the list rather than emptying it.
 *
 * Assertions are on catalogue KEYS, not English - `useT` is stubbed to the
 * identity - so the copy can be rewritten and translated without a failure
 * here. What is pinned is which sentence the pane chose.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { TestCase, TestReport, TestSuite } from '../diag/testReport.ts';

/* One stable `t`, not a fresh arrow per render: the pane memoises on its
   inputs, and an unstable translator would quietly invalidate that. */
const translate = (key: string) => key;
vi.mock('../i18n/LocaleShell.tsx', () => ({ useT: () => translate }));

const { TestResultsPane } = await import('./TestResultsPane.tsx');
const { testResultsSummary } = await import('./paneSummaries.ts');

// --- fixtures ---------------------------------------------------------------

function aCase(over: Partial<TestCase> = {}): TestCase {
  return {
    file: 'src/app/ux/format.test.ts',
    line: 24,
    name: 'formatClock pads the seconds',
    status: 'passed',
    ms: 3.1,
    failure: null,
    ...over,
  };
}

/** Counts are DERIVED from the cases unless a case overrides them, so a
 *  fixture cannot accidentally assert a total it does not contain. */
function aSuite(over: Partial<TestSuite> = {}): TestSuite {
  const tests = over.tests ?? [aCase()];
  const counts = {
    total: tests.length,
    passed: tests.filter((c) => c.status === 'passed').length,
    failed: tests.filter((c) => c.status === 'failed').length,
    skipped: tests.filter((c) => c.status === 'skipped').length,
    todo: tests.filter((c) => c.status === 'todo').length,
  };
  return {
    id: 'vitest',
    title: 'Unit',
    runner: 'vitest',
    runnerVersion: '5.0.0',
    command: 'npx vitest run',
    status: counts.failed > 0 ? 'failed' : 'passed',
    reason: null,
    exitCode: 0,
    durationMs: 6042,
    counts,
    tests,
    ...over,
  };
}

function aReport(over: Partial<TestReport> = {}): TestReport {
  const suites = over.suites ?? [aSuite()];
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-08T04:12:00.000Z',
    version: '0.6.0',
    commit: 'c4d275cb',
    dirty: false,
    host: { os: 'darwin', arch: 'arm64', node: 'v25.9.0' },
    tools: { vitest: '5.0.0' },
    ok: suites.every((s) => s.status === 'passed'),
    namesSanitised: 0,
    totals: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, notRun: 0 },
    suites,
    ...over,
  };
}

// --- is this report even about this build? ----------------------------------

describe('the report belonging to another build', () => {
  it('says so, in red, when the report was made from a different commit', () => {
    render(<TestResultsPane report={aReport({ commit: 'aaaaaaa' })} buildCommit="bbbbbbb" />);
    expect(screen.getByText(/settings\.testsWrongBuild/)).toBeInTheDocument();
  });

  /*
   * THE HALF THAT MAKES THE FIRST ONE MEAN SOMETHING. A banner that is always
   * drawn satisfies the case above perfectly and is worth nothing: the whole
   * point is that it appears when the commits differ and NOT when they agree,
   * because a pane that cries wolf on every ordinary build is one people stop
   * reading - which is how the real mismatch gets through.
   */
  it('stays quiet when the report is about the build running it', () => {
    render(<TestResultsPane report={aReport({ commit: 'c4d275cb' })} buildCommit="c4d275cb" />);
    expect(screen.queryByText(/settings\.testsWrongBuild/)).not.toBeInTheDocument();
    expect(screen.getByText(/settings\.testsAllPassed/)).toBeInTheDocument();
  });

  it('matches a short commit against a long one rather than calling it a mismatch', () => {
    // The generator writes a short HEAD; a build could be stamped with the
    // full forty. Comparing those as strings makes every build look wrong.
    render(
      <TestResultsPane
        report={aReport({ commit: 'c4d275cb' })}
        buildCommit="c4d275cb041bdb95c5b0ba06de04e2e6a75473fe"
      />,
    );
    expect(screen.queryByText(/settings\.testsWrongBuild/)).not.toBeInTheDocument();
  });

  it('does not claim a mismatch when the build carries no commit stamp at all', () => {
    // A dev server has no stamp. "Cannot tell" is a different sentence from
    // "this is the wrong build", and printing the second one here would be a
    // lie told on every single `npm run dev`.
    render(<TestResultsPane report={aReport()} buildCommit={null} />);
    expect(screen.queryByText(/settings\.testsWrongBuild/)).not.toBeInTheDocument();
    expect(screen.getByText(/settings\.testsNoStamp/)).toBeInTheDocument();
  });

  it('says the tree was dirty, because then the commit is not the whole story', () => {
    render(<TestResultsPane report={aReport({ dirty: true })} buildCommit="c4d275cb" />);
    expect(screen.getByText(/settings\.testsDirty/)).toBeInTheDocument();
  });
});

// --- the failure is the reason anybody opened this --------------------------

describe('a failing test', () => {
  const failing = aReport({
    commit: 'c4d275cb',
    suites: [
      aSuite({
        id: 'vitest',
        tests: [
          aCase({ name: 'a case that is fine' }),
          aCase({
            file: 'src/app/player/queue.test.ts',
            name: 'advance drains the up-next lane first',
            status: 'failed',
            failure: 'expected 2 to be 1',
          }),
        ],
      }),
    ],
  });

  it('is on screen without anybody opening anything', () => {
    render(<TestResultsPane report={failing} buildCommit="c4d275cb" />);
    expect(screen.getByText('advance drains the up-next lane first')).toBeInTheDocument();
  });

  it('brings its failure message with it', () => {
    render(<TestResultsPane report={failing} buildCommit="c4d275cb" />);
    expect(screen.getByText('expected 2 to be 1')).toBeInTheDocument();
  });

  /*
   * The other side of the same rule, and the reason the groups exist at all:
   * a passing file stays shut. Open everything and this is 1,700 rows nobody
   * reads; open nothing and the failure is three taps away from the person
   * who came here because something broke.
   */
  it('does not drag the passing cases open with it', () => {
    render(<TestResultsPane report={failing} buildCommit="c4d275cb" />);
    expect(screen.queryByText('a case that is fine')).not.toBeInTheDocument();
  });

  it('is reachable in a report where nothing failed only by opening the group', () => {
    render(<TestResultsPane report={aReport({ commit: 'c4d275cb' })} buildCommit="c4d275cb" />);
    expect(screen.queryByText('formatClock pads the seconds')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /settings\.testsSuiteUnit/ }));
    fireEvent.click(screen.getByRole('button', { name: /format\.test\.ts/ }));
    expect(screen.getByText('formatClock pads the seconds')).toBeInTheDocument();
  });
});

// --- a suite that never produced a result -----------------------------------

describe('a suite that errored', () => {
  const withError = aReport({
    commit: 'c4d275cb',
    // The report's OWN verdict says everything is fine. It is wrong, and the
    // pane is not allowed to take its word for it.
    ok: true,
    suites: [
      aSuite({ id: 'vitest', tests: [aCase()] }),
      aSuite({
        id: 'playwright:fast',
        title: 'Browser',
        status: 'error',
        reason: 'browserType.launch: Executable does not exist',
        exitCode: 1,
        tests: [],
        counts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
      }),
    ],
  });

  it('is not counted as a pass', () => {
    render(<TestResultsPane report={withError} buildCommit="c4d275cb" />);
    // Every test in the report passed and nothing failed - so a verdict built
    // out of failures alone reads "all passed" here, which is exactly the
    // green tick over an incomplete run this pane exists to prevent.
    expect(screen.queryByText(/settings\.testsAllPassed/)).not.toBeInTheDocument();
    expect(screen.getByText(/settings\.testsNoVerdict/)).toBeInTheDocument();
  });

  it('is called out in red, with the count of suites that produced nothing', () => {
    render(<TestResultsPane report={withError} buildCommit="c4d275cb" />);
    expect(screen.getByText(/settings\.testsSuitesMissing/)).toBeInTheDocument();
    expect(screen.getByText(/settings\.testsMissingWhy/)).toBeInTheDocument();
  });

  it('shows why there is no result, open or closed', () => {
    // The reason is the entire content of such a suite - there are no test
    // rows underneath it to disclose. Tied to the chevron it becomes the one
    // thing on the page that nobody would ever find, so it is outside the
    // disclosure entirely: still there after the group is collapsed.
    render(<TestResultsPane report={withError} buildCommit="c4d275cb" />);
    const shown = () => screen.queryByText(/browserType\.launch: Executable does not exist/);
    expect(shown()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /settings\.testsSuiteBrowserFast/ }));
    expect(shown()).toBeInTheDocument();
  });
});

// --- the filter -------------------------------------------------------------

describe('the filter', () => {
  const many = aReport({
    commit: 'c4d275cb',
    suites: [
      aSuite({
        id: 'vitest',
        tests: [
          aCase({ name: 'formatClock pads the seconds' }),
          aCase({ file: 'src/app/player/queue.test.ts', name: 'the queue advances' }),
        ],
      }),
    ],
  });

  it('narrows the list to the tests whose names match', () => {
    render(<TestResultsPane report={many} buildCommit="c4d275cb" />);
    fireEvent.change(screen.getByLabelText('settings.testsFilter'), {
      target: { value: 'queue advances' },
    });
    expect(screen.getByText('the queue advances')).toBeInTheDocument();
    expect(screen.queryByText('formatClock pads the seconds')).not.toBeInTheDocument();
  });

  it('opens what survived it rather than hiding it behind a closed group', () => {
    // Both groups are shut in this report - nothing failed. A filter that
    // narrowed the data without opening the groups would look like a filter
    // that found nothing at all.
    render(<TestResultsPane report={many} buildCommit="c4d275cb" />);
    expect(screen.queryByText('the queue advances')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('settings.testsFilter'), {
      target: { value: 'queue' },
    });
    expect(screen.getByText('the queue advances')).toBeInTheDocument();
  });

  it('matches the file a test lives in, not only its name', () => {
    render(<TestResultsPane report={many} buildCommit="c4d275cb" />);
    fireEvent.change(screen.getByLabelText('settings.testsFilter'), {
      target: { value: 'player' },
    });
    expect(screen.getByText('the queue advances')).toBeInTheDocument();
    expect(screen.queryByText('formatClock pads the seconds')).not.toBeInTheDocument();
  });

  it('treats a field of spaces as no filter at all', () => {
    // `query.trim()` decides whether a filter is running, and the filter is
    // what forces the groups open. Drop the trim and two accidental spaces
    // leave the whole report hanging open with nothing narrowed - a page in
    // its filtered state, filtered by nothing.
    render(<TestResultsPane report={many} buildCommit="c4d275cb" />);
    const field = screen.getByLabelText('settings.testsFilter');
    fireEvent.change(field, { target: { value: 'queue' } });
    fireEvent.change(field, { target: { value: '  ' } });
    expect(screen.queryByText('the queue advances')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.testsNoMatches')).not.toBeInTheDocument();
  });

  it('shows only failures when asked, and nothing else', () => {
    const mixed = aReport({
      commit: 'c4d275cb',
      suites: [
        aSuite({
          id: 'vitest',
          tests: [
            aCase({ name: 'a case that is fine' }),
            aCase({ name: 'a case that is not', status: 'failed', failure: 'nope' }),
          ],
        }),
      ],
    });
    render(<TestResultsPane report={mixed} buildCommit="c4d275cb" />);
    fireEvent.click(screen.getByLabelText('settings.testsOnlyFailures'));
    expect(screen.getByText('a case that is not')).toBeInTheDocument();
    expect(screen.queryByText('a case that is fine')).not.toBeInTheDocument();
  });
});

// --- the line under the row, read without opening anything ------------------

describe("the rail's one-line reading", () => {
  /*
   * This is the surface a report gets glanced at from, and the one where a
   * false reassurance costs most: somebody opens Settings, sees "1,339 tests
   * passed" under the row, and never opens the pane that would have told them
   * the run belonged to a different commit. So the order of the checks is the
   * behaviour, not an implementation detail.
   */
  it('reports the wrong build before it reports anything green', () => {
    const green = aReport({ commit: 'aaaaaaa' });
    expect(testResultsSummary(translate, green, 'bbbbbbb')).toBe(
      'settings.testsSummaryOtherBuild',
    );
    // ...and the same report, under its own build, is allowed to be green.
    expect(testResultsSummary(translate, green, 'aaaaaaa')).toContain(
      'settings.testsAllPassed',
    );
  });

  it('reports a suite that never ran before it reports a count of passes', () => {
    const incomplete = aReport({
      commit: 'aaaaaaa',
      suites: [aSuite({ id: 'vitest' }), aSuite({ id: 'playwright:fast', status: 'error', tests: [] })],
    });
    expect(testResultsSummary(translate, incomplete, 'aaaaaaa')).toBe(
      'settings.testsSuitesMissing',
    );
  });

  it('reports failures rather than the passes that outnumber them', () => {
    const mixed = aReport({
      commit: 'aaaaaaa',
      suites: [
        aSuite({
          id: 'vitest',
          tests: [aCase(), aCase({ name: 'broken', status: 'failed', failure: 'no' })],
        }),
      ],
    });
    expect(testResultsSummary(translate, mixed, 'aaaaaaa')).toBe('settings.testsSomeFailed');
  });
});
