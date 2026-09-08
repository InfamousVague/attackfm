/**
 * `mosaicArts` - one cover per ALBUM, in track order.
 *
 * The header records a bug that ran for years: "A server art URL is
 * `/api/art/{sha}?t={streamToken}&track={trackId}` - the sha IS the album,
 * because the server content-addresses the image bytes, but the trailing
 * `track` differs for every song. Comparing whole URLs therefore never matched,
 * so four songs off one record produced four different strings for the same
 * picture and every mosaic in the app drew that one sleeve four times over."
 *
 * A dedupe that silently does nothing is the hardest kind of bug to notice, so
 * the first test here is the exact failing input, and the last few are the
 * cases where whole-URL comparison IS still the honest answer.
 */
import { describe, expect, it } from 'vitest';
import { mosaicArts } from './artLoad.ts';

/** A server cover: same album (`sha`), a different `track` per song, and a
 *  stream token that rotates. */
const cover = (sha: string, track: number, token = 'tok1') =>
  `https://hub.test/api/art/${sha}?t=${token}&track=${track}`;

describe('REGRESSION: four songs off one record are one sleeve', () => {
  it('folds covers that differ only by the track id', () => {
    const arts = [cover('aaa', 1), cover('aaa', 2), cover('aaa', 3), cover('aaa', 4)];
    expect(mosaicArts(arts, 4)).toHaveLength(1);
  });

  it('folds them across a token rotation too', () => {
    // The token is the other inert half of the query, and it changes on renew.
    expect(mosaicArts([cover('aaa', 1, 'tok1'), cover('aaa', 2, 'tok9')], 4)).toHaveLength(1);
  });

  it('DOES keep two genuinely different albums', () => {
    // The case that makes the two above mean something: a dedupe strict enough
    // to fold everything would also pass the tests written only for folding.
    const arts = [cover('aaa', 1), cover('bbb', 2), cover('ccc', 3)];
    expect(mosaicArts(arts, 4)).toHaveLength(3);
  });

  it('keeps two albums served by different hubs', () => {
    // Origin is part of the identity: the same sha on two servers is two
    // fetches, and folding them would point one hub's tile at the other.
    const arts = ['https://a.test/api/art/aaa?track=1', 'https://b.test/api/art/aaa?track=2'];
    expect(mosaicArts(arts, 4)).toHaveLength(2);
  });
});

describe('what comes out', () => {
  it('keeps track order, so the first sleeve is the first song', () => {
    const out = mosaicArts([cover('bbb', 1), cover('aaa', 2), cover('ccc', 3)], 4);
    expect(out.map((u) => new URL(u).pathname)).toEqual([
      '/api/art/bbb',
      '/api/art/aaa',
      '/api/art/ccc',
    ]);
  });

  it('stops at `take`, and does not walk the rest of a long library', () => {
    const arts = Array.from({ length: 500 }, (_, i) => cover(`sha${i}`, i));
    expect(mosaicArts(arts, 4)).toHaveLength(4);
    expect(mosaicArts(arts, 1)).toHaveLength(1);
  });

  it('asks for the variant it was given', () => {
    // 640 for a tile you look AT; 160 for the cover wall behind a header,
    // which is blurred to nothing and would otherwise fetch a dozen full-size
    // covers to throw most of their pixels away.
    expect(mosaicArts([cover('aaa', 1)], 4, 640)[0]).toContain('size=640');
    expect(mosaicArts([cover('aaa', 1)], 4, 160)[0]).toContain('size=160');
    // Default is the tile size.
    expect(mosaicArts([cover('aaa', 1)])[0]).toContain('size=640');
  });

  it('appends the variant with the right separator', () => {
    expect(mosaicArts(['https://hub.test/api/art/aaa'], 4)[0]).toBe(
      'https://hub.test/api/art/aaa?size=640',
    );
    expect(mosaicArts(['https://hub.test/api/art/aaa?t=1'], 4)[0]).toBe(
      'https://hub.test/api/art/aaa?t=1&size=640',
    );
  });

  it('drops the songs with no cover at all', () => {
    expect(mosaicArts([null, cover('aaa', 1), null, cover('bbb', 2)], 4)).toHaveLength(2);
    expect(mosaicArts([null, null], 4)).toEqual([]);
    expect(mosaicArts([], 4)).toEqual([]);
  });
});

describe('a local file has no shared identity, and is not pretended to', () => {
  it('passes a blob: URL through whole, query and all', () => {
    // "a query string BREAKS one - the blob store keys on the full serialized
    // URL - so anything that is not http(s) passes through whole."
    const blob = 'blob:http://localhost/9f0a-1111';
    expect(mosaicArts([blob], 4)).toEqual([blob]);
    expect(mosaicArts([blob], 4)[0]).not.toContain('size=');
  });

  it('still repeats a local album, which is the documented limitation', () => {
    /*
     * "each track's cover is its own `blob:` URL with no shared identity to
     * compare, so a local album still repeats. Fixing that needs the scanner
     * to hash the picture, which is a bigger job than this one."
     *
     * Pinned as it is, not as it should be - so that the day somebody hashes
     * the picture, this test is what tells them the behaviour moved.
     */
    const out = mosaicArts(['blob:http://localhost/a', 'blob:http://localhost/b'], 4);
    expect(out).toHaveLength(2);
  });

  it('folds two identical blob URLs, which are genuinely one object', () => {
    const blob = 'blob:http://localhost/same';
    expect(mosaicArts([blob, blob], 4)).toEqual([blob]);
  });

  it('compares an unparseable string whole rather than throwing', () => {
    expect(mosaicArts(['not a url', 'not a url', 'other'], 4)).toEqual(['not a url', 'other']);
  });
});
