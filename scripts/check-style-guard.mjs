/**
 * Does the style guard actually put a missing stylesheet back?
 *
 *   npm run check:styles
 *
 * WHY THIS EXISTS. A guard for this was added in 0.3.190 and could not work:
 * it answered a missing stylesheet by adding a second <link> to the URL that
 * had just failed, which fails again for whatever reason the first one did. It
 * only ever helped if the boot loader had not tried, and the loader always
 * tries. That shipped believed-fixed for eighteen versions, because the symptom
 * is intermittent and nobody re-ran the guard against the failure it was
 * written for. A fix that cannot work is worse than no fix: it closes the
 * question.
 *
 * So this stages the actual failure - a bundle's app.js with its app.css gone -
 * and asserts on the thing a person would look at, which is whether the rules
 * are in effect afterwards, not whether some element was added.
 *
 * NOT wired into `npm run ship`, deliberately. Booting Chrome on every publish
 * puts a new failure mode on the one path that has to stay trustworthy, and the
 * first time it broke for an unrelated reason somebody would pass a flag and it
 * would never run again. Run it by hand when you touch styleGuard.ts.
 *
 * No dependencies: Node ships a global WebSocket, Chrome speaks CDP over it.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.attack.fm';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

const say = (m) => console.log(m);
const die = (m) => {
  console.error(`\x1b[31m✗\x1b[0m ${m}`);
  process.exit(1);
};

if (!CHROME) die('no Chrome found; this check drives one over CDP');

/**
 * Build the bundle this run will test, into a directory the script owns.
 *
 * It used to read `dist/` and merely assert app.js existed. That produced a
 * confident RED against a stale tree - a leftover dist from an earlier version
 * carries the OLD styleGuard, so the check correctly reports that the old guard
 * does not work while appearing to report on the current one. Somebody then
 * goes hunting a bug that is not there.
 *
 * Which is precisely the disease this whole file exists to catch, one layer
 * out: an instrument that answers confidently about something it did not
 * measure. A precondition you report on is a precondition somebody skips, so
 * this removes it instead - the two seconds are worth not having to trust the
 * state of a directory.
 *
 * AFM_OTA=1 because that is what ships. The plain build splits assets and the
 * OTA build inlines them into exactly app.js + app.css, which is the shape the
 * device's loader deals with and therefore the shape the guard must handle.
 */
async function buildBundle() {
  const out = await mkdtemp(join(tmpdir(), 'afm-styleguard-build-'));
  say('  building the OTA bundle to test (AFM_OTA=1)…');
  await new Promise((ok, no) => {
    const vite = spawn(
      'npx',
      ['vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: ROOT, env: { ...process.env, AFM_OTA: '1' }, stdio: 'inherit' },
    );
    vite.on('exit', (code) => (code === 0 ? ok() : no(new Error(`vite build exited ${code}`))));
    vite.on('error', no);
  });
  if (!existsSync(join(out, 'assets', 'app.js'))) {
    die('the build produced no assets/app.js');
  }
  return join(out, 'assets');
}

/** Serve one directory, and report which paths were actually asked for. */
function serve(dir) {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const file = join(dir, path === '/' ? 'index.html' : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      // A 404 here is the POINT for app.css, not a problem with the harness.
      res.writeHead(404).end('nope');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/** One CDP round trip on a fresh tab, returning whatever the page evaluates. */
async function evaluateInPage(port, url, expression) {
  const made = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const target = await made.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => no(new Error('CDP socket refused')), { once: true });
  });
  const answer = new Promise((ok, no) => {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== 1) return;
      if (msg.error) return no(new Error(msg.error.message));
      if (msg.result?.exceptionDetails) return no(new Error(msg.result.exceptionDetails.text));
      ok(msg.result?.result?.value);
    });
    setTimeout(() => no(new Error('page never answered')), 45_000);
  });
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
  const value = await answer;
  ws.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  return value;
}

/**
 * The assertion, run inside the page.
 *
 * Deliberately checks COMPUTED STYLE on a class the app actually uses, rather
 * than that some element was appended. `.fxShelf__list` is the row Matt
 * reported: unstyled it is a bulleted block, styled it is a flex column with no
 * marker. That is the difference a person sees, so that is what gets asserted.
 */
const PROBE = `(async () => {
  const deadline = Date.now() + 30000;
  const probe = () => {
    const ul = document.createElement('ul');
    ul.className = 'fxShelf__list';
    document.body.appendChild(ul);
    const s = getComputedStyle(ul);
    const live = s.listStyleType === 'none' && s.display === 'flex';
    ul.remove();
    return live;
  };
  while (Date.now() < deadline) {
    if (document.body && probe()) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const tag = document.querySelector('style[data-afm-recovered]');
  return JSON.stringify({
    rulesLive: document.body ? probe() : false,
    source: tag ? tag.dataset.afmRecovered : null,
    bytes: tag ? tag.textContent.length : 0,
  });
})()`;

/** Stage a bundle directory, with or without its stylesheet beside app.js. */
async function stage(built, withCss, version) {
  const dir = await mkdtemp(join(tmpdir(), 'afm-styleguard-'));
  await mkdir(join(dir, 'assets'));
  await copyFile(join(built, 'app.js'), join(dir, 'assets', 'app.js'));
  if (withCss) await copyFile(join(built, 'app.css'), join(dir, 'assets', 'app.css'));
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">` +
      // What the embedded boot loader sets, and what the published fallback
      // reads to make sure it never pairs new CSS with older JS.
      `<script>window.__afmBundleVersion=${JSON.stringify(version)};</script>` +
      // Stands in for the stale embedded sheet the loader keeps when the
      // bundle's own stylesheet fails - the other half of the half-update.
      `<style data-afm-embedded>body{background:#111}</style>` +
      `</head><body><div id="root"></div>` +
      `<script type="module" crossorigin src="./assets/app.js"></script></body></html>`,
    'utf8',
  );
  return dir;
}

// --- the two cases ----------------------------------------------------------

const profile = await mkdtemp(join(tmpdir(), 'afm-chrome-'));
const port = 9333;
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ],
  { stdio: 'ignore' },
);

const cleanup = [];
let failed = false;

try {
  const built = await buildBundle();
  cleanup.push(dirname(built));

  // Wait for the debugger to answer rather than sleeping a guessed interval.
  for (let i = 0; ; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      if (i > 100) die('Chrome never opened its debugging port');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // The published fallback only accepts CSS belonging to THIS version, so the
  // check asks the registry what is live rather than hard-coding a version
  // that would rot the moment anybody ships.
  let liveVersion = null;
  try {
    const res = await fetch(`${REGISTRY}/v1/app/bundle`);
    if (res.ok) liveVersion = (await res.json()).version ?? null;
  } catch {
    // Offline: the local case below still runs and is the important one.
  }

  const cases = [
    {
      name: 'app.css beside app.js — recovered from the device',
      withCss: true,
      version: liveVersion ?? '0.0.0',
      want: 'local',
    },
    {
      name: 'app.css missing — recovered from the published bundle',
      withCss: false,
      version: liveVersion,
      want: 'published',
      needsNetwork: true,
    },
  ];

  for (const c of cases) {
    if (c.needsNetwork && !liveVersion) {
      say(`\x1b[33m•\x1b[0m skipped (registry unreachable): ${c.name}`);
      continue;
    }
    const dir = await stage(built, c.withCss, c.version);
    cleanup.push(dir);
    const server = await serve(dir);
    const url = `http://127.0.0.1:${server.address().port}/`;
    const raw = await evaluateInPage(port, url, PROBE);
    server.close();
    const got = JSON.parse(raw);

    if (!got.rulesLive) {
      say(`\x1b[31m✗\x1b[0m ${c.name}`);
      say(`    .fxShelf__list has no rules behind it — this is the reported bug`);
      say(`    recovered from: ${got.source ?? 'nothing'}`);
      failed = true;
    } else if (got.source !== c.want) {
      say(`\x1b[31m✗\x1b[0m ${c.name}`);
      say(`    rules are live but came from "${got.source}", expected "${c.want}"`);
      failed = true;
    } else {
      // The PROVENANCE is the proof, not the size. An OTA build inlines
      // everything, so the local file and the published one are the same
      // number of bytes and a size comparison would prove nothing about which
      // route the recovery actually took.
      say(`\x1b[32m✓\x1b[0m ${c.name} — from ${got.source} (${got.bytes.toLocaleString()} bytes)`);
    }
  }
} finally {
  // Wait for Chrome to actually be gone before clearing its profile. Removing
  // it while the process is still flushing raced ENOTEMPTY and threw from the
  // finally block, which swallowed the result the run had just produced - a
  // harness that can hide its own verdict is worse than no harness.
  chrome.kill();
  await new Promise((done) => {
    if (chrome.exitCode !== null) return done();
    chrome.once('exit', done);
    setTimeout(done, 5000);
  });
  for (const dir of [...cleanup, profile]) {
    // Never fatal: the temp files are the least important thing here, and a
    // failure to tidy them must not change whether the check passed.
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

if (failed) die('the style guard did not restore the stylesheet');
say('\x1b[32m✓\x1b[0m the style guard restores a missing stylesheet by both routes');
