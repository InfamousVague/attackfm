#!/usr/bin/env node
/**
 * WHAT IS STILL IN ENGLISH — the instrument.
 *
 * "Every hard-coded string is translated" is a claim, and a claim about 449
 * files is worth exactly as much as the tool that can check it. This parses
 * every .ts and .tsx under src/ with the TypeScript compiler's own parser and
 * reports the string literals sitting where a user can READ them.
 *
 * IT CLASSIFIES, because the work is not uniform. A `<Text>Liked</Text>` is a
 * mechanical edit; `{n} {n === 1 ? 'song' : 'songs'}` is a grammar decision
 * that has to be made once and made right; a label in a module-level `const`
 * array is a trap, because it is evaluated at import and can never follow a
 * language change no matter how the call site is written. Those three need
 * three different passes, so they are counted separately:
 *
 *   jsx-text       text between tags
 *   prop           a visible prop's literal (label=, placeholder=, aria-label=)
 *   ts-field       a display field in a .ts object literal
 *   ts-const       a module-scope `const` holding a whole sentence
 *   toast          a message handed to toast()/notify()
 *   plural         `n === 1 ? 'song' : 'songs'` - English grammar as code
 *   ternary        a two-branch string choice that is not a count
 *   template       a template literal with a hole in it
 *   interleaved    a sentence built from text and {expressions} as siblings
 *   frozen         any of the above at MODULE SCOPE - the trap above
 *
 * WHAT IT REFUSES TO GUESS. A prop is on the visible list or it is not; a
 * .ts field name is on the display list or it is not. There is no cleverness
 * about whether `id="liked"` might be shown. Two consequences worth knowing:
 * it OVER-counts slightly where a visible prop carries something technical,
 * and it cannot see a string assembled by a helper it does not recognise. It
 * is a floor with a known shape, not a census.
 *
 *   node scripts/i18n-scan.mjs                 the score, and where the work is
 *   node scripts/i18n-scan.mjs --list          every finding, file:line
 *   node scripts/i18n-scan.mjs --kind plural   one category
 *   node scripts/i18n-scan.mjs --file X        one file
 *   node scripts/i18n-scan.mjs --work-list     the fan-out plan, as JSON
 *   node scripts/i18n-scan.mjs --keys         every t('…') in source resolves
 *   node scripts/i18n-scan.mjs --catalogues    every language has every key
 *   node scripts/i18n-scan.mjs --json          the whole thing, for a diff
 *   node scripts/i18n-scan.mjs --max 1200      fail if the count went UP
 *
 * The last one is the ratchet. Total coverage is not a state you reach, it is
 * one you hold: every new screen arrives with new English in it, and without a
 * number that can only go down, a finished sweep quietly comes undone over the
 * following month. Wire it into CI with today's count and lower it as passes
 * land.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

/** Props whose value a user reads. Anything not here is assumed technical. */
const VISIBLE_PROPS = new Set([
  'label', 'title', 'placeholder', 'alt', 'heading', 'subtitle', 'caption',
  'description', 'summary', 'hint', 'help', 'error', 'empty', 'emptyText',
  'tooltip', 'confirm', 'cancel', 'confirmLabel', 'cancelLabel', 'submitLabel',
  'aria-label', 'aria-description', 'aria-roledescription', 'aria-placeholder',
  'aria-valuetext', 'message', 'text', 'note', 'header', 'footer',
  'legend', 'action', 'actionLabel', 'primaryLabel', 'secondaryLabel',
  'kicker', 'eyebrow', 'blurb', 'body', 'prompt', 'question', 'answer',
]);

/**
 * Object-literal keys that hold display text in a .ts module. Narrower than
 * VISIBLE_PROPS on purpose: `name` and `text` are far more likely to be an
 * identifier in a plain data file than in JSX, and a false positive here
 * sends somebody to translate a protocol string.
 */
const DISPLAY_FIELDS = new Set([
  'label', 'title', 'heading', 'subtitle', 'caption', 'description', 'summary',
  'hint', 'help', 'blurb', 'placeholder', 'tooltip', 'message', 'body', 'note',
  'empty', 'emptyText', 'error', 'confirmLabel', 'cancelLabel', 'actionLabel',
  'kicker', 'eyebrow', 'legend', 'question', 'answer',
]);

/** Functions whose first string argument is shown to somebody. */
const SPEAKING_CALLS = new Set(['toast', 'notify', 'alert', 'confirm', 'say']);

/**
 * NOT PROSE. These are matched on, sent over a wire, or written to disk, and
 * translating one does not change what the user reads - it breaks the app,
 * silently, in a language nobody on the team is testing in.
 *
 * Every entry here was checked. The rule that produced the list: if any code
 * anywhere COMPARES the string, it is an identifier wearing a label's clothes.
 */
const DENY_FILES = [
  'src/app/api/',              // request shapes and header names
  'src/app/core/tauri.ts',     // command names
  'src/app/diag/',             // developer log lines, never surfaced
];
const DENY_SUBSTRINGS = [
  'artist:', 'genre:', 'unplayed',   // station filter syntax (stations.rs)
  'Charts', 'New music',             // folder AND playlist names, matched on
];

/**
 * Things that live in a string but are not language.
 *
 * A class list, a selector, a transition, a catalogue key being CHOSEN between,
 * and the app's own name. Every one of these was a finding the scanner was
 * reporting and a human then had to dismiss - and a checker whose output you
 * learn to skim is worse than no checker, because the real one hides in it.
 */
const cssish = (s) =>
  /var\(--|\w__\w|\w--\w/.test(s) ||        // BEM, custom properties
  /^[.#[]/.test(s) ||                          // a selector
  /^[a-z-]+ [\d.]+m?s\b/.test(s) ||           // "transform 0.22s ease-out"
  s === 'none';

/** 'library.greetingEvening' - a key, not a string. Choosing between two of
 *  them at a call site is the CORRECT shape, not a finding. */
const looksLikeKey = (s) => /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/.test(s);

/** Never translated: it is the product's name in every language. */
const BRANDS = new Set(['AttackFM', 'Attack FM']);

function looksTranslatable(raw) {
  const s = raw.trim();
  if (s.length < 2) return false;
  if (!/[A-Za-z]/.test(s)) return false;                 // "—", "•", "3"
  if (/^https?:|^\/|^\.\/|^#|^--|^data:/.test(s)) return false;
  if (/:\/\//.test(s)) return false;                    // a URL anywhere in it
  if (/^\(.*:.*\)/.test(s)) return false;               // a media query
  if (/^[a-z0-9-]+$/.test(s) && !s.includes(' ')) return false;  // "liked"
  if (/^[A-Z0-9_]+$/.test(s)) return false;              // SCREAMING_CONSTANT
  if (/^[a-z]+([A-Z][a-z]*)+$/.test(s)) return false;    // camelCaseIdentifier
  if (DENY_SUBSTRINGS.includes(s)) return false;
  if (BRANDS.has(s)) return false;
  if (cssish(s) || looksLikeKey(s)) return false;
  return true;
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const denied = (rel) => DENY_FILES.some((d) => rel.startsWith(d)) || rel.startsWith('src/app/i18n/');

function scanFile(file) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  let translated = 0;
  const seen = new Set();

  const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  /** Is this node outside every function - i.e. evaluated once, at import? */
  const atModuleScope = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) ||
          ts.isArrowFunction(p) || ts.isMethodDeclaration(p) ||
          ts.isGetAccessor(p) || ts.isConstructorDeclaration(p)) return false;
    }
    return true;
  };

  const lines = text.split('\n');
  /**
   * An escape hatch, spelled out rather than hidden in this file's deny-list.
   *
   * Some English is protocol - a section name the server also sends, a value
   * something compares with === - and the scanner cannot tell that by looking
   * at the string. Writing `i18n-ignore` on the line, or the line above it,
   * says so AT THE STRING, where the next reader is, instead of in a list
   * over here that nobody will find.
   */
  const ignored = (line) =>
    (lines[line - 1] ?? '').includes('i18n-ignore') || (lines[line - 2] ?? '').includes('i18n-ignore');

  const add = (node, kind, value) => {
    const line = at(node);
    if (ignored(line)) return;
    const clean = String(value).trim().replace(/\s+/g, ' ');
    const key = `${line}:${kind}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ line, kind, frozen: atModuleScope(node), value: clean });
  };

  const strLit = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n : null;

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const fn = node.expression;
      const name = ts.isIdentifier(fn) ? fn.text
        : ts.isPropertyAccessExpression(fn) ? fn.name.text : '';
      if (name === 't' || name === 'translate') translated++;
      if (SPEAKING_CALLS.has(name)) {
        const a0 = node.arguments[0];
        const lit = strLit(a0);
        if (lit && looksTranslatable(lit.text)) add(node, 'toast', lit.text);
        if (a0 && ts.isTemplateExpression(a0)) add(node, 'toast', a0.getText(sf));
      }
    }

    // `n === 1 ? 'song' : 'songs'` and its cousins.
    if (ts.isConditionalExpression(node)) {
      const a = strLit(node.whenTrue), b = strLit(node.whenFalse);
      // Judged per branch: the joined "a | b" is not a string anybody reads,
      // and a class list joined to another class list is not prose twice.
      const branches = [a, b].filter(Boolean).map((n) => n.text).filter((x) => x.trim());
      if (a && b && branches.some((x) => looksTranslatable(x))) {
        const cond = node.condition.getText(sf);
        const plural = /[=!]==?\s*1\b|\b1\s*[=!]==?|\.length\b|\bcount\b/i.test(cond);
        add(node, plural ? 'plural' : 'ternary', `${a.text} | ${b.text}`);
      }
    }

    if (ts.isJsxText(node) && looksTranslatable(node.text)) add(node, 'jsx-text', node.text);

    // A sentence assembled from siblings: text, {value}, more text.
    if (ts.isJsxElement(node)) {
      const kids = node.children;
      const words = kids.filter((k) => ts.isJsxText(k) && /[A-Za-z]{2}/.test(k.text));
      const holes = kids.filter((k) => ts.isJsxExpression(k) && k.expression &&
        !ts.isStringLiteral(k.expression));
      if (words.length && holes.length) add(node, 'interleaved', words.map((w) => w.getText(sf).trim()).join(' … '));
    }

    if (ts.isJsxAttribute(node) && node.initializer) {
      const prop = node.name.getText(sf);
      if (VISIBLE_PROPS.has(prop)) {
        const init = node.initializer;
        const inner = ts.isJsxExpression(init) ? init.expression : init;
        const lit = strLit(inner);
        if (lit && looksTranslatable(lit.text)) add(node, `prop:${prop}`, lit.text);
        else if (inner && ts.isTemplateExpression(inner)) add(node, 'template', inner.getText(sf));
      }
    }

    /*
     * A sentence living in a bare `export const`.
     *
     * SMART_SHUFFLE_LABEL got through an entire sweep hiding in one of these:
     * not a JSX attribute, not a display field in an object, just a const with
     * a sentence in it that was handed to an aria-label two files away.
     * Nothing about the SHAPE says user-visible, so this leans entirely on
     * looksTranslatable and additionally demands a SPACE - which is most of
     * what separates a sentence from an identifier.
     */
    if (ts.isVariableDeclaration(node) && node.initializer && atModuleScope(node)) {
      const lit = strLit(node.initializer);
      if (lit && lit.text.trim().includes(' ') && looksTranslatable(lit.text)) {
        add(node, 'ts-const', lit.text);
      }
    }

    // Display fields in plain object literals - the .ts half of the problem.
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
        ? node.name.text : null;
      if (key && DISPLAY_FIELDS.has(key)) {
        const lit = strLit(node.initializer);
        if (lit && looksTranslatable(lit.text)) add(node, `ts-field:${key}`, lit.text);
        else if (ts.isTemplateExpression(node.initializer)) add(node, 'template', node.initializer.getText(sf).slice(0, 120));
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { rel, findings, translated };
}

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);

// ---------------------------------------------------------------- catalogues
function checkCatalogues() {
  const dir = join(SRC, 'app/i18n/locales');
  const flat = (obj, prefix = '', out = new Set()) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') flat(v, `${prefix}${k}.`, out);
      else out.add(`${prefix}${k}`);
    }
    return out;
  };
  // Plural suffixes are SUPPOSED to differ: Japanese has no `_one`, Arabic has
  // four forms English has no use for. Comparing raw keys would report that as
  // drift and train everybody to ignore the check.
  const stem = (keys) => new Set([...keys].map((k) => k.replace(/_(zero|one|two|few|many|other)$/, '')));
  const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const en = stem(flat(read('en.json')));
  let bad = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const keys = flat(read(f));
    const missing = [...en].filter((k) => !stem(keys).has(k));
    const extra = [...stem(keys)].filter((k) => !en.has(k));
    const forms = [...keys].filter((k) => /_(zero|one|two|few|many|other)$/.test(k)).length;
    if (missing.length || extra.length) bad++;
    console.log(`  ${f.padEnd(9)} ${String(keys.size).padStart(4)} keys, ${String(forms).padStart(3)} plural forms` +
      (missing.length ? `  MISSING ${missing.length}: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}` : '') +
      (extra.length ? `  EXTRA ${extra.length}: ${extra.slice(0, 6).join(', ')}${extra.length > 6 ? '…' : ''}` : ''));
  }
  console.log(bad ? `\n${bad} catalogue(s) out of step with en.json` : '\nEvery catalogue matches en.json.');
  return bad;
}
if (flag('--catalogues')) { console.log('Catalogues:'); process.exit(checkCatalogues() ? 1 : 0); }

/**
 * Does every key the source asks for actually exist?
 *
 * This is the check that matters most, and the one a type system cannot make:
 * `t('settings.crossfaed')` compiles, ships, and puts a raw key on somebody's
 * screen. It is also exactly the mistake a large parallel sweep produces -
 * an agent converts a call site, reports the key, and a typo or a dropped
 * entry means the two never meet.
 *
 * Matched on the BASE key: i18next appends _one/_other itself, so a source
 * reference to 'library.songCount' is satisfied by 'library.songCount_other'.
 */
if (flag('--keys')) {
  const dir = join(SRC, 'app/i18n/locales');
  const flat = (obj, prefix = '', out = new Set()) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') flat(v, `${prefix}${k}.`, out);
      else out.add(`${prefix}${k}`);
    }
    return out;
  };
  const have = new Set([...flat(JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8')))]
    .map((k) => k.replace(/_(zero|one|two|few|many|other)$/, '')));

  const asked = new Map();   // key -> [file:line]
  for (const file of walkFiles(SRC)) {
    const rel = relative(ROOT, file);
    if (rel.startsWith('src/app/i18n/')) continue;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      // t('a.b'), translate('a.b'), i18nKey="a.b", labelKey: 'a.b'
      const re = /(?:\bt|\btranslate)\(\s*['"`]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)['"`]|i18nKey=["'`]([a-zA-Z0-9_.]+)["'`]|[A-Za-z]*[Kk]ey:\s*['"`]([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)['"`]/g;
      let m;
      while ((m = re.exec(line))) {
        const key = m[1] ?? m[2] ?? m[3];
        if (!asked.has(key)) asked.set(key, []);
        asked.get(key).push(`${rel}:${i + 1}`);
      }
    });
  }

  const missing = [...asked.keys()].filter((k) => !have.has(k)).sort();
  console.log(`${asked.size} keys referenced in source, ${have.size} in en.json`);
  if (missing.length) {
    console.log(`\n${missing.length} REFERENCED BUT MISSING — these render as a raw key:`);
    for (const k of missing.slice(0, 60)) console.log(`  ${k}   ${asked.get(k)[0]}`);
    if (missing.length > 60) console.log(`  … and ${missing.length - 60} more`);
  } else {
    console.log('\nEvery key the source asks for exists.');
  }
  process.exit(missing.length ? 1 : 0);
}

// ---------------------------------------------------------------------- scan
const only = val('--file');
const kindWanted = val('--kind');
const files = only ? [join(ROOT, only)] : walkFiles(SRC);

const rows = [];
let total = 0, done = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  if (denied(rel) && !only) continue;
  const scanned = scanFile(file);
  const { translated } = scanned;
  let findings = scanned.findings;
  if (kindWanted) findings = findings.filter((f) => f.kind.startsWith(kindWanted));
  total += findings.length;
  done += translated;
  if (findings.length || translated) rows.push({ file: rel, findings, translated });
}
rows.sort((a, b) => b.findings.length - a.findings.length);

const byKind = {};
const byArea = {};
const unique = new Set();
for (const r of rows) {
  const area = r.file.split(sep).slice(0, 3).join('/');
  for (const f of r.findings) {
    const k = f.frozen ? `${f.kind} (frozen)` : f.kind;
    byKind[k] = (byKind[k] ?? 0) + 1;
    unique.add(f.value);
  }
  byArea[area] = (byArea[area] ?? 0) + r.findings.length;
}

if (flag('--json')) {
  console.log(JSON.stringify({ total, unique: unique.size, translated: done, byKind, byArea, files: rows }, null, 2));
} else if (flag('--work-list')) {
  // One entry per area, biggest first — the fan-out plan.
  const plan = Object.entries(byArea).sort((a, b) => b[1] - a[1]).map(([area, count]) => ({
    area,
    count,
    files: rows.filter((r) => r.file.startsWith(area + '/') || r.file === area)
      .filter((r) => r.findings.length)
      .map((r) => ({ file: r.file, n: r.findings.length })),
  })).filter((a) => a.count > 0);
  console.log(JSON.stringify(plan, null, 2));
} else if (flag('--list') || only || kindWanted) {
  for (const r of rows) {
    if (!r.findings.length) continue;
    console.log(`\n${r.file}  (${r.findings.length})`);
    for (const f of r.findings) {
      console.log(`  ${String(f.line).padStart(4)}  ${(f.kind + (f.frozen ? '*' : '')).padEnd(20)} ${f.value.slice(0, 110)}`);
    }
  }
  console.log(`\n${total} hard-coded (${unique.size} unique), ${done} translated`);
} else if (val('--max') !== null) {
  const max = Number(val('--max'));
  const ok = total <= max;
  console.log(`${total} hard-coded, ceiling ${max} — ${ok ? 'ok' : 'REGRESSED'}`);
  if (!ok) {
    console.log('\nWorst files:');
    for (const r of rows.slice(0, 10)) if (r.findings.length) console.log(`  ${String(r.findings.length).padStart(4)}  ${r.file}`);
  }
  process.exit(ok ? 0 : 1);
} else {
  const pct = total + done ? Math.round((done / (total + done)) * 100) : 100;
  console.log(`i18n: ${done} translated, ${total} hard-coded (${unique.size} unique)  —  ${pct}%\n`);
  console.log('By kind:');
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
  console.log('\nBy area:');
  for (const [a, n] of Object.entries(byArea).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${a}`);
  }
}
