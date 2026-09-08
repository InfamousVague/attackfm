import { isAndroid } from '../core/platform.ts';
import { isTauri } from '../core/tauri.ts';
import { translate } from '../i18n/translate.ts';

/**
 * Put a rendered card (a PNG data URL) somewhere the person can send it.
 *
 * In order of what actually works, the same ladder the invite card climbs:
 *  1. Android app: the native bridge writes it into Photos (Pictures/AttackFM)
 *     through MediaStore - a WebView has no Web Share for files and ignores a
 *     download link.
 *  2. iOS and modern browsers: the share sheet, which carries Save Image and
 *     every messenger. Must be asked for INSIDE the tap - the caller hands
 *     over a picture drawn ahead of time, and the blob is decoded by hand so
 *     no await sits between the tap and the sheet.
 *  3. The desktop app: the clipboard (its WebView ignores downloads too).
 *  4. A browser: a plain download.
 *
 * `say` is how the outcome is told; every branch says something, because a
 * button that does nothing is the bug this exists to end.
 */
export async function saveCardImage(opts: {
  dataUrl: string;
  filename: string;
  /** For the share sheet's title. */
  title: string;
  say: (message: string) => void;
}): Promise<void> {
  const { dataUrl, filename, title, say } = opts;
  const native = (window as unknown as {
    AFMNative?: { saveImage?: (base64: string, name: string) => boolean };
  }).AFMNative;
  if (native?.saveImage) {
    const ok = native.saveImage(dataUrl.slice(dataUrl.indexOf(',') + 1), filename);
    if (ok) say(translate('widget.savedToPhotos'));
    else say(translate('widget.saveFailed'));
    return;
  }
  const raw = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });
  const file = new File([blob], filename, { type: 'image/png' });
  const shareData = { files: [file], title };
  if (navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData);
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        say(translate('widget.shareSheetFailed'));
      }
    }
    return;
  }
  if (isTauri() && isAndroid) {
    let installed = '';
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      installed = await getVersion();
    } catch {
      // Unknown is fine.
    }
    // Two whole sentences rather than one with an optional clause spliced in:
    // the version we found is a parenthetical in English and may not be one
    // anywhere else, and a translator cannot move a fragment they never see.
    say(
      installed
        ? translate('widget.needsNativeAppInstalled', { installed })
        : translate('widget.needsNativeApp'),
    );
    return;
  }
  if (isTauri() && navigator.clipboard && 'ClipboardItem' in window) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      say(translate('widget.copiedToClipboard'));
      return;
    } catch {
      // Fall through to the download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  say(translate('widget.downloaded', { filename }));
}
