import { describe, expect, it } from 'vitest';
import { buildDiscography, buildPopular } from './artistData.ts';
import type { AlbumGroup } from './albums.ts';
import type { CatalogArtist, CatalogRelease, CatalogTrack } from '../server.ts';
import type { OwnedIndex } from '../library/owned.ts';
import { titleKey } from '../library/owned.ts';
import { track } from '../../test/libraryFixtures.ts';

/** The two builders that turn "what the catalogue knows" plus "what you have"
 *  into the artist page's two grids. Pure - the fetching hooks beside them are
 *  not the subject. */

const release = (over: Partial<CatalogRelease> = {}): CatalogRelease => ({
  id: 'c1',
  title: 'OK Computer',
  cover: 'catalogue.jpg',
  year: '1997',
  trackCount: 12,
  kind: 'album',
  url: 'https://open.spotify.com/album/1',
  importable: true,
  ...over,
});

const group = (name: string, over: Partial<AlbumGroup> = {}): AlbumGroup => ({
  name,
  artwork: 'mine.jpg',
  list: [track({ album: name })],
  ...over,
});

const profile = (over: Partial<CatalogArtist> = {}): CatalogArtist =>
  ({ id: 'a1', name: 'Radiohead', albums: [], singles: [], top: [], ...over }) as CatalogArtist;

/** An index over a fixed list, matching the way the real one folds titles. */
const ownedOver = (rows: ReturnType<typeof track>[]): OwnedIndex => {
  const find = (_artist: string | null | undefined, title: string | null | undefined) =>
    rows.find((t) => titleKey(t.title) === titleKey(title ?? '')) ?? null;
  return { find, has: (a, t) => find(a, t) !== null };
};

describe('buildDiscography', () => {
  it('marks a catalogue record you own, and shows YOUR cover for it', () => {
    const { records } = buildDiscography([group('OK Computer')], profile({ albums: [release()] }));
    expect(records).toHaveLength(1);
    expect(records[0]?.owned).not.toBe(null);
    expect(records[0]?.cover).toBe('mine.jpg');
  });

  it('falls back to the catalogue cover for a record you do not own', () => {
    const { records } = buildDiscography([], profile({ albums: [release()] }));
    expect(records[0]?.owned).toBe(null);
    expect(records[0]?.cover).toBe('catalogue.jpg');
  });

  it('matches your copy through titleKey, not by exact string', () => {
    // "OK Computer OKNOTOK" is a different record; "OK Computer (Remastered)"
    // is the same one under a longer tag.
    const { records } = buildDiscography(
      [group('OK Computer (Remastered)')],
      profile({ albums: [release()] }),
    );
    expect(records[0]?.owned).not.toBe(null);
  });

  it('KEEPS a record of yours the catalogue never listed', () => {
    // "A rip the catalogue has never heard of is still an album you own."
    const { records } = buildDiscography([group('Bootleg Sessions')], profile());
    expect(records.map((r) => r.title)).toEqual(['Bootleg Sessions']);
    expect(records[0]?.release).toBe(null);
    expect(records[0]?.key).toBe('mine:Bootleg Sessions');
  });

  it('does not list an owned record TWICE when the catalogue also has it', () => {
    const { records } = buildDiscography([group('OK Computer')], profile({ albums: [release()] }));
    expect(records).toHaveLength(1);
  });

  it('leaves the untagged pile off the shelf', () => {
    // "Unknown album" is not a record, and neither is an empty name.
    const { records } = buildDiscography(
      [group('Unknown album'), group('')],
      profile(),
    );
    expect(records).toEqual([]);
  });

  it('keeps albums and singles apart', () => {
    // A body of work is fifteen records; folding thirty one-off singles in
    // buries the first in the second.
    const { records, singles } = buildDiscography(
      [],
      profile({ albums: [release()], singles: [release({ id: 'c2', title: 'Creep' })] }),
    );
    expect(records.map((r) => r.title)).toEqual(['OK Computer']);
    expect(singles.map((r) => r.title)).toEqual(['Creep']);
  });

  it('puts what you own first, then the rest newest first', () => {
    const { records } = buildDiscography(
      [group('Kid A')],
      profile({
        albums: [
          release({ id: 'c1', title: 'Pablo Honey', year: '1993' }),
          release({ id: 'c2', title: 'In Rainbows', year: '2007' }),
          release({ id: 'c3', title: 'Kid A', year: '2000' }),
        ],
      }),
    );
    expect(records.map((r) => r.title)).toEqual(['Kid A', 'In Rainbows', 'Pablo Honey']);
  });

  it('sorts a record with no year last among the unowned', () => {
    const { records } = buildDiscography(
      [],
      profile({
        albums: [
          release({ id: 'c1', title: 'Undated', year: null }),
          release({ id: 'c2', title: 'Dated', year: '1997' }),
        ],
      }),
    );
    expect(records.map((r) => r.title)).toEqual(['Dated', 'Undated']);
  });

  it('is empty rather than broken when the catalogue answered nothing', () => {
    expect(buildDiscography([], null)).toEqual({ records: [], singles: [] });
  });
});

describe('buildPopular', () => {
  const catTrack = (over: Partial<CatalogTrack> = {}): CatalogTrack => ({
    id: 't1',
    title: 'Karma Police',
    cover: 'cat.jpg',
    url: 'https://open.spotify.com/track/1',
    duration: 261,
    importable: true,
    ...over,
  });

  it('uses the catalogue’s ranking, attaching your copy where you have one', () => {
    const mine = track({ title: 'Karma Police' });
    const rows = buildPopular('Radiohead', ownedOver([mine]), profile({ top: [catTrack()] }), []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mine).toBe(mine);
    expect(rows[0]?.catalogue).not.toBe(null);
  });

  it('keeps a catalogue song you do NOT own, with nothing attached', () => {
    const rows = buildPopular('Radiohead', ownedOver([]), profile({ top: [catTrack()] }), []);
    expect(rows[0]?.mine).toBe(null);
    expect(rows[0]?.importable).toBe(true);
  });

  it('falls back to YOUR play counts only when the catalogue has nothing', () => {
    // "A list built from what you own says an artist's top songs are the two
    // you happen to have, which is a chart of one listener" - so this is the
    // offline case, not the normal one.
    const mine = track({ title: 'Creep' });
    const rows = buildPopular('Radiohead', ownedOver([mine]), null, [{ track: mine, plays: 9 }]);
    expect(rows.map((r) => r.title)).toEqual(['Creep']);
    expect(rows[0]?.catalogue).toBe(null);
    // Nothing to import: it is already here.
    expect(rows[0]?.importable).toBe(false);
    expect(rows[0]?.url).toBe('');
  });

  it('does NOT fall back when the catalogue answered, even if you own nothing', () => {
    const mine = track({ title: 'Creep' });
    const rows = buildPopular(
      'Radiohead',
      ownedOver([]),
      profile({ top: [catTrack()] }),
      [{ track: mine, plays: 9 }],
    );
    expect(rows.map((r) => r.title)).toEqual(['Karma Police']);
  });

  it('is empty when neither source has anything', () => {
    expect(buildPopular('Radiohead', ownedOver([]), null, [])).toEqual([]);
  });
});
