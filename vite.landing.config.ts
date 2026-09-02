import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The registry's playlist landing page (registry.attack.fm/p/<code>), built
 * from the SAME kit the app is built from - GlacierUI's PlayerBar, buttons
 * and tokens - rather than a hand-rolled imitation of them.
 *
 * Two files, fixed names, everything inlined: the registry binary embeds
 * `landing.js` and `landing.css` with include_str! and serves them beside
 * the OG-tagged shell, so there is no asset directory to deploy and no hash
 * to keep in step. Fonts and art become data: URIs inside the CSS for the
 * same reason the over-the-air bundle inlines them.
 *
 *   npm run build:landing   → server/crates/registry/assets/landing.{js,css}
 */
export default defineConfig({
  base: '/p/_/',
  plugins: [react()],
  build: {
    outDir: 'server/crates/registry/assets',
    emptyOutDir: true,
    assetsInlineLimit: 1 << 30,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/landing/main.tsx',
      output: {
        entryFileNames: 'landing.js',
        chunkFileNames: 'landing-[name].js',
        assetFileNames: (info) => (info.name && info.name.endsWith('.css') ? 'landing.css' : 'landing-[name][extname]'),
        inlineDynamicImports: true,
      },
    },
  },
  clearScreen: false,
});
