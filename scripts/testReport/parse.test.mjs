/**
 * The parsers, against output three real runners actually produced.
 *
 * EVERY FIXTURE IN `fixtures/` WAS CAPTURED, NOT WRITTEN. A throwaway suite
 * with one passing, one failing, one skipped and one todo test was run under
 * each runner and the reporter's own output kept; the only edits are the ones
 * named here, and none of them touch the SHAPE:
 *
 *   - the machine's absolute paths were re-rooted to `/repo` (and this repo's
 *     shared node_modules to `/repo/node_modules`), so a fixture does not
 *     hard-code one developer's home directory;
 *   - vitest's `snapshot` block, and Playwright's attachments, steps and
 *     captured stdio, were dropped - they are large and nothing here reads
 *     them;
 *   - the vitest failure's stack was cut to its first three frames.
 *
 * That matters because the whole risk in this code is believing a shape that
 * the runner does not emit. Hand-written fixtures would test the parser
 * against the author's memory of a JSON reporter, which is exactly the thing
 * that goes stale.
 *
 * Ship-guard note: no test in THIS file is named with the sequence the ship
 * guard hunts for. The sequence is exercised as string DATA below, because a
 * test name in this repo becomes a string inside the OTA bundle - see the
 * header of parse.mjs - and the measured count of names carrying it is meant
 * to stay zero.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  clamp,
  emptyCounts,
  fromCargo,
  fromPlaywright,
  fromVitest,
  notRunSuite,
  sanitiseName,
  sanitiseSuites,
  stripAnsi,
} from './parse.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const json = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const text = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/* The escape character, built rather than typed: a literal one in a source
   file is invisible in every diff and every review. */
const ESC = String.fromCharCode(27);

/** The exact byte sequence `scripts/ship-update.mjs` refuses to publish. */
const GUARDED = `from ${String.fromCharCode(39)}./`;

describe('stripAnsi and clamp', () => {
  it('takes the colour off a message a terminal dressed up', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[39m plain`)).toBe('red plain');
  });

  it('returns null for a message that was only whitespace', () => {
    expect(clamp('   \n  ')).toBeNull();
    expect(clamp(undefined)).toBeNull();
  });

  it('cuts a runaway message to the budget and marks the cut', () => {
    const out = clamp('x'.repeat(5000), 100);
    expect(out).toHaveLength(100);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('the ship guard sequence in a test name', () => {
  it('swaps the apostrophe for its typographic twin, and nothing else', () => {
    const name = `re-exports ${GUARDED}neighbour' when asked`;
    const safe = sanitiseName(name);

    // The guard's own regexes, copied from scripts/ship-update.mjs.
    expect(/from\s*["']\.\//.test(name)).toBe(true);
    expect(/from\s*["']\.\//.test(safe)).toBe(false);
    expect(/import\(\s*["']\.\//.test(safe)).toBe(false);

    // Only the one character moved.
    expect(safe).toBe(`re-exports from ’./neighbour' when asked`);
    expect(safe).toHaveLength(name.length);
  });

  it('covers the double-quoted half of the guard, and the import( form', () => {
    const dq = String.fromCharCode(34);
    expect(sanitiseName(`from ${dq}./x${dq}`)).toBe(`from ”./x${dq}`);
    expect(sanitiseName('import( "./y" )')).toBe('import( ”./y" )');
    expect(sanitiseName(`import(${String.fromCharCode(39)}./y')`)).toBe("import(’./y')");
  });

  it('leaves an innocent name exactly as it was', () => {
    for (const name of [
      'formatClock pads the seconds',
      'imports from the neighbour module',
      'a path like ./relative on its own is fine',
      'from "../up-one" is not what the guard matches',
    ]) {
      expect(sanitiseName(name)).toBe(name);
    }
  });

  it('counts, across every suite, the names it had to touch', () => {
    const suite = fromVitest(json('vitest-mixed.json'), { root: '/repo' });
    const before = suite.tests.filter((t) => /from\s*["']\.\//.test(t.name));
    expect(before).toHaveLength(1);

    const { suites, sanitised } = sanitiseSuites([suite, suite]);
    expect(sanitised).toBe(2);
    for (const s of suites) {
      expect(s.tests.some((t) => /from\s*["']\.\//.test(t.name))).toBe(false);
    }
  });

  it('reports zero when there was nothing to do', () => {
    const clean = { tests: [{ name: 'formatClock pads the seconds' }] };
    expect(sanitiseSuites([clean]).sanitised).toBe(0);
  });
});

describe('fromVitest', () => {
  const suite = fromVitest(json('vitest-mixed.json'), {
    root: '/repo',
    command: 'npx vitest run',
    runnerVersion: '5.0.0',
    exitCode: 1,
    durationMs: 2910,
  });
  const named = (fragment) => suite.tests.find((t) => t.name.includes(fragment));

  it('carries through the measurements the wrapper made, untouched', () => {
    expect(suite.id).toBe('vitest');
    expect(suite.runner).toBe('vitest');
    expect(suite.runnerVersion).toBe('5.0.0');
    expect(suite.command).toBe('npx vitest run');
    expect(suite.exitCode).toBe(1);
    expect(suite.durationMs).toBe(2910);
  });

  it('reads a passing test, with its file repo-relative and its line', () => {
    const t = named('passes');
    expect(t.status).toBe('passed');
    expect(t.file).toBe('src/__fixgen/mixed.test.ts');
    expect(t.line).toBe(4);
    expect(t.name).toBe('a group passes');
    expect(t.ms).toBeGreaterThan(0);
    expect(t.failure).toBeNull();
  });

  it('reads a failure and keeps the first line of its message', () => {
    const t = named('fails with a message');
    expect(t.status).toBe('failed');
    expect(t.failure.split('\n')[0]).toBe(
      'AssertionError: expected 2 to be 3 // Object.is equality',
    );
    expect(suite.status).toBe('failed');
  });

  it('reads a skip and a todo, and gives neither a duration', () => {
    // `duration` is ABSENT from the reporter's JSON for both, which is a
    // different thing from zero and has to stay a different thing here.
    expect(named('is skipped').status).toBe('skipped');
    expect(named('is skipped').ms).toBeNull();
    expect(named('is a todo').status).toBe('todo');
    expect(named('is a todo').ms).toBeNull();
  });

  it('counts the rows it built, not the numbers the runner printed', () => {
    expect(suite.counts).toEqual({ total: 5, passed: 2, failed: 1, skipped: 1, todo: 1 });
    expect(suite.counts.total).toBe(suite.tests.length);
  });

  it('calls a run that reported success with no tests an ERROR', () => {
    // The green tick that lies: captured from a real
    // `vitest run --passWithNoTests` whose filter matched nothing. Exit code
    // 0, `success: true`, and not one test executed.
    const empty = json('vitest-empty.json');
    expect(empty.success).toBe(true);
    expect(empty.numTotalTests).toBe(0);

    const s = fromVitest(empty, { root: '/repo', exitCode: 0 });
    expect(s.status).toBe('error');
    expect(s.counts).toEqual(emptyCounts());
    expect(s.reason).toMatch(/no test files at all/);
  });

  it('calls a file that would not load an ERROR, and says which file', () => {
    // A bad import arrives as a file entry with a message and an EMPTY
    // assertionResults array: nothing failed because nothing ran.
    const s = fromVitest(json('vitest-load-error.json'), { root: '/repo' });
    expect(s.status).toBe('error');
    expect(s.reason).toMatch(/^src\/__fixgen\/broken\.test\.ts did not load: /);
    expect(s.reason).toMatch(/Failed to resolve import/);
  });

  it('fails a status it does not recognise rather than filing it as a skip', () => {
    const doctored = structuredClone(json('vitest-mixed.json'));
    doctored.testResults[0].assertionResults[0].status = 'invented';
    const s = fromVitest(doctored, { root: '/repo' });
    const t = s.tests.find((x) => x.failure?.startsWith('unrecognised runner status'));
    expect(t.status).toBe('failed');
    expect(t.failure).toBe('unrecognised runner status: "invented"');
  });

  it('errors when its own count disagrees with the number vitest printed', () => {
    const doctored = structuredClone(json('vitest-mixed.json'));
    doctored.numTotalTests = 99;
    const s = fromVitest(doctored, { root: '/repo' });
    expect(s.status).toBe('error');
    expect(s.reason).toMatch(/reported 99 test\(s\) and this parser built 5 row\(s\)/);
  });
});

describe('fromPlaywright', () => {
  const suite = fromPlaywright(json('playwright-mixed.json'), {
    project: 'fast',
    root: '/repo',
    runnerVersion: '1.62.0',
    exitCode: 1,
    durationMs: 872,
  });
  const named = (fragment) => suite.tests.find((t) => t.name.includes(fragment));

  it('flattens the nested suites into one row per spec', () => {
    expect(suite.id).toBe('playwright:fast');
    expect(suite.runner).toBe('playwright');
    expect(suite.counts).toEqual({ total: 4, passed: 2, failed: 1, skipped: 1, todo: 0 });
  });

  it('names a test by its describe trail without repeating the filename', () => {
    // Playwright's outermost suite per file IS the file, and its title is the
    // filename - which `file` already says.
    expect(named('passes').name).toBe('a group passes');
    expect(named('passes').file).toBe('.tmp-fixgen/specs/mixed.spec.ts');
    expect(named('passes').line).toBe(4);
  });

  it('reads a failure and takes the terminal colours off its message', () => {
    const t = named('fails with a message');
    expect(t.status).toBe('failed');
    expect(t.failure).not.toContain(ESC);
    expect(t.failure.split('\n')[0]).toBe(
      'Error: expect(received).toBe(expected) // Object.is equality',
    );
  });

  it('gives a skipped spec no duration', () => {
    expect(named('is skipped').status).toBe('skipped');
    expect(named('is skipped').ms).toBeNull();
  });

  it('calls a globalSetup that threw an ERROR, not an empty pass', () => {
    // This is the shape that matters most in this repo: e2e/global-setup.ts
    // stands up a hub, a registry and a silent library, and when it throws
    // Playwright reports `suites: []`, an all-zero stats block, and the
    // reason in a TOP-LEVEL `errors[]` that nothing else in the file mentions.
    const failed = json('playwright-setup-failed.json');
    expect(failed.suites).toHaveLength(0);
    expect(failed.stats.unexpected).toBe(0);

    const s = fromPlaywright(failed, { project: 'fast', root: '/repo', exitCode: 1 });
    expect(s.status).toBe('error');
    expect(s.counts.total).toBe(0);
    expect(s.reason).toMatch(/error outside any test: Error: the hub never came up/);
  });

  it('keeps only the tests belonging to the project it was asked for', () => {
    const doctored = structuredClone(json('playwright-mixed.json'));
    for (const spec of doctored.suites[0].suites[0].specs) {
      spec.tests.push({ ...structuredClone(spec.tests[0]), projectName: 'slow' });
    }
    expect(fromPlaywright(doctored, { project: 'fast', root: '/repo' }).counts.total).toBe(4);
    expect(fromPlaywright(doctored, { project: 'slow', root: '/repo' }).counts.total).toBe(4);
  });
});

describe('fromCargo', () => {
  const suite = fromCargo(text('cargo-mixed.txt'), {
    target: 'fixgen',
    file: 'server/src/lib.rs',
    workspaceDir: 'server',
    exitCode: 101,
    durationMs: 40,
  });
  const named = (fragment) => suite.tests.find((t) => t.name.includes(fragment));

  it('reads the human lines, because the JSON format is nightly-only', () => {
    expect(suite.id).toBe('cargo:fixgen');
    expect(suite.runner).toBe('cargo');
    expect(suite.counts).toEqual({ total: 5, passed: 2, failed: 1, skipped: 2, todo: 0 });
  });

  it('takes `ok` for a pass and gives it no per-test time', () => {
    // The human format has no per-test clock. Null is the honest answer;
    // zero would be a number nobody measured.
    expect(named('passes').status).toBe('passed');
    expect(named('passes').ms).toBeNull();
    expect(named('passes').file).toBe('server/src/lib.rs');
  });

  it('takes `ignored` for a skip, with or without a trailing reason', () => {
    const exact = (name) => suite.tests.find((t) => t.name === name);
    expect(exact('tests::is_ignored').status).toBe('skipped');
    expect(exact('tests::is_ignored_with_a_reason').status).toBe('skipped');
  });

  it('attaches the panic body to the test that panicked, and its real line', () => {
    const t = named('fails_with_a_message');
    expect(t.status).toBe('failed');
    expect(t.failure).toMatch(/assertion `left == right` failed: two is not three/);
    // rustc prints panic paths relative to the WORKSPACE root, so the
    // workspace directory is what turns `src/lib.rs` into a repo path.
    expect(t.file).toBe('server/src/lib.rs');
    expect(t.line).toBe(6);
    expect(suite.status).toBe('failed');
  });

  it('reads a clean run of a real crate in this repo', () => {
    const s = fromCargo(text('cargo-passing.txt'), {
      target: 'afm_identity',
      file: 'server/crates/identity/src/lib.rs',
    });
    expect(s.status).toBe('passed');
    expect(s.reason).toBeNull();
    expect(s.counts).toEqual({ total: 5, passed: 5, failed: 0, skipped: 0, todo: 0 });
    expect(s.tests.map((t) => t.name)).toContain('tests::round_trips');
  });

  it('calls `running 0 tests` an ERROR even though libtest said ok', () => {
    // Captured from a real binary run with a filter that matched nothing:
    // exit 0, `test result: ok.`, and not a single test.
    const empty = text('cargo-empty.txt');
    expect(empty).toContain('test result: ok.');

    const s = fromCargo(empty, { target: 'fixgen', exitCode: 0 });
    expect(s.status).toBe('error');
    expect(s.reason).toMatch(/without running a single test/);
  });

  it('errors when the binary stopped before printing a summary', () => {
    const s = fromCargo('\nrunning 3 tests\ntest tests::one ... ok\n', { target: 'fixgen' });
    expect(s.status).toBe('error');
    expect(s.reason).toMatch(/no libtest summary line/);
  });

  it('errors when the summary disagrees with the lines above it', () => {
    const doctored = text('cargo-mixed.txt').replace('2 passed', '4 passed');
    const s = fromCargo(doctored, { target: 'fixgen' });
    expect(s.status).toBe('error');
    expect(s.reason).toMatch(/libtest summarised 4 passed .* and this parser read 2/s);
  });
});

describe('notRunSuite', () => {
  it('keeps a suite the run was told to skip, and says why', () => {
    const s = notRunSuite({
      id: 'cargo:attackfm-server',
      title: 'Server',
      runner: 'cargo',
      reason: 'not run: --skip=cargo',
    });
    expect(s.status).toBe('notRun');
    expect(s.reason).toBe('not run: --skip=cargo');
    expect(s.counts).toEqual(emptyCounts());
    expect(s.durationMs).toBeNull();
    expect(s.exitCode).toBeNull();
  });
});
