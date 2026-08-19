import { recordDiag } from '../diag/diagLog.ts';
import { REGISTRY_URL } from '../servers/registry.ts';

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
 * and a sibling URL is therefore the exact stylesheet this build expects.
 *
 * WHY THIS DOES NOT SIMPLY ADD ANOTHER <link>. It used to, and it came back:
 * the same symptom, the same screen, the same missing rules. A second <link>
 * to the URL that just failed fails again for whatever reason the first one
 * did, so the recovery could only ever help when the loader had not tried at
 * all. The app already knows this shape of bug from audio - on Android a
 * `convertFileSrc` URL handed to an element hangs forever while `fetch()` of
 * that identical URL answers 200, because the media stack never consults the
 * interceptor that serves it (see `loadLocalAudioUrl`). So the recovery reads
 * the bytes the way that is known to work and injects them as a <style>, which
 * needs no second trip through whatever refused the first one.
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

  if (applied(href)) return;
  void restore(href);
}

/**
 * Is this bundle's stylesheet both present AND carrying rules?
 *
 * The rule count matters as much as the href. A <link> that 404s never reaches
 * document.styleSheets at all, but one served an error page with the wrong
 * content type reaches it as a sheet with nothing in it - which looks loaded to
 * anything checking by URL alone, and is why the first version of this guard
 * could stand down in front of a completely unstyled screen.
 */
function applied(href: string): boolean {
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href !== href) continue;
    try {
      return sheet.cssRules.length > 0;
    } catch {
      // A cross-origin sheet refuses to be read. It loaded, which is the
      // question being asked, so take it.
      return true;
    }
  }
  return false;
}

/**
 * Put the right stylesheet back, by whatever route answers.
 *
 * Ordered by how likely each is to work rather than how tidy it is. The local
 * read comes first because those bytes are on the device and cost nothing; the
 * published copy is the fallback for a bundle whose app.css never landed or has
 * since been reclaimed, which a local read cannot fix at all.
 */
async function restore(href: string): Promise<void> {
  const local = await readCss(href);
  if (local) {
    adopt(local, 'local');
    return;
  }

  const remote = await publishedCss();
  if (remote) {
    adopt(remote, 'published');
    return;
  }

  recordDiag('boot', `stylesheet could not be restored: ${href}`);
}

/** The stylesheet as text, or null. */
async function readCss(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    // An error page served as the stylesheet would otherwise be adopted as one
    // and quietly replace the sheet that at least half worked.
    return text.includes('{') ? text : null;
  } catch {
    return null;
  }
}

/**
 * This version's stylesheet from the registry, for a device whose local copy
 * is gone. Deliberately asks for the manifest rather than a fixed file name,
 * so a device only ever adopts the CSS belonging to a real published bundle.
 */
async function publishedCss(): Promise<string | null> {
  const version = (window as { __afmBundleVersion?: string | null }).__afmBundleVersion;
  if (!version) return null;
  try {
    // The same two addresses the updater uses, from the same constant, rather
    // than a second copy of them here that could drift out of step.
    const res = await fetch(`${REGISTRY_URL}/v1/app/bundle`, { cache: 'no-store' });
    if (!res.ok) return null;
    const manifest = (await res.json()) as { version?: string; files?: { name: string }[] };
    // Only the version this JS actually is. Taking "latest" would pair new CSS
    // with older JS, which is the same two-halves bug pointing the other way.
    if (manifest.version !== version) return null;
    if (!manifest.files?.some((f) => f.name === 'app.css')) return null;
    return readCss(`${REGISTRY_URL}/v1/app/bundle/app.css`);
  } catch {
    return null;
  }
}

/** Apply recovered CSS, and retire the stale sheet it is standing in for. */
function adopt(css: string, source: 'local' | 'published'): void {
  const style = document.createElement('style');
  style.dataset.afmRecovered = source;
  style.textContent = css;
  document.head.appendChild(style);

  // Now that the right rules are up, drop the stale embedded sheet - leaving it
  // would keep any rule the new one happens not to override. Done only after
  // the replacement is in the document, so there is no frame with neither.
  for (const stale of document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>(
    'link[rel="stylesheet"][href*="app.css"], style[data-afm-embedded]',
  )) {
    if (stale !== style) stale.remove();
  }
  recordDiag('boot', `stylesheet was missing at boot and has been restored (${source})`);
}
