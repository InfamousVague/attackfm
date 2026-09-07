#!/usr/bin/env node
/**
 * Cut en.json into translation jobs.
 *
 * A job is (chunk of keys) x (one language). Chunks are cut along NAMESPACE
 * boundaries wherever they can be, because a translator - human or otherwise -
 * makes better choices seeing a whole screen's worth of strings together than
 * seeing eighty unrelated ones. "Play" in a bucket of transport controls and
 * "Play" in a bucket of column headings are different words in German, and the
 * only thing that can tell them apart is what sits beside them.
 *
 * PLURAL KEYS ARE EMITTED AS A BASE, not as the English forms. English has
 * _one and _other; Arabic needs six and Japanese one. Handing a translator
 * en.json's two forms invites them to produce two, so the job asks for the
 * base and names the categories that language actually has.
 *
 *   node scripts/i18n-chunks.mjs [keysPerChunk]      default 280
 *   node scripts/i18n-chunks.mjs 280 --write DIR     one JSON per chunk
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SIZE = Number(process.argv[2] ?? 280);
const writeIdx = process.argv.indexOf('--write');
const OUT = writeIdx > 0 ? process.argv[writeIdx + 1] : null;

/** Verified against Intl.PluralRules, not from memory. fr and pt put 0 in
 *  `one` — "0 titre", not "0 titres" — which is exactly the sort of thing a
 *  translator working from English gets wrong. */
export const PLURAL_CATEGORIES = {
  en: ['one', 'other'],
  es: ['one', 'many', 'other'],
  fr: ['one', 'many', 'other'],
  de: ['one', 'other'],
  ja: ['other'],
  pt: ['one', 'many', 'other'],
  zh: ['other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
};

const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') flatten(v, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = v;
  }
  return out;
};

const en = flatten(JSON.parse(readFileSync(join(ROOT, 'src/app/i18n/locales/en.json'), 'utf8')));

// Collapse plural families to one entry carrying the English forms for context.
const units = new Map();
for (const [key, value] of Object.entries(en)) {
  const m = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
  if (m) {
    const base = m[1];
    // A key that exists BOTH bare and pluralised is a bug, not a shape - it
    // means two call sites gave one key two meanings, and i18next silently
    // picks by whether `count` was passed. Fail loudly rather than translate
    // the confusion into seven languages.
    const seen = units.get(base);
    if (seen && !seen.plural) throw new Error(`"${base}" exists both bare and pluralised — split it`);
    if (!seen) units.set(base, { key: base, plural: true, forms: {} });
    units.get(base).forms[m[2]] = value;
  } else {
    const seen = units.get(key);
    if (seen && seen.plural) throw new Error(`"${key}" exists both bare and pluralised — split it`);
    units.set(key, { key, plural: false, en: value });
  }
}

const all = [...units.values()].sort((a, b) => (a.key < b.key ? -1 : 1));

// Cut on a namespace change when the chunk is already at least half full, so
// a namespace stays whole where that is cheap and is split where it is huge.
const chunks = [];
let cur = [];
for (let i = 0; i < all.length; i++) {
  const u = all[i];
  const ns = u.key.split('.')[0];
  const prevNs = cur.length ? cur[cur.length - 1].key.split('.')[0] : ns;
  if (cur.length >= SIZE || (ns !== prevNs && cur.length >= SIZE / 2)) { chunks.push(cur); cur = []; }
  cur.push(u);
}
if (cur.length) chunks.push(cur);

const manifest = chunks.map((c, i) => ({
  i,
  id: `${c[0].key.split('.')[0]}-${i}`,
  n: c.length,
  plurals: c.filter((u) => u.plural).length,
  namespaces: [...new Set(c.map((u) => u.key.split('.')[0]))],
  units: c,
}));

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'chunks.json'), JSON.stringify(manifest));
  console.error(`${manifest.length} chunks · ${all.length} units (${all.filter((u) => u.plural).length} plural) -> ${join(OUT, 'chunks.json')}`);
  console.log(JSON.stringify(manifest.map(({ i, id, n, plurals, namespaces }) => ({ i, id, n, plurals, namespaces }))));
} else {
  console.error(`${manifest.length} chunks · ${all.length} units (${all.filter((u) => u.plural).length} plural)`);
  for (const c of manifest) console.error(`  ${String(c.n).padStart(4)} (${c.plurals} plural)  ${c.id.padEnd(16)} ${c.namespaces.join(', ')}`);
}
