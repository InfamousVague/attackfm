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
import { LaunchUpdate } from './app/settings/LaunchUpdate.tsx';
import { runColdStartMaintenance } from './app/core/coldStart.ts';
import { initDeepLinks } from './app/servers/deepLink.ts';
import { hydrateOffline } from './app/downloads/offline.ts';

import { isAndroid, isIOS } from './app/core/platform.ts';
import { installGlobalDiag } from './app/diag/diagLog.ts';
import { ensureBundleStylesheet } from './app/core/styleGuard.ts';

/**
 * AM I THE FRONTEND THAT WAS CHOSEN?
 *
 * The boot loader picks between the embedded bundle and a downloaded one, and
 * takes the tag for the loser out of the document before it can run. That was
 * believed to be enough - "module scripts are deferred, so a classic inline
 * script can remove the tag before it ever executes" - and it is not true here.
 * Once a script element has been prepared the fetch is already in flight and
 * removing the element does not cancel evaluation, so on this WebView BOTH
 * frontends run: two copies of this module, two style guards, two calls to
 * createRoot on one #root. They then fight over the same DOM until one of them
 * throws NotFoundError from removeChild, and the app is a black screen. It is
 * intermittent because which one wins is a race, which is why it looked like a
 * mystery in the update path rather than a plain double-boot.
 *
 * So the loader publishes the src it chose, and the other copy stops here.
 * Compared as resolved URLs because the loader carries the embedded tag's
 * ATTRIBUTE (`/assets/app.js`) while `import.meta.url` is absolute.
 *
 * The fallback when nothing was published (a browser tab, or an older binary
 * whose index.html predates this) is to run: something has to.
 */
function chosenFrontend(): boolean {
  const chosen = window.__afmFrontend;
  if (!chosen) return true;
  try {
    return new URL(chosen, document.baseURI).href === import.meta.url;
  } catch {
    return true;
  }
}

if (!chosenFrontend()) {
  // Not an error and not worth a log line on every OTA launch: this copy was
  // never meant to run, and the one that was is already on its way up.
} else {

// Stamped once so CSS can ask which glass it is under: an iPhone's screen
// corners curve (the nav chin sweeps to match); Android's are the webview's
// problem, not ours, and the same sweep just looks like extra rounding.
document.documentElement.dataset.platform = isAndroid ? 'android' : isIOS ? 'ios' : 'desktop';


// Errors that never reached a `try`. Installed before anything else runs, so a
// module that throws on its way up is caught too - that failure is invisible
// on a phone otherwise, and it is the one that leaves a blank screen.
installGlobalDiag();

// Before anything renders: if the boot loader could not attach this bundle's
// stylesheet, the app is about to draw new markup against a native build's old
// CSS. Put the right sheet back.
ensureBundleStylesheet();

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

// Cleared first. On a binary older than this guard the embedded copy has
// already mounted into #root by now, and mounting a second root over it is
// exactly the fight this file exists to stop. Whoever runs last wins the
// container outright, and that is the downloaded bundle - the newer of the two,
// which is the right one to keep.
const container = document.getElementById('root')!;
container.replaceChildren();
createRoot(container).render(
  <StrictMode>
    {/* Outside App on purpose: the gate has to be able to reload before any
        provider has opened a socket, started a scan or restored a queue. Wrap
        it the other way and the app has already begun the work the reload is
        about to throw away. In a browser tab it renders its children and
        nothing else. */}
    <LaunchUpdate>
      <App />
    </LaunchUpdate>
  </StrictMode>,
);

} // end of the chosen-frontend guard
