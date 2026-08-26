import { renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import app from './vite.config';

/**
 * Rollup names an HTML output after its input, so the entry lands as
 * `demo.html`. Caddy serves this tree with a plain file_server, which resolves
 * a directory to `index.html` and nothing else - so `/demo/` would 404 and the
 * site's iframes would come up empty.
 */
const asIndex = {
  name: 'afm-demo-index',
  closeBundle() {
    const dir = resolve(__dirname, 'dist-site/demo');
    renameSync(resolve(dir, 'demo.html'), resolve(dir, 'index.html'));
  },
};

/**
 * The demo build: the real app, for the marketing site to show.
 *
 * attack.fm used to be screenshots. Screenshots go stale silently - the ones
 * this replaces were taken before a redesign and still showed a player bar
 * that no longer exists - and re-shooting them needs a real session token that
 * is not in the repo. So the site shows the app itself instead, built here
 * against a fixture hub (scripts/make-demo-fixtures.mjs) and mounted in the
 * device frames as an iframe.
 *
 * This is a thin wrapper on the app's own config, not a second one: it takes
 * that build whole and changes three things - the entry document (demo.html,
 * which carries the fixture shim), where it lands, and hashed filenames, since
 * this is served over HTTP to browsers rather than read out of a bundle
 * directory by name.
 *
 * It emits into dist-site/demo, so `npm run site:build` must run FIRST - that
 * build sets emptyOutDir and would delete this one.
 */
export default defineConfig({
  ...app,
  plugins: [react(), asIndex],
  base: './',
  build: {
    outDir: 'dist-site/demo',
    emptyOutDir: true,
    rollupOptions: {
      input: 'demo.html',
      output: {
        entryFileNames: 'assets/app-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
