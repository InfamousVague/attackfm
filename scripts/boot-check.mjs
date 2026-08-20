/**
 * Does the bundle we just built actually START?
 *
 * Every other check in ship-update.mjs is about the SHAPE of a release: the
 * version goes forward, the tree is pushed, the two files are self-contained,
 * both doors serve them. Not one of them ever runs the thing. 0.3.252 and
 * 0.3.253 both went to devices as a black screen - a hook called from App's
 * own body reaching for a context App itself provides - and every check passed
 * on both, because "cannot start" and "fine" are identical from the outside.
 *
 * So this loads the built bundle in a real browser and asks the only question
 * the others cannot: is there anything on the screen. It runs BEFORE the
 * upload rather than after, because a guard that tells you what you have
 * already sent to a phone is a post-mortem, not a guard.
 *
 * What it does NOT do is judge the app. A bundle with no server to talk to
 * throws all sorts of things and still boots to the sign-in screen, which is a
 * perfectly good boot - so failed requests and console noise are reported and
 * never fatal. The one fatal condition is an empty root: React rendering
 * nothing is exactly and only what this class of bug looks like.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Where a browser might be. CHROME_PATH wins, for anyone who keeps it elsewhere. */
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/**
 * Boot `distDir/index.html` and report what happened.
 *
 * Returns `{ skipped }` when there is no browser to do it with - a machine
 * without Chrome should not be unable to publish, for the same reason an
 * unreachable registry does not block one. Otherwise `{ ok, rootChildren,
 * text, errors }`.
 */
export async function bootCheck(distDir, { port = 9412, settleMs = 6000 } = {}) {
  const bin = findBrowser();
  if (!bin) return { skipped: 'no Chrome, Chromium or Edge found (set CHROME_PATH to point at one)' };

  const index = join(distDir, 'index.html');
  if (!existsSync(index)) return { ok: false, errors: [`no index.html in ${distDir}`], rootChildren: -1, text: '' };

  // The profile goes to a temp dir, NOT into dist. Anything this leaves behind
  // in dist is a file the upload would find and the self-contained check has
  // already signed off on - a guard must not add to what it is guarding.
  const profile = mkdtempSync(join(tmpdir(), 'afm-boot-'));

  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--user-data-dir=${profile}`,
    // The bundle is one file loading another beside it, off the disk.
    '--allow-file-access-from-files',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
    }
    if (!target) return { ok: false, errors: ['the browser never came up'], rootChildren: -1, text: '' };

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    const thrown = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        thrown.push(String(d?.exception?.description ?? d?.text ?? '').split('\n')[0].slice(0, 200));
      }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) =>
      new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

    await send('Runtime.enable');
    await send('Page.enable');
    // Before any of the app's own script, so a throw during boot is caught by
    // the hook rather than only by whatever happens to be listening later.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__boot={errors:[]};
        addEventListener('error', e => __boot.errors.push(String(e.message||e.error)));
        addEventListener('unhandledrejection', e => __boot.errors.push('rejection: '+String(e.reason)));`,
    });
    await send('Page.navigate', { url: `file://${index}` });
    await sleep(settleMs);

    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const root = document.getElementById('root');
        return {
          rootChildren: root ? root.children.length : -1,
          text: root ? root.innerText.trim().slice(0, 120).replace(/\\s+/g, ' ') : '',
          errors: (window.__boot?.errors ?? []).slice(0, 6),
        };
      })()`,
    });
    const v = r.result?.result?.value ?? { rootChildren: -1, text: '', errors: [] };
    const errors = [...new Set([...v.errors, ...thrown])];

    // The whole assertion: React put something on the screen. Everything else
    // is context for reading a failure, never a reason to call one.
    return { ok: v.rootChildren > 0 && v.text.length > 0, rootChildren: v.rootChildren, text: v.text, errors };
  } finally {
    try { ws?.close(); } catch { /* already gone */ }
    proc.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
