import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { SearchResult, ServerSession } from '../server.ts';
import type { AcquireValue } from '../../plugins/runtime.tsx';
import type { DownloadsContextValue } from '../../plugins/importsBridge.ts';
import type { OwnedIndex } from '../library/owned.ts';
import { track } from '../../test/libraryFixtures.ts';

/**
 * The Add verb behind every catalogue row.
 *
 * `searchCatalog` and `addPendingLike` are the network and are mocked;
 * `resolveImport.ts` and `searchModel.tsx`'s `isAbout` run for real, because
 * which candidate gets handed to the importer is part of what is under test.
 */
const net = vi.hoisted(() => ({
  searchCatalog: vi.fn<(s: unknown, q: string, signal?: AbortSignal) => Promise<SearchResult[]>>(),
  addPendingLike: vi.fn<(s: unknown, artist: string, title: string) => Promise<void>>(),
}));

vi.mock('../server.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server.ts')>()),
  searchCatalog: net.searchCatalog,
  addPendingLike: net.addPendingLike,
}));

const { useCatalogSearch } = await import('./useCatalogSearch.ts');
const { IMPORTER_PLUGIN_ID } = await import('../../plugins/runtime.tsx');

const server = { url: 'https://hub.example', token: 't', username: 'matt' } as ServerSession;

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: 'row-1',
  kind: 'track',
  title: 'Karma Police',
  subtitle: 'Radiohead',
  cover: null,
  url: 'https://open.spotify.com/track/abc',
  source: 'spotify',
  importable: true,
  ...over,
});

const noOwned: OwnedIndex = { find: () => null, has: () => false };

/**
 * A downloads bridge whose enqueue can be HELD OPEN.
 *
 * The point of the suite: while an enqueue is in the air is exactly when a
 * second tap arrives, and a fixture that resolves immediately would never
 * reproduce it.
 */
function fakeDownloads() {
  const calls: string[] = [];
  const waiting: (() => void)[] = [];
  let holding = false;
  const enqueue = vi.fn(async (url: string) => {
    calls.push(url);
    if (holding) await new Promise<void>((r) => waiting.push(r));
    return { id: `job-${calls.length}` };
  });
  return {
    calls,
    enqueue,
    /** Every enqueue from here on hangs until `finish()`. */
    hold() {
      holding = true;
    },
    finish() {
      holding = false;
      for (const r of waiting.splice(0)) r();
    },
    value: { enqueue } as unknown as DownloadsContextValue,
  };
}

/** An acquire surface that routes everything through the importer plugin. */
const viaImporter: AcquireValue = {
  handlersFor: () => [{ pluginId: IMPORTER_PLUGIN_ID }],
  acquire: vi.fn(),
} as unknown as AcquireValue;

type Props = Parameters<typeof useCatalogSearch>[0];

const props = (over: Partial<Props> = {}): Props => ({
  query: '',
  parsedPhrase: '',
  shownPaths: new Set<string>(),
  owned: noOwned,
  acquire: viaImporter,
  downloads: null,
  playPending: null,
  server,
  ...over,
});

function mount(over: Partial<Props> = {}) {
  return renderHook((p: Props) => useCatalogSearch(p), { initialProps: props(over) });
}

beforeEach(() => {
  net.searchCatalog.mockReset().mockResolvedValue([]);
  net.addPendingLike.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('acquireResult - the in-flight guard', () => {
  it('adds the same song ONCE when it is tapped twice in quick succession', async () => {
    /*
     * REGRESSION.
     *
     * The guard reads `adding`, which is state - and on the importable path
     * (a plain track from /api/search, which is the common row) nothing writes
     * `adding` until the enqueue has come BACK. So a second tap while the
     * first is still in the air reads the same empty map the first one read,
     * walks straight past the guard, and queues the download again.
     *
     * A double tap on Add is two downloads of one song. The two calls below
     * are deliberately not awaited between - that is what "quick succession"
     * means here, and awaiting them in turn would let React re-render and hide
     * the bug behind a fresh closure.
     */
    const downloads = fakeDownloads();
    downloads.hold();
    const hook = mount({ downloads: downloads.value });
    const row = result();

    await act(async () => {
      const first = hook.result.current.acquireResult(row);
      const second = hook.result.current.acquireResult(row);
      downloads.finish();
      await Promise.all([first, second]);
    });

    expect(downloads.enqueue).toHaveBeenCalledTimes(1);
  });

  it('lets a DIFFERENT song through at the same moment', async () => {
    // The half that makes the test above mean something: the guard is per
    // row, not a lock on the button.
    const downloads = fakeDownloads();
    downloads.hold();
    const hook = mount({ downloads: downloads.value });

    await act(async () => {
      const a = hook.result.current.acquireResult(result({ id: 'a' }));
      const b = hook.result.current.acquireResult(result({ id: 'b', url: 'https://open.spotify.com/track/b' }));
      downloads.finish();
      await Promise.all([a, b]);
    });

    expect(downloads.enqueue).toHaveBeenCalledTimes(2);
  });

  it('releases the row once the add has finished, so a LIKE can still upgrade it', async () => {
    // The guard must be an in-flight marker, not a permanent one - hearting a
    // row already added is a real second journey through this function.
    const downloads = fakeDownloads();
    const hook = mount({ downloads: downloads.value });
    const row = result();

    await act(async () => {
      await hook.result.current.acquireResult(row);
    });
    expect(hook.result.current.adding[row.id]).toBe('added');

    await act(async () => {
      await hook.result.current.acquireResult(row, { like: true });
    });
    expect(hook.result.current.adding[row.id]).toBe('liked');
    expect(net.addPendingLike).toHaveBeenCalledWith(server, 'Radiohead', 'Karma Police');
  });

  it('ignores a plain re-tap of a row already added', async () => {
    const downloads = fakeDownloads();
    const hook = mount({ downloads: downloads.value });
    const row = result();

    await act(async () => {
      await hook.result.current.acquireResult(row);
    });
    await act(async () => {
      await hook.result.current.acquireResult(row);
    });
    expect(downloads.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('acquireResult - which link gets handed over', () => {
  it('hands an importable row’s own link straight to the importer', async () => {
    const downloads = fakeDownloads();
    const hook = mount({ downloads: downloads.value });
    await act(async () => {
      await hook.result.current.acquireResult(result());
    });
    expect(downloads.calls).toEqual(['https://open.spotify.com/track/abc']);
    expect(net.searchCatalog).not.toHaveBeenCalled();
  });

  it('looks up a Deezer ALBUM’s Spotify twin first', async () => {
    // "An album usually arrives from Deezer, which the importer refuses as
    // primary input."
    const downloads = fakeDownloads();
    net.searchCatalog.mockResolvedValue([
      result({
        kind: 'album',
        title: 'OK Computer',
        subtitle: 'Radiohead',
        url: 'https://open.spotify.com/album/twin',
      }),
    ]);
    const hook = mount({ downloads: downloads.value });
    const deezer = result({
      kind: 'album',
      title: 'OK Computer',
      url: 'https://www.deezer.com/album/1',
      importable: false,
    });

    await act(async () => {
      await hook.result.current.acquireResult(deezer);
    });
    expect(downloads.calls).toEqual(['https://open.spotify.com/album/twin']);
    expect(hook.result.current.adding[deezer.id]).toBe('added');
  });

  it('says "missing" when the twin cannot be found, and forgets it after four seconds', async () => {
    vi.useFakeTimers();
    net.searchCatalog.mockResolvedValue([]);
    const downloads = fakeDownloads();
    const hook = mount({ downloads: downloads.value });
    const deezer = result({ url: 'https://www.deezer.com/track/1', importable: false });

    await act(async () => {
      await hook.result.current.acquireResult(deezer);
    });
    expect(hook.result.current.adding[deezer.id]).toBe('missing');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    // Back to an Add button, rather than a row stuck saying "missing" forever.
    expect(hook.result.current.adding[deezer.id]).toBeUndefined();
  });

  it('does nothing at all when there is no server to ask', async () => {
    const downloads = fakeDownloads();
    const hook = mount({ downloads: downloads.value, server: null });
    const deezer = result({ url: 'https://www.deezer.com/track/1', importable: false });
    await act(async () => {
      await hook.result.current.acquireResult(deezer);
    });
    expect(downloads.enqueue).not.toHaveBeenCalled();
    expect(hook.result.current.adding[deezer.id]).toBeUndefined();
  });

  it('writes the pending like under the RESOLVED name, not the row’s', async () => {
    // Keyed as close as possible to the tags the landed file will carry.
    net.searchCatalog.mockResolvedValue([
      result({
        title: 'Knuckle Velvet',
        subtitle: 'Ashnikko',
        url: 'https://open.spotify.com/track/resolved',
      }),
    ]);
    const downloads = fakeDownloads();
    const hook = mount({ downloads: downloads.value });
    const row = result({
      title: 'Knuckle Velvet (feat. Yah Wav)',
      subtitle: 'Ashnikko',
      url: 'https://www.deezer.com/track/1',
      importable: false,
    });

    await act(async () => {
      await hook.result.current.acquireResult(row, { like: true });
    });
    expect(net.addPendingLike).toHaveBeenCalledWith(server, 'Ashnikko', 'Knuckle Velvet');
    expect(hook.result.current.adding[row.id]).toBe('liked');
  });

  it('falls back to the plugin chooser when no importer is running', async () => {
    const acquire = { handlersFor: () => [], acquire: vi.fn() } as unknown as AcquireValue;
    const downloads = fakeDownloads();
    const hook = mount({ acquire, downloads: downloads.value });
    await act(async () => {
      await hook.result.current.acquireResult(result());
    });
    expect(downloads.enqueue).not.toHaveBeenCalled();
    expect((acquire.acquire as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      kind: 'track',
      title: 'Karma Police',
      artist: 'Radiohead',
      url: 'https://open.spotify.com/track/abc',
    });
  });
});

describe('the catalogue list', () => {
  it('debounces, so only the last query of a burst is sent', async () => {
    vi.useFakeTimers();
    const hook = mount({ query: 'r', parsedPhrase: 'r' });
    for (const q of ['ra', 'rad', 'radiohead']) {
      hook.rerender(props({ query: q, parsedPhrase: q }));
      // Well inside the 350ms window, so each keystroke cancels the last.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(net.searchCatalog).toHaveBeenCalledTimes(1);
    expect(net.searchCatalog.mock.calls[0]?.[1]).toBe('radiohead');
  });

  it('stands a catalogue row aside when its own copy is already on the page', async () => {
    const mine = track({ path: '/music/karma.mp3', title: 'Karma Police', artist: 'Radiohead' });
    const owned: OwnedIndex = { find: () => mine, has: () => true };
    net.searchCatalog.mockResolvedValue([result()]);
    const hook = mount({
      query: 'karma',
      owned,
      shownPaths: new Set([mine.path]),
    });
    await waitFor(() => expect(hook.result.current.catalog).not.toBe(null));
    expect(hook.result.current.outside).toEqual([]);
  });

  it('KEEPS it when the copy is one the page is not showing', async () => {
    const mine = track({ path: '/music/karma.mp3' });
    const owned: OwnedIndex = { find: () => mine, has: () => true };
    net.searchCatalog.mockResolvedValue([result()]);
    const hook = mount({ query: 'karma', owned, shownPaths: new Set<string>() });
    await waitFor(() => expect(hook.result.current.catalog).not.toBe(null));
    expect(hook.result.current.outside).toHaveLength(1);
  });

  it('promotes the artist whose name IS the query to the front', async () => {
    // The server sends artists last; an artist sitting nineteenth may as well
    // not exist in a section that shows a handful.
    net.searchCatalog.mockResolvedValue([
      result({ id: 't1', kind: 'track', title: 'Creep' }),
      result({ id: 'a1', kind: 'artist', title: 'Radiohead' }),
    ]);
    const hook = mount({ query: 'radiohead', parsedPhrase: 'radiohead' });
    await waitFor(() => expect(hook.result.current.catalog).not.toBe(null));
    expect(hook.result.current.outside.map((r) => r.id)).toEqual(['a1', 't1']);
  });

  it('leaves the server’s order alone when no artist answers to the query', async () => {
    net.searchCatalog.mockResolvedValue([
      result({ id: 't1', kind: 'track', title: 'Creep' }),
      result({ id: 'a1', kind: 'artist', title: 'Portishead' }),
    ]);
    const hook = mount({ query: 'creep', parsedPhrase: 'creep' });
    await waitFor(() => expect(hook.result.current.catalog).not.toBe(null));
    expect(hook.result.current.outside.map((r) => r.id)).toEqual(['t1', 'a1']);
  });

  it('does not ask at all with no server, or with an empty query', async () => {
    vi.useFakeTimers();
    const hook = mount({ query: 'radiohead', server: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(net.searchCatalog).not.toHaveBeenCalled();
    expect(hook.result.current.catalog).toBe(null);
  });
});
