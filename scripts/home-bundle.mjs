#!/usr/bin/env node
/**
 * Builds the home-hub install bundle: the server compiled for Apple silicon
 * plus the installer, tarred up to carry to the Mac that has the music drive.
 *
 *   npm run bundle:home
 *
 * The target Mac has no SSH from here, so the deploy path is a file you move
 * by hand (AirDrop, USB, a shared folder) and a script you run there once -
 * re-running the same script on a newer bundle IS the update. Everything the
 * installer needs rides inside; nothing is fetched at install time except the
 * optional Ollama model.
 *
 * Native build, no cross-compiling: this M-series Mac and the server M-series
 * Mac share the aarch64-apple-darwin target.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

const stamp = new Date().toISOString().slice(0, 10);
const NAME = `attackfm-home-${stamp}`;
const OUT = join(ROOT, 'dist-home');
const STAGE = join(OUT, NAME);

console.log('▸ building the server (release, native)');
run('cargo', ['build', '--release', '--manifest-path', join(ROOT, 'server/Cargo.toml')]);

console.log('▸ staging the bundle');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(join(ROOT, 'server/target/release/attackfm-server'), join(STAGE, 'attackfm-server'));
cpSync(join(ROOT, 'server/home-install.sh'), join(STAGE, 'home-install.sh'));
writeFileSync(
  join(STAGE, 'README.txt'),
  [
    `AttackFM home hub — ${stamp}`,
    '',
    'On the server Mac (the one with the music drive):',
    '',
    '  1. copy this whole folder over (AirDrop / USB / shared folder)',
    '  2. open Terminal in it and run:  bash home-install.sh',
    '',
    'First run asks where the music lives and sets the server up as a',
    'login service. Later runs are updates: same command, same answers',
    'remembered, library untouched.',
    '',
  ].join('\n'),
);

console.log('▸ tarring');
run('tar', ['-czf', join(OUT, `${NAME}.tar.gz`), '-C', OUT, NAME]);
console.log(`✓ ${join('dist-home', `${NAME}.tar.gz`)}`);
