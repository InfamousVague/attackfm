import { describe, expect, it } from 'vitest';
import { shareSeat } from './npShare.ts';
import { IDLE_TRACK } from './deckShared.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The share seat's rules, pinned away from the screen that draws them.
 *
 * Every case here is one the Now Playing screen actually holds - the blank
 * stand-in the deck carries while nothing is loaded, a book chapter, a
 * follower mirroring a room - and each one has a different right answer.
 * Getting them wrong is not a layout bug: it is a drawer that asks you to
 * pick a friend and then fails, or a song quietly refused for the wrong
 * reason.
 */

const SONG: Track = {
  path: 'afm://1',
  title: 'Fountain Pen Blues',
  artist: 'Marla Vane',
  album: 'Longhand',
  duration: 21,
  addedAt: 0,
  artwork: null,
  genre: '',
  lyrics: '',
};

const signedIn = { account: true, following: false };

describe('shareSeat - who gets offered a send', () => {
  it('offers it for a named song with a central account', () => {
    expect(shareSeat(SONG, signedIn)).toBe('send');
  });

  it('offers nothing at all without a central account', () => {
    // Not greyed: a share is between registry accounts, there is no friends
    // list behind the button, and nothing on this screen would ever turn it
    // on. TrackMenu hides its row on the same test.
    expect(shareSeat(SONG, { account: false, following: false })).toBe('none');
  });

  it('stands down while mirroring a groove, as the heart does', () => {
    expect(shareSeat(SONG, { account: true, following: true })).toBe('none');
  });

  it('offers nothing with no song', () => {
    expect(shareSeat(null, signedIn)).toBe('none');
  });

  it('offers nothing for a book', () => {
    // The recipient's hub goes looking for a SONG by the name it is handed.
    expect(shareSeat({ ...SONG, kind: 'book', title: 'Chapter Nineteen' }, signedIn)).toBe('none');
    // And a song says so, or says nothing at all - old servers and local
    // scans never set `kind`.
    expect(shareSeat({ ...SONG, kind: 'music' }, signedIn)).toBe('send');
    expect(shareSeat({ ...SONG, kind: undefined }, signedIn)).toBe('send');
  });

  it('greys the seat for a song with no name to send', () => {
    // The registry's own rule, checked here rather than met as a 400 after
    // the listener has already picked which friend to send it to.
    expect(shareSeat({ ...SONG, artist: '' }, signedIn)).toBe('unnamed');
    expect(shareSeat({ ...SONG, title: '' }, signedIn)).toBe('unnamed');
    // Whitespace is not a name either - the server trims before it looks.
    expect(shareSeat({ ...SONG, artist: '   ' }, signedIn)).toBe('unnamed');
  });

  it('greys the seat for the blank stand-in the deck holds while idle', () => {
    // IDLE_TRACK is a real shape this screen sees: not null, and named
    // nothing. It must not read as a sendable song.
    expect(shareSeat(IDLE_TRACK, signedIn)).toBe('unnamed');
  });

  it('does not care where the file lives', () => {
    // A tagged song on this laptop is exactly as sendable as one on a hub:
    // what crosses the wire is the name, not the bytes.
    expect(shareSeat({ ...SONG, path: '/Users/matt/Music/blues.flac' }, signedIn)).toBe('send');
  });
});
