#!/usr/bin/env node
/**
 * Fold a pass's keys into en.json.
 *
 * The sweep is done by many agents at once, and the one thing they must not
 * share is a file. So no agent writes the catalogue: each REPORTS the keys it
 * introduced, and they are merged here, once, in one place that can see all of
 * them at the same time. That is what makes a collision - the same key claimed
 * twice with two different English strings - a thing the tool tells you about
 * rather than a thing the last writer wins silently.
 *
 *   node scripts/i18n-merge.mjs keys.json          merge (refuses on collision)
 *   node scripts/i18n-merge.mjs keys.json --force  take the new text on collision
 *   node scripts/i18n-merge.mjs keys.json --locale ar   merge a TRANSLATION
 *   node scripts/i18n-merge.mjs --unused           keys no source file mentions
 *
 * keys.json is a flat object: { "settings.crossfade": "Crossfade", … }
 *
 * --locale merges into that language instead of English. A translation is
 * allowed to carry plural forms English does not have (Arabic's _zero, _two,
 * _few, _many) and to omit ones it has no use for (Japanese has only _other),
 * so those are NOT treated as drift - see the parity check in i18n-scan.mjs.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const LOCALES = join(ROOT, 'src/app/i18n/locales');
const args0 = process.argv.slice(2);
const LOCALE = args0.includes('--locale') ? args0[args0.indexOf('--locale') + 1] : 'en';
const EN = join(LOCALES, `${LOCALE}.json`);

const load = () => JSON.parse(readFileSync(EN, 'utf8'));

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

/** Rebuild the nested shape, with each level's keys in sorted order so the
 *  file's diff shows what CHANGED rather than where an agent happened to
 *  append. Plural variants sort next to their base, which is what you want to
 *  read. */
function nest(flat) {
  const out = {};
  for (const key of Object.keys(flat).sort()) {
    const parts = key.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) {
      if (typeof node[p] !== 'object' || node[p] === null) node[p] = {};
      node = node[p];
    }
    node[parts[parts.length - 1]] = flat[key];
  }
  return out;
}

const args = args0;

// ------------------------------------------------------------------- unused
if (args.includes('--unused')) {
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e)) files.push(full);
    }
  })(join(ROOT, 'src'));
  const haystack = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const keys = Object.keys(flatten(load()));
  // A plural key is referenced by its BASE ('library.songCount'), never by
  // 'library.songCount_one' - i18next appends the suffix itself.
  const unused = keys
    .map((k) => k.replace(/_(zero|one|two|few|many|other)$/, ''))
    .filter((k, i, a) => a.indexOf(k) === i)
    .filter((k) => !haystack.includes(`'${k}'`) && !haystack.includes(`"${k}"`) && !haystack.includes(`\`${k}\``));
  console.log(unused.length ? `${unused.length} key(s) no source file mentions:\n  ${unused.join('\n  ')}` : 'Every key is referenced.');
  process.exit(0);
}

// -------------------------------------------------------------------- merge
const file = args.filter((a) => !a.startsWith('--')).find((a) => a !== LOCALE);
if (!file) {
  console.error('usage: i18n-merge.mjs <keys.json> [--force]   |   --unused');
  process.exit(2);
}

const incoming = JSON.parse(readFileSync(file, 'utf8'));
const current = flatten(load());
const force = args.includes('--force');

const added = [];
const same = [];
const collisions = [];
for (const [key, en] of Object.entries(incoming)) {
  if (typeof en !== 'string') { console.error(`  skipped non-string ${key}`); continue; }
  if (!(key in current)) { current[key] = en; added.push(key); }
  else if (current[key] === en) same.push(key);
  else { collisions.push({ key, was: current[key], now: en }); if (force) current[key] = en; }
}

if (collisions.length) {
  console.log(`\n${collisions.length} COLLISION(S) — same key, different English:`);
  for (const c of collisions) console.log(`  ${c.key}\n    have: ${JSON.stringify(c.was)}\n    new:  ${JSON.stringify(c.now)}`);
  if (!force) {
    console.log('\nNothing written. Resolve them, or re-run with --force to take the new text.');
    process.exit(1);
  }
  console.log('\n--force: took the new text.');
}

writeFileSync(EN, JSON.stringify(nest(current), null, 2) + '\n');
console.log(`${LOCALE}.json: +${added.length} new, ${same.length} already identical, ${Object.keys(current).length} total`);
