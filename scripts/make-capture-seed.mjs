#!/usr/bin/env node
/**
 * Build the seed the capture script signs in with.
 *
 *   node scripts/make-capture-seed.mjs                    # https://matt.attack.fm
 *   node scripts/make-capture-seed.mjs https://my.hub     # somewhere else
 *
 * Asks for a username and password, exchanges them for a session, and writes
 * `public/__seed.json` - which is gitignored, because it holds a live session
 * and stream token.
 *
 * The password is read from the terminal with echo off, sent once over TLS to
 * the hub's own login, and never written down: not to the seed, not to a log,
 * not to an argument list where `ps` would show it to every user on the
 * machine. Nothing else in the repo ever needs it.
 *
 * The seed also carries the two settings that decide what the capture is
 * ALLOWED to photograph, which is why they live here rather than in the
 * capture script: acquisition plugins are disabled outright, so a private
 * downloader cannot appear in a public shot even if a click goes astray. That
 * is a stronger guarantee than avoiding those screens by hand.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'public/__seed.json');
const HUB = (process.argv[2] || 'https://matt.attack.fm').replace(/\/+$/, '');

/**
 * Every plugin that fetches music, and the two that surface a downloader's
 * furniture. Disabled in the captured app so no shot can contain one.
 * Anything added to plugins-repo that ACQUIRES belongs on this list.
 */
const ACQUISITION = ['audible', 'librivox', 'spotify-import', 'rabbit-hole', 'gig-radar'];

const ask = (prompt, hidden = false) =>
  new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo off: the password must not sit in the scrollback of a terminal
      // that may well be screen-shared while this is being run.
      const out = process.stdout;
      const write = out.write.bind(out);
      out.write = (chunk, ...rest) => (/\n/.test(String(chunk)) ? write(chunk, ...rest) : true);
      rl.question(prompt, (value) => {
        out.write = write;
        out.write('\n');
        rl.close();
        done(value);
      });
      return;
    }
    rl.question(prompt, (value) => {
      rl.close();
      done(value);
    });
  });

const main = async () => {
  console.log(`signing in to ${HUB}`);
  const username = (await ask('username: ')).trim();
  const password = await ask('password: ', true);

  const res = await fetch(`${HUB}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    console.error(`sign-in refused (${res.status}). Nothing written.`);
    process.exit(1);
  }
  const body = await res.json();
  if (!body.token || !body.streamToken) {
    console.error('the hub answered without a session. Nothing written.');
    process.exit(1);
  }

  const seed = {
    session: { url: HUB, token: body.token, streamToken: body.streamToken, user: body.user },
    disabled: ACQUISITION,
    // Dark, and the app's own accent: the site and the shots should look like
    // the product's default rather than like somebody's personal theme.
    appearance: { theme: 'dark' },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(seed, null, 2) + '\n', { mode: 0o600 });
  console.log(`wrote ${OUT} (mode 600, gitignored)`);
  console.log(`signed in as ${body.user?.username ?? username}`);
  console.log('\nnow: node scripts/capture-site-shots.mjs public/__seed.json http://localhost:5240');
  console.log('delete it when the capture is done: rm public/__seed.json');
};

main().catch((error) => {
  console.error('could not build a seed:', error.message);
  process.exit(1);
});
