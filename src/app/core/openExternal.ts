import { isTauri } from './tauri.ts';

/**
 * Opens a URL in the user's real browser, wherever the app is running.
 *
 * Inside Tauri (desktop or the phone's WKWebView) a bare `window.open` either
 * does nothing or hijacks the app's own view, so it goes through the opener
 * plugin, which hands the link to the system browser. In a plain browser tab
 * `window.open` is exactly right. Failures are swallowed: a link that will not
 * open is a dead end, not a crash.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      // Fall through to the web path below.
    }
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // Nothing more to try.
  }
}
