#!/usr/bin/env node
/**
 * Check every filter recipe against what a server can actually render.
 *
 *   node scripts/check-filters.mjs <seed.json> [serverUrl]
 *
 * This exists because of a real trap. The client's fx vocabulary
 * (src/app/player/fxChain.ts) lists far more node kinds than the deployed
 * encoder implements - 55 against 25 when this was written - and a recipe that
 * names a kind the server does not know applies cleanly, changes nothing, and
 * sounds like a filter that is simply weak. Nothing errors. Nothing logs.
 *
 * So the recipes are checked against a live `GET /api/fx/nodes`, which is the
 * only authority on what the encoder will really do, and every parameter is
 * checked against its published range: the server clamps, but a clamped value
 * is a recipe that does not sound the way it reads.
 *
 * The seed file holds a session token. Pass a path; keep it out of git.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = process.argv[2];
if (!seedPath) {
  console.error('usage: check-filters.mjs <seed.json> [serverUrl]');
  process.exit(1);
}
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const base = (process.argv[3] || seed.session?.url || '').replace(/\/$/, '');
const token = seed.session?.token;
if (!base || !token) {
  console.error('seed needs session.url and session.token');
  process.exit(1);
}

// The recipes are TS; read them as text rather than adding a build step for a
// checker. Each entry is `{ t: 'x', params: { k: n } }`.
const source = readFileSync(resolve(root, 'plugins-repo/filters/filters.ts'), 'utf8');
const recipes = [...source.matchAll(/\{\s*t:\s*'([a-z0-9]+)',\s*params:\s*\{([^}]*)\}\s*\}/g)].map(
  ([, t, body]) => ({
    t,
    params: Object.fromEntries(
      [...body.matchAll(/([a-z]+)\s*:\s*(-?[\d.]+)/g)].map(([, k, v]) => [k, Number(v)]),
    ),
  }),
);
if (recipes.length === 0) {
  console.error('parsed no recipe nodes - has the shape of filters.ts changed?');
  process.exit(1);
}

const response = await fetch(`${base}/api/fx/nodes`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) {
  console.error(`GET ${base}/api/fx/nodes -> ${response.status}`);
  process.exit(1);
}
const payload = await response.json();
const nodes = payload.nodes ?? payload;
const known = new Map(nodes.map((n) => [n.t, n.params ?? {}]));

console.log(`server renders ${known.size} kinds; checking ${recipes.length} recipe nodes\n`);

const problems = [];
// Unknown kinds are no longer a hard failure: the page asks the same endpoint
// and disables any filter this server cannot render, so an old hub shows them
// greyed rather than pretending. Still reported, because it tells you exactly
// what a listener on that server will not be offered.
const unavailable = [];
for (const node of recipes) {
  const spec = known.get(node.t);
  if (!spec) {
    unavailable.push(node.t);
    continue;
  }
  for (const [key, value] of Object.entries(node.params)) {
    const range = spec[key];
    if (!range) {
      problems.push(`"${node.t}" has no parameter "${key}"`);
      continue;
    }
    if (value < range.min || value > range.max) {
      problems.push(`"${node.t}.${key}" = ${value} is outside ${range.min}..${range.max}`);
    }
  }
}

if (unavailable.length) {
  const kinds = [...new Set(unavailable)];
  console.log(`! this server cannot render: ${kinds.join(', ')}`);
  console.log('  filters using them will show as "Needs a newer server" rather than applying silently.');
}

if (problems.length) {
  // A value the server clamps IS still a hard failure: nothing in the UI can
  // detect it, so the filter applies, looks fine, and sounds wrong.
  console.error('✗ ' + problems.length + ' problem(s):');
  for (const p of [...new Set(problems)]) console.error('   ' + p);
  process.exit(1);
}
console.log('✓ every value is in range for the kinds this server implements');
