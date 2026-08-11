import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A relative base so the built app works when Tauri serves it from a custom
// protocol rather than the server root. @glacier/react resolves from the
// vendored copy in node_modules (installed via the file: dependency).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // The launcher may assign a port (a second session's preview); 5240 is
    // the standing default the Tauri shell and docs expect.
    port: Number(process.env.PORT) || 5240,
    strictPort: true,
  },
  clearScreen: false,
});
