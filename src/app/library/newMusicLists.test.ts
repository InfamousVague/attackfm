import { describe, expect, it } from 'vitest';
import { newForYouLists, newMusicCovers } from './newMusicLists.ts';
import type { NewMusicList, NewMusicTrack } from '../api/newMusic.ts';

/**
 * What "New for you" is made of.
 *
 * Two surfaces read these - the shelf in the library and the hero at the top
 * of Discover - and the hero exists partly to keep the shelf from repeating
 * itself an inch below. So they have to agree exactly: on which lists there
 * are, in which order, and on which covers each one wears. A list dropped
 * here vanishes from both places at once and nothing says it did.
 */

const item = (n: number, cover: string = `https://hub.test/c${n}`): NewMusicTrack =>
  ({
    id: `deezer:track:${n}`,
    title: `New ${n}`,
    artist: `Band ${n}`,
    cover,
    url: `https://deezer.test/${n}`,
    preview: '',
    seed: 'Band 1',
    bpm: null,
    lyricsRead: false,
    score: 1,
  }) as NewMusicTrack;

const list = (over: Partial<NewMusicList> = {}): NewMusicList => ({
  id: 'nm-fresh',
  title: 'Fresh finds',
  blurb: '',
  items: [item(1), item(2)],
  ...over,
});

describe('newForYouLists', () => {
  it('keeps every list the hub sends, in the order it sent them', () => {
    // "Fresh first" is the hub's ordering, not a sort applied here - so the
    // only way to honour it is to leave the array alone.
    const sent = [list({ id: 'a' }), list({ id: 'b' }), list({ id: 'c' })];
    expect(newForYouLists(sent).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops the chart lane, which is not new to the world - only to you', () => {
    /*
     * `nm-popping` is the global trending shelf now, under the label the
     * server gives it. Left in, the hero would LEAD with everyone's chart
     * under a heading promising something the machine found for this
     * listener, and the trending shelf would then show it again below.
     */
    const kept = newForYouLists([list({ id: 'nm-popping' }), list({ id: 'nm-fresh' })]);
    expect(kept.map((l) => l.id)).toEqual(['nm-fresh']);
  });

  it('drops it by its exact id, not by anything about its title', () => {
    // A list a person's hub happens to call "Popping off" is still one the
    // model built for them; only the reserved id is the global lane.
    expect(newForYouLists([list({ id: 'nm-popping-2026', title: 'Popping off' })])).toHaveLength(1);
  });

  it('treats a feed that has not answered as an empty one', () => {
    // `newMusic` is null until the fetch lands. Every caller maps over the
    // result immediately, so null has to become a list here or nowhere.
    expect(newForYouLists(null)).toEqual([]);
    expect(newForYouLists([])).toEqual([]);
  });

  it('leaves the array it was handed alone', () => {
    // Two surfaces call this on the same feed value in the same render. One
    // that filtered in place would take lists away from the other.
    const sent = [list({ id: 'nm-popping' }), list({ id: 'nm-fresh' })];
    newForYouLists(sent);
    expect(sent).toHaveLength(2);
  });
});

describe('newMusicCovers', () => {
  it('takes the first `take` covers, in the list’s own order', () => {
    const four = list({ items: [item(1), item(2), item(3), item(4), item(5)] });
    expect(newMusicCovers(four, 4)).toEqual([
      'https://hub.test/c1',
      'https://hub.test/c2',
      'https://hub.test/c3',
      'https://hub.test/c4',
    ]);
  });

  it('never repeats a sleeve - the mosaic is four squares, not one four times', () => {
    /*
     * A themed list is often several songs off one record, and the 2x2 tile
     * showing the same cover four times reads as a broken image rather than
     * as a set. Distinctness is the whole reason this is not `.slice()`.
     */
    const sameRecord = list({
      items: [item(1, 'https://hub.test/a'), item(2, 'https://hub.test/a'), item(3, 'https://hub.test/b')],
    });
    expect(newMusicCovers(sameRecord, 4)).toEqual(['https://hub.test/a', 'https://hub.test/b']);
  });

  it('skips a row whose cover is missing rather than putting a hole in the tile', () => {
    // `cover` is typed non-null, so a blank one goes in as an explicit
    // malformed value - which is what a catalogue really sends sometimes.
    const holed = list({
      items: [
        { ...item(1), cover: '' } as unknown as NewMusicTrack,
        item(2),
        { ...item(3), cover: null } as unknown as NewMusicTrack,
        item(4),
      ],
    });
    expect(newMusicCovers(holed, 4)).toEqual(['https://hub.test/c2', 'https://hub.test/c4']);
  });

  it('returns fewer than asked, or none, rather than padding', () => {
    // The cover component branches on the count: none means it draws its
    // sparkle glyph instead, and a padded array would hide that.
    expect(newMusicCovers(list({ items: [item(1)] }), 4)).toHaveLength(1);
    expect(newMusicCovers(list({ items: [] }), 4)).toEqual([]);
    expect(
      newMusicCovers(list({ items: [{ ...item(1), cover: '' } as unknown as NewMusicTrack] }), 4),
    ).toEqual([]);
  });

  it('stops at `take` even when the list is long', () => {
    const many = list({ items: Array.from({ length: 40 }, (_, i) => item(i)) });
    expect(newMusicCovers(many, 4)).toHaveLength(4);
    expect(newMusicCovers(many, 1)).toEqual(['https://hub.test/c0']);
  });
});
