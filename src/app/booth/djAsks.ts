/**
 * The last few things the listener asked the DJ for, in their own words.
 *
 * The conversation keeps a transcript, but the transcript lives in one page
 * and the deck's DJ popover is on another; what the deck wants is the three
 * most recent asks as chips - "that thing I said yesterday", one tap from
 * playing again. Written from the conversation's send (typed or spoken, the
 * same door), read when the popover opens. localStorage, per device: an ask
 * is a small personal thing, and a hub round-trip to remember three
 * sentences is not worth the wait it would put on the open.
 */
const KEY = 'attackfm-dj-asks';
const KEEP = 3;

export function recentDjAsks(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, KEEP)
      : [];
  } catch {
    return [];
  }
}

/** Remember an ask, newest first, without repeating one already kept. */
export function noteDjAsk(text: string): void {
  const t = text.trim();
  if (!t) return;
  try {
    const rest = recentDjAsks().filter((s) => s.toLowerCase() !== t.toLowerCase());
    localStorage.setItem(KEY, JSON.stringify([t, ...rest].slice(0, KEEP)));
  } catch {
    // Storage refused (private mode, a full quota): the ask simply is not kept.
  }
}
