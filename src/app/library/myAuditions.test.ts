import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CollectorStatus, ServerSession } from '../server.ts';
import { remotePath } from '../server.ts';
import { track } from '../../test/libraryFixtures.ts';

/**
 * The auditions that are actually YOURS.
 *
 * `useLibrary().forYou` is every unadopted audition this client HOLDS, which
 * is not the same list. Three filters stand between the two, and each one was
 * added after a counter somewhere disagreed with the room it opened: the
 * owner, the heart, and the pass ledger. The pass ledger is real here
 * (`datePassed.ts` is a plain observable store), because a version bump that
 * fails to recompute is one of the two bugs this hook exists to prevent.
 */
const world = vi.hoisted(() => ({
  status: null as CollectorStatus | null,
  forYou: [] as unknown[],
  favorites: new Set<string>(),
  fetches: 0,
}));

vi.mock('../server.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server.ts')>()),
  fetchCollectorStatus: () => {
    world.fetches += 1;
    return world.status ? Promise.resolve(world.status) : Promise.reject(new Error('no collector'));
  },
}));

vi.mock('../servers/serverSession.tsx', () => ({
  useServerSession: () => ({ session: { url: 'https://hub.example', token: 't' } as ServerSession }),
}));

/*
 * `isFavorite` is ONE function for the life of the module, not a fresh arrow
 * per render. The real one comes out of a useMemo and is stable, and a mock
 * that changed identity every render would recompute the `mine` memo for free
 * - masking whether it really follows the pass ledger's version.
 */
const isFavorite = (path: string) => world.favorites.has(path);

vi.mock('./library.tsx', () => ({
  useLibrary: () => ({ forYou: world.forYou, isFavorite }),
}));

vi.mock('../nav/pageRefresh.tsx', () => ({ useRefreshNonce: () => 0 }));

const { useMyAuditions } = await import('./myAuditions.ts');
const { writePassed, readPassed } = await import('../date/datePassed.ts');

const status = (userId: number) => ({ userId, enabled: true }) as CollectorStatus;

/** An audition row: on the shelf for `userId`, unadopted, at `afm://<id>`. */
const audition = (id: number, userId: number, addedAt = id) =>
  track({ path: remotePath(id), curatorUserId: userId, curatorPromoted: false, addedAt });

beforeEach(() => {
  world.status = status(7);
  world.forYou = [];
  world.favorites = new Set();
  world.fetches = 0;
  writePassed(new Set());
});

afterEach(() => {
  writePassed(new Set());
});

async function auditions() {
  const { result } = renderHook(() => useMyAuditions());
  await waitFor(() => expect(result.current.status).not.toBe(null));
  return result;
}

describe('useMyAuditions', () => {
  it('keeps only the rows this account is the curator for', async () => {
    // "The shelf said 220 and the chip said 767 on the same screen, from the
    // same array" - ForYouShelf had the owner filter and the chip did not.
    world.forYou = [audition(1, 7), audition(2, 99), audition(3, 7)];
    const result = await auditions();
    expect(result.current.mine.map((t) => t.path)).toEqual([remotePath(3), remotePath(1)]);
  });

  it('drops a song that has already been KEPT', async () => {
    // A heart is a verdict, and a song with a verdict is not waiting for one.
    world.forYou = [audition(1, 7), audition(2, 7)];
    world.favorites = new Set([remotePath(2)]);
    const result = await auditions();
    expect(result.current.mine.map((t) => t.path)).toEqual([remotePath(1)]);
  });

  it('drops a song that has already been PASSED', async () => {
    world.forYou = [audition(1, 7), audition(2, 7)];
    writePassed(new Set([2]));
    const result = await auditions();
    expect(result.current.mine.map((t) => t.path)).toEqual([remotePath(1)]);
  });

  it('recomputes when a pass is written while the hook is mounted', async () => {
    /*
     * REGRESSION. Passes are remembered across launches, so the count has to
     * move when one is written - otherwise it only corrects itself on the next
     * full reload, which is precisely how the chip came to claim "172 waiting"
     * over a Music Date that opened on its empty state.
     */
    world.forYou = [audition(1, 7), audition(2, 7)];
    const result = await auditions();
    expect(result.current.mine).toHaveLength(2);

    writePassed(new Set([1, 2]));
    await waitFor(() => expect(result.current.mine).toHaveLength(0));
  });

  it('shows NONE rather than everyone’s when it does not know who you are', async () => {
    // "Showing somebody else's auditions is the failure this is here to avoid,
    // and an empty shelf is the mild one."
    world.status = null;
    world.forYou = [audition(1, 7), audition(2, 99)];
    const { result } = renderHook(() => useMyAuditions());
    await waitFor(() => expect(world.fetches).toBeGreaterThan(0));
    expect(result.current.status).toBe(null);
    expect(result.current.mine).toEqual([]);
  });

  it('keeps a row whose path carries no track id, rather than losing it', async () => {
    // The ledger is keyed by id; a row without one cannot have been passed.
    world.forYou = [track({ path: '/local/file.mp3', curatorUserId: 7, curatorPromoted: false })];
    const result = await auditions();
    expect(result.current.mine).toHaveLength(1);
  });

  it('orders the deck newest first', async () => {
    world.forYou = [audition(1, 7, 100), audition(2, 7, 300), audition(3, 7, 200)];
    const result = await auditions();
    expect(result.current.mine.map((t) => t.addedAt)).toEqual([300, 200, 100]);
  });

  it('reads the ledger without letting a caller edit it in place', async () => {
    // `readPassed` hands out a COPY - Music Date mutates its own set and writes
    // it back, and handing out the cache would let that edit the ledger
    // unannounced.
    writePassed(new Set([1]));
    const copy = readPassed();
    copy.add(2);
    world.forYou = [audition(2, 7)];
    const result = await auditions();
    expect(result.current.mine).toHaveLength(1);
  });
});
