import { describe, expect, it } from 'vitest';
import { identityKey, leadKey } from './identity.ts';

/**
 * The name a song in flight answers to.
 *
 * This is a cross-language contract, and being wrong costs in two directions.
 * SPLIT one song into two keys and its ghost never dissolves: the file lands,
 * the library owns it, and the "still downloading" band goes on spinning over
 * it for the thirty-day life of the promise. COLLIDE two songs onto one key
 * and a promise is marked landed against a record nobody asked for.
 *
 * Every case below is one side or the other of that line.
 */

describe('identityKey', () => {
  it('is the server key_of: the folded artist, a pipe, the folded title key', () => {
    // Stated literally once, because the string itself is the contract - the
    // Rust side builds the same one and joins on it.
    expect(identityKey('Czarface', 'Air Raid')).toBe('czarface|air raid');
  });

  it('SEPARATES the two halves, so no pair of songs can share a key by accident', () => {
    /*
     * Without the pipe these two concatenate to the same string, and a heart
     * promised on one would be settled by the other landing. The separator is
     * not decoration: it is the only thing standing between them.
     */
    expect(identityKey('Low', 'Rider')).not.toBe(identityKey('Low Rider', ''));
    expect(identityKey('Low', 'Rider')).toBe('low|rider');
  });

  it('folds case, accents and apostrophes, because a tag and a catalogue disagree', () => {
    // The tagger's spelling and the catalogue's are both right and rarely
    // identical. If these split, the file lands and the ghost stays.
    expect(identityKey('MÖTLEY CRÜE', "Don't Go Away Mad")).toBe(
      identityKey('Motley Crue', 'Dont Go Away Mad'),
    );
  });

  it('reduces the title through titleKey, so a remaster is the song it remasters', () => {
    // The catalogue promises "Alive"; the file that lands is tagged
    // "Alive - 2007 Remaster". One song, one key, or the ghost never clears.
    expect(identityKey('Pearl Jam', 'Alive - 2007 Remaster')).toBe(
      identityKey('Pearl Jam', 'Alive'),
    );
    expect(identityKey('The Weeknd', 'Blinding Lights (feat. Doja Cat)')).toBe(
      identityKey('The Weeknd', 'Blinding Lights'),
    );
  });

  it('keeps two genuinely different recordings apart', () => {
    // The other side of the line: fold these together and a listener who
    // asked for the live take is handed the studio one and told it arrived.
    expect(identityKey('Pearl Jam', 'Alive - Live')).not.toBe(
      identityKey('Pearl Jam', 'Alive'),
    );
  });

  it('survives an empty credit rather than throwing', () => {
    // A catalogue row with no artist is malformed, not fatal: the band draws
    // a row for it either way, so the key has to exist.
    expect(identityKey('', 'Song')).toBe('|song');
  });
});

describe('leadKey', () => {
  it('drops everything after the first credit, which is the half that disagrees', () => {
    /*
     * The bug this exists for, verbatim: a heart promised on Discover carries
     * "Czarface", and the file that lands is tagged "CZARFACE, Frankie
     * Pulitzer". The exact keys differ; the lead keys do not.
     */
    expect(identityKey('CZARFACE, Frankie Pulitzer', 'Air Raid')).not.toBe(
      identityKey('Czarface', 'Air Raid'),
    );
    expect(leadKey('CZARFACE, Frankie Pulitzer', 'Air Raid')).toBe(
      leadKey('Czarface', 'Air Raid'),
    );
  });

  it('knows every way a featured credit is written', () => {
    // One separator missing from the list is one whole shape of tag that goes
    // on spinning after its file has landed.
    for (const billing of [
      'Sam, Bo',
      'Sam; Bo',
      'Sam & Bo',
      'Sam feat. Bo',
      'Sam feat Bo',
      'Sam featuring Bo',
      'Sam with Bo',
      'Sam x Bo',
      'Sam / Bo',
    ]) {
      expect(leadKey(billing, 'Song')).toBe('sam|song');
    }
  });

  it('NEVER widens the title - it is a wider WHO, not a wider WHAT', () => {
    /*
     * The guard on the whole idea. The lead credit is a fallback for a
     * disagreement about who played on a record; it says nothing about which
     * record, so two different songs by one artist must stay apart even when
     * every other part of the match has been loosened.
     */
    expect(leadKey('Sam feat. Bo', 'One')).not.toBe(leadKey('Sam feat. Bo', 'Two'));
    expect(leadKey('Sam, Bo', 'Alive - Live')).not.toBe(leadKey('Sam', 'Alive'));
  });

  it('is the exact key when there is only one credit', () => {
    // The common case, and the reason a caller can ask for both and get one
    // answer: a solo billing must not produce a second, different key.
    expect(leadKey('Czarface', 'Air Raid')).toBe(identityKey('Czarface', 'Air Raid'));
  });

  it('falls back to the whole credit when the split leaves nothing', () => {
    // A billing that OPENS with a separator splits to an empty lead. Taking
    // it would key every such song to "|title" and collide all of them.
    expect(leadKey(', Bo', 'Song')).toBe('bo|song');
    expect(leadKey('', 'Song')).toBe('|song');
  });

  it('cuts an act whose OWN name contains a separator - the cost of the fallback', () => {
    /*
     * Pinned rather than endorsed. "AC/DC" and "Malcolm X" are single acts
     * whose names hold a separator, so their lead key is a fragment, and a
     * fragment can be some other artist's whole name. This is the price of
     * matching on the lead credit at all, and it is only ever paid as a
     * fallback after the exact key has already missed - but if this behaviour
     * changes, it should change because somebody decided to, not by accident.
     */
    expect(leadKey('AC/DC', 'Back In Black')).toBe('ac|back in black');
    expect(leadKey('Malcolm X', 'Speech')).toBe('malcolm|speech');
    // And the exact key, which is consulted first, is unharmed.
    expect(identityKey('AC/DC', 'Back In Black')).toBe('ac dc|back in black');
  });

  it('leaves a separator letter alone inside a word', () => {
    // `x` and `feat` are matched on word boundaries: "Xavier" is not "avier"
    // billed by X, and clipping it would break a name that never asked.
    expect(leadKey('Xavier', 'Song')).toBe('xavier|song');
    expect(leadKey('Featured Artist', 'Song')).toBe('featured artist|song');
  });
});
