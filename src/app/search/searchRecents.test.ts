import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recent, ServerSession } from '../server.ts';

/**
 * "What you opened from search last time."
 *
 * The list follows the account where there is one and lives on the device
 * where there is not, and both halves wear the same interface - so the tests
 * that matter are the ones that run the SAME sequence against both.
 */
const net = vi.hoisted(() => ({
  session: null as ServerSession | null,
  remote: [] as unknown[],
  fail: false,
  touched: [] as unknown[],
  removed: [] as [string, string][],
  cleared: 0,
}));

vi.mock('../servers/serverSession.tsx', () => ({
  useServerSession: () => ({ session: net.session }),
}));

vi.mock('../server.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server.ts')>()),
  fetchRecents: () =>
    net.fail ? Promise.reject(new Error('offline')) : Promise.resolve(net.remote),
  touchRecent: (_s: unknown, r: unknown) => {
    net.touched.push(r);
    return Promise.resolve();
  },
  removeRecent: (_s: unknown, kind: string, key: string) => {
    net.removed.push([kind, key]);
    return Promise.resolve();
  },
  clearRecents: () => {
    net.cleared += 1;
    return Promise.resolve();
  },
}));

const { useSearchRecents } = await import('./searchRecents.ts');

const SESSION = { url: 'https://hub.example', token: 't', username: 'matt' } as ServerSession;

const recent = (key: string, over: Partial<Recent> = {}): Omit<Recent, 'at'> => ({
  kind: 'track',
  key,
  title: key,
  subtitle: '',
  cover: null,
  url: '',
  ...over,
});

beforeEach(() => {
  net.session = null;
  net.remote = [];
  net.fail = false;
  net.touched = [];
  net.removed = [];
  net.cleared = 0;
});

describe('touch', () => {
  it('puts the newest at the front', async () => {
    const { result } = renderHook(() => useSearchRecents());
    act(() => result.current.touch(recent('a')));
    act(() => result.current.touch(recent('b')));
    expect(result.current.items.map((r) => r.key)).toEqual(['b', 'a']);
  });

  it('bumps an already-remembered row rather than listing it twice', async () => {
    const { result } = renderHook(() => useSearchRecents());
    act(() => result.current.touch(recent('a')));
    act(() => result.current.touch(recent('b')));
    act(() => result.current.touch(recent('a')));
    expect(result.current.items.map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('tells two KINDS with the same key apart', async () => {
    // An artist and an album can share a name; they are two shortcuts.
    const { result } = renderHook(() => useSearchRecents());
    act(() => result.current.touch(recent('Blur', { kind: 'artist' })));
    act(() => result.current.touch(recent('Blur', { kind: 'album' })));
    expect(result.current.items).toHaveLength(2);
  });

  it('keeps at most twenty - past that it is a history, not a shortcut', async () => {
    const { result } = renderHook(() => useSearchRecents());
    for (let i = 0; i < 25; i += 1) act(() => result.current.touch(recent(`k${i}`)));
    expect(result.current.items).toHaveLength(20);
    expect(result.current.items[0]?.key).toBe('k24');
    expect(result.current.items.some((r) => r.key === 'k0')).toBe(false);
  });

  it('mirrors to this device, keyed per ACCOUNT', async () => {
    // Signing in as somebody else must not flash their predecessor's
    // shortcuts.
    net.session = SESSION;
    const { result } = renderHook(() => useSearchRecents());
    await waitFor(() => expect(result.current.items).toEqual([]));
    act(() => result.current.touch(recent('a')));
    const key = `attackfm-search-recents:${SESSION.url}:${SESSION.username}`;
    expect(JSON.parse(localStorage.getItem(key) ?? '[]')).toHaveLength(1);
    // The signed-out list is a different key and is untouched.
    expect(localStorage.getItem('attackfm-search-recents')).toBe(null);
  });

  it('tells the server, when there is one - and does not, when there is not', async () => {
    const local = renderHook(() => useSearchRecents());
    act(() => local.result.current.touch(recent('a')));
    expect(net.touched).toEqual([]);

    net.session = SESSION;
    const remote = renderHook(() => useSearchRecents());
    await waitFor(() => expect(remote.result.current.items).toEqual([]));
    act(() => remote.result.current.touch(recent('a')));
    expect(net.touched).toHaveLength(1);
  });
});

describe('the server’s copy', () => {
  it('replaces the device mirror once it lands', async () => {
    net.session = SESSION;
    net.remote = [{ ...recent('from-server'), at: 1 }];
    const { result } = renderHook(() => useSearchRecents());
    await waitFor(() => expect(result.current.items.map((r) => r.key)).toEqual(['from-server']));
  });

  it('caps what the server sent, so an old long list does not come back whole', async () => {
    net.session = SESSION;
    net.remote = Array.from({ length: 30 }, (_, i) => ({ ...recent(`s${i}`), at: i }));
    const { result } = renderHook(() => useSearchRecents());
    await waitFor(() => expect(result.current.items).toHaveLength(20));
  });

  it('leaves the mirror on screen when the fetch fails', async () => {
    // "The mirror already on screen is a better answer than emptying the row
    // to prove a point."
    localStorage.setItem(
      `attackfm-search-recents:${SESSION.url}:${SESSION.username}`,
      JSON.stringify([{ ...recent('cached'), at: 1 }]),
    );
    net.session = SESSION;
    net.fail = true;
    const { result } = renderHook(() => useSearchRecents());
    expect(result.current.items.map((r) => r.key)).toEqual(['cached']);
    await waitFor(() => expect(result.current.items.map((r) => r.key)).toEqual(['cached']));
  });

  it('reads a torn mirror as an empty row rather than throwing', () => {
    localStorage.setItem('attackfm-search-recents', '{not json');
    const { result } = renderHook(() => useSearchRecents());
    expect(result.current.items).toEqual([]);
  });
});

describe('remove and clear', () => {
  it('removes one shortcut, by kind AND key', async () => {
    const { result } = renderHook(() => useSearchRecents());
    act(() => result.current.touch(recent('a', { kind: 'artist' })));
    act(() => result.current.touch(recent('a', { kind: 'album' })));
    act(() => result.current.remove('artist', 'a'));
    expect(result.current.items.map((r) => r.kind)).toEqual(['album']);
  });

  it('empties the row, and writes the emptiness through', async () => {
    const { result } = renderHook(() => useSearchRecents());
    act(() => result.current.touch(recent('a')));
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
    expect(JSON.parse(localStorage.getItem('attackfm-search-recents') ?? 'null')).toEqual([]);
  });

  it('tells the server about both, when there is one', async () => {
    net.session = SESSION;
    const { result } = renderHook(() => useSearchRecents());
    await waitFor(() => expect(result.current.items).toEqual([]));
    act(() => result.current.remove('track', 'a'));
    act(() => result.current.clear());
    expect(net.removed).toEqual([['track', 'a']]);
    expect(net.cleared).toBe(1);
  });
});

describe('the three verbs’ identity', () => {
  it('stays the same across renders, so the results page does not re-render per keystroke', async () => {
    // They end up in the dependency list of every row that can be tapped.
    const { result, rerender } = renderHook(() => useSearchRecents());
    const before = [result.current.touch, result.current.remove, result.current.clear];
    act(() => result.current.touch(recent('a')));
    rerender();
    expect([result.current.touch, result.current.remove, result.current.clear]).toEqual(before);
  });
});
