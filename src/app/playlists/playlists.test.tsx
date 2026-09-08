import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

/**
 * The LOCAL playlist store - the one that runs with no server signed in.
 *
 * Only `useServerSession` is mocked, and only to say "signed out", which is
 * what selects this half of the provider. Everything else - the reducers, the
 * storage write, the pre-0.3.286 decoration migration - is real.
 */
vi.mock('../servers/serverSession.tsx', () => ({ useServerSession: () => ({ session: null }) }));

const { PlaylistsProvider, usePlaylists, isGeneratedPlaylist, GENERATED_PLAYLIST_FOLDERS } =
  await import('./playlists.tsx');
const { metaKey, setMeta, metaFor } = await import('./playlistMeta.ts');

const STORAGE_KEY = 'attackfm-playlists';

const wrapper = ({ children }: { children: ReactNode }) => (
  <PlaylistsProvider>{children}</PlaylistsProvider>
);

function store() {
  const { result } = renderHook(() => usePlaylists(), { wrapper });
  return result;
}

/** Creates a list and hands back its id, the id being what every verb takes. */
async function withList(
  result: ReturnType<typeof store>,
  name = 'Road trip',
  paths: string[] = [],
) {
  let id = '';
  await act(async () => {
    id = await result.current.create(name, paths);
  });
  return id;
}

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { name: string }[];

beforeEach(() => {
  localStorage.clear();
});

describe('create', () => {
  it('makes a list holding the song that prompted it', async () => {
    // "New playlist" in the add-to-playlist panel: the song is in it from the
    // first moment rather than added a beat later.
    const result = store();
    const id = await withList(result, 'Road trip', ['/a.mp3']);
    expect(result.current.playlists.find((p) => p.id === id)?.paths).toEqual(['/a.mp3']);
  });

  it('drops duplicate paths it is born with', async () => {
    const result = store();
    const id = await withList(result, 'Dupes', ['/a.mp3', '/a.mp3', '/b.mp3']);
    expect(result.current.playlists.find((p) => p.id === id)?.paths).toEqual(['/a.mp3', '/b.mp3']);
  });

  it('names an unnamed list rather than leaving it blank', async () => {
    const result = store();
    await withList(result, '   ');
    expect(result.current.playlists[0]?.name).toBe('New Playlist');
  });

  it('gives every list its own id', async () => {
    const result = store();
    const a = await withList(result, 'A');
    const b = await withList(result, 'B');
    expect(a).not.toBe(b);
  });

  it('writes through, so the lists survive a relaunch', async () => {
    const result = store();
    await withList(result, 'Road trip');
    expect(stored().map((p) => p.name)).toEqual(['Road trip']);
  });
});

describe('addTrack / removeTrack', () => {
  it('appends to the end', async () => {
    const result = store();
    const id = await withList(result, 'L', ['/a.mp3']);
    act(() => result.current.addTrack(id, '/b.mp3'));
    expect(result.current.playlists[0]?.paths).toEqual(['/a.mp3', '/b.mp3']);
  });

  it('leaves an already-present path WHERE IT IS', async () => {
    // Not a bump to the end: a playlist's order is the listener's, and adding
    // a song twice should not silently reorder the list.
    const result = store();
    const id = await withList(result, 'L', ['/a.mp3', '/b.mp3']);
    act(() => result.current.addTrack(id, '/a.mp3'));
    expect(result.current.playlists[0]?.paths).toEqual(['/a.mp3', '/b.mp3']);
  });

  it('removes every copy of a path and leaves the rest in order', async () => {
    const result = store();
    const id = await withList(result, 'L', ['/a.mp3', '/b.mp3', '/c.mp3']);
    act(() => result.current.removeTrack(id, '/b.mp3'));
    expect(result.current.playlists[0]?.paths).toEqual(['/a.mp3', '/c.mp3']);
  });

  it('touches only the named list', async () => {
    const result = store();
    const a = await withList(result, 'A', ['/x.mp3']);
    await withList(result, 'B', ['/x.mp3']);
    act(() => result.current.removeTrack(a, '/x.mp3'));
    expect(result.current.playlists.map((p) => p.paths.length)).toEqual([0, 1]);
  });
});

describe('rename', () => {
  it('renames', async () => {
    const result = store();
    const id = await withList(result, 'Old');
    act(() => result.current.rename(id, ' New '));
    expect(result.current.playlists[0]?.name).toBe('New');
  });

  it('REFUSES an empty name rather than leaving a nameless list', async () => {
    const result = store();
    const id = await withList(result, 'Old');
    act(() => result.current.rename(id, '   '));
    expect(result.current.playlists[0]?.name).toBe('Old');
  });
});

describe('reorder', () => {
  it('takes the whole running order a drag commits', async () => {
    const result = store();
    const id = await withList(result, 'L', ['/a.mp3', '/b.mp3', '/c.mp3']);
    act(() => result.current.reorder(id, ['/c.mp3', '/a.mp3', '/b.mp3']));
    expect(result.current.playlists[0]?.paths).toEqual(['/c.mp3', '/a.mp3', '/b.mp3']);
  });

  it('copies the array it is handed, so a caller’s later edit does not reach in', async () => {
    const result = store();
    const id = await withList(result, 'L', ['/a.mp3', '/b.mp3']);
    const order = ['/b.mp3', '/a.mp3'];
    act(() => result.current.reorder(id, order));
    order.push('/sneaky.mp3');
    expect(result.current.playlists[0]?.paths).toEqual(['/b.mp3', '/a.mp3']);
  });
});

describe('setMeta', () => {
  it('changes one field and leaves the other alone', async () => {
    const result = store();
    const id = await withList(result, 'L');
    act(() => result.current.setMeta(id, { description: ' For the drive ' }));
    act(() => result.current.setMeta(id, { folder: 'Trips' }));
    expect(result.current.playlists[0]?.description).toBe('For the drive');
    expect(result.current.playlists[0]?.folder).toBe('Trips');
  });

  it('clears a description back to empty', async () => {
    const result = store();
    const id = await withList(result, 'L');
    act(() => result.current.setMeta(id, { description: 'x' }));
    act(() => result.current.setMeta(id, { description: '' }));
    expect(result.current.playlists[0]?.description).toBe('');
  });
});

describe('remove', () => {
  it('deletes the list and only that list', async () => {
    const result = store();
    const a = await withList(result, 'A');
    await withList(result, 'B');
    act(() => result.current.remove(a));
    expect(result.current.playlists.map((p) => p.name)).toEqual(['B']);
  });
});

describe('the store on disk', () => {
  it('ignores an entry that is not a playlist at all', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'ok', name: 'Fine', paths: [] }, { id: 7 }, null, 'nope']),
    );
    expect(store().current.playlists.map((p) => p.name)).toEqual(['Fine']);
  });

  it('fills in decoration fields a pre-0.3.286 list never had', () => {
    // Every reader wants strings; filling them here beats checking at fifty
    // call sites.
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'old', name: 'Old', paths: [] }]));
    const p = store().current.playlists[0]!;
    expect(p.description).toBe('');
    expect(p.folder).toBe('');
    expect(p.coverUrl).toBe(null);
  });

  it('reads a torn store as no playlists rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(store().current.playlists).toEqual([]);
  });

  it('folds decoration out of the OLD device store, and deletes it there', () => {
    // "Two stores that can disagree about one description is how a device
    // shows yesterday's text forever."
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'old', name: 'Old', paths: [] }]));
    const key = metaKey(null, 'old');
    setMeta(key, { description: 'from the old store', folder: 'Trips' });
    const result = store();
    expect(result.current.playlists[0]?.description).toBe('from the old store');
    expect(result.current.playlists[0]?.folder).toBe('Trips');
    // ...and it is gone from where it used to live.
    expect(metaFor(key)).toEqual({});
  });
});

describe('isGeneratedPlaylist', () => {
  it('names the folders the SERVER fills, not the ones a person made', () => {
    // These belong on Discover, and never in the "Add to playlist" picker -
    // which listed them fifteen deep above the lists a person keeps.
    expect(isGeneratedPlaylist({ folder: 'Charts' })).toBe(true);
    expect(isGeneratedPlaylist({ folder: 'New music' })).toBe(true);
    expect(isGeneratedPlaylist({ folder: 'Road trips' })).toBe(false);
    expect(isGeneratedPlaylist({})).toBe(false);
  });

  it('is exact - a folder merely named LIKE one of them is a person’s', () => {
    expect(isGeneratedPlaylist({ folder: 'charts' })).toBe(false);
    expect(isGeneratedPlaylist({ folder: 'New music 2026' })).toBe(false);
    expect([...GENERATED_PLAYLIST_FOLDERS].sort()).toEqual(['Charts', 'New music']);
  });
});
