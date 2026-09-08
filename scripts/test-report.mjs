/**
 * Every test this repository has, and what happened when it ran.
 *
 *   npm run test:report                  # run everything, write the report
 *   npm run test:report -- --only=vitest # refresh one runner
 *   npm run test:report -- --skip=cargo  # everything but the Rust suites
 *   npm run test:report -- --check       # is the committed report still true?
 *
 * The output is `src/app/diag/testReport.generated.json`, which is COMPILED
 * INTO THE APP. A developer-mode settings pane reads it back, so a phone in
 * somebody's pocket can answer "what does this version claim to have tested,
 * and did it pass" without a terminal, a checkout, or a network.
 *
 * WHAT THIS SCRIPT IS FOR, beyond convenience. Three runners, three output
 * formats, three ways of being quietly wrong, and one of them is shared: a
 * runner that RAN but ran NOTHING exits 0 and reports success. `scripts/
 * testReport/parse.mjs` turns each of those into `status: "error"`; this file
 * makes sure they are all actually invoked, times them on a clock that
 * includes what their own numbers leave out, and refuses to drop a suite it
 * did not run.
 *
 * The parsing lives next door and is PURE. This file is the half that touches
 * the world: it spawns, it reads the clock, it writes the file.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import process from 'node:process';

import {
  clamp,
  emptyCounts,
  fromCargo,
  fromPlaywright,
  fromVitest,
  notRunSuite,
  sanitiseSuites,
} from './testReport/parse.mjs';
import { REPORT_PATH as REPORT_PATH_IN_REPO, reportCommit } from './testReport/commit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/diag/testReport.generated.json');
/** The path recorded in `command`, so a re-run is a zero-line diff. */
const TMP_PLACEHOLDER = '<tmp>';

const step = (m) => console.log(`\x1b[36m▸\x1b[0m \x1b[1m${m}\x1b[0m`);
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);
const die = (m) => {
  console.error(`\x1b[31m✗\x1b[0m ${m}`);
  process.exit(1);
};

/* ------------------------------------------------------------------ args */

const FAMILIES = ['vitest', 'playwright', 'cargo'];
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const listArg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).split(',').map((s) => s.trim()).filter(Boolean) : null;
};
const only = listArg('only');
const skip = listArg('skip') ?? [];
for (const f of [...(only ?? []), ...skip]) {
  if (!FAMILIES.includes(f)) die(`unknown runner "${f}" — expected one of ${FAMILIES.join(', ')}`);
}
/*
 * `--check` REFUSES a partial run, rather than comparing half a report against
 * a whole one and calling the difference a drift. There is nothing a partial
 * check could say that is not either a false alarm or already known.
 */
if (CHECK && (only || skip.length)) {
  die('--check runs everything: it cannot be combined with --only or --skip');
}
const wanted = (family) => (only ? only.includes(family) : true) && !skip.includes(family);
const whyNot = (family) =>
  only
    ? `not run: --only=${only.join(',')} did not ask for ${family}`
    : `not run: --skip=${skip.join(',')}`;

/* ------------------------------------------------------------- the world */

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });

const git = (...args) => {
  const r = run('git', args, { timeout: 20_000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
};

/** The first line of `<tool> --version`, reduced to the number in it. */
function toolVersion(cmd, args = ['--version']) {
  const r = run(cmd, args, { timeout: 20_000 });
  if (r.status !== 0 && !r.stdout) return null;
  const line = String(r.stdout || r.stderr).split('\n')[0] ?? '';
  return line.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? clamp(line, 40);
}

/** A dependency's version, read from the package it ships. */
function packageVersion(name) {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * Is the tree dirty - ignoring the report itself?
 *
 * The report cannot count as a change to the tree it describes, or generating
 * it would make it wrong. Everything else counts, because a report generated
 * over uncommitted edits describes code nobody else has.
 */
function treeIsDirty() {
  const out = git('status', '--porcelain');
  if (out === null) return false;
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .some((l) => !l.endsWith(REPORT_PATH_IN_REPO));
}

/* ------------------------------------------------------------- the suites */

const scratch = mkdtempSync(join(tmpdir(), 'afm-testreport-'));
const cleanUp = () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* A leftover temp directory is the OS's problem, not this script's. */
  }
};

/** Read JSON a runner wrote, or null with the reason it could not be read. */
function readJson(path) {
  try {
    return { json: JSON.parse(readFileSync(path, 'utf8')), why: null };
  } catch (err) {
    return { json: null, why: `could not read the runner's JSON report: ${String(err)}` };
  }
}

/** A suite record for a runner that produced nothing readable at all. */
function unreadable({ id, title, runner, command, exitCode, durationMs, why, output }) {
  return {
    id,
    title,
    runner,
    runnerVersion: null,
    command,
    status: 'error',
    reason: clamp(`${why}\n${output ?? ''}`),
    exitCode,
    durationMs,
    counts: emptyCounts(),
    tests: [],
  };
}

/**
 * The unit suite.
 *
 * `--outputFile.json=` in the DOT FORM is required, because two reporters are
 * in play and the flat `--outputFile` would apply to both. Without any
 * outputFile at all vitest writes `.vitest/json/output.json` and prints a path
 * where the report should be, which is why this never reads stdout.
 * `--includeTaskLocation` is what puts a line number on every row; without it
 * every `line` in this suite is null.
 *
 * NEVER `--coverage`. The v8 coverage map is folded into the same JSON and
 * takes it from 3 KB to about 8 MB - a file that then ships inside the OTA
 * bundle on every device.
 */
function runVitest() {
  const out = join(scratch, 'vitest.json');
  const args = [
    'vitest',
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${out}`,
    '--includeTaskLocation',
  ];
  const command = `npx ${args.join(' ').replace(out, TMP_PLACEHOLDER)}`;

  step('Unit tests (vitest)');
  const started = Date.now();
  const r = run('npx', args, { stdio: ['ignore', 'inherit', 'pipe'] });
  const durationMs = Date.now() - started;

  const { json, why } = readJson(out);
  if (!json) {
    return unreadable({
      id: 'vitest',
      title: 'Unit',
      runner: 'vitest',
      command,
      exitCode: r.status,
      durationMs,
      why,
      output: r.stderr,
    });
  }
  return fromVitest(json, {
    root: ROOT,
    command,
    runnerVersion: packageVersion('vitest'),
    exitCode: r.status,
    durationMs,
  });
}

/**
 * One end-to-end project.
 *
 * `PLAYWRIGHT_JSON_OUTPUT_NAME` rather than a flag: `--reporter=json` writes
 * to stdout otherwise, and this suite's stdout is where the hub, the registry
 * and a browser are all talking at once.
 *
 * The wrapper's clock is the only one that includes `e2e/global-setup.ts` -
 * which builds a silent library, starts a hub and a registry, and signs two
 * accounts in. Playwright's own `stats.duration` starts after all of that.
 */
function runPlaywright(project, title) {
  const out = join(scratch, `playwright-${project}.json`);
  const args = ['playwright', 'test', `--project=${project}`, '--reporter=json'];
  if (project === 'slow') args.push('--pass-with-no-tests');
  const command = `npx ${args.join(' ')}`;

  step(`End-to-end, ${project} (playwright)`);
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out };
  // Passed THROUGH, not invented: every scratch harness in this repo points
  // these at a binary it built itself, and a report generated under one must
  // describe that run rather than silently using a different server.
  for (const key of ['BIN', 'REGISTRY_BIN']) if (process.env[key]) env[key] = process.env[key];

  const started = Date.now();
  // BOTH streams inherited. This is the suite that takes twenty minutes, and
  // a person watching it needs to see global-setup building a library and
  // standing up a hub; swallowing that to keep a copy for a `reason` nobody
  // will need is the wrong trade. If the JSON is unreadable the terminal
  // already holds the story, and the reason below names the file that is
  // missing.
  const r = run('npx', args, { stdio: ['ignore', 'inherit', 'inherit'], env });
  const durationMs = Date.now() - started;

  const { json, why } = readJson(out);
  if (!json) {
    return unreadable({
      id: `playwright:${project}`,
      title,
      runner: 'playwright',
      command,
      exitCode: r.status,
      durationMs,
      why: `${why} (exit code ${r.status}; the run's own output is above)`,
      output: null,
    });
  }
  return fromPlaywright(json, {
    project,
    root: ROOT,
    title,
    command,
    runnerVersion: packageVersion('@playwright/test'),
    exitCode: r.status,
    durationMs,
  });
}

/**
 * The server's Rust suites, one record per test binary.
 *
 * TWO STEPS, and the split is the point. `cargo test` prints its own progress
 * to stderr while libtest prints results to stdout, and the two streams are
 * merged by the time anything downstream sees them - so a single `cargo test`
 * cannot be attributed to a target. Instead `--no-run --message-format=json`
 * enumerates the test executables (`reason === 'compiler-artifact'` with
 * `profile.test === true` and an `executable`), and each one is run DIRECTLY.
 *
 * `--test-threads=1` is not about speed. With more than one thread libtest
 * prints a test's name when it starts and its result when it finishes, so the
 * lines interleave and no parser can pair them up again.
 *
 * The BUILD is charged to the first binary's clock. It is shared work - often
 * minutes of it on a cold target directory - and spreading it over the suites
 * or dropping it would both make the durations add up to something other than
 * the time this actually took.
 */
function runCargo() {
  const manifest = 'server/Cargo.toml';
  const workspaceDir = 'server';
  const buildArgs = ['test', '--workspace', '--manifest-path', manifest, '--no-run', '--message-format=json'];

  step('Server tests (cargo)');
  console.log(`    building the test binaries — cargo test --workspace --manifest-path ${manifest} --no-run`);
  const buildStarted = Date.now();
  const build = run('cargo', buildArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
  const buildMs = Date.now() - buildStarted;

  const targets = [];
  for (const line of String(build.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // cargo interleaves non-JSON lines when a build script prints.
    }
    if (msg.reason === 'compiler-artifact' && msg.profile?.test === true && msg.executable) {
      targets.push({
        name: msg.target?.name ?? 'unknown',
        kind: msg.target?.kind?.[0] ?? 'lib',
        src: msg.target?.src_path ? relative(ROOT, msg.target.src_path).split('\\').join('/') : null,
        exe: msg.executable,
      });
    }
  }

  if (!targets.length) {
    return [
      unreadable({
        id: 'cargo',
        title: 'Server',
        runner: 'cargo',
        command: `cargo ${buildArgs.join(' ')}`,
        exitCode: build.status,
        durationMs: buildMs,
        why: 'cargo enumerated no test executables — the workspace did not build',
        output: build.stderr,
      }),
    ];
  }

  // Two targets in one workspace can share a name (a crate's lib and its bin),
  // and two suites cannot share an id.
  const seen = new Map();
  for (const t of targets) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);

  const suites = [];
  targets.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  for (const [i, t] of targets.entries()) {
    const key = seen.get(t.name) > 1 ? `${t.name}-${t.kind}` : t.name;
    // The executable carries a build hash that changes with the code, so the
    // recorded command names it with a placeholder: a stable line that says
    // exactly what ran without making every rebuild a diff.
    const shown = relative(ROOT, t.exe).replace(/-[0-9a-f]{8,}$/, '-<hash>').split('\\').join('/');
    const command = `${shown} --test-threads=1`;

    console.log(`    ${key}`);
    const started = Date.now();
    const r = run(t.exe, ['--test-threads=1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    // The build is shared work; charging it to the first suite is what keeps
    // the durations summing to the wall time this phase really took.
    const durationMs = Date.now() - started + (i === 0 ? buildMs : 0);

    suites.push(
      fromCargo(String(r.stdout || ''), {
        target: key,
        title: key,
        file: t.src,
        workspaceDir,
        command,
        runnerVersion: toolVersion('rustc'),
        exitCode: r.status,
        durationMs,
      }),
    );
  }
  return suites;
}

/* ------------------------------------------------------------- assembling */

/** The committed report, if there is one - used to keep skipped suites. */
function committed() {
  try {
    return JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    return null;
  }
}

/** Suites a skipped family should still appear as, so nothing vanishes. */
function placeholders(family, previous) {
  const known = (previous?.suites ?? []).filter((s) =>
    family === 'cargo' ? s.id.startsWith('cargo') : s.id.split(':')[0] === family,
  );
  if (known.length) {
    return known.map((s) =>
      notRunSuite({ id: s.id, title: s.title, runner: s.runner, reason: whyNot(family), command: s.command }),
    );
  }
  const fallback = {
    vitest: [{ id: 'vitest', title: 'Unit', runner: 'vitest' }],
    playwright: [
      { id: 'playwright:fast', title: 'End-to-end', runner: 'playwright' },
      { id: 'playwright:slow', title: 'End-to-end, long windows', runner: 'playwright' },
    ],
    // Without the build there is no way to know what the targets are called,
    // so the family stands in for itself rather than guessing names.
    cargo: [{ id: 'cargo', title: 'Server', runner: 'cargo' }],
  };
  return fallback[family].map((s) => notRunSuite({ ...s, reason: whyNot(family) }));
}

/** vitest, then the e2e projects, then the Rust binaries by name. */
function inOrder(suites) {
  const rank = (id) =>
    id === 'vitest' ? 0 : id === 'playwright:fast' ? 1 : id === 'playwright:slow' ? 2 : 3;
  return [...suites].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/**
 * The report, with its keys in the schema's order.
 *
 * Written by hand rather than by spreading an object, because the ORDER is
 * part of the contract: the file is committed, and a re-run that produced the
 * same results but shuffled the keys would be a diff nobody can read.
 */
function assemble(suites, meta) {
  const totals = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, notRun: 0 };
  for (const s of suites) {
    for (const k of ['total', 'passed', 'failed', 'skipped', 'todo']) totals[k] += s.counts[k];
    // `notRun` counts SUITES, not tests: a suite that never ran has no tests
    // to count, and a zero here would be the same green tick the four statuses
    // exist to prevent. It is "how much of the inventory is unaccounted for".
    if (s.status === 'notRun' || (s.status === 'error' && s.counts.total === 0)) totals.notRun += 1;
  }

  return {
    schemaVersion: 1,
    generatedAt: meta.generatedAt,
    version: meta.version,
    commit: meta.commit,
    dirty: meta.dirty,
    host: meta.host,
    tools: meta.tools,
    // Not "nothing failed": every suite has to have PASSED, which a suite that
    // errored or never ran has not done.
    ok: suites.length > 0 && suites.every((s) => s.status === 'passed'),
    namesSanitised: meta.namesSanitised,
    totals,
    suites: suites.map((s) => ({
      id: s.id,
      title: s.title,
      runner: s.runner,
      runnerVersion: s.runnerVersion,
      command: s.command,
      status: s.status,
      reason: s.reason,
      exitCode: s.exitCode,
      durationMs: s.durationMs,
      counts: {
        total: s.counts.total,
        passed: s.counts.passed,
        failed: s.counts.failed,
        skipped: s.counts.skipped,
        todo: s.counts.todo,
      },
      tests: s.tests.map((t) => ({
        file: t.file,
        line: t.line,
        name: t.name,
        status: t.status,
        ms: t.ms,
        failure: t.failure,
      })),
    })),
  };
}

/*
 * THE OTHER HALF OF THE SHIP GUARD.
 *
 * `sanitiseName` neutralises the sequence in test NAMES, which is where it
 * would realistically appear. It deliberately does not touch a failure message
 * or a reason: mangling somebody's stack trace to protect a build is a cure
 * worse than the disease. But a stack trace CAN carry it - a vitest import
 * error says `Failed to resolve import "./x" from "y"` in as many words - and
 * a report carrying that would kill every future ship with a message about a
 * broken bundle that is not broken.
 *
 * So the finished file is scanned, and a report that would do that is not
 * written at all. Refusing is honest: the run happened, the failure is on the
 * terminal, and the fix is to fix the test rather than to quietly reword its
 * error.
 */
const GUARDS = [
  ['from', /from\s*["']\.\//],
  ['import(', /import\(\s*["']\.\//],
];

function guardTheBundle(report) {
  for (const [label, re] of GUARDS) {
    if (!re.test(JSON.stringify(report))) continue;
    const hits = [];
    for (const s of report.suites) {
      if (s.reason && re.test(s.reason)) hits.push(`${s.id}: reason`);
      for (const t of s.tests) {
        if (re.test(t.name)) hits.push(`${s.id}: the NAME of "${t.name}"`);
        if (t.failure && re.test(t.failure)) hits.push(`${s.id}: the failure text of "${t.name}"`);
      }
    }
    die(
      `refusing to write the report: it contains the \x1b[1m${label} "./\x1b[0m sequence that\n` +
        `    \`npm run ship\` refuses to publish inside app.js. Every future ship would die\n` +
        `    reporting a broken bundle. It is carried by:\n` +
        hits.slice(0, 10).map((h) => `      ${h}`).join('\n') +
        (hits.length > 10 ? `\n      …and ${hits.length - 10} more` : ''),
    );
  }
}

/* ------------------------------------------------------------------ check */

/** Everything a second run legitimately changes, taken back out. */
function normalise(report) {
  const copy = structuredClone(report);
  delete copy.generatedAt;
  for (const s of copy.suites ?? []) {
    delete s.durationMs;
    for (const t of s.tests ?? []) delete t.ms;
  }
  return copy;
}

/** Where two normalised reports part company, in reading order. */
function differences(a, b, path = '', found = []) {
  if (found.length >= 20) return found;
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      found.push(`${path || '(root)'}: committed ${JSON.stringify(a)} — fresh ${JSON.stringify(b)}`);
    }
    return found;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      found.push(`${path}: committed ${a.length} entr(ies) — fresh ${b.length}`);
    }
    for (let i = 0; i < Math.max(a.length, b.length) && found.length < 20; i += 1) {
      differences(a[i], b[i], `${path}[${i}]`, found);
    }
    return found;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (found.length >= 20) break;
    differences(a[key], b[key], path ? `${path}.${key}` : key, found);
  }
  return found;
}

/* ------------------------------------------------------------------- main */

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const previous = committed();

step(
  CHECK
    ? 'Checking the committed report against a fresh run'
    : `Running every suite for ${pkg.name} ${pkg.version}`,
);

const raw = [];
if (wanted('vitest')) raw.push(runVitest());
else raw.push(...placeholders('vitest', previous));

if (wanted('playwright')) {
  raw.push(runPlaywright('fast', 'End-to-end'));
  raw.push(runPlaywright('slow', 'End-to-end, long windows'));
} else raw.push(...placeholders('playwright', previous));

if (wanted('cargo')) raw.push(...runCargo());
else raw.push(...placeholders('cargo', previous));

const { suites, sanitised } = sanitiseSuites(inOrder(raw));

const report = assemble(suites, {
  generatedAt: new Date().toISOString(),
  version: pkg.version,
  commit: reportCommit(),
  dirty: treeIsDirty(),
  host: { os: process.platform, arch: process.arch, node: process.version },
  tools: {
    vitest: packageVersion('vitest'),
    playwright: packageVersion('@playwright/test'),
    rustc: toolVersion('rustc'),
    ffmpeg: toolVersion('ffmpeg', ['-version']),
  },
  namesSanitised: sanitised,
});

guardTheBundle(report);
cleanUp();

const serialised = `${JSON.stringify(report, null, 2)}\n`;

console.log('');
for (const s of report.suites) {
  const mark = { passed: '\x1b[32m✓\x1b[0m', failed: '\x1b[31m✗\x1b[0m', error: '\x1b[31m!\x1b[0m', notRun: '\x1b[33m–\x1b[0m' }[s.status];
  const secs = s.durationMs === null ? '     ' : `${(s.durationMs / 1000).toFixed(1)}s`.padStart(7);
  console.log(`  ${mark} ${s.id.padEnd(26)} ${String(s.counts.total).padStart(5)} tests ${secs}  ${s.status}`);
  if (s.reason) console.log(`      ${s.reason.split('\n')[0]}`);
}
console.log(
  `\n    ${report.totals.total} tests · ${report.totals.passed} passed · ${report.totals.failed} failed · ` +
    `${report.totals.skipped} skipped · ${report.totals.todo} todo · ${report.totals.notRun} suite(s) unaccounted for`,
);
if (report.namesSanitised) {
  warn(`${report.namesSanitised} test name(s) carried the ship guard's sequence and were neutralised`);
}

if (CHECK) {
  if (!previous) die(`there is no committed report at ${REPORT_PATH_IN_REPO} — run \`npm run test:report\``);
  const diff = differences(normalise(previous), normalise(report));
  if (!diff.length) {
    ok(`the committed report still matches a fresh run (${report.totals.total} tests)`);
    process.exit(0);
  }
  die(
    `the committed report no longer matches a fresh run — ${diff.length >= 20 ? '20+' : diff.length} difference(s):\n` +
      diff.map((d) => `      ${d}`).join('\n') +
      `\n    Run \`npm run test:report\` and commit the result.`,
  );
}

mkdirSync(dirname(OUT), { recursive: true });
const unchanged = existsSync(OUT) && readFileSync(OUT, 'utf8') === serialised;
writeFileSync(OUT, serialised);
ok(
  `${REPORT_PATH_IN_REPO} — ${(serialised.length / 1024).toFixed(1)} KB, ` +
    `${report.suites.length} suites, ${report.totals.total} tests, ok=${report.ok}` +
    (unchanged ? ' (byte-identical to what was there)' : ''),
);
if (!report.ok) {
  warn('this report says the suite is not green — commit it anyway, that is what it is for');
}
