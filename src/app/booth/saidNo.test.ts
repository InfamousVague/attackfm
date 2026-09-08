import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../core/tauri.ts';
import {
  artistKey,
  extKey,
  noteNo,
  PREVIEW_PREFIX,
  resetSaidNo,
  saidNo,
  saidNoTo,
  saidNoVersion,
  subscribeSaidNo,
  trackKey,
} from './saidNo.ts';

/**
 * What the listener said no to this sitting.
 *
 * The gap-filler between a thumb-down and the server catching up: the feed on
 * screen was dealt BEFORE the no, so a re-render off that stale reply would
 * put the song straight back under the thumb that just refused it. One
 * predicate serves three decks, and it has to read three different kinds of
 * name - a library id, a catalogue id, an artist - because a no lands on a
 * song, a preview date or an act depending on where it was given.
 */

function track(over: Partial<Track> = {}): Pick<Track, 'path' | 'artist'> {
  return { path: 'afm://42', artist: 'Somebody', ...over };
}

beforeEach(() => {
  resetSaidNo();
});

afterEach(() => {
  resetSaidNo();
});

describe('the three kinds of name', () => {
  it('spells them apart, so a track #1 and an artist "1" cannot collide', () => {
    expect(trackKey(1)).toBe('track:1');
    expect(extKey('1')).toBe('ext:1');
    expect(artistKey('1')).toBe('artist:1');
    expect(new Set([trackKey(1), extKey('1'), artistKey('1')]).size).toBe(3);
  });

  it('folds an artist’s case and edges, so "Wham! " and "wham!" are one act', () => {
    expect(artistKey('  Wham! ')).toBe(artistKey('wham!'));
  });
});

describe('saidNoTo', () => {
  it('is false with an empty ledger, whatever it is handed', () => {
    expect(saidNoTo(track())).toBe(false);
  });

  it('catches a song by its library id', () => {
    noteNo(trackKey(42));
    expect(saidNoTo(track({ path: 'afm://42' }))).toBe(true);
    expect(saidNoTo(track({ path: 'afm://43' }))).toBe(false);
  });

  it('catches a preview date by its catalogue id', () => {
    noteNo(extKey('spotify:track:xyz'));
    expect(saidNoTo(track({ path: `${PREVIEW_PREFIX}spotify:track:xyz` }))).toBe(true);
    expect(saidNoTo(track({ path: `${PREVIEW_PREFIX}spotify:track:abc` }))).toBe(false);
  });

  it('catches every card by a refused artist', () => {
    noteNo(artistKey('Wham!'));
    // A rejected artist's other cards go with them - the whole reason the
    // predicate reads the artist as well as the id.
    expect(saidNoTo(track({ path: 'afm://1', artist: 'Wham!' }))).toBe(true);
    expect(saidNoTo(track({ path: 'afm://2', artist: 'wham!  ' }))).toBe(true);
    expect(saidNoTo(track({ path: 'afm://3', artist: 'Keeper' }))).toBe(false);
  });

  it('does not read a blank artist as a refused one', () => {
    // `artist:` with nothing after it is a key somebody could plausibly write
    // down; every untagged row in the library must not vanish with it.
    noteNo('artist:');
    expect(saidNoTo(track({ artist: '   ' }))).toBe(false);
  });

  it('does not read a preview id off a library path', () => {
    noteNo(extKey('42'));
    // `afm://42` is a library id, not a catalogue one: only a `preview:`
    // path carries an ext id, and conflating them would let a no on one
    // catalogue row silence an unrelated library song.
    expect(saidNoTo(track({ path: 'afm://42' }))).toBe(false);
  });

  it('does not read a library id off a local file', () => {
    noteNo(trackKey(42));
    expect(saidNoTo(track({ path: '/Music/42.mp3' }))).toBe(false);
  });
});

describe('the ledger', () => {
  it('is idempotent, and only says so when something changed', () => {
    const heard = vi.fn();
    const off = subscribeSaidNo(heard);
    noteNo(trackKey(1));
    expect(heard).toHaveBeenCalledTimes(1);
    noteNo(trackKey(1));
    expect(heard).toHaveBeenCalledTimes(1);
    noteNo(trackKey(2));
    expect(heard).toHaveBeenCalledTimes(2);
    off();
  });

  it('bumps its version on every write, so a memo keyed on it recomputes', () => {
    const before = saidNoVersion();
    noteNo(trackKey(1));
    expect(saidNoVersion()).toBe(before + 1);
    // ...and not on a write that changed nothing.
    noteNo(trackKey(1));
    expect(saidNoVersion()).toBe(before + 1);
  });

  it('answers saidNo for a key it holds', () => {
    noteNo(trackKey(1));
    expect(saidNo(trackKey(1))).toBe(true);
    expect(saidNo(trackKey(2))).toBe(false);
  });

  it('forgets everything on a reset, and tells subscribers', () => {
    noteNo(trackKey(1));
    const heard = vi.fn();
    const off = subscribeSaidNo(heard);
    resetSaidNo();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(saidNo(trackKey(1))).toBe(false);
    off();
  });
});
