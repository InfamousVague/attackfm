/**
 * The verbose watcher: turns the server's activity feed into bell rows while
 * the device's "verbose notifications" switch is on.
 *
 * Headless, mounted beside DownloadNotices at the same depth in App (inside
 * the plugin providers and under ToastProvider). Polls GET /api/activity with
 * the last id it has seen, seeds silently on first contact, and raises one
 * notice per event with the event's `key` as the notice id - so a 'started'
 * row is replaced by its 'done'/'failed' row and rings again.
 *
 * SCAFFOLD - being filled in.
 */
export function VerboseNotices(): null {
  return null;
}
