/**
 * Turning three runners' output into one shape.
 *
 * The app carries a machine-generated inventory of its own tests
 * (`src/app/diag/testReport.generated.json`), and a developer-mode settings
 * pane reads it back: "these are this version's tests, and here is what
 * happened when they ran". Everything in this file is PURE - it takes text or
 * an already-parsed object and returns a record. Nothing here spawns a
 * process, reads a file, or looks at the clock; `scripts/test-report.mjs` does
 * all of that and hands the results down. That split is not tidiness: it is
 * the only way this can be tested at all, because the alternative is a test
 * that runs Playwright in order to check the Playwright parser.
 *
 * THE ONE RULE THE SHAPE EXISTS FOR. A suite has FOUR statuses, not two:
 * `passed`, `failed`, `error`, `notRun`. A runner that ran but ran nothing -
 * a build failure, a setup that threw, a filter that matched no files - exits
 * 0 and reports success, and that is the single way a green tick in this
 * report could lie. Every parser below turns "the runner was happy and no
 * test ran" into `error` with a reason. If you change one of them, keep that.
 *
 * A note on WHY the numbers are recounted rather than copied. Each parser
 * derives `counts` from the test rows it actually built, and compares them
 * against the totals the runner printed. They should agree; when they do not,
 * the parser has misread the output, and a report that has misread its input
 * must not be allowed to show a tick. So a disagreement is an `error` too.
 */
import { relative as pathRelative, join as pathJoin, isAbsolute, sep } from 'node:path';

/** No single string in the report may run away with the file. */
export const MAX_TEXT = 2048;

/*
 * ANSI, out.
 *
 * Playwright's expect() failures arrive dressed in colour and libtest's do
 * not, so this is not universal - but a report read inside a settings pane has
 * no terminal to interpret the escapes, and a raw SGR sequence in a JSON string
 * is noise in the diff of a file that is meant to re-generate byte-identically.
 *
 * The disable below is the honest way to write this: `no-control-regex` is
 * right about almost every regex containing an escape character, and wrong
 * about the one whose whole job is to match escape characters.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** The text a person will read, with the terminal's furniture taken off. */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/** ANSI-stripped, trimmed, and never longer than the report can afford. */
export function clamp(text, max = MAX_TEXT) {
  const s = stripAnsi(text).trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * THE SHIP GUARD'S TRAP, and the reason this function exists.
 *
 * `scripts/ship-update.mjs` refuses to publish a built `app.js` matching
 * /from\s*["']\.\//  or  /import\(\s*["']\.\//, because a relative import
 * inside an OTA bundle 404s on a device and quarantines the whole version.
 * That guard reads the built file as CHARACTERS - it cannot tell an import
 * from a string - and this report is compiled into the bundle as data. So a
 * test whose NAME contained that sequence would put it into app.js, and every
 * future ship would die reporting a broken build that is not broken.
 *
 * Measured on this tree the day it was written: zero test names contain it.
 * This is here so that the first one written is neutralised, rather than
 * discovered six weeks later by somebody trying to ship a hotfix.
 *
 * The substitution is the smallest one that works: the ASCII quote becomes its
 * typographic twin (U+2019 for the apostrophe, U+201D for the double quote),
 * which reads identically in the pane and matches neither regex. Both quote
 * forms are handled because the guard's character class is ["'] - covering
 * only the apostrophe would leave half the trap open. NOTHING ELSE IS
 * TOUCHED. This is not a general sanitiser and must never become one: a test
 * name is a person's sentence, and the only licence taken here is the one
 * that stops a release dying.
 *
 * It does NOT cover a failure message or a reason, which can carry the same
 * characters - `scripts/test-report.mjs` refuses to WRITE such a report
 * instead, and says which field carries it. Mangling somebody's stack trace
 * to protect a build is a cure worse than the disease.
 */
export function sanitiseName(name) {
  return String(name ?? '')
    .replace(/(from\s*|import\(\s*)'(\.\/)/g, '$1’$2')
    .replace(/(from\s*|import\(\s*)"(\.\/)/g, '$1”$2');
}

/**
 * Every test name in every suite, sanitised, and the count of the ones that
 * needed it.
 *
 * Done in ONE place, over the finished suites, rather than inside each parser
 * - because the number the report carries as `namesSanitised` has to be a
 * count of names that were about to reach the bundle, and the bundle is
 * written from these suites and nothing else.
 */
export function sanitiseSuites(suites) {
  let sanitised = 0;
  const out = suites.map((suite) => ({
    ...suite,
    tests: suite.tests.map((test) => {
      const name = sanitiseName(test.name);
      if (name !== test.name) sanitised += 1;
      return { ...test, name };
    }),
  }));
  return { suites: out, sanitised };
}

/** The zero every suite starts from, so no caller has to remember the keys. */
export function emptyCounts() {
  return { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
}

/** Counts derived from the rows themselves - see the note at the top. */
function countOf(tests) {
  const counts = emptyCounts();
  for (const t of tests) {
    counts.total += 1;
    if (counts[t.status] !== undefined) counts[t.status] += 1;
  }
  return counts;
}

/**
 * A suite the run deliberately did not touch (`--only`, `--skip`).
 *
 * It is RECORDED rather than dropped, because a report that silently omits the
 * Rust tests is indistinguishable from a repo that has none - and the whole
 * point of the artefact is to say what this version's tests ARE.
 */
export function notRunSuite({ id, title, runner, reason, command = null }) {
  return {
    id,
    title,
    runner,
    runnerVersion: null,
    command,
    status: 'notRun',
    reason: clamp(reason),
    exitCode: null,
    durationMs: null,
    counts: emptyCounts(),
    tests: [],
  };
}

/** Repo-relative, forward slashes, whatever the runner handed us. */
function repoRelative(file, root) {
  const s = String(file ?? '');
  if (!s) return null;
  const abs = isAbsolute(s) ? s : root ? pathJoin(root, s) : s;
  const rel = root ? pathRelative(root, abs) : abs;
  return rel.split(sep).join('/');
}

/** Rows sorted the same way on every run, so a re-run is a zero-line diff. */
function sortTests(tests) {
  return [...tests].sort(
    (a, b) =>
      String(a.file).localeCompare(String(b.file)) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
}

/**
 * Assemble the record, deciding the status from the rows and from the runner's
 * own verdict. Every parser funnels through here, so the four-status rule is
 * written once.
 *
 * TWO KINDS OF PROBLEM, and the difference is the whole point of having four
 * statuses instead of three:
 *
 *   `problems`  - something went wrong ALONGSIDE results that can be believed.
 *                 A spec file that would not load, a worker that died after
 *                 reporting. The rows are real; the suite FAILED.
 *   `untrusted` - the parser cannot vouch for the rows it built. The summary
 *                 disagrees with the lines above it, the binary stopped before
 *                 finishing, the runner counted a different number of tests.
 *                 This outranks a failing test, because if the output was
 *                 misread then the failures were misread too. The suite is an
 *                 ERROR: not "some tests failed", but "this report does not
 *                 know what happened".
 *
 * `runnerSaidTotal` is the runner's own count. It is compared, not trusted.
 */
function suiteRecord({
  id,
  title,
  runner,
  runnerVersion = null,
  command = '',
  exitCode = null,
  durationMs = null,
  tests,
  problems = [],
  untrusted = [],
  runnerSaidTotal = null,
}) {
  const sorted = sortTests(tests);
  const counts = countOf(sorted);
  const doubts = [...untrusted];

  if (runnerSaidTotal !== null && runnerSaidTotal !== counts.total) {
    doubts.push(
      `the runner reported ${runnerSaidTotal} test(s) and this parser built ${counts.total} row(s) - ` +
        'the output is not the shape this parser was written for',
    );
  }

  const notes = [...problems, ...doubts];

  let status;
  if (counts.total === 0) {
    // THE GREEN TICK THAT LIES. See the header.
    status = 'error';
    if (!notes.length) notes.push('the runner finished without running a single test');
  } else if (doubts.length) {
    status = 'error';
  } else if (counts.failed > 0) {
    status = 'failed';
  } else if (notes.length) {
    status = 'failed';
  } else {
    status = 'passed';
  }

  return {
    id,
    title,
    runner,
    runnerVersion,
    command,
    status,
    // `reason` belongs to error/notRun in the schema, and to a failure whose
    // cause is in no single test row - which is the same thing wearing a
    // different hat.
    reason: notes.length ? clamp(notes.join('\n')) : null,
    exitCode,
    durationMs,
    counts,
    tests: sorted,
  };
}

/*
 * Vitest 5's assertion statuses.
 *
 * The JSON reporter emits the long forms; the short ones are the task modes it
 * maps from, accepted here so that a reporter change cannot silently
 * reclassify a whole suite. `pending` is vitest's own word for a skip - the
 * same run that calls `it.skip` "skipped" counts it under `numPendingTests` -
 * so the two land in one bucket.
 */
const VITEST_STATUS = {
  pass: 'passed',
  passed: 'passed',
  fail: 'failed',
  failed: 'failed',
  skip: 'skipped',
  skipped: 'skipped',
  pending: 'skipped',
  todo: 'todo',
};

/**
 * A suite record from `vitest run --reporter=json`.
 *
 * The reporter's shape: the top level carries numTotal/Passed/Failed/Pending/
 * TodoTests, `success` and `startTime`; `testResults[]` is one entry per FILE
 * (`name` is an ABSOLUTE path, and `numTotalTestSuites` counts describe blocks
 * rather than files - do not reach for it); `assertionResults[]` is one entry
 * per test, with `location` present only when the run passed
 * `--includeTaskLocation`, and `duration` ABSENT for anything skipped or todo.
 *
 * The case worth knowing about is a file that fails to LOAD - a bad import, a
 * throw at module scope. It arrives as a testResults entry with
 * `status: "failed"`, a `message`, and an EMPTY assertionResults array. No
 * test failed; there is simply nothing there. Left unhandled it reads as a
 * smaller, greener suite.
 */
export function fromVitest(json, opts = {}) {
  const {
    root = null,
    id = 'vitest',
    title = 'Unit',
    command = '',
    runnerVersion = null,
    exitCode = null,
    durationMs = null,
  } = opts;

  const files = Array.isArray(json?.testResults) ? json.testResults : [];
  const tests = [];
  const problems = [];

  for (const file of files) {
    const rel = repoRelative(file?.name, root);
    const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : [];

    if (!assertions.length) {
      const why = clamp(file?.message);
      if (why) problems.push(`${rel ?? 'a file'} did not load: ${why}`);
      continue;
    }

    for (const a of assertions) {
      const mapped = VITEST_STATUS[a?.status];
      const name = a?.fullName || [...(a?.ancestorTitles ?? []), a?.title].filter(Boolean).join(' ');
      tests.push({
        file: rel,
        line: typeof a?.location?.line === 'number' ? a.location.line : null,
        name,
        // An unrecognised status is reported as a FAILURE, not quietly folded
        // into "skipped": a status this parser does not know is a status it
        // cannot vouch for, and the report's job is to refuse to vouch.
        status: mapped ?? 'failed',
        ms: typeof a?.duration === 'number' ? a.duration : null,
        failure: mapped
          ? clamp(a?.failureMessages?.[0])
          : `unrecognised runner status: ${JSON.stringify(a?.status)}`,
      });
    }
  }

  if (!files.length && json?.success === true) {
    problems.push(
      'vitest reported success with no test files at all - a filter that matched nothing, ' +
        'or a config whose `include` no longer reaches the suite',
    );
  }

  return suiteRecord({
    id,
    title,
    runner: 'vitest',
    runnerVersion,
    command,
    exitCode,
    durationMs,
    tests,
    problems,
    runnerSaidTotal: typeof json?.numTotalTests === 'number' ? json.numTotalTests : null,
  });
}

/*
 * Playwright's four outcomes, against the schema's four.
 *
 * `flaky` maps to FAILED, deliberately. A flaky test is one that went green on
 * a retry, and this repo sets `retries: 0` precisely so that a retry can never
 * turn a race into a pass - so a flaky row here means the config changed under
 * us, and the safe reading of "it failed and then it didn't" is that it
 * failed.
 */
const PLAYWRIGHT_STATUS = {
  expected: 'passed',
  unexpected: 'failed',
  flaky: 'failed',
  skipped: 'skipped',
};

/** Every spec in the tree, with the describe titles that led to it. */
function playwrightSpecs(suites, trail = [], depth = 0) {
  const out = [];
  for (const suite of suites ?? []) {
    // The outermost suite per file IS the file; its title is the filename, and
    // repeating that in every test name would be noise beside `file`.
    const next = depth === 0 ? trail : [...trail, suite?.title].filter(Boolean);
    for (const spec of suite?.specs ?? []) out.push({ spec, trail: next });
    out.push(...playwrightSpecs(suite?.suites, next, depth + 1));
  }
  return out;
}

/**
 * A suite record from `playwright test --reporter=json`.
 *
 * The shape: `suites[]` nests (the file, then each describe), `specs[]` sit at
 * the leaves with `file`, `line` and `title`, and every spec has `tests[]` -
 * ONE PER PROJECT, which is why `project` is not optional in practice: this
 * repo runs `fast` and `slow` as two suites, and a spec in both would
 * otherwise be counted twice. `stats` carries expected/unexpected/flaky/
 * skipped.
 *
 * `spec.file` is relative to `config.rootDir`, not to the repo.
 *
 * The top-level `errors[]` is the one that matters most: a globalSetup that
 * throws lands THERE, with `suites: []` and a stats block of all zeros. The
 * hub never came up, nothing ran, and Playwright's exit code is the only other
 * sign of it.
 */
export function fromPlaywright(json, opts = {}) {
  const {
    project = null,
    root = null,
    id = project ? `playwright:${project}` : 'playwright',
    title = 'End-to-end',
    command = '',
    runnerVersion = null,
    exitCode = null,
    durationMs = null,
  } = opts;

  const rootDir = json?.config?.rootDir ?? null;
  const tests = [];

  for (const { spec, trail } of playwrightSpecs(json?.suites)) {
    const file = repoRelative(
      rootDir && spec?.file && !isAbsolute(spec.file) ? pathJoin(rootDir, spec.file) : spec?.file,
      root,
    );
    for (const t of spec?.tests ?? []) {
      if (project && t?.projectName && t.projectName !== project) continue;
      const mapped = PLAYWRIGHT_STATUS[t?.status];
      const results = Array.isArray(t?.results) ? t.results : [];
      const timed = results.filter((r) => typeof r?.duration === 'number');
      const failure =
        results
          .map((r) => r?.error?.message ?? r?.errors?.[0]?.message)
          .find((m) => m && String(m).trim()) ?? null;
      tests.push({
        file,
        line: typeof spec?.line === 'number' ? spec.line : null,
        name: [...trail, spec?.title].filter(Boolean).join(' '),
        status: mapped ?? 'failed',
        // Summed across attempts rather than taken from the last one: with
        // retries off there is only ever one, and if retries are ever turned
        // on the honest answer to "how long did this cost" is all of them.
        ms:
          mapped === 'skipped' || !timed.length
            ? null
            : timed.reduce((n, r) => n + r.duration, 0),
        failure: mapped
          ? clamp(failure)
          : `unrecognised runner status: ${JSON.stringify(t?.status)}`,
      });
    }
  }

  const problems = [];
  for (const e of json?.errors ?? []) {
    const why = clamp(e?.message);
    // A globalSetup failure is the whole run, not a footnote to it: the hub,
    // the registry and the silent library are stood up there, and nothing
    // downstream of it means anything.
    if (why) problems.push(`the run reported an error outside any test: ${why}`);
  }

  const stats = json?.stats ?? null;
  const said = stats
    ? (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0) + (stats.skipped ?? 0)
    : null;

  return suiteRecord({
    id,
    title,
    runner: 'playwright',
    runnerVersion,
    command,
    exitCode,
    durationMs,
    tests,
    problems,
    // Compared only when this suite IS the whole run. Under a project filter
    // the stats block still counts the run, and checking one against the other
    // would be comparing two different questions.
    runnerSaidTotal:
      project && (json?.config?.projects?.length ?? 0) > 1 ? null : said,
  });
}

/* `test <name> ... <outcome>`, with the outcome on the SAME line - which is
   what `--test-threads=1` buys, and the reason the runner insists on it. With
   more than one thread libtest prints the name when a test starts and the
   result whenever it finishes, so the halves interleave and no parser can put
   them back together. */
const CARGO_LINE = /^test\s+(.+?)\s+\.\.\.\s+(.+?)\s*$/;
const CARGO_SUMMARY =
  /^test result:\s+(\w+)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored;\s+(\d+)\s+measured;\s+(\d+)\s+filtered out/;
/* `---- <name> stdout ----` opens the panic body for one failed test. */
const CARGO_FAILURE_HEAD = /^----\s+(.+?)\s+stdout\s+----$/;
/* rustc prints panic locations relative to the WORKSPACE root, not to the
   crate: measured on a two-crate workspace, the member's panic read
   `crates/inner/src/lib.rs` and not `src/lib.rs`. */
const CARGO_PANIC_AT = /panicked at ([^\s:][^:\n]*):(\d+):(\d+)/;

/**
 * A suite record from a libtest binary's HUMAN stdout.
 *
 * WHY THE HUMAN OUTPUT. On the pinned stable toolchain (1.94.1) there is no
 * supported machine-readable per-test output: `--format json` is gated behind
 * `-Zunstable-options` and refuses to run without a nightly compiler.
 * RUSTC_BOOTSTRAP=1 does unlock it - verified on this machine, it emits one
 * JSON object per test - but a report whose correctness rests on a variable
 * that exists to let the compiler bootstrap ITSELF is a report that breaks on
 * a toolchain bump, silently, at the moment somebody needs it. So this parses
 * what the binary prints for a person, which is stable, is demonstrated by
 * every Rust test run ever made, and is the same on every channel. Every
 * cargo record in this repo's report came out of THIS parser; there is no
 * second path to be unsure about.
 *
 * WHAT IS LOST, said out loud: libtest's human output carries no per-test
 * timing, so `ms` is null on every cargo row. It is not zero, and it is not
 * invented. The suite's own `durationMs` is measured by the wrapper and is
 * real.
 *
 * `file` is the test target's own source root (`server/src/main.rs`) rather
 * than the file the test is written in, because a libtest name is a MODULE
 * path (`tests::round_trips`) and carries no file at all. A FAILED test is
 * the exception: its panic names a real file and line, and those are used.
 */
export function fromCargo(text, opts = {}) {
  const {
    target = 'cargo',
    id = `cargo:${target}`,
    title = target,
    file = null,
    workspaceDir = null,
    command = '',
    runnerVersion = null,
    exitCode = null,
    durationMs = null,
  } = opts;

  const lines = String(text ?? '').split('\n');
  const rows = [];
  const failureBodies = new Map();
  let summary = null;

  let bodyFor = null;
  let body = [];
  const flush = () => {
    if (bodyFor) failureBodies.set(bodyFor, body.join('\n'));
    bodyFor = null;
    body = [];
  };

  for (const line of lines) {
    const head = CARGO_FAILURE_HEAD.exec(line);
    if (head) {
      flush();
      bodyFor = head[1];
      continue;
    }
    if (bodyFor) {
      // A body runs until the `failures:` roll-call, which is where libtest
      // stops describing and starts listing.
      if (/^failures:\s*$/.test(line) || CARGO_SUMMARY.test(line)) flush();
      else body.push(line);
      continue;
    }

    const sum = CARGO_SUMMARY.exec(line);
    if (sum) {
      summary = {
        verdict: sum[1],
        passed: Number(sum[2]),
        failed: Number(sum[3]),
        ignored: Number(sum[4]),
        measured: Number(sum[5]),
        filtered: Number(sum[6]),
      };
      continue;
    }

    const m = CARGO_LINE.exec(line);
    if (m) rows.push({ name: m[1], outcome: m[2] });
  }
  flush();

  const problems = [];
  const tests = rows.map(({ name, outcome }) => {
    let status;
    if (outcome === 'ok') status = 'passed';
    else if (outcome === 'FAILED') status = 'failed';
    else if (outcome === 'ignored' || outcome.startsWith('ignored,')) status = 'skipped';
    else {
      // A bench line, or something libtest has grown since this was written.
      status = 'failed';
      problems.push(`unrecognised libtest outcome for ${name}: ${outcome}`);
    }

    const raw = failureBodies.get(name) ?? null;
    const at = raw ? CARGO_PANIC_AT.exec(raw) : null;
    return {
      file: at && workspaceDir ? `${workspaceDir}/${at[1]}` : file,
      line: at ? Number(at[2]) : null,
      name,
      // libtest's human output has no per-test clock. See the header.
      status,
      ms: null,
      failure: status === 'failed' ? clamp(raw) : null,
    };
  });

  const untrusted = [];
  if (!summary) {
    // No `test result:` line at all: the binary never got as far as finishing
    // - a panic in a static initialiser, a SIGKILL, a harness that never
    // started. Whatever it is, it is not "no tests", and whatever rows were
    // printed before it stopped are a partial account of nothing.
    untrusted.push('the binary printed no libtest summary line - it did not finish');
  } else {
    const seen = countOf(tests);
    if (
      seen.passed !== summary.passed ||
      seen.failed !== summary.failed ||
      seen.skipped !== summary.ignored
    ) {
      untrusted.push(
        `libtest summarised ${summary.passed} passed / ${summary.failed} failed / ` +
          `${summary.ignored} ignored, and this parser read ${seen.passed} / ${seen.failed} / ` +
          `${seen.skipped} from the per-test lines`,
      );
    }
    if (summary.measured > 0) {
      // The report's promise is that it lists everything this version runs. A
      // benchmark that ran and is absent breaks that promise quietly, which is
      // the one thing the four statuses exist to prevent.
      untrusted.push(`${summary.measured} benchmark(s) ran and are not represented here`);
    }
  }

  return suiteRecord({
    id,
    title,
    runner: 'cargo',
    runnerVersion,
    command,
    exitCode,
    durationMs,
    tests,
    problems,
    untrusted,
    runnerSaidTotal: summary ? summary.passed + summary.failed + summary.ignored : null,
  });
}
