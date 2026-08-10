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

// Before the first provider runs, so nothing reads a feed cache that a killed
// app was meant to have forgotten. Cheap, synchronous, and a no-op on resume.
runColdStartMaintenance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
