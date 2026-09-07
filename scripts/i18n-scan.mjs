#!/usr/bin/env node
/**
 * WHAT IS STILL IN ENGLISH.
 *
 * "Every hard-coded string is translated" is a claim, and a claim about 446
 * files is worth exactly as much as the tool that can check it. This is that
 * tool: it parses every TSX file with the TypeScript compiler's own parser and
 * reports the string literals sitting in positions a user can READ.
 *
 * It looks in two places, because those are the two ways a string reaches a
 * screen:
 *
 *   - JSX text        <Text>Liked Songs</Text>
 *   - visible props   <Button label="Play" />, aria-label, placeholder, alt...
 *
 * WHAT IT DELIBERATELY DOES NOT DO is guess. A prop is either on the visible
 * list or it is not; there is no cleverness about whether `id="liked"` might
 * be shown. That makes the number an OVER-count in one narrow way - a visible
 * prop occasionally carries something technical - and an UNDER-count in a
 * broader one: a string built in a .ts helper and handed to a component is
 * invisible here. So treat the output as a floor with a known shape, not a
 * census. It is still the only honest way to watch the number go down.
 *
 *   node scripts/i18n-scan.mjs            summary + the worst files
 *   node scripts/i18n-scan.mjs --list     every finding, file:line
 *   node scripts/i18n-scan.mjs --json     for a diff between two runs
 *   node scripts/i18n-scan.mjs --file X   one file
 *   node scripts/i18n-scan.mjs --catalogues   every language has every key
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

/** Props whose value a user reads. Anything not here is assumed technical. */
const VISIBLE_PROPS = new Set([
  'label', 'title', 'placeholder', 'alt', 'heading', 'subtitle', 'caption',
  'description', 'summary', 'hint', 'help', 'error', 'empty', 'emptyText',
  'tooltip', 'confirm', 'cancel', 'confirmLabel', 'cancelLabel', 'submitLabel',
  'aria-label', 'aria-description', 'aria-roledescription', 'aria-placeholder',
  'aria-valuetext', 'message', 'text', 'note', 'name', 'header', 'footer',
  'legend', 'action', 'actionLabel', 'primaryLabel', 'secondaryLabel',
]);

/**
 * A string with no letters is punctuation or a number and needs no
 * translation; one with no lowercase AND no space is very likely a constant.
 * Everything else counts.
 */
function looksTranslatable(raw) {
  const s = raw.trim();
  if (s.length < 2) return false;
  if (!/[A-Za-z]/.test(s)) return false;          // "—", "•", "3"
  if (/^https?:|^\/|^\.\/|^#|^--/.test(s)) return false; // urls, paths, tokens
  if (/^[a-z0-9-]+$/.test(s) && !s.includes(' ')) return false; // "liked", "top-bar"
  if (/^[A-Z0-9_]+$/.test(s)) return false;       // SCREAMING_CONSTANT
  return true;
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function scanFile(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  let translated = 0;

  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (node, kind, value) => findings.push({ line: at(node), kind, value: value.trim().replace(/\s+/g, ' ') });

  const visit = (node) => {
    // Already done: every t(...) call is a string that has been dealt with.
    if (ts.isCallExpression(node)) {
      const fn = node.expression;
      const name = ts.isIdentifier(fn) ? fn.text : ts.isPropertyAccessExpression(fn) ? fn.name.text : '';
      if (name === 't') translated++;
    }

    if (ts.isJsxText(node) && looksTranslatable(node.text)) {
      add(node, 'jsx-text', node.text);
    }

    if (ts.isJsxAttribute(node) && node.initializer) {
      const propName = node.name.getText(sf);
      if (VISIBLE_PROPS.has(propName)) {
        const init = node.initializer;
        const lit =
          ts.isStringLiteral(init) ? init
          : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression) ? init.expression
          : ts.isJsxExpression(init) && init.expression && ts.isNoSubstitutionTemplateLiteral(init.expression) ? init.expression
          : null;
        if (lit && looksTranslatable(lit.text)) add(node, `prop:${propName}`, lit.text);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { findings, translated };
}

/**
 * Does every language have every key?
 *
 * Compared on the key with its plural suffix REMOVED, because the suffixes are
 * supposed to differ: Japanese has no `_one` (the language does not count that
 * way) and Arabic has `_zero`, `_two`, `_few` and `_many` that English has no
 * use for. Comparing raw keys would report all of that as drift and train
 * everybody to ignore the check.
 */
function checkCatalogues() {
  const dir = join(SRC, 'app/i18n/locales');
  const flat = (obj, prefix = '', out = new Set()) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') flat(v, `${prefix}${k}.`, out);
      else out.add(`${prefix}${k}`);
    }
    return out;
  };
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
    console.log(
      `  ${f.padEnd(9)} ${String(keys.size).padStart(3)} keys, ${forms} plural forms` +
      (missing.length ? `  MISSING ${missing.join(', ')}` : '') +
      (extra.length ? `  EXTRA ${extra.join(', ')}` : ''),
    );
  }
  console.log(bad ? `\n${bad} catalogue(s) out of step with en.json` : '\nEvery catalogue matches en.json.');
  return bad;
}

const args = process.argv.slice(2);
if (args.includes('--catalogues')) {
  console.log('Catalogues:');
  process.exit(checkCatalogues() ? 1 : 0);
}
const only = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const files = only ? [join(ROOT, only)] : walkFiles(SRC);

const rows = [];
let total = 0, done = 0;
for (const file of files) {
  const { findings, translated } = scanFile(file);
  total += findings.length;
  done += translated;
  if (findings.length || translated) rows.push({ file: relative(ROOT, file), findings, translated });
}
rows.sort((a, b) => b.findings.length - a.findings.length);

if (args.includes('--json')) {
  console.log(JSON.stringify({ total, translated: done, files: rows }, null, 2));
} else if (args.includes('--list') || only) {
  for (const r of rows) {
    if (!r.findings.length) continue;
    console.log(`\n${r.file}  (${r.findings.length})`);
    for (const f of r.findings) console.log(`  ${String(f.line).padStart(4)}  ${f.kind.padEnd(18)} ${f.value}`);
  }
  console.log(`\n${total} hard-coded, ${done} translated`);
} else {
  const pct = total + done ? Math.round((done / (total + done)) * 100) : 100;
  console.log(`i18n: ${done} translated, ${total} hard-coded  (${pct}% of visible strings in TSX)\n`);
  console.log('Worst files:');
  for (const r of rows.slice(0, 25)) {
    if (!r.findings.length) continue;
    console.log(`  ${String(r.findings.length).padStart(4)}  ${r.file}`);
  }
}
