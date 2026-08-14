import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// The version baked into THIS build. Without it a freshly installed app
// cannot tell that the bundle its hub publishes is the very one it is already
// running, and would download and announce an update to itself.
const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf8')).version as string;

// A relative base so the built app works when Tauri serves it from a custom
// protocol rather than the server root. @glacier/react resolves from the
// vendored copy in node_modules (installed via the file: dependency).
export default defineConfig({
  base: './',
  define: { __AFM_VERSION__: JSON.stringify(pkgVersion) },
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
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
