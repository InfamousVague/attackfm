#!/usr/bin/env node
/**
 * Is a translation SAFE to ship?
 *
 * Not "is it good" - nobody here can judge that in seven languages, and
 * pretending otherwise is how a broken app ships with confident-looking
 * Japanese in it. This checks the things that are mechanically checkable and
 * that BREAK THE APP rather than merely reading badly:
 *
 *   placeholders   {{title}} must survive. A dropped one leaves a blank where
 *                  a song's name goes; a renamed one prints "{{titre}}" to a
 *                  listener. Order may change - that is the point of having
 *                  them - but the SET must match the English.
 *   markup         <b>…</b> and <1>…</1> must stay paired, or Trans renders
 *                  the tag as text.
 *   plural forms   exactly the categories that language has, from
 *                  Intl.PluralRules. A missing _other is a key that resolves
 *                  to nothing; an Arabic catalogue with only _one and _other
 *                  is English grammar wearing Arabic words.
 *   coverage       every key English has.
 *
 * It also reports, as a warning rather than an error, entries identical to
 * the English. Some genuinely should be (a brand, "OK", "EQ"); a run of them
 * means an agent gave up on a chunk and copied it.
 *
 *   node scripts/i18n-verify.mjs            every locale
 *   node scripts/i18n-verify.mjs ar         one
 *   node scripts/i18n-verify.mjs --quiet    just the verdict
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(new URL('..', import.meta.url).pathname, 'src/app/i18n/locales');
const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const only = args.find((a) => !a.startsWith('--'));

const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') flat(v, `${p}${k}.`, out);
    else out[`${p}${k}`] = v;
  }
  return out;
};
const read = (f) => flat(JSON.parse(readFileSync(join(DIR, f), 'utf8')));
const SUFFIX = /_(zero|one|two|few|many|other)$/;
const holes = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...String(s).matchAll(/<\/?([\w]+)>/g)].map((m) => m[0]).sort();

/** base -> { forms: {cat: text} | null, en: text } */
function units(map) {
  const out = new Map();
  for (const [k, v] of Object.entries(map)) {
    const m = k.match(SUFFIX);
    const base = m ? k.slice(0, -m[0].length) : k;
    const u = out.get(base) ?? { base, forms: null, plain: null };
    if (m) (u.forms ??= {})[m[1]] = v;
    else u.plain = v;
    out.set(base, u);
  }
  return out;
}

const en = units(read('en.json'));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'en.json' && (!only || f === `${only}.json`)).sort();

let bad = 0;
for (const file of files) {
  const lang = file.replace('.json', '');
  const want = new Intl.PluralRules(lang).resolvedOptions().pluralCategories.slice().sort();
  const got = units(read(file));
  const errs = [];
  let same = 0;

  for (const [base, u] of en) {
    const g = got.get(base);
    if (!g) { errs.push(`MISSING  ${base}`); continue; }

    if (u.forms) {
      const have = Object.keys(g.forms ?? {}).sort();
      if (have.join() !== want.join()) {
        errs.push(`FORMS    ${base}  has [${have.join(', ') || '-'}] wants [${want.join(', ')}]`);
      }
      // The UNION across English's forms, not just `other`. English often
      // interpolates different things per form - `_one` is "Added {{name}}"
      // where `_other` is "Added {{count}} files" - and a translation is
      // entitled to either. Comparing against `other` alone reported every
      // one of those as an unknown placeholder.
      const ref = [...new Set(Object.values(u.forms).flatMap(holes))];
      for (const [cat, text] of Object.entries(g.forms ?? {})) {
        const mine = holes(text);
        // A form may legitimately DROP the count (Arabic "أغنيتان" names two
        // without printing 2) but may not invent a placeholder or misspell one.
        const extra = mine.filter((h) => !ref.includes(h));
        if (extra.length) errs.push(`HOLE     ${base}_${cat}  unknown {{${extra.join('}}, {{')}}}`);
      }
    } else {
      if (g.plain == null) { errs.push(`MISSING  ${base}  (present only as a plural)`); continue; }
      const a = holes(u.plain), b = holes(g.plain);
      if (a.join() !== b.join()) errs.push(`HOLE     ${base}  en[${a.join(', ')}] vs ${lang}[${b.join(', ')}]`);
      const ta = tags(u.plain), tb = tags(g.plain);
      if (ta.join() !== tb.join()) errs.push(`MARKUP   ${base}  en[${ta.join(' ')}] vs ${lang}[${tb.join(' ')}]`);
      if (g.plain === u.plain && /\s/.test(u.plain)) same++;
    }
  }
  const extra = [...got.keys()].filter((k) => !en.has(k));
  for (const k of extra.slice(0, 5)) errs.push(`EXTRA    ${k}`);
  if (extra.length > 5) errs.push(`EXTRA    …and ${extra.length - 5} more`);

  if (errs.length) bad++;
  const pct = Math.round(((en.size - errs.filter((e) => e.startsWith('MISSING')).length) / en.size) * 100);
  console.log(`${lang}  ${String(got.size).padStart(4)}/${en.size} keys (${pct}%)  ${errs.length ? `${errs.length} problem(s)` : 'clean'}${same ? `  · ${same} identical to English` : ''}`);
  if (!quiet) for (const e of errs.slice(0, 25)) console.log(`     ${e}`);
  if (!quiet && errs.length > 25) console.log(`     …and ${errs.length - 25} more`);
}
console.log(bad ? `\n${bad} locale(s) with problems.` : '\nEvery locale checks out.');
process.exit(bad ? 1 : 0);
