#!/usr/bin/env node
/**
 * Capture the screenshots the marketing site uses, from a real signed-in app.
 *
 *   node scripts/capture-site-shots.mjs <seed.json> [devServerUrl]
 *
 * The app has no URL routing - every view is React state - so the shots are
 * driven by clicking, exactly as a person would. That makes this script the
 * only repeatable record of HOW each capture was produced; re-shooting after a
 * UI change is running it again rather than remembering a sequence of taps.
 *
 * The seed file holds a session token and is NEVER read into this file's output
 * or its logs. Pass a path; keep the file out of git.
 *
 * Chrome is driven directly over CDP with node's built-in WebSocket, so this
 * needs no puppeteer/playwright install.
 *
 * NOTHING that shows music being acquired may be captured - the importer is a
 * private plugin. The seed disables those plugins outright, which is a stronger
 * guarantee than avoiding their screens by hand.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'site/public/shots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const seedPath = process.argv[2];
const APP = process.argv[3] || 'http://localhost:5240';
if (!seedPath) {
  console.error('usage: capture-site-shots.mjs <seed.json> [devServerUrl]');
  process.exit(1);
}

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client: one socket, id-matched replies, flat sessions. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function openBrowser() {
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      // A throwaway profile, so this never touches the real Chrome session.
      `--user-data-dir=/tmp/afm-shots-profile`,
      '--no-first-run',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  // Poll for the debugger rather than guessing a fixed delay.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const info = await res.json();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((ok, bad) => {
        ws.addEventListener('open', ok, { once: true });
        ws.addEventListener('error', bad, { once: true });
      });
      return { proc, cdp: new Cdp(ws) };
    } catch {
      await sleep(250);
    }
  }
  proc.kill();
  throw new Error('Chrome debugger never came up');
}

/** Evaluate in the page and return the JS value. */
async function evaluate(cdp, session, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' :: ' + expression.slice(0, 120));
  return result.value;
}

/**
 * Click the first element whose trimmed text matches, optionally within a scope.
 * Returns what it clicked so a failed step is obvious in the log rather than
 * producing a screenshot of the wrong screen.
 */
const clickByText = (text, scope = 'button,a,[role=button]') => `
  (() => {
    const wanted = ${JSON.stringify(text)}.toLowerCase();
    const el = [...document.querySelectorAll(${JSON.stringify(scope)})]
      .find(e => (e.textContent || '').trim().toLowerCase().startsWith(wanted));
    if (!el) return null;
    el.click();
    return (el.textContent || '').trim().slice(0, 60);
  })()
`;

/** Click by aria-label/title - what the transport and panel buttons expose. */
const clickByLabel = (label) => `
  (() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const el = [...document.querySelectorAll('button,[role=button]')]
      .find(e => ((e.getAttribute('aria-label') || e.getAttribute('title') || '').toLowerCase()) === wanted);
    if (!el) return null;
    el.click();
    return wanted;
  })()
`;

/** Start a track playing from the All-songs list. */
const playATrack = `
  (() => {
    const rows = [...document.querySelectorAll('tr[class*=interactiveRow]')];
    // A mid-list track rather than the first: more representative artwork, and
    // it proves the list actually scrolled real data in.
    const row = rows[12] || rows[0];
    if (!row) return null;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    row.click();
    return (row.textContent || '').trim().slice(0, 50);
  })()
`;

/** Open the full Now Playing screen by tapping the player bar's artwork. */
const openNowPlaying = `
  (() => {
    const bar = document.querySelector('.playerBarShell');
    if (!bar) return null;
    const art = bar.querySelector('img');
    (art?.closest('div') || bar).click();
    return document.querySelector('.npScreen') ? 'open' : 'clicked';
  })()
`;

async function shoot(cdp, session, name) {
  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    session,
  );
  const file = resolve(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  const kb = Math.round(Buffer.from(data, 'base64').length / 1024);
  console.log(`  ✓ ${name}.png (${kb} kB)`);
}

async function setViewport(cdp, session, vp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...vp, screenWidth: vp.width, screenHeight: vp.height }, session);
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  const { proc, cdp } = await openBrowser();
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);

    // Seed on the app's own origin, then reload into a signed-in app.
    await setViewport(cdp, session, PHONE);
    await cdp.send('Page.navigate', { url: APP }, session);
    await sleep(2500);
    await evaluate(
      cdp,
      session,
      `(() => {
        localStorage.setItem('attackfm-server-session', ${JSON.stringify(JSON.stringify(seed.session))});
        localStorage.setItem('attackfm-plugins-disabled', ${JSON.stringify(JSON.stringify(seed.disabled))});
        localStorage.setItem('attackfm-appearance-v2', ${JSON.stringify(JSON.stringify(seed.appearance))});
        return 'ok';
      })()`,
    );
    await cdp.send('Page.navigate', { url: APP }, session);
    await sleep(5000);

    const who = await evaluate(cdp, session, `JSON.parse(localStorage.getItem('attackfm-server-session')||'{}').username || 'anon'`);
    console.log(`signed in as ${who}`);

    // A private plugin appearing in a public shot is the one unacceptable
    // outcome, so it is asserted rather than assumed.
    const leaked = await evaluate(
      cdp,
      session,
      `/spotiflac|spotify import|downloads/i.test(document.body.innerText) ? document.body.innerText.match(/.{0,40}(spotiflac|spotify import|downloads).{0,40}/i)[0] : ''`,
    );
    if (leaked) throw new Error(`Acquisition UI visible on the first screen: "${leaked}"`);

    console.log('\nphone captures');
    await shoot(cdp, session, 'home');

    // The song list.
    console.log('  ' + (await evaluate(cdp, session, clickByText('All songs'))));
    await sleep(2800);
    await shoot(cdp, session, 'library');

    // Play a PLAYLIST, not a single track. Double-clicking one row leaves Up
    // Next empty, and an empty-state queue is a poor advert for a queue.
    await evaluate(cdp, session, clickByText('Library'));
    await sleep(1800);
    console.log('  playlist: ' + (await evaluate(cdp, session, clickByText('Chill Hits'))));
    await sleep(3000);
    console.log('  play: ' + (await evaluate(cdp, session, clickByText('Play'))));
    // Up Next is filled from the playing context asynchronously.
    await sleep(9000);
    console.log('  now playing: ' + (await evaluate(cdp, session, openNowPlaying)));
    await sleep(2500);
    await shoot(cdp, session, 'nowPlaying');

    // Each panel has an explicit "Close <panel>" control. Toggling the opener a
    // second time did NOT close it, so the queue sheet stayed on top and the
    // next panel opened behind it - producing three shots of the same sheet.
    // Queue goes last: it fills from the playing context a few seconds after
    // Play, and an empty Up Next is a poor advert for a queue.
    for (const [label, name, wait] of [
      ['Lyrics', 'lyrics', 3000],
      // The equaliser is deliberately NOT captured: its popover surfaces the
      // in-progress "HiFi chain" work, and a marketing page should not be the
      // announcement of a feature that has not shipped.
      ['Queue', 'queue', 3000],
    ]) {
      const hit = await evaluate(cdp, session, clickByLabel(label));
      if (!hit) throw new Error(`no ${label} button on the Now Playing screen`);
      await sleep(wait);

      // Prove the intended panel is actually the one on screen. Its own close
      // control only exists while it is open, which makes this exact rather
      // than a guess from pixels.
      const open = await evaluate(
        cdp,
        session,
        `!![...document.querySelectorAll('button,[role=button]')].find(
           e => (e.getAttribute('aria-label') || '').toLowerCase() === ${JSON.stringify('close ' + label.toLowerCase())})`,
      );
      if (!open) throw new Error(`${label} did not open (no "Close ${label.toLowerCase()}" control)`);
      console.log(`  ${label}: open`);

      await shoot(cdp, session, name);
      await evaluate(cdp, session, clickByLabel('Close ' + label.toLowerCase()));
      await sleep(1000);
    }

    await evaluate(cdp, session, clickByLabel('Close now playing'));
    await sleep(1200);

    // The Booth.
    console.log('  ' + (await evaluate(cdp, session, clickByText('Booth'))));
    await sleep(4000);
    await shoot(cdp, session, 'booth');

    // Listening stats live behind "View all stats" on the library page. The
    // Profile TAB is not this: with no registry account signed in it shows an
    // account-creation form, complete with a password field - which is not a
    // thing to put on a marketing page.
    await evaluate(cdp, session, clickByText('Library'));
    await sleep(1800);
    const stats = await evaluate(cdp, session, clickByText('View all stats'));
    if (!stats) throw new Error('no "View all stats" button on the library page');
    await sleep(3200);
    const isStats = await evaluate(cdp, session, `/listened this week/i.test(document.body.innerText)`);
    if (!isStats) throw new Error('stats page did not open');
    await shoot(cdp, session, 'stats');

    console.log('\ndesktop captures');
    await setViewport(cdp, session, DESKTOP);
    await sleep(1800);
    await evaluate(cdp, session, clickByText('Library'));
    await sleep(2000);
    await shoot(cdp, session, 'desktop');

    // An album, open on the desktop layout.
    await evaluate(
      cdp,
      session,
      `(() => {
        const card = [...document.querySelectorAll('button,a,[role=button]')]
          .find(e => /2020s station|Chill Hits|FlyLo/i.test((e.textContent || '')));
        if (card) card.click();
        return card ? 'opened' : null;
      })()`,
    );
    await sleep(3000);
    await shoot(cdp, session, 'desktopAlbum');

    console.log(`\nwrote to ${OUT}`);
  } finally {
    proc.kill();
  }
};

main().catch((error) => {
  console.error('capture failed:', error.message);
  process.exit(1);
});
