import { describe, expect, it } from 'vitest';
import { albumCredit, byRunningOrder, groupAlbums, isBy, nameFold } from './albums.ts';
import { track } from '../../test/libraryFixtures.ts';

/**
 * The three rules that decide what an album IS and whose it is.
 *
 * The module's own header says these were once inline on the artist page with
 * one of them wrong, and that it showed up as three unrelated-looking
 * complaints at once. Each block below is one of those complaints, written as
 * the thing that must stay true.
 */
describe('nameFold', () => {
  it('folds case and surrounding space so one name is one artist', () => {
    expect(nameFold('  The National ')).toBe('the national');
    expect(nameFold('RADIOHEAD')).toBe(nameFold('Radiohead'));
  });
});

describe('isBy', () => {
  it('counts a track whose own credit names the artist', () => {
    expect(isBy(track({ artist: 'Radiohead' }), 'radiohead')).toBe(true);
  });

  it('counts a GUEST track through the album credit - the bug this module fixed', () => {
    // A guest on two songs gives those songs a different track artist. Reading
    // the track credit alone lost them, and often the whole record with them.
    const guest = track({ artist: 'Radiohead feat. Someone', albumArtist: 'Radiohead' });
    expect(isBy(guest, 'Radiohead')).toBe(true);
  });

  it('still counts a compilation appearance through the TRACK credit', () => {
    // The other direction: "Various Artists" over the album must not hide the
    // artist whose song it is.
    const onComp = track({ artist: 'Aphex Twin', albumArtist: 'Various Artists' });
    expect(isBy(onComp, 'Aphex Twin')).toBe(true);
  });

  it('refuses a track by neither', () => {
    expect(isBy(track({ artist: 'Blur', albumArtist: 'Blur' }), 'Oasis')).toBe(false);
  });

  it('matches the WHOLE name, not part of it', () => {
    // Unlike `sameArtist` in owned.ts, which deliberately allows extra billing,
    // an album's artist is compared entire: "Blur" must not answer for
    // "Blurred Lines" and a partial credit must not gather someone else's
    // record onto this page.
    expect(isBy(track({ artist: 'Blur', albumArtist: 'Blur' }), 'Blu')).toBe(false);
    expect(isBy(track({ artist: 'Drake, Future', albumArtist: null }), 'Drake')).toBe(false);
  });
});

describe('byRunningOrder', () => {
  it('sorts by disc before track, so a two-disc set does not interleave', () => {
    const d1t9 = track({ discNo: 1, trackNo: 9 });
    const d2t1 = track({ discNo: 2, trackNo: 1 });
    expect([d2t1, d1t9].sort(byRunningOrder)).toEqual([d1t9, d2t1]);
  });

  it('sorts by track number within a disc', () => {
    const a = track({ discNo: 1, trackNo: 2 });
    const b = track({ discNo: 1, trackNo: 11 });
    expect([b, a].sort(byRunningOrder)).toEqual([a, b]);
  });

  it('reads an untagged position as 0, which sorts it first', () => {
    const untagged = track({ trackNo: null, discNo: null });
    const first = track({ trackNo: 1, discNo: 1 });
    expect([first, untagged].sort(byRunningOrder)).toEqual([untagged, first]);
  });
});

describe('groupAlbums', () => {
  it('gathers one record across spellings of its name', () => {
    const rows = [
      track({ album: 'In Rainbows', trackNo: 2 }),
      track({ album: 'in rainbows', trackNo: 1 }),
    ];
    const [album] = groupAlbums(rows);
    expect(album?.list).toHaveLength(2);
    // The first spelling seen is what gets shown.
    expect(album?.name).toBe('In Rainbows');
  });

  it('returns each album in running order', () => {
    const groups = groupAlbums([
      track({ album: 'Kid A', trackNo: 3 }),
      track({ album: 'Kid A', trackNo: 1 }),
      track({ album: 'Kid A', trackNo: 2 }),
    ]);
    expect(groups[0]?.list.map((t) => t.trackNo)).toEqual([1, 2, 3]);
  });

  it('files untagged tracks under one "Unknown album" rather than dropping them', () => {
    const groups = groupAlbums([track({ album: '' }), track({ album: '' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('Unknown album');
    expect(groups[0]?.list).toHaveLength(2);
  });

  it('takes the first artwork any of the record’s tracks carries', () => {
    const groups = groupAlbums([
      track({ album: 'Kid A', artwork: null, trackNo: 1 }),
      track({ album: 'Kid A', artwork: 'cover.jpg', trackNo: 2 }),
    ]);
    expect(groups[0]?.artwork).toBe('cover.jpg');
  });

  it('keeps two records with different names apart', () => {
    expect(groupAlbums([track({ album: 'Kid A' }), track({ album: 'Amnesiac' })])).toHaveLength(2);
  });
});

describe('albumCredit', () => {
  it('credits the album artist when the tracks agree on one', () => {
    const list = [
      track({ artist: 'Radiohead', albumArtist: 'Radiohead' }),
      track({ artist: 'Radiohead feat. Someone', albumArtist: 'Radiohead' }),
    ];
    expect(albumCredit(list)).toBe('Radiohead');
  });

  it('says "Various artists" plainly rather than picking whoever sorted first', () => {
    const list = [
      track({ artist: 'Aphex Twin', albumArtist: null }),
      track({ artist: 'Boards of Canada', albumArtist: null }),
    ];
    expect(albumCredit(list)).toBe('Various artists');
  });

  it('falls back to the track credit where there is no album credit', () => {
    expect(albumCredit([track({ artist: 'Bjork', albumArtist: null })])).toBe('Bjork');
  });

  it('is the various-artists case for an empty list, not a crash', () => {
    expect(albumCredit([])).toBe('Various artists');
  });
});
