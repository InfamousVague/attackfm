import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The marketing site at attack.fm, built separately from the app.
//
// It lives in this repo rather than as loose files on the box because the page
// that was serving attack.fm existed ONLY on the VPS - nothing in git produced
// it, so it could not be reviewed, diffed, or rebuilt. Keeping it here means
// the site is built from the same @glacier kit the app is built from, and the
// two cannot drift apart in palette, iconography, or type.
//
// Resolution note: `site/` has no node_modules of its own. Vite walks upward,
// so `@glacier/*` and `react` resolve to the ROOT install - one copy of the kit
// for both the app and the site, which is the point.
export default defineConfig({
  root: 'site',
  // Absolute base: this is served from the root of its own domain, unlike the
  // app, which Tauri serves from a custom protocol and so needs './'.
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../dist-site',
    emptyOutDir: true,
    /*
     * Two documents, not one page with a router.
     *
     * Caddy serves this tree with a plain `file_server` and no SPA fallback, so
     * a client-side route would 404 on a cold link - which is the only kind of
     * link that matters for a page people are sent to. A directory entry emits
     * `audiobooks/index.html`, which `file_server` serves at `/audiobooks/`
     * without being told anything.
     */
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'site/index.html'),
        audiobooks: resolve(__dirname, 'site/audiobooks/index.html'),
      },
    },
    // Screenshots are the payload here and they are large. Inlining anything
    // sizeable into the JS would block first paint on bytes the page does not
    // need until the reader scrolls to them.
    assetsInlineLimit: 2048,
  },
  server: {
    port: Number(process.env.SITE_PORT) || 5250,
    strictPort: true,
    // The site imports the app's own brand-accent definition from src/app, which
    // sits above this root. Without this, dev serving refuses to read it and the
    // site would need its own copy of the brand hex - the exact drift this
    // arrangement exists to prevent.
    fs: { allow: ['..'] },
  },
  clearScreen: false,
});
