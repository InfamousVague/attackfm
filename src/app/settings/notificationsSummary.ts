import { fetchPushPrefs, type ServerSession } from '../server.ts';
import { translate } from '../i18n/LocaleShell.tsx';

/*
 * The section list's one-line reading of the notifications pane ("4 of 6 on")
 * - cached at module level because the list renders before that pane has ever
 * mounted, and the truth lives a fetch away on the server. The pane's own
 * fetch and the list's priming fetch both write it; whoever runs first wins,
 * and they cannot disagree because they read the same endpoint.
 *
 * Beside the pane rather than inside it because the cache is the interesting
 * part and every one of its rules is a silent failure when broken: another
 * account's counts shown on this row, a sentence frozen in the language it
 * was first written in, or a "light fetch on open" that turns out to hit the
 * server on every open.
 */
let summaryCache: { key: string; on: number; total: number; at: number } | null = null;

/** The cache holds the two NUMBERS, not the sentence they make. A sentence
 *  cached here would be cached in whichever language it was first written in
 *  and would survive the picker; the numbers do not care. */
function summaryText(on: number, total: number): string {
  return translate('settings.notifyOnCount', { on, total });
}

/** Which account on which box wrote the cache - a multi-server app must not
 *  show one server's counts on another's row. */
function summaryKey(session: ServerSession): string {
  return `${session.url}\n${session.username}`;
}

/** What the pane knows, written down for the list. A kind counts as ON unless
 *  it says otherwise: the server answers with every kind it knows, and one it
 *  has no opinion about yet is one that will still be delivered. */
export function writeSummary(session: ServerSession, prefs: Record<string, boolean>): string {
  const kinds = Object.keys(prefs);
  const on = kinds.filter((k) => prefs[k] !== false).length;
  summaryCache = { key: summaryKey(session), on, total: kinds.length, at: Date.now() };
  return summaryText(on, kinds.length);
}

/** What the list shows now, or null before anything has been fetched FOR THIS
 *  session - another account's counts are worse than the worded fallback. */
export function notificationsSummaryCached(session: ServerSession): string | null {
  return summaryCache && summaryCache.key === summaryKey(session)
    ? summaryText(summaryCache.on, summaryCache.total)
    : null;
}

/** The list's light fetch on open. A minute of trust between fetches: opening
 *  settings twice in a row should not hit the server twice. */
export async function primeNotificationsSummary(session: ServerSession): Promise<string | null> {
  if (
    summaryCache &&
    summaryCache.key === summaryKey(session) &&
    Date.now() - summaryCache.at < 60_000
  ) {
    return summaryText(summaryCache.on, summaryCache.total);
  }
  try {
    const r = await fetchPushPrefs(session);
    return writeSummary(session, r.prefs);
  } catch {
    return null;
  }
}
