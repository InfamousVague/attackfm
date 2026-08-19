import { recordDiag } from '../diag/diagLog.ts';

/**
 * Makes sure the stylesheet that belongs to THIS bundle is actually applied.
 *
 * The boot loader in index.html swaps the embedded bundle for a downloaded one
 * by adding a <link> to the bundle's app.css and removing the embedded sheet
 * only once the new one has loaded. When that load fails it keeps the embedded
 * sheet, on the reasoning that a version-old stylesheet beats no stylesheet at
 * all - and that is right, as far as it goes.
 *
 * What it misses is that the JS came from the NEW bundle. Every class added
 * since the native app was last built then has no rules behind it, so the parts
 * of the app that changed most recently are exactly the parts that render as
 * naked HTML - bulleted lists, stacked flex rows, unstyled buttons. The app is
 * not "a version behind on looks"; it is two halves of different versions.
 *
 * That loader is embedded, so it cannot be repaired over the air. This can: the
 * bundle's app.css sits next to its app.js, `import.meta.url` is that app.js,
 * and a sibling URL is therefore the exact stylesheet this build expects. If it
 * is not among the loaded sheets, put it back.
 */
export function ensureBundleStylesheet(): void {
  // The dev server serves modules from /src and has no app.css beside them;
  // Vite injects styles itself there.
  if (import.meta.env.DEV) return;

  let href: string;
  try {
    href = new URL('app.css', import.meta.url).href;
  } catch {
    return; // no module URL to reason from
  }

  if (sheetLoaded(href)) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // The same fetch rules the loader uses, so this is not the one request that
  // goes out under different ones.
  link.crossOrigin = 'anonymous';
  link.dataset.afmRecovered = 'true';
  link.onload = () => {
    // Now that the right sheet is up, drop the stale embedded one - leaving it
    // would keep any rule the new sheet happens not to override.
    for (const stale of document.querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"][href*="app.css"]',
    )) {
      if (stale !== link) stale.remove();
    }
    recordDiag('boot', 'stylesheet was missing at boot and has been restored');
  };
  link.onerror = () => {
    link.remove();
    recordDiag('boot', `stylesheet could not be restored: ${href}`);
  };
  document.head.appendChild(link);
  link.href = href;
}

/** Is a stylesheet with this href already among the document's sheets? */
function sheetLoaded(href: string): boolean {
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href === href) return true;
  }
  return false;
}
