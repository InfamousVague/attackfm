import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The token layer: fonts first, then the CSS custom properties every component
// reads. In the vendored scaffold these resolve to the copied token files.
import '@glacier/tokens/css/fonts.css';
import '@glacier/tokens/css/tokens.css';
// The compiled component styles, read straight from the vendored package
// rather than a copy in src/: a snapshot goes stale the moment the kit is
// rebuilt, and a stylesheet whose class hashes no longer match the JS silently
// unstyles every component.
import '@glacier/react/styles.css';
import './app/app.css';
import { App } from './app/App.tsx';
import { runColdStartMaintenance } from './app/coldStart.ts';
import { initDeepLinks } from './app/deepLink.ts';
import { hydrateOffline } from './app/offline.ts';

// Before the first provider runs, so nothing reads a feed cache that a killed
// app was meant to have forgotten. Cheap, synchronous, and a no-op on resume.
runColdStartMaintenance();

// What this device already holds, read once from the folder that IS the index
// (offline.ts): playback consults the map synchronously, so it has to be warm
// before the first track loads. A no-op in a browser tab.
void hydrateOffline();

// Catch an invite link the app was opened with (or is handed while running) and
// hold it for Join a server. Fire-and-forget; a no-op off a device.
void initDeepLinks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
