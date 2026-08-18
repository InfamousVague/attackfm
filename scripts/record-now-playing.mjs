#!/usr/bin/env node
/**
 * Record the Now Playing screen for the length of a whole song.
 *
 *   node scripts/record-now-playing.mjs <seed.json> [devServerUrl]
 *
 * Produces site/public/video/now-playing.{mp4,webm} plus a poster frame. The
 * point of a full song rather than a loop of a few seconds is that the seek bar
 * visibly crosses the whole track and the disc keeps turning, which a short clip
 * cannot show honestly.
 *
 * NO AUDIO IS RECORDED, deliberately. The video ships on a public page, and the
 * sound would be a copyrighted master. Everything the clip is for is visual.
 *
 * Frames come from CDP's screencast, which pushes a frame whenever the page
 * paints; each must be acked or the stream stalls after a few frames.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'site/public/video');
const FRAMES = '/tmp/afm-frames';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9355;
const FPS = 12;

const seedPath = process.argv[2];
const APP = process.argv[3] || 'http://localhost:5240';
if (!seedPath) {
  console.error('usage: record-now-playing.mjs <seed.json> [devServerUrl]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CDP client with event listeners as well as id-matched replies. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
        return;
      }
      const handler = this.handlers.get(msg.method);
      if (handler) handler(msg.params, msg.sessionId);
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
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
      '--user-data-dir=/tmp/afm-record-profile',
      '--no-first-run',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      // The page must keep painting while nothing is in the foreground.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 60; i += 1) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
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

const evaluate = async (cdp, session, expression) => {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  if (exceptionDetails) {
    // exceptionDetails.text is just 'Uncaught'; the useful message is on
    // the exception object itself.
    const detail = exceptionDetails.exception?.description || exceptionDetails.text;
    throw new Error(detail);
  }
  return result.value;
};

const clickText = (t) => `
  (() => {
    const el = [...document.querySelectorAll('button,a,[role=button]')]
      .find(e => (e.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(t)}.toLowerCase()));
    if (!el) return null;
    el.click();
    return (el.textContent || '').trim().slice(0, 40);
  })()
`;

const main = async () => {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  const { proc, cdp } = await openBrowser();
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 },
      session,
    );

    await cdp.send('Page.navigate', { url: APP }, session);
    await sleep(2500);
    await evaluate(
      cdp,
      session,
      `(() => {
        localStorage.setItem('attackfm-server-session', ${JSON.stringify(JSON.stringify(seed.session))});
        localStorage.setItem('attackfm-plugins-disabled', ${JSON.stringify(JSON.stringify(seed.disabled))});
        localStorage.setItem('attackfm-appearance-v2', ${JSON.stringify(JSON.stringify(seed.appearance))});
        return 1;
      })()`,
    );
    await cdp.send('Page.navigate', { url: APP }, session);
    await sleep(5000);

    // A different playlist from the one the stills came from, so the clip is
    // not the same record the hero already shows.
    console.log('playlist:', await evaluate(cdp, session, clickText('Library')) && await evaluate(cdp, session, clickText('2020s station')));
    await sleep(3000);
    console.log('play:', await evaluate(cdp, session, clickText('Play')));
    await sleep(4500);

    await evaluate(
      cdp,
      session,
      `(() => {
        const bar = document.querySelector('.playerBarShell');
        const art = bar && bar.querySelector('img');
        (art?.closest('div') || bar)?.click();
        return 1;
      })()`,
    );
    await sleep(2500);

    // How long the song is.
    //
    // NOT from the audio element: the server streams without a Content-Length
    // the media element can use, so `duration` comes back Infinity or NaN and an
    // earlier version of this silently recorded a 30-second stub. The app prints
    // an elapsed and a remaining clock, and it gets those from the track
    // metadata, so their sum is the real length.
    let track = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      track = await evaluate(
        cdp,
        session,
        `(() => {
          const np = document.querySelector('.npScreen');
          if (!np) return null;
          const clocks = (np.innerText || '').match(/-?\\d+:\\d\\d/g) || [];
          const secs = (t) => {
            const [m, s] = t.replace('-', '').split(':').map(Number);
            return m * 60 + s;
          };
          const elapsed = clocks.find((c) => !c.startsWith('-'));
          const remaining = clocks.find((c) => c.startsWith('-'));
          const audio = [...document.querySelectorAll('audio')].find((a) => a.src);
          return {
            title: (np.innerText || '').split('\\n').filter(Boolean)[0] || '',
            elapsed: elapsed ? secs(elapsed) : 0,
            remaining: remaining ? secs(remaining) : 0,
            playing: audio ? !audio.paused : false,
          };
        })()`,
      );
      // Wait for the clock to actually be running, not just present at 0:00.
      if (track && track.remaining > 0 && track.playing) break;
      await sleep(1000);
    }
    if (!track) throw new Error('Now Playing never opened');
    if (!track.remaining) throw new Error('the Now Playing clock never showed a remaining time');

    // A couple of seconds past the end, so the bar is seen filling completely.
    const seconds = Math.min(track.remaining + 3, 420);
    const total = track.elapsed + track.remaining;
    console.log(`recording "${track.title}" (${total}s track) for ${seconds}s at ${FPS}fps`);

    let saved = 0;
    let lastKept = 0;
    const minGap = 1000 / FPS;
    cdp.on('Page.screencastFrame', async (params, sid) => {
      // Ack first: an unacked frame stops the stream after a handful.
      cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sid).catch(() => {});
      const now = Date.now();
      if (now - lastKept < minGap) return;
      lastKept = now;
      writeFileSync(`${FRAMES}/f${String(saved).padStart(5, '0')}.jpg`, Buffer.from(params.data, 'base64'));
      saved += 1;
    });

    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 }, session);
    const started = Date.now();
    while (Date.now() - started < seconds * 1000) {
      await sleep(2000);
      if (saved && saved % 120 === 0) process.stdout.write(`\r  frames: ${saved}   `);
    }
    await cdp.send('Page.stopScreencast', {}, session);
    console.log(`\n  captured ${saved} frames`);
    if (saved < FPS * 10) throw new Error(`only ${saved} frames captured; the screencast stalled`);

    // Encode. No audio track at all, by construction: the inputs are stills.
    const enc = (args) => {
      const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '));
    };
    const common = ['-y', '-framerate', String(FPS), '-i', `${FRAMES}/f%05d.jpg`, '-an'];
    enc([...common, '-vf', 'scale=560:-2', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
         '-crf', '30', '-preset', 'slow', '-movflags', '+faststart', resolve(OUT, 'now-playing.mp4')]);
    enc([...common, '-vf', 'scale=560:-2', '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0',
         '-row-mt', '1', resolve(OUT, 'now-playing.webm')]);
    // A poster so the frame is never empty before the video decodes.
    enc(['-y', '-i', `${FRAMES}/f00000.jpg`, '-frames:v', '1', '-update', '1', '-vf', 'scale=560:-2', resolve(OUT, 'now-playing-poster.jpg')]);

    console.log('\nwrote', OUT);
  } finally {
    proc.kill();
    rmSync(FRAMES, { recursive: true, force: true });
  }
};

main().catch((e) => {
  console.error('recording failed:', e.message);
  process.exit(1);
});
