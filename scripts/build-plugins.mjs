#!/usr/bin/env node
/**
 * Builds every plugin under plugins-repo/ into publishable bundles plus the
 * repository manifest the app's marketplace reads.
 *
 *   node scripts/build-plugins.mjs          # -> dist-plugins/
 *
 * Each plugin directory holds a plugin.json (id, name, version, flags) and an
 * entry exporting `createPlugin()`. The build compiles the entry with esbuild
 * into a single IIFE whose exports land on `AttackFMPluginExport` - the name
 * the app's evaluator returns out of its Function scope.
 *
 * The interesting part is imports. A plugin is compiled against the same
 * specifiers the in-tree code used - `react`, `@glacier/react`,
 * `@attackfm/app/*` - but none of those may be BUNDLED: a second React cannot
 * share hooks with the app's, and the app seam only exists at runtime. So a
 * resolver plugin maps each of those specifiers to a generated shim that reads
 * `globalThis.__ATTACKFM_HOST__.modules[...]`. ESM shims need static export
 * names, so the build first scans the plugin's sources for what it actually
 * imports from each host module and emits exactly those names.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(ROOT, 'plugins-repo');
const OUT = join(ROOT, 'dist-plugins');
// The public repository (plugins.attack.fm) carries only plugins whose
// plugin.json declares `"public": true` - the official, lawyer-calm set.
// Everything builds into OUT; the public subset is COPIED here with its own
// manifest, so the two repos can never disagree about a bundle's bytes.
const OUT_PUBLIC = join(ROOT, 'dist-plugins-public');

/** Built bundles speak host API 1; the app refuses anything newer than its own. */
const HOST_API = 1;

/** The specifiers resolved through the host at runtime rather than bundled. */
const HOST_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  '@glacier/react',
  '@glacier/icons',
  '@attackfm/app/tauri',
  '@attackfm/app/platform',
  '@attackfm/app/importsBridge',
  '@attackfm/app/openExternal',
  '@attackfm/app/library',
  '@attackfm/app/nowPlaying',
  '@attackfm/app/librarySync',
  '@attackfm/app/serverSession',
  '@attackfm/app/deckHold',
  '@attackfm/app/playlists',
  '@attackfm/app/equalizer',
  '@attackfm/app/fxChain',
  '@attackfm/app/importServer',
]);

/**
 * Scans a plugin's sources for the names it imports from each host module, so
 * the shims can export them statically. Namespace imports and defaults are
 * handled by the shim regardless; this only has to find the braces.
 */
function importedNames(dir) {
  const names = new Map(); // specifier -> Set of names
  for (const file of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    const importRe = /import\s+(type\s+)?(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*'([^']+)'/g;
    for (const match of source.matchAll(importRe)) {
      const [, typeOnly, , braces, specifier] = match;
      if (typeOnly || !HOST_MODULES.has(specifier)) continue;
      const set = names.get(specifier) ?? new Set();
      for (const piece of (braces ?? '').split(',')) {
        const name = piece.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
        // A brace list can carry type-only entries; they are erased anyway,
        // and exporting an extra const from the shim is harmless.
        if (name) set.add(name);
      }
      names.set(specifier, set);
    }
  }
  // jsx: the automatic runtime imports these behind the scenes.
  const jsx = names.get('react/jsx-runtime') ?? new Set();
  for (const n of ['jsx', 'jsxs', 'Fragment', 'jsxDEV']) jsx.add(n);
  names.set('react/jsx-runtime', jsx);
  return names;
}

/** The esbuild resolver that turns host modules into global lookups. */
function hostShimPlugin(names) {
  return {
    name: 'attackfm-host-shims',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (HOST_MODULES.has(args.path)) {
          return { path: args.path, namespace: 'attackfm-host' };
        }
        return null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: 'attackfm-host' }, (args) => {
        const wanted = [...(names.get(args.path) ?? [])];
        const lines = [
          `const m = globalThis.__ATTACKFM_HOST__?.modules?.[${JSON.stringify(args.path)}];`,
          `if (!m) throw new Error(${JSON.stringify(`host module missing: ${args.path}`)});`,
          `export default m?.default ?? m;`,
        ];
        if (wanted.length > 0) {
          lines.push(`export const { ${wanted.join(', ')} } = m;`);
        }
        return { contents: lines.join('\n'), loader: 'js' };
      });
    },
  };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
rmSync(OUT_PUBLIC, { recursive: true, force: true });
mkdirSync(OUT_PUBLIC, { recursive: true });

const listings = [];
for (const entry of readdirSync(REPO, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(REPO, entry.name);
  // A plugin that cannot build is skipped, loudly, and the rest publish: a
  // half-scaffolded directory (another session mid-write, a missing file)
  // must never block the whole repository from shipping a finished fix.
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    // Retired: kept in the tree, offered to nobody. A plugin that stops
    // earning its place should leave the marketplace without leaving the
    // repository - the source stays readable and one flag brings it back,
    // where deleting the directory would make "bring it back" an exercise in
    // git archaeology. Nothing is built and no manifest lists it, so the
    // publish below (which mirrors with --delete) takes its bundle off the
    // boxes too.
    if (meta.retired) {
      console.log(`skipped ${meta.id} (retired)`);
      continue;
    }
    // The version lives in TWO places - plugin.json (which names the file and
    // the manifest) and the Plugin object in index.tsx (which the app shows in
    // the marketplace). They drift silently: an edit to one looks like it
    // worked, the bundle ships under one number and reports another, and a
    // device that already has the plugin sees no reason to refetch. Caught
    // here, once, rather than in a marketplace card three deploys later.
    const entrySource = existsSync(join(dir, 'index.tsx'))
      ? readFileSync(join(dir, 'index.tsx'), 'utf8')
      : '';
    const declared = entrySource.match(/version:\s*'([^']+)'/)?.[1];
    if (declared && declared !== meta.version) {
      throw new Error(
        `${meta.id}: plugin.json says ${meta.version} but index.tsx says ${declared}. ` +
          `Make them agree - the file is named from plugin.json and the card reads index.tsx.`,
      );
    }

    const outFile = `${meta.id}-${meta.version}.js`;

    await build({
      entryPoints: [join(dir, meta.entry)],
      bundle: true,
      format: 'iife',
      globalName: 'AttackFMPluginExport',
      outfile: join(OUT, outFile),
      minify: true,
      sourcemap: false,
      jsx: 'automatic',
      logLevel: 'error',
      loader: { '.png': 'dataurl' },
      plugins: [hostShimPlugin(importedNames(dir))],
    });

    const code = readFileSync(join(OUT, outFile));
    listings.push({
      id: meta.id,
      name: meta.name,
      version: meta.version,
      description: meta.description,
      author: meta.author,
      tags: meta.tags,
      entry: outFile,
      api: HOST_API,
      bytes: code.length,
      sha256: createHash('sha256').update(code).digest('hex'),
      ...(meta.desktopOnly ? { desktopOnly: true } : {}),
      ...(meta.serverBacked ? { serverBacked: true } : {}),
      ...(meta.requiresServer ? { requiresServer: true } : {}),
      ...(meta.public ? { public: true } : {}),
    });
    console.log(`built ${outFile} (${(code.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.warn(`SKIPPED ${entry.name}: ${err?.message?.split('\n')[0] ?? err}`);
  }
}

writeFileSync(
  join(OUT, 'index.json'),
  JSON.stringify({ api: HOST_API, name: 'AttackFM plugins', plugins: listings }, null, 2),
);
console.log(`manifest: ${listings.length} plugin(s) -> dist-plugins/index.json`);

const publicListings = listings.filter((l) => l.public);
for (const l of publicListings) {
  writeFileSync(join(OUT_PUBLIC, l.entry), readFileSync(join(OUT, l.entry)));
}
writeFileSync(
  join(OUT_PUBLIC, 'index.json'),
  JSON.stringify({ api: HOST_API, name: 'AttackFM plugins', plugins: publicListings }, null, 2),
);
console.log(`public manifest: ${publicListings.length} plugin(s) -> dist-plugins-public/index.json`);
