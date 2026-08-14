import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// The version baked into THIS build. Without it a freshly installed app
// cannot tell that the bundle its hub publishes is the very one it is already
// running, and would download and announce an update to itself.
const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf8')).version as string;

// The OTA build (AFM_OTA=1, set by scripts/ship-update.mjs): everything in two
// files. A downloaded bundle is exactly app.js + app.css - the boot loader
// knows those two names and nothing else - but a normal build splits chunks
// and emits hashed assets, and their relative imports CANNOT resolve out of a
// bundle directory: convertFileSrc percent-encodes the whole path into one
// URL segment, so "./core-X.js" resolves against the origin root and 404s.
// The first dynamic import then throws, the boot wager is never settled, and
// the device quarantines the version. So the shipped bundle inlines every
// dynamic import into app.js and every asset (fonts, art) as data: URIs -
// bigger on the wire, but self-contained by construction. The embedded build
// keeps its splits; only what ships over the air pays the inlining tax.
const ota = process.env.AFM_OTA === '1';

// A relative base so the built app works when Tauri serves it from a custom
// protocol rather than the server root. @glacier/react resolves from the
// vendored copy in node_modules (installed via the file: dependency).
export default defineConfig({
  base: './',
  define: { __AFM_VERSION__: JSON.stringify(pkgVersion) },
  plugins: [react()],
  build: {
    ...(ota ? { assetsInlineLimit: 1 << 30, cssCodeSplit: false } : {}),
    rollupOptions: {
      output: {
        ...(ota ? { inlineDynamicImports: true } : {}),
        // STABLE names, not hashed ones. A downloaded bundle has to be
        // loadable by a filename the boot loader knows before it has seen the
        // bundle, and cache-busting is pointless here anyway: the embedded
        // copy ships inside the binary, and a downloaded one lives in its own
        // version directory. See src-tauri/src/bundle.rs.
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (info) =>
          info.name && info.name.endsWith('.css') ? 'assets/app.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    // The launcher may assign a port (a second session's preview); 5240 is
    // the standing default the Tauri shell and docs expect.
    port: Number(process.env.PORT) || 5240,
    strictPort: true,
  },
  clearScreen: false,
});
