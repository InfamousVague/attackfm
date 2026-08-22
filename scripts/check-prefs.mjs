#!/usr/bin/env node
/**
 * Guards the one thing about synced settings that fails silently.
 *
 * `SYNCED_KEYS` re-types the localStorage key of every setting that follows
 * the account, and each of those strings also exists in the module that owns
 * the setting. Nothing checks the two spellings against each other: a typo in
 * either direction compiles, ships, and simply stops syncing that setting -
 * with no error anywhere, on any device, ever. The failure is invisible until
 * somebody notices their crossfade did not come across.
 *
 * So: every key in SYNCED_KEYS must be written as a literal by some module
 * outside prefsSync. That is not proof the sync works, but it is proof the
 * list names real settings, which is the half that breaks quietly.
 *
 * Also refuses a key stored with a per-thing suffix (`<key>:<serverUrl>`),
 * because the bare key then holds nothing and syncing it is a no-op that
 * looks exactly like success.
 *
 *   node scripts/check-prefs.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const PREFS = join(ROOT, 'src/app/servers/prefsSync.ts');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const source = readFileSync(PREFS, 'utf8');
const block = source.split('export const SYNCED_KEYS')[1]?.split('] as const')[0] ?? '';
const keys = [...block.matchAll(/'(attackfm-[a-z0-9-]+)'/g)].map((m) => m[1]);

if (keys.length === 0) {
  console.error(red('✗ could not read SYNCED_KEYS out of prefsSync.ts'));
  process.exit(1);
}

/** Every line in src that writes this literal, outside prefsSync itself. */
function owners(key) {
  try {
    const out = execFileSync('grep', ['-rl', `'${key}'`, SRC, '--include=*.ts', '--include=*.tsx'], {
      encoding: 'utf8',
    });
    return out.split('\n').filter((f) => f && !f.endsWith('prefsSync.ts'));
  } catch {
    return [];
  }
}

/** Is the key ever used as a PREFIX (`${KEY}:${something}`)? Then the bare key
 *  is not where the value lives. */
function suffixed(key, files) {
  return files.some((file) => {
    const text = readFileSync(file, 'utf8');
    const name = text.match(new RegExp(`const (\\w+) = '${key}'`))?.[1];
    if (!name) return false;
    return new RegExp(`\\$\\{${name}\\}:`).test(text);
  });
}

const orphans = [];
const prefixed = [];
for (const key of keys) {
  const found = owners(key);
  if (found.length === 0) orphans.push(key);
  else if (suffixed(key, found)) prefixed.push(key);
}

const dupes = [...new Set(keys)].filter((k) => keys.filter((x) => x === k).length > 1);

if (orphans.length || prefixed.length || dupes.length) {
  for (const k of orphans) {
    console.error(red(`✗ ${k} is in SYNCED_KEYS but no module writes it — a typo, or a setting that was removed`));
  }
  for (const k of prefixed) {
    console.error(red(`✗ ${k} is stored per-thing as \`${k}:<suffix>\` — the bare key holds nothing, so syncing it does nothing`));
  }
  for (const k of dupes) console.error(red(`✗ ${k} appears twice in SYNCED_KEYS`));
  process.exit(1);
}

console.log(green(`✓ ${keys.length} synced settings, every one owned by a real module`));
