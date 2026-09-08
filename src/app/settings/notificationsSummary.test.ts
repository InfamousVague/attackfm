/**
 * "4 of 6 on", and the module-level cache that makes it possible.
 *
 * The settings list renders before the notifications pane has ever mounted,
 * and the truth is a fetch away on somebody's server - so this line is drawn
 * from a cache, and every rule that cache follows exists to stop a specific
 * wrong sentence appearing under the row.
 *
 * Three of them, and none announces itself when broken: counts belonging to
 * ANOTHER ACCOUNT shown under this one (a multi-server app, one module-level
 * variable); a sentence frozen in the language it was first built in (which
 * is why the cache holds two numbers and not a string); and a "light fetch on
 * open" that turns out to ask the server every single time Settings opens.
 *
 * A fresh module per test, because the cache is module state: a test that
 * leaves it primed is a test that decides whether the next one passes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../api/http.ts';

const { fetchPushPrefs } = vi.hoisted(() => ({ fetchPushPrefs: vi.fn() }));

vi.mock('../server.ts', () => ({ fetchPushPrefs }));
vi.mock('../i18n/translate.ts', () => ({
  translate: (key: string, options?: Record<string, unknown>) =>
    options ? `${key}(${JSON.stringify(options)})` : key,
}));

async function fresh() {
  vi.resetModules();
  return import('./notificationsSummary.ts');
}

function session(url: string, username = 'matt'): ServerSession {
  return { url, token: 't', streamToken: 's', username, isAdmin: false } as ServerSession;
}

const home = session('https://home.example.com');

afterEach(() => {
  fetchPushPrefs.mockReset();
});

describe('what the list can show before anything has been fetched', () => {
  it('is nothing at all, so the row falls back to its worded line', () => {
    // Not "0 of 0 on". The caller does `?? t('settings.summaryNotifications')`
    // and a fabricated zero would suppress that fallback with a lie.
    return fresh().then(({ notificationsSummaryCached }) => {
      expect(notificationsSummaryCached(home)).toBeNull();
    });
  });

  it('is STILL nothing for a second account on the same box', async () => {
    // One module-level cache, several accounts. Reporting matt's counts under
    // sam's row is the failure this key exists to prevent, and it is
    // invisible: both are plausible numbers.
    const { notificationsSummaryCached, writeSummary } = await fresh();
    writeSummary(home, { a: true, b: false });
    expect(notificationsSummaryCached(session('https://home.example.com', 'sam'))).toBeNull();
  });

  it('is still nothing for the same account on a DIFFERENT box', async () => {
    const { notificationsSummaryCached, writeSummary } = await fresh();
    writeSummary(home, { a: true, b: false });
    expect(notificationsSummaryCached(session('https://vps.example.com'))).toBeNull();
  });
});

describe('the counts', () => {
  it('counts a kind as ON unless it says otherwise', async () => {
    const { writeSummary } = await fresh();
    expect(writeSummary(home, { a: true, b: true, c: false })).toBe(
      'settings.notifyOnCount({"on":2,"total":3})',
    );
  });

  it('counts a kind the server has NO OPINION about as on', async () => {
    /*
     * The reply materialises every kind it knows and unset means on (see
     * `PushPrefs` in api/push.ts) - and a kind it has no row for arrives as
     * null over the wire whatever the TypeScript says. `!== false` is what
     * makes that an on; tightened to `=== true` the summary under-reports,
     * and it under-reports in the direction that tells somebody they have
     * switched off notifications they are still receiving.
     */
    const { writeSummary } = await fresh();
    const fromTheWire = { a: true, b: null, c: undefined } as unknown as Record<string, boolean>;
    expect(writeSummary(home, fromTheWire)).toBe('settings.notifyOnCount({"on":3,"total":3})');
  });

  it('reports the OFF state as off - four of six, not six of six', async () => {
    const { notificationsSummaryCached, writeSummary } = await fresh();
    writeSummary(home, { a: true, b: true, c: true, d: true, e: false, f: false });
    expect(notificationsSummaryCached(home)).toBe('settings.notifyOnCount({"on":4,"total":6})');
  });

  it('holds the NUMBERS rather than the sentence they make', async () => {
    /*
     * The language can change between the write and the read - somebody opens
     * Settings, changes the language, and looks at the list again. A cached
     * string would still be in the old language, under a row whose label has
     * already switched. Proved by moving the translator underneath a cache
     * that was written before it moved.
     */
    const mod = await fresh();
    mod.writeSummary(home, { a: true, b: false });
    const locale = await import('../i18n/translate.ts');
    const spy = vi.spyOn(locale, 'translate').mockReturnValue('IN ANOTHER LANGUAGE');
    expect(mod.notificationsSummaryCached(home)).toBe('IN ANOTHER LANGUAGE');
    spy.mockRestore();
  });
});

describe('priming the summary on open', () => {
  it('asks the server when it knows nothing, and remembers the answer', async () => {
    const { notificationsSummaryCached, primeNotificationsSummary } = await fresh();
    fetchPushPrefs.mockResolvedValue({ prefs: { a: true, b: false }, devices: 1 });

    expect(await primeNotificationsSummary(home)).toBe('settings.notifyOnCount({"on":1,"total":2})');
    expect(fetchPushPrefs).toHaveBeenCalledTimes(1);
    // Remembered, or the list would be blank again on the next paint.
    expect(notificationsSummaryCached(home)).toBe('settings.notifyOnCount({"on":1,"total":2})');
  });

  it('DOES NOT ask again a minute later - opening settings twice is one fetch', async () => {
    // The trust window is the whole reason this is "light". Drop it and every
    // open of Settings hits somebody's server, from every device they own.
    const { primeNotificationsSummary } = await fresh();
    fetchPushPrefs.mockResolvedValue({ prefs: { a: true }, devices: 1 });
    await primeNotificationsSummary(home);
    await primeNotificationsSummary(home);
    expect(fetchPushPrefs).toHaveBeenCalledTimes(1);
  });

  it('asks again once the cache is older than a minute', async () => {
    // The other half of the same knob: a window that never expires means a
    // switch flipped on the phone never reaches the laptop's summary line.
    vi.useFakeTimers();
    try {
      const { primeNotificationsSummary } = await fresh();
      fetchPushPrefs.mockResolvedValue({ prefs: { a: true }, devices: 1 });
      await primeNotificationsSummary(home);
      vi.setSystemTime(Date.now() + 61_000);
      await primeNotificationsSummary(home);
      expect(fetchPushPrefs).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again for a different account rather than trusting the window', async () => {
    const { primeNotificationsSummary } = await fresh();
    fetchPushPrefs.mockResolvedValue({ prefs: { a: true }, devices: 1 });
    await primeNotificationsSummary(home);
    await primeNotificationsSummary(session('https://home.example.com', 'sam'));
    expect(fetchPushPrefs).toHaveBeenCalledTimes(2);
  });

  it('answers null when the server cannot be reached, and caches nothing', async () => {
    // Offline, or a server that predates push. The row shows its worded
    // fallback; what it must not do is throw into the hub's render or
    // remember a failure as a count.
    const { notificationsSummaryCached, primeNotificationsSummary } = await fresh();
    fetchPushPrefs.mockRejectedValue(new Error('offline'));
    expect(await primeNotificationsSummary(home)).toBeNull();
    expect(notificationsSummaryCached(home)).toBeNull();
  });
});
