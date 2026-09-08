import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { RemoteTrack, ServerSession } from '../server.ts';

/**
 * The library provider, over TWO hubs.
 *
 * Almost everything here is real: `sessions.ts` (so `normalise` and
 * `sessionForOrigin` do their own work), `toTrack`, `remotePath`,
 * `trackIdFromPath` and `originFromPath`. Only the six calls that would touch
 * the network or IndexedDB are replaced, because the subject is what the
 * provider DERIVES from their answers - which hub a path belongs to, which
 * hub's heart list to read, and which hub's session a heart is written with.
 */

const hub = vi.hoisted(() => ({
  /** Rows each server holds, by normalised url. */
  index: new Map<string, unknown[]>(),
  /** Favourite ids each server holds, by normalised url. */
  favorites: new Map<string, number[]>(),
  /** Every heart written, so a test can say WHICH server it went to. */
  written: [] as { url: string; id: number; on: boolean }[],
  /** Set to reject the next write, standing in for a server that refuses. */
  refuse: false,
}));

vi.mock('../server.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server.ts')>();
  const key = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
  return {
    ...actual,
    loadCachedIndex: (url: string) => ({ rev: 1, tracks: hub.index.get(key(url)) ?? [] }),
    hydrateCachedIndex: (url: string) =>
      Promise.resolve({ rev: 1, tracks: hub.index.get(key(url)) ?? [] }),
    syncLibrary: (session: ServerSession) =>
      Promise.resolve({ tracks: hub.index.get(key(session.url)) ?? [], changed: true }),
    fetchRemoteFavorites: (session: ServerSession) =>
      Promise.resolve(hub.favorites.get(key(session.url)) ?? []),
    setRemoteFavorite: (session: ServerSession, id: number, on: boolean) => {
      hub.written.push({ url: key(session.url), id, on });
      return hub.refuse ? Promise.reject(new Error('refused')) : Promise.resolve();
    },
    requestScan: () => Promise.resolve(),
  };
});

vi.mock('../servers/serverSession.tsx', () => ({
  useServerSession: () => ({ session: primary }),
}));
vi.mock('../downloads/autoCache.ts', () => ({ nudgeSweep: () => {} }));
vi.mock('../player/carplay.ts', () => ({ pushCarPlayLibrary: () => Promise.resolve() }));
vi.mock('../servers/serverNames.ts', () => ({ learnServerName: () => {} }));

const { LibraryProvider, useLibrary } = await import('./library.tsx');
const { remotePath } = await import('../server.ts');
const { forgetSession, rememberSession } = await import('../servers/sessions.ts');

const PRIMARY = 'https://primary.example';
const SECOND = 'https://second.example';

const session = (url: string): ServerSession =>
  ({ url, token: `token-for-${url}`, username: 'matt' }) as ServerSession;

const primary = session(PRIMARY);
const second = session(SECOND);

/** A row as a server sends it - only the fields this suite reads are named. */
const row = (over: Partial<RemoteTrack> & { id: number }): RemoteTrack =>
  ({
    title: `Track ${over.id}`,
    artist: 'Some Artist',
    albumArtist: '',
    album: 'Some Album',
    trackNo: null,
    discNo: null,
    year: null,
    genre: '',
    lyrics: '',
    duration: 180,
    codec: 'flac',
    lossless: true,
    sampleRate: 44100,
    bitDepth: 16,
    channels: 2,
    bitrate: null,
    sizeBytes: 1,
    addedAt: 1_700_000_000_000 + over.id,
    artId: null,
    rev: 1,
    ...over,
  }) as RemoteTrack;

const wrapper = ({ children }: { children: ReactNode }) => (
  <LibraryProvider>{children}</LibraryProvider>
);

/** Renders the provider and waits for the first sync to settle. */
async function library() {
  const { result } = renderHook(() => useLibrary(), { wrapper });
  await waitFor(() => expect(result.current.indexing).toBe(false));
  return result;
}

beforeEach(() => {
  hub.index.clear();
  hub.favorites.clear();
  hub.written.length = 0;
  hub.refuse = false;
  rememberSession(primary, true);
  rememberSession(second, false);
});

afterEach(() => {
  forgetSession(PRIMARY);
  forgetSession(SECOND);
});

describe('the quarantine split', () => {
  beforeEach(() => {
    hub.index.set(PRIMARY, [
      row({ id: 1, title: 'Bought' }),
      row({ id: 2, title: 'Unadopted', curatorUserId: 7, curatorPromoted: false }),
      row({ id: 3, title: 'Adopted', curatorUserId: 7, curatorPromoted: true }),
      row({ id: 4, title: 'A Reading', kind: 'book' }),
    ] as unknown[] as RemoteTrack[]);
  });

  it('keeps an unadopted collector row OFF the shelves and on "For you"', async () => {
    const result = await library();
    expect(result.current.tracks.map((t) => t.title)).toEqual(['Adopted', 'Bought']);
    expect(result.current.forYou.map((t) => t.title)).toEqual(['Unadopted']);
  });

  it('promotes an adopted one into the library proper', async () => {
    // The other side of the same line: `curatorPromoted` is what a listen-
    // through or a heart flips, and it must move the row.
    const result = await library();
    expect(result.current.tracks.some((t) => t.title === 'Adopted')).toBe(true);
    expect(result.current.forYou.some((t) => t.title === 'Adopted')).toBe(false);
  });

  it('holds books apart from the music, on their own shelf', async () => {
    const result = await library();
    expect(result.current.books.map((t) => t.title)).toEqual(['A Reading']);
    expect(result.current.tracks.some((t) => t.kind === 'book')).toBe(false);
    expect(result.current.forYou.some((t) => t.kind === 'book')).toBe(false);
  });

  it('still resolves EVERY row through allTracks', async () => {
    // "Use this to answer 'which row is id N'". Connect hands a remote a bare
    // id, and asking `tracks` answered NOTHING while the other device was
    // playing a book or an audition.
    const result = await library();
    expect(result.current.allTracks.map((t) => t.title).sort()).toEqual([
      'A Reading',
      'Adopted',
      'Bought',
      'Unadopted',
    ]);
  });

  it('orders the shelf newest first', async () => {
    const result = await library();
    const dates = result.current.tracks.map((t) => t.addedAt);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });
});

describe('hearting a song on a SECOND hub', () => {
  const secondPath = () => remotePath(42, SECOND);

  beforeEach(() => {
    hub.index.set(PRIMARY, [row({ id: 1, title: 'Ours' })] as unknown[] as RemoteTrack[]);
    hub.index.set(SECOND, [row({ id: 42, title: 'Theirs' })] as unknown[] as RemoteTrack[]);
  });

  it('changes what isFavorite answers', async () => {
    /*
     * REGRESSION, and the one this suite exists for.
     *
     * `otherFavorites` is read inside the context value's memo but was missing
     * from its dependency list, so a heart on a song from another server
     * updated state and NOTHING re-derived: the row stayed unhearted while the
     * server had already been told. The bug is invisible on one hub, which is
     * how it survived.
     */
    const result = await library();
    expect(result.current.isFavorite(secondPath())).toBe(false);

    result.current.toggleFavorite(secondPath());
    await waitFor(() => expect(result.current.isFavorite(secondPath())).toBe(true));
  });

  it('writes the heart to THAT hub, with that hub’s own session', async () => {
    // The earlier half of the same bug: the heart dropped the origin and wrote
    // favourite #42 on whichever server happened to be current.
    const result = await library();
    result.current.toggleFavorite(secondPath());
    await waitFor(() => expect(hub.written).toHaveLength(1));
    expect(hub.written[0]).toEqual({ url: SECOND, id: 42, on: true });
  });

  it('unhearts it again', async () => {
    const result = await library();
    result.current.toggleFavorite(secondPath());
    await waitFor(() => expect(result.current.isFavorite(secondPath())).toBe(true));
    result.current.toggleFavorite(secondPath());
    await waitFor(() => expect(result.current.isFavorite(secondPath())).toBe(false));
    expect(hub.written.map((w) => w.on)).toEqual([true, false]);
  });

  it('puts the heart back when that server refuses', async () => {
    const result = await library();
    hub.refuse = true;
    result.current.toggleFavorite(secondPath());
    await waitFor(() => expect(hub.written).toHaveLength(1));
    await waitFor(() => expect(result.current.isFavorite(secondPath())).toBe(false));
  });

  it('does not write a heart for a hub this device is not signed in to', async () => {
    // `sessionForOrigin` has to hand back THAT server's session or the write
    // would go somewhere else wearing the wrong token.
    const result = await library();
    forgetSession(SECOND);
    result.current.toggleFavorite(secondPath());
    expect(hub.written).toEqual([]);
  });
});

describe('two hubs holding the same track id', () => {
  beforeEach(() => {
    // The secondary row is NEWER, so it sorts first and would be the one a
    // single flat id map kept - which is exactly the collision being tested.
    // With equal timestamps the assertion below would pass on whichever row
    // the sort happened to leave in front, and prove nothing.
    hub.index.set(PRIMARY, [
      row({ id: 42, title: 'Ours #42', addedAt: 1_000 }),
    ] as unknown[] as RemoteTrack[]);
    hub.index.set(SECOND, [
      row({ id: 42, title: 'Theirs #42', addedAt: 9_000 }),
    ] as unknown[] as RemoteTrack[]);
    hub.favorites.set(PRIMARY, [42]);
  });

  it('does not let one hub’s #42 answer for the other’s', async () => {
    // One flat map collided the moment a second hub was live: last write won,
    // and a secondary song could shadow a primary one in Liked.
    const result = await library();
    expect(result.current.isFavorite(remotePath(42))).toBe(true);
    expect(result.current.isFavorite(remotePath(42, SECOND))).toBe(false);
  });

  it('lists only the hub’s own copy under Liked', async () => {
    // One flat map kept whichever #42 it saw first - here the newer, secondary
    // one - and a song from another server shadowed a primary one in Liked.
    const result = await library();
    expect(result.current.favoriteTracks.map((t) => t.title)).toEqual(['Ours #42']);
  });

  it('answers false for a path that names no track id at all', async () => {
    const result = await library();
    expect(result.current.isFavorite('/local/file.mp3')).toBe(false);
  });
});
