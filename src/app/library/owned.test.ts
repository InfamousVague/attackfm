import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Track } from '../core/tauri.ts';
import { track } from '../../test/libraryFixtures.ts';

/** The library the index is built over. Only `tracks` is read. */
const shelf = vi.hoisted(() => ({ tracks: [] as unknown[] }));
vi.mock('./library.tsx', () => ({ useLibrary: () => ({ tracks: shelf.tracks }) }));

const { fold, sameArtist, titleKey, useOwned } = await import('./owned.ts');

/**
 * "Do I already have this?" - the rule four Add buttons gate on.
 *
 * Two ways to be wrong and they cost different things. Too generous hides
 * music the listener wants (a remix folded onto the original, so the Add
 * button never appears for a song they do not own); too strict shows an Add
 * button over a song already on the shelf and downloads it twice. Every case
 * below is one side or the other of that line.
 */
describe('titleKey', () => {
  it('drops a noise aside in brackets', () => {
    expect(titleKey('Blinding Lights (feat. Doja Cat)')).toBe('blinding lights');
    expect(titleKey('Alive [2007 Remaster]')).toBe('alive');
  });

  it('KEEPS a bare year in brackets - "Alive (2007)" is a record, not a note', () => {
    // The counter-case to the one above, and the reason NOISE is a word list
    // rather than "anything in brackets": stripping the year would fold two
    // different releases onto one key.
    expect(titleKey('Alive (2007)')).toBe('alive 2007');
  });

  it('drops a trailing " - " tail only when the tail is noise', () => {
    expect(titleKey('Blinding Lights - Radio Edit')).toBe('blinding lights');
    // Not noise: a different performance, and folding it onto the original
    // would hide a song the listener does not have.
    expect(titleKey('Blinding Lights - Live')).toBe('blinding lights live');
  });

  it('never drops remix, live, acoustic or version - those are other recordings', () => {
    for (const tail of ['Remix', 'Live', 'Acoustic', 'Piano Version']) {
      expect(titleKey(`Alive (${tail})`)).not.toBe('alive');
      expect(titleKey(`Alive - ${tail}`)).not.toBe('alive');
    }
  });

  it('folds accents, case and apostrophes so a tag matches a catalogue string', () => {
    expect(titleKey("Don't Stop Me Now")).toBe(titleKey('Dont Stop Me Now'));
    expect(titleKey('Bjӧrk')).toBe(titleKey('Bjӧrk'.normalize('NFD')));
    expect(titleKey('CRAZY IN LOVE')).toBe('crazy in love');
  });

  it('leaves the dash alone when only an inner segment is noise', () => {
    // Only the LAST segment is considered, so a title that is genuinely
    // hyphenated keeps its shape.
    expect(titleKey('Jump - Van Halen - 2015 Remaster')).toBe('jump van halen');
  });

  it('reduces a title that is nothing but an aside to empty rather than throwing', () => {
    expect(titleKey('(Remastered)')).toBe('');
  });
});

describe('sameArtist', () => {
  it('matches a lead credit inside a longer billing', () => {
    expect(sameArtist(fold('Drake, Future'), fold('Drake'))).toBe(true);
    expect(sameArtist(fold('Drake'), fold('Drake, Future'))).toBe(true);
  });

  it('matches whole words only - "Q" is not "Queen"', () => {
    // The reason the containment test is padded with spaces on both sides.
    expect(sameArtist(fold('Queen'), fold('Q'))).toBe(false);
    expect(sameArtist(fold('The Weeknd'), fold('Week'))).toBe(false);
  });

  it('is false when either side is empty', () => {
    // An untagged file must not claim to be every catalogue row.
    expect(sameArtist('', 'drake')).toBe(false);
    expect(sameArtist('drake', '')).toBe(false);
  });

  it('folds the two spellings of an accented name onto one', () => {
    expect(sameArtist(fold('Beyoncé'), fold('Beyonce'))).toBe(true);
  });
});

describe('the two rules together', () => {
  it('accepts the catalogue/tag pair that motivated the module', () => {
    // Spotify's string on the left, the file's tags on the right.
    expect(titleKey('Blinding Lights - Radio Edit')).toBe(titleKey('Blinding Lights'));
    expect(sameArtist(fold('The Weeknd'), fold('The Weeknd, Rosalía'))).toBe(true);
  });

  it('still refuses a genuinely different recording by the same act', () => {
    expect(titleKey('Blinding Lights (Chromatics Remix)')).not.toBe(titleKey('Blinding Lights'));
  });
});


describe('useOwned', () => {
  const shelve = (...tracks: Track[]) => {
    shelf.tracks = tracks;
    return renderHook(() => useOwned()).result.current;
  };

  beforeEach(() => {
    shelf.tracks = [];
  });

  it('finds the library’s copy through both folds at once', () => {
    // The pair the module exists for: Spotify's string on one side, the
    // file's tags on the other.
    const mine = track({ title: 'Blinding Lights', artist: 'The Weeknd' });
    const owned = shelve(mine);
    expect(owned.find('The Weeknd, Rosalía', 'Blinding Lights - Radio Edit')).toBe(mine);
    expect(owned.has('The Weeknd', 'Blinding Lights')).toBe(true);
  });

  it('reduces the LIBRARY’s side of the key too, not just the question', () => {
    // The index is built on `titleKey`, not on the raw tag: the decoration is
    // as likely to be on the file as on the catalogue row, and folding only
    // one side leaves an Add button over a song already on the shelf.
    const mine = track({ title: 'Alive - 2007 Remaster', artist: 'Pearl Jam' });
    const owned = shelve(mine);
    expect(owned.find('Pearl Jam', 'Alive')).toBe(mine);
  });

  it('refuses another artist’s song of the same name', () => {
    // Too generous here means an Add button that never appears for music the
    // listener does not have.
    const owned = shelve(track({ title: 'Alive', artist: 'Pearl Jam' }));
    expect(owned.find('Empire Of The Sun', 'Alive')).toBe(null);
    expect(owned.has('Empire Of The Sun', 'Alive')).toBe(false);
  });

  it('picks the right one when two artists have a song of the same name', () => {
    const pearlJam = track({ title: 'Alive', artist: 'Pearl Jam' });
    const empire = track({ title: 'Alive', artist: 'Empire Of The Sun' });
    const owned = shelve(pearlJam, empire);
    expect(owned.find('Empire Of The Sun', 'Alive')).toBe(empire);
  });

  it('ignores a row with no artist tag rather than letting it answer for anything', () => {
    const owned = shelve(track({ title: 'Alive', artist: '' }));
    expect(owned.find('Pearl Jam', 'Alive')).toBe(null);
  });

  it('answers null for an absent or unusable question', () => {
    const owned = shelve(track({ title: 'Alive', artist: 'Pearl Jam' }));
    expect(owned.find('Pearl Jam', null)).toBe(null);
    expect(owned.find(null, 'Alive')).toBe(null);
    // A title that reduces to nothing is not a lookup key.
    expect(owned.find('Pearl Jam', '(Remastered)')).toBe(null);
  });

  it('is empty over an empty library', () => {
    expect(shelve().has('Anyone', 'Anything')).toBe(false);
  });
});
