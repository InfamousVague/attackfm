#!/usr/bin/env node
/**
 * Cut the remaining work into buckets that no two agents can collide on.
 *
 * A bucket is a set of FILES, never a set of findings, because the unit of
 * conflict is the file: two agents editing one file at once will silently lose
 * each other's work no matter how disjoint their string lists are. Files are
 * kept with their neighbours where that is free - a bucket of one directory
 * reads as one job - but the invariant that actually matters is that every
 * file appears in exactly one bucket.
 *
 * Fenced files are excluded outright: another session owns them.
 *
 *   node scripts/i18n-buckets.mjs [target]     default 70 findings per bucket
 */
import { execSync } from 'node:child_process';

const TARGET = Number(process.argv[2] ?? 70);
const FENCED = new Set(['src/app/App.tsx', 'src/app/player/PlayerHost.tsx']);

const scan = JSON.parse(execSync('node scripts/i18n-scan.mjs --json', {
  cwd: new URL('..', import.meta.url).pathname,
  maxBuffer: 64 * 1024 * 1024,
}).toString());

const HARD = new Set(['plural', 'ternary', 'interleaved', 'template']);

const files = scan.files
  .filter((f) => f.findings.length && !FENCED.has(f.file))
  .map((f) => ({
    file: f.file,
    dir: f.file.split('/').slice(0, -1).join('/'),
    n: f.findings.length,
    hard: f.findings.filter((x) => HARD.has(x.kind.split(':')[0])).length,
  }))
  // Directory order keeps related files together; size order within it puts
  // the heavy file at the head of its bucket rather than straddling two.
  .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : b.n - a.n));

const buckets = [];
let cur = null;
for (const f of files) {
  // A single file over target gets a bucket to itself rather than dragging a
  // neighbour into a job that is already too big.
  if (f.n >= TARGET) { buckets.push({ files: [f], n: f.n, hard: f.hard }); continue; }
  if (!cur || cur.n + f.n > TARGET || cur.files[0].dir.split('/')[2] !== f.dir.split('/')[2]) {
    cur = { files: [], n: 0, hard: 0 };
    buckets.push(cur);
  }
  cur.files.push(f); cur.n += f.n; cur.hard += f.hard;
}

const out = buckets.filter((b) => b.files.length).map((b, i) => ({
  id: `${b.files[0].dir.replace(/^src\/(app\/|plugins\/)?/, '').replace(/\//g, '-') || 'root'}-${i}`,
  count: b.n,
  hard: b.hard,
  files: b.files.map((f) => f.file),
}));

const seen = new Set();
for (const b of out) for (const f of b.files) {
  if (seen.has(f)) throw new Error(`file in two buckets: ${f}`);
  seen.add(f);
}

console.error(`${out.length} buckets · ${out.reduce((s, b) => s + b.count, 0)} findings · ${seen.size} files · largest ${Math.max(...out.map((b) => b.count))}`);
console.log(JSON.stringify(out));
