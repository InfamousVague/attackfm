import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult, ServerSession } from '../server.ts';

/**
 * Finding a record the importer can actually take.
 *
 * `searchCatalog` is the only thing here that touches the network, so it is
 * the only thing mocked - the scoring and the two-query fallback are the
 * subject and run for real. The mock is declared before the import because
 * `resolveImport.ts` binds the function at module load.
 */
const searchCatalog = vi.fn<(s: ServerSession, q: string, signal?: AbortSignal) => Promise<SearchResult[]>>();
vi.mock('../server.ts', () => ({ searchCatalog: (...a: unknown[]) => searchCatalog(...(a as [ServerSession, string])) }));

const { PROBE_URL, importable, resolveImportable } = await import('./resolveImport.ts');

const session = { url: 'https://hub.example', token: 't', username: 'matt' } as ServerSession;

const row = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: 'r1',
  kind: 'album',
  title: 'OK Computer',
  subtitle: 'Radiohead',
  cover: null,
  url: 'https://open.spotify.com/album/abc',
  source: 'spotify',
  importable: true,
  ...over,
});

beforeEach(() => {
  searchCatalog.mockReset();
});

describe('importable', () => {
  it('believes a server that says so, either way', () => {
    expect(importable({ url: 'https://deezer.com/album/1', importable: true })).toBe(true);
    expect(importable({ url: 'https://open.spotify.com/album/1', importable: false })).toBe(false);
  });

  it('works it out from the LINK when the server did not say', () => {
    /*
     * REGRESSION. An older server simply omits the field, and reading
     * `undefined` as "no" made the resolver reject every candidate - so every
     * record on every artist page answered "Not on Spotify", which is both
     * wrong and the least debuggable way to be wrong.
     */
    expect(importable({ url: 'https://open.spotify.com/album/1' })).toBe(true);
    expect(importable({ url: 'spotify:album:1' })).toBe(true);
  });

  it('still says no to a link the importer really cannot take', () => {
    // The half that stops the rule above from being "always true".
    expect(importable({ url: 'https://www.deezer.com/album/1' })).toBe(false);
    expect(importable({ url: '' })).toBe(false);
  });

  it('answers yes for the probe URL the Add control tests with', () => {
    // A downloader's canHandle tests a URL, so probing with an empty string
    // always says no and the control would never appear.
    expect(importable({ url: PROBE_URL })).toBe(true);
  });
});

describe('resolveImportable', () => {
  it('returns an exact title-and-artist match', async () => {
    searchCatalog.mockResolvedValue([row()]);
    const found = await resolveImportable(session, 'album', 'Radiohead', 'OK Computer');
    expect(found?.url).toBe('https://open.spotify.com/album/abc');
  });

  it('REJECTS a tribute record that is genuinely called what you asked for', () => {
    // "VSQ Performs Radiohead" and three string-quartet covers all answer to
    // the query. Importing one instead of the real thing is worse than
    // importing nothing.
    searchCatalog.mockResolvedValue([
      row({ title: 'OK Computer', subtitle: 'Vitamin String Quartet' }),
      row({ title: "Radiohead's OK Computer", subtitle: 'The Gentlemen Of NUCO' }),
    ]);
    return expect(
      resolveImportable(session, 'album', 'Radiohead', 'OK Computer'),
    ).resolves.toBe(null);
  });

  it('accepts a deluxe edition - the same record wearing a longer name', async () => {
    searchCatalog.mockResolvedValue([
      row({ title: 'OK Computer OKNOTOK 1997 2017', id: 'deluxe' }),
    ]);
    const found = await resolveImportable(session, 'album', 'Radiohead', 'OK Computer');
    expect(found?.id).toBe('deluxe');
  });

  it('refuses the reverse - a record whose name merely PREFIXES what you asked for', () => {
    searchCatalog.mockResolvedValue([row({ title: 'OK' })]);
    return expect(resolveImportable(session, 'album', 'Radiohead', 'OK Computer')).resolves.toBe(
      null,
    );
  });

  it('prefers the exact match over a longer edition, whatever order they arrive in', async () => {
    searchCatalog.mockResolvedValue([
      row({ title: 'OK Computer OKNOTOK 1997 2017', id: 'deluxe' }),
      row({ title: 'OK Computer', id: 'exact' }),
    ]);
    expect((await resolveImportable(session, 'album', 'Radiohead', 'OK Computer'))?.id).toBe(
      'exact',
    );
  });

  it('ignores a candidate of the wrong KIND', () => {
    searchCatalog.mockResolvedValue([row({ kind: 'track' })]);
    return expect(resolveImportable(session, 'album', 'Radiohead', 'OK Computer')).resolves.toBe(
      null,
    );
  });

  it('ignores a perfect match the importer cannot take', () => {
    // An unimportable candidate is no better than the link we already had.
    searchCatalog.mockResolvedValue([
      row({ url: 'https://www.deezer.com/album/1', importable: false }),
    ]);
    return expect(resolveImportable(session, 'album', 'Radiohead', 'OK Computer')).resolves.toBe(
      null,
    );
  });

  it('asks with the title REDUCED first, then falls back to the raw one', async () => {
    // A catalogue title carries its billing - "Knuckle Velvet (feat. Yah Wav)"
    // - and handing that whole string to search throws it off badly enough
    // that the right track does not come back at all.
    searchCatalog.mockResolvedValueOnce([]).mockResolvedValueOnce([
      row({ kind: 'track', title: 'Knuckle Velvet (feat. Yah Wav)', subtitle: 'Ashnikko' }),
    ]);
    const found = await resolveImportable(
      session,
      'track',
      'Ashnikko',
      'Knuckle Velvet (feat. Yah Wav)',
    );
    expect(searchCatalog.mock.calls.map((c) => c[1])).toEqual([
      'Ashnikko knuckle velvet',
      'Ashnikko Knuckle Velvet (feat. Yah Wav)',
    ]);
    expect(found).not.toBe(null);
  });

  it('asks ONCE when reducing the title changes nothing', async () => {
    searchCatalog.mockResolvedValue([]);
    await resolveImportable(session, 'album', 'Radiohead', 'Kid A');
    expect(searchCatalog).toHaveBeenCalledTimes(1);
  });

  it('does not ask a second time once the first query answered', async () => {
    searchCatalog.mockResolvedValue([
      row({ kind: 'track', title: 'Knuckle Velvet', subtitle: 'Ashnikko' }),
    ]);
    await resolveImportable(session, 'track', 'Ashnikko', 'Knuckle Velvet (feat. Yah Wav)');
    expect(searchCatalog).toHaveBeenCalledTimes(1);
  });

  it('matches an artist billed with extra names', async () => {
    searchCatalog.mockResolvedValue([
      row({ kind: 'track', title: 'Anti-Hero', subtitle: 'Taylor Swift, Bleachers' }),
    ]);
    expect(
      await resolveImportable(session, 'track', 'Taylor Swift', 'Anti-Hero'),
    ).not.toBe(null);
  });
});
