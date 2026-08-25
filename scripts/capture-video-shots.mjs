#!/usr/bin/env node
/**
 * Capture a broad set of stills from a real signed-in app, for cutting a video.
 *
 *   node scripts/make-capture-seed.mjs                       # once, to sign in
 *   node scripts/capture-video-shots.mjs public/__seed.json http://localhost:5240
 *
 * Different job from `capture-site-shots.mjs`, which takes the seven images the
 * marketing site embeds and would fail the build if one went missing. This one
 * sweeps the whole app for footage, so:
 *
 *  - it writes to `capture/<timestamp>/`, NOT site/public/shots. A video run
 *    must never overwrite the site's images, which is exactly what happened the
 *    first time this was rehearsed.
 *  - a shot that cannot be reached is SKIPPED and reported, not fatal. A
 *    library without a jam or a transcribed book should still yield the other
 *    twenty-five.
 *  - every shot proves the intended screen is up before the shutter fires. A
 *    screenshot of the wrong screen is worse than a missing one: it is a
 *    missing one you do not find out about.
 *
 * Two shapes, both portrait: the phone, and the big upright screen where Now
 * Playing becomes the whole surface rather than a strip. Dark only - it is what
 * the app is designed around.
 *
 * NOTHING that shows music being acquired may be captured. The seed disables
 * those plugins outright, and the run refuses to start if their words are on
 * screen.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const seedPath = process.argv[2];
const APP = process.argv[3] || 'http://localhost:5240';
if (!seedPath) {
  console.error('usage: capture-site-shots.mjs <seed.json> [devServerUrl]');
  process.exit(1);
}



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


/**
 * Click the first element CONTAINING this text.
 *
 * The site script matches on startsWith, which is right for a plain button and
 * wrong for most of what this run wants: a library chip reads "3 ALL SONGS 3
 * songs", so the words sit in the middle and startsWith never sees them.
 */
const clickByContains = (text, scope = 'button,a,[role=button]') =>
  `(() => {
    const wanted = ${JSON.stringify(text)}.toLowerCase();
    const el = [...document.querySelectorAll(${JSON.stringify(scope)})]
      .find(e => (e.textContent || '').toLowerCase().includes(wanted));
    if (!el) return null;
    el.click();
    return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  })()`;

const OUT_ROOT = resolve(root, 'capture');
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
/** A big screen held upright: >=600 both ways and portrait, which is the shape
 *  that gives Now Playing the whole screen (see npBig in Player.tsx). */
const UNFOLDED = { width: 834, height: 1194, deviceScaleFactor: 2, mobile: true };

/** Is this element on screen and has the app settled? */
const seen = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;
const says = (re) => `${re}.test(document.body.innerText)`;

/**
 * The run, as data.
 *
 * `go` is evaluated to reach the shot and should return something truthy that
 * names what it did; `is` must then be true for the shot to be taken. Keeping
 * them apart is what stops a failed click from photographing whatever happened
 * to be underneath.
 */
const PHONE_SHOTS = [
  { name: 'home', go: `'already here'`, is: says(/listened this week|Playlists/i) },
  { name: 'allSongs', go: clickByContains('All songs'), is: seen('table'), wait: 2800 },
  { name: 'search', go: `(() => {
      const f = document.querySelector('input[type=search], input[placeholder*="Search" i]');
      if (!f) return null;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(f, 'love'); f.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`, is: says(/result|songs|albums/i), wait: 2600 },
  { name: 'books', go: clickByContains('Books', 'a,button,[role=button]'), is: says(/book|shelf|chapter/i), wait: 2600 },
  { name: 'bookPage', go: `(() => {
      const c = document.querySelector('.bookCard, .trackCard');
      if (!c) return null; c.click(); return 'opened';
    })()`, is: says(/chapter/i), wait: 2600 },
  { name: 'discover', go: clickByContains('Discover', 'a,button,[role=button]'), is: says(/discover|for you|station/i), wait: 3000 },
  { name: 'booth', go: clickByContains('Discover', 'a,button,[role=button]'), then: clickByContains('Booth'), is: says(/booth|curator|music date/i), wait: 3000, optional: true },
  { name: 'stats', go: `(() => {
      const l = [...document.querySelectorAll('a,button,[role=button]')].find(e => /^Library$/i.test((e.textContent||'').trim()));
      if (l) l.click(); return 'library';
    })()`, then: clickByText('View all stats'), is: says(/listened this week/i), wait: 3000 },
];

/** Everything that needs music actually playing. */
const PLAYING_SHOTS = [
  { name: 'nowPlaying', go: `'already open'`, is: seen('.npScreen') },
  { name: 'queue', go: clickByLabel('Queue'), is: `!![...document.querySelectorAll('button,[role=button]')].find(e => /close queue/i.test(e.getAttribute('aria-label')||''))`, close: 'Close queue', wait: 2600 },
  { name: 'chapters', go: clickByLabel('Chapters'), is: `!![...document.querySelectorAll('button,[role=button]')].find(e => /close chapters/i.test(e.getAttribute('aria-label')||''))`, close: 'Close chapters', wait: 2600, optional: true },
  { name: 'devices', go: clickByLabel('Playing on'), is: says(/this device|playing on|connect/i), close: 'Close', wait: 2200, optional: true },
];

/** Only a book has these, so the run puts a book on before asking for them. */
const BOOK_SHOTS = [
  { name: 'bookNowPlaying', go: `'already open'`, is: seen('.npScreen'), wait: 2600 },
  { name: 'bookChapters', go: clickByLabel('Chapters'), is: `!![...document.querySelectorAll('button,[role=button]')].find(e => /close chapters/i.test(e.getAttribute('aria-label')||''))`, close: 'Close chapters', wait: 2600, optional: true },
  { name: 'reading', go: `(() => {
      const b = [...document.querySelectorAll('button,[role=button]')]
        .find(e => /read along|words|transcript/i.test((e.getAttribute('aria-label')||'') + ' ' + (e.textContent||'')));
      if (b) b.click();
      return document.querySelector('.npBookWords') ? 'open' : (b ? 'clicked' : null);
    })()`, is: seen('.npBookWords'), wait: 3000, optional: true },
];

const UNFOLDED_SHOTS = [
  { name: 'unfoldedNowPlaying', go: `'shape change'`, is: seen('.npScreen'), wait: 2600 },
  { name: 'unfoldedLibrary', go: clickByContains('Library', 'a,button,[role=button]'), is: says(/Playlists|All songs/i), wait: 2600 },
  { name: 'unfoldedBooks', go: clickByContains('Books', 'a,button,[role=button]'), is: says(/book|chapter/i), wait: 2600, optional: true },
];

let outDir = '';
const taken = [];
const skipped = [];

async function shoot(cdp, session, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session);
  const bytes = Buffer.from(data, 'base64');
  writeFileSync(resolve(outDir, `${name}.png`), bytes);
  taken.push({ name, kb: Math.round(bytes.length / 1024) });
  console.log(`  ✓ ${name}.png (${Math.round(bytes.length / 1024)} kB)`);
}

async function setViewport(cdp, session, vp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...vp, screenWidth: vp.width, screenHeight: vp.height }, session);
}

/** One shot, end to end, and never fatal. */
async function take(cdp, session, shot) {
  try {
    const went = await evaluate(cdp, session, shot.go);
    if (!went) throw new Error('could not reach it');
    await sleep(shot.wait ?? 2200);
    if (shot.then) {
      const second = await evaluate(cdp, session, shot.then);
      if (!second) throw new Error('second step did not land');
      await sleep(shot.wait ?? 2200);
    }
    const right = await evaluate(cdp, session, shot.is);
    if (!right) throw new Error('reached something, but not the intended screen');
    await shoot(cdp, session, shot.name);
    if (shot.close) {
      await evaluate(cdp, session, clickByLabel(shot.close));
      await sleep(700);
    }
    // Belt and braces: a panel whose close control is named something else
    // stays open and the NEXT shot clicks through it. That is how the book
    // pass came to press "Tap to play here" in the device list.
    await evaluate(cdp, session, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`);
    await sleep(400);
  } catch (error) {
    // A library without a jam, a book nobody has transcribed, a panel that moved
    // - none of those should cost the other twenty-five shots.
    skipped.push({ name: shot.name, why: error.message });
    console.log(`  – ${shot.name}: ${error.message}`);
  }
}

const main = async () => {
  const seedPath = process.argv[2];
  const APP = process.argv[3] || 'http://localhost:5240';
  if (!seedPath) {
    console.error('usage: capture-video-shots.mjs <seed.json> [devServerUrl]');
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  outDir = resolve(OUT_ROOT, stamp);
  mkdirSync(outDir, { recursive: true });
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  const { proc, cdp } = await openBrowser();
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);

    await setViewport(cdp, session, PHONE);
    await cdp.send('Page.navigate', { url: APP }, session);
    await sleep(2500);
    await evaluate(cdp, session, `(() => {
      localStorage.setItem('attackfm-server-session', ${JSON.stringify(JSON.stringify(seed.session))});
      localStorage.setItem('attackfm-plugins-disabled', ${JSON.stringify(JSON.stringify(seed.disabled))});
      localStorage.setItem('attackfm-appearance-v2', ${JSON.stringify(JSON.stringify(seed.appearance))});
      return 'ok';
    })()`);
    await cdp.send('Page.navigate', { url: APP }, session);
    await sleep(6000);

    const tracks = await evaluate(cdp, session, `(document.body.innerText.match(/([\\d,]+)\\s+songs/i) || [])[1] || '?'`);
    console.log(`library reports ${tracks} songs`);

    // A private plugin in a public frame is the one unacceptable outcome, so it
    // is asserted rather than trusted to the seed alone.
    const leaked = await evaluate(cdp, session,
      `/spotiflac|spotify import|audible|librivox|downloads/i.test(document.body.innerText)
         ? document.body.innerText.match(/.{0,40}(spotiflac|spotify import|audible|librivox|downloads).{0,40}/i)[0] : ''`);
    if (leaked) throw new Error(`acquisition UI on screen: "${leaked}"`);

    console.log('\nphone');
    for (const shot of PHONE_SHOTS) await take(cdp, session, shot);

    // Put music on, from the song list, then everything that needs it.
    console.log('\nplaying');
    await evaluate(cdp, session, clickByContains('Library', 'a,button,[role=button]'));
    await sleep(1800);
    await evaluate(cdp, session, clickByContains('All songs'));
    await sleep(2800);
    const played = await evaluate(cdp, session, playATrack);
    console.log(`  play: ${played ?? 'nothing'}`);
    await sleep(7000);
    const opened = await evaluate(cdp, session, `(() => {
      const bar = document.querySelector('.playerBarShell');
      if (!bar) return null;
      (bar.querySelector('img')?.closest('div') || bar).click();
      return document.querySelector('.npScreen') ? 'open' : 'clicked';
    })()`);
    console.log(`  now playing: ${opened ?? 'no strip'}`);
    await sleep(2600);
    for (const shot of PLAYING_SHOTS) await take(cdp, session, shot);

    // A book, for the surfaces only a book has.
    console.log('\nbook');
    await evaluate(cdp, session, clickByLabel('Close now playing'));
    await sleep(1200);
    const toBooks = await evaluate(cdp, session, clickByContains('Books', 'a,button,[role=button]'));
    await sleep(2600);
    if (toBooks) {
      await evaluate(cdp, session, `(() => { const c = document.querySelector('.bookCard, .trackCard'); if (c) c.click(); return !!c; })()`);
      await sleep(2600);
      const playedBook = await evaluate(cdp, session, `(() => {
        const el = [...document.querySelectorAll('button,[role=button]')]
          .find(e => /^(play|resume|continue)$/i.test((e.textContent || '').trim()));
        if (!el) return null;
        el.click();
        return (el.textContent || '').trim();
      })()`);
      console.log(`  book: ${playedBook ?? 'nothing to play'}`);
      await sleep(7000);
      await evaluate(cdp, session, `(() => {
        const bar = document.querySelector('.playerBarShell');
        if (bar) (bar.querySelector('img')?.closest('div') || bar).click();
        return !!document.querySelector('.npScreen');
      })()`);
      await sleep(2600);
      for (const shot of BOOK_SHOTS) await take(cdp, session, shot);
    }

    console.log('\nunfolded');
    await setViewport(cdp, session, UNFOLDED);
    // The shape is read at mount, so the app is reloaded into it rather than
    // resized under itself - a resize alone leaves it in the phone's layout.
    await cdp.send('Page.navigate', { url: APP }, session);
    await sleep(6000);
    /*
     * Now Playing only takes the whole screen once something is PLAYING - the
     * shape alone is not enough (see npBig && deckEngaged in Player.tsx). The
     * reload that puts the app into this shape also empties the deck, so the
     * first unfolded shot has to put music back on or it photographs a library
     * page and calls it Now Playing.
     */
    await evaluate(cdp, session, clickByContains('All songs'));
    await sleep(2800);
    await evaluate(cdp, session, playATrack);
    await sleep(7000);
    await evaluate(cdp, session, `(() => {
      if (document.querySelector('.npScreen')) return 'already';
      const bar = document.querySelector('.playerBarShell');
      if (bar) (bar.querySelector('img')?.closest('div') || bar).click();
      return !!document.querySelector('.npScreen');
    })()`);
    await sleep(2600);
    for (const shot of UNFOLDED_SHOTS) await take(cdp, session, shot);

    writeFileSync(resolve(outDir, 'manifest.json'),
      JSON.stringify({ at: stamp, app: APP, hub: seed.session.url, taken, skipped }, null, 2) + '\n');
    console.log(`\n${taken.length} shots in ${outDir}`);
    if (skipped.length) console.log(`${skipped.length} skipped: ${skipped.map((s) => s.name).join(', ')}`);
  } finally {
    proc.kill();
  }
};

main().catch((error) => {
  console.error('capture failed:', error.message);
  process.exit(1);
});
