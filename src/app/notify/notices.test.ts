/**
 * The news ring behind the bell.
 *
 * `notices.ts` states four rules for itself - it PERSISTS, it is BOUNDED, it is
 * TOLERANT of its own older shapes, and it is SCOPED - and then adds two
 * mechanisms that exist because of a specific failure each:
 *
 *   - `EMPTY` and the two derived snapshots are FROZEN, shared objects,
 *     because `useSyncExternalStore` compares by identity and a getter that
 *     builds a fresh `[]` (or a fresh `Set`) re-renders forever;
 *   - the same-id/different-kind rule, because carrying `read` across
 *     unconditionally meant "the failure you had already looked at stamped the
 *     SUCCESS as read: the bell buzzed, the badge stayed dark, no row moved,
 *     and the arrival you were waiting for was announced to nobody."
 *
 * The second is the one worth having a regression test for, and it has one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The OS tray. Stubbed so "which arrivals ring" is observable, which is half
 *  of what the same-id/different-kind rule decides. */
const mirrorNoticeToOs = vi.fn();
vi.mock('./osNotify.ts', () => ({ mirrorNoticeToOs }));

const {
  clearNotices,
  dismissNotice,
  flushNotices,
  markAllRead,
  msOf,
  noteNotice,
  notices,
  setNoticeScope,
  subscribeNotices,
  unreadCount,
  unreadKinds,
} = await import('./notices.ts');

const KEY = 'attackfm-notify-v1';

function add(id: string, over: Partial<Parameters<typeof noteNotice>[0]> = {}): void {
  noteNotice({ id, kind: 'drops', title: 'Landed', body: 'A song', art: null, door: null, ...over });
}

beforeEach(() => {
  // The ring is module state, so it outlives the per-test localStorage clear.
  setNoticeScope(null);
  clearNotices();
  localStorage.clear();
  mirrorNoticeToOs.mockClear();
});

describe('a polled queue is safe to report from', () => {
  it('replaces the row for an id it already holds rather than stacking', () => {
    // "the same job seen again is the same row, not a second one" - a poll
    // sees a finished job on every tick, and one landing must not become forty.
    add('import:7', { body: 'first' });
    add('import:7', { body: 'second' });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.body).toBe('second');
  });

  it('keeps a restated story in its place, and keeps it read', () => {
    add('import:7');
    markAllRead();
    add('import:7', { body: 'still failing' });
    expect(notices()[0]?.read).toBe(true);
    expect(unreadCount()).toBe(0);
  });

  it('does not ring the tray again for a story it has already told', () => {
    add('import:7');
    mirrorNoticeToOs.mockClear();
    add('import:7', { body: 'restated' });
    expect(mirrorNoticeToOs).not.toHaveBeenCalled();
  });
});

describe('REGRESSION: same id, different kind', () => {
  it('a retry that finally lands is UNREAD, even though the failure was read', () => {
    /*
     * The failure, in full: an import keeps its job id across a retry, so a
     * download that fails and later succeeds reports twice under one id.
     * Carrying `read` across unconditionally meant the failure you had already
     * looked at stamped the SUCCESS as read - the arrival you were waiting for
     * was announced to nobody.
     */
    add('import:7', { kind: 'failed', title: 'Could not download' });
    markAllRead();
    expect(unreadCount()).toBe(0);

    add('import:7', { kind: 'drops', title: 'Landed' });
    expect(unreadCount()).toBe(1);
    expect(notices()[0]?.read).toBe(false);
    expect(unreadKinds().has('drops')).toBe(true);
  });

  it('moves it to the end, where the newest-first panel puts it on top', () => {
    add('a');
    add('import:7', { kind: 'failed' });
    add('b');
    add('import:7', { kind: 'drops' });
    expect(notices().map((n) => n.id)).toEqual(['a', 'b', 'import:7']);
  });

  it('rings the tray, because it is a new event', () => {
    add('import:7', { kind: 'failed' });
    mirrorNoticeToOs.mockClear();
    add('import:7', { kind: 'drops' });
    expect(mirrorNoticeToOs).toHaveBeenCalledTimes(1);
    expect(mirrorNoticeToOs.mock.calls[0]?.[0]).toMatchObject({ id: 'import:7', kind: 'drops' });
  });

  it('and a SAME-kind restatement does none of that', () => {
    // The third case, which is what makes the two above mean something: the
    // rule is `prev.kind === row.kind`, not "always treat a repeat as new".
    add('a');
    add('import:7', { kind: 'failed' });
    add('b');
    markAllRead();
    mirrorNoticeToOs.mockClear();
    add('import:7', { kind: 'failed', body: 'still failing' });
    expect(notices().map((n) => n.id)).toEqual(['a', 'import:7', 'b']);
    expect(unreadCount()).toBe(0);
    expect(mirrorNoticeToOs).not.toHaveBeenCalled();
  });
});

describe('bounded', () => {
  it('holds fifty and drops the eldest', () => {
    for (let i = 0; i < 60; i += 1) add(`n${i}`);
    const all = notices();
    expect(all).toHaveLength(50);
    expect(all[0]?.id).toBe('n10');
    expect(all[49]?.id).toBe('n59');
  });

  it('clamps a runaway line rather than letting it eat the ring', () => {
    // "a server error page pasted into a body would otherwise cost kilobytes
    // per failure."
    add('a', { title: 'x'.repeat(400), body: 'y'.repeat(400) });
    const row = notices()[0];
    expect(row?.title).toHaveLength(161);
    expect(row?.title.endsWith('…')).toBe(true);
    expect(row?.body).toHaveLength(161);
  });

  it('leaves a line that fits exactly alone', () => {
    add('a', { body: 'y'.repeat(160) });
    expect(notices()[0]?.body).toBe('y'.repeat(160));
    expect(notices()[0]?.body.endsWith('…')).toBe(false);
  });
});

describe('the snapshots useSyncExternalStore compares', () => {
  it('returns THE SAME empty array every time', () => {
    // A getter that builds a fresh `[]` each call re-renders forever.
    expect(notices()).toBe(notices());
    add('a');
    clearNotices();
    expect(notices()).toBe(notices());
    expect(Object.isFrozen(notices())).toBe(true);
  });

  it('returns the same kind Set until something actually changes', () => {
    // "a Set built inside the getter is a new object every time React looks -
    // which is an infinite render loop rather than a slow one."
    add('a');
    const first = unreadKinds();
    expect(unreadKinds()).toBe(first);
    add('b', { kind: 'friends' });
    expect(unreadKinds()).not.toBe(first);
    expect([...unreadKinds()].sort()).toEqual(['drops', 'friends']);
  });

  it('hands out a new array only when the ring changed', () => {
    add('a');
    const snapshot = notices();
    expect(notices()).toBe(snapshot);
    add('b');
    expect(notices()).not.toBe(snapshot);
  });
});

describe('the unread tally', () => {
  it('counts only unread rows, and clears when the panel is opened', () => {
    add('a');
    add('b');
    expect(unreadCount()).toBe(2);
    markAllRead();
    expect(unreadCount()).toBe(0);
    expect(unreadKinds().size).toBe(0);
  });

  it('is RECOUNTED on a dismissal rather than decremented', () => {
    // "a notice may or may not have been read and guessing which is how a
    // badge starts lying."
    add('a');
    add('b');
    markAllRead();
    add('c');
    expect(unreadCount()).toBe(1);
    dismissNotice('a');
    expect(unreadCount()).toBe(1);
    dismissNotice('c');
    expect(unreadCount()).toBe(0);
  });

  it('ignores a dismissal of something it does not hold', () => {
    add('a');
    let woke = 0;
    const off = subscribeNotices(() => {
      woke += 1;
    });
    dismissNotice('nope');
    expect(notices()).toHaveLength(1);
    expect(woke).toBe(0);
    off();
  });

  it('wakes its listeners when the ring changes', () => {
    let woke = 0;
    const off = subscribeNotices(() => {
      woke += 1;
    });
    add('a');
    expect(woke).toBe(1);
    markAllRead();
    expect(woke).toBe(2);
    off();
    add('b');
    expect(woke).toBe(2);
  });

  it('does nothing at all when there is nothing to mark or clear', () => {
    let woke = 0;
    const off = subscribeNotices(() => {
      woke += 1;
    });
    markAllRead();
    clearNotices();
    expect(woke).toBe(0);
    off();
  });
});

describe('scoped', () => {
  it('signing in as somebody else must not show you their week', () => {
    setNoticeScope('matt');
    add('a', { title: "matt's" });
    flushNotices();
    setNoticeScope('kim');
    expect(notices()).toHaveLength(0);
    setNoticeScope('matt');
    expect(notices().map((n) => n.title)).toEqual(["matt's"]);
  });

  it('writes the previous account out BEFORE swapping', () => {
    /*
     * The debounce means the previous account's last few rows may still be
     * only in memory; switching without writing them would drop them on the
     * floor. Asserted against the storage key directly, because the flush is
     * the whole point.
     */
    setNoticeScope('matt');
    add('a');
    setNoticeScope('kim');
    const written = JSON.parse(localStorage.getItem(`${KEY}:matt`) ?? '[]') as unknown[];
    expect(written).toHaveLength(1);
  });

  it('is a no-op when the scope has not changed', () => {
    setNoticeScope('matt');
    add('a');
    setNoticeScope('matt');
    expect(notices()).toHaveLength(1);
  });
});

describe('tolerant of its own older shapes', () => {
  const reload = async () => {
    vi.resetModules();
    return import('./notices.ts');
  };

  it('fills in fields a past version did not write', async () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: 'old' }]));
    const m = await reload();
    const [row] = m.notices();
    expect(row).toMatchObject({ id: 'old', kind: 'drops', title: '', body: '', art: null, door: null, read: false });
    expect(typeof row?.at).toBe('number');
  });

  it('drops a door it does not recognise rather than rendering a dead press', async () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: 'x', door: 'somewhere-else' }]));
    const m = await reload();
    expect(m.notices()[0]?.door).toBeNull();
  });

  it('keeps every door it does recognise', async () => {
    const doors = ['downloads', 'friends', 'discover', 'date', 'playlist', 'groove'];
    localStorage.setItem(KEY, JSON.stringify(doors.map((d, i) => ({ id: `d${i}`, door: d }))));
    const m = await reload();
    expect(m.notices().map((n) => n.door)).toEqual(doors);
  });

  it('throws away rows that are not rows', async () => {
    localStorage.setItem(KEY, JSON.stringify([null, 42, { noId: true }, { id: 'good' }]));
    const m = await reload();
    expect(m.notices().map((n) => n.id)).toEqual(['good']);
  });

  it('reads a torn entry as an empty ring rather than crashing the boot', async () => {
    localStorage.setItem(KEY, 'not json');
    const m = await reload();
    expect(m.notices()).toEqual([]);

    localStorage.setItem(KEY, '{"not":"an array"}');
    const m2 = await reload();
    expect(m2.notices()).toEqual([]);
  });

  it('counts the unread rows it just loaded from disk', async () => {
    /*
     * The final `changed()` at the bottom of the module: "the load above ran
     * before `changed()` ever did, so the derived counts start at zero while
     * the ring may already hold unread rows from the last run."
     */
    localStorage.setItem(KEY, JSON.stringify([{ id: 'a', kind: 'drops', read: false }]));
    const m = await reload();
    expect(m.unreadCount()).toBe(1);
    expect(m.unreadKinds().has('drops')).toBe(true);
  });
});

describe('optional fields ride only where they belong', () => {
  it('carries a playlist id, a groove asker and a song when given them', () => {
    add('a', { door: 'playlist', playlist: 'pl-1' });
    add('b', { door: 'groove', from: 'kim' });
    add('c', { song: { title: 'Idioteque', artist: 'Radiohead' } });
    const [pl, gr, sg] = notices();
    expect(pl?.playlist).toBe('pl-1');
    expect(gr?.from).toBe('kim');
    expect(sg?.song).toEqual({ title: 'Idioteque', artist: 'Radiohead' });
  });

  it('leaves them absent otherwise, so a row without one is drawn unpressable', () => {
    add('a', { door: 'playlist' });
    expect('playlist' in (notices()[0] ?? {})).toBe(false);
    expect('from' in (notices()[0] ?? {})).toBe(false);
    expect('song' in (notices()[0] ?? {})).toBe(false);
  });

  it('takes a caller-supplied timestamp, and stamps one otherwise', () => {
    add('a', { at: 1_700_000_000_000 });
    expect(notices()[0]?.at).toBe(1_700_000_000_000);
    add('b');
    expect(notices()[1]?.at).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('msOf', () => {
  it('promotes a unix-seconds stamp and leaves milliseconds alone', () => {
    // 1e12 ms is 2001, "so anything below it cannot be a millisecond timestamp
    // for a running app."
    expect(msOf(1_700_000_000)).toBe(1_700_000_000_000);
    expect(msOf(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(msOf(0)).toBe(0);
    expect(msOf(1e12)).toBe(1e12);
    expect(msOf(1e12 - 1)).toBe((1e12 - 1) * 1000);
  });
});
